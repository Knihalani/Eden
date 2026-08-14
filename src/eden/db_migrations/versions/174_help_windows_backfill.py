"""174 — restore Slack listen-vs-page columns + one-time backfill stamp.

Revision ID: 174_help_windows_backfill
Revises: 173_help_extra_work
Create Date: 2026-08-14

173 dropped granted_scopes / history_consented_at. Live org_slack_installs
has no equivalent, and needs_reconsent / listen-vs-page is broken without
them, so restore here (not a second pair). history_backfilled_at stamps
the one-time invite backfill so Events API is the only reader after.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "174_help_windows_backfill"
down_revision: str | Sequence[str] | None = "173_help_extra_work"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE org_slack_installs "
        "ADD COLUMN IF NOT EXISTS granted_scopes TEXT NOT NULL DEFAULT ''"
    )
    op.execute(
        "ALTER TABLE org_slack_installs "
        "ADD COLUMN IF NOT EXISTS history_consented_at TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE agent_slack_channels "
        "ADD COLUMN IF NOT EXISTS history_backfilled_at TIMESTAMPTZ"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE agent_slack_channels "
        "DROP COLUMN IF EXISTS history_backfilled_at"
    )
    op.execute(
        "ALTER TABLE org_slack_installs "
        "DROP COLUMN IF EXISTS history_consented_at"
    )
    op.execute(
        "ALTER TABLE org_slack_installs DROP COLUMN IF EXISTS granted_scopes"
    )
