"""Phase 7.x billing-roll-up: TelemetryCollector must record a
``usage_events`` row for every accepted LLM completion event so the
SDK-reported token counts aggregate into the org's free-tier cap.

The collector's ``_route`` step is mocked so the test exercises only
the new billing hook — no Postgres writes beyond what the mocked
``track_events_batch`` records.

Phase 3 (ingest hot-path batching): ``_emit_billing_events`` now calls
``UsageService.track_events_batch`` ONCE per ingest batch (a single
``executemany``) instead of ``track_event`` once per billable event.
These tests assert on the batched call; ``UsageService.track_event``
itself is unit-tested separately in
``tests/unit/services/test_usage_service_batch.py`` and stays the
single-row entry point for non-batch callers (job/storage/sandbox
metering).
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.observability.telemetry_collector import TelemetryCollector, TelemetryEvent


def _make_event(
    *,
    event_type: str = "openai.chat_completion",
    metrics: dict | None = None,
    payload: dict | None = None,
    tenant_id: str = "org_test",
    event_id: str = "evt_1",
) -> TelemetryEvent:
    return TelemetryEvent(
        event_id=event_id,
        tenant_id=tenant_id,
        project_id="default",
        trace_id="trace_1",
        realm="production",
        event_type=event_type,
        timestamp="2026-07-08T12:00:00+00:00",
        metrics=metrics or {},
        payload=payload or {},
        source_format="openai",
    )


def _collector() -> TelemetryCollector:
    collector = TelemetryCollector.__new__(TelemetryCollector)
    collector._dedup_cache = {}
    collector._dedup_max_size = 1000
    collector._tenant_event_counts = {"org_test": 0}
    collector.MAX_EVENTS_PER_TENANT = 1000
    return collector


def _mock_usage_service() -> tuple[MagicMock, AsyncMock]:
    mock_batch = AsyncMock(return_value=1)
    mock_service = MagicMock()
    mock_service.track_events_batch = mock_batch
    # Any accidental single-row call must be visible as a bug, not a
    # silent pass — the batch path must never fall back to it.
    mock_service.track_event = AsyncMock(
        side_effect=AssertionError(
            "track_event must not be called from the batch billing path"
        )
    )
    return mock_service, mock_batch


@pytest.mark.asyncio
async def test_emits_billing_for_llm_completion_with_tokens():
    """A normal openai.chat_completion event with input/output
    tokens MUST trigger exactly one ``track_events_batch`` call
    carrying exactly one entry."""
    collector = _collector()
    mock_service, mock_batch = _mock_usage_service()

    with patch(
        "eden.services.usage_service.UsageService",
        return_value=mock_service,
        create=True,
    ):
        event = _make_event(
            metrics={"input_tokens": 100, "output_tokens": 50},
            payload={"model": "gpt-4o", "model_normalized": "gpt-4o"},
        )
        await collector._emit_billing_events([event])

    mock_batch.assert_awaited_once()
    (batch,) = mock_batch.await_args.args
    assert len(batch) == 1
    entry = batch[0]
    assert entry["org_id"] == "org_test"
    assert entry["event_type"] == "llm_call"
    assert entry["resource"] == "gpt-4o"
    assert entry["quantity"] == 150  # 100 + 50
    assert entry["unit"] == "tokens"
    # Collector stamps cost from the seed pricing catalog when the SDK
    # omitted it (server-side pricing lookup).
    assert entry["cost_usd"] == 0.00075
    md = entry["metadata"]
    assert md["input_tokens"] == 100
    assert md["output_tokens"] == 50


@pytest.mark.asyncio
async def test_emits_billing_includes_cache_tokens():
    """Cache read + cache creation tokens roll up into the same
    usage_events row so the pricing lookup can apply cache-discount
    rates instead of full-price input rates."""
    collector = _collector()
    mock_service, mock_batch = _mock_usage_service()

    with patch(
        "eden.services.usage_service.UsageService",
        return_value=mock_service,
        create=True,
    ):
        event = _make_event(
            event_type="anthropic.message",
            metrics={
                "input_tokens": 10,
                "output_tokens": 20,
                "cache_read_tokens": 100,
                "cache_creation_tokens": 50,
            },
            payload={"model_normalized": "claude-3-5-sonnet"},
        )
        await collector._emit_billing_events([event])

    mock_batch.assert_awaited_once()
    (batch,) = mock_batch.await_args.args
    md = batch[0]["metadata"]
    assert md["input_tokens"] == 10
    assert md["output_tokens"] == 20
    assert md["cache_read_tokens"] == 100
    assert md["cache_creation_tokens"] == 50
    assert batch[0]["quantity"] == 180


@pytest.mark.asyncio
async def test_no_billing_for_event_without_tokens():
    """A LLM event with no token counts (e.g. error before usage
    was populated) MUST NOT trigger a zero-cost usage_events row."""
    collector = _collector()
    mock_service, mock_batch = _mock_usage_service()

    with patch(
        "eden.services.usage_service.UsageService",
        return_value=mock_service,
        create=True,
    ):
        event = _make_event(
            event_type="openai.chat_completion",
            metrics={},  # provider did not populate usage
        )
        await collector._emit_billing_events([event])

    mock_batch.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_billing_for_non_llm_event_types():
    """Span starts, agent runs, tool calls — none of these are
    LLM calls; they must not be billed here."""
    collector = _collector()
    mock_service, mock_batch = _mock_usage_service()

    with patch(
        "eden.services.usage_service.UsageService",
        return_value=mock_service,
        create=True,
    ):
        event = _make_event(
            event_type="agent.run",
            metrics={"input_tokens": 100, "output_tokens": 50},  # bogus
        )
        await collector._emit_billing_events([event])

    mock_batch.assert_not_awaited()


@pytest.mark.asyncio
async def test_uses_model_normalized_when_present():
    """Pricing must look up the normalized alias, not the dated
    raw model name."""
    collector = _collector()
    mock_service, mock_batch = _mock_usage_service()

    with patch(
        "eden.services.usage_service.UsageService",
        return_value=mock_service,
        create=True,
    ):
        event = _make_event(
            metrics={"input_tokens": 1, "output_tokens": 1},
            payload={
                "model": "gpt-4o-2024-08-06",
                "model_normalized": "gpt-4o",
            },
        )
        await collector._emit_billing_events([event])

    (batch,) = mock_batch.await_args.args
    assert batch[0]["resource"] == "gpt-4o"
    assert batch[0]["model"] == "gpt-4o"


@pytest.mark.asyncio
async def test_multiple_billable_events_share_one_batch_call():
    """N billable events in one ingest batch MUST produce exactly one
    ``track_events_batch`` call carrying all N entries — the whole point
    of Phase 3's batching (was N ``track_event`` calls)."""
    collector = _collector()
    mock_service, mock_batch = _mock_usage_service()

    with patch(
        "eden.services.usage_service.UsageService",
        return_value=mock_service,
        create=True,
    ):
        events = [
            _make_event(
                event_id=f"evt_{i}",
                metrics={"input_tokens": 10, "output_tokens": 5},
                payload={"model_normalized": "gpt-4o"},
            )
            for i in range(5)
        ]
        await collector._emit_billing_events(events)

    mock_batch.assert_awaited_once()
    (batch,) = mock_batch.await_args.args
    assert len(batch) == 5
    assert {entry["metadata"]["event_id"] for entry in batch} == {
        f"evt_{i}" for i in range(5)
    }


@pytest.mark.asyncio
async def test_billing_swallows_usage_service_import_error():
    """If usage_service can't be imported (test env, plugin off,
    etc.) the collector MUST NOT break ingest."""
    collector = _collector()
    event = _make_event(
        metrics={"input_tokens": 1, "output_tokens": 1},
        payload={"model_normalized": "gpt-4o"},
    )
    # Simulate the import failing inside _emit_billing_events.
    with patch.dict("sys.modules", {"eden.services.usage_service": None}):
        # No exception expected:
        await collector._emit_billing_events([event])


@pytest.mark.asyncio
async def test_billing_swallows_batch_write_failure():
    """A failed ``track_events_batch`` call must not raise out of
    ``_emit_billing_events`` — billing is best-effort and must never
    take down ingest."""
    collector = _collector()
    mock_service = MagicMock()
    mock_service.track_events_batch = AsyncMock(side_effect=RuntimeError("db down"))

    with patch(
        "eden.services.usage_service.UsageService",
        return_value=mock_service,
        create=True,
    ):
        event = _make_event(
            metrics={"input_tokens": 1, "output_tokens": 1},
            payload={"model_normalized": "gpt-4o"},
        )
        # No exception expected:
        await collector._emit_billing_events([event])
