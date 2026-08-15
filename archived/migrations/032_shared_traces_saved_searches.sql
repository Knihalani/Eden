-- June 2026: Public traces (share-by-link) + saved searches (Phase N).
--
-- Two surfaces that close the gap to Logfire / Sentry share UX:
--
-- 1) shared_traces — one row per active "share this trace" link.
--    A trace is shared by minting a signed token; we store the
--    SHA-256 hash of the token (never the plaintext), plus the
--    expiry + revocation state. The plaintext token is returned
--    to the user once and never persisted. The public route
--    hashes the inbound token, looks up the row, validates the
--    expiry, and returns a redacted view of the trace.
--
-- 2) saved_searches — per-user + per-org persistence of queries
--    (SQL / EQL / full-text). The portal's "Recent searches" and
--    "Save this query" flows read/write this table. Sharing
--    a search to the org is a separate `is_shared` flag.
--
-- Security model
-- ──────────────
--   * shared_traces.token_hash is the SHA-256 of the token. The
--     plaintext token never lands on disk. If the DB is dumped,
--     the attacker cannot reconstruct the URLs.
--   * Default expiry is 7 days. The user can request 1/7/30 days.
--   * Revocation sets ``revoked_at``; the public route short-
--     circuits on it. Admins can revoke from the UI.
--   * The public view redacts PII (email/SSN/API keys) via the
--     Cat 10 PII scanner before serialising.
--
--   * saved_searches: per-user by default; ``is_shared = true``
--     makes it visible to the whole org. Owner_id is always set
--     so we can audit who saved what.

CREATE TABLE IF NOT EXISTS shared_traces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    trace_id        TEXT NOT NULL,
    -- SHA-256 hex of the plaintext token. The plaintext is only
    -- returned to the user once (on creation) and never stored.
    token_hash      TEXT NOT NULL UNIQUE,
    -- 4-character prefix of the plaintext token, so the UI can
    -- show "share: abcd-…-xyz" without ever holding the secret.
    -- Helps users recognise which share link is which in the
    -- settings page.
    token_prefix    TEXT NOT NULL,
    -- The user who created the share. Audit field.
    created_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Optional human label ("incident-2026-06-17") for the
    -- org's own bookkeeping.
    label           TEXT,
    -- When the share link stops working. NULL = never expires
    -- (admins only; default deny on missing expiry).
    expires_at      TIMESTAMPTZ,
    -- Soft revocation: row stays for audit, but the public
    -- route 404s once revoked_at is set.
    revoked_at      TIMESTAMPTZ,
    -- Lightweight usage counter — bumped by the public route.
    -- Lets the UI show "this link was opened 12 times".
    view_count      INT NOT NULL DEFAULT 0,
    last_viewed_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shared_traces_org_created
    ON shared_traces (org_id, created_at DESC);
-- token_hash is already UNIQUE so the lookup-by-hash is O(log n).
CREATE INDEX IF NOT EXISTS idx_shared_traces_trace
    ON shared_traces (org_id, trace_id);


CREATE TABLE IF NOT EXISTS saved_searches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- ``owner_id`` is always the user who saved the search.
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Display name (user-supplied or auto-derived from the query).
    name            TEXT NOT NULL,
    -- ``sql`` | ``eql`` | ``text`` (Phase B Typesense full-text).
    -- ``sql`` is the read-only Postgres-fdw surface (Phase M);
    -- ``eql`` is the trace query DSL (Cat 19); ``text`` is the
    -- Typesense FTS surface (Phase B).
    query_type      TEXT NOT NULL
        CHECK (query_type IN ('sql', 'eql', 'text')),
    -- The query text. For ``sql`` this is a SELECT-only statement;
    -- for ``eql`` this is an EQL expression; for ``text`` this is
    -- the FTS query string.
    query           TEXT NOT NULL,
    -- Optional structured params (e.g. SQL parameter binds) so
    -- the query + params round-trip safely.
    params          JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- ``is_shared = true`` makes the search visible to the whole
    -- org. Admins can promote a personal search to org-wide.
    is_shared       BOOLEAN NOT NULL DEFAULT FALSE,
    -- Star/pin the search to the top of the list.
    is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
    -- Per-search tags for grouping (e.g. ``["cost", "weekly"]``).
    tags            TEXT[] NOT NULL DEFAULT '{}',
    -- Usage tracking for "recent searches" / "popular searches".
    last_used_at    TIMESTAMPTZ,
    use_count       INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user list (sidebar / dropdown).
CREATE INDEX IF NOT EXISTS idx_saved_searches_owner_updated
    ON saved_searches (owner_id, updated_at DESC);
-- Org-wide "shared" view.
CREATE INDEX IF NOT EXISTS idx_saved_searches_org_shared
    ON saved_searches (org_id, is_shared, updated_at DESC)
    WHERE is_shared = TRUE;
-- Pinned searches first.
CREATE INDEX IF NOT EXISTS idx_saved_searches_org_pinned
    ON saved_searches (org_id, is_pinned DESC, updated_at DESC);


-- Trigger: keep ``updated_at`` fresh on every UPDATE.
CREATE OR REPLACE FUNCTION saved_searches_touch_updated() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_saved_searches_touch_updated ON saved_searches;
CREATE TRIGGER trg_saved_searches_touch_updated
    BEFORE UPDATE ON saved_searches
    FOR EACH ROW EXECUTE FUNCTION saved_searches_touch_updated();


COMMENT ON TABLE shared_traces IS
    'Phase N: trace share-by-link (Logfire parity). token_hash is '
    'SHA-256 of the plaintext; the plaintext is never stored.';
COMMENT ON TABLE saved_searches IS
    'Phase N: per-user + per-org persistence of SQL/EQL/text '
    'searches. Replaces the portal "recent searches" in-memory cache.';
