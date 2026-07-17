"""110 — Wave 26: drop F22 issue_fix_sessions (DELETE F22).

Revision ID: 110_w26_drop_issue_fix_sessions
Revises: 109_w18_playgrounds
Create Date: 2026-07-17

Additive-only drop. Forward-compat: yes.
"""

from __future__ import annotations

from alembic import op

revision: str = "110_w26_drop_issue_fix_sessions"
down_revision: str = "109_w18_playgrounds"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_issue_fix_sessions_issue")
    op.execute("DROP TABLE IF EXISTS issue_fix_sessions")


def downgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS issue_fix_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id TEXT NOT NULL,
            issue_id TEXT NOT NULL,
            repo_full_name TEXT NOT NULL,
            branch_name TEXT,
            pr_url TEXT,
            status TEXT NOT NULL DEFAULT 'chatting',
            messages JSONB NOT NULL DEFAULT '[]'::jsonb,
            proposed_patch JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_fix_sessions_issue "
        "ON issue_fix_sessions (org_id, issue_id, created_at DESC)"
    )
