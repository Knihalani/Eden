-- ============================================================================
-- Sidebar preferences (per-user, per-org) — June 2026 Phase 1
-- ============================================================================
-- The portal's ``use-sidebar-prefs`` hook has been GET/PUT-ting
-- ``/orgs/{org_id}/sidebar-prefs`` for a while, but no backend route
-- existed — the hook silently fell back to ``sessionStorage`` (lost
-- on tab close) + ``DEFAULT_PREFS``. This migration + the new
-- ``src/eden/api/routes/sidebar_prefs.py`` route close the loop so
-- the user's pinned/hidden sidebar groups persist cross-device.
--
-- The table is intentionally minimal:
--   * composite PK on (user_id, org_id) — one prefs row per user
--     per org; no separate row-id needed
--   * JSONB ``prefs`` column — the shape is `{pinned, hidden,
--     group_order, density}` and is owned entirely by the client
--     (see ``clients/portal/src/hooks/use-sidebar-prefs.ts``); we
--     don't validate the contents server-side
--   * ``updated_at`` for staleness checks if we ever add a "reset
--     to defaults after N months of inactivity" feature
--
-- No RLS policy here — the route handler enforces ``require_org_member``
-- and only reads/writes the row matching the calling user, so the
-- database-level policy would be redundant.
CREATE TABLE IF NOT EXISTS sidebar_prefs (
    user_id UUID NOT NULL,
    org_id UUID NOT NULL,
    prefs JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, org_id)
);

-- The ``(org_id)`` lookup is what the dashboard uses on first paint
-- when it pre-fetches "everyone's pinned groups" — keep that path
-- index-only.
CREATE INDEX IF NOT EXISTS idx_sidebar_prefs_org_id
    ON sidebar_prefs (org_id);