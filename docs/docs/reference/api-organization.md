---
id: api-organization
title: Organization API
sidebar_label: Organization
sidebar_position: 7
---

# Organization API

Org membership, API keys, and audit. Base host:
`https://api.edenobservability.com`. Paths are under `/orgs/{org_id}/…`
(no `/v1` prefix on these routes).

Most of these endpoints require a **portal session** (Clerk). Creating
API keys for the SDK is easiest from **Settings → API Keys** or
**[Fill in](/quickstart)**.

## API keys (developer path)

### `GET /orgs/{org_id}/api-keys`

List keys (metadata only — secrets are never re-fetched).

### `POST /orgs/{org_id}/api-keys`

Requires org **owner** or **admin**. JSON body:

```json
{
  "name": "SDK",
  "scopes": [
    "references:read",
    "references:write",
    "jobs:read",
    "jobs:write"
  ]
}
```

Response includes `raw_key` **once**:

```json
{
  "id": "ak_…",
  "name": "SDK",
  "key_prefix": "sk_eden_…",
  "scopes": ["references:read", "…"],
  "raw_key": "sk_eden_…"
}
```

### `DELETE /orgs/{org_id}/api-keys/{key_id}`

Revoke immediately.

See [Manage API keys](/how-to/api-keys).

## Members

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/orgs/{org_id}/members` | List |
| `POST` | `/orgs/{org_id}/members` | Invite (`email`, `role`) |
| `DELETE` | `/orgs/{org_id}/members/{user_id}` | Owners only |

Roles: `owner`, `admin`, `member`, `viewer`.

## Audit log

`GET /orgs/{org_id}/audit-log` — append-only mutation history.

## Ingestion (SDK)

Not under this page — see [Ingestion API](/reference/api-ingestion):

`POST /orgs/{org_id}/ingest/{format}` with `X-Org-Api-Key` + `X-Org-Id`.
