"""Golden-path scenario 2 — deploy regression heal (plan M1, spec §2.2.2).

An org with ``auto_runtime_heal=true`` (autonomy_policies row), an active
canary prompt, and StatGate-P0 stumbles. The loop must decide **heal**
(xfail D1 today — P0 always escalates to a human before the heal branch),
execute the rollback (``data.status == "executed"``), emit HEAL_EXECUTED,
schedule the verify, and resolve the issue with zero human clicks.

Everything downstream of the decision already works — only the decision
itself is the defect, which is why the chain tests drive
``_request_heal`` directly.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.orchestrator import ClosedLoopOrchestrator
from eden.closed_loop.verify import run_due_verifications

from .conftest import AGENT, ORG

ISSUE_ID = "33333333-3333-3333-3333-333333333333"
FINGERPRINT_P0 = "fp-golden-statgate-p0"

#: StatGate-shaped triage result (source=statgate, P0 checks fired,
#: rollback suggested) — the shape TriageAgent's StatGate-first path
#: produces for a deploy regression.
TRIAGE_STATGATE_P0: dict[str, Any] = {
    "root_cause": "StatGate P0 rail",
    "confidence": 0.95,
    "source": "statgate",
    "auto_escalate": True,
    "p0_checks": ["statgate_p0"],
    "suggested_heal": "rollback",
    "suggested_actions": [{"action_type": "rollback", "summary": "roll back canary"}],
    "fingerprint": FINGERPRINT_P0,
}


def _triage_completed_event() -> LoopEvent:
    return LoopEvent(
        type=EventType.TRIAGE_COMPLETED,
        org_id=ORG,
        issue_id=ISSUE_ID,
        ref=FINGERPRINT_P0,
        payload={"triage_result": TRIAGE_STATGATE_P0, "agent_id": AGENT},
    )


def _seed(loop_db) -> None:
    loop_db.seed_issue(
        ISSUE_ID,
        status="triaged",
        severity="p0",
        kind="statgate_p0",
        fingerprint=FINGERPRINT_P0,
        triage_result=TRIAGE_STATGATE_P0,
    )
    loop_db.seed_stumbles(
        5, kind="statgate_p0", fingerprint=FINGERPRINT_P0, detail={}
    )
    loop_db.seed_policy(auto_runtime_heal=True)
    loop_db.seed_canary()


def test_statgate_scores_p0_with_rollback(loop_db) -> None:
    """The deterministic scorer flags P0 + suggests rollback for these
    stumbles — the precondition for the whole scenario."""
    from eden.issues.statgate_scorer import StatGateIncidentScorer

    _seed(loop_db)
    issue = loop_db.issues[ISSUE_ID]
    score = StatGateIncidentScorer().score(
        {
            "id": issue["id"],
            "kind": issue["kind"],
            "severity": issue["severity"],
            "stumble_count": issue["stumble_count"],
        },
        loop_db.stumbles,
    )
    assert score.p0 is True
    assert "statgate_p0" in score.p0_checks
    assert score.suggested_heal == "rollback"


@pytest.mark.asyncio
async def test_policy_row_allows_rollback(loop_db) -> None:
    """auto_runtime_heal=true in the org's autonomy_policies row →
    N22 decide('rollback') == allow (D2 is only about the *default*)."""
    from eden.closed_loop.autonomy_policy import decide, resolve

    _seed(loop_db)
    policy = await resolve(ORG, None)
    verdict, _reason, tier = decide(policy, "rollback")
    assert verdict == "allow"
    assert tier == "auto_runtime_heal"


@pytest.mark.xfail(
    strict=True,
    reason=(
        "D1: StatGate P0 always returns decision 'human' before the heal "
        "branch (orchestrator.py:219) — must become heal(+escalate) when a "
        "reversible heal is mapped and N22 allows it"
    ),
)
@pytest.mark.asyncio
async def test_p0_decision_is_heal(loop_db) -> None:
    """P0 + mapped rollback + allow policy must decide heal, not human."""
    _seed(loop_db)
    orch = ClosedLoopOrchestrator()
    decision = await orch._decide_remediation(
        _triage_completed_event(), dict(TRIAGE_STATGATE_P0)
    )
    assert decision in ("heal", "heal_and_escalate"), decision


@pytest.mark.asyncio
async def test_execute_heal_rollback_executed(loop_db) -> None:
    """SelfHealer.heal_from_issue rolls the active canary back:
    data.status == 'executed', canary marked rolled_back, decision audited."""
    from eden.autonomous.investigation import SelfHealer

    _seed(loop_db)
    result = await SelfHealer().heal_from_issue(ORG, ISSUE_ID)

    data = result.get("data") or {}
    assert data.get("status") == "executed", result
    assert loop_db.canaries["canary-1"]["status"] == "rolled_back"
    executed = [
        h for h in loop_db.heal_actions.values() if h["status"] == "executed"
    ]
    assert executed, "self_heal_actions row must be stamped executed"
    assert any(
        a["action"] == "rollback" and a["decision"] == "allow"
        for a in loop_db.audits
    ), "the rollback decision must be audited"


async def _drive_heal_to_verifying(loop_db, bus, wait_until) -> ClosedLoopOrchestrator:
    """_request_heal → HEAL_EXECUTED → issue verifying + pending verify row."""
    orch = ClosedLoopOrchestrator()
    await orch._request_heal(_triage_completed_event(), dict(TRIAGE_STATGATE_P0))
    wait_until(
        lambda: any(e.type == EventType.HEAL_EXECUTED for e in bus),
        message="HEAL_EXECUTED must be emitted after a successful rollback",
    )
    for event in list(bus):
        if event.type == EventType.HEAL_EXECUTED:
            await orch.on_event(event)
    return orch


@pytest.mark.asyncio
async def test_heal_executed_schedules_verify(loop_db, bus, wait_until) -> None:
    """HEAL_EXECUTED → FIX_PENDING→VERIFYING + verify row scheduled,
    with no human escalation on the way."""
    _seed(loop_db)
    await _drive_heal_to_verifying(loop_db, bus, wait_until)

    assert loop_db.issues[ISSUE_ID]["status"] == "verifying"
    row = loop_db.verifications.get(ISSUE_ID)
    assert row is not None and row["status"] == "pending"
    assert not any(e.type == EventType.ESCALATED_HUMAN for e in bus)


@pytest.mark.asyncio
async def test_heal_verify_resolves_zero_clicks(loop_db, bus, wait_until) -> None:
    """End of scenario 2 (D29 fixed in M3): the verify re-score judges on
    recent evidence, so a healed P0 with a clean quiet window passes →
    issue resolved, zero human clicks."""
    _seed(loop_db)
    orch = await _drive_heal_to_verifying(loop_db, bus, wait_until)

    # Post-heal the world is quiet: no new stumbles in the window.
    loop_db.recent_stumbles_any = 0
    loop_db.stumbles.clear()
    summary: dict[str, int] = {}
    for _ in range(3):
        summary = await run_due_verifications()
        if summary.get("passed") or summary.get("failed"):
            break
    assert summary.get("passed") == 1, summary

    for event in list(bus):
        if event.type == EventType.VERIFY_PASSED:
            await orch.on_event(event)

    assert loop_db.issues[ISSUE_ID]["status"] == "resolved"
    assert not any(e.type == EventType.ESCALATED_HUMAN for e in bus), (
        "the heal chain must not require a human"
    )
