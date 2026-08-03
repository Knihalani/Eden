"""Wave 24 — Autonomy closed loop + N21/N22 harden.

Covers: policy deny blocks heal; allow executes; kill switch fail-closed;
verify records outcome; CostEvent autonomy spend tags; cockpit heal/denial
surfaces.
"""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.autonomy_policy import AutonomousMaintenancePolicy, decide
from eden.closed_loop.events import EventType, LoopEvent
from eden.issues.models import Issue


def _issue(**kw: Any) -> Issue:
    base: dict[str, Any] = {
        "id": "iss-1",
        "org_id": "org_test",
        "fingerprint": "fp-1",
        "kind": "tool_error",
        "title": "search failed",
        "status": "triaged",
        "severity": "p1",
        "triage_result": {
            "suggested_actions": [{"action_type": "cache_bust"}],
        },
    }
    base.update(kw)
    return Issue(**base)


# ── N22 decide ───────────────────────────────────────────────────────


def test_observe_denies_runtime_heal() -> None:
    p = AutonomousMaintenancePolicy(
        org_id="org", maintenance_mode="observe", auto_runtime_heal=True
    )
    assert decide(p, "cache_bust")[0] == "deny"
    assert decide(p, "rollback")[0] == "deny"


def test_assisted_allows_heal() -> None:
    p = AutonomousMaintenancePolicy(
        org_id="org", maintenance_mode="assisted", auto_runtime_heal=True
    )
    assert decide(p, "cache_bust")[0] == "allow"
    assert decide(p, "reweight")[0] == "allow"


# ── Kill switch fail-closed ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_autonomy_action_fail_closed() -> None:
    from eden.llmops.feature_kills import is_autonomy_action_enabled

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        assert await is_autonomy_action_enabled("org", "not_a_real_action") is False


@pytest.mark.asyncio
async def test_kill_switch_disabled_blocks_heal() -> None:
    from eden.llmops.feature_kills import is_autonomy_action_enabled

    client = MagicMock()
    client.fetchrow = AsyncMock(return_value={"enabled": False})
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        assert await is_autonomy_action_enabled("org", "cache_bust") is False


@pytest.mark.asyncio
async def test_heal_precheck_blocks_when_kill_switch_off() -> None:
    from eden.autonomous.investigation import _heal_precheck

    with patch(
        "eden.llmops.feature_kills.is_autonomy_action_enabled",
        new=AsyncMock(return_value=False),
    ):
        blocked = await _heal_precheck("org_test", "cache_bust")
    assert blocked is not None
    assert "kill switch" in blocked.lower()


@pytest.mark.asyncio
async def test_heal_precheck_blocks_when_policy_denies() -> None:
    from eden.autonomous.investigation import _heal_precheck

    policy = AutonomousMaintenancePolicy(
        org_id="org_test", maintenance_mode="observe"
    )
    with patch(
        "eden.llmops.feature_kills.is_autonomy_action_enabled",
        new=AsyncMock(return_value=True),
    ), patch(
        "eden.closed_loop.autonomy_policy.resolve",
        new=AsyncMock(return_value=policy),
    ), patch(
        "eden.closed_loop.autonomy_policy.audit", new=AsyncMock()
    ):
        blocked = await _heal_precheck("org_test", "rollback")
    assert blocked is not None
    assert "observe" in blocked.lower() or "denied" in blocked.lower()


# ── Orchestrator: deny vs allow ──────────────────────────────────────


