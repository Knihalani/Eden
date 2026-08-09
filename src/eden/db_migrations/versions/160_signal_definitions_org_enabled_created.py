"""160 — partial index for signal_definitions enabled-list path (OPT-42).

Revision ID: 160_signal_definitions_org_enabled_created
Revises: 159_nl_alert_rules_severity
Create Date: 2026-08-06

``signal_definitions`` (migration 092) has a PK on ``id`` and a later
unique index on ``(org_id, template_id)`` (097). Neither covers the
live investigator read shape in ``signals/investigator.py``:

  ``WHERE org_id = $1 AND enabled = TRUE [AND id = $2]
    ORDER BY created_at ASC LIMIT 20``

Add a partial index on ``(org_id, created_at ASC) WHERE enabled = TRUE``
so the common "list enabled defs for org, oldest first" scan avoids a
seq scan as the table grows. Additive, zero downtime; definitions are
created rarely / manually so ``CREATE INDEX IF NOT EXISTS`` never
blocks ingest.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "160_signal_definitions_org_enabled_created"
down_revision: str | Sequence[str] | None = "159_nl_alert_rules_severity"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_definitions_org_enabled_created "
        "ON signal_definitions (org_id, created_at ASC) "
        "WHERE enabled = TRUE"
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS idx_signal_definitions_org_enabled_created"
    )
