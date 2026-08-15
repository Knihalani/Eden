-- June 2026: Unified AI agent conversation persistence (Phase C).
--
-- Two tables:
-- 1) ai_conversations — one row per chat session. Carries the system-
--    context snapshot (page context the agent was opened from), so a
--    user reopening an old chat can see exactly which trace/incident
--    they were investigating.
-- 2) ai_messages — one row per assistant / user / tool message.
--    Stores both the rendered text AND the structured payload
--    (tool_calls, chart_specs, citations). The portal renders
--    streaming events from these structured fields.
--
-- RLS
-- ───
-- Per-org isolation: every query is filtered by org_id. The chat
-- service always passes org_id from the JWT, never trusts the
-- client-supplied value.
--
-- Per-user visibility: ``user_id`` lets a user see only their own
-- conversations. Admins (role check at the API layer) can see all
-- conversations in their org.
--
-- Retention
-- ─────────
-- No automatic deletion; a separate retention job (not in this
-- migration) trims rows older than ``ai_agent_retention_days``.
-- Default 90 days — long enough that power users can scroll back
-- through multi-week investigations.

CREATE TABLE IF NOT EXISTS ai_conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Short human title; auto-generated from the first user message
    -- via the LLM (T3 tier, single-shot). User can rename in the UI.
    title           TEXT NOT NULL DEFAULT 'New chat',
    -- Page context snapshot: which page the chat was opened from,
    -- plus any IDs the frontend auto-attached (trace_id, incident_id,
    -- agent_id, etc). Used to scope tool queries.
    page_context    JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Number of LLM turns so far. Capped at ai_agent_max_turns.
    turn_count      INT NOT NULL DEFAULT 0,
    -- Total tokens used (prompt + completion) across all messages.
    total_tokens    INT NOT NULL DEFAULT 0,
    -- Total cost in USD across all messages. Useful for billing.
    total_cost_usd  NUMERIC(10, 6) NOT NULL DEFAULT 0,
    -- Tier used for the conversation (ModelTier.T3 = premium).
    -- Locked in at first message so a config flip mid-chat doesn't
    -- corrupt cost attribution.
    tier            TEXT NOT NULL DEFAULT 't3',
    -- Soft-delete: conversations are kept until retention prunes
    -- them, but the UI hides archived rows.
    archived_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The last assistant message id (for jump-to-latest in the UI).
    last_message_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_org_user_updated
    ON ai_conversations (org_id, user_id, updated_at DESC)
    WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_conversations_org_updated
    ON ai_conversations (org_id, updated_at DESC);


CREATE TABLE IF NOT EXISTS ai_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    -- ``user`` | ``assistant`` | ``tool`` | ``system``
    role            TEXT NOT NULL
        CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    -- Rendered text (markdown). Empty for tool messages.
    content         TEXT NOT NULL DEFAULT '',
    -- For tool messages: which tool was called, what args, what result.
    -- For assistant messages: which tools the model invoked, with args.
    -- Stored as JSONB so the portal can render tool-call badges.
    tool_calls      JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- For tool messages: the structured result (truncated to 50 KB
    -- at write time so a runaway SQL query can't blow up the row).
    tool_results    JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Chart specs the agent emitted. Each is a JSON object with
    -- ``type: line|bar|pie|scatter|table|heatmap|sankey``, ``title``,
    -- ``data``, and axis keys. The portal renders these inline.
    chart_specs     JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Citations: clickable refs into spans/traces/incidents. Each
    -- is ``{kind: "span"|"trace"|"incident"|"agent", id: "...",
    -- excerpt: "..."}``. The portal renders them as chips.
    citations       JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Token + cost attribution for this message (assistant only).
    prompt_tokens     INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    cost_usd          NUMERIC(10, 6) NOT NULL DEFAULT 0,
    -- Latency for the model call (assistant only). Useful for
    -- surfacing "this took 4s" in the UI.
    latency_ms        INT NOT NULL DEFAULT 0,
    -- The model used for this message (e.g. "anthropic/claude-opus-4").
    model_used        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_created
    ON ai_messages (conversation_id, created_at);

-- Trigger: keep ``ai_conversations.updated_at`` and ``last_message_at``
-- in sync so the portal can list "recent chats" without scanning
-- the messages table.
CREATE OR REPLACE FUNCTION ai_messages_touch_conversation() RETURNS TRIGGER AS $$
BEGIN
    UPDATE ai_conversations
    SET updated_at = NOW(),
        last_message_at = NOW()
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ai_messages_touch_conversation ON ai_messages;
CREATE TRIGGER trg_ai_messages_touch_conversation
    AFTER INSERT ON ai_messages
    FOR EACH ROW EXECUTE FUNCTION ai_messages_touch_conversation();

COMMENT ON TABLE ai_conversations IS
    'Phase C: persisted chat sessions for the unified AI agent panel. '
    'Per-org + per-user isolation. RLS-friendly.';
COMMENT ON TABLE ai_messages IS
    'Phase C: per-message store for the unified AI agent. Carries '
    'rendered text + structured tool_calls/chart_specs/citations so '
    'the portal can replay a chat from the DB alone.';