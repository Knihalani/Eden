"""Closed-loop event bus (F46) — Redis stream + consumer group.

Stream ``eden.loop.events`` fanned out to consumer group
``eden-closed-loop``. ``publish`` XADDs a :class:`LoopEvent`; the consumer
reads with ``XREADGROUP`` and dispatches each event to the orchestrator,
guarded by a Redis idempotency key ``{issue_id}:{type}:{ref}`` so a
re-delivery (or a duplicate emit) never double-processes.

Durability (M2, D4): when Redis is down, ``publish`` falls back to the
``loop_events_outbox`` Postgres table (migration 135) instead of dropping
the event. :func:`drain_outbox` replays undrained rows oldest-first onto
the stream — the verify worker's idle chores and the consumer at startup
call it — and :func:`cleanup_drained` GCs old drained rows. Module-level
``last_publish_failure_ts`` feeds the ``/internal/loop-health`` probe.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import socket
import time
from typing import Any

from eden.closed_loop.events import LoopEvent

logger = logging.getLogger(__name__)

LOOP_STREAM = "eden.loop.events"
_GROUP = "eden-closed-loop"
_CONSUMER = f"loop-{socket.gethostname()}"
_STREAM_MAXLEN = 100_000
_BATCH = 32
_IDEMPOTENCY_TTL_S = 3_600

#: Dead-letter policy: after this many failed deliveries of one entry the
#: consumer XACKs it with a ``logger.error`` so a poison message cannot
#: wedge the PEL forever. Tracked via ``loop:fail:{id}`` Redis counters.
_MAX_DELIVERIES = 3
_FAIL_TTL_S = 3_600

#: Entries pending longer than this are considered abandoned by a dead
#: consumer and reclaimed via XAUTOCLAIM.
_PENDING_IDLE_MS = 60_000

#: ``time.time()`` of the most recent failed publish; cleared on the next
#: successful XADD. Read by the loop-health probe.
last_publish_failure_ts: float | None = None

_TASK: asyncio.Task | None = None
_STOP: asyncio.Event | None = None


def _block_ms() -> int:
    from eden.storage.redis import redis_stream_block_ms

    return redis_stream_block_ms()


def _autoclaim_interval_s() -> int:
    from eden.storage.redis import redis_stream_autoclaim_interval_s

    return redis_stream_autoclaim_interval_s()


async def _pg() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception:
        return None


async def publish(event: LoopEvent, redis: Any | None = None) -> bool:
    """XADD a loop event; fall back to the durable outbox when Redis is down.

    Returns True when the event was published *or* durably queued in
    ``loop_events_outbox``; False only when both Redis and Postgres are
    unavailable (the event is lost — logged at ERROR).
    """
    global last_publish_failure_ts
    try:
        if redis is None:
            from eden.storage.redis import get_redis_client

            redis = await get_redis_client()
        if redis is None:
            raise ConnectionError("no redis client")
        await redis.xadd(
            LOOP_STREAM,
            event.to_fields(),
            maxlen=_STREAM_MAXLEN,
            approximate=True,
        )
        last_publish_failure_ts = None
        return True
    except Exception as exc:
        logger.error(
            "event_bus: publish failed (%s: %s); falling back to outbox",
            type(exc).__name__,
            exc,
        )
        last_publish_failure_ts = time.time()
        return await _outbox_insert(event)


async def _outbox_insert(event: LoopEvent) -> bool:
    """Durably queue an event in ``loop_events_outbox``. Never raises."""
    try:
        client = await _pg()
        if client is None:
            raise ConnectionError("no postgres client")
        await client.execute(
            "INSERT INTO loop_events_outbox (org_id, event) VALUES ($1, $2::jsonb)",
            event.org_id,
            json.dumps(event.to_fields(), default=str),
        )
        return True
    except Exception as exc:
        logger.error(
            "event_bus: outbox insert failed — event %s dropped: %s",
            getattr(event, "type", "?"),
            exc,
        )
        return False


async def schedule_retry(event: LoopEvent, *, delay_seconds: float) -> bool:
    """Durably queue an event for replay after ``delay_seconds`` (M3, D5).

    Inserts an outbox row with a future ``retry_after_ts`` — the drain
    pass skips it until due, then replays it onto the stream like any
    other outbox row. Never raises; returns False when Postgres is down.
    """
    try:
        client = await _pg()
        if client is None:
            raise ConnectionError("no postgres client")
        await client.execute(
            "INSERT INTO loop_events_outbox (org_id, event, retry_after_ts) "
            "VALUES ($1, $2::jsonb, NOW() + ($3 || ' seconds')::interval)",
            event.org_id,
            json.dumps(event.to_fields(), default=str),
            str(int(delay_seconds)),
        )
        return True
    except Exception as exc:
        logger.error(
            "event_bus: retry enqueue failed — event %s dropped: %s",
            getattr(event, "type", "?"),
            exc,
        )
        return False


async def drain_outbox(limit: int = 500) -> int:
    """Replay undrained outbox rows onto the stream, oldest-first.

    Rows with a future ``retry_after_ts`` are skipped until due. Each
    successful XADD stamps ``drained_at``; the first publish failure stops
    the pass (Redis is presumably still down). Re-publishing a row twice
    (e.g. crash between XADD and the stamp) is safe — the consumer's
    ``loop:idem`` keys dedupe downstream. Returns the number drained.
    """
    client = await _pg()
    if client is None:
        return 0
    try:
        rows = await client.fetch(
            "SELECT id, event FROM loop_events_outbox "
            "WHERE drained_at IS NULL "
            "AND (retry_after_ts IS NULL OR retry_after_ts <= NOW()) "
            "ORDER BY id ASC LIMIT $1",
            int(limit),
        )
    except Exception as exc:
        logger.debug("event_bus: outbox fetch failed: %s", exc)
        return 0
    if not rows:
        return 0
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
    except Exception:
        redis = None
    if redis is None:
        return 0
    drained = 0
    for row in rows:
        fields = row.get("event")
        if isinstance(fields, str):
            try:
                fields = json.loads(fields)
            except (TypeError, ValueError):
                fields = None
        if not isinstance(fields, dict) or not fields:
            # Poison row — stamp it drained so it can't wedge the queue.
            logger.error(
                "event_bus: malformed outbox row %s; marking drained",
                row.get("id"),
            )
            with contextlib.suppress(Exception):
                await client.execute(
                    "UPDATE loop_events_outbox SET drained_at = NOW() WHERE id = $1",
                    row["id"],
                )
            continue
        try:
            await redis.xadd(
                LOOP_STREAM,
                fields,
                maxlen=_STREAM_MAXLEN,
                approximate=True,
            )
        except Exception as exc:
            logger.warning(
                "event_bus: outbox drain stopped at row %s (redis down?): %s",
                row.get("id"),
                exc,
            )
            break
        with contextlib.suppress(Exception):
            await client.execute(
                "UPDATE loop_events_outbox SET drained_at = NOW() WHERE id = $1",
                row["id"],
            )
        drained += 1
    if drained:
        logger.info("event_bus: drained %s outbox event(s)", drained)
    return drained


async def outbox_depth() -> int:
    """Count of undrained outbox rows. Best-effort; 0 on any failure."""
    try:
        client = await _pg()
        if client is None:
            return 0
        row = await client.fetchrow(
            "SELECT COUNT(*) AS n FROM loop_events_outbox WHERE drained_at IS NULL"
        )
        return int(row["n"]) if row else 0
    except Exception:
        return 0


async def cleanup_drained(older_than_days: int = 7) -> int:
    """Delete drained outbox rows older than ``older_than_days``."""
    try:
        client = await _pg()
        if client is None:
            return 0
        status = await client.execute(
            "DELETE FROM loop_events_outbox WHERE drained_at IS NOT NULL "
            "AND drained_at < NOW() - ($1 || ' days')::interval",
            str(int(older_than_days)),
        )
        try:
            return int(str(status).split()[-1])
        except (ValueError, IndexError):
            return 0
    except Exception as exc:
        logger.debug("event_bus: cleanup_drained failed: %s", exc)
        return 0


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
        self._last_autoclaim_mono = 0.0

    async def _ensure_group(self, redis: Any) -> None:
        try:
            await redis.xgroup_create(LOOP_STREAM, _GROUP, id="0", mkstream=True)
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                logger.debug("event_bus: xgroup_create: %s", exc)

    async def _acquire_redis(self, stop: asyncio.Event) -> Any | None:
        """Get the stream client, retrying with capped backoff until stop.

        A Redis blip at process start must not permanently disable the
        loop (D4) — keep trying 5s → 60s until the client appears or the
        worker is told to stop.
        """
        from eden.storage.redis import get_redis_stream_client

        backoff = 5.0
        while not stop.is_set():
            try:
                redis = await get_redis_stream_client()
            except Exception as exc:
                logger.debug("event_bus: stream client init failed: %s", exc)
                redis = None
            if redis is not None:
                return redis
            logger.warning(
                "closed-loop consumer: no Redis; retrying in %.0fs", backoff
            )
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=backoff)
            backoff = min(backoff * 2, 60.0)
        return None

    async def run(self, stop: asyncio.Event) -> None:
        redis = await self._acquire_redis(stop)
        if redis is None:
            logger.info("closed-loop consumer: stopped before Redis came up")
            return
        await self._ensure_group(redis)
        with contextlib.suppress(Exception):
            await drain_outbox()
        block_ms = _block_ms()
        logger.info(
            "closed-loop consumer: started (group=%s, block_ms=%s)",
            _GROUP,
            block_ms,
        )
        while not stop.is_set():
            entries = await self._read_batch(redis)
            if not entries:
                continue
            for mid, fields in entries:
                await self._handle(redis, mid, fields)
        logger.info("closed-loop consumer: stopped")

    async def _read_batch(self, redis: Any) -> list[tuple[Any, Any]]:
        """Claim idle pending periodically, then read new messages.

        Crash mid-handle leaves entries in the PEL. Reading only ``>``
        would never finish them; XAUTOCLAIM reclaims idle ones — rate
        limited so it doesn't double command volume (same pattern as
        ``workers.trace_finalized_consumer``).
        """
        out: list[tuple[Any, Any]] = []
        now = time.monotonic()
        if now - self._last_autoclaim_mono >= _autoclaim_interval_s():
            self._last_autoclaim_mono = now
            try:
                claimed = await redis.xautoclaim(
                    LOOP_STREAM,
                    _GROUP,
                    _CONSUMER,
                    min_idle_time=_PENDING_IDLE_MS,
                    start_id="0-0",
                    count=_BATCH,
                )
                # redis-py: (next_id, [(id, fields), ...], deleted_ids?)
                if isinstance(claimed, (list, tuple)) and len(claimed) >= 2:
                    messages = claimed[1] or []
                    for item in messages:
                        if isinstance(item, (list, tuple)) and len(item) >= 2:
                            out.append((item[0], item[1]))
            except Exception as exc:
                # Older Redis / Upstash without XAUTOCLAIM — fall through.
                logger.debug("event_bus: xautoclaim: %s", exc)

        remaining = max(0, _BATCH - len(out))
        if remaining == 0:
            return out
        block_ms = _block_ms() if not out else 1
        try:
            resp = await redis.xreadgroup(
                _GROUP,
                _CONSUMER,
                {LOOP_STREAM: ">"},
                count=remaining,
                block=block_ms,
            )
        except Exception as exc:
            logger.debug("event_bus: xreadgroup failed: %s", exc)
            if not out:
                await asyncio.sleep(1.0)
            return out
        if not resp:
            return out
        for _stream, entries in resp:
            for mid, fields in entries:
                out.append((mid, fields))
        return out

    async def _handle(self, redis: Any, message_id: Any, fields: Any) -> None:
        """Dispatch one entry; XACK only on success or after dead-letter.

        A handler exception leaves the entry in the PEL so XAUTOCLAIM
        redelivers it. After ``_MAX_DELIVERIES`` failures the entry is
        dead-lettered (ERROR log) and acked so poison can't wedge the
        group.
        """
        try:
            event = LoopEvent.from_fields(fields)
            if await _already_processed(redis, event.idempotency_key()):
                logger.debug("event_bus: skip dup %s", event.idempotency_key())
            else:
                await self._orch.on_event(event)
        except Exception as exc:
            logger.warning("event_bus: handle failed: %s", exc)
            await self._maybe_dead_letter(redis, message_id, exc)
            return
        with contextlib.suppress(Exception):
            await redis.xack(LOOP_STREAM, _GROUP, message_id)

    async def _maybe_dead_letter(
        self, redis: Any, message_id: Any, exc: Exception
    ) -> None:
        """Count a failed delivery; ack + ERROR-log at ``_MAX_DELIVERIES``."""
        try:
            mid = (
                message_id.decode()
                if isinstance(message_id, bytes)
                else str(message_id)
            )
            key = f"loop:fail:{mid}"
            count = int(await redis.incr(key))
            with contextlib.suppress(Exception):
                await redis.expire(key, _FAIL_TTL_S)
            if count < _MAX_DELIVERIES:
                return
            logger.error(
                "event_bus: dead-letter %s after %s failed deliveries: %s",
                mid,
                count,
                exc,
            )
            with contextlib.suppress(Exception):
                await redis.xack(LOOP_STREAM, _GROUP, message_id)
            with contextlib.suppress(Exception):
                await redis.delete(key)
        except Exception as exc2:
            # Counter unavailable → leave unacked; XAUTOCLAIM will retry.
            logger.debug("event_bus: dead-letter accounting failed: %s", exc2)


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
