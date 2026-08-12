"""Multi-dictionary registry for Eden zstd storage.

Write path picks a column-specific dictionary (and embeds its zstd
``dict_id`` in the frame). Read path resolves the frame's ``dict_id``
against every known dictionary — including archived previous versions —
so retraining does not brick old ``*_zstd`` rows even after plaintext
dual-write is turned off.

Layout (default ``var/zstd_dicts/``)::

    catalog.json
    general.bin
    request_body.bin
    response_body.bin
    structured.bin
    archive/          # previous .bin files kept for decompress only

``var/zstd_dict.bin`` remains supported as a legacy single-dict fallback
(registered for reads; used for writes only when the catalog is absent).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import zstandard as zstd

logger = logging.getLogger(__name__)

# Stable write-time dict ids. Never reuse an id after the bytes change —
# bump the id (and archive the old file) on retrain.
DICT_ID_GENERAL = 1
DICT_ID_REQUEST = 2
DICT_ID_RESPONSE = 3
DICT_ID_STRUCTURED = 4

TELEMETRY_ZSTD_FIELDS: tuple[str, ...] = (
    "request_body",
    "response_body",
    "reasoning",
    "tool_calls_full",
    "tool_results",
    "payload",
    "metrics",
    "attributes",
)

DEFAULT_COLUMN_TO_DICT = {
    "request_body": "request_body",
    "response_body": "response_body",
    "reasoning": "response_body",
    "tool_calls_full": "structured",
    "tool_results": "structured",
    "payload": "structured",
    "metrics": "structured",
    "attributes": "structured",
    "_default": "general",
}

DEFAULT_DICT_SPECS = {
    "general": {"file": "general.bin", "dict_id": DICT_ID_GENERAL},
    "request_body": {"file": "request_body.bin", "dict_id": DICT_ID_REQUEST},
    "response_body": {"file": "response_body.bin", "dict_id": DICT_ID_RESPONSE},
    "structured": {"file": "structured.bin", "dict_id": DICT_ID_STRUCTURED},
}


def default_dicts_dir() -> Path:
    env = os.environ.get("EDEN_ZSTD_DICTS_DIR")
    if env:
        return Path(env)
    # Prefer repo/image layout; fall back next to legacy single dict.
    candidates = (
        Path("/app/var/zstd_dicts"),
        Path(__file__).resolve().parents[3] / "var" / "zstd_dicts",
    )
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[1]


@dataclass(frozen=True)
class DictEntry:
    name: str
    dict_id: int
    path: Path
    zdict: zstd.ZstdCompressionDict


class DictRegistry:
    """Process-wide dictionary catalog (thread-safe lazy load)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_id: dict[int, DictEntry] = {}
        self._by_name: dict[str, DictEntry] = {}
        self._column_map: dict[str, str] = dict(DEFAULT_COLUMN_TO_DICT)
        self._loaded = False
        self._generation = 0
        self.dicts_dir: Path = default_dicts_dir()
        self.legacy_path: Path | None = None

    @property
    def generation(self) -> int:
        return self._generation

    def invalidate(self) -> None:
        with self._lock:
            self._by_id.clear()
            self._by_name.clear()
            self._column_map = dict(DEFAULT_COLUMN_TO_DICT)
            self._loaded = False
            self._generation += 1

    def ensure_loaded(self) -> None:
        if self._loaded:
            return
        with self._lock:
            if self._loaded:
                return
            self._load_unlocked()
            self._loaded = True

    def _load_unlocked(self) -> None:
        self._by_id.clear()
        self._by_name.clear()
        self._column_map = dict(DEFAULT_COLUMN_TO_DICT)
        catalog_path = self.dicts_dir / "catalog.json"
        if catalog_path.is_file():
            try:
                catalog = json.loads(catalog_path.read_text())
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Failed to read zstd catalog %s (%s)", catalog_path, exc)
                catalog = {}
            write_map = catalog.get("write") or {}
            if isinstance(write_map, dict) and write_map:
                self._column_map = {str(k): str(v) for k, v in write_map.items()}
            specs = catalog.get("dicts") or DEFAULT_DICT_SPECS
            for name, spec in specs.items():
                rel = spec.get("file") if isinstance(spec, dict) else None
                did = int(spec.get("dict_id", 0)) if isinstance(spec, dict) else 0
                if not rel or not did:
                    continue
                path = self.dicts_dir / rel
                self._try_register(name, did, path)
            # Archive: every *.bin is registered for reads (id from file header).
            archive = self.dicts_dir / "archive"
            if archive.is_dir():
                for path in archive.glob("*.bin"):
                    self._try_register_archive(path)
        # Legacy single-dict file always registered for read (+ write fallback).
        if self.legacy_path and self.legacy_path.is_file():
            self._try_register("legacy", 0, self.legacy_path, allow_id_zero=True)
            legacy = self._by_name.get("legacy")
            if legacy is not None:
                # Without a catalog, the legacy file is the write dict for every
                # column — preserves pre-multi-dict behaviour for tests/dev.
                self._by_name.setdefault("general", legacy)
                for col_dict in ("request_body", "response_body", "structured"):
                    self._by_name.setdefault(col_dict, legacy)
        if not self._by_name:
            # Empty in-memory dict so compress still works.
            empty = zstd.ZstdCompressionDict(b"")
            entry = DictEntry(name="empty", dict_id=0, path=Path(""), zdict=empty)
            self._by_name["empty"] = entry
            self._by_name["general"] = entry
            self._by_id[0] = entry

    def _try_register(
        self,
        name: str,
        dict_id: int,
        path: Path,
        *,
        allow_id_zero: bool = False,
    ) -> None:
        if not path.is_file():
            return
        try:
            data = path.read_bytes()
        except OSError as exc:
            logger.warning("Failed to read zstd dict %s (%s)", path, exc)
            return
        if not data:
            return
        zdict = zstd.ZstdCompressionDict(data)
        file_id = int(zdict.dict_id())
        # Prefer the id embedded in the trained dict; catalog id is a hint.
        use_id = file_id or dict_id
        if use_id == 0 and not allow_id_zero:
            # Force a non-zero id at train time; skip broken files.
            logger.warning("zstd dict %s has dict_id=0; skipping write registration", path)
        entry = DictEntry(name=name, dict_id=use_id, path=path, zdict=zdict)
        self._by_name[name] = entry
        if use_id not in self._by_id:
            self._by_id[use_id] = entry

    def _try_register_archive(self, path: Path) -> None:
        try:
            data = path.read_bytes()
        except OSError:
            return
        if not data:
            return
        zdict = zstd.ZstdCompressionDict(data)
        use_id = int(zdict.dict_id())
        if use_id == 0:
            return
        if use_id in self._by_id:
            return  # current write dict wins
        entry = DictEntry(name=f"archive:{path.stem}", dict_id=use_id, path=path, zdict=zdict)
        self._by_id[use_id] = entry

    def entry_for_column(self, column: str | None) -> DictEntry:
        self.ensure_loaded()
        name = self._column_map.get(column or "", self._column_map.get("_default", "general"))
        entry = self._by_name.get(name) or self._by_name.get("general") or self._by_name.get("empty")
        assert entry is not None
        return entry

    def entry_for_dict_id(self, dict_id: int) -> DictEntry | None:
        self.ensure_loaded()
        return self._by_id.get(dict_id)

    def write_entries(self) -> list[DictEntry]:
        self.ensure_loaded()
        return list(self._by_name.values())

    def all_read_entries(self) -> list[DictEntry]:
        self.ensure_loaded()
        return list(self._by_id.values())


_REGISTRY = DictRegistry()


def get_registry() -> DictRegistry:
    return _REGISTRY


def set_dicts_dir(path: Path | None) -> None:
    """Test/helper hook — point the registry at a different catalog tree.

    Pass a non-existent path to force legacy-single-dict mode (catalog absent).
    Pass ``None`` to restore the default search path.
    """
    reg = _REGISTRY
    reg.invalidate()
    reg.dicts_dir = default_dicts_dir() if path is None else path


def set_legacy_dict_path(path: Path | None) -> None:
    reg = _REGISTRY
    reg.invalidate()
    reg.legacy_path = path
