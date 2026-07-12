"""N09 — content-addressed blob store (org-scoped dedupe).

Complements the shipped trace-scoped :mod:`eden.observability.message_store`
(Laminar O(k) message dedupe). This module interns larger payloads
(system prompts, tool schemas, tool results) once per ``(org_id, hash)``
with zstd-compressed bytes.

Kill switch: ``Settings.content_dedupe_enabled`` / ``EDEN_CONTENT_DEDUPE_ENABLED``.
When disabled, :meth:`BlobStore.get_or_put` returns an inline ref and does
not intern (rollback path from the N09 spec).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger(__name__)

MIN_BLOB_SIZE = 512

ContentType = Literal["messages", "tool_schema", "tool_result", "system_prompt", "other"]

_UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.I,
)
_ISO_TS_RE = re.compile(
    r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b"
)


@dataclass(frozen=True)
class BlobRef:
    """Opaque content reference returned to span writers."""

    content_hash: str
    content_type: str
    byte_size: int
    inline: bool = False
    reused: bool = False


def normalize_content(content: Any, content_type: ContentType = "other") -> bytes:
    """Normalize then serialize content for hashing.

    Rules (N09 §5):
      * system_prompt — trim / collapse whitespace
      * tool_schema — sort JSON keys
      * tool_result — strip UUIDs / ISO timestamps in string leaves
      * messages / other — canonical JSON when dict/list, else utf-8
    """
    if isinstance(content, bytes):
        raw = content
        if content_type == "system_prompt":
            text = raw.decode("utf-8", errors="replace")
            return _collapse_ws(text).encode("utf-8")
        return raw

    if isinstance(content, str):
        text = content
        if content_type == "system_prompt":
            text = _collapse_ws(text)
        elif content_type == "tool_result":
            text = _strip_volatile(text)
        return text.encode("utf-8")

    if content_type == "tool_result":
        content = _strip_volatile_obj(content)
    return json.dumps(
        content,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")


def _collapse_ws(text: str) -> str:
    return re.sub(r"[ \t]+", " ", text.strip())


def _strip_volatile(text: str) -> str:
    text = _UUID_RE.sub("<uuid>", text)
    return _ISO_TS_RE.sub("<ts>", text)


def _strip_volatile_obj(obj: Any) -> Any:
    if isinstance(obj, str):
        return _strip_volatile(obj)
    if isinstance(obj, list):
        return [_strip_volatile_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _strip_volatile_obj(v) for k, v in obj.items()}
    return obj


@dataclass
class BlobStore:
    """Org-scoped content-addressed store.

    Hot path is an in-process dict (tests + single-node). When Postgres is
    available, :meth:`get_or_put` also upserts into ``span_content_blobs``.
    """

    min_blob_size: int = MIN_BLOB_SIZE
    _memory: dict[tuple[str, str], bytes] = field(default_factory=dict)
    _ref_counts: dict[tuple[str, str], int] = field(default_factory=dict)
    _stats: dict[str, int] = field(
        default_factory=lambda: {
            "puts": 0,
            "reuses": 0,
            "inlines": 0,
            "bytes_stored": 0,
            "bytes_seen": 0,
        }
    )

    def enabled(self) -> bool:
        try:
            from eden.config import get_settings

            return bool(getattr(get_settings(), "content_dedupe_enabled", True))
        except Exception:
            return True

    def get_or_put(
        self,
        org_id: str,
        content: Any,
        content_type: ContentType = "other",
    ) -> BlobRef:
        """Intern ``content``; return a hash ref (or inline when disabled/small)."""
        raw = normalize_content(content, content_type)
        self._stats["bytes_seen"] += len(raw)
        content_hash = hashlib.sha256(raw).hexdigest()

        if not self.enabled() or len(raw) < self.min_blob_size:
            self._stats["inlines"] += 1
            return BlobRef(
                content_hash=content_hash,
                content_type=content_type,
                byte_size=len(raw),
                inline=True,
                reused=False,
            )

        key = (org_id, content_hash)
        reused = key in self._memory
        if not reused:
            compressed = self._compress(raw)
            self._memory[key] = compressed
            self._ref_counts[key] = 1
            self._stats["puts"] += 1
            self._stats["bytes_stored"] += len(compressed)
        else:
            self._ref_counts[key] = self._ref_counts.get(key, 0) + 1
            self._stats["reuses"] += 1

        return BlobRef(
            content_hash=content_hash,
            content_type=content_type,
            byte_size=len(raw),
            inline=False,
            reused=reused,
        )

    def get(self, org_id: str, content_hash: str) -> bytes | None:
        """Return decompressed bytes for a hash, or None."""
        key = (org_id, content_hash)
        compressed = self._memory.get(key)
        if compressed is None:
            return None
        return self._decompress(compressed)

    def dedupe_ratio(self) -> float:
        """bytes_seen / bytes_stored (1.0 = no savings yet)."""
        stored = self._stats["bytes_stored"]
        seen = self._stats["bytes_seen"]
        if stored <= 0:
            return 1.0
        return seen / stored

    def stats(self) -> dict[str, int | float]:
        out: dict[str, int | float] = dict(self._stats)
        out["dedupe_ratio"] = self.dedupe_ratio()
        out["unique_blobs"] = len(self._memory)
        return out

    async def persist_ref(
        self,
        org_id: str,
        ref: BlobRef,
        content: Any,
        content_type: ContentType = "other",
    ) -> bool:
        """Best-effort upsert into ``span_content_blobs``."""
        if ref.inline or not self.enabled():
            return False
        raw = normalize_content(content, content_type)
        compressed = self._compress(raw)
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
        except Exception as exc:
            logger.debug("blob_store: postgres unavailable: %s", exc)
            return False
        if client is None:
            return False
        try:
            await client.execute(
                """
                INSERT INTO span_content_blobs (
                    org_id, content_hash, content, content_type,
                    byte_size, ref_count
                )
                VALUES ($1, $2, $3, $4, $5, 1)
                ON CONFLICT (org_id, content_hash) DO UPDATE SET
                    ref_count = span_content_blobs.ref_count + 1
                """,
                org_id,
                ref.content_hash,
                compressed,
                content_type,
                ref.byte_size,
            )
            return True
        except Exception as exc:
            logger.debug("blob_store persist failed: %s", exc)
            return False

    @staticmethod
    def _compress(raw: bytes) -> bytes:
        try:
            from eden.storage.compression import compress_jsonb

            # compress_jsonb expects a Python value; pass decoded text when
            # utf-8, else wrap as base payload via latin-1 round-trip safe path.
            try:
                return compress_jsonb(raw.decode("utf-8"))
            except UnicodeDecodeError:
                import zstandard as zstd

                return zstd.ZstdCompressor(level=7).compress(raw)
        except Exception:
            import zstandard as zstd

            return zstd.ZstdCompressor(level=7).compress(raw)

    @staticmethod
    def _decompress(data: bytes) -> bytes:
        try:
            from eden.storage.compression import decompress_jsonb

            value = decompress_jsonb(data)
            if isinstance(value, str):
                return value.encode("utf-8")
            if isinstance(value, bytes):
                return value
            return json.dumps(value, sort_keys=True, separators=(",", ":")).encode(
                "utf-8"
            )
        except Exception:
            import zstandard as zstd

            return zstd.ZstdDecompressor().decompress(data)


_blob_store: BlobStore | None = None


def get_blob_store() -> BlobStore:
    global _blob_store
    if _blob_store is None:
        _blob_store = BlobStore()
    return _blob_store


def reset_blob_store() -> None:
    global _blob_store
    _blob_store = None
