# Wave 8 — Finalized-trace pipeline: one fetch, real classifier input, batched writes

**Status:** Complete this session. Measured before → after, all validation green.

## Theme

Waves 6–7 attacked the **read** side (materialize, cache, never re-scan). Wave 8
attacks the **always-on detection pipeline** — `trace.finalized` runs once per
trace, for every trace — where the same class of waste lived, plus a genuine
correctness bug in the F34 classifier gate. Three fixes, three categories:

| # | Category | What | Measured |
|---|---|---|---|
| A | **speed** | Single-fetch trace pipeline | up-to-3 full event scans/trace → **1** |
| B | **correctness/cost** | F34 gate now sees the trace | features: hash of empty list → hash of real events |
| C | **cost** | Batched prediction writes | up-to-50 INSERTs/trace → **1** executemany |

---

## A — Single-fetch trace pipeline (speed)

### The measured problem

`TraceFinalizedConsumer._process_trace` runs for every finalized trace and
fetched the FULL event set (wide columns incl. `payload`, `attributes`,
`tags`, `tool_calls_full`, `tool_results`, `request_body`, `response_body` —
up to `TRACE_EVENTS_LIMIT` = 2000 rows) **up to three separate times**:

1. `_run_layer_a` → `_fetch_trace_events`
2. `AutoIssueScanner._fetch_events` → `_fetch_trace_events` (the `events=`
   kwarg existed but the consumer never passed it)
3. `signal_investigator.investigate_trace(events=None)` → `_fetch_trace_events`

### What changed

- `_process_trace` now calls `_fetch_pipeline_events(org_id, trace_id)` **once**
  and threads the same list through `_run_layer_a(events=…)`,
  `_scanner.scan(events=…)`, `_run_signal_classifiers(events=…)` and
  `_run_signal_investigator(events=…)`.
- `_run_layer_a` accepts `events=` (falls back to its own fetch when None,
  keeping the public contract intact for any other caller).
- `_fetch_pipeline_events` is best-effort: a fetch failure degrades to `[]`
  and the whole pipeline skips (pre-fix, a blip between two fetches could let
  a later stage succeed while an earlier one saw empty — all-or-nothing is
  the documented trade, identical when the DB is fully down).
- Retry contract preserved: retries re-run `_process_trace` → fresh fetch;
  the transient-retry ladder only ever triggered on downstream write
  failures, which still propagate.

### Measured

`uv run python -m bench.trace_pipeline_fetches`: **`_fetch_trace_events` calls
per `_process_trace`: 1** (pre-fix: up to 3 full wide-column scans).

---

## B — F34 classifier gate now sees the trace (correctness/cost)

### The bug

`run_classifiers_before_investigator(org_id, trace_id)` was invoked with **no
events** — the consumer's `_run_signal_classifiers` never passed them. So
`_extract_features([], trace_id)` hashed `json.dumps({"trace_id": …,
"events": []})` — the trained logistic models decided whether to skip the F06
investigator (the F34 cost-savings gate) on a feature vector that contained
**zero trace content**.

### What changed

- `_run_signal_classifiers(org_id, trace_id, events=…)` threads the pipeline
  events into `run_classifiers_before_investigator(…, events=events)`.
- Feature vectors now hash the trace's actual first-40 events; two traces
  with different content produce different vectors (pinned by test).
- Residual training/serving skew documented: training hashes
  `signal_events.payload` (detection metadata), inference hashes trace
  events — the model is still OOD at inference, but far closer than the
  empty-list hash, and the gate is shadow-mode by default. Aligning both
  extractors is a flagged follow-up, not silently claimed as fixed.

### Measured

New test `test_f34_classifier_receives_real_events` asserts
`_extract_features([], tid) != _extract_features(events, tid)` and that the
gate's inference features equal the real-event features.

---

## C — Batch classifier prediction persistence (cost)

### The measured problem

`run_classifiers_before_investigator` persisted predictions with
`_persist_prediction` — **one `pg.execute` INSERT per classifier per trace**.
An org can hold up to 50 active classifiers (`_load_active_classifiers …
LIMIT 50`), so a single finalized trace could drive **up to 50 sequential
INSERT round-trips** on the always-on detection path.

### What changed

- `_persist_predictions(org_id, trace_id, recs)` writes the whole per-trace
  prediction set with **one `executemany`**; empty sets are a no-op.
- Row layout identical to the old per-row insert; asyncpg `executemany`
  executes the statement per parameter set — row-for-row equivalent.
- Per-skip `_record_savings_cost_event` stays in-loop (skips are rare).

### Measured

`bench.trace_pipeline_fetches`: **`classifier_predictions` INSERT
round-trips: 1** (pre-fix: up-to-50 per-classifier INSERTs). Pinned by
`test_persist_predictions_uses_one_executemany` (12 recs → one executemany,
zero per-row `execute`).

---

