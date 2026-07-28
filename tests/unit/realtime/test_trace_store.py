"""Regression tests for TraceEventStore resume/time-travel semantics.

Prior to this fix, ``get_events_after()`` passed the application-level
``event_id`` (a UUID, or an arbitrary client-supplied Last-Event-ID)
directly as the Redis ``XRANGE`` lower bound. Redis Stream IDs must be
``<ms>-<seq>``, so a non-numeric UUID either raised inside redis-py
(silently falling back to a Postgres path with no matching client) or,
if it happened to look numeric, was misinterpreted as a millisecond
timestamp with no relation to the real stream position.

Separately, ``get_trace()`` passed ``from_sequence``/``to_sequence`` --
small monotonic ints from ``INCR`` -- directly as ``XRANGE`` bounds.
Redis parses a bare integer like "2" as the stream id "2-0", an
almost-epoch-millisecond timestamp, so any ``from_sequence > 0`` was
effectively "from the beginning of time" and did not actually skip
already-seen events the way ``mobile_sse.py``/``grpc_server.py`` expect.

The fix maintains a side index (``trace:{entity_id}:idx``) mapping each
application-level ``event_id``/``sequence`` to the real Redis stream id
XADD assigned at write time, and uses that real id as the XRANGE bound.

These tests use a minimal in-memory fake Redis whose stream ids are
deliberately real-looking (large epoch-ms-like numbers) and decoupled
from the small monotonic ``sequence``/UUID ``event_id`` values, so that
a regression back to using the raw application value as the XRANGE
bound is caught rather than accidentally passing by coincidence.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest


class FakeRedis:
    """Minimal in-memory async fake covering the stream/hash ops
    TraceEventStore uses.

    Stream ids are generated independently of any sequence/event_id the
    caller supplies, mirroring real Redis (``<ms>-<seq>``) where the
    numeric id has no relationship to application-level identifiers.
    """

    def __init__(self) -> None:
        self._streams: dict[str, list[tuple[str, dict]]] = {}
        self._hashes: dict[str, dict[str, str]] = {}
        self._counters: dict[str, int] = {}
        # Start far from small ints like 1, 2, 3 so a regression that
        # uses the raw sequence/event_id as a bound is not masked by
        # coincidental overlap with our fake id space.
        self._next_ms = 1_700_000_000_000

    # -- plain KV / counter ops --------------------------------------
    async def incr(self, key: str) -> int:
        self._counters[key] = self._counters.get(key, 0) + 1
        return self._counters[key]

    async def delete(self, key: str) -> None:
        self._streams.pop(key, None)
        self._hashes.pop(key, None)
        self._counters.pop(key, None)

    async def expire(self, key: str, seconds: int) -> None:
        pass

    # -- hash ops (side index) ---------------------------------------
    async def hset(
        self,
        key: str,
        field: str | None = None,
        value: str | None = None,
        mapping: dict[str, str] | None = None,
    ) -> None:
        h = self._hashes.setdefault(key, {})
        if mapping:
            h.update(mapping)
        if field is not None:
            h[field] = value

    async def hget(self, key: str, field: str) -> str | None:
        return self._hashes.get(key, {}).get(field)

    # -- stream ops ----------------------------------------------------
    @staticmethod
    def _id_tuple(entry_id: str) -> tuple[int, int]:
        if "-" in entry_id:
            ms, seq = entry_id.split("-", 1)
        else:
            ms, seq = entry_id, "0"
        return (int(ms), int(seq))

    def _parse_bound(self, token: str) -> tuple[tuple[int, int], bool]:
        exclusive = token.startswith("(")
        if exclusive:
            token = token[1:]
        return self._id_tuple(token), exclusive

    async def xadd(
        self,
        name: str,
        fields: dict[str, str],
        maxlen: int | None = None,
        approximate: bool = True,
    ) -> str:
        entry_id = f"{self._next_ms}-0"
        self._next_ms += 7  # simulate a few ms passing between events
        self._streams.setdefault(name, []).append((entry_id, dict(fields)))
        if maxlen is not None:
            self._streams[name] = self._streams[name][-maxlen:]
        return entry_id

    async def xrange(
        self,
        name: str,
        min: str = "-",  # noqa: A002
        max: str = "+",  # noqa: A002
        count: int | None = None,
    ) -> list[tuple[str, dict]]:
        entries = self._streams.get(name, [])
        lo = None
        hi = None
        if min != "-":
            lo = self._parse_bound(min)
        if max != "+":
            hi = self._parse_bound(max)

        results = []
        for entry_id, fields in entries:
            eid = self._id_tuple(entry_id)
            if lo is not None:
                bound, exclusive = lo
                if (exclusive and eid <= bound) or (not exclusive and eid < bound):
                    continue
            if hi is not None:
                bound, exclusive = hi
                if (exclusive and eid >= bound) or (not exclusive and eid > bound):
                    continue
            results.append((entry_id, fields))

        if count is not None:
            results = results[:count]
        return results


def _patched_redis(fake: FakeRedis):
    return patch(
        "eden.storage.redis.get_redis_client",
        new=AsyncMock(return_value=fake),
    )


def _redis_unavailable():
    """Simulate Redis being down: ``_get_redis()`` catches the failure
    and returns ``None``, which is exactly the condition under which
    ``get_events_after`` must fall through to the Postgres cold path."""
    return patch(
        "eden.storage.redis.get_redis_client",
        new=AsyncMock(side_effect=RuntimeError("redis unavailable")),
    )


class FakePostgres:
    """Minimal in-memory async fake covering the ``trace_events`` reads
    ``_get_events_after_from_postgres`` performs: a cursor-event
    sequence lookup by ``event_id``, followed by a ``sequence >``
    range query -- never a raw ``event_id`` text comparison.
    """

    def __init__(self, rows: list[dict] | None = None) -> None:
        self.rows: list[dict] = rows or []

    async def fetchrow(self, query: str, *args: object) -> dict | None:
        entity_id, event_id = args
        for row in self.rows:
            if row["entity_id"] == entity_id and row["event_id"] == event_id:
                return {"sequence": row["sequence"]}
        return None

    async def fetch(self, query: str, *args: object) -> list[dict]:
        entity_id, after_sequence, limit = args
        matched = [
            row
            for row in self.rows
            if row["entity_id"] == entity_id and row["sequence"] > after_sequence
        ]
        matched.sort(key=lambda row: row["sequence"])
        return matched[:limit]

    async def execute(self, query: str, *args: object) -> str:
        return "OK"


def _patched_postgres(fake: FakePostgres):
    return patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=fake),
    )


def _pg_row(
    entity_id: str,
    event_id: str,
    event_type: str,
    sequence: int,
    payload: dict | None = None,
) -> dict:
    return {
        "entity_id": entity_id,
        "event_id": event_id,
        "event_type": event_type,
        "timestamp": datetime(2026, 1, 1, tzinfo=UTC),
        "sequence": sequence,
        "payload": payload if payload is not None else {},
    }


def _make_event(entity_id: str, event_id: str, event_type: str = "step"):
    from eden.realtime.trace_store import TraceEvent

    return TraceEvent(
        event_id=event_id,
        event_type=event_type,
        timestamp="2026-01-01T00:00:00Z",
        sequence=0,
        tenant_id="t1",
        user_id="u1",
        entity_id=entity_id,
    )


class TestGetEventsAfterResume:
    @pytest.mark.asyncio
    async def test_excludes_already_seen_events_by_event_id(self) -> None:
        """A real Last-Event-ID cursor must exclude everything at/before
        it and return only strictly-later events -- not crash, not
        silently return nothing, not return everything."""
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        fake = FakeRedis()
        entity_id = "trace-resume-1"

        with _patched_redis(fake):
            await store.append(entity_id, _make_event(entity_id, "evt-1"), persist=False)
            await store.append(entity_id, _make_event(entity_id, "evt-2"), persist=False)
            await store.append(entity_id, _make_event(entity_id, "evt-3"), persist=False)

            resumed = await store.get_events_after(entity_id, "evt-2")

        assert [e["event_id"] for e in resumed] == ["evt-3"]

    @pytest.mark.asyncio
    async def test_resume_from_first_event_returns_remaining_two(self) -> None:
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        fake = FakeRedis()
        entity_id = "trace-resume-2"

        with _patched_redis(fake):
            await store.append(entity_id, _make_event(entity_id, "evt-a"), persist=False)
            await store.append(entity_id, _make_event(entity_id, "evt-b"), persist=False)
            await store.append(entity_id, _make_event(entity_id, "evt-c"), persist=False)

            resumed = await store.get_events_after(entity_id, "evt-a")

        assert [e["event_id"] for e in resumed] == ["evt-b", "evt-c"]

    @pytest.mark.asyncio
    async def test_unknown_cursor_falls_back_without_crashing(self) -> None:
        """A cursor absent from the hot-path index (e.g. aged out, or
        garbage) must not raise -- it degrades to the Postgres fallback
        (empty here, since no Postgres client is configured)."""
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        fake = FakeRedis()
        entity_id = "trace-resume-3"

        with _patched_redis(fake):
            await store.append(entity_id, _make_event(entity_id, "evt-1"), persist=False)
            resumed = await store.get_events_after(entity_id, "not-a-known-event-id")

        assert resumed == []


class TestGetTraceSequenceBounds:
    @pytest.mark.asyncio
    async def test_from_sequence_excludes_earlier_events(self) -> None:
        """from_sequence must actually skip already-seen events instead
        of behaving like 'from the beginning of time' for every
        from_sequence > 0."""
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        fake = FakeRedis()
        entity_id = "trace-seq-1"

        with _patched_redis(fake):
            seq1 = await store.append(entity_id, _make_event(entity_id, "e1"), persist=False)
            seq2 = await store.append(entity_id, _make_event(entity_id, "e2"), persist=False)
            seq3 = await store.append(entity_id, _make_event(entity_id, "e3"), persist=False)
            assert (seq1, seq2, seq3) == (1, 2, 3)

            events = await store.get_trace(entity_id, from_sequence=2)

        assert [e.event_id for e in events] == ["e2", "e3"]

    @pytest.mark.asyncio
    async def test_to_sequence_excludes_later_events(self) -> None:
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        fake = FakeRedis()
        entity_id = "trace-seq-2"

        with _patched_redis(fake):
            await store.append(entity_id, _make_event(entity_id, "e1"), persist=False)
            await store.append(entity_id, _make_event(entity_id, "e2"), persist=False)
            await store.append(entity_id, _make_event(entity_id, "e3"), persist=False)

            events = await store.get_trace(entity_id, from_sequence=0, to_sequence=2)

        assert [e.event_id for e in events] == ["e1", "e2"]

    @pytest.mark.asyncio
    async def test_from_sequence_zero_returns_everything(self) -> None:
        """Default (from_sequence=0) must still behave as a full read
        from the start -- the fix must not regress the common case."""
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        fake = FakeRedis()
        entity_id = "trace-seq-3"

        with _patched_redis(fake):
            await store.append(entity_id, _make_event(entity_id, "e1"), persist=False)
            await store.append(entity_id, _make_event(entity_id, "e2"), persist=False)

            events = await store.get_trace(entity_id)

        assert [e.event_id for e in events] == ["e1", "e2"]

    @pytest.mark.asyncio
    async def test_to_sequence_still_excludes_later_events_when_idx_entry_aged_out(
        self,
    ) -> None:
        """If the ``to_sequence`` cursor's side-index entry has aged out
        of its TTL window (but the stream itself hasn't been trimmed
        past it), ``_lookup_stream_id`` returns ``None`` and the XRANGE
        upper bound falls back to ``"+"``. That must not silently pull
        in events beyond ``to_sequence`` -- the post-filter on each
        event's real ``sequence`` must still enforce the exact bound.
        """
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        fake = FakeRedis()
        entity_id = "trace-seq-4"

        with _patched_redis(fake):
            await store.append(entity_id, _make_event(entity_id, "e1"), persist=False)
            await store.append(entity_id, _make_event(entity_id, "e2"), persist=False)
            await store.append(entity_id, _make_event(entity_id, "e3"), persist=False)
            await store.append(entity_id, _make_event(entity_id, "e4"), persist=False)

            # Simulate the idx entry for sequence=2 having aged out of
            # its TTL window while e3/e4 are still present in the
            # (untrimmed) stream -- the "not written yet" assumption
            # behind the "+" fallback does not hold here.
            idx_key = f"trace:{entity_id}:idx"
            del fake._hashes[idx_key]["s:2"]

            events = await store.get_trace(entity_id, from_sequence=0, to_sequence=2)

        assert [e.event_id for e in events] == ["e1", "e2"]


class TestPostgresFallbackResume:
    """``get_events_after`` must fall back to Postgres correctly --
    ordered/filtered by the real monotonic ``sequence`` column, never
    by a raw text comparison on the ``event_id`` UUID -- when Redis is
    unavailable, when the hot-path idx has no entry for the cursor, or
    when XRANGE itself fails.
    """

    @pytest.mark.asyncio
    async def test_redis_unavailable_falls_back_to_postgres_in_sequence_order(
        self,
    ) -> None:
        """Rows are deliberately inserted with UUIDs whose lexicographic
        order is the *reverse* of insertion order, so a regression back
        to ``event_id > $2`` (text comparison) would return the wrong
        subset (likely empty, since 'aaa'/'mmm' are not > 'zzz') instead
        of the two events that actually come after by sequence.
        """
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        entity_id = "trace-pg-1"
        fake_pg = FakePostgres(
            rows=[
                _pg_row(entity_id, "zzz-event", "step", sequence=1),
                _pg_row(entity_id, "aaa-event", "step", sequence=2),
                _pg_row(entity_id, "mmm-event", "step", sequence=3),
            ]
        )

        with _redis_unavailable(), _patched_postgres(fake_pg):
            resumed = await store.get_events_after(entity_id, "zzz-event")

        assert [e["event_id"] for e in resumed] == ["aaa-event", "mmm-event"]

    @pytest.mark.asyncio
    async def test_resume_from_middle_event_returns_only_strictly_later_ones(
        self,
    ) -> None:
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        entity_id = "trace-pg-2"
        fake_pg = FakePostgres(
            rows=[
                _pg_row(entity_id, "e1", "step", sequence=1),
                _pg_row(entity_id, "e2", "step", sequence=2),
                _pg_row(entity_id, "e3", "step", sequence=3),
                _pg_row(entity_id, "e4", "step", sequence=4),
            ]
        )

        with _redis_unavailable(), _patched_postgres(fake_pg):
            resumed = await store.get_events_after(entity_id, "e2")

        assert [e["event_id"] for e in resumed] == ["e3", "e4"]

    @pytest.mark.asyncio
    async def test_unarchived_cursor_fails_safe_with_no_events(self) -> None:
        """A cursor event that isn't in Postgres either (never
        persisted, foreign, or purged) gives no monotonic bound to
        anchor on. The fallback must fail safe -- return nothing --
        rather than silently returning an arbitrary wrong subset via a
        raw UUID text comparison."""
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        entity_id = "trace-pg-3"
        fake_pg = FakePostgres(
            rows=[
                _pg_row(entity_id, "e1", "step", sequence=1),
                _pg_row(entity_id, "e2", "step", sequence=2),
            ]
        )

        with _redis_unavailable(), _patched_postgres(fake_pg):
            resumed = await store.get_events_after(entity_id, "not-archived-either")

        assert resumed == []

    @pytest.mark.asyncio
    async def test_idx_miss_on_hot_path_falls_back_to_postgres_correctly(
        self,
    ) -> None:
        """Redis is up but the cursor's side-index entry aged out (or
        never existed) -- ``get_events_after`` must still resolve the
        correct ordered subset via the Postgres fallback rather than
        mis-ordering by UUID."""
        from eden.realtime.trace_store import TraceEventStore

        store = TraceEventStore()
        fake_redis = FakeRedis()
        entity_id = "trace-pg-4"
        fake_pg = FakePostgres(
            rows=[
                _pg_row(entity_id, "zzz-first", "step", sequence=1),
                _pg_row(entity_id, "aaa-second", "step", sequence=2),
            ]
        )

        with _patched_redis(fake_redis), _patched_postgres(fake_pg):
            # No append() call, so the Redis idx has no entry at all
            # for "zzz-first" -- this must go straight to Postgres.
            resumed = await store.get_events_after(entity_id, "zzz-first")

        assert [e["event_id"] for e in resumed] == ["aaa-second"]
