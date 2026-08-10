"""163 — loop_events_outbox becomes the primary closed-loop queue (N5).

Revision ID: 163_loop_events_outbox_primary
Revises: 162_dataset_items_split
Create Date: 2026-08-10

N5: Postgres outbox replaces Redis XREADGROUP for the closed-loop path.
The outbox was the durable *fallback* (migration 135); now it is the
queue. ``publish()`` always inserts here, the consumer polls it with
``drained_at`` as the per-row watermark, and Redis is removed from the
closed-loop data path entirely.

Three additive columns serve the new semantics:

* ``idempotency_key`` — ``{issue_id}:{type}:{ref}`` from
  ``LoopEvent.idempotency_key()``. The partial unique index below makes
  a re-publish of an event that is still *pending* a no-op
  (``ON CONFLICT ... DO NOTHING``), replacing the Redis ``loop:idem:*``
  SET NX guard without keeping Redis in the path. Once a row is drained
  (``drained_at`` set) the constraint releases, so a genuinely new
  lifecycle with the same key can queue again.
* ``attempts`` — consecutive failed deliveries; the drain marks the row
  dead-lettered (ERROR log + drained_at stamp) after ``_MAX_DELIVERIES``,
  replacing the Redis ``loop:fail:*`` INCR counters.
* ``last_error`` — most recent handler failure text, for observability.

Raw SQL with ``IF NOT EXISTS`` so a half-migrated DB recovers with
``alembic upgrade head`` (same idempotency lesson as 077/133/135).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "163_loop_events_outbox_primary"
down_revision: str | Sequence[str] | None = "162_dataset_items_split"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE loop_events_outbox "
        "ADD COLUMN IF NOT EXISTS idempotency_key TEXT"
    )
    op.execute(
        "ALTER TABLE loop_events_outbox "
        "ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE loop_events_outbox "
        "ADD COLUMN IF NOT EXISTS last_error TEXT"
    )
    # Backfill idempotency keys for rows written before this migration.
    op.execute(
        """
        UPDATE loop_events_outbox
        SET idempotency_key = COALESCE(event->>'issue_id', '')
            || ':' || COALESCE(event->>'type', '')
            || ':' || COALESCE(event->>'ref', '')
        WHERE idempotency_key IS NULL
        """
    )
    # Dedupe only *pending* events: an undrained row with the same key
    # suppresses re-publish; once drained, the key is free again.
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_outbox_pending_key
        ON loop_events_outbox (idempotency_key)
        WHERE drained_at IS NULL
        """
    )
    # Drain scans WHERE drained_at IS NULL ORDER BY id; the partial index
    # above covers that predicate, so a separate btree is not needed.


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_loop_outbox_pending_key")
    op.execute("ALTER TABLE loop_events_outbox DROP COLUMN IF EXISTS last_error")
    op.execute("ALTER TABLE loop_events_outbox DROP COLUMN IF EXISTS attempts")
    op.execute("ALTER TABLE loop_events_outbox DROP COLUMN IF EXISTS idempotency_key")
