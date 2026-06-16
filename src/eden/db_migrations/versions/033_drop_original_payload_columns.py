"""033_drop_original_payload_columns — drop the original JSONB payload columns.

Revision ID: 033
Revises: 032
Create Date: 2026-06-16 (deferred; run ≥ 30 days after 032 ships)

DEFERRED MIGRATION. **Do not run until ALL of the following are true:**

  (a) Every writer to ``telemetry_events`` populates ``request_body_zstd``
      and ``response_body_zstd``. The new compression service
      (``eden.storage.compression.compress_jsonb``) is wired into
      ``TelemetryCollector._route_postgres`` — verify by grep.

  (b) Every reader of ``telemetry_events.request_body`` and
      ``response_body`` reads the ``*_zstd`` column first and falls
      back to the original. ``get_trace_tree`` is the canonical reader
      — verify by grep that the fallback path is no longer hit in
      normal operation (run for 30 days without a single
      ``response_body_zstd IS NULL`` in production logs).

  (c) ≥ 30 days of production traffic on the new path. The
      backfill script (``scripts/backfill_zstd_payloads.py``) reports
      0 pending rows.

  (d) Zero open support tickets that reference the old columns.

When all four are true, this migration is safe to run. It will:
  1. ``ALTER TABLE telemetry_events DROP COLUMN response_body;``
  2. ``ALTER TABLE telemetry_events DROP COLUMN request_body;``

Reclaim is ~10-100 KB × row count bytes; for a 100M-row table that is
1-10 TB of disk back. The actual free space is only returned to the OS
after a subsequent ``VACUUM FULL`` or ``pg_squeeze`` run.
"""
from alembic import op

revision = "033"
down_revision = "032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS response_body;"
    )
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS request_body;"
    )


def downgrade() -> None:
    # The drop is destructive; downgrade cannot recover the data.
    # We recreate the columns as JSONB NULL-able so the schema matches
    # the pre-033 state, but the data is gone.
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS request_body JSONB;"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS response_body JSONB;"
    )
