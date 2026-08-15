---
title: "13 — Predictive Intelligence (Cat 13, incl. Drift)"
status: "✅ IMPLEMENTED v1 (v0.2 surface: multi-day forecast + CUSUM anomalies + 5-component risk + per-agent cost + capacity scenarios)"
last_updated: 2026-06-12
version: 1.2
---

# 13 — Predictive Intelligence (Cat 13, incl. Drift)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-12).
> 6 v0 services + 1 CUSUM helper + v0.2 surface
> (multi-day forecast, CUSUM-detected anomalies, 5-
> component risk breakdown, per-agent cost rollup,
> capacity scenarios). 75 unit tests pass; full
> `tests/intelligence/` suite green (1 pre-existing
> date-pinned RCA failure + 2 missing-`alembic` Cat 23
> migration tests + 1 missing-`redis` Cat 23 hook test
> are unrelated to this cat).
> **Proactive > reactive.** The judge score drift at 3am
> Tuesday shouldn't be a surprise; the predictive layer
> should have flagged it Monday. This cat ships the
> forecasting + drift-detection infra that turns Eden
> from a "what happened" platform into a "what will
> happen" platform.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles & research](#source-articles--research)
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

Predict future quality, cost, capacity, and risk before
they materialise. Detect drift (output distribution shift,
embedding distribution shift) early.

The user story (the **SRE / platform team** conversation):

> "We want to know: (1) what will our hallucination rate
> be next week, (2) what will our cost be next month,
> (3) do we have enough GPU capacity for Black Friday,
> (4) is there a new failure mode emerging in production
> that the judges haven't caught yet."

## Source articles & research

* **Article 1 §13**: "Predictive Quality (predicted
  hallucination rate, accuracy), Predictive Cost
  (predicted cost, ROI), Predictive Capacity (predicted
  GPU / storage), Drift Detection (output drift,
  embedding drift), Predictive Risk (composite risk
  score)."
* **Article 3 (Phoenix)**: "Drift detection" — the
  output-drift + embedding-drift pattern.
* **Article 3 (Datadog)**: "Hallucination / drift
  detection" — the 2026 production reference.
* **Arize Phoenix (2026)**: the production-grade drift
  library; the v2 implementation integrates the
  Phoenix drift API for embedding-drift specifically.
* **2026 ACM/IEEE publication on time-series drift**:
  PSI (Population Stability Index), KS-test, Wasserstein
  distance, and CUSUM are the four standard drift
  detection algorithms. Eden ships PSI + CUSUM
  (cheap, fast, standard) + KS-test (slower, more
  powerful) as a v2 upgrade.

## What's already in Eden

* `src/eden/data_platform/anomaly_alerts.py` —
  `AnomalyAlert` (existing z-score anomaly detection on
  `data_platform_alerts`). The v0 `DriftDetector.detect_output_drift`
  extends this with PSI + CUSUM.
* `src/eden/llmops/production_monitor.py` —
  `ProductionMonitor` (existing). Subscribes to judge
  scores and emits alerts. The v0
  `QualityPredictor.predict` extends this with
  forecasting.
* `src/eden/services/cost_intel/forecast.py` (Cat 8) —
  `CostForecast` (existing OLS on cost). Cat 13's
  `CostPredictor.predict` re-uses this.
* `src/eden/llmops/judges/{hallucination,correctness}.py`
  (Cat 3) — the judge-score time series is the input
  to `QualityPredictor.predict`.
* The Cat 13 tables (quality_predictions, cost_predictions,
  capacity_forecasts, risk_scores, drift_alerts) are
  already migrated in 020.

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `QualityPredictor.predict` | `src/eden/services/predictive/quality.py` | 1 | M |
| `CostPredictor.predict` | `src/eden/services/predictive/cost.py` | 1 | M |
| `CapacityPredictor.predict` | `src/eden/services/predictive/capacity.py` | 1 | M |
| `RiskScorer.score` | `src/eden/services/predictive/risk.py` | 1 | M |
| `DriftDetector.detect_output_drift` | `src/eden/services/predictive/drift.py` | 1 | L |
| `DriftDetector.detect_embedding_drift` | same | 1 | L |
| **v2 additions:** | | | |
| `EmbeddingDriftDetector.detect` (Phoenix API) | `src/eden/services/predictive/embedding_drift.py` | 1 | M |
| `QualityPredictor.detect_anomalies` (CUSUM) | `src/eden/services/predictive/cusum.py` | 1 | M |
| `RiskScorer.composite` (judge + cost + drift) | `src/eden/services/predictive/composite_risk.py` | 1 | M |

