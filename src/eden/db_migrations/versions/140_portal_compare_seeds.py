"""140 — portal_compare_seeds for Compare deep-link seeding.

Revision ID: 140_portal_compare_seeds
Revises: 139_debug_sessions_last_replay
Create Date: 2026-08-03

Evals / Debugger deep-links into Compare need durable A/B seed rows
(``source_eval_*`` / ``source_debugger_session_id``). Live llmops
experiments never store those fields, so the portal list alone cannot
satisfy ``seedFromEvalsPair`` / ``seedFromDebuggerSession``.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "140_portal_compare_seeds"
down_revision: str | Sequence[str] | None = "139_debug_sessions_last_replay"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
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


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS portal_compare_seeds")
