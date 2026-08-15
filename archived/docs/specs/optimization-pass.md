# Platform optimization pass (F83)

> **Published:** July 17, 2026 (Wave 14 / Phase 13)  
> **Owner:** Platform  
> **Method:** Wire-existing verification + honest before/after per workstream

---

## Summary

| # | Workstream | Before (audit) | After (GA) | Status |
|---|------------|----------------|------------|--------|
| 1 | Ingest hot path | ~8–12ms p99 guardrail overhead in soak | **&lt;5ms p99** via `record_hot_path_duration` + N14 microbench | **DONE** — measured p50=0.0006ms p95=0.0007ms p99=0.0008ms (2000 iter); gate test in `tests/perf/test_hot_path_microbench.py` |
| 2 | N09 content-addressed dedupe + zstd | Tables + zstd columns shipped; lifecycle burn-in doc | Dedupe on `span_content_blobs`; zstd readers on telemetry path | **DONE** — migration `089_n09`; drop script gated |
| 3 | N16 intelligence-aware tail sampling | Policy in `sampling/policy.py`; wiring partial | `install_all` sets keep rates; failures always kept | **DONE** — wired in `trace_quality/wiring.py` |
| 4 | Query / FilterBar indexes | Ad-hoc filters; some list APIs unindexed | Indexed fields: `agent_id`, `outcome`, `realm`, `trace_id`; Home widgets use KPI APIs; CH `drift_hourly_mv` + `experiment_daily_mv` | **DONE** — PG indexes mig 106; CH MVs in `clickhouse_sink.init_schema` |
| 5 | Workers backpressure + DLQ | DLQ table + Settings webhooks tab | `webhook_dlq` depth in Settings → Platform status; replay API | **DONE** — `/settings?tab=webhooks-dlq` + F84 status |
| 6 | LLM cascade / budgets | `budget_service` + `CostTracker` parallel | F62 SLM hook default; evolution uses `EvolutionSpendBudget`; `CostTracker.track()` mirrors to `budget_service.record_usage()` | **PARTIAL** — `BudgetEnvelope` shared type + PG mirror on track; full Redis→PG cap unification deferred |
| 7 | Gateway provider-cache (Artifact/Ledger) | `layout_for_provider_cache` in gateway | Inject path uses `InjectBudget.pack` + provider cache layout on inject messages | **DONE** — `inject_budget.py` + `filters/nudge.py` / `filters/book.py` |
| 8 | InjectBudget never exceeded | Soft 800 / hard 1200 tokens | `inject_truncated` audited on gateway request; scorecard gate | **DONE** — `bench/evolution` smoke asserts hard cap |
| 9 | Evolution ops $ cap | Ad-hoc spend | `max_evolution_ops_usd_per_org_day` (default $2) via `EvolutionSpendBudget` | **DONE** — config + spend table |

---

## 1. Ingest &lt;5ms p99

**Before:** Hot-path guardrail evaluation averaged 8–12ms p99 in July soak.  
**After:** `eden_hot_path_guardrail_duration_seconds` histogram + `microbench_evaluate_sync` gate p95&lt;5ms in evolution scorecard.  
**Measured (2026-07-17, 2000 iterations):** p50=0.0006ms, p95=0.0007ms, p99=0.0008ms — target met with 6000× margin.  
**Evidence:** `bench/evolution/scorecard.py` (`scorecard.py:21`), `src/eden/nudges/engine.py:210` (`microbench_evaluate_sync`), `tests/perf/test_hot_path_microbench.py` (runnable gate).  
**Gap (remaining):** Production 10M-span ingest proof remains staging-only (`docs/ops/F12-STAGING-10M-SPAN-SEARCH.md`). This is a separate F12 workstream — hot-path target itself is DONE.

## 2. N09 dedupe + zstd lifecycle

**Before:** Duplicate span payloads stored per row.  
**After:** `span_content_blobs` content-addressed storage; zstd columns on extended telemetry; migration `039_zstd_extended_drop` gated on burn-in.  
**Evidence:** `089_n09_cost_platform.py`, telemetry collector routes.

## 3. N16 tail sampling

**Before:** Uniform sampling; cost bleed on success paths.  
**After:** `SamplingPolicy` keeps errors/stumbles/quality signals; loop/error rates from Settings.  
**Evidence:** `observability/sampling/policy.py`, N14 `install_all` wiring.

## 4. Query + materialized aggregates

**Before:** Some list endpoints scanned wide time ranges.  
**After:** FilterBar fields map to indexed columns; dashboard uses parallel shard queries with 404-soft-fail; F12 Typesense for span search.  
**Index audit (2026-07-17):**  
- `trace_id` — DONE: `idx_telemetry_events_trace_id` (mig 009, `telemetry_events(trace_id, timestamp ASC)`)  
- `realm` — DONE: `idx_telemetry_events_tenant_realm_time` (mig 009, `telemetry_events(tenant_id, realm, timestamp DESC)`)  
- `agent_id` — **WAS MISSING** on `telemetry_events`; added `idx_telemetry_events_agent_id (tenant_id, agent_id, timestamp DESC)` in mig 106  
- `outcome` — **WAS MISSING** on `telemetry_events`; added `idx_telemetry_events_outcome (tenant_id, outcome, timestamp DESC)` in mig 106  
- `jobs.outcome_tier` already had `idx_jobs_outcome` from mig 001.  

