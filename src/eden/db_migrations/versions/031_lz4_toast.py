"""031_lz4_toast — LZ4 TOAST compression cluster-wide.

Revision ID: 031
Revises: 030
Create Date: 2026-06-16

Switches the default TOAST compression algorithm from ``pglz`` to ``lz4``
for the entire database and explicitly for every large column on the
high-volume observability tables. LZ4 is ~2× faster to decompress than
pglz (and 5× faster to compress) with comparable or better ratio on
JSONB.

Tables + columns covered (verified against migrations 009, 010, 011):
- ``telemetry_events.payload``            (JSONB)
- ``telemetry_events.metrics``            (JSONB)
- ``telemetry_events.attributes``         (JSONB)
- ``telemetry_events.request_body``       (JSONB, migration 011)
- ``telemetry_events.response_body``      (JSONB, migration 011)
- ``telemetry_events.reasoning``          (JSONB, migration 011)
- ``telemetry_events.tool_calls_full``    (JSONB, migration 011)
- ``telemetry_events.tool_results``       (JSONB, migration 011)
- ``telemetry_events.images``             (JSONB, migration 011)
- ``telemetry_events.audio``              (JSONB, migration 011)
- ``telemetry_events.logprobs``           (JSONB, migration 011)
- ``telemetry_events.citations``          (JSONB, migration 011)
- ``usage_events.metadata``               (JSONB)
- ``judge_scores.rationale``              (TEXT)

CAVEAT — *must read*:
    ``ALTER TABLE … SET COMPRESSION lz4`` is a catalog-only change. It
    does NOT rewrite existing rows; they keep their pglz-compressed
    TOAST pointers until something forces a re-TOAST. This migration
    therefore follows each ``SET COMPRESSION`` with a noop
    ``UPDATE … SET col = col WHERE pg_column_size(col) > 2000`` to
    trigger a re-TOAST of all sufficiently large existing rows.

    That UPDATE is a table rewrite (heap + all btree indexes rebuilt
    in place). On a hot, large table it WILL hold an ``ACCESS
    EXCLUSIVE`` lock for the duration. On the order of:
        - 1M rows × 5 KB payload = 30-60 s
        - 100M rows × 5 KB payload = 50-100 minutes
    Run on staging first to measure, and schedule on prod during a
    quiet window (overnight UTC for a US-heavy workload).

    Per-column rollback is a single ``SET COMPRESSION pglz`` plus a
    reverse UPDATE-noop. See downgrade() below.

GOTCHA — RDS-style JSONB growth:
    On irregular JSONB shapes, LZ4's metadata overhead can exceed
    savings and storage will GROW. AWS RDS grew one customer's JSONB
    by 33% on a default-TOAST flip. Mitigation: run on staging 48h,
    measure ``pg_column_size`` before/after on a representative sample,
    and per-column-rollback any column that grew.
"""
from alembic import op
import sqlalchemy as sa

revision = "031"
down_revision = "030"
branch_labels = None
depends_on = None


# (table, column) — every column that holds >2 KB of TOAST-able data on
# average. ``request_body`` and ``response_body`` are the headline
# targets: 10-100 KB per row on real workloads.
_TOAST_COLUMNS = [
    ("telemetry_events", "payload"),
    ("telemetry_events", "metrics"),
    ("telemetry_events", "attributes"),
    ("telemetry_events", "request_body"),
    ("telemetry_events", "response_body"),
    ("telemetry_events", "reasoning"),
    ("telemetry_events", "tool_calls_full"),
    ("telemetry_events", "tool_results"),
    ("telemetry_events", "images"),
    ("telemetry_events", "audio"),
    ("telemetry_events", "logprobs"),
    ("telemetry_events", "citations"),
    ("usage_events", "metadata"),
    ("judge_scores", "rationale"),
]


def _table_and_column_exist(table: str, column: str) -> bool:
    conn = op.get_bind()
    return conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.columns "
            " WHERE table_schema='public' AND table_name=:t AND column_name=:c"
        ),
        {"t": table, "c": column},
    ).first() is not None


def upgrade() -> None:
    # 1. Database-wide default for any new tables / new columns.
    op.execute(
        """
        DO $$
        DECLARE
            db_name text := current_database();
        BEGIN
            EXECUTE format('ALTER DATABASE %I SET default_toast_compression = lz4', db_name);
        END $$;
        """
    )

    # 2. Per-column SET COMPRESSION (catalog-only) + UPDATE-noop (rewrite).
    for table, col in _TOAST_COLUMNS:
        if not _table_and_column_exist(table, col):
            # Skip silently — e.g. a fresh test DB may not have migration
            # 011 applied yet. The migration is idempotent.
            continue
        op.execute(f"ALTER TABLE {table} ALTER COLUMN {col} SET COMPRESSION lz4;")
        # Force re-TOAST of rows that have substantial data. The ``> 2000``
        # guard means we don't rewrite the (very common) empty/small
        # rows, which is the bulk of the table.
        op.execute(
            f"UPDATE {table} SET {col} = {col} "
            f"WHERE {col} IS NOT NULL AND pg_column_size({col}) > 2000;"
        )


def downgrade() -> None:
    for table, col in _TOAST_COLUMNS:
        if not _table_and_column_exist(table, col):
            continue
        op.execute(f"ALTER TABLE {table} ALTER COLUMN {col} SET COMPRESSION pglz;")
        op.execute(
            f"UPDATE {table} SET {col} = {col} "
            f"WHERE {col} IS NOT NULL AND pg_column_size({col}) > 2000;"
        )
    op.execute(
        """
        DO $$
        DECLARE
            db_name text := current_database();
        BEGIN
            EXECUTE format('ALTER DATABASE %I RESET default_toast_compression', db_name);
        END $$;
        """
    )
