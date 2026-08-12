"""168 — nl_signals.agent_id column (Wave 3 per-agent learning).

Revision ID: 168_nl_signals_agent_id
Revises: 167_trace_summaries
Create Date: 2026-08-11

Wave 3 (3.1): shadow detectors are created per-agent by
``SoftIssueReviewer._create_shadow_detector``, but the agent is only
encoded as a ``[auto:{agent_id}]`` prefix in ``description`` — there is
no queryable column, so the weekly promote/delete sweep and the per-agent
threshold tuning (3.2) must regex-parse free text. This adds a proper
``agent_id VARCHAR(256)`` column (matching ``agent_issues.agent_id`` and
``telemetry_events.attributes->>'agent_id'``, which are string agent
names — not UUIDs) and backfills existing rows from the ``[auto:...]``
prefix.

RLS: no policy change — ``nl_signals`` rows are already confined by the
``org_id`` columns this migration touches (mirrors 142 RLS shape).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "168_nl_signals_agent_id"
down_revision: str | Sequence[str] | None = "167_trace_summaries"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE nl_signals
            ADD COLUMN IF NOT EXISTS agent_id VARCHAR(256)
        """
    )
    # Backfill existing shadow detectors from the `[auto:{agent_id}]`
    # description prefix (the pre-column encoding). Idempotent: only
    # touches rows that still have NULL agent_id.
    op.execute(
        """
        UPDATE nl_signals
        SET agent_id = regexp_replace(
                description, '^\\[auto:([^\\]]+)\\].*$', '\\1'
            )
        WHERE description LIKE '[auto:%'
          AND agent_id IS NULL
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_nl_signals_org_agent "
        "ON nl_signals (org_id, agent_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_nl_signals_org_agent")
    op.execute("ALTER TABLE nl_signals DROP COLUMN IF EXISTS agent_id")
