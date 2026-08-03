"""M4 (D8) — nudge/prompt playbooks route to the Improve sweep.

``nudge_shadow`` / ``prompt_canary`` playbooks used to dead-end: not in
``_HEALABLE`` so never healed, never routed anywhere else. Now they
produce decision ``improve:<plan_kind_hint>`` → ``request_sweep(...,
plan_kind_hint=...)``, and the heal-side extractor refuses to hand them
to ``execute_heal`` as unknown action types.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop import orchestrator as orch_mod
from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

ORG = "org-d8"
ISSUE = "issue-d8-1"


def _event(event_type: str = EventType.TRIAGE_COMPLETED) -> LoopEvent:
    return LoopEvent(
        type=event_type,
        org_id=ORG,
        issue_id=ISSUE,
        ref="fp-d8",
        payload={"agent_id": "agent-d8"},
    )


def _orch(monkeypatch: pytest.MonkeyPatch, verdict: str = "require_approval"):
    orch = ClosedLoopOrchestrator()
    monkeypatch.setattr(orch, "_gate", AsyncMock(return_value="assisted"))
    decide = AsyncMock(return_value=verdict)
    monkeypatch.setattr(orch, "_decide_action", decide)
    return orch, decide


# ── decision routing ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_first_action_nudge_shadow_decides_improve(monkeypatch) -> None:
    orch, decide = _orch(monkeypatch)
    decision = await orch._decide_remediation(
        _event(), {"suggested_actions": [{"action_type": "nudge_shadow"}]}
    )
    assert decision == "improve:nudge_promote"
    # The audited N22 action is the T3 tier action, not the raw playbook.
    decide.assert_awaited_once()
    assert decide.await_args.args[1] == "nudge_promote"


@pytest.mark.asyncio
async def test_first_action_prompt_canary_decides_improve(monkeypatch) -> None:
    orch, decide = _orch(monkeypatch)
    decision = await orch._decide_remediation(
        _event(), {"suggested_actions": [{"action_type": "prompt_canary"}]}
    )
    assert decision == "improve:prompt_update"
    assert decide.await_args.args[1] == "prompt_canary"


@pytest.mark.asyncio
async def test_kind_router_nudge_kind_decides_improve(monkeypatch) -> None:
    """A ``loop``-kind issue whose triage suggests nothing healable
    resolves to nudge_shadow via the kind router → improve."""
    orch, _decide = _orch(monkeypatch)
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=MagicMock(kind="loop"))
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        decision = await orch._decide_remediation(
            _event(),
            # enrich fills an "escalate" action for unknown categories —
            # not heal/patch/improve, so the kind router runs.
            {"suggested_actions": [{"action_type": "escalate"}]},
        )
    assert decision == "improve:nudge_promote"


@pytest.mark.asyncio
async def test_n22_deny_keeps_improve_advisory(monkeypatch) -> None:
    orch, _decide = _orch(monkeypatch, verdict="deny")
    decision = await orch._decide_remediation(
        _event(), {"suggested_actions": [{"action_type": "nudge_shadow"}]}
    )
    assert decision == "recommend"


# ── improve decision → request_sweep with the hint ──────────────────


@pytest.mark.asyncio
async def test_improve_decision_requests_sweep_with_hint(monkeypatch) -> None:
    orch = ClosedLoopOrchestrator()
    monkeypatch.setattr(
        orch,
        "_decide_remediation",
        AsyncMock(return_value="improve:nudge_promote"),
    )
    sweep = AsyncMock(return_value={"status": "completed"})
    with patch("eden.improvement.agent.request_sweep", sweep):
        await orch._on_triage_completed(
            _event(),
        )

    sweep.assert_awaited_once()
    assert sweep.await_args.args[0] == ORG
    assert sweep.await_args.kwargs["issue_id"] == ISSUE
    assert sweep.await_args.kwargs["agent_id"] == "agent-d8"
    assert sweep.await_args.kwargs["plan_kind_hint"] == "nudge_promote"


@pytest.mark.asyncio
async def test_request_sweep_signature_threads_hint(monkeypatch) -> None:
    """request_sweep passes the hint into the sweep body (M6 consumes it)."""
    from eden.improvement import agent as agent_mod

    seen: dict[str, Any] = {}

    class _FakeAgent:
        async def sweep(self, org_id: str, **kwargs: Any) -> dict[str, Any]:
            seen.update({"org_id": org_id, **kwargs})
            return {"status": "completed"}

    monkeypatch.setattr(agent_mod, "ImprovementAgent", _FakeAgent)
    await agent_mod.request_sweep(
        ORG, agent_id="a", issue_id=ISSUE, plan_kind_hint="prompt_update"
    )
    assert seen["plan_kind_hint"] == "prompt_update"
    assert seen["issue_id"] == ISSUE


# ── heal-side filter — nudge kinds never reach execute_heal ─────────


@pytest.mark.asyncio
async def test_heal_action_filter_rejects_nudge_playbooks(monkeypatch) -> None:
    from eden.autonomous.investigation import _heal_action_from_triage

    monkeypatch.setattr(
        "eden.closed_loop.playbooks.resolve_playbook",
        lambda _kind, _triage: "nudge_shadow",
    )
    assert _heal_action_from_triage({"suggested_heal": "nudge_shadow"}) is None


@pytest.mark.asyncio
async def test_heal_action_filter_still_accepts_heals(monkeypatch) -> None:
    from eden.autonomous.investigation import _heal_action_from_triage

    monkeypatch.setattr(
        "eden.closed_loop.playbooks.resolve_playbook",
        lambda _kind, _triage: "rollback",
    )
    assert _heal_action_from_triage({}) == "rollback"
