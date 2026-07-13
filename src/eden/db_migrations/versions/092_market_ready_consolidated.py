"""092 — WS1–WS4 market-ready consolidated schema.

Revision ID: 092
Revises: 090
Create Date: 2026-07-13

Merges parallel workstream migrations:
  - WS1 detect/signals (F06, F21, F34, N02)
  - WS2 learn-in-production (F39/F40/F41/F42/F44)
  - WS3 fix/prove (agent sessions, fix chat, regression, impact)
  - WS4 enterprise (production eval, fleet, experiments, audit)
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "092"
down_revision: str | Sequence[str] | None = "090"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── WS1: detect / signals ─────────────────────────────────────
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


def downgrade() -> None:
    op.execute("ALTER TABLE agent_issues DROP COLUMN IF EXISTS regression_case_id")
    op.execute("ALTER TABLE agent_issues DROP COLUMN IF EXISTS experiment_result")
    op.execute("ALTER TABLE agent_issues DROP COLUMN IF EXISTS experiment_id")
    for table in (
        "agent_audit_ledger",
        "issue_experiments",
        "agent_delegation_edges",
        "agent_registry",
        "production_eval_daily_spend",
        "production_eval_scores",
        "production_eval_policies",
        "change_impact_reports",
        "regression_eval_cases",
        "issue_fix_sessions",
        "agent_sessions",
        "auto_curator_runs",
        "production_eval_slices",
        "drift_reports",
        "drift_baselines",
        "agent_book_config",
        "agent_books",
        "promotion_candidates",
        "nudge_outcomes",
        "nudges",
        "saved_searches",
        "mcp_tool_stats",
        "mcp_server_registry",
        "signal_classifiers",
        "tool_call_labels",
        "signal_events",
        "signal_definitions",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table}")
