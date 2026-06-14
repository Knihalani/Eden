"""Tests for the shared normalizer."""

from datetime import UTC, datetime, timezone

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.normalizer import (
    _coerce_outcome,
    _normalize_timestamp,
    normalize_to_telemetry_event,
)


def test_normalize_timestamp_iso_passthrough():
    s = "2024-01-01T00:00:00+00:00"
    assert _normalize_timestamp(s) == s


def test_normalize_timestamp_iso_with_z():
    s = "2024-01-01T00:00:00Z"
    out = _normalize_timestamp(s)
    assert out.endswith("+00:00")
    assert out.startswith("2024-01-01T00:00:00")


def test_normalize_timestamp_epoch_seconds():
    # 1700000000 = 2023-11-14 22:13:20 UTC
    out = _normalize_timestamp(1700000000)
    assert out.startswith("2023-11-14")


def test_normalize_timestamp_epoch_ms():
    out = _normalize_timestamp(1700000000000)
    assert out.startswith("2023-11-14")


def test_normalize_timestamp_datetime():
    dt = datetime(2024, 6, 1, 12, 0, 0, tzinfo=UTC)
    assert _normalize_timestamp(dt) == "2024-06-01T12:00:00+00:00"


def test_normalize_timestamp_naive_datetime_assumes_utc():
    dt = datetime(2024, 6, 1, 12, 0, 0)
    out = _normalize_timestamp(dt)
    assert out.endswith("+00:00")


def test_normalize_timestamp_none_uses_now():
    out = _normalize_timestamp(None)
    # ISO 8601 with timezone offset.
    assert "T" in out
    assert "+" in out or "Z" in out


def test_normalize_timestamp_invalid_string_uses_now():
    out = _normalize_timestamp("not a date")
    assert "T" in out


def test_coerce_outcome_known_mappings():
    assert _coerce_outcome("ok") == "success"
    assert _coerce_outcome("succeeded") == "success"
    assert _coerce_outcome("completed") == "success"
    assert _coerce_outcome("success") == "success"
    assert _coerce_outcome("fail") == "failure"
    assert _coerce_outcome("failed") == "failure"
    assert _coerce_outcome("error") == "failure"
    assert _coerce_outcome("partial") == "partial"
    assert _coerce_outcome("timeout") == "timeout"
    assert _coerce_outcome("timed_out") == "timeout"
    assert _coerce_outcome("crash") == "crash"
    assert _coerce_outcome("cancelled") == "failure"


def test_coerce_outcome_unknown_passes_through():
    assert _coerce_outcome("custom_status") == "custom_status"


def test_coerce_outcome_none_returns_none():
    assert _coerce_outcome(None) is None


def test_coerce_outcome_case_insensitive():
    assert _coerce_outcome("SUCCESS") == "success"
    assert _coerce_outcome("  Error  ") == "failure"


# ── normalize_to_telemetry_event (end-to-end) ──────────────────────


@pytest.mark.asyncio
async def test_normalize_minimal_raw_dict():
    attr = Attribution(tenant_id="org_abc", source_format="otel")
    event = await normalize_to_telemetry_event(
        {"event_type": "otel.chat"}, attr
    )
    assert event.tenant_id == "org_abc"
    assert event.source_format == "otel"
    assert event.event_type == "otel.chat"
    assert event.realm == "production"
    assert event.event_id.startswith("ing_")
    assert event.trace_id.startswith("trace_")


@pytest.mark.asyncio
async def test_normalize_preserves_explicit_ids():
    attr = Attribution(tenant_id="org_abc", project_id="proj_1", source_format="otel")
    event = await normalize_to_telemetry_event(
        {
            "event_id": "evt_123",
            "trace_id": "trace_abc",
            "event_type": "otel.chat",
            "name": "gpt-4o",
            "duration_ms": 250.0,
            "realm": "environment",
            "outcome": "success",
            "payload": {"x": 1},
            "metrics": {"input_tokens": 100},
            "attributes": {"k": "v"},
            "tags": ["a", "b"],
        },
        attr,
    )
    assert event.event_id == "evt_123"
    assert event.trace_id == "trace_abc"
    assert event.name == "gpt-4o"
    assert event.duration_ms == 250.0
    assert event.realm == "environment"
    assert event.outcome == "success"
    assert event.payload == {"x": 1}
    assert event.metrics == {"input_tokens": 100}
    assert event.attributes == {"k": "v"}
    assert event.tags == ["a", "b"]


@pytest.mark.asyncio
async def test_normalize_invalid_realm_defaults_to_production():
    attr = Attribution(tenant_id="org_abc")
    event = await normalize_to_telemetry_event(
        {"event_type": "x", "realm": "weird"}, attr
    )
    assert event.realm == "production"


@pytest.mark.asyncio
async def test_normalize_uppercase_realm_lowercased():
    attr = Attribution(tenant_id="org_abc")
    event = await normalize_to_telemetry_event(
        {"event_type": "x", "realm": "PRODUCTION"}, attr
    )
    assert event.realm == "production"


@pytest.mark.asyncio
async def test_normalize_coerces_outcome():
    attr = Attribution(tenant_id="org_abc")
    event = await normalize_to_telemetry_event(
        {"event_type": "x", "outcome": "ok"}, attr
    )
    assert event.outcome == "success"


@pytest.mark.asyncio
async def test_normalize_uses_attribution_project_id():
    attr = Attribution(tenant_id="org_abc", project_id="my_project", source_format="otel")
    event = await normalize_to_telemetry_event(
        {"event_type": "x"}, attr
    )
    assert event.project_id == "my_project"


@pytest.mark.asyncio
async def test_normalize_empty_payload_metrics_attributes():
    attr = Attribution(tenant_id="org_abc")
    event = await normalize_to_telemetry_event(
        {"event_type": "x", "payload": None, "metrics": None,
         "attributes": None, "tags": None},
        attr,
    )
    assert event.payload == {}
    assert event.metrics == {}
    assert event.attributes == {}
    assert event.tags == []
