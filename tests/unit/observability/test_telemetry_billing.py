"""Phase 7.x billing-roll-up: TelemetryCollector must record a
``usage_events`` row for every accepted LLM completion event so the
SDK-reported token counts aggregate into the org's free-tier cap.

The collector's ``_route`` step is mocked so the test exercises only
the new billing hook — no Postgres writes beyond what the mocked
``track_event`` records.
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


@pytest.mark.asyncio
async def test_emits_billing_for_llm_completion_with_tokens():
    """A normal openai.chat_completion event with input/output
    tokens MUST trigger exactly one ``track_event`` call."""
    collector = TelemetryCollector.__new__(TelemetryCollector)
    collector._dedup_cache = {}
    collector._dedup_max_size = 1000
    collector._tenant_event_counts = {"org_test": 0}
    collector.MAX_EVENTS_PER_TENANT = 1000

    mock_track = AsyncMock()
    mock_service = MagicMock()
    mock_service.track_event = mock_track

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

    mock_track.assert_awaited_once()
    call_kwargs = mock_track.await_args.kwargs
    assert call_kwargs["org_id"] == "org_test"
    assert call_kwargs["event_type"] == "llm_call"
    assert call_kwargs["resource"] == "gpt-4o"
    assert call_kwargs["quantity"] == 150  # 100 + 50
    assert call_kwargs["unit"] == "tokens"
    # Collector stamps cost from the seed pricing catalog when the SDK
    # omitted it (server-side pricing lookup).
    assert call_kwargs["cost_usd"] == 0.00075
    md = call_kwargs["metadata"]
    assert md["input_tokens"] == 100
    assert md["output_tokens"] == 50


@pytest.mark.asyncio
async def test_emits_billing_includes_cache_tokens():
    """Cache read + cache creation tokens roll up into the same
    usage_events row so the pricing lookup can apply cache-discount
    rates instead of full-price input rates."""
    collector = TelemetryCollector.__new__(TelemetryCollector)
    collector._dedup_cache = {}
    collector._dedup_max_size = 1000
    collector._tenant_event_counts = {"org_test": 0}
    collector.MAX_EVENTS_PER_TENANT = 1000

    mock_track = AsyncMock()
    mock_service = MagicMock()
    mock_service.track_event = mock_track

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

    mock_track.assert_awaited_once()
    md = mock_track.await_args.kwargs["metadata"]
    assert md["input_tokens"] == 10
    assert md["output_tokens"] == 20
    assert md["cache_read_tokens"] == 100
    assert md["cache_creation_tokens"] == 50
    assert mock_track.await_args.kwargs["quantity"] == 180


@pytest.mark.asyncio
async def test_no_billing_for_event_without_tokens():
    """A LLM event with no token counts (e.g. error before usage
    was populated) MUST NOT trigger a zero-cost usage_events row."""
    collector = TelemetryCollector.__new__(TelemetryCollector)
    collector._dedup_cache = {}
    collector._dedup_max_size = 1000
    collector._tenant_event_counts = {"org_test": 0}
    collector.MAX_EVENTS_PER_TENANT = 1000

    mock_track = AsyncMock()
    mock_service = MagicMock()
    mock_service.track_event = mock_track

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

    mock_track.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_billing_for_non_llm_event_types():
    """Span starts, agent runs, tool calls — none of these are
    LLM calls; they must not be billed here."""
    collector = TelemetryCollector.__new__(TelemetryCollector)
    collector._dedup_cache = {}
    collector._dedup_max_size = 1000
    collector._tenant_event_counts = {"org_test": 0}
    collector.MAX_EVENTS_PER_TENANT = 1000

    mock_track = AsyncMock()
    mock_service = MagicMock()
    mock_service.track_event = mock_track

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

    mock_track.assert_not_awaited()


@pytest.mark.asyncio
async def test_uses_model_normalized_when_present():
    """Pricing must look up the normalized alias, not the dated
    raw model name."""
    collector = TelemetryCollector.__new__(TelemetryCollector)
    collector._dedup_cache = {}
    collector._dedup_max_size = 1000
    collector._tenant_event_counts = {"org_test": 0}
    collector.MAX_EVENTS_PER_TENANT = 1000

    mock_track = AsyncMock()
    mock_service = MagicMock()
    mock_service.track_event = mock_track

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

    assert mock_track.await_args.kwargs["resource"] == "gpt-4o"
    assert mock_track.await_args.kwargs["model"] == "gpt-4o"


@pytest.mark.asyncio
async def test_billing_swallows_usage_service_import_error():
    """If usage_service can't be imported (test env, plugin off,
    etc.) the collector MUST NOT break ingest."""
    collector = TelemetryCollector.__new__(TelemetryCollector)
    event = _make_event(
        metrics={"input_tokens": 1, "output_tokens": 1},
        payload={"model_normalized": "gpt-4o"},
    )
    # Simulate the import failing inside _emit_billing_events.
    with patch.dict("sys.modules", {"eden.services.usage_service": None}):
        # No exception expected:
        await collector._emit_billing_events([event])
