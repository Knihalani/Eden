"""OOM W3-5 — InvestigationAgent lane budget gate.

Pins that investigate() skips the LLM call and returns a budget-exceeded
envelope when the system-wide investigation lane cap is exceeded.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.autonomous.investigation import InvestigationAgent


ORG = "org-inv-budget-test"
TRIGGER = "drift_alert:abc-123"


def _lane_check(allowed: bool, spent: float = 0.0, cap: float = 10.0):
    return patch(
        "eden.llmops.evolution_spend.LaneDailyBudget.check",
        new=AsyncMock(return_value=(allowed, spent, cap)),
    )


def _resolve_ctx_ok():
    """Stub trigger resolution so the gate actually runs."""
    return patch(
        "eden.autonomous.investigation._resolve_trigger_context",
        new=AsyncMock(
            return_value={
                "context": {"drift_p_value": 0.001},
                "trigger_id": "abc-123",
            }
        ),
    )


@pytest.mark.asyncio
async def test_investigate_skips_llm_when_lane_budget_exceeded() -> None:
    """Lane budget exceeded → returns skip envelope, no LLM call."""
    call_llm = AsyncMock()
    with (
        _resolve_ctx_ok(),
        _lane_check(False, spent=11.0, cap=10.0),
        patch("eden.autonomous.investigation._call_llm", new=call_llm),
    ):
        result = await InvestigationAgent().investigate(
            ORG, trigger=TRIGGER
        )

    call_llm.assert_not_awaited()
    # The envelope must signal the skip
    data = result.get("data", result)
    assert data.get("skipped") is True
    assert data.get("reason") == "lane_budget_exceeded"
    assert data.get("lane_spent_usd") == pytest.approx(11.0)
    assert data.get("lane_cap_usd") == pytest.approx(10.0)


@pytest.mark.asyncio
async def test_investigate_calls_llm_when_lane_budget_ok() -> None:
    """Lane budget not exceeded → LLM is called."""
    llm_resp = '{"findings": [{"description": "ok"}], "proposed_remediations": []}'
    call_llm = AsyncMock(return_value=llm_resp)
    with (
        _resolve_ctx_ok(),
        _lane_check(True, spent=1.0, cap=10.0),
        patch("eden.autonomous.investigation._call_llm", new=call_llm),
    ):
        result = await InvestigationAgent().investigate(
            ORG, trigger=TRIGGER
        )

    call_llm.assert_awaited_once()
    assert result.get("data", {}).get("skipped") is not True


@pytest.mark.asyncio
async def test_investigate_fail_open_when_budget_check_raises() -> None:
    """Budget check raises → fail-open, LLM is still called."""
    llm_resp = '{"findings": [], "proposed_remediations": []}'
    call_llm = AsyncMock(return_value=llm_resp)
    with (
        _resolve_ctx_ok(),
        patch(
            "eden.llmops.evolution_spend.LaneDailyBudget.check",
            new=AsyncMock(side_effect=RuntimeError("redis down")),
        ),
        patch("eden.autonomous.investigation._call_llm", new=call_llm),
    ):
        result = await InvestigationAgent().investigate(
            ORG, trigger=TRIGGER
        )

    call_llm.assert_awaited_once()
    assert result.get("data", {}).get("skipped") is not True
