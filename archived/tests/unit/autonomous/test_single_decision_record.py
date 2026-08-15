"""M10 (§5.4) — single policy decision record.

The orchestrator's audited heal decision (``decision_id``) threads
through ``heal_from_issue`` → ``execute_heal`` → ``_heal_precheck``.
A fresh (≤5 min) id skips the policy re-decide (no duplicate audit
row); the kill switch and the daily rollback cap are ALWAYS checked;
a stale or missing id re-decides as before.
"""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.autonomous import investigation as inv
from eden.closed_loop.autonomy_policy import AutonomousMaintenancePolicy

ORG = "org_sdr"


def _policy(**kw: Any) -> AutonomousMaintenancePolicy:
    return AutonomousMaintenancePolicy(
        org_id=ORG, maintenance_mode="assisted", auto_runtime_heal=True, **kw
    )


def _patches(policy: AutonomousMaintenancePolicy, kill_enabled: bool = True):
    decide = MagicMock(
        return_value=("allow", "assisted mode permits", "auto_runtime_heal")
    )
    audit = AsyncMock()
    return (
        patch(
            "eden.llmops.feature_kills.is_autonomy_action_enabled",
            new=AsyncMock(return_value=kill_enabled),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.resolve",
            new=AsyncMock(return_value=policy),
        ),
        patch("eden.closed_loop.autonomy_policy.decide", new=decide),
        patch("eden.closed_loop.autonomy_policy.audit", new=audit),
        decide,
        audit,
    )


# ── _heal_precheck ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fresh_decision_skips_policy_redecide() -> None:
    p_kill, p_res, p_dec, p_aud, decide, audit = _patches(_policy())
    with p_kill, p_res, p_dec, p_aud:
        blocked = await inv._heal_precheck(
            ORG,
            "cache_bust",
            decision_id="dec-fresh-1",
            decided_at=time.time(),
        )
    assert blocked is None
    decide.assert_not_called()
    audit.assert_not_awaited()  # no second audit row — one decision


@pytest.mark.asyncio
async def test_stale_decision_redecides() -> None:
    p_kill, p_res, p_dec, p_aud, decide, audit = _patches(_policy())
    with p_kill, p_res, p_dec, p_aud:
        blocked = await inv._heal_precheck(
            ORG,
            "cache_bust",
            decision_id="dec-stale-1",
            decided_at=time.time() - 400,  # > 5 min
        )
    assert blocked is None
    decide.assert_called_once()
    audit.assert_awaited_once()


@pytest.mark.asyncio
async def test_missing_decision_redecides() -> None:
    p_kill, p_res, p_dec, p_aud, decide, audit = _patches(_policy())
    with p_kill, p_res, p_dec, p_aud:
        blocked = await inv._heal_precheck(ORG, "cache_bust")
    assert blocked is None
    decide.assert_called_once()
    audit.assert_awaited_once()


@pytest.mark.asyncio
async def test_kill_switch_enforced_even_with_fresh_decision() -> None:
    p_kill, p_res, p_dec, p_aud, decide, _audit = _patches(
        _policy(), kill_enabled=False
    )
    with p_kill, p_res, p_dec, p_aud:
        blocked = await inv._heal_precheck(
            ORG,
            "cache_bust",
            decision_id="dec-fresh-2",
            decided_at=time.time(),
        )
    assert blocked is not None and "kill switch" in blocked
    decide.assert_not_called()


@pytest.mark.asyncio
async def test_rollback_cap_enforced_even_with_fresh_decision() -> None:
    p_kill, p_res, p_dec, p_aud, decide, _audit = _patches(
        _policy(max_auto_rollbacks_per_day=1)
    )
    client = MagicMock()
    client.fetchrow = AsyncMock(return_value={"n": 1})  # cap reached
    with p_kill, p_res, p_dec, p_aud, patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        blocked = await inv._heal_precheck(
            ORG,
            "rollback",
            decision_id="dec-fresh-3",
            decided_at=time.time(),
        )
    assert blocked is not None and "daily rollback cap" in blocked
    decide.assert_not_called()  # policy still not re-decided


