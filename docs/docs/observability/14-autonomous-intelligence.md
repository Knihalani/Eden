---
title: "14 — Autonomous Intelligence (Cat 14, incl. NL Interface)"
status: ✅ IMPLEMENTED v1 (shipped 2026-06-12)
last_updated: 2026-06-12
version: 1.1
---

# 14 — Autonomous Intelligence (Cat 14, incl. NL Interface)

> **Status:** STUB v0. The 4 base autonomous services
> (investigation, report, recommendation, self-heal) plus the 3
> NL Interface services (query, auto-dashboard, auto-report-from-NL)
> are typed stubs.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles](#source-articles)
3. [What's already in Eden](#whats-already-in-eden)
4. [The autonomous spectrum](#the-autonomous-spectrum)
5. [Feature inventory (7 features)](#feature-inventory-7-features)
6. [API contracts](#api-contracts)
7. [Data model (5 tables)](#data-model-5-tables)
8. [Algorithm / pseudo-code](#algorithm--pseudo-code)
9. [Failure modes & guardrails](#failure-modes--guardrails)
10. [Telemetry](#telemetry)
11. [Test plan](#test-plan)
12. [Acceptance criteria](#acceptance-criteria)
13. [Implementation order](#implementation-order)
14. [Open questions](#open-questions)
15. [Cross-references](#cross-references)

## Goal & motivation

The user story is:

> "I just got paged that my chatbot is hallucinating on
> customer questions. I don't have time to read traces. Tell
> me: what happened, what should I do, and if you can fix it
> safely, fix it."

This requires:

1. **Automated investigations** — given a trigger (drift
   alert, incident, judge regression), propose a root cause
   + remediation
2. **Automated reports** — weekly/incident/executive summaries
3. **Ranked recommendations** — actionable, prioritised
4. **Controlled self-healing** — auto-rollback, reweight,
   cache-bust
5. **Natural Language Interface** (Braintrust Loop-AI parity)
   — query observability data in plain English
6. **Auto-dashboards** — generate a dashboard from a NL
   description
7. **NL-to-report** — generate a report from a NL request

The autonomous services are the **"Automated"** half of the
"Observation → Explanation → Evaluation → Attribution →
Optimization → **Automation**" chain (Article 1).

## Source articles

* **Article 1 §14**: "Automated Investigations, Automated
  Reports, Optimization Recommendations, Automated Validation,
  Controlled Self-Healing."
* **Article 1 (biggest gap)**: "Autonomous Diagnostics: Still
  mostly manual."
* **Article 3 (Braintrust)**: "Loop AI agent for automated
  optimization and natural language queries over production
  data."
* **Article 3 (Phoenix)**: "Alyx AI assistant."
* **Article 3 (LangSmith)**: "Polly AI assistant for traces."

## What's already in Eden

* `JudgeRunner` (Cat 3) — runs judges and emits `JudgeScore`
  events.
* `PromotionLoop` (Cat 17) — can promote or rollback canaries.
* `InsightsService` (`src/eden/insights/`) — emits
  `Insight` objects from detector runs.
* `data_platform/anomaly_alerts.py` — emits `AnomalyAlert`
  events.
* `OpenRouterClient` — the existing LLM client used by
  judges and the multi-agent system.

## The autonomous spectrum

The 4 base services sit on a spectrum of "how autonomous":

```
Read-only ────────────────────────────────────── Destructive
                                                          
Investigation     Report         Recommendation   Self-Heal
(read RCA +       (read data +   (read data +      (mutate
suggest          summarise)     rank actions)      state!)
remediation)
```

Each step to the right requires more trust and more safety
rails. The default for all 4 is **read-only / suggest-only**.
Self-heal is explicitly gated by a separate flag and an
`require_org_admin` check.

## Feature inventory (7 features)

### Group A: Base autonomous (4)

| Feature | Class | File | Autonomy level |
|---|---|---|---|
| Investigation agent | `InvestigationAgent` | `src/eden/autonomous/investigation.py` | Read + suggest |
| Report generator | `ReportGenerator` | same | Read |
| Recommendation engine | `RecommendationEngine` | same | Read + suggest |
| Self-healer | `SelfHealer` | same | **Destructive** |

### Group B: NL Interface (3)

| Feature | Class | File | Notes |
|---|---|---|---|
| NL query engine | `NLQueryEngine` | `src/eden/autonomous/nl_interface/query.py` | Braintrust Loop-AI parity |
| Auto-dashboard builder | `AutoDashboardBuilder` | same | Phoenix Alyx parity |
| NL report generator | `NLReportGenerator` | same | LangSmith Polly parity |

## API contracts

All routes are gated by `intelligence_gap_v0` + `get_current_user`.
Destructive routes (self-heal) additionally require
`require_org_admin`.

### Investigation

```
POST /orgs/{org_id}/intelligence/autonomous/investigate
  body: {
    "trigger": "drift_alert:abc123" |
               "incident:xyz" |
               "judge_regression:hallucination" |
               "guardrail_breach:pii_leak"
  }
  → {
    "data": {
      "investigation_id": "uuid",
      "findings": [
        {
          "type": "rca",
          "summary": "Output drift detected on agent=planner between 14:00 and 14:30, correlated with prompt v3 deployment at 13:55.",
          "confidence": 0.89
        },
        {
          "type": "contributing_factor",
          "summary": "5 of 5 failed traces used the same retrieval chunk (id=42) which contained stale information."
        }
      ],
      "proposed_remediations": [
        {
          "action": "rollback_to_prompt_v2",
          "blast_radius": "all traffic",
          "estimated_recovery_time_minutes": 5
        },
        {
          "action": "remove_stale_chunk_42",
          "blast_radius": "1 chunk",
          "estimated_recovery_time_minutes": 1
        }
      ]
    }
  }
```

A real implementation runs a ReAct agent loop:

```python
def investigate(org_id, trigger):
    context = resolve_trigger_context(org_id, trigger)
    # Run a ReAct loop: think → act → observe
    agent = ReActAgent(tools=[
        get_related_traces, get_judge_scores, get_drift_alerts,
        list_active_canaries, get_kb_chunks
    ])
    result = agent.run(
        goal=f"Investigate {trigger} and propose a remediation",
        context=context,
    )
    return result
```

### Report

```
POST /orgs/{org_id}/intelligence/autonomous/report
  body: { "period": "weekly" | "monthly" | "incident" }
  → {
    "data": {
      "report_id": "uuid",
      "report_json": {
        "summary": "This week, judge scores were stable ...",
        "trends": { "hallucination": 0.04, "groundedness": 0.91, ... },
        "incidents": [ ... ],
        "recommendations": [ ... ]
      }
    }
  }
```

### Recommendations

```
GET  /orgs/{org_id}/intelligence/autonomous/recommendations
  → {
    "data": {
      "recommendations": [
        {
          "title": "Remove stale chunk id=42 from KB",
          "rationale": "Chunk 42 is contributing to 5 of 5 recent
                        hallucination failures.",
          "action": {
            "type": "kb.remove_chunk",
            "params": { "chunk_id": 42 }
          },
          "estimated_impact": "high",
          "risk": "low"
        }
      ]
    }
  }
```

### Self-heal (destructive)

```
POST /orgs/{org_id}/intelligence/autonomous/heal
  body: {
    "action_type": "rollback" | "reweight" | "cache_bust"
  }
  → {
    "data": {
      "action_id": "uuid",
      "status": "executed" | "pending_approval" | "failed",
      "before_state": { ... },
      "after_state": { ... }
    }
  }
```

A real implementation:

* **`rollback`** — calls `PromotionLoop` to roll back the
  current canary.
* **`reweight`** — calls the model router to shift weight
  away from the failing model.
* **`cache_bust`** — clears the relevant entries in
  `semantic_cache`.

All three are **destructive** and require `require_org_admin`.
The default mode is `pending_approval` — the action is queued
but not executed until a human approves.

### NL Interface

#### Query (Braintrust Loop-AI parity)

```
POST /orgs/{org_id}/intelligence/autonomous/nl/query
  body: {
    "question": "What's the p95 latency for agent=planner in the last 24h?"
  }
  → {
    "data": {
      "result": [
        { "timestamp": "2026-06-09T14:00", "p95_latency_ms": 1230 },
        { "timestamp": "2026-06-09T15:00", "p95_latency_ms": 1450 }
      ],
      "sql_used": "SELECT date_trunc('hour', timestamp), ...",
      "summary": "Agent planner's p95 latency spiked at 15:00 from 1230ms to 1450ms."
    }
  }
```

A real implementation:

1. Use the LLM to translate the question to a structured
   query (SQL or a JSON filter against ClickHouse / Postgres).
2. Run the query.
3. Use the LLM to summarise the result.
4. Log the question for future training data.

#### Auto-dashboard (Phoenix Alyx parity)

```
POST /orgs/{org_id}/intelligence/autonomous/nl/dashboard
  body: {
    "description": "Dashboard of judge scores per agent, last 7 days"
  }
  → {
    "data": {
      "dashboard_id": "uuid",
      "spec": {
        "panels": [
          { "type": "line_chart", "metric": "judge_score",
            "group_by": "judge_name", "window": "7d" },
          { "type": "bar_chart", "metric": "trace_count",
            "group_by": "agent_id", "window": "7d" }
        ]
      }
    }
  }
```

#### NL report (LangSmith Polly parity)

```
POST /orgs/{org_id}/intelligence/autonomous/nl/report
  body: { "request": "Weekly exec report on ROI and judge quality" }
  → {
    "data": {
      "report_id": "uuid",
      "report_json": { ... }
    }
  }
```

## Data model (5 tables)

```sql
-- 1. Investigations: one per triggered investigation
CREATE TABLE investigations (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trigger         TEXT NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
    findings_json   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_investigations_org ON investigations (org_id, created_at DESC);

-- 2. Autonomous reports: one per generated report
CREATE TABLE autonomous_reports (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    report_json     TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Autonomous recommendations: ranked, actionable
CREATE TABLE autonomous_recommendations (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    title           VARCHAR(256) NOT NULL,
    rationale       TEXT,
    action_json     TEXT,
    status          VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Self-heal actions: destructive, audited
CREATE TABLE self_heal_actions (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    action_type         VARCHAR(32) NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    before_state_json   TEXT,
    after_state_json    TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. NL query log: for future training data
CREATE TABLE nl_query_log (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    user_id         VARCHAR(128),
    question        TEXT NOT NULL,
    result_json     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_nl_query_log_org ON nl_query_log (org_id, created_at DESC);
```

## Algorithm / pseudo-code

### Investigation agent (ReAct loop)

```python
def investigate(org_id, trigger):
    context = resolve_trigger_context(org_id, trigger)
    agent = ReActAgent(
        llm_client=openrouter_client,
        tools=[
            get_related_traces,
            get_judge_scores,
            get_drift_alerts,
            list_active_canaries,
            get_kb_chunks,
        ],
        max_steps=10,
    )
    result = agent.run(
        goal=f"Investigate {trigger} and propose a remediation",
        context=context,
    )
    # Persist findings
    investigation_id = insert_investigation(org_id, trigger, result)
    return {"investigation_id": investigation_id, **result}
```

### NL query (LLM-to-SQL)

```python
def query(org_id, question):
    # 1. LLM-to-SQL
    schema = get_schema_description(org_id)
    sql = llm_client.call(
        agent="nl_to_sql",
        prompt=NL_TO_SQL_PROMPT.format(schema=schema, question=question),
        slot="fast", max_tokens=500,
    )
    # 2. Run the SQL (parameterised to prevent injection)
    try:
        result = await postgres_client.fetch(sql)
    except SQLSyntaxError:
        return {"result": [], "sql_used": sql,
                "summary": "I couldn't translate that question to SQL."}
    # 3. LLM-summarise
    summary = llm_client.call(
        agent="result_summariser",
        prompt=SUMMARISE_PROMPT.format(question=question, result=result),
        slot="fast", max_tokens=200,
    )
    # 4. Log the question
    insert_nl_query_log(org_id, question=question, result=result)
    return {"result": result, "sql_used": sql, "summary": summary}
```

### Self-heal (with safety rails)

```python
def heal(org_id, action_type):
    # 1. Require admin (enforced at the route level)
    # 2. Look up the current state (before_state)
    if action_type == "rollback":
        before = get_active_canary(org_id)
        # Default mode: pending_approval
        return queue_for_approval(
            action=lambda: PromotionLoop.rollback(org_id, before.canary_id),
            before_state=before,
        )
    elif action_type == "reweight":
        before = get_router_weights(org_id)
        return queue_for_approval(
            action=lambda: ModelRouter.reweight(org_id, target="cost"),
            before_state=before,
        )
    elif action_type == "cache_bust":
        before = get_cache_keys(org_id)
        return queue_for_approval(
            action=lambda: SemanticCache.bust(before),
            before_state=before,
        )

def queue_for_approval(action, before_state):
    # Insert into self_heal_actions with status='pending_approval'
    action_id = insert_self_heal_action(
        org_id, action_type=action.__name__, before_state=before_state,
        status="pending_approval",
    )
    # Do NOT execute the action — wait for human approval
    return action_id
```

## Failure modes & guardrails

* **Investigation exceeds max_steps (10)** — return the
  partial result with a `truncated: true` flag.
* **NL query LLM returns invalid SQL** — return an empty
  result with `summary: "I couldn't translate that question
  to SQL."`
* **Self-heal action is destructive** — default mode is
  `pending_approval`. The action is queued but NOT executed
  until a human approves via a separate `POST /heal/approve`
  endpoint.
* **Recommendation engine suggests a destructive action**
  — recommendations are read-only suggestions. The user must
  explicitly invoke the corresponding action endpoint
  (e.g. `POST /heal`).
* **Report generation LLM fails** — return a partial report
  with the parts that were successfully generated.
* **Autonomous services are gated by `intelligence_gap_v0`
  AND a separate `autonomous_actions_v0` flag** — the
  latter is OFF by default in production until the
  self-heal safety story is battle-tested.

## Telemetry

* `intelligence_investigation` (counter, tagged by `trigger`)
* `intelligence_investigation_duration_seconds` (histogram)
* `intelligence_investigation_steps` (histogram)
* `intelligence_report` (counter, tagged by `period`)
* `intelligence_recommendation` (counter, tagged by
  `action_type`)
* `intelligence_self_heal` (counter, tagged by `action_type`
  and `status`)
* `intelligence_nl_query` (counter, tagged by `success`)
* `intelligence_nl_query_latency_ms` (histogram)

Dashboards:

* **Autonomous Overview** — investigations per day, report
  generations, self-heal actions
* **NL Query Quality** — success rate, latency, top queries
* **Self-Heal Audit** — every self-heal action, before/after
  state, approver

## Test plan

* **Unit tests** (per service): 1-2 per public method, ~25
  total
* **Integration tests**:
  * Run an investigation on a synthetic drift alert, verify
    findings are sensible
  * Generate a weekly report, verify it includes the right
    sections
  * NL query against a synthetic dataset, verify SQL is
    valid
* **Safety tests**:
  * Self-heal action queues but does NOT execute by default
  * Destructive action requires admin
* **ReAct loop tests**:
  * Agent terminates within max_steps
  * Agent produces a valid remediation on a known trigger

## Acceptance criteria

- [ ] Investigation produces a 1-paragraph RCA + 1-3
  remediations within 60s.
- [ ] NL query executes against a synthetic dataset and
  returns a non-empty result for 9/10 questions.
- [ ] Self-heal `rollback` action triggers a canary rollback
  through the existing `PromotionLoop` when approved.
- [ ] Self-heal action is queued, not executed, by default.
- [ ] Weekly report includes: trends, incidents,
  recommendations, ROI.
- [ ] Recommendations are ranked by estimated_impact.
- [ ] NL-to-SQL translation has \<10% SQL syntax error rate.

## Implementation order

1. **Recommendation engine** (read-only, lowest risk) — first.
2. **Report generator** (read-only) — second.
3. **Investigation agent** (read + suggest) — third; depends
   on the existing `ReActAgent` infrastructure.
4. **NL query** — fourth; depends on the existing
   `OpenRouterClient`.
5. **Auto-dashboard** — fifth; depends on NL query.
6. **NL report** — sixth; depends on report generator.
7. **Self-heal** (destructive, highest risk) — LAST. Gated by
   `autonomous_actions_v0` and `require_org_admin`.

## Open questions

* **ReAct agent library** — do we use LangGraph, the existing
  `multi_agent/planning.py`, or a custom ReAct loop? (Owner:
  Cat 14 lead)
* **NL-to-SQL safety** — should the LLM-emitted SQL be
  parameterised? Yes, but how do we ensure it? (Owner: Cat
  14 lead)
* **Self-heal approval workflow** — does approval go through
  Slack, email, the UI, or all three? (Owner: Cat 14 lead)
* **Investigation trigger types** — which triggers do we
  support? Drift alert, incident, judge regression, guardrail
  breach. Should we add cost-spike, judge-regression on a
  specific deployment, etc.? (Owner: Cat 14 lead)
* **NL query model** — same `model_slot = "fast"` as
  judges, or a larger model? (Owner: Cat 14 lead)
* **Recommendation impact estimation** — how do we estimate
  the impact without a real A/B test? Heuristic? Bayesian?
  (Owner: Cat 14 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap)
* Stub envelope: `src/eden/intelligence_envelope.py`
* Cat 3 (Eval Quality — provides `judge_regression` triggers):
  [`03-evaluation-quality-intelligence.md`](./03-evaluation-quality-intelligence.md)
* Cat 13 (Predictive — provides `drift_alert` triggers):
  [`13-predictive-intelligence.md`](./13-predictive-intelligence.md)
* Cat 15 (Guardrails — provides `guardrail_breach` triggers):
  [`15-runtime-protection-guardrails.md`](./15-runtime-protection-guardrails.md)
* Cat 17 (Closed-loop — auto-disables noisy actions):
  [`17-closed-loop-wiring.md`](./17-closed-loop-wiring.md)
* Multi-agent trajectory: `src/eden/multi_agent/planning.py`
* Promotion loop: `src/eden/llmops/promotion.py`
* OpenRouter client: `src/eden/llm/`
