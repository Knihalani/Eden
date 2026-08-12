# Eden — Order-of-Magnitude Improvement Plan (2026-08-12)

> **Status: DRAFT — audits in flight.** Written by the main planning session; grounded in
> seven parallel code audits + fresh benchmark runs on this machine. Every claim carries a
> `verified` / `inferred` flag. This plan deliberately does NOT re-propose the in-flight
> autonomy waves (AUTONOMY-DEEP-AUDIT-WAVEPLAN-2026-08.md Waves 4–6 are mid-implementation
> in the working tree); it opens new order-of-magnitude axes.

## 0. Verified baselines (this machine, 2026-08-12)

Fresh `bench.run_all` (results: `bench/results/20260812-015544.json`, 9.7s):

| Metric | Value | Note |
|---|---|---|
| App import (`startup.app`) | ~547ms median (8/9 run); api_deps 370ms on 8/12 run | kb_router 315ms + api_deps ~300–370ms dominate |
| zstd compression ratio | **15.0×** (9.3MB → 620KB, n=5000 spans) | 35.2k ops/s single, 61.3k batch |
| request_path /health p50 | 0.90ms | local TestClient |
| Middleware dispatch | 1–6µs each | negligible |

Deploy topology (verified from `northflank.yml` annotations, live-checked 2026-07-29 by prior pass):
- **One API pod** (nf-compute-50: 0.5 vCPU / 1GB, $12/mo) carries ~111 routers, 21 deferred
  numpy routers, six leader-gated loops, the quality-pipeline sidecar, in-lifespan Alembic,
  **and the whole background fleet** (moved in-process 2026-07-29). Steady RSS 270MB.
- Redis = Upstash free tier, **10k commands/day cap** — already forced a 10× bundle-lock TTL
  increase (60s→600s) to survive; truncated shutdowns then cost 10-minute fleet-lease waits.
- Postgres = Neon (us-east-2), API in Northflank us-central, portal on Vercel iad1 — every
  API→DB round-trip is cross-region.
- Tinybird for analytics; pgvector replaced Qdrant (stale env vars remain).

Test suite: **6,055 unit tests passed, 14 skipped, 1 xfailed in 288s** (fresh run 2026-08-12,
this machine) — the suite is healthy and fast enough to gate refactors.

## 1. Method

Seven parallel audits: backend hot paths, LLM cost, portal frontend, SDKs, architecture
bloat, data platform, onboarding/time-to-value. Each returned evidence-backed findings
(file:line + measurements). Verification: existing bench harness + targeted micro-benches +
static counts. Sections below merge those findings into one ranked program.

## 2. Findings index (to be filled per audit)

### 2.5 SDK audit (COMPLETE — 12 findings, micro-benchmarked)

Measured (PYTHONPATH=sdk/python, N=10k): raw Span create+finish 6.2µs median;
full `trace()` ctx-mgr 56.7µs (17.6k spans/s); `enqueue()` no-op 541ns;
`_emit_trace_event` 25.4µs = **4.1× the raw span cost**.

| # | Finding | Multiplier | Status |
|---|---|---|---|
| S1 | Go SDK: no wire compression at all (`sdk/go/client.go:229-232`, plain JSON, no Content-Encoding; server already accepts gzip/zstd) | 10–15× wire bytes | VERIFIED |
| S2 | Rust SDK: no background queue — every `trace()` is a blocking reqwest POST (`sdk/rust/src/trace.rs:26`, `client.rs:78-100`) | ~50× throughput | VERIFIED |
| S3 | Python: input/output JSON-encoded twice — eagerly in `capture_value()` (trace.py:358-365) just to measure truncation size, again in sender thread | 2–3× emit path | MEASURED |
| S4 | Python: `get_config()` lock acquired 2× per span (trace.py:193 + :356) + live-mode check every span (trace.py:228-234) | ~15-20% of trace() | VERIFIED |
| S5 | TS: `JSON.stringify` on flush path (client.ts:159); no fast serializer despite fixed TelemetryEvent schema | 3–7× JSON path | INFERRED mag. |
| S6 | TS: zstd only on Bun (`_resolveZstd` probes `Bun.zstdCompressSync`, client.ts:134-142); all Node users fall back to gzip-1 | 2–3× compression | VERIFIED |
| S7 | Go SDK: zero retry — any 5xx/429/timeout silently drops the whole batch, logged at Debug only (client.go:235-247, :275) | 100%→~0% loss on transient failure | VERIFIED |
| S8 | Go/Rust: no auto-instrumentation (Python/TS are 2-line setup; Go/Rust manual wrap per call site) | TTFT 10 lines→2 | VERIFIED |
| S9 | TS `configureOtelExporter` swallows import errors in a void-async IIFE (otel.ts:22-50) — misconfig is invisible | debugging-time | VERIFIED |
| S10 | All SDKs default `sampling_profile="full"` with no ramp-down nudge (`config.py:185`, client.ts:712); Go/Rust have no sampling at all | 6–20× ingest cost at scale | VERIFIED |
| S11 | Python span_id uses `secrets.token_hex(8)` CSPRNG per span (trace.py:67) | ~1.5–2× span create | INFERRED mag. |
| S12 | Go `json.Marshal` full-copy per batch (client.go:211-218) vs streaming Encoder | ~2× GC pressure | INFERRED mag. |

