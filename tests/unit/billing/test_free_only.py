"""Billing free-only mode tests (July 2026 credits rewrite).

Covers: every org defaults to ``org_free``; Stripe-backed endpoints
return 503; ``/billing/plans`` surfaces org_free limits; free-tier
primary meter is **credits** (10_000 ≈ $100).
"""

from __future__ import annotations

import pytest

from eden.services import plan_tiers


class TestFreeTiers:
    """``PLAN_TIERS`` only exposes the two free tiers in free-only mode."""

    def test_only_free_tiers_in_active_catalogue(self):
        names = set(plan_tiers.PLAN_TIERS.keys())
        assert names == {"individual_free", "org_free"}

    def test_paid_tiers_still_resolvable_as_placeholders(self):
        for name in ("pro", "team", "enterprise"):
            tier = plan_tiers.get_plan_tier(name)
            assert tier.name == name

    def test_list_public_plan_tiers_returns_only_free(self):
        names = [t.name for t in plan_tiers.list_public_plan_tiers()]
        assert names == ["individual_free", "org_free"]

    def test_legacy_aliases_resolve(self):
        tier = plan_tiers.get_plan_tier("free")
        assert tier.name == "org_free"

    def test_unknown_plan_falls_back_to_org_free(self):
        assert plan_tiers.get_plan_tier("garbage").name == "org_free"

    def test_empty_plan_falls_back_to_org_free(self):
        assert plan_tiers.get_plan_tier("").name == "org_free"

    def test_default_plan_name_is_org_free(self):
        assert plan_tiers.default_plan_name() == "org_free"

    def test_individual_plan_name(self):
        assert plan_tiers.individual_plan_name() == "individual_free"


class TestCreditsModel:
    """100 credits = $1; free beta hard-caps at ≈ $100."""

    def test_credits_per_usd(self):
        assert plan_tiers.CREDITS_PER_USD == 100

    def test_usd_credits_round_trip(self):
        assert plan_tiers.usd_to_credits(1.0) == 100.0
        assert plan_tiers.credits_to_usd(10_000) == 100.0

    def test_free_hard_cap_is_about_100_dollars(self):
        assert plan_tiers.FREE_TIER_CREDITS_HARD == 10_000
        for name in ("individual_free", "org_free"):
            tier = plan_tiers.get_plan_tier(name)
            assert tier.credits_hard_limit == 10_000
            assert tier.cost_hard_limit_usd == pytest.approx(100.0)
            assert 0 < tier.credits_soft_limit < tier.credits_hard_limit
            assert tier.cost_soft_limit_usd == pytest.approx(
                plan_tiers.credits_to_usd(tier.credits_soft_limit)
            )

    def test_paid_placeholders_higher_than_free(self):
        free = plan_tiers.get_plan_tier("org_free")
        pro = plan_tiers.get_plan_tier("pro")
        assert pro.credits_hard_limit > free.credits_hard_limit
        assert pro.cost_hard_limit_usd > free.cost_hard_limit_usd


class TestFreeTiersLimits:
    @pytest.mark.parametrize(
        "plan_name,expected_seats",
        [("individual_free", 1), ("org_free", 3)],
    )
    def test_seat_limits(self, plan_name, expected_seats):
        assert plan_tiers.get_plan_tier(plan_name).seats_limit == expected_seats

    @pytest.mark.parametrize("plan_name", ["individual_free", "org_free"])
    def test_token_hard_limit_above_credit_cap(self, plan_name):
        """Token caps must not trip before the ~$100 credit cap."""
        assert plan_tiers.get_plan_tier(plan_name).tokens_hard_limit >= 20_000_000

    @pytest.mark.parametrize("plan_name", ["individual_free", "org_free"])
    def test_free_price(self, plan_name):
        assert plan_tiers.get_plan_tier(plan_name).price_monthly_usd == 0


