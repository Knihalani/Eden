"""156 — partial index + bounded backfill for agent-linkage telemetry (FEAT-98).

Revision ID: 156_agent_link_columns_index
Revises: 155_session_summaries_user_index
Create Date: 2026-08-06

No new ``ALTER TABLE`` is needed here — ``operation_name`` (067) and
``agent_id`` (009) already exist on ``telemetry_events``. This is
purely an index + bounded backfill:

* ``idx_telemetry_events_tenant_operation_name_agent`` on
  ``(tenant_id, operation_name, agent_id) WHERE operation_name IN
  ('invoke_agent', 'create_agent')`` supports the "list agent-invocation
  spans for tenant X" query the multi-agent portal panel needs. 067's
  existing ``idx_telemetry_events_tenant_operation_name`` covers
  ``(tenant_id, operation_name)`` only — it can't also serve a
  per-agent filter/group without revisiting every matching row.
  Following the 154/155 convention in this chain, this uses a plain
  ``CREATE INDEX IF NOT EXISTS`` rather than ``CONCURRENTLY``:
  ``CONCURRENTLY`` cannot run inside the transaction alembic wraps
  each migration in, and no other migration in this chain has broken
  out of that transaction (e.g. via ``op.get_bind().execute(...)``
  with autocommit) to use it successfully.

* Bounded backfill: recently-ingested rows with a NULL
  ``operation_name`` on ``event_type = 'tool.call'`` get an explicit
  ``'unknown'`` sentinel instead of NULL, so the new "list
  agent-invocation spans" panel doesn't have to special-case NULL vs.
  a real value it can filter/group on. ``event_type`` (not ``type``)
  is confirmed as the actual column name — see ``009_telemetry_events.py``.
  Scoped to ``created_at > now() - interval '30 days'`` to bound the
  UPDATE's cost/lock time on a hot table with a long history; older
  rows are left as-is (this is a UX default for new panel queries, not
  a correctness backfill that needs full-table coverage).

Downgrade drops only the new index. ``finish_reason`` must never be
touched by this migration — see 067's downgrade() docstring and FEAT-99
for the incident this guards against.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "156_agent_link_columns_index"
down_revision: str | Sequence[str] | None = "155_session_summaries_user_index"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # "List agent-invocation spans for tenant X" — filters on
    # operation_name IN ('invoke_agent', 'create_agent') and groups/filters
    # by agent_id. Partial so the index stays small (most rows aren't
    # agent-invocation spans).
    op.execute(
        "CREATE INDEX IF NOT EXISTS "
        "idx_telemetry_events_tenant_operation_name_agent "
        "ON telemetry_events (tenant_id, operation_name, agent_id) "
        "WHERE operation_name IN ('invoke_agent', 'create_agent')"
    )

    # Bounded backfill: give recently-ingested tool-call rows a non-null
    # operation_name sentinel. Time-bounded so this can't turn into an
    # unbounded table rewrite on a large, long-lived deployment.
    op.execute(
        "UPDATE telemetry_events "
        "SET operation_name = 'unknown' "
        "WHERE operation_name IS NULL "
        "AND created_at > now() - interval '30 days' "
        "AND event_type = 'tool.call'"
    )


def downgrade() -> None:
    # Index-only migration: drop the index and stop. No other column is
    # touched (see the module docstring for the incident this guards
    # against). The backfill UPDATE above is data, not schema; it is
    # not (and should not be) reversed here.
    op.execute(
        "DROP INDEX IF EXISTS idx_telemetry_events_tenant_operation_name_agent"
    )