# ── threading through execute_heal / heal_from_issue ────────────────


@pytest.mark.asyncio
async def test_execute_heal_threads_decision_into_precheck() -> None:
    healer = inv.SelfHealer()
    seen: dict[str, Any] = {}

    async def _capture_precheck(
        org_id: str, action_type: str, *, decision_id=None, decided_at=None
    ) -> str | None:
        seen.update(
            {"decision_id": decision_id, "decided_at": decided_at}
        )
        return None

    decided_at = time.time()
    with patch.object(
        inv, "_heal_precheck", new=_capture_precheck
    ), patch.object(
        inv, "_execute_cache_bust",
        new=AsyncMock(side_effect=lambda a: {**a, "executed": True}),
    ), patch.object(
        inv, "_upsert_self_heal", new=AsyncMock()
    ), patch.object(
        inv, "_audit_heal", new=AsyncMock()
    ):
        result = await healer.execute_heal(
            ORG,
            "act-1",
            {"action_type": "cache_bust", "status": "approved"},
            approved_by_user_id="orchestrator",
            decision_id="dec-thread-1",
            decided_at=decided_at,
        )
    assert seen == {"decision_id": "dec-thread-1", "decided_at": decided_at}
    data = result["data"]
    assert data["status"] == "executed"
    # The execution record links back to the single decision row.
    assert data["after_state"]["decision_id"] == "dec-thread-1"


@pytest.mark.asyncio
async def test_heal_from_issue_threads_decision() -> None:
    healer = inv.SelfHealer()
    issue = MagicMock()
    issue.triage_result = {
        "suggested_actions": [{"action_type": "cache_bust"}]
    }
    decided_at = time.time()
    with patch("eden.issues.repo.IssuesRepo") as repo_cls, patch.object(
        healer,
        "heal",
        new=AsyncMock(return_value={"data": {"action_id": "act-9"}}),
    ), patch.object(
        inv, "_load_self_heal_action", new=AsyncMock(return_value={})
    ), patch.object(
        inv, "_upsert_self_heal", new=AsyncMock()
    ), patch.object(
        healer,
        "execute_heal",
        new=AsyncMock(return_value={"data": {"status": "executed"}}),
    ) as execute:
        repo_cls.return_value.get_issue = AsyncMock(return_value=issue)
        await healer.heal_from_issue(
            ORG,
            "issue-9",
            decision_id="dec-thread-2",
            decided_at=decided_at,
        )
    call = execute.await_args
    assert call.kwargs["decision_id"] == "dec-thread-2"
    assert call.kwargs["decided_at"] == decided_at


@pytest.mark.asyncio
async def test_backward_compatible_defaults() -> None:
    """Callers without a decision record behave exactly as before —
    ``heal_from_issue``/``execute_heal`` accept the old signatures."""
    healer = inv.SelfHealer()
    p_kill, p_res, p_dec, p_aud, decide, audit = _patches(_policy())
    with p_kill, p_res, p_dec, p_aud, patch.object(
        inv, "_execute_cache_bust",
        new=AsyncMock(side_effect=lambda a: {**a, "executed": True}),
    ), patch.object(
        inv, "_upsert_self_heal", new=AsyncMock()
    ), patch.object(
        inv, "_audit_heal", new=AsyncMock()
    ):
        result = await healer.execute_heal(
            ORG,
            "act-2",
            {"action_type": "cache_bust", "status": "approved"},
            approved_by_user_id="user-1",
        )
    assert result["data"]["status"] == "executed"
    assert "decision_id" not in result["data"]["after_state"]
    decide.assert_called_once()  # no record → precheck decides (audited)
    audit.assert_awaited_once()
