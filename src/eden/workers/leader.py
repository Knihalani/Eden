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
) -> None:
    """Background task that extends the leader lock while work runs."""
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
            break
        if not extended:
            logger.warning("leader: lost lock %s during extend", lock.name)
            break


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
  The lock TTL defaults to three times the interval so a slow tick
  does not lose leadership mid-run.

  Redis / acquire failures are logged and retried on the next
  interval — they must not kill the calling supervised loop.
    """
    lock_ttl = ttl or max(30, int(interval * 3))
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
            extender = asyncio.create_task(
                _extend_lock_periodically(lock, interval, extender_stop),
                name=f"leader-extend-{lock_name}",
            )
            try:
                await work()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.error(
                    "leader: work %s failed: %s",
                    lock_name,
                    exc,
                    exc_info=True,
                )
            finally:
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
