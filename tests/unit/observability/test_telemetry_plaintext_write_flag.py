"""Tests for ``telemetry_plaintext_jsonb_write_enabled`` (Phase 4 storage).

``TelemetryCollector._build_postgres_row`` always populates the eight
``*_zstd`` columns (unconditionally computed by ``compress_many``
upstream). This flag additionally gates the five *nullable* plaintext
JSONB columns that mirror them (request_body, response_body,
reasoning, tool_calls_full, tool_results) — NOT the three NOT NULL
JSONB columns (payload, metrics, attributes), which always need a
non-NULL value regardless of the flag.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest

from eden.observability.telemetry_collector import TelemetryCollector, TelemetryEvent

# Column indices in the tuple returned by _build_postgres_row, matching
# TELEMETRY_INSERT_SQL's column list 1:1.
IDX_PAYLOAD = 14
IDX_METRICS = 15
IDX_ATTRIBUTES = 16
IDX_REQUEST_BODY = 20
IDX_RESPONSE_BODY = 21
IDX_REASONING = 22
IDX_TOOL_CALLS_FULL = 23
IDX_TOOL_RESULTS = 24
IDX_REQUEST_BODY_ZSTD = 38
IDX_RESPONSE_BODY_ZSTD = 39
IDX_REASONING_ZSTD = 40
IDX_TOOL_CALLS_FULL_ZSTD = 41
IDX_TOOL_RESULTS_ZSTD = 42
IDX_PAYLOAD_ZSTD = 43
IDX_METRICS_ZSTD = 44
IDX_ATTRIBUTES_ZSTD = 45

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


def _event() -> TelemetryEvent:
    return TelemetryEvent(
        event_id="evt-1",
        tenant_id="org-1",
        project_id="proj-1",
        trace_id="trace-1",
        realm="environment",
        event_type="llm.completion",
        timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        agent_id="agent-1",
        payload={"foo": "bar"},
        metrics={"input_tokens": 10},
        attributes={"model": "gpt-4o"},
        request_body={"messages": [{"role": "user", "content": "hi"}]},
        response_body={"choices": [{"message": {"role": "assistant", "content": "hey"}}]},
        reasoning={"summary": "thought about it"},
        tool_calls_full=[{"name": "search", "args": {}}],
        tool_results=[{"result": "ok"}],
    )


def _settings(flag: bool) -> MagicMock:
    settings = MagicMock()
    settings.telemetry_plaintext_jsonb_write_enabled = flag
    return settings


class TestPlaintextWriteEnabled:
    def test_default_true_populates_plaintext_columns(self):
        event = _event()
        with patch("eden.config.get_settings", return_value=_settings(True)):
            row = TelemetryCollector._build_postgres_row(event, _DUMMY_COMPRESSED)

        assert json.loads(row[IDX_REQUEST_BODY])["messages"][0]["content"] == "hi"
        assert json.loads(row[IDX_RESPONSE_BODY])["choices"][0]["message"]["content"] == "hey"
        assert json.loads(row[IDX_REASONING])["summary"] == "thought about it"
        assert json.loads(row[IDX_TOOL_CALLS_FULL])[0]["name"] == "search"
        assert json.loads(row[IDX_TOOL_RESULTS])[0]["result"] == "ok"

    def test_zstd_columns_always_populated_regardless_of_flag(self):
        event = _event()
        for flag in (True, False):
            with patch("eden.config.get_settings", return_value=_settings(flag)):
                row = TelemetryCollector._build_postgres_row(event, _DUMMY_COMPRESSED)
            assert row[IDX_REQUEST_BODY_ZSTD] == b"req-zstd"
            assert row[IDX_RESPONSE_BODY_ZSTD] == b"resp-zstd"
            assert row[IDX_REASONING_ZSTD] == b"reasoning-zstd"
            assert row[IDX_TOOL_CALLS_FULL_ZSTD] == b"tool-calls-zstd"
            assert row[IDX_TOOL_RESULTS_ZSTD] == b"tool-results-zstd"
            assert row[IDX_PAYLOAD_ZSTD] == b"payload-zstd"
            assert row[IDX_METRICS_ZSTD] == b"metrics-zstd"
            assert row[IDX_ATTRIBUTES_ZSTD] == b"attrs-zstd"


class TestPlaintextWriteDisabled:
    def test_nullable_blob_columns_become_none(self):
        event = _event()
        with patch("eden.config.get_settings", return_value=_settings(False)):
            row = TelemetryCollector._build_postgres_row(event, _DUMMY_COMPRESSED)

        assert row[IDX_REQUEST_BODY] is None
        assert row[IDX_RESPONSE_BODY] is None
        assert row[IDX_REASONING] is None
        assert row[IDX_TOOL_CALLS_FULL] is None
        assert row[IDX_TOOL_RESULTS] is None

    def test_not_null_columns_still_populated(self):
        """payload/metrics/attributes have a NOT NULL DB constraint and
        a `{}` DEFAULT — they must never become None regardless of the
        flag, or the insert would violate the column constraint."""
        event = _event()
        with patch("eden.config.get_settings", return_value=_settings(False)):
            row = TelemetryCollector._build_postgres_row(event, _DUMMY_COMPRESSED)

        assert row[IDX_PAYLOAD] is not None
        assert json.loads(row[IDX_PAYLOAD]) == {"foo": "bar"}
        assert row[IDX_METRICS] is not None
        assert row[IDX_ATTRIBUTES] is not None

    def test_empty_event_still_gets_not_null_default(self):
        """Even with no payload/metrics/attributes set, the NOT NULL
        columns fall back to the DB default sentinel ('{}'/'[]'),
        independent of the plaintext-write flag."""
        event = TelemetryEvent(
            event_id="evt-2",
            tenant_id="org-1",
            project_id="proj-1",
            trace_id="trace-2",
            realm="environment",
            event_type="llm.completion",
            timestamp=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        )
        with patch("eden.config.get_settings", return_value=_settings(False)):
            row = TelemetryCollector._build_postgres_row(event, _DUMMY_COMPRESSED)
        assert row[IDX_PAYLOAD] == "{}"
        assert row[IDX_METRICS] == "{}"
        assert row[IDX_ATTRIBUTES] == "{}"


class TestSettingsLookupFailsOpen:
    def test_get_settings_exception_defaults_to_dual_write(self):
        """If settings can't be read for any reason, fail open to the
        safe default (dual-write) rather than silently going dark on
        plaintext columns."""
        event = _event()
        with patch("eden.config.get_settings", side_effect=RuntimeError("boom")):
            row = TelemetryCollector._build_postgres_row(event, _DUMMY_COMPRESSED)
        assert row[IDX_REQUEST_BODY] is not None


@pytest.mark.asyncio
async def test_route_postgres_many_respects_flag():
    """Batch path (_route_postgres_many) shares _build_postgres_row, so
    the flag applies uniformly to both write paths."""
    from unittest.mock import AsyncMock

    collector = TelemetryCollector()
    events = [_event()]
    fake_client = MagicMock()
    fake_client.executemany = AsyncMock()

    with (
        patch.object(collector, "_require_postgres", AsyncMock(return_value=fake_client)),
        patch.object(collector, "_dedupe_batch_messages", AsyncMock()),
        patch(
            "eden.storage.compression.compress_many",
            return_value=list(_DUMMY_COMPRESSED),
        ),
        patch("eden.config.get_settings", return_value=_settings(False)),
    ):
        await collector._route_postgres_many(events)

    fake_client.executemany.assert_awaited_once()
    args = fake_client.executemany.await_args.args
    rows = args[1]
    assert rows[0][IDX_REQUEST_BODY] is None
    assert rows[0][IDX_REQUEST_BODY_ZSTD] == b"req-zstd"
