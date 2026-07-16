---
id: environment-variables
title: Environment variables
sidebar_label: Environment variables
sidebar_position: 3
---

# Environment variables

## What application developers set

| Env var | Default | Purpose |
|---------|---------|---------|
| `EDEN_API_KEY` | unset | Org API key (required) |
| `EDEN_ORG_ID` | unset | Org id (required) |
| `EDEN_BASE_URL` | `https://api.edenobservability.com` | Override API host (optional) |
| `EDEN_ENV` | `default` | Environment label on events (Python) |
| `EDEN_DEBUG` | `false` | Verbose SDK logs |

```bash
export EDEN_API_KEY="sk_eden_…"
export EDEN_ORG_ID="org_…"
# EDEN_BASE_URL is optional — SDKs already default to the production API
```

Validate with `python -m eden_sdk.doctor` or `npx @eden-ai/sdk doctor`.

## Portal (Vercel)

| Env var | Production value | Notes |
|---------|------------------|-------|
| `NEXT_PUBLIC_API_URL` | `/api/proxy` | Same-origin browser proxy |
| `API_INTERNAL_URL` | `https://api.edenobservability.com` | Server-side FastAPI upstream |
| `NEXT_PUBLIC_SITE_URL` | `https://edenobservability.com` | |
| Clerk keys | live keys for prod | |

## Platform variables (Eden-operated)

The tables below document variables used by the hosted API and
workers. Customers do not set these unless Eden staff asks you to for
a dedicated tenancy.

### A–C

| Env var | Production note | Used by |
|---------|-----------------|---------|
| `ANTHROPIC_API_KEY` | Provider key | API |
| `APP_BASE_URL` | Public portal/API URL | API |
| `CLICKHOUSE_*` | Analytics store | API |
| `CLERK_*` | Auth | API, Portal |
| `CORS_ORIGINS_RAW` | CSV of portal (+ docs if needed) origins | API |

### D–E (SDK + sampling)

| Env var | Default | Used by | Notes |
|---------|---------|---------|-------|
| `EDEN_API_KEY` | unset | SDKs | Org API key |
| `EDEN_BASE_URL` | `https://api.edenobservability.com` | SDKs | |
| `EDEN_DEBUG` | `false` | Python SDK | |
| `EDEN_ENV` | `default` | SDKs | |
| `EDEN_ORG_ID` | unset | SDKs | |
| `EDEN_SAMPLING_*` | see ops defaults | API | Ingest sampling |

### Remaining platform vars

Postgres, Redis, Qdrant, Stripe, Sentry, and provider keys are
configured on the Eden-operated API. Full historical list (including
local-dev defaults used by Eden engineers) lives in
`src/eden/config.py` / `.env.example` in the repo.

## Precedence

1. Explicit `configure(...)` / CLI flags — highest
2. Environment variables
3. SDK default (`https://api.edenobservability.com`) — lowest
