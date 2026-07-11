"""088 — org_members.last_writer_source (port migrations/039).

Revision ID: 088
Revises: 087
Create Date: 2026-07-11
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "088"
down_revision: str | Sequence[str] | None = "087"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE org_members
        ADD COLUMN IF NOT EXISTS last_writer_source TEXT NOT NULL DEFAULT 'clerk'
            CHECK (last_writer_source IN ('clerk', 'local'))
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE org_members DROP COLUMN IF EXISTS last_writer_source")
