---
title: "02 — Root Cause Attribution & Incident Clustering (Cat 2)"
status: IMPLEMENTED v1
last_updated: 2026-06-11
version: 1.1
---

# 02 — Root Cause Attribution & Incident Clustering (Cat 2)

> **Status:** IMPLEMENTED v1 (2026-06-11).
> `RootCauseAnalyzer.categorize` and `.explain` are real
> rule-based pre-filter implementations (LLM-as-judge upgrade
> path documented for Phase 1); `IncidentClusterer.cluster`
> and `.summarize` use a deterministic
> `(category, error_type, agent_id)` key (no embedding model
> required); `IncidentStore.list` reads from `incident_clusters`.
> 5 services + 1 shared helper module, 5 routes, 55 tests.

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

Every failed trace is auto-categorised into one of six failure
classes (`retrieval`, `tool`, `prompt`, `model`, `memory`,
`user_issue`) with a confidence score, the top-k contributing
signals, and a list of similar incidents. The user asks "why did
this fail" and gets a 1-sentence answer + 3 contributing factors +
a link to the 132 similar failures that were resolved last month.

The user story is:

> "I have a failed trace. I want to know: was it a retrieval
> failure, a tool failure, a prompt failure, a model failure, a
> memory failure, or a user issue? How confident are you? What
> were the top 3 contributing factors? How many similar failures
> have I had in the last 30 days and how were they resolved?"

## Source articles

* **Article 1 §2**: "Failure Attribution (retrieval/tool/prompt/
  model/memory/user), Root Cause Analysis (cause + confidence +
  contributing factors), Similar Incidents (132 similar
  failures and how resolved)."

## What's already in Eden

* `top_failure_modes` in `ObservabilitySummary` — counts
  failures by `error->>'type'` (just counting, no
  categorisation).
* `FailurePatternDetector` in
  `src/eden/insights/detectors.py:75` — detects recurring span
  sequences (e.g. "tool.X.fail → llm.completion → failure"),
  but does NOT cluster by failure type.
* `DisparityDetector` in
  `src/eden/insights/detectors.py:345` — env-vs-prod gap
  detection.
* `judge_scores` table — provides ground truth for some
  categories (e.g. low `hallucination` score → model failure).

## Feature inventory

| Feature | File | Routes | Tables | Deps | Effort |
|---|---|---|---|---|---|
| `RootCauseAnalyzer.categorize` | `src/eden/insights/rca/analyzer.py` | 1 | `rca_analyses` | `telemetry_events`, `judge_scores` | L |
| `RootCauseAnalyzer.explain` | same | 1 | `rca_analyses` | same | L |
| `IncidentClusterer.cluster` | `src/eden/insights/incidents/clusterer.py` | 1 | `incident_clusters`, `incident_cluster_members` | embeddings | L |
| `IncidentClusterer.summarize` | same | 1 | `incident_clusters` | LLM-as-judge | M |
| `IncidentStore.list` | same | 1 | `incident_clusters` | — | S |

## API contracts

```
POST /orgs/{org_id}/intelligence/rca/{trace_id}/analyze
  → {
    "data": {
      "category": "retrieval" | "tool" | "prompt" | "model" | "memory" | "user_issue",
      "confidence": 0.89,
      "signals": [
        "3 of 5 retrieval calls returned empty results",
        "low similarity scores (avg 0.42)",
        "user query contained terms not in the KB"
      ]
    }
  }

GET  /orgs/{org_id}/intelligence/rca/{trace_id}/explain
  → {
    "data": {
      "cause": "Retrieval returned outdated information about the user's question.",
      "confidence": 0.89,
      "contributing_factors": [
        "KB chunk 42 was last updated 90 days ago",
        "User query contains terms introduced in the last 30 days"
      ],
      "similar_incidents": [
        { "trace_id": "trace_xyz", "similarity": 0.87, "resolution": "updated chunk 42" }
      ]
    }
  }

POST /orgs/{org_id}/intelligence/rca/incidents/cluster
  body: { window: "24h", min_cluster_size: 3 }
  → {
    "data": {
      "clusters": [
        {
          "id": "uuid",
          "name": "planner_tool_timeout_2026-06-10",
          "member_count": 132,
          "severity": "high",
          "summary": "Agent planner timed out on tool_call 47 times in the last hour"
        }
      ]
    }
  }

GET  /orgs/{org_id}/intelligence/rca/incidents?severity=critical&limit=50
  → {
    "data": {
      "incidents": [
        { "id": "uuid", "name": "...", "member_count": 132, "severity": "high" }
      ]
    }
  }
```

## Data model

