"""062_provider_routing — D.12.6 Provider routing attempts per upgradespec §B.8.

Revision ID: 062
Revises: 061
Create Date: 2026-06-24

Per spec §B.8 (D.12.6):

    CREATE TABLE provider_routing_attempts (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trace_id            UUID NOT NULL,
        span_id             UUID NOT NULL,
        attempted_provider  TEXT NOT NULL,    -- 'openai' | 'anthropic' | 'google' | ...
        attempted_model     TEXT NOT NULL,
        failure_reason      TEXT,             -- null on success
        latency_ms          INTEGER,
        decision            TEXT NOT NULL,    -- 'success' | 'fallback' | 'retry' | 'abort'
        sequence_index      INTEGER NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (decision IN ('success', 'fallback', 'retry', 'abort'))
    );

Ponytail:
* ``org_id`` added (spine convention) so the service can
  org-scope queries without joining ``telemetry_events``.
* ``UNIQUE(trace_id, sequence_index)`` for SDK idempotency:
  when a middleware retries the same attempt, the upsert
  writes once. The spec doesn't require this index but the
  R-13 risk ("Provider routing attempts overload on retries
  — cap at 10 attempts/trace") implies we need a hard cap
  + a deterministic dedup key, and a UNIQUE on the natural
  key is the cheapest dedup.
* Decision CHECK constraint: kept per spec exactly (the
  4 values are part of the SDK contract).
* Attempted_provider is plain TEXT (no CHECK): providers
  evolve (same reasoning as voice / fine-tune).
* ``idx_provider_routing_provider_time`` on
  ``(attempted_provider, created_at DESC)`` for the
  repeated-failure detector's rolling-window query.
"""

from __future__ import annotations

from alembic import op

revision = "062"
down_revision = "061"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS provider_routing_attempts (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            trace_id            UUID NOT NULL,
            span_id             UUID NOT NULL,
            attempted_provider  TEXT NOT NULL,
            attempted_model     TEXT NOT NULL,
            failure_reason      TEXT,
            latency_ms          INTEGER,
            decision            TEXT NOT NULL,
            sequence_index      INTEGER NOT NULL,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(trace_id, sequence_index),
            CHECK (decision IN ('success', 'fallback', 'retry', 'abort'))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_provider_routing_trace "
        "ON provider_routing_attempts(trace_id, sequence_index)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_provider_routing_provider_time "
        "ON provider_routing_attempts(attempted_provider, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_provider_routing_org_time "
        "ON provider_routing_attempts(org_id, created_at DESC) "
        "WHERE decision IN ('fallback', 'abort')"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_provider_routing_org_time")
    op.execute("DROP INDEX IF EXISTS idx_provider_routing_provider_time")
    op.execute("DROP INDEX IF EXISTS idx_provider_routing_trace")
    op.execute("DROP TABLE IF EXISTS provider_routing_attempts")
