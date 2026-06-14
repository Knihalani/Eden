"""029_replay_sessions — persist replay sessions for the portal.

Revision ID: 029
Revises: 028
Create Date: 2026-06-14

Phase A.6 adds the ``replay_sessions`` table backing the
``POST /orgs/{org_id}/intelligence/replay/sessions`` endpoint. The
portal's /replay page calls this to start a new session; before this
table existed the route had no place to write and silently failed.

Schema notes:
  * ``id`` is a string PK with the deterministic ``replay_<uuid>``
    pattern (so the same content yields the same id on retry).
  * ``(org_id, trace_id, name)`` is unique so repeated calls with the
    same args are idempotent (find-or-create semantics in the route).
  * ``name`` is nullable — NULL means "scratch session", which is
    always inserted as a new row.
  * ``created_at`` is the wall-clock the session started; the portal
    uses this to sort the session list.
"""

from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision = "029"
down_revision = "028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS replay_sessions (
            id          VARCHAR(64) PRIMARY KEY,
            org_id      VARCHAR(128) NOT NULL,
            trace_id    VARCHAR(128) NOT NULL,
            name        VARCHAR(128),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_replay_sessions_org
        ON replay_sessions (org_id, created_at DESC)
    """)
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_replay_sessions_name
        ON replay_sessions (org_id, trace_id, name)
        WHERE name IS NOT NULL
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_replay_sessions_name")
    op.execute("DROP INDEX IF EXISTS idx_replay_sessions_org")
    op.execute("DROP TABLE IF EXISTS replay_sessions")