### 2.2 LLM cost audit (COMPLETE — 12 findings)

Context: Aug-2026 collapse of all tiers onto `deepseek/deepseek-v4-flash-0731`
($0.09/$0.18 per 1M) means savings come from **call-count and context-size reduction**,
not model downtiering. Judges LLM path (`judges_llm_v1`) and evolution loop are off by
default — dormant cost bombs with weak daily ceilings.

| # | Finding | Impact | Status |
|---|---|---|---|
| L1 | In-process LLM LRU cache fully built but env-disabled (`llm/client.py:319`, `EDEN_LLM_INPROCESS_CACHE` absent from northflank.yml) | 20–35% of total internal spend, zero code | VERIFIED code / INFERRED rate |
| L2 | Annotator prompt 3× oversized: 80 events × 240 chars → ~1,050 tok/call for an 11-tag classification (`evaluation/annotator.py:141-164`) | 60–75% of annotator input | INFERRED |
| L3 | Soft-issue review sends 50×600-char digests + 100 detectors ≈ 11.7k tok/call, nightly × orgs × agents (`services/soft_issue_review.py:45-49`) | ~79% reducible; scales with org count | INFERRED |
| L4 | `cache_control` prompt caching is dead code — only fires for `anthropic/`/`claude-` prefixes; primary model is DeepSeek (`llm/client.py:382-388, 703-711`) | 90% on static prefixes if routed to a caching model | VERIFIED |
| L5 | Patch generator re-sends full static context (KG, style profile, source files ~2–5k tok) on critic-rejection retry (`patches/patch_generator.py:868, 1056-1087`) | ~40% of patch-gen input on retries | VERIFIED pattern |
| L6 | UnifiedJudge gated at 1.2% sampling + flags off — correct, but no daily token budget guard before enabling (`llmops/judges/_sampling.py:12`, config.py:717,721) | prevents 100× amplification | VERIFIED |
| L7 | Semantic-cache double-embed already fixed (`optimization/cache.py:306-353` memo) | done | VERIFIED |
| L8 | Annotator sample rate 10% default; tags are search-only — 2% suffices (`annotator.py:80-88`) | with L2: ~95% of annotator spend | VERIFIED flag |
| L9 | Evolution loop (off): 300s tick, per-tick $0.05 gate but no daily ceiling (`agents/evolution/loop.py:103`, `llmops/evolution_spend.py`) | cap before enable; 6× via 1800s tick | PARTIAL |
| L10 | Investigation agent: unbounded `context_blob` JSON into prompt (`autonomous/investigation.py:140-150`) | 33× spike on large incidents | INFERRED |
| L11 | Pattern clusterer: 1 LLM call per cluster for a 20-token label (`observability/patterns_clusterer.py:475`) | ~87% per labeling run via one batched call | VERIFIED pattern |
| L12 | Zero Batch API usage anywhere (no `messages/batches` refs); offline workloads (CLHF, synthetic data, rubric synthesis) eligible for 50% batch discount if routed Anthropic-direct | 50% on offline lanes | VERIFIED absence |

### 2.4 Data platform audit (COMPLETE — 7 findings)

Bench baselines: zstd-7 + 8KB dict = 15.0× (5k payloads, 9.30MB→620KB, median span
1,859B→~124B); Typesense 1.1M docs keyword p95 164ms; PG-ILIKE fallback p95 480ms @100k.

