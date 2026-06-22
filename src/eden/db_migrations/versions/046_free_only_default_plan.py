"""046 — Free-only default plan (June 2026).

Revision ID: 046
Revises: 045
Create Date: 2026-06-21

Eden is in early stage. Only free plans are exposed; every organization
gets ``org_free`` by default. This migration:

1. Adds ``is_personal`` to ``organizations`` so the portal can label a
   user's auto-personal workspace distinct from team orgs (the billing
   logic doesn't read this — it keys off ``org_resource_limits.plan_name``
   — but the UI does).

2. Backfills ``org_resource_limits`` for every existing org that has no
   row yet, populating it with ``plan_name='org_free'`` and the
   tier's per-dimension limits. This is the table the quota middleware
   reads.

3. Backfills ``org_plans`` with ``plan_name='org_free'`` for every org
   that has no row yet (used by the legacy billing route handlers).

4. Marks single-member orgs (``COUNT(org_members) = 1``) as ``is_personal``.
   New user-created orgs default to ``is_personal=false``.

No data is destroyed. Existing rows on paid plans (from legacy Stripe
subscriptions) are left untouched — they'll resolve via
``get_plan_tier``'s legacy-alias map.
"""

from __future__ import annotations

from alembic import op


revision = "046"
down_revision = "045"
branch_labels = None
depends_on = None


# Limits match ``eden.services.plan_tiers.PLAN_TIERS['org_free']``.
# Inlined as literals (instead of importing the dataclass) so the
# migration runs against the bare DB without the app importable.
_ORG_FREE_LIMITS = {
    "jobs_soft_limit": 40,
    "jobs_hard_limit": 100,
    "tokens_soft_limit": 200_000,
    "tokens_hard_limit": 1_000_000,
    "storage_mb_soft_limit": 2_048,      # 2 GB
    "storage_mb_hard_limit": 10_240,     # 10 GB
    "sandbox_seconds_soft_limit": 72_000,    # 20h
    "sandbox_seconds_hard_limit": 144_000,   # 40h
    "requests_per_minute": 60,
    "requests_per_hour": 2_000,
    "concurrent_jobs": 2,
}


def upgrade() -> None:
    # 1. ``is_personal`` flag on organizations.
    op.execute(
        """
        ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT false
        """
    )

    # 2. Backfill org_resource_limits for orgs with no row yet.
    op.execute(
        f"""
        INSERT INTO org_resource_limits (
            org_id,
            jobs_soft_limit, jobs_hard_limit,
            tokens_soft_limit, tokens_hard_limit,
            storage_mb_soft_limit, storage_mb_hard_limit,
            sandbox_seconds_soft_limit, sandbox_seconds_hard_limit,
            requests_per_minute, requests_per_hour, concurrent_jobs,
            plan_name,
            effective_from
        )
        SELECT
            o.id,
            {_ORG_FREE_LIMITS['jobs_soft_limit']},
            {_ORG_FREE_LIMITS['jobs_hard_limit']},
            {_ORG_FREE_LIMITS['tokens_soft_limit']},
            {_ORG_FREE_LIMITS['tokens_hard_limit']},
            {_ORG_FREE_LIMITS['storage_mb_soft_limit']},
            {_ORG_FREE_LIMITS['storage_mb_hard_limit']},
            {_ORG_FREE_LIMITS['sandbox_seconds_soft_limit']},
            {_ORG_FREE_LIMITS['sandbox_seconds_hard_limit']},
            {_ORG_FREE_LIMITS['requests_per_minute']},
            {_ORG_FREE_LIMITS['requests_per_hour']},
            {_ORG_FREE_LIMITS['concurrent_jobs']},
            'org_free',
            NOW()
        FROM organizations o
        LEFT JOIN org_resource_limits r ON r.org_id = o.id
        WHERE r.org_id IS NULL
        """
    )

    # 3. Backfill org_plans with org_free defaults.
    op.execute(
        """
        INSERT INTO org_plans (
            org_id, plan_name,
            seats_limit, references_limit, jobs_limit,
            seats_used, references_used, jobs_used,
            active, created_at, updated_at
        )
        SELECT
            o.id, 'org_free',
            3, 50, 40,
            0, 0, 0,
            true, NOW(), NOW()
        FROM organizations o
        LEFT JOIN org_plans p ON p.org_id = o.id AND p.active = true
        WHERE p.id IS NULL
        """
    )

    # 4. Mark single-member orgs as personal. Anything created by the
    # auto-personal-org webhook going forward is also is_personal=true;
    # user-created team orgs stay is_personal=false.
    op.execute(
        """
        UPDATE organizations o
        SET is_personal = true
        WHERE NOT o.is_personal
          AND (
            SELECT COUNT(*) FROM org_members om
            WHERE om.org_id = o.id
          ) = 1
        """
    )


def downgrade() -> None:
    # Leave the data; only drop the column we added. Rolling back the
    # backfill would be lossy (deleting org_plans / org_resource_limits
    # rows would break the quota middleware).
    op.execute(
        "ALTER TABLE organizations DROP COLUMN IF EXISTS is_personal"
    )