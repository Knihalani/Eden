"""065 — add ``judge_scores.cost_usd`` and ``judge_scores.cached`` (C-9 fix)

Revision ID: 065
Revises: 064
Create Date: 2026-06-28

C-9 audit: ``judge_scores`` recorded latency_ms but never
``cost_usd`` or the cached/hit flag. Without these, the
``/observability/judges`` dashboard can't show the spend per
judge, and the per-tenant judge cost (which feeds
``BudgetService.record_usage`` via the C-15 audit path) was
silently zero. Result: judges ran but their cost never reached
the budget ledger.

Two additive columns, both NULLABLE so the upgrade is safe on a
table with existing rows:

* ``cost_usd NUMERIC(12, 8)`` — real cost from
  ``OpenRouterClient.usage.cost`` (same shape as
  ``usage_events.cost_usd``). Default 0.
* ``cached BOOLEAN NOT NULL DEFAULT FALSE`` — true when the
  judge prompt hit the semantic cache. Cheap to compute (the
  judge runner already passes the cache flag through the
  ``JudgeScore.metadata`` field), gives the dashboard a hit-rate
  column without a join.

The downgrade drops both columns. Same caveat as 064 — dropping
``cost_usd`` will break the C-15 ``record_usage`` path until
the column is re-added.
"""

from alembic import op

revision = "065"
down_revision = "064"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE judge_scores "
        "ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 8) NOT NULL DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE judge_scores "
        "ADD COLUMN IF NOT EXISTS cached BOOLEAN NOT NULL DEFAULT FALSE"
    )
    # Cheap partial index for dashboard queries that filter on
    # cached=FALSE (the non-cache-hit rows that drove spend).
    # Audit 2026-07-03 — asyncpg chokes on ``WHERE cached = FALSE``
    # in CREATE INDEX ("unrecognized node type: 0"); ``NOT cached``
    # is semantically identical and parses cleanly through asyncpg.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_judge_scores_uncached "
        "ON judge_scores (tenant_id, scored_at DESC) "
        "WHERE NOT cached"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_judge_scores_uncached")
    op.execute("ALTER TABLE judge_scores DROP COLUMN IF EXISTS cached")
    op.execute("ALTER TABLE judge_scores DROP COLUMN IF EXISTS cost_usd")
