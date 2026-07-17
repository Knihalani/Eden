# F12 — Staging 10M-span search proof (Phase 1)

**Date:** July 16, 2026  
**Feature:** F12 Typesense full-text span search  
**Target:** p95 query latency **<200 ms** on a **10M-document** `eden_spans` collection.

---

## Environment

| Component | Staging value |
|---|---|
| Typesense | Managed cluster or `eden_typesense` with ≥24 GB RAM |
| Collection | `eden_spans` (shared) with `filter_by tenant_id:=<org>` |
| Index age | 90-day TTL enforced (`typesense_ttl_cleanup` cron) |
| PII | `build_span_doc` in `src/eden/observability/typesense_client.py` applies `PIIMasker` before index — verified in `tests/unit/observability/test_search.py::TestPIIRedaction` |

> **Note on doc builder location:** The function named in the acceptance gate is `build_span_doc`, which lives in
> `src/eden/observability/typesense_client.py` (not `search_service.py`). It is imported by both the ingest
> collector (5th sink) and the search service's reindex utility.

---

## Load procedure

1. **Seed** — run the staging backfill job (or replay production sample) until `found` ≥ 10_000_000 for `q=*` with a single tenant filter.
2. **Warm** — execute 50 discarded queries (`q=python`, `q=error`, `q=tool`) to populate OS page cache.
3. **Measure** — 500 search requests via `SearchService.search(tenant_id=..., query=...)` mixing:
   - 60% short keyword (`bash`, `timeout`, `checkout`)
   - 30% multi-word (`user frustrated`)
   - 10% empty query with agent facet
4. **Record** — export `eden_search_duration_seconds` histogram p50/p95/p99 from `/metrics`.

---

## Acceptance (GA Phase 1)

| Metric | Gate | Result |
|---|---|---|
| Search p95 | <200 ms | **BLOCKED — staging Typesense unavailable** (see below) |
| Index enqueue p95 | <5 ms | _N/A — ingest sidecar_ |
| PII at index | email/CC/SSN absent | **PASS** (unit `TestPIIRedaction` — 49/49 ✓ Jul 17 2026) |
| Fallback banner | Typesense down → PG ILIKE | **PASS** (unit `TestTypesenseFallback` — 49/49 ✓ Jul 17 2026) |

---

## Local synthetic proxy results (N=50,000 documents)

> **These are NOT the staging 10M result.** They are a local worst-case floor
> measured against the Postgres-fallback ILIKE path (SQLite in-memory), which
> is the slowest possible execution path. Real Typesense inverted-index lookups
> on equivalent hardware will be substantially faster.

**Run date:** 2026-07-17 (GA hardening pass re-run, N=5,000 docs)  
**Environment:** macOS, no Typesense cluster (Docker unavailable)  
**Backend:** SQLite in-memory LIKE queries (mirrors `SearchService._pg_fallback_search`)  
**Doc pipeline:** full `build_span_doc` + `PIIMasker` production pipeline  

| Metric | Local proxy (SQLite, N=5k) | Prior run (N=50k) |
|---|---|---|
| p50 | 15.22 ms | 34.40 ms |
| p95 | **56.41 ms** | 88.06 ms |
| p99 | 97.61 ms | 137.51 ms |
| max | 135.17 ms | 1127.36 ms |

SQLite LIKE on unindexed text columns is a worst-case floor. Typesense uses an
inverted index and consistently achieves <50 ms p95 at 10M docs on commodity
hardware (per published Typesense benchmarks and the comment in
`typesense_client.py`: "Sub-50ms p95 even at 10M docs on commodity hardware").

---

## Wave 3 CI status (2026-07-17 close)

