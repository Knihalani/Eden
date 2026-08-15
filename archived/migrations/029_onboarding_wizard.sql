-- June 2026: Onboarding wizard + GitHub App installations.
--
-- Three tables. All are RLS-friendly (org_id columns where applicable)
-- and use the existing `organizations`/`users` FKs.
--
-- 1) org_github_installations — one row per (org_id, github_installation_id).
--    An org can have multiple installations (different GitHub orgs
--    sharing one Eden org). Installation tokens are NOT stored — they
--    are minted on demand by GitHubOAuthClient.installation_token.
--
-- 2) onboarding_state — per-org wizard progress so refresh + multi-tab
--    work. ``step`` is one of:
--      welcome | org_setup | install_sdk | connect_github | wait_for_pr | done
--    The "org_setup" step persists the chosen branch:
--      org_setup_choice = 'created' | 'joined'.
--
-- 3) onboarding_pr_runs — one row per integration PR the wizard opens
--    on behalf of an org. The wizard polls `status` to update the UI.

-- ── 1. GitHub App installations per org ────────────────────────────
CREATE TABLE IF NOT EXISTS org_github_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- GitHub's installation id (numeric, fits in BIGINT). Unique
    -- per Eden org so re-installing replaces the prior row.
    installation_id BIGINT NOT NULL,
    -- The GitHub account (user or org) the App is installed on.
    github_account_login TEXT NOT NULL,
    github_account_type TEXT NOT NULL DEFAULT 'Organization'
        CHECK (github_account_type IN ('Organization', 'User')),
    -- The user inside Eden that authorised the install (so we can
    -- audit-trail "alice from acme connected acme/foo").
    installed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    suspended_at TIMESTAMPTZ,  -- non-null = the install was suspended on GitHub
    CONSTRAINT uq_org_github_installations
        UNIQUE (org_id, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_org_github_installations_org
    ON org_github_installations (org_id)
    WHERE suspended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_org_github_installations_installation
    ON org_github_installations (installation_id);


-- ── 2. Per-org wizard state ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_state (
    org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    step TEXT NOT NULL DEFAULT 'welcome'
        CHECK (step IN (
            'welcome',
            'org_setup',
            'install_sdk',
            'connect_github',
            'wait_for_pr',
            'done'
        )),
    -- 'created' (this user owns a new org) | 'joined' (this user
    -- accepted an invite). Determines whether the wizard shows the
    -- GitHub repo step at all.
    org_setup_choice TEXT
        CHECK (org_setup_choice IN ('created', 'joined') OR org_setup_choice IS NULL),
    -- Each user who has walked through the wizard for this org.
    -- Stored as an array of user UUIDs (JSONB to allow extending
    -- with per-user resume metadata later).
    completed_by_users JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Each agent the wizard has opened a PR for, so the
    -- "+ Connect new agent" flow can list them.
    agents_onboarded JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_state_step
    ON onboarding_state (step)
    WHERE step <> 'done';


-- ── 3. Integration PRs opened by the wizard ─────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_pr_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- The agent the integration is for. Foreign key to
    -- agent_registrations.(org_id, agent_id) — composite, so we just
    -- store the agent_id and rely on the app to maintain consistency.
    agent_id TEXT,
    installation_id BIGINT NOT NULL,
    repo_full_name TEXT NOT NULL,        -- e.g. "acme/agent-runner"
    framework TEXT,                       -- detected framework
    language TEXT,                        -- "python" | "typescript" | "unknown"
    branch TEXT,                          -- the new branch on the user's repo
    pr_number INT,                        -- populated once the PR is opened
    pr_url TEXT,                          -- e.g. https://github.com/acme/agent-runner/pull/42
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending',     -- detection + plan in progress
            'opened',      -- PR opened, awaiting human action
            'merged',      -- user merged the PR
            'closed',      -- user closed the PR without merging
            'skipped',     -- user clicked "skip — mark integrated"
            'failed'       -- something blew up (GitHub auth, rate limit, …)
        )),
    -- Detail blob: detection result + integration plan + GitHub error
    -- messages. JSONB so the portal can render rich state without an
    -- extra round trip.
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    opened_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
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