**v0 surface:** 6 services, 6 routes. **v2 surface:**
9 services, 9 routes. v2 adds the Phoenix embedding-
drift API + CUSUM + composite risk.

## API contracts

### `POST /orgs/{org_id}/intelligence/predict/quality`

```json
body: {
  "judge": "hallucination",
  "forecast_horizon": "7d",
  "history_window": "90d"
}
→ {
    "data": {
      "judge": "hallucination",
      "history_window": "90d",
      "forecast_horizon": "7d",
      "predictions": [
        { "date": "2026-06-12", "predicted_score_median": 0.91, "ci_95_low": 0.88, "ci_95_high": 0.93 },
        { "date": "2026-06-13", "predicted_score_median": 0.91, "ci_95_low": 0.87, "ci_95_high": 0.94 },
        ...
        { "date": "2026-06-18", "predicted_score_median": 0.90, "ci_95_low": 0.85, "ci_95_high": 0.94 }
      ],
      "trend": "stable",  // stable|improving|regressing|insufficient_data
      "anomalies": [
        { "date": "2026-05-15", "type": "cusum", "z_score": 3.2, "alert": "judge score dropped 0.05 in 1 day" }
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/predict/cost`

```json
body: {
  "forecast_horizon": "30d",
  "group_by": "agent"
}
→ {
    "data": {
      "forecast_horizon": "30d",
      "predictions": [
        { "date": "2026-07-01", "predicted_cost_usd": 4500, "ci_95_low": 3800, "ci_95_high": 5200 },
        ...
        { "date": "2026-07-10", "predicted_cost_usd": 5200, "ci_95_low": 4100, "ci_95_high": 6300 }
      ],
      "by_agent": {
        "customer_service_v1": { "predicted_total_usd": 180000, "trend": "growing_8pct" },
        "marketing_copywriter_v3": { "predicted_total_usd": 95000, "trend": "stable" }
      },
      "alert": "customer_service_v1 spend growing 8% WoW — investigate"
    }
  }
```

### `POST /orgs/{org_id}/intelligence/predict/capacity`

```json
body: {
  "forecast_horizon": "90d",
  "scenario": "black_friday_3x"  // baseline|2x|3x|5x
}
→ {
    "data": {
      "forecast_horizon": "90d",
      "scenarios": {
        "baseline": { "peak_rpm": 1200, "max_gpu_needed": 8, "max_storage_gb": 5000 },
        "black_friday_3x": { "peak_rpm": 3600, "max_gpu_needed": 24, "max_storage_gb": 15000 }
      },
      "headroom_days": { "baseline": 87, "black_friday_3x": 23 },
      "recommendation": "For Black Friday 3x scenario, you need 24 GPUs by 2026-11-15. Current fleet is 8 GPUs. Add 16 GPUs in the next 30 days."
    }
  }
```

### `POST /orgs/{org_id}/intelligence/predict/detect-drift`

```json
body: {
  "judge": "hallucination",
  "window": "7d",
  "baseline_window": "30d",
  "method": "psi"  // psi|cusum|ks_test|wasserstein
}
→ {
    "data": {
      "judge": "hallucination",
      "window": "7d",
      "baseline_window": "30d",
      "method": "psi",
      "psi_score": 0.18,  // <0.1 = no drift, 0.1-0.2 = moderate, >0.2 = significant
      "drift_alert": "moderate_drift",
      "drift_direction": "regressing",  // regressing|improving|stable
      "drift_summary": "hallucination score distribution shifted; p10 dropped from 0.85 to 0.78 in the last 7d",
      "affected_agents": ["customer_service_v1", "marketing_copywriter_v3"]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/predict/risk`

The composite risk score — the cat's headline query.

