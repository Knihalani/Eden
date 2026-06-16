---
title: "12 — Experimentation Intelligence (Cat 12, incl. Simulation)"
status: IMPLEMENTED v1
last_updated: 2026-06-12
version: 1.2
---

# 12 — Experimentation Intelligence (Cat 12, incl. Simulation)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-12,
> 41 new tests, 8 services in
> `src/eden/experiments/experiment_intel/` +
> `src/eden/experiments/simulation/`, reading from the
> existing `judge_scores` + `telemetry_events` +
> `usage_events` substrate).
>
> **Per Article 1: "Simulation is the biggest gap in
> the market."** Today you ship a prompt change and wait
> a week to see if it works. With Cat 12, you ship a
> prompt change and see the answer in 5 minutes.
> **This is the highest-ROI category for engineering
> time.**

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

A/B/n traffic splitting, automatic evaluation on every
variant, experiment recommendation + winner detection,
and — the headline — **simulation** (replay production
in staging, what-if analysis, load simulations).

The user story (the **prompt engineer** conversation):

> "I'm rolling out a new system prompt for the customer-
> service agent. Before I push to 100% of traffic, I
> want to: (1) replay last week's 10,000 production
> traces against the new prompt in staging, (2) have
> the Cat 3 judge set score both versions, (3) see
> which judge scores improved and which regressed,
> (4) get a 'ship it' or 'don't ship' recommendation
> with statistical significance, (5) if I ship it,
> A/B split 1% to new / 99% to control, and (6) detect
> the winner in 24h with Bayesian confidence."

## Source articles & research

* **Article 1 §12**: "Experiment Explorer (browse
  experiments), Traffic Splitter (canary / A/B /
  multi-armed bandit), Auto Evaluation (auto-run
  experiments), Simulation (replay production in
  staging), What-If Analysis (predict outcomes of
  hypothetical changes)."
* **Article 1 ⭐ "biggest gap"**: "**Simulation** is
  almost nonexistent. Most platforms let you run
  experiments, but very few let you *replay* a
  past scenario in staging with a different prompt
  version."
* **Article 3 (Braintrust)**: "Auto dataset generation
  from production failures" + "Experiment-driven dataset
  versioning."
* **Article 3 (Arize)**: "Experiment-driven dataset
  versioning" — the dataset-as-experiment primitive.
* **2026 ACM/IEEE publication on A/B test methodology**:
  Bayesian winner selection (per-variant posterior
  probability of being the best) > p-hacking; we ship
  Bayesian, not frequentist.
* **LangChain / LangGraph 2026**: the multi-armed
  bandit library (epsilon-greedy + Thompson sampling)
  for online traffic splitting.

## What's already in Eden

* `src/eden/llmops/canary.py` (`CanaryDeployment`) —
  the existing canary-deployment surface; v0 extends
  this with the `TrafficSplitter`.
* `src/eden/evaluation/eval_intel/versioner.py`
  (`EvalVersioner`) — the deployment-SHA coupling
  with `PromptVersionsClient`. Used as the canary
  version key.
* `src/eden/observability/realtime/` (Cat 1) — the
  real-time event stream; the `AutoEvaluator` consumes
  this to score variants as they execute.
* `src/eden/evaluation/eval_intel/` (Cat 3) — the
  judge set. The `AutoEvaluator` re-uses every Cat 3
  judge to score a variant.
* `src/eden/insights/dataset_engine.py` — the
  experiment-traffic-splitting substrate.
* The Cat 12 tables (experiment_traffic_splits,
  experiment_auto_eval_runs, experiment_recommendations,
  simulation_scenarios, simulation_runs, what_if_analyses)
  are already migrated in 020.

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `TrafficSplitter.split` | `src/eden/services/experiment_intel/traffic.py` | 1 | M |
| `AutoEvaluator.evaluate` | `src/eden/services/experiment_intel/auto_eval.py` | 1 | M |
| `ExperimentRecommender.recommend` | `src/eden/services/experiment_intel/recommender.py` | 1 | L |
| `ExperimentWinnerDetector.detect` | `src/eden/services/experiment_intel/winner.py` | 1 | L |
| `Simulator.simulate_scenario` ⭐ | `src/eden/services/experiment_intel/simulator.py` | 1 | L |
| `Simulator.replay_production_in_staging` ⭐ | same | 1 | L |
| `Simulator.what_if_analysis` ⭐ | same | 1 | L |
| `Simulator.load_simulation` ⭐ | same | 1 | M |

