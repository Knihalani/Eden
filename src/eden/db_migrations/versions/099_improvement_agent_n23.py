"""099 — N23 improvement_runs + improvement_plans.

Revision ID: 099a
Revises: 098b

Renumbered from a duplicate "099" (see 096_debugger_llm_cache.py
for the chain-repair note) — continues from "098b".
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "099a"
down_revision: str | Sequence[str] | None = "098b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
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


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS improvement_plans")
    op.execute("DROP TABLE IF EXISTS improvement_runs")
