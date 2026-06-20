---
id: auth
title: Set up auth
sidebar_label: Set up auth
sidebar_position: 2
---

# How-to — Set up auth

Eden accepts three auth modes on every endpoint. Pick the one that
matches the caller.

## Mode 1 — Clerk session cookie (browsers, the portal)

The portal is built on Next.js + Clerk. When you log in, Clerk sets
a session cookie; the Next.js proxy at `/api/proxy/[...path]`
forwards it as the Clerk `__session` cookie (and attaches a Clerk
Bearer JWT for service-to-service fallback).

Self-hosted portals need:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_..."
CLERK_SECRET_KEY="sk_..."
CLERK_WEBHOOK_SIGNING_SECRET="whsec_..."
```

Clerk → Webhooks → add endpoint `https://your-domain/clerk/webhook`,
subscribe to `user.created`, `user.updated`, `organization.created`,
`organizationMembership.created`, and copy the signing secret.

## Mode 2 — Eden bearer token (services)

Issue from the portal:

```bash
curl -X POST https://api.edenobservability.com/v1/orgs/org_abc/api-keys \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "production-east", "scopes": ["ingest", "read"] }'
```

The response includes the secret **once**:

```json
{
  "data": {
    "key_id": "ak_abc",
    "secret": "sk_eden_AbCdEf1234..."
  }
}
```

Store it in your secrets manager and set as
`EDEN_API_KEY` in the service's env.

### Scopes

| Scope | Allows |
|-------|--------|
| `ingest` | POST events, write judge scores |
| `read` | GET traces, agents, budgets, audit log |
| `admin` | Manage members, rotate keys, change settings |

A key without an explicit scope is full access. To follow least
privilege, issue separate keys for ingestion-only and read-only
consumers.

### Rotation

Issue a new key, deploy the new env var, then revoke the old key:

```bash
curl -X DELETE https://api.edenobservability.com/v1/orgs/org_abc/api-keys/ak_old \
  -H "Authorization: Bearer sk_eden_admin_..."
```

There's no in-place rotation; old keys keep working until you
revoke them. The audit log records both events.

## Mode 3 — Clerk JWT (custom integrations)

If you already authenticate with Clerk, forward the JWT:

```bash
curl https://api.edenobservability.com/v1/traces \
  -H "Authorization: Bearer eyJhbGciOi..." \
  -H "X-Org-Id: org_..."
```

The backend accepts Clerk JWTs in either the `Authorization: Bearer
...` header or the `__session` cookie. The `X-Org-Id` header is
required for ingestion paths.

## Roles

Per-org roles (configured under Settings → Members):

| Role | Permissions |
|------|-------------|
| **owner** | All — including billing, member management, org deletion |
| **admin** | Members, settings, billing view, audit, integrations, PII |
| **member** | Read references, run judges |
| **viewer** | Read references |

Custom roles are planned for v2.

## Cross-org access

Every request must carry a valid `X-Org-Id`. If the caller is a
member of multiple orgs, the header selects which org's data is
in scope. A request that names an org the caller doesn't belong to
returns `403 cross_org_access`.

## Verifying a request server-side

The backend validates the token and resolves the user. If you need
to do this from your own service (e.g. for a custom dashboard), use
the introspection endpoint:

```bash
curl https://api.edenobservability.com/v1/auth/introspect \
  -H "Authorization: Bearer sk_eden_..."
```

Response:

```json
{
  "data": {
    "key_id": "ak_abc",
    "org_id": "org_abc",
    "scopes": ["ingest", "read"],
    "expires_at": null
  }
}
```

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| `401 not_authenticated` | Token missing or expired |
| `401 invalid_token` | Signature mismatch (often a typo or stale key) |
| `403 not_org_member` | Caller is not in the org named by `X-Org-Id` |
| `403 permission_denied` | Role doesn't allow the action (e.g. `member` trying to delete a key) |
| `403 cross_org_access` | API key is for org A, `X-Org-Id` says org B |
| `403 org_archived` | Org has been soft-deleted; restore from the portal |