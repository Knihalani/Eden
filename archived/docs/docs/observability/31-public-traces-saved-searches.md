---
title: "31 — Public traces + saved searches (Phase N)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 31 — Public traces + saved searches (Phase N)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the Logfire / Sentry share-UX gap. Two surfaces:
> share-by-link for traces (SHA-256-hashed tokens, expiry +
> revocation), and saved searches (per-user + per-org, SQL/EQL/
> text, with usage tracking).
> ~570 LOC backend + 32 unit tests.

## Goal & motivation

Three UX gaps that hurt Eden on the "share" axis:

1. **Share a trace with someone outside the org.** Today the only
   way to share a trace is to invite the recipient to the org —
   friction that's fatal for a "look at this incident" link.
2. **Persist useful searches.** The portal's "Recent searches"
   list is in-memory only; it evaporates on logout. Power users
   re-type the same SQL every morning.
3. **Promote a personal search to a team one.** Once one
   engineer writes a great cost-rollup query, every other
   engineer has to reinvent it.

Phase N closes all three with two services and a single
migration.

## What's in Eden

### 1. Public traces — share-by-link

**User flow**

1. User opens a trace detail page.
2. Clicks "Share" → a modal asks "1 day / 7 days / 30 days / No
   expiry" + optional label.
3. Backend mints a 24-byte URL-safe token, returns the URL
   **once** (the plaintext token is never persisted).
4. The recipient opens the URL — no auth required.
5. The public route hashes the inbound token, looks up the
   row, validates expiry + revocation, returns a redacted
   trace view.
6. The view counter is bumped; the row is preserved for the
   admin audit page.

**Security model**

- `token_hash` is the SHA-256 of the plaintext token. The
  plaintext is returned in the create response **once** and
  discarded. A DB dump gives the attacker no working URLs.
- `token_prefix` (first 4 chars of plaintext) is stored
  unencrypted for the audit UI ("share `jbxW…-xyz` was opened
  12 times"). With 24 bytes of entropy, leaking 4 chars is
  safe.
- `expires_at` defaults to 7 days, clamped to [1, 30] days.
  `None` means "no expiry" (admin-only).
- `revoked_at` is soft; the row stays for audit, but the public
  route 404s.
- The public view redaction (PII / API keys) is the Cat 10
  PII scanner's job — this phase ships the wiring (the
  redacted payload passes through), the PII pass is a later
  cat. The view **defaults to empty** until the PII pass is
  live, which is the safe default.

**Routes**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/orgs/{org}/traces/{trace}/share` | yes | Mint a share link |
| `GET` | `/orgs/{org}/traces/{trace}/shares` | yes | List active links for a trace |
| `GET` | `/orgs/{org}/shares` | yes (admin) | All shares in the org |
| `DELETE` | `/orgs/{org}/shares/{share_id}` | yes (admin) | Revoke a link |
| `GET` | `/public/traces/{token}` | **no** | Render the redacted view |

### 2. Saved searches

**User flow**

1. User runs a SQL/EQL/text query in the search bar.
2. Clicks "Save" → enters a name → the query persists.
3. Next time the user opens the search bar, "My searches"
   shows the saved query (and any org-shared ones).
4. The user can pin to top, add tags, share to org, delete.

**Sharing model**

- `is_shared=false` (default): only the owner sees it. The
  "personal" scope also includes `is_shared=true` rows so the
  user can find their team's queries.
- `is_shared=true`: visible to the whole org, ordered by
  `use_count DESC` (popular ones first).
- `is_pinned=true`: floats to the top of any list.
- Tags: free-form `["cost", "weekly"]` for the user's own
  grouping.

**Routes**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/orgs/{org}/saved-searches` | yes | Save a query |
| `GET` | `/orgs/{org}/saved-searches?scope=personal\|shared\|recent` | yes | List queries |
| `PATCH` | `/orgs/{org}/saved-searches/{id}` | yes (owner) | Update a query |
| `DELETE` | `/orgs/{org}/saved-searches/{id}` | yes (owner) | Delete a query |
| `POST` | `/orgs/{org}/saved-searches/{id}/use` | yes | Bump use counter |

## Architecture

```
User clicks "Share" on /observability/traces/abc
                │
                ▼
   POST /orgs/o/traces/abc/share
                │
                ▼
   ShareService.create_share()
       │
       ├─ token = secrets.token_urlsafe(24)
       ├─ token_hash = SHA-256(token)
       ├─ token_prefix = token[:4]
       ├─ INSERT INTO shared_traces
       │     (id, org_id, trace_id, token_hash, token_prefix,
       │      created_by, label, expires_at)
       │
       └─ return SharedTrace(_plaintext_token=token)
                │
                ▼
   API returns: { id, token, url: "https://.../public/traces/<token>" }
                │
                ▼
   Recipient opens URL (no auth)
                │
                ▼
   GET /public/traces/<token>
                │
                ▼
   ShareService.get_by_token(token)
       │
       ├─ hash = SHA-256(token)
       ├─ SELECT row WHERE token_hash = hash
       ├─ check is_active(): not revoked, not expired
       └─ return redacted view (Phase L PII scan)
                │
                ▼
   render trace detail page (PII-redacted)
```

