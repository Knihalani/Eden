"""159 — persist severity on nl_alert_rules (FEAT-102).

Revision ID: 159_nl_alert_rules_severity
Revises: 158_alert_suppression_rules
Create Date: 2026-08-06

``nl_alert_rules`` had no severity column — only the bridged
``eql_alert_rules`` row stored info|warning|high|critical. The portal
therefore hard-coded ``severity="warn"`` on every rule card. Add the
column (matching ``alert_events.severity`` conventions), backfill from
``eql_alert_rules`` by ``(org_id, name)`` where a bridge row exists,
and leave unmatched rows at the default ``warning``.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "159_nl_alert_rules_severity"
down_revision: str | Sequence[str] | None = "158_alert_suppression_rules"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE nl_alert_rules
        ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'warning'
        """
    )
    # Prefer the bridged EQL severity when the row already exists
    # (same name + org as create_nl_alert_rule + AlertAsCode.compile).
    # org_id types differ (UUID vs VARCHAR) — compare as text.
    op.execute(
        """
        UPDATE nl_alert_rules AS n
        SET severity = e.severity
        FROM eql_alert_rules AS e
        WHERE n.org_id::text = e.org_id::text
          AND n.name = e.name
          AND lower(e.severity) IN ('info', 'warning', 'high', 'critical')
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE nl_alert_rules DROP COLUMN IF EXISTS severity"
    )
