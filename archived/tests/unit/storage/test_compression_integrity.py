"""Hard integrity suite for the compression layer.

Guarantees:
- Lossless round-trip on production-shaped 8-field events
- Never-expand never stores a larger blob than raw JSON
- ``compress_jsonb`` and ``compress_many`` agree byte-for-byte
- Unicode / deep nesting / large chat bodies survive
- Legacy raw-JSON columns (no zstd magic) still decode
"""

from __future__ import annotations

import json
import math
import random

import pytest

from eden.storage.compression import (
    ZSTD_MAGIC,
    compress_jsonb,
    compress_many,
    decompress_jsonb,
    decompress_many,
)


def _canon(obj: object) -> str:
    return json.dumps(obj, default=str, sort_keys=True, allow_nan=False)


@pytest.fixture
def prod_events():
    # Import lazily so the bench module's path setup is not required under pytest
    import sys
    from pathlib import Path

    repo = Path(__file__).resolve().parents[3]
    if str(repo) not in sys.path:
        sys.path.insert(0, str(repo))
    from bench.compression_prod_weighted import build_events

    return build_events(300, seed=7)


def test_prod_weighted_round_trip_zero_loss(prod_events) -> None:
    from eden.storage.compression import TELEMETRY_ZSTD_FIELDS, _to_json_bytes

    flat = [f for ev in prod_events for f in ev.as_fields()]
    cols = list(TELEMETRY_ZSTD_FIELDS) * len(prod_events)
    stored = compress_many(flat, columns=cols)
    decoded = decompress_many(stored)
    errors = 0
    expand = 0
    for original, blob, got in zip(flat, stored, decoded, strict=True):
        if blob is None:
            assert original in (None, {}, [])
            continue
        raw = _to_json_bytes(original)
        if len(blob) > len(raw):
            expand += 1
        if _canon(got) != _canon(original):
            errors += 1
    assert errors == 0
    assert expand == 0


def test_single_matches_batch_on_prod_fields(prod_events) -> None:
    from eden.storage.compression import TELEMETRY_ZSTD_FIELDS

    mismatches = 0
    for ev in prod_events:
        for name, val in zip(TELEMETRY_ZSTD_FIELDS, ev.as_fields(), strict=True):
            if val in (None, {}, []):
                assert compress_many([val], columns=[name])[0] is None
                continue
            if compress_jsonb(val, column=name) != compress_many([val], columns=[name])[0]:
                mismatches += 1
    assert mismatches == 0


def test_unicode_and_deep_nest_round_trip() -> None:
    payload = {
        "ja": "日本語のプロンプト" * 20,
        "emoji": "🙂🔥" * 30,
        "deep": {"a": [{"b": {"c": ["x" * 50] * 5}}]},
    }
    assert decompress_jsonb(compress_jsonb(payload)) == payload
    assert decompress_many(compress_many([payload]))[0] == payload


def test_never_expand_invariant_random() -> None:
    rng = random.Random(123)
    from eden.storage.compression import _to_json_bytes

    for _ in range(200):
        payload = {
            "blob": "".join(rng.choice("abcdef0123456789") for _ in range(rng.randint(100, 4000)))
        }
        raw = _to_json_bytes(payload)
        stored = compress_jsonb(payload)
        assert len(stored) <= len(raw)
        assert decompress_jsonb(stored) == payload


def test_legacy_raw_json_without_magic_still_reads() -> None:
    legacy = json.dumps({"score": 1.5, "ok": True}, separators=(",", ":")).encode()
    assert not legacy.startswith(ZSTD_MAGIC)
    assert decompress_jsonb(legacy) == {"score": 1.5, "ok": True}


def test_nan_becomes_null_on_write_path_still_decodes() -> None:
    """orjson maps NaN→null; reader must accept the stored form."""
    stored = compress_jsonb({"score": float("nan")})
    got = decompress_jsonb(stored)
    assert got == {"score": None} or (
        isinstance(got.get("score"), float) and math.isnan(got["score"])
    )
