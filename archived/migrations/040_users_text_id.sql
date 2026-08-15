-- 040_users_text_id.sql
-- June 2026: widen users.id and every FK referencing it from UUID to TEXT.
--
-- Why this exists: the Clerk cutover (June 17) shipped /webhooks/clerk
-- but the schema kept users.id as UUID. Clerk IDs are strings
-- (``user_2x...`` / ``org_2x...``), so every user.created webhook has
-- been failing with ``invalid input syntax for type uuid`` since day
-- one. Result: new Clerk signups never get a Postgres row, /auth/me
-- raises DataError on the SELECT (→ 500), useOrg.currentOrg stays
-- null, and the portal sits in its loading skeleton post-onboarding.
--
-- Scope (verified against the live DB 2026-06-21):
--   - users.id                                    (UUID  → TEXT)
--   - 12 FK-constrained columns referencing users (UUID  → TEXT)
--   - 2 orphan UUID user_id columns (no FK)       (UUID  → TEXT)
--   - 3 RLS policies referencing user_id (direct or indirect)
--     (DROP+recreate with TEXT-typed comparisons)
--
-- Existing UUID values are valid TEXT (e.g.
-- ``e52a8dcc-0ee9-41c9-9951-c740fa446a6c``), so existing rows survive
-- unchanged. The DEFAULT gen_random_uuid() on users.id remains valid
-- because UUID → TEXT is an implicit cast — legacy /auth/signup still
-- works without code changes.
--
-- Order matters:
--   1. Drop FK constraints referencing users(id) (Postgres re-validates
--      ALL of them the moment users.id's type changes.)
--   2. Drop RLS policies that reference user_id DIRECTLY (jobs, specs)
--      OR indirectly (checkpoint_blobs subqueries jobs.user_id).
--      Postgres refuses to ALTER a column used in any policy expression.
--   3. ALTER users.id and every referencing column.
--   4. Re-add FKs and re-create policies with TEXT-typed comparisons
--      (drop the ``::uuid`` cast on the user_id comparison).
--
-- Locking note: ALTER COLUMN TYPE TEXT requires a full table rewrite
-- (UUID storage is 16 bytes fixed; TEXT is variable). For the
-- observed row counts (users: 1, everything else: 0) the rewrite is
-- sub-second. Run during low traffic if row counts have grown.
--
-- Rollback: not provided. Reversing the type would require the same
-- rewrite plus a USING clause that fails on any ``user_2x...`` value.

BEGIN;

-- ============================================================================
-- Step 1: drop every FK constraint that references users(id)
-- ============================================================================
ALTER TABLE code_references   DROP CONSTRAINT IF EXISTS code_references_uploaded_by_fkey;
ALTER TABLE idempotency_keys  DROP CONSTRAINT IF EXISTS idempotency_keys_user_id_fkey;
ALTER TABLE jobs              DROP CONSTRAINT IF EXISTS jobs_user_id_fkey;
ALTER TABLE notifications     DROP CONSTRAINT IF EXISTS notifications_user_id_fkey;
ALTER TABLE org_audit_log     DROP CONSTRAINT IF EXISTS org_audit_log_user_id_fkey;
ALTER TABLE org_invitations   DROP CONSTRAINT IF EXISTS org_invitations_invited_by_fkey;
ALTER TABLE org_members       DROP CONSTRAINT IF EXISTS org_members_invited_by_fkey;
ALTER TABLE org_members       DROP CONSTRAINT IF EXISTS org_members_user_id_fkey;
ALTER TABLE organizations     DROP CONSTRAINT IF EXISTS organizations_owner_id_fkey;
ALTER TABLE scim_identities   DROP CONSTRAINT IF EXISTS scim_identities_user_id_fkey;
ALTER TABLE specs             DROP CONSTRAINT IF EXISTS specs_user_id_fkey;
ALTER TABLE webhooks          DROP CONSTRAINT IF EXISTS webhooks_created_by_fkey;

-- ============================================================================
-- Step 2: drop RLS policies that touch user_id (direct OR via subquery)
-- ============================================================================
-- jobs + specs use user_id directly.
-- checkpoint_blobs subqueries jobs.user_id, so it transitively
-- depends on jobs.user_id's type and must also be dropped.
DROP POLICY IF EXISTS tenant_isolation_jobs            ON jobs;
DROP POLICY IF EXISTS tenant_isolation_specs           ON specs;
DROP POLICY IF EXISTS tenant_isolation_checkpoint_blobs ON checkpoint_blobs;

-- ============================================================================
-- Step 3: widen users.id
-- ============================================================================
ALTER TABLE users
    ALTER COLUMN id TYPE TEXT USING id::text;

-- ============================================================================
-- Step 3b: drop NOT NULL on password_hash (Clerk users don't have one)
-- ============================================================================
-- The Clerk webhook INSERTs users without a password_hash. Legacy
-- /auth/signup rows still have bcrypt hashes; keep the column for
-- those, but allow NULL so the Clerk path doesn't trip the
-- ``null value in column "password_hash"`` constraint.
ALTER TABLE users
    ALTER COLUMN password_hash DROP NOT NULL;

-- ============================================================================
-- Step 4: widen every FK column + the orphan UUID columns
-- ============================================================================
ALTER TABLE code_references   ALTER COLUMN uploaded_by TYPE TEXT USING uploaded_by::text;
ALTER TABLE idempotency_keys  ALTER COLUMN user_id     TYPE TEXT USING user_id::text;
ALTER TABLE jobs              ALTER COLUMN user_id     TYPE TEXT USING user_id::text;
ALTER TABLE notifications     ALTER COLUMN user_id     TYPE TEXT USING user_id::text;
ALTER TABLE org_audit_log     ALTER COLUMN user_id     TYPE TEXT USING user_id::text;
ALTER TABLE org_invitations   ALTER COLUMN invited_by  TYPE TEXT USING invited_by::text;
ALTER TABLE org_members       ALTER COLUMN invited_by  TYPE TEXT USING invited_by::text;
ALTER TABLE org_members       ALTER COLUMN user_id     TYPE TEXT USING user_id::text;
ALTER TABLE organizations     ALTER COLUMN owner_id    TYPE TEXT USING owner_id::text;
ALTER TABLE scim_identities   ALTER COLUMN user_id     TYPE TEXT USING user_id::text;
ALTER TABLE specs             ALTER COLUMN user_id     TYPE TEXT USING user_id::text;
ALTER TABLE webhooks          ALTER COLUMN created_by  TYPE TEXT USING created_by::text;

-- Orphans (no FK, no policy referencing user_id).
ALTER TABLE silver_events     ALTER COLUMN user_id     TYPE TEXT USING user_id::text;
ALTER TABLE usage_events      ALTER COLUMN user_id     TYPE TEXT USING user_id::text;

-- ============================================================================
-- Step 5: re-add every FK constraint (both sides TEXT — valid)
-- ============================================================================
ALTER TABLE code_references   ADD CONSTRAINT code_references_uploaded_by_fkey
    FOREIGN KEY (uploaded_by) REFERENCES users(id);
ALTER TABLE idempotency_keys  ADD CONSTRAINT idempotency_keys_user_id_fkey
    FOREIGN KEY (user_id)     REFERENCES users(id);
ALTER TABLE jobs              ADD CONSTRAINT jobs_user_id_fkey
    FOREIGN KEY (user_id)     REFERENCES users(id);
ALTER TABLE notifications     ADD CONSTRAINT notifications_user_id_fkey
    FOREIGN KEY (user_id)     REFERENCES users(id);
ALTER TABLE org_audit_log     ADD CONSTRAINT org_audit_log_user_id_fkey
    FOREIGN KEY (user_id)     REFERENCES users(id);
ALTER TABLE org_invitations   ADD CONSTRAINT org_invitations_invited_by_fkey
    FOREIGN KEY (invited_by)  REFERENCES users(id);
ALTER TABLE org_members       ADD CONSTRAINT org_members_invited_by_fkey
    FOREIGN KEY (invited_by)  REFERENCES users(id);
ALTER TABLE org_members       ADD CONSTRAINT org_members_user_id_fkey
    FOREIGN KEY (user_id)     REFERENCES users(id);
ALTER TABLE organizations     ADD CONSTRAINT organizations_owner_id_fkey
    FOREIGN KEY (owner_id)    REFERENCES users(id);
ALTER TABLE scim_identities   ADD CONSTRAINT scim_identities_user_id_fkey
    FOREIGN KEY (user_id)     REFERENCES users(id);
ALTER TABLE specs             ADD CONSTRAINT specs_user_id_fkey
    FOREIGN KEY (user_id)     REFERENCES users(id);
ALTER TABLE webhooks          ADD CONSTRAINT webhooks_created_by_fkey
    FOREIGN KEY (created_by)  REFERENCES users(id);

-- ============================================================================
-- Step 6: re-create the RLS policies with TEXT-typed user_id comparisons
-- ============================================================================
-- The originals cast ``current_setting('app.current_user_id', true)``
-- to ``::uuid``. Now user_id is TEXT, so the cast is dropped.
-- ``current_setting(...)`` already returns text, so the comparison is
-- plain string equality.
CREATE POLICY tenant_isolation_jobs ON jobs
    USING (
        (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid)
        OR (user_id = NULLIF(current_setting('app.current_user_id'::text, true), ''::text))
        OR (current_setting('app.current_org_id'::text, true) IS NULL)
    );

CREATE POLICY tenant_isolation_specs ON specs
    USING (
        (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid)
        OR (user_id = NULLIF(current_setting('app.current_user_id'::text, true), ''::text))
        OR (current_setting('app.current_org_id'::text, true) IS NULL)
    );

CREATE POLICY tenant_isolation_checkpoint_blobs ON checkpoint_blobs
    USING (
        ((job_id)::text IN (
            SELECT jobs.job_id
            FROM jobs
            WHERE (
                (jobs.org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid)
                OR (jobs.user_id = NULLIF(current_setting('app.current_user_id'::text, true), ''::text))
                OR (current_setting('app.current_org_id'::text, true) IS NULL)
            )
        ))
        OR (current_setting('app.current_org_id'::text, true) IS NULL)
    );

COMMIT;

-- ============================================================================
-- Post-migration sanity (run manually, not part of the migration)
-- ============================================================================
--
-- 1) Column type check:
--      SELECT column_name, data_type FROM information_schema.columns
--      WHERE table_name='users' AND column_name='id';
--      -- expect: text
--
-- 2) Round-trip a Clerk-format id:
--      INSERT INTO users (id, email, name) VALUES ('user_2xtest', 'x@x', 'X');
--      SELECT id, email FROM users WHERE id='user_2xtest';
--      DELETE FROM users WHERE id='user_2xtest';
--      -- expect: insert succeeds, select returns the row.
--
-- 3) FK count check (should still be 12):
--      SELECT count(*) FROM pg_constraint c
--      JOIN pg_class t ON c.conrelid=t.oid
--      WHERE c.contype='f' AND t.relname IN (
--        'code_references','idempotency_keys','jobs','notifications',
--        'org_audit_log','org_invitations','org_members',
--        'organizations','scim_identities','specs','webhooks'
--      );
--
-- 4) Policy count check (should still be 16):
--      SELECT count(*) FROM pg_policies WHERE schemaname='public';
