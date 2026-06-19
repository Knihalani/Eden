"""041 — ``trace_messages`` content-addressed dedup table (Phase B4).

Revision ID: 041
Revises: 040
Create Date: 2026-06-19

Phase B4 of the Eden app/storage plan (2026-06-19). Closes the
storage-loop on the dedup work that has been wired into the
collector since migration 030 (BRIN) — :mod:`eden.observability.message_store`
and the ``request_message_hashes`` / ``response_message_hashes``
hash-array columns on ``telemetry_events`` (added Phase 7.2,
migration 011) all reference this table, but the table itself was
never migrated into the alembic chain (it exists in the legacy
``/migrations/030_trace_messages.sql`` raw file but no
``030_trace_messages.py`` was ever written in ``versions/``).

This migration is ``CREATE TABLE IF NOT EXISTS`` so it's safe to
run on databases that already have the table from the raw SQL.
New clusters pick it up on first ``alembic upgrade head``.

The dedup math
--------------
For a k-turn agent trace, span i stores messages [m0..m{i-1}].
Without dedup the message-storage cost across a trace is
k(k+1)/2 = O(k²). With trace-scoped content-addressed dedup the
cost is k unique rows (one per unique message) — Laminar's
"20x compresses agent traces" headline.

Schema mirrors the legacy file verbatim (PK on
``(trace_id, msg_hash)``, JSONB content with GIN index for future
full-text search).
"""
from alembic import op

revision = "041"
down_revision = "040"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS trace_messages (
            trace_id        TEXT NOT NULL,
            msg_hash        TEXT NOT NULL,
            role            TEXT NOT NULL
                CHECK (role IN ('system', 'user', 'assistant', 'tool', 'function')),
            content         JSONB NOT NULL,
            first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (trace_id, msg_hash)
        );
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_messages_trace_id "
        "ON trace_messages(trace_id);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_messages_content_gin "
        "ON trace_messages USING GIN (content);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_trace_messages_content_gin;")
    op.execute("DROP INDEX IF EXISTS idx_trace_messages_trace_id;")
    op.execute("DROP TABLE IF EXISTS trace_messages;")
