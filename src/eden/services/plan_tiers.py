"""Plan tier definitions and feature gates for Eden.

Maps plan names to their resource limits and available features.
This is the single source of truth for all billing-tier logic.

**Free-only mode (June 2026).** Eden is in early stage; only two free
plans are exposed:

- ``individual_free`` — auto-assigned to a user's auto-created personal
  org (one seat, single dev). $1/mo cost ceiling.
- ``org_free`` — assigned to every multi-member org the user creates or
  is invited to. $3/mo cost ceiling (= ~$1/seat × 3 seats).

The primary free-tier cap is **total token cost in USD** (see
``cost_soft_limit_usd`` / ``cost_hard_limit_usd``), not abstract token
counts. Tokens/storage/sandbox still track for transparency but are
NOT the enforcement lever — the user said "make it stop once the total
token cost breaches a certain amount", and USD cost is the right unit
because it tracks LLM cost regardless of which model is in use.

Paid tier definitions (``pro`` / ``team`` / ``enterprise``) are kept as
:data:`_PAID_TIERS_PLACEHOLDER` for forward compatibility but are NOT
routed, billed, or surfaced in the UI.
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class PlanTier:
    """Defines a single plan tier with its limits and features."""

    name: str
    display_name: str
    price_monthly_usd: int | None
    # Primary enforcement lever: total USD cost per month across all
    # usage_events (LLM tokens, sandbox seconds, storage). When
    # ``cost_hard_limit_usd`` is breached the quota middleware blocks
    # further spend-bearing requests with HTTP 429.
    cost_soft_limit_usd: float
    cost_hard_limit_usd: float
    # Secondary limits — tracked for transparency but not the primary
    # enforcement lever (the user wanted cost, not token counts).
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
#
# Ponytail: cost caps are the headline. $1/active-user/month ceiling per
# the user's stated budget. ``org_free`` is $3 because 3 seats × ~$1 each;
# an idle seat costs $0 (no usage_events accumulate). Soft caps fire a
# warning header + UI banner but don't block; hard caps 429.

_FREE_FEATURES = frozenset({"api_access", "community_support"})

PLAN_TIERS: dict[str, PlanTier] = {
    "individual_free": PlanTier(
        name="individual_free",
        display_name="Personal",
        price_monthly_usd=0,
        cost_soft_limit_usd=0.70,
        cost_hard_limit_usd=1.00,    # ≈ $1/active-user/month ceiling
        seats_limit=1,
        references_limit=10,
        jobs_soft_limit=20,
        jobs_hard_limit=50,
        tokens_soft_limit=100_000,
        tokens_hard_limit=500_000,
        storage_mb_soft_limit=1_024,     # 1 GB
        storage_mb_hard_limit=5_120,     # 5 GB
        sandbox_seconds_soft_limit=36_000,    # 10h
        sandbox_seconds_hard_limit=72_000,    # 20h
        requests_per_minute=30,
        requests_per_hour=1_000,
        concurrent_jobs=1,
        features=set(_FREE_FEATURES),
    ),
    "org_free": PlanTier(
        name="org_free",
        display_name="Organization",
        price_monthly_usd=0,
        cost_soft_limit_usd=2.00,
        cost_hard_limit_usd=3.00,    # ≈ $1/seat × 3 seats
        seats_limit=3,
        references_limit=50,
        jobs_soft_limit=40,
        jobs_hard_limit=100,
        tokens_soft_limit=200_000,
        tokens_hard_limit=1_000_000,
        storage_mb_soft_limit=2_048,      # 2 GB
        storage_mb_hard_limit=10_240,     # 10 GB
        sandbox_seconds_soft_limit=72_000,    # 20h
        sandbox_seconds_hard_limit=144_000,   # 40h
        requests_per_minute=60,
        requests_per_hour=2_000,
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
        cost_soft_limit_usd=20.00,
        cost_hard_limit_usd=40.00,
        seats_limit=20,
        references_limit=200,
        jobs_soft_limit=100,
        jobs_hard_limit=200,
        tokens_soft_limit=2_000_000,
        tokens_hard_limit=4_000_000,
        storage_mb_soft_limit=51_200,    # 50 GB
        storage_mb_hard_limit=102_400,   # 100 GB
        sandbox_seconds_soft_limit=360_000,   # 100h
        sandbox_seconds_hard_limit=720_000,   # 200h
        requests_per_minute=300,
        requests_per_hour=10_000,
        concurrent_jobs=5,
        features={
            "api_access",
            "webhooks",
            "email_support",
            "advanced_analytics",
            "team_management",
        },
    ),
    "team": PlanTier(
        name="team",
        display_name="Growth",
        price_monthly_usd=299,
        cost_soft_limit_usd=120.00,
        cost_hard_limit_usd=240.00,
        seats_limit=100,
        references_limit=1_000,
        jobs_soft_limit=500,
        jobs_hard_limit=1_000,
        tokens_soft_limit=10_000_000,
        tokens_hard_limit=20_000_000,
        storage_mb_soft_limit=256_000,   # 250 GB
        storage_mb_hard_limit=512_000,   # 500 GB
        sandbox_seconds_soft_limit=1_800_000,  # 500h
        sandbox_seconds_hard_limit=3_600_000,  # 1000h
        requests_per_minute=1_500,
        requests_per_hour=50_000,
        concurrent_jobs=20,
        features={
            "api_access",
            "webhooks",
            "priority_support",
            "advanced_analytics",
            "team_management",
            "sso",
            "audit_logs_90d",
            "data_residency",
            "custom_models",
        },
    ),
    "enterprise": PlanTier(
        name="enterprise",
        display_name="Enterprise",
        price_monthly_usd=None,  # custom
        cost_soft_limit_usd=0.0,
        cost_hard_limit_usd=0.0,    # 0 = uncapped (custom contract)
        seats_limit=0,  # unlimited (enforced elsewhere)
        references_limit=0,  # unlimited
        jobs_soft_limit=2_000,
        jobs_hard_limit=5_000,
        tokens_soft_limit=50_000_000,
        tokens_hard_limit=100_000_000,
        storage_mb_soft_limit=1_048_576,  # 1 TB
        storage_mb_hard_limit=2_097_152,  # 2 TB
        sandbox_seconds_soft_limit=7_200_000,  # 2000h
        sandbox_seconds_hard_limit=14_400_000,  # 4000h
        requests_per_minute=5_000,
        requests_per_hour=200_000,
        concurrent_jobs=100,
        features={
            "api_access",
            "webhooks",
            "dedicated_support",
            "advanced_analytics",
            "team_management",
            "sso",
            "scim",
            "audit_logs_1y",
            "data_residency",
            "custom_models",
            "dedicated_workers",
            "sla",
            "professional_services",
        },
    ),
}

# Backwards-compatible aliases. Maps legacy plan names (from pre-June-2026
# org_plans rows or Stripe metadata) to the closest current free tier so
# legacy data doesn't break reads.
LEGACY_PLAN_ALIASES: dict[str, str] = {
    "free": "org_free",
    "starter": "pro",
}


def get_plan_tier(plan_name: str) -> PlanTier:
    """Resolve a plan name to its tier definition.

    Resolution order: aliases → free tiers → paid placeholders → default
    to ``org_free``. Unknown plan names fall back to ``org_free`` so a
    misconfigured row can never deny service.
    """
    if not plan_name:
        return PLAN_TIERS["org_free"]
    normalized = LEGACY_PLAN_ALIASES.get(plan_name, plan_name)
    if normalized in PLAN_TIERS:
        return PLAN_TIERS[normalized]
    if normalized in _PAID_TIERS_PLACEHOLDER:
        return _PAID_TIERS_PLACEHOLDER[normalized]
    return PLAN_TIERS["org_free"]


def has_feature(plan_name: str, feature: str) -> bool:
    """Check whether a given plan tier includes a feature."""
    return get_plan_tier(plan_name).has_feature(feature)


def list_public_plan_tiers() -> list[PlanTier]:
    """Return only the tiers exposed to new signups + the billing UI.

    Free-only mode: paid tiers are NOT in this list. When paid plans
    ship, move them back into :data:`PLAN_TIERS` and remove the
    placeholder dict.
    """
    return list(PLAN_TIERS.values())


def list_plan_tiers() -> list[PlanTier]:
    """Return all defined plan tiers (free + legacy paid placeholders)."""
    return list(PLAN_TIERS.values()) + list(_PAID_TIERS_PLACEHOLDER.values())


def get_feature_list() -> list[str]:
    """Return the union of all feature names across free tiers."""
    features: set[str] = set()
    for tier in PLAN_TIERS.values():
        features |= tier.features
    return sorted(features)


def default_plan_name() -> str:
    """The plan name to assign to a newly created org."""
    return "org_free"


def individual_plan_name() -> str:
    """The plan name to assign to a user's auto-created personal org."""
    return "individual_free"
