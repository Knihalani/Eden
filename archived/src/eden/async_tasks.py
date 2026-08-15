"""Bounded asyncio task helpers for fire-and-forget hot paths.

Unbounded ``loop.create_task`` on ingest / cost / warm paths can exhaust
the event loop under load. :func:`bounded_create_task` caps in-flight
coroutines with a process-local semaphore and rejects excess waiters
so memory does not grow without bound under an ingest flood.

Tasks are tracked with a strong reference so they are not GC'd mid-await
(CPython's event loop only holds tasks weakly). :func:`drain_background_tasks`
waits for them at shutdown so a pod restart does not abandon in-flight writes.

Fire-and-forget tasks are spawned under a context that strips the
request-pinned Postgres connection (see :func:`_detached_context`) so a
task that outlives its request cannot reuse a connection the pool has
already handed to another tenant.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import logging
from collections.abc import Awaitable, Coroutine
from typing import Any, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

_DEFAULT_LIMIT = 64
# Max tasks waiting on the semaphore (in addition to those holding it).
_DEFAULT_QUEUE_MULTIPLIER = 4
# Keyed by (limit, kind) so ``bounded_create_task`` and ``bounded_gather``
# never share a semaphore — a wide gather must not starve fire-and-forget.
_semaphores: dict[tuple[int, str], tuple[asyncio.AbstractEventLoop, asyncio.Semaphore]] = {}
_waiter_counts: dict[int, int] = {}
# Strong refs so fire-and-forget tasks are not collected mid-await.
_pending: set[asyncio.Task[Any]] = set()


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


def _semaphore_for(limit: int, kind: str) -> asyncio.Semaphore:
    """Return a process-local semaphore for ``(limit, kind)``.

    ``kind`` separates fire-and-forget (``"task"``) from gather
    (``"gather"``) so a wide ``bounded_gather`` cannot hold every permit
    and push ``bounded_create_task`` into the drop path.
    """
    loop = asyncio.get_running_loop()
    key = (limit, kind)
    cached = _semaphores.get(key)
    if cached is not None and cached[0] is loop:
        return cached[1]
    sem = asyncio.Semaphore(limit)
    _semaphores[key] = (loop, sem)
    return sem


def _detached_context() -> contextvars.Context:
    """Context for fire-and-forget tasks: strip the request-pinned PG conn.

    ``asyncio.Task`` copies the caller's context at creation. Without this,
    a task spawned from a route handler inherits the connection
    ``RLSOrgContextMiddleware`` pinned via ``bind_request_pg_conn`` and can
    query it after the middleware released it back to the pool — possibly
    while another tenant's request holds that same connection.
    """
    from eden.storage.postgres import copy_context_without_request_pg_conn

    return copy_context_without_request_pg_conn()


def reset_bounded_task_semaphores() -> None:
    """Clear cached semaphores and pending tracking (tests only)."""
    _semaphores.clear()
    _waiter_counts.clear()
    _pending.clear()


def pending_background_tasks() -> int:
    """Number of in-flight tasks still held by the strong-ref set."""
    return len(_pending)


def _track(
    task: asyncio.Task[Any],
    *,
    owned_coro: Coroutine[Any, Any, Any] | None = None,
) -> asyncio.Task[Any]:
    _pending.add(task)

    def _done(t: asyncio.Task[Any]) -> None:
        _pending.discard(t)
        if owned_coro is None or not t.cancelled():
            return
        try:
            from inspect import CORO_CREATED, getcoroutinestate

            if getcoroutinestate(owned_coro) == CORO_CREATED:
                owned_coro.close()
        except Exception:
            pass

    task.add_done_callback(_done)
    return task


def bounded_create_task[T](
    coro: Coroutine[Any, Any, T],
    *,
    name: str | None = None,
    limit: int | None = None,
    max_waiting: int | None = None,
    context: Any | None = None,
) -> asyncio.Task[T | None]:
    """Schedule ``coro`` under a concurrency semaphore.

    Drop-in for ``asyncio.create_task`` / ``loop.create_task`` on
    fire-and-forget sites. Excess coroutines wait on the semaphore
    up to ``max_waiting`` (default ``limit * 4``); further submissions
    are dropped so the waiter queue cannot grow without bound.

    The returned task is also retained in ``_pending`` until it finishes
    so discarding the caller's handle cannot GC the work mid-await.

    By default the task runs under :func:`_detached_context` so it does
    not inherit a request-pinned Postgres connection. Pass ``context=``
    only when you have already built an appropriate context yourself.
    """
    cap = _resolve_limit(limit)
    queue_cap = (
        int(max_waiting)
        if max_waiting is not None and max_waiting >= 0
        else cap * _DEFAULT_QUEUE_MULTIPLIER
    )
    sem = _semaphore_for(cap, "task")
    loop = asyncio.get_running_loop()
    # Always detach unless the caller supplied an explicit context.
    # Both create_task sites below must pass context= so neither path
    # inherits the request-pinned connection.
    task_ctx = context if context is not None else _detached_context()

    waiting = _waiter_counts.get(cap, 0)
    if waiting >= queue_cap:
        coro.close()
        logger.warning(
            "bounded_create_task: dropping task %s (waiters=%s >= %s)",
            name or "<unnamed>",
            waiting,
            queue_cap,
        )
        try:
            from eden.observability.drop_metrics import record_drop

            record_drop("queue", "queue_full")
        except Exception:
            pass

        async def _dropped() -> None:
            return None

        return _track(
            loop.create_task(_dropped(), name=name, context=task_ctx)
        )

    _waiter_counts[cap] = waiting + 1

    async def _runner() -> T | None:
        started = False
        try:
            async with sem:
                try:
                    started = True
                    return await coro
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    try:
                        from eden.observability.drop_metrics import record_drop

                        record_drop("queue", "write_error")
                    except Exception:
                        pass
                    logger.warning(
                        "bounded_create_task: task %s failed: %s",
                        name or "<unnamed>",
                        exc,
                    )
                    return None
        except asyncio.CancelledError:
            if not started:
                with contextlib.suppress(Exception):
                    coro.close()
            raise
        finally:
            _waiter_counts[cap] = max(0, _waiter_counts.get(cap, 1) - 1)

    return _track(
        loop.create_task(_runner(), name=name, context=task_ctx),
        owned_coro=coro,
    )


def fire_and_forget(
    result: Any,
    *,
    name: str,
    limit: int | None = None,
) -> bool:
    """Schedule ``result`` if it is an un-awaited coroutine.

    Several notification hooks (``PromotionHook.on_drift_alert``,
    ``on_judge_regression``, …) are ``async def`` but are invoked from
    synchronous helpers deep inside scoring / recommendation code. Calling
    them without awaiting silently drops the alert *and* emits a
    "coroutine was never awaited" RuntimeWarning. This centralises the
    correct handling: schedule on the running loop under the bounded-task
    semaphore, or close the coroutine cleanly when there is no loop.

    Returns ``True`` when the coroutine was scheduled.
    """
    if not asyncio.iscoroutine(result):
        return False
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # Sync context (CLI, worker bootstrap, test helper). Close the
        # coroutine so it does not surface as a RuntimeWarning.
        result.close()
        logger.debug("fire_and_forget: dropped %s (no running event loop)", name)
        return False
    try:
        bounded_create_task(result, name=name, limit=limit)
        return True
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("fire_and_forget: scheduling %s failed: %s", name, exc)
        with contextlib.suppress(Exception):
            result.close()
        return False


async def bounded_gather[T](
    *aws: Awaitable[T],
    limit: int | None = None,
    return_exceptions: bool = False,
) -> list[T | BaseException]:
    """Like ``asyncio.gather`` but caps concurrent awaitables.

    Each awaitable runs under a gather-scoped process-local semaphore for
    ``limit`` (default from settings / 64). Separate from the fire-and-forget
    semaphore so a wide gather cannot starve ``bounded_create_task``.
    """
    cap = _resolve_limit(limit)
    sem = _semaphore_for(cap, "gather")

    async def _run(aw: Awaitable[T]) -> T:
        async with sem:
            return await aw

    return list(
        await asyncio.gather(
            *(_run(aw) for aw in aws),
            return_exceptions=return_exceptions,
        )
    )


async def drain_background_tasks(*, timeout: float = 5.0) -> int:
    """Wait for tracked fire-and-forget tasks, then cancel stragglers.

    Returns the number of tasks that had to be cancelled after ``timeout``.
    Cancelled tasks are counted as ``("queue", "shutdown")`` drops.
    """
    pending = [t for t in list(_pending) if not t.done()]
    if not pending:
        return 0

    done, still = await asyncio.wait(pending, timeout=max(0.0, timeout))
    cancelled = 0
    if still:
        for t in still:
            t.cancel()
        await asyncio.gather(*still, return_exceptions=True)
        cancelled = len(still)
        try:
            from eden.observability.drop_metrics import record_drop

            record_drop("queue", "shutdown", cancelled)
        except Exception:
            pass
    # Done set is already finished; ensure refs are cleared.
    for t in done:
        _pending.discard(t)
    return cancelled


__all__ = [
    "bounded_create_task",
    "bounded_gather",
    "drain_background_tasks",
    "fire_and_forget",
    "pending_background_tasks",
    "reset_bounded_task_semaphores",
]
