"""087 — issue_verifications (F46 verify loop, Wave 6).

Revision ID: 087
Revises: 086
Create Date: 2026-07-10

Postgres-backed scheduled-verify rows. After the orchestrator applies a
remediation it inserts a ``pending`` row with ``scheduled_at = NOW() +
verify_delay``; a lightweight worker polls due rows, checks that the fix
held (stumble-rate for the fingerprint → 0 over the quiet window, and the
StatGate P0 cleared), then marks the row ``passed``/``failed`` and emits
the corresponding loop event. No new delayed-queue infrastructure — the
``(status, scheduled_at)`` index makes the due-poll a cheap range scan.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "087"
down_revision: str | Sequence[str] | None = "086"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS issue_verifications (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id        VARCHAR(128) NOT NULL,
            issue_id      UUID NOT NULL,
            fingerprint   VARCHAR(64) NOT NULL,
            ref           VARCHAR(128),
            scheduled_at  TIMESTAMPTZ NOT NULL,
            status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                          CHECK (status IN
                              ('pending','passed','failed','cancelled')),
            attempts      INTEGER NOT NULL DEFAULT 0,
            detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at  TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_verifications_due "
        "ON issue_verifications (status, scheduled_at)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_issue_verifications_issue "
        "ON issue_verifications (org_id, issue_id)"
    )
    # At most one live (pending) verify per issue — re-scheduling replaces.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_issue_verifications_pending "
        "ON issue_verifications (org_id, issue_id) "
        "WHERE status = 'pending'"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS issue_verifications CASCADE")
