"""052_budgets — D.10 cost guardrails schema per upgradespec §D.10 / §B.3.

Revision ID: 052
Revises: 051
Create Date: 2026-06-24

Three new tables:

* ``budgets`` — per-org cost guardrail config. One row per
  (org_id, window). The middleware reads from this table to
  check the monthly / daily / per-request cap.

* ``budget_consumption`` — rolling aggregation of cost
  (USD) per (org_id, window_start). Updated on every
  gateway ingest. Reads are O(1) for the active window.

* ``budget_actions`` — append-only audit log of every
  threshold_breached / exceeded event the middleware
  fired. The portal renders the action history.

Conventions (per the v1.4 cat-ship pattern, mirrors
:file:`051_hook_events.py`):
* All tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.

The free-tier defaults are seeded in the upgrade() body so
a fresh database has a sensible budget without needing
admin UI clicks. Existing orgs default to ``enforcement_enabled=false``
per the spec's "feature flag default off for existing customers" rule.
"""

from __future__ import annotations

from alembic import op

revision = "052"
down_revision = "051"
branch_labels = None
depends_on = None


def _table(name: str, body: str, extra_index: str = "") -> None:
    op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
    op.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
        f"ON {name} (org_id, created_at DESC)"
    )
    if extra_index:
        op.execute(extra_index)


def upgrade() -> None:
    # ── 1. budgets — per-org guardrail config ─────────────────────
    _table(
        "budgets",
        """
        id                            VARCHAR(64) PRIMARY KEY,
        org_id                        VARCHAR(128) NOT NULL,
        window                        VARCHAR(16) NOT NULL DEFAULT 'monthly',
        cost_soft_limit_usd           DOUBLE PRECISION NOT NULL DEFAULT 0.80,
        cost_hard_limit_usd           DOUBLE PRECISION NOT NULL DEFAULT 1.00,
        enforcement_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
        action_on_exceed              VARCHAR(16) NOT NULL DEFAULT 'throttle',
        threshold_alert_pct           INT NOT NULL DEFAULT 80,
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_org_window "
        "ON budgets (org_id, window) "
        "WHERE enforcement_enabled = TRUE",
    )

    # ── 2. budget_consumption — rolling aggregation ───────────────
    _table(
        "budget_consumption",
        """
        id                    UUID PRIMARY KEY,
        org_id                VARCHAR(128) NOT NULL,
        window                VARCHAR(16) NOT NULL,
        window_start          TIMESTAMPTZ NOT NULL,
        window_end            TIMESTAMPTZ NOT NULL,
        cost_usd              DOUBLE PRECISION NOT NULL DEFAULT 0.0,
        requests_count        BIGINT NOT NULL DEFAULT 0,
        last_request_at       TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_consumption_active "
        "ON budget_consumption (org_id, window, window_start) "
        "WHERE window_end > NOW()",
    )

    # ── 3. budget_actions — append-only audit log ─────────────────
    _table(
        "budget_actions",
        """
        id                UUID PRIMARY KEY,
        org_id            VARCHAR(128) NOT NULL,
        budget_id         VARCHAR(64) NOT NULL,
        action_type       VARCHAR(32) NOT NULL,
        severity          VARCHAR(16) NOT NULL DEFAULT 'medium',
        cost_at_action    DOUBLE PRECISION NOT NULL,
        threshold_pct     INT NOT NULL,
        action_taken      VARCHAR(32) NOT NULL,
        request_id        VARCHAR(128),
        hook_event_id     VARCHAR(64),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_budget_actions_type "
        "ON budget_actions (org_id, action_type, created_at DESC)",
    )


def downgrade() -> None:
    for table in (
        "budget_actions",
        "budget_consumption",
        "budgets",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table}")