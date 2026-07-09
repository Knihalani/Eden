-- 044_users_text_fk.sql
-- July 2026: Apply the three FK-blocked migrations (014, 020, 029) with
-- TEXT-typed FK references to users(id), matching migration 040's
-- widening. Each table is created idempotently and the FK to users
-- is TEXT — the original migrations used UUID and would fail to apply
-- now that users.id has been widened to TEXT by migration 040.
--
-- Why this is its own migration rather than editing 014/020/029:
--   - alembic_version is already at 082 (post 043). Re-running the
--     earlier files would either no-op (alembic tracks) or be
--     confusing for a DBA looking at version history.
--   - Keeps the original files unchanged so local DBs that did
--     successfully apply the UUID versions aren't affected.
--
-- Tables created here:
--   - org_github_installations  (was 029)
--   - onboarding_state          (was 029)
--   - onboarding_pr_runs        (was 029)
--   - org_scim_config           (was 014)
--   - scim_users                (was 014)
--   - role_definitions          (was 020)
--   - role_permissions          (was 020)
--   - role_assignments          (was 020)

BEGIN;

-- ── 1. GitHub App installations per org (was 029) ────────────────
CREATE TABLE IF NOT EXISTS org_github_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    installation_id BIGINT NOT NULL,
    github_account_login TEXT NOT NULL,
    github_account_type TEXT NOT NULL DEFAULT 'Organization'
        CHECK (github_account_type IN ('Organization', 'User')),
    -- TEXT (was UUID) — matches users.id post-040 widening.
    installed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    suspended_at TIMESTAMPTZ,
    CONSTRAINT uq_org_github_installations
        UNIQUE (org_id, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_org_github_installations_org
    ON org_github_installations (org_id)
    WHERE suspended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_org_github_installations_installation
    ON org_github_installations (installation_id);

-- ── 2. Per-org wizard state (was 029) ───────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_state (
    org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    step TEXT NOT NULL DEFAULT 'welcome'
        CHECK (step IN (
            'welcome', 'org_setup', 'install_sdk',
            'connect_github', 'wait_for_pr', 'done'
        )),
    org_setup_choice TEXT
        CHECK (org_setup_choice IN ('created', 'joined') OR org_setup_choice IS NULL),
    completed_by_users JSONB NOT NULL DEFAULT '[]'::jsonb,
    agents_onboarded JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_state_step
    ON onboarding_state (step)
    WHERE step <> 'done';

-- ── 3. Integration PRs opened by the wizard (was 029) ───────────
CREATE TABLE IF NOT EXISTS onboarding_pr_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_id TEXT,
    installation_id BIGINT NOT NULL,
    repo_full_name TEXT NOT NULL,
    framework TEXT,
    language TEXT,
    branch TEXT,
    pr_number INT,
    pr_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'opened', 'merged', 'closed', 'skipped', 'failed'
        )),
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- TEXT (was UUID) — matches users.id post-040 widening.
    opened_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    opened_at TIMESTAMPTZ,
    merged_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_onboarding_pr_runs_org_status
    ON onboarding_pr_runs (org_id, status);
CREATE INDEX IF NOT EXISTS idx_onboarding_pr_runs_org_recent
    ON onboarding_pr_runs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_onboarding_pr_runs_agent
    ON onboarding_pr_runs (org_id, agent_id, created_at DESC)
    WHERE agent_id IS NOT NULL;

-- ── 4. SCIM config (was 014) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_scim_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    scim_token_hash TEXT,
    scim_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    last_sync_at TIMESTAMPTZ,
    provisioned_user_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id)
);

CREATE INDEX IF NOT EXISTS idx_org_scim_config_org
    ON org_scim_config (org_id);
CREATE INDEX IF NOT EXISTS idx_org_scim_config_enabled
    ON org_scim_config (org_id, scim_enabled) WHERE scim_enabled = TRUE;

-- ── 5. SCIM users (was 014) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS scim_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    scim_external_id TEXT NOT NULL,
    -- TEXT (was UUID) — matches users.id post-040 widening.
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    user_email TEXT,
    display_name TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, scim_external_id)
);

CREATE INDEX IF NOT EXISTS idx_scim_users_org ON scim_users (org_id);
CREATE INDEX IF NOT EXISTS idx_scim_users_external_id ON scim_users (org_id, scim_external_id);
CREATE INDEX IF NOT EXISTS idx_scim_users_user_id ON scim_users (user_id);

-- ── 6. Role definitions (was 020) ────────────────────────────────
CREATE TABLE IF NOT EXISTS role_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    base_role VARCHAR(16) NOT NULL CHECK (base_role IN ('owner', 'admin', 'member', 'viewer')),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_role_definitions_org
    ON role_definitions (org_id);

