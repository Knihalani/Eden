"""071 — trace_reasoning_reports (per-trace Phase 9 reasoning composite).

Revision ID: 071
Revises: 070
Create Date: 2026-06-29

Per-trace reasoning quality report. The Phase 9 scorer computes
4 metrics (coherence, informativeness, goal alignment, verification)
plus a Lanham Trap Guard capped composite. Holds:
  * The 4 metrics (each REAL, in [0, 1]).
  * ``calibration_error`` (the inverse calibration component).
  * ``composite`` (Lanham-capped): 0.30·coh + 0.20·info + 0.20·goal
    + 0.15·ver + 0.15·(1 - calib), capped at 0.70 when
    verification < 0.10.

Indexes:
  * ``(tenant_id, trace_id, created_at DESC)`` — drives the
    ``GET /v1/traces/{trace_id}/reasoning`` route.
  * partial ``(tenant_id) WHERE composite < 0.5`` — drives the
    "low-reasoning" dashboard slice.

Idempotent.
"""

from alembic import op

revision = "071"
down_revision = "070"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_reasoning_reports (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            coherence REAL,
            informativeness REAL,
            goal_alignment REAL,
            verification REAL,
            calibration_error REAL,
            composite REAL,
            lanham_trap BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT trace_reasoning_reports_score_range_chk
                CHECK (
                    (coherence IS NULL
                     OR (coherence >= 0 AND coherence <= 1))
                    AND (informativeness IS NULL
                         OR (informativeness >= 0
                             AND informativeness <= 1))
                    AND (goal_alignment IS NULL
                         OR (goal_alignment >= 0
                             AND goal_alignment <= 1))
                    AND (verification IS NULL
                         OR (verification >= 0
                             AND verification <= 1))
                    AND (calibration_error IS NULL
                         OR (calibration_error >= 0
                             AND calibration_error <= 1))
                    AND (composite IS NULL
                         OR (composite >= 0 AND composite <= 1))
                )
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_reasoning_reports_tenant_trace "
        "ON trace_reasoning_reports (tenant_id, trace_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_reasoning_reports_low_composite "
        "ON trace_reasoning_reports (tenant_id) WHERE composite < 0.5"
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS idx_trace_reasoning_reports_low_composite"
    )
    op.execute(
        "DROP INDEX IF EXISTS idx_trace_reasoning_reports_tenant_trace"
    )
    op.execute("DROP TABLE IF EXISTS trace_reasoning_reports")
