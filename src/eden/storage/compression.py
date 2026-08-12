"""LLM payload compression service.

Wraps ``zstandard`` with column-specific pre-trained dictionaries,
adaptive compression levels, never-expand writes, and dict-id-aware
reads (so retrains stay decodable via archived dictionaries).

Public API
----------
- ``compress_jsonb(data, *, column=None) -> bytes``
- ``decompress_jsonb(data) -> Any``
- ``compress_many(values, *, columns=None) -> list[bytes | None]``
- ``decompress_many(values) -> list[Any]``
- ``get_dict()`` / ``train_dictionary(...)`` — legacy single-dict helpers
- ``TELEMETRY_ZSTD_FIELDS`` — canonical 8-column order for ingest

See ``eden.storage.zstd_registry`` for the multi-dict catalog layout.
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

from eden.storage.zstd_registry import (
    TELEMETRY_ZSTD_FIELDS,
    get_registry,
    set_dicts_dir,
    set_legacy_dict_path,
)
from eden.util.jsonx import dumps_bytes as _jsonx_dumps_bytes

logger = logging.getLogger(__name__)

__all__ = [
    "TELEMETRY_ZSTD_FIELDS",
    "DICT_PATH",
    "DEFAULT_LEVEL",
    "DEFAULT_DICT_SIZE",
    "SMALL_PAYLOAD_BYTES",
    "ZSTD_MAGIC",
    "compress_jsonb",
    "decompress_jsonb",
    "compress_many",
    "decompress_many",
    "get_dict",
    "train_dictionary",
    "invalidate_caches",
    "adaptive_level",
    "set_dicts_dir",
    "set_legacy_dict_path",
]

# Legacy single-dict path (still registered for reads / fallback writes).
DICT_PATH: Path = Path(os.environ.get("EDEN_ZSTD_DICT_PATH", "/app/var/zstd_dict.bin"))

# Baseline level when adaptive leveling is disabled; adaptive_level() is
# the production write default.
DEFAULT_LEVEL: int = 9
DEFAULT_DICT_SIZE: int = 16_384
SMALL_PAYLOAD_BYTES: int = 40
ZSTD_MAGIC: bytes = b"\x28\xb5\x2f\xfd"
_NONE_SENTINEL: bytes = b""

# Wire registry to the legacy path so old frames + old deploys keep working.
set_legacy_dict_path(DICT_PATH)


def _looks_like_zstd(data: bytes) -> bool:
    return len(data) >= 4 and data[:4] == ZSTD_MAGIC


def adaptive_level(raw_len: int) -> int:
    """Pick a zstd level from payload size.

    Small structured fields (metrics/attributes) spend most of their time
    in frame overhead — keep them cheap. Large chat bodies pay for level
    11 where the ratio actually moves.
    """
    if raw_len < 128:
        return 1
    if raw_len < 512:
        return 3
    if raw_len < 2048:
        return 5
    if raw_len < 8192:
        return 9
    return 11


def _maybe_compress(raw: bytes, compressor: zstd.ZstdCompressor) -> bytes:
    compressed = compressor.compress(raw)
    if len(compressed) >= len(raw):
        return raw
    return compressed


# ---------------------------------------------------------------------------
# Compressor / decompressor caches keyed by (registry_gen, dict_id, level)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_compressors: dict[tuple[int, int, int], zstd.ZstdCompressor] = {}
_decompressors: dict[tuple[int, int], zstd.ZstdDecompressor] = {}
_thread_local = threading.local()
_dict_generation = 0  # bumped by invalidate_caches; also tracks legacy get_dict


def _compressor() -> zstd.ZstdCompressor:
    """Legacy test/helper — default-column compressor at ``DEFAULT_LEVEL``."""
    entry = get_registry().entry_for_column(None)
    return _compressor_for(entry.dict_id, DEFAULT_LEVEL, entry.zdict)


def _decompressor() -> zstd.ZstdDecompressor:
    """Legacy test/helper — default-column decompressor."""
    entry = get_registry().entry_for_column(None)
    return _decompressor_for(entry.dict_id, entry.zdict)


def _dict_version(d: Any) -> tuple[int, int]:
    """Legacy test helper — (registry generation, object id)."""
    return (get_registry().generation, id(d))


@lru_cache(maxsize=1)
def get_dict() -> zstd.ZstdCompressionDict:
    """Legacy helper — returns the write dict for the default column."""
    return get_registry().entry_for_column(None).zdict


def _force_legacy_dict(path: Path) -> None:
    """Point writes/reads at a single legacy dict (disable multi-dict catalog)."""
    global DICT_PATH
    DICT_PATH = path
    set_dicts_dir(Path("/nonexistent_eden_zstd_dicts_for_tests"))
    set_legacy_dict_path(path)
    invalidate_caches()


def _compressor_for(dict_id: int, level: int, zdict: zstd.ZstdCompressionDict) -> zstd.ZstdCompressor:
    reg = get_registry()
    key = (reg.generation, dict_id, level)
    c = _compressors.get(key)
    if c is not None:
        return c
    with _lock:
        c = _compressors.get(key)
        if c is None:
            c = zstd.ZstdCompressor(dict_data=zdict, level=level, write_checksum=False)
            _compressors[key] = c
    return c


def _decompressor_for(dict_id: int, zdict: zstd.ZstdCompressionDict | None) -> zstd.ZstdDecompressor:
    reg = get_registry()
    key = (reg.generation, dict_id)
    d = _decompressors.get(key)
    if d is not None:
        return d
    with _lock:
        d = _decompressors.get(key)
        if d is None:
            d = zstd.ZstdDecompressor(dict_data=zdict) if zdict is not None else zstd.ZstdDecompressor()
            _decompressors[key] = d
    return d


def invalidate_caches() -> None:
    """Drop every compressor/decompressor cache + reload the dict registry."""
    global _dict_generation
    with _lock:
        _compressors.clear()
        _decompressors.clear()
        _dict_generation += 1
    get_dict.cache_clear()
    # Keep legacy path in sync if tests swapped DICT_PATH.
    set_legacy_dict_path(DICT_PATH)
    get_registry().invalidate()
    # Thread-locals: bump generation so workers rebuild.
    # (Workers compare against registry.generation.)


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------


def _to_json_bytes(data: Any) -> bytes:
    try:
        return _jsonx_dumps_bytes(data, default=str)
    except TypeError:
        return json.dumps(data, default=str, separators=(",", ":")).encode("utf-8")


def _from_json_bytes(data: bytes) -> Any:
    return json.loads(data.decode("utf-8"))


def _is_empty(value: Any) -> bool:
    return value is None


def _is_trivial(value: Any) -> bool:
    return value is None or value == {} or value == []


# ---------------------------------------------------------------------------
# Core compress / decompress
# ---------------------------------------------------------------------------


def _compress_raw(raw: bytes, *, column: str | None) -> bytes:
    if len(raw) < SMALL_PAYLOAD_BYTES:
        return raw
    entry = get_registry().entry_for_column(column)
    level = adaptive_level(len(raw))
    compressor = _compressor_for(entry.dict_id, level, entry.zdict)
    return _maybe_compress(raw, compressor)


def compress_jsonb(data: Any, *, column: str | None = None) -> bytes:
    """Compress a Python value to zstd/raw bytes for ``BYTEA`` storage."""
    if _is_empty(data):
        return _NONE_SENTINEL
    raw = _to_json_bytes(data)
    return _compress_raw(raw, column=column)


def decompress_jsonb(data: bytes | None) -> Any:
    """Decompress a stored blob. Raw JSON (no magic) parses directly."""
    if not data:
        return None
    if not _looks_like_zstd(data):
        return _from_json_bytes(data)
    raw = _decompress_zstd_frame(data, threaded=False)
    return _from_json_bytes(raw)


# ---------------------------------------------------------------------------
# Batch API
# ---------------------------------------------------------------------------

_BATCH_WORKERS = min(4, (os.cpu_count() or 1))
_batch_pool: ThreadPoolExecutor | None = None
_batch_pool_lock = threading.Lock()


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


def _worker_compressor_for(
    dict_id: int, level: int, zdict: zstd.ZstdCompressionDict
) -> zstd.ZstdCompressor:
    """Thread-local compressor cache (zstd CCtx is not cross-thread safe)."""
    cache: dict[tuple[int, int, int], zstd.ZstdCompressor] = getattr(
        _thread_local, "compressors", None
    ) or {}
    gen = get_registry().generation
    key = (gen, dict_id, level)
    c = cache.get(key)
    if c is not None:
        _thread_local.compressors = cache
        return c
    cache = {k: v for k, v in cache.items() if k[0] == gen}
    c = zstd.ZstdCompressor(dict_data=zdict, level=level, write_checksum=False)
    cache[key] = c
    _thread_local.compressors = cache
    return c


def _worker_decompressor_for(
    dict_id: int, zdict: zstd.ZstdCompressionDict | None
) -> zstd.ZstdDecompressor:
    """Thread-local decompressor cache — same safety constraint as compress."""
    cache: dict[tuple[int, int], zstd.ZstdDecompressor] = getattr(
        _thread_local, "decompressors", None
    ) or {}
    gen = get_registry().generation
    key = (gen, dict_id)
    d = cache.get(key)
    if d is not None:
        _thread_local.decompressors = cache
        return d
    cache = {k: v for k, v in cache.items() if k[0] == gen}
    d = zstd.ZstdDecompressor(dict_data=zdict) if zdict is not None else zstd.ZstdDecompressor()
    cache[key] = d
    _thread_local.decompressors = cache
    return d


def _decompress_zstd_frame(data: bytes, *, threaded: bool = False) -> bytes:
    """Resolve dict_id from the frame header and decompress.

    ``threaded=True`` uses the calling thread's decompressor cache (required
    for ``decompress_many`` workers — sharing a ``ZstdDecompressor`` across
    threads corrupts output).
    """
    pick = _worker_decompressor_for if threaded else _decompressor_for
    try:
        params = zstd.get_frame_parameters(data)
        frame_dict_id = int(params.dict_id)
    except zstd.ZstdError:
        frame_dict_id = -1

    reg = get_registry()
    if frame_dict_id > 0:
        entry = reg.entry_for_dict_id(frame_dict_id)
        if entry is not None:
            return pick(entry.dict_id, entry.zdict).decompress(data)
        for entry in reg.all_read_entries():
            try:
                return pick(entry.dict_id, entry.zdict).decompress(data)
            except zstd.ZstdError:
                continue
        raise zstd.ZstdError(f"no registered dictionary for dict_id={frame_dict_id}")

    try:
        return pick(0, None).decompress(data)
    except zstd.ZstdError:
        entry = reg.entry_for_column(None)
        return pick(entry.dict_id, entry.zdict).decompress(data)


def _compress_one(value: Any) -> bytes | None:
    """Legacy single-arg worker entry (no column → default dict)."""
    return _compress_one_keyed((value, None))


def _compress_one_keyed(item: tuple[Any, str | None]) -> bytes | None:
    value, column = item
    if value is None or value == {} or value == []:
        return None
    raw = _to_json_bytes(value)
    if len(raw) < SMALL_PAYLOAD_BYTES:
        return raw
    entry = get_registry().entry_for_column(column)
    level = adaptive_level(len(raw))
    compressor = _worker_compressor_for(entry.dict_id, level, entry.zdict)
    return _maybe_compress(raw, compressor)


def _decompress_one(value: bytes | None) -> Any:
    if not value:
        return None
    if not _looks_like_zstd(value):
        try:
            return _from_json_bytes(value)
        except (ValueError, UnicodeDecodeError) as exc:
            logger.warning("raw zstd-column JSON parse failed (%s); returning None", exc)
            return None
    try:
        raw = _decompress_zstd_frame(value, threaded=True)
        return _from_json_bytes(raw)
    except zstd.ZstdError as exc:
        logger.warning("zstd decompress failed (%s); returning None for fallback", exc)
        return None
    except (ValueError, UnicodeDecodeError) as exc:
        logger.warning("zstd payload JSON parse failed (%s); returning None", exc)
        return None


def compress_many(
    values: Iterable[Any],
    *,
    columns: Sequence[str | None] | None = None,
) -> list[bytes | None]:
    """Compress a batch of values in parallel.

    ``columns`` (optional) selects per-value dictionaries. When omitted and
    ``len(values)`` is a multiple of 8, the telemetry field order
    (:data:`TELEMETRY_ZSTD_FIELDS`) is assumed — matching
    ``TelemetryCollector._compress_fields``.
    """
    seq: Sequence[Any] = list(values)
    if not seq:
        return []
    if columns is None:
        cols = [None] * len(seq)
    else:
        if len(columns) != len(seq):
            raise ValueError(
                f"columns length {len(columns)} != values length {len(seq)}"
            )
        cols = list(columns)

    out: list[bytes | None] = [None] * len(seq)
    todo = [(i, seq[i], cols[i]) for i in range(len(seq)) if not _is_trivial(seq[i])]
    if not todo:
        return out
    pool = _get_batch_pool()
    results = pool.map(_compress_one_keyed, [(v, c) for _, v, c in todo])
    for (idx, _, _), result in zip(todo, results, strict=True):
        out[idx] = result
    return out


def decompress_many(values: Iterable[bytes | None]) -> list[Any]:
    seq: Sequence[bytes | None] = list(values)
    if not seq:
        return []
    out: list[Any] = [None] * len(seq)
    todo = [(i, v) for i, v in enumerate(seq) if v]
    if not todo:
        return out
    pool = _get_batch_pool()
    results = pool.map(_decompress_one, [v for _, v in todo])
    for (idx, _), result in zip(todo, results, strict=True):
        out[idx] = result
    return out


# ---------------------------------------------------------------------------
# Dictionary training
# ---------------------------------------------------------------------------


def train_dictionary(
    samples: list[bytes],
    dict_size: int = DEFAULT_DICT_SIZE,
    *,
    dict_id: int | None = None,
) -> bytes:
    """Train a zstd dictionary. Pass ``dict_id`` so frames embed a stable id."""
    if not samples:
        raise ValueError("train_dictionary requires at least one sample")
    if any(not isinstance(s, (bytes, bytearray)) for s in samples):
        raise TypeError("samples must be bytes, not str")
    kwargs: dict[str, Any] = {}
    if dict_id is not None:
        kwargs["dict_id"] = int(dict_id)
    trained = zstd.train_dictionary(dict_size, list(samples), **kwargs)
    return bytes(trained.as_bytes())
