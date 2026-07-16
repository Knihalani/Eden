---
id: cost-budget-alert
title: Set a cost budget + alert
sidebar_label: Set a cost budget + alert
sidebar_position: 5
---

# Tutorial — Set a cost budget + alert

Time: **10 minutes**. By the end you'll have a per-org monthly token
budget with soft and hard limits, a Slack alert at 80%, and a
webhook alert that fires at 95%.

## What you'll build

- A monthly budget of 2 billion tokens (soft) / 3 billion tokens
  (hard).
- A Slack alert when you cross 80%.
- A webhook to your on-call channel at 95%.
- An automatic hard-limit block at 100%.

## Step 1 — Open the Cost tab

Portal → **Cost** → **Budgets** → **Edit budget**.

## Step 2 — Configure the budget

```json
{
  "tokens": {
    "soft_limit": 2_000_000_000,
    "hard_limit": 3_000_000_000
  },
  "storage_mb": {
    "soft_limit": 1024,
    "hard_limit": 5120
  },
  "sandbox_seconds": {
    "soft_limit": 3600,
    "hard_limit": 7200
  }
}
```

Soft limits warn but allow. Hard limits return `429 Too Many
Requests` on subsequent ingest calls (the SDKs auto-retry, then
bubble).

Save. The budget is now active for the org.

## Step 3 — Configure Slack

If you haven't already:

1. Portal → **Settings** → **Integrations** → **Slack** → **Add**.
2. Authorise Eden in your Slack workspace.
3. Pick the channel for cost alerts (`#cost-alerts` is a sensible
   default).

## Step 4 — Configure the alert rules

Portal → **Cost** → **Alerts** → **New alert**.

```json
{
  "channels": ["email", "slack"],
  "thresholds": [
    { "resource": "tokens", "percent": 50,  "severity": "info" },
    { "resource": "tokens", "percent": 80,  "severity": "warning" },
    { "resource": "tokens", "percent": 95,  "severity": "critical" }
  ]
}
```

Save. The alert fires when **either** the monthly cumulative crosses
the threshold **or** the daily run-rate projects a month-end breach.

## Step 5 — Add a webhook for high severity

```bash
curl -X POST https://api.edenobservability.com/v1/budgets/org_abc/alerts \
  -H "X-Org-Api-Key: $EDEN_API_KEY" \
  -H "X-Org-Id: org_abc" \
  -H "Content-Type: application/json" \
  -d '{
    "channels": ["webhook"],
    "thresholds": [
      { "resource": "tokens", "percent": 95, "severity": "critical" }
    ],
    "webhook_url": "https://your-app.com/eden/budget-alert"
  }'
```

The webhook payload:

```json
{
  "event": "budget.threshold_breach",
  "org_id": "org_abc",
  "resource": "tokens",
  "percent": 95.4,
  "used": 1_908_000_000,
  "soft_limit": 2_000_000_000,
  "hard_limit": 3_000_000_000,
  "severity": "critical",
  "period_start": "2026-06-01T00:00:00Z",
  "request_id": "req_..."
}
```

## Step 6 — Verify the alert

The portal shows a **Test alert** button on each rule. Click it
to send a sample payload to Slack / the webhook URL without waiting
for a real threshold breach.

## Step 7 — Watch the dashboard

Portal → **Cost** → **Dashboard**.

You should see:

- A live progress bar for tokens (1.24B / 2B = 62%).
- A daily cost chart for the last 30 days.
- A 30-day forecast (the curve at the right of the chart).

If the forecast crosses the soft limit, the dashboard surfaces a
yellow banner.

## What you learned

- Budgets are per-resource (tokens, storage, sandbox seconds) and
  per-period (month by default).
- Soft limits warn; hard limits block ingest with HTTP 429.
- Alerts can route to email, Slack, webhooks, or all three.
- The cost dashboard shows a 30-day forecast based on OLS
  regression.

## Where next

- [How-to — Set per-agent budgets](/how-to/cost-budgets)
- [Reference — Cost intelligence API](/reference/api-cost)
- [Explanation — How the forecast is computed](/explanation/sampling-and-retention)