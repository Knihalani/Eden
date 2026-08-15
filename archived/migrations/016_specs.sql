-- Eden Specs Schema — Interview & Spec Generation
-- PostgreSQL 16+

-- ============================================================================
-- SPECS: Structured environment design plans generated from interviews
-- ============================================================================

CREATE TABLE specs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spec_id VARCHAR(255) UNIQUE NOT NULL,

    -- Ownership
    org_id UUID,
    user_id UUID,

    -- Source
    source VARCHAR(50) NOT NULL DEFAULT 'interview',  -- interview, template, import, api
    interview_session_id VARCHAR(255),  -- nullable for non-interview sources

    -- Spec content (structured EDP)
    spec JSONB NOT NULL,

    -- Checklist state snapshot at generation time
    checklist_state JSONB,

    -- Status lifecycle
    status VARCHAR(50) NOT NULL DEFAULT 'draft',  -- draft, pending_review, approved, rejected, converted_to_job, archived

    -- Versioning
    version INT NOT NULL DEFAULT 1,
    parent_spec_id UUID REFERENCES specs(id) ON DELETE SET NULL,

    -- Approval workflow (Phase 2+)
    approval_policy_id UUID,  -- references org_approval_policies
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,

    -- Metadata
    title TEXT,
    description TEXT,
    tags TEXT[],

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,  -- when user submitted for review
    converted_to_job_at TIMESTAMPTZ,

    -- Converted job reference
    converted_job_id VARCHAR(255)
);

-- Indexes for specs
CREATE INDEX idx_specs_spec_id ON specs (spec_id);
CREATE INDEX idx_specs_org_id ON specs (org_id);
CREATE INDEX idx_specs_user_id ON specs (user_id);
CREATE INDEX idx_specs_status ON specs (status);
CREATE INDEX idx_specs_source ON specs (source);
CREATE INDEX idx_specs_created ON specs (created_at DESC);
CREATE INDEX idx_specs_interview_session ON specs (interview_session_id);
CREATE INDEX idx_specs_parent ON specs (parent_spec_id);

-- Full-text search on spec content
CREATE INDEX idx_specs_fts ON specs USING GIN (to_tsvector('english', spec::text));

-- ============================================================================
-- INTERVIEW SESSIONS: Track active and completed interview sessions
-- ============================================================================

CREATE TABLE interview_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(255) UNIQUE NOT NULL,

    -- Ownership
    org_id UUID,
    user_id UUID,

    -- State
    conversation JSONB NOT NULL DEFAULT '[]',
    checklist_state JSONB,
    status VARCHAR(50) NOT NULL DEFAULT 'interviewing',  -- interviewing, spec_ready, spec_generated, converted_to_job, abandoned

    -- Generated spec reference
    generated_spec_id UUID REFERENCES specs(id) ON DELETE SET NULL,

    -- Metadata
    started_at TIMESTAMPTZ DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    abandoned_at TIMESTAMPTZ,

    -- TTL: sessions older than 30 days with no activity can be cleaned up
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days')
);

-- Indexes for interview sessions
CREATE INDEX idx_intsess_session_id ON interview_sessions (session_id);
CREATE INDEX idx_intsess_org_id ON interview_sessions (org_id);
CREATE INDEX idx_intsess_user_id ON interview_sessions (user_id);
CREATE INDEX idx_intsess_status ON interview_sessions (status);
CREATE INDEX idx_intsess_last_activity ON interview_sessions (last_activity_at DESC);
CREATE INDEX idx_intsess_expires ON interview_sessions (expires_at);

-- ============================================================================
-- SPEC COMMENTS: Team collaboration on specs (Phase 2+)
-- ============================================================================

CREATE TABLE spec_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    spec_id UUID NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    org_id UUID,

    -- Comment content
    content TEXT NOT NULL,
    -- Inline annotation: path within the spec JSON (e.g., "environment.observation_space")
    annotated_path TEXT,

    -- Threading
    parent_comment_id UUID REFERENCES spec_comments(id) ON DELETE CASCADE,

    -- Status
    resolved BOOLEAN DEFAULT FALSE,
    resolved_by UUID,
    resolved_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_spec_comments_spec ON spec_comments (spec_id);
CREATE INDEX idx_spec_comments_user ON spec_comments (user_id);
CREATE INDEX idx_spec_comments_parent ON spec_comments (parent_comment_id);
CREATE INDEX idx_spec_comments_resolved ON spec_comments (spec_id, resolved);

-- ============================================================================
-- SPEC APPROVALS: Audit trail of approval actions (Phase 2+)
-- ============================================================================

CREATE TABLE spec_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    spec_id UUID NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
    org_id UUID,

    -- Who took the action
    actor_id UUID NOT NULL,
    actor_role VARCHAR(50) NOT NULL,  -- owner, admin, reviewer, system

    -- Action
    action VARCHAR(50) NOT NULL,  -- submitted, approved, rejected, requested_changes, auto_approved
    reason TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_spec_approvals_spec ON spec_approvals (spec_id);
CREATE INDEX idx_spec_approvals_actor ON spec_approvals (actor_id);

-- ============================================================================
-- SPEC TEMPLATES: Reusable spec templates per org (Phase 2+)
-- ============================================================================

CREATE TABLE spec_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    org_id UUID NOT NULL,
    created_by UUID NOT NULL,

    -- Template content
    name TEXT NOT NULL,
    description TEXT,
    template JSONB NOT NULL,  -- Partial EDP with placeholders

    -- Categories for filtering
    categories TEXT[],
    tags TEXT[],

    -- Usage stats
    usage_count INT NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ,

    -- Status
    is_public BOOLEAN DEFAULT FALSE,  -- visible to all orgs if true
    is_active BOOLEAN DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_spec_templates_org ON spec_templates (org_id);
CREATE INDEX idx_spec_templates_active ON spec_templates (org_id, is_active);
CREATE INDEX idx_spec_templates_categories ON spec_templates USING GIN (categories);
CREATE INDEX idx_spec_templates_tags ON spec_templates USING GIN (tags);

-- ============================================================================
-- ORG APPROVAL POLICIES: Per-org configurable approval workflows (Phase 2+)
-- ============================================================================

CREATE TABLE org_approval_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    org_id UUID NOT NULL UNIQUE,

    -- Policy configuration
    policy JSONB NOT NULL DEFAULT '{}',
    -- Example policy structure:
    -- {
    --   "require_approval": true,
    --   "min_approvers": 1,
    --   "required_roles": ["admin"],
    --   "auto_approve_threshold": 0.0,  -- readiness score threshold for auto-approval
    --   "allow_self_approval": false,
    --   "approval_timeout_hours": 48
    -- }

    -- Status
    is_active BOOLEAN DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_org_ap_policies_org ON org_approval_policies (org_id);

-- ============================================================================
-- TRIGGER: Auto-update updated_at for new tables
-- ============================================================================

CREATE TRIGGER specs_updated_at
    BEFORE UPDATE ON specs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER spec_templates_updated_at
    BEFORE UPDATE ON spec_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER org_approval_policies_updated_at
    BEFORE UPDATE ON org_approval_policies
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- CONSTRAINT: Specs org_id should match the org table when orgs table exists
-- ============================================================================
-- Note: Foreign key to orgs table is added in a later migration to avoid
-- ordering issues. This migration is self-contained.
