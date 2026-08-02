"""131 — Slack App integration tables.

Revision ID: 131_slack_integration
Revises: 130_portal_rpm_floor
Create Date: 2026-08-01

Soft Autonomy Phase 5: Slack bot for issue / PR / needs-approval
alerts with per-agent channel routing.

* ``org_slack_installs`` — one row per (org, Slack workspace) OAuth
  install. Bot token is Fernet-encrypted at rest (``bot_token_enc``),
  same pattern as export-destination credentials.
* ``agent_slack_channels`` — one row per (org, agent) channel binding.
  ``agent_id IS NULL`` is the org-wide default channel, mirroring the
  NULL-agent org-default pattern used by ``autonomy_policies``. The
  unique index coalesces NULL → '' because Postgres treats NULLs as
  distinct in plain unique constraints.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "131_slack_integration"
down_revision: str | Sequence[str] | None = "130_portal_rpm_floor"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_slack_installs (
            id UUID PRIMARY KEY,
            org_id TEXT NOT NULL,
            team_id TEXT NOT NULL,
            team_name TEXT NOT NULL DEFAULT '',
            bot_token_enc TEXT NOT NULL,
            bot_user_id TEXT NOT NULL DEFAULT '',
            installed_by_user_id TEXT,
            installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT org_slack_installs_org_team_uq UNIQUE (org_id, team_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS org_slack_installs_org_idx "
        "ON org_slack_installs (org_id) WHERE revoked_at IS NULL"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_slack_channels (
            id UUID PRIMARY KEY,
            org_id TEXT NOT NULL,
            agent_id TEXT,
            channel_id TEXT NOT NULL,
            channel_name TEXT NOT NULL DEFAULT '',
            set_by_user_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    # NULL agent_id = org default. COALESCE makes the upsert target
    # deterministic (Postgres NULLs never conflict in a plain UNIQUE).
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS agent_slack_channels_org_agent_uq "
        "ON agent_slack_channels (org_id, COALESCE(agent_id, ''))"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agent_slack_channels")
    op.execute("DROP TABLE IF EXISTS org_slack_installs")
