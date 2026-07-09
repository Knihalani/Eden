"""057_mcp_traces — D.12.1 MCP traces schema per upgradespec §B.4.

Revision ID: 057
Revises: 056
Create Date: 2026-06-24

Per spec §B.4 (D.12.1):

    -- MCP data lives in telemetry_events.attributes->'mcp' (JSONB)
    CREATE VIEW mcp_traces_v AS
        SELECT event_id AS trace_id,
               (attributes->'mcp'->>'server_name') AS mcp_server_name,
               (attributes->'mcp'->>'tool_name')   AS mcp_tool_name,
               (attributes->'mcp'->>'resource_uri') AS mcp_resource_uri,
               (attributes->'mcp'->>'prompt_name')  AS mcp_prompt_name,
               (attributes->'mcp'->>'sampling_requested')::boolean AS mcp_sampling,
               (attributes->'mcp'->>'transport')    AS mcp_transport,
               created_at
          FROM telemetry_events
         WHERE attributes ? 'mcp';
    CREATE INDEX idx_telemetry_mcp_server
        ON telemetry_events ((attributes->'mcp'->>'server_name'))
        WHERE attributes ? 'mcp';

We add a typed ``mcp_server_auth_failures`` table so the
``mcp_server_auth_failure`` hook (per §E.1) has a queryable
audit log of auth failures (the spec's MCP auth surface).

The view is created with the column names the spec calls
out so the route layer can SELECT * without aliasing.

Conventions (per the 052_budgets / 056_onboarding_state pattern):
* VARCHAR(128) for ``org_id`` (matches spine convention)
* UUID PK via ``gen_random_uuid()`` (gen_random_uuid is enabled
  by migration 003 per the prior ship pattern)
* Best-effort CREATE IF NOT EXISTS so a fresh DB + the
  existing migrations all run cleanly
"""

from __future__ import annotations

from alembic import op

revision = "057"
down_revision = "056"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── View (per spec §B.4 — single typed SELECT over the
    #    telemetry_events JSONB ``mcp`` sub-document).
    op.execute(
        """
        CREATE OR REPLACE VIEW mcp_traces_v AS
        SELECT
            event_id                                   AS trace_id,
            tenant_id                                  AS org_id,
            (attributes->'mcp'->>'server_name')        AS mcp_server_name,
            (attributes->'mcp'->>'tool_name')          AS mcp_tool_name,
            (attributes->'mcp'->>'resource_uri')       AS mcp_resource_uri,
            (attributes->'mcp'->>'prompt_name')        AS mcp_prompt_name,
            (attributes->'mcp'->>'sampling_requested')::boolean
                                                     AS mcp_sampling,
            (attributes->'mcp'->>'transport')         AS mcp_transport,
            created_at
          FROM telemetry_events
         WHERE attributes ? 'mcp'
        """
    )
    # ── Index on the JSON path for fast filtering
    #    (the spec calls out that this index is the
    #    performance-critical read path).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_telemetry_mcp_server "
        "ON telemetry_events ((attributes->'mcp'->>'server_name')) "
        "WHERE attributes ? 'mcp'"
    )

    # ── Auth-failure audit table (per §E.1
    #    ``mcp_server_auth_failure`` hook).
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS mcp_server_auth_failures (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          VARCHAR(128) NOT NULL,
            server_name     TEXT NOT NULL,
            transport       TEXT,                -- 'stdio' | 'http_sse' | 'websocket'
            failure_kind    TEXT NOT NULL,       -- 'unauthorized' | 'expired_token' | 'dns' | 'tls' | 'other'
            error_message   TEXT,
            trace_id        UUID,
            span_id         UUID,
            occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at     TIMESTAMPTZ,
            resolved_by     VARCHAR(128)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_mcp_auth_failures_org "
        "ON mcp_server_auth_failures(org_id, occurred_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_mcp_auth_failures_server "
        "ON mcp_server_auth_failures(server_name, occurred_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_mcp_auth_failures_server")
    op.execute("DROP INDEX IF EXISTS idx_mcp_auth_failures_org")
    op.execute("DROP TABLE IF EXISTS mcp_server_auth_failures")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_mcp_server")
    op.execute("DROP VIEW IF EXISTS mcp_traces_v")
