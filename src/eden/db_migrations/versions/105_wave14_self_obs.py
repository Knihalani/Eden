"""105 — F84 eden_synthetic_runs for dogfood probes."""

from __future__ import annotations

from alembic import op

revision = "105_wave14_self_obs"
down_revision = "104_wave8_signals"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS eden_synthetic_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL,
          probe TEXT NOT NULL,
          status TEXT NOT NULL,
          detail JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_eden_synthetic_runs_org
          ON eden_synthetic_runs (org_id, created_at DESC);
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS eden_synthetic_runs")
