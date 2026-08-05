"""143 — composite indexes for signal_events' two real read paths (OPT-1).

Revision ID: 143_signal_events_indexes
Revises: 142_session_summaries
Create Date: 2026-08-05

``signal_events`` has shipped since 092_market_ready_consolidated with
exactly one index — a bare ``(trace_id)`` btree (``idx_signal_events_trace``)
— which serves neither of the table's two real read patterns:

  * ``list_signal_events`` (api/routes/signal_investigator.py) filters
    ``WHERE org_id = $1 AND signal_id = $2 [AND matched = $3]
    ORDER BY detected_at DESC``. ``matched`` is a bound parameter (not
    provable at plan time when present), so the base filter+sort needs
    a full composite index.
  * ``cluster_signal`` (signals/clusterer.py) filters
    ``WHERE org_id = $1 AND signal_id = $2 AND matched = TRUE
    AND detected_at >= $3 ORDER BY detected_at DESC LIMIT 500``.
    ``matched = TRUE`` is a hardcoded literal, so a partial index on
    that predicate applies and stays smaller than the full index.

Both indexes are additive, zero downtime, no backfill. No CONCURRENTLY
needed — ``signal_events`` is INSERT-only (event rows are never
updated), so a plain ``CREATE INDEX IF NOT EXISTS`` never blocks
inserts, matching the precedent set by every prior index added to this
table (e.g. 092's ``idx_signal_events_trace``, 142's session_summaries
indexes).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "143_signal_events_indexes"
down_revision: str | Sequence[str] | None = "142_session_summaries"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # list_signal_events: WHERE org_id = $1 AND signal_id = $2
    # [AND matched = $3] ORDER BY detected_at DESC. `matched` is a bound
    # parameter, so it's not provable at plan time — this full composite
    # index serves the base filter+sort regardless of whether `matched`
    # is passed.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_events_org_signal_detected "
        "ON signal_events (org_id, signal_id, detected_at DESC)"
    )
    # cluster_signal: WHERE org_id = $1 AND signal_id = $2 AND
    # matched = TRUE AND detected_at >= $3 ORDER BY detected_at DESC
    # LIMIT 500. `matched = TRUE` is a hardcoded literal, so a partial
    # index on that predicate applies and is smaller/cheaper than the
    # full index above.
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_signal_events_org_signal_matched_detected "
        "ON signal_events (org_id, signal_id, detected_at DESC) "
        "WHERE matched = TRUE"
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS idx_signal_events_org_signal_matched_detected"
    )
    op.execute("DROP INDEX IF EXISTS idx_signal_events_org_signal_detected")