```sql
-- 1. RCA analyses: one row per categorisation
CREATE TABLE rca_analyses (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    category        VARCHAR(32) NOT NULL,
    confidence      DOUBLE PRECISION NOT NULL,
    signals_json    TEXT,
    explanation     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_rca_analyses_trace
    ON rca_analyses (org_id, trace_id);

-- 2. Incident clusters: one row per cluster
CREATE TABLE incident_clusters (
    id                    UUID PRIMARY KEY,
    org_id                VARCHAR(128) NOT NULL,
    name                  VARCHAR(256) NOT NULL,
    centroid_embedding    TEXT,
    member_count          INTEGER NOT NULL DEFAULT 0,
    severity              VARCHAR(16) NOT NULL DEFAULT 'medium',
    summary               TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Cluster members: many-to-many between clusters and traces
CREATE TABLE incident_cluster_members (
    cluster_id  UUID NOT NULL,
    trace_id    VARCHAR(128) NOT NULL,
    similarity  DOUBLE PRECISION NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (cluster_id, trace_id)
);
```

## Algorithm / pseudo-code

### Categorisation (rule-based pre-filter; LLM-as-judge upgrade deferred)

The current implementation is **rule-based only** — no LLM call.
The LLM-as-judge fallback (deferred to a Phase 1 ship) will be
wired through the existing
`JudgeRegistry` + `JudgeRunner` pattern the same way
`DecisionScorer` uses the 3 Galileo Luna-2 judges.

```python
CATEGORIES = ("retrieval", "tool", "prompt", "model", "memory", "user_issue")

async def categorize(org_id, trace_id):
    events = await fetch_trace_events(org_id, trace_id)
    judges = await fetch_judge_scores(org_id, trace_id)
    # 6-rule table, first-match-wins (priority order):
    # 1. tool.* with error/outcome=error         → "tool",     0.92
    # 2. retrieval.* with empty/low-score items  → "retrieval", 0.88
    # 3. judge.hallucination < 0.5 OR judge.reasoning_coherence < 0.4
    #                                            → "model",    0.85
    # 4. judge.safety flagged OR PII / prompt-injection pattern
    #                                            → "user_issue", 0.80
    # 5. memory.* with outcome != success        → "memory",   0.82
    # 6. prompt.* with error                     → "prompt",   0.78
    # 7. (fallback) trace is a failure but no rule matched
    #                                            → "model",    0.55
    category, confidence, signals = _classify_events(events, judges)
    # Adjustments: −0.10 (single event), −0.05 (no judges),
    # +0.05 (multi-signal); capped at 0.97
    confidence = clamp(confidence + adjustments, 0.0, 0.97)
    # Persist (best-effort, delete-then-insert for idempotency)
    await _delete_then_insert_rca(org_id, trace_id, category, confidence, ...)
    return _ok_envelope("rca_analyzer", {...})
```

### Explanation (one call to categorize + similar-incidents lookup)

```python
async def explain(org_id, trace_id):
    cat = await self.categorize(org_id, trace_id)
    if cat["status"] == "not_found":
        return cat
    # error_type comes from categorize (first failed event's
    # ``error.type`` column) — passed through the response
    # so we don't have to re-parse the signal text.
    error_type = cat["data"]["error_type"]
    similar = await _fetch_similar_rca_analyses(
        org_id, category=cat["data"]["category"],
        error_type=error_type, exclude_trace_id=trace_id, limit=5,
    )
    # Similarity: 1.0 (same category + same error_type) /
    #             0.7 (same category only) / 0.0 (excluded)
    for row in similar:
        sim = 1.0 if error_type.lower() in row["signals_json"].lower() else 0.7
    return _ok_envelope("rca_analyzer", {
        "cause": f"{cat['data']['category']} failure: {signals[0]}",
        "contributing_factors": signals[:3],
        "similar_incidents": [...],
    })
```

### Clustering (deterministic key; no embedding model required)

The spec called for DBSCAN on trace embeddings, but the v1
ship uses a **deterministic `(category, error_type, agent_id)`
key** instead. Rationale:

* **Zero new deps** — no embedding model, no sentence-transformers.
* **Idempotent** — re-running on the same input produces the
  same `cluster_id` (acceptance criterion).
* **Explainable** — a cluster named
  `planner_timeouterror_tool_20260611` tells you everything
  without a debug UI.
* **Phase 1 upgrade path** — a real embedding model can swap
  in without changing the public surface.

