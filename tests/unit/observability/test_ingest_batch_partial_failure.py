"""One failing event must not abandon the rest of the batch — or the billing.

``ingest_batch`` fanned routing out with a bare ``asyncio.gather``. The first
per-event exception propagated straight out of the method, which skipped
everything after it: the billing roll-up **and** the debugger checkpoints, for
the *whole* batch including every event that routed successfully. The client got
a 500 for a request whose events were partly stored.

Retrying is safe — the Postgres write is
``ON CONFLICT (event_id, timestamp) DO NOTHING`` — but the failure must not be
reported per-event in the response, because the SDK acks on any 2xx and would
discard events it still needs to resend.

One exception keeps propagating: ``IngestionUnavailable`` means the durable
store is down, so *nothing* in the batch landed. It has to reach the caller as a
503 so the SDK backs off and retries, rather than being logged as a handful of
dropped events while the client is told everything is fine.

Separately, the single-event ``ingest()`` path never emitted billing events at
all — only ``ingest_batch`` did — so every event arriving through
``POST /observability/events`` or the Kafka consumer was stored and never
billed.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.observability.drop_metrics import get_drop_metrics, reset_for_tests
from eden.observability.errors import IngestionUnavailable
from eden.observability.telemetry_collector import TelemetryCollector, TelemetryEvent


@pytest.fixture(autouse=True)
def _reset_drops() -> None:
    reset_for_tests()
    yield
    reset_for_tests()


def _event(idx: int) -> TelemetryEvent:
    # The timestamp must be relative to now, not a literal. ``ingest`` runs the
    # late-span policy, which rejects anything older than
    # ``late_span_max_age_seconds`` (24h by default) -- so a hardcoded date
    # passes on the day it is written and starts failing the next, with a
    # ``False`` return that looks like a routing bug rather than a stale
    # fixture.
    return TelemetryEvent(
        event_id=f"evt-{idx}",
        tenant_id="tenant-1",
        project_id="proj-1",
        trace_id=f"trace-{idx}",
        realm="production",
        event_type="llm.completion",
        timestamp=datetime.now(UTC).isoformat(),
    )


def _collector() -> TelemetryCollector:
    return TelemetryCollector()


class _InlineBackground:
    """Run ``_spawn_bg`` coroutines on demand instead of detaching them.

    Billing is emitted through ``_spawn_bg``, so a test that asserts on it has
    to drive the coroutine itself; otherwise it is garbage-collected unawaited
    and the assertion sees nothing.
    """

    def __init__(self) -> None:
        self.coros: list[Any] = []

    def __call__(self, coro: Any) -> None:
        self.coros.append(coro)

    async def drain(self) -> None:
        while self.coros:
            await self.coros.pop(0)


class TestPartialRoutingFailure:
    @pytest.mark.asyncio
    async def test_one_bad_event_does_not_abandon_the_batch(self) -> None:
        collector = _collector()
        billed: list[list[Any]] = []

        async def _route(
            event: TelemetryEvent, *, skip_postgres: bool = False
        ) -> None:
            if event.event_id == "evt-1":
                raise RuntimeError("sink exploded")

        async def _emit(events: list[Any]) -> None:
            billed.append(list(events))

        with (
            patch.object(collector, "_route", new=AsyncMock(side_effect=_route)),
            patch.object(
                collector, "_emit_billing_events", new=AsyncMock(side_effect=_emit)
            ),
            patch.object(collector, "_spawn_bg", new=lambda coro: coro),
        ):
            result = await collector.ingest_batch([_event(i) for i in range(3)])

        assert result["accepted"] == 3

    @pytest.mark.asyncio
    async def test_billing_still_runs_after_a_per_event_failure(self) -> None:
        """The roll-up used to be skipped entirely for the whole batch."""
        collector = _collector()
        billed: list[list[Any]] = []

        async def _route(
            event: TelemetryEvent, *, skip_postgres: bool = False
        ) -> None:
            if event.event_id == "evt-0":
                raise RuntimeError("sink exploded")

        async def _emit(events: list[Any]) -> None:
            billed.append(list(events))

        bg = _InlineBackground()
        with (
            patch.object(collector, "_route", new=AsyncMock(side_effect=_route)),
            patch.object(
                collector, "_emit_billing_events", new=AsyncMock(side_effect=_emit)
            ),
            patch.object(collector, "_spawn_bg", new=bg),
        ):
            await collector.ingest_batch([_event(i) for i in range(3)])
            await bg.drain()

        assert billed, "billing roll-up never ran after a per-event failure"
        assert len(billed[0]) == 3

    @pytest.mark.asyncio
    async def test_failures_are_counted_as_drops(self) -> None:
        """A silent drop is what this whole wave exists to remove."""
        collector = _collector()

        async def _route(
            event: TelemetryEvent, *, skip_postgres: bool = False
        ) -> None:
            if event.event_id in {"evt-0", "evt-2"}:
                raise RuntimeError("sink exploded")

        with (
            patch.object(collector, "_route", new=AsyncMock(side_effect=_route)),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
        ):
            await collector.ingest_batch([_event(i) for i in range(3)])

        assert get_drop_metrics()[("queue", "write_error")] == 2.0

    @pytest.mark.asyncio
    async def test_clean_batch_records_no_drops(self) -> None:
        collector = _collector()
        with (
            patch.object(collector, "_route", new=AsyncMock()),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
        ):
            await collector.ingest_batch([_event(i) for i in range(3)])
        assert get_drop_metrics().get(("queue", "write_error"), 0.0) == 0.0


class TestBackpressureStillPropagates:
    """``IngestionUnavailable`` means the store is down — the client must know."""

    @pytest.mark.asyncio
    async def test_unavailable_is_reraised_not_swallowed(self) -> None:
        collector = _collector()
        with (
            patch.object(
                collector,
                "_route",
                new=AsyncMock(side_effect=IngestionUnavailable("pg down")),
            ),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
        ):
            with pytest.raises(IngestionUnavailable):
                await collector.ingest_batch([_event(0), _event(1)])

    @pytest.mark.asyncio
    async def test_unavailable_wins_over_an_ordinary_failure(self) -> None:
        """Mixed failures must still surface the retryable one."""
        collector = _collector()

        async def _route(
            event: TelemetryEvent, *, skip_postgres: bool = False
        ) -> None:
            if event.event_id == "evt-0":
                raise RuntimeError("sink exploded")
            raise IngestionUnavailable("pg down")

        with (
            patch.object(collector, "_route", new=AsyncMock(side_effect=_route)),
            patch.object(collector, "_emit_billing_events", new=AsyncMock()),
        ):
            with pytest.raises(IngestionUnavailable):
                await collector.ingest_batch([_event(0), _event(1)])


class TestSingleEventBilling:
    @pytest.mark.asyncio
    async def test_ingest_emits_billing_events(self) -> None:
        """The single-event path stored events without ever billing them."""
        collector = _collector()
        billed: list[list[Any]] = []

        async def _emit(events: list[Any]) -> None:
            billed.append(list(events))

        bg = _InlineBackground()
        with (
            patch.object(collector, "_route", new=AsyncMock()),
            patch.object(
                collector, "_emit_billing_events", new=AsyncMock(side_effect=_emit)
            ),
            patch.object(collector, "_spawn_bg", new=bg),
        ):
            assert await collector.ingest(_event(0)) is True
            await bg.drain()

        assert billed, (
            "ingest() routed the event but never emitted a billing event — "
            "every event through POST /observability/events was unbilled"
        )
        assert len(billed[0]) == 1
        assert billed[0][0].event_id == "evt-0"

    @pytest.mark.asyncio
    async def test_both_paths_bill_the_same_event(self) -> None:
        """Batch and single-event ingest must agree on what is billable."""
        seen: dict[str, int] = {"single": 0, "batch": 0}

        def _counter(key: str):
            async def _count(events: list[Any]) -> None:
                seen[key] += len(events)

            return _count

        single, bg1 = _collector(), _InlineBackground()
        with (
            patch.object(single, "_route", new=AsyncMock()),
            patch.object(
                single,
                "_emit_billing_events",
                new=AsyncMock(side_effect=_counter("single")),
            ),
            patch.object(single, "_spawn_bg", new=bg1),
        ):
            await single.ingest(_event(0))
            await bg1.drain()

        batch, bg2 = _collector(), _InlineBackground()
        with (
            patch.object(batch, "_route", new=AsyncMock()),
            patch.object(
                batch,
                "_emit_billing_events",
                new=AsyncMock(side_effect=_counter("batch")),
            ),
            patch.object(batch, "_spawn_bg", new=bg2),
        ):
            await batch.ingest_batch([_event(0)])
            await bg2.drain()

        assert seen["single"] == seen["batch"] == 1
