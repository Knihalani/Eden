"""FEAT-21 — ``QuotaEnforcementMiddleware`` must block live requests
against the customer-configured ``budgets.cost_hard_limit_usd``
(edited via ``POST /orgs/{org_id}/budget``, shown in the portal
Budgets UI), not just the ``org_resource_limits`` / plan-tier default.

The middleware itself does not read ``budgets`` directly — it consumes
whatever ``UsageService.get_budget_status`` returns in ``cost_usd``.
These tests exercise ``_check_hard_limits`` (the async entry point that
calls ``get_budget_status``) end to end through the real
``UsageService.get_budget_status`` with postgres / budget_service
mocked underneath, so the assertion covers the full wiring: a tight
customer-set budget cap blocks even though the plan-tier default would
not have.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.services.usage_service import UsageService


class _FakeClient:
    async def get_org_resource_limits(self, org_id: str) -> dict[str, Any]:
        return {"plan_name": "org_free"}

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any]:
        return {"tokens_used": 0, "storage_mb_used": 0, "sandbox_seconds_used": 0}


def _patch_client():
    return patch(
        "eden.services.usage_service.get_postgres_client",
        new=AsyncMock(return_value=_FakeClient()),
    )


def _patch_cost_sum(total_cost_usd: float):
    return patch.object(
        UsageService,
        "_sum_org_cost_usd",
        AsyncMock(return_value=total_cost_usd),
    )


def _patch_budget(budget_cfg: dict[str, Any]):
    return patch(
        "eden.services.budget_service.get_budget",
        new=AsyncMock(return_value=budget_cfg),
    )


class TestFeat21MiddlewareEnforcesBudgetsHardCap:
    @pytest.mark.asyncio
    async def test_a_tight_customer_budget_blocks_even_under_the_plan_tier_default(
        self,
    ) -> None:
        """$2.00 spent — under the org_free plan-tier's $4.00 default,
        but over the customer's own $1.00 ``budgets`` cap. Must block.
        """
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(AsyncMock())
        mw._usage_service = UsageService()

        budget_cfg = {
            "org_id": "org-tight",
            "source": "db",
            "enforcement_enabled": True,
            "cost_soft_limit_usd": 0.80,
            "cost_hard_limit_usd": 1.00,
        }
        with _patch_client(), _patch_cost_sum(2.0), _patch_budget(budget_cfg):
            blocked, detail = await mw._check_hard_limits(
                "org-tight", ["cost_usd"]
            )

        assert blocked is True
        assert detail

    @pytest.mark.asyncio
    async def test_no_budgets_row_stays_on_the_looser_plan_tier_default(
        self,
    ) -> None:
        """Same spend, no customer ``budgets`` row — must not block
        (this is the pre-fix behaviour, preserved as the fallback)."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(AsyncMock())
        mw._usage_service = UsageService()

        budget_cfg = {
            "org_id": "org-loose",
            "source": "defaults",
            "enforcement_enabled": True,
            "cost_soft_limit_usd": 3.2,
            "cost_hard_limit_usd": 4.0,
        }
        with _patch_client(), _patch_cost_sum(2.0), _patch_budget(budget_cfg):
            blocked, _detail = await mw._check_hard_limits(
                "org-loose", ["cost_usd"]
            )

        assert blocked is False

    @pytest.mark.asyncio
    async def test_a_disabled_budgets_row_does_not_block(self) -> None:
        """A ``budgets`` row exists but ``enforcement_enabled`` is
        False — must not be used to block live traffic."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(AsyncMock())
        mw._usage_service = UsageService()

        budget_cfg = {
            "org_id": "org-disabled",
            "source": "db",
            "enforcement_enabled": False,
            "cost_soft_limit_usd": 0.80,
            "cost_hard_limit_usd": 1.00,
        }
        with _patch_client(), _patch_cost_sum(2.0), _patch_budget(budget_cfg):
            blocked, _detail = await mw._check_hard_limits(
                "org-disabled", ["cost_usd"]
            )

        assert blocked is False
