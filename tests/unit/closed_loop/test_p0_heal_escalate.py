"""M10 (D1, §5.1) — P0 heal-with-parallel-escalate.

StatGate P0 + a mapped ``_HEALABLE`` heal + N22 ``allow`` must decide
``heal_and_escalate``: the heal executes AND the human is paged, but the
escalation must NOT apply the ESCALATED_HUMAN status transition (which
would park the issue in ``escalated`` and block HEAL_EXECUTED's
fix_pending→verifying). P0 without a mapped heal, or a deny /
require_approval verdict, stays a plain ``human`` escalation.
"""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.autonomy_policy import AutonomousMaintenancePolicy
from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

ORG = "org_p0"
ISSUE = "issue-p0-1"

TRIAGE_P0_ROLLBACK: dict[str, Any] = {
    "root_cause": "StatGate P0 rail",
    "source": "statgate",
    "auto_escalate": True,
    "p0_checks": ["statgate_p0"],
    "suggested_heal": "rollback",
    "suggested_actions": [{"action_type": "rollback"}],
}

# NOTE: ``statgate_p0`` p0_checks are router-mapped to rollback (D3
# playbooks), so a genuinely unmapped P0 needs a check/kind the router
# does not know.
TRIAGE_P0_NO_HEAL: dict[str, Any] = {
    "root_cause": "unknown blast",
    "source": "statgate",
    "auto_escalate": True,
    "p0_checks": ["custom_unmapped_rail"],
    "suggested_actions": [],
}


def _event(triage: dict[str, Any]) -> LoopEvent:
    return LoopEvent(
        type=EventType.TRIAGE_COMPLETED,
        org_id=ORG,
        issue_id=ISSUE,
        ref="fp-p0",
        payload={"triage_result": triage, "severity": "p0"},
    )


def _allow_policy() -> AutonomousMaintenancePolicy:
    return AutonomousMaintenancePolicy(
        org_id=ORG, maintenance_mode="assisted", auto_runtime_heal=True
    )


def _deny_policy() -> AutonomousMaintenancePolicy:
    return AutonomousMaintenancePolicy(
        org_id=ORG, maintenance_mode="assisted", auto_runtime_heal=False
    )


class _Ctx:
    """Drive ``_on_triage_completed`` with everything captured."""

    def __init__(self) -> None:
        self.published: list[LoopEvent] = []
        self.transitions: list[str] = []
        self.audits: list[dict[str, Any]] = []
        self.healer = MagicMock()
        self.healer.heal_from_issue = AsyncMock(
            return_value={
                "data": {"status": "executed", "action_type": "rollback"}
            }
        )


async def _drive(
    triage: dict[str, Any],
    policy: AutonomousMaintenancePolicy,
    *,
    heal_result: dict[str, Any] | None = None,
) -> _Ctx:
    ctx = _Ctx()
    if heal_result is not None:
        ctx.healer.heal_from_issue = AsyncMock(return_value=heal_result)

    async def _capture_publish(event: LoopEvent, redis: Any = None) -> Any:
        ctx.published.append(event)

    async def _capture_transition(
        org_id: str, issue_id: str, *, event_type: str, **kw: Any
    ) -> str | None:
        ctx.transitions.append(event_type)
        return "moved"

    async def _capture_audit(
        org_id: str, *, agent_id: Any, action: str, tier: str,
        decision: str, reason: str = "",
    ) -> None:
        ctx.audits.append(
            {"action": action, "decision": decision, "reason": reason}
        )

    orch = ClosedLoopOrchestrator()
    with patch(
        "eden.closed_loop.orchestrator.publish", new=_capture_publish
    ), patch(
        "eden.closed_loop.orchestrator.apply_transition",
        new=_capture_transition,
    ), patch(
        "eden.closed_loop.autonomy_policy.resolve",
        new=AsyncMock(return_value=policy),
    ), patch(
        "eden.closed_loop.autonomy_policy.audit", new=_capture_audit
    ), patch(
        "eden.closed_loop.autonomy_policy.evaluate_mode",
        new=AsyncMock(return_value=policy.maintenance_mode),
    ), patch(
        "eden.llmops.feature_kills.is_autonomy_action_enabled",
        new=AsyncMock(return_value=True),
    ), patch(
        "eden.autonomous.investigation.SelfHealer",
        return_value=ctx.healer,
    ), patch.object(
        ClosedLoopOrchestrator, "_maybe_alert", new=AsyncMock()
    ):
        await orch._on_triage_completed(_event(triage))
    return ctx


# ── decision routing ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_p0_mapped_heal_allow_decides_heal_and_escalate() -> None:
    orch = ClosedLoopOrchestrator()
    with patch(
        "eden.closed_loop.autonomy_policy.resolve",
        new=AsyncMock(return_value=_allow_policy()),
    ), patch(
        "eden.closed_loop.autonomy_policy.audit", new=AsyncMock()
    ), patch(
        "eden.closed_loop.autonomy_policy.evaluate_mode",
        new=AsyncMock(return_value="assisted"),
    ):
        decision = await orch._decide_remediation(
            _event(TRIAGE_P0_ROLLBACK), dict(TRIAGE_P0_ROLLBACK)
        )
    assert decision == "heal_and_escalate"


