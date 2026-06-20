---
id: api-keys
title: Manage API keys
sidebar_label: Manage API keys
sidebar_position: 3
---

# How-to — Manage API keys

API keys are how services authenticate to Eden. Each key belongs to
one org, has a set of scopes, and can be revoked at any time.

## Issue a key

### From the portal

**Settings → API Keys → New key**.

Fill in:

- **Name** — descriptive label (e.g. `production-east`, `staging-ci`)
- **Scopes** — `ingest`, `read`, `admin` (default: all)
- **Expires at** — optional ISO-8601 date; the key stops working
  after this point

Click **Create**. Copy the secret — it's shown once.

### From the API

```bash
curl -X POST https://api.edenobservability.com/v1/orgs/org_abc/api-keys \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production-east",
    "scopes": ["ingest", "read"],
    "expires_at": "2026-12-31T23:59:59Z"
  }'
```

Response:

```json
{
  "data": {
    "key_id": "ak_abc",
    "secret": "sk_eden_AbCdEf1234...",
    "prefix": "sk_eden_AbCdEf...",
    "scopes": ["ingest", "read"],
    "created_at": "2026-06-19T10:30:00Z",
    "expires_at": "2026-12-31T23:59:59Z"
  }
}
```

## Store the secret

Put it in your secrets manager and load as `EDEN_API_KEY`:

```bash
# Kubernetes
kubectl create secret generic eden-api-key --from-literal=key=sk_eden_...

# AWS Secrets Manager
aws secretsmanager create-secret \
  --name prod/eden/api-key \
  --secret-string "sk_eden_..."

# Doppler / Vault / 1Password — follow your platform's standard flow
```

## Rotate

There's no in-place rotation. To rotate:

1. Issue a new key with the same scopes.
2. Deploy the new key to all services.
3. Verify the new key works (`curl https://api.edenobservability.com/v1/auth/introspect`).
4. Revoke the old key.

There's typically a 24–48 hour overlap where both keys are valid —
the audit log records the issue / first-use / revoke events.

## Revoke

### From the portal

**Settings → API Keys** → click the row → **Revoke**.

### From the API

```bash
curl -X DELETE https://api.edenobservability.com/v1/orgs/org_abc/api-keys/ak_abc \
  -H "Authorization: Bearer sk_eden_admin_..."
```

Revoked keys return `401 not_authenticated` immediately. In-flight
requests that already passed auth keep working until they hit the
server again.

## Least-privilege pattern

Split keys by purpose:

| Purpose | Scopes | Where it goes |
|---------|--------|---------------|
| Production ingestion | `ingest` | App service env |
| Production read | `read` | Dashboard backend |
| CI eval runs | `ingest`, `read` | CI secret store |
| On-call debugging | `read` | PagerDuty runbook |

A compromised ingestion key can only POST events; it can't read
traces or modify org settings.

## Expiry

Set an `expires_at` for any key with limited blast radius:

- CI keys (rotate every 90 days)
- Vendor / consultant keys (expire when the engagement ends)
- Test keys (expire after the test cycle)

Expired keys return `401 not_authenticated` with `code: token_expired`.

## Audit

Every key action emits an entry in `org_audit_log`:

```bash
curl "https://api.edenobservability.com/v1/orgs/org_abc/audit-log?action=api_key.create" \
  -H "Authorization: Bearer sk_eden_admin_..."
```

Actions:

- `api_key.create`
- `api_key.use` (sampled, 1 in 1000 requests)
- `api_key.revoke`
- `api_key.expire`