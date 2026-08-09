"""155 — composite index for session_summaries' per-user read paths (FEAT-56).

Revision ID: 155_session_summaries_user_index
Revises: 154_tool_call_labels_index
Create Date: 2026-08-06

``session_summaries`` (migration 142) carries two secondary indexes:
``idx_session_summaries_org_agent_start`` ``(org_id, agent_id,
session_start DESC)`` and ``idx_session_summaries_org_start``
``(org_id, session_start DESC)``. ``analytics/cohorts.py``'s
``cohort_retention()`` scans ``(org_id, user_id)`` — neither index
leads with ``user_id``, so the per-user scan is a plain org-wide
sequential sweep.

The column order deliberately mirrors the existing
``idx_session_summaries_org_agent_start`` shape (tenant column first,
join key second, time DESC third) so both the per-user
``cohort_retention()`` scan and a future "sessions for user X, most
recent first" query hit the same index. B-tree indexes handle NULL
``user_id`` fine, so no backfill or constraint change is required.
Additive, zero downtime.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "155_session_summaries_user_index"
down_revision: str | Sequence[str] | None = "154_tool_call_labels_index"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # cohort_retention(): WHERE org_id = $1 AND user_id = $2 AND
    # session_start >= $3, aggregated by date_trunc('week', session_start).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_org_user "
        "ON session_summaries (org_id, user_id, session_start DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_session_summaries_org_user")
