"""072 — trace_guardrail_actions (per-step action log + kill switch).

Revision ID: 072
Revises: 071
Create Date: 2026-06-29

Per-step guardrail action log. Written by the TrajectoryGuardrail
hot path on every recommendation. The action may or may not be
applied depending on the per-tenant kill switch
(``tenant_guardrail_action_config``, migration 073). Holds:
  * ``trace_id``, ``step_index``, ``agent_id``.
  * ``action_class`` — one of 10 cat-15-extended action classes
    (record_to_table, emit_audit_event, emit_drift_alert,
    rewrite_response, coalesce_step, truncate_context,
    block_user, escalate_to_admin, revoke_api_key,
    apply_policy_change).
  * ``recommended`` (bool), ``applied`` (bool), ``reason``.
  * ``kill_switch_state`` — applied_by_default at the time of
    the call (auditability).
  * ``payload`` JSONB (action-specific body).

Indexes:
  * ``(tenant_id, trace_id, step_index)`` — drives the
    ``GET /v1/traces/{trace_id}/guardrail_actions`` route.
  * partial ``(tenant_id, applied, action_class) WHERE
    applied = FALSE AND action_class IN
    ('block_user','escalate_to_admin','revoke_api_key',
     'apply_policy_change')`` — drives the operator pending queue.
  * ``(tenant_id, created_at DESC)`` — drives the audit log.

CHECK constraints:
  * action_class ∈ 10-class set
  * applied ∈ {TRUE, FALSE}
  * step_index ≥ 0

Idempotent.
"""

from alembic import op

revision = "072"
down_revision = "071"
branch_labels = None
depends_on = None


# ponytail: frozen action-class enum kept in code AND in the
# CHECK constraint so the DB enforces it. The set matches
# Settings.default_action_applied_flag.
ACTION_CLASSES = (
    "record_to_table",
    "emit_audit_event",
    "emit_drift_alert",
    "rewrite_response",
    "coalesce_step",
    "truncate_context",
    "block_user",
    "escalate_to_admin",
    "revoke_api_key",
    "apply_policy_change",
)
_MUTATING = (
    "truncate_context",
    "block_user",
    "escalate_to_admin",
    "revoke_api_key",
    "apply_policy_change",
)


def upgrade() -> None:
    enum_sql = "', '".join(ACTION_CLASSES)
    op.execute(
        f"""
        CREATE TABLE IF NOT EXISTS trace_guardrail_actions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            step_index INTEGER NOT NULL,
            agent_id VARCHAR(128),
            action_class VARCHAR(32) NOT NULL,
            recommended BOOLEAN NOT NULL DEFAULT TRUE,
            applied BOOLEAN NOT NULL DEFAULT FALSE,
            reason VARCHAR(512),
            kill_switch_state BOOLEAN,
            payload JSONB NOT NULL DEFAULT '{{}}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT trace_guardrail_actions_class_chk
                CHECK (action_class IN ('{enum_sql}')),
            CONSTRAINT trace_guardrail_actions_applied_chk
                CHECK (applied IN (TRUE, FALSE)),
            CONSTRAINT trace_guardrail_actions_step_chk
                CHECK (step_index >= 0)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_trace_guardrail_actions_tenant_trace_step "
        "ON trace_guardrail_actions "
        "(tenant_id, trace_id, step_index)"
    )
    mutating_sql = "', '".join(_MUTATING)
    op.execute(
        f"""
        CREATE INDEX IF NOT EXISTS
        idx_trace_guardrail_actions_pending_mutating
        ON trace_guardrail_actions (tenant_id, action_class, created_at DESC)
        WHERE applied = FALSE AND action_class IN ('{mutating_sql}')
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_trace_guardrail_actions_audit "
        "ON trace_guardrail_actions (tenant_id, created_at DESC)"
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS idx_trace_guardrail_actions_audit"
    )
    op.execute(
        "DROP INDEX IF EXISTS "
        "idx_trace_guardrail_actions_pending_mutating"
    )
    op.execute(
        "DROP INDEX IF EXISTS "
        "idx_trace_guardrail_actions_tenant_trace_step"
    )
    op.execute("DROP TABLE IF EXISTS trace_guardrail_actions")
