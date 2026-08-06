"""151 — append-only event log for improvement_plans (FEAT-30 / N23).

Revision ID: 151_improvement_plan_events
Revises: 150_pagerduty_integration
Create Date: 2026-08-05

FEAT-30 gap 3: Loop 2 plan status history was derived from mutable
``improvement_plans`` fields only (no append-only trail) — the portal's
``PlanStatusHistory`` panel said so explicitly. This adds a minimal
event-emission-on-status-change table, mirroring the
``automation_runs`` pattern (migration 102 — ``id, org_id, <parent>_id,
status/payload jsonb, created_at``, no ``user_id`` FK so
system/agent-initiated transitions can be recorded, not just
admin-initiated ones like ``org_audit_log`` requires).

``eden.improvement.plans_repo.emit_event`` writes one row per lifecycle
transition (created / approved / rejected / snoozed / pr_opened /
merged / closed); best-effort, never blocks the state transition it
documents.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "151_improvement_plan_events"
down_revision: str | Sequence[str] | None = "150_pagerduty_integration"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS improvement_plan_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            plan_id UUID NOT NULL REFERENCES improvement_plans(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            actor TEXT,
            detail TEXT,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS improvement_plan_events_plan_idx
        ON improvement_plan_events (org_id, plan_id, created_at)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS improvement_plan_events")
