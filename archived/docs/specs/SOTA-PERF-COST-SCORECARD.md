# Eden SOTA Performance & Cost Scorecard (Wave 29)

> **Date:** 2026-07-17  
> **Standards source:** [`PERFORMANCE-COST-STANDARDS.md`](./PERFORMANCE-COST-STANDARDS.md)  
> **Method:** Map shipped surfaces to published SLAs; mark **MET** / **SOFT** / **UNPROVEN** honestly.

---

## 1. Client experience vs standards

| Surface (standard) | Target p95 | Evidence | Verdict |
|---|---|---|---|
| Portal page load (issues list) | <800ms | Portal OS hubs (W10–W12); axe green locally; F82 web-vitals workflow wired; **auth CI secrets soft** | **SOFT** — local axe OK; CI auth-green PARTIAL (W3) |
| Trace detail / transcript | <1.2s | `traces-detail-panels.tsx` + `@tanstack/react-virtual` (W13 structural); progressive load; `TranscriptV2` **UNVERIFIABLE** | **SOFT** — structural; staging p95 not measured; portal wave tests **DELETED** (cab7ae32) |
| MCP tool response (read) | <800ms | `eden-mcp` smoke + W28 tool catalog; exclude upstream LLM | **SOFT** — install/smoke OK; no staging latency histogram |
| Issue created after trace | <60s | Async workers + stumble/signal path | **SOFT** — unit contracts; staging dogfood open |
| Search (Typesense) F12 | <200ms | **Real Typesense 1.1M docs**: SearchService end-to-end p95 **184ms** with `search_cutoff_ms=150` (server keyword p95 555→164). Untuned p95 was ~446–551ms. Single-node laptop; 10M not yet run. Prior artifact: `bench/results/f12-span-search-1m-typesense-20260804.json`. Harness (`scripts/bench_f12_span_search.py`): `--facet-ab` / `--no-facet-ab` (default on) measures faceting cost; `gate_met` is harness-computed from measured baseline p95 vs `--gate-ms` (null on SQLite proxy). **Scale ladder** (`--scale-ladder` / `--corpus-sizes 10k,100k,1m,10m`; `--dry-run` for manifest-only): manifest `bench/results/f12-span-search-scale-ladder-20260807.json` — **10k/100k measured** on SQLite proxy (contract wiring, `gate_met=null`); **1.1M prior Typesense** (`gate_met=true`, p95 184ms, not re-run here); **10M blocked_staging** (no fabricated numbers). Typesense rungs need `docker compose -f docker/docker-compose.yml up -d typesense` + env vars. | **MET @1.1M** (tuned) — 10M staging follow-up; ladder harness complete, 10M genuinely unmeasured |
| StatGate (N08) | <80ms | Microbench, 2000 iterations over a 200-incident synthetic pool (mixed kinds/severities, 0–8 stumbles, ~20% with metric samples driving the numeric gate; pure compute, no I/O): p50=0.0090ms p95=0.0757ms p99=0.0801ms vs SLA p95<80ms p99<150ms (`tests/perf/test_statgate_microbench.py`) | **MET** (local) |
| Ingest hot-path overhead | ≤5ms p99 | Evolution scorecard + `tests/perf/test_hot_path_microbench.py` | **MET** (local) |
| Live stream publish (N11) | <500ms | Unit/local buffer proof (W27); staging p95 open | **SOFT** |

---

## 2. Cost hierarchy vs standards

| Principle | Implementation | Verdict |
|---|---|---|
| Deterministic before LLM | StatGate (N08), F34 classifiers gate the F06 investigator call site | **MET** |
| Org spend budgets / kill switches | Cost ledger (W7), FinOps explorer+kills (W8), N22 autonomy bounds (W24), evolution spend (W25) | **MET** |
| Feature-tagged CostEvent | autonomy / evolution / promote / signal_classifier | **MET** |
| ChatSidebar metered | Session spend meter + estimate_chat_cost (W23) | **MET** |
| Sampling on client/SDK | N16 client sampling + offline queue (W6) | **MET** |
| Playground LLM cost honesty | Real ModelRouter handler (`playground/llm_handler.py`); `playground` in `KNOWN_FEATURES` (`cost_ledger.py`); staging spend attribution unproven | **SOFT** |

> **Correction (OPT-12, 2026-08-05):** The "F06 investigator" gated above,
> RCA, and guardrails are **not LLM-cost-optimization targets** — none of
> them makes a live LLM call today, so there is nothing to optimize:
> - **Signal investigator (F06/F34):** `run_investigator_llm_batch`
>   (`signals/investigator.py`) always returns `{}`; `_one_completion`
>   raises `RuntimeError("signal investigator LLM path removed")`.
>   `INVESTIGATOR_COST_USD = 0.03` in `classifier_worker.py` is documented
>   in-code as "NOT a real price" — a notional yardstick for a local
>   shadow-mode savings counter, never written to a real `CostEvent`.
> - **RCA:** `RootCauseAnalyzer` (`insights/rca/analyzer.py`) is a
>   rule-based ~6-rule table; every response carries
>   `model: "rule_based_v1"`. The documented LLM-as-judge upgrade path is
>   deferred and was never built.
> - **Guardrails:** `guardrails/detectors.py` imports only `re` for
>   detection; no symbol in `guardrails/*.py` reaches an LLM client.
>
> **Current real LLM spend on all three: $0.** Do not allocate future
> engineering cycles to "optimizing" LLM cost on paths that don't exist.

