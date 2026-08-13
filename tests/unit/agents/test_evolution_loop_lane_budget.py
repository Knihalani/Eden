"""OOM W3-5 — evolution loop lane budget gate.

Pins that run_evolution_pass() skips the JudgeScorePromptEvolver when the
system-wide evolution lane cap is exceeded, and still runs canary-enroll +
promotion (those are unaffected by the lane budget).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.agents.evolution.loop import run_evolution_pass


def _lane_check(allowed: bool, spent: float = 0.0, cap: float = 2.0):
    return patch(
        "eden.llmops.evolution_spend.LaneDailyBudget.check",
        new=AsyncMock(return_value=(allowed, spent, cap)),
    )


def _promo_loop_stub(run_once_return=None):
    """Return a fake PromotionLoop object."""
    pl = MagicMock()
    pl.run_once = AsyncMock(return_value=run_once_return or {})
    return pl


@pytest.mark.asyncio
async def test_evolution_pass_skips_evolver_when_lane_budget_exceeded() -> None:
    """Lane exceeded → evolver skipped; spend_skipped=True; canaries + promotion still run."""
    canary_mock = AsyncMock(return_value=3)
    promo_mock = AsyncMock(return_value={"promoted": 0})
    promo_loop = MagicMock()
    promo_loop.run_once = promo_mock

    with (
        _lane_check(False, spent=2.5, cap=2.0),
        patch(
            "eden.agents.evolution.loop._enroll_pending_canaries",
            new=canary_mock,
        ),
        # get_promotion_loop is imported lazily inside run_evolution_pass
        patch(
            "eden.llmops.promotion.get_promotion_loop",
            return_value=promo_loop,
        ),
    ):
        result = await run_evolution_pass()

    assert result["spend_skipped"] is True
    evolver = result["evolver"]
    assert evolver.get("skipped") == "evolution_lane_budget_exceeded"
    assert evolver.get("lane_spent_usd") == pytest.approx(2.5)
    assert evolver.get("lane_cap_usd") == pytest.approx(2.0)
    # Non-evolver paths still run
    canary_mock.assert_awaited_once()
    promo_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_evolution_pass_proceeds_to_per_org_gate_when_lane_ok() -> None:
    """Lane OK → fall through to the existing EvolutionSpendBudget gate."""
    promo_loop = MagicMock()
    promo_loop.run_once = AsyncMock(return_value={})

    with (
        _lane_check(True, spent=0.1, cap=2.0),
        patch(
            "eden.llmops.feature_kills.is_feature_enabled",
            new=AsyncMock(return_value=False),  # feature killed → safe, no LLM
        ),
        patch(
            "eden.agents.evolution.loop._enroll_pending_canaries",
            new=AsyncMock(return_value=0),
        ),
        patch(
            "eden.llmops.promotion.get_promotion_loop",
            return_value=promo_loop,
        ),
    ):
        result = await run_evolution_pass()

    # Feature-killed but not via lane cap
    assert result["evolver"].get("skipped") == "feature_kill"
    assert result["evolver"].get("skipped") != "evolution_lane_budget_exceeded"


@pytest.mark.asyncio
async def test_evolution_pass_fail_open_when_lane_check_raises() -> None:
    """If lane check raises, fail-open and continue to per-org gate."""
    promo_loop = MagicMock()
    promo_loop.run_once = AsyncMock(return_value={})

    with (
        patch(
            "eden.llmops.evolution_spend.LaneDailyBudget.check",
            new=AsyncMock(side_effect=RuntimeError("redis down")),
        ),
        patch(
            "eden.llmops.feature_kills.is_feature_enabled",
            new=AsyncMock(return_value=False),  # safe gate
        ),
        patch(
            "eden.agents.evolution.loop._enroll_pending_canaries",
            new=AsyncMock(return_value=0),
        ),
        patch(
            "eden.llmops.promotion.get_promotion_loop",
            return_value=promo_loop,
        ),
    ):
        result = await run_evolution_pass()

    # Must not have lane-cap skip; per-org gate ran and feature-killed it
    assert result["evolver"].get("skipped") != "evolution_lane_budget_exceeded"
    # And the tick must not have raised
    assert "evolver" in result
