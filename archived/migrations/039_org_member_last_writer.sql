-- ============================================================================
-- Add last_writer_source to org_members for race resolution
-- ============================================================================
-- The Clerk ``organizationMembership.created`` webhook and Eden's local
-- ``accept_invitation`` insert can both write the same ``org_members``
-- row within milliseconds of each other. Previously the webhook used
-- ``ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role``,
-- which always overwrote the local role with Clerk's role string —
-- including when an admin invited a user as ``viewer`` but Clerk's
-- role mapping collapsed ``viewer`` to ``org:member`` (= Eden
-- ``member``), demoting the invitee's role without the operator's
-- knowledge.
--
-- ``last_writer_source`` records which side most recently wrote the
-- row. The webhook now conditionally updates the role only when the
-- previous writer was also Clerk (i.e. the initial race has resolved
-- and Clerk is now the source of truth for subsequent role changes).
--
-- Default ``'clerk'`` is safe for legacy rows: any webhook arriving
-- now sees ``last_writer_source = 'clerk'`` (from the default) and
-- behaves as before.
ALTER TABLE org_members
    ADD COLUMN IF NOT EXISTS last_writer_source TEXT NOT NULL DEFAULT 'clerk'
        CHECK (last_writer_source IN ('clerk', 'local'));

-- The membership lookup that ``get_current_org`` runs in
-- ``src/eden/api/deps.py:297`` shouldn't need to change — adding a
-- column with a constant default doesn't bloat the row.
