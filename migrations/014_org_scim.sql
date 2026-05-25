-- Organization SCIM 2.0 Provisioning
-- Stores SCIM token (hashed) and sync metadata per org

-- ============================================================================
-- SCIM CONFIGURATION TABLE
-- ============================================================================

CREATE TABLE org_scim_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    scim_token_hash TEXT,                    -- Hashed SCIM bearer token
    scim_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    last_sync_at TIMESTAMPTZ,
    provisioned_user_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(org_id)
);

CREATE INDEX idx_org_scim_config_org ON org_scim_config (org_id);
CREATE INDEX idx_org_scim_config_enabled ON org_scim_config (org_id, scim_enabled) WHERE scim_enabled = TRUE;

-- ============================================================================
-- SCIM USERS TABLE (maps SCIM userIds to org_members)
-- ============================================================================

CREATE TABLE scim_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    scim_external_id TEXT NOT NULL,           -- External user ID from IdP
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL if user de-provisioned
    user_email TEXT,                          -- Denormalized for easier lookups
    display_name TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,  -- FALSE = suspended
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(org_id, scim_external_id)
);

CREATE INDEX idx_scim_users_org ON scim_users (org_id);
CREATE INDEX idx_scim_users_external_id ON scim_users (org_id, scim_external_id);
CREATE INDEX idx_scim_users_user_id ON scim_users (user_id);

-- ============================================================================
-- TRIGGER TO UPDATE updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_org_scim_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER org_scim_config_updated_at
    BEFORE UPDATE ON org_scim_config
    FOR EACH ROW
    EXECUTE FUNCTION update_org_scim_config_updated_at();

CREATE OR REPLACE FUNCTION update_scim_users_last_synced()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_synced_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scim_users_last_synced_at
    BEFORE UPDATE ON scim_users
    FOR EACH ROW
    EXECUTE FUNCTION update_scim_users_last_synced_at();