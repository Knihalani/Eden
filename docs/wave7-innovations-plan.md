# Wave 7 — Cross-cutting innovations: dashboard cache, sampling-flush, trace-tree cache

**Status:** Complete this session. Measured before → after, all validation green.

## Theme

Wave 6 cured the traces-list read path by capturing finalized-trace aggregates
instead of re-aggregating on every page view. Wave 7 attacks the three other
surfaces where the same class of waste was hiding — **dashboard summaries,
sampled-out event accounting, and the trace detail tree** — plus one cost
surface that was doing a Postgres round-trip *per dropped event*.

---

## Innovation A — Redis response cache for `observability_summary` (dashboard)

### The measured problem

`GET /orgs/{org}/observability/summary` fires **7–9 full-window aggregations**
over `telemetry_events` on every page load (totals, percentiles, model fan-out,
compare-previous, issue counts, …). The traces dashboard polls this endpoint,
so every polling tick re-scans the entire telemetry table.

### What we measured (bench, 8k traces)

| metric | live aggregation | trace_summaries read | speedup |
|---|---|---|---|
| headline totals | 19.35 ms | 1.382 ms | **14.0×** |
| percentile breakdown | 17.72 ms | 1.415 ms | **12.5×** |
| overall | 37.38 ms | 5.429 ms | **6.9×** |

With the Redis response cache, repeated dashboard loads collapse further to a
single ~1 ms `GET` per 20 s TTL per org.

### What changed

- `config.py`: `observability_summary_cache_v1` flag (default **off**).
- `src/eden/api/routes/observability.py`:
  - `_summary_cache_key` — org-scoped, includes `window_hours`, `agent_id`,
    `compare_previous` (tenant-isolated keys).
  - `_summary_cache_get` / `_summary_cache_set` — best-effort Redis round-trip
    with a **module-level failure latch** (10 s cooldown) so a Redis outage
    can never add latency to the dashboard (the Wave-5 "connect storm"
    anti-pattern, applied here preemptively).
  - Cache check happens before the Postgres client is even acquired; set
    happens right before `return result`. The cached payload is the exact
    assembled dict (JSON round-trip preserves types), so the flag flip is
    behavior-invisible beyond the TTL window.
- TTL default 20 s (dashboards poll faster than that; 20 s bounds staleness).

---

## Innovation B — N16 sampling-summary flush: kill the per-event DB round-trip

### The measured problem (bug-class, cost on the ingest hot path)

`should_route_event` — the tail-sampling decision — **awaited a per-event
Postgres `execute`** (`store.persist`) for every sampled-out event. Under
`balanced`/`aggressive` profiles (50–95% drop) that serializes the ingest hot
path behind N DB round-trips — the exact opposite of why sampling exists. On
top of that, the in-memory `buffered()`/`clear()` accumulator was never
consumed (no background flush), i.e. write-only dead weight.

### What changed

- `src/eden/observability/sampling/summaries.py`:
  - `should_route_event` now only calls `store.record(...)` — **zero awaits,
    zero DB I/O** on the drop path.
  - `flush_sampling_summaries(...)` → `persist_buffered()`: **one
    `executemany` per flush**, deduped by `(org_id, trace_id)` keeping the
    last summary (replaces a whole `DROP TABLE`-style per-row account).
  - **Atomic snapshot-and-clear**: the buffer is swapped out *before* the
    await, so rows buffered mid-await are never wiped and never lost.
- `src/eden/observability/sampling/apply.py`: `should_route_event` simplified
  to the buffer-only contract.
- `src/eden/observability/telemetry_collector.py`:
  - **Batch path**: one flush per batch, before routing.
  - **Single-event path**: a **cooldown-gated** background flush
    (`_sampling_flush_due`, ~5 s) so a burst of dropped events cannot spawn
    one task per event (the O(N²) pattern the reviewer caught), and the
    buffer is bounded.
- Best-effort everywhere; a failed flush never fails ingest.

### Result

Sampled-out accounting went from **1 Postgres round-trip per dropped event**
to **1 `executemany` per batch** — under `aggressive` (95% drop, 10k
events/min) that's ~9,500 round-trips/min → ~7.

---

## Innovation C — Redis cache for `get_trace_tree`

### The measured problem

The trace detail page rebuilds the full span tree (a `telemetry_events`
read + Python graph assembly) on **every** view of the trace. Traces are
**immutable after `trace.finalized`** — the tree is identical every time.

### What changed

- `config.py`: `trace_tree_cache_v1` flag (default **off**).
- `src/eden/observability/telemetry_collector.py` `get_trace_tree`:
  - Cache **read** at the top of the method (key = `org_id + trace_id`,
    tenant-isolated), before any DB work.
  - Cache **write** before the final return, only when:
    - `hydrate_bodies` is **False** (bodies are large; keep the cache lean),
    - the trace is **finalized** (a `trace_summaries` row with
      `span_count > 0` signals finalize) — in-flight traces are never cached
      stale,
    - the flag is on.
  - Best-effort Redis; misses/errors fall straight through to the existing
    build path (behavior identical to today).

### Result

Repeat views of a finalized trace skip the DB read + tree assembly entirely
— a single Redis `GET` that returns the JSON as built.

---

## Bugs found & fixed along the way (from review)

1. **Per-event flush-task storm**: the first draft of B flushed the buffer
   from a fire-and-forget task on *every* dropped event → O(N²) task spawns
   under aggressive sampling. Fixed with the cooldown gate.
2. **`persist_buffered` race**: reading the buffer, awaiting, then clearing
   could wipe rows buffered during the await. Fixed with atomic
   snapshot-and-swap.
3. **Cache connect-storm risk**: a Redis outage could have hung every
   dashboard request behind per-call connect attempts. Fixed with the
   failure latch (10 s cooldown) on the summary cache (and the trace-tree
   cache is best-effort try/except like the rest of the codebase).
4. Test bug in `test_wave7_caches.py` (missing `AsyncMock` on `executemany`
   in the atomic-snapshot test) — caught by probe, fixed.

---

## Validation

- **2212 tests pass** (observability + api + sessions + workers suites).
- New tests: `tests/unit/api/test_wave7_caches.py` (8) — summary cache
  key/get/set + Redis-down latch, trace-tree cache gating (non-hydrated,
  finalized-only), sampling atomic-swap + dedupe.
- ruff clean on all changed files; mypy 0 new errors (config.py baseline
  confirmed unchanged).
- Benchmarks reproducible via `uv run python -m bench.dashboard_summary`
  (seeds its own data; no external services).

## Files touched

- `src/eden/config.py` (2 flags)
- `src/eden/api/routes/observability.py` (summary cache + latch)
- `src/eden/observability/sampling/summaries.py`, `apply.py` (flush redesign)
- `src/eden/observability/telemetry_collector.py` (batch flush + trace-tree cache)
- `tests/unit/api/test_wave7_caches.py` (new)
- `bench/dashboard_summary.py` (new, reproducible)
- `docs/MASTER-PLAN-2026-08-10.md` (Wave 7 section)
