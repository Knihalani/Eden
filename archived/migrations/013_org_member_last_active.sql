-- Add last_active_at to org_members for tracking member activity
ALTER TABLE org_members ADD COLUMN last_active_at TIMESTAMPTZ;

CREATE INDEX idx_org_members_last_active ON org_members (last_active_at);