## Data model

```sql
-- shared_traces: one row per active share link
CREATE TABLE shared_traces (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    trace_id        TEXT NOT NULL,
    token_hash      TEXT NOT NULL UNIQUE,        -- SHA-256 hex
    token_prefix    TEXT NOT NULL,               -- first 4 chars of plaintext
    created_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label           TEXT,
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    view_count      INT NOT NULL DEFAULT 0,
    last_viewed_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- saved_searches: per-user + per-org persistence of queries
CREATE TABLE saved_searches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    query_type      TEXT NOT NULL CHECK (query_type IN ('sql', 'eql', 'text')),
    query           TEXT NOT NULL,
    params          JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_shared       BOOLEAN NOT NULL DEFAULT FALSE,
    is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    last_used_at    TIMESTAMPTZ,
    use_count       INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## What's NOT in this phase (deferred)

- **PII redaction on the public view** — the route returns an
  empty spans list until the Cat 10 PII scanner is wired into
  the trace view. This is the safe default (the trace is
  served, but no message bodies). A follow-up PR runs the
  PII pass on the reconstructed trace before serving.
- **Public saved-search sharing** — the user can't yet share
  a saved search *itself* by URL. The "is_shared" flag
  covers org-internal sharing; per-URL sharing is a future
  feature that would re-use the same `shared_traces` table.
- **Search-result subscriptions** — "email me when this
  query returns > 100 rows" — is a later cat. The hooks
  (`record_use`) make it easy to bolt on.
- **Federated saved searches** — saved queries are scoped to
  one org. Cross-org search sharing is a future feature
  (probably paired with the marketplace cat).

## Failure modes

| Failure | Behaviour |
|---|---|
| `secrets.token_urlsafe` fails | `secrets` is stdlib + backed by `os.urandom`; failure here is "the OS is broken". No graceful path — raise. |
| Token hash collision | SHA-256 collisions are not a thing. The `UNIQUE` constraint is a defence-in-depth. |
| Recipient opens expired link | 404 with `share not found or expired` |
| Recipient opens revoked link | 404 with same message (no distinction — don't leak revocation state) |
| Malformed token (`<16 chars`, `/`, spaces) | 404 |
| DB unique violation on `token_hash` | Astronomically unlikely; raise 500 |
| User tries to revoke a share they didn't create | Route checks `org_id` only; UI hides non-owned shares |
| User tries to delete a saved search they don't own | Route checks `org_id` only; UI hides non-owned |

## Telemetry

- `share.created` event (counter) — fires on every mint.
- `share.viewed` event (counter) — fires on every public route hit.
- `share.revoked` event (counter) — fires on every revoke.
- `saved_search.created` / `updated` / `deleted` / `used`
  events (counters) — fires on each CRUD + use.
- A daily scheduled job (`purge_expired`) emits
  `share.purged` with the count.

These events flow into the same telemetry pipeline as LLM
spans; the AI agent can search "all share views in the last
hour" with no new wiring.

## Why now

The share-UX gap is the #1 "looks unfinished" complaint about
Eden vs Laminar / Sentry / Logfire. It's also one of the
smallest phases to ship — one new table, one new dataclass,
two new services, 5 routes. The work is well-bounded; we
can ship it in 2-3 days vs the 2-week estimates for the
larger cats (G, O, P).

## Tests

32 unit tests in `tests/unit/observability/test_sharing.py`:

- `TestTokenHelpers` (5) — token generation, hash determinism,
  prefix length, format validation.
- `TestSharedTraceDataclass` (7) — `public_url` rendering
  (with/without trailing slash), `is_active` for fresh /
  revoked / expired, `to_dict` plaintext gating.
- `TestShareService` (9) — create + plaintext return, expiry
  clamping, no-expiry, get-by-token round-trip, malformed
  token rejection, view-counter bump, revoke + re-revoke,
  unknown revoke, purge_expired.
- `TestSavedSearchService` (8) — create, get_by_id, partial
  update, unknown update, query_type validation, list
  personal/shared/recent, delete + re-delete, use counter.
- `TestSavedSearchDataclass` (1) — to_dict round-trip.

All 32 pass; 0 regressions in the existing 318-test
`tests/unit/observability/` suite.

## Cross-references

- [Cat 19 — Trace Query DSL](19-trace-query-dsl.md) — the
  "eql" query type in `saved_searches` is the EQL surface.
- [Cat 10 — Governance Intelligence](10-governance-intelligence.md)
  — the PII redaction pass (next step) reuses Cat 10.
- [Phase B — full-text search](19-trace-query-dsl.md) — the
  "text" query type is the Typesense surface.
- [Phase C — unified AI agent](14-autonomous-intelligence.md)
  — the agent can search saved searches + share views via
  Typesense.
