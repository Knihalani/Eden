"""135 — loop_events_outbox durable fallback for the closed-loop bus.

Revision ID: 135_loop_events_outbox
Revises: 134_budget_enforcement_default_true
Create Date: 2026-08-02

Phase 1 of the autonomy overhaul (M2, D4): when Redis is unreachable,
``closed_loop.event_bus.publish`` falls back to inserting the event
into this table instead of silently dropping it. An idle chore in the
verify worker (and the consumer at startup) drains undrained rows back
onto the ``eden.loop.events`` stream oldest-first; downstream
idempotency (``loop:idem:*`` SET NX keys) makes replay safe.

Columns:
  * ``event`` — the exact XADD field dict (``LoopEvent.to_fields()``)
    as JSONB, so drain re-publishes byte-for-byte.
  * ``retry_after_ts`` — optional not-before gate; drain skips rows
    until it passes (M3's triage retry schedules through this).
  * ``drained_at`` — stamped once the row has been re-published; rows
    older than 7 days with this set are GC'd by the TTL chore.

Raw SQL ``CREATE TABLE IF NOT EXISTS`` / ``CREATE INDEX IF NOT EXISTS``
so a half-migrated DB recovers with ``alembic upgrade head`` (same
idempotency lesson as 077/133).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "135_loop_events_outbox"
down_revision: str | Sequence[str] | None = "134_budget_enforcement_default_true"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS loop_events_outbox (
            id BIGSERIAL PRIMARY KEY,
            org_id TEXT NOT NULL,
            event JSONB NOT NULL,
            retry_after_ts TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            drained_at TIMESTAMPTZ
        )
        """
    )
    # Drain scans WHERE drained_at IS NULL ordered oldest-first; the TTL
    # chore deletes old drained rows. One composite index serves both.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_loop_events_outbox_drained_created "
        "ON loop_events_outbox (drained_at, created_at)"
    )


def downgrade() -> None:
    op.drop_index(
        "idx_loop_events_outbox_drained_created",
        table_name="loop_events_outbox",
    )
    op.drop_table("loop_events_outbox")
