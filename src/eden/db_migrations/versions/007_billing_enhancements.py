"""007_billing_enhancements

Revision ID: 007
Revises: 006_webhooks_and_idempotency
Create Date: 2026-05-30

Phase 5.2 — Adds per-job cost tracking, usage event performance indexes,
and org_plans enhancements for soft/hard limits and plan-tier features.
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Add per-job cost tracking columns ──────────────────────────
    op.execute("""
        ALTER TABLE jobs
        ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(18,6) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tokens_used INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS sandbox_seconds INTEGER DEFAULT 0
    """)

    # Index for cost attribution queries
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_jobs_org_id ON jobs (org_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_jobs_org_created ON jobs (org_id, created_at DESC)
    """)

    # Backfill org_id from job metadata (best-effort)
    op.execute("""
        UPDATE jobs
        SET org_id = (
            SELECT o.id FROM organizations o
            JOIN org_members om ON om.org_id = o.id
            WHERE om.user_id = jobs.user_id
            LIMIT 1
        )
        WHERE org_id IS NULL
    """)

    # ── 2. Enhance org_plans with soft/hard limits ────────────────────
    op.execute("""
        ALTER TABLE org_plans
        ADD COLUMN IF NOT EXISTS tokens_soft_limit INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tokens_hard_limit INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS storage_mb_soft_limit INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS storage_mb_hard_limit INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS sandbox_seconds_soft_limit INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS sandbox_seconds_hard_limit INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '[]'::jsonb
    """)

    # ── 3. Usage event performance indexes ─────────────────────────────
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_usage_events_org_created
        ON usage_events (org_id, created_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_usage_events_org_type_created
        ON usage_events (org_id, event_type, created_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_usage_events_org_resource_created
        ON usage_events (org_id, resource, created_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_usage_events_correlation
        ON usage_events (correlation_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_usage_events_model
        ON usage_events (org_id, model, created_at DESC)
        WHERE model IS NOT NULL
    """)

    # ── 4. Add org_resource_limits plan_name if missing ───────────────
    op.execute("""
        ALTER TABLE org_resource_limits
        ADD COLUMN IF NOT EXISTS plan_name TEXT DEFAULT 'free'
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_org_resource_limits_plan
        ON org_resource_limits (plan_name)
    """)

    # ── 5. Invoice enhancements ──────────────────────────────────────
    op.execute("""
        ALTER TABLE invoices
        ADD COLUMN IF NOT EXISTS amount_due NUMERIC(18,6),
        ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,6),
        ADD COLUMN IF NOT EXISTS billing_reason TEXT
    """)

    # ── 6. Stripe subscriptions status enum validation (soft) ────────
    # We keep TEXT but add a CHECK constraint for known statuses.
    # PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`, so guard with a check.
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'chk_stripe_sub_status'
                  AND conrelid = 'stripe_subscriptions'::regclass
            ) THEN
                ALTER TABLE stripe_subscriptions
                ADD CONSTRAINT chk_stripe_sub_status
                CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'cancelled'));
            END IF;
        END
        $$;
    """)


def downgrade() -> None:
    # Remove job columns
    op.execute("""
        ALTER TABLE jobs
        DROP COLUMN IF EXISTS org_id,
        DROP COLUMN IF EXISTS cost_usd,
        DROP COLUMN IF EXISTS tokens_used,
        DROP COLUMN IF EXISTS sandbox_seconds
    """)
    op.execute("DROP INDEX IF EXISTS idx_jobs_org_id")
    op.execute("DROP INDEX IF EXISTS idx_jobs_org_created")

    # Remove org_plans columns
    op.execute("""
        ALTER TABLE org_plans
        DROP COLUMN IF EXISTS tokens_soft_limit,
        DROP COLUMN IF EXISTS tokens_hard_limit,
        DROP COLUMN IF EXISTS storage_mb_soft_limit,
        DROP COLUMN IF EXISTS storage_mb_hard_limit,
        DROP COLUMN IF EXISTS sandbox_seconds_soft_limit,
        DROP COLUMN IF EXISTS sandbox_seconds_hard_limit,
        DROP COLUMN IF EXISTS features
    """)

    # Remove usage event indexes
    op.execute("DROP INDEX IF EXISTS idx_usage_events_org_created")
    op.execute("DROP INDEX IF EXISTS idx_usage_events_org_type_created")
    op.execute("DROP INDEX IF EXISTS idx_usage_events_org_resource_created")
    op.execute("DROP INDEX IF EXISTS idx_usage_events_correlation")
    op.execute("DROP INDEX IF EXISTS idx_usage_events_model")

    # Remove org_resource_limits plan_name
    op.execute("""
        ALTER TABLE org_resource_limits
        DROP COLUMN IF EXISTS plan_name
    """)
    op.execute("DROP INDEX IF EXISTS idx_org_resource_limits_plan")

    # Remove invoice columns
    op.execute("""
        ALTER TABLE invoices
        DROP COLUMN IF EXISTS amount_due,
        DROP COLUMN IF EXISTS tax_amount,
        DROP COLUMN IF EXISTS billing_reason
    """)

    # Remove stripe subscriptions check
    op.execute("""
        ALTER TABLE stripe_subscriptions
        DROP CONSTRAINT IF EXISTS chk_stripe_sub_status
    """)
