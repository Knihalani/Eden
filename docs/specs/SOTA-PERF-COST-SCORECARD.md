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
| StatGate (N08) | <80ms | Autonomy StatGate-first (W24); microbench hot-path | **MET** (local microbench) |
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
| Playground LLM cost honesty | Handler still stub → cost_usd often 0 (W18) | **SOFT** |

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
| Latency SLAs | 2 | 5 | 1 (F12 10M) |
| Cost controls | 5 | 1 | 0 |
| Async/cache | 3 | 1 | 0 |

**Overall:** **PARTIAL-GREEN** — core cost + hot-path gates met locally; several human-facing p95s and F12 staging remain unproven.

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
