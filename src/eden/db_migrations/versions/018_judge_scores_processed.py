"""018_judge_scores_processed — Watermark for the insights detector loop.

Revision ID: 018
Revises: 017
Create Date: 2026-06-08

Adds the ``judge_scores_processed`` watermark table that the periodic
insights detector loop (Phase 7.1b follow-up) uses to make the
``judge_scores`` → ``InsightsService`` flow exactly-once-ish.

The detector registry's six detectors are REAL implementations, but
nothing periodically read new ``judge_scores`` rows, fanned them
through ``DetectorRegistry.run_all``, and persisted ``Insight``
objects. The new background task in
``src/eden/insights/detector_loop.py`` consults this watermark
before each tick:

  1. Read the last ``last_processed_judge_score_id`` we touched.
  2. SELECT new ``judge_scores`` rows whose ``judge_run_id`` is
     greater than that watermark, ordered by ``judge_run_id`` ASC
     (or ``scored_at`` ASC when no watermark exists yet).
  3. Convert each row into an ``Insight`` (the ``JudgeDetector``
     virtual detector owns the conversion; the loop only does
     I/O).
  4. Persist the resulting ``Insight`` objects via
     ``InsightsService.persist_insight_to_postgres`` (migration
     019 owns the ``insights`` table; that table also exists
     here, but the loop only references it through
     ``InsightsService``).
  5. Update the watermark to the highest ``judge_run_id`` we
     successfully processed.

Why a table and not in-process state?  The loop runs in the API
process; on restart we need to resume from the last successful
tick so we don't re-emit Insights for rows we already converted.
The single-row-per-tenant table makes a single
``INSERT ... ON CONFLICT (tenant_id) DO UPDATE`` atomic and
exactly-once for a single tenant.

The migration is idempotent (CREATE TABLE IF NOT EXISTS, CREATE
INDEX IF NOT EXISTS) so a hot-restart against a partially-applied
DB is safe.

Notes:
  * ``tenant_id`` is the natural key; we keep one watermark row
    per tenant so a noisy tenant can't starve quieter ones
    (they advance independently).
  * ``last_processed_judge_score_id`` is a UUID. We rely on UUIDv4
    monotonicity being "good enough" — Postgres doesn't guarantee
    ordering of random UUIDs, so the loop also falls back to
    ``scored_at`` ASC when no row is found by UUID. The UUID is
    the primary key in the table anyway.
  * ``updated_at`` is for audit / dashboards; the loop never
    uses it for ordering.
"""

from alembic import op

revision = "018"
down_revision = "017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS judge_scores_processed (
            tenant_id                     VARCHAR(128) PRIMARY KEY,
            last_processed_judge_score_id UUID,
            updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_jsp_updated_at
        ON judge_scores_processed (updated_at DESC)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_jsp_updated_at")
    op.execute("DROP TABLE IF EXISTS judge_scores_processed")
