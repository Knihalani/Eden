"""``accepted`` must mean *stored*, and sampled-out events must say so.

``accepted`` is the number the ingest API hands back to the SDK, and it
was counting events the sampling gate had just thrown away. So a customer
was told "1000 accepted" for a batch of which Eden had stored — and could
show, and would bill for — 150. Billing already excluded sampled-out
events (they never reach ``_emit_billing_events``, which only sees
``to_route``), so the two numbers disagreed with nothing in the response
to explain the gap.

These tests fail if ``accepted += 1`` / ``return True`` is restored on the
sampled-out branch of either ingest path.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest

from eden.observability.telemetry_collector import TelemetryCollector, TelemetryEvent


def _event(i: int, *, trace_id: str = "tr-1") -> TelemetryEvent:
    # ``now``, not a literal: ``ingest`` runs the late-span policy, which
    # rejects anything older than ``late_span_max_age_seconds``.
    return TelemetryEvent(
        event_id=f"evt-{i}",
        tenant_id="org-1",
        project_id="proj-1",
        trace_id=trace_id,
        realm="production",
        event_type="llm.completion",
        timestamp=datetime.now(UTC).isoformat(),
    )


def _collector_patches(collector: TelemetryCollector, *, route_all: bool):
    """Patch out the sinks; ``route_all=False`` sends everything to the gate."""
    return (
        patch(
            "eden.observability.sampling.apply.should_route_event",
            new=AsyncMock(return_value=route_all),
        ),
        patch.object(collector, "_route", new=AsyncMock()),
        patch.object(collector, "_route_postgres_many", new=AsyncMock()),
        patch.object(collector, "_emit_billing_events", new=AsyncMock()),
        patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
    )


# ── Batch path ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_reports_sampled_out_separately_from_accepted() -> None:
    collector = TelemetryCollector()
    a, b, c, d, e = _collector_patches(collector, route_all=False)
    with a, b, c, d, e:
        result = await collector.ingest_batch([_event(i) for i in range(6)])

    assert result["sampled_out"] == 6
    assert result["accepted"] == 0, (
        "the SDK was told six events were accepted; the sinks never saw one"
    )
    assert result["rejected"] == 0, "sampled out is not an error"
    assert result["deduplicated"] == 0
    assert result["total"] == 6


@pytest.mark.asyncio
async def test_batch_accepted_equals_the_number_actually_routed() -> None:
    """``accepted`` tracks what reached the durable sink, event for event."""
    collector = TelemetryCollector()
    events = [_event(i, trace_id=f"tr-{i}") for i in range(10)]
    # Keep the even-indexed events only.
    keep = {e.event_id for e in events[::2]}

    async def _gate(event) -> bool:
        return event.event_id in keep

    with (
        patch("eden.observability.sampling.apply.should_route_event", new=_gate),
        patch.object(collector, "_route", new=AsyncMock()),
        patch.object(
            collector, "_route_postgres_many", new=AsyncMock()
        ) as route_many,
        patch.object(collector, "_emit_billing_events", new=AsyncMock()),
        patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
    ):
        result = await collector.ingest_batch(events)

    stored = route_many.await_args.args[0]
    assert len(stored) == 5
    assert result["accepted"] == len(stored)
    assert result["sampled_out"] == 5
    assert result["accepted"] + result["sampled_out"] == result["total"]


@pytest.mark.asyncio
async def test_batch_accepted_matches_what_billing_is_given() -> None:
    """The customer-visible count and the billed count must not diverge.

    Billing is emitted from ``to_route`` — the post-gate list — so this
    pins ``accepted`` to exactly that list. Folding sampled-out events
    into ``accepted`` breaks the equality with nothing to explain it.
    """
    collector = TelemetryCollector()
    events = [_event(i, trace_id=f"tr-{i}") for i in range(8)]
    keep = {e.event_id for e in events[:3]}

    async def _gate(event) -> bool:
        return event.event_id in keep

    with (
        patch("eden.observability.sampling.apply.should_route_event", new=_gate),
        patch.object(collector, "_route", new=AsyncMock()),
        patch.object(collector, "_route_postgres_many", new=AsyncMock()),
        patch.object(collector, "_emit_billing_events", new=AsyncMock()) as billed,
        patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
    ):
        result = await collector.ingest_batch(events)

    # ``call_args``, not ``await_args``: billing is fired through
    # ``_spawn_bg``, which the patch above closes rather than awaits.
    billed_events = billed.call_args.args[0]
    assert result["accepted"] == len(billed_events) == 3
    assert result["sampled_out"] == 5


@pytest.mark.asyncio
async def test_batch_with_sampling_off_reports_no_sampled_out() -> None:
    collector = TelemetryCollector()
    a, b, c, d, e = _collector_patches(collector, route_all=True)
    with a, b, c, d, e:
        result = await collector.ingest_batch([_event(i) for i in range(4)])

    assert result["accepted"] == 4
    assert result["sampled_out"] == 0


# ── Single-event path ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_single_ingest_reports_sampled_out_not_accepted() -> None:
    collector = TelemetryCollector()
    a, b, c, d, e = _collector_patches(collector, route_all=False)
    with a, b, c, d, e:
        result = await collector.ingest_one(_event(0))

    assert result == {
        "accepted": 0,
        "deduplicated": 0,
        "rejected": 0,
        "sampled_out": 1,
        "total": 1,
    }


@pytest.mark.asyncio
async def test_single_ingest_bool_means_stored() -> None:
    """``ingest()`` keeps its bool contract, and the bool means *stored*."""
    collector = TelemetryCollector()
    a, b, c, d, e = _collector_patches(collector, route_all=False)
    with a, b, c, d, e:
        assert await collector.ingest(_event(0)) is False

    collector2 = TelemetryCollector()
    a, b, c, d, e = _collector_patches(collector2, route_all=True)
    with a, b, c, d, e:
        assert await collector2.ingest(_event(1)) is True


@pytest.mark.asyncio
async def test_single_ingest_distinguishes_duplicate_from_rejected() -> None:
    """One event can no longer be reported as deduplicated *and* rejected.

    The old route body computed ``deduplicated=0 if accepted else 1`` and
    ``rejected=0 if accepted else 1``, so a single duplicate came back as
    a response whose counts summed to 2 out of a total of 1.
    """
    collector = TelemetryCollector()
    # The dedup hash covers the timestamp, so a re-send is the *same*
    # event object, not a freshly built one.
    event = _event(0)
    a, b, c, d, e = _collector_patches(collector, route_all=True)
    with a, b, c, d, e:
        first = await collector.ingest_one(event)
        second = await collector.ingest_one(event)

    assert first["accepted"] == 1
    assert second["deduplicated"] == 1
    assert second["rejected"] == 0
    for result in (first, second):
        counts = ("accepted", "deduplicated", "rejected", "sampled_out")
        assert sum(result[k] for k in counts) == result["total"] == 1


@pytest.mark.asyncio
async def test_single_ingest_reports_a_validation_failure_as_rejected() -> None:
    collector = TelemetryCollector()
    with patch.object(collector, "_validate", return_value=False):
        result = await collector.ingest_one(_event(0))

    assert result["rejected"] == 1
    assert result["accepted"] == 0
    assert result["sampled_out"] == 0


@pytest.mark.asyncio
async def test_counts_always_sum_to_total_in_a_mixed_batch() -> None:
    """The invariant that makes the response readable at all."""
    collector = TelemetryCollector()
    events = [_event(i, trace_id=f"tr-{i}") for i in range(9)]
    events.append(events[0])  # a re-sent event: same ids, same timestamp
    sampled = {e.event_id for e in events[3:6]}

    async def _gate(event) -> bool:
        return event.event_id not in sampled

    with (
        patch("eden.observability.sampling.apply.should_route_event", new=_gate),
        patch.object(collector, "_validate", side_effect=lambda e: e.event_id != "evt-8"),
        patch.object(collector, "_route", new=AsyncMock()),
        patch.object(collector, "_route_postgres_many", new=AsyncMock()),
        patch.object(collector, "_emit_billing_events", new=AsyncMock()),
        patch.object(collector, "_spawn_bg", new=lambda coro: coro.close()),
    ):
        result = await collector.ingest_batch(events)

    assert result["rejected"] == 1
    assert result["deduplicated"] == 1
    assert result["sampled_out"] == 3
    assert result["accepted"] == 5
    assert (
        result["accepted"]
        + result["deduplicated"]
        + result["rejected"]
        + result["sampled_out"]
        == result["total"]
        == 10
    )
