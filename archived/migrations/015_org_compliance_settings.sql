-- Per-organization compliance settings: PII policy, retention, region
-- Required for SOC 2 / GDPR posture.

-- ============================================================================
-- PII POLICY
-- ============================================================================
CREATE TABLE org_pii_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,

    -- Per-category enable toggles. Categories follow src/eden/llmops/pii/detectors.py
    categories JSONB NOT NULL DEFAULT '{
        "email": true,
        "phone": true,
        "ssn": true,
        "credit_card": true,
        "ipv4": true,
        "ipv6": true,
        "jwt": true,
        "api_key": true,
        "url_with_creds": true,
        "password_field": true
    }'::jsonb,

    -- If true, ingestion fails when a credential is detected rather than redacting.
    fail_closed_on_credentials BOOLEAN NOT NULL DEFAULT false,

    -- Additional JSON keys to redact beyond the built-in set (array of strings).
    extra_redact_keys JSONB NOT NULL DEFAULT '[]'::jsonb,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_org_pii_policies_org ON org_pii_policies (org_id);

-- ============================================================================
-- RETENTION POLICY
-- ============================================================================
CREATE TABLE org_retention_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,

    -- Per-table override. Default = empty object (use global default).
    -- Shape: { "raw_traces": {"hot_days": 7, "warm_days": 30, "cold_days": 90, "delete_days": 365}, ... }
    table_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Days after which stored PII is scrubbed (0 = never).
    pii_scrub_after_days INTEGER NOT NULL DEFAULT 90 CHECK (pii_scrub_after_days >= 0),

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_org_retention_policies_org ON org_retention_policies (org_id);

-- ============================================================================
-- REGION / DATA RESIDENCY
-- ============================================================================
CREATE TABLE org_regions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,

    -- ISO-style region code: us | eu | ap
    region TEXT NOT NULL DEFAULT 'us' CHECK (region IN ('us', 'eu', 'ap')),

    -- Optional explicit data-residency lock for compliance.
    pinned BOOLEAN NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_org_regions_org ON org_regions (org_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
CREATE OR REPLACE FUNCTION update_compliance_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER org_pii_policies_updated_at
    BEFORE UPDATE ON org_pii_policies
    FOR EACH ROW
    EXECUTE FUNCTION update_compliance_updated_at();

CREATE TRIGGER org_retention_policies_updated_at
    BEFORE UPDATE ON org_retention_policies
    FOR EACH ROW
    EXECUTE FUNCTION update_compliance_updated_at();

CREATE TRIGGER org_regions_updated_at
    BEFORE UPDATE ON org_regions
    FOR EACH ROW
    EXECUTE FUNCTION update_compliance_updated_at();

-- ============================================================================
-- DEFAULT ROW SEEDING
-- ============================================================================
-- For every existing org, ensure a default row exists in each table.
INSERT INTO org_pii_policies (org_id)
SELECT id FROM organizations
ON CONFLICT (org_id) DO NOTHING;

INSERT INTO org_retention_policies (org_id)
SELECT id FROM organizations
ON CONFLICT (org_id) DO NOTHING;

INSERT INTO org_regions (org_id)
SELECT id FROM organizations
ON CONFLICT (org_id) DO NOTHING;
