"""118 — improvement_plans: allow 'closed' status (Phase 2b PR-close sync).

Revision ID: 118_improvement_plans_closed_status
Revises: 117_portal_schema_drift
Create Date: 2026-07-23

The N23 improvement-plan inbox only reached ``pr_opened`` once a human
approved and Eden opened the PR — nothing updated the plan when the PR
was later merged or closed on GitHub, so the portal showed a stale
"PR opened" status forever. The GitHub webhook now calls
``plans_repo.mark_merged`` / ``mark_closed`` on ``pull_request`` closed
events; ``merged`` was already an allowed status, but ``closed`` (PR
closed without merging) was missing from the CHECK constraint.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "118_improvement_plans_closed_status"
down_revision: str | Sequence[str] | None = "117_portal_schema_drift"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE improvement_plans
            DROP CONSTRAINT IF EXISTS improvement_plans_status_check
        """
    )
    op.execute(
        """
        ALTER TABLE improvement_plans
            ADD CONSTRAINT improvement_plans_status_check
            CHECK (status IN (
                'draft', 'pending_review', 'approved', 'pr_opened',
                'merged', 'closed', 'rejected', 'snoozed', 'superseded'
            ))
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE improvement_plans SET status = 'rejected' WHERE status = 'closed'
        """
    )
    op.execute(
        """
        ALTER TABLE improvement_plans
            DROP CONSTRAINT IF EXISTS improvement_plans_status_check
        """
    )
    op.execute(
        """
        ALTER TABLE improvement_plans
            ADD CONSTRAINT improvement_plans_status_check
            CHECK (status IN (
                'draft', 'pending_review', 'approved', 'pr_opened',
                'merged', 'rejected', 'snoozed', 'superseded'
            ))
        """
    )
