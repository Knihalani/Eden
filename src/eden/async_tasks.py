"""Bounded asyncio task helpers for fire-and-forget hot paths.

Unbounded ``loop.create_task`` on ingest / cost / warm paths can exhaust
the event loop under load. :func:`bounded_create_task` caps in-flight
coroutines with a process-local semaphore and rejects excess waiters
so memory does not grow without bound under an ingest flood.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Coroutine
from typing import Any, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

_DEFAULT_LIMIT = 64
# Max tasks waiting on the semaphore (in addition to those holding it).
_DEFAULT_QUEUE_MULTIPLIER = 4
_semaphores: dict[int, tuple[asyncio.AbstractEventLoop, asyncio.Semaphore]] = {}
_waiter_counts: dict[int, int] = {}


def _resolve_limit(limit: int | None) -> int:
    if limit is not None and limit > 0:
        return int(limit)
    try:
        from eden.config import get_settings

        configured = int(
            getattr(get_settings(), "background_task_concurrency", _DEFAULT_LIMIT)
        )
        return configured if configured > 0 else _DEFAULT_LIMIT
    except Exception:
        return _DEFAULT_LIMIT


def _semaphore_for(limit: int) -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    cached = _semaphores.get(limit)
    if cached is not None and cached[0] is loop:
        return cached[1]
    sem = asyncio.Semaphore(limit)
    _semaphores[limit] = (loop, sem)
    return sem


def reset_bounded_task_semaphores() -> None:
    """Clear cached semaphores (tests only)."""
    _semaphores.clear()
    _waiter_counts.clear()


def bounded_create_task(
    coro: Coroutine[Any, Any, T],
    *,
    name: str | None = None,
    limit: int | None = None,
    max_waiting: int | None = None,
) -> asyncio.Task[T | None]:
    """Schedule ``coro`` under a concurrency semaphore.

    Drop-in for ``asyncio.create_task`` / ``loop.create_task`` on
    fire-and-forget sites. Excess coroutines wait on the semaphore
    up to ``max_waiting`` (default ``limit * 4``); further submissions
    are dropped so the waiter queue cannot grow without bound.
    """
    cap = _resolve_limit(limit)
    queue_cap = (
        int(max_waiting)
        if max_waiting is not None and max_waiting >= 0
        else cap * _DEFAULT_QUEUE_MULTIPLIER
    )
    sem = _semaphore_for(cap)
    loop = asyncio.get_running_loop()

    waiting = _waiter_counts.get(cap, 0)
    if waiting >= queue_cap:
        coro.close()
        logger.warning(
            "bounded_create_task: dropping task %s (waiters=%s >= %s)",
            name or "<unnamed>",
            waiting,
            queue_cap,
        )

        async def _dropped() -> None:
            return None

        return loop.create_task(_dropped(), name=name)

    _waiter_counts[cap] = waiting + 1

    async def _runner() -> T | None:
        try:
            async with sem:
                try:
                    return await coro
                except Exception as exc:
                    logger.debug("bounded_create_task: %s", exc)
                    return None
        finally:
            _waiter_counts[cap] = max(0, _waiter_counts.get(cap, 1) - 1)

    return loop.create_task(_runner(), name=name)


async def bounded_gather(
    *aws: Awaitable[T],
    limit: int | None = None,
    return_exceptions: bool = False,
) -> list[T | BaseException]:
    """Like ``asyncio.gather`` but caps concurrent awaitables.

    Each awaitable runs under the shared process-local semaphore for
    ``limit`` (default from settings / 64).
    """
    cap = _resolve_limit(limit)
    sem = _semaphore_for(cap)

    async def _run(aw: Awaitable[T]) -> T:
        async with sem:
            return await aw

    return list(
        await asyncio.gather(
            *(_run(aw) for aw in aws),
            return_exceptions=return_exceptions,
        )
    )


__all__ = [
    "bounded_create_task",
    "bounded_gather",
    "reset_bounded_task_semaphores",
]
