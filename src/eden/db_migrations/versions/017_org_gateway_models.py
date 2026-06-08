"""017_org_gateway_models — Per-org upstream model registry for the AI gateway.

Revision ID: 017
Revises: 016
Create Date: 2026-06-08

Adds the ``org_gateway_models`` table that lets each org register
upstream providers (OpenAI, Anthropic, Bedrock, OpenRouter, local)
that the AI gateway (A1) will route logical model names to.

  - ``name``: the logical model name the customer uses in API
    requests (e.g. "gpt-4o-mini"). Unique per org.
  - ``provider``: which upstream provider to call.
  - ``upstream_model``: the model id to send to the upstream
    (e.g. "gpt-4o-mini-2024-07-18"). Falls back to ``name``.
  - ``upstream_api_key_encrypted``: Fernet-encrypted upstream API
    key. NEVER stored in plaintext.
  - ``upstream_key_prefix``: last 4 chars of the key for display.
  - ``endpoint``: optional override of the upstream base URL.
  - ``enabled``: tenant-controlled switch. Disabled entries are
    skipped by the gateway but kept for audit.
  - ``routing_priority``: lower = preferred when multiple rows
    resolve the same logical ``name``.
  - ``metadata``: free-form JSON (e.g. headers, region hints).

The table is consumed by:

  * ``eden.llmops.registry_store`` — the storage layer A2 owns.
  * A1's OpenAI-compatible adapter — falls back to a static list
    when this table is empty for an org.
"""

from alembic import op

revision = "017"
down_revision = "016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_gateway_models (
            model_id                  UUID PRIMARY KEY,
            org_id                    VARCHAR(128) NOT NULL,
            name                      VARCHAR(256) NOT NULL,
            provider                  VARCHAR(64)  NOT NULL,
            upstream_model            VARCHAR(256) NOT NULL,
            upstream_api_key_encrypted TEXT NOT NULL DEFAULT '',
            upstream_key_prefix       VARCHAR(16)  NOT NULL DEFAULT '',
            endpoint                  TEXT,
            enabled                   BOOLEAN NOT NULL DEFAULT TRUE,
            routing_priority          INT NOT NULL DEFAULT 100,
            metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by                VARCHAR(128),
            created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_ogm_org_enabled
        ON org_gateway_models (org_id, enabled, routing_priority)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_ogm_org_provider
        ON org_gateway_models (org_id, provider)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_ogm_org_provider")
    op.execute("DROP INDEX IF EXISTS idx_ogm_org_enabled")
    op.execute("DROP TABLE IF EXISTS org_gateway_models")
