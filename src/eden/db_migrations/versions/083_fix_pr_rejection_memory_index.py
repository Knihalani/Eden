"""083 — fix pr_rejection_memory active index (NOW() predicate).

Revision ID: 083
Revises: 082
Create Date: 2026-07-10

Migration 050 used ``WHERE expires_at > NOW()`` in a partial index.
Postgres rejects that because ``NOW()`` is STABLE, not IMMUTABLE —
``alembic upgrade head`` failed in CI and on fresh databases.

Drop the invalid index (if any) and recreate as a composite btree
on ``(org_id, file_path, title_hash, expires_at)``. Queries still
filter ``expires_at > NOW()`` at runtime; the index supports the
lookup without a volatile predicate.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "083"
down_revision: str | Sequence[str] | None = "082"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _table_exists(table_name: str) -> bool:
    conn = op.get_bind()
    row = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = :t"
        ),
        {"t": table_name},
    ).first()
    return row is not None


def upgrade() -> None:
    # Neon staging was stamped at 082 without migration 050's table —
    # skip the index fix when the table is absent so 084–088 can run.
    if not _table_exists("pr_rejection_memory"):
        return
    op.execute("DROP INDEX IF EXISTS idx_pr_rejection_memory_active")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_active "
        "ON pr_rejection_memory (org_id, file_path, title_hash, expires_at)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_pr_rejection_memory_active")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_rejection_memory_active "
        "ON pr_rejection_memory (org_id, file_path, title_hash) "
        "WHERE expires_at > NOW()"
    )
