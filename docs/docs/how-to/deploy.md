---
id: deploy
title: API endpoint
sidebar_label: API endpoint
sidebar_position: 4
---

# How-to — API endpoint

Production API: **`https://api.edenobservability.com`**

SDKs use that host by default. You do not need `EDEN_BASE_URL` unless
Eden staff points you at a staging override.

## Connect your app

1. Sign in at [edenobservability.com](https://edenobservability.com).
2. Open the [Quickstart](/quickstart) — **Fill in** appears when you are
   signed in — or create a key under **Settings → API Keys**.
3. Install an SDK and send a trace.

```bash
export EDEN_API_KEY="sk_eden_…"
export EDEN_ORG_ID="org_…"
pip install eden-sdk
python -m eden_sdk.doctor
```

Confirm:

```bash
curl -sS https://api.edenobservability.com/live
# {"status":"alive",...}
```

## Portal → API

The portal talks to the API through its same-origin proxy
(`/api/proxy`). Server-side, that proxy should target
`https://api.edenobservability.com` (`API_INTERNAL_URL` on Vercel).

## Status & support

- Support: hello@edenobservability.com

Dedicated tenancy inquiries — contact sales@edenobservability.com.
