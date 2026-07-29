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

from eden.storage.empty_cooldown import next_grid_delay
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

#: Consecutive failed acquisitions, per lock name. ``Lock.acquire`` fails
#: closed on any Redis error — it warns and returns False — so a broken or
#: quota-exhausted Redis makes every leader-gated loop spin silently while
#: the process looks perfectly healthy. Counting the failures gives the
#: unconditional liveness heartbeat something concrete to report.
_acquire_failures: dict[str, int] = {}

#: Last exception seen from a leader-gated ``work()`` call, per lock name.
#: Acquisition succeeding and the work then throwing produces the same
#: outward evidence as never acquiring at all — no heartbeat, no progress,
#: acquire-failure count still zero — and only an ERROR line in container
#: logs distinguishes them. Recording it here lets the liveness heartbeat
#: carry the distinction out of the container.
_work_failures: dict[str, str] = {}

#: ``{lock_name: [loop_iterations, work_invocations]}``. Redis reachable,
#: zero acquire failures, zero work failures and zero output is a
#: contradiction unless the loops never reach the acquire call at all —
#: these two counters are what tell those apart, and nothing else can.
_tick_counts: dict[str, list[int]] = {}


def leader_tick_counts() -> dict[str, list[int]]:
    """``{lock_name: [iterations, work_runs]}`` for the liveness heartbeat."""
    return {k: list(v) for k, v in _tick_counts.items()}


def leader_acquire_failure_count(lock_name: str | None = None) -> int:
    """Consecutive failed acquisitions for ``lock_name`` (or all locks)."""
    if lock_name is not None:
        return _acquire_failures.get(lock_name, 0)
    return sum(_acquire_failures.values())


def leader_work_failures() -> dict[str, str]:
    """Last work exception per lock name (``{}`` when all is well)."""
    return dict(_work_failures)


def reset_leader_failure_counts() -> None:
    """Test-only: clear the failure counters."""
    _acquire_failures.clear()
    _work_failures.clear()
    _tick_counts.clear()


async def run_if_leader(
    lock_name: str,
    work: Callable[[], Awaitable[None]],
    *,
    interval: float = 30.0,
    ttl: int | None = None,
    stop: asyncio.Event | None = None,
    align: bool = False,
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
        _tick_counts.setdefault(lock_name, [0, 0])[0] += 1
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
            _acquire_failures.pop(lock_name, None)
        else:
            # Not being leader is normal for a follower replica, but Eden
            # runs a single worker — so a persistent inability to acquire
            # means Redis is refusing, not that someone else is leading.
            # Either way the count is what the liveness heartbeat reports.
            _acquire_failures[lock_name] = _acquire_failures.get(lock_name, 0) + 1

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
            _tick_counts.setdefault(lock_name, [0, 0])[1] += 1
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
                        _work_failures[lock_name] = (
                            f"{type(exc).__name__}: {str(exc)[:180]}"
                        )
                        logger.error(
                            "leader: work %s failed: %s",
                            lock_name,
                            exc,
                            exc_info=exc,
                        )
                    else:
                        _work_failures.pop(lock_name, None)
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
            # ``align`` is for loops that hit Postgres unconditionally on
            # every tick. Left to its own phase, such a loop lands wherever
            # the process happened to start and can split the fleet's
            # DB-quiet window in half -- enough to hold Neon above its
            # suspend timeout even though the interval itself clears it.
            timeout = next_grid_delay(interval) if align else interval
            await asyncio.wait_for(stop_event.wait(), timeout=timeout)
        except TimeoutError:
            continue
