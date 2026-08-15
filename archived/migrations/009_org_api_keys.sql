-- Organization API Keys for programmatic access (CI/CD, service accounts)
-- Keys are org-bound, not user-bound. Raw key is returned once on creation, then only hash stored.

-- ============================================================================
-- ORG API KEYS
-- ============================================================================

CREATE TABLE org_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Key identity
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,  -- SHA-256 of the actual key (never stored raw)
    key_prefix TEXT NOT NULL,  -- Last 8 chars for display/identification

    -- Scopes (permissions)
    scopes JSONB NOT NULL DEFAULT '[]',  -- e.g. ["references:read", "references:write"]

    -- Metadata
    created_by UUID NOT NULL REFERENCES users(id),
    last_used_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_org_api_keys_org ON org_api_keys (org_id);
CREATE INDEX idx_org_api_keys_key_hash ON org_api_keys (key_hash);
CREATE INDEX idx_org_api_keys_created_by ON org_api_keys (created_by);

-- Trigger to update last_used_at when key is used
CREATE OR REPLACE FUNCTION update_api_key_last_used()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_used_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Note: We don't auto-update last_used_at on every read to avoid write contention
-- Instead, we update it periodically or on explicit use