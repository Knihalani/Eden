"""A9 K42 — CostTracker.check_budget reads budget_service PG."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.optimization.cost_tracker import (
    BudgetExceededError,
    BudgetStatus,
    CostTracker,
)


@pytest.mark.asyncio
async def test_check_budget_ok_from_pg():
    tracker = CostTracker()
    with (
        patch(
            "eden.services.budget_service.get_budget",
            new=AsyncMock(
                return_value={
                    "window": "monthly",
                    "cost_soft_limit_usd": 10.0,
                    "cost_hard_limit_usd": 20.0,
                }
            ),
        ),
        patch(
            "eden.services.budget_service.get_consumption",
            new=AsyncMock(return_value={"cost_usd": 1.0}),
        ),
    ):
        status = await tracker.check_budget("org-1", estimated_cost_cents=50)
    assert status == BudgetStatus.OK


@pytest.mark.asyncio
async def test_check_budget_soft_from_pg():
    tracker = CostTracker()
    with (
        patch(
            "eden.services.budget_service.get_budget",
            new=AsyncMock(
                return_value={
                    "window": "monthly",
                    "cost_soft_limit_usd": 1.0,
                    "cost_hard_limit_usd": 10.0,
                }
            ),
        ),
        patch(
            "eden.services.budget_service.get_consumption",
            new=AsyncMock(return_value={"cost_usd": 0.9}),
        ),
    ):
        # 0.9 + 0.50 = 1.4 > soft 1.0
        status = await tracker.check_budget("org-1", estimated_cost_cents=50)
    assert status == BudgetStatus.SOFT_LIMIT


@pytest.mark.asyncio
async def test_check_budget_hard_raises_from_pg():
    tracker = CostTracker()
    with (
        patch(
            "eden.services.budget_service.get_budget",
            new=AsyncMock(
                return_value={
                    "window": "monthly",
                    "cost_soft_limit_usd": 1.0,
                    "cost_hard_limit_usd": 2.0,
                }
            ),
        ),
        patch(
            "eden.services.budget_service.get_consumption",
            new=AsyncMock(return_value={"cost_usd": 1.8}),
        ),
    ):
        with pytest.raises(BudgetExceededError):
            await tracker.check_budget("org-1", estimated_cost_cents=50)
