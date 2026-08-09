"""FEAT-17: critical severity must fire (not be filtered at evaluate time)."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.alerting.types import AlertSeverity
from eden.dsl import alerts as dsl_alerts
from eden.dsl.alerts import _FIREABLE_SEVERITIES


def test_critical_is_fireable_severity() -> None:
    assert AlertSeverity.CRITICAL in _FIREABLE_SEVERITIES
    assert "critical" in _FIREABLE_SEVERITIES


@pytest.mark.asyncio
async def test_critical_rule_is_not_severity_filtered_when_evaluating() -> None:
    rule = {
        "org_id": "org_test",
        "alert_id": "eql_alert_critical_1",
        "severity": "critical",
        "interval_seconds": 3600,
        "eql_query": "SELECT 1",
        "name": "Critical breach",
    }

    with (
        patch.object(
            dsl_alerts,
            "_run_alert_sql",
            new=AsyncMock(return_value=([], "postgres")),
        ),
        patch.object(
            dsl_alerts,
            "_insert_alert_firing",
            new=AsyncMock(),
        ),
        patch.object(
            dsl_alerts,
            "_advance_next_fire",
            new=AsyncMock(),
        ),
    ):
        result = await dsl_alerts._evaluate_rule(rule, force=False)

    assert result.get("reason") != "severity_filtered"
    assert result["severity"] == "critical"
    assert result["status"] == "missed"
