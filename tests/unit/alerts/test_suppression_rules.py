"""FEAT-134: org suppression rules treat matches as benign."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_org_suppression_rule_marks_benign() -> None:
    from eden.alerts.triage_judge import AlertTriageJudge

    with patch(
        "eden.alerts.repo.list_enabled_suppression_patterns",
        new=AsyncMock(
            return_value=[
                {
                    "pattern": r"tuesday.?batch",
                    "reason": "Known noisy Tuesday job",
                    "window_hours": 24,
                }
            ]
        ),
    ):
        verdict = await AlertTriageJudge().judge(
            "org-1",
            alert_event_id="evt-1",
            rule_name="latency spike",
            nl_text="tuesday batch latency",
            payload={"title": "latency"},
        )

    assert verdict["verdict"] == "benign"
    assert "Tuesday" in verdict["reason"] or "tuesday" in verdict["reason"].lower()
    assert verdict.get("suppression_pattern") == r"tuesday.?batch"


@pytest.mark.asyncio
async def test_org_suppression_miss_falls_through() -> None:
    from eden.alerts.triage_judge import AlertTriageJudge

    with (
        patch(
            "eden.alerts.repo.list_enabled_suppression_patterns",
            new=AsyncMock(return_value=[{"pattern": r"never_matches_xyz", "reason": ""}]),
        ),
        patch.object(
            AlertTriageJudge,
            "_find_duplicate_issue",
            new=AsyncMock(return_value=None),
        ),
    ):
        verdict = await AlertTriageJudge().judge(
            "org-1",
            alert_event_id="evt-2",
            rule_name="sustained 5xx",
            nl_text="error rate breach",
            payload={"title": "5xx"},
        )

    assert verdict["verdict"] == "real_incident"
