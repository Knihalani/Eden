"""N2 — the ingest gateway must accept the SDKs' zstd wire encoding.

Both SDKs send ``Content-Encoding: zstd`` when zstandard is available
(fall back to gzip otherwise). ``providers.maybe_gunzip_body`` must
decompress it identically to gzip — by header and by magic-sniffing when
a proxy stripped the header — and must keep the same bomb-size caps.
"""

from __future__ import annotations

import gzip

import pytest

from eden.observability.ingestion.providers import (
    _needs_gunzip,
    _zstd_decompress_limited,
    maybe_gunzip_body,
)

_PAYLOAD = (
    b'{"event_id":"e1","event_type":"agent.run","payload":{"role":"user",'
    b'"content":"hello world"}}' * 50
)


def _zstd_compress(raw: bytes) -> bytes:
    import zstandard

    return zstandard.ZstdCompressor(level=3).compress(raw)


def test_zstd_header_decoded() -> None:
    body = _zstd_compress(_PAYLOAD)
    assert maybe_gunzip_body(body, "zstd") == _PAYLOAD


def test_zstd_magic_sniffed_without_header() -> None:
    body = _zstd_compress(_PAYLOAD)
    # Proxy stripped the Content-Encoding header → sniff the frame magic.
    assert maybe_gunzip_body(body, None) == _PAYLOAD


def test_zstd_async_needs_detection() -> None:
    body = _zstd_compress(_PAYLOAD)
    assert _needs_gunzip(body, "zstd") is True
    assert _needs_gunzip(body, None) is True  # magic sniff


def test_gzip_still_works_after_zstd_branch() -> None:
    body = gzip.compress(_PAYLOAD, compresslevel=1)
    assert maybe_gunzip_body(body, "gzip") == _PAYLOAD
    assert maybe_gunzip_body(body, None) == _PAYLOAD  # gzip magic sniff


def test_identity_and_unknown_encoding_pass_through() -> None:
    assert maybe_gunzip_body(_PAYLOAD, None) == _PAYLOAD
    assert maybe_gunzip_body(_PAYLOAD, "identity") == _PAYLOAD
    assert maybe_gunzip_body(_PAYLOAD, "br") == _PAYLOAD  # brotli not handled


def test_zstd_bomb_is_rejected() -> None:
    # Highly compressible body that would decompress far beyond the cap.
    raw = b"A" * (2 * 1024 * 1024)
    body = _zstd_compress(raw)
    with pytest.raises(ValueError, match="exceeds"):
        _zstd_decompress_limited(body)


def test_corrupt_zstd_raises_value_error() -> None:
    with pytest.raises(ValueError, match="invalid zstd"):
        maybe_gunzip_body(b"\x28\xb5\x2f\xfd" + b"garbage-not-a-frame", "zstd")
