"""090 — Plain-English signals table (``nl_signals``).

Revision ID: 090
Revises: 089
Create Date: 2026-07-12

Phase Q / F35: persist NL signal definitions. The standalone SQL
``migrations/036_nl_signals.sql`` used ``created_by UUID``, but Neon
applied ``migrations/040_users_text_id.sql`` so ``users.id`` is
``text`` (Clerk). CI / fresh Alembic DBs still have ``users.id`` as
``uuid`` from ``001_initial_schema``. Match ``created_by`` to the
live ``users.id`` type so the FK works in both environments.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "090"
down_revision: str | Sequence[str] | None = "089"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _users_id_sql_type() -> str:
    """Return SQL type for ``users.id`` (``UUID`` or ``TEXT``)."""
    row = op.get_bind().execute(
        text(
            """
            SELECT data_type
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'users'
              AND column_name = 'id'
            """
        )
    ).fetchone()
    if row is None:
        return "UUID"
    data_type = (row[0] or "").lower()
    if data_type in ("text", "character varying", "varchar"):
        return "TEXT"
    return "UUID"


def upgrade() -> None:
    created_by_type = _users_id_sql_type()
    op.execute(
        f"""
        CREATE TABLE IF NOT EXISTS nl_signals (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            description     TEXT NOT NULL,
            rule            JSONB NOT NULL DEFAULT '{{}}'::jsonb,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            created_by      {created_by_type} REFERENCES users(id) ON DELETE SET NULL,
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
