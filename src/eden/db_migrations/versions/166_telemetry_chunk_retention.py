"""166 — telemetry_events hypertable tuning (P3.4).

Revision ID: 166_telemetry_chunk_retention
Revises: 165_drop_dead_test_tables
Create Date: 2026-08-10

P3.4: live probe (2026-08-10) found ``telemetry_events`` is a
TimescaleDB hypertable with **1-day chunks** (migration 034 default)
holding 102 rows across 9 chunks, **no retention policy**, and
**no compression** (migration 034's columnstore block silently no-ops on
the Neon "apache" OSS build — ``feature_not_supported`` — which is why
``timescaledb_information.compression_settings`` is empty live).

This migration:

1. Widens the chunk interval from 1 day to 7 days — 7× fewer chunks for
   the same time span, fewer background jobs, smaller catalog, and
   better batching for any future columnstore/compression pass. Only
   affects chunks created after this migration (existing chunks keep
   their bounds; Timescale merges nothing retroactively, which is fine —
   the table is small).
2. Adds a 90-day retention policy. The table only ever holds ~100 rows
   and ingestion is near-zero, so a 90-day window is generous but bounds
   the table against a future ingest spike. Requires Timescale 2.0+
   (``add_retention_policy``); Neon's allowlist includes timescaledb.
3. Retries columnstore compression with the same
   ``feature_not_supported`` guard migration 034 used. On an apache
   build this is a no-op; on an enterprise build it enables compression
   for chunks older than 7 days. Both outcomes are correct.

All statements are idempotent (``if_not_exists`` / ``if_exists``), so a
half-migrated DB recovers with ``alembic upgrade head``.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "166_telemetry_chunk_retention"
down_revision: str | Sequence[str] | None = "165_drop_dead_test_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1) 7-day chunks instead of 1-day.
    op.execute(
        "SELECT set_chunk_time_interval('telemetry_events', INTERVAL '7 days')"
    )

    # 2) 90-day retention. On the Neon "apache" OSS build this is also
    #    license-gated (``FeatureNotSupported`` — same family as the
    #    columnstore), so it gets the same guarded block; the app keeps
    #    working either way and an enterprise build gets the policy.
    op.execute(
        """
        DO $$
        BEGIN
            PERFORM add_retention_policy(
                'telemetry_events', INTERVAL '90 days',
                if_not_exists => TRUE
            );
        EXCEPTION
            WHEN feature_not_supported THEN
                RAISE NOTICE 'TimescaleDB apache build; skipping retention policy';
        END $$;
        """
    )

    # 3) Columnstore compression, guarded for the apache OSS build.
    op.execute(
        """
        DO $$
        BEGIN
            ALTER TABLE telemetry_events SET (
                timescaledb.compress,
                timescaledb.compress_segmentby = 'tenant_id, event_type, name',
                timescaledb.compress_orderby   = 'timestamp DESC'
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
                'telemetry_events', INTERVAL '7 days',
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
        """
        DO $$
        BEGIN
            PERFORM remove_retention_policy('telemetry_events', if_exists => TRUE);
        EXCEPTION
            WHEN feature_not_supported THEN
                NULL;
        END $$;
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            PERFORM remove_compression_policy('telemetry_events', if_exists => TRUE);
        EXCEPTION
            WHEN feature_not_supported THEN
                NULL;
        END $$;
        """
    )
    op.execute("ALTER TABLE telemetry_events SET (timescaledb.compress = false)")
    # Chunk interval is not revertible per-chunk; return the default.
    op.execute(
        "SELECT set_chunk_time_interval('telemetry_events', INTERVAL '1 day')"
    )
