"""085 — issue_state_transitions (F46 closed-loop audit trail).

Revision ID: 085
Revises: 084
Create Date: 2026-07-10

Every issue status change made by the closed-loop orchestrator is
appended here, so the full lifecycle (open → triaged → fix_pending →
verifying → resolved/regressed) is auditable and the portal can render a
timeline. Indexed for the per-issue reverse-chronological read.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "085"
down_revision: str | Sequence[str] | None = "084"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS issue_state_transitions (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id       VARCHAR(128) NOT NULL,
            issue_id     UUID NOT NULL,
            from_status  VARCHAR(16),
            to_status    VARCHAR(16) NOT NULL,
            event_type   VARCHAR(48) NOT NULL,
            reason       TEXT,
            actor        VARCHAR(64) NOT NULL DEFAULT 'orchestrator',
            detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_state_transitions_issue "
        "ON issue_state_transitions (issue_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_state_transitions_org "
        "ON issue_state_transitions (org_id, created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS issue_state_transitions CASCADE")
