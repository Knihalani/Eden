"""027_autonomous_code_modification — Cat 23 (Autonomous Code Modification) STUB surface.

Revision ID: 027
Revises: 026
Create Date: 2026-06-12

Adds the 15 core Cat 23 tables (the 4 inbox/persona/style/quality tables
are deferred per upgradespec §D.7 — they're stubbed at the service layer
and re-added when Gate-2/Gate-4 land):

* ``repo_connections`` — the per-repo connection metadata.

* ``repo_connections`` — the per-repo connection metadata.
  :class:`RepoConnector` writes one row per repo registration.
  PK is the deterministic ``repo_<uuid>`` id from
  :func:`eden.code_change._common._new_id`.

* ``code_root_cause_links`` — the per-RCA → per-file attribution.
  :class:`CodeRootCauseLinker` writes one row per RCA → file
  mapping with a confidence score. PK is the deterministic
  ``crcl_<sha256[:16]>`` id (content-derived from
  ``(org, rca_id, repo_id)``).

* ``proposed_patches`` — the per-patch proposal. :class:`PatchGenerator`
  writes one row per generated patch. PK is the deterministic
  ``patch_<uuid>`` id.

* ``patch_test_runs`` — the per-patch test result.
  :class:`TestPlanRunner` writes one row per test run. PK is
  the deterministic ``testrun_<uuid>`` id.

* ``pull_requests`` — the per-PR metadata. :class:`PRCreator` writes
  one row per opened PR. PK is the deterministic ``pr_<uuid>`` id.

* ``post_merge_windows`` — the per-window post-merge telemetry
  comparison. :class:`PostMergeMonitor` writes one row per
  window (1h, 6h, 24h, 7d) per PR. PK is the deterministic
  ``pmw_<uuid>`` id.

* ``revert_events`` — the per-revert event. :class:`AutoRevertEngine`
  writes one row per revert. PK is the deterministic
  ``rev_<uuid>`` id.

* ``codebase_knowledge_graph`` — the per-(repo, code_path) graph
  node. :class:`CodebaseKnowledgeGraph` writes one row per
  touched file. PK is the deterministic ``cgraph_<sha256[:16]>``
  id (content-derived from ``(org, repo, path)``).

The migration also adds the 4 admin-controlled approval workflow
tables (used by the inbox sub-package):

* ``approval_grants`` — the per-grant row.
* ``patch_approvals`` — the per-approval row.
* ``patch_approval_status`` — the per-patch status rollup.
* ``approval_delegations`` — the per-delegation row.

And the 3 auto-approval tables (used by the auto_approval
sub-package):

* ``auto_approval_policies`` — the per-org policy row.
* ``auto_approval_events`` — the per-evaluation event row.
* ``auto_approval_dry_runs`` — the per-dry-run summary row.

Conventions (per the v1.6 cat-ship pattern, mirrors
:file:`026_apm_depth_rollups.py`):

* All tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.
* The PKs use the deterministic ``<prefix>_<uuid|sha256>`` shapes
  the v1.6 cat spec mandates, so re-runs dedupe naturally and
  the STUB-mode services can mint ids without a database round-trip.

The STUB surface intentionally does NOT enforce RLS on the 8
core tables — the real Gate-1 + Gate-2 ship will add the
``ENABLE ROW LEVEL SECURITY`` + the
``CREATE POLICY tenant_isolation ON <table>`` blocks following
the :file:`015_regions_and_rls.py` pattern.

See ``docs/eden-observability-gap-roadmap.md`` (Cat 23) and
``docs/observability-gap/23-autonomous-code-modification.md``.
"""

from __future__ import annotations

from alembic import op

revision = "027"
down_revision = "026"
branch_labels = None
depends_on = None


def _table(name: str, body: str, extra_index: str = "") -> None:
    op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
    op.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
        f"ON {name} (org_id, created_at DESC)"
    )
    if extra_index:
        op.execute(extra_index)


def upgrade() -> None:
    # ── 8 core Cat 23 tables ──────────────────────────────────────

    # 1. repo_connections — per-repo connection metadata
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

    # ── 4 inbox + persona + style + quality tables ────────────────
    # ponytail: tables deferred per upgradespec §D.7 (Phase 1 cut).
    # The persona/style/inbox surfaces are gated by Cat 23's Gate-2 (attribution)
    # and Gate-4 (end-to-end ship). Migration keeps 19 → 15 tables for v1.6;
    # these 4 land via a future migration when the services have real
    # backing stores (not in-memory stubs).
    # _table(
    #     "agent_persona_config",
    #     ...
    # )
    # _table(
    #     "agent_activity_events",
    #     ...
    # )
    # _table(
    #     "repo_style_profiles",
    #     ...
    # )
    # _table(
    #     "patch_review_actions",
    #     ...
    # )


def downgrade() -> None:
    # Drop in reverse order so any FK constraints (future) are
    # removed before the tables they reference.
    for table in (
        # Auto-approval
        "auto_approval_dry_runs",
        "auto_approval_events",
        "auto_approval_policies",
        # Approvals
        "approval_delegations",
        "patch_approval_status",
        "patch_approvals",
        "approval_grants",
        # Inbox / persona / style / quality — deferred per §D.7
        "patch_review_actions",
        "repo_style_profiles",
        "agent_activity_events",
        "agent_persona_config",
        # 8 core
        "codebase_knowledge_graph",
        "revert_events",
        "post_merge_windows",
        "pull_requests",
        "patch_test_runs",
        "proposed_patches",
        "code_root_cause_links",
        "repo_connections",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table}")
