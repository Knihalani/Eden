-- Agent Registrations — Phase 2 of the env-gen cutover.
--
-- Each row represents a user agent that has registered itself with the
-- Eden SDK at startup. The CLI's `eden config discover-agents` reads
-- this table; per-agent observability + sim generation threads
-- `agent_id` through to scope the work.
--
-- Registration is idempotent on (org_id, agent_id) so SDKs can call
-- POST /agents/register on every boot without creating duplicates.

-- ============================================================================
-- AGENT REGISTRATIONS
-- ============================================================================

CREATE TABLE agent_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,                  -- client-supplied (or server-issued) id
    name TEXT NOT NULL,
    framework TEXT,                          -- langchain | openai | anthropic | ...
    repo_url TEXT,
    register_token TEXT,                     -- bearer the SDK uses for telemetry
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Idempotency: one row per (org, agent) pair
    CONSTRAINT uq_agent_registrations_org_agent UNIQUE (org_id, agent_id)
);

-- Common query paths
CREATE INDEX idx_agent_registrations_org ON agent_registrations (org_id);
CREATE INDEX idx_agent_registrations_org_framework
    ON agent_registrations (org_id, framework);
CREATE INDEX idx_agent_registrations_last_seen
    ON agent_registrations (org_id, last_seen_at DESC);
CREATE INDEX idx_agent_registrations_name_search
    ON agent_registrations USING gin (to_tsvector('simple', name));

-- Auto-update `updated_at` on every UPDATE.
CREATE OR REPLACE FUNCTION agent_registrations_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_registrations_updated_at
BEFORE UPDATE ON agent_registrations
FOR EACH ROW
EXECUTE FUNCTION agent_registrations_set_updated_at();
