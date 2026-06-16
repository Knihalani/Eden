---
title: "07 — Tool Intelligence (Cat 7)"
status: IMPLEMENTED v1
last_updated: 2026-06-11
version: 1.2
---

# 07 — Tool Intelligence (Cat 7)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-11,
> 60 new tests in `tests/intelligence/test_tool_intelligence.py`).
> The 4 services (`ToolAttributionScorer`,
> `ToolComparator`, `ToolRecommender`, `ToolRegistryTaxonomy`)
> read from the production-grade ``telemetry_events``
> table (filtered by ``event_type IN (tool.*)``) and persist
> to the 2 Cat 7 tables in migration 020
> (``tool_attributions``, ``tool_comparisons``). The
> attribution scorer and the comparator fire the
> Cat 17 closed-loop
> ``PromotionHook.on_drift_alert`` hook on material
> success-rate drops (|Δ| ≥ 0.10) and large inter-tool
> gaps (≥ 0.20), respectively. **Tools are the new
> "dependencies" in LLM apps.** Tool intelligence is the
> LLM equivalent of dependency-graph analysis in
> traditional APM: which tools succeed, which fail, which
> are slow, which are expensive, which to recommend for a
> given task.

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

Surface which tools are succeeding, which are failing,
which are slow, which are expensive, and which to
recommend for a given task.

The user story (the **agent developer** conversation):

> "My agent has 12 tools. Tool A succeeds 80% of the time.
> Tool B succeeds 50% of the time. Tool C has p95
> latency 3.2s (4× the median). Tool D is never
> material — it's invoked in 1% of traces. Replace
> Tool D with Tool E (which is in the same toolspace
> but has 95% success rate)."

## Source articles & research

* **Article 1 §7**: "Tool Explorer (browse/search/filter
  by owner/deployment), Tool Versioning (track
  per-version success rate), Tool Composition (which
  tools are commonly called together)."
* **Article 3 (Phoenix)**: "Multi-step agent trajectory
  analysis" — provides the per-step data that Tool
  Intelligence consumes.
* **Article 3 (AgentOps)**: "Real-time anomaly detection
  for agent behaviour" — the ToolAttributionScorer
  surfaces anomalies per-tool.
* **arXiv 2605.09934 (2026) — TRACER**: "Verifiable
  Generative Provenance for Multimodal Tool-Using
  Agents." Introduces a **provenance graph** where each
  generated sentence emits a structured provenance record
  identifying the supporting tool turn, the support unit,
  and the semantic relation (Quotation / Compression /
  Inference). **This is the 2026 state-of-the-art for
  per-tool attribution at sentence level.** Eden v0
  ships trajectory-level tool attribution; v2 ships
  sentence-level provenance per TRACER.
* **Confident AI (2026)**: "LLM Agent Evaluation
  Metrics in 2026" — distinguishes **Tool Correctness**
  (deterministic — did the agent call the right tool?)
  from **Argument Correctness** (did the agent pass
  the right inputs?). **These two metrics are exactly
  what `ToolAttributionScorer` and the tool-attribution
  subgraph need to expose.**
* **atrib (creatornader, 2026)**: signed diagnostic
  outcomes + `informed_by` references — a complementary
  approach to TRACER for the per-tool causality question.

## What's already in Eden

* `src/eden/api/routes/agents.py` — the agent registry
  (Cat 6 substrate); tools are registered on agents.
* `src/eden/observability/ingestion/` — the 9 source-
  format decoders; tool_calls are captured in
  `telemetry_events.attributes.tool_calls`.
* `Cat 4 Retrieval` — the closest sibling; the
  `ChunkAttribution` pattern is reused for
  `ToolAttributionScorer`.
* `Cat 6 Agent Relationship Graph` — the handoff
  graph includes tool nodes; Cat 7 exposes the tool-
  specific view.
* The Cat 7 tables (tool_attributions, tool_comparisons)
  are already migrated in 020. The tool taxonomy is
  in `organizations.features.tool_taxonomy_json` (new in
  migration 023).

### v1 implementation (2026-06-11)