| # | Finding | Multiplier | Status |
|---|---|---|---|
| D1 | Dual-write plaintext JSONB **and** zstd BYTEA on every span — 5 plaintext + 8 compressed columns per row; flip guarded by `telemetry_plaintext_jsonb_write_enabled=True` (`telemetry_collector.py:1557-1615`, `config.py:1049`; `scripts/check_zstd_drop_prerequisites.py` exists) | **6–15× Neon bytes** | VERIFIED |
| D2 | Trace list re-aggregates all of `telemetry_events` per page load; `trace_summaries` (migration 167, benched **203ms→0.5ms = 418×**) is **fully wired end-to-end** (collector placeholder at telemetry_collector.py:615/816, recompute in trace_finalized_consumer.py:394/585, read path in routes/observability.py) but **dark behind `trace_summaries_read_v1=False`** (config.py:1222, no northflank override) — flag flip + backfill, not new code *(main-session re-verified; audit agent said "unwired" — wrong)* | **418× page query** | VERIFIED |
| D3 | N16 tail sampling fully implemented + tested, default profile `full` (100% keep); `balanced` = 15% keep with P0/P1 signals always kept (`config.py:979-985`, `sampling/policy.py:22-26`) | 5–10× storage | VERIFIED |
| D4 | TimescaleDB `add_retention_policy` + columnstore silently no-op on Neon (migration 166 live-probe note). **Correction (main-session verified):** `retention_cron.run()` IS hosted — cron_tick `_run_daily` fires at 03:00 UTC via the leader maintenance loop and cold-archives + purges `telemetry_events` per-org (cron_tick.py:133-142, retention_cron.py:78-133). Residual risk: verify ArchiveService S3 target configured in prod + purge actually keeping pace; native TSDB compression remains unavailable → D1 flip is the compression story | bounded-if-configured; audit needed, not rebuild | VERIFIED w/ correction |
| D5 | Full span bodies (input_text/output_text) shipped to BOTH Postgres and Tinybird (`telemetry_collector.py:1299`, `clickhouse_sink.py:892`); Tinybird only needs metrics columns | 2× analytics ingest | VERIFIED |
| D6 | pgvector 1536-dim embeddings; `text-embedding-3-small` supports MRL `dimensions=256` at >95% NDCG@10 (`storage/pgvector.py:72`, migration 001 `vector(1536)`) | 6× vector index size/speed | VERIFIED |
| D7 | PG-ILIKE span-search fallback p95 480ms @100k (bench); no GIN trigram insurance index | ~10–20× fallback | VERIFIED (bench) |

Coupling: D1 then D3 compound (dual-write off × sampling on). D2 requires indexer wired before read-path switch.

### 2.3 Portal frontend audit (COMPLETE — 12 findings; build measured)

Build (bun, Next 16.2.10/webpack, React 19): 2,666KB raw / **838KB gzip** JS across 95
chunks; CSS 110KB/19KB. Lists already virtualized; recharts/rrweb correctly code-split.

| # | Finding | Multiplier | Status |
|---|---|---|---|
| P1 | Polyfills chunk 110KB raw/38KB gzip on every page despite browserslist ≥Chrome/FF 111, Safari 16.4 | 3–4× parse on low-end | MEASURED |
| P2 | Every API call: browser → Vercel fn `/api/proxy/[...path]` → FastAPI; no Cache-Control forwarded, cold-start risk per call | 2–3× latency on data pages | VERIFIED |
| P3 | `use-org.tsx:580` polls org state every 20s unconditionally on every page | 6× org-health calls | VERIFIED |
| P4 | Notifications poll 30s when active (`use-notifications.tsx:54`); with P3 ≈23k req/day for 2 users vs 10k/day Upstash cap | 4–10× | VERIFIED |
| P5 | Recharts+d3 110KB gzip on chart pages for 4 simple charts (code-split correctly, but heavy) | ~60KB gzip if swapped | MEASURED |
| P6 | `/improve` fires 4+ mount-time queries with no RSC dehydration (home has it: `portal-dehydrate.ts`) | 2–3× TTI on /improve | VERIFIED |
| P7 | Portal read models unpaginated: `/portal/improve/plans`, `/portal/traces`, `/portal/agents` return everything (server supports limit/offset, unthreaded) | 10×+ payload for big orgs | VERIFIED |
| P8 | Main shared chunk 195KB raw unsplit; `OnboardingBanner` eagerly imported in app-shell even for completed tours | 1.5–2× mobile parse | INFERRED |
| P9 | SSE stream + hook (`use-observability-stream.ts`) fully built; traces page still polls (10s-on-empty) and 90s staleTime — no `trace:new` push | polling→0 + ~2s freshness | VERIFIED |
| P10 | Hardcoded `setTimeout 1200ms` after org creation waiting for Clerk sync (`use-org.tsx:306`); typical sync 200–400ms | 1.2s off first-run critical path | VERIFIED |
| P11 | Triple speculative scroll setTimeout 50/250/600ms in settings (`settings/page.tsx:335-337`) | jank fix | VERIFIED |
| P12 | 28/~30 page roots are `"use client"` — no RSC streaming; `*-client.tsx` split pattern exists but unused on most routes | 1.5–2× RSC payload | VERIFIED |

### 2.6 Architecture bloat audit (COMPLETE — 13 findings, command-verified)

Baseline: **299k Python LOC / 63 packages / 177 migrations / 124 route files / 823
endpoints / 411 config settings**; 9,452 tests collect in 20s.