## Reviewer feedback (all addressed)

1. **Bench didn't exercise the batch path** (fake DB returned no
   classifiers) → seeded a classifier row + forced the F34 gate on; the
   INSERT count now actually measures the batch.
2. **"3 fetches" overstated** → corrected to "up to 3" (the investigator
   leg is skipped when Layer A has a primary hit).
3. **F34 training/serving skew not resolved** → documented honestly in
   `classifier_worker.py` instead of overclaiming.
4. **Degradation semantics** → code comment now states a fetch failure
   blanks the whole pipeline (all-or-nothing) vs pre-fix per-stage retries.
5. Retry contract, executemany equivalence, and tenant isolation confirmed.

---

## Validation

- **2270 tests pass** (workers + signals + issues + observability + api).
- New `tests/unit/workers/test_wave8_pipeline_single_fetch.py` (4 tests):
  single-fetch count + same-list threading, F34 real-events, one
  executemany, empty no-op.
- ruff clean on all changed files; mypy clean (0 new).
- Benchmark reproducible: `uv run python -m bench.trace_pipeline_fetches`
  (faked DB; no external services).

## Files touched

- `src/eden/workers/trace_finalized_consumer.py` (single-fetch + threading)
- `src/eden/signals/classifier_worker.py` (events threading + batched
  persistence + skew note)
- `tests/unit/workers/test_wave8_pipeline_single_fetch.py` (new)
- `bench/trace_pipeline_fetches.py` (new, reproducible)
- `docs/MASTER-PLAN-2026-08-10.md` (Wave 8 section)

---

# Wave 8.1 follow-up — thread the fetch into the annotator + prod-eval sampler

**Status:** Complete this session. Requested follow-up to Wave 8.

## What was still re-fetching

Wave 8 made `_process_trace` fetch the trace's events **once**, but two
stages could still re-scan `telemetry_events` when Layer A returned `None`:

1. **`_run_annotator`** — when `layer_a_report` was `None` (Layer A
   exception) or carried no `_events`, the annotator ran its own
   `_fetch_trace_events` before the (one paid) LLM call.
2. **`ProductionEvalSampler`** — on the sampled path, the online rules
   engine's `_load_span_content` issued its own `telemetry_events` read
   (latest-row `ORDER BY timestamp DESC LIMIT 1`) to build the judge
   payload, even though the pipeline had the full event list in memory.

## Fixes

| # | Where | What |
|---|---|---|
| A | `_run_annotator` | Gained an `events` kwarg threaded from
  `_process_trace`. `events is None` (not falsy) now gates the DB
  fallback — a threaded-but-empty list is authoritative, so the Layer A
  `None` path never re-scans. `layer_a_report._events` stays as the
  fallback for direct callers. |
| B | `ProductionEvalSampler` | `maybe_score_trace` / `_score_trace`
  gained `events` and forward it to `apply_rules_for_trace`. |
| C | `rules_engine` | New `_load_content` / `_content_from_events`
  derive judge content from the **last event** (mirrors
  `ORDER BY timestamp DESC LIMIT 1` on ASC-ordered events) — zero DB
  reads on the sampled path. Falls back to `_load_span_content` only
  when needed: no events passed, span-scoped targeting, NULL plaintext
  blobs (zstd-only storage), or the list hit the 2000-row fetch cap
  (`events[-1]` would not be the true newest). |

## Reviewer hardenings (all applied)

1. **`TRACE_EVENTS_LIMIT` truncation guard** — a 2000-row list is almost
   certainly truncated, so `events[-1]` is the *cap-th* oldest, not the
   newest; `_load_content` falls back to the DB read at the cap.
2. **Annotator's lost second-chance fetch documented** — the threaded
   empty list means a transient fetch blip now blanks the annotator too
   (all-or-nothing, consistent with Wave 8); noted in
   `_fetch_pipeline_events`' docstring.

## Validation

- **2601 tests pass** (workers + evaluation + signals + issues +
  observability + api) — incl. 6 new tests: annotator uses threaded
  events / empty-list no-refetch, rules-engine content-from-events,
  zstd fallback, 2000-cap truncation guard, sampler events threading.
- ruff clean; mypy clean on all 3 source files.
- Bench unchanged: `uv run python -m bench.trace_pipeline_fetches` still
  reports **1 fetch + 1 executemany** per trace.

## Files touched (8.1)

- `src/eden/workers/trace_finalized_consumer.py`
- `src/eden/evaluation/production/sampler.py`
- `src/eden/evaluation/online/rules_engine.py`
- `tests/unit/workers/test_wave8_pipeline_single_fetch.py` (extended)
- `tests/unit/evaluation/test_production_eval_budget.py` (`_Sampler` double)
- `tests/unit/workers/test_trace_finalized_annotator_retry.py` (`_capture`)
- `docs/MASTER-PLAN-2026-08-10.md`
