-- Organization Audit Log for Eden
-- Tracks all significant org actions with user, timestamp, and change details

-- ============================================================================
-- ORG AUDIT LOG
-- ============================================================================

CREATE TABLE org_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    user_id UUID NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,  -- e.g., 'member.invited', 'member.removed', 'member.role_changed'
    target_type TEXT,      -- e.g., 'user', 'reference', 'settings'
    target_id TEXT,        -- ID of the affected entity (if applicable)
    metadata JSONB DEFAULT '{}',  -- Additional context: diffs, old/new values, etc.
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX idx_org_audit_log_org_id ON org_audit_log (org_id);
CREATE INDEX idx_org_audit_log_user_id ON org_audit_log (user_id);
CREATE INDEX idx_org_audit_log_action ON org_audit_log (org_id, action);
CREATE INDEX idx_org_audit_log_created_at ON org_audit_log (org_id, created_at DESC);

-- Composite index for filtered queries
CREATE INDEX idx_org_audit_log_org_action_created ON org_audit_log (org_id, action, created_at DESC);
CREATE INDEX idx_org_audit_log_org_user_created ON org_audit_log (org_id, user_id, created_at DESC);