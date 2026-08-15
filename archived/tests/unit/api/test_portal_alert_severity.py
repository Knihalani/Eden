"""FEAT-102: portal alert-rule cards surface real NL severity."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.api.routes import portal as portal_routes


@pytest.mark.asyncio
async def test_list_portal_alert_rules_uses_nl_severity() -> None:
    rules = [
        {
            "id": "r1",
            "name": "Outage",
            "nl_text": "alert on outage",
            "compiled_eql": "SELECT 1",
            "channels": {"email": True},
            "enabled": True,
            "severity": "critical",
        },
        {
            "id": "r2",
            "name": "Warn me",
            "nl_text": "warn",
            "compiled_eql": "SELECT 2",
            "channels": {"in_app": True},
            "enabled": True,
            "severity": "warning",
        },
    ]
    with (
        patch.object(
            portal_routes,
            "_eql_alert_severity_by_name",
            AsyncMock(return_value={}),
        ),
        patch(
            "eden.alerts.repo.list_nl_rules",
            AsyncMock(return_value=rules),
        ),
    ):
        cards = await portal_routes.list_portal_alert_rules(
            org_id="org-1",
            _user={"user_id": "u1"},
        )

    assert [c.severity for c in cards] == ["critical", "warn"]
    # FEAT-103: Condition prefers nl_text; compiled EQL is secondary.
    assert cards[0].condition == "alert on outage"
    assert cards[0].compiledEql == "SELECT 1"
    assert cards[1].condition == "warn"
    assert cards[1].compiledEql == "SELECT 2"


@pytest.mark.asyncio
async def test_list_portal_alert_rules_condition_prefers_nl_text() -> None:
    """FEAT-103: Inbox Condition field must not prefer raw compiled EQL."""
    rules = [
        {
            "id": "r1",
            "name": "Outage",
            "nl_text": "alert me when outage rate spikes",
            "compiled_eql": "SELECT * FROM traces WHERE outage = true",
            "channels": {"email": True},
            "enabled": True,
            "severity": "critical",
        },
        {
            "id": "r2",
            "name": "EQL-only",
            "nl_text": "",
            "compiled_eql": "SELECT 2",
            "channels": {"email": True},
            "enabled": True,
            "severity": "warning",
        },
    ]
    with (
        patch.object(
            portal_routes,
            "_eql_alert_severity_by_name",
            AsyncMock(return_value={}),
        ),
        patch(
            "eden.alerts.repo.list_nl_rules",
            AsyncMock(return_value=rules),
        ),
    ):
        cards = await portal_routes.list_portal_alert_rules(
            org_id="org-1",
            _user={"user_id": "u1"},
        )

    assert cards[0].condition == "alert me when outage rate spikes"
    assert cards[0].compiledEql == "SELECT * FROM traces WHERE outage = true"
    # No NL text → fall back to compiled EQL for Condition.
    assert cards[1].condition == "SELECT 2"
    assert cards[1].compiledEql == "SELECT 2"


@pytest.mark.asyncio
async def test_list_portal_alert_rules_falls_back_to_eql_severity() -> None:
    rules = [
        {
            "id": "r1",
            "name": "Legacy",
            "nl_text": "old rule",
            "compiled_eql": "SELECT 1",
            "channels": {"email": True},
            "enabled": True,
            # Missing NL severity → use bridged EQL row.
            "severity": None,
        },
    ]
    with (
        patch.object(
            portal_routes,
            "_eql_alert_severity_by_name",
            AsyncMock(return_value={"Legacy": "high"}),
        ),
        patch(
            "eden.alerts.repo.list_nl_rules",
            AsyncMock(return_value=rules),
        ),
    ):
        cards = await portal_routes.list_portal_alert_rules(
            org_id="org-1",
            _user={"user_id": "u1"},
        )

    assert len(cards) == 1
    assert cards[0].severity == "error"  # high → portal "error"
