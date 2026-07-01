"""069 — trace_loop_reports (per-trace loop ensemble verdict).

Revision ID: 069
Revises: 068
Create Date: 2026-06-29

Per-trace LoopDetector ensemble report. Written by the sidecar
worker after the 4-detector ensemble (hash ring + Jaccard
shingles + semantic cosine + consecutive-novelty) fires. Holds:
  * ``verdict`` (OK/LOOP) — ensemble-level decision.
  * ``detectors_tripped`` JSONB array of detector names.
  * ``severity`` (low/medium/high) — for the dashboard filter.
  * ``action`` (allow/block/escalate) — mapped from verdict.

Indexes:
  * ``(tenant_id, trace_id, created_at DESC)`` — drives the
    ``GET /v1/traces/{trace_id}/loops`` route.
  * partial ``(tenant_id, severity) WHERE severity = 'high'`` —
    drives the operator inbox.
  * partial ``(tenant_id, verdict) WHERE verdict = 'LOOP'`` —
    drives the loop dashboard.

Idempotent.
"""

from alembic import op

revision = "069"
down_revision = "068"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_loop_reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            verdict VARCHAR(8) NOT NULL DEFAULT 'OK',
            detectors_tripped JSONB NOT NULL DEFAULT '[]'::jsonb,
            severity VARCHAR(8) NOT NULL DEFAULT 'low',
            action VARCHAR(16) NOT NULL DEFAULT 'allow',
            max_cosine REAL,
            max_jaccard REAL,
            step_index INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT trace_loop_reports_verdict_chk
                CHECK (verdict IN ('OK','LOOP')),
            CONSTRAINT trace_loop_reports_severity_chk
                CHECK (severity IN ('low','medium','high')),
            CONSTRAINT trace_loop_reports_action_chk
                CHECK (action IN ('allow','block','escalate'))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_loop_reports_tenant_trace "
        "ON trace_loop_reports (tenant_id, trace_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_loop_reports_high_severity "
        "ON trace_loop_reports (tenant_id, severity) "
        "WHERE severity = 'high'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_loop_reports_loop_verdict "
        "ON trace_loop_reports (tenant_id, verdict) "
        "WHERE verdict = 'LOOP'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_trace_loop_reports_loop_verdict")
    op.execute("DROP INDEX IF EXISTS idx_trace_loop_reports_high_severity")
    op.execute("DROP INDEX IF EXISTS idx_trace_loop_reports_tenant_trace")
    op.execute("DROP TABLE IF EXISTS trace_loop_reports")