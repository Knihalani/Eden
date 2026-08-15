"""W1-3 collector bundle — unit tests for OOM items 3.1, 3.2, 3.3.

3.1 Agent-registration touch cooldown
  * Two batches 100 ms apart → one Neon write (the second is suppressed by the
    300 s cooldown).

3.2 Batch checkpoint + billing writers
  * A 20-span batch → ≤ 2 Neon round-trips from the checkpoint background task
    (one executemany for telemetry_events, one for debugger_llm_cache).
  * Billing rows are buffered; ``_flush_billing_buffer`` calls
    ``track_events_batch`` once for all accumulated rows.

3.3 Compression offload threshold (no dedicated test needed here — the bench
  test ``test_ingest_batching_collapses_round_trips`` and the fix to
  ``_fake_compress_many``'s signature cover the observable behaviour; the sync
  path is exercised whenever flat_fields < _COMPRESS_OFFLOAD_FIELDS).
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import eden.observability.telemetry_collector as _tc_module
from eden.observability.telemetry_collector import TelemetryCollector, TelemetryEvent
from eden.observability.ingestion.checkpoint_hook import maybe_persist_checkpoints_batch


# ── Helpers ───────────────────────────────────────────────────────────────────


def _llm_event(idx: int = 0, *, agent_id: str = "agent-1") -> TelemetryEvent:
    return TelemetryEvent(
        event_id=f"evt-{idx}",
        tenant_id="11111111-1111-1111-1111-111111111111",
        project_id="proj-1",
        trace_id=f"trace-{idx}",
        realm="production",
        event_type="llm.completion",
        timestamp=datetime.now(UTC).isoformat(),
        agent_id=agent_id,
        metrics={"input_tokens": 10, "output_tokens": 5},
        payload={
            "messages": [{"role": "user", "content": f"hello {idx}"}],
            "response": {"content": f"world {idx}"},
            "model": "gpt-4o",
        },
    )


def _collector_full() -> TelemetryCollector:
    """Collector with all __init__ attrs in place (calls real __init__)."""
    c = TelemetryCollector()
    return c


# ── 3.1 Agent touch cooldown ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_agent_touch_cooldown_skips_second_batch() -> None:
    """Two batches 100 ms apart containing the same agent → exactly ONE
    Neon write.  The second batch must be suppressed by the cooldown gate."""
    # Clear the module-level cache so this test starts fresh.
    _tc_module._agent_touch_cache.clear()

    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock()

    collector = TelemetryCollector()
    collector._postgres = fake_pg

    event = _llm_event(0, agent_id="bot-42")

    # First batch: should UPSERT.
    await collector._touch_agent_registrations([event])
    assert fake_pg.executemany.await_count == 1, (
        "first batch must trigger one executemany"
    )

    # 100 ms later — well within the 300 s cooldown.
    await asyncio.sleep(0)
    await collector._touch_agent_registrations([event])
    assert fake_pg.executemany.await_count == 1, (
        "second batch within cooldown must NOT trigger another executemany"
    )


@pytest.mark.asyncio
async def test_agent_touch_cooldown_fires_after_expiry() -> None:
    """A pair expires from the cache after the cooldown elapses."""
    _tc_module._agent_touch_cache.clear()

    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock()

    collector = TelemetryCollector()
    collector._postgres = fake_pg

    event = _llm_event(0, agent_id="bot-99")

    # First write.
    await collector._touch_agent_registrations([event])
    assert fake_pg.executemany.await_count == 1

    # Simulate expiry by back-dating the cache entry past the cooldown.
    key = ("11111111-1111-1111-1111-111111111111", "bot-99")
    _tc_module._agent_touch_cache[key] = time.monotonic() - _tc_module._AGENT_TOUCH_COOLDOWN_S - 1

    await collector._touch_agent_registrations([event])
    assert fake_pg.executemany.await_count == 2, (
        "expired pair must trigger another executemany"
    )


# ── 3.2 Checkpoint batch ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_checkpoint_batch_two_round_trips_for_twenty_events() -> None:
    """20 qualifying LLM events → at most 2 ``pg.executemany`` calls
    (one for telemetry_events checkpoints, one for debugger_llm_cache)."""
    from types import SimpleNamespace

    events = [
        SimpleNamespace(
            event_type="llm.completion",
            trace_id=f"trace-{i}",
            tenant_id="org-x",
            sequence=i,
            payload={
                "messages": [{"role": "user", "content": f"q{i}"}],
                "response": {"content": f"a{i}"},
                "model": "gpt-4o",
            },
        )
        for i in range(20)
    ]

    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock()

    # Patch Redis (not available) and step-number resolution.
    with patch(
        "eden.observability.ingestion.checkpoint_hook._resolve_step_number",
        new=AsyncMock(return_value=0),
    ), patch(
        "eden.debugger.cache.llm_input_hash", return_value="h"
    ):
        await maybe_persist_checkpoints_batch(events, pg=fake_pg)

    # At most 2 round-trips regardless of batch size.
    assert fake_pg.executemany.await_count <= 2, (
        f"expected ≤2 executemany calls, got {fake_pg.executemany.await_count}"
    )
    # Both tables must have been written.
    calls = [str(c.args[0]) for c in fake_pg.executemany.await_args_list]
    assert any("telemetry_events" in q for q in calls), (
        "checkpoint rows must be written to telemetry_events"
    )
    assert any("debugger_llm_cache" in q for q in calls), (
        "cache rows must be written to debugger_llm_cache"
    )


@pytest.mark.asyncio
async def test_checkpoint_batch_skips_non_llm_events() -> None:
    """Non-LLM events must not generate checkpoint rows."""
    from types import SimpleNamespace

    events = [
        SimpleNamespace(
            event_type="tool.call",
            trace_id="trace-1",
            tenant_id="org-x",
            sequence=0,
            payload={},
        )
        for _ in range(5)
    ]

    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock()

    await maybe_persist_checkpoints_batch(events, pg=fake_pg)

    fake_pg.executemany.assert_not_awaited()


@pytest.mark.asyncio
async def test_checkpoint_batch_is_best_effort() -> None:
    """Even when pg.executemany raises, the function must not propagate."""
    from types import SimpleNamespace

    events = [
        SimpleNamespace(
            event_type="llm.completion",
            trace_id="tr",
            tenant_id="org-x",
            sequence=0,
            payload={
                "messages": [{"role": "user", "content": "hi"}],
                "response": {"content": "ok"},
            },
        )
    ]

    fake_pg = MagicMock()
    fake_pg.executemany = AsyncMock(side_effect=RuntimeError("db down"))

    with patch(
        "eden.observability.ingestion.checkpoint_hook._resolve_step_number",
        new=AsyncMock(return_value=0),
    ):
        # Must not raise.
        await maybe_persist_checkpoints_batch(events, pg=fake_pg)


# ── 3.2 Billing buffer ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_billing_buffer_accumulates_across_batches() -> None:
    """Rows from two separate ``_emit_billing_events`` calls must be
    accumulated in the buffer and flushed together in one
    ``track_events_batch`` call."""
    collector = _collector_full()

    mock_batch = AsyncMock(return_value=1)
    mock_service = MagicMock()
    mock_service.track_events_batch = mock_batch

    events_a = [_llm_event(0)]
    events_b = [_llm_event(1)]

    with patch(
        "eden.services.usage_service.UsageService",
        return_value=mock_service,
        create=True,
    ):
        await collector._emit_billing_events(events_a)
        await collector._emit_billing_events(events_b)
        # Nothing flushed yet (buffer < 500 rows and no timer elapsed).
        mock_batch.assert_not_awaited()

        # Explicit flush drains both batches in a single call.
        await collector._flush_billing_buffer()

    mock_batch.assert_awaited_once()
    (sent_batch,) = mock_batch.await_args.args
    llm_rows = [r for r in sent_batch if r["event_type"] == "llm_call"]
    span_rows = [r for r in sent_batch if r["event_type"] == "span_ingest"]
    trace_rows = [r for r in sent_batch if r["event_type"] == "trace_ingest"]
    assert len(llm_rows) == 2, f"expected 2 llm_call rows, got {len(llm_rows)}"
    assert len(span_rows) == 2, f"expected 2 span_ingest rows (one per batch), got {len(span_rows)}"
    assert len(trace_rows) == 2, f"expected 2 trace_ingest rows (one per batch), got {len(trace_rows)}"


@pytest.mark.asyncio
async def test_billing_buffer_flush_on_size_threshold() -> None:
    """When the buffer hits BILLING_FLUSH_MAX_ROWS the flush must fire
    inline (within the same ``_emit_billing_events`` call)."""
    collector = _collector_full()
    # Shrink the threshold so the test doesn't need 500 events.
    collector.BILLING_FLUSH_MAX_ROWS = 3

    mock_batch = AsyncMock(return_value=1)
    mock_service = MagicMock()
    mock_service.track_events_batch = mock_batch

    events = [_llm_event(i) for i in range(3)]

    with patch(
        "eden.services.usage_service.UsageService",
        return_value=mock_service,
        create=True,
    ):
        await collector._emit_billing_events(events)

    # Size threshold hit → inline flush without waiting for timer.
    mock_batch.assert_awaited_once()
    (sent_batch,) = mock_batch.await_args.args
    llm_rows = [r for r in sent_batch if r["event_type"] == "llm_call"]
    assert len(llm_rows) == 3, f"expected 3 llm_call rows, got {len(llm_rows)}"


@pytest.mark.asyncio
async def test_billing_buffer_drained_on_close() -> None:
    """``close_telemetry_collector`` must drain the billing buffer."""
    from eden.observability.telemetry_collector import (
        get_telemetry_collector,
        close_telemetry_collector,
    )

    # Reset singleton.
    import eden.observability.telemetry_collector as _tc
    old = _tc._telemetry_collector
    _tc._telemetry_collector = None

    try:
        collector = await get_telemetry_collector()

        mock_batch = AsyncMock(return_value=1)
        mock_service = MagicMock()
        mock_service.track_events_batch = mock_batch

        with patch(
            "eden.services.usage_service.UsageService",
            return_value=mock_service,
            create=True,
        ):
            await collector._emit_billing_events([_llm_event(0)])
            # Buffer has 1 row; timer has NOT fired.
            mock_batch.assert_not_awaited()
            await close_telemetry_collector()

        mock_batch.assert_awaited_once()
    finally:
        _tc._telemetry_collector = old
