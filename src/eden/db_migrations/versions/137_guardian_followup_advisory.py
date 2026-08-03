"""137 — improvement_plans: 'advisory' plan_kind + guardian follow-up race-proofing (M5, D9).

Revision ID: 137_guardian_followup_advisory
Revises: 136_issue_status_escalated
Create Date: 2026-08-03

Phase 1 of the autonomy overhaul (M5, D9; M6 also depends on this):

1. Widen the ``improvement_plans.plan_kind`` CHECK with ``'advisory'``.
   The guardian degrades a failed follow-up generation to an advisory
   ("needs manual fix") instead of an approvable empty ``code_patch``,
   and M6 moves non-actionable ``config_change`` rows to the same kind.
   The 099 CHECK lives inline on the column (auto-generated name), so
   the DO block resolves the real constraint name from ``pg_constraint``
   before dropping — the same dump/restore-safe pattern as 118/136.

2. Unique partial index racing-proofing guardian follow-ups: the
   guardian's "skip if a follow-up already exists" pre-check
   (guardian.py ``_existing_follow_up``) is check-then-insert; two
   concurrent VERIFY_FAILED consumers could both draft. The parent link
   is stored in the real ``parent_plan_id`` column (migration 132), so
   the index keys on ``(org_id, parent_plan_id) WHERE status = 'draft'
   AND parent_plan_id IS NOT NULL`` — the second concurrent draft
   fails the INSERT (``create_plan`` returns None; caller treats it
   as follow_up_exists).

Downgrade re-labels ``advisory`` rows as ``config_change`` (the
closest pre-137 advisory-ish kind, and how they were emitted before)
before restoring the original CHECK list.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "137_guardian_followup_advisory"
down_revision: str | Sequence[str] | None = "136_issue_status_escalated"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The 099 list.
_BASE_KINDS = (
    "'code_patch','prompt_update','nudge_promote',"
    "'guardrail_tune','config_change'"
)

_DROP_PLAN_KIND_CHECK = """
DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
    FROM pg_constraint
    WHERE conrelid = 'improvement_plans'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%plan_kind%';
    IF cname IS NOT NULL THEN
        EXECUTE format(
            'ALTER TABLE improvement_plans DROP CONSTRAINT %I', cname
        );
    END IF;
END $$;
"""


def upgrade() -> None:
    op.execute(_DROP_PLAN_KIND_CHECK)
    op.execute(
        f"""
        ALTER TABLE improvement_plans
            ADD CONSTRAINT improvement_plans_plan_kind_check
            CHECK (plan_kind IN ({_BASE_KINDS},'advisory'))
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS
            improvement_plans_guardian_followup_uniq
        ON improvement_plans (org_id, parent_plan_id)
        WHERE status = 'draft' AND parent_plan_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS improvement_plans_guardian_followup_uniq"
    )
    op.execute(
        "UPDATE improvement_plans SET plan_kind = 'config_change' "
        "WHERE plan_kind = 'advisory'"
    )
    op.execute(_DROP_PLAN_KIND_CHECK)
    op.execute(
        f"""
        ALTER TABLE improvement_plans
            ADD CONSTRAINT improvement_plans_plan_kind_check
            CHECK (plan_kind IN ({_BASE_KINDS}))
        """
    )