@pytest.mark.asyncio
async def test_p0_without_mapped_heal_stays_human() -> None:
    orch = ClosedLoopOrchestrator()
    with patch(
        "eden.closed_loop.autonomy_policy.resolve",
        new=AsyncMock(return_value=_allow_policy()),
    ), patch(
        "eden.closed_loop.autonomy_policy.audit", new=AsyncMock()
    ), patch(
        "eden.closed_loop.autonomy_policy.evaluate_mode",
        new=AsyncMock(return_value="assisted"),
    ), patch(
        "eden.issues.repo.IssuesRepo"
    ) as repo_cls:
        repo_cls.return_value.get_issue = AsyncMock(return_value=None)
        decision = await orch._decide_remediation(
            _event(TRIAGE_P0_NO_HEAL), dict(TRIAGE_P0_NO_HEAL)
        )
    assert decision == "human"


@pytest.mark.asyncio
@pytest.mark.parametrize("verdict", ["deny", "require_approval"])
async def test_p0_non_allow_verdict_stays_human(verdict: str) -> None:
    orch = ClosedLoopOrchestrator()
    with patch.object(
        ClosedLoopOrchestrator,
        "_decide_action_recorded",
        new=AsyncMock(return_value=(verdict, "dec-x", time.time())),
    ), patch.object(
        ClosedLoopOrchestrator, "_gate", new=AsyncMock(return_value="assisted")
    ):
        decision = await orch._decide_remediation(
            _event(TRIAGE_P0_ROLLBACK), dict(TRIAGE_P0_ROLLBACK)
        )
    assert decision == "human"


# ── heal_and_escalate end-to-end (mocked executors) ─────────────────


@pytest.mark.asyncio
async def test_heal_and_escalate_runs_both_without_status_regression() -> None:
    ctx = await _drive(TRIAGE_P0_ROLLBACK, _allow_policy())

    # Heal executed → HEAL_EXECUTED emitted, HEAL_REQUESTED transition ran.
    assert any(e.type == EventType.HEAL_EXECUTED for e in ctx.published)
    assert EventType.HEAL_REQUESTED in ctx.transitions

    # Human paged: ESCALATED_HUMAN *event* with the auto-mitigated note…
    escalated = [
        e for e in ctx.published if e.type == EventType.ESCALATED_HUMAN
    ]
    assert escalated, "the human must still be paged"
    payload = escalated[0].payload
    assert payload.get("reason") == "p0_auto_mitigated"
    triage = payload.get("triage_result") or {}
    assert triage.get("auto_mitigated") is True
    assert triage.get("heal_action") == "rollback"
    assert "verify pending" in str(triage.get("reason") or "")

    # …but NO ESCALATED_HUMAN status transition: the issue stays on the
    # heal→verify lifecycle (fix_pending→verifying must not be blocked).
    assert EventType.ESCALATED_HUMAN not in ctx.transitions


@pytest.mark.asyncio
async def test_heal_and_escalate_single_decision_audit() -> None:
    ctx = await _drive(TRIAGE_P0_ROLLBACK, _allow_policy())
    rollback_decides = [
        a for a in ctx.audits
        if a["action"] == "rollback" and a["decision"] == "allow"
    ]
    # One decision, one audit row (§5.4): _decide_remediation decides,
    # _request_heal reuses the stashed record instead of re-deciding.
    assert len(rollback_decides) == 1, ctx.audits
    assert "decision_id=" in rollback_decides[0]["reason"]
    # The heal decision id threads into the executor call.
    call = ctx.healer.heal_from_issue.await_args
    assert call.kwargs.get("decision_id"), call
    assert f"decision_id={call.kwargs['decision_id']}" in (
        rollback_decides[0]["reason"]
    )


@pytest.mark.asyncio
async def test_p0_deny_policy_escalates_with_status() -> None:
    ctx = await _drive(TRIAGE_P0_ROLLBACK, _deny_policy())

    ctx.healer.heal_from_issue.assert_not_awaited()
    assert not any(e.type == EventType.HEAL_EXECUTED for e in ctx.published)
    # Plain human escalation: event AND status transition.
    assert any(e.type == EventType.ESCALATED_HUMAN for e in ctx.published)
    assert EventType.ESCALATED_HUMAN in ctx.transitions
    # The deny is audited.
    assert any(
        a["action"] == "rollback" and a["decision"] == "deny"
        for a in ctx.audits
    )


@pytest.mark.asyncio
async def test_heal_failure_escalates_once_with_failure_reason() -> None:
    ctx = await _drive(
        TRIAGE_P0_ROLLBACK,
        _allow_policy(),
        heal_result={
            "data": {"status": "failed", "failure_reason": "no_active_canary"}
        },
    )

    assert any(e.type == EventType.HEAL_FAILED for e in ctx.published)
    escalated = [
        e for e in ctx.published if e.type == EventType.ESCALATED_HUMAN
    ]
    # Exactly one page — _heal_failed escalated; heal_and_escalate must
    # not send a second "auto-mitigated" page for a heal that failed.
    assert len(escalated) == 1, escalated
    assert escalated[0].payload.get("reason") == "no_active_canary"
