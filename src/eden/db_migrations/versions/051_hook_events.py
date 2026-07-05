"""051 — hook_events per upgradespec.md §E.5.

Revision ID: 051
Revises: 050
Create Date: 2026-06-23

The new ``hook_events`` table is the canonical audit log for the
closed-loop hook bus (Cat 17). Each row represents one firing of a
hook reason — with parent_hook_id, repetition_count, dedup_window,
fan-out actions, and approval-gate proposal ids, all per spec §E.5.

Until this migration runs in production, :class:`HookBus` writes
backwards-compatible rows to the existing ``closed_loop_actions``
table (see ``src/eden/llmops/hooks_bus.py``). The new columns here
will be backfilled in a separate one-shot job after upgrade.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "051"
down_revision: str | Sequence[str] | None = "050"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create hook_events + indexes per upgradespec §E.5."""
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS hook_events (
            id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id                   UUID NOT NULL,
            reason                   TEXT NOT NULL,
            severity                 TEXT NOT NULL
                CHECK (severity IN ('low','medium','high','critical')),
            source                   JSONB NOT NULL DEFAULT '{}'::jsonb,
            context                  JSONB NOT NULL DEFAULT '{}'::jsonb,
            parent_hook_id           UUID REFERENCES hook_events(id) ON DELETE SET NULL,
            repetition_count         INTEGER NOT NULL DEFAULT 1,
            dedup_window_seconds     INTEGER NOT NULL DEFAULT 300,
            fan_out_actions          JSONB NOT NULL DEFAULT '[]'::jsonb,
            proposals                JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_hook_events_org_time "
        "ON hook_events (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_hook_events_reason "
        "ON hook_events (reason, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_hook_events_parent "
        "ON hook_events (parent_hook_id) WHERE parent_hook_id IS NOT NULL"
    )


def downgrade() -> None:
    """Drop hook_events + indexes."""
    op.execute("DROP INDEX IF EXISTS idx_hook_events_parent")
    op.execute("DROP INDEX IF EXISTS idx_hook_events_reason")
    op.execute("DROP INDEX IF EXISTS idx_hook_events_org_time")
    op.execute("DROP TABLE IF EXISTS hook_events")
