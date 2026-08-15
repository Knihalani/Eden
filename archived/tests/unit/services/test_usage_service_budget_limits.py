"""FEAT-21 — ``UsageService.get_budget_status`` must source the cost
hard/soft cap from the customer-editable ``budgets`` table
(``cost_hard_limit_usd`` / ``cost_soft_limit_usd``, edited via
``POST /orgs/{org_id}/budget`` and shown in the portal Budgets UI) when
a row exists and its ``enforcement_enabled`` flag is set — instead of
(or as a fallback from) ``org_resource_limits`` / the plan-tier
default, which is all it read before this fix.

Before the fix, a customer who tightened their budget cap via the
portal saw zero effect on ``QuotaEnforcementMiddleware`` — live
``/gateway/v1`` traffic was enforced against the plan-tier default
(here: ``org_free`` -> $4.00) no matter what the ``budgets`` row said.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.services.usage_service import UsageService


class _FakeClient:
    """Minimal stand-in for the postgres client used by get_budget_status.

    ``org_resource_limits`` never carries ``cost_soft_limit_usd`` /
    ``cost_hard_limit_usd`` in practice (the SELECT in
    ``get_org_resource_limits`` does not project those columns), so the
    fake mirrors that: the returned dict has no cost keys, matching the
    real "always falls through to the plan tier" behaviour today.
    """

    def __init__(self, plan_name: str = "org_free") -> None:
        self.plan_name = plan_name

    async def get_org_resource_limits(self, org_id: str) -> dict[str, Any]:
        return {
            "plan_name": self.plan_name,
            "tokens_soft_limit": None,
            "tokens_hard_limit": None,
            "storage_mb_soft_limit": None,
            "storage_mb_hard_limit": None,
            "sandbox_seconds_soft_limit": None,
            "sandbox_seconds_hard_limit": None,
            "seats_used": 0,
            "references_used": 0,
            "seats_limit": None,
            "references_limit": None,
        }

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any]:
        return {"tokens_used": 0, "storage_mb_used": 0, "sandbox_seconds_used": 0}


def _patch_client(plan_name: str = "org_free"):
    return patch(
        "eden.services.usage_service.get_postgres_client",
        new=AsyncMock(return_value=_FakeClient(plan_name)),
    )


def _patch_cost_sum(total_cost_usd: float):
    return patch.object(
        UsageService,
        "_sum_org_cost_usd",
        AsyncMock(return_value=total_cost_usd),
    )


def _patch_budget(budget_cfg: dict[str, Any] | None, *, raises: bool = False):
    if raises:
        mock = AsyncMock(side_effect=RuntimeError("db down"))
    else:
        mock = AsyncMock(return_value=budget_cfg)
    return patch("eden.services.budget_service.get_budget", new=mock)


@pytest.mark.asyncio
async def test_budgets_row_with_enforcement_enabled_overrides_plan_tier_default() -> None:
    """A customer-configured ``budgets`` row wins over the plan-tier
    default, and ``limit_source`` reports which one was used."""
    budget_cfg = {
        "org_id": "org-1",
        "source": "db",
        "enforcement_enabled": True,
        "cost_soft_limit_usd": 0.80,
        "cost_hard_limit_usd": 1.00,
    }
    with _patch_client(), _patch_cost_sum(2.0), _patch_budget(budget_cfg):
        status = await UsageService().get_budget_status("org-1")

    cost = status["cost_usd"]
    assert cost["hard_limit"] == 1.00
    assert cost["soft_limit"] == 0.80
    assert cost["limit_source"] == "budgets"
    # $2.00 used against a $1.00 customer-set cap — must read as exceeded,
    # not "ok" (which is what the $4.00 org_free tier default would give).
    assert cost["status"] == "hard_exceeded"


@pytest.mark.asyncio
async def test_no_budgets_row_falls_back_to_plan_tier_default() -> None:
    """No customer row (``source == "defaults"``) — stay on the
    ``org_resource_limits`` / plan-tier default exactly as before."""
    budget_cfg = {
        "org_id": "org-1",
        "source": "defaults",
        "enforcement_enabled": True,
        "cost_soft_limit_usd": 3.2,
        "cost_hard_limit_usd": 4.0,
    }
    with _patch_client("org_free"), _patch_cost_sum(2.0), _patch_budget(budget_cfg):
        status = await UsageService().get_budget_status("org-1")

    cost = status["cost_usd"]
    assert cost["limit_source"] == "org_resource_limits"
    assert cost["hard_limit"] == 4.0  # org_free plan-tier default
    assert cost["status"] == "ok"  # $2.00 used, $4.00 cap


@pytest.mark.asyncio
async def test_budgets_row_with_enforcement_disabled_falls_back() -> None:
    """A ``budgets`` row exists but ``enforcement_enabled`` is False —
    must not be used as the live enforcement cap."""
    budget_cfg = {
        "org_id": "org-1",
        "source": "db",
        "enforcement_enabled": False,
        "cost_soft_limit_usd": 0.80,
        "cost_hard_limit_usd": 1.00,
    }
    with _patch_client("org_free"), _patch_cost_sum(2.0), _patch_budget(budget_cfg):
        status = await UsageService().get_budget_status("org-1")

    cost = status["cost_usd"]
    assert cost["limit_source"] == "org_resource_limits"
    assert cost["hard_limit"] == 4.0
    assert cost["status"] == "ok"


@pytest.mark.asyncio
async def test_budget_service_lookup_failure_falls_back_gracefully() -> None:
    """``budget_service.get_budget`` is best-effort at its own layer, but
    ``get_budget_status`` must also degrade gracefully if it ever raises."""
    with _patch_client("org_free"), _patch_cost_sum(2.0), _patch_budget(None, raises=True):
        status = await UsageService().get_budget_status("org-1")

    cost = status["cost_usd"]
    assert cost["limit_source"] == "org_resource_limits"
    assert cost["hard_limit"] == 4.0
    assert cost["status"] == "ok"
