---
id: deploy
title: Cloud hosting
sidebar_label: Cloud hosting
sidebar_position: 4
---

# How-to — Cloud hosting

Eden is a **managed cloud product**. You do not self-host the API, portal,
or workers. Your agents run on your infra and talk to Eden over HTTPS.

## Connect your app

1. Open [Quickstart](https://edenobservability.com/quickstart) and click **Fill in**,
   or create a key under **Settings → API Keys**.
2. Install an SDK and send a trace — see [Quickstart](/quickstart).

The SDKs default to `https://api.edenobservability.com`. You do not need
`EDEN_BASE_URL` unless you are pointed at a staging override by Eden staff.

## Custom domain for the API (`api.edenobservability.com`)

If the API currently serves from a Northflank ingress
(e.g. `eden-api--….northflank.app`), point your apex subdomain at it:

1. **Northflank** → project → `eden-api` service → **Domains** → **Add domain**
   → enter `api.edenobservability.com`.
2. Northflank shows the target (usually a CNAME to `….northflank.app` or
   their edge). Copy it.
3. In your DNS provider (Cloudflare, Route53, etc.) create:

   | Type | Name | Value |
   |------|------|--------|
   | `CNAME` | `api` | the Northflank target from step 2 |

   If the zone is apex-only and CNAME is disallowed, use the ALIAS/ANAME
   record Northflank documents for your DNS host.
4. Wait for DNS + Northflank TLS (often a few minutes). Confirm:

   ```bash
   curl -sS https://api.edenobservability.com/live
   ```

5. Ensure portal env `NEXT_PUBLIC_API_URL` (or equivalent) is
   `https://api.edenobservability.com`, and API `CORS_ORIGINS` includes
   `https://edenobservability.com`.

## Status & support

- Status: [status.edenobservability.com](https://status.edenobservability.com)
- Support: support@eden.dev

Enterprise dedicated tenancy (not self-host) — contact sales@eden.dev.
