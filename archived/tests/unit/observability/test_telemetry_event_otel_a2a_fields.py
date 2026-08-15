"""FEAT-22: OTel/A2A interop fields on ``TelemetryEvent`` round-trip.

Migrations 058 and 067 added ``operation_name``, ``provider_name``,
``error_type``, ``parent_agent_span_id``, and ``child_agent_trace_id`` as
columns on the ``telemetry_events`` table, but the dataclass had no matching
fields -- so nothing in the ingestion code path could ever populate them.
This just verifies the dataclass now carries the five fields and that they
survive a ``to_dict()`` / ``from_dict()`` round-trip (the shape used for
Redis hot-path storage and WebSocket fanout).
"""
from __future__ import annotations

from datetime import UTC, datetime

from eden.observability.telemetry_collector import TelemetryEvent

_NEW_FIELDS = (
    "operation_name",
    "provider_name",
    "error_type",
    "parent_agent_span_id",
    "child_agent_trace_id",
)


def _base_event(**overrides: object) -> TelemetryEvent:
    kwargs: dict[str, object] = {
        "event_id": "evt-1",
        "tenant_id": "org-1",
        "project_id": "proj-1",
        "trace_id": "trace-1",
        "realm": "environment",
        "event_type": "span.start",
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
    kwargs.update(overrides)
    return TelemetryEvent(**kwargs)  # type: ignore[arg-type]


def test_new_fields_default_to_none() -> None:
    event = _base_event()
    for field_name in _NEW_FIELDS:
        assert getattr(event, field_name) is None


def test_new_fields_are_settable() -> None:
    event = _base_event(
        operation_name="chat.completions",
        provider_name="anthropic",
        error_type="RateLimitError",
        parent_agent_span_id="span-parent-1",
        child_agent_trace_id="trace-child-1",
    )
    assert event.operation_name == "chat.completions"
    assert event.provider_name == "anthropic"
    assert event.error_type == "RateLimitError"
    assert event.parent_agent_span_id == "span-parent-1"
    assert event.child_agent_trace_id == "trace-child-1"


def test_to_dict_includes_new_fields() -> None:
    event = _base_event(
        operation_name="tool.call",
        provider_name="openai",
        error_type=None,
        parent_agent_span_id="span-parent-2",
        child_agent_trace_id="trace-child-2",
    )
    data = event.to_dict()
    assert data["operation_name"] == "tool.call"
    assert data["provider_name"] == "openai"
    assert data["error_type"] is None
    assert data["parent_agent_span_id"] == "span-parent-2"
    assert data["child_agent_trace_id"] == "trace-child-2"


def test_to_dict_from_dict_round_trips_new_fields() -> None:
    original = _base_event(
        operation_name="llm.completion",
        provider_name="bedrock",
        error_type="Timeout",
        parent_agent_span_id="span-parent-3",
        child_agent_trace_id="trace-child-3",
    )
    restored = TelemetryEvent.from_dict(original.to_dict())
    for field_name in _NEW_FIELDS:
        assert getattr(restored, field_name) == getattr(original, field_name)
    assert restored == original


def test_from_dict_defaults_missing_new_fields_to_none() -> None:
    original = _base_event()
    data = original.to_dict()
    for field_name in _NEW_FIELDS:
        data.pop(field_name, None)
    restored = TelemetryEvent.from_dict(data)
    for field_name in _NEW_FIELDS:
        assert getattr(restored, field_name) is None
