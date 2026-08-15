-- Organization 2FA Enforcement
-- Adds two_factor_enforced to organizations.settings JSONB
-- Adds two_factor_enabled and two_factor_secret to users table

-- ============================================================================
-- ORGANIZATION 2FA ENFORCEMENT
-- ============================================================================

-- Add two_factor_enforced column to organizations (stored in settings JSONB)
-- Note: organizations.settings is already JSONB, we just need to document the key
-- We'll use a separate column for the boolean flag for easier querying
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS two_factor_enforced BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_orgs_two_factor_enforced ON organizations (two_factor_enforced) WHERE two_factor_enforced = TRUE;

-- ============================================================================
-- USER 2FA FIELDS
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;

CREATE INDEX IF NOT EXISTS idx_users_two_factor_enabled ON users (two_factor_enabled) WHERE two_factor_enabled = TRUE;