```json
body: { "window": "7d" }
→ {
    "data": {
      "composite_risk_score": 0.42,  // 0.0-1.0; > 0.7 = high risk
      "risk_breakdown": {
        "judge_drift": 0.15,
        "cost_volatility": 0.30,
        "latency_p95_trend": 0.10,
        "judge_variance": 0.20,
        "embedding_drift": 0.05
      },
      "alerts": [
        { "type": "judge_drift", "agent": "customer_service_v1",
          "judge": "correctness", "drift_score": 0.22, "alert": "correctness has regressed 4% in 7d" }
      ],
      "recommendation": "investigate — composite risk above 0.4 threshold"
    }
  }
```

## Data model

```sql
-- 1. Quality predictions (one row per day per judge)
CREATE TABLE quality_predictions (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    judge_name          VARCHAR(64) NOT NULL,
    prediction_date     DATE NOT NULL,
    predicted_score_median DOUBLE PRECISION,
    ci_95_low           DOUBLE PRECISION,
    ci_95_high          DOUBLE PRECISION,
    trend               VARCHAR(16) NOT NULL,  -- stable|improving|regressing|insufficient_data
    model               VARCHAR(32) NOT NULL DEFAULT 'ols_arima',  -- ols_arima|prophet|ets
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_quality_predictions
    ON quality_predictions (org_id, judge_name, prediction_date);

-- 2. Cost predictions
CREATE TABLE cost_predictions (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    prediction_date     DATE NOT NULL,
    agent_id            VARCHAR(128),  -- NULL = total
    predicted_cost_usd  DOUBLE PRECISION,
    ci_95_low           DOUBLE PRECISION,
    ci_95_high          DOUBLE PRECISION,
    trend               VARCHAR(16) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_cost_predictions
    ON cost_predictions (org_id, agent_id, prediction_date);

-- 3. Capacity forecasts
CREATE TABLE capacity_forecasts (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    forecast_date       DATE NOT NULL,
    scenario            VARCHAR(16) NOT NULL,  -- baseline|2x|3x|5x
    peak_rpm            INT,
    max_gpu_needed      INT,
    max_storage_gb      INT,
    headroom_days       INT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_capacity_forecasts
    ON capacity_forecasts (org_id, forecast_date, scenario);

-- 4. Composite risk scores
CREATE TABLE risk_scores (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,
    composite_risk_score DOUBLE PRECISION NOT NULL,
    risk_breakdown_json TEXT NOT NULL,  -- {judge_drift, cost_volatility, latency_p95_trend, ...}
    alerts_json         TEXT,
    recommendation      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_risk_scores
    ON risk_scores (org_id, window_end DESC);

-- 5. Drift alerts
CREATE TABLE drift_alerts (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    judge_name          VARCHAR(64),
    drift_method        VARCHAR(32) NOT NULL,  -- psi|cusum|ks_test|wasserstein
    drift_score         DOUBLE PRECISION NOT NULL,
    drift_alert         VARCHAR(32) NOT NULL,  -- no_drift|moderate_drift|significant_drift
    drift_direction     VARCHAR(16) NOT NULL,  -- regressing|improving|stable
    drift_summary       TEXT,
    affected_agents_json TEXT,
    resolved_at         TIMESTAMPTZ,
    resolved_by         VARCHAR(128)
);
CREATE INDEX idx_drift_alerts
    ON drift_alerts (org_id, drift_alert, detected_at DESC);
```

## Algorithm / pseudo-code

### `QualityPredictor.predict` (OLS + ARIMA, Prophet as v2 upgrade)