-- ── 7. Role permissions (was 020) ────────────────────────────────
CREATE TABLE IF NOT EXISTS role_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id UUID NOT NULL REFERENCES role_definitions(id) ON DELETE CASCADE,
    permission_key VARCHAR(64) NOT NULL,
    granted BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (role_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role
    ON role_permissions (role_id);

-- ── 8. Role assignments (was 020) ───────────────────────────────
CREATE TABLE IF NOT EXISTS role_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id UUID NOT NULL REFERENCES role_definitions(id) ON DELETE CASCADE,
    -- TEXT (was UUID) — matches users.id post-040 widening.
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource_type VARCHAR(32),
    resource_id TEXT,
    -- TEXT (was UUID) — matches users.id post-040 widening.
    granted_by TEXT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_role_assignments_user ON role_assignments (user_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_role ON role_assignments (role_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_resource
    ON role_assignments (resource_type, resource_id)
    WHERE resource_type IS NOT NULL;

-- Resource consistency check.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_resource_consistency'
    ) THEN
        ALTER TABLE role_assignments
            ADD CONSTRAINT role_assignments_resource_consistency
            CHECK (
                (resource_type IS NULL AND resource_id IS NULL)
                OR (resource_type IS NOT NULL AND resource_id IS NOT NULL)
            );
    END IF;
END$$;

-- ── Triggers (was 014) ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_org_scim_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS org_scim_config_updated_at ON org_scim_config;
CREATE TRIGGER org_scim_config_updated_at
    BEFORE UPDATE ON org_scim_config
    FOR EACH ROW
    EXECUTE FUNCTION update_org_scim_config_updated_at();

CREATE OR REPLACE FUNCTION update_scim_users_last_synced()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_synced_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scim_users_last_synced_at ON scim_users;
CREATE TRIGGER scim_users_last_synced_at
    BEFORE UPDATE ON scim_users
    FOR EACH ROW
    EXECUTE FUNCTION update_scim_users_last_synced();

COMMIT;

-- ── 9. AI insights chat sessions + messages (was 015) ──────────
-- Idempotent. user_id is TEXT (was UUID) to match users.id.

CREATE TABLE IF NOT EXISTS ai_insights_chat_sessions (
    session_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    title       VARCHAR(256) NOT NULL DEFAULT 'New chat',
    archived_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aics_org_user_updated
    ON ai_insights_chat_sessions (org_id, user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_aics_org_archived
    ON ai_insights_chat_sessions (org_id, archived_at);

CREATE TABLE IF NOT EXISTS ai_insights_chat_messages (
    message_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID NOT NULL
                  REFERENCES ai_insights_chat_sessions(session_id)
                  ON DELETE CASCADE,
    role          VARCHAR(16) NOT NULL,
    content_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aicm_session_created
    ON ai_insights_chat_messages (session_id, created_at);

-- ── 10. Webhook DLQ (was 053_webhook_dlq alembic) ─────────────
-- Mirrors the alembic revision's column choices (VARCHAR org_id
-- and webhook_id, TEXT payload). The replay endpoint expects
-- (org_id, webhook_id) lookup and the column shapes match the
-- routes' SQL.

CREATE TABLE IF NOT EXISTS webhook_dlq (
    id                    UUID PRIMARY KEY,
    org_id                VARCHAR(128) NOT NULL,
    webhook_id            VARCHAR(64) NOT NULL,
    event_type            VARCHAR(64) NOT NULL,
    payload               TEXT NOT NULL,
    last_response_status  INT,
    last_error            TEXT,
    attempt_count         INT NOT NULL,
    max_attempts          INT NOT NULL,
    first_attempt_at      TIMESTAMPTZ,
    last_attempt_at       TIMESTAMPTZ,
    replay_count          INT NOT NULL DEFAULT 0,
    last_replayed_at      TIMESTAMPTZ,
    signature_v1          TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_org
    ON webhook_dlq (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_webhook
    ON webhook_dlq (org_id, webhook_id, created_at DESC);

-- signature_v1 column on webhook_deliveries (idempotent).
ALTER TABLE webhook_deliveries
    ADD COLUMN IF NOT EXISTS signature_v1 TEXT;

-- webhook_endpoints view alias (spec-aligned naming).
CREATE OR REPLACE VIEW webhook_endpoints AS
    SELECT id, org_id::text AS org_id_text, url, events,
           active, created_at, updated_at
      FROM webhooks;

COMMIT;
