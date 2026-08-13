---
id: security-model
title: Security model
sidebar_label: Security model
sidebar_position: 4
---

# Security model

Eden's security model is designed around three principles:

1. **Tenant isolation at the data layer** — Postgres RLS, scoped
   queries, no path to leak data across orgs.
2. **PII never reaches storage** — in-place redaction before
   persistence; the original is gone the moment the event lands.
3. **Audit by default** — every mutation logged; every read scoped;
   every key revocable.

## Tenant isolation

### Postgres RLS

Every table that holds org data has an RLS policy that reads the
`app.org_id` GUC. The FastAPI dependency `get_current_org()` is the
only legal way to scope a request — it sets the GUC and the RLS
policies enforce it for every query.

A request that names an org the caller doesn't belong to returns
`403 cross_org_access` from the API and is audited.

### Clerk org mapping

Users live in Clerk. Clerk organisations map 1:1 to Eden orgs:

- `clerk.user_id` → `eden.user_id`
- `clerk.org_id` → `eden.org_id`

When a user is added to a Clerk org (via the dashboard, SSO JIT, or
SCIM), Eden creates the matching Eden org membership. The mapping
is stored in `org_members` with a foreign key to `users` (which is
populated lazily on first Clerk webhook).

### API keys

API keys are per-org and per-scope. A key issued for org A cannot
read org B's data even if the caller passes `X-Org-Id: org_b` —
the auth middleware checks both.

## Encryption

### At rest

- **Postgres** — full-disk encryption (cloud-managed; AWS RDS,
  Neon, etc.).
- **PII columns** — pgcrypto for sensitive columns (PII tags,
  OAuth tokens, API key secrets).
- **Backups** — encrypted via the cloud provider's KMS.

### In transit

- **External** — TLS 1.3 at the ingress (Caddy / nginx / cloud LB).
- **Internal** — mTLS between services in the cluster.

## PII handling

The PII scanner runs **before** the telemetry collector's other
stages. A redaction is irreversible — the original is never stored.

### Built-in patterns

| Pattern | Replacement |
|---------|-------------|
| Email | `[REDACTED:email]` |
| Phone (E.164, US, intl) | `[REDACTED:phone]` |
| SSN | `[REDACTED:ssn]` |
| Credit card (Luhn-validated) | `[REDACTED:cc]` |
| IPv4 / IPv6 | `[REDACTED:ip]` |
| JWT | `[REDACTED:jwt]` |
| AWS access key | `[REDACTED:aws_key]` |

### Custom patterns

Per-org. Add via Settings → PII → Custom patterns. The pattern
runs after the built-ins.

### Fail-closed vs. fail-open

`fail_closed_on_decode_error: true` (default `false`) controls what
happens when the scanner itself fails. Fail-closed drops the event;
fail-open lets it through with a warning.

## Auth

### Three modes

| Mode | Used by |
|------|---------|
| Clerk session cookie | Browser, portal |
| Bearer token (Eden) | Services |
| Clerk JWT | Custom integrations |

The middleware accepts any of the three. The Clerk session is
verified against Clerk's public key; the Eden bearer is verified
against the key hash in `api_keys` (SHA-256, never stored in
plaintext); the Clerk JWT is verified against Clerk's JWKS.

### Roles

| Role | Powers |
|------|--------|
| `owner` | All — billing, members, deletion |
| `admin` | Members, settings, integrations, PII |
| `member` | Read references, run judges |
| `viewer` | Read references |

Custom roles are planned for v2.

### SSO

SAML 2.0 and OIDC via Clerk. Supports Okta, Azure AD, Google
Workspace, OneLogin, JumpCloud, Auth0, and generic IdPs.

See [How-to → SSO](/how-to/sso).

## Audit log

Every mutation lands in `org_audit_log`:

- `api_key.create` / `api_key.revoke` / `api_key.use` (sampled)
- `member.invite` / `member.remove` / `member.role_change`
- `settings.update`
- `judge.create` / `judge.run` / `judge.delete`
- `eval.run`
- `alert.create` / `alert.ack`
- `webhook.create` / `webhook.delete`
- `pii.redaction` (sampled)
- `gdpr.erase`
- `org.archive` / `org.delete`
- `sso.saml_login` / `sso.scim_provision`

