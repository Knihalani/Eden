"""086 — autonomy_policies + autonomy_audit_log (N22 safety envelope).

Revision ID: 086
Revises: 085
Create Date: 2026-07-10

The autonomy policy engine (``eden.closed_loop.autonomy_policy``) reads
these tables to bound autonomous maintenance. ``autonomy_policies`` holds
one row per ``(org_id, agent_id)`` — a ``NULL`` agent_id is the org
default; an agent row overrides it. We deliberately do *not* seed a row
per org: :func:`resolve` synthesises the default from Settings when no
row exists, so the effective posture tracks the config flags instead of
going stale. ``autonomy_audit_log`` records every allow/deny/require_
approval decision for the N06 compliance pack and the N17 cockpit.

org_id is stored as ``VARCHAR`` (not a UUID FK) to match the rest of the
issues/closed-loop schema, which keys on the string org id.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "086"
down_revision: str | Sequence[str] | None = "085"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS autonomy_policies (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            agent_id            VARCHAR(256),
            policy              JSONB NOT NULL DEFAULT '{}'::jsonb,
            compliance_profile  VARCHAR(24) NOT NULL DEFAULT 'standard'
                                CHECK (compliance_profile IN
                                    ('standard','hipaa','soc2_strict')),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    # UNIQUE (org_id, agent_id) — but NULLs are distinct in Postgres, so a
    # partial unique index enforces a single org-default (agent_id IS NULL)
    # row alongside the composite unique for agent rows.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_autonomy_policies_org_agent "
        "ON autonomy_policies (org_id, agent_id) "
        "WHERE agent_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_autonomy_policies_org_default "
        "ON autonomy_policies (org_id) "
        "WHERE agent_id IS NULL"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS autonomy_audit_log (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id        VARCHAR(128) NOT NULL,
            agent_id      VARCHAR(256),
            action        VARCHAR(64) NOT NULL,
            tier_applied  VARCHAR(32) NOT NULL,
            decision      VARCHAR(24) NOT NULL
                          CHECK (decision IN
                              ('allow','deny','require_approval')),
            reason        TEXT,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_autonomy_audit_org "
        "ON autonomy_audit_log (org_id, created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS autonomy_audit_log CASCADE")
    op.execute("DROP TABLE IF EXISTS autonomy_policies CASCADE")
