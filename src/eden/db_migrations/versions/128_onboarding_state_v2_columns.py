"""128 — D.14 onboarding-v2 columns on live onboarding_state.

Revision ID: 128_onboarding_state_v2_columns
Revises: 127_sidebar_prefs_user_id_type
Create Date: 2026-07-31

Alembic 056 used ``CREATE TABLE IF NOT EXISTS`` against a table that
``migrations/029_onboarding_wizard.sql`` had already created with a
different shape (``step``, ``org_setup_choice``, …). The IF NOT EXISTS
no-op'd, so for a while production lacked ``current_step``,
``completed_steps``, ``cat_enablements``, ``first_trace_at``,
``milestones_reached``, and ``created_at`` while the state machine
wrote them and ``_persist`` swallowed the failure.

This revision adds those columns idempotently (ADD COLUMN IF NOT
EXISTS) so wizard columns and v2 columns coexist on one table, and
creates the milestones GIN index 056 intended. Safe to re-run on
environments that already received the columns out-of-band.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "128_onboarding_state_v2_columns"
down_revision: str | Sequence[str] | None = "127_sidebar_prefs_user_id_type"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE onboarding_state
            ADD COLUMN IF NOT EXISTS current_step VARCHAR(32)
                NOT NULL DEFAULT 'install',
            ADD COLUMN IF NOT EXISTS completed_steps TEXT[]
                NOT NULL DEFAULT ARRAY[]::TEXT[],
            ADD COLUMN IF NOT EXISTS cat_enablements JSONB
                NOT NULL DEFAULT '{}'::jsonb,
            ADD COLUMN IF NOT EXISTS first_trace_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS milestones_reached TEXT[]
                NOT NULL DEFAULT ARRAY[]::TEXT[],
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
                NOT NULL DEFAULT NOW()
        """
    )
    # 056's GIN index — IF NOT EXISTS so already-patched DBs are fine.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_onboarding_milestones
            ON onboarding_state USING GIN (milestones_reached)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_onboarding_milestones")
    # Do not DROP the columns: wizard rows and any v2 writes would lose
    # data, and the coexisting wizard columns must stay. Downgrade is
    # index-only.
