"""157 — agent_artifact_context table (FEAT-128).

Revision ID: 157_agent_artifact_context
Revises: 156_agent_link_columns_index
Create Date: 2026-08-06

Foundational schema for team-uploaded per-agent context (FEAT-148).
Mirrors the org_id UUID FK pattern from ``100_artifacts_ledger``.
"""

from __future__ import annotations

from alembic import op

revision = "157_agent_artifact_context"
down_revision = "156_agent_link_columns_index"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_artifact_context (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            agent_id     TEXT NOT NULL,
            filename     VARCHAR(256),
            content_type VARCHAR(32) NOT NULL DEFAULT 'text/markdown',
            content      TEXT NOT NULL,
            created_by   VARCHAR(128) NOT NULL,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_agent_artifact_context_agent
        ON agent_artifact_context (org_id, agent_id, created_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_agent_artifact_context_agent")
    op.execute("DROP TABLE IF EXISTS agent_artifact_context")