```python
def predict_quality(org_id, judge_name, horizon_days=7, history_days=90):
    # 1. Pull the per-day judge score history
    history = SELECT date_trunc('day', scored_at) as d,
                     median(score) as s, count(*) as n
              FROM judge_scores
              WHERE org_id = ? AND judge_name = ?
                AND scored_at > now() - INTERVAL '90 days'
              GROUP BY d ORDER BY d
    if len(history) < 14:
        return {"trend": "insufficient_data", "predictions": []}
    # 2. Fit OLS + ARIMA (per 2026 time-series best practice)
    #    v0: OLS only; v2: Prophet with daily + weekly seasonality
    slope, intercept = ols(history.day, history.s)
    arima_fit = arima(history.s, order=(1, 1, 1))  # p, d, q
    # 3. Forecast horizon_days into the future
    predictions = []
    for i in range(horizon_days):
        ols_pred = intercept + slope * (len(history) + i)
        arima_pred = arima_fit.forecast(steps=i+1)[-1]
        ensemble = 0.4 * ols_pred + 0.6 * arima_pred  # ARIMA weighted heavier
        ci_95 = arima_fit.conf_int(alpha=0.05, steps=i+1)[-1]
        predictions.append({
            "date": today + timedelta(days=i+1),
            "predicted_score_median": ensemble,
            "ci_95_low": ci_95[0], "ci_95_high": ci_95[1],
        })
    # 4. Trend + CUSUM anomaly detection
    trend = determine_trend(history.s, slope)
    anomalies = cusum(history.s)  # returns list of {date, z_score}
    return {"predictions": predictions, "trend": trend, "anomalies": anomalies}
```

### `DriftDetector.detect_output_drift` (PSI)

```python
def detect_output_drift_psi(org_id, judge_name, window_days=7, baseline_days=30):
    # 1. Pull score distributions
    baseline = SELECT score FROM judge_scores
               WHERE org_id = ? AND judge_name = ? AND scored_at > now() - make_interval(days => 30+?)
                 AND scored_at < now() - make_interval(days => ?)
    current = SELECT score FROM judge_scores
              WHERE org_id = ? AND judge_name = ? AND scored_at > now() - make_interval(days => ?)
    # 2. Bin into 10 buckets
    bins = np.linspace(0, 1, 11)  # [0, 0.1, 0.2, ..., 1.0]
    baseline_hist = np.histogram(baseline.score, bins=bins)[0] / len(baseline)
    current_hist = np.histogram(current.score, bins=bins)[0] / len(current)
    # 3. PSI = sum((current - baseline) * ln(current / baseline))
    #    Handle 0 buckets: 0 * ln(0/anything) = 0
    psi = 0
    for b, c in zip(baseline_hist, current_hist):
        if b == 0 and c == 0:
            continue
        if b == 0:
            b = 0.0001  # epsilon
        if c == 0:
            c = 0.0001
        psi += (c - b) * np.log(c / b)
    # 4. Classify
    if psi < 0.1:
        alert = "no_drift"
    elif psi < 0.2:
        alert = "moderate_drift"
    else:
        alert = "significant_drift"
    direction = "regressing" if current.score.median() < baseline.score.median() else "improving" if current.score.median() > baseline.score.median() else "stable"
    return {"psi_score": psi, "drift_alert": alert, "drift_direction": direction}
```

### `RiskScorer.score` (composite)

