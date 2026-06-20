---
id: api-organization
title: Organization API
sidebar_label: Organization
sidebar_position: 7
---

# Organization API

Org membership, API keys, billing, and audit log.

## `GET /v1/orgs/{org_id}`

Org metadata.

```json
{
  "data": {
    "org_id": "org_abc",
    "name": "Acme Corp",
    "slug": "acme",
    "plan": "pro",
    "created_at": "2026-01-01T00:00:00Z",
    "members": 12,
    "seats_limit": 15,
    "tags": ["enterprise-tier-trial"]
  }
}
```

## `POST /v1/orgs/{org_id}/members`

Invite a user.

```json
{
  "email": "alice@acme.com",
  "role": "member"
}
```

`role` is one of `owner`, `admin`, `member`, `viewer`. Custom roles
are out of scope for v1 — see [RBAC](/reference/rbac) for the
planned v2 model.

## `GET /v1/orgs/{org_id}/members`

List members. Filter by `role`.

## `DELETE /v1/orgs/{org_id}/members/{user_id}`

Remove a member. Owners only.

## `GET /v1/orgs/{org_id}/api-keys`

List API keys (metadata only — the secret is shown once on create).

```json
{
  "data": [
    {
      "key_id": "ak_abc",
      "name": "production-east",
      "prefix": "sk_eden_AbCdEf...",
      "scopes": ["ingest", "read"],
      "created_at": "2026-06-01T08:00:00Z",
      "last_used_at": "2026-06-19T10:30:00Z",
      "expires_at": null
    }
  ]
}
```

## `POST /v1/orgs/{org_id}/api-keys`

```json
{
  "name": "production-east",
  "scopes": ["ingest", "read"],
  "expires_at": "2026-12-31T23:59:59Z"
}
```

Response includes the **only** time the secret is shown:

```json
{
  "data": {
    "key_id": "ak_abc",
    "secret": "sk_eden_AbCdEf1234...",
    "prefix": "sk_eden_AbCdEf...",
    "scopes": ["ingest", "read"],
    "created_at": "2026-06-19T10:30:00Z"
  }
}
```

## `DELETE /v1/orgs/{org_id}/api-keys/{key_id}`

Revoke. Existing requests in flight keep working until they hit the
server; new requests return `401`.

## `GET /v1/orgs/{org_id}/audit-log`

Append-only audit log. Every mutation (member add/remove, key
create/revoke, settings change, judge run, eval run, alert ack)
emits one entry.

### Query parameters

| Param | Type | Default |
|-------|------|---------|
| `since` | ISO-8601 | 24h ago |
| `until` | ISO-8601 | now |
| `action` | string | — exact match |
| `user_id` | string | — |
| `limit` | int | 100, max 1000 |

### Response

```json
{
  "data": [
    {
      "id": "audit_abc",
      "org_id": "org_abc",
      "user_id": "u_123",
      "user_email": "alice@acme.com",
      "action": "api_key.create",
      "target_type": "api_key",
      "target_id": "ak_abc",
      "metadata": { "name": "production-east" },
      "ip_address": "203.0.113.42",
      "user_agent": "Mozilla/5.0...",
      "created_at": "2026-06-19T10:30:00Z"
    }
  ]
}
```

The audit log is retained for 7 years by default (configurable via
`settings.audit_log_retention_days`). Export via
`POST /v1/orgs/{org}/export/audit` for long-term archival.

## `POST /v1/orgs/{org_id}/export`

Bulk export of org data (audit log + traces + datasets + agent
registry) as a ZIP archive of NDJSON files.

```json
{
  "include": ["audit_log", "traces", "datasets", "agents"],
  "since": "2026-01-01T00:00:00Z",
  "until": "2026-06-19T00:00:00Z",
  "anonymize_pii": true
}
```

Response is `202 Accepted` with an `export_id`. Poll
`GET /v1/orgs/{org}/exports/{export_id}` for status; when
`status: "complete"`, the response includes a signed download URL
valid for 24 hours.

## Errors

| Status | Code | Cause |
|--------|------|-------|
| 403 | `not_org_member` | Caller is not in the org |
| 403 | `permission_denied` | Caller's role doesn't allow the action |
| 404 | `org_not_found` / `member_not_found` / `key_not_found` | |