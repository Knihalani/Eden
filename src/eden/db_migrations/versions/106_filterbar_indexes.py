"""106 — F83 FilterBar composite indexes on telemetry_events.

Revision ID: 106_filterbar_indexes
Revises: 105_wave14_self_obs
Create Date: 2026-07-17

The ``telemetry_events`` table (migration 009) already has composite
indexes for ``trace_id`` and the ``(tenant_id, realm, timestamp)``
access pattern.  Two FilterBar fields referenced in the F83 optimization
spec were NOT indexed, causing full table scans when the portal filters by
``agent_id`` or ``outcome``:

* ``agent_id`` — frequently filtered in the Traces/Sessions panel to scope
  a session replay to a single agent.
* ``outcome`` — the "outcome" FilterBar chip maps to
  ``telemetry_events.outcome VARCHAR(32)``.

Both indexes are composite with ``(tenant_id, <field>, timestamp DESC)``
to support the standard list-query shape:
``WHERE tenant_id = $1 AND <field> = $2 ORDER BY timestamp DESC``.

Additive-only — no existing index is dropped or altered.
Forward-compat: yes (old app code still works without the indexes).
Downgrade risk: none.
Blast radius: low (new indexes on existing table).
"""

from __future__ import annotations

from alembic import op

revision: str = "106_filterbar_indexes"
down_revision: str = "105_wave14_self_obs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_agent_id
        ON telemetry_events (tenant_id, agent_id, timestamp DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_outcome
        ON telemetry_events (tenant_id, outcome, timestamp DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_outcome")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_agent_id")
