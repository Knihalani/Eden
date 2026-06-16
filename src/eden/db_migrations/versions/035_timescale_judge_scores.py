"""035_timescale_judge_scores — convert judge_scores to a TimescaleDB hypertable.

Revision ID: 035
Revises: 034
Create Date: 2026-06-16

Converts ``judge_scores`` to a TimescaleDB hypertable partitioned by
``scored_at`` (1-day chunks) and enables native columnar compression.

This is the same shape as migration 034 (telemetry_events); see that
file for the lossless-compression rationale. The differences are:

- Time column is ``scored_at`` (not ``timestamp``).
- Segment columns are ``(tenant_id, judge_name)`` — the dominant
  read pattern is per-tenant per-judge time-series (dashboards,
  regressions, alerting).
- ``judge_scores`` has zero FKs (verified against migration 010), so
  the conversion is direct.

Pre-conditions
--------------
- TimescaleDB extension >= 2.11 recommended. The 30-day compression
  policy is conservative for older versions.
- ``scored_at`` is NOT NULL on the table (verified against migration
  010 line 40).
"""
from alembic import op

revision = "035"
down_revision = "034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb;")

    op.execute(
        """
        SELECT create_hypertable(
            'judge_scores', 'scored_at',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE
        );
        """
    )

    op.execute(
        """
        ALTER TABLE judge_scores SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'tenant_id, judge_name',
            timescaledb.compress_orderby   = 'scored_at DESC'
        );
        """
    )

    op.execute(
        """
        SELECT add_compression_policy(
            'judge_scores', INTERVAL '30 days',
            if_exists => TRUE
        );
        """
    )


def downgrade() -> None:
    op.execute(
        "SELECT remove_compression_policy('judge_scores', if_exists => TRUE);"
    )
    op.execute("ALTER TABLE judge_scores SET (timescaledb.compress = false);")
