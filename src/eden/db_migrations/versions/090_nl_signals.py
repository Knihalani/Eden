"""090 — Plain-English signals table (``nl_signals``).

Revision ID: 090
Revises: 089
Create Date: 2026-07-12

Phase Q / F35: persist NL signal definitions. The standalone SQL
``migrations/036_nl_signals.sql`` used ``created_by UUID`` but Neon
``users.id`` is ``text`` (Clerk), so that FK could not be created.
This Alembic revision matches live column types and is idempotent.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "090"
down_revision: str | Sequence[str] | None = "089"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS nl_signals (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            description     TEXT NOT NULL,
            rule            JSONB NOT NULL DEFAULT '{}'::jsonb,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
            cluster_id      TEXT,
            last_matched_at TIMESTAMPTZ,
            match_count     INT NOT NULL DEFAULT 0,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nl_signals_org_created
        ON nl_signals (org_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_nl_signals_cluster
        ON nl_signals (org_id, cluster_id, created_at DESC)
        WHERE cluster_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION nl_signals_touch_updated() RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_nl_signals_touch_updated ON nl_signals")
    op.execute(
        """
        CREATE TRIGGER trg_nl_signals_touch_updated
            BEFORE UPDATE ON nl_signals
            FOR EACH ROW EXECUTE FUNCTION nl_signals_touch_updated()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_nl_signals_touch_updated ON nl_signals")
    op.execute("DROP FUNCTION IF EXISTS nl_signals_touch_updated")
    op.execute("DROP TABLE IF EXISTS nl_signals")
