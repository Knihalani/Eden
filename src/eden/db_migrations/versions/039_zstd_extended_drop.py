"""039 — Drop the original 6 JSONB columns after extended zstd burn-in (Phase B2).

Revision ID: 039
Revises: 038
Create Date: 2026-06-19 (deferred; run ≥ 30 days after 038 ships)

DEFERRED MIGRATION. Mirrors migration 033's pattern (the request /
response drop). Do NOT run until ALL of the following are true:

  (a) Every writer to ``telemetry_events`` populates the 6 new
      ``*_zstd`` columns (``reasoning_zstd``, ``tool_calls_full_zstd``,
      ``tool_results_zstd``, ``payload_zstd``, ``metrics_zstd``,
      ``attributes_zstd``). The ``TelemetryCollector._route_postgres``
      function writes them on every new event.

  (b) Every reader of the 6 original JSONB columns reads ``*_zstd``
      first and falls back to the original JSONB only on
      ``ZstdError`` / NULL. The ``_read_payload`` shim is the
      canonical reader.

  (c) ≥ 30 days of production traffic on the new path. The backfill
      script (``scripts/backfill_extended_zstd.py``) reports 0
      pending rows.

  (d) Zero open support tickets that reference the original 6
      JSONB columns.

The actual ``DROP COLUMN`` statements are removed from this
migration's ``upgrade()`` body (mirrors migration 033). Run the
SQL manually after the four prerequisites are satisfied.
"""
from alembic import op

revision = "039"
down_revision = "038"
branch_labels = None
depends_on = None


# The 6 columns that will eventually be dropped. Listed here so the
# downgrade() can recreate them with the same shape.
_DROPPABLE_COLUMNS = [
    "reasoning",
    "tool_calls_full",
    "tool_results",
    "payload",
    "metrics",
    "attributes",
]


def upgrade() -> None:
    # No-op; the actual DROP COLUMN lives in
    # ``scripts/zstd_extended_drop_originals.sql`` (mirrors
    # migration 033's pattern).
    pass


def downgrade() -> None:
    # The drop is destructive; downgrade cannot recover the data.
    # Recreate the columns as JSONB NULL-able so the schema matches
    # the pre-039 state.
    for col in _DROPPABLE_COLUMNS:
        op.execute(
            f"ALTER TABLE telemetry_events "
            f"ADD COLUMN IF NOT EXISTS {col} JSONB;"
        )
