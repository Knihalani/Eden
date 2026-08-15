"""Tests for the shared normalizer."""

from datetime import UTC, datetime, timezone

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.normalizer import (
    _coerce_outcome,
    _normalize_timestamp,
    normalize_many,
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


def test_normalize_timestamp_offsetless_iso_string_assumes_utc():
    out = _normalize_timestamp("2026-08-04T10:00:00")
    assert out == "2026-08-04T10:00:00+00:00"


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
    event = await normalize_to_telemetry_event({"event_type": "otel.chat"}, attr)
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
    event = await normalize_to_telemetry_event({"event_type": "x", "realm": "weird"}, attr)
    assert event.realm == "production"


@pytest.mark.asyncio
async def test_normalize_uppercase_realm_lowercased():
    attr = Attribution(tenant_id="org_abc")
    event = await normalize_to_telemetry_event({"event_type": "x", "realm": "PRODUCTION"}, attr)
    assert event.realm == "production"


@pytest.mark.asyncio
async def test_normalize_coerces_outcome():
    attr = Attribution(tenant_id="org_abc")
    event = await normalize_to_telemetry_event({"event_type": "x", "outcome": "ok"}, attr)
    assert event.outcome == "success"


@pytest.mark.asyncio
async def test_normalize_uses_attribution_project_id():
    attr = Attribution(tenant_id="org_abc", project_id="my_project", source_format="otel")
    event = await normalize_to_telemetry_event({"event_type": "x"}, attr)
    assert event.project_id == "my_project"


@pytest.mark.asyncio
async def test_normalize_empty_payload_metrics_attributes():
    attr = Attribution(tenant_id="org_abc")
    event = await normalize_to_telemetry_event(
        {"event_type": "x", "payload": None, "metrics": None, "attributes": None, "tags": None},
        attr,
    )
    assert event.payload == {}
    assert event.metrics == {}
    assert event.attributes == {}
    assert event.tags == []


@pytest.mark.asyncio
async def test_normalize_lifts_outcome_and_error_from_payload():
    attr = Attribution(tenant_id="org_abc", source_format="openai")
    event = await normalize_to_telemetry_event(
        {
            "event_type": "llm_completion",
            "trace_id": "t1",
            "payload": {
                "status": "error",
                "error_message": "boom",
                "error_type": "RuntimeError",
            },
        },
        attr,
    )
    assert event.outcome == "failure"
    assert event.attributes.get("error") == "boom"
    assert event.attributes.get("error_type") == "RuntimeError"


# ── normalize_many (Phase 3: bounded-concurrency batch normalize) ─────


@pytest.mark.asyncio
async def test_normalize_many_empty_list():
    attr = Attribution(tenant_id="org_abc")
    assert await normalize_many([], attr) == []


@pytest.mark.asyncio
async def test_normalize_many_single_item_matches_single_call():
    attr = Attribution(tenant_id="org_abc", source_format="otel")
    raw = {"event_type": "otel.chat", "trace_id": "t1"}
    [batched] = await normalize_many([raw], attr)
    single = await normalize_to_telemetry_event(raw, attr)
    assert batched.trace_id == single.trace_id == "t1"
    assert batched.event_type == single.event_type == "otel.chat"


@pytest.mark.asyncio
async def test_normalize_many_preserves_order():
    attr = Attribution(tenant_id="org_abc", source_format="otel")
    raws = [{"event_type": "x", "trace_id": f"t{i}"} for i in range(30)]
    events = await normalize_many(raws, attr)
    assert [e.trace_id for e in events] == [f"t{i}" for i in range(30)]


@pytest.mark.asyncio
async def test_normalize_many_caps_concurrency():
    """A batch larger than the concurrency cap must never have more than
    the cap in flight at once."""
    import asyncio

    from eden.observability.ingestion import normalizer as normalizer_mod

    in_flight = 0
    max_in_flight = 0
    lock = asyncio.Lock()

    async def _fake_normalize(raw, attribution):
        nonlocal in_flight, max_in_flight
        async with lock:
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
        await asyncio.sleep(0.01)
        async with lock:
            in_flight -= 1
        return await normalize_to_telemetry_event(raw, attribution)

    attr = Attribution(tenant_id="org_abc", source_format="otel")
    raws = [{"event_type": "x", "trace_id": f"t{i}"} for i in range(40)]
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(normalizer_mod, "normalize_to_telemetry_event", _fake_normalize)
        events = await normalize_many(raws, attr)

    assert len(events) == 40
    assert max_in_flight <= normalizer_mod._NORMALIZE_CONCURRENCY


@pytest.mark.asyncio
async def test_normalize_many_propagates_exceptions():
    attr = Attribution(tenant_id="org_abc", source_format="otel")
    raws = [{"event_type": "x", "trace_id": "t0"}, "not_a_dict"]
    with pytest.raises(AttributeError):
        await normalize_many(raws, attr)
