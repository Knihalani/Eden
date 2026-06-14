"""022_columnar_engine — Cat 18 (v1.3) observability gap roadmap.

Revision ID: 022
Revises: 021
Create Date: 2026-06-11

Adds the data model for Cat 18 — Query Performance / Columnar
Engine, the v1.3-ship category that closes the
Braintrust-Brainstore gap by wrapping the existing
:class:`eden.data_platform.clickhouse_sink.ClickHouseSink`
substrate in a typed service surface (per-org partitions,
pre-computed rollups, background compaction, query engine
with Postgres fallback).

The three new tables:

* ``columnar_rollups`` — one row per pre-computed aggregate
  over a (org, source_table, granularity, window). The
  :class:`ColumnarAggregator` writes one row per call to
  ``precompute_rollups``. The rollup payload is stored as
  JSONB-in-TEXT (the same shape the existing analytics
  layers use) so the dashboard can render the rollup
  without a re-aggregation.
* ``columnar_partitions`` — one row per (org, partition_id)
  that the partition manager has materialised. The PK is
  ``(org_id, partition_id)`` so the per-org partitioning
  pattern the v1.3 ship uses is enforced at the schema
  layer (no two partitions with the same id per org).
  The ``last_compaction_at`` + ``last_compaction_dur_ms``
  columns are the SLA signal the closed-loop
  :class:`ColumnarHook.on_compaction_drift` reads.
* ``columnar_compaction_log`` — append-only history of
  every compaction the :class:`ColumnarCompactor` has
  run. The :class:`ColumnarQueryEngine` reads this on
  the Postgres fallback path so a degraded ClickHouse
  can still surface "last successful compaction" without
  hitting the live ClickHouse API.

Conventions
-----------
* All tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.
* The Postgres-fallback path (Cat 18's headline
  resilience feature) is enforced at the service layer,
  not at the schema layer.

See ``docs/observability-gap/18-query-performance.md``.
"""

from __future__ import annotations

from alembic import op

revision = "022"
down_revision = "021"
branch_labels = None
depends_on = None


# Mirror the pattern in 021_custom_metric_studio.py so the
# downgrade / upgrade shapes stay in lockstep. Centralised so
# adding a 4th v1.3 cat is a 2-line edit, not 6.
def _table(name: str, body: str, extra_index: str = "") -> None:
    op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
    op.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
        f"ON {name} (org_id, created_at DESC)"
    )
    if extra_index:
        op.execute(extra_index)


def upgrade() -> None:
    # ─── Cat 18 — Columnar Engine (v1.3) ─────────────────────
    # 1. columnar_rollups — pre-computed aggregates. The
    #    payload_json holds the per-time-bucket aggregate
    #    values for the window (e.g.
    #    {"n_calls": 452000, "n_errors": 12, "p95_ms": 87.4,
    #    "cost_usd": 12.34}); n_rows is the number of source
    #    rows the rollup aggregated. The
    #    (org, source_table, granularity, window_end DESC)
    #    index is the dashboard's read pattern.
    _table(
        "columnar_rollups",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        source_table        VARCHAR(64) NOT NULL,
        granularity         VARCHAR(16) NOT NULL,
        window_start        TIMESTAMPTZ NOT NULL,
        window_end          TIMESTAMPTZ NOT NULL,
        payload_json        TEXT NOT NULL,
        n_rows              BIGINT NOT NULL,
        compressed_bytes    BIGINT NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_columnar_rollups_lookup "
        "ON columnar_rollups (org_id, source_table, granularity, "
        "window_end DESC)",
    )

    # 2. columnar_partitions — per-org partition metadata. The
    #    PK is composite (org_id, partition_id) so the
    #    Brainstore-style per-customer partitioning is
    #    enforced at the schema layer. The last_compaction_*
    #    columns are the SLA signal the closed-loop
    #    ColumnarHook.on_compaction_drift reads.
    _table(
        "columnar_partitions",
        """
        org_id                  VARCHAR(128) NOT NULL,
        partition_id            VARCHAR(128) NOT NULL,
        clickhouse_partition    VARCHAR(256) NOT NULL,
        granularity             VARCHAR(16) NOT NULL,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_compaction_at      TIMESTAMPTZ,
        last_compaction_dur_ms  INT,
        rows_total              BIGINT NOT NULL DEFAULT 0,
        bytes_total             BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (org_id, partition_id)
        """,
    )

    # 3. columnar_compaction_log — append-only compaction
    #    history. The query engine reads this on the Postgres
    #    fallback path so a degraded ClickHouse can still
    #    surface "last successful compaction" without
    #    hitting the live ClickHouse API.
    _table(
        "columnar_compaction_log",
        """
        id                  UUID PRIMARY KEY,
        org_id              VARCHAR(128) NOT NULL,
        partition_id        VARCHAR(128) NOT NULL,
        started_at          TIMESTAMPTZ NOT NULL,
        completed_at        TIMESTAMPTZ NOT NULL,
        rows_in             BIGINT NOT NULL,
        rows_out            BIGINT NOT NULL,
        bytes_in            BIGINT NOT NULL,
        bytes_out           BIGINT NOT NULL,
        status              VARCHAR(16) NOT NULL,
        error               TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_columnar_compaction_partition "
        "ON columnar_compaction_log (org_id, partition_id, "
        "completed_at DESC)",
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_columnar_compaction_partition")
    op.execute("DROP INDEX IF EXISTS idx_columnar_rollups_lookup")
    op.execute("DROP INDEX IF EXISTS idx_columnar_compaction_log_org")
    op.execute("DROP INDEX IF EXISTS idx_columnar_partitions_org")
    op.execute("DROP INDEX IF EXISTS idx_columnar_rollups_org")
    op.execute("DROP TABLE IF EXISTS columnar_compaction_log")
    op.execute("DROP TABLE IF EXISTS columnar_partitions")
    op.execute("DROP TABLE IF EXISTS columnar_rollups")
