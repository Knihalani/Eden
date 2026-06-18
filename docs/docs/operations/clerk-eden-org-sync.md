# Eden ↔ Clerk organisation sync

> Last updated: June 2026 (post dual-org alignment).
> Owner: Platform team.

## Why two systems

The Eden portal uses Clerk for end-user auth (sign-up, sign-in,
session JWT, organisation switcher) and Eden's own Postgres tables
for org membership, RBAC, and audit. The two systems must stay in
lock-step or one of three things breaks:

- **Clerk switcher is empty** → user can't navigate between orgs.
- **Clerk session JWT has no `org_id`/`org_role` claim** →
  `get_current_org` in `src/eden/api/deps.py:297` falls back to the
  `X-Org-Id` header, which works for FE-initiated calls but not for
  background jobs (SCIM, billing webhooks).
- **`useOrganization()` returns null** → the (portal) layout's
  sidebar shows no org name.

## How alignment works

```
                   POST /orgs                       organisation.created
   Eden UI  ───────────────────────▶  FastAPI  ──────────────────────────────▶  Clerk
              returns org_id                Clerk create + webhook
              + clerk_org_id                returns org_2x…
                    │                              │
                    │                              ▼
                    │                       clerk_webhooks._upsert_org
                    │                              │
                    │                              ▼  (backfills clerk_org_id
                    │                                  if not already set)
                    ▼
              INSERT INTO organizations
                (id, clerk_org_id, name, slug, owner_id)
```

Two-sided write:

