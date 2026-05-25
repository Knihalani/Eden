-- Organization archive and soft-delete support

-- Add archived_at for soft-delete (archive)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Add deleted_at for hard-delete tracking (permanent deletion)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Index for querying active (non-archived) orgs
CREATE INDEX IF NOT EXISTS idx_orgs_archived_at ON organizations (archived_at) WHERE archived_at IS NULL;