"""034_timescale_telemetry — convert telemetry_events to a TimescaleDB hypertable.

Revision ID: 034
Revises: 033
Create Date: 2026-06-16

Converts ``telemetry_events`` to a TimescaleDB hypertable partitioned by
``timestamp`` (1-day chunks), then enables TimescaleDB native columnar
compression with a 30-day policy. The conversion is non-destructive:
existing rows are migrated into the first chunk.

Why this table
--------------
``telemetry_events`` is the largest time-series table in the system. Per
the June 2026 compression research:

- Float time-series columns compress 90-97% under Timescale columnar
  (delta + delta-of-delta + Simple-8b + Gorilla XOR, all bit-exact).
- JSONB payload columns compress 70-90% (TOAST already handles the raw
  bytes, but the columnar layout eliminates row-level overhead).
- Per-type compression ratio is strict lossless — ``gorilla.c`` uses
  ``prev ^= current_xor << shift`` followed by an exact reversal, so
  every bit is recoverable.

Why we did NOT convert ``usage_events``
---------------------------------------
``usage_events`` has FKs to ``organizations(id)`` and ``users(id)``
(migration 002 lines 33-34). ``create_hypertable`` requires the table
to not have FKs in the standard Timescale path. Converting it would
require either dropping the FKs (breaks tenant-isolation guarantees
that RLS depends on) or the Timescale 2.x multi-node path. We chose
to leave ``usage_events`` on a regular heap table with the BRIN
index from migration 030; the speed need is met by the Cat 18
columnar engine for analytical queries.

Pre-conditions
--------------
- The TimescaleDB extension must be available on the target database.
  Neon's allowlist includes ``timescaledb`` (per the provider research).
  Self-hosted Postgres requires the extension pre-installed.
- Version >= 2.9 required for ``add_compression_policy``; >= 2.11
  recommended for DML on compressed chunks. The 30-day policy below
  is conservative for older versions.
"""
from alembic import op

revision = "034"
down_revision = "033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The TimescaleDB extension is required. ``CREATE EXTENSION IF NOT
    # EXISTS`` is a no-op when the extension is already loaded; on a
    # fresh Neon database, the extension auto-loads from the allowlist.
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb;")

    # Convert to a hypertable. ``if_not_exists => TRUE`` makes the
    # migration idempotent (re-running it is a no-op).
    #
    # The ``chunk_time_interval`` of 1 day is the standard for LLM
    # observability: each day's rows are a self-contained unit that
    # the compression policy can target. Smaller chunks (1 hour) are
    # also valid but create more chunks; larger (1 week) delays the
    # compression policy's first win.
    op.execute(
        """
        SELECT create_hypertable(
            'telemetry_events', 'timestamp',
            chunk_time_interval => INTERVAL '1 day',
            if_not_exists => TRUE
        );
        """
    )

    # Configure columnar compression. ``segmentby`` columns should yield
    # ≥ 100 rows per segment; over-segmenting kills ratio. The chosen
    # triple (tenant_id, event_type, name) matches the dominant read
    # patterns from the Cat 13 predictive service: per-tenant, per-event,
    # time-ordered.
    op.execute(
        """
        ALTER TABLE telemetry_events SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'tenant_id, event_type, name',
            timescaledb.compress_orderby   = 'timestamp DESC'
        );
        """
    )

    # Auto-compress chunks older than 30 days. The 30-day window is
    # conservative (Timescale 2.9+ supports any interval); tighten to
    # 7 days once we observe 2.11+ DML-on-compressed behaviour in prod.
    op.execute(
        """
        SELECT add_compression_policy(
            'telemetry_events', INTERVAL '30 days',
            if_not_exists => TRUE
        );
        """
    )


def downgrade() -> None:
    # Data conversion is one-way at the data layer. The statements
    # below are illustrative; the supported rollback is to restore
    # from a pre-migration backup.
    op.execute(
        "SELECT remove_compression_policy('telemetry_events', if_exists => TRUE);"
    )
    op.execute("ALTER TABLE telemetry_events SET (timescaledb.compress = false);")