```python
async def cluster(org_id, window="24h", min_cluster_size=3):
    interval = parse_window(window)  # "1h"/"24h"/"7d"/"30d"
    if interval is None:
        return bad_request_envelope(...)
    failed_trace_ids = await fetch_failed_traces_in_window(org_id, interval)
    # For each failed trace, classify + extract the key
    buckets = defaultdict(list)
    for tid in failed_trace_ids:
        events = await fetch_trace_events(org_id, tid)
        category, _, _ = _classify_events(events, [])
        first = first_failed_event(events)
        key = (category, error_type_from_event(first), agent_id_from_event(first))
        buckets[key].append(tid)
    # Recursive split for buckets > 10k members (cap depth=3,
    # final fallback: split by trace_id character position)
    buckets = bucket_with_split(buckets, depth=0)
    # Build cluster rows + members
    for key, members in buckets.items():
        if len(members) < min_cluster_size:
            small_buckets.append(...)
            continue
        cluster_id = make_cluster_id(org_id, key)  # clu_<sha256[:16]>
        severity = "critical"|"high"|"medium"|"low" by member_count
        centroid_json = {"key": list(key), "avg_jaccard": ..., "version": "v1"}
        ...
    # Fire closed-loop hook for high-severity, large clusters
    for c in clusters:
        if c["severity"] in ("critical", "high") and c["member_count"] >= 10:
            get_promotion_hook().on_drift_alert(org_id, drift_type="incident_cluster", severity=c["severity"])
    return _ok_envelope("incident_clusterer", {...})
```

### Summarize (one-paragraph templated cluster summary)

```python
async def summarize(org_id, cluster_id):
    row = await fetch_cluster_row(org_id, cluster_id)
    if row is None:
        return not_found_envelope(...)
    members = await fetch_cluster_members(org_id, cluster_id)
    # Aggregate event stats (capped at 20 events/member, 200 total)
    event_type_counts, error_type_counts, agent_counts = ...
    avg_duration_ms = mean(durations)
    recommendation = CATEGORY_RECOMMENDATIONS.get(category, "...")
    summary = (
        f"Cluster of {member_count} failures on agent '{top_agent}'. "
        f"Dominant error: '{top_error_type}' ({count}×). "
        f"Top event sequence: {top_3_event_types}. "
        f"First seen: {first_at}, last seen: {last_at}. "
        f"Avg duration: {avg_duration_ms:.1f}ms. "
        f"Recommended action: {recommendation}"
    )
    await _update_cluster_summary(org_id, cluster_id, summary)
    return _ok_envelope("incident_clusterer", {...})
```

## Failure modes & guardrails

* **No embeddings available** — return a single "all failures"
  cluster with a clear `data.message: "clustering unavailable,
  showing aggregate counts"`.
* **LLM-as-judge fails** — fall back to the rule-based
  pre-filter with `confidence: 0.5`.
* **No failed traces in window** — return empty clusters
  list with `data.message: "no failures in window"`.
* **Cluster centroid becomes too large (>10k members)** — split
  it recursively until each cluster has <10k members.

## Telemetry

* `intelligence_rca_request` (counter, tagged by `category`)
* `intelligence_rca_confidence` (histogram)
* `intelligence_rca_latency_ms` (histogram)
* `intelligence_incident_cluster_size` (histogram)
* `intelligence_incident_severity` (counter, tagged by
  `severity`)

## Test plan

* Categorize returns one of the six valid categories.
* Categorize includes `signals` (non-empty when confidence >
  0.7).
* Cluster returns the canonical 4-category taxonomy in
  `data`.
* Explanation includes 1-3 contributing factors, each
  referencing a specific event in the trace.

## Acceptance criteria

- [ ] Categorize accuracy on a synthetic eval set: ≥ 80%
  match with human-labelled categories.
- [ ] Cluster produces stable cluster IDs across re-runs
  (idempotent on the same input).
- [ ] Explain returns 1-3 contributing factors, each
  referencing a specific event in the trace.
- [ ] Latency < 500ms for traces with <1k events.
- [ ] "Similar incidents" returns at least 1 result for
  50% of new failures.

## Open questions

* **Embedding model** — sentence-transformers, OpenAI ada-002,
  or a custom fine-tuned model? (Owner: Cat 2 lead)
* **Cluster naming** — auto-generated or user-assigned?
  (Owner: Cat 2 lead)
* **Severity assignment** — heuristic (count × recency) or
  LLM-as-judge? (Owner: Cat 2 lead)
* **Cross-trace incident linking** — should a single
  incident span multiple traces (it does), and how do we
  show the relationship? (Owner: Cat 2 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](../eden-observability-gap-roadmap.md)
* Stub envelope: [`src/eden/intelligence_envelope.py`](../../src/eden/intelligence_envelope.py)
* Existing detectors: [`src/eden/insights/detectors.py`](../../src/eden/insights/detectors.py)
* Cat 3 (Eval Quality — provides ground truth via judge
  scores): [`03-evaluation-quality-intelligence.md`](./03-evaluation-quality-intelligence.md)
* Cat 17 (Closed-loop — auto-triggers investigation on alert):
  [`17-closed-loop-wiring.md`](./17-closed-loop-wiring.md)
