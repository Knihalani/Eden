"""FEAT-43: ``send_nl_incident_email`` must honor ``nl_alert_rules.channels``
instead of unconditionally emailing.

Mirrors the mocking pattern of
``tests/unit/services/test_alert_email_self_obs.py``: only the transport
boundaries (email service, Slack sender, PagerDuty sender) are mocked —
the routing logic in ``send_nl_incident_email`` runs for real.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


def _patched(**overrides):
    """Common patch set: dedupe/recipients always allow-through unless
    a test overrides them."""
    from eden.services import alert_email

    defaults = {
        "_allow_send": AsyncMock(return_value=True),
        "_org_alert_recipients": AsyncMock(return_value=["owner@example.com"]),
    }
    defaults.update(overrides)
    return alert_email, defaults


@pytest.mark.asyncio
async def test_no_channels_configured_defaults_to_email_only():
    """Legacy behaviour: a rule with no messaging channel configured
    (``channels`` unset) still pages via email, and does not touch
    Slack/PagerDuty."""
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(alert_email, "_allow_send", new=AsyncMock(return_value=True)),
        patch.object(
            alert_email,
            "_org_alert_recipients",
            new=AsyncMock(return_value=["owner@example.com"]),
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
        patch(
            "eden.services.slack_notify.notify_nl_incident", new=AsyncMock()
        ) as mock_slack,
    ):
        await alert_email.send_nl_incident_email(
            org_id="org-1",
            alert_event_id="evt-1",
            rule_name="Sustained 5xx breach",
            reason="breach",
            confidence=0.9,
            channels=None,
        )

    svc.send_email.assert_awaited_once()
    mock_slack.assert_not_awaited()


@pytest.mark.asyncio
async def test_in_app_only_channels_default_to_email_only():
    """The storage default (``{"in_app": true}``) isn't a messaging
    channel — it must not suppress the legacy email default."""
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(alert_email, "_allow_send", new=AsyncMock(return_value=True)),
        patch.object(
            alert_email,
            "_org_alert_recipients",
            new=AsyncMock(return_value=["owner@example.com"]),
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
        patch(
            "eden.services.slack_notify.notify_nl_incident", new=AsyncMock()
        ) as mock_slack,
    ):
        await alert_email.send_nl_incident_email(
            org_id="org-1",
            alert_event_id="evt-1",
            rule_name="Sustained 5xx breach",
            channels={"in_app": True},
        )

    svc.send_email.assert_awaited_once()
    mock_slack.assert_not_awaited()


@pytest.mark.asyncio
async def test_slack_only_channel_sends_slack_not_email():
    """A rule configured with only ``channels: {"slack": true}`` must
    page Slack and must NOT send an email — this is the core FEAT-43
    regression: the channel selector must not be cosmetic."""
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(alert_email, "_allow_send", new=AsyncMock(return_value=True)),
        patch.object(
            alert_email,
            "_org_alert_recipients",
            new=AsyncMock(return_value=["owner@example.com"]),
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
        patch(
            "eden.services.slack_notify.notify_nl_incident", new=AsyncMock()
        ) as mock_slack,
    ):
        await alert_email.send_nl_incident_email(
            org_id="org-1",
            alert_event_id="evt-2",
            rule_name="Sustained 5xx breach",
            reason="breach",
            confidence=0.8,
            channels={"slack": True},
        )

    mock_slack.assert_awaited_once()
    call = mock_slack.await_args
    assert call.args[0] == "org-1"
    assert call.kwargs["alert_event_id"] == "evt-2"
    assert call.kwargs["rule_name"] == "Sustained 5xx breach"
    svc.send_email.assert_not_awaited()


@pytest.mark.asyncio
async def test_email_and_slack_both_true_send_both():
    """Channels are independent toggles, not a fallback pair — both
    fire when both are enabled."""
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(alert_email, "_allow_send", new=AsyncMock(return_value=True)),
        patch.object(
            alert_email,
            "_org_alert_recipients",
            new=AsyncMock(return_value=["owner@example.com"]),
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
        patch(
            "eden.services.slack_notify.notify_nl_incident", new=AsyncMock()
        ) as mock_slack,
    ):
        await alert_email.send_nl_incident_email(
            org_id="org-1",
            alert_event_id="evt-3",
            rule_name="Sustained 5xx breach",
            channels={"email": True, "slack": True},
        )

    svc.send_email.assert_awaited_once()
    mock_slack.assert_awaited_once()


@pytest.mark.asyncio
async def test_email_explicitly_false_suppresses_email():
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(alert_email, "_allow_send", new=AsyncMock(return_value=True)),
        patch.object(
            alert_email,
            "_org_alert_recipients",
            new=AsyncMock(return_value=["owner@example.com"]),
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
        patch(
            "eden.services.slack_notify.notify_nl_incident", new=AsyncMock()
        ) as mock_slack,
    ):
        await alert_email.send_nl_incident_email(
            org_id="org-1",
            alert_event_id="evt-4",
            rule_name="Sustained 5xx breach",
            channels={"email": False, "slack": True},
        )

    svc.send_email.assert_not_awaited()
    mock_slack.assert_awaited_once()


@pytest.mark.asyncio
async def test_pagerduty_channel_dispatches_pagerduty():
    pytest.importorskip("eden.services.pagerduty_delivery")
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(alert_email, "_allow_send", new=AsyncMock(return_value=True)),
        patch.object(
            alert_email,
            "_org_alert_recipients",
            new=AsyncMock(return_value=["owner@example.com"]),
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
        patch(
            "eden.services.pagerduty_delivery.send_pagerduty_event", new=AsyncMock()
        ) as mock_pd,
    ):
        await alert_email.send_nl_incident_email(
            org_id="org-1",
            alert_event_id="evt-5",
            rule_name="Sustained 5xx breach",
            confidence=0.95,
            channels={"pagerduty": True},
        )

    mock_pd.assert_awaited_once()
    assert mock_pd.await_args.kwargs["severity"] == "critical"
    svc.send_email.assert_not_awaited()


@pytest.mark.asyncio
async def test_slack_dispatch_failure_does_not_block_email():
    """Each channel send is independently best-effort."""
    from eden.services import alert_email

    svc = AsyncMock()
    with (
        patch.object(alert_email, "_allow_send", new=AsyncMock(return_value=True)),
        patch.object(
            alert_email,
            "_org_alert_recipients",
            new=AsyncMock(return_value=["owner@example.com"]),
        ),
        patch.object(alert_email, "get_email_service", return_value=svc),
        patch(
            "eden.services.slack_notify.notify_nl_incident",
            new=AsyncMock(side_effect=RuntimeError("slack down")),
        ) as mock_slack,
    ):
        await alert_email.send_nl_incident_email(
            org_id="org-1",
            alert_event_id="evt-6",
            rule_name="Sustained 5xx breach",
            channels={"email": True, "slack": True},
        )

    mock_slack.assert_awaited_once()
    svc.send_email.assert_awaited_once()
