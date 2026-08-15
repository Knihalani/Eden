# N03: Continuous Production Eval Sampling

| Field | Value |
|---|---|
| **Feature ID** | N03 |
| **Slug** | `continuous-production-eval-sampling` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Market hypothesis** | Static eval suites rot; buyers want live quality scores on production traffic |
| **Dependencies** | Cat 3 judges, F44, F20, StatGate, N16, N22, F28 |

---

## 1. Summary

Always-on **production quality measurement** — sample traces (1–5% default), score with budgeted judge suites, trend pass rates hourly, and auto-escalate drift to F28 stumbles. Complements F44 (offline curation) and N01 (regression gates) with **live** health signals for N05 fleet dashboard and autonomous maintenance.

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| Cat 3 judge definitions | `evaluation/` | No production sampler |
| StatGate hard guardrails | `supplementaries/phase_6_stat_gate/` | Pre-filter exists, not wired to sampler |
| Judge scoring infra | eval runner | No `production_eval_scores` table |
| N16 tail sampling | spec | Composes — N16 decides *what* to retain; N03 decides *what* to score |

**Cost gap:** No daily budget cap, no SLM cascade, no stumble-priority override.

---

## 3. Target behavior

```
trace.finalized
    → N16 retention decision (store full vs tail)
    → SamplingPolicy.should_score(trace)?
        ├─ F28 stumble → 100% score
        ├─ StatGate hard fail → skip (already flagged)
        ├─ random sample → policy.sample_rate
        └─ budget check → skip if cap hit
    → Lightweight judge suite (SLM first)
    → Store ProductionEvalScore row
    → Aggregate hourly → agent quality trend
    → Anomaly (2σ drop) → F28 stumble kind=quality_drift
    → N17 card if autonomous tier ≥ T1
```

### Operator vs autonomous

| Mode | Behavior |
|---|---|
| **Normal** | Operator sets policy in portal; reviews trend charts |
| **Assisted (T2)** | Auto-create F28 stumble on 2σ drop; suggest N01 case capture |
| **Autonomous (T3)** | Auto-trigger N18 prompt canary when fail_rate > SLO 2h |

---

## 4. Architecture

| Component | Path | Role |
|---|---|---|
| `ProductionEvalSampler` | `src/eden/evaluation/production/sampler.py` | Policy + budget gate |
| `JudgeCascade` | `evaluation/production/judge_cascade.py` | SLM → escalate |
| `HourlyAggregator` | `evaluation/production/aggregator.py` | MV refresh |
| `QualityDriftDetector` | `evaluation/production/drift.py` | 2σ anomaly |
| Portal | `/agents/{id}/quality` | Trend charts |

**Worker placement:** Subscribe to `trace.finalized` on quality pipeline worker (N14) — not ingest hot path.

---

## 5. Data model

```sql
CREATE TABLE production_eval_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    agent_id TEXT,  -- NULL = org default
    sample_rate FLOAT NOT NULL DEFAULT 0.02,
    judge_ids UUID[] NOT NULL,
    max_cost_usd_per_day FLOAT DEFAULT 50.0,
    min_eval_pass_rate FLOAT,  -- SLO for alerting
    slm_only BOOLEAN DEFAULT true,
    enabled BOOLEAN DEFAULT true,
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE production_eval_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    trace_id UUID NOT NULL,
    agent_id TEXT,
    judge_id UUID NOT NULL,
    score FLOAT NOT NULL,
    passed BOOLEAN,
    cost_usd FLOAT,
    latency_ms INT,
    judge_tier TEXT,  -- 'slm', 'frontier'
    scored_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX production_eval_scores_agent_hour_idx
    ON production_eval_scores (org_id, agent_id, scored_at DESC);

CREATE MATERIALIZED VIEW production_eval_hourly AS
SELECT org_id, agent_id, date_trunc('hour', scored_at) AS hour,
       avg(score) AS avg_score, count(*) AS n,
       sum(CASE WHEN NOT passed THEN 1 ELSE 0 END)::float / nullif(count(*),0) AS fail_rate,
       sum(cost_usd) AS cost_usd
FROM production_eval_scores GROUP BY 1,2,3;

CREATE TABLE production_eval_daily_spend (
    org_id UUID NOT NULL,
    date DATE NOT NULL,
    spend_usd FLOAT DEFAULT 0,
    traces_scored INT DEFAULT 0,
    PRIMARY KEY (org_id, date)
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET/PATCH` | `/orgs/{id}/production-eval/policies` | CRUD policies |
| `GET` | `/orgs/{id}/agents/{agent_id}/quality/trend` | Hourly aggregates |
| `GET` | `/orgs/{id}/agents/{agent_id}/quality/failures` | Recent failing traces |
| `POST` | `/orgs/{id}/production-eval/score/{trace_id}` | Manual score (debug) |