---

## 3. Caching / async defaults

| Pattern | Status |
|---|---|
| Async workers for heavy paths | **MET** — ingest enqueue, classifiers, heal verify |
| Redis caches where applicable | **MET** — live pub/sub, budgets; fail-closed documented |
| Prefix / blob caches | **MET** — F01 / N09 patterns retained |
| CDN static assets | **SOFT** — portal deploy dependent |

---

## 4. Scorecard rollup

| Bucket | MET | SOFT | UNPROVEN |
|---|---|---|---|
| Latency SLAs | 3 (F12 @1.1M) | 5 | 0 |
| Cost controls | 5 | 1 | 0 |
| Async/cache | 3 | 1 | 0 |

**Overall:** **PARTIAL-GREEN** — core cost + ingest hot-path + StatGate (N08) latency gates met locally; F12 span-search met at 1.1M on real Typesense (`search_cutoff_ms=150`, p95 184ms), with 10M-on-staging as the remaining follow-up; human-facing p95s remain unproven. F12 harness now supports scale ladder (`--scale-ladder`, `--corpus-sizes`, `--dry-run`), facet A/B (`--facet-ab`), and programmatic `gate_met`. Ladder manifest `bench/results/f12-span-search-scale-ladder-20260807.json`: 10k/100k SQLite-proxy measured (wiring only), 1.1M Typesense prior artifact (`gate_met=true`), 10M `blocked_staging` — no numbers fabricated.

---

## 5. How to re-run

```bash
# Hot-path / inject budget
python -m bench.evolution.run --suite smoke

# F12 span-search scale ladder (manifest + per-rung JSON under bench/results/)
TYPESENSE_HOST=localhost TYPESENSE_PORT=8108 TYPESENSE_API_KEY=<key> \
  python scripts/bench_f12_span_search.py --scale-ladder

# Manifest only (no seeding/benchmarking) when Typesense is down
python scripts/bench_f12_span_search.py --scale-ladder --dry-run

# Portal structural contracts — w29-portal.test.ts DELETED (cab7ae32); use surviving portal tests:
cd clients/portal && bun test src/lib/api/__tests__/portal.test.ts

# Packaging dry-run
bash scripts/publish_sdk.sh dry-run
```

---

## 6. Full-optimization gates (Wave-2 audit 2026-07-18)

| Gate | Target | Evidence | Verdict |
|---|---|---|---|
| Bundle CI (K43) | ≤400KB/chunk, ≤6MB total, recursive | `bun run check:bundle` → largest 326 KB / total 5 MB / recursive OK | **MET** |
| Web Vitals budgets | LCP≤2600 / INP≤220 | Script `measure-web-vitals.mjs` + `web-vitals.yml`; needs Clerk `AUTH_STATE` | **UNPROVEN** locally (CI-only / auth-seed debt) |
| Ingest Prometheus (K45) | `eden_ingest_redis_commands`, `eden_ch_flush_batch_size`, `eden_sse_publish_skipped` | unit metrics tests + `ingest_hot_path_metrics.py` | **MET** (local) |
| Slow queries admin (K44) | `GET /orgs/{org}/admin/slow-queries` | Endpoint + ring buffer tested; `record_slow_query` has **no production producers** (tests only) | **SOFT/UNPROVEN** |
| S18 benches | redact/chunk/dual-emit cases | `tests/perf/test_redact_chunk_dual_emit_bench.py` in targeted suite | **MET** (local) |
| Ingest microbench | hot-path overhead gate | `tests/perf/test_hot_path_microbench.py` → 2 passed | **MET** (local) |
| ID checklist | Every §5 ID registered; 0 OPEN P0/P1 | Checklist tally: **140 DONE**, 1 DEFERRED (P6b-remainder), 3 N/A (B33–B35); 0 OPEN P0/P1 | **MET** |

**Measure script:** `clients/portal/scripts/measure-web-vitals.mjs` (invoked by `web-vitals.yml` after `seed-auth`). Budgets parsed from `budgets.ts`. Local run without Clerk auth seed does not produce authenticated LCP — do not claim MET without CI/auth samples.

**Wave-2 note:** Portal vitest 279/279 after K13 `api.ts`→`lib/api/*` test path fixes. Backend `tests/unit` still has residual failures unrelated to checklist P0/P1 (see Wave-2 report debt).