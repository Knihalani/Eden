"""010_judge_scores — Phase 7.1b LLM-as-judge storage.

Revision ID: 010
Revises: 008
Create Date: 2026-06-04

Tables added:
- judge_scores        : one row per (event, judge, invocation). Append-only
                       history — every judge run is recorded even if
                       a later run for the same (event, judge) overwrites
                       the score (we keep all runs for audit).

The migration is intentionally ``judge_run_id``-PK'd (UUID) rather
than a composite natural key. Customer code can de-dupe by
``(trace_id, span_id, judge_name, judge_version, scored_at)`` if
needed; the surrogate key keeps writes append-only and avoids
hot-row updates on re-scoring.
"""

from alembic import op

revision = "010"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS judge_scores (
            judge_run_id     UUID PRIMARY KEY,
            tenant_id        VARCHAR(128) NOT NULL,
            trace_id         VARCHAR(128) NOT NULL,
            span_id          VARCHAR(64),
            judge_name       VARCHAR(64) NOT NULL,
            judge_version    VARCHAR(32) NOT NULL,
            score            DOUBLE PRECISION NOT NULL,
            rationale        TEXT,
            model            VARCHAR(128) NOT NULL,
            scored_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            latency_ms       DOUBLE PRECISION,
            source_event_id  VARCHAR(128)
        )
    """)

    # Per-trace query path (the timeline / scores UI).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_judge_scores_tenant_trace
        ON judge_scores (tenant_id, trace_id)
    """)

    # Per-judge time-series (dashboards, regressions).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_judge_scores_judge_name
        ON judge_scores (judge_name, scored_at DESC)
    """)

    # Per-tenant per-judge score distribution (alerting + insights).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_judge_scores_tenant_judge_score
        ON judge_scores (tenant_id, judge_name, score)
    """)

    # Source-event lookup (so a future "explain why this score" UI can
    # join back to the telemetry_events row).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_judge_scores_source_event
        ON judge_scores (source_event_id)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_judge_scores_source_event")
    op.execute("DROP INDEX IF EXISTS idx_judge_scores_tenant_judge_score")
    op.execute("DROP INDEX IF EXISTS idx_judge_scores_judge_name")
    op.execute("DROP INDEX IF EXISTS idx_judge_scores_tenant_trace")
    op.execute("DROP TABLE IF EXISTS judge_scores")
