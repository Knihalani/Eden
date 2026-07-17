"""112 — Wave 28: F34 classifier predictions + investigator_disabled.

Revision ID: 112_w28_f64_f34_mcp
Revises: 111_w27_live_labels
Create Date: 2026-07-17

Additive only. Forward-compat: yes.
"""

from __future__ import annotations

from alembic import op

revision: str = "112_w28_f64_f34_mcp"
down_revision: str = "111_w27_live_labels"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE signal_classifiers
        ADD COLUMN IF NOT EXISTS investigator_disabled BOOLEAN DEFAULT FALSE
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS classifier_predictions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id TEXT NOT NULL,
            trace_id TEXT NOT NULL,
            classifier_id UUID NOT NULL,
            signal_id TEXT,
            score DOUBLE PRECISION NOT NULL,
            fired BOOLEAN NOT NULL,
            shadow_investigator_agree BOOLEAN,
            investigator_skipped BOOLEAN NOT NULL DEFAULT FALSE,
            estimated_savings_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_classifier_predictions_org_created
        ON classifier_predictions (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_classifier_predictions_org_signal
        ON classifier_predictions (org_id, signal_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS classifier_predictions")
    op.execute(
        """
        ALTER TABLE signal_classifiers
        DROP COLUMN IF EXISTS investigator_disabled
        """
    )
