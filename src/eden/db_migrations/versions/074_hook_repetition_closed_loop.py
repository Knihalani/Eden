"""B-15 fix: add ``repetition_count`` to ``closed_loop_actions``.

Migration 051 already added the column to ``hook_events`` (the
post-051 surface). This migration backfills the legacy
``closed_loop_actions`` table so the fallback path used by
``_record_action`` can also track how many times the same
``(hook_name, target)`` pair has fired in the recent past.

The number is the count of times an emit() was dedup'd while
the dedup window was still active — i.e. the "this fired again
but we already saw it" counter. Operators use this to spot
noisy failing pipelines (a hook repeating 100×/min is a bug,
not an emergency).

Revision ID: 074_hook_repetition_closed_loop
Revises: 073_tenant_guardrail_action_config
Create Date: 2026-06-29 12:00:00.000000
"""

from __future__ import annotations

from alembic import op

revision = "074_hook_repetition_closed_loop"
down_revision = "073"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # B-15 fix: closed_loop_actions gains a repetition_count column
    # so the fallback path (closed_loop_actions) and the HookBus path
    # (hook_events, already has the column from migration 051) report
    # the same shape. Default 1 — every row was emitted at least once.
    op.execute(
        "ALTER TABLE closed_loop_actions "
        "ADD COLUMN IF NOT EXISTS repetition_count INTEGER NOT NULL DEFAULT 1"
    )
    # Partial index for the "show me the noisy hooks" query.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_closed_loop_actions_repetition "
        "ON closed_loop_actions (org_id, hook_name) "
        "WHERE repetition_count > 1"
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS idx_closed_loop_actions_repetition"
    )
    op.execute(
        "ALTER TABLE closed_loop_actions "
        "DROP COLUMN IF EXISTS repetition_count"
    )