class TestQuotaEnforcementCreditsCap:
    """The quota middleware must check credits on every mutating request."""

    def test_credits_in_global_mutating_resources(self):
        from eden.api.middleware.quota_enforcement import GLOBAL_MUTATING_RESOURCES

        assert "credits" in GLOBAL_MUTATING_RESOURCES
        assert "cost_usd" not in GLOBAL_MUTATING_RESOURCES

    def test_credits_hard_exceeded_returns_429(self):
        import asyncio

        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

        mw = QuotaEnforcementMiddleware(app=None)
        budget = {
            "credits": {
                "used": 10_500,
                "soft_limit": 8_000,
                "hard_limit": 10_000,
                "status": "hard_exceeded",
                "percentage": 105.0,
            },
            "cost_usd": {
                "used": 105.0,
                "soft_limit": 80.0,
                "hard_limit": 100.0,
                "status": "hard_exceeded",
                "percentage": 105.0,
            },
            "seats": {"used": 0, "soft_limit": 3, "hard_limit": 3, "status": "ok", "percentage": 0.0},
            "references": {"used": 0, "soft_limit": 50, "hard_limit": 50, "status": "ok", "percentage": 0.0},
        }

        class _FakeService:
            async def get_budget_status(self, org_id):
                return budget

        mw._usage_service = _FakeService()
        blocked, detail = asyncio.run(mw._check_hard_limits("org-1", ["credits"]))
        assert blocked is True
        assert "credit cap" in detail.lower()
        assert "10500" in detail.replace(",", "") or "10,500" in detail or "10500" in detail

    def test_credits_within_cap_does_not_block(self):
        import asyncio

        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

        mw = QuotaEnforcementMiddleware(app=None)
        budget = {
            "credits": {
                "used": 1_200,
                "soft_limit": 8_000,
                "hard_limit": 10_000,
                "status": "ok",
                "percentage": 12.0,
            },
            "cost_usd": {
                "used": 12.0,
                "soft_limit": 80.0,
                "hard_limit": 100.0,
                "status": "ok",
                "percentage": 12.0,
            },
            "seats": {"used": 0, "soft_limit": 3, "hard_limit": 3, "status": "ok", "percentage": 0.0},
            "references": {"used": 0, "soft_limit": 50, "hard_limit": 50, "status": "ok", "percentage": 0.0},
        }

        class _FakeService:
            async def get_budget_status(self, org_id):
                return budget

        mw._usage_service = _FakeService()
        blocked, detail = asyncio.run(mw._check_hard_limits("org-1", ["credits"]))
        assert blocked is False
        assert detail == ""

    def test_quota_headers_include_credits_and_cost(self):
        import asyncio

        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

        mw = QuotaEnforcementMiddleware(app=None)
        budget = {
            "tokens": {"used": 100, "soft_limit": 100_000, "hard_limit": 500_000, "status": "ok", "percentage": 0.02},
            "storage_mb": {"used": 0, "soft_limit": 1024, "hard_limit": 5120, "status": "ok", "percentage": 0.0},
            "sandbox_seconds": {"used": 0, "soft_limit": 36000, "hard_limit": 72000, "status": "ok", "percentage": 0.0},
            "seats": {"used": 1, "soft_limit": 3, "hard_limit": 3, "status": "ok", "percentage": 33.3},
            "references": {"used": 0, "soft_limit": 50, "hard_limit": 50, "status": "ok", "percentage": 0.0},
            "credits": {
                "used": 450.0,
                "soft_limit": 8_000,
                "hard_limit": 10_000,
                "status": "ok",
                "percentage": 4.5,
            },
            "cost_usd": {
                "used": 4.5,
                "soft_limit": 80.0,
                "hard_limit": 100.0,
                "status": "ok",
                "percentage": 4.5,
            },
            "plan_name": "org_free",
        }

        class _FakeService:
            async def get_budget_status(self, org_id):
                return budget

        mw._usage_service = _FakeService()
        headers = asyncio.run(mw._build_quota_headers("org-1"))
        assert headers["X-Quota-Credits-Used"] == "450.0"
        assert headers["X-Quota-Credits-Hard"] == "10000"
        assert headers["X-Quota-Cost-Used"] == "4.5"
        assert headers["X-Quota-Cost-Hard"] == "100.0"
        assert headers["X-Quota-Plan"] == "org_free"


class TestPaidPlansDisabled:
    def test_paid_plans_flag_is_off(self):
        from eden.api.routes import billing

        assert billing.PAID_PLANS_ENABLED is False

    def test_require_paid_plans_enabled_raises_503(self):
        from fastapi import HTTPException

        from eden.api.routes.billing import _require_paid_plans_enabled

        with pytest.raises(HTTPException) as exc_info:
            _require_paid_plans_enabled()
        assert exc_info.value.status_code == 503
        assert "Paid plans are not available" in exc_info.value.detail

    def test_legacy_free_alias_maps_to_org_free_for_check_limit(self):
        import inspect

        from eden.api.routes.billing import check_limit

        source = inspect.getsource(check_limit)
        assert "org_free" in source
        assert 'plan_name="free"' not in source
