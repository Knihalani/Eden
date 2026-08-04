"""139 — debug_sessions.last_replay (debugger notes + last replay persistence).

Revision ID: 139_debug_sessions_last_replay
Revises: 138_improvement_item_snoozes
Create Date: 2026-08-03

Stores the last hermetic re-run outcome on a debug session so the portal
can show ``lastReplay`` after reload instead of only in-memory patches.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "139_debug_sessions_last_replay"
down_revision: str | Sequence[str] | None = "138_improvement_item_snoozes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE debug_sessions
        ADD COLUMN IF NOT EXISTS last_replay JSONB
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE debug_sessions DROP COLUMN IF EXISTS last_replay"
    )
