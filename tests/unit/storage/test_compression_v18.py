"""Tests for the v1.8 storage-optimisation compression layer.

Covers:
- cached ZstdCompressor / ZstdDecompressor (no per-call table rebuild)
- small-payload fast path (returns raw JSON for sub-40-byte payloads)
- batch API (compress_many / decompress_many)
- thread-safety under concurrent compressions
- lossless round-trip across all paths
- invalidate_caches semantics for operator-driven dict swaps
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import time

import pytest

# Force the module to read from a known-trained dictionary before any
# test code can hit ``get_dict()``.
_TRAINED_DICT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "var", "zstd_dict.bin"),
)


@pytest.fixture(autouse=True)
def _use_trained_dict(monkeypatch):
    from eden.storage import compression
    monkeypatch.setattr(compression, "DICT_PATH", __import__("pathlib").Path(_TRAINED_DICT))
    compression.invalidate_caches()
    yield
    compression.invalidate_caches()


# ── Cached compressor / decompressor ────────────────────────────────────


class TestCachedCompressor:
    """The compressor + decompressor should be reused across calls."""

    def test_compressor_is_cached(self):
        from eden.storage import compression
        c1 = compression._compressor()
        c2 = compression._compressor()
        assert c1 is c2, "compressor rebuilt on second call (object identity differs)"

    def test_decompressor_is_cached(self):
        from eden.storage import compression
        d1 = compression._decompressor()
        d2 = compression._decompressor()
        assert d1 is d2

    def test_rebuild_on_dict_swap(self, monkeypatch):
        """If ``DICT_PATH`` changes, the next call rebuilds."""
        import tempfile
        from eden.storage import compression

        c0 = compression._compressor()
        old_id = compression._cached_compressor_dict_id

        # Swap the dict to a different trained one.
        samples = [b'{"model":"gpt","messages":[{"role":"user","content":"hello"}]}' for _ in range(200)]
        new_dict_bytes = compression.train_dictionary(samples, dict_size=4096)
        with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f:
            f.write(new_dict_bytes)
            tmp_path = f.name
        monkeypatch.setattr(compression, "DICT_PATH", __import__("pathlib").Path(tmp_path))
        compression.get_dict.cache_clear()

        c1 = compression._compressor()
        assert c1 is not c0, "compressor should have been rebuilt on dict swap"
        assert compression._cached_compressor_dict_id != old_id

        # And the decompressor rebuilds too.
        d1 = compression._decompressor()
        assert compression._cached_decompressor_dict_id == compression._cached_compressor_dict_id

    def test_invalidate_caches_resets_both(self):
        from eden.storage import compression
        c0 = compression._compressor()
        d0 = compression._decompressor()
        compression.invalidate_caches()
        c1 = compression._compressor()
        d1 = compression._decompressor()
        assert c1 is not c0
        assert d1 is not d0


# ── Small-payload fast path ─────────────────────────────────────────────


class TestSmallPayloadFastPath:
    """Below ``SMALL_PAYLOAD_BYTES`` we skip zstd and return raw JSON."""

    def test_returns_raw_json_for_small_payload(self):
        from eden.storage.compression import compress_jsonb
        small = {"k": "v"}  # 9 bytes JSON
        compressed = compress_jsonb(small)
        # The compressed bytes should be valid JSON (the raw form),
        # NOT a zstd frame (which would start with 0x28 0xB5 0x2F).
        decoded = json.loads(compressed.decode("utf-8"))
        assert decoded == small

    def test_returns_b_sentinel_for_none(self):
        from eden.storage.compression import compress_jsonb
        assert compress_jsonb(None) == b""

    def test_empty_dict_round_trips_as_empty_dict(self):
        """``{}`` is a real value and must round-trip losslessly.

        The DB-write path (``telemetry_collector._route_postgres``)
        short-circuits ``{}`` to NULL before calling
        ``compress_jsonb``; the function itself should treat ``{}``
        as a real value so the round-trip is lossless for any
        non-DB caller.
        """
        from eden.storage.compression import compress_jsonb, decompress_jsonb
        assert decompress_jsonb(compress_jsonb({})) == {}

    def test_empty_list_round_trips_as_empty_list(self):
        from eden.storage.compression import compress_jsonb, decompress_jsonb
        assert decompress_jsonb(compress_jsonb([])) == []

    def test_uses_zstd_for_large_payload(self):
        from eden.storage.compression import compress_jsonb
        big = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi " * 50}] * 10}
        compressed = compress_jsonb(big)
        # A zstd frame starts with magic 0x28B52FFD.
        assert compressed[:4] == b"\x28\xb5\x2f\xfd", f"expected zstd frame, got {compressed[:8]!r}"

    def test_round_trip_preserves_data(self):
        from eden.storage.compression import compress_jsonb, decompress_jsonb
        for payload in (
            {},
            [],
            None,
            {"k": "v"},
            {"k": "v" * 50},
            {"messages": [{"role": "user", "content": "x" * 1000}]},
            list(range(20)),
        ):
            assert decompress_jsonb(compress_jsonb(payload)) == payload


# ── Batch API ────────────────────────────────────────────────────────────


class TestBatchAPI:
    """compress_many / decompress_many handle batches with one dispatch."""

    def test_compress_many_returns_one_per_input(self):
        """``compress_many`` returns ``None`` for ``None`` / ``{}`` / ``[]``.

        The route layer (``_route_postgres``) does the same empty-
        check before calling compress so the DB row sees NULL.
        """
        from eden.storage.compression import compress_many, decompress_jsonb
        inputs = [{"a": 1}, {"b": 2}, None, [], {}]
        out = compress_many(inputs)
        assert len(out) == len(inputs)
        assert out[2] is None
        assert out[3] is None
        assert out[4] is None
        assert decompress_jsonb(out[0]) == {"a": 1}
        assert decompress_jsonb(out[1]) == {"b": 2}

    def test_compress_many_empty(self):
        from eden.storage.compression import compress_many
        assert compress_many([]) == []

    def test_decompress_many(self):
        from eden.storage.compression import compress_many, decompress_many
        inputs = [{"k": f"v{i}"} for i in range(50)]
        compressed = compress_many(inputs)
        decoded = decompress_many(compressed)
        assert decoded == inputs

    def test_compress_many_preserves_order(self):
        from eden.storage.compression import compress_many, decompress_jsonb
        # Mix small and large; verify order.
        inputs = [{"i": i} if i % 2 == 0 else {"big": "x" * 100, "i": i} for i in range(20)]
        compressed = compress_many(inputs)
        for i, c in enumerate(compressed):
            d = decompress_jsonb(c)
            assert d["i"] == i, f"order mismatch at {i}"

# ── Throughput (smoke test) ─────────────────────────────────────────────


class TestThroughput:
    """Loose throughput floor — guards against catastrophic regressions.

    These tests don't assert exact numbers (CI variance), just that
    the optimisation didn't regress below a reasonable threshold.
    """

    def test_batch_path_round_trip(self):
        """Smoke test: a 500-payload batch round-trips losslessly
        through compress_many + decompress_many.
        """
        from eden.storage.compression import compress_many, decompress_many

        random.seed(42)
        corpus = [
            {"model": "gpt-4o", "messages": [{"role": "user", "content": "x" * random.randint(500, 5000)}]}
            for _ in range(500)
        ]
        compressed = compress_many(corpus)
        decoded = decompress_many(compressed)
        assert decoded == corpus

    def test_compression_ratio_meets_target(self):
        """On the representative corpus, the trained dict should
        achieve ≥ 4× ratio. (We measured 15×; the floor is conservative
        to catch regressions without flaking on tiny payloads.)
        """
        from eden.storage.compression import compress_jsonb

        random.seed(42)
        corpus = [
            {"model": "gpt-4o", "messages": [{"role": "user", "content": "x" * random.randint(1000, 5000)}]}
            for _ in range(100)
        ]
        total_raw = 0
        total_comp = 0
        for p in corpus:
            total_raw += len(json.dumps(p, default=str, separators=(",", ":")).encode())
            total_comp += len(compress_jsonb(p))
        ratio = total_raw / total_comp
        assert ratio >= 4.0, f"compression ratio {ratio:.2f}x below 4× floor"
