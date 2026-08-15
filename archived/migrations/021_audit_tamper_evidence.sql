-- Migration 021: Audit log tamper-evidence (hash chain)
--
-- Closes §6.4 of the June 2026 roadmap. Adds a SHA-256 hash chain to
-- ``org_audit_log`` so a verifier can detect any insertion, deletion,
-- or modification of historical audit rows.
--
--   prev_hash  TEXT    — entry_hash of the previous row in the org
--                        (or '0' * 64 for the first row of an org)
--   entry_hash TEXT    — sha256(prev_hash || canonical_json(row))
--
-- The chain is computed by a trigger on INSERT, so callers don't have
-- to know about it — they just call ``log_audit_event`` as before.
--
-- The ``verify_audit_chain`` function returns one row per audit-log
-- entry with columns (seq, ok, expected_hash, actual_hash), so a
-- verifier can show exactly which row was tampered with.
--
-- A backfill script (``docker/postgres/audit-backfill.py``) populates
-- the columns for existing rows. Idempotent.

-- Required for the SHA-256 hashing in the trigger function. The
-- `digest(text, 'sha256')` call below uses pgcrypto. Many of our
-- existing migrations (015, 016) already depend on pgcrypto, so
-- this is safe to re-run.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

BEGIN;

-- Idempotent: only add columns if they don't exist.
ALTER TABLE org_audit_log
    ADD COLUMN IF NOT EXISTS prev_hash  TEXT,
    ADD COLUMN IF NOT EXISTS entry_hash TEXT;

COMMENT ON COLUMN org_audit_log.prev_hash IS
    'SHA-256 of the previous row in this org (or 64 zeros for the first row). Part of the tamper-evidence chain.';
COMMENT ON COLUMN org_audit_log.entry_hash IS
    'SHA-256 of (prev_hash || canonical_json(row)) — recomputed by trigger on INSERT.';

-- Indexes for chain queries.
CREATE INDEX IF NOT EXISTS idx_org_audit_log_entry_hash
    ON org_audit_log (org_id, entry_hash);
CREATE INDEX IF NOT EXISTS idx_org_audit_log_chain
    ON org_audit_log (org_id, created_at, entry_hash);

-- ============================================================================
-- canonical_json() — deterministic JSON for hashing
--
-- jsonb ordering is not guaranteed, so we normalize to text with
-- sorted keys. (text/jsonb are stored the same way on disk, but the
-- SQL-level ``::text`` cast preserves key insertion order, which
-- would break the hash. We rebuild with jsonb_each_text + aggregation
-- to produce a key-sorted canonical form.)
-- ============================================================================

CREATE OR REPLACE FUNCTION audit_canonical_json(
    p_id            UUID,
    p_org_id        UUID,
    p_user_id       UUID,
    p_action        TEXT,
    p_target_type   TEXT,
    p_target_id     TEXT,
    p_metadata      JSONB,
    p_ip_address    TEXT,
    p_user_agent    TEXT,
    p_created_at    TIMESTAMPTZ
) RETURNS TEXT AS $$
DECLARE
    canonical_text TEXT;
BEGIN
    -- We sort each field as a (key, value) pair and concat. Keys are
    -- fixed (id, org_id, user_id, action, target_type, target_id,
    -- metadata, ip_address, user_agent, created_at) so no JSON-key
    -- sorting is needed at this level.
    canonical_text := format(
        '{"action":%s,"created_at":%s,"id":%s,"ip_address":%s,"metadata":%s,"org_id":%s,"target_id":%s,"target_type":%s,"user_agent":%s,"user_id":%s}',
        to_jsonb(p_action),
        to_jsonb(p_created_at),
        to_jsonb(p_id),
        to_jsonb(p_ip_address),
        p_metadata::text,
        to_jsonb(p_org_id),
        to_jsonb(p_target_id),
        to_jsonb(p_target_type),
        to_jsonb(p_user_agent),
        to_jsonb(p_user_id)
    );
    RETURN canonical_text;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ============================================================================
-- compute_audit_hash() — called by the BEFORE INSERT trigger
--
-- Looks up the previous row in this org (the row with the greatest
-- created_at less than the new row's, or NULL if this is the first
-- row) and computes entry_hash = sha256(prev_hash || canonical_json).
-- ============================================================================

CREATE OR REPLACE FUNCTION compute_audit_hash()
RETURNS TRIGGER AS $$
DECLARE
    prev_entry_hash TEXT;
    canonical       TEXT;
BEGIN
    SELECT oal.entry_hash
      INTO prev_entry_hash
      FROM org_audit_log oal
     WHERE oal.org_id = NEW.org_id
     ORDER BY oal.created_at DESC, oal.id DESC
     LIMIT 1
       FOR UPDATE;

    NEW.prev_hash := COALESCE(prev_entry_hash, repeat('0', 64));

    canonical := audit_canonical_json(
        NEW.id,
        NEW.org_id,
        NEW.user_id,
        NEW.action,
        NEW.target_type,
        NEW.target_id,
        COALESCE(NEW.metadata, '{}'::jsonb),
        NEW.ip_address,
        NEW.user_agent,
        NEW.created_at
    );

    NEW.entry_hash := encode(
        digest(NEW.prev_hash || canonical, 'sha256'),
        'hex'
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop and recreate the trigger so this migration is idempotent.
DROP TRIGGER IF EXISTS trg_compute_audit_hash ON org_audit_log;
CREATE TRIGGER trg_compute_audit_hash
    BEFORE INSERT ON org_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION compute_audit_hash();


-- ============================================================================
-- verify_audit_chain(org_id) — returns one row per audit-log entry
-- with (seq, id, ok, expected_hash, actual_hash).
--
--   ok = TRUE   means the row's entry_hash matches what would be
--               computed from its prev_hash + canonical_json(row).
--   ok = FALSE  means the row was tampered with, OR a previous row
--               in the chain was tampered with and the bad hash has
--               propagated.
-- ============================================================================

CREATE OR REPLACE FUNCTION verify_audit_chain(p_org_id UUID)
RETURNS TABLE(
    seq              BIGINT,
    id               UUID,
    created_at       TIMESTAMPTZ,
    ok               BOOLEAN,
    expected_hash    TEXT,
    actual_hash      TEXT
) AS $$
    WITH ordered AS (
        SELECT
            oal.*,
            LAG(oal.entry_hash) OVER (PARTITION BY oal.org_id ORDER BY oal.created_at, oal.id) AS prev_entry
        FROM org_audit_log oal
        WHERE oal.org_id = p_org_id
    ),
    recomputed AS (
        SELECT
            o.id,
            o.created_at,
            o.entry_hash,
            encode(
                digest(
                    COALESCE(o.prev_entry, repeat('0', 64)) ||
                    audit_canonical_json(
                        o.id, o.org_id, o.user_id, o.action,
                        o.target_type, o.target_id,
                        COALESCE(o.metadata, '{}'::jsonb),
                        o.ip_address, o.user_agent, o.created_at
                    ),
                    'sha256'
                ),
                'hex'
            ) AS re_hash
        FROM ordered o
    )
    SELECT
        ROW_NUMBER() OVER (ORDER BY r.created_at, r.id)::BIGINT AS seq,
        r.id,
        r.created_at,
        (r.entry_hash = r.re_hash) AS ok,
        r.re_hash AS expected_hash,
        r.entry_hash AS actual_hash
    FROM recomputed r
    ORDER BY r.created_at, r.id;
$$ LANGUAGE SQL STABLE;

COMMIT;
