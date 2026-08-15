"""Closed-loop event bus (F46) — Postgres outbox queue (N5).

The ``loop_events_outbox`` table (migration 135) is the closed-loop
queue. ``publish`` inserts a :class:`LoopEvent` row; the consumer polls
undrained rows with ``FOR UPDATE SKIP LOCKED`` and dispatches each to the
orchestrator. Redis is out of the closed-loop data path entirely (N5) —
no ``XADD``, no ``XREADGROUP``, no ``loop:idem:*`` SET NX guard, no
``loop:fail:*`` counters.

Durability and dedup come from Postgres:

* Idempotency — the partial unique index on
  ``(idempotency_key) WHERE drained_at IS NULL`` (migration 163) makes a
  re-publish of an event that is still *pending* a no-op
  (``ON CONFLICT ... DO NOTHING``). A process-local windowed cache
  (``_seen``, 1h TTL) additionally suppresses a re-publish that arrived
  after the original row was drained — the same semantic the Redis
  ``loop:idem:*`` keys used to provide, without Redis.
* Delivery — ``FOR UPDATE SKIP LOCKED`` claim means concurrent drains
  (the consumer poll *and* the verify worker's 60s ``outbox_drain``
  safety-net chore) each dispatch a given row exactly once.
* Dead-lettering — consecutive failures are counted in ``attempts``
  (with ``last_error`` for ops); after ``_MAX_DELIVERIES`` the row is
  dead-lettered (ERROR log + drained stamp) so a poison event cannot
  wedge the queue. Between failures the row is re-queued with a capped
  exponential backoff via ``retry_after_ts``.

Module-level ``last_publish_failure_ts`` feeds the
``/internal/loop-health`` probe (the verify worker's loop-dead watchdog
turns a stale stamp into an alert).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Any

from eden.closed_loop.events import LoopEvent

logger = logging.getLogger(__name__)

#: Max rows claimed per drain pass.
_BATCH = 32
#: Dead-letter policy: after this many consecutive failed deliveries of
#: one row the drain dead-letters it (ERROR log + drained stamp) so a
#: poison event cannot wedge the queue.
_MAX_DELIVERIES = 3
#: Backoff between failed deliveries: ``delay = min(base * 2**attempts,
#: _RETRY_MAX_DELAY_S)``.
_RETRY_BASE_DELAY_S = 10.0
_RETRY_MAX_DELAY_S = 60.0
#: Idle poll cadence when the outbox is empty (the verify worker's 60s
#: ``outbox_drain`` chore is a cross-process safety net on top of this).
_POLL_INTERVAL_S = 5.0
#: Window (seconds) for which the consumer's in-process dedup cache
#: suppresses a re-dispatch of an already-handled ``idempotency_key``.
_DEDUP_WINDOW_S = 3_600.0
#: Bounds the in-process dedup cache.
_DEDUP_MAX_KEYS = 4_096

#: ``time.time()`` of the most recent failed publish; cleared on the next
#: successful insert. Read by the loop-health probe + loop-dead watchdog.
last_publish_failure_ts: float | None = None

#: process-local key -> monotonic timestamp of last dispatch (dedup).
_seen: dict[str, float] = {}

_TASK: asyncio.Task | None = None
_STOP: asyncio.Event | None = None


async def _pg() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception:
        return None


def _dedup_seen(key: str) -> bool:
    """True when ``key`` was *successfully* dispatched within the window.

    Only successful dispatches record the key (see ``_record_dispatched``),
    so a failed delivery never suppresses its own retry.
    """
    if not key:
        return False
    last = _seen.get(key)
    return last is not None and time.monotonic() - last < _DEDUP_WINDOW_S


def _record_dispatched(key: str) -> None:
    """Mark ``key`` as successfully dispatched at ``now``.

    Caps the cache size so it cannot grow without bound on a long-lived
    process (best-effort window eviction, then a hard clear).
    """
    if not key:
        return
    now = time.monotonic()
    _seen[key] = now
    if len(_seen) > _DEDUP_MAX_KEYS:
        cutoff = now - _DEDUP_WINDOW_S
        for k in [k for k, v in _seen.items() if v < cutoff]:
            _seen.pop(k, None)
        if len(_seen) > _DEDUP_MAX_KEYS:
            _seen.clear()


async def publish(event: LoopEvent) -> bool:
    """Queue a loop event in the outbox.

    Returns True when the event is durably queued — or was already
    pending with the same ``idempotency_key`` (the ``ON CONFLICT`` no-op
    suppresses the duplicate). Returns False only when Postgres is
    unavailable (the event is lost — logged at ERROR).
    """
    global last_publish_failure_ts
    try:
        client = await _pg()
        if client is None:
            raise ConnectionError("no postgres client")
        await client.execute(
            "INSERT INTO loop_events_outbox (org_id, event, idempotency_key) "
            "VALUES ($1, $2::jsonb, $3) "
            "ON CONFLICT (idempotency_key) WHERE drained_at IS NULL DO NOTHING",
            event.org_id,
            json.dumps(event.to_fields(), default=str),
            event.idempotency_key(),
        )
        last_publish_failure_ts = None
        return True
    except Exception as exc:
        logger.error(
            "event_bus: publish failed — event %s dropped: %s",
            getattr(event, "type", "?"),
            exc,
        )
        last_publish_failure_ts = time.time()
        return False


async def schedule_retry(event: LoopEvent, *, delay_seconds: float) -> bool:
    """Durably queue an event for replay after ``delay_seconds`` (M3, D5).

    Inserts an outbox row with a future ``retry_after_ts`` — the drain
    pass skips it until due, then dispatches it like any other row.
    Never raises; returns False when Postgres is down.
    """
    try:
        client = await _pg()
        if client is None:
            raise ConnectionError("no postgres client")
        await client.execute(
            "INSERT INTO loop_events_outbox "
            "(org_id, event, idempotency_key, retry_after_ts) "
            "VALUES ($1, $2::jsonb, $3, NOW() + ($4 || ' seconds')::interval) "
            "ON CONFLICT (idempotency_key) WHERE drained_at IS NULL DO NOTHING",
            event.org_id,
            json.dumps(event.to_fields(), default=str),
            event.idempotency_key(),
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


async def drain_outbox(
    limit: int = 500, orchestrator: Any | None = None
) -> int:
    """Dispatch up to ``limit`` due outbox rows oldest-first.

    Rows are claimed with ``FOR UPDATE SKIP LOCKED`` so concurrent drains
    (the consumer poll plus the verify worker's safety-net chore) never
    dispatch the same row twice. For each claimed row:

    * an ``idempotency_key`` seen within the dedup window is stamped
      drained without re-dispatching;
    * a successful ``orchestrator.on_event`` stamps ``drained_at``;
    * a failure increments ``attempts`` and re-queues the row with a
      capped exponential backoff, dead-lettering (ERROR log + drained
      stamp) after ``_MAX_DELIVERIES``;
    * a malformed row is stamped drained with an ERROR log so it cannot
      wedge the queue.

    Rows with a future ``retry_after_ts`` are skipped until due. Returns
    the number of rows handled (dispatched, deduped, or dead-lettered).
    """
    if orchestrator is None:
        from eden.closed_loop.orchestrator import get_orchestrator

        orchestrator = get_orchestrator()
    client = await _pg()
    if client is None:
        return 0
    try:
        rows = await client.fetch(
            "SELECT id, event, attempts FROM loop_events_outbox "
            "WHERE drained_at IS NULL "
            "AND (retry_after_ts IS NULL OR retry_after_ts <= NOW()) "
            "ORDER BY id ASC LIMIT $1 FOR UPDATE SKIP LOCKED",
            int(limit),
        )
    except Exception as exc:
        logger.debug("event_bus: outbox claim failed: %s", exc)
        return 0
    if not rows:
        return 0
    handled = 0
    for row in rows:
        row_id = row.get("id")
        fields = row.get("event")
        if isinstance(fields, str):
            try:
                fields = json.loads(fields)
            except (TypeError, ValueError):
                fields = None
        if not isinstance(fields, dict) or not fields:
            # Poison row — stamp it drained so it can't wedge the queue.
            logger.error("event_bus: malformed outbox row %s; marking drained", row_id)
            with contextlib.suppress(Exception):
                await client.execute(
                    "UPDATE loop_events_outbox SET drained_at = NOW() "
                    "WHERE id = $1",
                    row_id,
                )
            handled += 1
            continue
        try:
            event = LoopEvent.from_fields(fields)
        except Exception as exc:
            logger.error(
                "event_bus: undecodable outbox row %s; marking drained: %s",
                row_id,
                exc,
            )
            with contextlib.suppress(Exception):
                await client.execute(
                    "UPDATE loop_events_outbox SET drained_at = NOW() "
                    "WHERE id = $1",
                    row_id,
                )
            handled += 1
            continue
        if _dedup_seen(event.idempotency_key()):
            # Already handled within the window — acknowledge and move on.
            with contextlib.suppress(Exception):
                await client.execute(
                    "UPDATE loop_events_outbox SET drained_at = NOW() "
                    "WHERE id = $1",
                    row_id,
                )
            handled += 1
            continue
        try:
            await orchestrator.on_event(event)
        except Exception as exc:
            attempts = int(row.get("attempts") or 0) + 1
            if attempts >= _MAX_DELIVERIES:
                logger.error(
                    "event_bus: dead-letter row %s after %s failed "
                    "deliveries: %s",
                    row_id,
                    attempts,
                    exc,
                )
                with contextlib.suppress(Exception):
                    await client.execute(
                        "UPDATE loop_events_outbox SET drained_at = NOW(), "
                        "attempts = $2, last_error = $3 WHERE id = $1",
                        row_id,
                        attempts,
                        str(exc)[:500],
                    )
            else:
                # Re-queue with a capped exponential backoff.
                backoff = min(
                    _RETRY_BASE_DELAY_S * (2 ** (attempts - 1)),
                    _RETRY_MAX_DELAY_S,
                )
                logger.warning(
                    "event_bus: handle failed (attempt %d/%d) row %s; "
                    "retrying in %.0fs: %s",
                    attempts,
                    _MAX_DELIVERIES,
                    row_id,
                    backoff,
                    exc,
                )
                with contextlib.suppress(Exception):
                    await client.execute(
                        "UPDATE loop_events_outbox SET attempts = $2, "
                        "last_error = $3, "
                        "retry_after_ts = NOW() + ($4 || ' seconds')::interval "
                        "WHERE id = $1",
                        row_id,
                        attempts,
                        str(exc)[:500],
                        str(int(backoff)),
                    )
            continue
        _record_dispatched(event.idempotency_key())
        with contextlib.suppress(Exception):
            await client.execute(
                "UPDATE loop_events_outbox SET drained_at = NOW() WHERE id = $1",
                row_id,
            )
        handled += 1
    if handled:
        logger.info("event_bus: handled %s outbox event(s)", handled)
    return handled


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


async def oldest_pending_age_s() -> float | None:
    """Age (seconds) of the oldest undrained outbox row, if any.

    Feeds the loop-health probe (how long the queue has been building).
    Best-effort; None when empty or on any failure.
    """
    try:
        client = await _pg()
        if client is None:
            return None
        row = await client.fetchrow(
            "SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) AS age "
            "FROM loop_events_outbox WHERE drained_at IS NULL "
            "HAVING MIN(created_at) IS NOT NULL"
        )
        if not row or row.get("age") is None:
            return None
        return max(0.0, float(row["age"]))
    except Exception:
        return None


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


class ClosedLoopConsumer:
    """Poll the outbox and dispatch events to the orchestrator (N5)."""

    def __init__(self, orchestrator: Any | None = None) -> None:
        if orchestrator is None:
            from eden.closed_loop.orchestrator import get_orchestrator

            orchestrator = get_orchestrator()
        self._orch = orchestrator

    async def run(self, stop: asyncio.Event) -> None:
        logger.info(
            "closed-loop consumer: started (outbox poll=%.0fs, batch=%d)",
            _POLL_INTERVAL_S,
            _BATCH,
        )
        while not stop.is_set():
            handled = await drain_outbox(limit=_BATCH, orchestrator=self._orch)
            if handled == 0:
                # Idle: wait out the poll interval (or stop), then re-check.
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(
                        stop.wait(), timeout=_POLL_INTERVAL_S
                    )
        logger.info("closed-loop consumer: stopped")


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
