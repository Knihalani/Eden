"""030_brin_timeseries — BRIN indexes on all append-only time-series tables.

Revision ID: 030
Revises: 029
Create Date: 2026-06-16

BRIN (Block Range INdex) stores a min/max per ~32 pages (configurable via
``pages_per_range``) instead of per-row, yielding ~99% smaller indexes than
B-tree for naturally ordered timestamps. The Postgres planner uses BRIN for
range scans (``WHERE created_at > $1``) when the cost beats a sequential
scan; the existing B-tree indexes on (org_id, …, created_at) stay in place
for point lookups.

Tables covered (and their time columns):
- ``usage_events (created_at)``        — bronze event sink, narrow time-series
- ``telemetry_events (timestamp)``     — Phase 7.0 LLM/agent events
- ``judge_scores (scored_at)``         — Phase 7.1b LLM-as-judge runs
- ``retrieval_logs (created_at)``      — Phase C.4 retrieval tuner (raw SQL
                                          in ``migrations/022_retrieval_tuner.sql``;
                                          guarded so the migration is a no-op
                                          if the table hasn't been created)

Pre-conditions (verification, not gating):
- Physical correlation between the timestamp column and insertion order must
  be ≥ 0.7 for BRIN to be useful. Run:
      ``SELECT attname, correlation FROM pg_stats
         WHERE tablename IN ('usage_events', 'telemetry_events',
                             'judge_scores', 'retrieval_logs')
           AND attname IN ('created_at', 'timestamp', 'scored_at');``
  If correlation < 0.7 on any table, the BRIN will be ignored by the
  planner and the index is just dead weight — drop it in that case.

This migration is fully online and non-destructive: BRIN creation does not
rewrite the table. Drop the index (downgrade) is instant.
"""
from alembic import op
import sqlalchemy as sa

revision = "030"
down_revision = "029"
branch_labels = None
depends_on = None


# (table, timestamp_column) — column names verified against migrations 002
# (usage_events), 009 (telemetry_events), 010 (judge_scores), and
# migrations/022_retrieval_tuner.sql (retrieval_logs).
_BRIN_TARGETS = [
    ("usage_events", "created_at"),
    ("telemetry_events", "timestamp"),
    ("judge_scores", "scored_at"),
    ("retrieval_logs", "created_at"),
]


def _table_exists(table_name: str) -> bool:
    """Return True if ``table_name`` exists in the public schema."""
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
    for table, col in _BRIN_TARGETS:
        # Guard the BRIN creation with a table-exists check so this migration
        # is safe to run against a DB that hasn't applied the raw-SQL
        # ``migrations/022_retrieval_tuner.sql`` yet (retrieval_logs may be
        # missing on dev / staging).
        if not _table_exists(table):
            continue
        idx_name = f"idx_brin_{table}_{col}"
        op.execute(
            f"CREATE INDEX IF NOT EXISTS {idx_name} "
            f"ON {table} USING brin ({col}) WITH (pages_per_range = 32);"
        )


def downgrade() -> None:
    for table, col in _BRIN_TARGETS:
        idx_name = f"idx_brin_{table}_{col}"
        op.execute(f"DROP INDEX IF EXISTS {idx_name};")
