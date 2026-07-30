"""122 — judge_scores_processed: a cursor that actually orders.

The insights detector loop paginated ``judge_scores`` with

    WHERE tenant_id = $1 AND judge_run_id > $2
    ORDER BY scored_at ASC
    LIMIT $3

and then advanced the watermark to ``max(judge_run_id)`` from the batch.

``judge_run_id`` is a **UUID** (migration 018). It carries no time ordering, so
the filter column and the sort column were unrelated: the loop selected the
oldest-scored rows whose random id happened to exceed a random watermark, then
ratcheted the watermark to the largest random id it had seen.

Every row whose ``judge_run_id`` sorts below that value became permanently
invisible. Roughly half the stream was skipped after the first tick, and as the
watermark climbed toward ``ffff…`` the proportion approached everything — a
pipeline that goes quiet rather than failing, so nothing reported it. Judge
scores stopped becoming insights and no error was ever raised.

This migration adds the second half of a real keyset cursor
(``last_processed_scored_at``) so the loop can order and filter on the same
tuple, ``(scored_at, judge_run_id)``, plus the composite index that keyset needs
to stay a range scan.

Existing watermark values are meaningless under the new scheme — a random UUID
with no companion timestamp — so they are reset. That makes the next tick
re-read each tenant's history from the beginning and pick up everything the old
cursor skipped. Re-processing is safe: insight persistence is keyed on the
insight's own id, so replayed rows collapse onto the rows they already wrote.

Revision ID: 122_judge_watermark_composite
Revises: 121_leader_leases
Create Date: 2026-07-29
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "122_judge_watermark_composite"
down_revision: str | Sequence[str] | None = "121_leader_leases"
branch_labels = None
depends_on = None


def _table_exists(name: str) -> bool:
    """True when ``name`` exists in the current schema."""
    bind = op.get_bind()
    return bool(
        bind.exec_driver_sql(
            "SELECT 1 FROM information_schema.tables "
            f"WHERE table_schema = current_schema() AND table_name = '{name}'"
        ).scalar()
    )


def upgrade() -> None:
    if not _table_exists("judge_scores_processed"):
        # Migration 018 never ran on this database; nothing to widen.
        return

    op.execute(
        """
        ALTER TABLE judge_scores_processed
        ADD COLUMN IF NOT EXISTS last_processed_scored_at TIMESTAMPTZ
        """
    )

    # Reset the corrupt cursors so the skipped history is re-read. Both halves
    # must go: a UUID without its timestamp cannot seed a composite keyset.
    #
    # Scoped to rows that still lack the timestamp, which is exactly the set
    # written before this migration. Unconditional, this UPDATE is destructive
    # on any re-run — a ``downgrade 121`` / ``upgrade`` cycle, or a re-stamp,
    # would wipe every tenant's *valid* composite cursor and force a full replay
    # of judge_scores history for the whole fleet. ``IF NOT EXISTS`` above makes
    # the DDL idempotent; the DML has to be too.
    op.execute(
        """
        UPDATE judge_scores_processed
           SET last_processed_judge_score_id = NULL,
               last_processed_scored_at = NULL
         WHERE last_processed_scored_at IS NULL
        """
    )

    if _table_exists("judge_scores"):
        # The keyset predicate is ``(scored_at, judge_run_id) > ($2, $3)``
        # within a tenant. Without this index that is a full scan per tick.
        op.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_judge_scores_tenant_keyset
            ON judge_scores (tenant_id, scored_at, judge_run_id)
            """
        )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_judge_scores_tenant_keyset")
    if _table_exists("judge_scores_processed"):
        op.execute(
            """
            ALTER TABLE judge_scores_processed
            DROP COLUMN IF EXISTS last_processed_scored_at
            """
        )
