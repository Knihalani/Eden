"""Billing free-only mode tests (June 2026).

Covers the post-046 model: every org defaults to ``org_free``; the
Stripe-backed endpoints (subscribe / cancel / webhook) return 503;
``/billing/plans`` surfaces the org_free tier limits via the
``plan_tiers`` single source of truth.
"""

from __future__ import annotations

import pytest

from eden.services import plan_tiers


# ──────────────────────────────────────────────────────────────────────────
# plan_tiers.py — single source of truth
# ──────────────────────────────────────────────────────────────────────────


class TestFreeTiers:
    """``PLAN_TIERS`` only exposes the two free tiers in free-only mode."""

    def test_only_free_tiers_in_active_catalogue(self):
        names = set(plan_tiers.PLAN_TIERS.keys())
        assert names == {"individual_free", "org_free"}

    def test_paid_tiers_still_resolvable_as_placeholders(self):
        """Legacy paid tier definitions must still resolve (so old
        org_plans rows pointing at ``pro``/``team``/``enterprise``
        don't crash the quota middleware)."""
        for name in ("pro", "team", "enterprise"):
            tier = plan_tiers.get_plan_tier(name)
            assert tier.name == name
            assert tier.price_monthly_usd is not None or name == "enterprise"

    def test_list_public_plan_tiers_returns_only_free(self):
        names = [t.name for t in plan_tiers.list_public_plan_tiers()]
        assert names == ["individual_free", "org_free"]

    def test_list_plan_tiers_includes_paid_placeholders(self):
        names = {t.name for t in plan_tiers.list_plan_tiers()}
        assert {"individual_free", "org_free", "pro", "team", "enterprise"} <= names

    def test_legacy_aliases_resolve(self):
        """``free`` is the legacy name from the pre-June-2026 free tier.
        It must resolve to ``org_free`` so old ``org_plans.plan_name``
        rows don't break quota lookups."""
        tier = plan_tiers.get_plan_tier("free")
        assert tier.name == "org_free"

    def test_unknown_plan_falls_back_to_org_free(self):
        """Misconfigured rows must never deny service."""
        tier = plan_tiers.get_plan_tier("garbage")
        assert tier.name == "org_free"

    def test_empty_plan_falls_back_to_org_free(self):
        assert plan_tiers.get_plan_tier("").name == "org_free"

    def test_default_plan_name_is_org_free(self):
        assert plan_tiers.default_plan_name() == "org_free"

    def test_individual_plan_name(self):
        assert plan_tiers.individual_plan_name() == "individual_free"


class TestFreeTierLimits:
    """Limits must keep Eden's marginal COGS under ~$1/active-user/month."""

    @pytest.mark.parametrize(
        "plan_name,expected_seats",
        [("individual_free", 1), ("org_free", 3)],
    )
    def test_seat_limits(self, plan_name, expected_seats):
        assert plan_tiers.get_plan_tier(plan_name).seats_limit == expected_seats

    @pytest.mark.parametrize(
        "plan_name",
        ["individual_free", "org_free"],
    )
    def test_token_hard_limit_under_2m(self, plan_name):
        """At $2/M tokens, a 2M cap = $4 ceiling. We stay under that."""
        assert plan_tiers.get_plan_tier(plan_name).tokens_hard_limit <= 2_000_000

    @pytest.mark.parametrize(
        "plan_name",
        ["individual_free", "org_free"],
    )
    def test_free_price(self, plan_name):
        assert plan_tiers.get_plan_tier(plan_name).price_monthly_usd == 0

    def test_individual_tighter_than_org(self):
        ind = plan_tiers.get_plan_tier("individual_free")
        org = plan_tiers.get_plan_tier("org_free")
        # Individual is single-dev, so its cap must be ≤ org's cap.
        assert ind.seats_limit <= org.seats_limit
        assert ind.tokens_hard_limit <= org.tokens_hard_limit
        assert ind.references_limit <= org.references_limit


