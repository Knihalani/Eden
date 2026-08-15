"""FEAT-43: AlertTriageJudge.run_for_event must thread the firing
rule's ``channels`` config through to the paging call, either via an
explicit ``channels=`` kwarg from the caller or (when the caller
doesn't have it in hand) a best-effort lookup via the alert_event's
linked ``rule_id`` -> ``nl_alert_rules.channels``.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_explicit_channels_kwarg_passed_straight_through(
    mock_postgres_client: MagicMock,
) -> None:
    from eden.alerts.triage_judge import AlertTriageJudge

    with patch(
        "eden.services.alert_email.send_nl_incident_email", new=AsyncMock()
    ) as mock_send:
        await AlertTriageJudge().run_for_event(
            "org-1",
            "evt-explicit",
            rule_name="Sustained 5xx breach",
            nl_text="error rate spike",
            channels={"slack": True},
        )

    mock_send.assert_awaited_once()
    assert mock_send.await_args.kwargs["channels"] == {"slack": True}
    # No DB lookup needed when channels are supplied explicitly.
    mock_postgres_client.fetchrow.assert_not_called()


@pytest.mark.asyncio
async def test_channels_auto_resolved_from_linked_rule(
    mock_postgres_client: MagicMock,
) -> None:
    """When the caller omits ``channels`` but the event is linked to a
    real nl_alert_rules row (``alert_events.rule_id``), the rule's
    stored channels are looked up and forwarded automatically."""
    from eden.alerts.triage_judge import AlertTriageJudge

    mock_postgres_client._fetchrow_overrides.append(
        ("FROM alert_events WHERE id", {"rule_id": "rule-1"})
    )
    mock_postgres_client._fetchrow_overrides.append(
        (
            "FROM nl_alert_rules WHERE",
            {
                "id": "rule-1",
                "org_id": "org-1",
                "name": "Sustained 5xx breach",
                "nl_text": "error rate spike",
                "compiled_eql": "SELECT 1",
                "triage_enabled": True,
                "channels": {"slack": True, "email": False},
                "enabled": True,
                "created_by": None,
                "last_fired_at": None,
                "created_at": None,
                "updated_at": None,
            },
        )
    )

    with patch(
        "eden.services.alert_email.send_nl_incident_email", new=AsyncMock()
    ) as mock_send:
        await AlertTriageJudge().run_for_event(
            "org-1",
            "evt-linked",
            rule_name="Sustained 5xx breach",
            nl_text="error rate spike",
        )

    mock_send.assert_awaited_once()
    assert mock_send.await_args.kwargs["channels"] == {
        "slack": True,
        "email": False,
    }


@pytest.mark.asyncio
async def test_no_linked_rule_preserves_email_default(
    mock_postgres_client: MagicMock,
) -> None:
    """No ``channels`` kwarg and no linked rule_id (today's only live
    firing path, per the eql_alert_rules/AlertAsCode watchdog) must
    resolve to ``channels=None`` — i.e. the pre-FEAT-43 email-only
    default, not a broken/empty routing decision."""
    from eden.alerts.triage_judge import AlertTriageJudge

    mock_postgres_client._fetchrow_overrides.append(
        ("FROM alert_events WHERE id", {"rule_id": None})
    )

    with patch(
        "eden.services.alert_email.send_nl_incident_email", new=AsyncMock()
    ) as mock_send:
        await AlertTriageJudge().run_for_event(
            "org-1",
            "evt-unlinked",
            rule_name="Sustained 5xx breach",
            nl_text="error rate spike",
        )

    mock_send.assert_awaited_once()
    assert mock_send.await_args.kwargs["channels"] is None
