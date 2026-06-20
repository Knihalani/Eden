"""037 — Add ``session_id`` to ``telemetry_events`` (Phase A1 cross-cutting).

Revision ID: 037
Revises: 036
Create Date: 2026-06-19

Adds ``session_id`` column to ``telemetry_events`` so a trace can be
joined to its surrounding session activity without a secondary
table JOIN.

Forward-fill: every new event that arrives via ``/ingest/*`` with
an ``X-Eden-Session-Id`` header (or ``session_id`` in the body)
populates the column. The session is created by the Phase A1
``/intelligence/user/sessions/start`` endpoint.

Backfill: a one-shot script (not part of this migration; see
``scripts/backfill_session_id_on_telemetry_events.py``) reads the
last 30 days of ``app_events`` and joins to ``telemetry_events``
on ``trace_id``. Alembic migrations are atomic; backfill belongs
out-of-band (same pattern as ``scripts/backfill_zstd_payloads.py``).
"""
from alembic import op

revision = "037"
down_revision = "036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE telemetry_events
        ADD COLUMN IF NOT EXISTS session_id VARCHAR(64);
    """)
    # The telemetry_events table uses ``tenant_id`` (not ``org_id``).
    # This matches migration 009 (Phase 7.0) and every other index
    # on the table. The DESC on ``timestamp`` mirrors the
    # existing read pattern (recent-first scans).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_session
        ON telemetry_events (tenant_id, session_id, timestamp DESC);
    """)
    # BRIN for the session_id range scan — the partial WHERE
    # clause triggers a planner error on BRIN, so leave it
    # unconditional. Cheap to maintain; unused rows just have
    # null session_id which the index handles fine.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_session_brin
        ON telemetry_events USING BRIN (session_id);
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_session_brin;")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_session;")
    op.execute(
        "ALTER TABLE telemetry_events DROP COLUMN IF EXISTS session_id;"
    )
