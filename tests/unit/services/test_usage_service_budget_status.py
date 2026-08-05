"""FEAT-21 — ``UsageService.get_budget_status`` must check the same
customer-configured ``budgets`` table the portal Budgets UI reads/writes
(via ``budget_service.get_budget`` / ``GET,POST /orgs/{org_id}/budget``),
not the internal ``org_resource_limits`` table.

Before this fix, ``get_budget_status`` derived the enforced
``cost_usd`` hard/soft limit purely from
``org_resource_limits.cost_hard_limit_usd`` — a customer lowering (or
raising) their cap in the Budgets UI had zero effect on
``QuotaEnforcementMiddleware`` enforcement, because the middleware's
block/allow decision is entirely driven by the dict this method
returns (see ``QuotaEnforcementMiddleware._check_hard_limits`` /
``_evaluate_hard_limits``).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.services.usage_service import UsageService


class _FakeClient:
    """Minimal fake postgres client for ``get_budget_status``.

    Routes ``fetchrow`` by a distinctive substring in the SQL so the
    same fake serves every query the method issues (resource limits,
    the tokens/storage/sandbox usage rollup, and the three cost sums
    in ``_sum_org_cost_usd``).
    """

    def __init__(
        self,
        resource_limits: dict[str, Any] | None,
        *,
        usage_events_cost: float = 0.0,
        customer_cost_events_cost: float = 0.0,
        budget_consumption_cost: float = 0.0,
    ) -> None:
        self._resource_limits = resource_limits
        self._usage_events_cost = usage_events_cost
        self._customer_cost_events_cost = customer_cost_events_cost
        self._budget_consumption_cost = budget_consumption_cost

    async def get_org_resource_limits(self, org_id: str) -> dict[str, Any] | None:
        return self._resource_limits

    async def set_org_resource_limits(self, org_id: str, plan_name: str = "org_free") -> None:
        self._resource_limits = {"plan_name": plan_name}

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        if "tokens_used" in query:
            return {"tokens_used": 0, "storage_mb_used": 0, "sandbox_seconds_used": 0}
        if "FROM usage_events" in query:
            return {"total": self._usage_events_cost}
        if "FROM customer_cost_events" in query:
            return {"total": self._customer_cost_events_cost}
        if "FROM budget_consumption" in query:
            return {"total": self._budget_consumption_cost}
        return None


ORG_RESOURCE_LIMITS_PAID = {
    "plan_name": "team",
    "cost_soft_limit_usd": 1_600.0,
    "cost_hard_limit_usd": 2_000.0,
}


def _patch_client(client: _FakeClient):
    return patch(
        "eden.services.usage_service.get_postgres_client",
        AsyncMock(return_value=client),
    )


def _patch_budget(budget_cfg: dict[str, Any] | None, *, raises: bool = False):
    if raises:
        mock = AsyncMock(side_effect=RuntimeError("db down"))
    else:
        mock = AsyncMock(return_value=budget_cfg)
    return patch("eden.services.usage_service.budget_service.get_budget", mock)


class TestCostUsdSourcedFromBudgetsTable:
    @pytest.mark.asyncio
    async def test_uses_budgets_hard_limit_when_row_exists(self) -> None:
        """A customer-configured ``budgets`` row (source == 'db') must
        win over ``org_resource_limits`` — even though the org_resource_limits
        cap here (2000) is far above spend, the tighter customer-configured
        cap (20) must be the one that reports hard_exceeded."""
        client = _FakeClient(
            ORG_RESOURCE_LIMITS_PAID,
            usage_events_cost=25.0,
        )
        budget_cfg = {
            "source": "db",
            "cost_soft_limit_usd": 10.0,
            "cost_hard_limit_usd": 20.0,
            "enforcement_enabled": True,
        }
        with _patch_client(client), _patch_budget(budget_cfg):
            status = await UsageService().get_budget_status("org-1")

        cost = status["cost_usd"]
        assert cost["hard_limit"] == 20.0
        assert cost["soft_limit"] == 10.0
        assert cost["status"] == "hard_exceeded"
        assert cost["limit_source"] == "budgets"

    @pytest.mark.asyncio
    async def test_falls_back_to_org_resource_limits_without_a_budgets_row(self) -> None:
        """No ``budgets`` row (``source == 'defaults'``) must fall back to
        ``org_resource_limits``/plan-tier — NOT the free-tier
        ``budget_service.FREE_TIER_DEFAULTS`` (~$4), which would wrongly
        clamp a paid org that never visited the Budgets UI."""
        client = _FakeClient(
            ORG_RESOURCE_LIMITS_PAID,
            usage_events_cost=10.0,
        )
        budget_cfg = {
            "source": "defaults",
            "cost_soft_limit_usd": 3.2,
            "cost_hard_limit_usd": 4.0,
            "enforcement_enabled": True,
        }
        with _patch_client(client), _patch_budget(budget_cfg):
            status = await UsageService().get_budget_status("org-1")

        cost = status["cost_usd"]
        assert cost["hard_limit"] == 2_000.0
        assert cost["soft_limit"] == 1_600.0
        assert cost["status"] == "ok"
        assert cost["limit_source"] == "org_resource_limits"

    @pytest.mark.asyncio
    async def test_budget_service_failure_falls_back_gracefully(self) -> None:
        """``budget_service.get_budget`` raising must not break
        ``get_budget_status`` — fall back to org_resource_limits."""
        client = _FakeClient(ORG_RESOURCE_LIMITS_PAID, usage_events_cost=1.0)
        with _patch_client(client), _patch_budget(None, raises=True):
            status = await UsageService().get_budget_status("org-1")

        cost = status["cost_usd"]
        assert cost["hard_limit"] == 2_000.0
        assert cost["limit_source"] == "org_resource_limits"

    @pytest.mark.asyncio
    async def test_enforcement_disabled_never_reports_hard_exceeded(self) -> None:
        """``budgets.enforcement_enabled = False`` must suppress
        ``hard_exceeded`` (mirrors the DL-15 preflight gate in
        ``autonomous/agent.py``) while still reporting the configured
        numbers and a soft-exceeded warning."""
        client = _FakeClient(ORG_RESOURCE_LIMITS_PAID, usage_events_cost=10.0)
        budget_cfg = {
            "source": "db",
            "cost_soft_limit_usd": 4.0,
            "cost_hard_limit_usd": 5.0,
            "enforcement_enabled": False,
        }
        with _patch_client(client), _patch_budget(budget_cfg):
            status = await UsageService().get_budget_status("org-1")

        cost = status["cost_usd"]
        assert cost["hard_limit"] == 5.0
        assert cost["status"] == "soft_exceeded"
        assert cost["limit_source"] == "budgets"

    @pytest.mark.asyncio
    async def test_zero_hard_limit_row_is_treated_as_unconfigured(self) -> None:
        """A ``budgets`` row with ``cost_hard_limit_usd <= 0`` (unset)
        must not clamp spend to zero — fall back to
        org_resource_limits, matching the ``_limit`` helper's
        ``val > 0`` convention used for every other resource."""
        client = _FakeClient(ORG_RESOURCE_LIMITS_PAID, usage_events_cost=10.0)
        budget_cfg = {
            "source": "db",
            "cost_soft_limit_usd": 0.0,
            "cost_hard_limit_usd": 0.0,
            "enforcement_enabled": True,
        }
        with _patch_client(client), _patch_budget(budget_cfg):
            status = await UsageService().get_budget_status("org-1")

        cost = status["cost_usd"]
        assert cost["hard_limit"] == 2_000.0
        assert cost["limit_source"] == "org_resource_limits"


class TestQuotaMiddlewareRespectsBudgetsSourcedLimit:
    """End-to-end: once ``get_budget_status`` sources cost_usd from
    ``budgets``, the middleware's generic hard-limit evaluator blocks
    on it exactly like any other resource."""

    @pytest.mark.asyncio
    async def test_middleware_blocks_on_budgets_sourced_hard_exceeded(self) -> None:
        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

        client = _FakeClient(ORG_RESOURCE_LIMITS_PAID, usage_events_cost=25.0)
        budget_cfg = {
            "source": "db",
            "cost_soft_limit_usd": 10.0,
            "cost_hard_limit_usd": 20.0,
            "enforcement_enabled": True,
        }
        with _patch_client(client), _patch_budget(budget_cfg):
            budget_status = await UsageService().get_budget_status("org-1")

        class _FakeService:
            async def get_budget_status(self, org_id):
                return budget_status

        mw = QuotaEnforcementMiddleware(app=None)
        mw._usage_service = _FakeService()

        blocked, detail = await mw._check_hard_limits("org-1", ["cost_usd"])
        assert blocked is True
        assert "$25.00" in detail or "25.00" in detail
