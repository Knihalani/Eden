---
id: cost-budgets
title: Set cost budgets + alerts
sidebar_label: Set cost budgets + alerts
sidebar_position: 7
---

# How-to — Set cost budgets + alerts

Per-org budgets on tokens, storage, and sandbox seconds. Soft limits
warn; hard limits block ingest. Alerts route to email, Slack, or
your own webhook.

## Default behaviour

Out of the box, every org has unlimited budgets (free tier).
Crossing a soft limit fires a warning; crossing a hard limit returns
`429 Too Many Requests`.

## Set a budget

### From the portal

**Cost → Budgets → Edit budget**.

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

### From the API

```bash
curl -X PUT https://api.edenobservability.com/v1/orgs/org_abc/budgets \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{
    "tokens": {
      "soft_limit": 2000000000,
      "hard_limit": 3000000000
    }
  }'
```

## Per-agent budgets

Restrict specific agents:

```bash
curl -X POST https://api.edenobservability.com/v1/orgs/org_abc/budgets/agents \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "agent_checkout_v2",
    "tokens": {
      "soft_limit": 500_000_000,
      "hard_limit": 750_000_000
    }
  }'
```

Per-agent limits take precedence over the org-wide limit for events
that carry an `agent_id`.

## Alerts

```bash
curl -X POST https://api.edenobservability.com/v1/budgets/org_abc/alerts \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{
    "channels": ["email", "slack", "webhook"],
    "thresholds": [
      { "resource": "tokens", "percent": 50,  "severity": "info" },
      { "resource": "tokens", "percent": 80,  "severity": "warning" },
      { "resource": "tokens", "percent": 95,  "severity": "critical" }
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

`severity` is one of `info`, `warning`, `critical`. The org owner
gets all severities by email; Slack and webhook channels are
opt-in per channel.

## Anomaly detection

The cost intel service runs a daily z-score check on the daily
total. Configure the sensitivity:

```bash
curl -X PUT https://api.edenobservability.com/v1/orgs/org_abc/cost/anomaly-config \
  -H "Authorization: Bearer sk_eden_admin_..." \
  -H "Content-Type: application/json" \
  -d '{ "z_threshold": 3.0, "lookback_days": 30 }'
```

Anomalies appear in the **Cost → Anomalies** tab and fire the
`cost_anomaly` webhook.

## Forecast

```bash
curl https://api.edenobservability.com/v1/cost/forecast?days=30 \
  -H "Authorization: Bearer sk_eden_..." \
  -H "X-Org-Id: org_abc"
```

Returns a 30-day OLS forecast with 95% confidence intervals. The
model retrains nightly.

## What happens at the hard limit

When usage crosses `hard_limit`, the next ingest call returns:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 3600
X-Quota-Tokens-Status: hard_exceeded

{
  "detail": "tokens hard limit exceeded (3000000000 / 3000000000). Upgrade your plan to continue.",
  "code": "rate_limited",
  "request_id": "req_..."
}
```

The SDKs auto-retry after `Retry-After` seconds. If you'd rather
fail fast, set `max_retries=0` in the SDK config.

## Reset

Budgets reset at the start of each calendar month (UTC). The
period_start in the budget response tells you when the next reset
happens.

```json
{ "period_start": "2026-06-01T00:00:00Z" }
```

If you need a different cadence (e.g. fiscal year), set
`period: "fiscal_year"` in the org policy.