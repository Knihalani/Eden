"""135 — webhook_deliveries.last_attempt_at (prod outbox reclaim).

Revision ID: 135_webhook_deliveries_last_attempt
Revises: 134_budget_enforcement_default_true
Create Date: 2026-08-03

``webhook_delivery._attempt_delivery`` stamps ``last_attempt_at`` and
``process_pending_deliveries`` reclaims stale ``in_flight`` rows by that
column. Migration 053 only added ``last_attempt_at`` on ``webhook_dlq``,
not on ``webhook_deliveries`` — so every outbox tick on prod logged
``column "last_attempt_at" does not exist`` and reclaim/claim failed.

Also documents that org feature flags live in ``organizations.settings``
(``features`` was never added to organizations; 007 put it on org_plans).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "135_webhook_deliveries_last_attempt"
down_revision: str | Sequence[str] | None = "134_budget_enforcement_default_true"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE webhook_deliveries
        ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_in_flight_attempt
        ON webhook_deliveries (last_attempt_at)
        WHERE status = 'in_flight'
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS idx_webhook_deliveries_in_flight_attempt"
    )
    op.execute(
        "ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS last_attempt_at"
    )
