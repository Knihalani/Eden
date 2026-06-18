-- ============================================================================
-- Add Clerk linkage column to organizations
-- ============================================================================
-- Stores the Clerk organization id (``org_2x…``) returned by Clerk Backend
-- API on ``POST /v1/organizations``. Nullable because:
--
-- 1. Existing rows that were created via the Clerk webhook (where
--    ``organizations.id`` IS the Clerk id) have no value here — they keep
--    working because the read helper at
--    ``src/eden/api/utils/clerk_client.py:resolve_clerk_org_id`` falls
--    back to ``organizations.id`` when the column is NULL.
-- 2. Rows that were created by the legacy Eden ``POST /orgs`` path
--    before this fix landed have ``uuid4()`` ids that Clerk has never
--    seen. We do NOT backfill those: a future script can re-sync by
--    POSTing to Clerk Backend API and rewriting ``clerk_org_id``.
--
-- New rows created via the fixed backend path always carry both ids.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS clerk_org_id TEXT;

-- Partial unique index: rows with clerk_org_id must be unique. NULL
-- remains allowed (legacy webhook-created rows). The partial form
-- avoids interaction with the existing UUID primary-key index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_clerk_org_id
    ON organizations (clerk_org_id)
    WHERE clerk_org_id IS NOT NULL;
