"""073 — tenant_guardrail_action_config (per-tenant per-action kill switch).

Revision ID: 073
Revises: 072
Create Date: 2026-06-29

Per-tenant per-action kill-switch state. One row per
(tenant_id, action_class). The TrajectoryGuardrail hot path
reads this row before applying any mutating side effect.

Defaults (mirrored from ``Settings.default_action_applied_flag``
in ``src/eden/config.py``):
  * Read-only actions default ``applied_by_default = TRUE``:
    record_to_table, emit_audit_event, emit_drift_alert,
    rewrite_response, coalesce_step.
  * Mutating actions default ``applied_by_default = FALSE``:
    truncate_context, block_user, escalate_to_admin,
    revoke_api_key, apply_policy_change.

Operators flip via ``POST /v1/admin/guardrails/{action_class}/enable``
or ``/disable``. The route layer enforces ``require_org_admin``.

Idempotent. Migration 073 seeds one row per
(tenant_id, action_class) at migration time using
``Settings.default_action_applied_flag``. Tenants are read from
the existing ``tenants`` (or ``orgs``) table.

Idempotent.
"""

from alembic import op

revision = "073"
down_revision = "072"
branch_labels = None
depends_on = None


# ponytail: keep the two lists aligned with the
# Settings.default_action_applied_flag dict. The action-class
# CHECK constraint also re-uses these strings.
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
_READ_ONLY = {
    "record_to_table": True,
    "emit_audit_event": True,
    "emit_drift_alert": True,
    "rewrite_response": True,
    "coalesce_step": True,
    "truncate_context": False,
    "block_user": False,
    "escalate_to_admin": False,
    "revoke_api_key": False,
    "apply_policy_change": False,
}


def upgrade() -> None:
    enum_sql = "', '".join(ACTION_CLASSES)
    op.execute(
        f"""
        CREATE TABLE IF NOT EXISTS tenant_guardrail_action_config (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id VARCHAR(128) NOT NULL,
            action_class VARCHAR(32) NOT NULL,
            applied_by_default BOOLEAN NOT NULL,
            updated_by VARCHAR(128),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT tenant_guardrail_action_config_class_chk
                CHECK (action_class IN ('{enum_sql}')),
            CONSTRAINT tenant_guardrail_action_config_uq
                UNIQUE (tenant_id, action_class)
        )
        """
    )
    # Per-action partial index — drives the hot-path read on every
    # trajectory step.
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_tenant_guardrail_action_config_lookup "
        "ON tenant_guardrail_action_config "
        "(tenant_id, action_class) INCLUDE (applied_by_default)"
    )
    # Seed defaults from any pre-existing tenant rows. The
    # tenanted_orgs table is the canonical tenant registry;
    # fall back to ``tenants`` if it doesn't exist.
    # Audit 2026-07-03 — wrap the parametrised probe in ``text(...)``
    # so the sync psycopg2 engine accepts it; the pre-fix raw string
    # worked with asyncpg but raised ``Not an executable object`` on
    # the sync path.
    from sqlalchemy import text

    for table in ("tenanted_orgs", "tenants", "orgs"):
        # ponytail: existence probe via to_regclass so the
        # seed step is no-op when the tenant table is missing.
        exists = op.get_bind().execute(
            text("SELECT 1 FROM pg_class WHERE relname = :t"),
            {"t": table},
        ).fetchone()
        if not exists:
            continue
        for action_class, default in _READ_ONLY.items():
            op.execute(
                text(
                    f"""
                    INSERT INTO tenant_guardrail_action_config
                        (tenant_id, action_class, applied_by_default)
                    SELECT id, :action, :default
                    FROM {table}
                    ON CONFLICT (tenant_id, action_class) DO NOTHING
                    """
                ),
                {"action": action_class, "default": default},
            )
        break  # seed from first existing tenant table


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS "
        "idx_tenant_guardrail_action_config_lookup"
    )
    op.execute(
        "DROP TABLE IF EXISTS tenant_guardrail_action_config"
    )