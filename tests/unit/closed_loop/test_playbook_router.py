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
