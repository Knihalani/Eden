"""Phase 8 — Wave 9 autonomous SRE unit tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.autonomy_policy import AutonomousMaintenancePolicy, decide
from eden.closed_loop.events import EventType, LoopEvent


@pytest.mark.asyncio
async def test_improvement_agent_enabled_from_org_features() -> None:
    from eden.preview.gates import improvement_agent_enabled

    with patch(
        "eden.preview.gates._load_org_features",
        new=AsyncMock(return_value={"improvement_agent_v1": True}),
    ), patch("eden.config.get_settings") as mock_settings:
        mock_settings.return_value.improvement_agent_v1 = False
        assert await improvement_agent_enabled("org_new") is True


@pytest.mark.asyncio
async def test_improvement_agent_org_kill_switch_when_global_on() -> None:
    from eden.preview.gates import improvement_agent_enabled

    with patch(
        "eden.preview.gates._load_org_features",
        new=AsyncMock(return_value={"improvement_agent_v1": False}),
    ), patch("eden.config.get_settings") as mock_settings:
        mock_settings.return_value.improvement_agent_v1 = True
        assert await improvement_agent_enabled("org_killed") is False


@pytest.mark.asyncio
async def test_slm_hook_parses_llm_json() -> None:
    from eden.evaluation.online.slm_hook import score_with_slm

    llm_json = (
        '{"score": 0.82, "passed": true, "confidence": 0.9, '
        '"rationale": "coherent answer"}'
    )
    with patch(
        "eden.autonomous._common._call_llm",
        new=AsyncMock(return_value=llm_json),
    ), patch(
        "eden.closed_loop.autonomy_policy.record_spend",
        new=AsyncMock(),
    ):
        result = await score_with_slm(
            "org_1",
            trace_id="trace-1",
            span_id="span-1",
            payload={"text": "hello world"},
        )
    assert result is not None
    assert result["judge_tier"] == "slm"
    assert result["score"] == pytest.approx(0.82)
    assert result["passed"] is True


@pytest.mark.asyncio
async def test_closed_loop_executor_denies_without_n22_allow() -> None:
    from eden.llmops.closed_loop_executor import _dispatch_side_effect

    policy = AutonomousMaintenancePolicy(
        org_id="org_test",
        maintenance_mode="observe",
        auto_runtime_heal=True,
    )
    with patch(
        "eden.closed_loop.autonomy_policy.resolve",
        new=AsyncMock(return_value=policy),
    ), patch("eden.closed_loop.autonomy_policy.audit", new=AsyncMock()):
        result = await _dispatch_side_effect(
            "org_test",
            {"action_kind": "cache_bust", "payload": {}},
        )
    assert result["side_effect"] == "denied"


@pytest.mark.asyncio
async def test_orchestrator_heal_blocked_when_n22_denies() -> None:
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    with patch.object(
        ClosedLoopOrchestrator,
        "_decide_action_recorded",
        new=AsyncMock(return_value=("deny", None, 0.0)),
    ), patch(
        "eden.closed_loop.orchestrator.apply_transition",
        new=AsyncMock(),
    ) as at, patch(
        "eden.autonomous.investigation.SelfHealer"
    ) as mock_healer_cls:
        mock_healer_cls.return_value.heal_from_issue = AsyncMock()
        await orch._request_heal(
            LoopEvent(
                type=EventType.TRIAGE_COMPLETED,
                org_id="org_test",
                issue_id="iss-1",
                payload={
                    "triage_result": {
                        "suggested_actions": [{"action_type": "cache_bust"}]
                    }
                },
            ),
            {"suggested_actions": [{"action_type": "cache_bust"}]},
        )
    at.assert_not_awaited()
    mock_healer_cls.return_value.heal_from_issue.assert_not_awaited()


def test_n22_assisted_requires_approval_for_patch() -> None:
    policy = AutonomousMaintenancePolicy(
        org_id="org",
        maintenance_mode="assisted",
        auto_code_patch_pr=True,
    )
    verdict, reason, _tier = decide(policy, "propose_patch")
    assert verdict == "require_approval"
    assert "assisted" in reason


@pytest.mark.asyncio
async def test_flywheel_enqueue_promotion_calls_evidence_gate() -> None:
    from eden.kb.flywheel.coordinator import KBFlywheelCoordinator

    coord = KBFlywheelCoordinator()
    with patch.object(
        coord, "_may_draft", new=AsyncMock(return_value=True)
    ), patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(
            return_value=MagicMock(
                fetchrow=AsyncMock(return_value={"id": "skill-1"})
            )
        ),
    ), patch(
        "eden.promotion.evidence_gate.EvidenceGate.enqueue",
        new=AsyncMock(return_value="cand-1"),
    ) as mock_enqueue:
        await coord._enqueue_promotion({"org_id": "org_1", "id": "iss-1"})
    mock_enqueue.assert_awaited_once_with("org_1", kind="kb_skill", ref_id="skill-1")
