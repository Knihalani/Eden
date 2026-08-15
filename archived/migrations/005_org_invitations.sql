-- Create org_invitations table for tokenized email invitations
CREATE TABLE IF NOT EXISTS org_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    token_hash VARCHAR(255) NOT NULL,
    invited_by UUID NOT NULL REFERENCES users(id),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    accepted_at TIMESTAMP WITH TIME ZONE,
    declined_at TIMESTAMP WITH TIME ZONE
);

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON org_invitations(token_hash);

-- Index for listing pending invites per org
CREATE INDEX IF NOT EXISTS idx_org_invitations_org_pending ON org_invitations(org_id, status) WHERE status = 'pending';

-- Index for checking existing invites by email per org
CREATE INDEX IF NOT EXISTS idx_org_invitations_email_org ON org_invitations(email, org_id);