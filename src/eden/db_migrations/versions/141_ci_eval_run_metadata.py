"""141 — metadata JSONB on regression_eval_runs for CI context.

Revision ID: 141_ci_eval_run_metadata
Revises: 140_portal_compare_seeds
Create Date: 2026-08-04

The /ci-eval productization (F56) needs each regression run to carry
its CI context (``ref`` / ``commit_sha`` / ``pr_number``) plus the
skipped/errors counts and per-case outcomes that the base table
(migration 101) never stored. A single ``metadata`` JSONB column
absorbs all of it — no per-field columns, additive only.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "141_ci_eval_run_metadata"
down_revision: str | Sequence[str] | None = "140_portal_compare_seeds"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE regression_eval_runs "
        "ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE regression_eval_runs DROP COLUMN IF EXISTS metadata"
    )
