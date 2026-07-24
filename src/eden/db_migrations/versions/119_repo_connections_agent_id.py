"""119 — repo_connections: one linked repo per agent.

Revision ID: 119_repo_connections_agent_id
Revises: 118_improvement_plans_closed_status
Create Date: 2026-07-24

Repo linking is per agent (not per org): one user/org can have many
linked repos, but each agent has at most one active link. Adds
``agent_id`` and a partial unique index on ``(org_id, agent_id)``
for active rows.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "119_repo_connections_agent_id"
down_revision: str | Sequence[str] | None = "118_improvement_plans_closed_status"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE repo_connections
            ADD COLUMN IF NOT EXISTS agent_id VARCHAR
        """
    )
    # At most one active connection per agent within an org.
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS
            idx_repo_connections_org_agent_active
        ON repo_connections (org_id, agent_id)
        WHERE status = 'active' AND agent_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_repo_connections_agent_id
        ON repo_connections (org_id, agent_id)
        WHERE agent_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_repo_connections_agent_id")
    op.execute("DROP INDEX IF EXISTS idx_repo_connections_org_agent_active")
    op.execute(
        """
        ALTER TABLE repo_connections
            DROP COLUMN IF EXISTS agent_id
        """
    )
