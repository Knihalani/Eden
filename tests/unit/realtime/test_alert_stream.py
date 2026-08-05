"""Tests for AlertStreamProcessor.process_event/process_batch (FEAT-14/15).

Prior to this change, alert_stream.py had zero test coverage even though
it is the only place that evaluates alert rules — including the P0
``rule_sandbox_escape`` rule that fires on ``sandbox.security_alert``
events (FEAT-15's new producer).
"""

from __future__ import annotations

import pytest

from eden.realtime.alert_stream import (
    AlertSeverity,
    AlertStreamProcessor,
)


def _sandbox_escape_event(
    entity_id: str = "job-123",
    tenant_id: str = "org-1",
    message: str = "Sandbox path-escape attempt rejected: path traversal rejected: '../x'",
) -> dict:
    """Matches the payload shape published by
    ``eden.sandbox.runner._emit_sandbox_escape_alert`` /
    ``eden.realtime.kafka_consumer.publish_alert_event``."""
    return {
        "event_type": "sandbox.security_alert",
        "entity_id": entity_id,
        "tenant_id": tenant_id,
        "timestamp": "2026-08-05T00:00:00+00:00",
        "payload": {
            "severity": "critical",
            "message": message,
            "reason": "path_traversal",
            "workdir": "/tmp/eden-sandbox-abc123",
            "command": ["pytest", "-q"],
        },
    }


class TestSandboxEscapeRule:
    @pytest.mark.asyncio
    async def test_process_event_fires_rule_sandbox_escape(self) -> None:
        processor = AlertStreamProcessor()
        event = _sandbox_escape_event()

        alerts = await processor.process_event(event)

        assert len(alerts) == 1
        alert = alerts[0]
        assert alert.rule_id == "rule_sandbox_escape"
        assert alert.severity == AlertSeverity.CRITICAL
        assert alert.entity_id == "job-123"
        assert alert.tenant_id == "org-1"
        # P0 rule routes to pagerduty/webhook in addition to in-app/websocket.
        channel_values = {c.value for c in alert.channels}
        assert {"in_app", "websocket", "pagerduty", "webhook"} <= channel_values
        # Message surfaces the payload detail, not just the generic rule description.
        assert "path traversal" in alert.message
        assert alert.context["event_type"] == "sandbox.security_alert"

    @pytest.mark.asyncio
    async def test_process_event_ignores_unrelated_event_type(self) -> None:
        processor = AlertStreamProcessor()
        event = {
            "event_type": "sandbox.info",
            "entity_id": "job-123",
            "tenant_id": "org-1",
            "payload": {},
        }

        alerts = await processor.process_event(event)

        assert alerts == []

    @pytest.mark.asyncio
    async def test_dedup_suppresses_repeat_alert_within_window(self) -> None:
        processor = AlertStreamProcessor()
        event = _sandbox_escape_event()

        first = await processor.process_event(event)
        second = await processor.process_event(event)

        assert len(first) == 1
        assert len(second) == 0  # deduplicated within the 5-minute window

    @pytest.mark.asyncio
    async def test_dedup_is_per_entity(self) -> None:
        processor = AlertStreamProcessor()

        first = await processor.process_event(_sandbox_escape_event(entity_id="job-A"))
        second = await processor.process_event(_sandbox_escape_event(entity_id="job-B"))

        assert len(first) == 1
        assert len(second) == 1


class TestProcessBatch:
    @pytest.mark.asyncio
    async def test_process_batch_evaluates_all_events(self) -> None:
        processor = AlertStreamProcessor()
        events = [
            _sandbox_escape_event(entity_id="job-A"),
            _sandbox_escape_event(entity_id="job-B"),
            {"event_type": "unrelated.event", "entity_id": "x", "payload": {}},
        ]

        alerts = await processor.process_batch(events)

        assert len(alerts) == 2
        assert {a.entity_id for a in alerts} == {"job-A", "job-B"}
        assert all(a.rule_id == "rule_sandbox_escape" for a in alerts)


class TestOtherDefaultRules:
    @pytest.mark.asyncio
    async def test_cost_spike_rule_requires_metric_threshold(self) -> None:
        processor = AlertStreamProcessor()
        below_threshold = {
            "event_type": "metering.cost_report",
            "entity_id": "tenant-1",
            "tenant_id": "tenant-1",
            "payload": {"daily_cost_usd": 5.0},
        }
        above_threshold = {
            "event_type": "metering.cost_report",
            "entity_id": "tenant-2",
            "tenant_id": "tenant-2",
            "payload": {"daily_cost_usd": 250.0},
        }

        below_alerts = await processor.process_event(below_threshold)
        above_alerts = await processor.process_event(above_threshold)

        assert below_alerts == []
        assert len(above_alerts) == 1
        assert above_alerts[0].rule_id == "rule_cost_spike"

    @pytest.mark.asyncio
    async def test_disabled_rule_never_matches(self) -> None:
        processor = AlertStreamProcessor()
        processor.remove_rule("rule_sandbox_escape")

        alerts = await processor.process_event(_sandbox_escape_event())

        assert alerts == []