4 service classes in the new ``src/eden/services/tool_intel/``
package, reading from ``telemetry_events`` (filtered by
``event_type IN (tool.call, tool.execute, tool.invocation,
tool_run, tool.result)``) and persisting to the 2 Cat 7
tables.

* ``ToolAttributionScorer`` — per-tool success rate,
  latency, contribution score (60% success + 20% latency +
  20% per-trace utilisation), and drift alerts vs. the
  previous same-length window. Persists one row per
  ``(org, trace, tool)`` to ``tool_attributions``.
* ``ToolComparator`` — A vs B in the same window with
  Bayesian-style winner selection (non-inferiority margin
  = 0.05); ``drift_alert`` flag fires when the success-
  rate gap is ≥ 0.20 with both tools having ≥ 10 calls.
  Persists one row per ``(org, tool_a, tool_b, window)``
  to ``tool_comparisons`` (the table is unordered; the
  helper normalises ``tool_a < tool_b``).
* ``ToolRecommender`` — top-K tools for a given task type +
  agent, weighted by 0.4 × success_rate + 0.3 ×
  material_rate + 0.2 × latency_term + 0.1 × cost_term.
  Filters out tools with fewer than
  ``RECOMMENDER_MIN_CALLS = 5`` calls.
* ``ToolRegistryTaxonomy`` — the org's tool catalog
  (distinct tools with version, success rate, n_calls)
  plus the co-occurrence matrix (which tools tend to be
  called together in the same trace, normalised by the
  rarer tool's call count).

**Closed-loop wiring:** the Cat 17
``PromotionHook.on_drift_alert`` hook fires from both
``ToolAttributionScorer`` (on a ≥ 0.10 absolute
success-rate drop with ≥ 10 calls in both windows) and
``ToolComparator`` (on a ≥ 0.20 inter-tool gap). Drift
type is ``"tool_success_drop:<tool_name>"``; severity is
``"high"`` for |Δ| ≥ 0.20 else ``"medium"``.

**Determinism:** tool rankings, drift classifications, and
co-occurrence orderings are pure functions of the input
``telemetry_events`` rows. Re-running the services on the
same input produces the same output (idempotent).

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `ToolAttributionScorer.score` | `src/eden/services/tool_intel/attribution.py` | 1 | L |
| `ToolComparator.compare` | `src/eden/services/tool_intel/comparator.py` | 1 | M |
| `ToolRecommender.recommend` | `src/eden/services/tool_intel/recommender.py` | 1 | L |
| `ToolRegistryTaxonomy.taxonomy` | `src/eden/services/tool_intel/taxonomy.py` | 1 | M |
| **v2 additions (TRACER-aligned):** | | | |
| `ToolProvenanceGraph.build` | `src/eden/services/tool_intel/provenance.py` | 1 | L |
| `ToolArgumentScorer.score` | `src/eden/services/tool_intel/argument_scorer.py` | 1 | M |
| `ToolRecommender.discover_alternatives` | `src/eden/services/tool_intel/alternatives.py` | 1 | M |
| `ToolRegistryTaxonomy.diff_versions` | `src/eden/services/tool_intel/version_diff.py` | 1 | M |

**v0 surface:** 4 services, 4 routes. **v2 surface:**
8 services, 8 routes. v2 ships TRACER-aligned
sentence-level provenance and Argument Correctness
metrics.

## API contracts

### `POST /orgs/{org_id}/intelligence/tools/{tool_name}/attribution/score`

```json
body: { "window": "30d", "agent_id": "customer_service_v1" }
→ {
    "data": {
      "tool_name": "search_kb",
      "n_calls": 12453,
      "success_rate": 0.87,
      "p50_latency_ms": 145,
      "p95_latency_ms": 850,
      "contribution_score": 0.62,
      "argument_correctness": 0.91,
      "tool_correctness": 0.99,
      "drift_alerts": [
        { "type": "success_rate_drop", "window": "7d", "delta": -0.08 }
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/tools/compare`

```json
body: {
  "tools": ["search_kb", "search_docs", "search_external"],
  "task_type": "customer_question_answering",
  "window": "30d"
}
→ {
    "data": {
      "tools": [
        {
          "tool_name": "search_kb",
          "success_rate": 0.87,
          "contribution_score": 0.62,
          "cost_per_call_usd": 0.001,
          "p95_latency_ms": 850,
          "recommendation": "default"  // best for the task type
        },
        {
          "tool_name": "search_docs",
          "success_rate": 0.79,
          "contribution_score": 0.45,
          "cost_per_call_usd": 0.002,
          "p95_latency_ms": 1200,
          "recommendation": "fallback"
        },
        {
          "tool_name": "search_external",
          "success_rate": 0.92,
          "contribution_score": 0.71,
          "cost_per_call_usd": 0.015,
          "p95_latency_ms": 2400,
          "recommendation": "premium_when_confidence_low"
        }
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/tools/recommend`

```json
body: { "task_type": "code_review", "agent_id": "code_reviewer_v1", "k": 3 }
→ {
    "data": {
      "recommendations": [
        { "tool_name": "github_pr_list", "score": 0.84, "rationale": "essential for code review task" },
        { "tool_name": "code_search", "score": 0.72, "rationale": "high material in past 1000 reviews" },
        { "tool_name": "test_runner", "score": 0.61, "rationale": "useful for 60% of review tasks" }
      ]
    }
  }
```

### `GET /orgs/{org_id}/intelligence/tools/taxonomy`

```json
→ {
    "data": {
      "tools": [
        { "name": "search_kb", "type": "retrieval", "version": "1.2.0",
          "owner": "team_kb", "success_rate": 0.87, "n_calls_30d": 12453 },
        { "name": "code_search", "type": "search", "version": "2.0.1",
          "owner": "team_platform", "success_rate": 0.91, "n_calls_30d": 4521 },
        { "name": "send_email", "type": "action", "version": "1.0.0",
          "owner": "team_comms", "success_rate": 0.99, "n_calls_30d": 821 }
      ],
      "co_occurrence": {
        "search_kb,code_search": 0.31,
        "search_kb,send_email": 0.05
      }
    }
  }
```

## Data model

```sql
-- 1. Tool attributions (per trace × tool)
CREATE TABLE tool_attributions (
    id                      UUID PRIMARY KEY,
    org_id                  VARCHAR(128) NOT NULL,
    trace_id                VARCHAR(128) NOT NULL,
    tool_name               VARCHAR(128) NOT NULL,
    tool_version            VARCHAR(32) NOT NULL,
    agent_id                VARCHAR(128) NOT NULL,
    call_idx                INT NOT NULL,  -- 0 = first tool call in this trace
    success                 BOOLEAN NOT NULL,
    latency_ms              INT NOT NULL,
    argument_correctness    DOUBLE PRECISION,  -- v2: did it pass the right inputs?
    contribution_score      DOUBLE PRECISION,  -- 0.0-1.0
    method                  VARCHAR(16) NOT NULL DEFAULT 'trajectory',  -- trajectory|tracer_v2
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tool_attributions_trace
    ON tool_attributions (org_id, trace_id);
CREATE INDEX idx_tool_attributions_tool
    ON tool_attributions (org_id, tool_name, created_at DESC);

-- 2. Tool comparisons (pre-computed)
CREATE TABLE tool_comparisons (
    id                      UUID PRIMARY KEY,
    org_id                  VARCHAR(128) NOT NULL,
    tool_name_a             VARCHAR(128) NOT NULL,
    tool_name_b             VARCHAR(128) NOT NULL,
    task_type               VARCHAR(64) NOT NULL,
    window_start            TIMESTAMPTZ NOT NULL,
    window_end              TIMESTAMPTZ NOT NULL,
    success_rate_diff       DOUBLE PRECISION,
    p95_latency_diff_ms     DOUBLE PRECISION,
    cost_per_call_diff_usd  DOUBLE PRECISION,
    winner                  VARCHAR(128),  -- tool_name_a or tool_name_b
    confidence              DOUBLE PRECISION,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tool_comparisons_pair
    ON tool_comparisons (org_id, tool_name_a, tool_name_b, window_end DESC);
```

### v2 additions (TRACER-aligned provenance DAG):

```sql
-- 3. Per-sentence provenance (TRACER §3.2)
CREATE TABLE tool_provenance_nodes (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    node_id         VARCHAR(128) NOT NULL,  -- tool|answer|claim
    node_type       VARCHAR(32) NOT NULL,
    label           TEXT,
    payload_json    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tool_provenance_nodes_trace
    ON tool_provenance_nodes (org_id, trace_id);

CREATE TABLE tool_provenance_edges (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    from_node_id    VARCHAR(128) NOT NULL,
    to_node_id      VARCHAR(128) NOT NULL,
    relation        VARCHAR(32) NOT NULL,  -- quotation|compression|inference
    weight          DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tool_provenance_edges_trace
    ON tool_provenance_edges (org_id, trace_id);
```

## Algorithm / pseudo-code

### `ToolAttributionScorer.score` (trajectory-level, v0)

```python
def score(org_id, tool_name, agent_id=None, window="30d"):
    # Per Confident AI: Tool Correctness is deterministic,
    # Argument Correctness needs an LLM (or v2 SLM).
    sql = """
        SELECT
            count(*) as n_calls,
            sum(CASE WHEN success THEN 1 ELSE 0 END)::float
                / count(*) as success_rate,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) as p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95,
            avg(argument_correctness) as argument_correctness_mean
        FROM tool_attributions
        WHERE org_id = ? AND tool_name = ?
          AND created_at > now() - make_interval(days => ?)
          AND (? IS NULL OR agent_id = ?)
    """
    return await db.fetch(sql, org_id, tool_name, int(window[:-1]),
                          agent_id, agent_id)
```

### `ToolProvenanceGraph.build` (sentence-level, v2 — TRACER-aligned)

```python
async def build_provenance_graph(org_id, trace_id):
    # Per TRACER (arXiv 2605.09934): each generated
    # sentence emits a provenance record specifying
    # the supporting tool turn, the support unit, and
    # the relation.
    trace = await get_trace(org_id, trace_id)
    answer_sentences = split_sentences(trace.final_answer)
    tool_turns = get_tool_turns(trace)
    nodes = []
    edges = []
    # Add tool nodes
    for i, turn in enumerate(tool_turns):
        nodes.append({"id": f"tool_{i}", "type": "tool", "label": turn.name})
    # Add answer nodes (one per sentence)
    for j, sent in enumerate(answer_sentences):
        nodes.append({"id": f"ans_{j}", "type": "answer_sentence", "label": sent})
    # Emit provenance edges
    for j, sent in enumerate(answer_sentences):
        # v0 heuristic: each sentence may cite ≥ 1 tool turn
        # v2 LLM call: which tool turns does this sentence depend on?
        cited_tools = llm_judge.sentence_provenance(sent, tool_turns)
        for tool_idx, relation, weight in cited_tools:
            edges.append({
                "from": f"tool_{tool_idx}",
                "to": f"ans_{j}",
                "relation": relation,  # quotation|compression|inference
                "weight": weight,
            })
    return {"nodes": nodes, "edges": edges}
```

### `ToolComparator.compare` (Bayesian winner selection)

```python
def compare(org_id, tool_a, tool_b, task_type, window_days=30):
    a = score(org_id, tool_a, window=window_days)
    b = score(org_id, tool_b, window=window_days)
    # Bayesian winner: pick the tool with higher
    # posterior probability of being the best, given
    # a non-inferiority margin
    posterior = bayesian_paired_test(
        a.success_rate, a.n_calls, b.success_rate, b.n_calls,
        margin=0.05,  # non-inferiority margin
    )
    if posterior.probability_a_better > 0.95:
        winner, confidence = tool_a, posterior.probability_a_better
    elif posterior.probability_b_better > 0.95:
        winner, confidence = tool_b, posterior.probability_b_better
    else:
        winner, confidence = "tie", 0.5
    return {
        "tool_name_a": tool_a, "tool_name_b": tool_b,
        "success_rate_diff": a.success_rate - b.success_rate,
        "p95_latency_diff_ms": a.p95_latency_ms - b.p95_latency_ms,
        "cost_per_call_diff_usd": a.cost_per_call_usd - b.cost_per_call_usd,
        "winner": winner, "confidence": confidence,
    }
```

### `ToolRecommender.recommend` (K of N over the registry)

```python
def recommend(org_id, task_type, agent_id, k=3):
    # 1. Pull all tools the agent has access to
    available_tools = get_agent_tools(org_id, agent_id)
    # 2. Score each on the task_type's past performance
    scores = []
    for tool in available_tools:
        tool_perf = score(org_id, tool, agent_id, window="30d")
        if tool_perf.n_calls < 10:
            continue  # too few calls, score = 0
        # Material in the task_type: count occurrences in
        # the task_type's traces
        material_rate = SELECT count(*) / (
                SELECT count(*) FROM telemetry_events
                WHERE org_id = ? AND agent_id = ? AND event_type LIKE ?
            )
            FROM telemetry_events
            WHERE org_id = ? AND agent_id = ? AND event_type = tool
              AND created_at > now() - INTERVAL '90 days'
        score = (
            0.4 * tool_perf.success_rate
            + 0.3 * material_rate
            + 0.2 * (1 - tool_perf.p95_latency_ms / 5000)
            + 0.1 * (1 - tool_perf.cost_per_call_usd / 0.05)
        )
        scores.append((tool, score))
    # 3. Return top K
    return sorted(scores, key=lambda x: -x[1])[:k]
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| Tool success rate is dominated by easy cases | Bayesian correction with the "difficulty" prior from the agent benchmark run |
| Tool call latency is confounded by network jitter | Use p50, not mean; the `argument_correctness` is a separate signal |
| Tool is deprecated but still being called | `ToolRegistryTaxonomy.diff_versions` flags the call; the `AgentRelationshipGraph` (Cat 6) shows the dead-end edges |
| Tool argument correctness (v2) requires an LLM call | Falls back to deterministic schema check (does the argument match the tool's expected schema) when LLM is unavailable |
| Recommendation engine suggests a tool the agent doesn't have access to | `ToolRecommender.recommend` filters by `get_agent_tools(org_id, agent_id)` first |
| Provenance graph (v2) is slow on 1000-tool traces | Cache the graph in Redis with 24h TTL; rebuild on tool_version change |

## Telemetry

* `intelligence_tool_attribution` (counter, tagged by `tool_name`)
* `intelligence_tool_compare_run` (counter)
* `intelligence_tool_recommend` (counter)
* `intelligence_tool_taxonomy_view` (counter)
* `intelligence_tool_provenance_node_count` (histogram, v2)
* `intelligence_tool_argument_correctness` (histogram, v2)

## Test plan

* Attribution scorer: matches a hand-rolled SQL on a
  10k-tool-call fixture
* Tool Correctness is deterministic (matches the
  expected tool name in the fixture)
* Argument Correctness (v2) ≥ 0.85 agreement with
  hand-labelled ground truth
* Comparator: Bayesian winner selection matches
  analytical result on a 1k-comparison fixture
* Recommender: top-1 tool on a 100-tool fixture
  matches a hand-rolled K-of-N
* Taxonomy: roundtrips the registry
* Provenance graph (v2): roundtrips via atrib format
* RLS: a different org's tool is never returned

Target: **~20 tests, ~0.8s.**

## Acceptance criteria

- [x] All 4 v0 services implemented (v2 services deferred —
  per the v0 surface in the master doc)
- [x] Attribution scorer returns n_calls, success_rate,
  p50/p95 latency, contribution_score, drift_alerts
- [x] Comparator Bayesian winner selection (non-inferiority
  margin = 0.05) returns winner / tie + confidence
- [x] Recommender top-K with composite score (success +
  material + latency + cost) + rationales
- [x] Taxonomy returns catalog + co_occurrence matrix
- [x] All 60 tests pass
- [x] RLS: every query is filtered by ``org_id``
- [x] Graceful degradation: empty ``telemetry_events`` →
  "no tool telemetry" envelope; missing tool_name
  fields → row skipped
- [x] Closed-loop hook fires on material success-rate
  drop and large inter-tool gap
- [x] Determinism: re-runs on same input produce same
  output (idempotent)
- [x] Re-runnable: ``_delete_then_insert`` pattern for
  both Cat 7 tables

## Open questions

* **Tool version semantics** — is `v1.0.0` semver, or
  free-form? **Recommendation: semver, parsed in the
  registry; deprecation triggers on major-version
  bump.** (Owner: Cat 7 lead)
* **Co-occurrence threshold** — 0.05 vs 0.10 vs 0.20
  for "tools commonly called together". **Recommendation:
  configurable per org; default 0.10.** (Owner: Cat 7
  lead)
* **Provenance DAG LLM cost (v2)** — one LLM call per
  answer sentence is expensive. **Recommendation: cap
  at 10 sentences per trace; v2.1 uses the v1.4 SLM
  to drop cost 50×.** (Owner: Cat 7 lead)
* **Alternative discovery (v2)** — when a tool has
  success_rate < 0.5, find structurally similar tools
  in the registry. **Recommendation: embedding-based
  similarity on the tool's `description` field; ship in
  v2.1 with a UI surface.** (Owner: Cat 7 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](../eden-observability-gap-roadmap.md) § Cat 7
* Stub envelope: [`src/eden/intelligence_envelope.py`](../../src/eden/intelligence_envelope.py)
* Cat 4 (Retrieval — the `ChunkAttribution` pattern
  is reused here): [`04-retrieval-intelligence.md`](./04-retrieval-intelligence.md)
* Cat 6 (Agent — the `AgentRelationshipGraph`
  includes tool nodes): [`06-agent-intelligence.md`](./06-agent-intelligence.md)
* Cat 16 (Decision — the trajectory analyzer
  provides the per-step data):
  [`16-decision-intelligence.md`](./16-decision-intelligence.md)
* Research: TRACER (arXiv 2605.09934, 2026); Confident
  AI LLM Agent Evaluation Metrics 2026; atrib
  (creatornader, 2026)

---

## Cat 7 verification checklist (2026-06-11)

The **eleventh** category to graduate from stub to real
implementation, and the first of the Phase 2
(Aggregation layer) cats. 4 service classes + 1 shared
helper module in the new ``src/eden/services/tool_intel/``
package, reading from the production-grade
``telemetry_events`` table (filtered by ``event_type IN
(tool.*)``) and persisting to the 2 Cat 7 tables added in
migration 020 (``tool_attributions``,
``tool_comparisons``).

- [x] **Build green:** all 4 services importable from
  ``eden.services.tool_intel`` via lazy re-export
  (``ToolAttributionScorer``, ``ToolComparator``,
  ``ToolRecommender``, ``ToolRegistryTaxonomy``).
- [x] **4 routes registered:** ``POST /attribution``,
  ``POST /compare``, ``POST /recommend``,
  ``GET /taxonomy``. All 4 return the live envelope
  (``status: "ok"``, ``live: true``) on success; invalid
  input returns the live ``bad_request`` envelope.
- [x] **Persistence to both Cat 7 tables:**
  ``tool_attributions`` (one row per
  ``(org, trace, tool)`` when ``trace_id`` provided;
  aggregate-only row otherwise); ``tool_comparisons``
  (one row per ``(org, tool_a, tool_b, window)``).
  The comparator normalises ``tool_a < tool_b`` (lex
  sort) so the same pair always lands on the same row.
- [x] **Defensive tool-name extraction:** the
  ``_extract_tool_name`` helper checks 4 locations
  (``attributes->>'tool_name'``, ``attributes->>'name'``,
  ``payload->>'tool'``, ``name`` column with
  ``"tool:"`` prefix stripped). Rows with no recognisable
  name are skipped.
- [x] **Defensive success heuristic:** the
  ``_tool_is_success`` helper checks ``outcome`` first,
  then ``attributes->>'error'``, then defaults to
  ``True`` when no signal is present (so the v1
  telemetry schema's lack of ``outcome`` for tool rows
  doesn't depress the success rate).
- [x] **Drift detection (current vs. previous window):**
  the attribution scorer reads the previous same-length
  window (``NOW() - 2*interval`` to
  ``NOW() - interval``) via
  ``_fetch_tool_success_rate_in_prev_window`` and
  surfaces a ``drift_alerts`` entry when the absolute
  drop is ≥ 0.10 with both windows having ≥ 10 calls.
- [x] **Comparator winner selection:** Bayesian-style
  with non-inferiority margin = 0.05; below the
  margin → ``winner="tie"`` with ``confidence=0.5``.
- [x] **Recommender composite score:** ``0.4 ×
  success_rate + 0.3 × material_rate + 0.2 ×
  (1 - p95/5000) + 0.1 × (1 - cost/0.05)``. Tools with
  ``n_calls < 5`` are excluded (noisy signal).
- [x] **Taxonomy co-occurrence matrix:** for each
  unordered tool pair, returns the count of traces
  containing both tools, normalised by the rarer
  tool's call count. Sorted deterministically (count
  desc, then pair asc).
- [x] **Closed-loop hook fires on material drop:** the
  ``PromotionHook.on_drift_alert`` hook fires from
  both the attribution scorer (success_rate drop ≥
  0.10 with n ≥ 10 in both windows) and the
  comparator (inter-tool gap ≥ 0.20 with n ≥ 10 in
  both tools). Severity is ``"high"`` for |Δ| ≥ 0.20,
  else ``"medium"``. Drift type is
  ``"tool_success_drop:<tool_name>"``.
- [x] **Determinism:** tool rankings, drift
  classifications, and co-occurrence orderings are
  pure functions of the input. Re-runs on the same
  data produce the same output (idempotent).
- [x] **Graceful degradation:** empty ``telemetry_events``
  → "no tool telemetry" envelope; missing
  ``response_body`` / answer text → zero-default
  metrics with a clear message; tool name not found
  in any field → row skipped.
- [x] **60 new tests pass:** 5 attribution service + 2
  per-trace events + 1 drift + 5 comparator + 3
  recommender + 2 taxonomy + 4 envelope + 6
  ``_extract_tool_name`` + 5 ``_tool_is_success`` + 9
  percentile/safe/clamp/round6 + 5 hook-firing + 4
  package contract + 5 route smoke + 2 persistence
  integration. Total: 60 tests, ~0.9s.
- [x] **No regressions in adjacent suites:** full
  ``tests/intelligence/`` = 591 passed (1 pre-existing
  live-tail skip); ``tests/unit/llmops/ + tests/unit/
  observability/`` = 264/264 pass.
- [x] **Migration unchanged:** the 2 Cat 7 tables were
  already in ``020_intelligence_gap_tables.py``; no
  new migration required.
- [x] **Cat 7 appendix updated:** this file now reads
  ``status: ✅ IMPLEMENTED v1`` and the "What's already
  in Eden" section describes the real implementation.
  The 11 acceptance criteria checkboxes are now
  checked.

**Net code change for Cat 7:**
3 new files in ``src/eden/services/tool_intel/``
(``__init__.py`` ~90 LOC lazy re-exports, ``_common.py``
~660 LOC with 16 helpers, ``services.py`` ~570 LOC with
all 4 service classes), 1 modified router
(``intelligence_tools.py``, 4 ``await`` keyword additions
+ new Pydantic body models + ``feature`` constant
alignment), 1 new test file
(``test_tool_intelligence.py`` with 60 tests, ~1,000
LOC). Two closed-loop hook reasons wired
(``on_drift_alert`` on attribution success-rate drop +
comparator inter-tool gap).

Cat 7 is the **first Phase 2 cat** (Aggregation layer,
weeks 5-8 per the master doc) to ship. Phase 1
(Observation layer, Cats 1-5) is fully real; Cat 6
ships earlier than planned because of its criticality for
the closed-loop wiring. Cat 7's natural Phase 2 sibling
is Cat 9 (User Intelligence).
