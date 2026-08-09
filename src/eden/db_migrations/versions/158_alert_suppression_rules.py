"""158 — org-scoped alert suppression rules (FEAT-134).

Revision ID: 158_alert_suppression_rules
Revises: 157_agent_artifact_context
Create Date: 2026-08-06

Customers need a config surface for "don't page for known-noisy events"
beyond the hardcoded ``_BENIGN_PATTERNS`` in ``AlertTriageJudge``. This
table stores org-scoped regex/substring patterns (plus optional reason
and mute window) that the triage judge loads and treats as benign.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "158_alert_suppression_rules"
down_revision: str | Sequence[str] | None = "157_agent_artifact_context"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS alert_suppression_rules (
            id UUID PRIMARY KEY,
            org_id TEXT NOT NULL,
            pattern TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            window_hours INT,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_by_user_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS alert_suppression_rules_org_idx "
        "ON alert_suppression_rules (org_id) WHERE enabled"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS alert_suppression_rules_org_idx")
    op.execute("DROP TABLE IF EXISTS alert_suppression_rules")
