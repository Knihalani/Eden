---
id: api-cost
title: Cost intelligence API
sidebar_label: Cost intelligence
sidebar_position: 6
---

# Cost intelligence API

Read and configure the per-org cost surface: budgets, alerts,
forecasts, anomaly detection, and per-department rollups.

## `GET /v1/budgets`

Fetch the active budgets for an org.

### Response

```json
{
  "data": {
    "org_id": "org_abc",
    "period": "month",
    "period_start": "2026-06-01T00:00:00Z",
    "tokens": {
      "used": 1_240_000_000,
      "soft_limit": 2_000_000_000,
      "hard_limit": 3_000_000_000,
      "percentage": 62.0,
      "status": "ok"
    },
    "storage_mb": {
      "used": 240,
      "soft_limit": 1024,
      "hard_limit": 5120,
      "percentage": 23.4,
      "status": "ok"
    },
    "sandbox_seconds": {
      "used": 1200,
      "soft_limit": 3600,
      "hard_limit": 7200,
      "percentage": 33.3,
      "status": "ok"
    },
    "plan_name": "pro",
    "total_cost_usd": 142.50
  }
}
```

`status` is one of `ok`, `soft_exceeded`, `hard_exceeded`. Crossing
the soft limit fires a warning webhook; crossing the hard limit
returns `429 Too Many Requests` on subsequent ingest calls (with
`Retry-After`).

## `POST /v1/budgets/{org_id}/alerts`

Configure budget alerts.

```json
{
  "channels": ["email", "slack", "webhook"],
  "thresholds": [
    { "resource": "tokens", "percent": 50, "severity": "info" },
    { "resource": "tokens", "percent": 80, "severity": "warning" },
    { "resource": "tokens", "percent": 95, "severity": "critical" }
  ],
  "webhook_url": "https://your-app.com/eden/budget-alert"
}
```

`channels`:
- `email` — sends to the org owner's email
- `slack` — posts to the org's configured Slack channel (Settings →
  Integrations → Slack)
- `webhook` — POSTs a JSON body to `webhook_url`

## `GET /v1/cost/summary`

Per-day cost breakdown for the last N days.

### Query parameters

| Param | Type | Default |
|-------|------|---------|
| `days` | int | 30 |
| `group_by` | string | `model` — also `agent_id`, `realm`, `department` |

### Response

```json
{
  "data": {
    "period_start": "2026-05-20T00:00:00Z",
    "period_end": "2026-06-19T00:00:00Z",
    "total_cost_usd": 4120.50,
    "by_day": [
      { "date": "2026-06-18", "cost_usd": 142.50, "tokens": 124_000_000 },
      { "date": "2026-06-19", "cost_usd": 138.20, "tokens": 119_500_000 }
    ],
    "by_model": [
      { "model": "gpt-4o-mini", "cost_usd": 2400.00, "share": 0.582 },
      { "model": "claude-3-5-sonnet-20240620", "cost_usd": 1500.00, "share": 0.364 },
      { "model": "text-embedding-3-small", "cost_usd": 220.50, "share": 0.054 }
    ]
  }
}
```

## `GET /v1/cost/anomalies`

Anomalies flagged by the cost intel service (z-score on the daily
total, configured per org).

```json
{
  "data": [
    {
      "anomaly_id": "anom_abc",
      "detected_at": "2026-06-19T03:00:00Z",
      "kind": "z_score",
      "z": 4.2,
      "expected_usd": 140.00,
      "actual_usd": 412.00,
      "attributed_to": { "model": "gpt-4o", "agent_id": "agent_research_v3" }
    }
  ]
}
```

## `GET /v1/cost/forecast`

Linear-regression forecast for the next 30 days based on the last
90. Used by the portal's **Forecast** tab.

```json
{
  "data": {
    "horizon_days": 30,
    "series": [
      { "date": "2026-06-20", "predicted_usd": 145.20, "lower_ci": 132.00, "upper_ci": 158.40 }
    ],
    "model": { "type": "ols", "r_squared": 0.84 },
    "mean_fallback": false
  }
}
```

## `GET /v1/cost/outcomes`

ROI rollup by department. The CFO killer query.

```json
{
  "data": {
    "departments": [
      {
        "department": "support",
        "cost_usd": 1200.00,
        "outcomes": { "tickets_resolved": 2400, "csat_avg": 4.3 },
        "cost_per_outcome_usd": 0.50,
        "roi": 14.2
      }
    ]
  }
}
```

ROI is computed as `(value_of_outcomes - cost) / cost`. The
`value_of_outcomes` formula is configurable per org.

## Errors

| Status | Code | Cause |
|--------|------|-------|
| 402 | `payment_required` | Hard limit hit and the org has no overage budget |
| 422 | `invalid_threshold` | Threshold percent outside `0 < p < 100` |