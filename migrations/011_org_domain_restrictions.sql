-- Organization Email Domain Restrictions
-- Allows org admins to configure allowed email domains for invitations

-- ============================================================================
-- ORG ALLOWED DOMAINS
-- ============================================================================

CREATE TABLE org_allowed_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    added_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(org_id, domain)
);

CREATE INDEX idx_org_allowed_domains_org ON org_allowed_domains (org_id);

-- ============================================================================
-- ORGANIZATION DOMAIN RESTRICTION ENFORCEMENT
-- ============================================================================

-- Add domain_restriction_enforced column to organizations (stored in settings JSONB)
-- Using a separate column for the boolean flag for easier querying
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS domain_restriction_enforced BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_orgs_domain_restriction_enforced ON organizations (domain_restriction_enforced) WHERE domain_restriction_enforced = TRUE;