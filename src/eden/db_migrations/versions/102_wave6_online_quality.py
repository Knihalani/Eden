"""102 — Phase 5 Wave 6: online scoring, dashboards, prompt deploy, automations."""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "102_wave6_online_quality"
down_revision: str | Sequence[str] | None = "101_eval_loop"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
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