**v0 surface:** 8 services, 8 routes. **v0 ships the
whole cat** (no v2) — simulation is the headline feature
and the surface is small enough to ship together.

## API contracts

### `POST /orgs/{org_id}/intelligence/experiments/traffic-split`

```json
body: {
  "name": "system_prompt_v2_canary",
  "control": { "version": "1.0.0" },
  "treatment": { "version": "1.1.0" },
  "split": { "control": 0.99, "treatment": 0.01 },
  "duration_hours": 24,
  "stopping_rule": "auto"  // auto|manual
}
→ { "data": { "experiment_id": "exp_abc" } }
```

### `POST /orgs/{org_id}/intelligence/experiments/auto-eval/run`

```json
body: {
  "experiment_id": "exp_abc",
  "judges": ["hallucination", "correctness", "groundedness", "relevance"]
}
→ {
    "data": {
      "eval_run_id": "eval_xyz",
      "judge_scores": {
        "control": {
          "hallucination": { "median": 0.91, "n": 4821 },
          "correctness":   { "median": 0.88, "n": 4821 }
        },
        "treatment": {
          "hallucination": { "median": 0.94, "n": 49 },
          "correctness":   { "median": 0.91, "n": 49 }
        }
      }
    }
  }
```

### `POST /orgs/{org_id}/intelligence/experiments/recommend`

The headline query. The "ship it / don't ship it" call.

```json
body: { "experiment_id": "exp_abc" }
→ {
    "data": {
      "recommendation": "ship",
      "confidence": 0.92,
      "rationale": "Treatment wins on hallucination (+0.03) and correctness (+0.03); loses on latency (+200ms p95) which is below the 500ms budget. Bayesian posterior probability that treatment > control: 0.94 on hallucination, 0.91 on correctness. No regressions on safety or groundedness.",
      "judge_comparison": {
        "hallucination":  { "control": 0.91, "treatment": 0.94, "winner": "treatment", "delta": 0.03, "p_value_bayesian": 0.94 },
        "correctness":    { "control": 0.88, "treatment": 0.91, "winner": "treatment", "delta": 0.03, "p_value_bayesian": 0.91 },
        "groundedness":   { "control": 0.85, "treatment": 0.85, "winner": "tie",     "delta": 0.0,  "p_value_bayesian": 0.52 },
        "latency_p95_ms": { "control": 1200,  "treatment": 1400,  "winner": "control", "delta": 200,  "p_value_bayesian": 0.88 }
      },
      "ship_conditions": [
        "treatment.hallucination > 0.92 (passes)",
        "treatment.safety > 0.95 (passes)",
        "treatment.latency_p95 < 1500ms (passes)"
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/experiments/simulator/replay-production-in-staging`

The simulation headline.

```json
body: {
  "production_window_start": "2026-05-25",
  "production_window_end": "2026-06-01",
  "candidate_version": "1.1.0",
  "judges": ["hallucination", "correctness", "groundedness", "relevance", "safety"],
  "sample_size": 5000  // cap to keep simulation fast
}
→ {
    "data": {
      "simulation_id": "sim_abc",
      "n_traces_replayed": 5000,
      "n_traces_succeeded": 4987,
      "n_traces_failed": 13,
      "duration_seconds": 312,
      "judge_comparison": {
        "control": { "hallucination": 0.91, "correctness": 0.88, "safety": 0.96 },
        "candidate": { "hallucination": 0.94, "correctness": 0.91, "safety": 0.97 }
      },
      "regressions": [
        { "trace_id": "trc_abc", "judge": "correctness",
          "control_score": 0.95, "candidate_score": 0.62,
          "rationale": "The candidate prompt no longer recognises the user's locale code" }
      ],
      "improvements": [
        { "trace_id": "trc_def", "judge": "hallucination",
          "control_score": 0.72, "candidate_score": 0.95 }
      ],
      "recommendation": "ship_with_monitoring",
      "rationale": "Net +0.03 on hallucination, +0.03 on correctness, +0.01 on safety. 13 failures to investigate; 3 of those are locale regressions."
    }
  }
```

### `POST /orgs/{org_id}/intelligence/experiments/simulator/what-if`

