"""Chaos — LLM provider outage must fail CLOSED, never auto-approve.

Two LLM chokepoints in the autonomy loop:

1. **Triage** (``TriageAgent.triage``): the ``InvestigationAgent`` call
   raising must yield a triage result with NO auto-executable actions
   and no auto-escalation — the issue stays where a human will see it,
   and its status is never advanced by the outage path.

   Observed (documented, not xfailed — the safety property holds): the
   raise is downgraded to ``source="heuristic"`` with the
   ``_max_confidence`` floor of 0.5, so an LLM outage is
   indistinguishable from a genuine heuristic pass in the payload
   (unlike the timeout path, which honestly stamps
   ``source="timeout"``). Flagged in the chaos report.

2. **Patch critic** (``patch_generator._critic_review``): M4/D13 says
   fail-closed on EVERY path — an outage returns ``passed=False`` /
   ``reason="critic_error"`` so an unreviewed diff can never continue.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest


class FakeIssuesRepo:
    """Just the surface TriageAgent touches. Deliberately has NO
    status-mutation method beyond ``set_triage_result`` — any attempt
    by the outage path to advance the issue would AttributeError."""

    def __init__(self, issue: Any) -> None:
        self.issue = issue
        self.saved: list[dict[str, Any]] = []

    async def get_issue(self, org_id: str, issue_id: str) -> Any:
        return self.issue

    async def list_stumbles(
        self, org_id: str, *, fingerprint: str, limit: int
    ) -> list[dict[str, Any]]:
        return []

    async def set_triage_result(
        self, org_id: str, issue_id: str, result: dict[str, Any]
    ) -> None:
        self.saved.append(result)


class FakeScorer:
    """StatGate stand-in that never auto-escalates (forces the LLM leg)."""

    def score(self, issue_row: dict[str, Any], stumbles: list) -> Any:
        return SimpleNamespace(auto_escalate=False, p0_checks=[])


def _issue() -> Any:
    return SimpleNamespace(
        id="00000000-0000-0000-0000-00000000000d",
        org_id="org-chaos",
        fingerprint="fp-chaos",
        kind="tool_error",
        title="chaos issue",
        status="open",
        severity="p2",
        stumble_count=3,
        user_count=1,
        triage_result=None,
    )


@pytest.mark.asyncio
async def test_triage_llm_outage_yields_no_auto_actions(monkeypatch):
    from eden.issues.triage_agent import TriageAgent

    class _OutageInvestigationAgent:
        async def investigate(self, *args: Any, **kwargs: Any) -> None:
            raise ConnectionError("chaos: LLM provider outage")

    # The lazy `from eden.autonomous import InvestigationAgent` inside
    # triage() resolves to this raising double.
    monkeypatch.setattr(
        "eden.autonomous.InvestigationAgent",
        _OutageInvestigationAgent,
        raising=False,
    )

    repo = FakeIssuesRepo(_issue())
    agent = TriageAgent(repo=repo, scorer=FakeScorer())

    # Infra probes (Redis/PG-backed), not the behavior under test.
    agent._has_active_work = AsyncMock(return_value=False)
    agent._budget_ok = AsyncMock(return_value=True)
    agent._gather_evidence = AsyncMock(
        return_value={"span_ids": [], "linked_files": [], "react_calls": 0}
    )
    debit = AsyncMock()
    agent._debit_budget = debit

    envelope = await agent.triage("org-chaos", str(_issue().id))

    assert envelope["status"] == "ok"
    tr = envelope["data"]["triage_result"]

    # Fail-closed: nothing auto-executable came out of the outage.
    # (The playbook enrichment adds an explicit human-review action:
    # "No playbook match — human triage" — exactly the right landing.)
    assert tr["auto_escalate"] is False
    actions = tr["suggested_actions"]
    _AUTO_EXECUTABLE = {"rollback", "reweight", "cache_bust", "propose_patch"}
    assert all(a.get("type") not in _AUTO_EXECUTABLE for a in actions), actions
    assert all(not a.get("auto") for a in actions), actions
    assert any(a.get("type") == "escalate" for a in actions), (
        "outage should surface a human-review escalation"
    )
    # No LLM was used, so the outage must not be billed as one...
    assert tr["source"] != "llm"
    debit.assert_not_awaited()
    # ...and the outage is labeled honestly as an LLM error (NOT masquerading
    # as a genuine heuristic pass at the 0.5 confidence floor) with zero
    # confidence, so downstream trust logic can see it never reasoned.
    assert tr["source"] == "llm_error"
    assert tr["confidence"] == 0.0

    # The degraded result IS persisted (visible to humans in the
    # cockpit) and the repo was never asked to advance the status.
    assert len(repo.saved) == 1
    assert repo.saved[0]["source"] == tr["source"]


@pytest.mark.asyncio
async def test_patch_critic_outage_fails_closed(monkeypatch):
    from eden.patches.patch_generator import _critic_review

    monkeypatch.setattr(
        "eden.improvement.sweep_budget.try_consume_llm_call", lambda: True
    )
    router = SimpleNamespace(
        aroute=AsyncMock(side_effect=ConnectionError("chaos: LLM gateway down"))
    )

    verdict = await _critic_review(
        router, "--- a/x.py\n+++ b/x.py\n", rca_summary="rca"
    )

    # M4 (D13): outage == not reviewed == fail. The diff cannot ship.
    assert verdict["passed"] is False
    assert verdict["reason"] == "critic_error"
    router.aroute.assert_awaited_once()


@pytest.mark.asyncio
async def test_patch_critic_budget_exhaustion_fails_closed(monkeypatch):
    """Exhausted LLM budget is an outage too — same closed door."""
    from eden.patches.patch_generator import _critic_review

    monkeypatch.setattr(
        "eden.improvement.sweep_budget.try_consume_llm_call", lambda: False
    )
    router = SimpleNamespace(aroute=AsyncMock())  # must never be called

    verdict = await _critic_review(router, "diff", rca_summary="rca")

    assert verdict["passed"] is False
    assert verdict["reason"] == "llm_budget_exhausted"
    router.aroute.assert_not_awaited()
