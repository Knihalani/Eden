"""Phase 4.2 — Data Layer Foundation.

Adds:
- usage_events          : per-tenant granular usage metering
- invoices              : billing invoice tracking
- org_resource_limits   : per-tenant resource quotas (jobs, tokens, storage)
- Row-level security (RLS) policies on all tenant-scoped tables
- Tenant isolation enforcement functions

Revision ID: 002
Revises: 001
Create Date: 2026-05-29 00:00:00.000000

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ========================================================================
    # Usage Events — granular metering per tenant
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS usage_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            event_type TEXT NOT NULL,  -- 'llm_call', 'job_start', 'job_complete', 'storage', 'sandbox'
            resource TEXT NOT NULL,     -- 'tokens', 'jobs', 'storage_mb', 'sandbox_seconds'
            quantity NUMERIC(18, 6) NOT NULL DEFAULT 0,  -- supports fractional tokens
            unit TEXT NOT NULL,         -- 'tokens', 'count', 'mb', 'seconds'
            model TEXT,                 -- LLM model slug (for llm_call events)
            cost_usd NUMERIC(18, 6),    -- estimated cost in USD
            metadata JSONB DEFAULT '{}',
            correlation_id TEXT,        -- links to request tracing
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_usage_events_org ON usage_events (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events (org_id, event_type)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_usage_events_resource ON usage_events (org_id, resource, created_at)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events (created_at DESC)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_usage_events_correlation ON usage_events (correlation_id)")

    # ========================================================================
    # Invoices — billing invoice tracking
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS invoices (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            stripe_invoice_id TEXT UNIQUE,
            stripe_subscription_id TEXT,
            amount_due NUMERIC(18, 2) NOT NULL DEFAULT 0,    -- in cents internally; display /100
            amount_paid NUMERIC(18, 2) NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'usd',
            status TEXT NOT NULL DEFAULT 'draft',  -- draft, open, paid, void, uncollectible
            period_start TIMESTAMPTZ,
            period_end TIMESTAMPTZ,
            hosted_invoice_url TEXT,
            invoice_pdf_url TEXT,
            metadata JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (org_id, status)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_invoices_stripe ON invoices (stripe_invoice_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_invoices_period ON invoices (period_start, period_end)")

    # ========================================================================
    # Org Resource Limits — per-tenant quota enforcement
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_resource_limits (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

            -- Soft / hard limits per resource
            jobs_soft_limit INT NOT NULL DEFAULT 100,
            jobs_hard_limit INT NOT NULL DEFAULT 200,
            tokens_soft_limit INT NOT NULL DEFAULT 1000000,   -- 1M tokens
            tokens_hard_limit INT NOT NULL DEFAULT 2000000,   -- 2M tokens
            storage_mb_soft_limit INT NOT NULL DEFAULT 1024,    -- 1 GB
            storage_mb_hard_limit INT NOT NULL DEFAULT 5120,    -- 5 GB
            sandbox_seconds_soft_limit INT NOT NULL DEFAULT 3600,
            sandbox_seconds_hard_limit INT NOT NULL DEFAULT 7200,

            -- Rate limiting per tier
            requests_per_minute INT NOT NULL DEFAULT 60,
            requests_per_hour INT NOT NULL DEFAULT 1000,
            concurrent_jobs INT NOT NULL DEFAULT 3,

            -- Usage counters (updated periodically)
            jobs_used INT NOT NULL DEFAULT 0,
            tokens_used INT NOT NULL DEFAULT 0,
            storage_mb_used INT NOT NULL DEFAULT 0,
            sandbox_seconds_used INT NOT NULL DEFAULT 0,

            -- Plan linkage
            plan_name TEXT NOT NULL DEFAULT 'free',
            effective_from TIMESTAMPTZ DEFAULT NOW(),
            effective_until TIMESTAMPTZ,

            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),

            UNIQUE(org_id, effective_from)
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_org_limits_org ON org_resource_limits (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_org_limits_plan ON org_resource_limits (plan_name)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_org_limits_effective ON org_resource_limits (org_id, effective_from)")

    # ========================================================================
    # Row-Level Security (RLS) Policies
    # ========================================================================

    # Enable RLS on tenant-scoped tables
    for table in (
        "jobs",
        "skills",
        "exploits",
        "graph_entities",
        "code_references",
        "checkpoint_blobs",
        "specs",
        "usage_events",
        "invoices",
        "org_resource_limits",
    ):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        # Force RLS for table owners too (prevents accidental superuser bypass in app)
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")

    # ------------------------------------------------------------------
    # Tenant isolation policy for jobs
    # ------------------------------------------------------------------
    op.execute("""
        CREATE POLICY tenant_isolation_jobs ON jobs
        FOR ALL
        TO PUBLIC
        USING (
            org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID
            OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
            OR current_setting('app.current_org_id', true) IS NULL
        )
    """)

    # ------------------------------------------------------------------
    # Tenant isolation policy for skills
    # ------------------------------------------------------------------
    op.execute("""
        CREATE POLICY tenant_isolation_skills ON skills
        FOR ALL
        TO PUBLIC
        USING (
            org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID
            OR org_id IS NULL
            OR current_setting('app.current_org_id', true) IS NULL
        )
    """)

    # ------------------------------------------------------------------
    # Tenant isolation policy for exploits
    # ------------------------------------------------------------------
    op.execute("""
        CREATE POLICY tenant_isolation_exploits ON exploits
        FOR ALL
        TO PUBLIC
        USING (
            org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID
            OR org_id IS NULL
            OR current_setting('app.current_org_id', true) IS NULL
        )
    """)

    # ------------------------------------------------------------------
    # Tenant isolation policy for graph_entities
    # ------------------------------------------------------------------
    op.execute("""
        CREATE POLICY tenant_isolation_graph_entities ON graph_entities
        FOR ALL
        TO PUBLIC
        USING (
            org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID
            OR org_id IS NULL
            OR current_setting('app.current_org_id', true) IS NULL
        )
    """)

    # ------------------------------------------------------------------
    # Tenant isolation policy for code_references
    # ------------------------------------------------------------------
    op.execute("""
        CREATE POLICY tenant_isolation_code_references ON code_references
        FOR ALL
        TO PUBLIC
        USING (
            org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID
            OR current_setting('app.current_org_id', true) IS NULL
        )
    """)

    # ------------------------------------------------------------------
    # Tenant isolation policy for checkpoint_blobs (via jobs)
    # ------------------------------------------------------------------
    op.execute("""
        CREATE POLICY tenant_isolation_checkpoint_blobs ON checkpoint_blobs
        FOR ALL
        TO PUBLIC
        USING (
            job_id IN (
                SELECT job_id FROM jobs
                WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID
                   OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
                   OR current_setting('app.current_org_id', true) IS NULL
            )
            OR current_setting('app.current_org_id', true) IS NULL
        )
    """)

    # ------------------------------------------------------------------
    # Tenant isolation policy for specs
    # ------------------------------------------------------------------
    op.execute("""
        CREATE POLICY tenant_isolation_specs ON specs
        FOR ALL
        TO PUBLIC
        USING (
            org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID
            OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::UUID
            OR current_setting('app.current_org_id', true) IS NULL
        )
    """)

    # ------------------------------------------------------------------
    # Tenant isolation policy for usage_events
    # ------------------------------------------------------------------
    op.execute("""
        CREATE POLICY tenant_isolation_usage_events ON usage_events
        FOR ALL
        TO PUBLIC
        USING (
            org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID
            OR current_setting('app.current_org_id', true) IS NULL
        )
    """)

    # ------------------------------------------------------------------
    # Tenant isolation policy for invoices
    # ------------------------------------------------------------------
    op.execute("""
        CREATE POLICY tenant_isolation_invoices ON invoices
        FOR ALL
        TO PUBLIC
        USING (
            org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID
            OR current_setting('app.current_org_id', true) IS NULL
        )
    """)

    # ------------------------------------------------------------------
    # Tenant isolation policy for org_resource_limits
    # ------------------------------------------------------------------
    op.execute("""
        CREATE POLICY tenant_isolation_org_resource_limits ON org_resource_limits
        FOR ALL
        TO PUBLIC
        USING (
            org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID
            OR current_setting('app.current_org_id', true) IS NULL
        )
    """)

    # ========================================================================
    # Helper function: set tenant context for RLS
    # ========================================================================
    op.execute("""
        CREATE OR REPLACE FUNCTION set_tenant_context(
            p_org_id UUID,
            p_user_id UUID DEFAULT NULL
        )
        RETURNS void
        LANGUAGE plpgsql
        SECURITY DEFINER
        AS $$
        BEGIN
            PERFORM set_config('app.current_org_id', p_org_id::text, true);
            IF p_user_id IS NOT NULL THEN
                PERFORM set_config('app.current_user_id', p_user_id::text, true);
            END IF;
        END;
        $$
    """)

    # ========================================================================
    # Helper function: clear tenant context
    # ========================================================================
    op.execute("""
        CREATE OR REPLACE FUNCTION clear_tenant_context()
        RETURNS void
        LANGUAGE plpgsql
        SECURITY DEFINER
        AS $$
        BEGIN
            PERFORM set_config('app.current_org_id', '', true);
            PERFORM set_config('app.current_user_id', '', true);
        END;
        $$
    """)

    # ========================================================================
    # Trigger: auto-update updated_at for new tables
    # ========================================================================
    for table in ("usage_events", "invoices", "org_resource_limits"):
        op.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_trigger
                    WHERE tgname = '{table}_updated_at'
                ) THEN
                    CREATE TRIGGER {table}_updated_at
                        BEFORE UPDATE ON {table}
                        FOR EACH ROW
                        EXECUTE FUNCTION update_updated_at();
                END IF;
            END $$;
        """)

    # ========================================================================
    # Seed default resource limits for existing orgs
    # ========================================================================
    op.execute("""
        INSERT INTO org_resource_limits (org_id, plan_name, jobs_soft_limit, jobs_hard_limit)
        SELECT id, 'free', 20, 50
        FROM organizations
        ON CONFLICT (org_id, effective_from) DO NOTHING
    """)


def downgrade() -> None:
    # Drop RLS policies first
    tables_with_policies = (
        "jobs", "skills", "exploits", "graph_entities",
        "code_references", "checkpoint_blobs", "specs",
        "usage_events", "invoices", "org_resource_limits",
    )
    for table in tables_with_policies:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation_{table} ON {table}")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    # Drop helper functions
    op.execute("DROP FUNCTION IF EXISTS set_tenant_context(UUID, UUID)")
    op.execute("DROP FUNCTION IF EXISTS set_tenant_context(UUID)")
    op.execute("DROP FUNCTION IF EXISTS clear_tenant_context()")

    # Drop new tables in reverse dependency order
    op.execute("DROP TABLE IF EXISTS org_resource_limits CASCADE")
    op.execute("DROP TABLE IF EXISTS invoices CASCADE")
    op.execute("DROP TABLE IF EXISTS usage_events CASCADE")