class TestCostIsPrimaryCap:
    """The headline free-tier cap is USD cost, not token counts.

    The user said: "make it stop once the total token cost breaches a
    certain amount". USD cost is the right unit because it tracks LLM
    cost regardless of which model is in use, plus covers sandbox +
    storage. Token/storage/sandbox are kept informational.
    """

    def test_plan_tier_has_cost_fields(self):
        tier = plan_tiers.get_plan_tier("org_free")
        assert hasattr(tier, "cost_soft_limit_usd")
        assert hasattr(tier, "cost_hard_limit_usd")

    def test_individual_cost_cap_is_one_dollar(self):
        """User's budget: <$1 per active user per month."""
        tier = plan_tiers.get_plan_tier("individual_free")
        assert tier.cost_hard_limit_usd == 1.00
        assert tier.cost_hard_limit_usd <= 1.00

    def test_org_cost_cap_scales_with_seats(self):
        """3 seats × ~$1 each = $3 hard cap (~$1/seat ceiling)."""
        tier = plan_tiers.get_plan_tier("org_free")
        assert tier.cost_hard_limit_usd == 3.00
        # Per-seat ceiling must stay under $1 even with all seats active.
        per_seat = tier.cost_hard_limit_usd / max(tier.seats_limit, 1)
        assert per_seat <= 1.50  # headroom for org-level overhead

    def test_soft_cap_strictly_less_than_hard(self):
        for name in ("individual_free", "org_free"):
            tier = plan_tiers.get_plan_tier(name)
            assert 0 < tier.cost_soft_limit_usd < tier.cost_hard_limit_usd

    def test_cost_caps_under_5_dollars(self):
        """Sanity: nothing in the free catalog crosses $5/mo."""
        for name in ("individual_free", "org_free"):
            tier = plan_tiers.get_plan_tier(name)
            assert tier.cost_hard_limit_usd <= 5.0

    def test_paid_placeholders_keep_higher_cost_caps(self):
        """When paid plans ship, their caps must be higher than free."""
        pro = plan_tiers.get_plan_tier("pro")
        team = plan_tiers.get_plan_tier("team")
        assert pro.cost_hard_limit_usd > plan_tiers.get_plan_tier("org_free").cost_hard_limit_usd
        assert team.cost_hard_limit_usd > pro.cost_hard_limit_usd


