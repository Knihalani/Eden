"""Initial Eden schema baseline.

Creates the full database schema as it existed before Alembic was adopted.
Future schema changes should use standard Alembic operations.

Revision ID: 001
Revises:
Create Date: 2026-05-29 00:00:00.000000

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ========================================================================
    # Extensions
    # ========================================================================
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


def downgrade() -> None:
    # Drop in reverse dependency order
    tables = [
        "stripe_events",
        "specs",
        "notifications",
        "org_allowed_domains",
        "scim_identities",
        "org_sso_settings",
        "sso_configurations",
        "org_invitations",
        "org_api_keys",
        "org_audit_log",
        "stripe_subscriptions",
        "org_plans",
        "code_references",
        "prompt_versions",
        "exploits",
        "skills",
        "entity_links",
        "graph_entities",
        "checkpoint_blobs",
        "jobs",
        "org_members",
        "organizations",
        "users",
    ]
    for table in tables:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")

    op.execute("DROP FUNCTION IF EXISTS update_updated_at() CASCADE")
    op.execute('DROP EXTENSION IF EXISTS "vector"')
    op.execute('DROP EXTENSION IF EXISTS "uuid-ossp"')
