---
id: deploy
title: Cloud hosting
sidebar_label: Cloud hosting
sidebar_position: 4
---

# How-to — Cloud hosting

Eden is a **managed cloud product**. The control plane (API, portal,
workers, storage) runs on Eden infrastructure — you do **not** self-host
Docker Compose, Helm, or Kubernetes for production use.

## What you run

| Component | Where it runs |
|-----------|----------------|
| Eden API + portal | Eden cloud (`api.edenobservability.com`, `edenobservability.com`) |
| Your agents / LLM apps | Your infra — call Eden via the SDK or gateway |
| Upstream models | Your providers (OpenAI, Anthropic, Bedrock, etc.) |

## Connect your app

1. Create an API key in the portal: **Settings → API Keys**.
2. Point the SDK at the cloud API:

```bash
export EDEN_API_KEY="sk_eden_…"
export EDEN_ORG_ID="org_…"
export EDEN_BASE_URL="https://api.edenobservability.com"
```

3. Follow the [Quickstart](/quickstart).

## Status & support

- Status: [status.edenobservability.com](https://status.edenobservability.com)
- Support: support@eden.dev

Enterprise VPC / dedicated tenancy may be available under contract —
contact sales@eden.dev. That is not a self-hosted distribution.
