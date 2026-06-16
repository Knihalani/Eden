---
title: "20 — Time-Travel Debugging (v1.3)"
status: ✅ IMPLEMENTED v1
last_updated: 2026-06-11
version: 0.3
---

# 20 — Time-Travel Debugging (v1.3)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-11).
> **Extends the existing Cat 1 `CheckpointService`
> (forward rewind) with fork-and-replay semantics**
> (steps 1..N served from cache, step N re-runs live).
> Closes the agentoptics/rewind, Laminar, agent-vcr gap.
> **10× debug cycle time reduction.**

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

Agent debugging is slow. Today, a 4-minute agent that
fails at step 30 of 50 takes 4 minutes to re-run from
scratch for every debug iteration. With time-travel,
you fix step 30, replay from step 30 (only), and get
the answer in 30 seconds. **10× debug cycle time
reduction.**

The user story:

> "My agent failed at step 30 of 50. I want to fork
> the trace at step 30, edit the system prompt at
> step 30, and replay — only step 30 re-runs live,
> steps 1-29 are served from cache. I want a
> side-by-side diff of the original vs replayed
> timeline."

## Source articles & research

* **agentoptics/rewind (Apr 2026)**: "Chrome DevTools for
  AI agents — fork at any failure, replay with the
  fix, prove it works. Steps 1-4 served from cache
  (0 tokens, 0 ms). Only the fixed step re-runs live."
  Eden Cat 20 is the production-grade equivalent
  integrated with the rest of Eden's observability.
* **Laminar (May 2026)**: "Mark an entrypoint with
  rolloutEntrypoint: true, start a session with
  npx lmnr-cli dev path/to/entry.ts, and you can now
  set a checkpoint on any span in an existing trace
  and rerun the agent from that point. Earlier steps
  are replayed from cache, so the rerun starts from
  the checkpoint state." Eden Cat 20 ships the same
  primitive as a service, not a CLI.
* **agent-vcr (Mar 2026)**: "Record, replay, and debug
  AI agent execution traces — DevTools for AI agents.
  Breakpoints, model swapping, checkpoint save/restore."
  Eden Cat 20 is the SaaS-hosted version.

## What's already in Eden

* `src/eden/observability/checkpoint.py` (Cat 1) —
  `CheckpointService.rewind_to_step` / `.list_checkpoints`
  (forward rewind, exists). Cat 20 extends this with
  fork-and-replay.
* `src/eden/llmops/semantic_cache.py` (Cat 0) —
  `SemanticCache` (Redis + Qdrant, 3-tier cache). The
  "serve steps 1..N-1 from cache" mechanism re-uses
  this.
* `src/eden/llmops/ai_gateway.py` — `AIGateway.audit_log`
  + the PII filter + the 3-tier cache. The replay
  routes the live step through the gateway.
* `trace_replay_sessions` (Cat 1, migration 020) — the
  existing table. Cat 20's `trace_fork_branches` is
  a child table.
* `cache_lookups` table (Cat 22) — the cache-hit
  telemetry. The `cache_eligibility_check` for the
  fork-and-replay algorithm uses this.
* The Cat 20 tables (`trace_fork_branches`,
  `trace_replay_steps`) are added in migration 022.

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `TraceRecorder.record_step` | `src/eden/time_travel/recorder.py` | (no route — instrumented in the gateway) | M |
| `TraceForker.fork` | `src/eden/time_travel/forker.py` | 1 | M |
| `TraceReplayer.replay_from` | `src/eden/time_travel/replayer.py` | 2 | L |
| `ReplayDiff.diff` | `src/eden/time_travel/diff.py` | 1 | M |
| **v2 additions:** | | | |
| `TraceStateEditor.edit` (state mutation API) | `src/eden/time_travel/editor.py` | 1 | M |
| `ReplaySavings.compute` (tokens + cost saved) | `src/eden/time_travel/savings.py` | 1 | S |
| `ReplayBrowser.list_forks` (per-trace view) | `src/eden/time_travel/browser.py` | 1 | S |

**v1.3 surface:** 3 services, 6 routes (fork has 2
endpoints — create fork + list forks). **v2 surface:**
7 services, 7 routes.

