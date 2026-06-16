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

    # TimescaleDB requires the partition column to be part of any
    # PRIMARY KEY or UNIQUE constraint. The original ``judge_scores``
    # PK (from migration 010) is on ``judge_run_id`` only. We DROP
    # + re-ADD the PK to include ``scored_at`` before calling
    # create_hypertable. Safe on a fresh DB (no rows); for a
    # populated DB this is a table rewrite — schedule accordingly.
    op.execute(
        "ALTER TABLE judge_scores DROP CONSTRAINT IF EXISTS judge_scores_pkey CASCADE;"
    )
    op.execute(
        "ALTER TABLE judge_scores "
        "ADD CONSTRAINT judge_scores_pkey PRIMARY KEY (judge_run_id, scored_at);"
    )

    op.execute(
        """
        SELECT create_hypertable(
            'judge_scores', 'scored_at',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE
        );
        """
    )

    # See the matching note in migration 034 — the columnstore is an
    # enterprise feature; on the open-source "apache" build the DO
    # block swallows ``feature_not_supported`` and we fall through
    # to the LZ4 TOAST + BRIN wins from migrations 030 + 031.
    op.execute(
        """
        DO $$
        BEGIN
            ALTER TABLE judge_scores SET (
                timescaledb.compress,
                timescaledb.compress_segmentby = 'tenant_id, judge_name',
                timescaledb.compress_orderby   = 'scored_at DESC'
            );
        EXCEPTION
            WHEN feature_not_supported THEN
                RAISE NOTICE 'TimescaleDB apache build; skipping columnstore compression';
        END $$;
        """
    )

    op.execute(
        """
        DO $$
        BEGIN
            PERFORM add_compression_policy(
                'judge_scores', INTERVAL '30 days',
                if_not_exists => TRUE
            );
        EXCEPTION
            WHEN feature_not_supported THEN
                NULL;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        "SELECT remove_compression_policy('judge_scores', if_exists => TRUE);"
    )
    op.execute("ALTER TABLE judge_scores SET (timescaledb.compress = false);")
