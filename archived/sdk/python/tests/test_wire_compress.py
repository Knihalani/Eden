"""N2 — SDK wire compression: zstd fast path with gzip fallback parity.

``_wire_compress.compress_wire`` prefers zstd when ``zstandard`` is
installed and falls back to gzip level 1 otherwise. Both must round-trip
through the ingest gateway's decompression (``providers.py`` accepts the
zstd magic + header), and the gzip branch must match what the SDK sent
before this change so a slim install cannot regress.
"""

from __future__ import annotations

import gzip

import pytest

from eden_sdk import _wire_compress as wc


@pytest.mark.parametrize("raw", [b"", b"hello", b'{"a":1}' * 200])
def test_roundtrip_any_encoding(raw: bytes) -> None:
    """Whatever encoding is active must round-trip to the exact input."""
    body, encoding = wc.compress_wire(raw)
    assert encoding in (wc.WIRE_GZIP, wc.WIRE_ZSTD, "identity")
    if encoding == wc.WIRE_ZSTD:
        import zstandard

        assert zstandard.ZstdDecompressor().decompress(body) == raw
    elif encoding == wc.WIRE_GZIP:
        assert gzip.decompress(body) == raw
    else:
        assert body == raw


@pytest.mark.skipif(not wc._HAVE_ZSTD, reason="zstandard not installed")
def test_zstd_when_available() -> None:
    raw = b'{"trace_id":"t-1","spans":[{"name":"x"}]}' * 100
    body, encoding = wc.compress_wire(raw)
    assert encoding == wc.WIRE_ZSTD
    assert wc.is_zstd_body(body)
    import zstandard

    dctx = zstandard.ZstdDecompressor()
    assert dctx.decompress(body) == raw


@pytest.mark.skipif(wc._HAVE_ZSTD, reason="zstandard installed")
def test_gzip_fallback_without_zstd() -> None:
    body, encoding = wc.compress_wire(b'{"a":1}')
    assert encoding == wc.WIRE_GZIP
    assert not wc.is_zstd_body(body)


def test_is_zstd_magic() -> None:
    assert wc.is_zstd_body(b"\x28\xb5\x2f\xfd" + b"rest")
    assert not wc.is_zstd_body(b"not zstd")
    assert not wc.is_zstd_body(b"")


def test_zstd_smaller_than_gzip_on_repetitive_payload() -> None:
    """zstd's ratio advantage on telemetry-shaped repetitive JSON."""
    raw = b'{"role":"user","content":"repeat me "}' * 300
    z_body, z_enc = wc.compress_wire(raw)
    if z_enc != wc.WIRE_ZSTD:
        pytest.skip("zstandard not installed")
    g_body = gzip.compress(raw, compresslevel=1)
    assert len(z_body) <= len(g_body) * 1.1


@pytest.mark.skipif(not wc._HAVE_ZSTD, reason="zstandard not installed")
def test_gzip_branch_still_roundtrips_when_zstd_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Force the gzip branch of ``compress_wire`` even when zstandard is
    installed (regression guard for parity discipline — the fallback must
    keep working on slim installs). Mirrors the TS SDK's
    ``_setZstdProbeForTests`` hook semantics."""
    monkeypatch.setattr(wc, "_HAVE_ZSTD", False)
    raw = b'{"b":2}' * 50
    body, encoding = wc.compress_wire(raw)
    assert encoding == wc.WIRE_GZIP
    assert gzip.decompress(body) == raw


@pytest.mark.skipif(not wc._HAVE_ZSTD, reason="zstandard not installed")
def test_zstd_branch_survives_compressor_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A broken zstd compressor must fall through to gzip, never raise
    (telemetry must not die with the fast path)."""
    import zstandard

    class _BoomCompressor:
        @staticmethod
        def compress(_raw: bytes) -> bytes:  # pragma: no cover - raises
            raise RuntimeError("zstd blew up")

    class _Boom:
        @staticmethod
        def ZstdCompressor(*_args, **_kwargs) -> _BoomCompressor:
            return _BoomCompressor()

    monkeypatch.setattr(wc, "_zstd", _Boom())
    raw = b'{"ok":1}' * 100
    body, encoding = wc.compress_wire(raw)
    assert encoding == wc.WIRE_GZIP
    assert gzip.decompress(body) == raw
    # Sanity: the real library is still importable for other tests.
    assert zstandard.ZstdDecompressor()