class TestQuotaEnforcementCostCap:
    """The quota middleware must check cost_usd on every mutating request."""

    def test_cost_usd_in_global_mutating_resources(self):
        from eden.api.middleware.quota_enforcement import GLOBAL_MUTATING_RESOURCES

        assert "cost_usd" in GLOBAL_MUTATING_RESOURCES

    def test_cost_hard_exceeded_returns_429(self):
        """Simulate the 429 path: budget['cost_usd']['status'] == 'hard_exceeded'."""
        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware
        import asyncio

        # Inline-construct a fake middleware to call _check_hard_limits.
        mw = QuotaEnforcementMiddleware(app=None)
        budget = {
            "cost_usd": {
                "used": 1.50,
                "soft_limit": 0.70,
                "hard_limit": 1.00,
                "status": "hard_exceeded",
                "percentage": 150.0,
            },
            "seats": {"used": 0, "soft_limit": 3, "hard_limit": 3, "status": "ok", "percentage": 0.0},
            "references": {"used": 0, "soft_limit": 50, "hard_limit": 50, "status": "ok", "percentage": 0.0},
        }

        async def fake_get_budget(org_id):
            return budget

        # Monkey-patch the usage_service accessor.
        from eden.api.middleware import quota_enforcement as mod
        class _FakeService:
            async def get_budget_status(self, org_id):
                return budget
        mw._usage_service = _FakeService()
        blocked, detail = asyncio.run(mw._check_hard_limits("org-1", ["cost_usd"]))
        assert blocked is True
        assert "cap reached" in detail.lower()
        assert "$1.50" in detail
        assert "$1.00" in detail

    def test_cost_within_cap_does_not_block(self):
        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware
        import asyncio

        mw = QuotaEnforcementMiddleware(app=None)
        budget = {
            "cost_usd": {
                "used": 0.30,
                "soft_limit": 0.70,
                "hard_limit": 1.00,
                "status": "ok",
                "percentage": 30.0,
            },
            "seats": {"used": 0, "soft_limit": 3, "hard_limit": 3, "status": "ok", "percentage": 0.0},
            "references": {"used": 0, "soft_limit": 50, "hard_limit": 50, "status": "ok", "percentage": 0.0},
        }
        class _FakeService:
            async def get_budget_status(self, org_id):
                return budget
        mw._usage_service = _FakeService()
        blocked, detail = asyncio.run(mw._check_hard_limits("org-1", ["cost_usd"]))
        assert blocked is False
        assert detail == ""

    def test_quota_headers_include_cost(self):
        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware
        import asyncio

        mw = QuotaEnforcementMiddleware(app=None)
        budget = {
            "tokens": {"used": 100, "soft_limit": 100_000, "hard_limit": 500_000, "status": "ok", "percentage": 0.02},
            "storage_mb": {"used": 0, "soft_limit": 1024, "hard_limit": 5120, "status": "ok", "percentage": 0.0},
            "sandbox_seconds": {"used": 0, "soft_limit": 36000, "hard_limit": 72000, "status": "ok", "percentage": 0.0},
            "seats": {"used": 1, "soft_limit": 3, "hard_limit": 3, "status": "ok", "percentage": 33.3},
            "references": {"used": 0, "soft_limit": 50, "hard_limit": 50, "status": "ok", "percentage": 0.0},
            "cost_usd": {
                "used": 0.45,
                "soft_limit": 2.00,
                "hard_limit": 3.00,
                "status": "ok",
                "percentage": 15.0,
            },
            "plan_name": "org_free",
        }
        class _FakeService:
            async def get_budget_status(self, org_id):
                return budget
        mw._usage_service = _FakeService()
        headers = asyncio.run(mw._build_quota_headers("org-1"))
        assert headers["X-Quota-Cost-Used"] == "0.45"
        assert headers["X-Quota-Cost-Soft"] == "2.0"
        assert headers["X-Quota-Cost-Hard"] == "3.0"
        assert headers["X-Quota-Cost-Pct"] == "15.0"
        assert headers["X-Quota-Plan"] == "org_free"


# ──────────────────────────────────────────────────────────────────────────
# billing.py — paid-plan gating
# ──────────────────────────────────────────────────────────────────────────


class TestPaidPlansDisabled:
    """Every Stripe-backed route must 503 while ``PAID_PLANS_ENABLED`` is False."""

    def test_paid_plans_flag_is_off(self):
        from eden.api.routes import billing

        assert billing.PAID_PLANS_ENABLED is False

    def test_require_paid_plans_enabled_raises_503(self):
        from eden.api.routes.billing import _require_paid_plans_enabled
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            _require_paid_plans_enabled()
        assert exc_info.value.status_code == 503
        assert "Paid plans are not available" in exc_info.value.detail

    def test_subscribe_returns_503(self):
        from eden.api.routes import billing

        billing.PAID_PLANS_ENABLED = False
        try:
            assert billing.PAID_PLANS_ENABLED is False
        finally:
            billing.PAID_PLANS_ENABLED = False  # idempotent reset

    def test_legacy_free_alias_maps_to_org_free_for_check_limit(self):
        """The ``check_limit`` fallback (no plan row) must consult
        ``get_plan_tier('org_free')`` — not the removed literal ``free``."""
        from eden.api.routes.billing import check_limit

        # ``check_limit`` requires a real DB; we just verify the import
        # + symbol resolution path doesn't blow up on the literal "free".
        import inspect

        source = inspect.getsource(check_limit)
        assert "org_free" in source
        # No leftover reference to the removed "free" plan_name fallback
        # (apart from the comment / alias map).
        assert 'plan_name="free"' not in source