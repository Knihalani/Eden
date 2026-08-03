"""136 — agent_issues: allow 'escalated' status (M4, D17).

Revision ID: 136_issue_status_escalated
Revises: 135_loop_events_outbox
Create Date: 2026-08-02

Phase 1 of the autonomy overhaul (M4, D17): ``ESCALATED_HUMAN`` becomes a
real state-machine transition, so escalating an issue to a human must
write ``status='escalated'`` instead of leaving the status untouched.
The 084 ``agent_issues`` CHECK enumerates the allowed statuses inline on
the column (Postgres default name ``agent_issues_status_check``), so it
must be dropped and recreated with the widened list.

The DO block resolves the constraint name from ``pg_constraint`` rather
than trusting the default-name convention — the same
information-schema-safe pattern as 118's status widening — so a database
whose auto-generated name drifted (dump/restore, manual repair) still
migrates cleanly.

Downgrade moves ``escalated`` rows back to ``open`` (still visible,
still waiting on a human) before restoring the original list.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "136_issue_status_escalated"
down_revision: str | Sequence[str] | None = "135_loop_events_outbox"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The 084 list (which already includes 'learning' — Anchor Drift #3).
_BASE_STATUSES = (
    "'open','triaged','fix_pending','verifying',"
    "'resolved','regressed','ignored','learning'"
)

_DROP_STATUS_CHECK = """
DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint
    WHERE conrelid = 'agent_issues'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE agent_issues DROP CONSTRAINT %I', cname);
    END IF;
END $$;
"""


def upgrade() -> None:
    op.execute(_DROP_STATUS_CHECK)
    op.execute(
        f"""
        ALTER TABLE agent_issues
            ADD CONSTRAINT agent_issues_status_check
            CHECK (status IN ({_BASE_STATUSES},'escalated'))
        """
    )


def downgrade() -> None:
    op.execute(
        "UPDATE agent_issues SET status = 'open' WHERE status = 'escalated'"
    )
    op.execute(_DROP_STATUS_CHECK)
    op.execute(
        f"""
        ALTER TABLE agent_issues
            ADD CONSTRAINT agent_issues_status_check
            CHECK (status IN ({_BASE_STATUSES}))
        """
    )