Retention: **7 years** by default (configurable via
`settings.audit_log_retention_days`). Export via
`POST /orgs/{org}/export/audit` for long-term archival.

## Compliance evidence packs

Eden ships pre-built evidence packs for:

- **SOC 2** — 50+ controls (CC1–CC9), evidence auto-collected
- **HIPAA** — 18 safeguards (administrative, physical, technical)
- **GDPR** — 10 controls mapped (incl. Article 17 right-to-erasure,
  Article 22 right-to-explanation). Erasure support is real but
  **partial** — see [GDPR right-to-be-forgotten](#gdpr-right-to-be-forgotten)
  below for exactly what is covered today. Eden does not claim GDPR
  certification.
- **ISO 27001** — 14 control families (A.5–A.18)

Each pack maps the controls to specific audit log entries, PII
redactions, and config snapshots. The portal's **Compliance** tab
renders the evidence inline; export as a PDF for your auditor.

## GDPR right-to-be-forgotten

Eden's erasure support is **partial and honestly self-reported**, not
a certified "GDPR-compliant" guarantee. Two paths trigger the same
underlying `RightToBeForgottenService` pass:

- **Self-service** — `DELETE /auth/users/me` (synchronous) or
  `DELETE /api/v1/me` (queued as a background job), reachable from
  **Settings** in the portal as an account danger-zone action. Any
  signed-in user can erase their own account.
- **Admin-triggered** — `POST /orgs/{org_id}/intelligence/governance/rtbf`,
  controlled by the `rtbf_fanout_v1` feature flag (enabled as of wave 2026-08-12).

```bash
curl -X DELETE https://api.edenobservability.com/auth/users/me \
  -H "Authorization: Bearer <user_session_token>" \
  -d '{ "confirm": "DELETE" }'
```

Each request:

1. Anonymises six Postgres tables — `telemetry_events`, `judge_scores`,
   `user_feedback`, `user_sessions`, `conversation_messages`,
   `conversations` — with the user id replaced deterministically
   (`anon_<sha256[:16]>`) so traces that span events still join
   correctly. Self-service deletion additionally scrubs the `users`
   row (email/name anonymised, `password_hash` cleared,
   `token_version` rotated to kill live sessions) and removes org
   memberships.
2. Fans out to secondary stores, reporting **per-store status
   honestly** instead of assuming success:
   - `redis` — **best-effort, currently ineffective**: scans for keys
     matching a user-scoped pattern and deletes any matches, but no
     cache writer in the codebase currently writes keys in that shape,
     so in practice the scan matches zero keys and no real cache data
     is erased today. Tracked for a real fix separately.
   - `qdrant` — real point deletion where the client supports it.
   - `clickhouse` — **tenant-scoped only** today (no `user_id` column
     on the analytics table), not a true per-user erasure.
   - `typesense` — **not yet covered**: reports `status: "unsupported"`
     until an operator runs the one-time backfill
     (`eden.scripts.typesense_backfill_user_id`, not yet executed
     against production as of this writing) and sets
     `typesense_span_user_id_backfilled`. Until then, indexed
     prompt/completion text from spans indexed before the `user_id`
     field existed remains searchable.
   - object storage (S3) — **not implemented**: no per-user object
     index exists, so scoped erasure isn't possible yet.

A request's `fanout_incomplete` flag (in the response and audit log)
is set whenever any store above didn't confirm a real deletion — an
erasure is never reported as complete when part of it didn't run. Do
not describe Eden as fully "GDPR-compliant" in customer-facing
material; describe the specific, currently-covered scope above.

## Self-healing safety

Cat 14's SelfHealer never executes — it always proposes and
requires admin approval. The proposal is gated by:

- `code_change_enabled: true` (org-level opt-in)
- `auto_pr_enabled: true` (admin opt-in to auto-PR)
- `auto_revert_enabled: true` (admin opt-in to auto-revert)

Two-stage opt-in enforced via `_check_two_stage_optin` chokepoint
in the service layer. The SelfHealer captures `before_state` for
rollback and runs in sandbox (Firecracker VM) before any PR is
opened.

Read the [Configuration reference](/reference/configuration) for the full opt-in flags.
for the full opt-in flags.