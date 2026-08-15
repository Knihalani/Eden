-- Notifications for Eden client portal
-- User notifications with read status tracking

-- ============================================================================
-- NOTIFICATIONS
-- ============================================================================

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    type TEXT NOT NULL,  -- e.g., 'job_completed', 'job_failed', 'member_invited', 'billing_alert'
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',  -- Additional context: job_id, org_id, etc.
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX idx_notifications_user_id ON notifications (user_id);
CREATE INDEX idx_notifications_org_id ON notifications (org_id);
CREATE INDEX idx_notifications_user_unread ON notifications (user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC);

-- Trigger to auto-create notification when job completes or fails
-- This is handled in the application layer for flexibility
