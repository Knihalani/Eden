"""SOTA Wave 7 — CostEvent ledger + cascade recording tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.evaluation.online.scorer_cascade import OnlineScorerCascade
from eden.llmops.cost_ledger import (
    CostEvent,
    cost_context,
    current_cost_context,
    record_cost_event,
)
from eden.llmops.feature_kills import is_feature_enabled


@pytest.mark.asyncio
async def test_record_cost_event_writes_pg_and_budget() -> None:
    client = AsyncMock()
    client.execute = AsyncMock(return_value=None)
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ),
        patch(
            "eden.services.budget_service.record_usage",
            new=AsyncMock(return_value=True),
        ) as usage,
        patch(
            "eden.services.budget_service.evaluate_budget_alerts",
            new=AsyncMock(return_value=[50]),
        ) as alerts,
    ):
        ok = await record_cost_event(
            CostEvent(
                org_id="org_test",
                feature="chat_sidebar",
                model="anthropic/claude-haiku",
                cost_usd=0.0123,
                input_tokens=10,
                output_tokens=20,
                total_tokens=30,
                trace_id="tr_1",
            )
        )
    assert ok is True
    client.execute.assert_awaited()
    usage.assert_awaited_once_with("org_test", 0.0123)
    alerts.assert_awaited_once_with("org_test")


@pytest.mark.asyncio
async def test_record_cost_event_skips_budget_on_zero_cost() -> None:
    """$0 events still write the ledger row but skip budget I/O."""
    client = AsyncMock()
    client.execute = AsyncMock(return_value=None)
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ),
        patch(
            "eden.services.budget_service.record_usage",
            new=AsyncMock(return_value=True),
        ) as usage,
        patch(
            "eden.services.budget_service.evaluate_budget_alerts",
            new=AsyncMock(return_value=[]),
        ) as alerts,
    ):
        ok = await record_cost_event(
            CostEvent(
                org_id="org_test",
                feature="embeddings",
                model="text-embedding-3-small",
                cost_usd=0.0,
                input_tokens=10,
                output_tokens=0,
            )
        )
    assert ok is True
    client.execute.assert_awaited()
    usage.assert_not_awaited()
    alerts.assert_not_awaited()


@pytest.mark.asyncio
async def test_record_cost_event_normalizes_unknown_feature() -> None:
    client = AsyncMock()
    client.execute = AsyncMock(return_value=None)
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ),
        patch(
            "eden.services.budget_service.record_usage",
            new=AsyncMock(return_value=True),
        ),
        patch(
            "eden.services.budget_service.evaluate_budget_alerts",
            new=AsyncMock(return_value=[]),
        ),
    ):
        await record_cost_event(
            CostEvent(
                org_id="org_x",
                feature="not_a_real_feature",
                model="m",
                cost_usd=0.01,
            )
        )
    args = client.execute.await_args.args
    # bind order: sql, id, org_id, feature, model, ...
    assert args[3] == "unknown"


def test_cost_context_binds_feature() -> None:
    with cost_context("org1", "triage", trace_id="t1"):
        ctx = current_cost_context()
    assert ctx["org_id"] == "org1"
    assert ctx["feature"] == "triage"
    assert ctx["trace_id"] == "t1"
    assert current_cost_context()["org_id"] is None


@pytest.mark.asyncio
async def test_feature_kill_unknown_fail_closed() -> None:
    assert await is_feature_enabled("org", "totally_unknown_feature") is False


@pytest.mark.asyncio
async def test_scorer_cascade_llm_fallback_when_flag_on() -> None:
    cascade = OnlineScorerCascade()
    fake_resp = MagicMock()
    fake_resp.content = '{"score": 0.9, "passed": true, "confidence": 0.8, "rationale": "ok"}'
    fake_resp.usage = MagicMock(cost=0.02)

    with (
        patch("eden.config.get_settings") as gs,
        patch(
            "eden.llmops.feature_kills.is_feature_enabled",
            new=AsyncMock(return_value=True),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.check_budget",
            new=AsyncMock(return_value=(True, 0.0, 25.0)),
        ),
        patch(
            "eden.llm.internal_router.route_async",
            new=AsyncMock(return_value=fake_resp),
        ),
    ):
        gs.return_value = MagicMock(online_scoring_llm_fallback_v1=True)
        result = await cascade._run_llm_fallback(
            "org1", "tr1", "sp1", {"text": "hello"}
        )

    assert result is not None
    assert result["judge_tier"] == "llm"
    assert result["score"] == 0.9
    assert result["cost_usd"] == 0.02


@pytest.mark.asyncio
async def test_scorer_cascade_llm_fallback_respects_flag_off() -> None:
    cascade = OnlineScorerCascade()
    with patch("eden.config.get_settings") as gs:
        gs.return_value = MagicMock(online_scoring_llm_fallback_v1=False)
        assert (
            await cascade._run_llm_fallback("org", "t", None, {"text": "x"})
            is None
        )


@pytest.mark.asyncio
async def test_evolution_pass_skips_when_spend_capped() -> None:
    from eden.agents.evolution import loop as evo_loop

    budget = MagicMock()
    budget.may_spend = AsyncMock(return_value=False)
    budget.status = AsyncMock(
        return_value={"cap_usd": 2.0, "spent_usd": 2.0, "remaining_usd": 0.0}
    )

    with (
        patch(
            "eden.llmops.feature_kills.is_feature_enabled",
            new=AsyncMock(return_value=True),
        ),
        patch(
            "eden.llmops.evolution_spend.EvolutionSpendBudget",
            return_value=budget,
        ),
        patch.object(
            evo_loop, "_enroll_pending_canaries", new=AsyncMock(return_value=0)
        ),
        patch(
            "eden.llmops.promotion.get_promotion_loop",
            return_value=MagicMock(run_once=AsyncMock(return_value={})),
        ),
    ):
        summary = await evo_loop.run_evolution_pass()

    assert summary["spend_skipped"] is True
    assert summary["evolver"]["skipped"] == "evolution_spend_cap"


@pytest.mark.asyncio
async def test_budget_alert_ladder_fires_50_80_100() -> None:
    from eden.services import budget_service as bs

    with (
        patch.object(
            bs,
            "get_budget",
            new=AsyncMock(
                return_value={
                    "id": "bud_1",
                    "window": "monthly",
                    "cost_hard_limit_usd": 10.0,
                    "threshold_alert_pct": 80,
                    "alert_thresholds": [50, 80, 100],
                }
            ),
        ),
        patch.object(
            bs,
            "get_consumption",
            new=AsyncMock(
                return_value={"cost_usd": 10.0, "window_start": "2026-07-01"}
            ),
        ),
        patch.object(bs, "list_actions", new=AsyncMock(return_value=[])),
        patch.object(bs, "record_action", new=AsyncMock(return_value=True)) as rec,
        patch.object(bs, "_notify_budget_alert", new=AsyncMock()),
    ):
        fired = await bs.evaluate_budget_alerts("org_z")

    assert fired == [50, 80, 100]
    assert rec.await_count == 3
