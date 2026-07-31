"""126 — ensure ai_conversations + ai_messages exist (Assistant history).

Revision ID: 126_ai_conversations
Revises: 125_clickhouse_fallback_drain
Create Date: 2026-07-31

The portal Assistant and AI Insights chat persist sessions in
``ai_conversations`` / ``ai_messages`` (see ``migrations/031_ai_conversations.sql``).
That SQL lived outside the Alembic chain, so greenfield / drifted
deploys 503'd ``GET /portal/.../assistant/threads`` when the tables
were missing.

``user_id`` MUST match live ``users.id`` type: Neon applied
``migrations/040_users_text_id.sql`` (TEXT / Clerk), while fresh
Alembic DBs still have UUID from ``001_initial_schema``. A hard-coded
``UUID REFERENCES users(id)`` crash-loops API boot on prod (alembic
fails → ``eden_production`` raises → pod restarts → deploy stuck
IN_PROGRESS). Mirror migration 090's type probe.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "126_ai_conversations"
down_revision: str | Sequence[str] | None = "125_clickhouse_fallback_drain"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _users_id_sql_type() -> str:
    """Return SQL type for ``users.id`` (``UUID`` or ``TEXT``)."""
    row = (
        op.get_bind()
        .execute(
            text(
                """
            SELECT data_type
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'users'
              AND column_name = 'id'
            """
            )
        )
        .fetchone()
    )
    if row is None:
        return "UUID"
    data_type = (row[0] or "").lower()
    if data_type in ("text", "character varying", "varchar"):
        return "TEXT"
    return "UUID"


def _orgs_id_sql_type() -> str:
    """Return SQL type for ``organizations.id`` (``UUID`` or ``TEXT``)."""
    row = (
        op.get_bind()
        .execute(
            text(
                """
            SELECT data_type
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'organizations'
              AND column_name = 'id'
            """
            )
        )
        .fetchone()
    )
    if row is None:
        return "UUID"
    data_type = (row[0] or "").lower()
    if data_type in ("text", "character varying", "varchar"):
        return "TEXT"
    return "UUID"


def upgrade() -> None:
    user_id_type = _users_id_sql_type()
    org_id_type = _orgs_id_sql_type()
    op.execute(
        f"""
        CREATE TABLE IF NOT EXISTS ai_conversations (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id          {org_id_type} NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id         {user_id_type} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title           TEXT NOT NULL DEFAULT 'New chat',
            page_context    JSONB NOT NULL DEFAULT '{{}}'::jsonb,
            turn_count      INT NOT NULL DEFAULT 0,
            total_tokens    INT NOT NULL DEFAULT 0,
            total_cost_usd  NUMERIC(10, 6) NOT NULL DEFAULT 0,
            tier            TEXT NOT NULL DEFAULT 't3',
            archived_at     TIMESTAMPTZ,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_message_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_org_user_updated
            ON ai_conversations (org_id, user_id, updated_at DESC)
            WHERE archived_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_org_updated
            ON ai_conversations (org_id, updated_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_messages (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            conversation_id   UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
            role              TEXT NOT NULL
                CHECK (role IN ('user', 'assistant', 'tool', 'system')),
            content           TEXT NOT NULL DEFAULT '',
            tool_calls        JSONB NOT NULL DEFAULT '[]'::jsonb,
            tool_results      JSONB NOT NULL DEFAULT '[]'::jsonb,
            chart_specs       JSONB NOT NULL DEFAULT '[]'::jsonb,
            citations         JSONB NOT NULL DEFAULT '[]'::jsonb,
            prompt_tokens     INT NOT NULL DEFAULT 0,
            completion_tokens INT NOT NULL DEFAULT 0,
            cost_usd          NUMERIC(10, 6) NOT NULL DEFAULT 0,
            latency_ms        INT NOT NULL DEFAULT 0,
            model_used        TEXT,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created
            ON ai_messages (conversation_id, created_at)
        """
    )


def downgrade() -> None:
    # Destructive; keep tables if operators rolled back for other reasons.
    pass
