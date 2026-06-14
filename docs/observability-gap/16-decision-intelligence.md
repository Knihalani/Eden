---
title: "16 — Decision Intelligence (Cat 16) ⭐ NEW"
status: IMPLEMENTED v1
last_updated: 2026-06-10
version: 1.1
---

# 16 — Decision Intelligence (Cat 16) ⭐ NEW

> **Status:** IMPLEMENTED v1 (as of 2026-06-10). All 5 services
> have real implementations that read `telemetry_events`, persist
> to the 4 already-migrated tables, and (for the scorer) fire
> the Cat 17 closed-loop hooks. The package lives at
> `src/eden/decision/` and is reachable at
> `/intelligence/replay/decision/...`.
>
> Article 1 calls Decision Intelligence the **"biggest gap in
> today's market"** — users cannot understand why agents choose
> actions.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles](#source-articles)
3. [What's already in Eden](#whats-already-in-eden)
4. [The 3 Galileo metrics, reused](#the-3-galileo-metrics-reused)
5. [Feature inventory (5 features)](#feature-inventory-5-features)
6. [API contracts](#api-contracts)
7. [Data model (4 tables)](#data-model-4-tables)
8. [Algorithm / pseudo-code](#algorithm--pseudo-code)
9. [Failure modes & guardrails](#failure-modes--guardrails)
10. [Telemetry](#telemetry)
11. [Test plan](#test-plan)
12. [Acceptance criteria](#acceptance-criteria)
13. [Implementation order](#implementation-order)
14. [Open questions](#open-questions)
15. [Cross-references](#cross-references)

## Goal & motivation

Reconstruct the decision path of an agent execution, explain in
natural language why the agent chose action X over Y, list the
alternatives the agent considered, score the quality of each
decision, and run multi-step agent trajectory analysis.

The user story is:

> "I have a multi-step agent run that produced a wrong answer.
> I want to see: what did the agent do at each step? What
> alternatives did it consider? Why did it pick the wrong one?
> And what's the overall trajectory — did it loop, did it
> backtrack, did it hit a dead end?"

This requires:

1. **Decision path reconstruction** — every step in order
2. **Reasoning trace explanation** — natural-language summary
3. **Alternatives** — what the agent considered
4. **Decision scoring** — quality of each decision
5. **Agent trajectory analysis** (Phoenix parity) — patterns
   over the whole trajectory (loops, backtracks, dead ends)

## Source articles

* **Article 1 (biggest gap callout)**: "Decision Intelligence:
  Users still cannot understand why agents choose actions."
* **Article 2 (Galileo)**: Reasoning Coherence metric, Action
  Completion metric, Tool Selection Quality metric.
* **Article 3 (Phoenix)**: "Multi-step agent trajectory
  analysis."

## What's already in Eden

* `telemetry_events` table — every event has `trace_id`,
  `span_id`, `parent_span_id`, `event_type`, `payload` (which
  may include `reasoning`, `thought`, `action`, `tool_call`,
  `alternatives`).
* 3 Galileo judges (Cat 3): `ActionCompletionJudge`,
  `ToolSelectionQualityJudge`, `ReasoningCoherenceJudge`.
* `multi_agent/planning.py` — the multi-agent trajectory
  runner that produces `EpisodeResult.trajectory`.

## The 3 Galileo metrics, reused

The 3 Galileo judges from Cat 3 are reused as the per-decision
scoring engine:

| Judge | What it scores per decision |
|---|---|
| `ActionCompletionJudge` | Did the action advance the goal? |
| `ToolSelectionQualityJudge` | Was the chosen tool the best available? |
| `ReasoningCoherenceJudge` | Did the CoT justify the action? |

The `DecisionScorer` aggregates these into a per-decision score
and an overall trajectory score.

## Feature inventory (5 features)

| Feature | Class | File | Effort |
|---|---|---|---|
| Decision path reconstructor | `DecisionPathReconstructor` | `src/eden/decision/path_reconstructor.py` | M |
| Reasoning trace explainer | `ReasoningTraceExplainer` | same | L |
| Decision alternatives | `DecisionAlternatives` | same | S |
| Decision scorer | `DecisionScorer` | same | M |
| Agent trajectory analyzer | `AgentTrajectoryAnalyzer` | same | L |

## API contracts

All routes are co-located under the replay router at
`/orgs/{org_id}/intelligence/replay/{trace_id}/decision/...`,
gated by `intelligence_gap_v0` + `get_current_user`.

### Decision path

```
POST /orgs/{org_id}/intelligence/replay/{trace_id}/decision/path
  → {
    "data": {
      "steps": [
        {
          "step_index": 0,
          "timestamp": "2026-06-10T...",
          "event_type": "agent.action",
          "reasoning": "The user asked for X. I should do Y first.",
          "chosen_action": "tool_call: search('X')",
          "alternatives_considered": [
            "tool_call: web_search('X')",
            "tool_call: kb_search('X')"
          ]
        },
        {
          "step_index": 1,
          "timestamp": "2026-06-10T...",
          "event_type": "llm.completion",
          "reasoning": "The search returned Z. I should summarize.",
          "chosen_action": "summarize(Z)",
          "alternatives_considered": []
        }
      ]
    }
  }
```

### Reasoning explanation

```
GET  /orgs/{org_id}/intelligence/replay/{trace_id}/decision/explain
  → {
    "data": {
      "summary": "The agent took 3 steps. At step 1, it searched
                   the web for X, finding Z. At step 2, it
                   attempted to call the calculator but encountered
                   a tool error. At step 3, it tried the calculator
                   again with corrected syntax, succeeded, and
                   returned the final answer. The agent's
                   reasoning at step 2 was thin — it should have
                   validated the tool's input format before
                   calling.",
      "key_factors": [
        "Tool error recovery at step 2 → 3",
        "Web search returned relevant results at step 1"
      ],
      "alternative_considered": "kb_search would have been faster
                                 but the agent chose web_search
                                 because the question was
                                 time-sensitive."
    }
  }
```

### Alternatives

```
GET  /orgs/{org_id}/intelligence/replay/{trace_id}/decision/alternatives
  → {
    "data": {
      "alternatives": [
        {
          "step_index": 1,
          "action": "web_search('X')",
          "score": 0.85,
          "was_chosen": true
        },
        {
          "step_index": 1,
          "action": "kb_search('X')",
          "score": 0.42,
          "was_chosen": false
        }
      ]
    }
  }
```

### Decision score

```
GET  /orgs/{org_id}/intelligence/replay/{trace_id}/decision/score
  → {
    "data": {
      "overall_score": 0.78,
      "per_step_scores": [
        { "step_index": 0, "action_completion": 0.92, "tool_selection": 0.88, "reasoning_coherence": 0.95 },
        { "step_index": 1, "action_completion": 0.65, "tool_selection": null, "reasoning_coherence": 0.78 }
      ],
      "components": {
        "action_completion": 0.78,
        "tool_selection": 0.88,
        "reasoning_coherence": 0.86
      }
    }
  }
```

### Trajectory analysis

```
POST /orgs/{org_id}/intelligence/replay/{trace_id}/decision/trajectory
  → {
    "data": {
      "trajectory": [
        { "step_index": 0, "action": "...", "result": "..." },
        { "step_index": 1, "action": "...", "result": "..." }
      ],
      "analysis": {
        "patterns": [
          { "type": "loop", "steps": [2, 3, 4], "description": "Tool call retried 3 times with the same input" },
          { "type": "backtrack", "steps": [5, 6, 7], "description": "Agent reversed a previous decision" }
        ],
        "dead_ends": [8],
        "duration_ms": 12340,
        "step_count": 12
      }
    }
  }
```

## Data model (4 tables)

```sql
-- 1. Decision paths: one row per step in a trace
CREATE TABLE decision_paths (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    step_index      INTEGER NOT NULL,
    reasoning       TEXT,
    chosen_action   TEXT,
    path_json       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_decision_paths_trace
    ON decision_paths (org_id, trace_id, step_index);

-- 2. Decision alternatives: one row per considered alternative
CREATE TABLE decision_alternatives (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    step_index      INTEGER NOT NULL,
    considered      TEXT NOT NULL,
    chosen          BOOLEAN NOT NULL DEFAULT FALSE,
    score           DOUBLE PRECISION,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_decision_alternatives_trace
    ON decision_alternatives (org_id, trace_id, step_index);

-- 3. Decision scores: one row per trace
CREATE TABLE decision_scores (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    score           DOUBLE PRECISION,
    components_json TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Agent trajectories: one row per trace
CREATE TABLE agent_trajectories (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    trajectory_json TEXT NOT NULL,
    analysis_json   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Algorithm / pseudo-code

### Decision path reconstruction

```python
def reconstruct(org_id, trace_id):
    events = SELECT * FROM telemetry_events
              WHERE org_id = ? AND trace_id = ?
                AND event_type IN ('llm.call', 'tool.call',
                                   'agent.action', 'reasoning')
              ORDER BY timestamp, span_id
    steps = []
    for i, e in enumerate(events):
        steps.append({
            "step_index": i,
            "timestamp": e.timestamp.isoformat(),
            "event_type": e.event_type,
            "reasoning": (e.payload or {}).get("thought")
                         or (e.payload or {}).get("reasoning"),
            "chosen_action": (e.payload or {}).get("action")
                            or (e.payload or {}).get("tool_call"),
            "alternatives_considered": (e.payload or {}).get("alternatives", []),
        })
    return {"steps": steps}
```

### Reasoning trace explanation

```python
def explain(org_id, trace_id):
    steps = reconstruct(org_id, trace_id)["steps"]
    # Use an LLM-as-judge to summarize the multi-step reasoning
    prompt = EXPLANATION_PROMPT.format(
        steps=json.dumps(steps, indent=2)
    )
    response = llm_client.call(
        agent="decision_explainer",
        prompt=prompt, slot="fast", max_tokens=500,
    )
    return {
        "summary": response["summary"],
        "key_factors": response["key_factors"],
        "alternative_considered": response["alternative_considered"],
    }
```

### Decision scoring

```python
def score(org_id, trace_id):
    steps = reconstruct(org_id, trace_id)["steps"]
    per_step = []
    for step in steps:
        if step["event_type"] == "agent.action":
            ac = ActionCompletionJudge.score_step(step)
            ts = ToolSelectionQualityJudge.score_step(step) if step.get("tool_call") else None
            rc = ReasoningCoherenceJudge.score_step(step)
            per_step.append({
                "step_index": step["step_index"],
                "action_completion": ac,
                "tool_selection": ts,
                "reasoning_coherence": rc,
            })
    # Aggregate
    components = {
        "action_completion": mean(s["action_completion"] for s in per_step if s["action_completion"] is not None),
        "tool_selection": mean(s["tool_selection"] for s in per_step if s["tool_selection"] is not None),
        "reasoning_coherence": mean(s["reasoning_coherence"] for s in per_step if s["reasoning_coherence"] is not None),
    }
    overall = (components["action_completion"] + components["tool_selection"] + components["reasoning_coherence"]) / 3
    return {
        "overall_score": overall,
        "per_step_scores": per_step,
        "components": components,
    }
```

### Trajectory analysis

```python
def analyze(org_id, trace_id):
    events = SELECT * FROM telemetry_events
              WHERE org_id = ? AND trace_id = ?
              ORDER BY timestamp
    trajectory = [serialize_event(e) for e in events]

    # Detect patterns
    patterns = []
    # Loop detection: same action repeated ≥3 times in a row
    for i in range(len(events) - 2):
        if (events[i].payload.get("action") == events[i+1].payload.get("action")
            == events[i+2].payload.get("action")):
            patterns.append({
                "type": "loop",
                "steps": [i, i+1, i+2],
                "description": f"Action {events[i].payload.get('action')} repeated 3 times",
            })
    # Backtrack detection: a state seen before, then re-visited
    seen_states = set()
    for i, e in enumerate(events):
        state = serialize_state(e)
        if state in seen_states and i > 0:
            patterns.append({
                "type": "backtrack",
                "steps": [seen_states_first_index, i],
                "description": f"State revisited at step {i}",
            })
        seen_states.add(state)
    # Dead end detection: a step with error and no recovery
    dead_ends = [i for i, e in enumerate(events) if e.error and not _recovered(events, i)]

    return {
        "trajectory": trajectory,
        "analysis": {
            "patterns": patterns,
            "dead_ends": dead_ends,
            "duration_ms": sum(e.duration_ms for e in events),
            "step_count": len(events),
        }
    }
```

## Failure modes & guardrails

* **No reasoning in payload** — return an empty step list with
  `data.message: "no reasoning captured"`.
* **LLM call fails for explanation** — return the
  reconstructed path with `explanation: "explanation unavailable"`
  rather than failing the whole request.
* **Galileo judge unavailable** — return `data: { score: null,
  components: null, message: "judges unavailable" }`.
* **Trace too long (>10k steps)** — return only the first 1000
  steps with a `truncated: true` flag.

## Telemetry

* `intelligence_decision_path_reconstructed` (counter) — every
  successful reconstruction
* `intelligence_decision_explanation` (counter, tagged by
  `llm_status`) — success vs failure
* `intelligence_decision_score` (histogram) — overall_score
  distribution
* `intelligence_trajectory_pattern` (counter, tagged by
  `pattern_type`) — loop / backtrack / dead-end counts

## Test plan

* **Unit tests** (per service): 1-2 per public method, ~15 total
* **Integration tests**: synthetic traces with known
  decisions, verify reconstruction is correct
* **Reconstruction correctness**: 10 known traces → 100% step
  count match
* **Explanation quality**: hand-labelled explanations compared
  to LLM explanations (qualitative)
* **Score sanity**: scores in [0, 1] on a 100-event synthetic set

## Acceptance criteria

- [ ] Path reconstruction includes every agent step in order.
- [ ] Explainer summary is <500 words and references ≥ 1
  specific step.
- [ ] Decision score is computed by the 3 Galileo judges and
  aggregated.
- [ ] Trajectory analysis identifies at least one pattern
  (loop, backtrack, dead-end) on a synthetic test set.
- [ ] Decisions on a correct trajectory score > 0.8 on
  average.
- [ ] Decisions on a broken trajectory score < 0.4 on
  average.

## Implementation order

1. **Decision path reconstructor** — first; everything else
   depends on the reconstructed path.
2. **Decision alternatives** — small, isolated.
3. **Decision scorer** — depends on the path and the
   alternatives, reuses the 3 Galileo judges.
4. **Reasoning trace explainer** — depends on the path; uses
   an LLM call.
5. **Agent trajectory analyzer** — depends on the path; runs
   last because it has the most complex pattern detection.

## Open questions

* **State serialization** — what's the canonical "state" for
  backtrack detection? The full agent state, or just the
  last action's result? (Owner: Cat 16 lead)
* **LLM model for explanation** — same `model_slot = "fast"`
  used by judges, or a larger model? (Owner: Cat 16 lead)
* **Explanation streaming** — should the explanation be
  streamed via SSE for long traces? (Owner: Cat 16 lead)
* **Decision vs Agent overlap** — do we have two different
  "decision path" concepts? (No, per the master doc; Cat 6
  Agent Intel is per-agent aggregates, Cat 16 is per-decision
  per-call.)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](../eden-observability-gap-roadmap.md)
* Stub envelope: [`src/eden/intelligence_envelope.py`](../../src/eden/intelligence_envelope.py)
* Cat 3 (Eval Quality — provides the 3 Galileo judges):
  [`03-evaluation-quality-intelligence.md`](./03-evaluation-quality-intelligence.md)
* Cat 1 (Trace Replay — provides the trace tree):
  [`01-trace-replay.md`](./01-trace-replay.md)
* Multi-agent trajectory: [`src/eden/multi_agent/planning.py`](../../src/eden/multi_agent/planning.py)
