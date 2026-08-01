"""129 — Ensure dataset_columns exists for spreadsheet metadata.

Revision ID: 129_dataset_columns
Revises: 128_onboarding_state_v2_columns
Create Date: 2026-07-31

``migrations/037_dataset_columns.sql`` defined this table outside the
Alembic chain. DatasetHub list/get used to subquery ``dataset_columns``,
which 503'd portals when the table was missing. List/get no longer
depend on it, but spreadsheet routes still need the table — create it
idempotently here.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "129_dataset_columns"
down_revision: str | Sequence[str] | None = "128_onboarding_state_v2_columns"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_columns (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            dataset_id      UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            name            TEXT NOT NULL,
            type            TEXT NOT NULL DEFAULT 'text'
                CHECK (type IN ('text', 'number', 'json')),
            source          TEXT NOT NULL DEFAULT 'user'
                CHECK (source IN ('user', 'ai')),
            description     TEXT NOT NULL DEFAULT '',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_dataset_columns_dataset
            ON dataset_columns (dataset_id, created_at ASC)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_dataset_columns_dataset")
    op.execute("DROP TABLE IF EXISTS dataset_columns")
