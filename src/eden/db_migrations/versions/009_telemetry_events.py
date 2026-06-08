"""009_telemetry_events — Phase 7.0 Multi-Format Telemetry Ingestion.

Revision ID: 009
Revises: 008
Create Date: 2026-06-03

Adds the ``telemetry_events`` table that the existing
``TelemetryCollector._route_postgres`` has been writing to since Phase 6.5
without an accompanying migration. The INSERT statement at
``src/eden/observability/telemetry_collector.py:347`` is the source of
truth for the column list and ordering; this migration makes the schema
match.

A new ``source_format`` column records which ingestion format produced
the row (e.g. ``otel``, ``helicone``, ``langfuse``, ``openai``,
``anthropic``, ``bedrock``, ``gemini``, ``framework``, ``webhook``,
``eden_sdk``, ``eden-auto-instrument``). Defaults to ``eden_native`` for
the existing in-process emit path so backfilled rows are not NULL.
"""

from alembic import op

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── telemetry_events ─────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS telemetry_events (
            event_id           VARCHAR(128) PRIMARY KEY,
            tenant_id          VARCHAR(128) NOT NULL,
            project_id         VARCHAR(128) NOT NULL,
            trace_id           VARCHAR(128) NOT NULL,
            realm              VARCHAR(32)  NOT NULL,
            event_type         VARCHAR(64)  NOT NULL,
            timestamp          TIMESTAMPTZ  NOT NULL,
            agent_id           VARCHAR(128),
            agent_version      VARCHAR(64),
            environment_id     VARCHAR(128),
            parent_span_id     VARCHAR(64),
            span_id            VARCHAR(64),
            name               VARCHAR(256),
            duration_ms        DOUBLE PRECISION,
            payload            JSONB        NOT NULL DEFAULT '{}'::jsonb,
            metrics            JSONB        NOT NULL DEFAULT '{}'::jsonb,
            attributes         JSONB        NOT NULL DEFAULT '{}'::jsonb,
            tags               JSONB        NOT NULL DEFAULT '[]'::jsonb,
            outcome            VARCHAR(32),
            source_format      VARCHAR(64)  NOT NULL DEFAULT 'eden_native',
            created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    """)

    # Primary time-series access pattern: list a tenant's recent events.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_timestamp
        ON telemetry_events (tenant_id, timestamp DESC)
    """)

    # Per-trace fan-out (Redis stream, WebSocket, replay).
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_trace_id
        ON telemetry_events (trace_id, timestamp ASC)
    """)

    # Per-tenant / per-event-type time-series for heatmaps, dashboards.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_type_time
        ON telemetry_events (tenant_id, event_type, timestamp DESC)
    """)

    # Source-format filter (e.g. "show all helicone rows in last 24h").
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_source_format
        ON telemetry_events (source_format, timestamp DESC)
    """)

    # Realm filter (env vs prod) is a frequent UI slice.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_tenant_realm_time
        ON telemetry_events (tenant_id, realm, timestamp DESC)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_tenant_realm_time")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_source_format")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_tenant_type_time")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_trace_id")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_tenant_timestamp")
    op.execute("DROP TABLE IF EXISTS telemetry_events")
