"""F30 / N08 — StatGate scorer + TriageAgent (Wave 3)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.issues.models import Issue
from eden.issues.statgate_scorer import StatGateIncidentScorer


def _issue(**over: Any) -> Issue:
    base: dict[str, Any] = {
        "id": "iss-1",
        "org_id": "org_test",
        "fingerprint": "fp1",
        "kind": "tool_error",
        "title": "tool failed",
        "status": "open",
        "severity": "p1",
        "stumble_count": 2,
        "user_count": 1,
    }
    base.update(over)
    return Issue(**base)  # type: ignore[arg-type]


# ── StatGateIncidentScorer ──────────────────────────────────────────


def test_scorer_flags_etec_loop_p0() -> None:
    s = StatGateIncidentScorer().score(
        {"kind": "loop", "severity": "p2", "stumble_count": 2},
        [{"kind": "loop", "detail": {"repeat_count": 5}}],
    )
    assert s.auto_escalate is True
    assert "etec_loop" in s.p0_checks


def test_scorer_flags_statgate_p0_stumble() -> None:
    s = StatGateIncidentScorer().score(
        {"kind": "tool_error", "severity": "p1", "stumble_count": 1},
        [{"kind": "statgate_p0", "detail": {}}],
    )
    assert s.auto_escalate is True
    assert "statgate_p0" in s.p0_checks
    assert s.suggested_heal == "rollback"


def test_scorer_flags_cost_spike() -> None:
    s = StatGateIncidentScorer().score(
        {"kind": "tool_error", "severity": "p2", "stumble_count": 1},
        [{"kind": "tool_error", "detail": {"cost_z_score": 4.1}}],
    )
    assert "cost_spike" in s.p0_checks
    assert s.suggested_heal == "reweight"


def test_scorer_no_p0_for_benign_issue() -> None:
    s = StatGateIncidentScorer().score(
        {"kind": "tool_error", "severity": "p2", "stumble_count": 1},
        [{"kind": "tool_error", "detail": {"error": "boom"}}],
    )
    assert s.auto_escalate is False
    assert s.p0_checks == []


# ── TriageAgent ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_triage_statgate_first_no_llm() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(kind="loop", severity="p1", stumble_count=6)
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "loop", "detail": {"repeat_count": 6}, "span_id": "s1"}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    agent = TriageAgent(repo=repo)
    with patch("eden.autonomous.InvestigationAgent") as inv_cls:
        res = await agent.triage("org_test", "iss-1")
        # StatGate short-circuit → InvestigationAgent never constructed.
        inv_cls.assert_not_called()

    tr = res["data"]["triage_result"]
    assert tr["source"] == "statgate"
    assert tr["auto_escalate"] is True
    repo.set_triage_result.assert_awaited_once()


@pytest.mark.asyncio
async def test_triage_falls_back_to_llm() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(kind="tool_error", severity="p2", stumble_count=1)
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "tool_error", "detail": {"error": "boom"}}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    inv_result = {
        "status": "ok",
        "data": {
            "investigation_id": "inv-1",
            "findings": [{"summary": "API key expired", "confidence": 0.8}],
            "proposed_remediations": [
                {"action": "rotate_key", "summary": "rotate the API key"}
            ],
            "llm_used": True,
        },
    }
    inv_instance = MagicMock()
    inv_instance.investigate = AsyncMock(return_value=inv_result)

    agent = TriageAgent(repo=repo)
    with patch("eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=True)), patch(
        "eden.issues.triage_agent.TriageAgent._debit_budget", AsyncMock()
    ), patch("eden.autonomous.InvestigationAgent", return_value=inv_instance):
        res = await agent.triage("org_test", "iss-1")

    tr = res["data"]["triage_result"]
    assert tr["source"] == "llm"
    assert tr["root_cause"] == "API key expired"
    assert tr["confidence"] == 0.8
    assert tr["suggested_actions"][0]["action_type"] == "rotate_key"
    inv_instance.investigate.assert_awaited_once()
    _a, kwargs = inv_instance.investigate.call_args
    assert kwargs["trigger"] == "issue:iss-1"


@pytest.mark.asyncio
async def test_triage_budget_exceeded_skips_llm() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(kind="tool_error", severity="p2", stumble_count=1)
    )
    repo.list_stumbles = AsyncMock(return_value=[{"kind": "tool_error", "detail": {}}])
    repo.set_triage_result = AsyncMock(return_value=True)

    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=False)
    ), patch("eden.autonomous.InvestigationAgent") as inv_cls:
        res = await agent.triage("org_test", "iss-1")
        inv_cls.assert_not_called()

    assert res["status"] == "budget_exceeded"
    assert res["data"]["triage_result"]["source"] == "budget_exceeded"


@pytest.mark.asyncio
async def test_triage_returns_cached_unless_forced() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(triage_result={"source": "llm", "root_cause": "x"})
    )
    agent = TriageAgent(repo=repo)
    res = await agent.triage("org_test", "iss-1")
    assert res["data"]["cached"] is True


@pytest.mark.asyncio
async def test_triage_not_found() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=None)
    agent = TriageAgent(repo=repo)
    res = await agent.triage("org_test", "missing")
    assert res["status"] == "not_found"
