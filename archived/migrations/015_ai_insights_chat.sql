-- Migration 015: AI Insights Chat Sidebar
-- Phase 8 / Batch B4: persistent AI assistant sidebar with tool access
-- to internal telemetry queries.
--
-- Adds:
--   * ai_insights_chat_sessions — one row per chat conversation opened
--     by an org member. Holds title + timestamps; messages live in
--     the messages table.
--   * ai_insights_chat_messages — one row per turn (user / assistant /
--     tool). content_jsonb stores the full Anthropic content-block
--     array so we can replay tool-call sequences and preserve
--     structured metadata (citations, latency, model).

BEGIN;

-- ============================================================================
-- AI INSIGHTS CHAT SESSIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_insights_chat_sessions (
    session_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id),
    user_id     UUID NOT NULL REFERENCES users(id),
    title       VARCHAR(256) NOT NULL DEFAULT 'New chat',
    archived_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the sidebar's main query: list this user's sessions
-- for the current org, newest first.
CREATE INDEX IF NOT EXISTS idx_aics_org_user_updated
    ON ai_insights_chat_sessions (org_id, user_id, updated_at DESC);

-- Index for the "active vs archived" split used by the sidebar filter.
CREATE INDEX IF NOT EXISTS idx_aics_org_archived
    ON ai_insights_chat_sessions (org_id, archived_at);

-- ============================================================================
-- AI INSIGHTS CHAT MESSAGES
-- ============================================================================
-- role values: 'user' | 'assistant' | 'tool'
--
-- content_jsonb holds the Anthropic content-block array verbatim:
--   user      -> [{"type": "text", "text": "..."}]
--   assistant -> [{"type": "text", ...}, {"type": "tool_use", ...}]
--   tool      -> [{"type": "tool_result", "tool_use_id": "...", "content": ...}]
--
-- The CASCADE on session_id keeps the messages table clean when a
-- session is removed. Sessions are soft-deleted from the UI
-- (archived_at is set) so we never lose history.
CREATE TABLE IF NOT EXISTS ai_insights_chat_messages (
    message_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id    UUID NOT NULL
                  REFERENCES ai_insights_chat_sessions(session_id)
                  ON DELETE CASCADE,
    role          VARCHAR(16) NOT NULL,
    content_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aicm_session_created
    ON ai_insights_chat_messages (session_id, created_at);

COMMIT;