| Gate | Status | Notes |
|---|---|---|
| F85 golden 8/8 smoke | PARTIAL | Runner + fixtures exist; deep promote/NL-ack/prefix-rerun need auth org data |
| F85 auth-green CI | **PARTIAL** | `portal-ci.yml` golden-paths job + Clerk test-key fallback shipped; GitHub secrets list blocked (`gh` token invalid). Local `.env.local` has Clerk keys — operator must confirm Actions run green |
| Auth axe | PARTIAL | Unauth critical gate green; authenticated shell needs Clerk seed |
| Web vitals | PARTIAL | Clerk-free LCP/INP on `/dashboard`+`/traces`; ChatSidebar INP deferred |
| F12 10M p95 | **BLOCKED** | Staging Typesense unavailable — see acceptance table above |
| F12 **contract** (scaled-down) | **GREEN (wiring)** | `.github/workflows/f12-span-search-contract.yml` — N=10k SQLite proxy via `bench_f12_span_search.py`; local run p95 **20.64 ms** (N=10k, 200 req). **Not** the 10M GA gate |
| Contracts wave6 + ai-insights | GREEN | `tests/unit/api/test_w3_contracts.py` |
| OpenAPI denylist | GREEN | `_INTERNAL_*` + tag strip in `openapi_public.py` |

### F12 honesty note

The scaled-down CI job proves `build_span_doc` + PIIMasker + bench harness wiring.
**Do not stamp F12 DONE for 10M p95** until staging Typesense evidence lands.
F12 feature code remains SHIPPED; the 10M load-test env gate stays BLOCKED.

**Chaos / dependency down (documented):** Typesense down → PG ILIKE fallback + portal banner (unit covered). Redis down → rate-limit / cache degrade to in-process; gateway exact-cache miss tags still emit.

**What is needed:**
1. A running Typesense instance (`TYPESENSE_HOST`, `TYPESENSE_PORT=8108`, `TYPESENSE_API_KEY`) connected to the Northflank staging environment with ≥10M `eden_spans` documents indexed.
2. Network access from the machine running the bench script to that cluster.
3. Either a human with Northflank staging credentials or a CI job in the staging environment.

**Who/what needs to run this:** The on-call engineer with Northflank staging credentials, or the Northflank CI pipeline targeting the `staging` environment.

**Exact reproducible command** (copy-paste once staging Typesense is available):

```bash
TYPESENSE_HOST=<staging-typesense-host> \
TYPESENSE_PORT=8108 \
TYPESENSE_API_KEY=<staging-api-key> \
  python3.12 scripts/bench_f12_span_search.py --n=10000000 --requests=500
```

The script auto-detects Typesense reachability: if the cluster responds, it seeds docs via `index_many` and runs the 500-request workload against it; if not, it falls back to the SQLite proxy and clearly labels the output. The acceptance gate p95 < 200 ms will be marked PASS / FAIL automatically in the printed table.

---

## F83 hot-path guardrail microbench (ingest sidecar)

> Collected here because `docs/specs/optimization-pass.md` workstream #1
> references `eden_hot_path_guardrail_duration_seconds` and the same "Gap:
> Production 10M-span ingest proof remains staging-only" line.

**Function:** `microbench_evaluate_sync` in `src/eden/nudges/engine.py`  
**Target:** p95 < 5 ms (gate enforced in `bench/evolution/scorecard.py`)  
**Run date:** 2026-07-17  
**Iterations:** 5,000

| Metric | Measured |
|---|---|
| p50 | 0.00062 ms |
| p95 | 0.00067 ms |
| p99 | 0.00071 ms |

**Result: PASS** — p95 is 7,500× under the 5 ms gate. The hot-path
`evaluate_trigger` loop has no LLM invocation; it is pure Python dict
traversal + regex, which is why latencies are sub-millisecond.

---

## Rollback

Disable `typesense_search_v1` per org or globally; portal shows fallback banner and Postgres ILIKE path (`SearchService._pg_fallback_search`).

---

*Run `scripts/bench_f12_span_search.py` on Northflank staging before GA sign-off. Update the "Staging result" column with measured p95 from the script output.*
