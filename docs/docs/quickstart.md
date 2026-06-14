---
title: Quickstart
description: From signup to your first trace in 60 seconds.
sidebar_position: 2
---

# Quickstart

Get from zero to a live trace in your dashboard in about a minute.

## 1. Sign up

Go to **[`https://portal.example.com/signup`](https://portal.example.com/signup)**.
Pick an email + password. You'll land in the onboarding wizard.

> **Self-hosting?** Run `docker compose -f docker/docker-compose.yml up -d`
> from the repo root and visit `http://localhost:3000/signup`. The
> compose stack ships Postgres, Qdrant, Redis, ClickHouse, and pgbouncer.

## 2. Create or join an org

The wizard's first step asks whether you're starting fresh or joining
a team:

- **Create new organisation** — pick a name, optionally invite teammates.
  You become the owner with `integrations:write` permission.
- **Join existing organisation** — paste an invite token or accept one
  of the pending invites listed on the page. Your role (`member` /
  `viewer`) is set by the inviter. If you join with `member` or
  `viewer`, the GitHub repo step is skipped — that step requires
  `integrations:write`, which only owners and admins have. Your admin
  can connect repos for you from the portal at any time.

## 3. Grab your API key

The wizard reveals an API key for the active org. Copy it somewhere
safe — it's shown once.

```bash
export EDEN_API_KEY="eden_sk_…"
export EDEN_DEFAULT_ORG="org_…"
export EDEN_BASE_URL="http://localhost:8000"   # or your portal URL
```

## 4. Install the SDK

Python:

```bash
pip install eden-ai
```

TypeScript:

```bash
npm install @eden-ai/sdk
```

## 5. Send your first trace

Python:

```python
import os
import eden

eden.init(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_DEFAULT_ORG"],
    base_url=os.environ.get("EDEN_BASE_URL", "https://api.eden.ai"),
)

with eden.trace(name="hello-world") as t:
    t.log("First Eden trace 🎉")
    t.usage(input_tokens=10, output_tokens=20, model="gpt-4o-mini")
```

TypeScript:

```ts
import { init, trace } from "@eden-ai/sdk";

init({
  apiKey: process.env.EDEN_API_KEY!,
  orgId: process.env.EDEN_DEFAULT_ORG!,
  baseUrl: process.env.EDEN_BASE_URL ?? "https://api.eden.ai",
});

await trace({ name: "hello-world" }, async (t) => {
  t.log("First Eden trace 🎉");
  t.usage({ inputTokens: 10, outputTokens: 20, model: "gpt-4o-mini" });
});
```

## 6. See it in the dashboard

Open **[`/traces`](/traces)** in the portal. Your trace should appear
within a second or two. Click it to drill into the timeline, see
per-step latency / cost / token usage, and run an LLM judge on the
output.

> **Didn't show up?** Check the API key is for the right org, and
> that `EDEN_BASE_URL` resolves from your machine. The portal's
> Settings → Diagnostics page exposes the last 10 ingestion errors
> for your org.

## What's next

- **[Auto-instrument your agent repo](./onboarding-pr-flow.md)** —
  let Eden open a pull request that wires the SDK into a detected
  LangChain / CrewAI / AutoGen / LlamaIndex / OpenAI / Anthropic
  agent automatically.
- **[Connect more integrations](./integrations/index.md)** — Slack
  alerts, GitHub Actions, Helicone import, Langfuse import.
- **[Set up cost budgets](./optimization/cost.md)** — get notified
  before runaway agent loops burn through your budget.
- **[Configure PII policy](./governance/pii-policy.md)** — what gets
  redacted and what's allowed to land in the dashboard.

## Common gotchas

- **`401 unauthorized`** — the API key is correct but the request is
  missing `X-Org-Id`. The SDK sets this automatically; if you're
  using raw `curl`, add `-H "X-Org-Id: $EDEN_DEFAULT_ORG"`.
- **`429 too many requests`** — you've hit the default per-tenant
  rate limit (60 req / 60s). Upgrade the org tier in Settings →
  Billing, or batch requests via the SDK's auto-buffering.
- **Traces look truncated** — ingestion enforces a 5 MiB body cap.
  Either chunk the trace or pre-redact large payloads with the SDK's
  `eden.redact(body)` helper.