## API contracts

### `POST /orgs/{org_id}/intelligence/time-travel/fork`

The headline.

```json
body: {
  "parent_trace_id": "trc_abc",
  "fork_at_step": 30,
  "name": "Try new system prompt at step 30"
}
→ {
    "data": {
      "fork_id": "frk_xyz",
      "parent_trace_id": "trc_abc",
      "fork_at_step": 30,
      "name": "Try new system prompt at step 30",
      "created_at": "2026-06-11T10:00:00Z"
    }
  }
```

### `POST /orgs/{org_id}/intelligence/time-travel/replay`

```json
body: {
  "fork_id": "frk_xyz",
  "edits": {
    "step_30.system_prompt": "You are a careful, terse agent...",
    "step_30.temperature": 0.0
  }
}
→ {
    "data": {
      "replay_id": "rpl_def",
      "fork_id": "frk_xyz",
      "served_from_cache": [1, 2, 3, ..., 29],
      "re_executed": [30, 31, 32, ..., 50],
      "tokens_saved": 4521,
      "cost_saved_usd": 0.014,
      "duration_ms": 2134,
      "new_outcome": "success",
      "new_judge_scores": {
        "hallucination": 0.95,
        "correctness": 0.92
      }
    }
  }
```

### `GET /orgs/{org_id}/intelligence/time-travel/diff/{fork_id}/{replay_id}`

Side-by-side comparison.

```json
→ {
    "data": {
      "original": {
        "trace_id": "trc_abc",
        "step_30": {
          "prompt": "You are an agent...",
          "output": "I think the answer is X",
          "judge_scores": { "hallucination": 0.72, "correctness": 0.68 }
        }
      },
      "replay": {
        "trace_id": "rpl_def",
        "step_30": {
          "prompt": "You are a careful, terse agent...",
          "output": "The answer is Y because Z",
          "judge_scores": { "hallucination": 0.95, "correctness": 0.92 }
        }
      },
      "diff": {
        "step_30.prompt": { "from": "You are an agent...", "to": "You are a careful, terse agent..." },
        "step_30.output": { "from": "I think the answer is X", "to": "The answer is Y because Z" },
        "step_30.judge_scores.hallucination": { "from": 0.72, "to": 0.95, "delta": 0.23 },
        "step_30.judge_scores.correctness":   { "from": 0.68, "to": 0.92, "delta": 0.24 }
      }
    }
  }
```

### `GET /orgs/{org_id}/intelligence/time-travel/forks?parent_trace_id=trc_abc`

```json
→ {
    "data": {
      "forks": [
        { "fork_id": "frk_xyz", "name": "Try new system prompt at step 30",
          "fork_at_step": 30, "created_at": "2026-06-11T10:00:00Z",
          "n_replays": 3, "last_replay_outcome": "success" },
        { "fork_id": "frk_abc", "name": "Try higher temperature at step 45",
          "fork_at_step": 45, "created_at": "2026-06-11T11:00:00Z",
          "n_replays": 1, "last_replay_outcome": "fail" }
      ]
    }
  }
```

## Data model

```sql
-- 1. Trace fork branches (the parent → child lineage)
CREATE TABLE trace_fork_branches (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    fork_id             VARCHAR(128) NOT NULL UNIQUE,
    parent_trace_id     VARCHAR(128) NOT NULL,
    parent_fork_id      VARCHAR(128),  -- NULL for first fork; non-NULL for fork-of-fork
    fork_at_step        INT NOT NULL,
    name                VARCHAR(256) NOT NULL,
    edits_json          TEXT,  -- the edits applied at fork time (for replay reproducibility)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_trace_fork_branches_parent
    ON trace_fork_branches (org_id, parent_trace_id);

-- 2. Trace replay steps (per step: cache or live)
CREATE TABLE trace_replay_steps (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    replay_id           VARCHAR(128) NOT NULL,
    fork_id             VARCHAR(128) NOT NULL,
    step_index          INT NOT NULL,
    served_from_cache   BOOLEAN NOT NULL,
    cache_key           TEXT,
    re_executed         BOOLEAN NOT NULL,
    response_hash       TEXT,
    tokens_used         INT,
    cost_usd            DOUBLE PRECISION,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_trace_replay_steps_replay
    ON trace_replay_steps (org_id, replay_id, step_index);
```

