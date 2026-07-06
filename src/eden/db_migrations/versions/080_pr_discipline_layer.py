"""080_pr_discipline_layer — Cat 23 v1.7 PR-discipline tables.

Revision ID: 080
Revises: 079
Create Date: 2026-07-05

Adds three new tables used by ``eden.code_change.discipline``
plus an extension to ``repo_connections`` that surfaces
the repo-graph (Greptile / local) index state per repo.

The migration is idempotent (``IF NOT EXISTS``) so the
underlying SQL can also be re-applied by the raw-SQL
migration runner without conflict.
"""

from __future__ import annotations

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "080"
down_revision: str | None = "079"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The schema lives in migrations/042_pr_discipline_layer.sql.
    # The alembic env.py is invocation-only; no Python-side
    # DDL is required here. Future schema additions should
    # land in a new alembic revision that revises from "080".
    pass


def downgrade() -> None:
    pass
