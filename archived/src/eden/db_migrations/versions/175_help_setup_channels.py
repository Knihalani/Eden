"""175 — watch + notify Slack channels for agent setup.

Revision ID: 175_help_setup_channels
Revises: 174_help_windows_backfill
Create Date: 2026-08-14

Point 12: an agent can watch several channels and post leftover / change
cards in one notify channel (``get_channel``). Existing 1:1 unique on
(org, agent) cannot hold both. ``is_notify`` marks the row Slack 1/2/3
reads; watch rows stay mapped for leftover.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "175_help_setup_channels"
down_revision: str | Sequence[str] | None = "174_help_windows_backfill"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE agent_slack_channels "
        "ADD COLUMN IF NOT EXISTS is_notify BOOLEAN NOT NULL DEFAULT false"
    )
    op.execute(
        "UPDATE agent_slack_channels SET is_notify = true "
        "WHERE is_notify = false"
    )
    op.execute("DROP INDEX IF EXISTS agent_slack_channels_org_agent_uq")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS agent_slack_channels_org_agent_channel_uq "
        "ON agent_slack_channels (org_id, COALESCE(agent_id, ''), channel_id)"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS agent_slack_channels_org_agent_notify_uq "
        "ON agent_slack_channels (org_id, COALESCE(agent_id, '')) "
        "WHERE is_notify"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS agent_slack_channels_org_agent_notify_uq")
    op.execute("DROP INDEX IF EXISTS agent_slack_channels_org_agent_channel_uq")
    op.execute(
        """
        DELETE FROM agent_slack_channels a
        USING agent_slack_channels b
        WHERE a.org_id = b.org_id
          AND COALESCE(a.agent_id, '') = COALESCE(b.agent_id, '')
          AND a.ctid < b.ctid
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS agent_slack_channels_org_agent_uq "
        "ON agent_slack_channels (org_id, COALESCE(agent_id, ''))"
    )
    op.execute("ALTER TABLE agent_slack_channels DROP COLUMN IF EXISTS is_notify")
