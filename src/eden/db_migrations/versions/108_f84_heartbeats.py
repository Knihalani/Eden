"""108 — F84 component heartbeats (SOTA Wave 9).

Revision ID: 108_f84_heartbeats
Revises: 107_customer_cost_events
Create Date: 2026-07-17

Additive-only. Forward-compat: yes.
"""

from __future__ import annotations

from alembic import op

revision: str = "108_f84_heartbeats"
down_revision: str = "107_customer_cost_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS eden_component_heartbeats (
            id          BIGSERIAL PRIMARY KEY,
            component   TEXT NOT NULL,
            org_id      TEXT,
            status      TEXT NOT NULL DEFAULT 'healthy',
            meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
            checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_eden_component_heartbeats_comp_checked
            ON eden_component_heartbeats (component, checked_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_eden_component_heartbeats_org_checked
            ON eden_component_heartbeats (org_id, checked_at DESC)
            WHERE org_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS eden_component_heartbeats")
