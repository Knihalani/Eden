---
id: configuration
title: Configuration
description: "Eden configuration for app developers: required API key and org id, optional base URL and debug settings, plus what the hosted platform manages."
sidebar_label: Configuration
sidebar_position: 2
---

# Configuration

## For application developers

You only need:

| Env var | Purpose |
|---------|---------|
| `EDEN_API_KEY` | Org API key from **Settings → API Keys** |
| `EDEN_ORG_ID` | Org id (same page) |

Optional:

| Env var | Default | When to set |
|---------|---------|-------------|
| `EDEN_BASE_URL` | `https://api.edenobservability.com` | Staging override from Eden staff |
| `EDEN_DEBUG` | `false` | Verbose SDK logs |
| `EDEN_ENV` | `default` | Environment label on events |

See [Environment variables](/reference/environment-variables) (SDK
section) and [Authenticate](/how-to/auth).

Validate with:

```bash
python -m eden_sdk.doctor
npx eden-doctor
```

## Platform configuration (Eden-operated)

The hosted API, portal, and workers are configured by Eden. Customers
do not deploy Postgres, Redis, ClickHouse, or Clerk. Dedicated
tenancy may be discussed under a separate agreement — contact sales@edenobservability.com.

If you are an Eden operator, the full platform variable list lives in
[Environment variables](/reference/environment-variables).
