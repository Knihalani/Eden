---
id: auth
title: Authenticate with Eden
sidebar_label: Authenticate
sidebar_position: 2
---

# How-to — Authenticate with Eden

Your app authenticates against `https://api.edenobservability.com`.

## For SDKs (recommended)

Create an org API key in the portal (**Settings → API Keys**) or use
**[Fill in](/quickstart)** on the quickstart (appears when you are
signed in on the portal).

```bash
export EDEN_API_KEY="sk_eden_…"
export EDEN_ORG_ID="org_…"
```

The SDKs send:

| Header | Value |
|--------|-------|
| `X-Org-Api-Key` | your API key |
| `X-Org-Id` | your org id |

You do **not** need `EDEN_BASE_URL` for production.

See [Manage API keys](/how-to/api-keys).

## For raw HTTP (ingestion)

```bash
curl -X POST \
  "https://api.edenobservability.com/orgs/$EDEN_ORG_ID/ingest/custom" \
  -H "X-Org-Api-Key: $EDEN_API_KEY" \
  -H "X-Org-Id: $EDEN_ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{ "event_type": "hello", "outcome": "success" }'
```

Full shapes: [Ingestion API](/reference/api-ingestion).

## For the portal (browsers)

Sign in at [edenobservability.com](https://edenobservability.com).
The portal uses Clerk session cookies and proxies API calls — you do
not configure Clerk yourself.

## Roles

| Role | Can create API keys | Typical use |
|------|---------------------|-------------|
| **owner** / **admin** | Yes | Manage workspace |
| **member** / **viewer** | No | Read traces, evals |

## Rotate / revoke

1. Create a new key under **Settings → API Keys**.
2. Deploy it.
3. Revoke the old key in the portal.

Validate with:

```bash
python -m eden_sdk.doctor
# or
npx eden-doctor
```

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `401` / missing key | `EDEN_API_KEY` unset or revoked |
| `403` / wrong org | `EDEN_ORG_ID` does not match the key's org |
| No traces appear | Forgot `flush()` / doctor never run; check **Traces** after ~1 min |
