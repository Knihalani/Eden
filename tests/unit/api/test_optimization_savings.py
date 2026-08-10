"""Token-savings honesty tests for the optimization routes.

Data-integrity audit 2026-08: ``compression_ratio`` and
``coalesced_requests`` were permanently hardcoded to ``1.0`` / ``0``
as placeholders. Neither stat is tracked anywhere (the gateway
coalescer keeps no totals; nothing measures prompt compression), so
the contract is now: ``None`` means "not tracked" — never an
invented number.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.api.routes.optimization import (
    TokenSavingsResponse,
    _empty_optimization_overview,
    get_token_savings,
)


class TestTokenSavingsHonesty:
    def test_untracked_fields_default_to_none(self) -> None:
        resp = TokenSavingsResponse(
            tokens_saved=10, estimated_cost_saved_cents=0.1
        )
        assert resp.compression_ratio is None
        assert resp.coalesced_requests is None

    def test_empty_overview_does_not_fabricate_savings(self) -> None:
        overview = _empty_optimization_overview("org_x", days=7)
        assert overview.savings.compression_ratio is None
        assert overview.savings.coalesced_requests is None

    @pytest.mark.asyncio
    async def test_savings_route_reports_untracked_as_none(self) -> None:
        router = MagicMock()
        router.get_stats.return_value = {"tokens_saved": 1000}
        with patch(
            "eden.api.routes.optimization._get_model_router",
            return_value=router,
        ):
            resp = await get_token_savings(
                org_id="org_x", user={}, _check_billing_view={}
            )
        assert resp.tokens_saved == 1000
        assert resp.estimated_cost_saved_cents == pytest.approx(8.85)
        assert resp.compression_ratio is None
        assert resp.coalesced_requests is None


class TestOverviewBudgetSource:
    """Wave 4 (4.3): the overview must not read the dead Redis cost hash.

    FEAT-171 removed the only writer of ``eden:cost:{org_id}:month:*``,
    so the overview used to return zero/stale spend. It now derives
    current-month spend from the in-memory tracker — these tests lock
    that in and guard against the Redis read being resurrected.
    """

    def test_no_redis_cost_hash_read_remains(self) -> None:
        import inspect

        from eden.api.routes import optimization as mod

        src = inspect.getsource(mod)
        # The FEAT-171 comment may mention the old hash — assert on the
        # actual code patterns, not the docs.
        assert "redis.hget" not in src
        assert "from eden.storage.redis" not in src

    @pytest.mark.asyncio
    async def test_overview_spend_derived_from_tracker_not_redis(self) -> None:
        from datetime import UTC, datetime, timedelta

        from eden.api.routes.optimization import _build_optimization_overview
        from eden.optimization.cost_tracker import CostEvent

        now = datetime.now(UTC)
        tracker = MagicMock()
        tracker.get_events.return_value = [
            CostEvent(
                tenant_id="org_x",
                user_id=None,
                job_id=None,
                model="gpt-4o-mini",
                pipeline_node="gateway",
                cost_type="llm_tokens",
                total_tokens=100,
                total_cost_cents=12.5,
                timestamp=(now - timedelta(days=2)).isoformat(),
            ),
            # Outside the current month — must be excluded from spend.
            CostEvent(
                tenant_id="org_x",
                user_id=None,
                job_id=None,
                model="gpt-4o-mini",
                pipeline_node="gateway",
                cost_type="llm_tokens",
                total_tokens=100,
                total_cost_cents=7.5,
                timestamp=(now - timedelta(days=45)).isoformat(),
            ),
        ]
        tracker.check_budget = AsyncMock(return_value="ok")
        tracker._get_tenant_limits = AsyncMock(
            return_value={
                "soft_limit_cents": 1000.0,
                "hard_limit_cents": 5000.0,
                "plan_name": "free",
            }
        )
        router = MagicMock()
        router.get_stats.return_value = {}
        empty_cache = MagicMock()
        empty_cache.get_stats.return_value = {}
        with (
            patch(
                "eden.api.routes.optimization._get_model_router",
                return_value=router,
            ),
            patch(
                "eden.api.routes.optimization._get_exact_cache",
                return_value=empty_cache,
            ),
            patch(
                "eden.api.routes.optimization._get_semantic_cache",
                return_value=empty_cache,
            ),
            patch(
                "eden.api.routes.optimization._get_cost_tracker",
                return_value=tracker,
            ),
        ):
            overview = await _build_optimization_overview("org_x", days=30)

        assert overview.budget.current_month_spend_cents == pytest.approx(12.5)
        assert overview.budget.utilization_pct == pytest.approx(
            12.5 / 5000.0 * 100, abs=0.01
        )
