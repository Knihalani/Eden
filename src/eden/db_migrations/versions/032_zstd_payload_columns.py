"""032_zstd_payload_columns — zstd-compressed BYTEA columns for LLM payloads.

Revision ID: 032
Revises: 031
Create Date: 2026-06-16

Adds ``request_body_zstd`` and ``response_body_zstd`` BYTEA columns to
``telemetry_events``. These hold the same LLM payload data as
``request_body`` / ``response_body`` (JSONB), but compressed with
``zstandard`` and a pre-trained dictionary (see
``src/eden/storage/compression.py``).

The original JSONB columns are kept in place for a 30-day burn-in. During
that window, the application writes to BOTH columns and reads from
``*_zstd`` first, falling back to the JSONB column for pre-backfill rows.
Migration ``033_drop_original_payload_columns`` (deferred 30 days) drops
the JSONB columns once the burn-in is complete.

This migration only adds the columns. The actual compression + backfill
runs in ``scripts/backfill_zstd_payloads.py`` (a one-shot worker) — see
the docstring on that script for invocation.

Why BYTEA, not JSONB-with-ALTER-TOAST
-------------------------------------
PostgreSQL 18's zstd-as-TOAST-compression is still a ``pgsql-hackers``
patch and is not in any managed provider's allowlist. Storing compressed
bytes as ``BYTEA`` gives full control of the dictionary and decouples us
from Postgres's internal compression decisions. It also lets us update
the dictionary (re-train quarterly) without rewriting every row.
"""
from alembic import op

revision = "032"
down_revision = "031"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS request_body_zstd BYTEA;"
    )
    op.execute(
        "ALTER TABLE telemetry_events "
        "ADD COLUMN IF NOT EXISTS response_body_zstd BYTEA;"
    )
    # Index on the new columns is intentionally omitted: the read path
    # is always by (tenant_id, trace_id) which uses the existing
    # btree on (trace_id, timestamp ASC). The new columns are only
    # read inside the row.


def downgrade() -> None:
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS response_body_zstd;"
    )
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS request_body_zstd;"
    )
