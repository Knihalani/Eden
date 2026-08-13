"""FEAT-44: unified alert routing dispatch and caller wiring."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.alerts.types import AlertSeverity
from eden.alerts.unified import (
    AlertDestination,
    UnifiedAlertRouteRequest,
    UnifiedDestinationKind,
    destinations_from_channels,
    destinations_from_nl_rule_channels,
    dispatch_unified_alert,
    route_request_from_generated_alert,
)
from eden.automations.engine import AutomationsEngine
from eden.realtime.alert_stream import (
    AlertChannel,
    AlertStreamProcessor,
    GeneratedAlert,
)


def _sandbox_escape_event() -> dict:
    return {
        "event_type": "sandbox.security_alert",
        "entity_id": "job-123",
        "tenant_id": "org-1",
        "timestamp": "2026-08-05T00:00:00+00:00",
        "payload": {
            "severity": "critical",
            "message": "path traversal rejected",
        },
    }


class TestUnifiedDispatch:
    @pytest.mark.asyncio
    async def test_email_destination_calls_send_issue_alert_email(self) -> None:
        send_mock = AsyncMock()
        with (
            patch(
                "eden.services.alert_email._org_alert_recipients",
                AsyncMock(return_value=["admin@example.com"]),
            ),
            patch("eden.services.alert_email.send_issue_alert_email", send_mock),
        ):
            result = await dispatch_unified_alert(
                UnifiedAlertRouteRequest(
                    org_id="org-1",
                    title="Test",
                    message="detail",
                    severity=AlertSeverity.HIGH,
                    event_kind="test_event",
                    issue_id="issue-1",
                    destinations=[
                        AlertDestination(kind=UnifiedDestinationKind.EMAIL)
                    ],
                )
            )

        assert result.any_sent is True
        email = result.by_kind(UnifiedDestinationKind.EMAIL)
        assert email is not None
        assert email.status == "sent"
        send_mock.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_email_skipped_without_recipients(self) -> None:
        with patch(
            "eden.services.alert_email._org_alert_recipients",
            AsyncMock(return_value=[]),
        ):
            result = await dispatch_unified_alert(
                UnifiedAlertRouteRequest(
                    org_id="org-1",
                    title="Test",
                    message="detail",
                    destinations=[
                        AlertDestination(kind=UnifiedDestinationKind.EMAIL)
                    ],
                )
            )

        email = result.by_kind(UnifiedDestinationKind.EMAIL)
        assert email is not None
        assert email.status == "skipped"
        assert "recipients" in (email.error or "")

    @pytest.mark.asyncio
    async def test_pagerduty_destination_calls_sender(self) -> None:
        send_mock = AsyncMock()
        with patch(
            "eden.services.pagerduty_delivery.send_pagerduty_event", send_mock
        ):
            result = await dispatch_unified_alert(
                UnifiedAlertRouteRequest(
                    org_id="org-1",
                    title="P0",
                    message="sandbox escape",
                    severity=AlertSeverity.CRITICAL,
                    entity_id="job-1",
                    rule_id="rule_sandbox_escape",
                    destinations=[
                        AlertDestination(kind=UnifiedDestinationKind.PAGERDUTY)
                    ],
                )
            )

        assert result.by_kind(UnifiedDestinationKind.PAGERDUTY).status == "sent"
        send_mock.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_fans_out_to_multiple_destinations(self) -> None:
        with (
            patch(
                "eden.services.alert_email._org_alert_recipients",
                AsyncMock(return_value=["a@b.com"]),
            ),
            patch(
                "eden.services.alert_email.send_issue_alert_email",
                AsyncMock(),
            ),
            patch(
                "eden.services.pagerduty_delivery.send_pagerduty_event",
                AsyncMock(),
            ),
        ):
            result = await dispatch_unified_alert(
                UnifiedAlertRouteRequest(
                    org_id="org-1",
                    title="Multi",
                    message="msg",
                    destinations=[
                        AlertDestination(kind=UnifiedDestinationKind.EMAIL),
                        AlertDestination(kind=UnifiedDestinationKind.PAGERDUTY),
                    ],
                )
            )

        assert len(result.results) == 2
        assert result.any_sent is True


class TestDestinationHelpers:
    def test_destinations_from_channels_maps_alert_channel(self) -> None:
        dests = destinations_from_channels(
            [AlertChannel.EMAIL, AlertChannel.PAGERDUTY]
        )
        assert [d.kind for d in dests] == [
            UnifiedDestinationKind.EMAIL,
            UnifiedDestinationKind.PAGERDUTY,
        ]

    def test_nl_rule_channels_default_email_only(self) -> None:
        dests = destinations_from_nl_rule_channels({})
        assert dests == [AlertDestination(kind=UnifiedDestinationKind.EMAIL)]

    def test_nl_rule_channels_in_app_adds_destination(self) -> None:
        dests = destinations_from_nl_rule_channels({"in_app": True})
        kinds = {d.kind for d in dests}
        assert kinds == {
            UnifiedDestinationKind.EMAIL,
            UnifiedDestinationKind.IN_APP,
        }

    def test_nl_rule_channels_explicit_slack_and_pagerduty(self) -> None:
        dests = destinations_from_nl_rule_channels(
            {"email": False, "slack": True, "pagerduty": True}
        )
        kinds = {d.kind for d in dests}
        assert kinds == {
            UnifiedDestinationKind.SLACK,
            UnifiedDestinationKind.PAGERDUTY,
        }


class TestGeneratedAlertAdapter:
    def test_route_request_from_generated_alert(self) -> None:
        alert = GeneratedAlert(
            alert_id="a-1",
            rule_id="rule_sandbox_escape",
            severity=AlertSeverity.CRITICAL,
            title="Sandbox Security Alert",
            message="escape",
            entity_id="job-1",
            tenant_id="org-1",
            channels=[AlertChannel.EMAIL, AlertChannel.PAGERDUTY],
        )
        req = route_request_from_generated_alert(alert)
        assert req.org_id == "org-1"
        assert req.rule_id == "rule_sandbox_escape"
        assert len(req.destinations) == 2


class TestCallerWiring:
    @pytest.mark.asyncio
    async def test_alert_stream_uses_unified_dispatch(self) -> None:
        dispatch_mock = AsyncMock()
        processor = AlertStreamProcessor()
        with patch(
            "eden.alerts.unified.dispatch_unified_alert", dispatch_mock
        ):
            await processor.process_event(_sandbox_escape_event())

        dispatch_mock.assert_awaited_once()
        request = dispatch_mock.await_args.args[0]
        assert request.rule_id == "rule_sandbox_escape"
        assert request.severity == AlertSeverity.CRITICAL

    @pytest.mark.asyncio
    async def test_automations_alert_action_uses_unified_dispatch(self) -> None:
        from eden.alerts.unified import (
            DestinationDispatchResult,
            UnifiedDispatchResult,
        )

        engine = AutomationsEngine(pg=object())
        dispatch_mock = AsyncMock(
            return_value=UnifiedDispatchResult(
                results=[
                    DestinationDispatchResult(
                        kind=UnifiedDestinationKind.EMAIL,
                        status="sent",
                        detail={"recipient_count": 1},
                    )
                ]
            )
        )
        with patch(
            "eden.alerts.unified.dispatch_unified_alert", dispatch_mock
        ):
            result = await engine._execute_action(
                "org-1",
                "alert",
                {"message": "low score", "severity": "P1"},
                trace_id="t-1",
                score=0.1,
            )

        dispatch_mock.assert_awaited_once()
        request = dispatch_mock.await_args.args[0]
        assert request.event_kind == "automation_triggered"
        assert request.issue_id == "t-1"
        assert result["status"] == "sent"
