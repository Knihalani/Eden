"""Wire compression for the SDK's send hot path (N2, 2026-08-10).

Every ingest POST is compressed. gzip level 1 was the only option; this
module adds a zstd fast path (``Content-Encoding: zstd``) when the
``zstandard`` package is available, falling back to gzip level 1 for the
base install. Measured on the backend wire benchmark: orjson+zstd-3
104k ev/s vs json+gzip-1 27k ev/s — **3.8× faster send at the same
ratio** (see ``docs/EXHAUSTIVE-AUDIT-2026-08-10.md`` §7).

Both encodings are accepted by the ingest gateway
(``eden.observability.ingestion.providers`` decompresses zstd magic
``28 B5 2F FD`` and the ``Content-Encoding: zstd`` header). zstandard is
optional (``pip install eden-sdk[fast]``); without it the gzip branch
produces exactly the bytes the SDK shipped before, so a slim install
cannot regress compatibility with old gateways.

Parity discipline mirrors ``_fast_json``: the fast path may be absent,
but when present it must not change observable behavior. Callers use
:func:`compress_wire` and send whatever encoding it reports back.
"""

from __future__ import annotations

from typing import Any

__all__ = ["compress_wire", "WIRE_GZIP", "WIRE_ZSTD"]

#: ``Content-Encoding`` values this module can emit.
WIRE_GZIP = "gzip"
WIRE_ZSTD = "zstd"

#: zstd frame magic (little-endian 0xFD2FB528). ``providers.py`` uses the
#: same constant to sniff compressed bodies whose header was stripped.
_ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

#: gzip level 1 = the historical wire default; level 1 is deliberately not
#: a ratio play — it is the fastest deflate for telemetry-shaped payloads.
_GZIP_LEVEL = 1

try:  # pragma: no cover - exercised in [fast] installs
    import zstandard as _zstd

    _HAVE_ZSTD = True
except ImportError:  # pragma: no cover - base install
    _zstd = None  # type: ignore[assignment]
    _HAVE_ZSTD = False


def _gzip_compress(raw: bytes) -> bytes:
    import gzip

    return gzip.compress(raw, compresslevel=_GZIP_LEVEL)


def _zstd_compress(raw: bytes) -> bytes:
    # A module-level compressor is not safe to share across threads
    # (zstandard docs), and the send path can be called from worker
    # threads. Constructing per call is the same pattern the backend
    # storage layer uses; the cost is negligible next to the network.
    assert _zstd is not None  # guarded by _HAVE_ZSTD
    return _zstd.ZstdCompressor(level=3).compress(raw)


def compress_wire(raw: bytes) -> tuple[bytes, str]:
    """Compress ``raw`` for the wire.

    Returns ``(body, content_encoding)``. Prefers zstd level 3 when
    ``zstandard`` is installed, else gzip level 1. Never raises for a
    compression failure (falls through to gzip, then identity) so a
    broken optional extra cannot kill telemetry.
    """
    if _HAVE_ZSTD:
        try:
            return _zstd_compress(raw), WIRE_ZSTD
        except Exception:  # noqa: BLE001 - optional fast path
            pass
    try:
        return _gzip_compress(raw), WIRE_GZIP
    except Exception:  # noqa: BLE001 - last-resort identity
        return raw, "identity"


def is_zstd_body(body: bytes) -> bool:
    """True when ``body`` starts with a zstd frame magic."""
    return len(body) >= 4 and body[:4] == _ZSTD_MAGIC


def _wire_payload() -> dict[str, Any]:
    """Expose the active wire codec for diagnostics (used by tests)."""
    return {
        "zstd": _HAVE_ZSTD,
        "magic": _ZSTD_MAGIC,
    }
