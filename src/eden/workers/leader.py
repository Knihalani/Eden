"""Redis-backed leader election for singleton background loops.

When multiple API replicas or worker containers run the same periodic
task, only the process holding the leader lock executes work. Followers
sleep and retry acquisition on the next interval.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import AsyncIterator

from eden.storage.redis import Lock

logger = logging.getLogger(__name__)


@asynccontextmanager
async def leader_session(
    name: str,
    *,
    ttl: int = 90,
) -> AsyncIterator[bool]:
    """Try to acquire a leader lock for the duration of the context.

    Yields ``True`` when this process is the leader, ``False`` otherwise.
    The lock is released on exit.
    """
    lock = Lock(name, ttl=ttl, prefix="eden:leader")
    acquired = await lock.acquire()
    if not acquired:
        yield False
        return
    try:
        yield True
    finally:
        await lock.release()


async def _extend_lock_periodically(
    lock: Lock,
    interval: float,
    stop: asyncio.Event,
    *,
    lost: asyncio.Event | None = None,
) -> None:
    """Background task that extends the leader lock while work runs.

    When ``lost`` is provided it is set the moment extension fails or
    the lock is confirmed lost — before this function returns — so a
    caller (``run_if_leader``) can cancel in-flight work immediately
    instead of only learning about it after the fact. Without this,
    two replicas can legitimately hold "the lock" concurrently for as
    long as the losing replica's ``work()`` call keeps running: a
    second replica re-acquires the now-expired lock and starts its own
    tick while the first replica's stale tick is still executing.
    """
    while not stop.is_set():
        await asyncio.sleep(interval)
        if stop.is_set():
            break
        try:
            extended = await lock.extend(lock.ttl)
        except Exception as exc:
            logger.warning(
                "leader: extend raised for %s: %s", lock.name, exc
            )
            if lost is not None:
                lost.set()
            break
        if not extended:
            logger.warning("leader: lost lock %s during extend", lock.name)
            if lost is not None:
                lost.set()
            break


#: Lock TTL is intentionally decoupled from the caller's tick
#: ``interval`` (which can be hours, e.g. the 3600s artifact-demotion
#: loop). A hard-crashed leader (SIGKILL, no exception path to release
#: the lock) blocks failover until the lock's TTL expires — tying that
#: TTL to a multi-hour tick interval means a healthy replica cannot
#: take over for hours. Keeping it fixed + short, renewed frequently
#: while work is in-flight, bounds the failover window to roughly one
#: renewal period regardless of how long the tick itself is.
_DEFAULT_LOCK_TTL_SECONDS = 60
_DEFAULT_LOCK_RENEW_SECONDS = 20.0


async def run_if_leader(
    lock_name: str,
    work: Callable[[], Awaitable[None]],
    *,
    interval: float = 30.0,
    ttl: int | None = None,
    stop: asyncio.Event | None = None,
) -> None:
    """Run ``work`` on each interval while holding the leader lock.

  Followers wait ``interval`` seconds between acquisition attempts.
  The lock TTL is fixed (``_DEFAULT_LOCK_TTL_SECONDS``) and decoupled
  from ``interval`` — it is renewed every ``_DEFAULT_LOCK_RENEW_SECONDS``
  while ``work()`` runs, so a slow tick does not lose leadership
  mid-run *and* a hard-crashed leader's failover window stays bounded
  to roughly one renewal period instead of scaling with ``interval``.

  Redis / acquire failures are logged and retried on the next
  interval — they must not kill the calling supervised loop.

  The moment the lock is confirmed lost (extend fails or returns
  False) the in-flight ``work()`` call is cancelled immediately —
  not just the renewal — so a second replica that legitimately
  re-acquires the now-expired lock cannot run concurrently with a
  still-running (but no-longer-leader) first replica.
    """
    lock_ttl = ttl or _DEFAULT_LOCK_TTL_SECONDS
    stop_event = stop or asyncio.Event()

    while not stop_event.is_set():
        lock = Lock(lock_name, ttl=lock_ttl, prefix="eden:leader")
        try:
            acquired = await lock.acquire()
        except Exception as exc:
            logger.error(
                "leader: acquire %s raised: %s",
                lock_name,
                exc,
                exc_info=True,
            )
            acquired = False

        if acquired:
            extender_stop = asyncio.Event()
            leadership_lost = asyncio.Event()
            extender = asyncio.create_task(
                _extend_lock_periodically(
                    lock,
                    _DEFAULT_LOCK_RENEW_SECONDS,
                    extender_stop,
                    lost=leadership_lost,
                ),
                name=f"leader-extend-{lock_name}",
            )
            work_task = asyncio.create_task(
                work(), name=f"leader-work-{lock_name}"
            )
            lost_wait_task = asyncio.create_task(
                leadership_lost.wait(), name=f"leader-lost-wait-{lock_name}"
            )
            try:
                done, _pending = await asyncio.wait(
                    {work_task, lost_wait_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if work_task not in done:
                    # Leadership was lost mid-tick — abort the in-flight
                    # work immediately rather than let it keep running
                    # concurrently with whatever replica re-acquires the
                    # now-expired lock (split-brain).
                    logger.warning(
                        "leader: leadership lost mid-tick for %s; "
                        "cancelling in-flight work",
                        lock_name,
                    )
                    work_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await work_task
                else:
                    try:
                        exc = work_task.exception()
                    except asyncio.CancelledError:
                        exc = None
                    if exc is not None:
                        logger.error(
                            "leader: work %s failed: %s",
                            lock_name,
                            exc,
                            exc_info=exc,
                        )
            except asyncio.CancelledError:
                work_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await work_task
                raise
            finally:
                if not lost_wait_task.done():
                    lost_wait_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await lost_wait_task
                extender_stop.set()
                extender.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await extender
                try:
                    await lock.release()
                except Exception as exc:
                    logger.warning(
                        "leader: release %s failed: %s", lock_name, exc
                    )
        else:
            logger.debug(
                "leader: not leader for %s; sleeping %.0fs",
                lock_name,
                interval,
            )

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval)
        except TimeoutError:
            continue
