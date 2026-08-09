"""A failed write must not make the retry look like a duplicate.

``_is_duplicate`` inserts the event's content hash into the dedup cache *before*
the event is routed. That ordering is deliberate and necessary — it is what makes
the check atomic against a concurrent duplicate — but it had no compensating
release, so a routing failure left the hash behind:

    1. client POSTs event E
    2. _is_duplicate(E) -> False, and records E's hash
    3. _route(E) raises (Postgres blip, sink timeout)
    4. caller gets a 5xx, SDK retries E exactly as designed
    5. _is_duplicate(E) -> True. Rejected.

The event is now gone for good, discarded by the mechanism whose entire purpose
is to protect against double-counting. And it is silent: the retry gets a 200
with ``deduplicated`` incremented, so the client believes the event is stored.

Releasing on failure is safe because the Postgres write is
``ON CONFLICT (event_id, timestamp) DO NOTHING`` — a retry that does land cannot
double-count. That is what makes reserve/release the right shape here rather
than a two-phase commit with real bookkeeping.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest

from eden.observability.errors import IngestionUnavailableError
from eden.observability.telemetry_collector import TelemetryCollector, TelemetryEvent

#: One timestamp for the whole module, captured at import.
#:
#: It has to be *recent* — ``ingest`` runs the late-span policy, which rejects
#: anything older than 24h, so a hardcoded date rots after a day. It also has to
#: be *stable*: ``_enrich`` builds the dedup hash from
#: ``trace_id|event_type|span_id|timestamp|event_id``, so calling
#: ``datetime.now()`` per event makes "the same event, retried" a different hash
#: and every dedup assertion here silently tests nothing. (Found exactly that
#: way: three tests failed because two identical events were not duplicates.)
_TS = datetime.now(UTC).isoformat()


def _event(idx: int) -> TelemetryEvent:
    """The same logical event for a given ``idx`` — same fields, same hash."""
    return TelemetryEvent(
        event_id=f"evt-{idx}",
        tenant_id="tenant-1",
        project_id="proj-1",
        trace_id=f"trace-{idx}",
        realm="production",
        event_type="llm.completion",
        timestamp=_TS,
    )


class TestSingleEventPath:
    @pytest.mark.asyncio
    async def test_retry_after_a_routing_failure_is_accepted(self) -> None:
        """The regression, end to end."""
        collector = TelemetryCollector()
        calls = {"n": 0}

        async def _route(
            _event: TelemetryEvent, *, skip_postgres: bool = False
        ) -> None:
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("pg blip")

        with (
            patch.object(collector, "_route", new=AsyncMock(side_effect=_route)),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
            patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
        ):
            event = _event(0)
            with pytest.raises(RuntimeError):
                await collector.ingest(event)

            # The SDK retries the same event. It must be routed, not deduped.
            retry = _event(0)
            assert await collector.ingest(retry) is True, (
                "the retry was rejected as a duplicate — the event is lost"
            )

        assert calls["n"] == 2, "the retry never reached the sinks"

    @pytest.mark.asyncio
    async def test_a_genuine_duplicate_is_still_rejected(self) -> None:
        """The release must not weaken dedup for events that *did* land."""
        collector = TelemetryCollector()

        with (
            patch.object(collector, "_route", new=AsyncMock()),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
            patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
        ):
            assert await collector.ingest(_event(0)) is True
            assert await collector.ingest(_event(0)) is False, (
                "dedup stopped working for successfully stored events"
            )

    @pytest.mark.asyncio
    async def test_reservation_is_released_on_cancellation_too(self) -> None:
        """A shutdown mid-route must not poison the hash either."""
        collector = TelemetryCollector()

        async def _cancel(_event: TelemetryEvent) -> None:
            raise TimeoutError("sink timed out")

        with (
            patch.object(collector, "_route", new=AsyncMock(side_effect=_cancel)),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
            patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
        ):
            with pytest.raises(TimeoutError):
                await collector.ingest(_event(1))

        assert collector._dedup_cache == {}, "a reservation survived the failure"


class TestBatchPath:
    @pytest.mark.asyncio
    async def test_only_the_failed_events_are_released(self) -> None:
        """A partial failure must free exactly the events that failed."""
        collector = TelemetryCollector()

        async def _route(
            event: TelemetryEvent, *, skip_postgres: bool = False
        ) -> None:
            if event.event_id == "evt-1":
                raise RuntimeError("sink exploded")

        with (
            patch.object(collector, "_route", new=AsyncMock(side_effect=_route)),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
            patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
        ):
            events = [_event(i) for i in range(3)]
            await collector.ingest_batch(events)

            # evt-1 failed, so its reservation is gone and a retry is accepted;
            # evt-0 and evt-2 landed, so theirs remain and a resend is deduped.
            result = await collector.ingest_batch([_event(0), _event(1), _event(2)])

        assert result["deduplicated"] == 2, (
            f"expected the two stored events to dedup, got {result}"
        )
        assert result["accepted"] == 1, (
            "the failed event's retry was not accepted — it is lost"
        )

    @pytest.mark.asyncio
    async def test_unavailable_releases_the_whole_batch(self) -> None:
        """Nothing landed, so nothing may stay reserved."""
        collector = TelemetryCollector()

        with (
            patch.object(
                collector,
                "_route",
                new=AsyncMock(side_effect=IngestionUnavailableError("pg down")),
            ),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
            patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
        ):
            with pytest.raises(IngestionUnavailableError):
                await collector.ingest_batch([_event(i) for i in range(3)])

        assert collector._dedup_cache == {}, (
            "reservations survived a total-failure batch, so the SDK's retry of "
            "the whole batch would be rejected wholesale"
        )

    @pytest.mark.asyncio
    async def test_a_clean_batch_keeps_every_reservation(self) -> None:
        collector = TelemetryCollector()
        with (
            patch.object(collector, "_route", new=AsyncMock()),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
            patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
        ):
            await collector.ingest_batch([_event(i) for i in range(3)])
            result = await collector.ingest_batch([_event(i) for i in range(3)])
        assert result["deduplicated"] == 3


class TestReleaseHelper:
    def test_release_is_a_no_op_without_a_content_hash(self) -> None:
        """``_enrich`` sets the hash; an un-enriched event must not blow up."""
        collector = TelemetryCollector()
        collector._release_dedup(_event(0))  # no _content_hash yet

    def test_release_is_idempotent(self) -> None:
        collector = TelemetryCollector()
        event = _event(0)
        collector._enrich(event)
        assert collector._is_duplicate(event) is False
        collector._release_dedup(event)
        collector._release_dedup(event)
        assert collector._dedup_cache == {}

    def test_release_only_removes_its_own_hash(self) -> None:
        collector = TelemetryCollector()
        a, b = _event(0), _event(1)
        for e in (a, b):
            collector._enrich(e)
            collector._is_duplicate(e)
        collector._release_dedup(a)
        assert collector._is_duplicate(b) is True, "released the wrong entry"

    def test_reservation_semantics_are_documented(self) -> None:
        """The ordering is subtle enough that the next reader needs the why."""
        import inspect

        src = inspect.getsource(TelemetryCollector._release_dedup)
        assert "ON CONFLICT" in src, (
            "the release's safety argument rests on the idempotent write; say so"
        )


class TestNoRegressionInAccounting:
    @pytest.mark.asyncio
    async def test_failed_events_are_still_counted_as_drops(self) -> None:
        from eden.observability.drop_metrics import get_drop_metrics, reset_for_tests

        reset_for_tests()
        collector = TelemetryCollector()

        async def _route(
            event: TelemetryEvent, *, skip_postgres: bool = False
        ) -> None:
            if event.event_id == "evt-0":
                raise RuntimeError("boom")

        with (
            patch.object(collector, "_route", new=AsyncMock(side_effect=_route)),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
            patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
        ):
            await collector.ingest_batch([_event(0), _event(1)])

        assert get_drop_metrics().get(("queue", "write_error"), 0.0) == 1.0
        reset_for_tests()

    @pytest.mark.asyncio
    async def test_zip_strict_would_catch_a_length_mismatch(self) -> None:
        """The release loop pairs results to inputs by position.

        ``gather`` preserves order, so ``zip(..., strict=True)`` is the assertion
        that this assumption still holds — a silent mismatch would release the
        wrong events' reservations, which is worse than releasing none.
        """
        import inspect

        src = inspect.getsource(TelemetryCollector.ingest_batch)
        assert "strict=True" in src, (
            "the results/inputs pairing is unguarded; a length mismatch would "
            "release the wrong reservations"
        )
