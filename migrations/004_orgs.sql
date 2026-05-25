-- Organization and membership schema for Eden multi-tenant B2B
-- Organizations allow teams to share code patterns, skills, and KB entries

-- ============================================================================
-- ORGANIZATIONS
-- ============================================================================

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    owner_id UUID NOT NULL REFERENCES users(id),
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orgs_slug ON organizations (slug);
CREATE INDEX idx_orgs_owner ON organizations (owner_id);

-- ============================================================================
-- ORGANIZATION MEMBERS
-- ============================================================================

CREATE TABLE org_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    invited_by UUID REFERENCES users(id),
    joined_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(org_id, user_id)
);

CREATE INDEX idx_org_members_org ON org_members (org_id);
CREATE INDEX idx_org_members_user ON org_members (user_id);
CREATE INDEX idx_org_members_role ON org_members (org_id, role);

-- ============================================================================
-- ORG-SCOPED CODE REFERENCES
-- ============================================================================

CREATE TABLE code_references (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    uploaded_by UUID NOT NULL REFERENCES users(id),

    name TEXT NOT NULL,
    description TEXT,
    purpose TEXT NOT NULL,  -- What this reference is used for (e.g., "Auth patterns", "API conventions")

    -- File info
    filename TEXT NOT NULL,
    file_path TEXT,
    language TEXT,

    -- Code content (stored directly for small files, or reference to storage)
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,

    -- Embedding for semantic search
    embedding vector(1536),

    metadata JSONB DEFAULT '{}',

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_code_refs_org ON code_references (org_id);
CREATE INDEX idx_code_refs_purpose ON code_references (org_id, purpose);
CREATE INDEX idx_code_refs_lang ON code_references (org_id, language);
CREATE INDEX idx_code_refs_embedding ON code_references USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_code_refs_uploaded_by ON code_references (uploaded_by);

-- ============================================================================
-- ADD ORG CONTEXT TO EXISTING TABLES
-- ============================================================================

-- Add org_id to jobs for organization-scoped job visibility
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS idx_jobs_org_id ON jobs (org_id);
CREATE INDEX IF NOT EXISTS idx_jobs_org_status ON jobs (org_id, status);

-- Add org_id to skills for organization-scoped skill library
ALTER TABLE skills ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_skills_org_id ON skills (org_id);
CREATE INDEX idx_skills_org_archivist ON skills (org_id, archivist_reviewed);

-- Add org_id to graph_entities for organization-scoped KB
ALTER TABLE graph_entities ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_ge_org_id ON graph_entities (org_id);

-- Add org_id to exploits for organization-scoped exploit library
ALTER TABLE exploits ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_exploits_org_id ON exploits (org_id);

-- ============================================================================
-- USER PREFERRED ORG
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_org_id UUID REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS idx_users_preferred_org ON users (preferred_org_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_org_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orgs_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW
    EXECUTE FUNCTION update_org_updated_at();