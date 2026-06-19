"""040 — ``trace_archive_index`` for cold (Impossible Cloud) archive (Phase B3).

Revision ID: 040
Revises: 039
Create Date: 2026-06-19

Phase B3 of the Eden app/storage plan (2026-06-19). Once the
Postgres ``telemetry_events`` row count grows past 90 days, the
ArchiveService moves it to Impossible Cloud (single always-hot
tier, zero egress). This table is the index that makes trace_id
lookups O(1) instead of a full-table scan:

* ``trace_id`` PK — the trace we archived
* ``org_id`` — for tenant-scoped queries
* ``archive_path`` — the ``s3://{bucket}/cold/telemetry_events/...`` key
* ``archived_at`` — when the row moved to Impossible Cloud
* ``row_count`` — number of rows archived for this trace (a trace
  spans multiple ``telemetry_events`` rows; one index row per trace)

Reads transparently fall back to the archive when the trace isn't
in Postgres. See ``src/eden/services/data_platform/archive.py`` for
the writer and ``src/eden/observability/telemetry_collector.py`` for
the reader fallback.

Why not store payload in the index
----------------------------------
A trace typically holds 1-100 ``telemetry_events`` rows (one per
span). The payload is in Impossible Cloud; the index is small
enough that Postgres can keep it hot in RAM for the lifetime of the
tenant. Storage cost is ~80 bytes per trace × 1M traces ≈ 80 MB.

Indexes
-------
* PK on ``trace_id`` (the primary lookup path).
* ``(org_id, archived_at DESC)`` for tenant-scoped "what did we
  archive last week" admin queries.
* BRIN on ``archived_at`` for time-range scans.
"""
from alembic import op

revision = "040"
down_revision = "039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS trace_archive_index (
            trace_id      VARCHAR(128) PRIMARY KEY,
            org_id        VARCHAR(128) NOT NULL,
            archive_path  VARCHAR(512) NOT NULL,
            row_count     INTEGER NOT NULL DEFAULT 0,
            archived_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_archive_org_archived "
        "ON trace_archive_index (org_id, archived_at DESC);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_archive_archived_brin "
        "ON trace_archive_index USING BRIN (archived_at);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_trace_archive_archived_brin;")
    op.execute("DROP INDEX IF EXISTS idx_trace_archive_org_archived;")
    op.execute("DROP TABLE IF EXISTS trace_archive_index;")