@pytest.mark.asyncio
async def test_orchestrator_deny_blocks_heal_execute() -> None:
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    with patch.object(
        ClosedLoopOrchestrator,
        "_decide_action_recorded",
        new=AsyncMock(return_value=("deny", "dec-w24-deny", time.time())),
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


@pytest.mark.asyncio
async def test_orchestrator_allow_executes_heal() -> None:
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    healer = MagicMock()
    healer.heal_from_issue = AsyncMock(
        return_value={"data": {"status": "executed", "action_type": "cache_bust"}}
    )
    with patch.object(
        ClosedLoopOrchestrator,
        "_decide_action_recorded",
        new=AsyncMock(return_value=("allow", "dec-w24-allow", time.time())),
    ), patch(
        "eden.llmops.feature_kills.is_autonomy_action_enabled",
        new=AsyncMock(return_value=True),
    ), patch(
        "eden.closed_loop.orchestrator.apply_transition",
        new=AsyncMock(),
    ) as at, patch(
        "eden.autonomous.investigation.SelfHealer", return_value=healer
    ), patch.object(orch, "emit", new=AsyncMock()) as emit:
        await orch._request_heal(
            LoopEvent(
                type=EventType.TRIAGE_COMPLETED,
                org_id="org_test",
                issue_id="iss-1",
                payload={},
            ),
            {"suggested_actions": [{"action_type": "cache_bust"}]},
        )
    at.assert_awaited()
    healer.heal_from_issue.assert_awaited_once()
    call = healer.heal_from_issue.await_args
    assert call.args == ("org_test", "iss-1")
    # M10 (§5.4): the audited decision id threads into the executor.
    assert call.kwargs.get("decision_id") == "dec-w24-allow"
    emit.assert_awaited()
    assert emit.await_args.args[0].type == EventType.HEAL_EXECUTED


@pytest.mark.asyncio
async def test_orchestrator_kill_switch_blocks_even_when_policy_allows() -> None:
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    with patch.object(
        ClosedLoopOrchestrator,
        "_decide_action_recorded",
        new=AsyncMock(return_value=("allow", "dec-w24-kill", time.time())),
    ), patch(
        "eden.llmops.feature_kills.is_autonomy_action_enabled",
        new=AsyncMock(return_value=False),
    ), patch(
        "eden.closed_loop.autonomy_policy.audit", new=AsyncMock()
    ) as audit, patch(
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
                payload={},
            ),
            {"suggested_actions": [{"action_type": "rollback"}]},
        )
    at.assert_not_awaited()
    mock_healer_cls.return_value.heal_from_issue.assert_not_awaited()
    audit.assert_awaited()


# ── Verify records outcome ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_verify_pass_emits_verify_passed() -> None:
    from eden.closed_loop import verify as verify_mod

    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=[
            {
                "id": "v1",
                "org_id": "org_test",
                "issue_id": "iss-1",
                "fingerprint": "fp-1",
                "ref": "fp-1",
                "attempts": 0,
            }
        ]
    )
    client.execute = AsyncMock()

    with patch.object(
        verify_mod, "_pg", new=AsyncMock(return_value=client)
    ), patch.object(
        verify_mod,
        "_verify_issue",
        new=AsyncMock(return_value=(True, {"reason": "quiet"})),
    ), patch.object(
        verify_mod, "_emit", new=AsyncMock()
    ) as emit, patch.object(
        verify_mod, "_complete", new=AsyncMock()
    ) as complete:
        summary = await verify_mod.run_due_verifications(limit=10)

    assert summary["passed"] == 1
    complete.assert_awaited()
    emit.assert_awaited_once()
    assert emit.await_args.args[3] is True  # passed=


@pytest.mark.asyncio
async def test_verify_fail_after_max_attempts() -> None:
    from eden.closed_loop import verify as verify_mod

    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=[
            {
                "id": "v1",
                "org_id": "org_test",
                "issue_id": "iss-1",
                "fingerprint": "fp-1",
                "ref": "fp-1",
                "attempts": 2,  # +1 → 3 == max
            }
        ]
    )
    client.execute = AsyncMock()

    with patch.object(
        verify_mod, "_pg", new=AsyncMock(return_value=client)
    ), patch.object(
        verify_mod,
        "_verify_issue",
        new=AsyncMock(return_value=(False, {"reason": "still P0"})),
    ), patch.object(
        verify_mod, "_cfg", return_value=3
    ), patch.object(
        verify_mod, "_emit", new=AsyncMock()
    ) as emit, patch.object(
        verify_mod, "_complete", new=AsyncMock()
    ) as complete:
        summary = await verify_mod.run_due_verifications(limit=10)

    assert summary["failed"] == 1
    complete.assert_awaited()
    emit.assert_awaited_once()
    assert emit.await_args.args[3] is False


