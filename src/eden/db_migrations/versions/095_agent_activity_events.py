"""095_agent_activity_events — Cat 23 Gate 4a activity feed table.

Revision ID: 095
Revises: 094
Create Date: 2026-07-14

Adds the ``agent_activity_events`` table that was commented out in
migration 027 (upgradespec §D.7 deferred Gate-4 tables). The table
backs the :class:`eden.code_change.activity_feed.AgentActivityFeed`
service which emits and lists activity events for the Eden Agent.

Originally drafted as revision 028 by Wave 4, but ``028`` was already
taken by ``028_user_soft_delete.py``. Renumbered to 095 after Wave 5's
``094_strategy_store_org_id``.

Schema:

* ``agent_activity_events`` — one row per agent event.
  PK is the deterministic ``act_<uuid>`` id from
  :func:`eden.code_change._common._new_id`.

Conventions (mirrors 027):

* Includes ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Gets an ``idx_agent_activity_events_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.
* Adds a ``idx_agent_activity_events_type`` index for event-type
  fan-out queries (the portal's event-type filter).
"""

from __future__ import annotations

from alembic import op

revision = "095"
down_revision = "094"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_activity_events (
            id           VARCHAR(64)   PRIMARY KEY,
            org_id       VARCHAR(128)  NOT NULL,
            event_type   VARCHAR(64)   NOT NULL,
            summary      TEXT          NOT NULL DEFAULT '',
            deep_link    TEXT          NOT NULL DEFAULT '',
            metadata     JSONB,
            created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_activity_events_org "
        "ON agent_activity_events (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_activity_events_type "
        "ON agent_activity_events (org_id, event_type, created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agent_activity_events")
