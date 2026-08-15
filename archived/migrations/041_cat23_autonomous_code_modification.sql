-- Manually extracted from src/eden/db_migrations/versions/027_autonomous_code_modification.py
-- All 19 Cat 23 tables with IF NOT EXISTS guards
BEGIN;

-- 1. repo_connections
CREATE TABLE IF NOT EXISTS repo_connections (
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
);
CREATE INDEX IF NOT EXISTS idx_repo_connections_org ON repo_connections (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repo_connections_status ON repo_connections (org_id, status) WHERE status = 'active';

-- 2. code_root_cause_links
CREATE TABLE IF NOT EXISTS code_root_cause_links (
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
);
CREATE INDEX IF NOT EXISTS idx_code_root_cause_links_org ON code_root_cause_links (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_root_cause_links_rca ON code_root_cause_links (org_id, rca_id);

-- 3. proposed_patches
CREATE TABLE IF NOT EXISTS proposed_patches (
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
);
CREATE INDEX IF NOT EXISTS idx_proposed_patches_org ON proposed_patches (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposed_patches_status ON proposed_patches (org_id, status) WHERE status IN ('proposed', 'approved', 'merged');

-- 4. patch_test_runs
CREATE TABLE IF NOT EXISTS patch_test_runs (
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
);
CREATE INDEX IF NOT EXISTS idx_patch_test_runs_org ON patch_test_runs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patch_test_runs_patch ON patch_test_runs (org_id, patch_id);

-- 5. pull_requests
CREATE TABLE IF NOT EXISTS pull_requests (
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
);
CREATE INDEX IF NOT EXISTS idx_pull_requests_org ON pull_requests (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pull_requests_state ON pull_requests (org_id, state) WHERE state IN ('open', 'merged');

-- 6. post_merge_windows
CREATE TABLE IF NOT EXISTS post_merge_windows (
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
);
CREATE INDEX IF NOT EXISTS idx_post_merge_windows_org ON post_merge_windows (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_merge_windows_pr ON post_merge_windows (org_id, pr_id, window_hours);

-- 7. revert_events
CREATE TABLE IF NOT EXISTS revert_events (
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
);
CREATE INDEX IF NOT EXISTS idx_revert_events_org ON revert_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_revert_events_pr ON revert_events (org_id, pr_id);

-- 8. codebase_knowledge_graph
CREATE TABLE IF NOT EXISTS codebase_knowledge_graph (
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
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_codebase_knowledge_graph_org ON codebase_knowledge_graph (org_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_codebase_knowledge_graph_pk ON codebase_knowledge_graph (id);

-- 9. approval_grants
CREATE TABLE IF NOT EXISTS approval_grants (
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
);
CREATE INDEX IF NOT EXISTS idx_approval_grants_org ON approval_grants (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_grants_user ON approval_grants (org_id, granted_user_id) WHERE revoked_at IS NULL;

-- 10. patch_approvals
CREATE TABLE IF NOT EXISTS patch_approvals (
    id                       VARCHAR(64) PRIMARY KEY,
    org_id                   VARCHAR(128) NOT NULL,
    patch_id                 VARCHAR(64) NOT NULL,
    approver_user_id         VARCHAR(128) NOT NULL,
    approval_type            VARCHAR(32) NOT NULL,
    comment                  TEXT NOT NULL DEFAULT '',
    delegated_from_user_id   VARCHAR(128),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patch_approvals_org ON patch_approvals (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patch_approvals_patch ON patch_approvals (org_id, patch_id);

-- 11. patch_approval_status
CREATE TABLE IF NOT EXISTS patch_approval_status (
    id                       VARCHAR(64) PRIMARY KEY,
    org_id                   VARCHAR(128) NOT NULL,
    patch_id                 VARCHAR(64) NOT NULL,
    approvals_required       INT NOT NULL DEFAULT 1,
    approvals_received       INT NOT NULL DEFAULT 0,
    eligible_approvers       JSONB,
    missing_approver_roles   JSONB,
    status                   VARCHAR(32) NOT NULL DEFAULT 'awaiting',
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patch_approval_status_org ON patch_approval_status (org_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_patch_approval_status_pk ON patch_approval_status (patch_id);

-- 12. approval_delegations
CREATE TABLE IF NOT EXISTS approval_delegations (
    id                       VARCHAR(64) PRIMARY KEY,
    org_id                   VARCHAR(128) NOT NULL,
    delegator_user_id        VARCHAR(128) NOT NULL,
    delegate_user_id         VARCHAR(128) NOT NULL,
    starts_at                TIMESTAMPTZ NOT NULL,
    ends_at                  TIMESTAMPTZ NOT NULL,
    scope_filter             TEXT NOT NULL DEFAULT '',
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_approval_delegations_org ON approval_delegations (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_delegations_active ON approval_delegations (org_id, delegate_user_id) WHERE revoked_at IS NULL;

-- 13. auto_approval_policies
CREATE TABLE IF NOT EXISTS auto_approval_policies (
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
);
CREATE INDEX IF NOT EXISTS idx_auto_approval_policies_org ON auto_approval_policies (org_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_approval_policies_pk ON auto_approval_policies (org_id);

-- 14. auto_approval_events
CREATE TABLE IF NOT EXISTS auto_approval_events (
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
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auto_approval_events_org ON auto_approval_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_approval_events_patch ON auto_approval_events (org_id, patch_id);

-- 15. auto_approval_dry_runs
CREATE TABLE IF NOT EXISTS auto_approval_dry_runs (
    id                            VARCHAR(64) PRIMARY KEY,
    org_id                        VARCHAR(128) NOT NULL,
    requested_by_user_id          VARCHAR(128) NOT NULL,
    total_patches_evaluated       INT NOT NULL DEFAULT 0,
    would_have_auto_approved      INT NOT NULL DEFAULT 0,
    blocked_breakdown             JSONB,
    estimated_time_saved_minutes  INT NOT NULL DEFAULT 0,
    evaluated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auto_approval_dry_runs_org ON auto_approval_dry_runs (org_id, evaluated_at DESC);

-- 16. agent_persona_config
CREATE TABLE IF NOT EXISTS agent_persona_config (
    id                       VARCHAR(64) PRIMARY KEY,
    org_id                   VARCHAR(128) NOT NULL,
    display_name             VARCHAR(128) NOT NULL DEFAULT 'Eden Agent',
    avatar                   VARCHAR(256) NOT NULL DEFAULT 'eden-mark',
    voice                    VARCHAR(64) NOT NULL DEFAULT 'concise',
    track_record_visible_to  JSONB,
    commit_message_style     VARCHAR(64) NOT NULL DEFAULT 'conventional-commits',
    pr_body_template         VARCHAR(64) NOT NULL DEFAULT 'default',
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_persona_config_org ON agent_persona_config (org_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_persona_config_pk ON agent_persona_config (org_id);

-- 17. agent_activity_events
CREATE TABLE IF NOT EXISTS agent_activity_events (
    id                       VARCHAR(64) PRIMARY KEY,
    org_id                   VARCHAR(128) NOT NULL,
    agent_id                 VARCHAR(64) NOT NULL,
    event_type               VARCHAR(64) NOT NULL,
    patch_id                 VARCHAR(64),
    summary                  TEXT NOT NULL DEFAULT '',
    deep_link                TEXT NOT NULL DEFAULT '',
    actor_user_id            VARCHAR(128),
    metadata                 JSONB,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_activity_events_org ON agent_activity_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activity_events_type ON agent_activity_events (org_id, event_type, created_at DESC);

-- 18. repo_style_profiles
CREATE TABLE IF NOT EXISTS repo_style_profiles (
    id                       VARCHAR(64) PRIMARY KEY,
    org_id                   VARCHAR(128) NOT NULL,
    repo_id                  VARCHAR(64) NOT NULL,
    indentation              JSONB,
    type_hints_style         VARCHAR(32) NOT NULL DEFAULT 'pep484',
    naming_convention        JSONB,
    import_style             VARCHAR(32) NOT NULL DEFAULT 'absolute',
    error_handling           VARCHAR(32) NOT NULL DEFAULT 'exceptions',
    logging_style            VARCHAR(32) NOT NULL DEFAULT 'stdlib-logging',
    docstring_style          VARCHAR(32) NOT NULL DEFAULT 'google',
    test_framework           VARCHAR(32) NOT NULL DEFAULT 'pytest',
    lint_config              JSONB,
    complexity_median        INT NOT NULL DEFAULT 5,
    architecture_patterns    JSONB,
    last_learned_at          TIMESTAMPTZ,
    last_learned_from_pr_id  VARCHAR(64),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_repo_style_profiles_org ON repo_style_profiles (org_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_style_profiles_pk ON repo_style_profiles (org_id, repo_id);

-- 19. patch_review_actions
CREATE TABLE IF NOT EXISTS patch_review_actions (
    id                       VARCHAR(64) PRIMARY KEY,
    org_id                   VARCHAR(128) NOT NULL,
    patch_id                 VARCHAR(64) NOT NULL,
    action                   VARCHAR(32) NOT NULL,
    actor_user_id            VARCHAR(128) NOT NULL,
    comment                  TEXT NOT NULL DEFAULT '',
    reason                   TEXT NOT NULL DEFAULT '',
    edited_diff              TEXT,
    version_after            INT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patch_review_actions_org ON patch_review_actions (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patch_review_actions_patch ON patch_review_actions (org_id, patch_id);

-- 20. pr_patterns (added by migration 045)
CREATE TABLE IF NOT EXISTS pr_patterns (
    id                       VARCHAR(64) PRIMARY KEY,
    org_id                   VARCHAR(128) NOT NULL,
    repo_id                  VARCHAR(64) NOT NULL,
    title_format             TEXT NOT NULL DEFAULT '',
    body_template            TEXT NOT NULL DEFAULT '',
    common_labels            JSONB,
    common_reviewers         JSONB,
    common_branch_prefix     VARCHAR(64) NOT NULL DEFAULT 'eden/auto-fix',
    sample_size              INT NOT NULL DEFAULT 0,
    sample_window_days       INT NOT NULL DEFAULT 0,
    last_mined_from_pr_id    VARCHAR(64),
    last_mined_from_pr_number INT,
    last_mined_at            TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr_patterns_org ON pr_patterns (org_id, created_at DESC);

-- 21. pr_rejection_memory (Phase 3b, 2026-06-23) — not-now memory.
-- When a human reviews a proposed_patch and rejects it (wontfix /
-- outdated / user_fixed), the rejection is persisted here with a TTL
-- so the Cat 23 scheduler doesn't regenerate the same patch during
-- the cooldown window. Different rejection types have different TTLs:
-- wontfix = 30d (the codebase intentionally doesn't want this),
-- outdated = 30d (the upstream issue is no longer relevant),
-- user_fixed = 90d (the user already merged their own fix, don't
-- re-suggest). The scheduler reads this table before generating a
-- new patch on the same (file_path, title_hash) pair.
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
);
CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_org ON pr_rejection_memory (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_active ON pr_rejection_memory (org_id, file_path, title_hash) WHERE expires_at > NOW();
CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_expires ON pr_rejection_memory (expires_at);

COMMIT;
