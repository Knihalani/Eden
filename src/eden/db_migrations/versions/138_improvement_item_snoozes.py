"""138 — durable snooze store for N17 cockpit queue items.

Revision ID: 138_improvement_item_snoozes
Revises: 137_guardian_followup_advisory
Create Date: 2026-08-03

Plan snooze already persists on ``improvement_plans.snoozed_until``
(migration 099). Queue cards that are not plans (issues, closed-loop
actions, Cat 23 proposed patches, nudges, …) previously only lived in
the process-local ``_SNOOZES`` dict in ``cockpit_aggregator``, so a
worker restart or multi-replica deploy forgot every item snooze.

This table is the durable mirror: one row per ``(org_id, item_ref)``
with an absolute ``snoozed_until``. Upserts go through
``snooze_item``; ``list_queue`` filters via ``active_snooze_refs``.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "138_improvement_item_snoozes"
down_revision: str | Sequence[str] | None = "137_guardian_followup_advisory"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS improvement_item_snoozes (
            org_id UUID NOT NULL
                REFERENCES organizations(id) ON DELETE CASCADE,
            item_ref TEXT NOT NULL,
            snoozed_until TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, item_ref)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS improvement_item_snoozes_org_until_idx
        ON improvement_item_snoozes (org_id, snoozed_until)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS improvement_item_snoozes")
