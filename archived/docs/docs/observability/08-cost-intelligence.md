---
title: "08 — Cost Intelligence (Cat 8)"
status: IMPLEMENTED v1
last_updated: 2026-06-11
version: 1.1
---

# 08 — Cost Intelligence (Cat 8)

> **Status:** IMPLEMENTED v1. All 4 services ship real
> implementations reading from the production-grade
> `usage_events` table (populated by `UsageService` at
> `src/eden/services/usage_service.py`) and the `outcomes`
> table (Cat 11, currently empty). Empty `outcomes` table
> degrades gracefully — efficiency returns `null`
> cost_per_outcome for unbucketed groups; ROI returns
> `value=0` and `roi=null` when spend=0. The
> `CostAnomalyDetector` fires the closed-loop
> `PromotionHook.on_drift_alert` for high-severity (|z| > 4)
> anomalies. See `src/eden/services/cost_intel/` for the 4
> services + shared helpers + the `_fire_cost_anomaly_alert`
> hook-firing helper.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles](#source-articles)
3. [What's already in Eden](#whats-already-in-eden)
4. [Feature inventory](#feature-inventory)
5. [API contracts](#api-contracts)
6. [Data model](#data-model)
7. [Algorithm / pseudo-code](#algorithm--pseudo-code)
8. [Failure modes & guardrails](#failure-modes--guardrails)
9. [Telemetry](#telemetry)
10. [Test plan](#test-plan)
11. [Acceptance criteria](#acceptance-criteria)
12. [Open questions](#open-questions)
13. [Cross-references](#cross-references)

## Goal & motivation

Cost per outcome (cost per ticket resolved, per report, per
goal), ROI analysis (spend vs value generated), cost anomaly
detection, and a forward cost forecast.

The user story is:

> "I spent $5,000 on LLM calls last month. How much of that
> was for tickets that actually got resolved? What's my cost
> per resolved ticket? And what's my forecast for next month?"

## Source articles

* **Article 1 §8**: "Cost Attribution (user/customer/workflow/
  agent/tool/model), Cost Drivers (why did costs increase),
  Cost Trends (daily/weekly/monthly), Cost Efficiency (cost
  per ticket, cost per report), ROI Analysis (spend, value
  generated, net return)."
* **Article 2 (Langfuse)**: "Token-level cost tracking with
  per-model pricing and cost attribution by trace, user, or
  session."

## What's already in Eden

* `UsageService` at `src/eden/services/usage_service.py` with
  `get_cost_attribution()` (group_by: user, job, model,
  resource, endpoint, time) backed by `usage_events`.
* `get_daily_usage_series()` — daily trend.
* `get_cost_breakdown()` in `src/eden/api/routes/optimization.py`
  — by_tier, by_node, by_model.
* Redis-backed monthly cost accumulation at
  `eden:cost:{org_id}:month:{month_key}`.

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `CostEfficiencyScorer.score` | `src/eden/services/cost_intel/efficiency.py` | 1 | M |
| `ROIAnalyzer.roi` | same | 1 | M |
| `CostAnomalyDetector.detect` | same | 1 | M |
| `CostForecast.forecast` | same | 1 | L |

## API contracts

```
POST /orgs/{org_id}/intelligence/cost/efficiency
  body: { group_by: "outcome_type", window: "7d" }
  → {
    "data": {
      "per_outcome": [
        { "outcome_type": "ticket_resolved", "cost_per_outcome": 0.42, "sample_size": 1234 },
        { "outcome_type": "report_generated", "cost_per_outcome": 1.20, "sample_size": 89 }
      ]
    }
  }

POST /orgs/{org_id}/intelligence/cost/roi
  body: { window: "30d" }
  → {
    "data": {
      "spend_usd": 5000,
      "value_generated_usd": 50000,  // from outcomes table (Cat 11)
      "net_return_usd": 45000,
      "roi": 9.0   // 9x return
    }
  }

POST /orgs/{org_id}/intelligence/cost/anomalies
  body: { window: "7d" }
  → {
    "data": {
      "anomalies": [
        {
          "type": "cost_spike",
          "severity": "high",
          "observed_usd": 1234.56,
          "expected_range_usd": [200, 400],
          "deviation_percent": 308.6,
          "likely_cause": "agent=planner, model=gpt-4, 2026-06-09"
        }
      ]
    }
  }

GET  /orgs/{org_id}/intelligence/cost/forecast?horizon_days=7
  → {
    "data": {
      "forecast": [
        { "day": "2026-06-11", "predicted_cost_usd": 150.0, "lower": 100.0, "upper": 200.0 },
        { "day": "2026-06-12", "predicted_cost_usd": 160.0, "lower": 110.0, "upper": 210.0 }
      ]
    }
  }
```

## Data model

```sql
-- 1. Cost efficiency scores: cost per outcome
CREATE TABLE cost_efficiency_scores (
    id                UUID PRIMARY KEY,
    org_id            VARCHAR(128) NOT NULL,
    group_by_key      VARCHAR(64) NOT NULL,
    group_by_value    VARCHAR(128) NOT NULL,
    cost_per_outcome  DOUBLE PRECISION,
    sample_size       INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. ROI analyses
CREATE TABLE roi_analyses (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    window          VARCHAR(32) NOT NULL,
    spend_usd       DOUBLE PRECISION NOT NULL,
    value_usd       DOUBLE PRECISION NOT NULL,
    roi             DOUBLE PRECISION,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Algorithm / pseudo-code

The implementation in `src/eden/services/cost_intel/efficiency.py`
follows the pseudo-code below one-to-one. The shared helpers
(window parser, OLS regression, envelope builders, persistence,
closed-loop hook firing) live in
`src/eden/services/cost_intel/_common.py`. The Cat 8 service
constants (`Z_THRESHOLD = 2.5`, `HIGH_Z_THRESHOLD = 4.0`,
`MIN_FORECAST_HISTORY_DAYS = 14`, `FORECAST_HISTORY_DAYS = 90`,
`CONF_BAND_LOWER = 0.8`, `CONF_BAND_UPPER = 1.2`) live at the
top of `_common.py`.

### Cost efficiency (join `usage_events` with `outcomes`)

`CostEfficiencyScorer.score` — see
`src/eden/services/cost_intel/efficiency.py:CostEfficiencyScorer.score`.

```python
def score(org_id, group_by, window):
    # 1. Whitelist group_by (anti SQL-injection on metadata->>$group_by)
    if group_by not in ALLOWED_GROUP_BY: return bad_request_envelope
    interval = _parse_window(window)  # "7d" -> "7 days" (or None)

    # 2. Aggregate cost by group_by dimension
    cost = SELECT
        COALESCE(metadata->>$group_by, '__missing__') AS group_value,
        SUM(cost_usd)::float8                        AS total_cost
        FROM usage_events
        WHERE org_id = ? AND created_at > NOW() - interval
        GROUP BY 1

    # 3. Aggregate outcomes by outcome_type (only when group_by == "outcome_type")
    outcomes = SELECT type, COUNT(*) FROM outcomes
               WHERE org_id = ? AND created_at > NOW() - interval
               GROUP BY 1

    # 4. Join in Python; degrade gracefully when outcomes are empty
    per_outcome = []
    for gv, c in cost.items():
        oc = outcomes.get(gv, 0) if group_by == "outcome_type" else 0
        per_outcome.append({
            "outcome_type": gv,
            "cost_per_outcome": c / oc if oc > 0 else None,
            "sample_size": oc,
            "total_cost_usd": c,
            "warning": "no_outcomes_in_window" if oc == 0 else None,
        })

    # 5. Persist per-group rows (best-effort, re-runnable)
    _delete_then_insert_efficiency(org_id, group_by, rows)
    return ok_envelope(per_outcome=per_outcome, group_by=group_by, window=window)
```

### ROI

`ROIAnalyzer.roi` — see
`src/eden/services/cost_intel/efficiency.py:ROIAnalyzer.roi`.

```python
def roi(org_id, window):
    interval = _parse_window(window)
    spend = SUM(cost_usd) FROM usage_events WHERE org_id=? AND created_at > NOW() - interval
    value = SUM(value)    FROM outcomes       WHERE org_id=? AND created_at > NOW() - interval
    net_return = value - spend
    roi = (value - spend) / spend if spend > 0 else None  # null on zero spend
    _delete_then_insert_roi(org_id, window, spend, value, roi)
    return ok_envelope(spend_usd=spend, value_generated_usd=value, net_return_usd=net_return, roi=roi)
```

### Anomaly detection (z-score on the daily cost series)

`CostAnomalyDetector.detect` — see
`src/eden/services/cost_intel/efficiency.py:CostAnomalyDetector.detect`.

```python
def detect(org_id, window):
    interval = _parse_window(window)
    daily = SELECT date_trunc('day', created_at), SUM(cost_usd)
            FROM usage_events WHERE org_id=? AND created_at > NOW() - interval
            GROUP BY 1 ORDER BY 1

    if len(daily) == 0: return ok_envelope(message="no usage data", anomalies=[])
    if len(daily) < 2:  return ok_envelope(message="insufficient history for z-score", anomalies=[])

    costs = [r.cost for r in daily]
    mean = sum(costs) / len(costs)
    stdev = sqrt(sum((c - mean) ** 2 for c in costs) / (len(costs) - 1))
    if stdev == 0: return ok_envelope(message="no variance in window", anomalies=[])

    anomalies = []
    anomalous_days = []
    for r in daily:
        z = (r.cost - mean) / stdev
        if abs(z) <= Z_THRESHOLD:  # 2.5
            continue
        severity = "high" if abs(z) > HIGH_Z_THRESHOLD else "medium"  # 4.0
        anomalies.append({
            "type": "cost_spike" if z > 0 else "cost_drop",
            "severity": severity,
            "observed_usd": r.cost,
            "expected_range_usd": [mean - 2 * stdev, mean + 2 * stdev],
            "deviation_percent": (r.cost - mean) / mean * 100,
            "z_score": z,
            "day": r.day,
            "likely_cause": None,  # filled below
        })
        anomalous_days.append(r.day)

    # Single batched attribution query (one call, not per-day)
    top_by_day = _fetch_top_attribution_for_days(org_id, anomalous_days)
    for a in anomalies:
        a["likely_cause"] = _format_likely_cause(top_by_day.get(a["day"]))

    # Fire closed-loop hook for high-severity anomalies
    _fire_cost_anomaly_alert(org_id, anomalies)  # no-op in stub mode

    return ok_envelope(anomalies=anomalies, mean_usd=mean, stdev_usd=stdev, days_observed=len(daily))
```

### Forecast (linear regression)

`CostForecast.forecast` — see
`src/eden/services/cost_intel/efficiency.py:CostForecast.forecast`.

```python
def forecast(org_id, horizon_days):
    daily = SELECT date_trunc('day', created_at), SUM(cost_usd)
            FROM usage_events WHERE org_id=? AND created_at > NOW() - INTERVAL '90 days'
            GROUP BY 1 ORDER BY 1

    if not daily: return ok_envelope(forecast=[], message="no usage data", model="linear_regression_v1")

    if len(daily) < MIN_FORECAST_HISTORY_DAYS:  # 14
        # Mean fallback — emit horizon_days rows of the mean with ±20% band
        mean_cost = mean(daily)
        return ok_envelope(forecast=[mean]*horizon_days, warning="insufficient_history", model="mean_fallback")

    # OLS linear regression on (day_index, daily_cost)
    n = len(daily)
    slope, intercept = _linear_regression(range(n), [r.cost for r in daily])
    forecast_rows = []
    for i in range(1, horizon_days + 1):
        predicted = slope * (n + i - 1) + intercept
        forecast_rows.append({
            "day": last_day + timedelta(days=i),
            "predicted_cost_usd": predicted,
            "lower": predicted * CONF_BAND_LOWER,   # 0.8
            "upper": predicted * CONF_BAND_UPPER,   # 1.2
        })
    return ok_envelope(forecast=forecast_rows, model="linear_regression_v1", slope=slope, intercept=intercept)
```

## Failure modes & guardrails

The implementation now handles these edge cases explicitly:

* **No usage events in the window** — return empty results
  with `data.message: "no usage data"` (all 4 services).
* **No outcomes in the window** — efficiency returns
  `sample_size: 0` and `cost_per_outcome: null` (with
  `warning: "no_outcomes_in_window"`); ROI returns
  `value_generated_usd: 0` and `roi: null` when spend > 0.
* **Forecast with < 14 days of history** — fall back to the
  window mean with `warning: "insufficient_history"` and
  `model: "mean_fallback"`.
* **Anomaly detector with < 2 days of history** — return
  empty anomalies with `message: "insufficient history for
  z-score"` (sample stdev needs ≥ 2 points).
* **Anomaly detector with zero-variance window** (every day
  the same) — return empty anomalies with
  `message: "no variance in window"`.
* **Bad `group_by` value** (anything outside the
  `ALLOWED_GROUP_BY` whitelist) — return
  `bad_request` envelope with a 4xx-class message; this
  prevents SQL injection via the `metadata->>$group_by`
  parameter.
* **Bad `window` string** (anything the parser can't
  interpret) — return `bad_request` envelope.
* **Hook firing failure** — `_fire_cost_anomaly_alert`
  catches any exception from the hook and logs at DEBUG
  level; the response is never broken by hook errors.
* **Persistence failure** — `_delete_then_insert_efficiency`
  and `_delete_then_insert_roi` are best-effort; any
  exception is logged and swallowed so the response always
  returns the in-memory data.

## Telemetry

The services log the following counters at INFO/DEBUG level;
a future Phase 2 run can wire these to Prometheus:

* `intelligence_cost_efficiency` (counter, tagged by
  `group_by`)
* `intelligence_cost_anomaly` (counter, tagged by `severity`)
* `intelligence_cost_forecast_latency_ms` (histogram)

## Test plan

The full test surface lives in
`tests/intelligence/test_cost_intelligence.py` (48 tests
across 8 sections):

* `TestCostEfficiencyScorer` (7): empty-window, group-by
  math, no-outcomes → null, persistence, bad group_by, bad
  window, non-outcome group_by → null per-outcome.
* `TestROIAnalyzer` (7): zero/zero, positive ROI, negative
  ROI, zero-spend + value, persistence, empty outcomes,
  bad window.
* `TestCostAnomalyDetector` (7): no history, single day,
  cost-spike, cost-drop, |z|>4 → high, attribution,
  zero-variance.
* `TestFireCostAnomalyAlert` (3): no-high-doesn't-fire,
  high-fires-with-correct-kwargs, hook-exception-no-
  propagate.
* `TestCostForecast` (6): no history, < 14 days → mean
  fallback, 15-day constant → flat forecast, upward trend,
  horizon respected, confidence-band math.
* `TestEnvelopeHelpers` (3): shape contracts.
* `TestLinearRegression` (5): perfect fit, constant series,
  two-point fit, zero-length, all-x-identical.
* `TestPackageContract` (3): lazy re-exports, unknown
  attribute, `__dir__`.
* Route smoke tests (5): all 4 routes + 1
  routes-registered-under-intelligence-cost-tag test.

## Acceptance criteria

- [x] Efficiency breaks down by `outcome_type` with sample
  sizes.
- [x] Anomaly detection flags ≥ 1 anomaly in a synthetic
  cost-spike dataset.
- [x] Forecast mean absolute percentage error < 20% on a
  held-out 7-day window.
- [x] ROI computation handles negative ROI cleanly.
- [x] ROI computation handles zero spend (returns null).

## Open questions

* **Value attribution** — how do we put a dollar value on
  "ticket resolved" or "report generated"? Customer-defined?
  Default lookup table? (Owner: Cat 8 + Cat 11 leads)
* **Forecast model** — linear regression, Prophet, or a
  custom model? (Owner: Cat 8 lead)
* **Anomaly severity** — heuristic (z-score thresholds) or
  learned? (Owner: Cat 8 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap)
* Stub envelope: `src/eden/intelligence_envelope.py`
* Existing usage service:
  `src/eden/services/usage_service.py`
* Cat 11 (Outcome — source of `outcomes` table):
  [`11-outcome-roi-intelligence.md`](./11-outcome-roi-intelligence.md)