```python
def composite_risk(org_id, window_days=7):
    judge_drift = max(psi_drift_score(org_id, j, window_days) for j in cat3_judges)
    cost_volatility = cost_stddev_7d / cost_mean_7d  # coefficient of variation
    latency_p95_trend = max(0, percentile_trend(org_id, "duration_ms", 0.95, window_days))
    judge_variance = max(judge_score_variance(org_id, j) for j in cat3_judges)
    embedding_drift = embedding_drift_score(org_id, window_days)  # v2
    composite = (
        0.35 * judge_drift +
        0.20 * cost_volatility +
        0.15 * latency_p95_trend +
        0.20 * judge_variance +
        0.10 * embedding_drift
    )
    return {
        "composite_risk_score": min(1.0, composite),
        "risk_breakdown": {
            "judge_drift": judge_drift, "cost_volatility": cost_volatility,
            "latency_p95_trend": latency_p95_trend, "judge_variance": judge_variance,
            "embedding_drift": embedding_drift,
        }
    }
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| Insufficient history (n < 14 days) | `predict` returns `insufficient_data`; the user sees a "collect more data" message |
| Sudden judge-score spike (real incident) | The CUSUM detector fires within hours; Cat 17 `PromotionHook.on_drift_alert` rolls back the canary |
| Drift false positive (an OOD prompt like a holiday greeting) | PSI < 0.1 = no drift; the alert requires PSI > 0.2; alerts fire only on significant drift |
| Cost forecast overestimates (black swan event) | The CI widens to ±50% in the 30-day forecast; the user sees the CI, not the point estimate |
| Capacity forecast underestimates (Black Friday) | The user specifies the `scenario` (baseline, 2x, 3x, 5x); the forecast is per-scenario |
| Composite risk score is too noisy | The `composite_risk_score` is a per-org z-score (normalised against the org's own 90-day history); noise is suppressed by the rolling window |

## Telemetry

* `intelligence_predict_quality` (counter, tagged by `judge`)
* `intelligence_predict_cost` (counter)
* `intelligence_predict_capacity` (counter, tagged by `scenario`)
* `intelligence_predict_drift_alert` (counter, tagged by `severity`)
* `intelligence_predict_risk_score` (histogram)

## Test plan

* `QualityPredictor.predict` matches a hand-rolled
  ARIMA forecast on a 90-day fixture within 5%
* `CostPredictor.predict` matches the existing Cat 8
  `CostForecast` output (no regression)
* `CapacityPredictor.predict` correctly scales RPM
  with the `scenario` multiplier
* `DriftDetector.detect_output_drift` PSI matches
  the reference PSI implementation (scipy) within
  0.01
* `RiskScorer.composite` correctly combines the
  5 component scores with the published weights
* CUSUM correctly fires on a synthetic 3σ drop
* Drift false-positive rate on a 30-day stable fixture
  is < 1%
* RLS: a different org's prediction is never returned

Target: **~22 tests, ~0.9s.**

## Acceptance criteria

- [ ] All 6 v0 services + 3 v2 services implemented
- [ ] QualityPredictor matches ARIMA reference within 5%
- [ ] CostPredictor matches Cat 8 CostForecast
- [ ] CapacityPredictor scales correctly with scenario
- [ ] PSI matches scipy within 0.01
- [x] CUSUM fires on synthetic 3σ drop
- [x] Drift false-positive rate < 1% on stable fixture
- [x] Composite risk score is per-org normalised
- [x] All 75 tests pass (v0 + v0.2 surface)
- [x] RLS verified (uses `eden.storage.postgres.get_postgres_client`
  with the same `org_id` filter as the existing Cat 8 +
  Cat 16 services)

## Open questions

* **Model choice** — OLS+ARIMA in v0; Prophet in v2.1;
  neural (e.g., NHITS, TFT) in v3 if customers ask.
  **Recommendation: ship OLS+ARIMA in v0; Prophet is
  the v2.1 upgrade; neural is overkill for most
  customers.** (Owner: Cat 13 lead)
* **Drift method default** — PSI (fast, standard) vs
  KS-test (more powerful, slower) vs Wasserstein
  (semantically meaningful, slow). **Recommendation: PSI
  as the v0 default; KS-test as the v2.1 upgrade.**
  (Owner: Cat 13 lead)
* **Embedding drift** — Phoenix API (free, OSS) vs
  in-house cosine distance. **Recommendation: Phoenix
  API in v2 (it's the 2026 standard); in-house for
  v0 (10 lines of code, no external dep).** (Owner:
  Cat 13 lead)
* **Composite risk threshold** — 0.4 is the default
  "investigate" threshold; 0.7 is the "page on-call"
  threshold. **Recommendation: configurable per org
  in `organizations.features`.** (Owner: Cat 13 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap) § Cat 13
* Stub envelope: `src/eden/intelligence_envelope.py`
* Anomaly detection (z-score baseline):
  `src/eden/data_platform/anomaly_alerts.py`
* Production monitor (Cat 0):
  `src/eden/llmops/production_monitor.py`
* Cat 8 (cost — `CostForecast` is the upstream OLS):
  [`08-cost-intelligence.md`](./08-cost-intelligence.md)
* Cat 3 (judge — the input to `QualityPredictor`):
  [`03-evaluation-quality-intelligence.md`](./03-evaluation-quality-intelligence.md)
* Cat 2 (RCA — fires on drift detection):
  [`02-root-cause-incidents.md`](./02-root-cause-incidents.md)
* Cat 17 (closed-loop — `PromotionHook.on_drift_alert`
  rolls back canaries on significant drift):
  [`17-closed-loop-wiring.md`](./17-closed-loop-wiring.md)
* Research: 2026 ACM/IEEE time-series drift
  (PSI + CUSUM + KS-test); Arize Phoenix (embedding
  drift); Datadog hallucination drift detection
