"""154 — composite index for tool_call_labels' per-agent read paths (OPT-16).

Revision ID: 154_tool_call_labels_index
Revises: 153_regression_case_dataset_link
Create Date: 2026-08-06

``tool_call_labels`` (migration 092) has no secondary index beyond its
``UNIQUE (org_id, span_id)`` constraint. Two live, confirmed read paths
in ``learning/tool_call_labels.py`` filter by ``org_id + agent_id`` and
sort by ``created_at DESC``:

  * ``list_for_agent``: ``WHERE org_id = $1 AND agent_id = $2
    [AND tool_name = $3] ORDER BY created_at DESC LIMIT 200``
  * ``count_labels``:  ``WHERE org_id = $1 AND agent_id = $2
    AND tool_name = $3``

Neither can use the ``(org_id, span_id)`` unique index. The composite
``(org_id, agent_id, created_at DESC)`` index serves the base
filter+sort of both queries regardless of whether ``tool_name`` is
passed (matching the shape of the sibling ``signal_events`` indexes in
143). Additive, zero downtime, no backfill; write volume here is gated
by explicit human/agent labeling actions, so a plain ``CREATE INDEX
IF NOT EXISTS`` never blocks inserts.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "154_tool_call_labels_index"
down_revision: str | Sequence[str] | None = "153_regression_case_dataset_link"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # list_for_agent / count_labels: WHERE org_id = $1 AND agent_id =
    # $2 [AND tool_name = $3] ORDER BY created_at DESC. `tool_name` is
    # a bound parameter when present, so the base filter+sort needs the
    # full composite; a trailing tool_name equality still benefits from
    # this index's leading columns.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_tool_call_labels_org_agent_created "
        "ON tool_call_labels (org_id, agent_id, created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_tool_call_labels_org_agent_created")
