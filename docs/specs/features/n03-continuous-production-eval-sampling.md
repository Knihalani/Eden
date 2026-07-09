# N03: Continuous Production Eval Sampling

| Field | Value |
|---|---|
| **Feature ID** | N03 |
| **Slug** | `continuous-production-eval-sampling` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Market hypothesis** | Static eval suites rot; buyers want live quality scores on production traffic |
| **Dependencies** | Cat 3 judges, F44, F20, StatGate |

---

## 1. Problem

Teams run evals pre-deploy but **production drift** (model updates, prompt A/B, tool API changes) degrades quality silently. Bento/Raindrop pitch "always-on eval" — sample production traces, score with lightweight judges, trend pass rate over time.

Eden has judges and StatGate but no **continuous sampling pipeline** with cost controls.

---

## 2. Target behavior

```
trace.finalized
    → SamplingPolicy decides: score? (1-5% default, configurable)
    → Lightweight judge suite (latency-budgeted SLM first)
    → Store ProductionEvalScore row
    → Aggregate hourly → agent quality trend
    → Anomaly → F28 stumble if score drops >2σ
```

---

## 3. Data model

```sql
CREATE TABLE production_eval_policies (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT,
    sample_rate FLOAT NOT NULL DEFAULT 0.02,
    judge_ids UUID[] NOT NULL,
    max_cost_usd_per_day FLOAT DEFAULT 50.0,
    enabled BOOLEAN DEFAULT true
);

CREATE TABLE production_eval_scores (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    trace_id UUID NOT NULL,
    agent_id TEXT,
    judge_id UUID NOT NULL,
    score FLOAT NOT NULL,
    passed BOOLEAN,
    cost_usd FLOAT,
    latency_ms INT,
    scored_at TIMESTAMPTZ DEFAULT now()
);

CREATE MATERIALIZED VIEW production_eval_hourly AS
SELECT org_id, agent_id, date_trunc('hour', scored_at) AS hour,
       avg(score) AS avg_score, count(*) AS n,
       sum(CASE WHEN NOT passed THEN 1 ELSE 0 END)::float / count(*) AS fail_rate
FROM production_eval_scores GROUP BY 1,2,3;
```

---

## 4. Cost control (critical)

| Guard | Behavior |
|---|---|
| Daily budget cap | Stop sampling when `max_cost_usd_per_day` hit |
| Priority sampling | Always score traces with F28 stumbles (100%) |
| SLM cascade | Haiku-class judge first; escalate to Sonnet only on borderline |
| StatGate pre-filter | Skip traces already failed hard guardrails |

---

## 5. Portal & API

- **Trend chart:** pass rate by agent, 7d/30d
- **Drill-down:** failing traces from score drop
- **EQL:** `production_eval.fail_rate > 0.1 last 1h`
- **MCP:** `get_production_quality_trend(agent_id)`

---

## 6. Differentiation vs F44

| F44 | N03 |
|---|---|
| Nightly batch clustering → datasets | Real-time sampling → scores |
| Curates **cases** for CI | Measures **live** quality |
| Offline | Online with budgets |

They compose: N03 detects drift → F44/N01 capture failing traces as regression cases.

---

## 7. Acceptance criteria

- [ ] 2% sample rate on 10k traces/day stays under daily budget
- [ ] Stumble traces always scored (100% sample)
- [ ] Hourly aggregate visible in portal within 15 min
- [ ] 2σ quality drop creates F28 stumble within 1h
- [ ] Policy CRUD in portal Settings → Production Eval

---

*See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.3.*