```json
body: {
  "baseline_window_start": "2026-05-01",
  "baseline_window_end": "2026-06-01",
  "what_if": "switch_from_gpt4o_to_claude_haiku"
}
→ {
    "data": {
      "baseline_cost_usd": 42000,
      "baseline_judge_score_median": 0.88,
      "what_if_estimated_cost_usd": 4200,  // 10x reduction
      "what_if_estimated_judge_score_median": 0.85,  // 0.03 drop
      "what_if_estimated_latency_p95_ms": 850,  // 50% reduction
      "confidence_interval_cost": [3500, 4800],
      "confidence_interval_judge_score": [0.82, 0.87],
      "method": "production_analogue_lookup"
    }
  }
```

## Data model

```sql
-- 1. Experiment traffic splits (the A/B/n definitions)
CREATE TABLE experiment_traffic_splits (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    name            VARCHAR(128) NOT NULL,
    control_version VARCHAR(32) NOT NULL,
    treatment_version VARCHAR(32) NOT NULL,
    control_weight  DOUBLE PRECISION NOT NULL,
    treatment_weight DOUBLE PRECISION NOT NULL,
    duration_hours  INT,
    stopping_rule   VARCHAR(16) NOT NULL DEFAULT 'auto',
    status          VARCHAR(16) NOT NULL DEFAULT 'active',  -- active|stopped|winner_detected
    winner          VARCHAR(32),  -- 'control'|'treatment' on stop
    winner_confidence DOUBLE PRECISION,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stopped_at      TIMESTAMPTZ
);
CREATE INDEX idx_experiment_traffic_splits
    ON experiment_traffic_splits (org_id, status, created_at DESC);

-- 2. Experiment auto-eval runs (per judge per variant)
CREATE TABLE experiment_auto_eval_runs (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    experiment_id   UUID NOT NULL REFERENCES experiment_traffic_splits(id),
    judge_name      VARCHAR(64) NOT NULL,
    variant         VARCHAR(16) NOT NULL,  -- 'control'|'treatment'
    n_traces        INT NOT NULL,
    judge_score_median DOUBLE PRECISION,
    judge_score_p5  DOUBLE PRECISION,
    judge_score_p95 DOUBLE PRECISION,
    run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_experiment_auto_eval
    ON experiment_auto_eval_runs (org_id, experiment_id, judge_name);

-- 3. Experiment recommendations
CREATE TABLE experiment_recommendations (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    experiment_id   UUID NOT NULL REFERENCES experiment_traffic_splits(id),
    recommendation  VARCHAR(16) NOT NULL,  -- ship|dont_ship|ship_with_monitoring|need_more_data
    confidence      DOUBLE PRECISION NOT NULL,
    rationale       TEXT NOT NULL,
    judge_comparison_json TEXT NOT NULL,
    ship_conditions_json TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Simulation scenarios (the headline data structure)
CREATE TABLE simulation_scenarios (
    id                      UUID PRIMARY KEY,
    org_id                  VARCHAR(128) NOT NULL,
    name                    VARCHAR(128) NOT NULL,
    production_window_start  TIMESTAMPTZ NOT NULL,
    production_window_end    TIMESTAMPTZ NOT NULL,
    candidate_version       VARCHAR(32) NOT NULL,
    judges                  TEXT NOT NULL,  -- comma-separated
    sample_size             INT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Simulation runs (the execution record)
CREATE TABLE simulation_runs (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    scenario_id         UUID NOT NULL REFERENCES simulation_scenarios(id),
    n_traces_replayed   INT NOT NULL,
    n_traces_succeeded  INT NOT NULL,
    n_traces_failed     INT NOT NULL,
    duration_seconds    INT NOT NULL,
    judge_comparison_json TEXT NOT NULL,
    regressions_json    TEXT,
    improvements_json   TEXT,
    recommendation      VARCHAR(32) NOT NULL,
    rationale           TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. What-if analyses
CREATE TABLE what_if_analyses (
    id                              UUID PRIMARY KEY,
    org_id                          VARCHAR(128) NOT NULL,
    baseline_window_start           TIMESTAMPTZ NOT NULL,
    baseline_window_end             TIMESTAMPTZ NOT NULL,
    what_if_description             TEXT NOT NULL,
    baseline_cost_usd               DOUBLE PRECISION,
    baseline_judge_score_median     DOUBLE PRECISION,
    what_if_estimated_cost_usd      DOUBLE PRECISION,
    what_if_estimated_judge_score   DOUBLE PRECISION,
    confidence_interval_json        TEXT,
    method                          VARCHAR(64) NOT NULL,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Algorithm / pseudo-code

### `ExperimentWinnerDetector.detect` (Bayesian winner selection)

```python
def detect_winner(org_id, experiment_id, min_n_per_arm=100):
    # Per 2026 A/B test methodology: Bayesian, not
    # frequentist. Compute per-judge per-variant
    # posterior, then aggregate.
    runs = SELECT * FROM experiment_auto_eval_runs
            WHERE experiment_id = ? ORDER BY run_at DESC LIMIT 100
    # 1. Per-judge per-variant Bayesian posterior
    judge_winners = {}
    for judge in distinct_judges(runs):
        control_scores = distribution(runs.filter(variant='control')[judge])
        treatment_scores = distribution(runs.filter(variant='treatment')[judge])
        # Posterior probability that treatment > control
        prob = bayesian_paired_t_test(
            control_scores, treatment_scores,
            prior=normal(0, 0.05)  # non-inferiority margin
        )
        judge_winners[judge] = {
            "winner": "treatment" if prob > 0.95 else "control" if prob < 0.05 else "tie",
            "prob_treatment_better": prob,
            "delta": treatment_scores.mean() - control_scores.mean(),
        }
    # 2. Aggregate: ship iff treatment wins on safety,
    # hallucination, groundedness; doesn't lose on
    # latency; doesn't lose on cost
    if (judge_winners["safety"]["winner"] == "control" and
        judge_winners["safety"]["prob_treatment_better"] < 0.05):
        return {"recommendation": "dont_ship", "confidence": 0.95, "rationale": "safety regression"}
    if any(judge_winners[j]["winner"] == "control" and
           judge_winners[j]["prob_treatment_better"] < 0.05 for j in ["hallucination", "groundedness"]):
        return {"recommendation": "dont_ship", "confidence": 0.92, "rationale": "quality regression"}
    return {"recommendation": "ship", "confidence": 0.88,
            "rationale": "all critical judges favor treatment"}
