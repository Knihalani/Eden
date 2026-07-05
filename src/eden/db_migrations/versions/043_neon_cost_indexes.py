"""043 — Neon-cost index add (June 2026 cost audit).

Revision ID: 043
Revises: 042
Create Date: 2026-06-20

Three indexes that close the two real-world seqscans the cost audit
found, with zero quality impact (every query path that triggers them
was already correct — it was just expensive).

Index 1 — ``telemetry_events (tenant_id, created_at DESC)``
-----------------------------------------------------------
The SSE live-tail polls every ``POLL_INTERVAL_S``:

    SELECT MAX(created_at)::text FROM telemetry_events
     WHERE tenant_id = $1
    SELECT ... FROM telemetry_events
     WHERE tenant_id = $1 AND created_at > $2
     ORDER BY created_at ASC LIMIT $3

``created_at`` is the row-insert time (default ``NOW()``) and is
distinct from the event ``timestamp`` column. Migration 009 only
indexed ``(tenant_id, timestamp DESC)`` + ``(trace_id, timestamp ASC)``
+ a BRIN on ``timestamp``. BRIN alone does not narrow a tenant filter,
so every live-tail poll did a full sequential scan of
``telemetry_events``.

The new composite is online (``CREATE INDEX CONCURRENTLY`` is not
needed for non-blocking — Postgres takes an ``ACCESS SHARE`` lock
during ``CREATE INDEX IF NOT EXISTS``, which is fine on the hot
telemetry table because writers use ``INSERT`` only and never block
on ``ACCESS SHARE``). For very large tables in prod, an operator
can manually ``CREATE INDEX CONCURRENTLY`` instead.

Index 2 + 3 — ``notifications (user_id, created_at DESC)``
        + ``notifications (user_id) WHERE read_at IS NULL``
-----------------------------------------------------------
The notifications route lists / counts / unreads per user:

    SELECT ... FROM notifications WHERE user_id = $1 ORDER BY created_at DESC
    SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL

Migration 001 created ``notifications`` with no secondary indexes —
every list did a full seqscan. The composite covers the list +
the count. The partial index keeps the unread badge query O(unread)
instead of O(total).

Why we don't extend ``idx_jobs_fts``
------------------------------------
``idx_jobs_fts`` (GIN on ``to_tsvector('english', request::text)``)
is large and write-expensive, but every Eden release uses it for
the portal's job search. Keeping it; the cost is justified by the
feature.
"""
import sqlalchemy as sa
from alembic import op

revision = "043"
down_revision = "042"
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    conn = op.get_bind()
    row = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = :t"
        ),
        {"t": table_name},
    ).first()
    return row is not None


def upgrade() -> None:
    # telemetry_events: live-tail seqscan → tenant-scoped created_at
    if _table_exists("telemetry_events"):
        op.execute(
            "CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_created_at "
            "ON telemetry_events (tenant_id, created_at DESC);"
        )

    # notifications: every list / unread count seqscanned
    if _table_exists("notifications"):
        op.execute(
            "CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at "
            "ON notifications (user_id, created_at DESC);"
        )
        op.execute(
            "CREATE INDEX IF NOT EXISTS idx_notifications_user_unread "
            "ON notifications (user_id) WHERE read_at IS NULL;"
        )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_notifications_user_unread")
    op.execute("DROP INDEX IF EXISTS idx_notifications_user_created_at")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_tenant_created_at")