# ── CostEvent autonomy spend tag ─────────────────────────────────────


@pytest.mark.asyncio
async def test_record_spend_tags_cost_event() -> None:
    from eden.closed_loop import autonomy_policy as ap

    recorded: list[Any] = []

    async def _capture(event: Any) -> bool:
        recorded.append(event)
        return True

    redis = MagicMock()
    redis.incrbyfloat = AsyncMock(return_value=1.25)
    redis.expire = AsyncMock()

    class _Pipe:
        def __init__(self) -> None:
            self._ops: list[tuple[str, tuple]] = []

        def incrbyfloat(self, key: str, amount: float) -> "_Pipe":
            self._ops.append(("incrbyfloat", (key, amount)))
            return self

        def expire(self, key: str, ttl: int) -> "_Pipe":
            self._ops.append(("expire", (key, ttl)))
            return self

        async def execute(self) -> list:
            out: list = []
            for op, args in self._ops:
                if op == "incrbyfloat":
                    out.append(await redis.incrbyfloat(args[0], args[1]))
                elif op == "expire":
                    await redis.expire(args[0], args[1])
                    out.append(True)
            return out

    redis.pipeline = MagicMock(return_value=_Pipe())

    with patch.object(ap, "_redis", new=AsyncMock(return_value=redis)), patch(
        "eden.llmops.cost_ledger.record_cost_event", new=_capture
    ):
        total = await ap.record_spend("org_test", 1.25, feature="autonomy")

    assert total == pytest.approx(1.25)
    assert len(recorded) == 1
    assert recorded[0].feature == "autonomy"
    assert recorded[0].org_id == "org_test"
    assert recorded[0].cost_usd == pytest.approx(1.25)


def test_autonomy_in_known_cost_features() -> None:
    from eden.llmops.cost_ledger import KNOWN_FEATURES

    assert "autonomy" in KNOWN_FEATURES


# ── Cockpit heal + denial surfaces ───────────────────────────────────


@pytest.mark.asyncio
async def test_cockpit_surfaces_self_heals() -> None:
    from eden.improvement.cockpit_aggregator import ImprovementCockpitAggregator

    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=[
            {
                "id": "heal-1",
                "action_type": "cache_bust",
                "status": "executed",
                "before_state_json": None,
                "after_state_json": None,
                "created_at": None,
            }
        ]
    )
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        items = await ImprovementCockpitAggregator()._from_self_heals("org_test")
    assert len(items) == 1
    assert items[0].item_type == "auto_heal"
    assert items[0].column == "verify"


@pytest.mark.asyncio
async def test_cockpit_surfaces_policy_denials() -> None:
    from eden.improvement.cockpit_aggregator import ImprovementCockpitAggregator

    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=[
            {
                "id": "aud-1",
                "agent_id": None,
                "action": "rollback",
                "tier_applied": "auto_runtime_heal",
                "decision": "deny",
                "reason": "maintenance_mode=observe",
                "created_at": None,
            }
        ]
    )
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        items = await ImprovementCockpitAggregator()._from_autonomy_denials(
            "org_test", None
        )
    assert len(items) == 1
    assert items[0].item_type == "policy_denial"
    assert items[0].column == "needs_you"
    assert "observe" in (items[0].blocked_reason or "")


# ── learn hook on verify passed ──────────────────────────────────────


@pytest.mark.asyncio
async def test_verify_passed_calls_flywheel_learn() -> None:
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    with patch(
        "eden.closed_loop.orchestrator.apply_transition", new=AsyncMock()
    ), patch.object(
        orch, "_flywheel_on_resolved", new=AsyncMock()
    ) as flywheel:
        await orch._on_verify_passed(
            LoopEvent(
                type=EventType.VERIFY_PASSED,
                org_id="org_test",
                issue_id="iss-1",
                payload={"verify": {"reason": "quiet"}},
            )
        )
    flywheel.assert_awaited_once()