```

### `Simulator.replay_production_in_staging` (the headline)

```python
async def replay_production_in_staging(org_id, window_start, window_end,
                                       candidate_version, judges, sample_size=5000):
    # 1. Pull N production traces (most recent first,
    #    stratified by query type for representativeness)
    prod_traces = SELECT * FROM telemetry_events
                   WHERE org_id = ? AND created_at BETWEEN ? AND ?
                   AND event_type IN ('otel.chat', 'agent.run')
                   ORDER BY created_at DESC LIMIT ?
    prod_traces = stratified_sample(prod_traces, by='query_type', n=sample_size)
    # 2. For each trace, re-run in staging with the
    #    candidate prompt version
    results = []
    for trace in prod_traces:
        # The original trace has: input, output_control, judge_scores_control
        # The simulation produces: output_candidate, judge_scores_candidate
        sim = await sandbox_runner.run_agent(
            org_id, trace.input, candidate_version
        )
        results.append({
            "trace_id": trace.trace_id,
            "judges_control":   trace.judge_scores,
            "judges_candidate": sim.judge_scores,
            "output_control":   trace.output,
            "output_candidate": sim.output,
        })
    # 3. Aggregate + return the comparison
    return aggregate_simulation_results(results, judges)
```

### `Simulator.what_if_analysis`

```python
def what_if(org_id, baseline_window_start, baseline_window_end, what_if):
    # Method 1: production analogue lookup
    # (find a similar past org that did the what_if)
    analogue = find_analogue(org_id, what_if)  # from a public benchmark or past customer
    if analogue:
        return estimate_from_analogue(org_id, baseline, analogue)
    # Method 2: per-trace token-cost extrapolation
    # (cheaper; less accurate)
    return estimate_from_token_extrapolation(org_id, baseline, what_if)
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| Treatment wins on a "soft" judge but loses on a "hard" judge (safety) | `recommend` always requires `safety` and `groundedness` to favor treatment; otherwise `dont_ship` |
| Sample size is too small (n < 100 per arm) | `detect_winner` returns `need_more_data` if `n < min_n_per_arm` |
| Simulation re-run in staging doesn't match production (different infra, different prompt version) | The simulation records the **infra_diff** vs production; if non-trivial, the comparison is annotated with a warning |
| Sandbox runner can't reproduce the original failure (e.g., time-dependent tool calls) | The simulator marks the trace as `not_reproducible` and excludes it from the aggregate; the report shows the count |
| Bayesian posterior is overconfident (sample size too small) | The `confidence_interval_cost` and `confidence_interval_judge_score` widen as `n` shrinks; below `min_n`, the response is `insufficient_data` |
| Experiment is left running for 30 days (cost explosion) | The `duration_hours` setting enforces auto-stop; Cat 9 `TenantBudget` caps daily cost |
| The new version's judges haven't been calibrated for the candidate's data distribution | The first 24h is treated as a "burn-in" period; the `AutoEvaluator` doesn't score until 100 traces have accumulated per arm |
| What-if analysis produces an absurd estimate (cost > 10x or < 0.1x) | The `confidence_interval_*` widens to ≥ ±50%; the `recommendation` includes a `low_confidence_warning: true` flag |

