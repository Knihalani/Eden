"""Plan tier definitions and feature gates for Eden.

Maps plan names to their resource limits and available features.
This is the single source of truth for all billing-tier logic.

**Free-only mode (July 2026).** Eden is in public beta; only two free
plans are exposed:

- ``individual_free`` — personal workspace (1 seat).
- ``org_free`` — multi-member workspace (3 seats).

The primary free-tier cap is **credits** (not raw USD in the UI).

- ``CREDITS_PER_USD = 100`` → 1 credit ≈ $0.01 Eden COGS
- Free hard cap = **400 credits ≈ $4 / month** — enough to try the
  product, not enough for COGS to spiral before monetization
- Soft cap = **320 credits ≈ $3.20** (warn; do not block)

USD fields remain on the tier for FinOps / COGS accounting and stay
in sync with credits (``cost_*_usd = credits_* / CREDITS_PER_USD``).

Paid tier definitions (``pro`` / ``team`` / ``enterprise``) are kept as
:data:`_PAID_TIERS_PLACEHOLDER` for forward compatibility but are NOT
routed, billed, or surfaced in the UI.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# 1 credit = $0.01 of Eden platform COGS (LLM, sandbox, etc.).
CREDITS_PER_USD: int = 100

# Free-beta monthly grant — enough to try the product, not enough to burn.
FREE_TIER_CREDITS_SOFT: int = 320   # ≈ $3.20
FREE_TIER_CREDITS_HARD: int = 400   # ≈ $4 MAX


def usd_to_credits(usd: float) -> float:
    """Convert USD COGS into credits (100 credits = $1)."""
    return round(float(usd or 0.0) * CREDITS_PER_USD, 2)


def credits_to_usd(credits: float) -> float:
    """Convert credits back to USD COGS."""
    return round(float(credits or 0.0) / CREDITS_PER_USD, 4)


@dataclass(frozen=True)
class PlanTier:
    """Defines a single plan tier with its limits and features."""

    name: str
    display_name: str
    price_monthly_usd: int | None
    # PRIMARY enforcement lever (credits). Quota middleware blocks when
    # monthly spend (usage_events + customer_cost_events) reaches
    # ``credits_hard_limit``.
    credits_soft_limit: int
    credits_hard_limit: int
    # USD mirrors of the credit caps (FinOps / COGS accounting).
    cost_soft_limit_usd: float
    cost_hard_limit_usd: float
    # Secondary limits — tracked for transparency; seats/refs still gate
    # invite/create flows. Tokens/storage/sandbox are informational under
    # the credit cap (raised high enough not to trip before ~$4).
    seats_limit: int
    references_limit: int
    jobs_soft_limit: int
    jobs_hard_limit: int
    tokens_soft_limit: int
    tokens_hard_limit: int
    storage_mb_soft_limit: int
    storage_mb_hard_limit: int
    sandbox_seconds_soft_limit: int
    sandbox_seconds_hard_limit: int
    requests_per_minute: int
    requests_per_hour: int
    concurrent_jobs: int
    features: set[str] = field(default_factory=set)

    def has_feature(self, feature: str) -> bool:
        """Check if this tier includes a given feature."""
        return feature in self.features


# ──────────────────────────────────────────────────────────────────────────
# Free plan catalogue — the only plans exposed right now
# ──────────────────────────────────────────────────────────────────────────

_FREE_FEATURES = frozenset({"api_access", "community_support"})

PLAN_TIERS: dict[str, PlanTier] = {
    "individual_free": PlanTier(
        name="individual_free",
        display_name="Personal",
        price_monthly_usd=0,
        credits_soft_limit=FREE_TIER_CREDITS_SOFT,
        credits_hard_limit=FREE_TIER_CREDITS_HARD,
        cost_soft_limit_usd=credits_to_usd(FREE_TIER_CREDITS_SOFT),
        cost_hard_limit_usd=credits_to_usd(FREE_TIER_CREDITS_HARD),
        seats_limit=1,
        references_limit=25,
        jobs_soft_limit=100,
        jobs_hard_limit=250,
        # Informational — sized so they don't trip before the $4 credit cap
        # at typical ~$2–5 / MTok blended rates.
        tokens_soft_limit=20_000_000,
        tokens_hard_limit=50_000_000,
        storage_mb_soft_limit=10_240,      # 10 GB
        storage_mb_hard_limit=51_200,      # 50 GB
        sandbox_seconds_soft_limit=360_000,   # 100h
        sandbox_seconds_hard_limit=720_000,   # 200h
        # Portal hubs fan out many GETs; 60 rpm rate-limited normal UI.
        requests_per_minute=300,
        requests_per_hour=8_000,
        concurrent_jobs=2,
        features=set(_FREE_FEATURES),
    ),
    "org_free": PlanTier(
        name="org_free",
        display_name="Organization",
        price_monthly_usd=0,
        credits_soft_limit=FREE_TIER_CREDITS_SOFT,
        credits_hard_limit=FREE_TIER_CREDITS_HARD,
        cost_soft_limit_usd=credits_to_usd(FREE_TIER_CREDITS_SOFT),
        cost_hard_limit_usd=credits_to_usd(FREE_TIER_CREDITS_HARD),
        seats_limit=3,
        references_limit=50,
        jobs_soft_limit=100,
        jobs_hard_limit=250,
        tokens_soft_limit=20_000_000,
        tokens_hard_limit=50_000_000,
        storage_mb_soft_limit=10_240,
        storage_mb_hard_limit=51_200,
        sandbox_seconds_soft_limit=360_000,
        sandbox_seconds_hard_limit=720_000,
        requests_per_minute=300,
        requests_per_hour=8_000,
        concurrent_jobs=2,
        features=set(_FREE_FEATURES),
    ),
}


# ──────────────────────────────────────────────────────────────────────────
# Paid tiers — NOT exposed, NOT routed, NOT billed. Kept so legacy rows
# in org_plans (from Stripe webhooks / pre-June-2026 signups) still
# resolve to sane limits if anything points at them.
# ──────────────────────────────────────────────────────────────────────────

_PAID_TIERS_PLACEHOLDER: dict[str, PlanTier] = {
    "pro": PlanTier(
        name="pro",
        display_name="Team",
        price_monthly_usd=49,
        credits_soft_limit=40_000,   # ≈ $400
        credits_hard_limit=50_000,   # ≈ $500
        cost_soft_limit_usd=400.0,
        cost_hard_limit_usd=500.0,
        seats_limit=20,
        references_limit=200,
        jobs_soft_limit=100,
        jobs_hard_limit=200,
        tokens_soft_limit=100_000_000,
        tokens_hard_limit=200_000_000,
        storage_mb_soft_limit=51_200,
        storage_mb_hard_limit=102_400,
        sandbox_seconds_soft_limit=360_000,
        sandbox_seconds_hard_limit=720_000,
        requests_per_minute=300,
        requests_per_hour=10_000,
        concurrent_jobs=5,
        features={
            "api_access",
            "community_support",
            "priority_support",
            "sso",
        },
    ),
    "team": PlanTier(
        name="team",
        display_name="Business",
        price_monthly_usd=149,
        credits_soft_limit=160_000,
        credits_hard_limit=200_000,
        cost_soft_limit_usd=1_600.0,
        cost_hard_limit_usd=2_000.0,
        seats_limit=50,
        references_limit=1_000,
        jobs_soft_limit=500,
        jobs_hard_limit=1_000,
        tokens_soft_limit=400_000_000,
        tokens_hard_limit=800_000_000,
        storage_mb_soft_limit=204_800,
        storage_mb_hard_limit=512_000,
        sandbox_seconds_soft_limit=1_440_000,
        sandbox_seconds_hard_limit=2_880_000,
        requests_per_minute=600,
        requests_per_hour=25_000,
        concurrent_jobs=10,
        features={
            "api_access",
            "community_support",
            "priority_support",
            "sso",
            "audit_log",
        },
    ),
    "enterprise": PlanTier(
        name="enterprise",
        display_name="Enterprise",
        price_monthly_usd=None,
        credits_soft_limit=0,   # 0 = uncapped
        credits_hard_limit=0,
        cost_soft_limit_usd=0.0,
        cost_hard_limit_usd=0.0,
        seats_limit=0,
        references_limit=0,
        jobs_soft_limit=0,
        jobs_hard_limit=0,
        tokens_soft_limit=0,
        tokens_hard_limit=0,
        storage_mb_soft_limit=0,
        storage_mb_hard_limit=0,
        sandbox_seconds_soft_limit=0,
        sandbox_seconds_hard_limit=0,
        requests_per_minute=2_000,
        requests_per_hour=100_000,
        concurrent_jobs=50,
        features={
            "api_access",
            "community_support",
            "priority_support",
            "sso",
            "audit_log",
            "dedicated_support",
        },
    ),
}


# Backwards-compatible aliases. Maps legacy plan names (from pre-June-2026
# org_plans rows or Stripe metadata) to the closest current free tier so
# legacy data doesn't break reads.
LEGACY_PLAN_ALIASES: dict[str, str] = {
    "free": "org_free",
    "starter": "pro",
    "business": "team",
}

_ALIASES = LEGACY_PLAN_ALIASES


def get_plan_tier(plan_name: str) -> PlanTier:
    """Resolve a plan name (or alias) to its :class:`PlanTier`.

    Unknown / empty names fall back to ``org_free`` so misconfigured
    rows never deny service.
    """
    if not plan_name:
        return PLAN_TIERS["org_free"]
    key = LEGACY_PLAN_ALIASES.get(plan_name, plan_name)
    if key in PLAN_TIERS:
        return PLAN_TIERS[key]
    if key in _PAID_TIERS_PLACEHOLDER:
        return _PAID_TIERS_PLACEHOLDER[key]
    return PLAN_TIERS["org_free"]


def has_feature(plan_name: str, feature: str) -> bool:
    """Convenience wrapper around :meth:`PlanTier.has_feature`."""
    return get_plan_tier(plan_name).has_feature(feature)


def list_public_plan_tiers() -> list[PlanTier]:
    """Tiers surfaced in the portal / ``/billing/plans`` catalogue."""
    return list(PLAN_TIERS.values())


def list_plan_tiers() -> list[PlanTier]:
    """All known tiers including paid placeholders."""
    return list(PLAN_TIERS.values()) + list(_PAID_TIERS_PLACEHOLDER.values())


def get_feature_list() -> list[str]:
    """Union of every feature flag across free tiers."""
    out: set[str] = set()
    for tier in PLAN_TIERS.values():
        out |= set(tier.features)
    return sorted(out)


def default_plan_name() -> str:
    """Plan assigned to every new multi-member org."""
    return "org_free"


def individual_plan_name() -> str:
    """Plan intended for a user's personal/auto-created workspace."""
    return "individual_free"
