"""132 — Post-PR guardian: parent_plan_id on improvement_plans.

Revision ID: 132_plan_parent
Revises: 131_slack_integration
Create Date: 2026-08-01

Soft Autonomy Phase 9: when a merged fix PR regresses (post-merge
verify fails), the guardian drafts a follow-up plan — a revert or a
secondary fix — linked to the original via ``parent_plan_id`` so the
portal can render the chain (plan → regression → follow-up) and the
dedup index can treat follow-ups as distinct from fresh drafts.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "132_plan_parent"
down_revision: str | Sequence[str] | None = "131_slack_integration"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE improvement_plans "
        "ADD COLUMN IF NOT EXISTS parent_plan_id UUID "
        "REFERENCES improvement_plans(id) ON DELETE SET NULL"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS improvement_plans_parent_idx "
        "ON improvement_plans (parent_plan_id) WHERE parent_plan_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS improvement_plans_parent_idx")
    op.execute("ALTER TABLE improvement_plans DROP COLUMN IF EXISTS parent_plan_id")
