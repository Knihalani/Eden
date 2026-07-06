# Trace Evaluation Wiring — How the 11 Phases Connect to Production

This document captures the full path from a real LLM call to a persisted
quality report, and the contracts that every link in the chain must
honour.

## End-to-end path

```
┌──────────────────────────────────────────────────────────────────┐
│  Real LLM call                                                  │
│  (openai SDK, anthropic SDK, …)                                 │
└────────────────────────────┬─────────────────────────────────────┘
                             │ TelemetryEvent
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  eden.observability.telemetry_collector (Phase 1)               │
│  - event_type: span.start / llm.completion / tool.call / …       │
│  - archetype_id stamped on every event.attributes                │
└────────────────────────────┬─────────────────────────────────────┘
                             │ Postgres insert
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  eden.observability.quality_pipeline.worker                      │
│  src/eden/observability/quality_pipeline/worker.py              │
│  - compute_trace_reports(tenant_id, trace_id, events,           │
│                           archetype_id=None)                     │
│  - Runs 5 steps concurrently via asyncio.gather:                │
│      1. compute_tas       → supplementaries.phase_2_efficiency  │
│      2. check_combined    → supplementaries.phase_3_loops       │
│      3. HallucinationPipeline.score() (per LLM)                 │
│                            → supplementaries.phase_5_quality     │
│      4. score_with_composite → supplementaries.phase_9_reasoning │
│      5. run_all_detectors  → supplementaries.phase_7_detection  │
│  - Converts dataclass results → dict payloads for persistence.  │
└────────────────────────────┬─────────────────────────────────────┘
                             │ dict payloads
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  eden.observability.quality_pipeline.persist_reports            │
│  - INSERTs one row per step into trace_*_reports tables.         │
│  - Schema fields (trace_efficiency_reports.tas, .intervention,  │
│    .fix_patches, .metrics, …) match the dict payload contract.   │
└──────────────────────────────────────────────────────────────────┘
```

## Contracts between layers

### 1. Supplementaries → Worker (dataclass → dict)

Every supplementary module returns a **frozen dataclass**:

| Module | Function | Return type |
|---|---|---|
| `phase_2_efficiency.composite` | `compute_tas(events, archetype_id)` | `TASResult` |
| `phase_3_loops.combined_loop_detector` | `check_combined(events)` | `CombinedLoopReport` |
| `phase_5_quality.pipeline` | `HallucinationPipeline.score(premise, hypothesis)` | `QualityReport` |
| `phase_9_reasoning.scorer` | `score_with_composite(steps, user_prompt)` | `ReasoningScore` |
| `phase_7_detection.detectors` | `run_all_detectors(events)` | `DetectionReport` |

The worker **must not** call `.get()` on these — it accesses fields
directly and converts to dict via a literal mapping.

### 2. Worker → Persistence (dict → Postgres)

The persistence layer in `worker.py` calls `payload.get(...)` on the
worker's dict output. Therefore every step function in the worker
must return a dict whose keys match the persistence SQL exactly.
The mapping is documented in `_upsert_report()`:

```python
# trace_efficiency_reports (TAS)
payload.get("tas"), payload.get("avs"), payload.get("vae"),
payload.get("grade"), payload.get("intervention"),
payload.get("fix_patches"), payload.get("metrics")

# trace_loop_reports (loop)
payload.get("verdict"), payload.get("detectors_tripped"),
payload.get("severity"), payload.get("action"),
payload.get("max_cosine"), payload.get("max_jaccard"),
payload.get("step_index")
```

### 3. Test → Worker (event dict → TelemetryEvent)

The worker accepts `events: list[dict[str, Any]]`. Internally it
calls `_coerce_to_telemetry_events(events)` which validates each dict
via `TelemetryEvent.from_dict(...)` and falls back to a permissive
wrapper for malformed events (so a single bad event doesn't 500
the whole compute).

### 4. Dataset → Worker (synthetic traces)

The 30 synthetic traces under `tests/fixtures/traces/synthetic/`
stamp `archetype_id` on every event's `attributes`. The worker
reads it from the first event and forwards it to `compute_tas`,
which uses it to look up the per-archetype Task Value Score (TVS)
and pick the right intervention.

The `tests/integration/test_synthetic_dataset_worker_accuracy.py`
test verifies the worker produces TAS within ±5 and the exact
intervention for every synthetic trace — re-baseline the ground
truth whenever the composite formula changes.

## Online-by-default network behaviour

The worker imports `supplementaries._hf_cache_patch` at module load,
which installs a monkey-patch on `huggingface_hub.hf_hub_download`:

- If the requested file is already in the local cache → return the
  cached path. **No network.**
- If the cache has no information → fall through to upstream
  online behaviour.

Other code paths that genuinely need the network (live API calls,
fresh model downloads) are unaffected.

## Determinism guarantees

- `compute_tas` is pure-Python — no network, no model load.
- `check_combined` lazily loads the sentence-transformer model on
  first call. Subsequent calls are deterministic.
- The HuggingFace cache patch eliminates the only known source
  of non-determinism (a flaky network probe during model load).
- All 600 supplementaries tests run in ~23 seconds on a warm cache.

## How to verify

```bash
# 1. All supplementaries tests pass
.venv/bin/pytest supplementaries/ -q
# → 600 passed, 0 failed in ~23s

# 2. End-to-end worker accuracy on the synthetic dataset
.venv/bin/pytest tests/integration/test_synthetic_dataset_worker_accuracy.py -v
# → 32 passed (30 per-trace accuracy + 2 dataset integrity)

# 3. Existing trace-quality tests
.venv/bin/pytest tests/e2e/test_trace_quality_e2e.py tests/api/test_sidecar_failure_modes.py -v
# → 10 passed
```
