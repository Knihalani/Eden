"""176 — Linear / Jira project pick on the help contract.

Revision ID: 176_help_assignment_pick
Revises: 175_help_setup_channels
Create Date: 2026-08-14

Same leftover path. No Linear app. No Jira app. They pick a project
or team id; the existing extra_work webhook attaches by that id.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "176_help_assignment_pick"
down_revision: str | Sequence[str] | None = "175_help_setup_channels"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE help_contracts "
        "ADD COLUMN IF NOT EXISTS linear_project_id TEXT"
    )
    op.execute(
        "ALTER TABLE help_contracts "
        "ADD COLUMN IF NOT EXISTS jira_project_key TEXT"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE help_contracts DROP COLUMN IF EXISTS jira_project_key")
    op.execute("ALTER TABLE help_contracts DROP COLUMN IF EXISTS linear_project_id")
