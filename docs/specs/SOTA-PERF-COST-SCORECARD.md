# Eden SOTA Performance & Cost Scorecard (Wave 29)

> **Date:** 2026-07-17  
> **Standards source:** [`PERFORMANCE-COST-STANDARDS.md`](./PERFORMANCE-COST-STANDARDS.md)  
> **Method:** Map shipped surfaces to published SLAs; mark **MET** / **SOFT** / **UNPROVEN** honestly.

---

## 1. Client experience vs standards

| Surface (standard) | Target p95 | Evidence | Verdict |
|---|---|---|---|
| Portal page load (issues list) | <800ms | Portal OS hubs (W10–W12); axe green locally; F82 web-vitals workflow wired; **auth CI secrets soft** | **SOFT** — local axe OK; CI auth-green PARTIAL (W3) |
| Trace detail / transcript | <1.2s | TranscriptV2 + virtualization (W13); progressive load | **SOFT** — structural + unit; staging p95 not measured |
| MCP tool response (read) | <800ms | `eden-mcp` smoke + W28 tool catalog; exclude upstream LLM | **SOFT** — install/smoke OK; no staging latency histogram |
| Issue created after trace | <60s | Async workers + stumble/signal path | **SOFT** — unit contracts; staging dogfood open |
| Search (Typesense) F12 | <200ms | Local SQLite proxy N=50k p95 ~253ms; **staging 10M BLOCKED** | **UNPROVEN** — W3 P0-F12-10M |
| StatGate (N08) | <80ms | Microbench, 2000 iterations over a 200-incident synthetic pool (mixed kinds/severities, 0–8 stumbles, ~20% with metric samples driving the numeric gate; pure compute, no I/O): p50=0.0090ms p95=0.0757ms p99=0.0801ms vs SLA p95<80ms p99<150ms (`tests/perf/test_statgate_microbench.py`) | **MET** (local) |
| Ingest hot-path overhead | ≤5ms p99 | Evolution scorecard + `tests/perf/test_hot_path_microbench.py` | **MET** (local) |
| Live stream publish (N11) | <500ms | Unit/local buffer proof (W27); staging p95 open | **SOFT** |

---

## 2. Cost hierarchy vs standards

| Principle | Implementation | Verdict |
|---|---|---|
| Deterministic before LLM | StatGate (N08), F34 classifiers before F06 investigator | **MET** |
| Org spend budgets / kill switches | Cost ledger (W7), FinOps explorer+kills (W8), N22 autonomy bounds (W24), evolution spend (W25) | **MET** |
| Feature-tagged CostEvent | autonomy / evolution / promote / signal_classifier | **MET** |
| ChatSidebar metered | Session spend meter + estimate_chat_cost (W23) | **MET** |
| Sampling on client/SDK | N16 client sampling + offline queue (W6) | **MET** |
| Playground LLM cost honesty | Real ModelRouter handler (`playground/llm_handler.py`); `playground` in `KNOWN_FEATURES` (`cost_ledger.py`); staging spend attribution unproven | **SOFT** |

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
| Latency SLAs | 1 | 5 | 2 (F12 10M; N08 StatGate) |
| Cost controls | 5 | 1 | 0 |
| Async/cache | 3 | 1 | 0 |

**Overall:** **PARTIAL-GREEN** — core cost + ingest hot-path gates met locally; StatGate (N08) latency, human-facing p95s, and F12 staging remain unproven.

---

## 5. How to re-run

```bash
# Hot-path / inject budget
python -m bench.evolution.run --suite smoke

# Portal structural (incl. W29 sweep contracts)
cd clients/portal && bun test src/lib/__tests__/w29-portal.test.ts

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