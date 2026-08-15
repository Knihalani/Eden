"""170 — post_merge_windows table (Wave 4 post-merge guard).

Revision ID: 170_post_merge_windows
Revises: 169_outcome_tables
Create Date: 2026-08-11

Wave 4 (4.1): the missing ship→verify node. When an improvement plan's
PR merges, the approve flow schedules a one-shot N01 replay verify, but
there is no *production* post-merge guard — nothing compares the agent's
real-world issue rate before vs after the merge. This table opens a
1h/24h/7d watch per merged plan: a row per window, closed by the
``PostMergeMonitor`` comparator (4.2) once ``closes_at`` passes.

Adopting a dead schema (audit C1–C3): migration 027 created a
``post_merge_windows`` table (``pr_id``/``baseline_metrics``/
``regression_score`` shape) that no code ever wrote to, and 097 forced
tenant RLS onto it — a footgun for background-worker writes, since the
097 policy (``org_id = current_setting('app.current_org_id')``) rejects
or silently hides rows written from cron contexts that never set the GUC.
We drop that dead table (its RLS policy dies with it) and create the
wired shape below, keyed by ``plan_id`` (the approve flow knows the plan,
not always the PR id at merge time) with a plain ``org_id`` column — the
same worker-write convention as ``nudge_outcomes`` / the 169 outcome
tables, where readers confine via ``WHERE org_id = $1``.

Row lifecycle: ``status='pending'`` (written at merge, with the pre-merge
baseline rate snapshot) → comparator sets ``ok`` or ``degrading`` +
``delta_pct`` + optional ``follow_up_plan_id`` (an advisory plan linked
via ``parent_plan_id`` when the agent's issue rate regressed materially).
``UNIQUE (org_id, plan_id, window_hours)`` keeps re-delivered merge
events from double-opening the same watch.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "170_post_merge_windows"
down_revision: str | Sequence[str] | None = "169_outcome_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Drop the dead 027 table (never wired; FORCE-RLS from 097 is a
    # worker-write footgun). Its tenant_isolation policy drops with it.
    op.execute("DROP TABLE IF EXISTS post_merge_windows")
    op.execute(
        """
        CREATE TABLE post_merge_windows (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            plan_id          UUID NOT NULL REFERENCES improvement_plans(id) ON DELETE CASCADE,
            agent_id         VARCHAR(256),
            window_hours     INTEGER NOT NULL
                CHECK (window_hours IN (1, 24, 168)),
            status           TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'ok', 'degrading')),
            opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            closes_at        TIMESTAMPTZ NOT NULL,
            pre_issue_rate   DOUBLE PRECISION,
            post_issue_rate  DOUBLE PRECISION,
            delta_pct        DOUBLE PRECISION,
            follow_up_plan_id UUID REFERENCES improvement_plans(id) ON DELETE SET NULL,
            evaluated_at     TIMESTAMPTZ,
            evidence         JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (org_id, plan_id, window_hours)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX idx_post_merge_windows_due
        ON post_merge_windows (closes_at, status)
        WHERE status = 'pending'
        """
    )


def downgrade() -> None:
    # Restore the pre-170 (027) shape so the downgrade chain stays
    # resolvable — 097's downgrade issues DROP POLICY / NO FORCE /
    # DISABLE RLS against this table name.
    op.execute("DROP TABLE IF EXISTS post_merge_windows")
    op.execute(
        """
        CREATE TABLE post_merge_windows (
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
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_post_merge_windows_pr "
        "ON post_merge_windows (org_id, pr_id, window_hours)"
    )
