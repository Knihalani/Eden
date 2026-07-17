"""107 — Customer CostEvent ledger + FinOps alert thresholds (SOTA W7/W8).

Revision ID: 107_customer_cost_events
Revises: 106_filterbar_indexes
Create Date: 2026-07-17

* ``customer_cost_events`` — durable org-scoped LLM cost attribution
  (feature, model, tokens, cost_usd, optional trace/agent/session).
* ``budgets.alert_thresholds`` — JSONB list of percent thresholds
  (default [50, 80, 100]) for customer FinOps alerts.
* ``feature_kill_switches`` — customer-facing feature kill matrix
  (org_id, feature_key, enabled).

Additive-only. Forward-compat: yes.
"""

from __future__ import annotations

from alembic import op

revision: str = "107_customer_cost_events"
down_revision: str = "106_filterbar_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_cost_events (
            id              UUID PRIMARY KEY,
            org_id          VARCHAR(128) NOT NULL,
            feature         VARCHAR(64) NOT NULL DEFAULT 'unknown',
            model           VARCHAR(256) NOT NULL DEFAULT 'unknown',
            cost_usd        DOUBLE PRECISION NOT NULL DEFAULT 0,
            input_tokens    INT NOT NULL DEFAULT 0,
            output_tokens   INT NOT NULL DEFAULT 0,
            total_tokens    INT NOT NULL DEFAULT 0,
            request_id      VARCHAR(128),
            trace_id        VARCHAR(128),
            agent_id        VARCHAR(128),
            session_id      VARCHAR(128),
            user_id         VARCHAR(128),
            metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
            recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_customer_cost_events_org_time
        ON customer_cost_events (org_id, recorded_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_customer_cost_events_org_feature
        ON customer_cost_events (org_id, feature, recorded_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_customer_cost_events_org_model
        ON customer_cost_events (org_id, model, recorded_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_customer_cost_events_trace
        ON customer_cost_events (org_id, trace_id)
        WHERE trace_id IS NOT NULL
        """
    )

    # budgets may be missing if 052 was stamped without applying.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS budgets (
            id                            VARCHAR(64) PRIMARY KEY,
            org_id                        VARCHAR(128) NOT NULL,
            "window"                      VARCHAR(16) NOT NULL DEFAULT 'monthly',
            cost_soft_limit_usd           DOUBLE PRECISION NOT NULL DEFAULT 0.80,
            cost_hard_limit_usd           DOUBLE PRECISION NOT NULL DEFAULT 1.00,
            enforcement_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
            action_on_exceed              VARCHAR(16) NOT NULL DEFAULT 'throttle',
            threshold_alert_pct           INT NOT NULL DEFAULT 80,
            created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        ALTER TABLE budgets
        ADD COLUMN IF NOT EXISTS alert_thresholds JSONB
            NOT NULL DEFAULT '[50, 80, 100]'::jsonb
        """
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS feature_kill_switches (
            org_id          VARCHAR(128) NOT NULL,
            feature_key     VARCHAR(64) NOT NULL,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by      VARCHAR(128),
            PRIMARY KEY (org_id, feature_key)
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS feature_kill_switches")
    op.execute(
        "ALTER TABLE budgets DROP COLUMN IF EXISTS alert_thresholds"
    )
    op.execute("DROP INDEX IF EXISTS idx_customer_cost_events_trace")
    op.execute("DROP INDEX IF EXISTS idx_customer_cost_events_org_model")
    op.execute("DROP INDEX IF EXISTS idx_customer_cost_events_org_feature")
    op.execute("DROP INDEX IF EXISTS idx_customer_cost_events_org_time")
    op.execute("DROP TABLE IF EXISTS customer_cost_events")