## Telemetry

* `intelligence_experiment_traffic_split` (counter)
* `intelligence_experiment_auto_eval_run` (counter, tagged by `judge`)
* `intelligence_experiment_recommendation` (counter, tagged by `recommendation`)
* `intelligence_experiment_winner_detected` (counter)
* `intelligence_simulation_run` (counter, tagged by `scenario`)
* `intelligence_what_if_run` (counter)

## Test plan

* Traffic split: 100% control, 0% treatment
* Auto-eval: a fixture with 1k control + 100 treatment
  traces; each judge gets a posterior
* Recommender: 6 test cases — ship (clear winner),
  dont_ship (safety regression), ship_with_monitoring
  (mixed signal), need_more_data (n<100), tie
  (no clear winner), low_confidence (wide CIs)
* Winner detector: Bayesian vs frequentist agreement
  on a 10k-pair fixture
* Simulator: replay 1000 prod traces in staging; the
  regressions and improvements are correctly identified
* What-if: estimate from analogue matches the actual
  when the analogue is run
* RLS: a different org's experiment is never returned
* End-to-end: a full experiment (split → 1h of traffic →
  auto-eval → recommend → winner detection → traffic
  reallocation) completes in < 5 min

Target: **~30 tests, ~1.2s.**

## Acceptance criteria

- [ ] All 8 services implemented
- [ ] Traffic split respects the 0.99/0.01 split
- [ ] Auto-eval scores both arms in < 5 min for a 1k fixture
- [ ] Recommender handles all 6 cases (ship,
  dont_ship, ship_with_monitoring, need_more_data,
  tie, low_confidence)
- [ ] Winner detector Bayesian posterior matches
  analytical result
- [ ] Simulator correctly identifies regressions
  and improvements
- [ ] What-if estimate within 20% of the actual
  analogue run
- [ ] All 30 tests pass
- [ ] RLS verified
- [ ] End-to-end experiment completes in < 5 min

## Open questions

* **Bandit vs fixed split** — epsilon-greedy vs
  Thompson sampling vs fixed A/B. **Recommendation:
  fixed split by default; bandit as v2.1.** (Owner:
  Cat 12 lead)
* **What-if method** — production analogue lookup
  (privacy risk) vs token extrapolation (less accurate).
  **Recommendation: ship both; analogue only with
  customer opt-in.** (Owner: Cat 12 lead)
* **Sample-size auto-calculator** — at what `n` do we
  declare a winner? **Recommendation: per-judge
  minimum n=100; Bayesian posterior > 0.95.** (Owner:
  Cat 12 lead)
* **Multi-armed bandit library** — Thompson sampling
  in-house or a 3rd-party lib? **Recommendation: in-house
  for v0 (it's 50 lines of code); revisit if a battle-
  tested lib ships.** (Owner: Cat 12 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap) § Cat 12
* Stub envelope: `src/eden/intelligence_envelope.py`
* Canary deployment: `src/eden/llmops/canary.py`
* Eval versioner (deployment-SHA coupling):
  `src/eden/evaluation/eval_intel/versioner.py`
* Cat 3 (judges — the AutoEvaluator re-uses the full
  judge set): [`03-evaluation-quality-intelligence.md`](./03-evaluation-quality-intelligence.md)
* Cat 17 (closed-loop — `ExperimentHook.on_winner`
  archives the losing variants):
  [`17-closed-loop-wiring.md`](./17-closed-loop-wiring.md)
* Cat 11 (outcome — simulation predicts outcomes):
  [`11-outcome-roi-intelligence.md`](./11-outcome-roi-intelligence.md)
* Research: 2026 A/B test methodology (Bayesian vs
  frequentist); Braintrust auto-dataset-from-prod;
  Arize experiment-driven dataset versioning
