---
id: api-keys
title: Manage API keys
sidebar_label: Manage API keys
sidebar_position: 3
---

# How-to — Manage API keys

API keys authenticate the SDKs and HTTP ingestion against your org.
Each key belongs to one org and can be revoked at any time.

Keys talk to `https://api.edenobservability.com`.

## Fastest path

If you are signed in on the portal, open the **[Quickstart](/quickstart)**
and use **Fill in** — it creates a key and injects it into a runnable
snippet.

## From the portal

1. Sign in at [edenobservability.com](https://edenobservability.com).
2. Open **Settings → API Keys**.
3. Click **Create API key**, give it a name (e.g. `production`, `SDK`).
4. Copy the secret immediately — it is shown **once**.
5. Copy your **Organization ID** from the same page.

```bash
export EDEN_API_KEY="sk_eden_…"
export EDEN_ORG_ID="org_…"
```

You do **not** need `EDEN_BASE_URL` for production — the SDKs default to
`https://api.edenobservability.com`.

## Scopes

Current portal scopes (used for org API surfaces that check scopes):

| Scope | Purpose |
|-------|---------|
| `references:read` / `references:write` | Code references |
| `jobs:read` / `jobs:write` | Jobs / eval harnesses |

**Ingestion and the gateway** authenticate with a valid org API key
(`X-Org-Api-Key` + `X-Org-Id`). Prefer selecting all scopes when creating
a key for the SDK.

## From the API

Requires an admin session (Clerk JWT). Portal create is the supported
path for most developers.

```bash
curl -X POST "https://api.edenobservability.com/orgs/$EDEN_ORG_ID/api-keys" \
  -H "Authorization: Bearer $CLERK_SESSION_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "SDK",
    "scopes": ["references:read","references:write","jobs:read","jobs:write"]
  }'
```

Response includes `raw_key` once.

## Rotate

1. Create a new key.
2. Deploy it to all services.
3. Confirm with `python -m eden_sdk.doctor` / `npx @eden-ai/sdk doctor`.
4. Revoke the old key in **Settings → API Keys**.

## Revoke

**Settings → API Keys** → trash icon on the row. Revoked keys fail auth
immediately on the next request.

## Next

- [Quickstart](/quickstart)
- [Python SDK](/reference/sdk-python)
- [TypeScript SDK](/reference/sdk-typescript)