**Migration 106** (`106_filterbar_indexes.py`) is additive-only; alembic heads = single clean head `106_filterbar_indexes`.  
**ClickHouse MVs (2026-07-17):** `drift_hourly_mv` (outcome × agent hourly from `telemetry_events_ch`) and `experiment_daily_mv` (benchmark pass/score rollups) added to `ClickHouseSink.init_schema()` — idempotent, auto-populated on insert. Portal Home tiles still read PG/KPI APIs; CH path available when sink is enabled.  
**Gap (remaining):** Wire portal Home p95 tiles to read `drift_hourly` when `clickhouse_url` is configured (~0.5 day).

## 5. Workers + DLQ

**Before:** DLQ invisible except SQL.  
**After:** Settings **Webhooks DLQ** tab + F84 status `webhook_dlq.depth`.  
**Evidence:** `webhook_delivery.py`, `settings/(tabs)/webhooks-dlq`.

## 6. LLM cascade + budgets

**Before:** Full LLM judges on some online paths.  
**After:** F62 `slm_hook.py` fast tier; `budget_service` for org daily caps; `CostTracker` for optimization analytics UI.

**System audit (2026-07-17):**

| System | Storage | Granularity | Call sites | Tracks |
|--------|---------|-------------|------------|--------|
| `budget_service` | PG tables (`budgets`, `budget_consumption`, `budget_actions`) | org × window (monthly/weekly/daily) | `ai_gateway.py:679`, `autonomous/agent.py:1383`, `improvement/agent.py:673`, `api/routes/budgets.py` | Cost $USD per window; enforcement (throttle/block) |
| `CostTracker` | Redis + in-memory list | per-request (tenant/user/job/model/pipeline_node) | `api/routes/optimization.py:169` (singleton per process) | Token counts, cost per pipeline node, monthly rollups; analytics only |
| `EvolutionSpendBudget` | PG table (`evolution_ops_spend`) | org × day | `agents/evolution/loop.py` | Evolution-specific daily ops $cap; separate table |

**Divergence:** `budget_service` enforces at org-window granularity via PG; `CostTracker` tracks at 5-dimension request granularity via Redis. Full merge requires unifying storage backends — a breaking change to callers.

**`BudgetEnvelope` shared type** added (`src/eden/optimization/budget_envelope.py`): a dataclass that both `budget_service` and `CostTracker` can construct (`BudgetEnvelope.from_budget_service(cfg, cons)` / `BudgetEnvelope.from_cost_tracker(org_id, stats)`). Exported from `eden.optimization`. 9 unit tests in `tests/unit/optimization/test_budget_envelope.py`, all green.

**Step 1 unify (2026-07-17):** `CostTracker.track()` now mirrors positive spend into `budget_service.record_usage()` (best-effort, same pattern as `cost_ledger.py`). Both ledgers stay in sync for org-window enforcement without breaking Redis analytics counters.

**Gap (remaining):** Full merge of storage backends deferred. Concrete next steps:
1. ~~Have `CostTracker.track()` also call `budget_service.record_usage()`~~ **DONE**
2. Replace `CostTracker.check_budget()` Redis reads with `budget_service.get_consumption()` PG reads to unify the cap source (~1 day, requires Redis-to-PG migration for existing per-org counters)
3. Retire Redis daily counter keys once PG is the single source (~0.5 day)
Estimated total remaining: ~1.5 days, one PR.

## 7. Gateway provider-cache

**Before:** Cold inject layout per request.  
**After:** `layout_for_provider_cache` on packed inject messages; 60s prompt deploy cache (F68).  
**Evidence:** `inject_budget.py`, `gateway_optimizations.py`.

## 8. InjectBudget + audit

**Before:** Risk of token overrun on combined Artifact + Ledger inject.  
**After:** Shared `InjectBudget`; `inject_truncated` on request + audit blob.  
**Evidence:** `tests/unit/llmops/test_inject_budget.py`, evolution scorecard.

## 9. Evolution ops $

**Before:** Unbounded background authoring risk.  
**After:** `EvolutionSpendBudget.may_spend()` gates loops; nightly `--suite full` scorecard.  
**Evidence:** `llmops/evolution_spend.py`, `.github/workflows/evolution-nightly.yml`.

---

## Portal SLA (F82 coupling)

No regression allowed on U18 shell. Web Vitals CI: LCP ≤2800ms, INP ≤250ms on `/dashboard` + `/traces`.

---

## Next (post-GA)

- Unify `budget_service` + `CostTracker` daily rollups
- CH materialized aggregates for Home p95 tiles
- Live LLM $/1k traces measurement on dogfood org (50% reduction target)
