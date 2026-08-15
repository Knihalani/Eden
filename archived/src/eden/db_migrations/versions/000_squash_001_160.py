"""Squashed baseline — Eden schema from revisions 001 through 160.

This single revision replaces the 160 individual migration files that covered
the period from the initial schema (001) through migration 160
(signal_definitions partial index, 2026-08-xx).

Squash rationale (plan item 8.6 / W3-7):
  • 160 files deleted, 1 file added — identical net schema for fresh installs.
  • Existing deployed databases at revision ≥ 161 are unaffected: this file
    carries revision id ``160_signal_definitions_org_enabled_created`` (the same
    id migration 160 used), so migration 161's down_revision pointer is already
    correct and no re-stamp is required on prod.
  • Fresh installs: alembic applies this file first (down_revision=None), then
    continues with 161 → 171 as normal.

Revision ID: 160_signal_definitions_org_enabled_created
Revises: (none — this is the new base)
Create Date: 2026-08-12 (squash)
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from uuid import UUID
import logging

# ---------------------------------------------------------------------------
# Alembic revision identifiers
# ---------------------------------------------------------------------------
revision: str = "160_signal_definitions_org_enabled_created"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Build the full Eden schema as of revision 160.

    This is the cumulative DDL of migrations 001-160 applied in topological
    order. The body was generated mechanically from the individual upgrade()
    functions; no DDL was omitted.
    """
    # --- 001_initial_schema.py (rev 001) ---
    op.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    op.execute('CREATE EXTENSION IF NOT EXISTS "vector"')

    # ========================================================================
    # Users & Authentication
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            name TEXT NOT NULL,
            two_factor_enabled BOOLEAN DEFAULT FALSE,
            two_factor_secret TEXT,
            preferred_org_id UUID,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            last_login_at TIMESTAMPTZ
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_users_preferred_org ON users (preferred_org_id)")

    # ========================================================================
    # Organizations
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS organizations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            owner_id UUID NOT NULL REFERENCES users(id),
            settings JSONB DEFAULT '{}',
            two_factor_enforced BOOLEAN DEFAULT FALSE,
            domain_restriction_enforced BOOLEAN DEFAULT FALSE,
            archived_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_orgs_slug ON organizations (slug)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_orgs_owner ON organizations (owner_id)")

    # ========================================================================
    # Organization Members
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_members (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
            invited_by UUID REFERENCES users(id),
            joined_at TIMESTAMPTZ DEFAULT NOW(),
            last_active_at TIMESTAMPTZ,
            UNIQUE(org_id, user_id)
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members (user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_org_members_role ON org_members (org_id, role)")

    # ========================================================================
    # Jobs
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            job_id VARCHAR(255) UNIQUE NOT NULL,
            request JSONB NOT NULL,
            environment_class VARCHAR(50) NOT NULL,
            outcome_tier VARCHAR(20),
            status VARCHAR(50) NOT NULL,
            edp_history JSONB NOT NULL DEFAULT '[]',
            critic_decisions JSONB NOT NULL DEFAULT '[]',
            routing_history JSONB NOT NULL DEFAULT '[]',
            res JSONB,
            fact_check_report JSONB,
            code_history JSONB NOT NULL DEFAULT '[]',
            quality_reports JSONB NOT NULL DEFAULT '[]',
            verifier_report JSONB,
            tester_results JSONB,
            kb_reads JSONB NOT NULL DEFAULT '[]',
            agent_proposals JSONB NOT NULL DEFAULT '[]',
            quality_metrics JSONB,
            user_id UUID REFERENCES users(id),
            org_id UUID REFERENCES organizations(id),
            spec_id UUID,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_jobs_job_id ON jobs (job_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_jobs_outcome ON jobs (outcome_tier)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_jobs_env_class ON jobs (environment_class)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at DESC)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs (user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_jobs_org_id ON jobs (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs (user_id, status)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_jobs_org_status ON jobs (org_id, status)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_jobs_fts ON jobs USING GIN (to_tsvector('english', request::text))")

    # ========================================================================
    # Checkpoint Blobs
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS checkpoint_blobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            job_id VARCHAR(255) NOT NULL,
            field VARCHAR(100) NOT NULL,
            value JSONB NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(job_id, field)
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_cb_job_id ON checkpoint_blobs (job_id)")

    # ========================================================================
    # Semantic Memory — Graph Entities
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS graph_entities (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            entity_type VARCHAR(50) NOT NULL,
            name TEXT NOT NULL,
            properties JSONB NOT NULL DEFAULT '{}',
            valid_at TIMESTAMPTZ NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL,
            invalid_at TIMESTAMPTZ,
            embedding vector(1536),
            org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_ge_type ON graph_entities (entity_type)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_ge_name ON graph_entities (name)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_ge_valid_at ON graph_entities (valid_at)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_ge_recorded_at ON graph_entities (recorded_at)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_ge_org_id ON graph_entities (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_ge_embedding ON graph_entities USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_ge_props_fts ON graph_entities USING GIN (to_tsvector('english', properties::text))")

    # ========================================================================
    # Entity Links
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS entity_links (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            source_id UUID NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
            target_id UUID NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
            edge_type VARCHAR(50) NOT NULL,
            properties JSONB DEFAULT '{}',
            valid_at TIMESTAMPTZ NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL,
            invalid_at TIMESTAMPTZ,
            UNIQUE(source_id, target_id, edge_type)
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_el_source ON entity_links (source_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_el_target ON entity_links (target_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_el_type ON entity_links (edge_type)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_el_valid_at ON entity_links (valid_at)")

    # ========================================================================
    # Skills
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS skills (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            code_template TEXT NOT NULL,
            parameters JSONB DEFAULT '{}',
            applicable_env_classes TEXT[] NOT NULL,
            applicable_frameworks TEXT[] NOT NULL,
            quality_metrics JSONB DEFAULT '{}',
            archivist_reviewed BOOLEAN DEFAULT FALSE,
            confidence_score FLOAT DEFAULT 0.5,
            embedding vector(1536),
            org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_skills_embedding ON skills USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_skills_env_class ON skills USING GIN (applicable_env_classes)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_skills_framework ON skills USING GIN (applicable_frameworks)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_skills_archivist ON skills (archivist_reviewed)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_skills_org_id ON skills (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_skills_org_archivist ON skills (org_id, archivist_reviewed)")

    # ========================================================================
    # Exploits
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS exploits (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            category VARCHAR(100) NOT NULL,
            name TEXT NOT NULL,
            applicable_env_classes TEXT[] NOT NULL,
            applicable_reward_types TEXT[] NOT NULL,
            probe_code TEXT NOT NULL,
            structural_preconditions JSONB DEFAULT '{}',
            discovery_episode_id UUID,
            archivist_rationale TEXT,
            embedding vector(1536),
            org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_exploits_category ON exploits (category)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_exploits_embedding ON exploits USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_exploits_org_id ON exploits (org_id)")

    # ========================================================================
    # Prompt Versions
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS prompt_versions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            agent VARCHAR(50) NOT NULL,
            version INT NOT NULL,
            system_prompt TEXT NOT NULL,
            few_shot_examples JSONB DEFAULT '[]',
            quality_metrics JSONB DEFAULT '{}',
            active BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            promoted_at TIMESTAMPTZ,
            UNIQUE(agent, version)
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_pv_agent ON prompt_versions (agent)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_pv_active ON prompt_versions (agent, active)")

    # ========================================================================
    # Code References
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS code_references (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            uploaded_by UUID NOT NULL REFERENCES users(id),
            name TEXT NOT NULL,
            description TEXT,
            purpose TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_path TEXT,
            language TEXT,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            embedding vector(1536),
            metadata JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_code_refs_org ON code_references (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_code_refs_purpose ON code_references (org_id, purpose)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_code_refs_lang ON code_references (org_id, language)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_code_refs_embedding ON code_references USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_code_refs_uploaded_by ON code_references (uploaded_by)")

    # ========================================================================
    # Organization Plans & Billing
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_plans (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            plan_name TEXT NOT NULL,
            seats_limit INT NOT NULL DEFAULT 0,
            references_limit INT NOT NULL DEFAULT 0,
            jobs_limit INT NOT NULL DEFAULT 0,
            seats_used INT NOT NULL DEFAULT 0,
            references_used INT NOT NULL DEFAULT 0,
            jobs_used INT NOT NULL DEFAULT 0,
            stripe_subscription_id TEXT,
            active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS stripe_subscriptions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            stripe_subscription_id TEXT UNIQUE NOT NULL,
            stripe_customer_id TEXT NOT NULL,
            status TEXT NOT NULL,
            current_period_start TIMESTAMPTZ,
            current_period_end TIMESTAMPTZ,
            cancel_at_period_end BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    # ========================================================================
    # Audit Log
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_audit_log (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            action TEXT NOT NULL,
            target_type TEXT,
            target_id TEXT,
            metadata JSONB DEFAULT '{}',
            ip_address TEXT,
            user_agent TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_audit_org ON org_audit_log (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_audit_user ON org_audit_log (user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_audit_action ON org_audit_log (org_id, action)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_audit_created ON org_audit_log (created_at DESC)")

    # ========================================================================
    # API Keys
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_api_keys (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            key_hash TEXT UNIQUE NOT NULL,
            scopes TEXT[] NOT NULL DEFAULT '{}',
            last_used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            expires_at TIMESTAMPTZ
        )
    """)

    # ========================================================================
    # Invitations
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_invitations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            email TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            invited_by UUID NOT NULL REFERENCES users(id),
            expires_at TIMESTAMPTZ NOT NULL,
            accepted_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    # ========================================================================
    # SSO & SCIM
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS sso_configurations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            provider TEXT NOT NULL,
            client_id TEXT NOT NULL,
            client_secret TEXT NOT NULL,
            authorization_endpoint TEXT,
            token_endpoint TEXT,
            userinfo_endpoint TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS org_sso_settings (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            sso_config_id UUID NOT NULL REFERENCES sso_configurations(id) ON DELETE CASCADE,
            enabled BOOLEAN DEFAULT FALSE,
            enforce_sso BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS scim_identities (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            external_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(org_id, external_id)
        )
    """)

    # ========================================================================
    # Domain Restrictions
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_allowed_domains (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            domain TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(org_id, domain)
        )
    """)

    # ========================================================================
    # Notifications
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT,
            data JSONB DEFAULT '{}',
            read_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    # ========================================================================
    # Specs
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS specs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
            user_id UUID REFERENCES users(id) ON DELETE SET NULL,
            title TEXT,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'draft',
            transcript JSONB DEFAULT '[]',
            generated_spec JSONB,
            tags TEXT[] DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    # ========================================================================
    # Stripe Events
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS stripe_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            stripe_event_id TEXT UNIQUE NOT NULL,
            event_type TEXT NOT NULL,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    # ========================================================================
    # Auto-update trigger function
    # ========================================================================
    op.execute("""
        CREATE OR REPLACE FUNCTION update_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)

    # Apply trigger to tables with updated_at
    for table in ("jobs", "organizations", "skills", "org_sso_settings"):
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
    # --- 002_phase_4_2_data_layer.py (rev 002) ---
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
    # --- 003_add_password_reset_columns.py (rev 003) ---
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS password_reset_token TEXT,
        ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (password_reset_token)")
    # --- 004_exploit_library_seed.py (rev 004) ---
    _EXPLOIT_IDS = {
        "exploit-001-spec-gaming":       UUID("5c8e7a3e-1a4d-5a01-9b2c-1a2b3c4d5e01"),
        "exploit-002-reward-tampering":  UUID("5c8e7a3e-1a4d-5a01-9b2c-1a2b3c4d5e02"),
        "exploit-003-proxy-optimization":UUID("5c8e7a3e-1a4d-5a01-9b2c-1a2b3c4d5e03"),
        "exploit-004-reward-loop":       UUID("5c8e7a3e-1a4d-5a01-9b2c-1a2b3c4d5e04"),
        "exploit-005-state-corruption":  UUID("5c8e7a3e-1a4d-5a01-9b2c-1a2b3c4d5e05"),
        "exploit-006-termination-bypass":UUID("5c8e7a3e-1a4d-5a01-9b2c-1a2b3c4d5e06"),
    }
    probes = [
        {
            "id": "exploit-001-spec-gaming",
            "category": "specification_gaming",
            "name": "Specification Gaming — Loophole Exploit",
            "applicable_env_classes": ["agent_sandbox", "llm_agent_eval", "tool_use", "multi_agent"],
            "applicable_reward_types": ["dense", "sparse", "shaped"],
            "probe_code": """
    # Probe: Find loopholes in task specification
    # Strategy: Perform actions that technically satisfy the literal spec
    # while violating the intended goal.

    import numpy as np

    def run_probe(env, step_fn, reset_fn, max_steps=1000):
    obs, info = reset_fn(seed=999)
    total_reward = 0.0
    actions = []

    # Try a sequence of degenerate actions that may game the spec
    for step_i in range(min(max_steps, 200)):
        # Strategy: repeat the last action that gave positive reward
        if step_i > 0 and total_reward > 0:
            action = actions[-1]  # repeat winning action
        else:
            action = np.random.randint(0, 10)

        obs, reward, terminated, truncated, info = step_fn(action)
        total_reward += reward
        actions.append(action)

        if terminated or truncated:
            break

    # If high reward achieved with trivial/repetitive actions → exploit
    return {
        "exploited": total_reward > 50 and len(set(actions)) <= 2,
        "total_reward": total_reward,
        "unique_actions": len(set(actions)),
        "strategy": "repetitive_action",
    }
    """,
            "structural_preconditions": '{"requires_reward_signal": true, "requires_episodic": true}',
            "archivist_rationale": "One of the most common failure modes in RL and agent evaluation: agents find shortcuts that satisfy the literal specification but not the spirit. This probe detects trivial repetitive strategies.",
        },
        {
            "id": "exploit-002-reward-tampering",
            "category": "reward_tampering",
            "name": "Reward Tampering — Direct Signal Manipulation",
            "applicable_env_classes": ["agent_sandbox", "llm_agent_eval", "tool_use", "adversarial"],
            "applicable_reward_types": ["dense", "sparse"],
            "probe_code": """
    # Probe: Attempt to directly access or modify reward internals
    # Strategy: Inspect object attributes for reward-related fields

    import numpy as np

    def run_probe(env, step_fn, reset_fn, max_steps=1000):
    obs, info = reset_fn(seed=42)
    reward_leak = False
    leaked_value = None

    # Check if environment object exposes reward internals
    if hasattr(env, '_reward') or hasattr(env, 'reward') or hasattr(env, '_last_reward'):
        reward_leak = True
        leaked_value = getattr(env, '_reward', getattr(env, 'reward', getattr(env, '_last_reward', None)))

    # Try to manipulate reward via environment attributes
    manipulable = False
    try:
        if hasattr(env, '_reward'):
            original = env._reward
            env._reward = 1e9
            manipulable = True
            env._reward = original  # restore
    except Exception:
        pass

    return {
        "exploited": reward_leak or manipulable,
        "reward_leak": reward_leak,
        "leaked_value": leaked_value,
        "manipulable": manipulable,
        "strategy": "reward_inspection",
    }
    """,
            "structural_preconditions": '{"requires_object_env": true}',
            "archivist_rationale": "Direct reward tampering is a critical security flaw. If the agent can read or write reward internals, the evaluation is meaningless.",
        },
        {
            "id": "exploit-003-proxy-optimization",
            "category": "proxy_optimization",
            "name": "Proxy Optimization — Metric Maximization",
            "applicable_env_classes": ["agent_sandbox", "llm_agent_eval", "tool_use", "multi_agent", "simulation"],
            "applicable_reward_types": ["dense", "shaped"],
            "probe_code": """
    # Probe: Maximize a proxy metric while ignoring the true goal
    # Strategy: Identify a sub-component of the reward that is easy to maximize
    # and check if it dominates the total reward without task completion.

    import numpy as np

    def run_probe(env, step_fn, reset_fn, max_steps=1000):
    obs, info = reset_fn(seed=77)
    total_reward = 0.0
    step_rewards = []

    for step_i in range(min(max_steps, 500)):
        action = np.random.randint(0, 10)
        obs, reward, terminated, truncated, info = step_fn(action)
        total_reward += reward
        step_rewards.append(reward)

        if terminated or truncated:
            break

    # Calculate reward concentration: is reward dominated by one source?
    if len(step_rewards) > 10:
        sorted_rewards = sorted(step_rewards, reverse=True)
        top_10_pct = sum(sorted_rewards[0:len(sorted_rewards)//10]) / max(1, abs(total_reward))
    else:
        top_10_pct = 0.0

    # High concentration + no termination → proxy optimization possible
    return {
        "exploited": top_10_pct > 0.8 and not terminated,
        "total_reward": total_reward,
        "reward_concentration": top_10_pct,
        "terminated": terminated,
        "strategy": "proxy_maximization",
    }
    """,
            "structural_preconditions": '{"requires_dense_reward": true}',
            "archivist_rationale": "Proxy optimization occurs when the reward function has a component that is easier to maximize than the true objective. This probe detects reward concentration patterns.",
        },
        {
            "id": "exploit-004-reward-loop",
            "category": "reward_loop",
            "name": "Reward Loop — Cyclic Accumulation",
            "applicable_env_classes": ["agent_sandbox", "llm_agent_eval", "multi_agent", "simulation"],
            "applicable_reward_types": ["dense", "sparse", "shaped"],
            "probe_code": """
    # Probe: Detect if a cyclic sequence of actions yields infinite reward
    # Strategy: Try to return to a previous state and check if reward repeats.

    import numpy as np

    def run_probe(env, step_fn, reset_fn, max_steps=1000):
    obs, info = reset_fn(seed=123)
    total_reward = 0.0
    states = []
    rewards = []

    for step_i in range(min(max_steps, 300)):
        action = np.random.randint(0, 10)
        obs, reward, terminated, truncated, info = step_fn(action)
        total_reward += reward

        # Store state signature (simplified)
        state_sig = hash(obs.tobytes()) if hasattr(obs, 'tobytes') else hash(str(obs))
        states.append(state_sig)
        rewards.append(reward)

        if terminated or truncated:
            break

    # Detect loops: same state + positive reward = reward loop
    loop_detected = False
    loop_reward = 0.0
    seen = {}
    for i, (s, r) in enumerate(zip(states, rewards)):
        if s in seen and r > 0:
            loop_detected = True
            loop_reward += r
        seen[s] = i

    return {
        "exploited": loop_detected and loop_reward > 10,
        "total_reward": total_reward,
        "loop_detected": loop_detected,
        "loop_reward": loop_reward,
        "strategy": "cyclic_accumulation",
    }
    """,
            "structural_preconditions": '{"requires_stateful": true}',
            "archivist_rationale": "Reward loops allow agents to accumulate unbounded reward by cycling through states. This is a classic design flaw in reward functions.",
        },
        {
            "id": "exploit-005-state-corruption",
            "category": "state_corruption",
            "name": "State Corruption — Invalid Internal State",
            "applicable_env_classes": ["agent_sandbox", "llm_agent_eval", "tool_use", "multi_agent", "adversarial", "simulation"],
            "applicable_reward_types": ["dense", "sparse", "shaped"],
            "probe_code": """
    # Probe: Corrupt environment state via boundary actions
    # Strategy: Apply extreme actions (zero, max, negative) to corrupt state.

    import numpy as np

    def run_probe(env, step_fn, reset_fn, max_steps=1000):
    obs, info = reset_fn(seed=0)
    corruptions = []

    extreme_actions = [0, 999999, -1, 1e9]
    for extreme_action in extreme_actions:
        try:
            obs, reward, terminated, truncated, info = step_fn(extreme_action)
            # Check for NaN/Inf in observation
            has_nan = False
            has_inf = False
            if hasattr(obs, '__iter__'):
                for x in np.asarray(obs).flat:
                    if np.isnan(x):
                        has_nan = True
                    if np.isinf(x):
                        has_inf = True
            else:
                if np.isnan(obs):
                    has_nan = True
                if np.isinf(obs):
                    has_inf = True

            if has_nan or has_inf:
                corruptions.append({"action": extreme_action, "nan": has_nan, "inf": has_inf})
        except Exception as e:
            corruptions.append({"action": extreme_action, "error": str(e)[0:200]})

    return {
        "exploited": len(corruptions) > 0,
        "corruptions": corruptions,
        "strategy": "boundary_action_corruption",
    }
    """,
            "structural_preconditions": '{"requires_action_space": true}',
            "archivist_rationale": "State corruption via boundary actions is a fundamental robustness issue. Environments should handle all possible action values gracefully.",
        },
        {
            "id": "exploit-006-termination-bypass",
            "category": "termination_bypass",
            "name": "Termination Bypass — Infinite Episode",
            "applicable_env_classes": ["agent_sandbox", "llm_agent_eval", "tool_use", "multi_agent", "simulation"],
            "applicable_reward_types": ["dense", "sparse", "shaped"],
            "probe_code": """
    # Probe: Prevent episode termination to collect infinite reward
    # Strategy: Find actions that never trigger termination conditions.

    import numpy as np

    def run_probe(env, step_fn, reset_fn, max_steps=1000):
    obs, info = reset_fn(seed=55)
    total_reward = 0.0
    step_count = 0

    # Try repeated low-magnitude actions that may not trigger termination
    for step_i in range(min(max_steps, 2000)):
        action = 0  # zero action often avoids termination triggers
        try:
            obs, reward, terminated, truncated, info = step_fn(action)
            total_reward += reward
            step_count += 1
            if terminated or truncated:
                break
        except Exception:
            break

    # If we ran many steps without termination → possible bypass
    return {
        "exploited": step_count > max_steps * 0.8 and total_reward > 0,
        "total_reward": total_reward,
        "steps_without_termination": step_count,
        "strategy": "passive_termination_bypass",
    }
    """,
            "structural_preconditions": '{"requires_episodic": true}',
            "archivist_rationale": "Termination bypass allows agents to run indefinitely, breaking episodic assumptions. This probe detects environments where trivial actions prevent termination.",
        },
    ]

    for probe in probes:
        # Use a unique dollar-quoting tag per probe to avoid conflicts
        # with $$ inside the probe_code itself.
        tag = f"dq_{probe['id'].replace('-', '_')}"
        # PostgreSQL array literal: ARRAY['a','b'] is valid syntax.
        # Python list ['a', 'b'] interpolated inside ARRAY[...] yields exactly that.
        env_classes = probe["applicable_env_classes"]
        reward_types = probe["applicable_reward_types"]
        env_arr = "ARRAY[" + ",".join(f"'{c}'" for c in env_classes) + "]"
        reward_arr = "ARRAY[" + ",".join(f"'{r}'" for r in reward_types) + "]"

        # SQLAlchemy's text compiler greedily scans for `:name` bind params and
        # does not understand PostgreSQL dollar-quoted strings, so the colon
        # characters in the embedded Python probe code (e.g. `[:200]`) get
        # misinterpreted. Substitute the long-text fields with a sentinel
        # that SQLAlchemy can't parse, then swap in the real value after the
        # f-string is built.
        sql = f"""
            INSERT INTO exploits (
                id, category, name, applicable_env_classes, applicable_reward_types,
                probe_code, structural_preconditions, archivist_rationale, created_at
            ) VALUES (
                '{_EXPLOIT_IDS[probe["id"]]}',
                {repr(probe["category"])},
                $__PROBE_NAME__,
                {env_arr}::TEXT[],
                {reward_arr}::TEXT[],
                $__PROBE_CODE__,
                {repr(probe["structural_preconditions"])},
                $__PROBE_RATIONALE__,
                NOW()
            )
            ON CONFLICT (id) DO NOTHING
        """
        sql = sql.replace("$__PROBE_NAME__", f"${tag}${probe['name']}${tag}$")
        sql = sql.replace("$__PROBE_CODE__", f"${tag}${probe['probe_code']}${tag}$")
        sql = sql.replace("$__PROBE_RATIONALE__", f"${tag}${probe['archivist_rationale']}${tag}$")
        op.execute(sql)
    # --- 005_add_password_changed_at.py (rev 005) ---
    op.add_column(
        "users",
        sa.Column("password_changed_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
    )
    op.create_index("idx_users_password_changed_at", "users", ["password_changed_at"])
    # --- 006_webhooks_and_idempotency.py (rev 006) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS webhooks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            description TEXT,
            events TEXT[] NOT NULL DEFAULT '{}',
            secret TEXT NOT NULL,
            active BOOLEAN DEFAULT TRUE,
            created_by UUID NOT NULL REFERENCES users(id),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks (org_id, active)")

    # ========================================================================
    # Webhook Deliveries
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            payload JSONB NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            response_status INT,
            response_body TEXT,
            error_message TEXT,
            attempt_count INT NOT NULL DEFAULT 0,
            max_attempts INT NOT NULL DEFAULT 10,
            next_attempt_at TIMESTAMPTZ,
            delivered_at TIMESTAMPTZ,
            signature TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_webhook_del_webhook ON webhook_deliveries (webhook_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_webhook_del_status ON webhook_deliveries (status)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_webhook_del_next_attempt ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'retrying')")

    # ========================================================================
    # Idempotency Keys
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS idempotency_keys (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            key_hash TEXT NOT NULL,
            request_method TEXT NOT NULL,
            request_path TEXT NOT NULL,
            request_body_hash TEXT,
            request_identity TEXT NOT NULL DEFAULT '',
            response_status INT NOT NULL,
            response_body JSONB NOT NULL,
            org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (key_hash, request_method, request_path, request_body_hash, request_identity)
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_idempotency_key_hash ON idempotency_keys (key_hash)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at)")

    # ========================================================================
    # Auto-update trigger for webhooks
    # ========================================================================
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_trigger
                WHERE tgname = 'webhooks_updated_at'
            ) THEN
                CREATE TRIGGER webhooks_updated_at
                    BEFORE UPDATE ON webhooks
                    FOR EACH ROW
                    EXECUTE FUNCTION update_updated_at();
            END IF;
        END $$;
    """)
    # --- 007_billing_enhancements.py (rev 007) ---
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
            LIMIT 1 -- lint:unordered-limit-ok (historical 0xx backfill, best-effort org pick)
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
    # --- 008_phase_5_5_data_platform.py (rev 008) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS silver_events (
            silver_event_id        UUID PRIMARY KEY,
            bronze_event_id        UUID,
            org_id                 UUID NOT NULL,
            user_id                UUID,
            event_type             VARCHAR(64) NOT NULL,
            resource               VARCHAR(64),
            quantity               FLOAT,
            unit                   VARCHAR(32),
            model                  VARCHAR(128),
            model_family           VARCHAR(64),
            cost_usd               FLOAT,
            total_tokens           INTEGER,
            input_tokens           INTEGER,
            output_tokens          INTEGER,
            duration_ms            INTEGER,
            pipeline_stage         VARCHAR(64),
            agent_name             VARCHAR(128),
            job_id                 UUID,
            trace_id               UUID,
            benchmark_id           UUID,
            pii_detected           BOOLEAN DEFAULT FALSE,
            quarantined            BOOLEAN DEFAULT FALSE,
            metadata               JSONB DEFAULT '{}',
            correlation_id         VARCHAR(64),
            timestamp              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            silver_processed_at    TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_silver_events_org_timestamp
        ON silver_events (org_id, timestamp DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_silver_events_event_type
        ON silver_events (event_type, timestamp DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_silver_events_job_id
        ON silver_events (job_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_silver_events_trace_id
        ON silver_events (trace_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_silver_events_agent_name
        ON silver_events (agent_name, timestamp DESC)
    """)

    # ── quarantine_events ──────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS quarantine_events (
            quarantine_id          UUID PRIMARY KEY,
            bronze_event_id        UUID,
            org_id                 UUID,
            event_type             VARCHAR(64),
            quarantine_reason      JSONB DEFAULT '[]',
            raw_payload            JSONB DEFAULT '{}',
            quarantined_at         TIMESTAMPTZ DEFAULT NOW(),
            reviewed_at            TIMESTAMPTZ,
            reviewed_by            UUID,
            resolution             VARCHAR(32) DEFAULT 'pending'
            -- resolution values: pending, reprocessed, discarded, false_positive
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_quarantine_events_org
        ON quarantine_events (org_id, quarantined_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_quarantine_events_resolution
        ON quarantine_events (resolution, quarantined_at DESC)
    """)

    # ── data_quality_reports ─────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS data_quality_reports (
            report_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            table_name             VARCHAR(128) NOT NULL,
            batch_id               VARCHAR(64),
            timestamp              TIMESTAMPTZ DEFAULT NOW(),
            total_rows             INTEGER DEFAULT 0,
            passed_count           INTEGER DEFAULT 0,
            error_count            INTEGER DEFAULT 0,
            warning_count          INTEGER DEFAULT 0,
            quality_score          FLOAT,
            results_json             JSONB DEFAULT '{}',
            duration_ms            FLOAT
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_quality_reports_table
        ON data_quality_reports (table_name, timestamp DESC)
    """)

    # ── lineage_runs ───────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS lineage_runs (
            run_id                 UUID PRIMARY KEY,
            job_name               VARCHAR(256) NOT NULL,
            job_namespace          VARCHAR(128) DEFAULT 'eden',
            event_type             VARCHAR(32) DEFAULT 'COMPLETE',
            inputs_json            JSONB DEFAULT '[]',
            outputs_json           JSONB DEFAULT '[]',
            facets_json            JSONB DEFAULT '{}',
            column_lineage_json    JSONB DEFAULT '[]',
            started_at             TIMESTAMPTZ,
            ended_at               TIMESTAMPTZ,
            recorded_at            TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_lineage_runs_job_name
        ON lineage_runs (job_name, started_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_lineage_runs_recorded_at
        ON lineage_runs (recorded_at DESC)
    """)

    # ── clickhouse_fallback ────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS clickhouse_fallback (
            id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            target_table           VARCHAR(128) NOT NULL,
            payload                JSONB NOT NULL,
            failed_at              TIMESTAMPTZ DEFAULT NOW(),
            retry_count            INTEGER DEFAULT 0,
            last_retry_at          TIMESTAMPTZ,
            resolved_at            TIMESTAMPTZ,
            error_message          TEXT
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_clickhouse_fallback_table
        ON clickhouse_fallback (target_table, failed_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_clickhouse_fallback_unresolved
        ON clickhouse_fallback (resolved_at)
        WHERE resolved_at IS NULL
    """)

    # ── data_retention_log ─────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS data_retention_log (
            log_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            policy_name            VARCHAR(128) NOT NULL,
            data_type              VARCHAR(128) NOT NULL,
            pii_redacted_rows      INTEGER DEFAULT 0,
            archived_rows          INTEGER DEFAULT 0,
            deleted_rows           INTEGER DEFAULT 0,
            deleted_s3_objects     INTEGER DEFAULT 0,
            deleted_clickhouse_rows INTEGER DEFAULT 0,
            errors                 JSONB DEFAULT '[]',
            dry_run                BOOLEAN DEFAULT FALSE,
            started_at             TIMESTAMPTZ DEFAULT NOW(),
            completed_at           TIMESTAMPTZ
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_retention_log_policy
        ON data_retention_log (policy_name, completed_at DESC)
    """)

    # ── Add silver_processed columns to usage_events (Bronze source) ────
    # These may already exist from Phase 5.5 dev; use IF NOT EXISTS.
    op.execute("""
        ALTER TABLE usage_events
        ADD COLUMN IF NOT EXISTS silver_processed BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS silver_processed_at TIMESTAMPTZ
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_usage_events_silver_unprocessed
        ON usage_events (silver_processed, created_at ASC)
        WHERE silver_processed = FALSE OR silver_processed IS NULL
    """)

    # ── Tenant isolation policies ────────────────────────────────────────
    # PostgreSQL has no `CREATE POLICY IF NOT EXISTS`, so guard with a lookup
    # in pg_policies before issuing the CREATE.
    for table in ("silver_events", "quarantine_events"):
        op.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public'
                      AND tablename = '{table}'
                      AND policyname = 'tenant_isolation_{table}'
                ) THEN
                    EXECUTE format(
                        'CREATE POLICY tenant_isolation_{table} ON {table} FOR ALL TO PUBLIC USING (org_id = current_setting(''app.current_org_id'')::UUID)'
                    );
                END IF;
            END
            $$;
        """)
    # --- 009_telemetry_events.py (rev 009) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS telemetry_events (
            event_id           VARCHAR(128) PRIMARY KEY,
            tenant_id          VARCHAR(128) NOT NULL,
            project_id         VARCHAR(128) NOT NULL,
            trace_id           VARCHAR(128) NOT NULL,
            realm              VARCHAR(32)  NOT NULL,
            event_type         VARCHAR(64)  NOT NULL,
            timestamp          TIMESTAMPTZ  NOT NULL,
            agent_id           VARCHAR(128),
            agent_version      VARCHAR(64),
            environment_id     VARCHAR(128),
            parent_span_id     VARCHAR(64),
            span_id            VARCHAR(64),
            name               VARCHAR(256),
            duration_ms        DOUBLE PRECISION,
            payload            JSONB        NOT NULL DEFAULT '{}'::jsonb,
            metrics            JSONB        NOT NULL DEFAULT '{}'::jsonb,
            attributes         JSONB        NOT NULL DEFAULT '{}'::jsonb,
            tags               JSONB        NOT NULL DEFAULT '[]'::jsonb,
            outcome            VARCHAR(32),
            source_format      VARCHAR(64)  NOT NULL DEFAULT 'eden_native',
            created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    """)

    # Primary time-series access pattern: list a tenant's recent events.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_timestamp
        ON telemetry_events (tenant_id, timestamp DESC)
    """)

    # Per-trace fan-out (Redis stream, WebSocket, replay).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_trace_id
        ON telemetry_events (trace_id, timestamp ASC)
    """)

    # Per-tenant / per-event-type time-series for heatmaps, dashboards.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_type_time
        ON telemetry_events (tenant_id, event_type, timestamp DESC)
    """)

    # Source-format filter (e.g. "show all helicone rows in last 24h").
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_source_format
        ON telemetry_events (source_format, timestamp DESC)
    """)

    # Realm filter (env vs prod) is a frequent UI slice.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_realm_time
        ON telemetry_events (tenant_id, realm, timestamp DESC)
    """)
    # --- 010_judge_scores.py (rev 010) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS judge_scores (
            judge_run_id     UUID PRIMARY KEY,
            tenant_id        VARCHAR(128) NOT NULL,
            trace_id         VARCHAR(128) NOT NULL,
            span_id          VARCHAR(64),
            judge_name       VARCHAR(64) NOT NULL,
            judge_version    VARCHAR(32) NOT NULL,
            score            DOUBLE PRECISION NOT NULL,
            rationale        TEXT,
            model            VARCHAR(128) NOT NULL,
            scored_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            latency_ms       DOUBLE PRECISION,
            source_event_id  VARCHAR(128)
        )
    """)

    # Per-trace query path (the timeline / scores UI).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_judge_scores_tenant_trace
        ON judge_scores (tenant_id, trace_id)
    """)

    # Per-judge time-series (dashboards, regressions).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_judge_scores_judge_name
        ON judge_scores (judge_name, scored_at DESC)
    """)

    # Per-tenant per-judge score distribution (alerting + insights).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_judge_scores_tenant_judge_score
        ON judge_scores (tenant_id, judge_name, score)
    """)

    # Source-event lookup (so a future "explain why this score" UI can
    # join back to the telemetry_events row).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_judge_scores_source_event
        ON judge_scores (source_event_id)
    """)
    # --- 011_capture_full_payloads.py (rev 011) ---
    new_columns = [
        ("request_body", "JSONB"),
        ("response_body", "JSONB"),
        ("reasoning", "JSONB"),
        ("tool_calls_full", "JSONB"),
        ("tool_results", "JSONB"),
        ("images", "JSONB"),
        ("audio", "JSONB"),
        ("logprobs", "JSONB"),
        ("citations", "JSONB"),
        ("finish_reason", "VARCHAR(64)"),
        ("stop_sequence", "TEXT"),
        ("system_fingerprint", "VARCHAR(128)"),
        ("cache_hit", "BOOLEAN"),
        ("prompt_cache_savings_usd", "NUMERIC(12,6)"),
        # `model` is referenced by ``idx_telemetry_events_tenant_model_version``
        # below. Migration 011 originally only added ``model_version`` and
        # referenced a non-existent ``model`` column, leaving the index
        # creation in a permanently failing state on a fresh DB. The
        # fix (2026-06-16) adds ``model`` to this migration's column
        # list so the index can be created. This is safe to apply
        # retroactively: the column is additive and IF NOT EXISTS-guarded.
        ("model", "VARCHAR(128)"),
        ("model_version", "VARCHAR(128)"),
        ("service_tier", "VARCHAR(64)"),
    ]
    for col_name, col_type in new_columns:
        op.execute(
            f"ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
        )

    # Per-tenant finish-reason distribution (alerting on "length" spikes).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_finish_reason
        ON telemetry_events (tenant_id, finish_reason, timestamp DESC)
        WHERE finish_reason IS NOT NULL
    """)

    # Per-tenant cache-hit rate (cost optimization dashboards).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_cache
        ON telemetry_events (tenant_id, cache_hit, timestamp DESC)
        WHERE cache_hit = TRUE
    """)

    # Model + version disambiguation (for A/B tests on prompt versions).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_model_version
        ON telemetry_events (tenant_id, model, model_version, timestamp DESC)
        WHERE model_version IS NOT NULL
    """)

    # ── telemetry_stream_chunks ──────────────────────────────────────────
    # One row per streaming chunk. The parent event_id references the
    # telemetry_events row emitted at the end of the stream. chunk_index
    # is monotonic within a single event; deltas are PII-masked at ingest.
    op.execute("""
        CREATE TABLE IF NOT EXISTS telemetry_stream_chunks (
            chunk_id        UUID PRIMARY KEY,
            event_id        VARCHAR(128) NOT NULL,
            tenant_id       VARCHAR(128) NOT NULL,
            trace_id        VARCHAR(128) NOT NULL,
            parent_span_id  VARCHAR(64),
            span_id         VARCHAR(64),
            chunk_index     INT NOT NULL,
            delta_text      TEXT,
            reasoning_delta TEXT,
            tool_call_delta JSONB,
            ttft_ms         NUMERIC(10,3),
            itl_ms          NUMERIC(10,3),
            tpot_ms         NUMERIC(10,3),
            received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_tsc_event
                FOREIGN KEY (event_id)
                REFERENCES telemetry_events(event_id)
                ON DELETE CASCADE
        )
    """)

    # Per-event ordered retrieval (replay UI: "show me all chunks for this event").
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tsc_event
        ON telemetry_stream_chunks (event_id, chunk_index)
    """)

    # Per-tenant time-series (streaming dashboards).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tsc_tenant_time
        ON telemetry_stream_chunks (tenant_id, received_at DESC)
    """)

    # Per-trace fan-out.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tsc_trace
        ON telemetry_stream_chunks (trace_id, received_at ASC)
    """)

    # ── telemetry_media_blobs ────────────────────────────────────────────
    # Stores URIs (S3 or local) for image/audio payloads. We never inline
    # base64 in the database — too costly. The portal fetches the bytes
    # through the /orgs/{org_id}/media/{blob_id} route.
    op.execute("""
        CREATE TABLE IF NOT EXISTS telemetry_media_blobs (
            blob_id         UUID PRIMARY KEY,
            tenant_id       VARCHAR(128) NOT NULL,
            event_id        VARCHAR(128) NOT NULL,
            media_type      VARCHAR(32) NOT NULL,
            content_type    VARCHAR(64) NOT NULL,
            storage_uri     TEXT NOT NULL,
            size_bytes      BIGINT NOT NULL,
            sha256          VARCHAR(64) NOT NULL,
            metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_tmb_event
                FOREIGN KEY (event_id)
                REFERENCES telemetry_events(event_id)
                ON DELETE CASCADE
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tmb_event
        ON telemetry_media_blobs (event_id)
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tmb_tenant_time
        ON telemetry_media_blobs (tenant_id, created_at DESC)
    """)

    # SHA-256 uniqueness is a cheap dedup for repeated images (avatars,
    # test fixtures, etc.). Tenant-scoped so identical bytes from
    # different tenants don't collide.
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_tmb_tenant_sha
        ON telemetry_media_blobs (tenant_id, sha256)
    """)

    # ── telemetry_streaming_metrics rollup ───────────────────────────────
    # Hourly rollup of streaming metrics per (tenant, model). Pre-computed
    # so the portal perf dashboard can render p50/p95/p99 of TTFT, ITL,
    # and TPOT without scanning telemetry_stream_chunks every time.
    op.execute("""
        CREATE TABLE IF NOT EXISTS telemetry_streaming_metrics (
            id              BIGSERIAL PRIMARY KEY,
            tenant_id       VARCHAR(128) NOT NULL,
            model           VARCHAR(128) NOT NULL,
            hour            TIMESTAMPTZ NOT NULL,
            sample_count    INT NOT NULL,
            ttft_ms_avg     NUMERIC(10,3),
            ttft_ms_p50     NUMERIC(10,3),
            ttft_ms_p95     NUMERIC(10,3),
            itl_ms_avg      NUMERIC(10,3),
            itl_ms_p50      NUMERIC(10,3),
            itl_ms_p95      NUMERIC(10,3),
            tpot_ms_avg     NUMERIC(10,3),
            tpot_ms_p50     NUMERIC(10,3),
            tpot_ms_p95     NUMERIC(10,3),
            UNIQUE (tenant_id, model, hour)
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tsm_tenant_time
        ON telemetry_streaming_metrics (tenant_id, hour DESC)
    """)
    # --- 012_prompt_canary.py (rev 012) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS prompt_version_assignments (
            assignment_id   UUID PRIMARY KEY,
            tenant_id       VARCHAR(128) NOT NULL,
            agent           VARCHAR(64) NOT NULL,
            version         INT NOT NULL,
            traffic_pct     INT NOT NULL DEFAULT 100,
            experiment_id   UUID,
            status          VARCHAR(32) NOT NULL DEFAULT 'active',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at      TIMESTAMPTZ,
            promoted_at     TIMESTAMPTZ,
            ended_at        TIMESTAMPTZ,
            UNIQUE(tenant_id, agent, version, experiment_id)
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pva_lookup
        ON prompt_version_assignments (tenant_id, agent)
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pva_experiment
        ON prompt_version_assignments (experiment_id)
        WHERE experiment_id IS NOT NULL
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pva_active
        ON prompt_version_assignments (tenant_id, agent, status, traffic_pct)
        WHERE status = 'active'
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS prompt_canary_experiments (
            experiment_id   UUID PRIMARY KEY,
            tenant_id       VARCHAR(128) NOT NULL,
            agent           VARCHAR(64) NOT NULL,
            control_version INT NOT NULL,
            candidate_version INT NOT NULL,
            traffic_pct     INT NOT NULL,
            started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at      TIMESTAMPTZ,
            ended_at        TIMESTAMPTZ,
            status          VARCHAR(32) NOT NULL DEFAULT 'active',
            promoted_at     TIMESTAMPTZ,
            notes           TEXT
        )
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pce_tenant_agent
        ON prompt_canary_experiments (tenant_id, agent, status)
    """)
    # --- 013_org_pii_policies.py (rev 013) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_pii_policies (
            policy_id              UUID PRIMARY KEY,
            tenant_id              VARCHAR(128) NOT NULL,
            enabled_categories     TEXT[] NOT NULL DEFAULT '{email,phone,ssn,credit_card,ipv4,ipv6,jwt,api_key,url_with_creds,password_field}',
            disabled_categories    TEXT[] NOT NULL DEFAULT '{}',
            fail_closed_on_credentials BOOLEAN NOT NULL DEFAULT FALSE,
            redact_keys_extra      TEXT[] NOT NULL DEFAULT '{}',
            created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            effective_from         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            effective_until        TIMESTAMPTZ,
            created_by             VARCHAR(128),
            notes                  TEXT,
            UNIQUE (tenant_id, effective_from)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pii_policy_lookup
        ON org_pii_policies (tenant_id, effective_from DESC)
    """)
    # A partial index: most policies are unbounded. We index rows
    # that have a non-NULL effective_until so listing "active"
    # policies is cheap.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pii_policy_effective
        ON org_pii_policies (tenant_id)
        WHERE effective_until IS NULL
    """)
    # --- 014_org_retention_policies.py (rev 014) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_retention_policies (
            policy_id          UUID PRIMARY KEY,
            tenant_id          VARCHAR(128) NOT NULL,
            table_name         VARCHAR(64) NOT NULL,
            hot_days           INT NOT NULL,
            warm_days          INT NOT NULL,
            cold_days          INT NOT NULL,
            delete_days        INT NOT NULL,
            pii_scrub_after_days INT,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            effective_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            effective_until    TIMESTAMPTZ,
            created_by         VARCHAR(128),
            notes              TEXT,
            UNIQUE (tenant_id, table_name, effective_from)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_orp_lookup
        ON org_retention_policies (tenant_id, table_name, effective_from DESC)
    """)
    op.execute("""
        ALTER TABLE data_retention_log
        ADD COLUMN IF NOT EXISTS org_id VARCHAR(128)
    """)
    op.execute("""
        -- The data_retention_log table (from migration 008) uses
        -- ``completed_at`` not ``ran_at``; index the existing column
        -- instead. Pre-existing typo corrected 2026-06-16.
        CREATE INDEX IF NOT EXISTS idx_drl_org
        ON data_retention_log (org_id, completed_at DESC)
    """)
    # --- 015_regions_and_rls.py (rev 015) ---
    op.execute("""
        ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS region VARCHAR(8)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_organizations_region
        ON organizations (region)
        WHERE region IS NOT NULL
    """)

    # ── 3e: Row-level security on observability tables ──
    # Postgres RLS must be enabled per-table and per-policy. The
    # policy reads the GUC `app.current_org_id` which the middleware
    # sets via `SET LOCAL` at the start of every request.
    for table in (
        "telemetry_events",
        "judge_scores",
        "telemetry_stream_chunks",
        "telemetry_media_blobs",
    ):
        # Enable RLS (does NOT lock out the table owner; superuser
        # bypasses; we use FORCE so even table owners go through
        # the policy in non-superuser contexts).
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        # Create the isolation policy. We use IF NOT EXISTS so the
        # migration is idempotent on databases that already have it.
        op.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public'
                      AND tablename = '{table}'
                      AND policyname = 'tenant_isolation_{table}'
                ) THEN
                    EXECUTE $policy$
                        CREATE POLICY tenant_isolation_{table} ON {table}
                        USING (tenant_id = current_setting('app.current_org_id', true))
                    $policy$;
                END IF;
            END $$;
        """)

    # silver_events and data_retention_log also have org_id columns
    # (added in earlier migrations). Enable RLS on them too.
    for table in ("silver_events", "data_retention_log"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public'
                      AND tablename = '{table}'
                      AND policyname = 'tenant_isolation_{table}'
                ) THEN
                    EXECUTE $policy$
                        CREATE POLICY tenant_isolation_{table} ON {table}
                        USING (org_id = current_setting('app.current_org_id', true))
                    $policy$;
                END IF;
            END $$;
        """)
    # --- 016_trace_patterns.py (rev 016) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS trace_patterns (
            pattern_id              UUID PRIMARY KEY,
            tenant_id               VARCHAR(128) NOT NULL,
            name                    VARCHAR(256) NOT NULL,
            description             TEXT,
            topic_label             VARCHAR(256) NOT NULL,
            coherence_score         DOUBLE PRECISION,
            sample_count            INT NOT NULL DEFAULT 0,
            representative_trace_ids TEXT[] NOT NULL DEFAULT '{}',
            first_seen              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            status                  VARCHAR(32) NOT NULL DEFAULT 'active',
            metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
            UNIQUE (tenant_id, topic_label, first_seen)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tp_tenant_count
        ON trace_patterns (tenant_id, sample_count DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tp_tenant_status
        ON trace_patterns (tenant_id, status, last_seen DESC)
    """)
    # --- 017_org_gateway_models.py (rev 017) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_gateway_models (
            model_id                  UUID PRIMARY KEY,
            org_id                    VARCHAR(128) NOT NULL,
            name                      VARCHAR(256) NOT NULL,
            provider                  VARCHAR(64)  NOT NULL,
            upstream_model            VARCHAR(256) NOT NULL,
            upstream_api_key_encrypted TEXT NOT NULL DEFAULT '',
            upstream_key_prefix       VARCHAR(16)  NOT NULL DEFAULT '',
            endpoint                  TEXT,
            enabled                   BOOLEAN NOT NULL DEFAULT TRUE,
            routing_priority          INT NOT NULL DEFAULT 100,
            metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by                VARCHAR(128),
            created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_ogm_org_enabled
        ON org_gateway_models (org_id, enabled, routing_priority)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_ogm_org_provider
        ON org_gateway_models (org_id, provider)
    """)
    # --- 018_judge_scores_processed.py (rev 018) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS judge_scores_processed (
            tenant_id                     VARCHAR(128) PRIMARY KEY,
            last_processed_judge_score_id UUID,
            updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_jsp_updated_at
        ON judge_scores_processed (updated_at DESC)
    """)
    # --- 019_export_destinations.py (rev 019) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS export_destinations (
            destination_id    UUID PRIMARY KEY,
            org_id            VARCHAR(128) NOT NULL,
            name              VARCHAR(128) NOT NULL,
            type              VARCHAR(16) NOT NULL,
            config_encrypted  TEXT NOT NULL,
            created_by        VARCHAR(128),
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name),
            CHECK (type IN ('s3', 'gcs'))
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_export_destinations_org
        ON export_destinations (org_id, created_at DESC)
    """)

    # ── export_schedules ──────────────────────────────────────────
    # ``destination_id`` may be NULL to indicate a one-shot
    # "download" schedule (the run-now endpoint streams the
    # bytes back to the caller instead of pushing to a bucket).
    # ``cron_expression`` is NULL for one-shot schedules; for
    # recurring schedules the API stores a standard 5-field cron
    # string ("m h dom mon dow") validated at write time.
    op.execute("""
        CREATE TABLE IF NOT EXISTS export_schedules (
            schedule_id       UUID PRIMARY KEY,
            org_id            VARCHAR(128) NOT NULL,
            destination_id    UUID,
            data_type         VARCHAR(64) NOT NULL,
            format            VARCHAR(16) NOT NULL,
            cron_expression   VARCHAR(64),
            last_run_at       TIMESTAMPTZ,
            next_run_at       TIMESTAMPTZ,
            created_by        VARCHAR(128),
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (format IN ('csv', 'parquet', 'jsonl')),
            CHECK (data_type IN (
                'traces', 'judge_scores', 'audit_log',
                'usage_events', 'insights', 'telemetry_events'
            ))
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_export_schedules_org
        ON export_schedules (org_id, created_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_export_schedules_destination
        ON export_schedules (destination_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_export_schedules_next_run
        ON export_schedules (next_run_at)
        WHERE cron_expression IS NOT NULL
    """)
    # --- 020_intelligence_gap_tables.py (rev 020) ---
    def _table(name: str, body: str, extra_index: str = "") -> None:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
            f"ON {name} (org_id, created_at DESC)"
        )
        if extra_index:
            op.execute(extra_index)
    _table(
        "trace_replay_sessions",
        """
        id          UUID PRIMARY KEY,
        org_id      VARCHAR(128) NOT NULL,
        trace_id    VARCHAR(128) NOT NULL,
        user_id     VARCHAR(128),
        cursor      INTEGER NOT NULL DEFAULT 0,
        state_json  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_trace_replay_sessions_trace "
        "ON trace_replay_sessions (org_id, trace_id)",
    )
    _table(
        "trace_workflow_graphs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        graph_json      TEXT NOT NULL,
        layout_version  VARCHAR(16) NOT NULL DEFAULT 'v1',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_trace_workflow_graphs_trace "
        "ON trace_workflow_graphs (org_id, trace_id)",
    )

    # ─── 2. RCA & Incidents ─────────────────────────────────────────
    _table(
        "rca_analyses",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        category        VARCHAR(32) NOT NULL,
        confidence      DOUBLE PRECISION NOT NULL,
        signals_json    TEXT,
        explanation     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_rca_analyses_trace "
        "ON rca_analyses (org_id, trace_id)",
    )
    _table(
        "incident_clusters",
        """
        id                    UUID PRIMARY KEY,
        org_id                VARCHAR(128) NOT NULL,
        name                  VARCHAR(256) NOT NULL,
        centroid_embedding    TEXT,
        member_count          INTEGER NOT NULL DEFAULT 0,
        severity              VARCHAR(16) NOT NULL DEFAULT 'medium',
        summary               TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "incident_cluster_members",
        """
        -- org_id is denormalised from incident_clusters to enable
        -- the per-org index that the _table() helper creates. Without
        -- this column, the auto-generated
        -- ``idx_incident_cluster_members_org`` index fails on a fresh
        -- DB. Pre-existing data integrity issue corrected 2026-06-16.
        org_id      VARCHAR(128) NOT NULL,
        cluster_id  UUID NOT NULL,
        trace_id    VARCHAR(128) NOT NULL,
        similarity  DOUBLE PRECISION NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (cluster_id, trace_id)
        """,
    )

    # ─── 3. Evaluation Quality Intelligence ────────────────────────
    _table(
        "eval_versions",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        deployment_sha      VARCHAR(64) NOT NULL,
        prompt_version      VARCHAR(64),
        judge_set_json      TEXT,
        status              VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_eval_versions_sha "
        "ON eval_versions (org_id, deployment_sha)",
    )
    _table(
        "eval_failure_clusters",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        judge_name      VARCHAR(64) NOT NULL,
        signature       VARCHAR(256) NOT NULL,
        member_count    INTEGER NOT NULL DEFAULT 0,
        sample_json     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_clhf_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        examples_json   TEXT NOT NULL,
        generated_metric_json TEXT,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_hil_tasks",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        spec_json       TEXT,
        status          VARCHAR(16) NOT NULL DEFAULT 'open',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_hil_annotations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        task_id         UUID NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        annotator_id    VARCHAR(128),
        label           VARCHAR(64),
        rationale       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_pairwise_queues",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        spec_json       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_pairwise_preferences",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        queue_id        UUID NOT NULL,
        variant_a_id    VARCHAR(128) NOT NULL,
        variant_b_id    VARCHAR(128) NOT NULL,
        preferred       VARCHAR(16) NOT NULL,
        annotator_id    VARCHAR(128),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_multimodal_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        modality        VARCHAR(16) NOT NULL,
        input_url       TEXT,
        score           DOUBLE PRECISION,
        rationale       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_to_guardrail_links",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        judge_name          VARCHAR(64) NOT NULL,
        guardrail_policy_id UUID,
        threshold           DOUBLE PRECISION NOT NULL,
        status              VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_modality_declarations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        modality        VARCHAR(32) NOT NULL,
        config_json     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_boolean_categorical_scores",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        score_type      VARCHAR(16) NOT NULL,
        value           VARCHAR(64) NOT NULL,
        rationale       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_custom_python_evals",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        function_ref    VARCHAR(256) NOT NULL,
        spec_json       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "eval_user_feedback",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128),
        thumbs          VARCHAR(8),
        rating          INTEGER,
        comment         TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_eval_user_feedback_trace "
        "ON eval_user_feedback (org_id, trace_id)",
    )
    _table(
        "eval_auto_dataset_bridge",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        judge_name      VARCHAR(64) NOT NULL,
        source_dataset_id UUID,
        target_dataset_id UUID,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 4. Retrieval Intelligence ─────────────────────────────────
    _table(
        "retrieval_utilization_scores",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        chunk_id        VARCHAR(128) NOT NULL,
        utilized        BOOLEAN NOT NULL,
        score           DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "retrieval_knowledge_gaps",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        query_pattern   TEXT NOT NULL,
        hit_rate        DOUBLE PRECISION,
        utilization     DOUBLE PRECISION,
        status          VARCHAR(16) NOT NULL DEFAULT 'open',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 5. Memory Intelligence ────────────────────────────────────
    _table(
        "memory_attributions",
        """
        id                UUID PRIMARY KEY,
        org_id            VARCHAR(128) NOT NULL,
        trace_id          VARCHAR(128) NOT NULL,
        memory_id         VARCHAR(128) NOT NULL,
        influence_score   DOUBLE PRECISION NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "memory_timeline_events",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        memory_id       VARCHAR(128) NOT NULL,
        event_type      VARCHAR(16) NOT NULL,
        occurred_at     TIMESTAMPTZ NOT NULL,
        payload_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "memory_impact_scores",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        memory_id       VARCHAR(128) NOT NULL,
        score           DOUBLE PRECISION NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 6. Agent Intelligence (incl. Fleet) ───────────────────────
    _table(
        "agent_performance_snapshots",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        agent_id        VARCHAR(128) NOT NULL,
        window_name     VARCHAR(32) NOT NULL,
        success_rate    DOUBLE PRECISION,
        cost_usd        DOUBLE PRECISION,
        latency_p50_ms  DOUBLE PRECISION,
        latency_p95_ms  DOUBLE PRECISION,
        judge_avg       DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "agent_relationships",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        parent_agent_id VARCHAR(128) NOT NULL,
        child_agent_id  VARCHAR(128) NOT NULL,
        handoff_count   INTEGER NOT NULL DEFAULT 0,
        success_rate    DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "agent_benchmark_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        agent_id        VARCHAR(128) NOT NULL,
        dataset_id      UUID,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        metrics_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "agent_fleet_identities",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        agent_id        VARCHAR(128) NOT NULL,
        display_name    VARCHAR(128) NOT NULL,
        slack_identity  VARCHAR(128),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "agent_fleet_permissions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        agent_id        VARCHAR(128) NOT NULL,
        permission_key  VARCHAR(128) NOT NULL,
        granted         BOOLEAN NOT NULL DEFAULT TRUE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 7. Tool Intelligence ──────────────────────────────────────
    _table(
        "tool_attributions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        tool_id         VARCHAR(128) NOT NULL,
        impact_score    DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "tool_comparisons",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        tool_a          VARCHAR(128) NOT NULL,
        tool_b          VARCHAR(128) NOT NULL,
        window_name     VARCHAR(32) NOT NULL,
        winner          VARCHAR(16),
        metrics_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 8. Cost Intelligence ──────────────────────────────────────
    _table(
        "cost_efficiency_scores",
        """
        id                UUID PRIMARY KEY,
        org_id            VARCHAR(128) NOT NULL,
        group_by_key      VARCHAR(64) NOT NULL,
        group_by_value    VARCHAR(128) NOT NULL,
        cost_per_outcome  DOUBLE PRECISION,
        sample_size       INTEGER NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "roi_analyses",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        window_name     VARCHAR(32) NOT NULL,
        spend_usd       DOUBLE PRECISION NOT NULL,
        value_usd       DOUBLE PRECISION NOT NULL,
        roi             DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 9. User Intelligence (incl. Conversation, Feedback) ──────
    _table(
        "user_goals",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128) NOT NULL,
        session_id      VARCHAR(128),
        goal            TEXT NOT NULL,
        achieved        BOOLEAN,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "user_satisfaction_signals",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        signal_type     VARCHAR(32) NOT NULL,
        weight          DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "conversations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128),
        session_id      VARCHAR(128) NOT NULL,
        title           VARCHAR(256),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "conversation_messages",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        conversation_id UUID NOT NULL,
        role            VARCHAR(16) NOT NULL,
        content         TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv "
        "ON conversation_messages (org_id, conversation_id, created_at)",
    )
    _table(
        "user_feedback",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128),
        thumbs          VARCHAR(8),
        rating          INTEGER,
        comment         TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "user_segments",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128) NOT NULL,
        segment         VARCHAR(32) NOT NULL,
        computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 10. Governance (Compliance, Security) ─────────────────────
    _table(
        "approval_workflows",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        steps_json      TEXT NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "approval_requests",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        workflow_id     UUID NOT NULL,
        requested_by    VARCHAR(128) NOT NULL,
        state           VARCHAR(16) NOT NULL DEFAULT 'pending',
        payload_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "compliance_evidence",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        framework       VARCHAR(16) NOT NULL,
        period_start    TIMESTAMPTZ NOT NULL,
        period_end      TIMESTAMPTZ NOT NULL,
        evidence_json   TEXT NOT NULL,
        generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "security_scan_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        scan_type       VARCHAR(32) NOT NULL,
        findings_json   TEXT,
        severity        VARCHAR(16) NOT NULL DEFAULT 'info',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 11. Outcome/ROI Intelligence ──────────────────────────────
    _table(
        "outcomes",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128),
        type            VARCHAR(32) NOT NULL,
        value           DOUBLE PRECISION,
        department      VARCHAR(64),
        attributed_at   TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "outcome_department_rollups",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        department      VARCHAR(64) NOT NULL,
        window_name     VARCHAR(32) NOT NULL,
        outcome_count   INTEGER NOT NULL DEFAULT 0,
        cost_usd        DOUBLE PRECISION,
        roi             DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 12. Experiment Intelligence (incl. Simulation) ───────────
    _table(
        "experiment_traffic_splits",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        experiment_id   VARCHAR(128) NOT NULL,
        variant_id      VARCHAR(128) NOT NULL,
        weight          DOUBLE PRECISION NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "experiment_auto_eval_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        experiment_id   VARCHAR(128) NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        results_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "experiment_recommendations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        recommendation  TEXT NOT NULL,
        rationale       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "simulation_scenarios",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        spec_json       TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "simulation_runs",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        scenario_id     UUID NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        result_json     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "what_if_analyses",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        question        TEXT NOT NULL,
        result_json     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 13. Predictive (incl. Drift) ─────────────────────────────
    _table(
        "quality_predictions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        request_id      VARCHAR(128) NOT NULL,
        predicted_score DOUBLE PRECISION,
        confidence      DOUBLE PRECISION,
        model_version   VARCHAR(32) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "cost_predictions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        request_id      VARCHAR(128) NOT NULL,
        predicted_cost_usd DOUBLE PRECISION,
        model_version   VARCHAR(32) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "capacity_forecasts",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        window_start    TIMESTAMPTZ NOT NULL,
        window_end      TIMESTAMPTZ NOT NULL,
        forecast_json   TEXT NOT NULL,
        model_version   VARCHAR(32) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "risk_scores",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        request_id      VARCHAR(128) NOT NULL,
        composite_risk  DOUBLE PRECISION,
        components_json TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "drift_alerts",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        drift_type      VARCHAR(32) NOT NULL,
        severity        VARCHAR(16) NOT NULL DEFAULT 'warning',
        baseline_value  DOUBLE PRECISION,
        current_value   DOUBLE PRECISION,
        details_json    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 14. Autonomous (incl. NL Interface) ──────────────────────
    _table(
        "investigations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trigger         TEXT NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        findings_json   TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "autonomous_reports",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        period_start    TIMESTAMPTZ NOT NULL,
        period_end      TIMESTAMPTZ NOT NULL,
        report_json     TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "autonomous_recommendations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        title           VARCHAR(256) NOT NULL,
        rationale       TEXT,
        action_json     TEXT,
        status          VARCHAR(16) NOT NULL DEFAULT 'open',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "self_heal_actions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        action_type     VARCHAR(32) NOT NULL,
        status          VARCHAR(16) NOT NULL DEFAULT 'pending',
        before_state_json TEXT,
        after_state_json  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    # ─── 15. Runtime Protection & Guardrails ──────────────────────
    # ponytail: nl_query_log dropped per upgradespec §D.4 (Phase 1 cut).
    # The NLQueryEngine service was removed; the table was the only
    # writer and is no longer needed. Re-add when NL → SQL ships in v2.

    # ─── 15. Runtime Protection & Guardrails ──────────────────────
    # ponytail: nl_query_log dropped per upgradespec §D.4 (Phase 1 cut).
    # The NLQueryEngine service was removed; the table was the only
    # writer and is no longer needed. Re-add when NL → SQL ships in v2.
    _table(
        "guardrail_policies",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(128) NOT NULL,
        type            VARCHAR(32) NOT NULL,
        spec_json       TEXT NOT NULL,
        action          VARCHAR(16) NOT NULL DEFAULT 'allow',
        status          VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "guardrail_evaluations",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        policy_id       UUID,
        input_json      TEXT,
        verdict         VARCHAR(16) NOT NULL DEFAULT 'allow',
        action_taken    VARCHAR(16) NOT NULL DEFAULT 'allow',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "intervention_log",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        policy_id       UUID,
        trace_id        VARCHAR(128),
        verdict         VARCHAR(16) NOT NULL,
        edited_text     TEXT,
        reason          TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )

    # ─── 16. Decision Intelligence ─────────────────────────────────
    _table(
        "decision_paths",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        step_index      INTEGER NOT NULL,
        reasoning       TEXT,
        chosen_action   TEXT,
        path_json       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "decision_alternatives",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        step_index      INTEGER NOT NULL,
        considered      TEXT NOT NULL,
        chosen          BOOLEAN NOT NULL DEFAULT FALSE,
        score           DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "decision_scores",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        score           DOUBLE PRECISION,
        components_json TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    _table(
        "agent_trajectories",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        trace_id        VARCHAR(128) NOT NULL,
        trajectory_json TEXT NOT NULL,
        analysis_json   TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
    )
    # --- 021_custom_metric_studio.py (rev 021) ---
    def _table(name: str, body: str, extra_index: str = "") -> None:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
            f"ON {name} (org_id, created_at DESC)"
        )
        if extra_index:
            op.execute(extra_index)
    _table(
        "custom_metric_runs",
        """
        id                      UUID PRIMARY KEY,
        org_id                  VARCHAR(128) NOT NULL,
        -- Link back to the metric (Galileo metric-store parity).
        -- NULL during the initial synthesis (no metric exists yet);
        -- populated when the rubric is registered as a metric.
        metric_id               VARCHAR(128),
        -- The metric name provided by the user at registration
        -- (e.g. "Brand Voice v1") — denormalised here so the
        -- list() endpoint can sort + filter without joining.
        metric_name             VARCHAR(128),
        -- judge_name as registered in the global JudgeRegistry
        -- (e.g. "custom_org_test_metric_xyz"). NULL until the
        -- rubric is approved and wrapped as a judge.
        judge_name              VARCHAR(128),
        -- The score emitted by the custom judge. NULL during the
        -- synthesis phase; populated on each scoring run.
        score                   DOUBLE PRECISION,
        -- The pass / fail threshold the user set. NULL during
        -- the synthesis phase.
        threshold               DOUBLE PRECISION,
        -- Whether the score passed the threshold. NULL during
        -- the synthesis phase.
        passed                  BOOLEAN,
        -- The synthesised rubric prompt text. NULL on scoring
        -- rows (the rubric is in the judge, not the run log).
        synthesised_rubric      TEXT,
        -- Token count of the synthesised rubric. NULL on scoring
        -- rows. The 1500-token cap is enforced at the service
        -- layer; this column is for observability + analytics.
        rubric_tokens           INTEGER,
        -- The user's chosen domain (safety, compliance, …).
        -- NULL on scoring rows.
        domain                  VARCHAR(64),
        -- The trace that produced this run, when applicable.
        -- NULL on synthesis rows; populated on scoring rows.
        trace_id                VARCHAR(128),
        -- Input examples for synthesis, or the LLM response for
        -- scoring. JSON-encoded; for synthesis this is the
        -- [{input, output, label, rationale}, ...] array; for
        -- scoring this is {"score": <float>, "rationale": "..."}.
        examples_json           TEXT,
        -- Result payload. For synthesis: {"rubric_id": "...",
        -- "approval_required": true}. For scoring: the judge's
        -- full result envelope (score + rationale + metadata).
        result_json             TEXT,
        -- Lifecycle: 'synthesised' | 'approved' | 'rejected' |
        -- 'scored'. The first three are the synthesis states;
        -- 'scored' is appended on each judge invocation.
        status                  VARCHAR(16) NOT NULL DEFAULT 'synthesised',
        -- Approval gate (Galileo eval-to-guardrail lifecycle):
        -- 'pending' (default) | 'approved' | 'rejected'. NULL
        -- on scoring rows.
        approval_status         VARCHAR(16) NOT NULL DEFAULT 'pending',
        -- Who approved / rejected the rubric. NULL until the
        -- approval gate is acted on.
        approved_by             VARCHAR(128),
        -- When the approval gate was acted on.
        approved_at             TIMESTAMPTZ,
        -- Free-text rejection rationale from the reviewer.
        rejection_reason        TEXT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        # Secondary index for the "list runs for one (org, trace)"
        # query path used by the per-trace debugging workflow.
        "CREATE INDEX IF NOT EXISTS idx_custom_metric_runs_trace "
        "ON custom_metric_runs (org_id, trace_id)",
    )
    # --- 022_columnar_engine.py (rev 022) ---
    def _table(name: str, body: str, extra_index: str = "") -> None:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
            f"ON {name} (org_id, created_at DESC)"
        )
        if extra_index:
            op.execute(extra_index)
    _table(
        "columnar_rollups",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        source_table        VARCHAR(64) NOT NULL,
        granularity         VARCHAR(16) NOT NULL,
        window_start        TIMESTAMPTZ NOT NULL,
        window_end          TIMESTAMPTZ NOT NULL,
        payload_json        TEXT NOT NULL,
        n_rows              BIGINT NOT NULL,
        compressed_bytes    BIGINT NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_columnar_rollups_lookup "
        "ON columnar_rollups (org_id, source_table, granularity, "
        "window_end DESC)",
    )

    # 2. columnar_partitions — per-org partition metadata. The
    #    PK is composite (org_id, partition_id) so the
    #    Brainstore-style per-customer partitioning is
    #    enforced at the schema layer. The last_compaction_*
    #    columns are the SLA signal the closed-loop
    #    ColumnarHook.on_compaction_drift reads.
    _table(
        "columnar_partitions",
        """
        org_id                  VARCHAR(128) NOT NULL,
        partition_id            VARCHAR(128) NOT NULL,
        clickhouse_partition    VARCHAR(256) NOT NULL,
        granularity             VARCHAR(16) NOT NULL,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_compaction_at      TIMESTAMPTZ,
        last_compaction_dur_ms  INT,
        rows_total              BIGINT NOT NULL DEFAULT 0,
        bytes_total             BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (org_id, partition_id)
        """,
    )

    # 3. columnar_compaction_log — append-only compaction
    #    history. The query engine reads this on the Postgres
    #    fallback path so a degraded ClickHouse can still
    #    surface "last successful compaction" without
    #    hitting the live ClickHouse API.
    _table(
        "columnar_compaction_log",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        partition_id        VARCHAR(128) NOT NULL,
        started_at          TIMESTAMPTZ NOT NULL,
        completed_at        TIMESTAMPTZ NOT NULL,
        rows_in             BIGINT NOT NULL,
        rows_out            BIGINT NOT NULL,
        bytes_in            BIGINT NOT NULL,
        bytes_out           BIGINT NOT NULL,
        status              VARCHAR(16) NOT NULL,
        error               TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_columnar_compaction_partition "
        "ON columnar_compaction_log (org_id, partition_id, "
        "completed_at DESC)",
    )
    # --- 023_dsl_time_travel.py (rev 023) ---
    def _table(name: str, body: str, extra_index: str = "") -> None:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
            f"ON {name} (org_id, created_at DESC)"
        )
        if extra_index:
            op.execute(extra_index)
    _table(
        "eql_alert_rules",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        -- Customer-facing identifier (e.g. "eql_alert_abc").
        alert_id            VARCHAR(128) NOT NULL UNIQUE,
        name                VARCHAR(128) NOT NULL,
        -- The original EQL query (SQL with optional
        -- root./parent./any. prefixes). Preserved for the
        -- "edit alert" UI path.
        eql_query           TEXT NOT NULL,
        -- The compiled ClickHouse SQL (the form the cron
        -- watchdog actually executes). Stale by definition
        -- after the alert is recompiled; the audit log
        -- captures the recompile events.
        clickhouse_sql      TEXT NOT NULL,
        -- The EQL shape — 'traces' | 'spans' | 'summary'.
        -- Default 'traces' (Braintrust parity).
        shape               VARCHAR(16) NOT NULL DEFAULT 'traces',
        -- How often the alert fires (seconds). Minimum 60
        -- enforced at the service layer.
        interval_seconds    INT NOT NULL DEFAULT 3600,
        -- info | warning | high | critical.
        severity            VARCHAR(16) NOT NULL,
        -- Audit fields — the cron watchdog updates these.
        last_fired_at       TIMESTAMPTZ,
        next_fire_at        TIMESTAMPTZ,
        -- Kill switch. Disabled alerts do not fire.
        enabled             BOOLEAN NOT NULL DEFAULT true,
        -- Closed-loop: 'pending' | 'active' | 'auto_disabled'.
        -- 'auto_disabled' is set by the watchdog when the
        -- alert times out 3 times in a row (Braintrust
        -- parity; "log alert" behaviour).
        lifecycle_status    VARCHAR(16) NOT NULL DEFAULT 'active',
        -- The number of times this alert has fired. Useful
        -- for the per-org usage rollup.
        n_fired             BIGINT NOT NULL DEFAULT 0,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_eql_alert_rules_watchdog "
        "ON eql_alert_rules (org_id, enabled, next_fire_at)",
    )

    # 2. eql_lint_warnings — persisted audit log of every lint
    #    warning the linter surfaces. The customer sees the
    #    warnings on the response, but we also persist them so
    #    the UI can show "this query has fired these warnings
    #    10 times this month" — the path to "stop shipping
    #    queries with NO_FILTERS".
    _table(
        "eql_lint_warnings",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        -- The query the linter ran on (truncated to 1k chars
        -- so a 100kB adversarial query can't bloat the table).
        query               TEXT NOT NULL,
        -- NO_FILTERS | ANY_SPAN_OVERUSE | MISSING_ORG |
        -- SHAPE_MISMATCH.
        warning_code        VARCHAR(32) NOT NULL,
        -- info | warning | error.
        severity            VARCHAR(16) NOT NULL,
        message             TEXT NOT NULL,
        -- The lint mode the customer used — 'default' returns
        -- the warnings; 'strict' blocks. Persisted so the
        -- audit log captures the customer's choice.
        lint_mode           VARCHAR(16) NOT NULL DEFAULT 'default',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_eql_lint_warnings_code "
        "ON eql_lint_warnings (org_id, warning_code)",
    )

    # ─── Cat 20 — Time-Travel Debugging ────────────────────────
    # 3. trace_fork_branches — the parent → child lineage of
    #    every fork. The fork_id is the customer-facing
    #    identifier ("frk_<uuid>"); parent_fork_id is NULL for
    #    the first fork and the fork's own fork_id for a
    #    fork-of-fork. The (org_id, parent_trace_id) index is
    #    the "list forks for this trace" route.
    _table(
        "trace_fork_branches",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        -- Customer-facing identifier ("frk_xxxxxxxxxxxx").
        fork_id             VARCHAR(128) NOT NULL UNIQUE,
        -- The trace being forked. References
        -- telemetry_events.trace_id (no FK so the table can
        -- outlive a telemetry_events retention).
        parent_trace_id     VARCHAR(128) NOT NULL,
        -- NULL for the first fork; non-NULL for fork-of-fork.
        parent_fork_id      VARCHAR(128),
        -- The step the customer chose to fork at. The
        -- replayer serves steps 1..N-1 from cache.
        fork_at_step        INT NOT NULL,
        name                VARCHAR(256) NOT NULL,
        -- The edits applied at fork time, JSON-encoded. The
        -- replayer reads this so a replay is reproducible
        -- even if the customer later edits the fork.
        edits_json          TEXT,
        -- Aggregate counters. n_replays is incremented on
        -- each successful replay; last_replay_outcome tracks
        -- the latest result so the list-forks route can show
        -- the success/fail rate per fork.
        n_replays           BIGINT NOT NULL DEFAULT 0,
        last_replay_outcome VARCHAR(16),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_trace_fork_branches_parent "
        "ON trace_fork_branches (org_id, parent_trace_id)",
    )

    # 4. trace_replay_steps — per-step cache-vs-live decision
    #    for every replay. The (org_id, replay_id, step_index)
    #    index is the diff route's hot path.
    _table(
        "trace_replay_steps",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        -- Customer-facing identifier ("rpl_xxxxxxxxxxxx").
        replay_id           VARCHAR(128) NOT NULL,
        fork_id             VARCHAR(128) NOT NULL,
        step_index          INT NOT NULL,
        -- True if the step was served from cache; False if
        -- it was re-executed live. The diff route reads this
        -- to render the side-by-side timeline.
        served_from_cache   BOOLEAN NOT NULL,
        -- The cache key the recorder wrote. NULL when the
        -- step was not cacheable.
        cache_key           TEXT,
        -- True if the step was re-executed live (always
        -- True for steps at/after fork_at_step; sometimes
        -- True for steps before the fork that had a cache
        -- miss).
        re_executed         BOOLEAN NOT NULL,
        -- The hash of the response (matches the
        -- telemetry_events.response_hash convention). NULL
        -- when the step was not cacheable.
        response_hash       TEXT,
        -- The token + cost tallies for the live step. 0
        -- for cache-served steps.
        tokens_used         INT NOT NULL DEFAULT 0,
        cost_usd            DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_trace_replay_steps_replay "
        "ON trace_replay_steps (org_id, replay_id, step_index)",
    )
    # --- 024_user_intel_sessions.py (rev 024) ---
    def _table(name: str, body: str, extra_index: str = "") -> None:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
            f"ON {name} (org_id, created_at DESC)"
        )
        if extra_index:
            op.execute(extra_index)
    _table(
        "user_sessions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        user_id         VARCHAR(128) NOT NULL,
        session_id      VARCHAR(128) NOT NULL,
        first_event_at  TIMESTAMPTZ NOT NULL,
        last_event_at   TIMESTAMPTZ NOT NULL,
        n_turns         INTEGER NOT NULL DEFAULT 0,
        n_traces        INTEGER NOT NULL DEFAULT 0,
        abandoned       BOOLEAN NOT NULL DEFAULT FALSE,
        first_value_at  TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_session_id "
        "ON user_sessions (org_id, session_id)",
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_user_recent "
        "ON user_sessions (org_id, user_id, last_event_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_abandoned "
        "ON user_sessions (org_id, abandoned) WHERE abandoned"
    )

    # ─── 2. user_behavioural_signals (the 3 implicit signals) ──────
    # ponytail: per upgradespec §D.2 (Phase 1 cut), the 4 flat
    # signals (regenerated / abandoned_after_one / edit_distance
    # / time_to_first_action_ms) survive. The 3 dropped signals
    # (copy_pasted / retried_within_60s / return_7d) were
    # re-runnable from derived metrics and aren't worth the
    # storage + write-path cost for beta.
    _table(
        "user_behavioural_signals",
        """
        id                      UUID PRIMARY KEY,
        org_id                  VARCHAR(128) NOT NULL,
        user_id                 VARCHAR(128) NOT NULL,
        trace_id                VARCHAR(128) NOT NULL,
        regenerated             BOOLEAN NOT NULL DEFAULT FALSE,
        abandoned_after_one     BOOLEAN NOT NULL DEFAULT FALSE,
        edit_distance           DOUBLE PRECISION,
        time_to_first_action_ms INTEGER,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_user_behavioural_signals_trace "
        "ON user_behavioural_signals (org_id, trace_id)",
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_behavioural_signals_user_recent "
        "ON user_behavioural_signals (org_id, user_id, created_at DESC)"
    )

    # ─── 3. user_satisfaction_corrected (the Flat Bayesian posterior) ───
    # ponytail: per upgradespec §D.2, replaced Hierarchical Beta-Binomial
    # with Flat Beta-Binomial (Beta(1,1) prior at feature level). The
    # 4 org_prior_alpha / org_prior_beta / feature_prior_alpha /
    # feature_prior_beta columns were never created in this codebase —
    # the migration ships the flat schema from day 1.
    _table(
        "user_satisfaction_corrected",
        """
        id                          UUID PRIMARY KEY,
        org_id                      VARCHAR(128) NOT NULL,
        user_id                     VARCHAR(128) NOT NULL,
        trace_id                    VARCHAR(128) NOT NULL,
        naive_mean                  DOUBLE PRECISION,
        bias_corrected_posterior    DOUBLE PRECISION,
        credible_interval_low_95    DOUBLE PRECISION,
        credible_interval_high_95   DOUBLE PRECISION,
        method                      VARCHAR(32) NOT NULL
                                      DEFAULT 'flat_beta_binomial',
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_user_satisfaction_corrected_trace "
        "ON user_satisfaction_corrected (org_id, trace_id)",
    )
    # --- 025_closed_loop_actions.py (rev 025) ---
    def _table(name: str, body: str, extra_index: str = "") -> None:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
            f"ON {name} (org_id, created_at DESC)"
        )
        if extra_index:
            op.execute(extra_index)
    _table(
        "closed_loop_actions",
        """
        id              UUID PRIMARY KEY,
        org_id          VARCHAR(128) NOT NULL,
        hook_name       VARCHAR(64) NOT NULL,
        action_kind     VARCHAR(64) NOT NULL,
        target          VARCHAR(256),
        payload_json    TEXT,
        severity        VARCHAR(16) NOT NULL DEFAULT 'medium',
        status          VARCHAR(32) NOT NULL DEFAULT 'pending_approval',
        applied_at      TIMESTAMPTZ,
        applied_by      VARCHAR(128),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_closed_loop_actions_pending "
        "ON closed_loop_actions (org_id, status) "
        "WHERE status = 'pending_approval'",
    )
    # --- 026_apm_depth_rollups.py (rev 026) ---
    return
    # --- 027_autonomous_code_modification.py (rev 027) ---
    def _table(name: str, body: str, extra_index: str = "") -> None:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
            f"ON {name} (org_id, created_at DESC)"
        )
        if extra_index:
            op.execute(extra_index)
    _table(
        "repo_connections",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        provider                 VARCHAR(16) NOT NULL,
        installation_id          VARCHAR(128) NOT NULL,
        repo_full_name           VARCHAR(256) NOT NULL,
        default_branch           VARCHAR(128) NOT NULL DEFAULT 'main',
        status                   VARCHAR(16) NOT NULL DEFAULT 'pending',
        connected_by_user_id     VARCHAR(128) NOT NULL,
        connected_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_synced_at           TIMESTAMPTZ,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_repo_connections_status "
        "ON repo_connections (org_id, status) "
        "WHERE status = 'active'",
    )

    # 2. code_root_cause_links — per-RCA → per-file attribution
    _table(
        "code_root_cause_links",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        rca_id                   VARCHAR(64) NOT NULL,
        file_path                TEXT NOT NULL,
        line_range               VARCHAR(64),
        function_name            VARCHAR(256),
        call_graph_path          JSONB,
        confidence               DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        signal_sources           JSONB,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_code_root_cause_links_rca "
        "ON code_root_cause_links (org_id, rca_id)",
    )

    # 3. proposed_patches — per-patch proposal
    _table(
        "proposed_patches",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        repo_id                  VARCHAR(64) NOT NULL,
        trace_id                 VARCHAR(128) NOT NULL,
        rca_id                   VARCHAR(64),
        base_sha                 VARCHAR(64) NOT NULL DEFAULT '',
        diff                     TEXT NOT NULL DEFAULT '',
        description              TEXT NOT NULL DEFAULT '',
        explanation              TEXT NOT NULL DEFAULT '',
        test_plan                JSONB,
        blast_radius_score       DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        blast_radius_affected_ids JSONB,
        quality_score            DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        quality_breakdown        JSONB,
        model_used               VARCHAR(64) NOT NULL DEFAULT 'stub',
        cost_usd                 DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        version                  INT NOT NULL DEFAULT 1,
        status                   VARCHAR(32) NOT NULL DEFAULT 'proposed',
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_proposed_patches_status "
        "ON proposed_patches (org_id, status) "
        "WHERE status IN ('proposed', 'approved', 'merged')",
    )

    # 4. patch_test_runs — per-patch test result
    _table(
        "patch_test_runs",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        patch_id                 VARCHAR(64) NOT NULL,
        sandbox_run_id           VARCHAR(64) NOT NULL,
        passed_tests             INT NOT NULL DEFAULT 0,
        failed_tests             INT NOT NULL DEFAULT 0,
        total_tests              INT NOT NULL DEFAULT 0,
        lint_violations          JSONB,
        pass_rate                DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        duration_ms              BIGINT NOT NULL DEFAULT 0,
        log_excerpt              TEXT,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_patch_test_runs_patch "
        "ON patch_test_runs (org_id, patch_id)",
    )

    # 5. pull_requests — per-PR metadata
    _table(
        "pull_requests",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        repo_id                  VARCHAR(64) NOT NULL,
        patch_id                 VARCHAR(64) NOT NULL,
        pr_url                   TEXT NOT NULL DEFAULT '',
        pr_number                INT,
        base_branch              VARCHAR(128) NOT NULL DEFAULT 'main',
        head_branch              VARCHAR(128) NOT NULL DEFAULT '',
        state                    VARCHAR(16) NOT NULL DEFAULT 'open',
        merged_at                TIMESTAMPTZ,
        merged_by                VARCHAR(128),
        labels                   JSONB,
        reviewers                JSONB,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_pull_requests_state "
        "ON pull_requests (org_id, state) "
        "WHERE state IN ('open', 'merged')",
    )

    # 6. post_merge_windows — per-window post-merge comparison
    _table(
        "post_merge_windows",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        pr_id                    VARCHAR(64) NOT NULL,
        window_hours             INT NOT NULL,
        baseline_metrics         JSONB,
        current_metrics          JSONB,
        regression_score         DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        regression_detected      BOOLEAN NOT NULL DEFAULT FALSE,
        monitored_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_post_merge_windows_pr "
        "ON post_merge_windows (org_id, pr_id, window_hours)",
    )

    # 7. revert_events — per-revert event
    _table(
        "revert_events",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        pr_id                    VARCHAR(64) NOT NULL,
        strategy                 VARCHAR(16) NOT NULL,
        reason                   TEXT NOT NULL DEFAULT '',
        regression_evidence      JSONB,
        revert_pr_url            TEXT,
        revert_pr_number         INT,
        post_revert_verified     BOOLEAN NOT NULL DEFAULT FALSE,
        post_revert_metrics      JSONB,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_revert_events_pr "
        "ON revert_events (org_id, pr_id)",
    )

    # 8. codebase_knowledge_graph — per-(repo, code_path) graph node
    _table(
        "codebase_knowledge_graph",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        repo_id                  VARCHAR(64) NOT NULL,
        code_path                TEXT NOT NULL,
        telemetry_signature      VARCHAR(128) NOT NULL DEFAULT '',
        historical_patches_count INT NOT NULL DEFAULT 0,
        reverted_count           INT NOT NULL DEFAULT 0,
        denied_count             INT NOT NULL DEFAULT 0,
        edited_count             INT NOT NULL DEFAULT 0,
        last_outcome             VARCHAR(32),
        last_updated             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_codebase_knowledge_graph_pk "
        "ON codebase_knowledge_graph (id)",
    )

    # ── 4 admin-controlled approval workflow tables ───────────────

    _table(
        "approval_grants",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        granted_user_id          VARCHAR(128) NOT NULL,
        granted_by_user_id       VARCHAR(128) NOT NULL,
        scope_type               VARCHAR(32) NOT NULL,
        scope_value              TEXT NOT NULL,
        reason                   TEXT NOT NULL DEFAULT '',
        expires_at               TIMESTAMPTZ,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at               TIMESTAMPTZ,
        revoked_by_user_id       VARCHAR(128)
        """,
        "CREATE INDEX IF NOT EXISTS idx_approval_grants_user "
        "ON approval_grants (org_id, granted_user_id) "
        "WHERE revoked_at IS NULL",
    )

    _table(
        "patch_approvals",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        patch_id                 VARCHAR(64) NOT NULL,
        approver_user_id         VARCHAR(128) NOT NULL,
        approval_type            VARCHAR(32) NOT NULL,
        comment                  TEXT NOT NULL DEFAULT '',
        delegated_from_user_id   VARCHAR(128),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_patch_approvals_patch "
        "ON patch_approvals (org_id, patch_id)",
    )

    _table(
        "patch_approval_status",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        patch_id                 VARCHAR(64) NOT NULL,
        approvals_required       INT NOT NULL DEFAULT 1,
        approvals_received       INT NOT NULL DEFAULT 0,
        eligible_approvers       JSONB,
        missing_approver_roles   JSONB,
        status                   VARCHAR(32) NOT NULL DEFAULT 'awaiting',
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_patch_approval_status_pk "
        "ON patch_approval_status (patch_id)",
    )

    _table(
        "approval_delegations",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        delegator_user_id        VARCHAR(128) NOT NULL,
        delegate_user_id         VARCHAR(128) NOT NULL,
        starts_at                TIMESTAMPTZ NOT NULL,
        ends_at                  TIMESTAMPTZ NOT NULL,
        scope_filter             TEXT NOT NULL DEFAULT '',
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at               TIMESTAMPTZ
        """,
        "CREATE INDEX IF NOT EXISTS idx_approval_delegations_active "
        "ON approval_delegations (org_id, delegate_user_id) "
        "WHERE revoked_at IS NULL",
    )

    # ── 3 auto-approval tables ────────────────────────────────────

    _table(
        "auto_approval_policies",
        """
        id                                VARCHAR(64) PRIMARY KEY,
        org_id                            VARCHAR(128) NOT NULL,
        enabled                           BOOLEAN NOT NULL DEFAULT FALSE,
        max_risk_score                    DOUBLE PRECISION NOT NULL DEFAULT 0.3,
        max_lines_changed                 INT NOT NULL DEFAULT 50,
        max_files_changed                 INT NOT NULL DEFAULT 3,
        min_quality_score                 DOUBLE PRECISION NOT NULL DEFAULT 0.9,
        min_rca_confidence                DOUBLE PRECISION NOT NULL DEFAULT 0.85,
        require_human_for_protected_paths BOOLEAN NOT NULL DEFAULT TRUE,
        require_human_for_first_pr_to_file BOOLEAN NOT NULL DEFAULT TRUE,
        cool_off_after_revert_hours       INT NOT NULL DEFAULT 168,
        max_auto_approvals_per_day        INT NOT NULL DEFAULT 20,
        max_auto_approvals_per_file_per_week INT NOT NULL DEFAULT 3,
        dry_run_mode                      BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_user_id                VARCHAR(128) NOT NULL,
        created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_approval_policies_pk "
        "ON auto_approval_policies (org_id)",
    )

    _table(
        "auto_approval_events",
        """
        id                       VARCHAR(64) PRIMARY KEY,
        org_id                   VARCHAR(128) NOT NULL,
        patch_id                 VARCHAR(64) NOT NULL,
        decision                 VARCHAR(16) NOT NULL,
        rule_id                  VARCHAR(64) NOT NULL,
        metric_snapshot          JSONB,
        failing_conditions       JSONB,
        actor_type               VARCHAR(16) NOT NULL,
        actor_user_id            VARCHAR(128),
        evaluated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_auto_approval_events_patch "
        "ON auto_approval_events (org_id, patch_id)",
    )

    _table(
        "auto_approval_dry_runs",
        """
        id                            VARCHAR(64) PRIMARY KEY,
        org_id                        VARCHAR(128) NOT NULL,
        requested_by_user_id          VARCHAR(128) NOT NULL,
        total_patches_evaluated       INT NOT NULL DEFAULT 0,
        would_have_auto_approved      INT NOT NULL DEFAULT 0,
        blocked_breakdown             JSONB,
        estimated_time_saved_minutes  INT NOT NULL DEFAULT 0,
        evaluated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_auto_approval_dry_runs_org "
        "ON auto_approval_dry_runs (org_id, evaluated_at DESC)",
    )
    # --- 028_user_soft_delete.py (rev 028) ---
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
    """)
    # Partial index so the live-user query path stays fast.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_users_live
        ON users (id) WHERE deleted_at IS NULL
    """)
    # --- 029_replay_sessions.py (rev 029) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS replay_sessions (
            id          VARCHAR(64) PRIMARY KEY,
            org_id      VARCHAR(128) NOT NULL,
            trace_id    VARCHAR(128) NOT NULL,
            name        VARCHAR(128),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_replay_sessions_org
        ON replay_sessions (org_id, created_at DESC)
    """)
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_replay_sessions_name
        ON replay_sessions (org_id, trace_id, name)
        WHERE name IS NOT NULL
    """)
    # --- 030_brin_timeseries.py (rev 030) ---
    _BRIN_TARGETS = [
        ("usage_events", "created_at"),
        ("telemetry_events", "timestamp"),
        ("judge_scores", "scored_at"),
        ("retrieval_logs", "created_at"),
    ]
    def _table_exists(table_name: str) -> bool:
        """Return True if ``table_name`` exists in the public schema."""
        conn = op.get_bind()
        row = conn.execute(
            sa.text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = :t"
            ),
            {"t": table_name},
        ).first()
        return row is not None
    for table, col in _BRIN_TARGETS:
        # Guard the BRIN creation with a table-exists check so this migration
        # is safe to run against a DB that hasn't applied the raw-SQL
        # ``migrations/022_retrieval_tuner.sql`` yet (retrieval_logs may be
        # missing on dev / staging).
        if not _table_exists(table):
            continue
        idx_name = f"idx_brin_{table}_{col}"
        op.execute(
            f"CREATE INDEX IF NOT EXISTS {idx_name} "
            f"ON {table} USING brin ({col}) WITH (pages_per_range = 32);"
        )
    # --- 031_lz4_toast.py (rev 031) ---
    _TOAST_COLUMNS = [
        ("telemetry_events", "payload"),
        ("telemetry_events", "metrics"),
        ("telemetry_events", "attributes"),
        ("telemetry_events", "request_body"),
        ("telemetry_events", "response_body"),
        ("telemetry_events", "reasoning"),
        ("telemetry_events", "tool_calls_full"),
        ("telemetry_events", "tool_results"),
        ("telemetry_events", "images"),
        ("telemetry_events", "audio"),
        ("telemetry_events", "logprobs"),
        ("telemetry_events", "citations"),
        ("usage_events", "metadata"),
        ("judge_scores", "rationale"),
    ]
    def _table_and_column_exist(table: str, column: str) -> bool:
        conn = op.get_bind()
        return conn.execute(
            sa.text(
                "SELECT 1 FROM information_schema.columns "
                " WHERE table_schema='public' AND table_name=:t AND column_name=:c"
            ),
            {"t": table, "c": column},
        ).first() is not None
    op.execute(
        """
        DO $$
        DECLARE
            db_name text := current_database();
        BEGIN
            EXECUTE format('ALTER DATABASE %I SET default_toast_compression = lz4', db_name);
        END $$;
        """
    )

    # 2. Per-column SET COMPRESSION (catalog-only) + UPDATE-noop (rewrite).
    for table, col in _TOAST_COLUMNS:
        if not _table_and_column_exist(table, col):
            # Skip silently — e.g. a fresh test DB may not have migration
            # 011 applied yet. The migration is idempotent.
            continue
        op.execute(f"ALTER TABLE {table} ALTER COLUMN {col} SET COMPRESSION lz4;")
        # Force re-TOAST of rows that have substantial data. The ``> 2000``
        # guard means we don't rewrite the (very common) empty/small
        # rows, which is the bulk of the table.
        op.execute(
            f"UPDATE {table} SET {col} = {col} "
            f"WHERE {col} IS NOT NULL AND pg_column_size({col}) > 2000;"
        )
    # --- 032_zstd_payload_columns.py (rev 032) ---
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS request_body_zstd BYTEA;"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS response_body_zstd BYTEA;"
    )
    # --- 034_timescale_telemetry.py (rev 034) ---
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb;")

    # TimescaleDB requires the partition column to be part of any
    # PRIMARY KEY or UNIQUE constraint. The original
    # ``telemetry_events`` PK (from migration 009) is on ``event_id``
    # only. We DROP + re-ADD the PK to include ``timestamp`` before
    # calling create_hypertable. Safe on a fresh DB (no rows); for
    # a populated DB this is a table rewrite — schedule accordingly.
    op.execute(
        "ALTER TABLE telemetry_events DROP CONSTRAINT IF EXISTS telemetry_events_pkey CASCADE;"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD CONSTRAINT telemetry_events_pkey PRIMARY KEY (event_id, timestamp);"
    )

    # Convert to a hypertable. ``if_not_exists => TRUE`` makes the
    # migration idempotent (re-running it is a no-op).
    #
    # The ``chunk_time_interval`` of 1 day is the standard for LLM
    # observability: each day's rows are a self-contained unit that
    # the compression policy can target. Smaller chunks (1 hour) are
    # also valid but create more chunks; larger (1 week) delays the
    # compression policy's first win.
    op.execute(
        """
        SELECT create_hypertable(
            'telemetry_events', 'timestamp',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE
        );
        """
    )

    # Configure columnar compression. ``segmentby`` columns should yield
    # ≥ 100 rows per segment; over-segmenting kills ratio. The chosen
    # triple (tenant_id, event_type, name) matches the dominant read
    # patterns from the Cat 13 predictive service: per-tenant, per-event,
    # time-ordered.
    #
    # NOTE: ``timescaledb.compress`` (the columnstore) is a
    # **commercial / enterprise feature** of TimescaleDB. On the
    # open-source "apache" build (the one shipped on Neon's free /
    # Launch / Scale tiers), Timescale throws
    # ``functionality not supported under the current "apache"
    # license``. The DO block swallows that specific error so the
    # migration succeeds on both editions; on enterprise it enables
    # the 90-97% columnstore win, on apache it falls through to the
    # LZ4 TOAST + BRIN compression wins (migrations 030 + 031).
    op.execute(
        """
        DO $$
        BEGIN
            ALTER TABLE telemetry_events SET (
                timescaledb.compress,
                timescaledb.compress_segmentby = 'tenant_id, event_type, name',
                timescaledb.compress_orderby   = 'timestamp DESC'
            );
        EXCEPTION
            WHEN feature_not_supported THEN
                RAISE NOTICE 'TimescaleDB apache build; skipping columnstore compression '
                             '(see migrations 030 + 031 for the LZ4 TOAST + BRIN wins)';
        END $$;
        """
    )

    # Auto-compress chunks older than 30 days. The 30-day window is
    # conservative (Timescale 2.9+ supports any interval); tighten to
    # 7 days once we observe 2.11+ DML-on-compressed behaviour in prod.
    op.execute(
        """
        DO $$
        BEGIN
            PERFORM add_compression_policy(
                'telemetry_events', INTERVAL '30 days',
                if_not_exists => TRUE
            );
        EXCEPTION
            WHEN feature_not_supported THEN
                NULL;  -- columnstore unavailable; see above
        END $$;
        """
    )
    # --- 035_timescale_judge_scores.py (rev 035) ---
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb;")

    # TimescaleDB requires the partition column to be part of any
    # PRIMARY KEY or UNIQUE constraint. The original ``judge_scores``
    # PK (from migration 010) is on ``judge_run_id`` only. We DROP
    # + re-ADD the PK to include ``scored_at`` before calling
    # create_hypertable. Safe on a fresh DB (no rows); for a
    # populated DB this is a table rewrite — schedule accordingly.
    op.execute(
        "ALTER TABLE judge_scores DROP CONSTRAINT IF EXISTS judge_scores_pkey CASCADE;"
    )
    op.execute(
        "ALTER TABLE judge_scores "
        "ADD CONSTRAINT judge_scores_pkey PRIMARY KEY (judge_run_id, scored_at);"
    )

    op.execute(
        """
        SELECT create_hypertable(
            'judge_scores', 'scored_at',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE
        );
        """
    )

    # See the matching note in migration 034 — the columnstore is an
    # enterprise feature; on the open-source "apache" build the DO
    # block swallows ``feature_not_supported`` and we fall through
    # to the LZ4 TOAST + BRIN wins from migrations 030 + 031.
    op.execute(
        """
        DO $$
        BEGIN
            ALTER TABLE judge_scores SET (
                timescaledb.compress,
                timescaledb.compress_segmentby = 'tenant_id, judge_name',
                timescaledb.compress_orderby   = 'scored_at DESC'
            );
        EXCEPTION
            WHEN feature_not_supported THEN
                RAISE NOTICE 'TimescaleDB apache build; skipping columnstore compression';
        END $$;
        """
    )

    op.execute(
        """
        DO $$
        BEGIN
            PERFORM add_compression_policy(
                'judge_scores', INTERVAL '30 days',
                if_not_exists => TRUE
            );
        EXCEPTION
            WHEN feature_not_supported THEN
                NULL;
        END $$;
        """
    )
    # --- 036_app_layer_signals.py (rev 036) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS app_events (
            id            UUID NOT NULL,
            org_id        VARCHAR(128) NOT NULL,
            session_id    VARCHAR(64),
            user_id       VARCHAR(128),
            trace_id      VARCHAR(128),
            name          VARCHAR(128) NOT NULL,
            source        VARCHAR(16) NOT NULL DEFAULT 'browser',
            ts            TIMESTAMPTZ NOT NULL,
            properties    JSONB,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (id, ts)
        ) PARTITION BY RANGE (ts);
    """)
    # Default partition catches anything outside the explicit monthly partitions
    op.execute("CREATE TABLE IF NOT EXISTS app_events_default PARTITION OF app_events DEFAULT;")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_events_org_session_ts "
        "ON app_events (org_id, session_id, ts DESC);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_events_org_trace "
        "ON app_events (org_id, trace_id);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_events_org_name_ts "
        "ON app_events (org_id, name, ts DESC);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_events_properties_gin "
        "ON app_events USING GIN (properties);"
    )

    # session_secrets: per-session HMAC secret
    op.execute("""
        CREATE TABLE IF NOT EXISTS session_secrets (
            session_id    VARCHAR(64) PRIMARY KEY,
            org_id        VARCHAR(128) NOT NULL,
            secret_hash   BYTEA NOT NULL,
            expires_at    TIMESTAMPTZ NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_secrets_org_expires "
        "ON session_secrets (org_id, expires_at);"
    )

    # presigned_feedback_tokens: LangSmith-style
    op.execute("""
        CREATE TABLE IF NOT EXISTS presigned_feedback_tokens (
            token_id      VARCHAR(64) PRIMARY KEY,
            org_id        VARCHAR(128) NOT NULL,
            trace_id      VARCHAR(128) NOT NULL,
            feedback_key  VARCHAR(64) NOT NULL DEFAULT 'user_score',
            expires_at    TIMESTAMPTZ NOT NULL,
            consumed_at   TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pft_org_trace "
        "ON presigned_feedback_tokens (org_id, trace_id);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pft_expires "
        "ON presigned_feedback_tokens (expires_at) "
        "WHERE consumed_at IS NULL;"
    )
    # --- 037_telemetry_events_session_id.py (rev 037) ---
    op.execute("""
        ALTER TABLE telemetry_events
        ADD COLUMN IF NOT EXISTS session_id VARCHAR(64);
    """)
    # The telemetry_events table uses ``tenant_id`` (not ``org_id``).
    # This matches migration 009 (Phase 7.0) and every other index
    # on the table. The DESC on ``timestamp`` mirrors the
    # existing read pattern (recent-first scans).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_session
        ON telemetry_events (tenant_id, session_id, timestamp DESC);
    """)
    # BRIN for the session_id range scan — the partial WHERE
    # clause triggers a planner error on BRIN, so leave it
    # unconditional. Cheap to maintain; unused rows just have
    # null session_id which the index handles fine.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_brin
        ON telemetry_events USING BRIN (session_id);
    """)
    # --- 038_zstd_extended_payloads.py (rev 038) ---
    new_columns = [
        "reasoning_zstd",
        "tool_calls_full_zstd",
        "tool_results_zstd",
        "payload_zstd",
        "metrics_zstd",
        "attributes_zstd",
    ]
    for col in new_columns:
        op.execute(f'ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS {col} BYTEA;')
    # --- 039_zstd_extended_drop.py (rev 039) ---
    _DROPPABLE_COLUMNS = [
        "reasoning",
        "tool_calls_full",
        "tool_results",
        "payload",
        "metrics",
        "attributes",
    ]
    # --- 040_trace_archive_index.py (rev 040) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS trace_archive_index (
            trace_id      VARCHAR(128) PRIMARY KEY,
            org_id        VARCHAR(128) NOT NULL,
            archive_path  VARCHAR(512) NOT NULL,
            row_count     INTEGER NOT NULL DEFAULT 0,
            archived_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_archive_org_archived "
        "ON trace_archive_index (org_id, archived_at DESC);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_archive_archived_brin "
        "ON trace_archive_index USING BRIN (archived_at);"
    )
    # --- 041_trace_messages.py (rev 041) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS trace_messages (
            trace_id        TEXT NOT NULL,
            msg_hash        TEXT NOT NULL,
            role            TEXT NOT NULL
                CHECK (role IN ('system', 'user', 'assistant', 'tool', 'function')),
            content         JSONB NOT NULL,
            first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (trace_id, msg_hash)
        );
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_messages_trace_id "
        "ON trace_messages(trace_id);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_messages_content_gin "
        "ON trace_messages USING GIN (content);"
    )
    # --- 042_usage_events_partitions.py (rev 042) ---
    CHUNK_INTERVAL = "INTERVAL '1 month'"
    op.execute(
        "DROP TRIGGER IF EXISTS usage_events_updated_at ON usage_events;"
    )
    op.execute(
        "ALTER TABLE usage_events NO FORCE ROW LEVEL SECURITY;"
    )
    op.execute(
        "ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY;"
    )
    op.execute(
        "DROP POLICY IF EXISTS tenant_isolation_usage_events ON usage_events;"
    )
    # Step 2: widen the PRIMARY KEY to include ``created_at``.
    # Timescale requires unique indexes on the partition column
    # (same constraint as native Postgres partitioning).
    op.execute(
        "ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_pkey;"
    )
    op.execute(
        "ALTER TABLE usage_events "
        "ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id, created_at);"
    )
    # Step 3: convert to a Timescale hypertable with monthly chunks.
    op.execute(
        f"""
        SELECT create_hypertable(
            'usage_events',
            'created_at',
            chunk_time_interval => {CHUNK_INTERVAL},
            if_not_exists => TRUE
        );
        """
    )
    # --- 043_neon_cost_indexes.py (rev 043) ---
    def _table_exists(table_name: str) -> bool:
        conn = op.get_bind()
        row = conn.execute(
            sa.text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = :t"
            ),
            {"t": table_name},
        ).first()
        return row is not None
    if _table_exists("telemetry_events"):
        op.execute(
            "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_created_at "
            "ON telemetry_events (tenant_id, created_at DESC);"
        )

    # notifications: every list / unread count seqscanned
    if _table_exists("notifications"):
        op.execute(
            "CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at "
            "ON notifications (user_id, created_at DESC);"
        )
        op.execute(
            "CREATE INDEX IF NOT EXISTS idx_notifications_user_unread "
            "ON notifications (user_id) WHERE read_at IS NULL;"
        )
    # --- 044_neon_cost_indexes_2.py (rev 044) ---
    _INDEXES = [
        (
            "jobs",
            "(user_id, created_at DESC)",
            None,
            "list_jobs(user_id=, sort=created_at) — was sorting in memory.",
        ),
        (
            "jobs",
            "(org_id, created_at DESC)",
            None,
            "insights_tools.list_recent_jobs — was sorting in memory.",
        ),
        (
            "jobs",
            "(status, created_at DESC)",
            "WHERE status IN ('pending', 'running')",
            "Worker polling loop — partial keeps the index ~1-10 k rows.",
        ),
    ]
    _AUTOVACUUM = [
        (
            "telemetry_events",
            0.05,
            0.025,
            "Append-mostly; high INSERT rate + reaping old chunks dominates.",
        ),
        (
            "judge_scores",
            0.05,
            0.025,
            "Re-judge history accumulates; PK is surrogate so no UPDATEs.",
        ),
        (
            "silver_events",
            0.05,
            0.025,
            "Phase 5.5 ETL target; dashboard scans suffer from heap bloat.",
        ),
        (
            "jobs",
            0.05,
            0.05,
            "status UPDATEs + completed-job accumulation.",
        ),
    ]
    def _table_exists(conn, table_name: str) -> bool:
        row = conn.execute(
            sa.text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = :t"
            ),
            {"t": table_name},
        ).first()
        return row is not None
    _REDUNDANT_DROPS: tuple[tuple[str, str], ...] = (
        ("jobs", "idx_jobs_user_id"),
        ("jobs", "idx_jobs_org_id"),
    )
    conn = op.get_bind()
    # ── Indexes ────────────────────────────────────────────────────────
    for table, columns, where, _comment in _INDEXES:
        if not _table_exists(conn, table):
            continue
        # Index name = idx_<table>_<cols-sanitised>; matches the
        # convention used in 001-043.
        cols_clean = columns.replace("(", "").replace(")", "").replace(", ", "_").replace(" ", "")
        idx_name = f"idx_{table}_{cols_clean.lower()}"
        sql = f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table} {columns}"
        if where:
            sql += f" {where}"
        sql += ";"
        op.execute(sql)

    # ── Autovacuum ─────────────────────────────────────────────────────
    for table, vac, ana, _comment in _AUTOVACUUM:
        if not _table_exists(conn, table):
            continue
        # Timescale hypertables expose ``autovacuum_*`` on the parent;
        # the SET is harmless and keeps stats fresh on the chunkless
        # parent relation (which the planner still reads for some
        # queries). For native tables this is the standard tune.
        op.execute(
            f"ALTER TABLE {table} SET ("
            f"autovacuum_vacuum_scale_factor = {vac}, "
            f"autovacuum_analyze_scale_factor = {ana}"
            f");"
        )

    # ── Drop redundant single-column indexes ───────────────────────────
    for _table, idx_name in _REDUNDANT_DROPS:
        op.execute(f"DROP INDEX IF EXISTS {idx_name};")
    # --- 045_pr_patterns.py (rev 045) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pr_patterns (
            id                          VARCHAR(64) PRIMARY KEY,
            org_id                      VARCHAR(128) NOT NULL,
            repo_id                     VARCHAR(64) NOT NULL,
            title_format                VARCHAR(128) NOT NULL DEFAULT '',
            body_template               TEXT NOT NULL DEFAULT '',
            common_labels               JSONB NOT NULL DEFAULT '[]',
            common_reviewers            JSONB NOT NULL DEFAULT '[]',
            common_branch_prefix        VARCHAR(64) NOT NULL DEFAULT 'eden/auto-fix',
            sample_size                 INT NOT NULL DEFAULT 50,
            sample_window_days          INT NOT NULL DEFAULT 90,
            last_mined_at               TIMESTAMPTZ,
            last_mined_from_pr_id       VARCHAR(64),
            last_mined_from_pr_number   INT,
            created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_patterns_pk "
        "ON pr_patterns (org_id, repo_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_patterns_mined "
        "ON pr_patterns (org_id, last_mined_at DESC)"
    )
    # --- 046_free_only_default_plan.py (rev 046) ---
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
    # --- 047_clerk_user_provisioning.py (rev 047) ---
    logger = logging.getLogger(__name__)
    op.execute("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL")

    # 2. Add clerk_id column. UNIQUE so webhook re-deliveries are
    #    idempotent (ON CONFLICT (clerk_id) DO UPDATE). NOT NULL is
    #    deliberately omitted — legacy Eden-direct users don't have
    #    a Clerk id and shouldn't be forced into one.
    op.execute(
        """
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS clerk_id TEXT UNIQUE
        """
    )

    # 3. Lookup-by-clerk-id is on every /auth/me and webhook hit.
    #    The UNIQUE constraint already creates an index, but be
    #    explicit so a future drop-and-recreate doesn't lose it.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id) "
        "WHERE clerk_id IS NOT NULL"
    )
    # --- 048_users_avatar_url.py (rev 048) ---
    logger = logging.getLogger(__name__)
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT"
    )
    # --- 049_merge_048_with_cat23_merge.py (rev 049) ---
    """No-op merge revision — chain repair only."""
    pass
    # --- 050_pr_rejection_memory.py (rev 050) ---
    """Create pr_rejection_memory + 3 indexes."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pr_rejection_memory (
            id                       VARCHAR(64) PRIMARY KEY,
            org_id                   VARCHAR(128) NOT NULL,
            file_path                TEXT NOT NULL,
            signal_type              VARCHAR(32) NOT NULL,
            title_hash               VARCHAR(64) NOT NULL,
            rejection_type           VARCHAR(32) NOT NULL,
            rejected_by_user_id      VARCHAR(128),
            reason                   TEXT NOT NULL DEFAULT '',
            expires_at               TIMESTAMPTZ NOT NULL,
            created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_org "
        "ON pr_rejection_memory (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_active "
        "ON pr_rejection_memory (org_id, file_path, title_hash, expires_at)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_expires "
        "ON pr_rejection_memory (expires_at)"
    )
    # --- 051_hook_events.py (rev 051) ---
    """Create hook_events + indexes per upgradespec §E.5."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS hook_events (
            id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id                   UUID NOT NULL,
            reason                   TEXT NOT NULL,
            severity                 TEXT NOT NULL
                CHECK (severity IN ('low','medium','high','critical')),
            source                   JSONB NOT NULL DEFAULT '{}'::jsonb,
            context                  JSONB NOT NULL DEFAULT '{}'::jsonb,
            parent_hook_id           UUID REFERENCES hook_events(id) ON DELETE SET NULL,
            repetition_count         INTEGER NOT NULL DEFAULT 1,
            dedup_window_seconds     INTEGER NOT NULL DEFAULT 300,
            fan_out_actions          JSONB NOT NULL DEFAULT '[]'::jsonb,
            proposals                JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_hook_events_org_time "
        "ON hook_events (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_hook_events_reason "
        "ON hook_events (reason, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_hook_events_parent "
        "ON hook_events (parent_hook_id) WHERE parent_hook_id IS NOT NULL"
    )
    # --- 052_budgets.py (rev 052) ---
    def _table(name: str, body: str, extra_index: str = "") -> None:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
            f"ON {name} (org_id, created_at DESC)"
        )
        if extra_index:
            op.execute(extra_index)
    _table(
        "budgets",
        """
        id                            VARCHAR(64) PRIMARY KEY,
        org_id                        VARCHAR(128) NOT NULL,
        "window"                      VARCHAR(16) NOT NULL DEFAULT 'monthly',
        cost_soft_limit_usd           DOUBLE PRECISION NOT NULL DEFAULT 0.80,
        cost_hard_limit_usd           DOUBLE PRECISION NOT NULL DEFAULT 1.00,
        enforcement_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
        action_on_exceed              VARCHAR(16) NOT NULL DEFAULT 'throttle',
        threshold_alert_pct           INT NOT NULL DEFAULT 80,
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_org_window "
        "ON budgets (org_id, \"window\") "
        "WHERE enforcement_enabled = TRUE",
    )

    # ── 2. budget_consumption — rolling aggregation ───────────────
    _table(
        "budget_consumption",
        """
        id                    UUID PRIMARY KEY,
        org_id                VARCHAR(128) NOT NULL,
        "window"                VARCHAR(16) NOT NULL,
        window_start          TIMESTAMPTZ NOT NULL,
        window_end            TIMESTAMPTZ NOT NULL,
        cost_usd              DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        requests_count        BIGINT NOT NULL DEFAULT 0,
        last_request_at       TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_consumption_active "
        "ON budget_consumption (org_id, \"window\", window_start)",
    )

    # ── 3. budget_actions — append-only audit log ─────────────────
    _table(
        "budget_actions",
        """
        id                UUID PRIMARY KEY,
        org_id            VARCHAR(128) NOT NULL,
        budget_id         VARCHAR(64) NOT NULL,
        action_type       VARCHAR(32) NOT NULL,
        severity          VARCHAR(16) NOT NULL DEFAULT 'medium',
        cost_at_action    DOUBLE PRECISION NOT NULL,
        threshold_pct     INT NOT NULL,
        action_taken      VARCHAR(32) NOT NULL,
        request_id        VARCHAR(128),
        hook_event_id     VARCHAR(64),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_budget_actions_type "
        "ON budget_actions (org_id, action_type, created_at DESC)",
    )
    # --- 053_webhook_dlq.py (rev 053) ---
    def _table(name: str, body: str, extra_index: str = "") -> None:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
            f"ON {name} (org_id, created_at DESC)"
        )
        if extra_index:
            op.execute(extra_index)
    _table(
        "webhook_dlq",
        """
        id                UUID PRIMARY KEY,
        org_id            VARCHAR(128) NOT NULL,
        webhook_id        VARCHAR(64) NOT NULL,
        event_type        VARCHAR(64) NOT NULL,
        payload           TEXT NOT NULL,
        last_response_status INT,
        last_error        TEXT,
        attempt_count     INT NOT NULL,
        max_attempts      INT NOT NULL,
        first_attempt_at  TIMESTAMPTZ,
        last_attempt_at   TIMESTAMPTZ,
        replay_count      INT NOT NULL DEFAULT 0,
        last_replayed_at  TIMESTAMPTZ,
        signature_v1      TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_webhook_dlq_webhook "
        "ON webhook_dlq (org_id, webhook_id, created_at DESC)",
    )

    # ── 2. signature_v1 column on webhook_deliveries ──────────────
    # (Idempotent: ALTER TABLE ... ADD COLUMN IF NOT EXISTS)
    op.execute(
        "ALTER TABLE webhook_deliveries "
        "ADD COLUMN IF NOT EXISTS signature_v1 TEXT"
    )

    # ── 3. webhook_endpoints view (per spec naming) ───────────────
    # The existing ``webhooks`` table holds the same data the
    # spec names ``webhook_endpoints``. We create a view so
    # the spec-aligned API + portal work without forcing a
    # rename of the underlying table.
    op.execute(
        """
        CREATE OR REPLACE VIEW webhook_endpoints AS
        SELECT id, org_id::text AS org_id_text, url, events,
               active, created_at, updated_at
          FROM webhooks
        """
    )
    # --- 054_streaming_tokens.py (rev 054) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS streaming_tokens (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          VARCHAR(128) NOT NULL,
            trace_id        VARCHAR(128) NOT NULL,
            span_id         VARCHAR(128) NOT NULL,
            token_index     INTEGER NOT NULL CHECK (token_index >= 0),
            token_text      TEXT,
            token_byte_len  SMALLINT NOT NULL DEFAULT 0 CHECK (token_byte_len >= 0),
            delta_ms        INTEGER NOT NULL DEFAULT 0 CHECK (delta_ms >= 0),
            abs_ms          INTEGER NOT NULL DEFAULT 0 CHECK (abs_ms >= 0),
            finish_reason   VARCHAR(32),
            redacted        BOOLEAN NOT NULL DEFAULT FALSE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(span_id, token_index)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_streaming_tokens_trace "
        "ON streaming_tokens (org_id, trace_id, token_index)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_streaming_tokens_span "
        "ON streaming_tokens (span_id, token_index)"
    )
    # --- 055_prompt_versioning.py (rev 055) ---
    def _table(name: str, body: str, extra_index: str = "") -> None:
        op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
            f"ON {name} (org_id, created_at DESC)"
        )
        if extra_index:
            op.execute(extra_index)
    op.execute(
        """
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'prompt_versions'
              AND column_name = 'agent'
          ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'prompt_versions'
              AND column_name = 'prompt_id'
          ) THEN
            DROP TABLE prompt_versions CASCADE;
          END IF;
        END $$
        """
    )

    # ── 1. prompts — per-org registry ──────────────────────────────
    _table(
        "prompts",
        """
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id          VARCHAR(128) NOT NULL,
        name            VARCHAR(256) NOT NULL,
        description     TEXT,
        tags            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        auto_eval_on_save BOOLEAN NOT NULL DEFAULT FALSE,
        created_by      VARCHAR(128) NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(org_id, name)
        """,
        "CREATE INDEX IF NOT EXISTS idx_prompts_tags "
        "ON prompts USING GIN (tags)",
    )

    # ── 2. prompt_versions — version timeline ──────────────────────
    _table(
        "prompt_versions",
        """
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id            VARCHAR(128) NOT NULL,
        prompt_id         UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        version           INTEGER NOT NULL,
        template          TEXT NOT NULL,
        template_hash     VARCHAR(64) NOT NULL,
        model             VARCHAR(64) NOT NULL,
        params            JSONB NOT NULL DEFAULT '{}'::jsonb,
        variables         JSONB NOT NULL DEFAULT '[]'::jsonb,
        parent_version_id UUID REFERENCES prompt_versions(id),
        change_note       TEXT,
        created_by        VARCHAR(128) NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(prompt_id, version)
        """,
        "CREATE INDEX IF NOT EXISTS idx_prompt_versions_template_hash "
        "ON prompt_versions (template_hash)",
    )

    # ── 3. prompt_eval_runs — auto-eval history ────────────────────
    _table(
        "prompt_eval_runs",
        """
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id               VARCHAR(128) NOT NULL,
        prompt_version_id    UUID NOT NULL REFERENCES prompt_versions(id) ON DELETE CASCADE,
        dataset_id           UUID,
        baseline_version_id  UUID REFERENCES prompt_versions(id),
        status               VARCHAR(16) NOT NULL DEFAULT 'pending',
        results              JSONB,
        scores_summary       JSONB,
        n_evaluated          INT NOT NULL DEFAULT 0,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at           TIMESTAMPTZ,
        completed_at         TIMESTAMPTZ,
        CHECK (status IN ('pending', 'running', 'completed', 'failed'))
        """,
        "CREATE INDEX IF NOT EXISTS idx_prompt_eval_runs_version "
        "ON prompt_eval_runs (prompt_version_id, created_at DESC)",
    )

    # ── 4. telemetry_events.prompt_version_id (nullable FK) ────────
    # No backfill — existing rows stay NULL. The portal renders
    # "no version tracked" for NULL prompt_version_id.
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS prompt_version_id UUID"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_prompt_version "
        "ON telemetry_events (prompt_version_id) "
        "WHERE prompt_version_id IS NOT NULL"
    )
    # --- 056_onboarding_state.py (rev 056) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS onboarding_state (
            org_id              VARCHAR(128) PRIMARY KEY,
            current_step        VARCHAR(32) NOT NULL DEFAULT 'install',
            completed_steps     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
            cat_enablements     JSONB NOT NULL DEFAULT '{}'::jsonb,
            first_trace_at      TIMESTAMPTZ,
            milestones_reached  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (current_step IN (
                'install', 'org', 'connect', 'wait',
                'done', 'tour', 'autonomous'
            ))
        )
        """
    )
    # GIN index on milestones_reached for fast "has org X reached
    # milestone Y" lookups (the hook bus uses this on every
    # first_10_traces / first_judge_score / first_prompt_version emit).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_onboarding_milestones "
        "ON onboarding_state USING GIN (milestones_reached)"
    )
    # --- 057_mcp_traces.py (rev 057) ---
    op.execute(
        """
        CREATE OR REPLACE VIEW mcp_traces_v AS
        SELECT
            event_id                                   AS trace_id,
            tenant_id                                  AS org_id,
            (attributes->'mcp'->>'server_name')        AS mcp_server_name,
            (attributes->'mcp'->>'tool_name')          AS mcp_tool_name,
            (attributes->'mcp'->>'resource_uri')       AS mcp_resource_uri,
            (attributes->'mcp'->>'prompt_name')        AS mcp_prompt_name,
            (attributes->'mcp'->>'sampling_requested')::boolean
                                                     AS mcp_sampling,
            (attributes->'mcp'->>'transport')         AS mcp_transport,
            created_at
          FROM telemetry_events
         WHERE attributes ? 'mcp'
        """
    )
    # ── Index on the JSON path for fast filtering
    #    (the spec calls out that this index is the
    #    performance-critical read path).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_mcp_server "
        "ON telemetry_events ((attributes->'mcp'->>'server_name')) "
        "WHERE attributes ? 'mcp'"
    )

    # ── Auth-failure audit table (per §E.1
    #    ``mcp_server_auth_failure`` hook).
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS mcp_server_auth_failures (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          VARCHAR(128) NOT NULL,
            server_name     TEXT NOT NULL,
            transport       TEXT,                -- 'stdio' | 'http_sse' | 'websocket'
            failure_kind    TEXT NOT NULL,       -- 'unauthorized' | 'expired_token' | 'dns' | 'tls' | 'other'
            error_message   TEXT,
            trace_id        UUID,
            span_id         UUID,
            occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at     TIMESTAMPTZ,
            resolved_by     VARCHAR(128)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_mcp_auth_failures_org "
        "ON mcp_server_auth_failures(org_id, occurred_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_mcp_auth_failures_server "
        "ON mcp_server_auth_failures(server_name, occurred_at DESC)"
    )
    # --- 058_a2a_links.py (rev 058) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS a2a_links (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            parent_trace_id     UUID NOT NULL,
            child_trace_id      UUID NOT NULL,
            parent_agent_id     UUID NOT NULL,
            child_agent_id      UUID NOT NULL,
            parent_span_id      UUID NOT NULL,
            invocation_type     TEXT NOT NULL,
            response_status     TEXT,
            error_kind          TEXT,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(parent_trace_id, parent_span_id, child_trace_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_a2a_links_parent "
        "ON a2a_links(parent_trace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_a2a_links_child "
        "ON a2a_links(child_trace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_a2a_links_org "
        "ON a2a_links(org_id, created_at DESC)"
    )

    # 2 new columns on telemetry_events (per spec §B.5).
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS parent_agent_span_id UUID"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS child_agent_trace_id UUID"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_parent_agent_span "
        "ON telemetry_events(parent_agent_span_id) "
        "WHERE parent_agent_span_id IS NOT NULL"
    )
    # --- 059_computer_use.py (rev 059) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS computer_use_steps (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            trace_id            UUID NOT NULL,
            span_id             UUID NOT NULL,
            step_index          INTEGER NOT NULL,
            screenshot_before   TEXT,
            screenshot_after    TEXT,
            action_type         TEXT NOT NULL,
            action_payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
            target_app          TEXT,
            target_coords       JSONB,
            success             BOOLEAN,
            error               TEXT,
            duration_ms         INTEGER,
            blocked             BOOLEAN NOT NULL DEFAULT FALSE,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(span_id, step_index),
            CHECK (action_type IN (
                'click', 'type', 'scroll', 'drag', 'key', 'wait'
            ))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_computer_use_steps_trace "
        "ON computer_use_steps(trace_id, step_index)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_computer_use_steps_org "
        "ON computer_use_steps(org_id, created_at DESC)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS computer_use_screenshots_tombstoned (
            s3_uri              TEXT PRIMARY KEY,
            org_id              VARCHAR(128) NOT NULL,
            trace_id            UUID NOT NULL,
            tombstoned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            tombstoned_by       VARCHAR(128),
            reason              TEXT
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_cu_screenshots_tombstoned_org "
        "ON computer_use_screenshots_tombstoned(org_id, tombstoned_at DESC)"
    )
    # --- 060_voice_sessions.py (rev 060) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS voice_sessions (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            trace_id            UUID NOT NULL,
            span_id             UUID NOT NULL,
            session_id          TEXT NOT NULL,
            transport           TEXT,
            asr_provider         TEXT,
            asr_latency_ms       INTEGER,
            asr_confidence      NUMERIC(4,3),
            asr_input_audio_ms  INTEGER,
            llm_first_audio_ms  INTEGER,
            tts_provider         TEXT,
            tts_first_byte_ms    INTEGER,
            tts_total_ms         INTEGER,
            barge_in_detected    BOOLEAN NOT NULL DEFAULT FALSE,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_voice_sessions_trace "
        "ON voice_sessions(trace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_voice_sessions_session "
        "ON voice_sessions(session_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_voice_sessions_org_barge "
        "ON voice_sessions(org_id, created_at DESC) "
        "WHERE barge_in_detected = TRUE"
    )
    # --- 061_fine_tune_lineage.py (rev 061) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS fine_tuning_runs (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            provider            TEXT NOT NULL,
            provider_fine_tune_id TEXT,
            base_model          TEXT NOT NULL,
            fine_tuned_model    TEXT NOT NULL,
            dataset_id          UUID NOT NULL,
            training_params     JSONB NOT NULL DEFAULT '{}'::jsonb,
            status              TEXT NOT NULL DEFAULT 'pending',
            eval_results        JSONB,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at        TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_fine_tuning_runs_org "
        "ON fine_tuning_runs(org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_fine_tuning_runs_org_status "
        "ON fine_tuning_runs(org_id, status)"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_fine_tuning_provider_id "
        "ON fine_tuning_runs(provider, provider_fine_tune_id) "
        "WHERE provider_fine_tune_id IS NOT NULL"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_trace_lineage (
            dataset_id          UUID NOT NULL,
            trace_id            UUID NOT NULL,
            span_id             UUID,
            added_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (dataset_id, trace_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_dataset_trace_lineage_trace "
        "ON dataset_trace_lineage(trace_id)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS fine_tune_trace_usage (
            fine_tuning_run_id  UUID NOT NULL
                                REFERENCES fine_tuning_runs(id) ON DELETE CASCADE,
            trace_id            UUID NOT NULL,
            first_used_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (fine_tuning_run_id, trace_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_fine_tune_trace_usage_trace "
        "ON fine_tune_trace_usage(trace_id)"
    )
    # --- 062_provider_routing.py (rev 062) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS provider_routing_attempts (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            trace_id            UUID NOT NULL,
            span_id             UUID NOT NULL,
            attempted_provider  TEXT NOT NULL,
            attempted_model     TEXT NOT NULL,
            failure_reason      TEXT,
            latency_ms          INTEGER,
            decision            TEXT NOT NULL,
            sequence_index      INTEGER NOT NULL,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(trace_id, sequence_index),
            CHECK (decision IN ('success', 'fallback', 'retry', 'abort'))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_provider_routing_trace "
        "ON provider_routing_attempts(trace_id, sequence_index)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_provider_routing_provider_time "
        "ON provider_routing_attempts(attempted_provider, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_provider_routing_org_time "
        "ON provider_routing_attempts(org_id, created_at DESC) "
        "WHERE decision IN ('fallback', 'abort')"
    )
    # --- 063_sidebar_prefs.py (rev 063) ---
    op.execute("""
        CREATE TABLE IF NOT EXISTS sidebar_prefs (
            user_id    UUID NOT NULL,
            org_id     UUID NOT NULL,
            prefs      JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, org_id)
        );
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_sidebar_prefs_org_id "
        "ON sidebar_prefs (org_id);"
    )
    # --- 064_org_clerk_org_id.py (rev 064) ---
    op.execute(
        "ALTER TABLE organizations "
        "ADD COLUMN IF NOT EXISTS clerk_org_id TEXT"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_clerk_org_id "
        "ON organizations (clerk_org_id) WHERE clerk_org_id IS NOT NULL"
    )
    # --- 065_judge_cost.py (rev 065) ---
    op.execute(
        "ALTER TABLE judge_scores "
        "ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 8) NOT NULL DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE judge_scores "
        "ADD COLUMN IF NOT EXISTS cached BOOLEAN NOT NULL DEFAULT FALSE"
    )
    # Cheap partial index for dashboard queries that filter on
    # cached=FALSE (the non-cache-hit rows that drove spend).
    # Audit 2026-07-03 — asyncpg chokes on ``WHERE cached = FALSE``
    # in CREATE INDEX ("unrecognized node type: 0"); ``NOT cached``
    # is semantically identical and parses cleanly through asyncpg.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_judge_scores_uncached "
        "ON judge_scores (tenant_id, scored_at DESC) "
        "WHERE NOT cached"
    )
    # --- 066_session21_indexes.py (rev 066) ---
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_ts "
        'ON telemetry_events (tenant_id, "timestamp" DESC)'
    )
    # 2. (tenant_id, agent_id, created_at DESC) on telemetry_events
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_agent_ts "
        "ON telemetry_events (tenant_id, agent_id, created_at DESC)"
    )
    # 3. usage_events has no agent_id column (cost is tracked on the
    # ``model`` column instead — see idx_usage_events_model). The
    # original index tried to create on a non-existent column and
    # crashed every upgrade. Audit 2026-07-03 — replaced with an
    # index on the column that actually carries the per-model
    # breakdown. Index name kept for downstream tooling pivot.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_agent_ts "
        "ON usage_events (org_id, created_at DESC) "
        "WHERE model IS NOT NULL"
    )
    # 4. (tenant_id, judge_name, scored_at DESC) on judge_scores.
    # Audit 2026-07-03 — judge_scores has no ``agent_id`` column
    # (judges score traces, not agents); use ``judge_name`` for the
    # Cat-3 evaluator cohort rollup. Index name kept for downstream
    # tooling pivot compatibility.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_judge_scores_tenant_agent_ts "
        "ON judge_scores (tenant_id, judge_name, scored_at DESC)"
    )
    # 5. partial handoff index on telemetry_events.
    # Audit 2026-07-03 — telemetry_events has no parent_agent_id
    # column (parentage is encoded via parent_span_id). Index on
    # (tenant_id, span_id, created_at DESC) covers the same handoff
    # analyzer read path. Index name kept for downstream pivot.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_parent_agent "
        "ON telemetry_events (tenant_id, span_id, created_at DESC) "
        "WHERE parent_span_id IS NOT NULL"
    )
    # 6. (org_id, handoff_count DESC) on agent_relationships
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_relationships_org_handoff_count "
        "ON agent_relationships (org_id, handoff_count DESC)"
    )
    # 7. (org_id, memory_id, created_at DESC) on memory_attributions
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_attributions_org_memory_ts "
        "ON memory_attributions (org_id, memory_id, created_at DESC)"
    )
    # 8. (org_id, memory_id, created_at DESC) on memory_timeline_events
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_timeline_events_org_memory_ts "
        "ON memory_timeline_events (org_id, memory_id, created_at DESC)"
    )
    # 9. (org_id, first_event_at DESC) on user_sessions
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_org_first_event "
        "ON user_sessions (org_id, first_event_at DESC)"
    )
    # 10. (org_id, user_id, created_at DESC) on user_satisfaction_corrected
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_user_satisfaction_corrected_org_user_ts "
        "ON user_satisfaction_corrected (org_id, user_id, created_at DESC)"
    )
    # 11. partial pending_approval index on closed_loop_actions
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_closed_loop_actions_pending "
        "ON closed_loop_actions (org_id, status) "
        "WHERE status = 'pending_approval'"
    )
    # --- 067_trace_quality_otel_columns.py (rev 067) ---
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS provider_name VARCHAR(64) "
        "NOT NULL DEFAULT 'unknown'"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS operation_name VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS error_type VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS model_name VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS usage_prompt_tokens INTEGER"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS usage_completion_tokens INTEGER"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS usage_total_tokens INTEGER"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS ttft_ms INTEGER"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS finish_reason VARCHAR(32)"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS is_llm_generated BOOLEAN "
        "NOT NULL DEFAULT FALSE"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS is_batch BOOLEAN NOT NULL DEFAULT FALSE"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS batch_id VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS retry_attempt INTEGER NOT NULL DEFAULT 0"
    )
    # 3 partial indexes that the sidecar worker hot path needs.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_trace_ts "
        "ON telemetry_events (tenant_id, trace_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_source_format "
        "ON telemetry_events (tenant_id, source_format)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_operation_name "
        "ON telemetry_events (tenant_id, operation_name) "
        "WHERE operation_name IS NOT NULL"
    )
    # --- 068_trace_efficiency_reports.py (rev 068) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_efficiency_reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
            tas INTEGER,
            avs INTEGER,
            vae INTEGER,
            grade VARCHAR(2),
            intervention VARCHAR(16) NOT NULL DEFAULT 'allow',
            fix_patches JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT trace_efficiency_reports_grade_chk
                CHECK (grade IS NULL OR grade IN ('A','B','C','D','F')),
            CONSTRAINT trace_efficiency_reports_intervention_chk
                CHECK (intervention IN
                       ('allow','warn','redact','block','escalate')),
            CONSTRAINT trace_efficiency_reports_tas_range_chk
                CHECK (tas IS NULL OR (tas >= 0 AND tas <= 100))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_efficiency_reports_tenant_trace "
        "ON trace_efficiency_reports (tenant_id, trace_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_efficiency_reports_low_grade "
        "ON trace_efficiency_reports (tenant_id, grade) "
        "WHERE grade IN ('D','F')"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_efficiency_reports_block "
        "ON trace_efficiency_reports (tenant_id, intervention) "
        "WHERE intervention IN ('block','escalate')"
    )
    # --- 069_trace_loop_reports.py (rev 069) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_loop_reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            verdict VARCHAR(8) NOT NULL DEFAULT 'OK',
            detectors_tripped JSONB NOT NULL DEFAULT '[]'::jsonb,
            severity VARCHAR(8) NOT NULL DEFAULT 'low',
            action VARCHAR(16) NOT NULL DEFAULT 'allow',
            max_cosine REAL,
            max_jaccard REAL,
            step_index INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT trace_loop_reports_verdict_chk
                CHECK (verdict IN ('OK','LOOP')),
            CONSTRAINT trace_loop_reports_severity_chk
                CHECK (severity IN ('low','medium','high')),
            CONSTRAINT trace_loop_reports_action_chk
                CHECK (action IN ('allow','block','escalate'))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_loop_reports_tenant_trace "
        "ON trace_loop_reports (tenant_id, trace_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_loop_reports_high_severity "
        "ON trace_loop_reports (tenant_id, severity) "
        "WHERE severity = 'high'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_loop_reports_loop_verdict "
        "ON trace_loop_reports (tenant_id, verdict) "
        "WHERE verdict = 'LOOP'"
    )
    # --- 070_trace_quality_reports.py (rev 070) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_quality_reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            hallucination_score REAL,
            groundedness REAL,
            tool_relevance REAL,
            step_coherence REAL,
            components JSONB NOT NULL DEFAULT '{}'::jsonb,
            verdict VARCHAR(16) NOT NULL DEFAULT 'allow',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT trace_quality_reports_verdict_chk
                CHECK (verdict IN ('allow','warn','block','manual_review')),
            CONSTRAINT trace_quality_reports_score_range_chk
                CHECK (
                    (hallucination_score IS NULL
                     OR (hallucination_score >= 0
                         AND hallucination_score <= 1))
                    AND (groundedness IS NULL
                         OR (groundedness >= 0 AND groundedness <= 1))
                    AND (tool_relevance IS NULL
                         OR (tool_relevance >= 0 AND tool_relevance <= 1))
                    AND (step_coherence IS NULL
                         OR (step_coherence >= 0 AND step_coherence <= 1))
                )
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_quality_reports_tenant_trace "
        "ON trace_quality_reports (tenant_id, trace_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_quality_reports_block "
        "ON trace_quality_reports (tenant_id, verdict) "
        "WHERE verdict = 'block'"
    )
    # --- 071_trace_reasoning_reports.py (rev 071) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_reasoning_reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            coherence REAL,
            informativeness REAL,
            goal_alignment REAL,
            verification REAL,
            calibration_error REAL,
            composite REAL,
            lanham_trap BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT trace_reasoning_reports_score_range_chk
                CHECK (
                    (coherence IS NULL
                     OR (coherence >= 0 AND coherence <= 1))
                    AND (informativeness IS NULL
                         OR (informativeness >= 0
                             AND informativeness <= 1))
                    AND (goal_alignment IS NULL
                         OR (goal_alignment >= 0
                             AND goal_alignment <= 1))
                    AND (verification IS NULL
                         OR (verification >= 0
                             AND verification <= 1))
                    AND (calibration_error IS NULL
                         OR (calibration_error >= 0
                             AND calibration_error <= 1))
                    AND (composite IS NULL
                         OR (composite >= 0 AND composite <= 1))
                )
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_reasoning_reports_tenant_trace "
        "ON trace_reasoning_reports (tenant_id, trace_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_reasoning_reports_low_composite "
        "ON trace_reasoning_reports (tenant_id) WHERE composite < 0.5"
    )
    # --- 072_trace_guardrail_actions.py (rev 072) ---
    ACTION_CLASSES = (
        "record_to_table",
        "emit_audit_event",
        "emit_drift_alert",
        "rewrite_response",
        "coalesce_step",
        "truncate_context",
        "block_user",
        "escalate_to_admin",
        "revoke_api_key",
        "apply_policy_change",
    )
    _MUTATING = (
        "truncate_context",
        "block_user",
        "escalate_to_admin",
        "revoke_api_key",
        "apply_policy_change",
    )
    enum_sql = "', '".join(ACTION_CLASSES)
    op.execute(
        f"""
        CREATE TABLE IF NOT EXISTS trace_guardrail_actions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            step_index INTEGER NOT NULL,
            agent_id VARCHAR(128),
            action_class VARCHAR(32) NOT NULL,
            recommended BOOLEAN NOT NULL DEFAULT TRUE,
            applied BOOLEAN NOT NULL DEFAULT FALSE,
            reason VARCHAR(512),
            kill_switch_state BOOLEAN,
            payload JSONB NOT NULL DEFAULT '{{}}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT trace_guardrail_actions_class_chk
                CHECK (action_class IN ('{enum_sql}')),
            CONSTRAINT trace_guardrail_actions_applied_chk
                CHECK (applied IN (TRUE, FALSE)),
            CONSTRAINT trace_guardrail_actions_step_chk
                CHECK (step_index >= 0)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_trace_guardrail_actions_tenant_trace_step "
        "ON trace_guardrail_actions "
        "(tenant_id, trace_id, step_index)"
    )
    mutating_sql = "', '".join(_MUTATING)
    op.execute(
        f"""
        CREATE INDEX IF NOT EXISTS
        idx_trace_guardrail_actions_pending_mutating
        ON trace_guardrail_actions (tenant_id, action_class, created_at DESC)
        WHERE applied = FALSE AND action_class IN ('{mutating_sql}')
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_trace_guardrail_actions_audit "
        "ON trace_guardrail_actions (tenant_id, created_at DESC)"
    )
    # --- 073_tenant_guardrail_action_config.py (rev 073) ---
    ACTION_CLASSES = (
        "record_to_table",
        "emit_audit_event",
        "emit_drift_alert",
        "rewrite_response",
        "coalesce_step",
        "truncate_context",
        "block_user",
        "escalate_to_admin",
        "revoke_api_key",
        "apply_policy_change",
    )
    _READ_ONLY = {
        "record_to_table": True,
        "emit_audit_event": True,
        "emit_drift_alert": True,
        "rewrite_response": True,
        "coalesce_step": True,
        "truncate_context": False,
        "block_user": False,
        "escalate_to_admin": False,
        "revoke_api_key": False,
        "apply_policy_change": False,
    }
    enum_sql = "', '".join(ACTION_CLASSES)
    op.execute(
        f"""
        CREATE TABLE IF NOT EXISTS tenant_guardrail_action_config (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            action_class VARCHAR(32) NOT NULL,
            applied_by_default BOOLEAN NOT NULL,
            updated_by VARCHAR(128),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT tenant_guardrail_action_config_class_chk
                CHECK (action_class IN ('{enum_sql}')),
            CONSTRAINT tenant_guardrail_action_config_uq
                UNIQUE (tenant_id, action_class)
        )
        """
    )
    # Per-action partial index — drives the hot-path read on every
    # trajectory step.
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_tenant_guardrail_action_config_lookup "
        "ON tenant_guardrail_action_config "
        "(tenant_id, action_class) INCLUDE (applied_by_default)"
    )
    # Seed defaults from any pre-existing tenant rows. The
    # tenanted_orgs table is the canonical tenant registry;
    # fall back to ``tenants`` if it doesn't exist.
    # Audit 2026-07-03 — wrap the parametrised probe in ``text(...)``
    # so the sync psycopg2 engine accepts it; the pre-fix raw string
    # worked with asyncpg but raised ``Not an executable object`` on
    # the sync path.
    from sqlalchemy import text

    for table in ("tenanted_orgs", "tenants", "orgs"):
        # ponytail: existence probe via to_regclass so the
        # seed step is no-op when the tenant table is missing.
        exists = op.get_bind().execute(
            text("SELECT 1 FROM pg_class WHERE relname = :t"),
            {"t": table},
        ).fetchone()
        if not exists:
            continue
        for action_class, default in _READ_ONLY.items():
            op.execute(
                text(
                    f"""
                    INSERT INTO tenant_guardrail_action_config
                        (tenant_id, action_class, applied_by_default)
                    SELECT id, :action, :default
                    FROM {table}
                    ON CONFLICT (tenant_id, action_class) DO NOTHING
                    """
                ),
                {"action": action_class, "default": default},
            )
        break  # seed from first existing tenant table
    # --- 074_hook_repetition_closed_loop.py (rev 074_hook_repetition_closed_loop) ---
    op.execute(
        "ALTER TABLE closed_loop_actions "
        "ADD COLUMN IF NOT EXISTS repetition_count INTEGER NOT NULL DEFAULT 1"
    )
    # Partial index for the "show me the noisy hooks" query.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_closed_loop_actions_repetition "
        "ON closed_loop_actions (org_id, hook_name) "
        "WHERE repetition_count > 1"
    )
    # --- 075_uniqueness_constraints.py (rev 075) ---
    _DEDUP_SQL = [
        # agent_performance_snapshots — tuple is (org_id, agent_id, window_name)
        """
        DELETE FROM agent_performance_snapshots
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY org_id, agent_id, window_name
                           ORDER BY id DESC
                       ) AS rn
                  FROM agent_performance_snapshots
            ) t
            WHERE rn > 1
        )
        """,
        # agent_relationships — tuple is (org_id, parent_agent_id, child_agent_id)
        """
        DELETE FROM agent_relationships
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY org_id, parent_agent_id, child_agent_id
                           ORDER BY id DESC
                       ) AS rn
                  FROM agent_relationships
            ) t
            WHERE rn > 1
        )
        """,
        # agent_benchmark_runs — tuple is (org_id, agent_id, dataset_id).
        # ``dataset_id`` is nullable; Postgres considers each NULL
        # distinct, so the UNIQUE holds for non-NULL rows. The
        # dedup CTE partitions on (org_id, agent_id, dataset_id)
        # so the dedup matches the UNIQUE.
        """
        DELETE FROM agent_benchmark_runs
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY org_id, agent_id, dataset_id
                           ORDER BY id DESC
                       ) AS rn
                  FROM agent_benchmark_runs
            ) t
            WHERE rn > 1
        )
        """,
        # user_behavioural_signals — tuple is (org_id, trace_id).
        """
        DELETE FROM user_behavioural_signals
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY org_id, trace_id
                           ORDER BY id DESC
                       ) AS rn
                  FROM user_behavioural_signals
            ) t
            WHERE rn > 1
        )
        """,
    ]
    def _add_unique_if_missing(table: str, constraint: str, columns: str) -> None:
        """Add a UNIQUE constraint named ``constraint`` on ``table``
        if it doesn't already exist. Uses ``information_schema`` so
        it's idempotent against re-runs (the audit risk is the
        migration being run on a partially-migrated DB).
        """
        op.execute(
            f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.table_constraints
                     WHERE constraint_name = '{constraint}'
                       AND table_name = '{table}'
                ) THEN
                    ALTER TABLE {table}
                    ADD CONSTRAINT {constraint} UNIQUE ({columns});
                END IF;
            END$$;
            """
        )
    for stmt in _DEDUP_SQL:
        op.execute(stmt)
    # Step 2 adds the constraints that the new UPSERT paths rely on.
    _add_unique_if_missing(
        "agent_performance_snapshots",
        "uq_agent_performance_snapshots_tuple",
        "org_id, agent_id, window_name",
    )
    _add_unique_if_missing(
        "agent_relationships",
        "uq_agent_relationships_tuple",
        "org_id, parent_agent_id, child_agent_id",
    )
    _add_unique_if_missing(
        "agent_benchmark_runs",
        "uq_agent_benchmark_runs_tuple",
        "org_id, agent_id, dataset_id",
    )
    _add_unique_if_missing(
        "user_behavioural_signals",
        "uq_user_behavioural_signals_tuple",
        "org_id, trace_id",
    )
    # --- 076_account_lockout.py (rev 076) ---
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS failed_login_count INTEGER "
        "NOT NULL DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ"
    )
    # token_version is bumped on password change / reset / account
    # deletion. The change-password route has used it since 2026-06
    # without a declaring migration — this commit adds the column
    # so the existing UPDATE statements stop failing in fresh DBs.
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS token_version INTEGER "
        "NOT NULL DEFAULT 0"
    )
    # last_seen_at backs the idle-timeout check in get_current_user.
    # Updated best-effort on every authenticated request; if a
    # token's iat predates ``last_seen_at - 30min`` the request is
    # rejected as idle-expired.
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ"
    )
    # --- 077_password_reset_tokens.py (rev 077) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id VARCHAR(128) NOT NULL,
            token_hash VARCHAR(64) NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL,
            ip_address VARCHAR(64),
            user_agent VARCHAR(512)
        )
        """
    )
    # create_index on token_hash (unique=True) for O(log N) lookup
    # and to prevent duplicate inserts of the same token hash.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash "
        "ON password_reset_tokens (token_hash)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id "
        "ON password_reset_tokens (user_id)"
    )
    # --- 078_two_factor_recovery_codes.py (rev 078) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS two_factor_recovery_codes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id VARCHAR(128) NOT NULL,
            code_hash VARCHAR(64) NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_recovery_codes_user "
        "ON two_factor_recovery_codes (user_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_recovery_codes_code_hash "
        "ON two_factor_recovery_codes (code_hash)"
    )
    # --- 079_org_pii_policy_mode.py (rev 079) ---
    op.execute("""
        ALTER TABLE org_pii_policies
        ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'redact'
    """)
    # Backfill: rows that already had fail_closed_on_credentials=true
    # should report mode='fail_closed' so the GET handler's derived
    # value matches the stored one.
    op.execute("""
        UPDATE org_pii_policies
        SET mode = 'fail_closed'
        WHERE fail_closed_on_credentials = TRUE
          AND (mode IS NULL OR mode = 'redact')
    """)
    op.execute("""
        UPDATE org_pii_policies
        SET mode = 'off'
        WHERE enabled_categories = '{}'::text[]
          AND (mode IS NULL OR mode = 'redact')
    """)
    # --- 081_org_cost_overrides.py (rev 081) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_cost_overrides (
            override_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            provider VARCHAR(32) NOT NULL,
            model_id VARCHAR(128) NOT NULL,
            cost_per_1k_input NUMERIC(12, 8) NOT NULL,
            cost_per_1k_output NUMERIC(12, 8) NOT NULL,
            currency CHAR(3) NOT NULL DEFAULT 'USD',
            source VARCHAR(32) NOT NULL DEFAULT 'manual',
            effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            effective_until TIMESTAMPTZ,
            notes TEXT,
            created_by UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    # Lookup index for the hot path (org + provider + model +
    # currently-effective range). Partial index keeps it small
    # because most orgs have only a handful of overrides.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_org_cost_overrides_lookup
            ON org_cost_overrides (org_id, provider, model_id, effective_from DESC)
            WHERE effective_until IS NULL
        """
    )
    # Per-org scan index for the admin GET that returns all
    # overrides for an org.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_org_cost_overrides_org
            ON org_cost_overrides (org_id, effective_from DESC)
        """
    )
    # --- 082_org_cost_overrides_cache.py (rev 082) ---
    op.execute(
        """
        ALTER TABLE org_cost_overrides
            ADD COLUMN IF NOT EXISTS cost_per_1k_cache_read NUMERIC(12, 8),
            ADD COLUMN IF NOT EXISTS cost_per_1k_cache_write NUMERIC(12, 8)
        """
    )
    # --- 083_fix_pr_rejection_memory_index.py (rev 083) ---
    def _table_exists(table_name: str) -> bool:
        conn = op.get_bind()
        row = conn.execute(
            sa.text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = :t"
            ),
            {"t": table_name},
        ).first()
        return row is not None
    if not _table_exists("pr_rejection_memory"):
        return
    op.execute("DROP INDEX IF EXISTS idx_pr_rejection_memory_active")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_active "
        "ON pr_rejection_memory (org_id, file_path, title_hash, expires_at)"
    )
    # --- 084_agent_issues.py (rev 084) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_stumbles (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id        VARCHAR(128) NOT NULL,
            trace_id      VARCHAR(128) NOT NULL,
            session_id    VARCHAR(128),
            user_id       VARCHAR(256),
            agent_id      VARCHAR(256),
            span_id       VARCHAR(128),
            kind          VARCHAR(32) NOT NULL,
            fingerprint   VARCHAR(64) NOT NULL,
            title         TEXT NOT NULL,
            detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
            severity      VARCHAR(4) NOT NULL
                          CHECK (severity IN ('p0','p1','p2','p3')),
            detected_by   VARCHAR(64) NOT NULL,
            detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_agent_stumbles_dedup
                UNIQUE (org_id, trace_id, kind, fingerprint)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_stumbles_fingerprint "
        "ON agent_stumbles (org_id, fingerprint, detected_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_stumbles_trace "
        "ON agent_stumbles (org_id, trace_id, detected_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_stumbles_agent "
        "ON agent_stumbles (org_id, agent_id, kind, detected_at DESC)"
    )

    # ── agent_issues ────────────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_issues (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            fingerprint         VARCHAR(64) NOT NULL,
            kind                VARCHAR(32) NOT NULL,
            title               TEXT NOT NULL,
            status              VARCHAR(16) NOT NULL DEFAULT 'open'
                                CHECK (status IN (
                                    'open','triaged','fix_pending','verifying',
                                    'resolved','regressed','ignored','learning'
                                )),
            severity            VARCHAR(4) NOT NULL
                                CHECK (severity IN ('p0','p1','p2','p3')),
            agent_id            VARCHAR(256),
            first_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            stumble_count       INTEGER NOT NULL DEFAULT 1,
            user_count          INTEGER NOT NULL DEFAULT 1,
            repetition_count    INTEGER NOT NULL DEFAULT 1,
            affected_user_ids   TEXT[] NOT NULL DEFAULT '{}',
            example_stumble_ids UUID[] NOT NULL DEFAULT '{}',
            triage_result       JSONB,
            assignee            VARCHAR(256),
            experiment_id       UUID,
            resolved_at         TIMESTAMPTZ,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_agent_issues_fingerprint
                UNIQUE (org_id, fingerprint)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_issues_org_status "
        "ON agent_issues (org_id, status, severity, last_seen DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_issues_fingerprint "
        "ON agent_issues (org_id, fingerprint, last_seen DESC)"
    )
    # "repeat incident" surface (Wave 7 badge).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_issues_repetition "
        "ON agent_issues (org_id, status) WHERE repetition_count > 1"
    )
    # --- 085_issue_state_transitions.py (rev 085) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS issue_state_transitions (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id       VARCHAR(128) NOT NULL,
            issue_id     UUID NOT NULL,
            from_status  VARCHAR(16),
            to_status    VARCHAR(16) NOT NULL,
            event_type   VARCHAR(48) NOT NULL,
            reason       TEXT,
            actor        VARCHAR(64) NOT NULL DEFAULT 'orchestrator',
            detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_state_transitions_issue "
        "ON issue_state_transitions (issue_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_state_transitions_org "
        "ON issue_state_transitions (org_id, created_at DESC)"
    )
    # --- 086_autonomy_policies.py (rev 086) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS autonomy_policies (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            agent_id            VARCHAR(256),
            policy              JSONB NOT NULL DEFAULT '{}'::jsonb,
            compliance_profile  VARCHAR(24) NOT NULL DEFAULT 'standard'
                                CHECK (compliance_profile IN
                                    ('standard','hipaa','soc2_strict')),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    # UNIQUE (org_id, agent_id) — but NULLs are distinct in Postgres, so a
    # partial unique index enforces a single org-default (agent_id IS NULL)
    # row alongside the composite unique for agent rows.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_autonomy_policies_org_agent "
        "ON autonomy_policies (org_id, agent_id) "
        "WHERE agent_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_autonomy_policies_org_default "
        "ON autonomy_policies (org_id) "
        "WHERE agent_id IS NULL"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS autonomy_audit_log (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id        VARCHAR(128) NOT NULL,
            agent_id      VARCHAR(256),
            action        VARCHAR(64) NOT NULL,
            tier_applied  VARCHAR(32) NOT NULL,
            decision      VARCHAR(24) NOT NULL
                          CHECK (decision IN
                              ('allow','deny','require_approval')),
            reason        TEXT,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_autonomy_audit_org "
        "ON autonomy_audit_log (org_id, created_at DESC)"
    )
    # --- 087_issue_verifications.py (rev 087) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS issue_verifications (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id        VARCHAR(128) NOT NULL,
            issue_id      UUID NOT NULL,
            fingerprint   VARCHAR(64) NOT NULL,
            ref           VARCHAR(128),
            scheduled_at  TIMESTAMPTZ NOT NULL,
            status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                          CHECK (status IN
                              ('pending','passed','failed','cancelled')),
            attempts      INTEGER NOT NULL DEFAULT 0,
            detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at  TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_verifications_due "
        "ON issue_verifications (status, scheduled_at)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_verifications_issue "
        "ON issue_verifications (org_id, issue_id)"
    )
    # At most one live (pending) verify per issue — re-scheduling replaces.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_verifications_pending "
        "ON issue_verifications (org_id, issue_id) "
        "WHERE status = 'pending'"
    )
    # --- 088_org_member_last_writer.py (rev 088) ---
    op.execute(
        """
        ALTER TABLE org_members
        ADD COLUMN IF NOT EXISTS last_writer_source TEXT NOT NULL DEFAULT 'clerk'
            CHECK (last_writer_source IN ('clerk', 'local'))
        """
    )
    # --- 089_n16_n09_cost_platform.py (rev 089) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_sampling_summaries (
            org_id TEXT NOT NULL,
            trace_id TEXT NOT NULL,
            agent_id TEXT,
            duration_ms INT NOT NULL DEFAULT 0,
            cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
            span_count INT NOT NULL DEFAULT 0,
            dropped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            drop_reason TEXT NOT NULL DEFAULT 'sampled_out',
            PRIMARY KEY (org_id, trace_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_trace_sampling_summaries_dropped
        ON trace_sampling_summaries (org_id, dropped_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS span_content_blobs (
            org_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            content BYTEA NOT NULL,
            content_type TEXT NOT NULL,
            byte_size INT NOT NULL,
            ref_count BIGINT NOT NULL DEFAULT 1,
            first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, content_hash)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_span_content_blobs_type
        ON span_content_blobs (org_id, content_type)
        """
    )
    # --- 090_nl_signals.py (rev 090) ---
    def _users_id_sql_type() -> str:
        """Return SQL type for ``users.id`` (``UUID`` or ``TEXT``)."""
        row = op.get_bind().execute(
            text(
                """
                SELECT data_type
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'users'
                  AND column_name = 'id'
                """
            )
        ).fetchone()
        if row is None:
            return "UUID"
        data_type = (row[0] or "").lower()
        if data_type in ("text", "character varying", "varchar"):
            return "TEXT"
        return "UUID"
    created_by_type = _users_id_sql_type()
    op.execute(
        f"""
        CREATE TABLE IF NOT EXISTS nl_signals (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            description     TEXT NOT NULL,
            rule            JSONB NOT NULL DEFAULT '{{}}'::jsonb,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            created_by      {created_by_type} REFERENCES users(id) ON DELETE SET NULL,
            cluster_id      TEXT,
            last_matched_at TIMESTAMPTZ,
            match_count     INT NOT NULL DEFAULT 0,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nl_signals_org_created
        ON nl_signals (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nl_signals_cluster
        ON nl_signals (org_id, cluster_id, created_at DESC)
        WHERE cluster_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION nl_signals_touch_updated() RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_nl_signals_touch_updated ON nl_signals")
    op.execute(
        """
        CREATE TRIGGER trg_nl_signals_touch_updated
            BEFORE UPDATE ON nl_signals
            FOR EACH ROW EXECUTE FUNCTION nl_signals_touch_updated()
        """
    )
    # --- 092_market_ready_consolidated.py (rev 092) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS signal_definitions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            output_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            source_search_query TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS signal_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            signal_id UUID NOT NULL REFERENCES signal_definitions(id) ON DELETE CASCADE,
            trace_id TEXT NOT NULL,
            matched BOOLEAN NOT NULL,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            investigator_confidence REAL,
            detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_signal_events_trace
        ON signal_events (trace_id)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_call_labels (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            span_id TEXT NOT NULL,
            trace_id TEXT NOT NULL,
            agent_id TEXT,
            label TEXT NOT NULL CHECK (label IN ('good', 'bad')),
            reason TEXT,
            tool_name TEXT NOT NULL,
            args_hash TEXT,
            labeled_by TEXT,
            actor_type TEXT NOT NULL DEFAULT 'user',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, span_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS signal_classifiers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            signal_id UUID NOT NULL REFERENCES signal_definitions(id) ON DELETE CASCADE,
            model_type TEXT NOT NULL DEFAULT 'logistic',
            model_blob BYTEA NOT NULL,
            metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
            shadow_mode BOOLEAN NOT NULL DEFAULT TRUE,
            sample_count INT NOT NULL DEFAULT 0,
            trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            version INT NOT NULL DEFAULT 1
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS mcp_server_registry (
            org_id VARCHAR(128) NOT NULL,
            server_name TEXT NOT NULL,
            first_seen TIMESTAMPTZ,
            last_seen TIMESTAMPTZ,
            tool_names TEXT[] DEFAULT '{}',
            transport TEXT,
            call_count_7d BIGINT NOT NULL DEFAULT 0,
            error_rate_7d REAL NOT NULL DEFAULT 0,
            p95_latency_ms REAL,
            auth_failure_count_7d INT NOT NULL DEFAULT 0,
            affected_agent_ids TEXT[] DEFAULT '{}',
            PRIMARY KEY (org_id, server_name)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS mcp_tool_stats (
            org_id VARCHAR(128) NOT NULL,
            server_name TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            call_count_7d BIGINT NOT NULL DEFAULT 0,
            error_rate_7d REAL NOT NULL DEFAULT 0,
            p95_latency_ms REAL,
            PRIMARY KEY (org_id, server_name, tool_name)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS saved_searches (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            query_text TEXT NOT NULL,
            trace_count INT NOT NULL DEFAULT 0,
            signal_id UUID REFERENCES signal_definitions(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )

    # ── WS2: learn-in-production ──────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS nudges (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            name TEXT NOT NULL,
            trigger JSONB NOT NULL DEFAULT '{}'::jsonb,
            action_type TEXT NOT NULL,
            content TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'shadow'
                CHECK (mode IN ('shadow','promoted','archived')),
            source_issue_id UUID,
            evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            promoted_at TIMESTAMPTZ,
            archived_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nudges_org_agent_mode
        ON nudges (org_id, agent_id, mode)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS nudge_outcomes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            nudge_id UUID NOT NULL REFERENCES nudges(id) ON DELETE CASCADE,
            trace_id TEXT NOT NULL,
            mode TEXT NOT NULL,
            matched BOOLEAN NOT NULL,
            applied BOOLEAN NOT NULL,
            outcome_success BOOLEAN,
            metric_delta JSONB,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nudge_outcomes_nudge
        ON nudge_outcomes (nudge_id, recorded_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS promotion_candidates (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            ref_id UUID NOT NULL,
            status TEXT NOT NULL DEFAULT 'shadow'
                CHECK (status IN ('shadow','pending_review','promoted','rejected','demoted')),
            evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
            shadow_started_at TIMESTAMPTZ,
            promoted_at TIMESTAMPTZ,
            demoted_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_promotions_queue
        ON promotion_candidates (org_id, status, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_books (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            version INT NOT NULL,
            content_md TEXT NOT NULL,
            token_count INT NOT NULL DEFAULT 0,
            source_issue_ids UUID[],
            source_skill_ids UUID[],
            published_by TEXT,
            publish_mode TEXT CHECK (publish_mode IN ('manual','auto_draft','auto_publish')),
            published_at TIMESTAMPTZ DEFAULT now(),
            UNIQUE (org_id, agent_id, version)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_book_config (
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT false,
            max_tokens INT NOT NULL DEFAULT 2000,
            auto_update BOOLEAN NOT NULL DEFAULT true,
            PRIMARY KEY (org_id, agent_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS drift_baselines (
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            dimension TEXT NOT NULL,
            baseline_histogram JSONB NOT NULL DEFAULT '{}'::jsonb,
            sample_count INT NOT NULL DEFAULT 0,
            window_days INT NOT NULL DEFAULT 30,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, agent_id, dimension)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS drift_reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            report_period_start TIMESTAMPTZ NOT NULL,
            report_period_end TIMESTAMPTZ NOT NULL,
            dimensions JSONB NOT NULL DEFAULT '[]'::jsonb,
            top_dimensions TEXT[],
            plain_english_summary TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_drift_reports_org_agent
        ON drift_reports (org_id, agent_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS production_eval_slices (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            dataset_id UUID,
            cluster_id INT NOT NULL,
            cluster_label TEXT,
            medoid_trace_id TEXT NOT NULL,
            case_count INT NOT NULL DEFAULT 1,
            member_trace_ids TEXT[],
            refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (org_id, agent_id, cluster_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS auto_curator_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id TEXT,
            traces_sampled INT NOT NULL DEFAULT 0,
            clusters_found INT NOT NULL DEFAULT 0,
            cases_upserted INT NOT NULL DEFAULT 0,
            cost_usd FLOAT NOT NULL DEFAULT 0,
            duration_seconds INT NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            completed_at TIMESTAMPTZ
        )
        """
    )

    # ── WS3: fix / prove ────────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_sessions (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          VARCHAR(128) NOT NULL,
            agent_id        VARCHAR(256),
            user_id         VARCHAR(256),
            metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
            success         BOOLEAN,
            failure_reason  TEXT,
            trace_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
            started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at        TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_org_started "
        "ON agent_sessions (org_id, started_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS issue_fix_sessions (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          VARCHAR(128) NOT NULL,
            issue_id        UUID NOT NULL,
            repo_full_name  TEXT NOT NULL,
            branch_name     TEXT,
            pr_url          TEXT,
            status          VARCHAR(32) NOT NULL DEFAULT 'chatting',
            messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
            proposed_patch  TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_fix_sessions_issue "
        "ON issue_fix_sessions (org_id, issue_id, created_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS regression_eval_cases (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            dataset_id          VARCHAR(128) NOT NULL DEFAULT 'agent-regressions',
            source_issue_id     UUID,
            source_trace_id     VARCHAR(128),
            fingerprint         TEXT,
            auto_generated      BOOLEAN NOT NULL DEFAULT FALSE,
            input_data          JSONB NOT NULL DEFAULT '{}'::jsonb,
            expected_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
            metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_regression_eval_fingerprint "
        "ON regression_eval_cases (org_id, fingerprint) WHERE fingerprint IS NOT NULL"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS change_impact_reports (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          VARCHAR(128) NOT NULL,
            change_id       VARCHAR(256) NOT NULL,
            agent_id        VARCHAR(256),
            report          JSONB NOT NULL DEFAULT '{}'::jsonb,
            recommendation  VARCHAR(32) NOT NULL DEFAULT 'review_required',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_change_impact_change_id "
        "ON change_impact_reports (org_id, change_id)"
    )

    # ── WS4: enterprise ───────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS production_eval_policies (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            agent_id VARCHAR(256),
            sample_rate FLOAT NOT NULL DEFAULT 0.02,
            judge_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            max_cost_usd_per_day FLOAT DEFAULT 50.0,
            min_eval_pass_rate FLOAT,
            slm_only BOOLEAN DEFAULT true,
            enabled BOOLEAN DEFAULT true,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_prod_eval_policies_org "
        "ON production_eval_policies (org_id, agent_id)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS production_eval_scores (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            agent_id VARCHAR(256),
            judge_id VARCHAR(128) NOT NULL DEFAULT 'slm_default',
            score FLOAT NOT NULL,
            passed BOOLEAN,
            cost_usd FLOAT DEFAULT 0,
            latency_ms INT,
            judge_tier TEXT DEFAULT 'slm',
            scored_at TIMESTAMPTZ DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_prod_eval_scores_agent_hour "
        "ON production_eval_scores (org_id, agent_id, scored_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS production_eval_daily_spend (
            org_id VARCHAR(128) NOT NULL,
            date DATE NOT NULL,
            spend_usd FLOAT DEFAULT 0,
            traces_scored INT DEFAULT 0,
            PRIMARY KEY (org_id, date)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_registry (
            org_id VARCHAR(128) NOT NULL,
            agent_id VARCHAR(256) NOT NULL,
            display_name TEXT,
            tier TEXT DEFAULT 'standard'
                CHECK (tier IN ('critical','standard','experimental')),
            owner_team TEXT,
            slo_config JSONB DEFAULT '{
              "p95_latency_ms": 5000,
              "max_error_rate": 0.05,
              "min_eval_pass_rate": 0.90
            }'::jsonb,
            autonomy_policy_id UUID,
            first_seen TIMESTAMPTZ,
            last_seen TIMESTAMPTZ,
            PRIMARY KEY (org_id, agent_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_delegation_edges (
            org_id VARCHAR(128) NOT NULL,
            parent_agent_id VARCHAR(256) NOT NULL,
            child_agent_id VARCHAR(256) NOT NULL,
            call_count_7d BIGINT DEFAULT 0,
            error_rate_7d FLOAT DEFAULT 0,
            PRIMARY KEY (org_id, parent_agent_id, child_agent_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS issue_experiments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            issue_id UUID NOT NULL,
            experiment_id VARCHAR(128) NOT NULL,
            control_variant TEXT NOT NULL,
            treatment_variant TEXT NOT NULL,
            primary_metric TEXT DEFAULT 'stumble_rate',
            min_samples_per_variant INT DEFAULT 100,
            started_at TIMESTAMPTZ DEFAULT NOW(),
            ended_at TIMESTAMPTZ,
            status TEXT DEFAULT 'running'
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_experiments_issue "
        "ON issue_experiments (org_id, issue_id)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_audit_ledger (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            event_type TEXT NOT NULL,
            event_subtype TEXT,
            agent_id VARCHAR(256),
            actor_id VARCHAR(256),
            actor_type TEXT NOT NULL
                CHECK (actor_type IN ('user','mcp','system','service_account')),
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            prev_hash TEXT,
            entry_hash TEXT NOT NULL,
            compliance_tags TEXT[] DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_audit_ledger_org_agent_ts "
        "ON agent_audit_ledger (org_id, agent_id, created_at DESC)"
    )
    op.execute(
        "ALTER TABLE agent_issues "
        "ADD COLUMN IF NOT EXISTS experiment_id UUID"
    )
    op.execute(
        "ALTER TABLE agent_issues "
        "ADD COLUMN IF NOT EXISTS experiment_result JSONB"
    )
    op.execute(
        "ALTER TABLE agent_issues "
        "ADD COLUMN IF NOT EXISTS regression_case_id VARCHAR(128)"
    )
    # --- 093_redteam_findings_org_scope.py (rev 093) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS redteam_findings (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            probe_name          TEXT NOT NULL,
            category            TEXT NOT NULL
                CHECK (category IN ('jailbreak', 'prompt_injection', 'pii',
                                    'excessive_agency')),
            severity            TEXT NOT NULL
                CHECK (severity IN ('low', 'medium', 'high', 'critical')),
            attack_prompt       TEXT NOT NULL,
            agent_response      TEXT NOT NULL,
            failed              BOOLEAN NOT NULL DEFAULT FALSE,
            detection_reason    TEXT NOT NULL,
            target_label        TEXT NOT NULL DEFAULT 'default',
            tags                TEXT[] NOT NULL DEFAULT '{}',
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_redteam_findings_org_created
        ON redteam_findings (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_redteam_findings_severity
        ON redteam_findings (org_id, severity, created_at DESC)
        WHERE severity IN ('high', 'critical')
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_redteam_findings_failures
        ON redteam_findings (org_id, created_at DESC)
        WHERE failed = TRUE
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_redteam_findings_probe
        ON redteam_findings (org_id, probe_name, created_at DESC)
        """
    )
    # --- 094_strategy_store_org_id.py (rev 094) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS retrieval_strategy_state (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            collection VARCHAR(50) NOT NULL,
            score_threshold FLOAT DEFAULT 0.7,
            default_limit INT DEFAULT 20,
            dense_weight FLOAT DEFAULT 0.6,
            sparse_weight FLOAT DEFAULT 0.4,
            preferred_filters JSONB DEFAULT '{}',
            last_tuned_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
        """
    )

    op.execute(
        """
        ALTER TABLE retrieval_strategy_state
            ADD COLUMN IF NOT EXISTS org_id VARCHAR(128) NOT NULL DEFAULT ''
        """
    )

    op.execute(
        """
        ALTER TABLE retrieval_strategy_state
            DROP CONSTRAINT IF EXISTS retrieval_strategy_state_collection_key
        """
    )

    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS
            uq_retrieval_strategy_collection_org
        ON retrieval_strategy_state (collection, org_id)
        """
    )

    op.execute(
        """
        CREATE INDEX IF NOT EXISTS
            idx_retrieval_strategy_org
        ON retrieval_strategy_state (org_id, collection)
        """
    )
    # --- 095_agent_activity_events.py (rev 095) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_activity_events (
            id           VARCHAR(64)   PRIMARY KEY,
            org_id       VARCHAR(128)  NOT NULL,
            event_type   VARCHAR(64)   NOT NULL,
            summary      TEXT          NOT NULL DEFAULT '',
            deep_link    TEXT          NOT NULL DEFAULT '',
            metadata     JSONB,
            created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_activity_events_org "
        "ON agent_activity_events (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_activity_events_type "
        "ON agent_activity_events (org_id, event_type, created_at DESC)"
    )
    # --- 096_compliance_jobs.py (rev 096) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS compliance_jobs (
            id              VARCHAR(64) PRIMARY KEY,
            job_type        VARCHAR(32) NOT NULL,
            status          VARCHAR(32) NOT NULL DEFAULT 'queued',
            subject_user_id VARCHAR(128),
            subject_org_id  VARCHAR(128),
            requested_by    VARCHAR(128),
            download_url    TEXT,
            error_message   TEXT,
            payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at    TIMESTAMPTZ
        );
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_compliance_jobs_subject_user
            ON compliance_jobs (subject_user_id, created_at DESC);
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_compliance_jobs_status
            ON compliance_jobs (status, created_at DESC);
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dsar_tickets (
            id              VARCHAR(64) PRIMARY KEY,
            subject_name    TEXT NOT NULL,
            subject_email   TEXT NOT NULL,
            request_type    VARCHAR(32) NOT NULL,
            details         TEXT,
            status          VARCHAR(32) NOT NULL DEFAULT 'open',
            sla_due_at      TIMESTAMPTZ NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at     TIMESTAMPTZ
        );
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_dsar_tickets_status
            ON dsar_tickets (status, sla_due_at);
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS do_not_sell_requests (
            id              VARCHAR(64) PRIMARY KEY,
            email           TEXT NOT NULL,
            email_hash      VARCHAR(64) NOT NULL,
            effective_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_do_not_sell_email_hash
            ON do_not_sell_requests (email_hash);
        """
    )
    # --- 096_debugger_llm_cache.py (rev 096b) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS debugger_llm_cache (
            org_id           TEXT          NOT NULL,
            source_trace_id  TEXT          NOT NULL,
            step_number      INT           NOT NULL,
            input_hash       TEXT          NOT NULL,
            response         JSONB         NOT NULL,
            model            TEXT,
            created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, source_trace_id, step_number, input_hash)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_cache_trace "
        "ON debugger_llm_cache (org_id, source_trace_id, step_number)"
    )
    # --- 097_cat23_rls.py (rev 097a) ---
    _CAT23_TABLES: tuple[str, ...] = (
        # 8 core
        "repo_connections",
        "code_root_cause_links",
        "proposed_patches",
        "patch_test_runs",
        "pull_requests",
        "post_merge_windows",
        "revert_events",
        "codebase_knowledge_graph",
        # Approval workflow
        "approval_grants",
        "patch_approvals",
        "patch_approval_status",
        "approval_delegations",
        # Auto-approval
        "auto_approval_policies",
        "auto_approval_events",
        "auto_approval_dry_runs",
    )
    for table in _CAT23_TABLES:
        # Enable RLS (FORCE so even table owners go through
        # the policy in non-superuser contexts).
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public'
                      AND tablename = '{table}'
                      AND policyname = 'tenant_isolation_{table}'
                ) THEN
                    EXECUTE $policy$
                        CREATE POLICY tenant_isolation_{table} ON {table}
                        USING (org_id = current_setting('app.current_org_id', true))
                    $policy$;
                END IF;
            END $$;
        """)
    # --- 097_signal_definitions_f35_bridge.py (rev 097b) ---
    op.execute(
        "ALTER TABLE signal_definitions "
        "ADD COLUMN IF NOT EXISTS template_id TEXT"
    )
    op.execute(
        "ALTER TABLE signal_definitions "
        "ADD COLUMN IF NOT EXISTS statgate_rule TEXT"
    )
    op.execute(
        "ALTER TABLE signal_definitions "
        "ADD COLUMN IF NOT EXISTS investigator_prompt TEXT"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_definitions_template "
        "ON signal_definitions (org_id, template_id) "
        "WHERE template_id IS NOT NULL"
    )
    # --- 098_cat23_deferred_tables.py (rev 098a) ---
    _TABLES: tuple[str, ...] = (
        "agent_persona_config",
        "repo_style_profiles",
        "patch_review_actions",
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_persona_config (
            id                          VARCHAR(64)   PRIMARY KEY,
            org_id                      VARCHAR(128)  NOT NULL,
            display_name                VARCHAR(256)  NOT NULL DEFAULT 'Eden Agent',
            avatar                      VARCHAR(128)  NOT NULL DEFAULT 'eden-mark',
            voice                       VARCHAR(64)   NOT NULL DEFAULT 'concise',
            track_record_visible_to     JSONB,
            commit_message_style        VARCHAR(64)   NOT NULL DEFAULT 'conventional-commits',
            pr_body_template            VARCHAR(64)   NOT NULL DEFAULT 'default',
            created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_persona_config_org "
        "ON agent_persona_config (org_id, created_at DESC)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS repo_style_profiles (
            id                          VARCHAR(64)   PRIMARY KEY,
            org_id                      VARCHAR(128)  NOT NULL,
            repo_id                     VARCHAR(64)   NOT NULL,
            indentation                 JSONB,
            type_hints_style            VARCHAR(64)   NOT NULL DEFAULT 'pep484',
            naming_convention           JSONB,
            import_style                VARCHAR(64)   NOT NULL DEFAULT 'absolute',
            error_handling              VARCHAR(64)   NOT NULL DEFAULT 'exceptions',
            logging_style               VARCHAR(64)   NOT NULL DEFAULT 'stdlib-logging',
            docstring_style             VARCHAR(64)   NOT NULL DEFAULT 'google',
            test_framework              VARCHAR(64)   NOT NULL DEFAULT 'pytest',
            lint_config                 JSONB,
            complexity_median           INT           NOT NULL DEFAULT 5,
            architecture_patterns       JSONB,
            last_learned_at             TIMESTAMPTZ,
            last_learned_from_pr_id     VARCHAR(64),
            created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_repo_style_profiles_org "
        "ON repo_style_profiles (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_repo_style_profiles_repo "
        "ON repo_style_profiles (org_id, repo_id)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS patch_review_actions (
            id                          VARCHAR(64)   PRIMARY KEY,
            org_id                      VARCHAR(128)  NOT NULL,
            patch_id                    VARCHAR(64)   NOT NULL,
            action                      VARCHAR(64)   NOT NULL,
            actor_user_id               VARCHAR(128)  NOT NULL,
            comment                     TEXT          NOT NULL DEFAULT '',
            reason                      TEXT          NOT NULL DEFAULT '',
            edited_diff                 TEXT,
            version_after               INT,
            created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_patch_review_actions_org "
        "ON patch_review_actions (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_patch_review_actions_patch "
        "ON patch_review_actions (org_id, patch_id)"
    )

    # Tenant RLS — same pattern as 097_cat23_rls.
    for table in _TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public'
                      AND tablename = '{table}'
                      AND policyname = 'tenant_isolation_{table}'
                ) THEN
                    EXECUTE $policy$
                        CREATE POLICY tenant_isolation_{table} ON {table}
                        USING (org_id = current_setting('app.current_org_id', true))
                    $policy$;
                END IF;
            END $$;
        """)
    # --- 098_nl_alert_rules_f81.py (rev 098b) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS nl_alert_rules (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name            TEXT NOT NULL,
            nl_text         TEXT NOT NULL,
            compiled_eql    TEXT NOT NULL,
            triage_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
            channels        JSONB NOT NULL DEFAULT '{"in_app": true}'::jsonb,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            created_by      TEXT,
            last_fired_at   TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nl_alert_rules_org
        ON nl_alert_rules (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_events (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            rule_id             UUID REFERENCES nl_alert_rules(id) ON DELETE SET NULL,
            title               TEXT NOT NULL,
            severity            TEXT NOT NULL DEFAULT 'warning',
            payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
            triage_verdict      TEXT,
            triage_reason       TEXT,
            triage_confidence   NUMERIC,
            incident_id         UUID,
            acknowledged        BOOLEAN NOT NULL DEFAULT FALSE,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_alert_events_org_verdict
        ON alert_events (org_id, triage_verdict, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_triage_feedback (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            alert_event_id  UUID NOT NULL REFERENCES alert_events(id) ON DELETE CASCADE,
            human_verdict   TEXT NOT NULL,
            created_by      TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_alert_triage_feedback_event
        ON alert_triage_feedback (alert_event_id, created_at DESC)
        """
    )
    # --- 099_improvement_agent_n23.py (rev 099a) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS improvement_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id TEXT,
            started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            finished_at TIMESTAMPTZ,
            status TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
            last_run_at TIMESTAMPTZ NOT NULL,
            plans_created INT NOT NULL DEFAULT 0,
            plans_skipped_dedup INT NOT NULL DEFAULT 0,
            llm_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
            error TEXT,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS improvement_runs_org_started_idx
        ON improvement_runs (org_id, started_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS improvement_plans (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            run_id UUID REFERENCES improvement_runs(id) ON DELETE SET NULL,
            agent_id TEXT,
            plan_kind TEXT NOT NULL
                CHECK (plan_kind IN (
                    'code_patch', 'prompt_update', 'nudge_promote',
                    'guardrail_tune', 'config_change'
                )),
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN (
                    'draft', 'pending_review', 'approved', 'pr_opened',
                    'merged', 'rejected', 'snoozed', 'superseded'
                )),
            title TEXT NOT NULL,
            summary TEXT,
            source_ref TEXT,
            source_fingerprint TEXT,
            diff_unified TEXT,
            diff_edited BOOLEAN NOT NULL DEFAULT false,
            files_changed JSONB NOT NULL DEFAULT '[]'::jsonb,
            evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
            triage_snapshot JSONB,
            estimated_blast_radius TEXT,
            llm_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
            pr_url TEXT,
            pr_number INT,
            github_branch TEXT,
            approved_by TEXT,
            approved_at TIMESTAMPTZ,
            rejected_by TEXT,
            rejected_at TIMESTAMPTZ,
            rejection_reason TEXT,
            snoozed_until TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS improvement_plans_dedup_idx
        ON improvement_plans (org_id, source_fingerprint)
        WHERE status IN ('draft', 'pending_review', 'approved', 'pr_opened')
        AND source_fingerprint IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS improvement_plans_inbox_idx
        ON improvement_plans (org_id, status, created_at DESC)
        """
    )
    # --- 099_intel_metric_runs_alert_firings.py (rev 099) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS custom_metric_runs (
            id                      VARCHAR(64) PRIMARY KEY,
            org_id                  VARCHAR(128) NOT NULL,
            metric_id               VARCHAR(128),
            metric_name             VARCHAR(128),
            judge_name              VARCHAR(128),
            score                   DOUBLE PRECISION,
            threshold               DOUBLE PRECISION,
            passed                  BOOLEAN,
            synthesised_rubric      TEXT,
            rubric_tokens           INTEGER,
            domain                  VARCHAR(64),
            trace_id                VARCHAR(128),
            examples_json           TEXT,
            result_json             TEXT,
            status                  VARCHAR(16) NOT NULL DEFAULT 'synthesised',
            approval_status         VARCHAR(16) NOT NULL DEFAULT 'pending',
            approved_by             VARCHAR(128),
            approved_at             TIMESTAMPTZ,
            rejection_reason        TEXT,
            created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_custom_metric_runs_org "
        "ON custom_metric_runs (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_custom_metric_runs_trace "
        "ON custom_metric_runs (org_id, trace_id)"
    )
    # Widen legacy UUID PK → VARCHAR so string run ids persist.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'custom_metric_runs'
                  AND column_name = 'id'
                  AND data_type = 'uuid'
            ) THEN
                ALTER TABLE custom_metric_runs
                    ALTER COLUMN id TYPE VARCHAR(64)
                    USING id::text;
            END IF;
        END $$;
        """
    )

    # ─── Cat 19 — alert firings audit log ───────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS eql_alert_firings (
            id                  VARCHAR(64) PRIMARY KEY,
            org_id              VARCHAR(128) NOT NULL,
            alert_id            VARCHAR(128) NOT NULL,
            severity            VARCHAR(16) NOT NULL,
            fired_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            n_rows              BIGINT NOT NULL DEFAULT 0,
            sample_rows_json    TEXT,
            clickhouse_sql      TEXT,
            data_source         VARCHAR(32) NOT NULL DEFAULT 'postgres',
            status              VARCHAR(16) NOT NULL DEFAULT 'fired',
            error               TEXT,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_eql_alert_firings_org "
        "ON eql_alert_firings (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_eql_alert_firings_alert "
        "ON eql_alert_firings (org_id, alert_id, fired_at DESC)"
    )
    # --- 100_artifacts_ledger.py (rev 100_artifacts_ledger) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_ledgers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            version INT NOT NULL DEFAULT 1,
            inject_enabled BOOLEAN NOT NULL DEFAULT false,
            max_tokens INT NOT NULL DEFAULT 800,
            retrieval_enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (org_id, agent_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS ledger_entries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            agent_id TEXT NOT NULL,
            ledger_id UUID NOT NULL REFERENCES agent_ledgers(id) ON DELETE CASCADE,
            chapter TEXT NOT NULL DEFAULT 'general',
            text TEXT NOT NULL,
            citations JSONB NOT NULL DEFAULT '[]'::jsonb,
            source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            embedding BYTEA,
            weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
            version INT NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    # Expression unique constraints are not valid in CREATE TABLE UNIQUE (...);
    # use a unique index on md5(text) instead.
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_entries_ledger_chapter_text
        ON ledger_entries (ledger_id, chapter, md5(text))
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ledger_entries_ledger_weight
        ON ledger_entries (ledger_id, weight DESC, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS evolution_ops_spend (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            ref_id TEXT,
            cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_evolution_ops_spend_org_day
        ON evolution_ops_spend (org_id, recorded_at DESC)
        """
    )
    # --- 101_eval_loop.py (rev 101_eval_loop) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS datasets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            source_type TEXT NOT NULL DEFAULT 'manual',
            source_ref TEXT,
            version INT NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_datasets_org ON datasets (org_id, created_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            input TEXT NOT NULL DEFAULT '',
            expected_output TEXT NOT NULL DEFAULT '',
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            origin_trace_id TEXT,
            origin_issue_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_dataset_items_dataset "
        "ON dataset_items (dataset_id, created_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_snapshots (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            org_id VARCHAR(128) NOT NULL,
            version INT NOT NULL,
            row_count INT NOT NULL DEFAULT 0,
            snapshot_data JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS offline_experiments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            dataset_snapshot_id UUID,
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            baseline_experiment_id UUID,
            source_issue_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS experiment_datapoints (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            experiment_id UUID NOT NULL REFERENCES offline_experiments(id) ON DELETE CASCADE,
            row_id UUID,
            input_data JSONB NOT NULL DEFAULT '{}'::jsonb,
            control_output JSONB NOT NULL DEFAULT '{}'::jsonb,
            treatment_output JSONB NOT NULL DEFAULT '{}'::jsonb,
            grade TEXT,
            score_delta DOUBLE PRECISION,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS regression_eval_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            agent_id TEXT,
            change_id TEXT,
            passed INT NOT NULL DEFAULT 0,
            failed INT NOT NULL DEFAULT 0,
            failures JSONB NOT NULL DEFAULT '[]'::jsonb,
            status TEXT NOT NULL DEFAULT 'completed',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_regression_eval_runs_org "
        "ON regression_eval_runs (org_id, created_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS labeling_queues (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            schema JSONB NOT NULL DEFAULT '{}'::jsonb,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
        """
    )
    # Legacy SQL migration 035 created labeling_items; some prod DBs never
    # received it. Create a compatible base table before queue columns.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS labeling_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            source_trace_id TEXT,
            source_span_id TEXT,
            source_dataset_id UUID,
            source_synthetic_qa_id TEXT,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            label_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
            prompt TEXT,
            -- users.id is TEXT in prod (Clerk/Eden hybrid ids); keep assigned_to TEXT.
            assigned_to TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            tags TEXT[] NOT NULL DEFAULT '{}',
            annotations_required INT NOT NULL DEFAULT 1,
            required_skills TEXT[] NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        ALTER TABLE labeling_items
        ADD COLUMN IF NOT EXISTS queue_id UUID REFERENCES labeling_queues(id) ON DELETE SET NULL
        """
    )
    op.execute(
        """
        ALTER TABLE labeling_items
        ADD COLUMN IF NOT EXISTS kanban_status TEXT NOT NULL DEFAULT 'todo'
        """
    )
    # --- 102_wave6_online_quality.py (rev 102_wave6_online_quality) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS online_scoring_rules (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            scope TEXT NOT NULL DEFAULT 'trace',
            filter_query TEXT NOT NULL DEFAULT '',
            scorer_type TEXT NOT NULL DEFAULT 'slm',
            scorer_ref TEXT,
            sample_rate FLOAT NOT NULL DEFAULT 1.0,
            enabled BOOLEAN NOT NULL DEFAULT true,
            version INT NOT NULL DEFAULT 1,
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_online_scoring_rules_org "
        "ON online_scoring_rules (org_id, enabled, updated_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS span_scores (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            trace_id TEXT NOT NULL,
            span_id TEXT NOT NULL,
            rule_id UUID REFERENCES online_scoring_rules(id) ON DELETE SET NULL,
            scorer_type TEXT NOT NULL DEFAULT 'slm',
            score FLOAT,
            passed BOOLEAN,
            label TEXT,
            rationale TEXT,
            confidence FLOAT,
            cost_usd FLOAT NOT NULL DEFAULT 0,
            judge_tier TEXT NOT NULL DEFAULT 'slm',
            scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_span_scores_org_trace "
        "ON span_scores (org_id, trace_id, scored_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_span_scores_org_span "
        "ON span_scores (org_id, span_id, scored_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS code_evaluators (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            source_code TEXT NOT NULL,
            entrypoint TEXT NOT NULL DEFAULT 'evaluate',
            timeout_ms INT NOT NULL DEFAULT 500,
            enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS categorical_classifiers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            column_key TEXT NOT NULL,
            labels JSONB NOT NULL DEFAULT '[]'::jsonb,
            scorer_type TEXT NOT NULL DEFAULT 'slm',
            scorer_ref TEXT,
            enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS automations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            trigger_type TEXT NOT NULL DEFAULT 'score_threshold',
            trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
            action_type TEXT NOT NULL DEFAULT 'dataset',
            action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
            enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS automation_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'completed',
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS monitoring_dashboards (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            is_home BOOLEAN NOT NULL DEFAULT false,
            layout JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dashboard_widgets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            dashboard_id UUID NOT NULL REFERENCES monitoring_dashboards(id) ON DELETE CASCADE,
            org_id VARCHAR(128) NOT NULL,
            widget_type TEXT NOT NULL DEFAULT 'metric',
            title TEXT NOT NULL DEFAULT '',
            query TEXT NOT NULL DEFAULT '',
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            position INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS prompt_environments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            prompt_name TEXT NOT NULL,
            env TEXT NOT NULL DEFAULT 'production',
            version INT NOT NULL,
            deployed_by TEXT,
            deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, prompt_name, env)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS prompt_collaborators (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            prompt_name TEXT NOT NULL,
            user_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'editor',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, prompt_name, user_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS online_scoring_rewind_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            rule_id UUID NOT NULL REFERENCES online_scoring_rules(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'pending',
            traces_processed INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
        """
    )
    # --- 103_wave7_debugger_browser.py (rev 103_wave7_debugger_browser) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS debug_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            title TEXT NOT NULL DEFAULT 'Debug session',
            source_trace_id TEXT,
            notes TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_debug_sessions_org "
        "ON debug_sessions (org_id, updated_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS debug_session_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id UUID NOT NULL REFERENCES debug_sessions(id) ON DELETE CASCADE,
            org_id VARCHAR(128) NOT NULL,
            source_trace_id TEXT NOT NULL,
            result_trace_id TEXT,
            from_step INT NOT NULL DEFAULT 0,
            rerun_mode TEXT NOT NULL DEFAULT 'hermetic',
            diff_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_debug_session_runs_session "
        "ON debug_session_runs (session_id, created_at ASC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS browser_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            trace_id TEXT NOT NULL,
            agent_session_id TEXT,
            user_agent TEXT NOT NULL DEFAULT '',
            viewport_w INT NOT NULL DEFAULT 0,
            viewport_h INT NOT NULL DEFAULT 0,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ended_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_browser_sessions_trace "
        "ON browser_sessions (org_id, trace_id, started_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS browser_session_events (
            id BIGSERIAL PRIMARY KEY,
            browser_session_id UUID NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
            step_number INT,
            event_type TEXT NOT NULL,
            payload JSONB NOT NULL,
            recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_browser_session_events_session "
        "ON browser_session_events (browser_session_id, step_number, recorded_at ASC)"
    )
    # --- 104_wave8_signals.py (rev 104_wave8_signals) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS signal_clusters (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            signal_id UUID NOT NULL REFERENCES signal_definitions(id) ON DELETE CASCADE,
            name TEXT,
            status TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'resolved', 'reopened')),
            event_count INT NOT NULL DEFAULT 0,
            first_seen TIMESTAMPTZ,
            last_seen TIMESTAMPTZ,
            centroid JSONB,
            sample_trace_ids TEXT[] DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_clusters_org_signal "
        "ON signal_clusters (org_id, signal_id, status)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS signal_backfill_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            signal_id UUID NOT NULL REFERENCES signal_definitions(id) ON DELETE CASCADE,
            window_start TIMESTAMPTZ NOT NULL,
            window_end TIMESTAMPTZ NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'complete', 'failed', 'cancelled')),
            traces_total INT,
            traces_done INT NOT NULL DEFAULT 0,
            estimated_cost_usd REAL,
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_backfill_org_status "
        "ON signal_backfill_jobs (org_id, status, created_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS search_to_signal_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            saved_search_id UUID,
            signal_id UUID REFERENCES signal_definitions(id) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'complete', 'failed')),
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS topic_clusters (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            facet TEXT NOT NULL DEFAULT 'task'
                CHECK (facet IN ('task', 'sentiment', 'issues', 'custom')),
            name TEXT NOT NULL,
            description TEXT,
            share_pct REAL,
            keywords TEXT[] DEFAULT '{}',
            sample_count INT NOT NULL DEFAULT 0,
            representative_trace_ids TEXT[] DEFAULT '{}',
            pattern_id UUID,
            signal_cluster_id UUID REFERENCES signal_clusters(id) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'active',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            first_seen TIMESTAMPTZ,
            last_seen TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_topic_clusters_org_facet "
        "ON topic_clusters (org_id, facet, sample_count DESC)"
    )
    # --- 105_wave14_self_obs.py (rev 105_wave14_self_obs) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS eden_synthetic_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL,
          probe TEXT NOT NULL,
          status TEXT NOT NULL,
          detail JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_eden_synthetic_runs_org
          ON eden_synthetic_runs (org_id, created_at DESC);
        """
    )
    # --- 106_filterbar_indexes.py (rev 106_filterbar_indexes) ---
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_agent_id
        ON telemetry_events (tenant_id, agent_id, timestamp DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_outcome
        ON telemetry_events (tenant_id, outcome, timestamp DESC)
        """
    )
    # --- 107_customer_cost_events.py (rev 107_customer_cost_events) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_cost_events (
            id              UUID PRIMARY KEY,
            org_id          VARCHAR(128) NOT NULL,
            feature         VARCHAR(64) NOT NULL DEFAULT 'unknown',
            model           VARCHAR(256) NOT NULL DEFAULT 'unknown',
            cost_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
            input_tokens    INT NOT NULL DEFAULT 0,
            output_tokens   INT NOT NULL DEFAULT 0,
            total_tokens    INT NOT NULL DEFAULT 0,
            request_id      VARCHAR(128),
            trace_id        VARCHAR(128),
            agent_id        VARCHAR(128),
            session_id      VARCHAR(128),
            user_id         VARCHAR(128),
            metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
            recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_customer_cost_events_org_time
        ON customer_cost_events (org_id, recorded_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_customer_cost_events_org_feature
        ON customer_cost_events (org_id, feature, recorded_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_customer_cost_events_org_model
        ON customer_cost_events (org_id, model, recorded_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_customer_cost_events_trace
        ON customer_cost_events (org_id, trace_id)
        WHERE trace_id IS NOT NULL
        """
    )

    # budgets may be missing if 052 was stamped without applying.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS budgets (
            id                            VARCHAR(64) PRIMARY KEY,
            org_id                        VARCHAR(128) NOT NULL,
            "window"                      VARCHAR(16) NOT NULL DEFAULT 'monthly',
            cost_soft_limit_usd           DOUBLE PRECISION NOT NULL DEFAULT 0.80,
            cost_hard_limit_usd           DOUBLE PRECISION NOT NULL DEFAULT 1.00,
            enforcement_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
            action_on_exceed              VARCHAR(16) NOT NULL DEFAULT 'throttle',
            threshold_alert_pct           INT NOT NULL DEFAULT 80,
            created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        ALTER TABLE budgets
        ADD COLUMN IF NOT EXISTS alert_thresholds JSONB
            NOT NULL DEFAULT '[50, 80, 100]'::jsonb
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS feature_kill_switches (
            org_id          VARCHAR(128) NOT NULL,
            feature_key     VARCHAR(64) NOT NULL,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by      VARCHAR(128),
            PRIMARY KEY (org_id, feature_key)
        )
        """
    )
    # --- 108_f84_heartbeats.py (rev 108_f84_heartbeats) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS eden_component_heartbeats (
            id          BIGSERIAL PRIMARY KEY,
            component   TEXT NOT NULL,
            org_id      TEXT,
            status      TEXT NOT NULL DEFAULT 'healthy',
            meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
            checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_eden_component_heartbeats_comp_checked
            ON eden_component_heartbeats (component, checked_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_eden_component_heartbeats_org_checked
            ON eden_component_heartbeats (org_id, checked_at DESC)
            WHERE org_id IS NOT NULL
        """
    )
    # --- 109_w18_playgrounds.py (rev 109_w18_playgrounds) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS prompt_templates (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            version INT NOT NULL DEFAULT 1,
            system TEXT NOT NULL DEFAULT '',
            user_template TEXT NOT NULL DEFAULT '',
            tools JSONB NOT NULL DEFAULT '[]'::jsonb,
            required_params JSONB NOT NULL DEFAULT '[]'::jsonb,
            optional_params JSONB NOT NULL DEFAULT '[]'::jsonb,
            model TEXT NOT NULL DEFAULT 't1',
            temperature DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            max_tokens INT NOT NULL DEFAULT 1024,
            description TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name, version)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_prompt_templates_org_name "
        "ON prompt_templates (org_id, name, version DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS playgrounds (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_playgrounds_org "
        "ON playgrounds (org_id, updated_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS playground_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            playground_id UUID NOT NULL REFERENCES playgrounds(id) ON DELETE CASCADE,
            org_id VARCHAR(128) NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed',
            results JSONB NOT NULL DEFAULT '{}'::jsonb,
            cost_usd NUMERIC,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_playground_runs_pg "
        "ON playground_runs (playground_id, created_at DESC)"
    )
    # --- 110_w26_drop_issue_fix_sessions.py (rev 110_w26_drop_issue_fix_sessions) ---
    op.execute("DROP INDEX IF EXISTS idx_issue_fix_sessions_issue")
    op.execute("DROP TABLE IF EXISTS issue_fix_sessions")
    # --- 111_w27_live_labels.py (rev 111_w27_live_labels) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_call_calibrators (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            model_blob BYTEA NOT NULL,
            precision DOUBLE PRECISION,
            recall DOUBLE PRECISION,
            sample_count INT NOT NULL DEFAULT 0,
            trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (org_id, agent_id, tool_name)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_call_predictions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id TEXT NOT NULL,
            span_id TEXT NOT NULL,
            calibrator_id UUID NOT NULL,
            confidence DOUBLE PRECISION NOT NULL,
            predicted_label TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS live_trace_sessions (
            org_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            trace_id TEXT,
            last_event_id BIGINT NOT NULL DEFAULT 0,
            event_count INT NOT NULL DEFAULT 0,
            dropped_events INT NOT NULL DEFAULT 0,
            finalized BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, session_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_tool_call_calibrators_org_agent
        ON tool_call_calibrators (org_id, agent_id)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_tool_call_predictions_org_span
        ON tool_call_predictions (org_id, span_id)
        """
    )
    # --- 112_w28_f64_f34_mcp.py (rev 112_w28_f64_f34_mcp) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS signal_classifiers (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        ALTER TABLE signal_classifiers
        ADD COLUMN IF NOT EXISTS investigator_disabled BOOLEAN DEFAULT FALSE
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS classifier_predictions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id TEXT NOT NULL,
            trace_id TEXT NOT NULL,
            classifier_id UUID NOT NULL,
            signal_id TEXT,
            score DOUBLE PRECISION NOT NULL,
            fired BOOLEAN NOT NULL,
            shadow_investigator_agree BOOLEAN,
            investigator_skipped BOOLEAN NOT NULL DEFAULT FALSE,
            estimated_savings_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_classifier_predictions_org_created
        ON classifier_predictions (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_classifier_predictions_org_signal
        ON classifier_predictions (org_id, signal_id)
        """
    )
    # --- 113_a7_search_trgm_indexes.py (rev 113_a7_search_trgm_indexes) ---
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_name_trgm
        ON telemetry_events USING gin (name gin_trgm_ops)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_agent_id_trgm
        ON telemetry_events USING gin (agent_id gin_trgm_ops)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_jobs_job_id_trgm
        ON jobs USING gin (job_id gin_trgm_ops)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_jobs_request_text_trgm
        ON jobs USING gin ((request::text) gin_trgm_ops)
        """
    )
    # --- 114_org_api_keys_soft_revoke.py (rev 114_org_api_keys_soft_revoke) ---
    op.execute(
        """
        ALTER TABLE org_api_keys
            ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE
        """
    )
    op.execute(
        """
        ALTER TABLE org_api_keys
            ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ
        """
    )
    # --- 115_org_api_keys_prefix_created_by.py (rev 115_api_keys_prefix) ---
    op.execute(
        """
        ALTER TABLE org_api_keys
            ADD COLUMN IF NOT EXISTS key_prefix TEXT NOT NULL DEFAULT ''
        """
    )
    # Who minted the key. Prod ``users.id`` is TEXT (Clerk-era), not UUID —
    # a UUID FK fails with DatatypeMismatchError. Keep TEXT, no FK.
    op.execute(
        """
        ALTER TABLE org_api_keys
            ADD COLUMN IF NOT EXISTS created_by TEXT
        """
    )
    # --- 116_saved_searches_phase_n.py (rev 116_saved_searches_phase_n) ---
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'saved_searches'
              AND column_name = 'query_text'
          ) THEN
            ALTER TABLE saved_searches
              RENAME TO saved_search_signal_links;
          END IF;
        END $$;
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
          IF to_regclass('public.saved_search_signal_links') IS NOT NULL THEN
            ALTER INDEX IF EXISTS saved_searches_pkey
              RENAME TO saved_search_signal_links_pkey;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;  -- index may already be renamed / absent
        END $$;
        """
    )

    # ── 2. Phase N saved searches (portal Views / sharing) ───────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS saved_searches (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            -- Clerk-era users.id is TEXT — do not UUID-FK.
            owner_id        TEXT NOT NULL,
            name            TEXT NOT NULL,
            query_type      TEXT NOT NULL
                CHECK (query_type IN ('sql', 'eql', 'text')),
            query           TEXT NOT NULL,
            params          JSONB NOT NULL DEFAULT '{}'::jsonb,
            is_shared       BOOLEAN NOT NULL DEFAULT FALSE,
            is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
            tags            TEXT[] NOT NULL DEFAULT '{}',
            last_used_at    TIMESTAMPTZ,
            use_count       INT NOT NULL DEFAULT 0,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_saved_searches_owner_updated
            ON saved_searches (owner_id, updated_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_saved_searches_org_shared
            ON saved_searches (org_id, is_shared, updated_at DESC)
            WHERE is_shared = TRUE
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_saved_searches_org_pinned
            ON saved_searches (org_id, is_pinned DESC, updated_at DESC)
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION saved_searches_touch_updated() RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute(
        """
        DROP TRIGGER IF EXISTS trg_saved_searches_touch_updated ON saved_searches
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_saved_searches_touch_updated
            BEFORE UPDATE ON saved_searches
            FOR EACH ROW EXECUTE FUNCTION saved_searches_touch_updated()
        """
    )

    # ── 3. shared_traces (also missing on prod; same Phase N SQL) ─
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS shared_traces (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            trace_id        TEXT NOT NULL,
            token_hash      TEXT NOT NULL UNIQUE,
            token_prefix    TEXT NOT NULL,
            -- Clerk users.id is TEXT
            created_by      TEXT NOT NULL,
            label           TEXT,
            expires_at      TIMESTAMPTZ,
            revoked_at      TIMESTAMPTZ,
            view_count      INT NOT NULL DEFAULT 0,
            last_viewed_at  TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shared_traces_org_created
            ON shared_traces (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_shared_traces_trace
            ON shared_traces (org_id, trace_id)
        """
    )
    # --- 117_portal_schema_drift.py (rev 117_portal_schema_drift) ---
    op.execute(
        """
        ALTER TABLE org_invitations
            ADD COLUMN IF NOT EXISTS token_hash TEXT
        """
    )
    op.execute(
        """
        ALTER TABLE org_invitations
            ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
        """
    )
    op.execute(
        """
        ALTER TABLE org_invitations
            ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ
        """
    )
    # Backfill token_hash from legacy plaintext token column when present.
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'org_invitations' AND column_name = 'token'
          ) THEN
            UPDATE org_invitations
               SET token_hash = COALESCE(NULLIF(token_hash, ''), token)
             WHERE token_hash IS NULL OR token_hash = '';
          END IF;
        END $$;
        """
    )
    op.execute(
        """
        UPDATE org_invitations
           SET status = CASE
             WHEN accepted_at IS NOT NULL THEN 'accepted'
             WHEN declined_at IS NOT NULL THEN 'declined'
             WHEN expires_at < NOW() THEN 'expired'
             ELSE 'pending'
           END
         WHERE status IS NULL OR status = '' OR status = 'pending'
        """
    )
    # Enforce NOT NULL on token_hash after backfill (empty stubs get placeholder).
    op.execute(
        """
        UPDATE org_invitations
           SET token_hash = 'migrated-' || id::text
         WHERE token_hash IS NULL OR token_hash = ''
        """
    )
    op.execute(
        """
        ALTER TABLE org_invitations
            ALTER COLUMN token_hash SET NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_org_invitations_token
            ON org_invitations (token_hash)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_org_invitations_org_pending
            ON org_invitations (org_id, status)
            WHERE status = 'pending'
        """
    )

    # ── org_allowed_domains ──────────────────────────────────────
    op.execute(
        """
        ALTER TABLE org_allowed_domains
            ADD COLUMN IF NOT EXISTS added_by TEXT
        """
    )

    # ── annotations + labeling_assignments ───────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS annotations (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            item_id         UUID NOT NULL REFERENCES labeling_items(id) ON DELETE CASCADE,
            annotator_id    TEXT NOT NULL,
            label           JSONB NOT NULL,
            confidence      NUMERIC(3, 2) NOT NULL DEFAULT 0.5
                CHECK (confidence >= 0 AND confidence <= 1),
            notes           TEXT,
            time_spent_ms   INT,
            skills_exercised TEXT[] NOT NULL DEFAULT '{}',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (item_id, annotator_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_annotations_item
            ON annotations (item_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_annotations_annotator
            ON annotations (annotator_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_annotations_org_created
            ON annotations (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS labeling_assignments (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            item_id         UUID NOT NULL REFERENCES labeling_items(id) ON DELETE CASCADE,
            annotator_id    TEXT NOT NULL,
            assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            started_at      TIMESTAMPTZ,
            completed_at    TIMESTAMPTZ,
            source          TEXT NOT NULL DEFAULT 'auto'
                CHECK (source IN ('auto', 'manual', 'self')),
            UNIQUE (item_id, annotator_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_labeling_assignments_org
            ON labeling_assignments (org_id, assigned_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_labeling_assignments_annotator
            ON labeling_assignments (annotator_id, completed_at)
            WHERE completed_at IS NULL
        """
    )

    # ── sidebar_prefs (user_id TEXT — Clerk) ─────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS sidebar_prefs (
            user_id    TEXT NOT NULL,
            org_id     UUID NOT NULL,
            prefs      JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, org_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_sidebar_prefs_org_id
            ON sidebar_prefs (org_id)
        """
    )

    # ── streaming_tokens ─────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS streaming_tokens (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          VARCHAR(128) NOT NULL,
            trace_id        VARCHAR(128) NOT NULL,
            span_id         VARCHAR(128) NOT NULL,
            token_index     INTEGER NOT NULL CHECK (token_index >= 0),
            token_text      TEXT,
            token_byte_len  SMALLINT NOT NULL DEFAULT 0 CHECK (token_byte_len >= 0),
            delta_ms        INTEGER NOT NULL DEFAULT 0 CHECK (delta_ms >= 0),
            abs_ms          INTEGER NOT NULL DEFAULT 0 CHECK (abs_ms >= 0),
            finish_reason   VARCHAR(32),
            redacted        BOOLEAN NOT NULL DEFAULT FALSE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(span_id, token_index)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_streaming_tokens_trace
            ON streaming_tokens (org_id, trace_id, token_index)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_streaming_tokens_span
            ON streaming_tokens (span_id, token_index)
        """
    )
    # --- 118_improvement_plans_closed_status.py (rev 118_improvement_plans_closed_status) ---
    op.execute(
        """
        ALTER TABLE improvement_plans
            DROP CONSTRAINT IF EXISTS improvement_plans_status_check
        """
    )
    op.execute(
        """
        ALTER TABLE improvement_plans
            ADD CONSTRAINT improvement_plans_status_check
            CHECK (status IN (
                'draft', 'pending_review', 'approved', 'pr_opened',
                'merged', 'closed', 'rejected', 'snoozed', 'superseded'
            ))
        """
    )
    # --- 119_repo_connections_agent_id.py (rev 119_repo_connections_agent_id) ---
    op.execute(
        """
        ALTER TABLE repo_connections
            ADD COLUMN IF NOT EXISTS agent_id VARCHAR
        """
    )
    # At most one active connection per agent within an org.
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS
            idx_repo_connections_org_agent_active
        ON repo_connections (org_id, agent_id)
        WHERE status = 'active' AND agent_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_repo_connections_agent_id
        ON repo_connections (org_id, agent_id)
        WHERE agent_id IS NOT NULL
        """
    )
    # --- 120_guardrail_policies_direction.py (rev 120_guardrail_policies_direction) ---
    op.execute(
        """
        ALTER TABLE guardrail_policies
            ADD COLUMN IF NOT EXISTS direction VARCHAR(16)
                NOT NULL DEFAULT 'both'
        """
    )
    # Belt-and-braces: existing rows created before the DEFAULT existed
    # (if the column was added without one on some substrate) still land
    # on 'both' rather than NULL.
    op.execute(
        """
        UPDATE guardrail_policies SET direction = 'both'
        WHERE direction IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_guardrail_policies_org_type_direction
        ON guardrail_policies (org_id, type, direction)
        WHERE status = 'active'
        """
    )
    # --- 121_leader_leases.py (rev 121_leader_leases) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS eden_leader_leases (
            lock_name  TEXT PRIMARY KEY,
            holder     TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    # Expired-lease sweeps and the "who holds this" read both filter on
    # expiry; the table is tiny (one row per loop) but the index keeps the
    # acquire path an index lookup rather than a scan as loops are added.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_eden_leader_leases_expires
        ON eden_leader_leases (expires_at)
        """
    )
    # --- 122_judge_watermark_composite.py (rev 122_judge_watermark_composite) ---
    def _table_exists(name: str) -> bool:
        """True when ``name`` exists in the current schema."""
        bind = op.get_bind()
        return bool(
            bind.exec_driver_sql(
                "SELECT 1 FROM information_schema.tables "
                f"WHERE table_schema = current_schema() AND table_name = '{name}'"
            ).scalar()
        )
    if not _table_exists("judge_scores_processed"):
        # Migration 018 never ran on this database; nothing to widen.
        return

    op.execute(
        """
        ALTER TABLE judge_scores_processed
        ADD COLUMN IF NOT EXISTS last_processed_scored_at TIMESTAMPTZ
        """
    )

    # Reset the corrupt cursors so the skipped history is re-read. Both halves
    # must go: a UUID without its timestamp cannot seed a composite keyset.
    #
    # Scoped to rows that still lack the timestamp, which is exactly the set
    # written before this migration. Unconditional, this UPDATE is destructive
    # on any re-run — a ``downgrade 121`` / ``upgrade`` cycle, or a re-stamp,
    # would wipe every tenant's *valid* composite cursor and force a full replay
    # of judge_scores history for the whole fleet. ``IF NOT EXISTS`` above makes
    # the DDL idempotent; the DML has to be too.
    op.execute(
        """
        UPDATE judge_scores_processed
           SET last_processed_judge_score_id = NULL,
               last_processed_scored_at = NULL
         WHERE last_processed_scored_at IS NULL
        """
    )

    if _table_exists("judge_scores"):
        # The keyset predicate is ``(scored_at, judge_run_id) > ($2, $3)``
        # within a tenant. Without this index that is a full scan per tick.
        op.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_judge_scores_tenant_keyset
            ON judge_scores (tenant_id, scored_at, judge_run_id)
            """
        )
    # --- 123_usage_events_rls_restore.py (rev 123_usage_events_rls_restore) ---
    def _table_exists(name: str) -> bool:
        """True when ``name`` exists in the current schema."""
        bind = op.get_bind()
        return bool(
            bind.exec_driver_sql(
                "SELECT 1 FROM information_schema.tables "
                f"WHERE table_schema = current_schema() AND table_name = '{name}'"
            ).scalar()
        )
    def _column_type(table: str, column: str) -> str | None:
        """Return the declared type of ``table.column``, or None if absent."""
        bind = op.get_bind()
        return bind.exec_driver_sql(
            "SELECT data_type FROM information_schema.columns "
            f"WHERE table_schema = current_schema() AND table_name = '{table}' "
            f"AND column_name = '{column}'"
        ).scalar()
    if not _table_exists("usage_events"):
        return

    op.execute("DROP POLICY IF EXISTS tenant_isolation_usage_events ON usage_events")

    # This restores migration 002's policy *verbatim* (002:249-255), including
    # the ``OR ... IS NULL`` branch. That branch is not slack to be tidied up —
    # it is what makes the policy compatible with Eden's writers, and removing
    # it breaks billing ingestion outright:
    #
    #   For a FOR ALL policy with no WITH CHECK, Postgres reuses USING as the
    #   check expression for INSERT and UPDATE. ``bronze_sink._flush``
    #   (data_platform/bronze_sink.py:194-208) writes usage_events from a
    #   background timer over a plain pool checkout, and one batch spans many
    #   orgs, so ``app.current_org_id`` is unset and *cannot* be set to a single
    #   value. Without the escape hatch every insert raises "new row violates
    #   row-level security policy", bronze_sink retries three times, logs, and
    #   drops the batch — every usage, cost and quota row lost, silently.
    #
    # So the boundary this policy provides is: a connection that *has* set the
    # GUC (every user-facing read — see the RLS middleware in
    # api/middleware/rls_org_context.py) is confined to its own org; trusted
    # background connections that never set it are not. That is the same
    # trade-off all ten of migration 002's policies make, and it is strictly
    # more isolation than the nothing that has been in place since 042.
    #
    # Tightening this to a strict predicate (and adding FORCE) requires pinning
    # every usage_events read *and write* path to a GUC-carrying connection
    # first, including giving bronze_sink a per-org flush. That is the follow-up;
    # doing the policy half of it alone converts a silent read leak into silent
    # write loss, which is worse.
    #
    # ``org_id`` is UUID here so the GUC (always text) needs the cast. The type
    # is read rather than assumed, and both variants are written out in full — an
    # interpolated predicate would keep the actual comparison out of this file,
    # which is the last thing a tenant-isolation policy should do.
    org_type = (_column_type("usage_events", "org_id") or "").lower()
    if org_type == "uuid":
        op.execute(
            """
            CREATE POLICY tenant_isolation_usage_events ON usage_events
            FOR ALL
            TO PUBLIC
            USING (
                org_id = NULLIF(
                    current_setting('app.current_org_id', true), ''
                )::UUID
                OR current_setting('app.current_org_id', true) IS NULL
            )
            """
        )
    else:
        op.execute(
            """
            CREATE POLICY tenant_isolation_usage_events ON usage_events
            FOR ALL
            TO PUBLIC
            USING (
                org_id = current_setting('app.current_org_id', true)
                OR current_setting('app.current_org_id', true) IS NULL
            )
            """
        )
    op.execute("ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY")
    # --- 124_missing_columns_both_sides_assume.py (rev 124_missing_columns_both_sides_assume) ---
    def _table_exists(name: str) -> bool:
        """True when ``name`` exists in the current schema."""
        bind = op.get_bind()
        return bool(
            bind.exec_driver_sql(
                "SELECT 1 FROM information_schema.tables "
                f"WHERE table_schema = current_schema() AND table_name = '{name}'"
            ).scalar()
        )
    if _table_exists("eden_component_heartbeats"):
        op.execute(
            """
            ALTER TABLE eden_component_heartbeats
            ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            """
        )
        # The readers all want the newest row per component within an org.
        op.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_heartbeats_org_component_checked
            ON eden_component_heartbeats (org_id, component, checked_at DESC)
            """
        )

    # ── users.email_verified ──────────────────────────────────────────
    if _table_exists("users"):
        # DEFAULT FALSE, so existing accounts are not silently promoted to
        # verified by this migration. They predate the flag; treating them as
        # unverified is the safe reading, and the signup path sets FALSE
        # explicitly for new ones.
        op.execute(
            """
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE
            """
        )

    # ── lineage_runs.org_id ───────────────────────────────────────────
    if _table_exists("lineage_runs"):
        op.execute(
            "ALTER TABLE lineage_runs ADD COLUMN IF NOT EXISTS org_id VARCHAR(128)"
        )
        op.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_lineage_runs_org_recorded
            ON lineage_runs (org_id, recorded_at DESC)
            """
        )

    # ── jobs.current_stage, jobs.archivist_summary ────────────────────
    if _table_exists("jobs"):
        # ``current_stage`` is read by the live job-progress paths
        # (api/routes/websocket.py:605,610,632 and realtime/mobile_sse.py:354)
        # and selected by ``PostgresClient.get_job``. With the column absent that
        # SELECT raised, so *every* websocket/SSE job-progress subscription
        # failed rather than merely missing a field.
        op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS current_stage TEXT")
        # ``archivist_summary`` is in the INSERT column list of
        # ``kb/episodic/client.py`` and declared on the job response model
        # (api/app.py:349), so the insert itself could never succeed.
        op.execute("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS archivist_summary JSONB")

    # ── org_pii_patterns ──────────────────────────────────────────────
    #
    # ``SecurityScanner._fetch_patterns`` read
    # ``SELECT pattern_name, regex FROM org_pii_policies WHERE enabled = TRUE``.
    # ``org_pii_policies`` (migration 013) is a *category*-based, one-row-per-org
    # table — categories, enabled_categories, mode, extra_redact_keys — with no
    # per-pattern regex at any grain, so that query raised on every scan and the
    # handler fell back to the built-in defaults.
    #
    # The feature is not a mistake, though: there is a test asserting a tenant
    # can supply a custom regex and have it override a default, and it passed
    # because its fake Postgres returned rows regardless of the SQL. So the
    # promise was documented and tested, the storage simply never existed — the
    # worst combination for a redaction control, because an operator adding a
    # pattern would see it accepted and silently not applied.
    #
    # Per-pattern rows are a different grain from org_pii_policies, so they get
    # their own table rather than more columns on that one.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_pii_patterns (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            pattern_name TEXT NOT NULL,
            regex TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, pattern_name)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_org_pii_patterns_org_enabled
        ON org_pii_patterns (org_id) WHERE enabled
        """
    )

    # ── retrieval_logs.org_id ─────────────────────────────────────────
    if _table_exists("retrieval_logs"):
        op.execute(
            "ALTER TABLE retrieval_logs ADD COLUMN IF NOT EXISTS org_id VARCHAR(128)"
        )
        op.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_retrieval_logs_org_created
            ON retrieval_logs (org_id, created_at DESC)
            """
        )
    # --- 125_clickhouse_fallback_drain.py (rev 125_clickhouse_fallback_drain) ---
    def _table_exists(table_name: str) -> bool:
        conn = op.get_bind()
        row = conn.execute(
            sa.text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = :t"
            ),
            {"t": table_name},
        ).first()
        return row is not None
    if not _table_exists("clickhouse_fallback"):
        return

    op.execute(
        "ALTER TABLE clickhouse_fallback "
        "ADD COLUMN IF NOT EXISTS dead_at TIMESTAMPTZ"
    )

    # Oldest-first over the live backlog only. Rows that are resolved or
    # dead leave the index entirely, so it stays proportional to the
    # backlog rather than to everything the table has ever held.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_clickhouse_fallback_drain "
        "ON clickhouse_fallback (failed_at) "
        "WHERE resolved_at IS NULL AND dead_at IS NULL"
    )
    # --- 126_ai_conversations.py (rev 126_ai_conversations) ---
    def _users_id_sql_type() -> str:
        """Return SQL type for ``users.id`` (``UUID`` or ``TEXT``)."""
        row = (
            op.get_bind()
            .execute(
                text(
                    """
                SELECT data_type
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'users'
                  AND column_name = 'id'
                """
                )
            )
            .fetchone()
        )
        if row is None:
            return "UUID"
        data_type = (row[0] or "").lower()
        if data_type in ("text", "character varying", "varchar"):
            return "TEXT"
        return "UUID"
    def _orgs_id_sql_type() -> str:
        """Return SQL type for ``organizations.id`` (``UUID`` or ``TEXT``)."""
        row = (
            op.get_bind()
            .execute(
                text(
                    """
                SELECT data_type
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'organizations'
                  AND column_name = 'id'
                """
                )
            )
            .fetchone()
        )
        if row is None:
            return "UUID"
        data_type = (row[0] or "").lower()
        if data_type in ("text", "character varying", "varchar"):
            return "TEXT"
        return "UUID"
    user_id_type = _users_id_sql_type()
    org_id_type = _orgs_id_sql_type()
    op.execute(
        f"""
        CREATE TABLE IF NOT EXISTS ai_conversations (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          {org_id_type} NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id         {user_id_type} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title           TEXT NOT NULL DEFAULT 'New chat',
            page_context    JSONB NOT NULL DEFAULT '{{}}'::jsonb,
            turn_count      INT NOT NULL DEFAULT 0,
            total_tokens    INT NOT NULL DEFAULT 0,
            total_cost_usd  NUMERIC(10, 6) NOT NULL DEFAULT 0,
            tier            TEXT NOT NULL DEFAULT 't3',
            archived_at     TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_message_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_org_user_updated
            ON ai_conversations (org_id, user_id, updated_at DESC)
            WHERE archived_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_org_updated
            ON ai_conversations (org_id, updated_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_messages (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id   UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
            role              TEXT NOT NULL
                CHECK (role IN ('user', 'assistant', 'tool', 'system')),
            content           TEXT NOT NULL DEFAULT '',
            tool_calls        JSONB NOT NULL DEFAULT '[]'::jsonb,
            tool_results      JSONB NOT NULL DEFAULT '[]'::jsonb,
            chart_specs       JSONB NOT NULL DEFAULT '[]'::jsonb,
            citations         JSONB NOT NULL DEFAULT '[]'::jsonb,
            prompt_tokens     INT NOT NULL DEFAULT 0,
            completion_tokens INT NOT NULL DEFAULT 0,
            cost_usd          NUMERIC(10, 6) NOT NULL DEFAULT 0,
            latency_ms        INT NOT NULL DEFAULT 0,
            model_used        TEXT,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created
            ON ai_messages (conversation_id, created_at)
        """
    )
    # --- 127_sidebar_prefs_user_id_type.py (rev 127_sidebar_prefs_user_id_type) ---
    def _col_data_type(table: str, column: str) -> str | None:
        row = (
            op.get_bind()
            .execute(
                text(
                    """
                SELECT data_type
                FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = :table
                  AND column_name = :column
                """
                ),
                {"table": table, "column": column},
            )
            .fetchone()
        )
        if row is None:
            return None
        return (row[0] or "").lower()
    def _users_id_sql_type() -> str:
        data_type = _col_data_type("users", "id")
        if data_type in ("text", "character varying", "varchar"):
            return "TEXT"
        return "UUID"
    def _orgs_id_sql_type() -> str:
        data_type = _col_data_type("organizations", "id")
        if data_type in ("text", "character varying", "varchar"):
            return "TEXT"
        return "UUID"
    if _col_data_type("sidebar_prefs", "user_id") is None:
        # Table missing — create with live types (same as 117 intent).
        user_id_type = _users_id_sql_type()
        org_id_type = _orgs_id_sql_type()
        op.execute(
            f"""
            CREATE TABLE IF NOT EXISTS sidebar_prefs (
                user_id    {user_id_type} NOT NULL,
                org_id     {org_id_type} NOT NULL,
                prefs      JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, org_id)
            )
            """
        )
        op.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sidebar_prefs_org_id
                ON sidebar_prefs (org_id)
            """
        )
        return

    want_user = _users_id_sql_type()
    want_org = _orgs_id_sql_type()
    have_user = _col_data_type("sidebar_prefs", "user_id") or ""
    have_org = _col_data_type("sidebar_prefs", "org_id") or ""

    user_is_text = have_user in ("text", "character varying", "varchar")
    org_is_text = have_org in ("text", "character varying", "varchar")
    want_user_text = want_user == "TEXT"
    want_org_text = want_org == "TEXT"

    if user_is_text != want_user_text:
        op.execute(
            f"""
            ALTER TABLE sidebar_prefs
            ALTER COLUMN user_id TYPE {want_user}
            USING user_id::text
            """
            if want_user_text
            else """
            ALTER TABLE sidebar_prefs
            ALTER COLUMN user_id TYPE UUID
            USING user_id::uuid
            """
        )

    if org_is_text != want_org_text:
        op.execute(
            f"""
            ALTER TABLE sidebar_prefs
            ALTER COLUMN org_id TYPE {want_org}
            USING org_id::text
            """
            if want_org_text
            else """
            ALTER TABLE sidebar_prefs
            ALTER COLUMN org_id TYPE UUID
            USING org_id::uuid
            """
        )
    # --- 128_onboarding_state_v2_columns.py (rev 128_onboarding_state_v2_columns) ---
    op.execute(
        """
        ALTER TABLE onboarding_state
            ADD COLUMN IF NOT EXISTS current_step VARCHAR(32)
                NOT NULL DEFAULT 'install',
            ADD COLUMN IF NOT EXISTS completed_steps TEXT[]
                NOT NULL DEFAULT ARRAY[]::TEXT[],
            ADD COLUMN IF NOT EXISTS cat_enablements JSONB
                NOT NULL DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS first_trace_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS milestones_reached TEXT[]
                NOT NULL DEFAULT ARRAY[]::TEXT[],
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
                NOT NULL DEFAULT NOW()
        """
    )
    # 056's GIN index — IF NOT EXISTS so already-patched DBs are fine.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_onboarding_milestones
            ON onboarding_state USING GIN (milestones_reached)
        """
    )
    # --- 129_dataset_columns.py (rev 129_dataset_columns) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_columns (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            dataset_id      UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            name            TEXT NOT NULL,
            type            TEXT NOT NULL DEFAULT 'text'
                CHECK (type IN ('text', 'number', 'json')),
            source          TEXT NOT NULL DEFAULT 'user'
                CHECK (source IN ('user', 'ai')),
            description     TEXT NOT NULL DEFAULT '',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_dataset_columns_dataset
            ON dataset_columns (dataset_id, created_at ASC)
        """
    )
    # --- 130_portal_rpm_floor.py (rev 130_portal_rpm_floor) ---
    op.execute(
        """
        UPDATE org_resource_limits
        SET
            requests_per_minute = 300,
            requests_per_hour = GREATEST(COALESCE(requests_per_hour, 0), 8000),
            updated_at = NOW()
        WHERE plan_name IN ('free', 'org_free')
          AND COALESCE(requests_per_minute, 0) < 300
        """
    )
    # --- 131_slack_integration.py (rev 131_slack_integration) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_slack_installs (
            id UUID PRIMARY KEY,
            org_id TEXT NOT NULL,
            team_id TEXT NOT NULL,
            team_name TEXT NOT NULL DEFAULT '',
            bot_token_enc TEXT NOT NULL,
            bot_user_id TEXT NOT NULL DEFAULT '',
            installed_by_user_id TEXT,
            installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT org_slack_installs_org_team_uq UNIQUE (org_id, team_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS org_slack_installs_org_idx "
        "ON org_slack_installs (org_id) WHERE revoked_at IS NULL"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_slack_channels (
            id UUID PRIMARY KEY,
            org_id TEXT NOT NULL,
            agent_id TEXT,
            channel_id TEXT NOT NULL,
            channel_name TEXT NOT NULL DEFAULT '',
            set_by_user_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    # NULL agent_id = org default. COALESCE makes the upsert target
    # deterministic (Postgres NULLs never conflict in a plain UNIQUE).
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS agent_slack_channels_org_agent_uq "
        "ON agent_slack_channels (org_id, COALESCE(agent_id, ''))"
    )
    # --- 132_plan_parent.py (rev 132_plan_parent) ---
    op.execute(
        "ALTER TABLE improvement_plans "
        "ADD COLUMN IF NOT EXISTS parent_plan_id UUID "
        "REFERENCES improvement_plans(id) ON DELETE SET NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS improvement_plans_parent_idx "
        "ON improvement_plans (parent_plan_id) WHERE parent_plan_id IS NOT NULL"
    )
    # --- 133_email_verification_tokens.py (rev 133_email_verification_tokens) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS email_verification_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id VARCHAR(128) NOT NULL,
            token_hash VARCHAR(64) NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verification_tokens_token_hash "
        "ON email_verification_tokens (token_hash)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id "
        "ON email_verification_tokens (user_id)"
    )
    # --- 134_budget_enforcement_default_true.py (rev 134_budget_enforcement_default_true) ---
    op.execute(
        "ALTER TABLE budgets "
        "ALTER COLUMN enforcement_enabled SET DEFAULT TRUE"
    )
    # Flip existing free-tier-shaped rows that still have enforcement off.
    # Match the FREE_TIER_DEFAULTS hard cap (≤ 4.0 USD) so paid/custom
    # budgets are left alone.
    op.execute(
        """
        UPDATE budgets
           SET enforcement_enabled = TRUE,
               updated_at = NOW()
         WHERE enforcement_enabled = FALSE
           AND cost_hard_limit_usd <= 4.0
        """
    )
    # --- 135_webhook_deliveries_last_attempt.py (rev 135_webhook_deliveries_last_attempt) ---
    op.execute(
        """
        ALTER TABLE webhook_deliveries
        ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_in_flight_attempt
        ON webhook_deliveries (last_attempt_at)
        WHERE status = 'in_flight'
        """
    )
    # --- 135_loop_events_outbox.py (rev 135_loop_events_outbox) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS loop_events_outbox (
            id BIGSERIAL PRIMARY KEY,
            org_id TEXT NOT NULL,
            event JSONB NOT NULL,
            retry_after_ts TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            drained_at TIMESTAMPTZ
        )
        """
    )
    # Drain scans WHERE drained_at IS NULL ordered oldest-first; the TTL
    # chore deletes old drained rows. One composite index serves both.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_loop_events_outbox_drained_created "
        "ON loop_events_outbox (drained_at, created_at)"
    )
    # --- 136_issue_status_escalated.py (rev 136_issue_status_escalated) ---
    _BASE_STATUSES = (
        "'open','triaged','fix_pending','verifying',"
        "'resolved','regressed','ignored','learning'"
    )
    _DROP_STATUS_CHECK = """
    DO $$
    DECLARE
        cname text;
    BEGIN
        SELECT conname INTO cname
        FROM pg_constraint
        WHERE conrelid = 'agent_issues'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%status%';
        IF cname IS NOT NULL THEN
            EXECUTE format('ALTER TABLE agent_issues DROP CONSTRAINT %I', cname);
        END IF;
    END $$;
    """
    op.execute(_DROP_STATUS_CHECK)
    op.execute(
        f"""
        ALTER TABLE agent_issues
            ADD CONSTRAINT agent_issues_status_check
            CHECK (status IN ({_BASE_STATUSES},'escalated'))
        """
    )
    # --- 137_guardian_followup_advisory.py (rev 137_guardian_followup_advisory) ---
    _BASE_KINDS = (
        "'code_patch','prompt_update','nudge_promote',"
        "'guardrail_tune','config_change'"
    )
    _DROP_PLAN_KIND_CHECK = """
    DO $$
    DECLARE
        cname text;
    BEGIN
        SELECT conname INTO cname
        FROM pg_constraint
        WHERE conrelid = 'improvement_plans'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%plan_kind%';
        IF cname IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE improvement_plans DROP CONSTRAINT %I', cname
            );
        END IF;
    END $$;
    """
    op.execute(_DROP_PLAN_KIND_CHECK)
    op.execute(
        f"""
        ALTER TABLE improvement_plans
            ADD CONSTRAINT improvement_plans_plan_kind_check
            CHECK (plan_kind IN ({_BASE_KINDS},'advisory'))
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS
            improvement_plans_guardian_followup_uniq
        ON improvement_plans (org_id, parent_plan_id)
        WHERE status = 'draft' AND parent_plan_id IS NOT NULL
        """
    )
    # --- 138_improvement_item_snoozes.py (rev 138_improvement_item_snoozes) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS improvement_item_snoozes (
            org_id UUID NOT NULL
                REFERENCES organizations(id) ON DELETE CASCADE,
            item_ref TEXT NOT NULL,
            snoozed_until TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, item_ref)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS improvement_item_snoozes_org_until_idx
        ON improvement_item_snoozes (org_id, snoozed_until)
        """
    )
    # --- 139_debug_sessions_last_replay.py (rev 139_debug_sessions_last_replay) ---
    op.execute(
        """
        ALTER TABLE debug_sessions
        ADD COLUMN IF NOT EXISTS last_replay JSONB
        """
    )
    # --- 140_portal_compare_seeds.py (rev 140_portal_compare_seeds) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS portal_compare_seeds (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            agent_id TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            recommendation TEXT NOT NULL DEFAULT 'need_more_data',
            arms JSONB NOT NULL DEFAULT '[]'::jsonb,
            sample_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            source_eval_baseline_id TEXT,
            source_eval_compare_id TEXT,
            source_debugger_session_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS portal_compare_seeds_org_idx
        ON portal_compare_seeds (org_id, updated_at DESC)
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS portal_compare_seeds_eval_pair_uidx
        ON portal_compare_seeds (org_id, source_eval_baseline_id, source_eval_compare_id)
        WHERE source_eval_baseline_id IS NOT NULL
          AND source_eval_compare_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS portal_compare_seeds_dbg_uidx
        ON portal_compare_seeds (org_id, source_debugger_session_id)
        WHERE source_debugger_session_id IS NOT NULL
        """
    )
    # --- 141_ci_eval_run_metadata.py (rev 141_ci_eval_run_metadata) ---
    op.execute(
        "ALTER TABLE regression_eval_runs "
        "ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb"
    )
    # --- 142_session_summaries.py (rev 142_session_summaries) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS session_summaries (
            org_id               VARCHAR(128) NOT NULL,
            session_id           VARCHAR(128) NOT NULL,
            agent_id             VARCHAR(256),
            user_id              VARCHAR(256),
            trace_ids            TEXT[] NOT NULL DEFAULT '{}',
            turn_count           INTEGER NOT NULL DEFAULT 0,
            total_cost_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
            total_input_tokens   BIGINT NOT NULL DEFAULT 0,
            total_output_tokens  BIGINT NOT NULL DEFAULT 0,
            total_latency_ms     DOUBLE PRECISION,
            session_start        TIMESTAMPTZ,
            session_end          TIMESTAMPTZ,
            had_stumble          BOOLEAN NOT NULL DEFAULT FALSE,
            stumble_count        INTEGER NOT NULL DEFAULT 0,
            stumble_turn_indices INTEGER[] NOT NULL DEFAULT '{}',
            issue_count          INTEGER NOT NULL DEFAULT 0,
            linked_issue_id      UUID,
            outcome              VARCHAR(16) NOT NULL DEFAULT 'live'
                                 CHECK (outcome IN
                                     ('success', 'fail', 'partial', 'live')),
            updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (org_id, session_id)
        )
        """
    )
    # List endpoint: filter by agent + order by recency (spec §5 index).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_org_agent_start "
        "ON session_summaries (org_id, agent_id, session_start DESC)"
    )
    # Unfiltered list (no agent_id) orders by recency too.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_org_start "
        "ON session_summaries (org_id, session_start DESC)"
    )
    # 084 indexed agent_stumbles by fingerprint/trace/agent but never by
    # session; the timeline's badge query filters by session's traces and
    # the rollup counts per-session stumbles.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_stumbles_session "
        "ON agent_stumbles (org_id, session_id, detected_at DESC) "
        "WHERE session_id IS NOT NULL"
    )

    op.execute("ALTER TABLE session_summaries ENABLE ROW LEVEL SECURITY")
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename = 'session_summaries'
                  AND policyname = 'tenant_isolation_session_summaries'
            ) THEN
                EXECUTE $policy$
                    CREATE POLICY tenant_isolation_session_summaries
                    ON session_summaries
                    FOR ALL
                    TO PUBLIC
                    USING (
                        org_id = current_setting('app.current_org_id', true)
                        OR current_setting('app.current_org_id', true) IS NULL
                    )
                $policy$;
            END IF;
        END $$;
        """
    )
    # --- 143_signal_events_indexes.py (rev 143_signal_events_indexes) ---
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_events_org_signal_detected "
        "ON signal_events (org_id, signal_id, detected_at DESC)"
    )
    # cluster_signal: WHERE org_id = $1 AND signal_id = $2 AND
    # matched = TRUE AND detected_at >= $3 ORDER BY detected_at DESC
    # LIMIT 500. `matched = TRUE` is a hardcoded literal, so a partial
    # index on that predicate applies and is smaller/cheaper than the
    # full index above.
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_signal_events_org_signal_matched_detected "
        "ON signal_events (org_id, signal_id, detected_at DESC) "
        "WHERE matched = TRUE"
    )
    # --- 144_auto_curator_watermark.py (rev 144_auto_curator_watermark) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS auto_curator_watermark (
            org_id UUID PRIMARY KEY
                REFERENCES organizations(id) ON DELETE CASCADE,
            last_processed_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS auto_curator_watermark_last_processed_idx
        ON auto_curator_watermark (last_processed_at)
        """
    )
    # --- 145_sso_certificate_column.py (rev 145_sso_certificate_column) ---
    op.execute(
        """
        ALTER TABLE sso_configurations
        ADD COLUMN IF NOT EXISTS certificate TEXT
        """
    )
    # --- 146_classifier_retrain_watermark.py (rev 146_classifier_retrain_watermark) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS classifier_retrain_watermark (
            org_id UUID NOT NULL,
            signal_id UUID NOT NULL,
            last_processed_at TIMESTAMPTZ,
            PRIMARY KEY (org_id, signal_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS classifier_retrain_watermark_last_processed_idx
        ON classifier_retrain_watermark (last_processed_at)
        """
    )
    # --- 147_drift_baseline_watermark.py (rev 147_drift_baseline_watermark) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS drift_baseline_watermark (
            org_id VARCHAR(128) NOT NULL,
            agent_id VARCHAR(256) NOT NULL,
            last_processed_at TIMESTAMPTZ,
            PRIMARY KEY (org_id, agent_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS drift_baseline_watermark_last_processed_idx
        ON drift_baseline_watermark (last_processed_at)
        """
    )
    # --- 148_agent_identity_aliases.py (rev 148_agent_identity_aliases) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_identity_aliases (
            org_id TEXT NOT NULL,
            synthetic_label TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (org_id, synthetic_label)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS agent_identity_aliases_org_agent_idx
        ON agent_identity_aliases (org_id, agent_id)
        """
    )
    # --- 149_promotion_candidates_ref_id_text.py (rev 149_promotion_candidates_ref_id_text) ---
    def _col_data_type(table: str, column: str) -> str | None:
        row = (
            op.get_bind()
            .execute(
                text(
                    """
                    SELECT data_type
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = :table
                      AND column_name = :column
                    """
                ),
                {"table": table, "column": column},
            )
            .fetchone()
        )
        if row is None:
            return None
        return (row[0] or "").lower()
    data_type = _col_data_type("promotion_candidates", "ref_id")
    if data_type is None:
        # Table doesn't exist yet in this environment — nothing to widen.
        return
    if data_type in ("text", "character varying", "varchar"):
        # Already widened (e.g. re-run against a fresh 092+149-consolidated
        # environment) — no-op.
        return
    op.execute(
        """
        ALTER TABLE promotion_candidates
        ALTER COLUMN ref_id TYPE TEXT
        USING ref_id::text
        """
    )
    # --- 150_pagerduty_integration.py (rev 150_pagerduty_integration) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_pagerduty_configs (
            id UUID PRIMARY KEY,
            org_id TEXT NOT NULL,
            routing_key_enc TEXT NOT NULL,
            service_name TEXT NOT NULL DEFAULT '',
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_by_user_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT org_pagerduty_configs_org_uq UNIQUE (org_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS org_pagerduty_configs_org_idx "
        "ON org_pagerduty_configs (org_id) WHERE active"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pagerduty_dlq (
            id UUID PRIMARY KEY,
            org_id TEXT,
            event_action TEXT NOT NULL DEFAULT 'trigger',
            dedup_key TEXT,
            summary TEXT NOT NULL DEFAULT '',
            payload JSONB NOT NULL,
            error_message TEXT,
            attempt_count INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS pagerduty_dlq_org_idx "
        "ON pagerduty_dlq (org_id)"
    )
    # --- 151_improvement_plan_events.py (rev 151_improvement_plan_events) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS improvement_plan_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            plan_id UUID NOT NULL REFERENCES improvement_plans(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            actor TEXT,
            detail TEXT,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS improvement_plan_events_plan_idx
        ON improvement_plan_events (org_id, plan_id, created_at)
        """
    )
    # --- 152_budget_scope.py (rev 152_budget_scope) ---
    def _existing_tables() -> set[str]:
        """Return the set of table names present on the connected database."""
        from sqlalchemy import inspect

        bind = op.get_bind()
        return set(inspect(bind).get_table_names())
    tables = _existing_tables()

    # ── 1. budgets — add scope columns, widen the unique index ────
    op.execute("DROP INDEX IF EXISTS idx_budgets_org_window")
    if "budgets" in tables:
        op.execute(
            """
            ALTER TABLE budgets
            ADD COLUMN IF NOT EXISTS scope_type VARCHAR(16) NOT NULL DEFAULT 'org',
            ADD COLUMN IF NOT EXISTS scope_id VARCHAR(128) NULL
            """
        )
        op.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_org_window_scope "
            "ON budgets (org_id, \"window\", scope_type, COALESCE(scope_id, '')) "
            "WHERE enforcement_enabled = TRUE"
        )

    # ── 2. budget_consumption — add scope columns, widen the index ─
    op.execute("DROP INDEX IF EXISTS idx_budget_consumption_active")
    if "budget_consumption" in tables:
        op.execute(
            """
            ALTER TABLE budget_consumption
            ADD COLUMN IF NOT EXISTS scope_type VARCHAR(16) NOT NULL DEFAULT 'org',
            ADD COLUMN IF NOT EXISTS scope_id VARCHAR(128) NULL
            """
        )
        op.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_consumption_active_scope "
            "ON budget_consumption "
            "(org_id, \"window\", window_start, scope_type, COALESCE(scope_id, ''))"
        )

    # ── 3. budget_actions — add scope columns (no unique index) ────
    if "budget_actions" in tables:
        op.execute(
            """
            ALTER TABLE budget_actions
            ADD COLUMN IF NOT EXISTS scope_type VARCHAR(16) NOT NULL DEFAULT 'org',
            ADD COLUMN IF NOT EXISTS scope_id VARCHAR(128) NULL
            """
        )
    # --- 153_regression_case_dataset_link.py (rev 153_regression_case_dataset_link) ---
    op.execute(
        "ALTER TABLE dataset_items ADD COLUMN IF NOT EXISTS org_id VARCHAR(128)"
    )
    op.execute(
        "ALTER TABLE dataset_items ADD COLUMN IF NOT EXISTS fingerprint TEXT"
    )
    op.execute(
        """
        ALTER TABLE dataset_items
        ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_dataset_items_org "
        "ON dataset_items (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_items_fingerprint "
        "ON dataset_items (org_id, fingerprint) WHERE fingerprint IS NOT NULL"
    )
    # --- 154_tool_call_labels_index.py (rev 154_tool_call_labels_index) ---
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_tool_call_labels_org_agent_created "
        "ON tool_call_labels (org_id, agent_id, created_at DESC)"
    )
    # --- 155_session_summaries_user_index.py (rev 155_session_summaries_user_index) ---
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_org_user "
        "ON session_summaries (org_id, user_id, session_start DESC)"
    )
    # --- 156_agent_link_columns_index.py (rev 156_agent_link_columns_index) ---
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_telemetry_events_tenant_operation_name_agent "
        "ON telemetry_events (tenant_id, operation_name, agent_id) "
        "WHERE operation_name IN ('invoke_agent', 'create_agent')"
    )

    # Bounded backfill: give recently-ingested tool-call rows a non-null
    # operation_name sentinel. Time-bounded so this can't turn into an
    # unbounded table rewrite on a large, long-lived deployment.
    op.execute(
        "UPDATE telemetry_events "
        "SET operation_name = 'unknown' "
        "WHERE operation_name IS NULL "
        "AND created_at > now() - interval '30 days' "
        "AND event_type = 'tool.call'"
    )
    # --- 157_agent_artifact_context.py (rev 157_agent_artifact_context) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_artifact_context (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id     TEXT NOT NULL,
            filename     VARCHAR(256),
            content_type VARCHAR(32) NOT NULL DEFAULT 'text/markdown',
            content      TEXT NOT NULL,
            created_by   VARCHAR(128) NOT NULL,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_agent_artifact_context_agent
        ON agent_artifact_context (org_id, agent_id, created_at DESC)
        """
    )
    # --- 158_alert_suppression_rules.py (rev 158_alert_suppression_rules) ---
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_suppression_rules (
            id UUID PRIMARY KEY,
            org_id TEXT NOT NULL,
            pattern TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            window_hours INT,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_by_user_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS alert_suppression_rules_org_idx "
        "ON alert_suppression_rules (org_id) WHERE enabled"
    )
    # --- 159_nl_alert_rules_severity.py (rev 159_nl_alert_rules_severity) ---
    op.execute(
        """
        ALTER TABLE nl_alert_rules
        ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'warning'
        """
    )
    # Prefer the bridged EQL severity when the row already exists
    # (same name + org as create_nl_alert_rule + AlertAsCode.compile).
    # org_id types differ (UUID vs VARCHAR) — compare as text.
    op.execute(
        """
        UPDATE nl_alert_rules AS n
        SET severity = e.severity
        FROM eql_alert_rules AS e
        WHERE n.org_id::text = e.org_id::text
          AND n.name = e.name
          AND lower(e.severity) IN ('info', 'warning', 'high', 'critical')
        """
    )
    # --- 160_signal_definitions_org_enabled_created.py (rev 160_signal_definitions_org_enabled_created) ---
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_definitions_org_enabled_created "
        "ON signal_definitions (org_id, created_at ASC) "
        "WHERE enabled = TRUE"
    )


def downgrade() -> None:
    """Squashed base revisions cannot be individually downgraded."""
    raise NotImplementedError(
        "Cannot downgrade past a squash boundary. "
        "Restore from a database backup to roll back before revision 160."
    )

