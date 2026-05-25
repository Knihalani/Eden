-- Migration 010: SSO/SAML Configuration for Organizations
-- ============================================================================
-- org_sso_providers: Stores SSO/SAML/OIDC provider configurations per org
-- org_sso_sessions: Tracks SSO sessions for login state
-- ============================================================================

-- SSO Providers table
CREATE TABLE org_sso_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider_type VARCHAR(20) NOT NULL,  -- 'okta', 'google', 'oidc', 'saml2'
    name VARCHAR(100) NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    -- SAML/OIDC config fields stored in config JSONB:
    --   entity_id, sso_url, certificate, client_id, client_secret,
    --   scopes, authorization_endpoint, token_endpoint, userinfo_endpoint
    enabled BOOLEAN DEFAULT FALSE,
    default_for_domain VARCHAR(255),  -- Auto-enroll users with this email domain
    enforce_sso BOOLEAN DEFAULT FALSE,  -- Block password login when enabled
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- SCIM token storage (references org_sso_providers)
ALTER TABLE org_sso_providers ADD COLUMN scim_token_hash VARCHAR(64);
ALTER TABLE org_sso_providers ADD COLUMN scim_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE org_sso_providers ADD COLUMN last_scim_sync_at TIMESTAMPTZ;

-- SSO Sessions table for tracking active SSO logins
CREATE TABLE org_sso_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES org_sso_providers(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idp_session_id VARCHAR(255),  -- Session ID from the identity provider
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,  -- For OIDC
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT fk_org FOREIGN KEY (provider_id) REFERENCES org_sso_providers(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_sso_providers_org_id ON org_sso_providers(org_id);
CREATE INDEX idx_sso_providers_enabled ON org_sso_providers(org_id, enabled) WHERE enabled = TRUE;
CREATE INDEX idx_sso_providers_domain ON org_sso_providers(default_for_domain) WHERE default_for_domain IS NOT NULL;
CREATE INDEX idx_sso_sessions_user ON org_sso_sessions(user_id);
CREATE INDEX idx_sso_sessions_provider ON org_sso_sessions(provider_id);
CREATE INDEX idx_sso_sessions_expires ON org_sso_sessions(expires_at) WHERE expires_at IS NOT NULL;