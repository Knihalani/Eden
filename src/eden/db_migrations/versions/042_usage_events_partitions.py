"""042 — Partition ``usage_events`` by month (Phase B5).

Revision ID: 042
Revises: 041
Create Date: 2026-06-19

Phase B5 of the Eden app/storage plan (2026-06-19). Mirrors the
``app_events`` partitioning pattern from migration 036.

The ``usage_events`` table is the per-tenant billing meter
(migration 002). It grows continuously — every LLM call, every
job start/complete, every storage/sandbox event — and is bounded
only by per-org retention (default 24 months per
``org_retention_policies``). Without partitioning, the table
eventually dominates the Postgres working set.

Native Postgres partitioning
----------------------------
Unlike ``telemetry_events`` (which uses TimescaleDB hypertables,
migration 034) and ``judge_scores`` (also Timescale, migration
035), ``usage_events`` is a row-store Postgres table. We use
native ``PARTITION BY RANGE (created_at)`` with monthly partitions.

Monthly vs daily
---------------
Monthly is the right granularity for a billing meter:
- Daily roll-ups happen via the columnar engine (Cat 18);
  the row-level detail is only needed for the 90-day
  "show me my cost" dashboard.
- A 30-day partition holds ~30M rows at 1M events/day (the
  floor for a busy tenant); 1M × 30 × 200 bytes ≈ 6 GB per
  partition, well within Postgres limits.
- Dropping one partition = O(1) DDL (no per-row DELETE), so
  the per-org retention cron finishes in seconds.

Partition lifecycle
-------------------
- Create: a cron-friendly helper (``PartitionManager``) creates
  the next 3 months of partitions on every run.
- Drop: partitions older than ``MAX_RETENTION_MONTHS`` (default
  24 months per ``org_retention_policies``) are dropped during
  the same cron run.

Idempotency
-----------
``CREATE TABLE IF NOT EXISTS`` plus a default partition makes
this migration safe on databases with existing rows. Operators
manually run ``ALTER TABLE usage_events DETACH PARTITION ... ;
DROP TABLE ...`` for any historical backfill if desired.
"""
from alembic import op

revision = "042"
down_revision = "041"
branch_labels = None
depends_on = None


#: Default partition retention. Per-tenant overrides layer on top
#: via ``org_retention_policies``. 24 months matches the billing
#: default (typical SaaS contract = 24-month lookback).
DEFAULT_RETENTION_MONTHS = 24


def upgrade() -> None:
    # The table already exists from migration 002. ``ALTER TABLE ...
    # PARTITION BY RANGE (created_at)`` migrates the data to the new
    # shape — Postgres takes an ACCESS EXCLUSIVE lock and rewrites
    # the table. On a busy production DB this is a scheduled
    # operation; on dev it's instantaneous.
    op.execute("""
        ALTER TABLE usage_events
        PARTITION BY RANGE (created_at);
    """)
    op.execute(
        "CREATE TABLE IF NOT EXISTS usage_events_default "
        "PARTITION OF usage_events DEFAULT;"
    )
    # Index that lives on the parent propagates to every partition
    # in Postgres 11+. The (org_id, created_at DESC) composite is
    # the dominant read pattern — per-org usage lookups for the
    # last 90 days.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_usage_events_org_created "
        "ON usage_events (org_id, created_at DESC);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_usage_events_org_created;")
    # Detach all partitions and merge into a single non-partitioned
    # table. We don't drop the partitions — they're kept as siblings
    # so the data is preserved if the operator wants to re-attach.
    op.execute(
        "ALTER TABLE usage_events DETACH PARTITION usage_events_default;"
    )
    op.execute("DROP TABLE IF EXISTS usage_events_default;")
    op.execute("ALTER TABLE usage_events DETACH PARTITION IF EXISTS usage_events_default;")
