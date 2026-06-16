---
title: "05 — Memory Intelligence (Cat 5)"
status: IMPLEMENTED v1
last_updated: 2026-06-11
version: 1.2
---

# 05 — Memory Intelligence (Cat 5)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-11,
> 4 services in `src/eden/kb/episodic/memory_intel/`,
> 33 new tests). Memory Attribution reads `memory.*`
> events from `telemetry_events` and persists per-memory
> influence scores to ``memory_attributions``;
> Timeline reads from ``memory_timeline_events``;
> Impact Scorer applies a retrieval-score × materiality
> × recency weighting and persists to
> ``memory_impact_scores``; Reweaver emits merge / archive
> / demote *suggestions* (never destructive; v2 ships the
> admin endpoint that applies them).
> **No competitor ships a production-quality memory
> attribution system as of June 2026** — this is the cat
> where Eden is **strictly first** in the market.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles & research](#source-articles--research)
3. [What's already in Eden](#whats-already-in-eden)
4. [The Pink et al. (2025) episodic-memory framework](#the-pink-et-al-2025-episodic-memory-framework)
5. [Feature inventory](#feature-inventory)
6. [API contracts](#api-contracts)
7. [Data model](#data-model)
8. [Algorithm / pseudo-code](#algorithm--pseudo-code)
9. [Failure modes & guardrails](#failure-modes--guardrails)
10. [Telemetry](#telemetry)
11. [Test plan](#test-plan)
12. [Acceptance criteria](#acceptance-criteria)
13. [Open questions](#open-questions)
14. [Cross-references](#cross-references)

## Goal & motivation

Surface which memory entries influenced an answer, when each
memory was created/updated/deleted/accessed, the impact of each
memory (memory A: 61% influence, memory B: 24%), and suggestions
to merge/archive stale memories.

The user story is:

> "I have 100 memories stored for this user. I want to know
> which 3 actually influenced the agent's last response. And
> I want to know which memories are stale (last accessed > 90
> days ago) so I can archive them."

Article 1 calls Memory Intelligence the **"largest gap in
today's market"** — almost nobody does this properly.

## Source articles & research

* **Article 1 §5**: "Memory Explorer (user/episodic/long-term/
  working memory), Memory Attribution, Memory Timeline
  (created/updated/deleted/accessed), Memory Quality
  (contradictions/duplication/staleness), Memory Impact Scoring
  (Memory A: 61% influence, memory B: 24%)."
* **Pink et al. 2025 (position paper)**: *"Episodic Memory is
  the Missing Piece for Long-Term LLM Agents"* — distils
  5 concrete properties that define a memory system as
  "episodic"; the 5th is **consolidation**, the single
  most critical open research direction. Most production
  frameworks (Letta, LangMem, Mem0, Zep) **leave
  consolidation to the agent itself, triggered manually
  via tool calls**. There is no automated pipeline.
* **MemGPT / Letta (Packer et al. 2023)**: memory as
  virtual memory — agent manages a 3-tier hierarchy
  (core = always-in-context, recall = full history via
  tool call, archival = external vector store) through
  function calls. **Proven pattern, but the agent is
  in charge of its own memory.**
* **Letta 0.15+ (2026)**: introduces **MemFS** (memory
  filesystem) — git-backed directory of markdown files
  + **sleep-time subagents** ("dream" agents) that
  periodically reflect and consolidate. This is the
  first production framework to operationalise the
  Pink et al. consolidation property.
* **MemQ (arXiv 2605.08374, 2026)**: integrates
  Q-learning into self-evolving memory agents over
  **provenance DAGs**. Key insight: instead of just
  tracking which memories were retrieved, track
  which memories were retrieved **for the task that
  produced the next memory** — TD(λ) propagates credit
  backward through the DAG. This is the first
  principled approach to **memory impact scoring**
  that goes beyond "memory A: 61% influence" toward
  "memory A's contribution to the *new memory* B was
  X% of B's value."
* **atrib (creatornader, 2026)**: open-source agent
  attribution framework using **signed diagnostic
  outcomes** linked via `informed_by` references. 9
  edge types connect actions into a verifiable graph.
  First framework to ship **signed, replayable**
  agent history.

The 2026 consensus across these papers: **memory
attribution requires a provenance DAG, not a scalar
influence score**. Eden Cat 5 ships the influence score
(per Article 1) AND the provenance DAG (per Pink et
al. + MemQ) — backward-compatible with the existing
scoring, forward-compatible with the DAG approach.

## What's already in Eden

* `EpisodicClient` at `src/eden/kb/episodic/client.py` —
  browse, search, and cluster episodic memories. Backed
  by the existing memory storage.
* `DataQualityValidator` at
  `src/eden/api/routes/data_platform.py` — validates
  table freshness and quality (the data substrate for
  the Memory Timeline and Reweaver).
* `EpisodicClient.list()`,
  `search_by_description()`,
  `get_recent()`,
  `get_clustering_candidates()` — the **Memory
  Explorer** surface (Article 1 §5's first sub-feature).
* The Cat 5 tables (memory_attributions,
  memory_timeline_events, memory_impact_scores) are
  already migrated in 020. The provenance DAG
  columns are added in migration 023.
* `JudgeContext` and `JudgeScore` (in
  `src/eden/llmops/judges/base.py`) — the
  re-usable types for the per-memory influence score.

## The Pink et al. (2025) episodic-memory framework

Cat 5 ships against the 5 properties of episodic memory
that the position paper identifies. We map each
property to an Eden surface:

| # | Property (Pink et al. 2025) | Eden Cat 5 surface |
|---|---|---|
| 1 | **Event-level granularity** | `MemoryTimelineBuilder` — every `created / updated / deleted / accessed` event is logged to `memory_timeline_events` with the agent + prompt + outcome |
| 2 | **Temporal context** | `occurred_at` on every timeline event; the `Reweaver.suggest` function checks `last_accessed > 90 days ago` |
| 3 | **Causal links to outcomes** | `MemoryAttributor` + `MemoryImpactScorer` — counterfactual attribution per Pink et al. + MemQ provenance DAG (v2) |
| 4 | **Distinct from semantic memory** | Existing `EpisodicClient` already differentiates episodic (event-keyed) from semantic (fact-keyed) |
| 5 | **Consolidation** | **MISSING in v0; v2 ships the `SleepTimeConsolidator`** (see Open Questions) |

Property 5 (consolidation) is the open research
frontier. v0 ships the first 4; v2 ships consolidation
via sleep-time subagents (per Letta 0.15+'s dream
pattern) or via MemQ's Q-learning approach (per
arXiv 2605.08374). Either way, the `Reweaver.suggest`
already produces the merge / archive / dedup
recommendations that consolidation executes.

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `MemoryAttributor.attribute` | `src/eden/kb/episodic/memory_intel/attributor.py` | 1 | L |
| `MemoryTimelineBuilder.timeline` | same | 1 | M |
| `MemoryImpactScorer.score` | same | 1 | L |
| `MemoryReweaver.suggest` | same | 1 | M |
| **v2 additions:** | | | |
| `MemoryConsolidator.consolidate` | same | 1 | L |
| `ProvenanceDAG.build` | same | 1 | L |
| `MemoryConflictResolver.resolve` | same | 1 | M |
| `MemoryTierManager.promote` / `.demote` | same | 2 | M |
| `MemoryPrivacyFilter.redact` | same | 1 | S |

The 5 v2 services are the Letta/MemQ/Atrib-aligned
expansion. **Total v2 surface: 9 services, 9 routes,
3 tables, ~2,500 LOC.**

## API contracts

### `POST /orgs/{org_id}/intelligence/memory/{trace_id}/attribute`

```json
→ {
    "data": {
      "per_memory": [
        { "memory_id": "m1", "influence_score": 0.61, "role": "primary" },
        { "memory_id": "m2", "influence_score": 0.24, "role": "secondary" },
        { "memory_id": "m3", "influence_score": 0.10, "role": "context" }
      ],
      "uncovered_facts": ["the user's birthday is March 15"],
      "provenance_dag_url": "/intelligence/memory/dag/{trace_id}"  // v2
    }
  }
```

### `GET /orgs/{org_id}/intelligence/memory/timeline/{memory_id}`

```json
→ {
    "data": {
      "events": [
        { "event_type": "created",  "occurred_at": "2026-03-01T...", "actor": "agent:customer_service_v1" },
        { "event_type": "updated",  "occurred_at": "2026-04-15T...", "actor": "user:u_123", "diff": "name spelling" },
        { "event_type": "accessed", "occurred_at": "2026-06-10T...", "actor": "agent:customer_service_v1", "trace_id": "trc_abc" },
        { "event_type": "deleted",  "occurred_at": "2026-07-20T...", "actor": "user:u_123" }
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/memory/{trace_id}/impact`

```json
→ {
    "data": {
      "per_memory": [
        { "memory_id": "m1", "score": 0.61, "q_value": 0.83 },  // MemQ Q-value
        { "memory_id": "m2", "score": 0.24, "q_value": 0.41 }
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/memory/reaver/suggest`

```json
body: { "memory_id": "m1" }
→ {
    "data": {
      "suggestions": [
        { "action": "merge",   "with_memory_id": "m5", "rationale": "near-duplicate (cosine 0.97)" },
        { "action": "archive",                       "rationale": "last accessed 95 days ago" },
        { "action": "demote",  "to_tier": "cold",    "rationale": "never material in last 1000 traces" }
      ]
    }
  }
```

### `GET /orgs/{org_id}/intelligence/memory/dag/{trace_id}` (v2)

Returns the full provenance DAG for a trace: every
memory retrieved, every tool called, every fact
extracted, with `informed_by` edges. Compatible with
the open-source `atrib` format so other harnesses can
import / replay.

```json
→ {
    "data": {
      "nodes": [
        { "id": "m1", "type": "memory",  "label": "user birthday" },
        { "id": "m2", "type": "memory",  "label": "user prefers email" },
        { "id": "m3", "type": "memory",  "label": "user timezone PST" },
        { "id": "t1", "type": "tool",    "label": "search_kb" },
        { "id": "a1", "type": "answer",  "label": "final response" }
      ],
      "edges": [
        { "from": "t1", "to": "a1", "relation": "informed_by", "weight": 0.61 },
        { "from": "m1", "to": "a1", "relation": "informed_by", "weight": 0.24 },
        { "from": "m2", "to": "a1", "relation": "informed_by", "weight": 0.10 },
        { "from": "m3", "to": "a1", "relation": "informed_by", "weight": 0.05 }
      ]
    }
  }
```

## Data model

```sql
-- 1. Memory attributions: which memory influenced which trace
CREATE TABLE memory_attributions (
    id                UUID PRIMARY KEY,
    org_id            VARCHAR(128) NOT NULL,
    trace_id          VARCHAR(128) NOT NULL,
    memory_id         VARCHAR(128) NOT NULL,
    influence_score   DOUBLE PRECISION NOT NULL,
    role              VARCHAR(16) NOT NULL DEFAULT 'context',  -- primary|secondary|context
    method            VARCHAR(16) NOT NULL DEFAULT 'counterfactual',  -- counterfactual|provenance_dag|v2
    q_value           DOUBLE PRECISION,  -- MemQ Q-value (v2)
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_memory_attributions_trace
    ON memory_attributions (org_id, trace_id);
CREATE INDEX idx_memory_attributions_memory
    ON memory_attributions (org_id, memory_id, created_at DESC);

-- 2. Memory timeline events
CREATE TABLE memory_timeline_events (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    memory_id       VARCHAR(128) NOT NULL,
    event_type      VARCHAR(16) NOT NULL,  -- created, updated, deleted, accessed, promoted, demoted
    occurred_at     TIMESTAMPTZ NOT NULL,
    actor           VARCHAR(128) NOT NULL,  -- agent:<id> or user:<id> or system:consolidator
    trace_id        VARCHAR(128),  -- for "accessed" events
    payload_json    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_memory_timeline_events_memory
    ON memory_timeline_events (org_id, memory_id, occurred_at DESC);
CREATE INDEX idx_memory_timeline_events_actor
    ON memory_timeline_events (org_id, actor, occurred_at DESC);

-- 3. Memory impact scores (one row per trace × memory)
CREATE TABLE memory_impact_scores (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    memory_id       VARCHAR(128) NOT NULL,
    score           DOUBLE PRECISION NOT NULL,
    method          VARCHAR(16) NOT NULL DEFAULT 'counterfactual',  -- counterfactual|q_learning|v2
    q_value         DOUBLE PRECISION,  -- MemQ Q-value (v2)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_memory_impact_scores_trace
    ON memory_impact_scores (org_id, trace_id);
```

### v2 additions (migration 023):

```sql
-- 4. Provenance DAG nodes (memory/tool/answer)
CREATE TABLE memory_provenance_nodes (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    node_id         VARCHAR(128) NOT NULL,
    node_type       VARCHAR(16) NOT NULL,  -- memory|tool|answer|finding
    label           TEXT,
    payload_json    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_memory_provenance_nodes_trace
    ON memory_provenance_nodes (org_id, trace_id);

-- 5. Provenance DAG edges
CREATE TABLE memory_provenance_edges (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    from_node_id    VARCHAR(128) NOT NULL,
    to_node_id      VARCHAR(128) NOT NULL,
    relation        VARCHAR(32) NOT NULL,  -- informed_by|supersedes|attests_to|contradicts
    weight          DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    q_value         DOUBLE PRECISION,  -- MemQ
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_memory_provenance_edges_trace
    ON memory_provenance_edges (org_id, trace_id);
CREATE INDEX idx_memory_provenance_edges_from
    ON memory_provenance_edges (org_id, from_node_id);

-- 6. Memory tiers (hot/warm/cold/archived)
ALTER TABLE memory_provenance_nodes
    ADD COLUMN tier VARCHAR(16) NOT NULL DEFAULT 'hot';  -- hot|warm|cold|archived
CREATE INDEX idx_memory_provenance_nodes_tier
    ON memory_provenance_nodes (org_id, tier);
```

## Algorithm / pseudo-code

### Attribution (counterfactual — v0)

```python
def attribute(org_id, trace_id, method="counterfactual"):
    # 1. Reconstruct the prompt that was sent to the LLM
    prompt = reconstruct_prompt(org_id, trace_id)
    answer = get_final_answer(org_id, trace_id)
    memories = extract_memories_from_prompt(prompt)

    if method == "counterfactual":
        # v0 approach (Article 1)
        contributions = []
        for mem in memories:
            prompt_without = prompt.replace(mem.text, "")
            new_answer = llm_client.call(
                agent="memory_attribution",
                prompt=prompt_without, slot="fast", max_tokens=500,
            )
            contribution = compute_semantic_distance(answer, new_answer)
            contributions.append({
                "memory_id": mem.id,
                "influence_score": contribution,
                "role": "primary" if contribution > 0.5
                       else "secondary" if contribution > 0.15
                       else "context",
            })
        # Normalize
        total = sum(c["influence_score"] for c in contributions)
        if total > 0:
            for c in contributions:
                c["influence_score"] /= total
        return {"per_memory": contributions}
```

### Attribution (provenance DAG — v2, MemQ-aligned)

```python
def attribute_dag(org_id, trace_id, method="provenance_dag"):
    # Per MemQ (arXiv 2605.08374): use the provenance DAG
    # structure rather than re-running the LLM
    dag = build_provenance_dag(org_id, trace_id)
    # TD(λ) backward through the DAG, crediting ancestors
    # proportionally to structural depth
    q_values = {}
    lambda_ = 0.95
    for node in dag.descendants(answer_node):
        reward = compute_outcome_reward(node)
        for ancestor, depth in dag.ancestors_with_depth(node):
            decay = lambda_ ** depth
            q_values[ancestor] = q_values.get(ancestor, 0) + reward * decay
    return q_values
```

### Timeline (event log)

```python
def timeline(org_id, memory_id):
    events = SELECT * FROM memory_timeline_events
              WHERE org_id = ? AND memory_id = ?
              ORDER BY occurred_at DESC
              LIMIT 100
    return {"events": events}
```

A real implementation populates `memory_timeline_events`
via a trigger on the existing memory-storage table
(or a CDC consumer in the `EpisodicClient`).

### Reweaver (stale + duplicate detection)

```python
def suggest(org_id, memory_id):
    suggestions = []
    # 1. Last-accessed check (stale)
    last_access = SELECT MAX(occurred_at)
                  FROM memory_timeline_events
                  WHERE org_id = ? AND memory_id = ? AND event_type = 'accessed'
    days_since = (now() - last_access).days
    if days_since > 90:
        suggestions.append({"action": "archive", "rationale": f"last accessed {days_since} days ago"})
    # 2. Materiality check (v2 — never material in last 1000 traces)
    never_material = SELECT count(*)
                     FROM memory_attributions
                     WHERE org_id = ? AND memory_id = ?
                       AND created_at > now() - INTERVAL '30 days'
    if never_material == 0:
        suggestions.append({"action": "demote", "to_tier": "cold",
                            "rationale": "never material in last 30 days"})
    # 3. Duplicate check (near-duplicate by cosine)
    target_emb = embed(get_memory_text(memory_id))
    similar = SELECT memory_id, embedding FROM memories
              WHERE org_id = ? ORDER BY embedding <-> target_emb LIMIT 5
    for other_id, other_emb in similar:
        sim = cosine_similarity(target_emb, other_emb)
        if sim > 0.95:
            suggestions.append({"action": "merge", "with_memory_id": other_id,
                                "rationale": f"near-duplicate (cosine {sim:.2f})"})
    return {"suggestions": suggestions}
```

### Conflict resolution (v2)

When the same fact appears in 2+ memories with
contradicting content (e.g., "user birthday: March 15"
vs "user birthday: March 17"):

```python
def resolve(org_id, memory_id_a, memory_id_b):
    # 1. Most-recently-touched wins, by default
    a_touched = last_touched(org_id, memory_id_a)
    b_touched = last_touched(org_id, memory_id_b)
    if a_touched > b_touched:
        winner, loser = memory_id_a, memory_id_b
    else:
        winner, loser = memory_id_b, memory_id_a
    # 2. But if the loser has more attributions (used more),
    #    flag for human review instead of auto-merging
    loser_usage = count(SELECT * FROM memory_attributions
                        WHERE memory_id = loser AND created_at > now() - INTERVAL '90 days')
    if loser_usage > 5:
        return {"action": "escalate", "winner": winner, "loser": loser,
                "rationale": f"loser used in {loser_usage} traces in last 90 days; needs human review"}
    return {"action": "merge", "winner": winner, "loser": loser}
```

### Sleep-time consolidation (v2)

Per Letta 0.15+'s "dream" pattern + Pink et al.'s
"consolidation" property:

```python
async def sleep_time_consolidator(org_id):
    """Runs nightly. 4 sub-tasks."""
    # 1. Demote cold memories (never material in 30d)
    candidates = reaver.suggest(org_id, "ALL")
    for c in candidates:
        if c["action"] == "demote":
            memory_tier_manager.demote(org_id, c["memory_id"], c["to_tier"])
    # 2. Merge near-duplicates
    for c in candidates:
        if c["action"] == "merge":
            await memory_consolidator.merge(org_id, c["memory_id"], c["with_memory_id"])
    # 3. Archive stale memories
    for c in candidates:
        if c["action"] == "archive":
            await memory_consolidator.archive(org_id, c["memory_id"])
    # 4. Refresh the Q-values (MemQ)
    for trace in recent_traces(org_id, days=7):
        memory_impact_scorer.score_dag(org_id, trace.trace_id)
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| **No memories in the prompt** | Return empty `per_memory` with `data.message: "no memories used"`. |
| **LLM-as-judge fails (v0 counterfactual)** | Fall back to token overlap between memory text and final answer. |
| **Counterfactual cost** (re-run LLM per memory) | v0 caps at 10 memories per trace; v2 switches to provenance DAG (no LLM re-run). |
| **Reweaver is destructive** | Returns *suggestions* only. A separate admin endpoint applies the merge/archive. |
| **Conflict resolution auto-merges** | Auto-merges only when the loser is unused in last 90d; otherwise escalates to human review. |
| **Sleep-time consolidator runs out of LLM budget** | Cat 9 `TenantBudget` applies; per-tenant cap; budget-abort fires `JudgeBudgetHook.on_auto_judge_budget_exceeded` (Cat 17b) |
| **Privacy leak** (memory contains PII surfaced in trace) | `MemoryPrivacyFilter.redact` (v2) strips PII before the LLM call |
| **Provenance DAG cycle** (memory A → memory B → memory A) | Cycle detector rejects at ingest; cycle is a bug in the agent harness |

## Telemetry

* `intelligence_memory_attribution` (counter, tagged by
  `method`)
* `intelligence_memory_attribution_latency_ms` (histogram)
* `intelligence_memory_impact_score` (histogram)
* `intelligence_memory_reaver_suggestion` (counter,
  tagged by `action`)
* `intelligence_memory_conflict_resolved` (counter,
  tagged by `outcome: merge|escalate`)
* `intelligence_memory_sleep_time_consolidation` (counter,
  tagged by `outcome: merged|archived|demoted|skipped`)
* `intelligence_memory_dag_node_count` (histogram)
* `intelligence_memory_q_value` (histogram, MemQ)

## Test plan

* **Attribution top-1 memory matches hand-labelled ground
  truth** ≥ 90% of the time (both counterfactual and
  provenance DAG methods).
* **Attribution is deterministic** (same trace → same
  attribution).
* **Timeline returns events in reverse chronological
  order**, includes all 6 event types.
* **Reweaver flags synthetic stale memory** (last_accessed
  > 90d) for archival.
* **Reweaver flags near-duplicate** (similarity > 0.95) for
  merge.
* **Conflict resolution auto-merges unused losers, escalates
  used losers**.
* **Provenance DAG roundtrip** — build, serialize, replay
  on a different Eden tenant, get the same attribution.
* **Provenance DAG compat with atrib** (open-source format)
  — load atrib trace → Eden attribution matches within 5%.
* **Sleep-time consolidator is idempotent** — running it
  twice on the same memory set produces the same end state.
* **RLS**: a different org's memories are never returned
  (tested via a per-tenant fixture).

Target: **~28 tests, ~1.0s.**

## Acceptance criteria

- [ ] Attribution shows the correct top-1 memory on a
  synthetic test set ≥ 90% of the time (both methods).
- [ ] Timeline includes all 6 event types (created, updated,
  deleted, accessed, promoted, demoted).
- [ ] Reweaver flags stale memories (last_accessed > 90d)
  for archival.
- [ ] Reweaver flags near-duplicates (similarity > 0.95)
  for merge.
- [ ] Reweaver flags never-material memories (zero
  attributions in 30d) for demotion.
- [ ] Attribution is deterministic (same trace → same
  attribution).
- [ ] Conflict resolution auto-merges losers with zero
  attributions in 90d; escalates losers with ≥ 5
  attributions in 90d.
- [ ] Provenance DAG (v2) roundtrips via atrib format.
- [ ] Sleep-time consolidator (v2) is idempotent.
- [ ] All 28 tests pass.
- [ ] RLS: cross-tenant memory is never returned.

## Open questions

* **Consolidation policy** — Letta uses sleep-time
  subagents (LLM-driven); MemQ uses Q-learning
  (gradient-driven); we could ship either. **Recommendation:
  start with Letta's pattern (simpler, ships in week 1),
  layer MemQ's Q-learning in v2.1 once we have 30 days
  of data.** (Owner: Cat 5 lead)
* **Memory storage** — does the existing `EpisodicClient`
  back the `memory_timeline_events` table, or do we
  need a new trigger? **Recommendation: write a CDC
  consumer that subscribes to the existing memory
  storage and populates the timeline.** (Owner: Cat 5
  lead)
* **Memory quality vs quantity** — should we cap the
  per-user memory count? **Recommendation: yes, soft
  cap at 10,000 per user; Reweaver auto-archives the
  bottom 10% by last_accessed.** (Owner: Cat 5 lead)
* **Provenance DAG storage** — adjacency list (one row
  per edge) vs path enumeration (one row per path).
  **Recommendation: adjacency list; per-trace query
  with recursive CTE.** (Owner: Cat 5 lead)
* **Cross-org memory sharing** — should tenant A be able
  to import a memory from tenant B? **Recommendation:
  no, not in v0; revisit if the marketplace feature
  ships.** (Owner: Cat 5 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap) § Cat 5
* Stub envelope: `src/eden/intelligence_envelope.py`
* Existing episodic client:
  `src/eden/kb/episodic/client.py`
* Data quality validator:
  `src/eden/api/routes/data_platform.py`
* Cat 4 (Retrieval — reuses attribution patterns):
  [`04-retrieval-intelligence.md`](./04-retrieval-intelligence.md)
* Cat 16 (Decision — reuses provenance DAG patterns):
  [`16-decision-intelligence.md`](./16-decision-intelligence.md)
* Cat 7 (Tool — reuses attribution patterns for tool calls):

## Ship log

### v1 — 2026-06-11

4 services shipped; 33 new tests; doc flipped STUB →
IMPLEMENTED v1. All services degrade gracefully when
their dependencies are missing or empty (the typical
Eden pattern: a "no data" envelope with a ``message``
hint).

* **MemoryAttributor** —
  ``src/eden/kb/episodic/memory_intel/attributor.py``.
  Reads ``memory.*`` events from ``telemetry_events``,
  tokenises the memory text, computes a per-memory
  influence score (Jaccard overlap with the trace's
  final answer, weighted 0.7/0.3 by the harness's
  retrieval_score when present), normalises to sum to
  1.0 across the trace, maps each score to a role
  (``primary`` / ``secondary`` / ``context``), and
  persists one row per memory to
  ``memory_attributions``. Side-effect: appends an
  ``accessed`` event to ``memory_timeline_events``
  for every memory the trace used.
* **MemoryTimelineBuilder** — same file. Returns the
  full lifecycle (created / updated / deleted /
  accessed / promoted / demoted) for one ``memory_id``
  by reading from ``memory_timeline_events``,
  ordered by ``occurred_at DESC`` and capped at
  ``MAX_TIMELINE_EVENTS = 200``. Empty / missing rows
  return ``status: "not_found"``.
* **MemoryImpactScorer** — same file. For each memory
  on the trace, computes an impact score
  ``0.5 * retrieval_score + 0.3 * materiality + 0.2 *
  recency``, where ``materiality`` is the
  count-of-attributions-in-30d normalised to 0..1
  (saturating at 10), and ``recency`` is
  ``1 - (days_since_last_attribution / 30)`` clamped
  to 0..1. Persists per-memory rows to
  ``memory_impact_scores``.
* **MemoryReweaver** — same file. For a single
  ``memory_id`` (or the org's full distinct set
  inferred from the last 30 days of timeline +
  attribution rows), returns merge / archive /
  demote *suggestions*:
  * ``archive`` when ``last_accessed`` is more than
    :data:`STALE_DAYS = 90` days ago, or never
    accessed.
  * ``demote`` when zero attributions in the last
    :data:`NEVER_MATERIAL_DAYS = 30` days.
  * ``merge`` when Jaccard with another memory in the
    org's corpus is ≥
    :data:`NEAR_DUPLICATE_THRESHOLD = 0.85`.
* **Shared helpers** —
  ``src/eden/kb/episodic/memory_intel/_common.py``.
  Envelope helpers (``_ok_envelope``,
  ``_not_found_envelope``, ``_bad_request_envelope``)
  with ``live=True`` so the front-end can distinguish
  real responses from the ``not_implemented`` stubs.
  Postgres data read paths for the 4 services. Window
  parsing, tokeniser, role mapping, normalisation.
  Persistence helpers using the
  delete-then-insert pattern (the migration
  ``020_intelligence_gap_tables.py`` has no unique
  constraint, so the helpers clear the
  ``(org, trace)`` or ``(org, memory)`` tuple first
  to make the services re-runnable).
* **Package init** —
  ``src/eden/kb/episodic/memory_intel/__init__.py``.
  Re-exports the 4 services for the route file and
  any downstream consumer.

### Verification

```
$ pytest tests/intelligence/test_memory_intelligence.py
.......... 33 passed
$ pytest tests/intelligence/
........ 456 passed, 1 skipped
```

The Cat 5 routes are mounted at:

* ``POST /orgs/{org_id}/intelligence/memory/{trace_id}/attribute``
* ``GET  /orgs/{org_id}/intelligence/memory/timeline/{memory_id}``
* ``POST /orgs/{org_id}/intelligence/memory/{trace_id}/impact``
* ``POST /orgs/{org_id}/intelligence/memory/reaver/suggest``

All four require the ``intelligence_gap_v0`` feature
flag and a valid ``get_current_user``. The
``reaver/suggest`` route accepts ``{"memory_id": "m1",
"window": "30d"}``; an empty ``memory_id`` triggers
the org-wide reweave.

### What's deferred to v2 (per the appendix)

* **Provenance DAG** (MemQ) — replaces the v0
  counterfactual path with a structured
  ``memory_provenance_nodes`` / ``memory_provenance_edges``
  graph + Q-learning credit assignment. Migration 023
  + 3 new services (``ProvenanceDAG.build``,
  ``MemoryConsolidator.consolidate``,
  ``MemoryConflictResolver.resolve``).
* **Sleep-time consolidation** (Letta MemFS pattern) —
  the destructive admin endpoint that the v0
  ``MemoryReweaver`` *suggests* but never *applies*.
  Will run nightly as a background task.
* **Per-tenant LoRA heads** for the v1.4 SLM-as-judge
  plan — a future Memory-aware judge ("is this memory
  relevant to the current task?") trained on the v0
  attribution data.
  [`07-tool-intelligence.md`](./07-tool-intelligence.md)
* Research: Pink et al. 2025 position paper on episodic
  memory; MemGPT / Letta memory-as-virtual-memory
  pattern; MemQ provenance DAG; atrib signed
  diagnostic outcomes
