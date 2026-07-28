"""Trace event store for event-sourced agent trace replay.

Phase 6.2: Stores immutable trace events in Redis streams for fast
recent access and PostgreSQL for long-term archival. Supports time-travel
replay, partial recovery, and human-in-the-loop pause/resume.

Usage:
    from eden.realtime.trace_store import TraceEventStore
    store = TraceEventStore()
    await store.append("trace_abc", trace_event)
    events = await store.get_trace("trace_abc", from_sequence=0)
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class TraceEvent:
    """A single immutable event in a trace log."""

    event_id: str
    event_type: str
    timestamp: str
    sequence: int
    tenant_id: str
    user_id: str
    entity_id: str  # job_id, trace_id, or benchmark_id
    priority: str = "medium"
    payload: dict[str, Any] = field(default_factory=dict)
    version: str = "1.0.0"

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "event_type": self.event_type,
            "timestamp": self.timestamp,
            "sequence": self.sequence,
            "tenant_id": self.tenant_id,
            "user_id": self.user_id,
            "entity_id": self.entity_id,
            "priority": self.priority,
            "payload": self.payload,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TraceEvent:
        return cls(
            event_id=data["event_id"],
            event_type=data["event_type"],
            timestamp=data["timestamp"],
            sequence=data["sequence"],
            tenant_id=data["tenant_id"],
            user_id=data["user_id"],
            entity_id=data["entity_id"],
            priority=data.get("priority", "medium"),
            payload=data.get("payload", {}),
            version=data.get("version", "1.0.0"),
        )


class TraceEventStore:
    """Append-only event store for agent traces.

    Hot path: Redis streams for fast recent access.
    Cold path: PostgreSQL for long-term archival.
    """

    # Redis stream maxlen per trace — last 10K events
    STREAM_MAXLEN = 10000
    # How many recent events to keep hot in Redis
    HOT_WINDOW_HOURS = 48

    def __init__(self) -> None:
        self._redis: Any = None
        self._postgres: Any = None

    async def _get_redis(self) -> Any:
        if self._redis is not None:
            return self._redis
        try:
            from eden.storage.redis import get_redis_client
            self._redis = await get_redis_client()
        except Exception as exc:
            logger.warning(f"Redis unavailable for trace store: {exc}")
        return self._redis

    async def _get_postgres(self) -> Any:
        if self._postgres is not None:
            return self._postgres
        try:
            from eden.storage.postgres import get_postgres_client
            self._postgres = await get_postgres_client()
        except Exception as exc:
            logger.warning(f"Postgres unavailable for trace store: {exc}")
        return self._postgres

    async def append(
        self,
        entity_id: str,
        event: TraceEvent,
        persist: bool = True,
    ) -> int:
        """Append an event to the trace log.

        Args:
            entity_id: The trace/job/benchmark ID this event belongs to.
            event: The event to append.
            persist: If True, also archive to PostgreSQL.

        Returns:
            The assigned sequence number.
        """
        redis = await self._get_redis()
        sequence = 0

        # Assign sequence number via Redis atomic incr
        if redis:
            seq_key = f"trace:{entity_id}:seq"
            sequence = await redis.incr(seq_key)
            event.sequence = sequence
        else:
            # Fallback: use timestamp-based pseudo-sequence
            event.sequence = int(datetime.now(UTC).timestamp() * 1000)
            sequence = event.sequence

        # Write to Redis stream (hot path)
        if redis:
            stream_key = f"trace:{entity_id}:events"
            try:
                real_stream_id = await redis.xadd(
                    stream_key,
                    fields={"data": json.dumps(event.to_dict())},
                    maxlen=self.STREAM_MAXLEN,
                )
                if isinstance(real_stream_id, bytes):
                    real_stream_id = real_stream_id.decode()

                # Redis Stream IDs are ``<ms>-<seq>``, assigned by Redis
                # itself. They have no numeric relationship to either our
                # application-level ``event_id`` (a UUID) or ``sequence``
                # (a small monotonic int from ``INCR``). Callers resume
                # using those application-level values (SSE Last-Event-ID,
                # gRPC resume tokens, ``from_sequence``/``to_sequence``),
                # so we keep a small side index mapping each of them to
                # the real stream id XADD returned, and use *that* as the
                # XRANGE bound at read time instead of the raw
                # application value. See get_events_after()/get_trace().
                idx_key = f"trace:{entity_id}:idx"
                try:
                    await redis.hset(
                        idx_key,
                        mapping={
                            f"e:{event.event_id}": real_stream_id,
                            f"s:{event.sequence}": real_stream_id,
                        },
                    )
                    await redis.expire(idx_key, self.HOT_WINDOW_HOURS * 3600)
                except Exception as exc:
                    logger.debug(
                        f"Failed to update trace id index for {entity_id}: {exc}"
                    )
            except Exception as exc:
                logger.warning(f"Redis xadd failed for {entity_id}: {exc}")

        # Archive to PostgreSQL (cold path)
        if persist:
            await self._archive_event(event)

        # Publish to real-time subscribers
        await self._publish_event(entity_id, event)

        return sequence

    async def _archive_event(self, event: TraceEvent) -> None:
        """Archive an event to PostgreSQL for long-term storage."""
        client = await self._get_postgres()
        if not client:
            return

        try:
            await client.execute(
                """
                INSERT INTO trace_events (
                    event_id, event_type, timestamp, sequence,
                    tenant_id, user_id, entity_id, priority, payload, version
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (event_id) DO NOTHING
                """,
                event.event_id,
                event.event_type,
                event.timestamp,
                event.sequence,
                event.tenant_id,
                event.user_id,
                event.entity_id,
                event.priority,
                json.dumps(event.payload),
                event.version,
            )
        except Exception as exc:
            logger.warning(f"Failed to archive trace event {event.event_id}: {exc}")

    async def _publish_event(self, entity_id: str, event: TraceEvent) -> None:
        """Publish event to real-time WebSocket subscribers."""
        try:
            from eden.api.routes.websocket import _job_connections
            if entity_id in _job_connections:
                message = {
                    "type": "trace_event",
                    "event": event.to_dict(),
                }
                for ws in list(_job_connections[entity_id]):
                    try:
                        await ws.send_json(message)
                    except Exception:
                        _job_connections[entity_id].discard(ws)
                        if not _job_connections[entity_id]:
                            del _job_connections[entity_id]
                            break
        except Exception as exc:
            logger.debug(f"WebSocket publish failed for {entity_id}: {exc}")

    async def _lookup_stream_id(
        self,
        redis: Any,
        entity_id: str,
        *,
        event_id: str | None = None,
        sequence: int | None = None,
    ) -> str | None:
        """Resolve an application-level cursor to the real Redis stream ID.

        ``event_id`` (a UUID) and ``sequence`` (a small monotonic int from
        ``INCR``) are never valid Redis Stream IDs (``<ms>-<seq>``) on
        their own. ``append()`` records the real stream id XADD assigned
        for each of them in a small side index (``trace:{entity_id}:idx``)
        so reads can translate back to a real, comparable stream id.
        """
        idx_key = f"trace:{entity_id}:idx"
        field = f"e:{event_id}" if event_id is not None else f"s:{sequence}"
        try:
            value = await redis.hget(idx_key, field)
        except Exception as exc:
            logger.debug(f"Trace id index lookup failed for {entity_id}: {exc}")
            return None
        if isinstance(value, bytes):
            value = value.decode()
        return value

    async def get_events_after(
        self,
        entity_id: str,
        after_event_id: str,
        limit: int = 1000,
    ) -> list[dict]:
        """Return events with id > ``after_event_id`` (SSE resume).

        Phase 5.1.6: backs the ``Last-Event-ID`` resume contract for the
        SSE endpoints. Reads from the Redis stream (hot path) up to
        ``limit`` events. Returns the event dicts in order. Falls back
        to PostgreSQL when the Redis stream has aged out the event.
        """
        redis = await self._get_redis()
        if not redis:
            return await self._get_events_after_from_postgres(
                entity_id, after_event_id, limit
            )

        stream_key = f"trace:{entity_id}:events"
        try:
            # ``after_event_id`` is an application-level UUID (or an
            # arbitrary client-supplied Last-Event-ID) -- never a real
            # Redis Stream ID. Translate it via the side index written in
            # append() before using it as an XRANGE bound.
            real_stream_id = await self._lookup_stream_id(
                redis, entity_id, event_id=after_event_id
            )
            if real_stream_id is None:
                # Not (or no longer) in the hot-path index: either this
                # cursor predates the trace, or it has aged out of the
                # index's TTL window. PostgreSQL still knows the
                # event_id -> sequence ordering directly.
                return await self._get_events_after_from_postgres(
                    entity_id, after_event_id, limit
                )

            # Redis stream IDs are ``ms-seq`` (e.g. "1717250000123-0").
            # ``(after`` is exclusive lower bound, equivalent to id > after.
            rows = await redis.xrange(
                stream_key,
                min=f"({real_stream_id}",
                count=limit,
            )
        except Exception as exc:
            logger.debug(f"Redis xrange failed for {entity_id}: {exc}")
            return await self._get_events_after_from_postgres(
                entity_id, after_event_id, limit
            )

        events: list[dict] = []
        for _stream_id, fields in rows:
            try:
                events.append(json.loads(fields["data"]))
            except (KeyError, TypeError, json.JSONDecodeError):
                continue
        return events

    async def _get_events_after_from_postgres(
        self,
        entity_id: str,
        after_event_id: str,
        limit: int,
    ) -> list[dict]:
        """Cold-path resume: replay from archived trace_events.

        ``after_event_id`` is an application-level UUID with no
        relationship to insertion/sequence order -- comparing it
        directly (``event_id > $2``, the old behaviour) is a silent
        correctness bug, since UUIDs don't sort lexicographically in
        any way related to actual event ordering. ``trace_events`` has
        a real monotonic ``sequence`` column (assigned by Redis
        ``INCR``, or a timestamp-based fallback when Redis was down at
        append time -- see ``append()``), so look up the cursor
        event's ``sequence`` first and bound the range query by *that*,
        mirroring what ``get_trace()``'s Postgres fallback already does
        below.
        """
        client = await self._get_postgres()
        if not client:
            return []

        try:
            cursor_row = await client.fetchrow(
                """
                SELECT sequence FROM trace_events
                WHERE entity_id = $1 AND event_id = $2
                """,
                entity_id,
                after_event_id,
            )
        except Exception as exc:
            logger.debug(f"PG fallback cursor lookup failed for {entity_id}: {exc}")
            return []

        if cursor_row is None:
            # The cursor event isn't archived either (never persisted,
            # a garbage/foreign Last-Event-ID, or purged). We have no
            # monotonic bound to anchor the resume on, so -- unlike the
            # old code, which would silently compare UUIDs and return
            # some arbitrary wrong subset -- fail safe: log and return
            # no events rather than guess.
            logger.warning(
                f"PG fallback resume for {entity_id}: cursor event "
                f"{after_event_id!r} has no archived row, so its sequence "
                "can't be resolved; returning no events instead of risking "
                "wrong ordering/subset"
            )
            return []

        after_sequence = cursor_row["sequence"]

        try:
            rows = await client.fetch(
                """
                SELECT event_id, event_type, timestamp, sequence, payload
                FROM trace_events
                WHERE entity_id = $1
                  AND sequence > $2
                ORDER BY sequence ASC
                LIMIT $3
                """,
                entity_id,
                after_sequence,
                limit,
            )
        except Exception as exc:
            logger.debug(f"PG fallback resume failed for {entity_id}: {exc}")
            return []
        return [
            {
                "event_id": r["event_id"],
                "event_type": r["event_type"],
                "timestamp": r["timestamp"].isoformat() if r.get("timestamp") else None,
                "sequence": r["sequence"],
                "payload": r["payload"] if isinstance(r["payload"], dict)
                           else json.loads(r["payload"] or "{}"),
            }
            for r in rows
        ]

    async def get_trace(
        self,
        entity_id: str,
        from_sequence: int = 0,
        to_sequence: int | None = None,
        limit: int = 1000,
    ) -> list[TraceEvent]:
        """Retrieve events for a trace, preferring Redis hot path.

        Args:
            entity_id: The trace/job/benchmark ID.
            from_sequence: Start at this sequence (inclusive).
            to_sequence: End at this sequence (inclusive), or None for all.
            limit: Max events to return.

        Returns:
            Ordered list of TraceEvent objects.
        """
        redis = await self._get_redis()
        events: list[TraceEvent] = []

        # Hot path: read from Redis stream
        if redis:
            stream_key = f"trace:{entity_id}:events"
            try:
                # ``from_sequence``/``to_sequence`` are small monotonic
                # ints from our own INCR-based sequence counter, not real
                # Redis Stream IDs. A bare int like "2" is parsed by
                # Redis as the stream id "2-0" -- an almost-epoch
                # millisecond timestamp -- so using it directly as a
                # bound made every from_sequence > 0 behave like "from
                # the beginning of time" instead of actually skipping
                # already-seen events. Translate through the side index
                # written in append() to get the real stream id bound.
                min_bound = "-"
                if from_sequence and from_sequence > 0:
                    start_id = await self._lookup_stream_id(
                        redis, entity_id, sequence=from_sequence
                    )
                    # If unmapped (e.g. aged out of the index TTL window),
                    # everything left in a maxlen-trimmed stream is
                    # already newer than from_sequence, so reading from
                    # the start of what remains is correct.
                    min_bound = start_id if start_id is not None else "-"

                max_bound = "+"
                if to_sequence is not None:
                    end_id = await self._lookup_stream_id(
                        redis, entity_id, sequence=to_sequence
                    )
                    # If unmapped, we can't tell *why*: to_sequence may
                    # simply not have been written yet (safe to read
                    # through to the end), or its idx entry may have
                    # aged out of the TTL window while the event itself
                    # is still in the stream (unsafe to assume "+" --
                    # that would silently include events past
                    # to_sequence). Rather than guess, read through to
                    # "+" either way and enforce the exact upper bound
                    # below by filtering on each event's deserialized
                    # ``sequence``, which is authoritative regardless of
                    # which case we're actually in.
                    max_bound = end_id if end_id is not None else "+"

                # Redis xrange returns items in sequence order
                redis_events = await redis.xrange(
                    stream_key,
                    min=min_bound,
                    max=max_bound,
                    count=limit,
                )
                for _entry_id, fields in redis_events:
                    data = json.loads(fields.get("data", "{}"))
                    parsed_event = TraceEvent.from_dict(data)
                    if to_sequence is not None and parsed_event.sequence > to_sequence:
                        # Belt-and-suspenders for the aged-out-idx case
                        # above: never surface an event past the
                        # caller's requested upper bound, even if the
                        # XRANGE bound itself was too permissive.
                        continue
                    events.append(parsed_event)

                if len(events) >= limit:
                    return events[:limit]
            except Exception as exc:
                logger.debug(f"Redis xrange failed for {entity_id}: {exc}")

        # Cold path / backfill from PostgreSQL
        # If we got some events from Redis, continue from the last sequence
        last_seq = events[-1].sequence if events else from_sequence - 1
        remaining_limit = limit - len(events)

        if remaining_limit > 0:
            client = await self._get_postgres()
            if client:
                try:
                    rows = await client.fetch(
                        """
                        SELECT * FROM trace_events
                        WHERE entity_id = $1 AND sequence > $2
                        ORDER BY sequence ASC
                        LIMIT $3
                        """,
                        entity_id,
                        last_seq,
                        remaining_limit,
                    )
                    for row in rows:
                        payload = row["payload"]
                        if isinstance(payload, str):
                            payload = json.loads(payload)
                        event_data = dict(row)
                        event_data["payload"] = payload
                        events.append(TraceEvent.from_dict(event_data))
                except Exception as exc:
                    logger.warning(f"Postgres trace fetch failed for {entity_id}: {exc}")

        return events

    async def get_trace_summary(self, entity_id: str) -> dict[str, Any]:
        """Get a summary of a trace: event count, duration, types."""
        client = await self._get_postgres()
        if not client:
            return {"event_count": 0, "duration_ms": 0, "types": {}}

        try:
            row = await client.fetchrow(
                """
                SELECT
                    COUNT(*) as event_count,
                    MIN(timestamp) as started_at,
                    MAX(timestamp) as ended_at
                FROM trace_events
                WHERE entity_id = $1
                """,
                entity_id,
            )

            type_rows = await client.fetch(
                """
                SELECT event_type, COUNT(*) as count
                FROM trace_events
                WHERE entity_id = $1
                GROUP BY event_type
                """,
                entity_id,
            )

            started = row["started_at"] if row else None
            ended = row["ended_at"] if row else None
            duration_ms = 0
            if started and ended:
                try:
                    from dateutil import parser
                    duration_ms = (parser.parse(ended) - parser.parse(started)).total_seconds() * 1000
                except Exception:
                    pass

            return {
                "event_count": row["event_count"] if row else 0,
                "started_at": started.isoformat() if hasattr(started, "isoformat") else str(started),
                "ended_at": ended.isoformat() if hasattr(ended, "isoformat") else str(ended),
                "duration_ms": duration_ms,
                "types": {r["event_type"]: r["count"] for r in type_rows},
            }
        except Exception as exc:
            logger.warning(f"Trace summary failed for {entity_id}: {exc}")
            return {"event_count": 0, "duration_ms": 0, "types": {}}

    async def delete_trace(self, entity_id: str) -> None:
        """Delete a trace from Redis and flag for archival deletion."""
        redis = await self._get_redis()
        if redis:
            try:
                await redis.delete(f"trace:{entity_id}:events")
                await redis.delete(f"trace:{entity_id}:seq")
                await redis.delete(f"trace:{entity_id}:idx")
            except Exception as exc:
                logger.warning(f"Failed to delete Redis trace {entity_id}: {exc}")

        client = await self._get_postgres()
        if client:
            try:
                await client.execute(
                    "DELETE FROM trace_events WHERE entity_id = $1",
                    entity_id,
                )
            except Exception as exc:
                logger.warning(f"Failed to delete Postgres trace {entity_id}: {exc}")


# ── Singleton accessor ──────────────────────────────────────────────────

_trace_store: TraceEventStore | None = None


async def get_trace_store() -> TraceEventStore:
    """Get the singleton trace event store."""
    global _trace_store
    if _trace_store is None:
        _trace_store = TraceEventStore()
    return _trace_store


async def get_trace_event_store() -> TraceEventStore:
    """Alias for :func:`get_trace_store` — clearer name at call sites
    that primarily need read access (e.g. SSE resume replay)."""
    return await get_trace_store()


async def close_trace_store() -> None:
    """Close the trace event store (no-op, stateless)."""
    global _trace_store
    _trace_store = None
