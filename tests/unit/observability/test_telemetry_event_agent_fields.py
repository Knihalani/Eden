"""Tests for FEAT-22: the five OTel/A2A interop columns added by
migrations 058 and 067 (``operation_name``, ``provider_name``,
``error_type``, ``parent_agent_span_id``, ``child_agent_trace_id``).

Regression coverage for the gap where ``TelemetryEvent`` never carried
matching dataclass fields for these DB columns, so nothing was ever
available to serialize into ``TELEMETRY_INSERT_SQL`` — see
docs/specs/strategic-review-2026-08/WAVE-PLAN.md FEAT-22.
"""
from __future__ import annotations

from datetime import UTC, datetime

from eden.observability.telemetry_collector import (
    TELEMETRY_INSERT_SQL,
    TelemetryCollector,
    TelemetryEvent,
)

# Column indices in the tuple returned by _build_postgres_row, matching
# TELEMETRY_INSERT_SQL's column list 1:1. Appended at the end (after
# response_message_hashes), so pre-existing indices are unaffected.
IDX_OPERATION_NAME = 48
IDX_PROVIDER_NAME = 49
IDX_ERROR_TYPE = 50
IDX_PARENT_AGENT_SPAN_ID = 51
IDX_CHILD_AGENT_TRACE_ID = 52

_DUMMY_COMPRESSED = (
    b"req-zstd",
    b"resp-zstd",
    b"reasoning-zstd",
    b"tool-calls-zstd",
    b"tool-results-zstd",
    b"payload-zstd",
    b"metrics-zstd",
    b"attrs-zstd",
)

_NEW_COLUMNS = (
    "operation_name",
    "provider_name",
    "error_type",
    "parent_agent_span_id",
    "child_agent_trace_id",
)


def _event(**overrides) -> TelemetryEvent:
    fields = {
        "event_id": "evt-agent-1",
        "tenant_id": "org-1",
        "project_id": "proj-1",
        "trace_id": "trace-1",
        "realm": "environment",
        "event_type": "span.start",
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "agent_id": "agent-1",
        "operation_name": "chat.completions",
        "provider_name": "anthropic",
        "error_type": "RateLimitError",
        "parent_agent_span_id": "span-parent-1",
        "child_agent_trace_id": "trace-child-1",
    }
    fields.update(overrides)
    return TelemetryEvent(**fields)


class TestAgentInteropFieldsRoundTrip:
    def test_to_dict_includes_all_five_fields(self):
        event = _event()
        as_dict = event.to_dict()
        assert as_dict["operation_name"] == "chat.completions"
        assert as_dict["provider_name"] == "anthropic"
        assert as_dict["error_type"] == "RateLimitError"
        assert as_dict["parent_agent_span_id"] == "span-parent-1"
        assert as_dict["child_agent_trace_id"] == "trace-child-1"

    def test_to_dict_then_from_dict_round_trips(self):
        event = _event()
        rebuilt = TelemetryEvent.from_dict(event.to_dict())
        assert rebuilt.operation_name == event.operation_name
        assert rebuilt.provider_name == event.provider_name
        assert rebuilt.error_type == event.error_type
        assert rebuilt.parent_agent_span_id == event.parent_agent_span_id
        assert rebuilt.child_agent_trace_id == event.child_agent_trace_id

    def test_from_dict_defaults_to_none_when_absent(self):
        event = _event()
        raw = event.to_dict()
        for col in _NEW_COLUMNS:
            raw.pop(col, None)
        rebuilt = TelemetryEvent.from_dict(raw)
        assert rebuilt.operation_name is None
        assert rebuilt.provider_name is None
        assert rebuilt.error_type is None
        assert rebuilt.parent_agent_span_id is None
        assert rebuilt.child_agent_trace_id is None

    def test_dataclass_defaults_are_none(self):
        event = TelemetryEvent(
            event_id="evt-agent-2",
            tenant_id="org-1",
            project_id="proj-1",
            trace_id="trace-2",
            realm="environment",
            event_type="span.start",
            timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        )
        assert event.operation_name is None
        assert event.provider_name is None
        assert event.error_type is None
        assert event.parent_agent_span_id is None
        assert event.child_agent_trace_id is None


class TestInsertSqlHasNewColumns:
    def test_column_list_includes_all_five(self):
        for col in _NEW_COLUMNS:
            assert col in TELEMETRY_INSERT_SQL, f"{col} missing from TELEMETRY_INSERT_SQL"

    def test_placeholder_count_matches_column_count(self):
        # 48 pre-existing columns + 5 new ones = 53 (created_at uses NOW()).
        import re

        columns_block = TELEMETRY_INSERT_SQL.split("VALUES", 1)[0]
        column_names = [
            c.strip()
            for c in columns_block.split("(", 1)[1].rsplit(")", 1)[0].split(",")
            if c.strip()
        ]
        placeholders = re.findall(r"\$\d+", TELEMETRY_INSERT_SQL)
        # created_at is supplied via NOW(), not a placeholder.
        assert len(column_names) == len(placeholders) + 1
        assert placeholders[-1] == "$53"


class TestBuildPostgresRowWritesNewColumns:
    def test_row_carries_agent_interop_values(self):
        event = _event()
        row = TelemetryCollector._build_postgres_row(event, _DUMMY_COMPRESSED)
        assert row[IDX_OPERATION_NAME] == "chat.completions"
        assert row[IDX_PROVIDER_NAME] == "anthropic"
        assert row[IDX_ERROR_TYPE] == "RateLimitError"
        assert row[IDX_PARENT_AGENT_SPAN_ID] == "span-parent-1"
        assert row[IDX_CHILD_AGENT_TRACE_ID] == "trace-child-1"

    def test_row_length_matches_sql_placeholder_count(self):
        event = _event()
        row = TelemetryCollector._build_postgres_row(event, _DUMMY_COMPRESSED)
        # 53 placeholders total ($1..$53); created_at (NOW()) isn't part
        # of the row tuple.
        assert len(row) == 53

    def test_row_defaults_to_none_when_unset(self):
        event = _event(
            operation_name=None,
            provider_name=None,
            error_type=None,
            parent_agent_span_id=None,
            child_agent_trace_id=None,
        )
        row = TelemetryCollector._build_postgres_row(event, _DUMMY_COMPRESSED)
        assert row[IDX_OPERATION_NAME] is None
        assert row[IDX_PROVIDER_NAME] is None
        assert row[IDX_ERROR_TYPE] is None
        assert row[IDX_PARENT_AGENT_SPAN_ID] is None
        assert row[IDX_CHILD_AGENT_TRACE_ID] is None