| # | Finding | Size | Confidence |
|---|---|---|---|
| A1 | 245 of 411 config settings have zero external references (AST scan) | ~1,000 LOC | High |
| A2 | Three parallel LLM client layers: `llm/`, `llmops/ai_gateway`, `optimization/model_router` | ~3,200 LOC | High |
| A3 | Dead realtime: gRPC server (332 LOC), mobile SSE (426), ksqlDB (209) — zero imports | 1,096 LOC | High |
| A4 | 124 route files incl. 21 thin `intelligence_*` wrappers + prompts/prompts_v2 split | ~30 files | High |
| A5 | Four overlapping autonomy loops: `autonomous/`, `closed_loop/`, `improvement/`, `agents/evolution/` | ~5,000 LOC | Medium |
| A6 | `alerting/` package = one enum, one consumer (vs `alerts/`) | 111 LOC | High |
| A7 | `agent/` vs `agents/` naming collision (unrelated things) | 1 pkg | High |
| A8 | `eden.compliance` 39-LOC compat shim, zero imports | 39 LOC | High |
| A9 | Migration squash: 177 migrations, ~40% destructive of earlier ones | ~150 files | High |
| A10 | `evaluation/` (14.9k) + `experiments/` (4.6k) parallel runner classes | ~3,000 LOC | Medium |
| A11 | 11 micro-packages each with ≤2 external imports | ~4,300 LOC inlinable | High |
| A12 | 13 packages with zero unit tests (~15k LOC) — blocks safe consolidation | prerequisite | High |
| A13 | Startup eager-imports (kb_router 315ms + 23k-LOC observability etc.) drive 547ms app import + 20s pytest collect | 3–5s dev-loop | Medium |

Quick wins (<1 day, ~1,200 LOC, near-zero risk): A8 → A6 → A3 → A7.

### 2.1 Backend hot-path audit (COMPLETE — 10 findings; measured)

Measured: in-process ingest 5,955 events/s (168µs/event, mocked sinks); cold import 558ms
(importtime: 194ms route mounting, 74ms fastapi.openapi.models, kb router 317ms).

| # | Finding | Multiplier | Status |
|---|---|---|---|
| B1 | `trace_summaries_read_v1=False` in prod → traces list = 2 Neon round-trips of GROUP-BY scans (`routes/observability.py:675-800`); summary path already coded at :523-527 | ~10× busiest read (418× at query level) | VERIFIED |
| B2 | Leader locks burn **9,504 of 10,000/day Upstash commands**: 6 loops × 2 cmds × 720 ticks + 2 held locks (leader.py:78, background.py:66, sidecars.py:43); `pg_lease` Postgres fallback already proven in the July outage | ~20× Redis cmds → ~0 | VERIFIED (math) |
| B3 | `Cache.get()` = GET + PTTL, 2 Redis cmds per hit (`storage/redis.py:408-433`); `cached()` decorator bypasses L0 entirely | 2× Redis cmds on reads | VERIFIED |
| B4 | `_touch_agent_registrations` unconditional Neon UPSERT per ingest batch (`telemetry_collector.py:840,1037-1091`) — no cooldown | 5–50× fewer writes | VERIFIED |
| B5 | 558ms cold import on a pod that restarts often; kb route tree + eager openapi models; targets <200ms | ~3× startup | MEASURED |
| B6 | Per ingest batch: 3 fire-and-forget Neon writers + sequential per-span checkpoint loop (20 round-trips for 20-span batch) (`telemetry_collector.py:831-868`) | 3–5× pool pressure | VERIFIED |
| B7 | Tenant rate-limit = 1 Redis Lua EVAL per API request; in-process bucket exists as fallback; single-replica deploy → distributed limiting adds nothing (`middleware/tenant_rate_limit.py:379-411`) | 0–30% of Redis budget | VERIFIED |
| B8 | `compress_many` always thread-offloaded even for 1-event batches (~30-100µs dispatch vs 16µs work) (`telemetry_collector.py:1731-1733`) | 2–3× small-batch ingest | VERIFIED |
| B9 | Legacy traces path re-issues COUNT as second GROUP-BY round-trip (`observability.py:791-800`); window-function alternative | 2× round-trips | VERIFIED |
| B10 | `optimization/cache.py` eagerly imports redis.asyncio (46ms) + llm client at app import | 103ms/restart | MEASURED |

### 2.x Other audits — pending: onboarding/time-to-value

_Backend, LLM cost, portal, architecture, data platform, onboarding audits in flight._

## 3. The improvement program

_Pending._

## 4. Sequencing & dependencies

_Pending._

## 5. Measurement & regression guards

_Pending._
