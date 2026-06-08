"""Plan tier definitions and feature gates for Eden billing.

Maps plan names to their resource limits and available features.
This is the single source of truth for all billing-tier logic.
"""

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class PlanTier:
    """Defines a single plan tier with its limits and features."""

    name: str
    display_name: str
    price_monthly_usd: Optional[int]
    seats_limit: int
    references_limit: int
    jobs_soft_limit: int
    jobs_hard_limit: int
    tokens_soft_limit: int  # per month
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
# Plan tier catalogue — matches the multi-tenancy billing architecture doc
# ──────────────────────────────────────────────────────────────────────────

PLAN_TIERS: dict[str, PlanTier] = {
    "free": PlanTier(
        name="free",
        display_name="Personal",
        price_monthly_usd=0,
        seats_limit=1,
        references_limit=10,
        jobs_soft_limit=20,
        jobs_hard_limit=50,
        tokens_soft_limit=100_000,
        tokens_hard_limit=500_000,
        storage_mb_soft_limit=1_024,     # 1 GB
        storage_mb_hard_limit=5_120,     # 5 GB
        sandbox_seconds_soft_limit=36_000,   # 10h
        sandbox_seconds_hard_limit=72_000,    # 20h
        requests_per_minute=30,
        requests_per_hour=1_000,
        concurrent_jobs=1,
        features={"api_access", "community_support"},
    ),
    "pro": PlanTier(
        name="pro",
        display_name="Team",
        price_monthly_usd=49,
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

# Backwards-compatible aliases for legacy plan names used in Stripe metadata
LEGACY_PLAN_ALIASES: dict[str, str] = {
    "starter": "pro",
}


def get_plan_tier(plan_name: str) -> PlanTier:
    """Resolve a plan name to its tier definition.

    Falls back to the free tier for unknown plan names.
    Handles legacy plan-name aliases.
    """
    normalized = LEGACY_PLAN_ALIASES.get(plan_name, plan_name)
    return PLAN_TIERS.get(normalized, PLAN_TIERS["free"])


def has_feature(plan_name: str, feature: str) -> bool:
    """Check whether a given plan tier includes a feature."""
    return get_plan_tier(plan_name).has_feature(feature)


def list_plan_tiers() -> list[PlanTier]:
    """Return all defined plan tiers in ascending price order."""
    return list(PLAN_TIERS.values())


def get_feature_list() -> list[str]:
    """Return the union of all feature names across all tiers."""
    features: set[str] = set()
    for tier in PLAN_TIERS.values():
        features |= tier.features
    return sorted(features)
