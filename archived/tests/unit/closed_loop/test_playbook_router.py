"""D8 — cache-poison autopilot playbook tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.closed_loop.playbook_router import (
    PLAYBOOK_CATEGORIES,
    enrich_triage_with_playbook,
    route_playbook,
)


def test_playbook_has_22_categories() -> None:
    assert len(PLAYBOOK_CATEGORIES) == 22


def test_cache_poison_routes_to_cache_bust() -> None:
    decision = route_playbook(root_cause="semantic cache poison detected")
    assert decision.category == "cache_poison"
    assert decision.action_type == "cache_bust"
    assert decision.auto_heal is True


def test_semantic_cache_drift_playbook() -> None:
    decision = route_playbook(root_cause="cache drift on semantic cache-hit-cascade")
    assert decision.category in ("cache_poison", "semantic_cache_drift")
    assert decision.action_type == "cache_bust"


@pytest.mark.asyncio
async def test_orchestrator_cache_poison_autonomous_heal_path() -> None:
    from eden.closed_loop.events import EventType, LoopEvent
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    triage = enrich_triage_with_playbook(
        {
            "root_cause": "cache_poison — stale response served",
            "suggested_actions": [],
        }
    )
    event = LoopEvent(
        type=EventType.TRIAGE_COMPLETED,
        org_id="org_1",
        issue_id="iss_1",
        ref="fp",
        payload={"agent_id": "agent_a"},
    )

    with (
        patch(
            "eden.closed_loop.autonomy_policy.evaluate_mode",
            AsyncMock(return_value="autonomous"),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.decide",
            return_value=("allow", "ok", "auto_runtime_heal"),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.audit",
            AsyncMock(),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.resolve",
            AsyncMock(),
        ),
    ):
        decision = await orch._decide_remediation(event, triage)

    assert decision == "heal"
    assert triage["playbook"] == "cache_poison"


@pytest.mark.asyncio
async def test_orchestrator_require_approval_patch_still_drafts() -> None:
    """Soft Autonomy Phase 8 (PR-first): in assisted mode a patch verdict
    of ``require_approval`` must still route to ``patch`` — the drafted
    plan landing in Needs-you IS the approval request. Only ``deny``
    blocks the draft."""
    from eden.closed_loop.events import EventType, LoopEvent
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    triage = {
        "root_cause": "null guard missing in checkout loop",
        "suggested_actions": [{"type": "propose_patch", "summary": "add guard"}],
    }
    event = LoopEvent(
        type=EventType.TRIAGE_COMPLETED,
        org_id="org_1",
        issue_id="iss_1",
        ref="fp",
        payload={"agent_id": "agent_a"},
    )

    with (
        patch(
            "eden.closed_loop.autonomy_policy.evaluate_mode",
            AsyncMock(return_value="assisted"),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.decide",
            return_value=("require_approval", "assisted mode requires human approval", "auto_code_patch_pr"),
        ),
        patch("eden.closed_loop.autonomy_policy.audit", AsyncMock()),
        patch("eden.closed_loop.autonomy_policy.resolve", AsyncMock()),
    ):
        decision = await orch._decide_remediation(event, triage)

    assert decision == "patch"


@pytest.mark.asyncio
async def test_orchestrator_require_approval_heal_stays_advisory() -> None:
    """Heals mutate runtime state — ``require_approval`` must NOT
    auto-execute them (unlike side-effect-free patch drafts)."""
    from eden.closed_loop.events import EventType, LoopEvent
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    triage = {
        "root_cause": "cache poison",
        "suggested_actions": [{"type": "cache_bust", "summary": "flush"}],
    }
    event = LoopEvent(
        type=EventType.TRIAGE_COMPLETED,
        org_id="org_1",
        issue_id="iss_1",
        ref="fp",
        payload={"agent_id": "agent_a"},
    )

    with (
        patch(
            "eden.closed_loop.autonomy_policy.evaluate_mode",
            AsyncMock(return_value="assisted"),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.decide",
            return_value=("require_approval", "assisted", "auto_runtime_heal"),
        ),
        patch("eden.closed_loop.autonomy_policy.audit", AsyncMock()),
        patch("eden.closed_loop.autonomy_policy.resolve", AsyncMock()),
    ):
        decision = await orch._decide_remediation(event, triage)

    assert decision == "recommend"
