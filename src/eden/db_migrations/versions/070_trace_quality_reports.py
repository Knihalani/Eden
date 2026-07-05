"""070 — trace_quality_reports (per-trace hallucination stack).

Revision ID: 070
Revises: 069
Create Date: 2026-06-29

Per-trace Phase 5 quality stack report. Written by the sidecar
worker. The 4-model stack (numeric guard + DistilBERT-MNLI +
MiniCheck-RoBERTa + MiniLM cross-encoder) runs on the trace's
final LLM response. Holds:
  * ``hallucination_score`` (0-1; >0.5 = block).
  * ``groundedness`` (0-1).
  * ``tool_relevance`` (0-1; from cross-encoder).
  * ``step_coherence`` (0-1; from cross-step NLI proxy).
  * ``components`` JSONB dict of per-model contributions.
  * ``verdict`` (allow/warn/block).

Indexes:
  * ``(tenant_id, trace_id, created_at DESC)`` — drives the
    ``GET /v1/traces/{trace_id}/quality`` route.
  * partial ``(tenant_id, verdict) WHERE verdict = 'block'``.

Idempotent.
"""

from alembic import op

revision = "070"
down_revision = "069"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_quality_reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            hallucination_score REAL,
            groundedness REAL,
            tool_relevance REAL,
            step_coherence REAL,
            components JSONB NOT NULL DEFAULT '{}'::jsonb,
            verdict VARCHAR(16) NOT NULL DEFAULT 'allow',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT trace_quality_reports_verdict_chk
                CHECK (verdict IN ('allow','warn','block','manual_review')),
            CONSTRAINT trace_quality_reports_score_range_chk
                CHECK (
                    (hallucination_score IS NULL
                     OR (hallucination_score >= 0
                         AND hallucination_score <= 1))
                    AND (groundedness IS NULL
                         OR (groundedness >= 0 AND groundedness <= 1))
                    AND (tool_relevance IS NULL
                         OR (tool_relevance >= 0 AND tool_relevance <= 1))
                    AND (step_coherence IS NULL
                         OR (step_coherence >= 0 AND step_coherence <= 1))
                )
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_quality_reports_tenant_trace "
        "ON trace_quality_reports (tenant_id, trace_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_quality_reports_block "
        "ON trace_quality_reports (tenant_id, verdict) "
        "WHERE verdict = 'block'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_trace_quality_reports_block")
    op.execute(
        "DROP INDEX IF EXISTS idx_trace_quality_reports_tenant_trace"
    )
    op.execute("DROP TABLE IF EXISTS trace_quality_reports")
