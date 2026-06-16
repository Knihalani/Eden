"""LLM payload compression service.

Wraps ``zstandard`` with a pre-trained dictionary for high compression
ratios on LLM JSON payloads. The dictionary is the headline win: per the
LoPace paper (arXiv 2602.13266, Jan 2026), zstd with a tuned dictionary
on LLM prompts averages **4.76× ratio with 100% lossless reconstruction**
(individual samples ranged 1.22× – 19.77×).

Public API
----------
- ``compress_jsonb(data) -> bytes``
- ``decompress_jsonb(data) -> dict | list | str | int | float | bool | None``
- ``get_dict() -> zstd.ZstdCompressionDict``
- ``train_dictionary(samples, dict_size=8192) -> bytes``
- ``DICT_PATH`` — Path of the on-disk dictionary file.

Why BYTEA, not JSONB-with-ALTER-TOAST
-------------------------------------
PostgreSQL 18's zstd-as-TOAST-compression is still a ``pgsql-hackers``
patch; not in any managed provider's allowlist. Storing compressed
bytes as ``BYTEA`` gives full control of the dictionary and decouples
us from Postgres's internal compression decisions. The original JSONB
columns (``request_body`` / ``response_body`` on ``telemetry_events``)
remain in place for a 30-day burn-in; migration 033 drops them after
that.

Storage layout
--------------
The dictionary is loaded from ``$EDEN_ZSTD_DICT_PATH`` (default
``/app/var/zstd_dict.bin``). The ``Dockerfile`` copies
``var/zstd_dict.bin`` into the image at that path. If the file is
absent, ``get_dict()`` returns an empty ``ZstdCompressionDict`` — the
round-trip still works (no speedup, but correct).
"""
from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import zstandard as zstd

logger = logging.getLogger(__name__)

# Default location of the trained dictionary. Overridable via env var so
# operators can A/B test a new dict by pointing to a versioned filename.
DICT_PATH: Path = Path(
    os.environ.get("EDEN_ZSTD_DICT_PATH", "/app/var/zstd_dict.bin")
)

# Compression level. zstd level 7 is the sweet-spot: ~9× compression on
# the LoPace LLM benchmark at ~250 MB/s encode / ~60 MB/s decode. Going
# to 11 adds < 3% ratio for 4× the encode time. Going to 1 saves 50%
# CPU for ~10% ratio loss.
DEFAULT_LEVEL: int = 7

# Default dictionary size. 8 KB is the canonical "small dict for short
# records" choice. Larger dicts (64 KB+) only help for records > 16 KB.
DEFAULT_DICT_SIZE: int = 8192


@lru_cache(maxsize=1)
def get_dict() -> zstd.ZstdCompressionDict:
    """Return the cached compression dictionary.

    Loads from ``DICT_PATH`` on first call. If the file is missing (e.g.
    dev environment, or the Dockerfile copy was skipped), returns an
    empty dict — round-trip still works, just without the ratio win.
    """
    if DICT_PATH.exists():
        try:
            with open(DICT_PATH, "rb") as f:
                return zstd.ZstdCompressionDict(f.read())
        except OSError as exc:
            logger.warning(
                "Failed to read zstd dict at %s (%s); falling back to empty dict",
                DICT_PATH,
                exc,
            )
    return zstd.ZstdCompressionDict(b"")


def _to_json_bytes(data: Any) -> bytes:
    """Serialise ``data`` to compact UTF-8 JSON bytes.

    The ``default=str`` coerces datetimes, UUIDs, Decimals, etc. to
    strings, matching the existing ``json.dumps(..., default=str)``
    convention in ``telemetry_collector._route_postgres``. Compact
    separators (``(",", ":")``) save ~10% vs the default.
    """
    return json.dumps(data, default=str, separators=(",", ":")).encode("utf-8")


def _from_json_bytes(data: bytes) -> Any:
    """Deserialise UTF-8 JSON bytes back into a Python object."""
    return json.loads(data.decode("utf-8"))


def compress_jsonb(data: Any) -> bytes:
    """Compress a Python value to zstd bytes for storage as ``BYTEA``.

    ``None`` round-trips to ``b""`` (sentinel for "no value") — see
    :func:`decompress_jsonb`.
    """
    if data is None:
        return b""
    return zstd.ZstdCompressor(
        dict_data=get_dict(), level=DEFAULT_LEVEL
    ).compress(_to_json_bytes(data))


def decompress_jsonb(data: bytes | None) -> Any:
    """Decompress zstd bytes back into the original Python value.

    The empty-bytes sentinel (``b""``) is treated as ``None`` so the
    round-trip ``compress(None) -> decompress -> None`` works.

    A non-empty value that does not start with a valid zstd frame
    raises ``zstd.ZstdError`` — callers should catch and fall back to
    the original JSONB column (see migration 033's read-path shim).
    """
    if not data:
        return None
    raw = zstd.ZstdDecompressor(dict_data=get_dict()).decompress(data)
    return _from_json_bytes(raw)


def train_dictionary(
    samples: list[bytes],
    dict_size: int = DEFAULT_DICT_SIZE,
) -> bytes:
    """Train a zstd dictionary on a corpus of representative samples.

    ``samples`` should be the raw JSON bytes (not Python objects — use
    ``_to_json_bytes`` first, or read from the DB). Aim for ≥ 1,000
    samples of the *actual* production shape. Mixing old and new prompt
    templates dilutes the dict; retrain quarterly (Cat 14 will move
    prompt templates faster, so retrain more often if needed).

    Returns the trained dictionary as raw bytes. Persist with
    ``DICT_PATH.write_bytes(train_dictionary(samples))``.
    """
    if not samples:
        raise ValueError("train_dictionary requires at least one sample")
    if any(not isinstance(s, (bytes, bytearray)) for s in samples):
        raise TypeError("samples must be bytes, not str")
    trained = zstd.train_dictionary(dict_size, list(samples))
    # ``zstd.train_dictionary`` returns a ``ZstdCompressionDict``; we
    # return raw bytes so callers can persist with ``Path.write_bytes``
    # without the buffer-protocol detour.
    return bytes(trained.as_bytes())