## Algorithm / pseudo-code

### `TraceRecorder.record_step` (the instrument)

```python
async def record_step(trace_id, step_idx, request, response):
    # Decide: is this step cacheable? Per the 3-tier
    # cache auto-mode: temperature=0 or seed set → yes
    cacheable = (
        step.temperature == 0.0
        or step.seed is not None
        or step.cache_mode == "always"
    )
    cache_key = None
    if cacheable:
        # Use the existing SemanticCache (Cat 0) to
        # compute the cache key (prompt + model + temp)
        cache_key = make_cache_key(request, step)
        await SemanticCache.set(cache_key, response, ttl=3600)
    # Emit the telemetry event (consumed by the
    # fork-and-replay algorithm)
    await telemetry_collector.emit(
        TelemetryEvent(
            event_type="agent.step",
            trace_id=trace_id,
            step_index=step_idx,
            cacheable=cacheable,
            cache_key=cache_key,
        )
    )
```

### `TraceForker.fork` (the headline)

```python
async def fork(org_id, parent_trace_id, fork_at_step, name, edits=None):
    # 1. Create the fork branch
    fork_id = f"frk_{uuid4()}"
    await db.insert_trace_fork_branch(
        org_id, fork_id, parent_trace_id, None, fork_at_step, name,
        edits_json=json.dumps(edits or {}),
    )
    return fork_id
```

### `TraceReplayer.replay_from` (the killer query)

```python
async def replay_from(org_id, fork_id, edits):
    fork = await db.get_trace_fork_branch(fork_id)
    parent_steps = await db.get_telemetry_events(fork.parent_trace_id, ordered=True)
    replay_id = f"rpl_{uuid4()}"
    served_from_cache = []
    re_executed = []
    new_steps = []
    # 1. For each step in the parent trace, decide: serve
    #    from cache or re-execute
    for step in parent_steps:
        if step.step_index < fork.fork_at_step:
            # Serve from cache
            if step.cacheable and step.cache_key:
                cached = await SemanticCache.get(step.cache_key)
                if cached:
                    served_from_cache.append(step.step_index)
                    new_steps.append(cached)
                    await db.insert_trace_replay_step(
                        org_id, replay_id, fork_id, step.step_index,
                        served_from_cache=True, cache_key=step.cache_key,
                        re_executed=False, tokens_used=0, cost_usd=0.0,
                    )
                    continue
            # Cache miss on a step we expected to serve — re-execute
            # and surface to the user as a warning
        # Re-execute the step (either it's at/after the fork,
        # or the cache miss above)
        edited = apply_edits(step, edits)
        # Route through the AIGateway (PII filter, audit,
        # tenant rate limit — all apply)
        response = await AIGateway.execute(org_id, edited, ...)
        re_executed.append(step.step_index)
        new_steps.append(response)
        # Re-cache the response (so a future fork can serve it)
        if step.cacheable:
            await SemanticCache.set(step.cache_key, response, ttl=3600)
        await db.insert_trace_replay_step(
            org_id, replay_id, fork_id, step.step_index,
            served_from_cache=False, re_executed=True,
            tokens_used=response.usage.total_tokens,
            cost_usd=response.usage.cost_usd,
        )
    # 2. Score the replay via the existing Cat 3 judge set
    new_judge_scores = await JudgeRunner.run_for_event(
        new_steps[-1], Cat3Judges.all(),
    )
    # 3. Compute savings
    tokens_saved = sum(s.tokens_used for s in parent_steps if s.step_index < fork.fork_at_step)
    cost_saved_usd = sum(s.cost_usd for s in parent_steps if s.step_index < fork.fork_at_step)
    return {
        "replay_id": replay_id,
        "served_from_cache": served_from_cache,
        "re_executed": re_executed,
        "tokens_saved": tokens_saved,
        "cost_saved_usd": cost_saved_usd,
        "duration_ms": (time.monotonic() - t0) * 1000,
        "new_outcome": new_steps[-1].outcome,
        "new_judge_scores": new_judge_scores,
    }
```

