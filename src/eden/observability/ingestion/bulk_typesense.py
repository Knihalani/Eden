"""Bulk Typesense index helper (SOTA Wave 9).

Buffers span docs and flushes via ``TypesenseClient.index_many``.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_bulk_buffer: list[dict[str, Any]] = []
_BULK_FLUSH_SIZE = 50


async def enqueue_span_doc(doc: dict[str, Any], *, flush_size: int = _BULK_FLUSH_SIZE) -> int:
    """Append a doc; flush when buffer reaches ``flush_size``. Returns indexed count."""
    _bulk_buffer.append(doc)
    if len(_bulk_buffer) < flush_size:
        return 0
    return await flush_bulk_index()


async def flush_bulk_index() -> int:
    """Flush the in-process bulk buffer via Typesense import API."""
    global _bulk_buffer
    if not _bulk_buffer:
        return 0
    batch = list(_bulk_buffer)
    _bulk_buffer = []
    try:
        from eden.observability.typesense_client import get_typesense_client

        client = get_typesense_client()
        if client is None:
            return 0
        return int(await client.index_many(batch))
    except Exception as exc:
        logger.debug("bulk typesense flush failed: %s", exc)
        return 0


def pending_bulk_count() -> int:
    return len(_bulk_buffer)
