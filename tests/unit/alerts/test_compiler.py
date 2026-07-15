"""Unit tests for F81 AlertCompiler."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.alerts.compiler import AlertCompiler, filters_to_nl, rule_to_eql
from eden.alerts.triage_judge import AlertTriageJudge
from eden.services.cat2_intel.signals import CompiledRule, compile_signal


class TestRuleToEql:
    def test_cost_per_call_compiles(self) -> None:
        rule = compile_signal(
            "cost per call above $0.30 in the last hour"
        )
        assert rule.metric == "cost_per_call"
        eql = rule_to_eql(rule)
        assert "any.cost_usd" in eql
        assert "telemetry_events" in eql
        assert "0.3" in eql or "0.30" in eql

    def test_error_rate_compiles(self) -> None:
        rule = compile_signal("error rate above 5% in the last 24 hours")
        eql = rule_to_eql(rule)
        assert "error" in eql.lower()
        assert "0.05" in eql

    def test_filters_to_nl(self) -> None:
        text = filters_to_nl({"outcome": "failure", "agent_id": "support"})
        assert "failure" in text
        assert "support" in text


@pytest.mark.asyncio
async def test_alert_compiler_returns_eql() -> None:
    compiler = AlertCompiler()
    with patch(
        "eden.alerts.compiler.EQLParser.parse",
        AsyncMock(return_value={"status": "ok", "data": {"warnings": []}}),
    ):
        result = await compiler.compile(
            "org_test",
            "cost per call above $0.30 for 15 minutes",
        )
    assert result["eql"]
    assert "telemetry_events" in result["eql"]
    assert result.get("suggested_name")


@pytest.mark.asyncio
async def test_benign_marketing_spike_suppressed() -> None:
    judge = AlertTriageJudge()
    verdict = await judge.judge(
        "org_test",
        alert_event_id="evt_1",
        rule_name="Cost spike",
        nl_text="cost alert",
        payload={"tags": "campaign=summer_sale marketing campaign"},
    )
    assert verdict["verdict"] == "benign"
    assert verdict["confidence"] >= 0.8


@pytest.mark.asyncio
async def test_duplicate_links_open_issue() -> None:
    judge = AlertTriageJudge()
    verdict = await judge.judge(
        "org_test",
        alert_event_id="evt_2",
        rule_name="Tool errors",
        nl_text="tool error rate",
        payload={"issue_id": "issue-abc"},
    )
    assert verdict["verdict"] == "duplicate"
    assert verdict.get("incident_id") == "issue-abc"