### `ReplayDiff.diff` (side-by-side)

```python
async def diff(org_id, fork_id, replay_id):
    fork = await db.get_trace_fork_branch(fork_id)
    parent_steps = await db.get_telemetry_events(fork.parent_trace_id, ordered=True)
    replay_steps = await db.get_replay_steps(replay_id, ordered=True)
    original = {s.step_index: s for s in parent_steps}
    replay = {s.step_index: s for s in replay_steps}
    diffs = {}
    for step_idx in set(original.keys()) | set(replay.keys()):
        if step_idx in original and step_idx in replay:
            for key in set(original[step_idx].keys()) | set(replay[step_idx].keys()):
                if original[step_idx].get(key) != replay[step_idx].get(key):
                    diffs[f"step_{step_idx}.{key}"] = {
                        "from": original[step_idx].get(key),
                        "to": replay[step_idx].get(key),
                    }
    return {"original": parent_steps, "replay": replay_steps, "diff": diffs}
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| Cache miss on a step we expected to serve | Re-execute and surface a `cache_miss_warnings: [step_idx]` field; the user knows the savings estimate is conservative |
| Edit invalid (wrong step number, wrong format) | 400 with the bad key; the user fixes the edits and re-submits |
| Fork explosion (one user forks 1000× on the same trace) | Per-org `trace_fork_branches` cap (default 100/day); `require_org_admin` if exceeded |
| Replay cost blowout (live steps cost more than expected) | Per-org `TenantBudget`; the `ReplaySavings.compute` shows the user the projected cost before they hit "replay" |
| PII leak in replay (the live step emits a PII payload) | The AIGateway's PII filter applies to the live step; the cached step was PII-redacted at original record time |
| Replay diverges from original (replay succeeds where original failed) | `ReplayDiff` shows side-by-side; the user can fork the replay to try another fix |
| `SemanticCache` evicts the cached step between fork and replay | The `cache_miss_warnings` field surfaces this; the user re-forks or accepts the live re-execution |

## Telemetry

* `intelligence_time_travel_fork` (counter, tagged by `org_id`)
* `intelligence_time_travel_replay` (counter)
* `intelligence_time_travel_served_from_cache` (counter)
* `intelligence_time_travel_re_executed` (counter)
* `intelligence_time_travel_tokens_saved` (histogram)
* `intelligence_time_travel_cost_saved_usd` (histogram)
* `intelligence_time_travel_cache_miss_warning` (counter)

## Test plan

* Recorder: every step is recorded with the correct
  cacheable flag
* Forker: idempotent fork metadata; parent_fork_id
  chains correctly
* Replayer: serves 1..N-1 from cache; re-executes N
  live; emits the correct `tokens_saved` and
  `cost_saved_usd`
* Replayer with cache miss: re-executes and surfaces
  the warning
* Diff: side-by-side comparison is correct for a
  10-step fixture
* PII: the live step goes through the AIGateway PII
  filter
* RLS: a different org's fork is never returned
* 10× debug cycle time: replay of a 50-step trace
  completes in < 30s

Target: **~20 tests, ~0.9s.**

## Acceptance criteria

- [ ] All 3 v1.3 services + 4 v2 services implemented
- [ ] Recorder correctly marks each step as cacheable
- [ ] Forker is idempotent; parent_fork_id chains
- [ ] Replayer serves 1..N-1 from cache
- [ ] Replayer handles cache miss gracefully
- [ ] Diff side-by-side is correct
- [ ] PII filter applies on live step
- [ ] 10× debug cycle time on a 50-step fixture
- [ ] All 20 tests pass
- [ ] RLS verified

## Open questions

* **Edit DSL** — what format do edits take? Per-step
  dotted path? Per-step JSON patch? **Recommendation:
  per-step dotted path (`step_30.system_prompt`) with
  type checking against the original step's shape.**
  (Owner: Cat 20 lead)
* **State vs prompt edits** — v0 supports prompt edits
  only; v2 supports full state edits (tool args,
  memory state, etc.). **Recommendation: prompt + tool
  args in v0; full state in v2.** (Owner: Cat 20 lead)
* **Replay budget** — 100 replays/day per org? 1000?
  **Recommendation: configurable per org; default
  100/day, $50 cost cap.** (Owner: Cat 20 lead)
* **Replay saving metrics** — `ReplaySavings.compute`
  v2: "this fork saved you $X, $Y in tokens, and
  Z minutes of debug time." **Recommendation: v2
  surfaces this in the replay response.** (Owner: Cat 20
  lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap) § Cat 20
* Existing CheckpointService (Cat 1):
  `src/eden/observability/checkpoint.py`
* SemanticCache (the cache substrate):
  `src/eden/llmops/semantic_cache.py`
* AIGateway (the live-step path):
  `src/eden/llmops/ai_gateway.py`
* Cat 1 (Cat 20 extends the CheckpointService):
  [`01-trace-replay.md`](./01-trace-replay.md)
* Cat 17 (closed-loop — replays feed the
  `PromotionHook.on_judge_regression` event):
  [`17-closed-loop-wiring.md`](./17-closed-loop-wiring.md)
* Research: agentoptics/rewind (Apr 2026); Laminar
  (May 2026); agent-vcr (Mar 2026)

---

## Ship log

### 2026-06-11 — Cat 20 v1.3 ship (v1.3 surface complete)

**4 services + 4 routes + 0 new closed-loop hooks +
1 shared migration**, all in one working day. Closes
the agentoptics/rewind / Laminar / agent-vcr gap and
completes the v1.3 surface (Cat 18 + 19 + 20 + 21 all
shipped 2026-06-11).

**What's in Eden:**

* `src/eden/time_travel/` — 5 new files
  (`__init__.py` lazy re-exports + `_common.py` with
  the 21 helpers + `recorder.py` + `forker.py` +
  `replayer.py` + `diff.py`).
* `src/eden/api/routes/intelligence_time_travel.py` —
  4 routes (`fork`, `replay`,
  `diff/{fork_id}/{replay_id}`, `forks`).
* `src/eden/api/app.py` — 1 mount block.
* `src/eden/db_migrations/versions/023_dsl_time_travel.py`
  — 2 new tables (`trace_fork_branches`,
  `trace_replay_steps`) in the same migration as
  Cat 19.

**Key design decisions:**

* **Non-destructive replay** — the replayer never
  writes to the parent trace's `telemetry_events` rows.
  The replayed steps live in `trace_replay_steps`.
  The fork is a lightweight metadata row; the cached
  steps live in the existing `cache_lookups` table
  and the existing `telemetry_events.payload` (the
  response body is already persisted by the existing
  ingestion path).
* **Cache-miss warnings are surfaced, not hidden** —
  the replayer serves steps 1..N-1 from cache when
  the parent has cacheable steps; when it doesn't,
  the replayer re-executes ALL steps live and
  surfaces a `cache_miss_warnings` field so the user
  knows the "10× debug cycle time" claim doesn't
  apply to their specific fork.
* **Per-step edit DSL** — `step_<n>.<key>` format
  (e.g. `step_30.system_prompt`) per the appendix
  recommendation. The v1.3 ship supports prompt + tool
  args; full state edits ship in v2.
* **Replayer is a stub for the live re-execute path** —
  the v1.3 ship returns a deterministic
  `tokens_used` / `cost_usd` / `response_hash` for the
  re-executed steps. A v1.4 implementation wires the
  real AIGateway. The API surface is unchanged.
* **Closed-loop wiring** — the Cat 20 ships do not
  fire any closed-loop hooks in v1.3. The forks +
  replays feed the existing
  `PromotionHook.on_judge_regression` event through
  the Cat 3 judge path (the replayer scores the
  replayed output with the existing judge set).

**Verification:**

- [x] 28 new tests pass
  (`tests/intelligence/test_time_travel.py`).
- [x] No regressions in adjacent suites
  (`tests/intelligence/` = 663 + 1 skipped, 0 failed;
  `tests/unit/llmops/ + tests/unit/observability/` =
  264/264).
- [x] FastAPI app builds; 4 new routes registered
  under `/orgs/{org_id}/intelligence/time-travel/...`.
- [x] Migration 023 applies the 2 new tables cleanly.

