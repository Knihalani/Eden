"""056_onboarding_state — D.14 cold-start UX schema per upgradespec §D.14 / §B.13.

Revision ID: 056
Revises: 055
Create Date: 2026-06-24

Per spec §B.13:

    CREATE TABLE onboarding_state (
        org_id              UUID PRIMARY KEY,
        current_step        TEXT NOT NULL DEFAULT 'install',
        completed_steps     TEXT[] NOT NULL DEFAULT '{}',
        cat_enablements     JSONB NOT NULL DEFAULT '{}'::jsonb,
        first_trace_at      TIMESTAMPTZ,
        milestones_reached  TEXT[] NOT NULL DEFAULT '{}',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );

Conventions (per the v1.4 cat-ship pattern, mirrors
:file:`052_budgets.py`):
* ``org_id`` follows the spine's ``VARCHAR(128)`` convention
  (the spec's ``UUID`` PK form is replaced with VARCHAR(128) so
  the FK from ``orgs.id`` lines up with the rest of the schema).
* The 7-step list mirrors the portal step order:
  ``install → org → connect → wait → done → tour → autonomous``.
* The ``cat_enablements`` JSONB field tracks per-cat
  opt-in state (e.g. ``{"cat-3": {"enabled_at": "...", "config": {...}}}``)
  so the state machine + portal can render progressive disclosure
  per the spec's §10.2 schedule.

The 7-day milestone schedule (per spec §10.1) is enforced
in :file:`eden.services.onboarding.state_machine`, not in
SQL — the column is the persistence layer; the schedule is
the policy.
"""

from __future__ import annotations

from alembic import op

revision = "056"
down_revision = "055"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS onboarding_state (
            org_id              VARCHAR(128) PRIMARY KEY,
            current_step        VARCHAR(32) NOT NULL DEFAULT 'install',
            completed_steps     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
            cat_enablements     JSONB NOT NULL DEFAULT '{}'::jsonb,
            first_trace_at      TIMESTAMPTZ,
            milestones_reached  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (current_step IN (
                'install', 'org', 'connect', 'wait',
                'done', 'tour', 'autonomous'
            ))
        )
        """
    )
    # GIN index on milestones_reached for fast "has org X reached
    # milestone Y" lookups (the hook bus uses this on every
    # first_10_traces / first_judge_score / first_prompt_version emit).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_onboarding_milestones "
        "ON onboarding_state USING GIN (milestones_reached)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_onboarding_milestones")
    op.execute("DROP TABLE IF EXISTS onboarding_state")