**EQL:** `production_eval.fail_rate > 0.1 last 1h by agent_id`

**MCP:** `get_production_quality_trend(agent_id, window=7d)`

---

## 7. Implementation plan

1. Migration + policy CRUD API
2. `ProductionEvalSampler` on quality worker (requires N14)
3. `JudgeCascade` — reuse Cat 3 judge runner with tier flag
4. Hourly MV refresh via pg_cron or tick worker
5. `QualityDriftDetector` → F28 stumble + F47 digest
6. Portal trend page + N05 fleet widget integration

---

## 8. Cost control (critical)

| Guard | Behavior |
|---|---|
| Daily budget cap | Stop sampling when `max_cost_usd_per_day` hit; alert N17 |
| Priority sampling | Always score F28 stumble traces (100%) |
| SLM cascade | Haiku-class first (~$0.001/trace); Sonnet only if `0.4 < score < 0.6` |
| StatGate pre-filter | Skip traces already failed hard guardrails ($0) |
| N22 budget | `daily_autonomy_budget_usd` includes prod eval spend |

### Cost model

| Profile | Sample rate | Judges | Est. $/1k traces/day |
|---|---|---|---|
| Conservative | 1% | SLM ×2 | $0.02 |
| Standard | 2% | SLM ×3 | $0.06 |
| Deep | 5% | SLM + frontier 10% | $0.15 |

At 10k traces/day, 2% + SLM ≈ **$0.60/day** — well under $50 cap.

---

## 9. Feature flags & rollout

| Flag | Default |
|---|---|
| `production_eval_sampling_v1` | off |
| `production_eval_auto_stumble` | on when v1 |
| `production_eval_slm_cascade` | on |

Requires N14 quality worker running.

---

## 10. Test plan

- Policy 2% → ~200 scores on 10k fixture traces (statistical tolerance)
- Budget cap at $1 → sampling stops mid-day
- Stumble trace always scored even at cap (priority override)
- 2σ drop fixture → F28 stumble within 1h aggregation window
- SLM cascade: borderline score triggers frontier judge

---

## 11. Acceptance criteria

- [ ] 2% sample rate on 10k traces/day stays under daily budget
- [ ] Stumble traces always scored (100% sample)
- [ ] Hourly aggregate visible in portal within 15 min
- [ ] 2σ quality drop creates F28 stumble within 1h
- [ ] Policy CRUD in portal Settings → Production Eval
- [ ] N05 fleet health card shows eval pass rate
- [ ] N22 cost budget includes production eval spend

---

## 12. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| should_score decision | 2ms | 10ms | 25ms |
| SLM judge per trace | 800ms | 3s | 8s |
| Frontier escalate | 2s | 8s | 20s |
| Hourly MV refresh | 10s | 60s | 120s |
| Trend API | 40ms | 200ms | 500ms |

### Caching strategy

- Policy lookup: Redis 60s `(org_id, agent_id)`
- Daily spend counter: Redis atomic incr, flush to PG hourly
- Trend API: serve from MV — no live aggregation

### Degradation modes

- Judge provider down → skip score, increment `production_eval_degraded`
- Budget 90% → reduce sample_rate 50% automatically
- Worker backlog >10k → drop random sample, keep stumble priority

### Monitoring

```
eden_production_eval_scored_total{tier,passed}
eden_production_eval_cost_usd_total
eden_production_eval_budget_exceeded_total
eden_production_eval_drift_stumble_total
eden_production_eval_sampler_lag_seconds
```

---

## 13. Differentiation vs F44

| F44 | N03 |
|---|---|
| Nightly batch clustering → datasets | Real-time sampling → scores |
| Curates **cases** for CI | Measures **live** quality |
| Offline | Online with budgets |

**Compose:** N03 detects drift → F44/N01 capture failing traces as regression cases.

---

*See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.3, [PERFORMANCE-COST-STANDARDS.md](../PERFORMANCE-COST-STANDARDS.md).*
