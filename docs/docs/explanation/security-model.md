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
`POST /v1/orgs/{org}/export/audit` for long-term archival.

## Compliance evidence packs

Eden ships pre-built evidence packs for:

- **SOC 2** — 50+ controls (CC1–CC9), evidence auto-collected
- **HIPAA** — 18 safeguards (administrative, physical, technical)
- **GDPR** — 10 controls (incl. Article 17 right-to-erasure,
  Article 22 right-to-explanation)
- **ISO 27001** — 14 control families (A.5–A.18)

Each pack maps the controls to specific audit log entries, PII
redactions, and config snapshots. The portal's **Compliance** tab
renders the evidence inline; export as a PDF for your auditor.

## GDPR right-to-be-forgotten

```bash
curl -X POST https://api.edenobservability.com/v1/orgs/org_abc/gdpr/erase \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -d '{ "user_id": "u_abc" }'
```

Anonymises across:

- `telemetry_events.attributes->>'user_id'`
- `judge_scores.attributes->>'user_id'`
- `usage_events.user_id`
- `notifications.user_id`
- `audit_log.user_id` → `anon_<sha256[:16]>`

The user id is replaced deterministically so traces that span
events still join correctly. No PII leaks.

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