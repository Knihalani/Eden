"""Bulk Typesense index helper (SOTA Wave 9).

Buffers span docs and flushes via ``TypesenseClient.index_many``.
Flushes on size (≥50) or timer (≤5s).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

_bulk_buffer: list[dict[str, Any]] = []
_BULK_FLUSH_SIZE = 50
_BULK_FLUSH_INTERVAL_S = 5.0
_flush_task: asyncio.Task[None] | None = None


def _ensure_timer() -> None:
    global _flush_task
    if _flush_task is not None and not _flush_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _flush_task = loop.create_task(_timer_flush())


async def _timer_flush() -> None:
    await asyncio.sleep(_BULK_FLUSH_INTERVAL_S)
    try:
        await flush_bulk_index()
    except Exception as exc:
        logger.debug("bulk typesense timer flush failed: %s", exc)


async def enqueue_span_doc(doc: dict[str, Any], *, flush_size: int = _BULK_FLUSH_SIZE) -> int:
    """Append a doc; flush when buffer reaches ``flush_size``. Returns indexed count."""
    _bulk_buffer.append(doc)
    _ensure_timer()
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
            # Put the detached batch back — an absent client is transient
            # (Typesense not configured yet / mid-restart), not a reason
            # to discard up to ``_BULK_FLUSH_SIZE`` docs.
            _bulk_buffer = batch + _bulk_buffer
            return 0
        return int(await client.index_many(batch))
    except Exception as exc:
        logger.debug("bulk typesense flush failed: %s", exc)
        try:
            from eden.observability.drop_metrics import record_drop

            record_drop("sink_search", "write_error", len(batch))
        except Exception:
            pass
        return 0


def pending_bulk_count() -> int:
    return len(_bulk_buffer)
