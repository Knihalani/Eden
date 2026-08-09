# OPT-61 — Tier-aware RCA / signal investigator

**Status:** ✅ DONE (practical scope) — 2026-08-07  
**Related:** warm_days / cold archive (`ArchiveService`, `telemetry_collector._load_from_archive`)

## GitHub-style issue note

**Title:** OPT-61 — tier-aware RCA / investigator queries across warm+cold tiers

**Body:**

RCA (`insights/rca/_common._fetch_trace_events`) and the signal investigator (which imports that helper) previously only read hot Postgres. Traces older than the org's `warm_days` window live in Impossible Cloud via `trace_archive_index` + `ArchiveService.rehydrate`, so investigation/`not_found` for archived traces was a silent false negative.

### Shipped

- **Single-trace cold rehydrate-on-miss** — `_fetch_trace_events` calls `ArchiveService.rehydrate` on hot miss (same pattern as `TelemetryCollector.get_trace_tree`).
- **Thin vs full column projection** on rehydrated rows (`error_type`, `agent_id`, etc.).
- **Process-local + Prometheus counters** via `simple_metrics`:
  - `eden_rca_trace_events_hot_hits_total`
  - `eden_rca_trace_events_cold_rehydrates_total`
  - `eden_rca_trace_events_misses_total`
- **Windowed failed-trace queries** — `_fetch_failed_traces_in_window` supplements hot Postgres with `trace_archive_index` candidates (`archived_at` pre-filter), rehydrates up to **30** traces per call (`bounded_gather`, concurrency 8), and filters failures client-side with `event_is_failure` + event `timestamp` in-window.
- Route module comments in `intelligence_rca.py` and `signal_investigator.py` reference `warm_days` / cold tier.
- `investigate_trace` routes single-trace reads through `_fetch_trace_events`.

### Hard limits (documented)

| Limit | Value | Why |
|---|---|---|
| Hot failed traces | 500 | Existing incident-clusterer cap |
| Cold rehydrates per window query | 30 | Bounded Impossible Cloud reads per RCA cluster pass |
| Archive index pre-filter | `archived_at` in window | Index has no per-event failure columns; event timestamps validated only after rehydrate |
| Cold failures missed when | Archived before window but events failed inside window | Would require full index scan + rehydrate — intentionally out of scope |

### Intentionally hot-only

**Signal backfill** (`signals/backfill.py`) stays hot-only. Backfill re-investigates recently finalized traces when a signal is created; each cold rehydrate is an Impossible Cloud round-trip and would distort job cost/rate limits (`_MAX_TRACES_PER_MINUTE`). Live signal matching does not need historical cold tiers.

### Deferred follow-ups

- [ ] Optional **write-through rehydrate** into hot Postgres for hot-path reuse (today rehydrate is read-only).
- [ ] **Tier-aware UI copy** when results came from cold storage (latency expectations in portal).

### Hook in place

`src/eden/insights/rca/_common.py` → `_fetch_trace_events`, `_fetch_failed_traces_in_window`, `_load_trace_events_from_archive`.
