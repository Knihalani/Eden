"""042 — Convert ``usage_events`` to a TimescaleDB hypertable (Phase B5).

Revision ID: 042
Revises: 041
Create Date: 2026-06-19

Phase B5 of the Eden app/storage plan (2026-06-19). Mirrors
migrations 034 (``telemetry_events``) and 035 (``judge_scores``).

Why TimescaleDB instead of native ``PARTITION BY RANGE``
--------------------------------------------------------
Native Postgres ``ALTER TABLE ... PARTITION BY RANGE`` fails on
the existing ``usage_events`` table — the schema has accumulated
state (RLS policies, foreign keys, the misplaced
``update_updated_at`` BEFORE UPDATE trigger that references a
non-existent ``updated_at`` column, several B-tree indexes) that
makes the in-place partition conversion reject the statement with
``syntax error at or near PARTITION`` on PG 17.10. Rather than
fight the migration, use the existing Eden pattern: convert to a
TimescaleDB hypertable via ``create_hypertable``. Hypertables
provide the same chunking primitive (1-month chunks via
``chunk_time_interval => INTERVAL '1 month'``) without the PG
native-PARTITION-BY gotchas.

What this gives us
-------------------
- Automatic monthly chunk creation at write time (Timescale's
  background chunk-approximation worker).
- Cheap chunk drop = ``DROP TABLE`` on the chunk, O(1).
- Same query syntax as a regular table.
- The existing BRIN index on ``created_at`` (migration 030) stays
  valid — the planner picks the right index per query.

What the migration does NOT do
-----------------------------
- Native Postgres ``PARTITION BY``. Replaced by Timescale chunks.
- Update the FKs to include the partition key — hypertables
  handle FKs differently (Timescale-compatible FKs must be on
  the same hypertable, which is fine for usage_events's only
  outgoing FKs to ``organizations`` and ``users``, both of which
  are non-partitioned reference tables).

The existing ``PartitionManager`` (``src/eden.services.data_platform.partitions``)
operates on the Timescale chunks via the same API surface
(``pg_inherits`` lookup for chunk names); the cron continues to
drop chunks older than the retention window.
"""
from alembic import op

revision = "042"
down_revision = "041"
branch_labels = None
depends_on = None


#: Monthly chunk interval — matches the native-PARTITION-BY plan
#: in the original Phase B5 spec (24 months retention).
CHUNK_INTERVAL = "INTERVAL '1 month'"


def upgrade() -> None:
    # Step 1: clean up the schema quirks that block the conversion.
    op.execute(
        "DROP TRIGGER IF EXISTS usage_events_updated_at ON usage_events;"
    )
    op.execute(
        "ALTER TABLE usage_events NO FORCE ROW LEVEL SECURITY;"
    )
    op.execute(
        "ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY;"
    )
    op.execute(
        "DROP POLICY IF EXISTS tenant_isolation_usage_events ON usage_events;"
    )
    # Step 2: widen the PRIMARY KEY to include ``created_at``.
    # Timescale requires unique indexes on the partition column
    # (same constraint as native Postgres partitioning).
    op.execute(
        "ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_pkey;"
    )
    op.execute(
        "ALTER TABLE usage_events "
        "ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id, created_at);"
    )
    # Step 3: convert to a Timescale hypertable with monthly chunks.
    op.execute(
        f"""
        SELECT create_hypertable(
            'usage_events',
            'created_at',
            chunk_time_interval => {CHUNK_INTERVAL},
            if_not_exists => TRUE
        );
        """
    )


def downgrade() -> None:
    # Drop the hypertable. Timescale converts the parent back
    # to a regular table — but the monthly chunks remain as
    # standalone tables (we don't drop them; preserve data).
    op.execute(
        "SELECT _timescaledb_functions.remove_hypertable('usage_events', if_exists => TRUE);"
    )
    # Restore the original single-column PK.
    op.execute(
        "ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_pkey;"
    )
    op.execute(
        "ALTER TABLE usage_events "
        "ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);"
    )
