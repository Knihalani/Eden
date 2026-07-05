"""068 — trace_efficiency_reports (per-trace ETEC composite).

Revision ID: 068
Revises: 067
Create Date: 2026-06-29

Per-trace Eden Trace-Efficiency Composite (ETEC) report. Written
by the sidecar worker on every ``span.end`` for a trace. The
report holds:
  * 10 ETEC metrics in a JSONB blob (SRR, LDI, TCA, CCE, RDA,
    ISR, OBS, LHP, VHP, CCR) — see spec §3.
  * ``tas`` (0-100), ``avs``, ``vae`` derived scores.
  * ``grade`` (CHECK constraint A-F), ``intervention``
    (allow/warn/redact/block/escalate).
  * ``fix_patches`` JSONB array of recommended text fixes.
  * ``created_at`` for the dashboard query path.

Indexes:
  * ``(tenant_id, trace_id, created_at DESC)`` — drives the
    ``GET /v1/traces/{trace_id}/efficiency`` route.
  * partial ``(tenant_id, grade) WHERE grade IN ('D','F')`` —
    drives the "low-TAS" dashboard slice; only the bad rows.
  * partial ``(tenant_id, intervention) WHERE intervention IN
    ('block','escalate')`` — drives the operator inbox.

Backfill SQL: sidecar worker writes one row per trace; no
ad-hoc backfill needed.

Idempotent: ``alembic upgrade head && alembic downgrade -1 &&
alembic upgrade head`` is clean.
"""

from alembic import op

revision = "068"
down_revision = "067"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_efficiency_reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
            tas INTEGER,
            avs INTEGER,
            vae INTEGER,
            grade VARCHAR(2),
            intervention VARCHAR(16) NOT NULL DEFAULT 'allow',
            fix_patches JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT trace_efficiency_reports_grade_chk
                CHECK (grade IS NULL OR grade IN ('A','B','C','D','F')),
            CONSTRAINT trace_efficiency_reports_intervention_chk
                CHECK (intervention IN
                       ('allow','warn','redact','block','escalate')),
            CONSTRAINT trace_efficiency_reports_tas_range_chk
                CHECK (tas IS NULL OR (tas >= 0 AND tas <= 100))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_efficiency_reports_tenant_trace "
        "ON trace_efficiency_reports (tenant_id, trace_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_efficiency_reports_low_grade "
        "ON trace_efficiency_reports (tenant_id, grade) "
        "WHERE grade IN ('D','F')"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_efficiency_reports_block "
        "ON trace_efficiency_reports (tenant_id, intervention) "
        "WHERE intervention IN ('block','escalate')"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_trace_efficiency_reports_block")
    op.execute("DROP INDEX IF EXISTS idx_trace_efficiency_reports_low_grade")
    op.execute("DROP INDEX IF EXISTS idx_trace_efficiency_reports_tenant_trace")
    op.execute("DROP TABLE IF EXISTS trace_efficiency_reports")