1. **Eden-first** — `POST /orgs` calls Clerk Backend API, gets
   `clerk_org_id`, writes the Eden row with both `id` (UUID) and
   `clerk_org_id` (Clerk's `org_2x...`). The webhook then fires
   and the handler backfills the same column (no-op).
2. **Clerk-first** — Clerk orgs created via the dashboard or any
   path outside Eden's API. The webhook arrives with no Eden row
   and inserts one (only when `clerk_id` is a valid UUID; the
   non-UUID Clerk default format is logged and skipped).

## Schema

```sql
-- migrations/038_org_clerk_id.sql
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS clerk_org_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_clerk_org_id
    ON organizations (clerk_org_id)
    WHERE clerk_org_id IS NOT NULL;

-- migrations/039_org_member_last_writer.sql
ALTER TABLE org_members
    ADD COLUMN IF NOT EXISTS last_writer_source TEXT NOT NULL DEFAULT 'clerk'
        CHECK (last_writer_source IN ('clerk', 'local'));
```

`clerk_org_id` is nullable for legacy rows; `resolve_clerk_org_id`
in `src/eden/api/utils/clerk_client.py` falls back to `id::text` so
existing webhook-created rows keep working.

`last_writer_source` resolves the role-overwrite race between Eden's
local invite accept and Clerk's `organizationMembership.created`
webhook (Eden invites as `viewer`; Clerk's role mapping collapses
`viewer` to `member`; the webhook would silently demote without the
guard).

## Files

| File | Role |
|---|---|
| `migrations/038_org_clerk_id.sql` | Adds `clerk_org_id` column + partial unique index. |
| `migrations/039_org_member_last_writer.sql` | Adds `last_writer_source` column. |
| `src/eden/api/utils/clerk_client.py` | Thin Clerk Backend API client (httpx). |
| `src/eden/api/routes/orgs.py:create_org` | Server-driven create (Clerk first, then Eden). |
| `src/eden/api/routes/orgs.py:accept_org_invitation` | Per-org accept (delegates to `accept_invitation` in the service). |
| `src/eden/api/routes/auth.py:accept_invitation_by_token` | Paste-token accept. |
| `src/eden/api/routes/clerk_webhooks.py:_upsert_org` | Idempotent webhook handler with UUID guard. |
| `src/eden/api/routes/clerk_webhooks.py:_upsert_membership` | `last_writer_source`-guarded upsert. |
| `src/eden/services/invitation_service.py:accept_invitation` | Local + Clerk membership insert, sets `last_writer_source='local'`. |
| `clients/portal/src/app/(portal)/onboarding/org/page.tsx` | Uses `setActive({ organization: clerkOrgId })` after each accept. |
| `clients/portal/src/hooks/use-org.tsx` | Falls back to Eden `current_org_id` when `clerkOrg` is null. |
| `src/eden/scripts/backfill_legacy_orgs.py` | One-shot backfill for legacy rows. |
| `src/eden/scripts/scan_orphan_clerk_orgs.py` | Read-only audit of Clerk-only orgs. |

## Runbook

### Deploy

Migrations apply with `IF NOT EXISTS` so they're safe to run
out-of-order against a rolling deploy. The standard migration
workflow:

```bash
psql "$DATABASE_URL" -f migrations/038_org_clerk_id.sql
psql "$DATABASE_URL" -f migrations/039_org_member_last_writer.sql
# Deploy API + portal.
```

### Backfill legacy rows

After deploy, every `organizations` row with `clerk_org_id IS NULL`
needs a Clerk org to back the Clerk session JWT. The backfill
script is idempotent and supports `--dry-run`.

```bash
# Preview.
python -m eden.scripts.backfill_legacy_orgs --dry-run --limit 50

# Apply in batches.
python -m eden.scripts.backfill_legacy_orgs --limit 50
python -m eden.scripts.backfill_legacy_orgs --limit 50
python -m eden.scripts.backfill_legacy_orgs          # tail
```

### Audit orphans

Clerk orgs that have no matching Eden row (a write that crashed
mid-transaction between the Clerk API call and the Postgres
insert). Read-only:

```bash
# Human-readable.
python -m eden.scripts.scan_orphan_clerk_orgs

# JSON for piping into ops tooling.
python -m eden.scripts.scan_orphan_clerk_orgs --report-json | jq 'length'
```

The script intentionally never deletes. Decide per-org whether the
orphan's owner should be migrated into Eden, the Clerk org should
be deleted, or it should be left alone.

## Failure modes

| Symptom | Likely cause | Mitigation |
|---|---|---|
| Clerk switcher empty after accept | Webhook delivery race; `setActive` throws | Try the join again; the backend retry is idempotent. |
| Silent role demotion on accept | `last_writer_source` not set on the local insert | Verify migration 039 applied; the `ON CONFLICT DO UPDATE` guard requires the column to exist. |
| Webhook delivery fails with UUID error | `_upsert_org` INSERTing non-UUID `clerk_id` | The handler now catches this and logs `info`. If it appears in production, the webhook delivery is "best effort" — Eden's row is the source of truth. |
| `org_degraded: true` on every create | `CLERK_SECRET_KEY` empty or Clerk outage | Check the API server logs; the response carries the warning so the FE surfaces it. |
| Backfill script reports `skipped=N` | Clerk rejected the slug (already in use) | Inspect the log; usually a duplicate from a previous attempt. Either skip or relink manually. |

## Tests

```bash
.venv/bin/python3 -m pytest tests/integration/test_orgs.py -v
.venv/bin/python3 -m pytest tests/unit/test_org_scripts.py -v
```

Coverage:

- `TestCreateOrgClerkSync` — Clerk-first create + degraded path.
- `TestAcceptInviteClerkSync` — paste-token and per-org accept routes
  surface `clerk_org_id`; tolerate Clerk outages.
- `TestUpsertOrgRace` — webhook handler skips non-UUID INSERTs.
- `TestLastWriterRaceResolution` — local insert marks `last_writer_source`,
  webhook's `DO UPDATE` carries the conditional guard.
- `TestBackfillLegacyOrgsCLI` — argparse surface, dry-run output.
- `TestScanOrphanClerkOrgsLogic` — orphan filter logic.

## Future work (deferred)

- `last_writer_source` could grow into a `last_writer_at` timestamp
  + source to support future side-effects (e.g. SCIM).
- The webhook INSERT path currently uses a `::uuid` cast for safety
  but never produces a row in practice (Eden's `POST /orgs` always
  writes first). Consider dropping it once we confirm all Clerk
  orgs are routed through Eden.
- The orphan scanner is read-only. A `delete-orphans.py` (with
  `--dry-run` default and per-org confirmation) is a small follow-up.
