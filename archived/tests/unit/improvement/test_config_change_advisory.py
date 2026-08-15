"""M6 (D10, spec §3.7/§11): config_change is advisory-only.

Producers emit ``plan_kind="advisory"`` (no approvable rows the system
cannot act on), and approving a legacy ``config_change`` — or a new
``advisory`` — plan returns ``advisory_only`` with an N06 ledger record,
never ``unsupported_kind`` and never a fake apply.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.improvement.agent import ImprovementAgent
from eden.improvement.approve import approve_plan


@pytest.mark.asyncio
async def test_producers_emit_no_config_change_kind() -> None:
    """Sweep lanes that used to emit config_change now emit advisory."""
    agent = ImprovementAgent()
    trace_24h = [
        {
            "agent_id": "agent-a",
            "cost_24h": 50.0,
            "p95_latency_24h": 95.0,
            "trace_count": 10,
        }
    ]
    trace_baseline = [
        {
            "agent_id": "agent-a",
            "mean_cost": 10.0,
            "std_cost": 2.0,
            "mean_p95": 90.0,
            "std_p95": 5.0,
        }
    ]

    with (
        patch("eden.improvement.agent._pg_fetch", AsyncMock()) as mock_fetch,
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
    ):
        mock_fetch.side_effect = [trace_24h, trace_baseline, [], []]
        out = await agent._from_metrics("org-1", None)

    assert out, "cost spike must still produce a plan"
    assert all(c.plan_kind != "config_change" for c in out)
    assert out[0].plan_kind == "advisory"


@pytest.mark.asyncio
@pytest.mark.parametrize("plan_kind", ["config_change", "advisory"])
async def test_approve_advisory_kinds_returns_advisory_only(plan_kind: str) -> None:
    plan = {
        "id": "plan-adv-1",
        "status": "pending_review",
        "plan_kind": plan_kind,
        "title": "Cost spike: agent-a",
        "summary": "24h cost exceeds 7d rolling baseline by >2σ",
        "evidence": {"metric": "cost", "value_24h": 50.0},
    }
    ledger = AsyncMock()
    mark = AsyncMock(return_value={**plan, "status": "approved"})
    with (
        patch(
            "eden.improvement.approve.plans_repo.get_plan",
            AsyncMock(return_value=plan),
        ),
        patch("eden.improvement.approve._n22_blocked", AsyncMock(return_value=None)),
        patch("eden.improvement.approve.plans_repo.mark_approved", mark),
        patch("eden.improvement.approve._n06_ledger", ledger),
    ):
        result = await approve_plan("org-1", "plan-adv-1", approved_by="user-1")

    assert result["status"] == "advisory_only"
    assert result["plan_kind"] == plan_kind
    assert result["status"] != "unsupported_kind"
    assert "N06" in result["message"]
    mark.assert_awaited_once()
    # Recommendation recorded to the N06 ledger with the plan evidence.
    ledger.assert_awaited_once()
    kwargs = ledger.await_args.kwargs
    assert kwargs["event_subtype"] == "advisory_acknowledged"
    assert kwargs["payload"]["plan_kind"] == plan_kind
    assert kwargs["payload"]["recommendation"] == {"metric": "cost", "value_24h": 50.0}


@pytest.mark.asyncio
async def test_approve_advisory_records_real_n06_ledger_writer() -> None:
    """The N06 record goes through AgentAuditLedgerWriter (compliance pack)."""
    plan = {
        "id": "plan-adv-2",
        "status": "draft",
        "plan_kind": "config_change",
        "title": "Budget threshold breached",
        "evidence": {"metric": "budget_breach"},
    }
    writer = AsyncMock()
    with (
        patch(
            "eden.improvement.approve.plans_repo.get_plan",
            AsyncMock(return_value=plan),
        ),
        patch("eden.improvement.approve._n22_blocked", AsyncMock(return_value=None)),
        patch(
            "eden.improvement.approve.plans_repo.mark_approved",
            AsyncMock(return_value={**plan, "status": "approved"}),
        ),
        patch(
            "eden.governance.compliance_pack.AgentAuditLedgerWriter.write",
            writer,
        ),
    ):
        result = await approve_plan("org-1", "plan-adv-2", approved_by="user-1")

    assert result["status"] == "advisory_only"
    writer.assert_awaited_once()
    kwargs = writer.await_args.kwargs
    assert kwargs["event_subtype"] == "advisory_acknowledged"
    assert kwargs["payload"]["plan_id"] == "plan-adv-2"
