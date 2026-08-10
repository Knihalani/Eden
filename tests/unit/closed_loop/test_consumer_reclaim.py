"""N5 — closed-loop consumer polls the Postgres outbox (no Redis).

Covers the run loop: dispatch via ``drain_outbox``, idle poll, clean
stop, and the D4 "keep trying when Postgres is down" behaviour.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import eden.closed_loop.event_bus as eb


@pytest.fixture(autouse=True)
def _reset_bus_state():
    eb.last_publish_failure_ts = None
    eb._seen.clear()
    yield
    eb.last_publish_failure_ts = None
    eb._seen.clear()


def _consumer(orch: MagicMock | None = None) -> eb.ClosedLoopConsumer:
    if orch is None:
        orch = MagicMock()
        orch.on_event = AsyncMock()
    return eb.ClosedLoopConsumer(orchestrator=orch)


@pytest.mark.asyncio
async def test_run_polls_outbox_with_consumer_orchestrator():
    consumer = _consumer()
    stop = asyncio.Event()
    calls = 0
    seen: list[tuple[int, object]] = []

    async def _drain(limit: int = 500, orchestrator=None) -> int:
        nonlocal calls
        calls += 1
        seen.append((limit, orchestrator))
        if calls >= 2:
            stop.set()
        return 0

    with (
        patch.object(eb, "drain_outbox", _drain),
        patch.object(eb, "_POLL_INTERVAL_S", 0.01),
    ):
        await asyncio.wait_for(consumer.run(stop), timeout=2.0)

    assert calls >= 2
    assert seen[0][0] == eb._BATCH
    assert seen[0][1] is consumer._orch


@pytest.mark.asyncio
async def test_run_dispatches_events_via_drain():
    consumer = _consumer()
    stop = asyncio.Event()
    calls = 0

    async def _drain(limit: int = 500, orchestrator=None) -> int:
        nonlocal calls
        calls += 1
        if calls >= 2:
            stop.set()
        return 1

    with patch.object(eb, "drain_outbox", _drain):
        await asyncio.wait_for(consumer.run(stop), timeout=2.0)

    assert calls >= 2  # kept going after dispatching, not one-shot


@pytest.mark.asyncio
async def test_no_pg_at_start_keeps_polling():
    """D4 — a Postgres blip at start must not permanently disable the
    loop; the consumer keeps polling (via drain_outbox returning 0)."""
    consumer = _consumer()
    stop = asyncio.Event()
    calls = 0

    async def _drain(limit: int = 500, orchestrator=None) -> int:
        nonlocal calls
        calls += 1
        if calls >= 3:
            stop.set()
        return 0

    with (
        patch.object(eb, "drain_outbox", _drain),
        patch.object(eb, "_POLL_INTERVAL_S", 0.01),
    ):
        await asyncio.wait_for(consumer.run(stop), timeout=2.0)

    assert calls >= 3


@pytest.mark.asyncio
async def test_run_stops_promptly_on_signal():
    consumer = _consumer()
    stop = asyncio.Event()
    calls = 0

    async def _drain(limit: int = 500, orchestrator=None) -> int:
        nonlocal calls
        calls += 1
        return 0  # empty — go idle

    with (
        patch.object(eb, "drain_outbox", _drain),
        patch.object(eb, "_POLL_INTERVAL_S", 30.0),
    ):
        task = asyncio.create_task(consumer.run(stop))
        await asyncio.sleep(0.05)
        assert not task.done()
        stop.set()
        await asyncio.wait_for(task, timeout=2.0)

    assert calls == 1  # one drain, then idle-wait woke on stop
