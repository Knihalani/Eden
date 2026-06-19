"""036 — App/site-layer signals (Phase A1).

Revision ID: 036
Revises: 035
Create Date: 2026-06-19

Adds three tables that close the gap between Eden's agent-layer
telemetry and the app/site signals captured by Datadog RUM, Langfuse
traceId propagation, LangSmith presigned tokens, and Braintrust's
browser SDK.

Tables
------
* ``app_events`` — high-volume event log from browser/mobile/server.
  One row per ``track()`` call. Source-tagged (``browser`` /
  ``server`` / ``mobile``) so the same endpoint accepts both app
  and server signals without contamination. Partitioned by ``ts``
  monthly to bound the working set per query.
* ``session_secrets`` — HMAC secret per active session, for
  presigned-feedback replay protection and server-side session
  validation.
* ``presigned_feedback_tokens`` — LangSmith-style unauthenticated
  feedback URLs. ``token_id`` is opaque; HMAC-signed payload holds
  the org_id, trace_id, feedback_key, expires_at.

Companion: migration 037 adds ``session_id`` to ``telemetry_events``
so a trace can be joined to its surrounding session activity in a
single query (without going through ``app_events``).
"""
from alembic import op

revision = "036"
down_revision = "035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # app_events: high-volume, partition by ts monthly
    op.execute("""
        CREATE TABLE IF NOT EXISTS app_events (
            id            UUID PRIMARY KEY,
            org_id        VARCHAR(128) NOT NULL,
            session_id    VARCHAR(64),
            user_id       VARCHAR(128),
            trace_id      VARCHAR(128),
            name          VARCHAR(128) NOT NULL,
            source        VARCHAR(16) NOT NULL DEFAULT 'browser',
            ts            TIMESTAMPTZ NOT NULL,
            properties    JSONB,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        ) PARTITION BY RANGE (ts);
    """)
    # Default partition catches anything outside the explicit monthly partitions
    op.execute("CREATE TABLE IF NOT EXISTS app_events_default PARTITION OF app_events DEFAULT;")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_events_org_session_ts "
        "ON app_events (org_id, session_id, ts DESC);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_events_org_trace "
        "ON app_events (org_id, trace_id);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_events_org_name_ts "
        "ON app_events (org_id, name, ts DESC);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_events_properties_gin "
        "ON app_events USING GIN (properties);"
    )

    # session_secrets: per-session HMAC secret
    op.execute("""
        CREATE TABLE IF NOT EXISTS session_secrets (
            session_id    VARCHAR(64) PRIMARY KEY,
            org_id        VARCHAR(128) NOT NULL,
            secret_hash   BYTEA NOT NULL,
            expires_at    TIMESTAMPTZ NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_secrets_org_expires "
        "ON session_secrets (org_id, expires_at);"
    )

    # presigned_feedback_tokens: LangSmith-style
    op.execute("""
        CREATE TABLE IF NOT EXISTS presigned_feedback_tokens (
            token_id      VARCHAR(64) PRIMARY KEY,
            org_id        VARCHAR(128) NOT NULL,
            trace_id      VARCHAR(128) NOT NULL,
            feedback_key  VARCHAR(64) NOT NULL DEFAULT 'user_score',
            expires_at    TIMESTAMPTZ NOT NULL,
            consumed_at   TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pft_org_trace "
        "ON presigned_feedback_tokens (org_id, trace_id);"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pft_expires "
        "ON presigned_feedback_tokens (expires_at) "
        "WHERE consumed_at IS NULL;"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS app_events CASCADE;")
    op.execute("DROP TABLE IF EXISTS session_secrets CASCADE;")
    op.execute("DROP TABLE IF EXISTS presigned_feedback_tokens CASCADE;")
