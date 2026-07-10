"""Closed-loop event bus (F46) — Redis stream + consumer group.

Stream ``eden.loop.events`` fanned out to consumer group
``eden-closed-loop``. ``publish`` XADDs a :class:`LoopEvent`; the consumer
reads with ``XREADGROUP`` and dispatches each event to the orchestrator,
guarded by a Redis idempotency key ``{issue_id}:{type}:{ref}`` so a
re-delivery (or a duplicate emit) never double-processes.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import socket
from typing import Any

from eden.closed_loop.events import LoopEvent

logger = logging.getLogger(__name__)

LOOP_STREAM = "eden.loop.events"
_GROUP = "eden-closed-loop"
_CONSUMER = f"loop-{socket.gethostname()}"
_STREAM_MAXLEN = 100_000
_BATCH = 32
_BLOCK_MS = 2_000
_IDEMPOTENCY_TTL_S = 3_600

_TASK: asyncio.Task | None = None
_STOP: asyncio.Event | None = None


async def publish(event: LoopEvent, redis: Any | None = None) -> bool:
    """XADD a loop event. Best-effort; returns True on success."""
    try:
        if redis is None:
            from eden.storage.redis import get_redis_client

            redis = await get_redis_client()
        if redis is None:
            return False
        await redis.xadd(
            LOOP_STREAM,
            event.to_fields(),
            maxlen=_STREAM_MAXLEN,
            approximate=True,
        )
        return True
    except Exception as exc:  # pragma: no cover - redis optional
        logger.debug("event_bus: publish failed: %s", exc)
        return False


async def _already_processed(redis: Any, key: str) -> bool:
    """Return True if this idempotency key was already handled."""
    try:
        was_set = await redis.set(
            f"loop:idem:{key}", "1", ex=_IDEMPOTENCY_TTL_S, nx=True
        )
        return not bool(was_set)
    except Exception:
        return False


class ClosedLoopConsumer:
    def __init__(self, orchestrator: Any | None = None) -> None:
        if orchestrator is None:
            from eden.closed_loop.orchestrator import get_orchestrator

            orchestrator = get_orchestrator()
        self._orch = orchestrator

    async def _ensure_group(self, redis: Any) -> None:
        try:
            await redis.xgroup_create(LOOP_STREAM, _GROUP, id="0", mkstream=True)
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                logger.debug("event_bus: xgroup_create: %s", exc)

    async def run(self, stop: asyncio.Event) -> None:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is None:
            logger.info("closed-loop consumer: no Redis; disabled")
            return
        await self._ensure_group(redis)
        logger.info("closed-loop consumer: started (group=%s)", _GROUP)
        while not stop.is_set():
            try:
                resp = await redis.xreadgroup(
                    _GROUP,
                    _CONSUMER,
                    {LOOP_STREAM: ">"},
                    count=_BATCH,
                    block=_BLOCK_MS,
                )
            except Exception as exc:
                logger.debug("event_bus: xreadgroup failed: %s", exc)
                await asyncio.sleep(1.0)
                continue
            if not resp:
                continue
            for _stream, entries in resp:
                for mid, fields in entries:
                    await self._handle(redis, mid, fields)
        logger.info("closed-loop consumer: stopped")

    async def _handle(self, redis: Any, message_id: Any, fields: Any) -> None:
        try:
            event = LoopEvent.from_fields(fields)
            if await _already_processed(redis, event.idempotency_key()):
                logger.debug("event_bus: skip dup %s", event.idempotency_key())
            else:
                await self._orch.on_event(event)
        except Exception as exc:
            logger.warning("event_bus: handle failed: %s", exc)
        finally:
            with contextlib.suppress(Exception):
                await redis.xack(LOOP_STREAM, _GROUP, message_id)


async def start_consumer() -> None:
    global _TASK, _STOP
    try:
        from eden.config import get_settings

        if not getattr(get_settings(), "closed_loop_orchestrator_v1", True):
            logger.info("closed-loop consumer: disabled by Settings")
            return
    except Exception:
        pass
    if _TASK is not None and not _TASK.done():
        return
    _STOP = asyncio.Event()
    consumer = ClosedLoopConsumer()
    _TASK = asyncio.create_task(consumer.run(_STOP), name="closed_loop_consumer")


async def stop_consumer() -> None:
    global _TASK, _STOP
    if _STOP is None:
        return
    _STOP.set()
    if _TASK is not None:
        try:
            await asyncio.wait_for(_TASK, timeout=15.0)
        except TimeoutError:
            _TASK.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await _TASK
    _TASK = None
    _STOP = None


def is_consumer_running() -> bool:
    return _TASK is not None and not _TASK.done()
