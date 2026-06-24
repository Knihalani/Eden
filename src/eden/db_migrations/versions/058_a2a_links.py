"""058_a2a_links — D.12.2 A2A protocol traces per upgradespec §B.5.

Revision ID: 058
Revises: 057
Create Date: 2026-06-24

Per spec §B.5 (D.12.2):

    CREATE TABLE a2a_links (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        parent_trace_id     UUID NOT NULL,
        child_trace_id      UUID NOT NULL,
        parent_agent_id     UUID NOT NULL,
        child_agent_id      UUID NOT NULL,
        parent_span_id      UUID NOT NULL,
        invocation_type     TEXT NOT NULL,
        response_status     TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(parent_trace_id, parent_span_id, child_trace_id)
    );

    ALTER TABLE telemetry_events
        ADD COLUMN parent_agent_span_id UUID,
        ADD COLUMN child_agent_trace_id  UUID;

Ponytail: VARCHAR(128) for the agent_id columns (matches the
spine's VARCHAR convention; agent_id is an opaque org-internal
string in our schema, not a true UUID). The ``parent_agent_id``
+ ``child_agent_id`` columns are kept as UUID per the spec
because they reference agent registry rows (which are UUID).
"""

from __future__ import annotations

from alembic import op

revision = "058"
down_revision = "057"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS a2a_links (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            parent_trace_id     UUID NOT NULL,
            child_trace_id      UUID NOT NULL,
            parent_agent_id     UUID NOT NULL,
            child_agent_id      UUID NOT NULL,
            parent_span_id      UUID NOT NULL,
            invocation_type     TEXT NOT NULL,
            response_status     TEXT,
            error_kind          TEXT,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(parent_trace_id, parent_span_id, child_trace_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_a2a_links_parent "
        "ON a2a_links(parent_trace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_a2a_links_child "
        "ON a2a_links(child_trace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_a2a_links_org "
        "ON a2a_links(org_id, created_at DESC)"
    )

    # 2 new columns on telemetry_events (per spec §B.5).
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS parent_agent_span_id UUID"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS child_agent_trace_id UUID"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_parent_agent_span "
        "ON telemetry_events(parent_agent_span_id) "
        "WHERE parent_agent_span_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_telemetry_parent_agent_span")
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS child_agent_trace_id"
    )
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS parent_agent_span_id"
    )
    op.execute("DROP INDEX IF EXISTS idx_a2a_links_org")
    op.execute("DROP INDEX IF EXISTS idx_a2a_links_child")
    op.execute("DROP INDEX IF EXISTS idx_a2a_links_parent")
    op.execute("DROP TABLE IF EXISTS a2a_links")