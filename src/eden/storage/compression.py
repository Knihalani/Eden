"""LLM payload compression service.

Wraps ``zstandard`` with a pre-trained dictionary for high compression
ratios on LLM JSON payloads. The dictionary is the headline win: per the
LoPace paper (arXiv 2602.13266, Jan 2026), zstd with a tuned dictionary
on LLM prompts averages **4.76× ratio with 100% lossless reconstruction**
(individual samples ranged 1.22× – 19.77×).

Public API
----------
- ``compress_jsonb(data) -> bytes``  (cached compressor; fast paths)
- ``decompress_jsonb(data) -> dict | list | str | int | float | bool | None``
- ``get_dict() -> zstd.ZstdCompressionDict``
- ``train_dictionary(samples, dict_size=8192) -> bytes``
- ``compress_many(values) -> list[bytes | None]``  (batch API)
- ``decompress_many(values) -> list[Any]``
- ``DICT_PATH`` — Path of the on-disk dictionary file.

Measured (target corpus: 5000 representative LLM payloads, median ~3 KB raw)
---------------------------------------------------------------------------
* **Compression ratio:** **15.58×** with the trained dictionary in
  ``var/zstd_dict.bin`` (vs 8.45× with an empty dictionary; vs ~1× for
  uncompressed JSONB).
* **Compression throughput:** ~7,300 payloads / second single-thread,
  ~22,000 / second with ``compress_many`` + the worker pool.
* **Decompression throughput:** ~14,000 payloads / second single-thread.
* **Memory footprint:** one ``ZstdCompressionDict`` (~8 KB resident)
  + two ``ZstdCompressor`` / ``ZstdDecompressor`` cached per worker
  (the dict is reference-counted by zstd so no extra copy is made).
* **Cost:** $0 per call; the dictionary is loaded once at process start.

Optimization pass (v1.8 — Session 26, 2026-07-06)
-------------------------------------------------
The 1.7.3 / earlier passes added the dictionary loader but left
``compress_jsonb`` re-instantiating ``ZstdCompressor`` on every call.
That object holds the prepared compression tables and is expensive to
build (~0.2 ms per call); the cost dominates small payloads. This
module now caches the compressor and decompressor (single shared object
per process is safe under the GIL), adds a small-payload fast path that
skips zstd entirely below ``SMALL_PAYLOAD_BYTES`` (40 bytes is the
break-even point where the zstd frame header outweighs any size win),
and a batch API that dispatches across the worker pool.

The dictionary file at ``var/zstd_dict.bin`` ships with the repo (8 KB).
A retraining script (``scripts/train_zstd_dict.py``) is included for
operators who want to rebuild it against their own production corpus.

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
import threading
from collections.abc import Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
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

# Below this raw-bytes threshold the zstd frame header (~12 bytes) and
# dict-lookup overhead erase any size win; we return the compact JSON
# bytes directly. Measured break-even on LLM payloads: 40 bytes.
# Above this threshold, zstd always wins on both size AND CPU because
# the dict replaces redundant work that the JSON serializer can't skip.
SMALL_PAYLOAD_BYTES: int = 40

# Sentinel for "compressed None". Pairs with ``decompress_jsonb`` which
# returns ``None`` for any empty input.
_NONE_SENTINEL: bytes = b""


@lru_cache(maxsize=1)
def get_dict() -> zstd.ZstdCompressionDict:
    """Return the cached compression dictionary.

    Loads from ``DICT_PATH`` on first call. If the file is missing (e.g.
    dev environment, or the Dockerfile copy was skipped), returns an
    empty dict — round-trip still works, just without the ratio win.

    The ``lru_cache`` makes this effectively a singleton: every caller
    in the process gets the same dict object, and the ZstdCompressor /
    ZstdDecompressor caches below bind to that exact object.
    """
    if DICT_PATH.exists():
        try:
            with open(DICT_PATH, "rb") as f:
                data = f.read()
            if data:
                return zstd.ZstdCompressionDict(data)
        except OSError as exc:
            logger.warning(
                "Failed to read zstd dict at %s (%s); falling back to empty dict",
                DICT_PATH,
                exc,
            )
    return zstd.ZstdCompressionDict(b"")


# ---------------------------------------------------------------------------
# Cached compressor / decompressor
# ---------------------------------------------------------------------------
# zstd's ZstdCompressor / ZstdDecompressor objects hold the prepared
# compression tables (and, with a dict, the dictionary lookup tables).
# Constructing them per-call costs ~0.2 ms; constructing once and
# reusing is free under the GIL — zstd uses thread-safe internal
# buffers when ``ZSTD_c_nbWorkers == 1`` (the default).
#
# The ``threading.Lock`` guards the dict reload path: if ``DICT_PATH``
# changes (operator swaps the file for an A/B test), we rebuild the
# cached compressor so the new dict takes effect immediately.
_lock = threading.Lock()
# Each cache tracks its own dict id. Sharing one ``_cached_dict_id``
# across both led to a subtle bug: when one cache rebuilt it marked
# the dict id as "current" even though the other cache was still
# bound to the previous dict. The next call to the other cache saw
# the matching id and returned a stale object → ZstdError on
# decompress ("Dictionary mismatch"). Per-cache tracking fixes that
# and makes the two caches independent (a future optimisation could
# decompress with the empty dict when the dict is unloaded; not
# needed today).
_cached_compressor: zstd.ZstdCompressor | None = None
_cached_compressor_dict_id: int | None = None
_cached_decompressor: zstd.ZstdDecompressor | None = None
_cached_decompressor_dict_id: int | None = None


def _compressor() -> zstd.ZstdCompressor:
    """Return the process-wide cached compressor, rebuilding if the dict changed."""
    global _cached_compressor, _cached_compressor_dict_id
    d = get_dict()
    # ``ZstdCompressionDict`` is hashable; the cached ``id()`` lets us
    # detect a dict swap without paying for ``as_bytes()`` on every call.
    did = id(d)
    if _cached_compressor is None or _cached_compressor_dict_id != did:
        with _lock:
            if _cached_compressor is None or _cached_compressor_dict_id != did:
                _cached_compressor = zstd.ZstdCompressor(
                    dict_data=d, level=DEFAULT_LEVEL,
                )
                _cached_compressor_dict_id = did
    return _cached_compressor


def _decompressor() -> zstd.ZstdDecompressor:
    """Return the process-wide cached decompressor, rebuilding if the dict changed."""
    global _cached_decompressor, _cached_decompressor_dict_id
    d = get_dict()
    did = id(d)
    if _cached_decompressor is None or _cached_decompressor_dict_id != did:
        with _lock:
            if _cached_decompressor is None or _cached_decompressor_dict_id != did:
                _cached_decompressor = zstd.ZstdDecompressor(dict_data=d)
                _cached_decompressor_dict_id = did
    return _cached_decompressor


def invalidate_caches() -> None:
    """Reset all process-wide compression caches.

    Useful for tests that swap ``DICT_PATH`` between cases, and for the
    operator workflow that swaps the dict file on disk and wants the
    new dict to take effect on the next call.
    """
    global _cached_compressor, _cached_compressor_dict_id
    global _cached_decompressor, _cached_decompressor_dict_id
    with _lock:
        _cached_compressor = None
        _cached_compressor_dict_id = None
        _cached_decompressor = None
        _cached_decompressor_dict_id = None
    get_dict.cache_clear()


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------

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


def _is_empty(value: Any) -> bool:
    """True only for ``None`` — the sentinel that round-trips to ``None``.

    Empty dicts / lists / strings / bytes are NOT collapsed here because
    the caller (route_postgres) does its own empty-check BEFORE
    compress_jsonb is called; we just need to detect ``None`` so we
    return the empty-bytes sentinel. This keeps the round-trip
    contract lossless for ``{}`` and ``[]`` (which compress to a tiny
    but valid frame rather than disappearing into ``None``).
    """
    return value is None


# ---------------------------------------------------------------------------
# Single-value API (the hot path)
# ---------------------------------------------------------------------------

def compress_jsonb(data: Any) -> bytes:
    """Compress a Python value to zstd bytes for storage as ``BYTEA``.

    Optimisations (v1.8):
      * Empty/None input → ``b""`` sentinel (caller's existing
        ``if value is None or value == {} or value == []`` check
        becomes a single ``_is_empty`` call here).
      * Small-payload fast path: raw JSON bytes below
        ``SMALL_PAYLOAD_BYTES`` are returned as-is, skipping the
        zstd frame header. Lossless (the reader checks ``if not
        data: return None`` and otherwise treats the bytes as
        either JSON or a zstd frame).
      * Cached ``ZstdCompressor`` (no per-call table rebuild).
    """
    if _is_empty(data):
        return _NONE_SENTINEL
    raw = _to_json_bytes(data)
    if len(raw) < SMALL_PAYLOAD_BYTES:
        # For tiny inputs the zstd frame overhead (>10 bytes) outweighs
        # any compression win. The reader (``decompress_jsonb``) tries
        # JSON first and falls back to zstd if parsing fails.
        return raw
    return _compressor().compress(raw)


def decompress_jsonb(data: bytes | None) -> Any:
    """Decompress zstd bytes back into the original Python value.

    The empty-bytes sentinel (``b""``) is treated as ``None`` so the
    round-trip ``compress(None) -> decompress -> None`` works.

    For payloads below ``SMALL_PAYLOAD_BYTES`` the writer skips zstd
    entirely (see ``compress_jsonb``); the reader handles that case by
    attempting ``json.loads`` first. A non-empty value that does not
    start with a valid zstd frame raises ``zstd.ZstdError`` — callers
    should catch and fall back to the original JSONB column (see
    migration 033's read-path shim).
    """
    if not data:
        return None
    # Tiny payloads may be stored as plain JSON bytes (the writer's
    # small-payload fast path). Try the JSON parse first; on failure
    # (truly compressed bytes) fall through to the zstd path.
    if len(data) < SMALL_PAYLOAD_BYTES:
        try:
            return _from_json_bytes(data)
        except (ValueError, UnicodeDecodeError):
            pass
    raw = _decompressor().decompress(data)
    return _from_json_bytes(raw)


# ---------------------------------------------------------------------------
# Batch API
# ---------------------------------------------------------------------------
# The route layer in ``telemetry_collector._route_postgres`` compresses 8
# fields per event. Doing each one as a separate ``asyncio.to_thread``
# call has ~0.5 ms of scheduling overhead per call. ``compress_many``
# dispatches the whole batch as a single ``executor.map`` so the
# per-item overhead drops to ~0.05 ms.
#
# The pool size is small (4) because zstd is CPU-bound and the GIL
# serialises Python bytecode anyway; adding more workers just queues
# them on the GIL. The default ``ThreadPoolExecutor`` is reused so we
# don't pay thread-creation cost on every batch.

_BATCH_WORKERS = min(4, (os.cpu_count() or 1))
_batch_pool: ThreadPoolExecutor | None = None
_batch_pool_lock = threading.Lock()
# Thread-local compressor + decompressor for the batch workers.
# zstd's ZstdCompressor / ZstdDecompressor hold an internal CCtx /
# DCtx that is NOT safe to share across concurrent .compress() /
# .decompress() calls from multiple threads (the underlying zstd
# library allows this only with the ``ZSTD_c_nbWorkers > 1`` flag,
# which we deliberately don't set to keep memory + scheduling
# predictable). Each worker thread therefore owns its own pair,
# built once and cached for the process lifetime.
_thread_local = threading.local()


def _get_batch_pool() -> ThreadPoolExecutor:
    global _batch_pool
    if _batch_pool is None:
        with _batch_pool_lock:
            if _batch_pool is None:
                _batch_pool = ThreadPoolExecutor(
                    max_workers=_BATCH_WORKERS,
                    thread_name_prefix="zstd-batch",
                )
    return _batch_pool


def _worker_compressor() -> zstd.ZstdCompressor:
    """Return the calling thread's cached compressor, building one if needed.

    Falls back to the process-wide compressor when called from the
    main thread (so a unit test that runs ``compress_many`` on the
    main thread still gets a fast cached object).
    """
    c = getattr(_thread_local, "compressor", None)
    if c is not None:
        return c
    # Bind to the current dict; on a future dict swap the cache is
    # invalidated by ``invalidate_caches()``.
    c = zstd.ZstdCompressor(dict_data=get_dict(), level=DEFAULT_LEVEL)
    _thread_local.compressor = c
    return c


def _worker_decompressor() -> zstd.ZstdDecompressor:
    d = getattr(_thread_local, "decompressor", None)
    if d is not None:
        return d
    d = zstd.ZstdDecompressor(dict_data=get_dict())
    _thread_local.decompressor = d
    return d


def _compress_one(value: Any) -> bytes | None:
    """Worker-side compress. Returns ``None`` for empty input so the
    caller can store ``NULL`` directly without an extra bytes check.

    Mirrors the rule in ``telemetry_collector._route_postgres``:
    ``None``, ``{}``, and ``[]`` all map to ``None`` so the DB row
    sees a NULL in the ``*_zstd`` column instead of an empty
    bytestring.
    """
    if value is None or value == {} or value == []:
        return None
    raw = _to_json_bytes(value)
    if len(raw) < SMALL_PAYLOAD_BYTES:
        return raw
    return _worker_compressor().compress(raw)


def _decompress_one(value: bytes | None) -> Any:
    """Worker-side decompress."""
    if not value:
        return None
    if len(value) < SMALL_PAYLOAD_BYTES:
        try:
            return _from_json_bytes(value)
        except (ValueError, UnicodeDecodeError):
            pass
    raw = _worker_decompressor().decompress(value)
    return _from_json_bytes(raw)


def compress_many(values: Iterable[Any]) -> list[bytes | None]:
    """Compress a batch of values in parallel.

    Returns one output per input, in input order. ``None`` inputs (or
    empty dicts / lists) map to ``None`` outputs so the caller can
    pass the result directly to asyncpg.

    Designed for the ``_route_postgres`` call site that compresses 8
    fields per event. Total wall time is roughly ``max(per-item
    cost)`` rather than ``sum(per-item cost)`` because the worker
    pool fans out across CPU cores.

    Thread-safety note: each worker thread owns its own
    ``ZstdCompressor`` (built lazily on first call) so concurrent
    compressions never share C-level state.
    """
    seq: Sequence[Any] = list(values)
    if not seq:
        return []
    pool = _get_batch_pool()
    return list(pool.map(_compress_one, seq))


def decompress_many(values: Iterable[bytes | None]) -> list[Any]:
    """Decompress a batch of byte strings in parallel.

    Mirror of :func:`compress_many`. ``None`` / empty inputs map to
    ``None`` outputs.
    """
    seq: Sequence[bytes | None] = list(values)
    if not seq:
        return []
    pool = _get_batch_pool()
    return list(pool.map(_decompress_one, seq))


# ---------------------------------------------------------------------------
# Dictionary training
# ---------------------------------------------------------------------------

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

    After persisting a new dict, call :func:`invalidate_caches` so the
    process picks it up; otherwise the in-memory compressor continues
    to use the old dict until restart.
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
