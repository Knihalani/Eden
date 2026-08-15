# Eden — Order-of-Magnitude Improvement Plan (2026-08-12)

> **Status: COMPLETE.** Written by the main planning session; grounded in seven parallel
> code audits (72 findings) + fresh benchmark/test runs on this machine. Every claim
> carries a `verified` / `inferred` flag; two audit-agent claims were corrected against
> code before planning on them. This plan deliberately does NOT re-propose the in-flight
> autonomy waves (AUTONOMY-DEEP-AUDIT-WAVEPLAN-2026-08.md Waves 4–6 are mid-implementation
> in the working tree); it opens new order-of-magnitude axes.

## Executive summary — the ten headline OOMs

| # | Win | Multiplier | Cost |
|---|---|---|---|
| 1 | Flip `TRACE_SUMMARIES_READ_V1` + backfill — the portal's busiest query, machinery fully built and dark | **418×** query / ~10× page | 1 env var + backfill script |
| 2 | Postgres-primary leader election — locks alone burn ~95% of the 10k/day Upstash quota (root cause of a prior 7.4-day outage) | **~20×** Redis commands | M refactor, proven fallback |
| 3 | Stop plaintext+zstd dual-write on every span | **6–15×** Neon storage | flag + staged column drop |
| 4 | Demo data on signup — portal is empty until users instrument their own agent | **20×** time-to-first-value | 1 endpoint + webhook hook |
| 5 | Tail sampling `balanced` (built, tested, off) | **5–10×** storage at scale | staged org rollout |
| 6 | Enable the built-but-env-disabled in-process LLM cache | 20–35% of internal LLM spend | 1 env var |
| 7 | SSE (built, unused) replaces 3 polling loops | ~10× portal→API traffic, <2s freshness | M wiring |
| 8 | Go/Rust SDK parity: compression, retries, background queue | 10–15× wire bytes; ~50× Rust throughput; loss→~0 | S–M each |
| 9 | Python SDK hot path: stop double-encoding payloads | 56.7µs → <25µs per traced call | M |
| 10 | Consolidation: 245 dead settings, 3 LLM layers, ~1.2k LOC deletable day-one | ~10k LOC, −6 packages, import 547→<200ms | staged |

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

### 2.7 Onboarding / time-to-value audit (COMPLETE — 8 findings)

| # | Finding | KPI multiplier | Status |
|---|---|---|---|
| O1 | No demo/seed data for new orgs — empty Traces page until user wires their own agent (`grep seed_demo/demo_traces → 0`; `inject_synthetic_incident.py` is admin-CLI only; empty-state copy in `portal-polish.ts:53-65`) | time-to-first-value 45min→2min (**20×**) | VERIFIED |
| O2 | OTLP zero-SDK ingest exists (`POST /orgs/{org}/ingest/otel`, `ingestion.py:430`) but the `OTEL_EXPORTER_OTLP_ENDPOINT` env-var path is documented **nowhere** | unlocks zero-code-change enterprise migration | VERIFIED |
| O3 | ~~LangGraph has zero instrumentation in either SDK (13 Python / 10 TS frameworks covered, no langgraph.py/ts)~~ **DONE W2-12**: `langgraph.py` + TS `wrapLangGraph` shipped; matrix now 14 Python / 11 TS frameworks | ~60%→~85% new-build coverage | DONE |
| O4 | MCP server (32 tools) not on PyPI; hosted `/v1/mcp` gated off (`mcp_http_transport_v1=False`); install requires monorepo clone | IDE-wedge adoption 0→self-serve | VERIFIED |
| O5 | All notification channels silent by default: email only ≥P0/P1 (`alert_email.py:295-298`), Slack needs per-org OAuth, `sendkit_api_key=""` default — first detection lands in a bell icon nobody watches | detection→awareness loop closed | VERIFIED |
| O6 | Billing dormant: `PAID_PLANS_ENABLED=False` (`billing.py:64`); free 400-credit cap blocks ingest with **no upgrade path** → churn by design | revenue conversion 0→positive | VERIFIED |
| O7 | Changelog stops at SDK 0.3.2; shipped is 0.4.2 (both SDKs) — docs 2 minor versions stale | enterprise-eval trust | VERIFIED |
| O8 | MCP has no Resources or Prompts (2024-11-05 features) — tools-only surface | richer AI-native UX | VERIFIED |

_Backend, LLM cost, portal, architecture, data platform, onboarding audits in flight._

## 3. The improvement program

Eight tracks. Every item cites its evidence row (§2) and carries implementation detail,
verification steps, effort (S <½d, M ≤3d, L >3d), and risk. The single most important
meta-finding: **Eden's biggest multipliers are already built and dark** — the pattern
across audits is "shipped machinery, missing flag/wiring." Track 1 ships those first.

### Track 1 — Ship the dark 10–400× wins (flag flips + wiring; ~1 week total)

**1.1 Turn on the materialized trace read path (B1/D2 — 418× query, ~10× page).**
- *Change:* set `TRACE_SUMMARIES_READ_V1=true` (northflank env + config default flip once
  verified). The whole pipeline is already wired: placeholder upsert at
  `telemetry_collector.py:615/816`, recompute in `trace_finalized_consumer.py:585`,
  gated read in `routes/observability.py`.
- *Backfill:* one-shot script (new `scripts/backfill_trace_summaries.py`):
  `INSERT INTO trace_summaries (org_id, trace_id, started_at, …) SELECT tenant_id,
  trace_id, min(timestamp), … FROM telemetry_events GROUP BY tenant_id, trace_id
  ON CONFLICT (org_id, trace_id) DO NOTHING`, chunked by org via the existing
  `retention_archive_watermark` pattern to avoid one giant transaction on Neon.
- *Verify:* route returns identical payloads flag-on vs flag-off on a seeded org
  (add a parity test in `tests/unit/api/`); p50 of `GET /observability/traces` before/after
  in `bench/trace_summaries.py`. Watch `span_count>0` finalization invariants (collector
  code at :2434 already treats a summary row as the finalization marker — confirm no
  circular dependency when flag flips).
- Effort S. Risk: low (read-path fallback retained; flag can revert instantly).

**1.2 Enable the in-process LLM cache (L1 — 20–35% of internal LLM spend).**
- *Change:* `EDEN_LLM_INPROCESS_CACHE=1` in northflank env for API + worker;
  `EDEN_LLM_INPROCESS_CACHE_MAX=1024` for the worker. Zero code.
- *Verify:* the client already counts hits — expose `llm_cache_hit_total` on `/metrics`
  and check >10% hit rate after a week of background loops.
- Effort S. Risk: none (temp=0 calls only; key includes temperature).

**1.3 Kill the plaintext/zstd dual-write (D1 — 6–15× Neon bytes/row).**
- *Change:* run `scripts/check_zstd_drop_prerequisites.py`; fix any reader it flags to
  prefer `*_zstd`; then `EDEN_TELEMETRY_PLAINTEXT_JSONB_WRITE_ENABLED=0`. After a 2-week
  burn-in, ship the deferred migration-033 column drop (as migration 178) to reclaim
  space (`VACUUM FULL` alternative on Neon: create-copy-swap or rely on autovacuum + new
  rows being small).
- *Verify:* `pg_total_relation_size('telemetry_events')` growth rate before/after;
  trace-detail rendering byte-identical (existing decompression round-trip tests cover
  the zstd path; compression bench shows 0 round-trip errors).
- Effort S–M. Risk: medium — any reader still on plaintext returns NULLs; the check
  script + staged rollout (write-off before column-drop) contains it.

**1.4 Tail sampling default→`balanced` for opted-in orgs (D3 — 5–10× storage).**
- *Change:* keep global default `full`; add per-org `sampling_profile_override` rollout
  starting with dogfood orgs, then make `balanced` the default for NEW orgs (config +
  `orgs.py` new-org defaults). P0/P1 signal traces (errors/loops/slow/cost≥$0.50/forced)
  are always kept — the fast-path in `sampling/apply.py:179` already handles `full`.
- *Verify:* per-org kept/dropped counters (already emitted by the sampling module —
  surface on the cost page); confirm issue-detection recall unchanged on dogfood org for
  2 weeks (detectors run on kept + signal traces by design).
- Effort S–M. Risk: medium (data you didn't keep is gone) — hence opt-in + new-org-only
  default, never retroactive.

**1.5 Replace portal polling with the already-built SSE channel (P3/P4/P9).**
- *Change:* (a) `use-org.tsx:580` interval 20s→120s immediately (one line);
  (b) wire `useObservabilityStream` into `traces-client.tsx`: on `trace:new` →
  `queryClient.invalidateQueries(queryKeys.portal.traces(orgId))`; (c) emit
  `notification:new` on the same stream from the backend notification writer
  (`services/` notification insert site) and invalidate `["notifications"]`, removing the
  30s poll; keep a 5-min fallback poll for SSE-failure degradation.
- *Verify:* proxy request count per active user session (count in Vercel logs or a dev
  HAR): target 23k/day→<2k/day for 2 users; new-trace visibility latency <2s.
- Effort M. Risk: low (SSE hook has reconnect/backoff; fallback poll retained).

### Track 2 — Reclaim the Redis budget (prevents the next multi-day silent outage)

**2.1 Postgres-primary leader election (B2 — ~9.5k of 10k daily Upstash cmds → ~0).**
- *Change:* in `workers/leader.py` `_acquire_with_fallback`, invert priority: try
  `pg_lease` (proven during the July outage) first for all 6 `run_if_leader` loops; same
  for the bundle lock (`background.py`) and sidecar guard (`sidecars.py`). Redis becomes
  the fallback when Postgres is unavailable. Keep tick alignment (`align=True` grid) so
  the Neon-quiet window is preserved — the lease INSERT rides the same grid tick that
  already touches Postgres, so **net-new Neon wakeups: zero**.
- *Verify:* Upstash daily command count (dashboard) drops >90%; leader single-holder
  invariant tested via the existing `eden_leader_leases` conflict tests; chaos test:
  kill -9 the holder, next pod acquires within TTL.
- Effort M. Risk: medium (leadership is safety-critical) — mitigated by keeping the
  exact `pg_lease` semantics that already ran in production.

**2.2 Single-command cache reads (B3 — 2× Redis on every read).**
- *Change:* replace GET+PTTL in `storage/redis.py:408-433` with one Lua
  `{GET, PTTL}` script (option B from audit — preserves the short-TTL L0 correctness the
  PTTL was added for); make the `cached()` decorator route through the L0 layer.
- *Verify:* unit tests for L0 TTL inheritance; Redis cmd counter per cache read == 1.
- Effort S. Risk: low.

**2.3 In-process rate limiting on single-replica deploys (B7).**
- *Change:* default `tenant_rate_limit` to the existing in-process `TokenBucket`; use the
  Redis sliding-window Lua only when `TENANT_RATE_LIMIT_DISTRIBUTED=true` (new setting,
  default false; set true automatically if `deployment.instances > 1` ever ships).
- Effort S. Risk: low (single replica ⇒ semantics identical).

### Track 3 — Ingest & Neon write efficiency

**3.1 Agent-registration touch cooldown (B4 — 5–50× fewer UPSERTs).** Module-level
`dict[(org_id, agent_id) → monotonic]` in `telemetry_collector._touch_agent_registrations`
skipping entries touched <300s ago; prune opportunistically. Test: two batches 100ms
apart → one write. Effort S.

**3.2 Batch the checkpoint + billing background writers (B6).** Add
`maybe_persist_checkpoints_batch(events)` (evaluate thresholds in Python, one
`executemany`); buffer `_emit_billing_events` rows in-memory and flush every 30s / 500
rows via the existing `_ch_flush_loop` pattern (flush on shutdown is already handled by
the collector drain). Test: 20-span batch → ≤2 Neon round-trips background. Effort M.

**3.3 Compression offload threshold (B8).** `if len(flat_fields) < 4: compress_many(...)`
sync else `asyncio.to_thread` — mirrors `maybe_gunzip_body_async`'s
`_GZIP_OFFLOAD_BYTES` pattern. Bench with `bench/ingest_batch_path.py` at batch=1 and
batch=50. Effort S.

**3.4 Metrics-only Tinybird projection (D5 — 2× analytics ingest).** In
`clickhouse_sink.ingest_agent_traces` row builder, strip `input_text`/`output_text`
(keep tokens/cost/latency/outcome/model/tool_names). Audit Tinybird pipes first
(`_query_home_kpis_pipe` etc.) for any content-column reads — grep the pipe SQL in the
repo/Tinybird workspace; if topics/insights need text, point them at Postgres zstd
columns instead. Effort S–M. Risk: low after pipe audit.

**3.5 Legacy COUNT elimination (B9 — moot once 1.1 sticks).** If the legacy path must
stay for rollback, fold COUNT into the page query with `count(*) OVER ()`. Effort S.

### Track 4 — SDK program (customer-visible overhead, reliability, adoption)

**4.1 Go SDK to parity (S1/S7/S12).** gzip-1 (stdlib) with `Content-Encoding: gzip`
(server already accepts), 3-attempt exponential backoff honoring `Retry-After`,
`json.Encoder` into a shared `bytes.Buffer`. 10–15× wire bytes + eliminates silent batch
loss. Effort S–M.

**4.2 Rust SDK background queue (S2 — ~50× throughput).** `tokio::mpsc::unbounded_channel`
+ spawned drain task batching ≤50 events/500ms, non-blocking `trace()`; graceful flush on
`Client::shutdown()`. Effort M.

**4.3 Python hot-path fixes (S3/S4/S11 — measured 56.7µs → target <25µs per traced call).**
Defer truncation-size measurement to the sender thread (pass raw objects through
`enqueue()`; apply `capture_limits` + single `dumps_bytes` there); thread `cfg` from
`trace()` into `_emit_trace_event` (kills 2nd lock); short-circuit live-mode check when
`cfg.live` false and no stream; `uuid.uuid4().hex[:16]` span ids. Re-run the S-audit
micro-bench as a perf test with a generous gate (e.g. median <35µs) so regressions fail CI.
Effort M.

**4.4 TS SDK: Node zstd + surfaced OTel errors (S6/S9).** Optional dep
`@nicolo-ribaudo/zstd-wasm` (dynamic import, fall back gzip); make
`configureOtelExporter` return a Promise that rejects on missing peer deps. (Skip the
fast-serializer swap S5 until profiling justifies it — V8 stringify is rarely the
bottleneck vs compression.) Effort S–M.

**4.5 LangGraph instrumentation, both SDKs (O3 — coverage 60%→85%).** New
`instrumentations/langgraph.py` patching `CompiledGraph` invoke/stream to emit
`graph.node_start/end` spans with node names + state keys (pattern: `pydantic_ai.py`);
TS mirror. Register in `eden.instrument()` matrix + docs matrix. Effort M each.

**4.6 Sampling posture nudge (S10).** `eden-doctor` warns when `sent_total>10k` and
profile is `full`, recommending `balanced` (pairs with 1.4). Effort S.

### Track 5 — Portal performance & UX

**5.1 Polyfill diet (P1 — 38KB gzip off every page).** Audit
`polyfills-*.js` with source-map-explorer; given browserslist ≥111/16.4, drop to the
minimal Next polyfill set. Verify with fresh build chunk listing. Effort S–M.
**5.2 CDN caching + RSC prefetch (P2/P6).** Proxy: forward
`Cache-Control: private, max-age=15` on idempotent GETs (traces/agents lists);
`/improve`: add `dehydrateImprove(orgId)` in the RSC page mirroring `portal-dehydrate.ts`
(prefetch agents+plans+queue in parallel server-side). Target: /improve TTI −2 round
trips. Effort M.
**5.3 Paginate the portal read models (P7).** Thread `limit=50` + cursor through
`/portal/traces`, `/portal/improve/plans`, `/portal/agents` (server caps exist at
`resources.ts:1751`); infinite-scroll on /improve reusing the `useInfiniteQuery` pattern
from `issues-client.tsx:587`. Effort M.
**5.4 RSC-ify page roots (P12).** Convert the 28 `"use client"` page roots to server
components with `*-client.tsx` islands (pattern already exists on /traces). Do the top-5
traffic routes first (home, traces, issues, improve, agents). Effort M–L, incremental.
**5.5 First-run fixes (P10/P11/P8).** Replace the 1.2s Clerk-sync sleep with a 100ms
exponential poll of `api.getOrg(newOrgId)`; single MutationObserver-based scroll in
settings; lazy-load `OnboardingBanner` when `tourState==='complete'`. Effort S each.

### Track 6 — Time-to-value & growth (the adoption OOMs)

**6.1 Demo data on signup (O1 — 20× time-to-first-value).** New
`POST /internal/onboarding/{org_id}/seed-demo` (behind the existing
`_require_onboarding_v2_enabled` guard) generating ~12 synthetic traces across 3 demo
agents + 1 seeded issue + 1 improvement-plan draft, reusing `inject_synthetic_incident.py`
internals; call it from the Clerk `organization.created` webhook (`clerk_webhooks.py:343`);
portal shows a dismissible "Demo data" banner; auto-purge when first real trace arrives
(hook the `first_10_traces` milestone). The new user sees a working product — traces,
a detected issue, and a proposed fix — before writing any code. Effort M.
**6.2 Document the OTLP env-var path (O2).** One docs section + a `docs/` tutorial
"Migrate from any OTel stack in 2 env vars"; add an integration test hitting
`/ingest/otel` with a stock `opentelemetry-exporter-otlp-proto-http` payload. Effort S.
**6.3 MCP as the IDE wedge (O4/O8).** Publish standalone `eden-mcp` to PyPI (thin
wrapper around `eden.mcp_server`, own pyproject, no platform deps beyond httpx) so
`uvx eden-mcp` works; flip `mcp_http_transport_v1=True` for the hosted endpoint; add
`resources/list|read` (`eden://orgs/{org}/traces/{id}`) + 3 prompts (`triage_issue`,
`explain_trace`, `summarize_cost`). Effort M.
**6.4 Close the detection→awareness loop (O5).** First-detection email regardless of
severity (24h org dedupe, opt-out checkbox in tour "Get started" step, stored in org
notification prefs); verify `SENDKIT_API_KEY` set in prod; empty-key startup warning in
self_obs probes. Effort S–M.
**6.5 Enable billing (O6 — churn-by-design → conversion).** Ops: wire Stripe keys, flip
`PAID_PLANS_ENABLED=True`, e2e the subscribe flow in test mode; product: usage meter on
the cost page + soft-cap (320/400 credits) warning email actually firing. Code risk low —
plan definitions/check_limit/Stripe wiring exist. Effort M (mostly ops).
**6.6 Docs freshness gate (O7).** Write the 0.4.x changelog section; CI check comparing
`eden_sdk.__version__` to the newest changelog heading. Effort S.

### Track 7 — LLM cost scaling posture (multipliers that matter at 100× volume)

7.1 Annotator: `max_chars 3500→1000`, `events[:80]→[:25]`, sample 10%→2%
(L2/L8 — ~95% of annotator spend combined). Effort S.
7.2 Soft-issue review: `_MAX_DIGEST_CHARS 600→200`, `_MAX_TRACES_PER_ORG 50→20`
(L3 — ~79% of that lane). Effort S.
7.3 Truncate investigation `context_blob` to 8k chars before prompt render (L10). Effort S.
7.4 Batch pattern-cluster labeling into one call returning a JSON array (L11). Effort S.
7.5 Hard daily budgets before any dormant lane is enabled: `JUDGES_DAILY_BUDGET_USD`,
`EVOLUTION_DAILY_BUDGET_USD` enforced in `evolution_spend.py`-style gates; evolution tick
300s→1800s (L6/L9). Effort S–M.
7.6 Caching/batch lanes: route patch-gen + judges to a `cache_control`-capable model when
quality demands it (L4/L5 — the code already handles Anthropic prefixes); keep the static
prefix stable across critic retries so the cache (or L1's in-process cache) can hit; add
an Anthropic-direct Batch API client for offline lanes (CLHF, synthetic data, rubric
synthesis) at 50% discount (L12). Effort M–L, sequenced last (needs model-quality evals).

### Track 8 — Codebase consolidation (engineering-velocity OOM)

8.1 **Day-one deletions (~1,200 LOC, near-zero risk):** `eden.compliance` shim (A8),
`alerting/` merge into `alerts/` (A6), dead realtime gRPC/mobile-SSE/ksqlDB files +
their 4 shutdown-registry entries (A3), `agent/`→`agents/` rename (A7). Gate each with
the 6,055-test suite. Effort S.
8.2 **Config prune (A1):** delete the 245 zero-reference settings in batches of ~50 with
the AST scan re-run in CI as a `sweep_dead_functions.py`-style guard; removes ~1,000 LOC
from the 411-setting config and shrinks the northflank env surface (F-J stale vars go
with it). Effort M.
8.3 **One LLM client layer (A2):** fold `llmops/ai_gateway` + `optimization/model_router`
capabilities (routing/fallback/counters) into `eden.llm.client` behind its existing
interface; the DeepSeek-collapse (§2.2 note) already made the router's tiering dead.
~3,200 LOC → ~1,200. Effort L; prerequisite 8.7 for untested corners.
8.4 **Route consolidation (A4):** collapse the 21 `intelligence_*` thin wrappers into
domain routers; merge prompts/prompts_v2 route split (aligns with the in-flight A4
registry unification). Cuts app-import route-mount time (194ms self-time) too. Effort M.
8.5 **evaluation/ + experiments/ runner merge (A10):** single runner API; keep both
route surfaces temporarily. Effort L.
8.6 **Migration squash (A9):** squash 001–160 into a base revision for fresh installs
(Alembic `stamp` for existing DBs); cuts in-lifespan Alembic boot time and 150 files.
Do after 171-era churn settles. Effort M.
8.7 **Test the 13 untested packages (A12):** minimum smoke + contract tests (~15k LOC at
risk) — prerequisite for 8.3/8.5. Effort L, parallelizable.
8.8 **Startup <200ms (B5/B10/A13):** lazy `redis.asyncio`/`llm.client` imports in
`optimization/cache.py`; TYPE_CHECKING-guard `fastapi.openapi.models` imports; defer the
kb router via the existing deferred-routers pattern. Verify with `bench/startup.py`
(547ms→<200ms target). Effort M.

### Track 9 — Close the loop for real + product honesty (integrated from the 2026-08-12 P0–P3 product review)

Spot-verified this session where marked; the rest carries the reviewer's claim and a
verify-first step. Overlapping items were folded into Tracks 6 (see cross-refs) rather
than duplicated.

**9.1 (P0) Eval-delta on Improve plans/PRs — the wedge vs LangSmith.**
`improvement/approve.py` contains **zero** judge/score/delta references (verified) — PR
bodies ship without "this fix moved judge X by Y". *Change:* at plan-approve/PR-open time,
query judge scores for the agent over the pre-window vs replay/canary results (the
EvidenceGate + `judge_scores` machinery from the autonomy waves already computes exactly
this), render a delta table into the PR body + plan detail evidence block. Depends on the
in-flight Wave A prompt-version stamping for the prompt lane; the code-patch lane can use
replay-verify results immediately. Effort M. **Make this the default PR body.**

**9.2 (P0) Failure-fixture export in portal + real `eden debugger replay` CLI.**
Backend/MCP fixture export exists (docs promise portal + CLI); no portal TSX export
surface, no CLI entrypoint. *Change:* portal "Export fixture" button on trace/issue detail
calling the existing export route; `eden-debugger` console script in the SDK (or
`python -m eden_sdk.replay`) that loads a fixture and re-runs it locally against recorded
tool results. Effort M. This is the cheap-replay pain point; pairs with 9.3.

**9.3 (P0) One-click fork/replay from the failing span on an issue.** Time-travel is
shipped; the issue → Improve path doesn't start from the failing span. *Change:* deep-link
button on the issue occurrence row → debugger session seeded at that span's checkpoint
(`debugger/checkpoints.py` — note the `id`→`event_id` fix from the autonomy plan must land
first), with "propose fix from here" creating the improvement-plan draft pre-scoped to
that agent+span. Effort M. Glue, not new machinery.

**9.4 (P0) Improve UX parity with the API.** Server has `POST /plans/{plan_id}/snooze`
(verified in `routes/improve.py`) — portal `/improve` doesn't expose it; approve flow can
only create + merge/close, not iterate an open fix PR. *Change:* snooze action on plan
cards (mutation + `snoozed_until` chip); "request changes" on an open PR plan → new
guardian iteration commit on the same branch (guardian already supports follow-up via
`parent_plan_id`). Effort S–M.

**9.5 (P1) Docs/flag honesty pass.** Deleted Cat-23 package still documented; stale
claims: F65 labeling, "13 frameworks" (Mastra no-op), compose-as-prod. Fold into 6.6's
freshness gate: one sweep now + CI doc-drift checks for flag-vs-docs claims (grep docs
for feature-flag names, fail on defaults contradicting prose). Beta trust dies on
overclaiming faster than on missing features. Effort S–M.

**9.6 (P1) OTel GA path (expands 6.2).** JSON OTLP works; reviewer reports protobuf 415s,
gRPC off, dual-emit off, hard-coded tenant. `ingestion.py` references
`application/x-otel-protobuf` support, so **verify at runtime first** (integration test
with stock OTLP-proto exporter — same test as 6.2), then fix whichever of
{protobuf parsing, tenant resolution from headers, dual-emit flag} actually fails.
gRPC stays out of scope (Northflank single HTTP port) — document HTTP-only honestly.
Effort M after verification.

**9.7 (P1) `judge.regression` outbound webhook.** Docs claim it; wide internal usage of
the event name exists (config, promotion_hooks, closed_loop_executor — verified grep) but
reviewer found no outbound webhook emitter. *Change:* emit through the existing
`services/webhook_delivery.py` service on judge-regression detection; contract test
asserting delivery. Effort S.

**9.8 (P1) Prompt canary UI on /prompts.** Note: `canary-cockpit.tsx` is already
uncommitted-in-flight (autonomy Wave 5) on `/improve`. Do NOT build twice — extend the
cockpit with a traffic-split editor and surface it from `/prompts` too. Effort S–M after
the autonomy branch lands.

**9.9 (P1) Custom dashboard builder.** Dashboard CRUD + home exist; widget builder
missing; NL auto-builder returns 501. *Change:* v1 = widget grid over the existing
query endpoints (metric picker + timerange + groupby, reusing the dataviz components
already in the portal); wire the NL builder to the existing EQL/insights endpoints or
remove the 501 route until real. Effort L — schedule Wave 3; it's the Langfuse
most-requested class.

**9.10 (P2) Deterministic judges as a portal product.** Scorers live in playground/CI;
docs' `/v1/judges` + `kind: deterministic` CRUD don't match code. Decide: ship the CRUD
(map onto metric_studio registry) or rewrite docs (fold into 9.5's honesty pass) — default
to docs-fix now, CRUD in Wave 3. Effort S now / L later.

**9.11 (P2) MCP improve-loop GA + coding-agent SKILL.md (expands 6.3).** Beyond
PyPI + hosted transport: ship a `SKILL.md` (agent-facing runbook: find issue → fixture →
replay → propose plan → approve) so Claude Code/Cursor agents can drive the loop
end-to-end. Braintrust/Weave are shipping this narrative. Effort S on top of 6.3.

**9.12 (P2) Multi-agent graph on the trace.** Data/tables exist; `/multi-agent`
soft-lands; tutorial overclaims an Agent Graph tab. v1 = render the existing handoff
edges as a graph panel on trace detail (client-side dagre/elk over data already in the
payload); fix the tutorial in 9.5 meanwhile. Effort M–L.

**9.13 (P2) GDPR RTBF fanout on.** `rtbf_fanout_v1: bool = False` (**verified**,
config.py:1264 comment says fanout targets are real in
`services/governance_intel/rtbf_fanout.py`). *Change:* integration-test each fanout leg
(Typesense/Redis/CH/S3 — drop the Qdrant leg per pgvector migration), then flip the flag.
Blocks EU deals otherwise. Effort S–M.

**9.14 (P2) Gateway circuit-breaker honesty.** Breaker wraps the internal LLM client,
not clearly the public `/gateway/v1`. Verify with a fault-injection test; either wire the
breaker middleware onto the gateway route or remove the claim (9.5). Effort S–M.

**9.15 (P3) Trace bookmarks.** Cheap (`trace_bookmarks` table + star toggle on list rows
+ "Starred" filter), not differentiating — schedule opportunistically or deal-driven.
Effort S.

## 4. Execution structure — parallel waves

### Execution model

- **One item = one owner (human or agent) = one worktree = one PR.** Items inside a wave
  are **file-disjoint by construction** (ownership manifest below), so a wave can be
  executed by N parallel agents with zero merge conflicts. Where two logical items shared
  a file, they were bundled into a single work item.
- **Gates per PR:** full unit suite green (6,055 tests, 288s) + the relevant bench guard
  from §5 + `git diff`-scoped review. No PR may touch files outside its manifest line.
- **Env flips are ops steps, not PRs** — executed between waves, each with a stated
  rollback (revert the env var). Northflank.yml has a single owner per wave to avoid
  manifest conflicts.
- **Two shared-file conventions:** `config.py` — new settings are append-only at the end
  of the relevant section (trivial rebases); `query-keys.ts`/`resources.ts` — same.
- **Continuous lane (runs alongside every wave):** 8.7 test-backfill for the 13 untested
  packages — additive test files only, never conflicts; staffed at whatever capacity is
  spare. It gates Wave 4's big refactors.
- The in-flight autonomy branch (Waves 4–6, uncommitted) merges first; everything below
  is file-disjoint from it except where noted (1.4, 9.3, 9.8 explicitly wait for it).

### Wave 0 — ops only (hours, no code)

| Item | Action | Rollback |
|---|---|---|
| 1.2 | `EDEN_LLM_INPROCESS_CACHE=1` (+`_MAX=1024` on worker) | unset |
| 1.1a | Run `scripts/backfill_trace_summaries.py` (write it as the wave's one code PR — new file, conflicts with nothing) | table is additive |
| 1.1b | After backfill parity check: `TRACE_SUMMARIES_READ_V1=true` | set false |

### Wave 1 — 18 parallel items (all file-disjoint)

| # | Item | Owned files (exclusive) |
|---|---|---|
| W1-1 | 2.2 single-command cache reads | `storage/redis.py` |
| W1-2 | 2.3 in-process rate limit default | `api/middleware/tenant_rate_limit.py` |
| W1-3 | 3.1+3.2+3.3 **collector bundle** (touch cooldown, batched checkpoint/billing writers, compress threshold — one owner because all live in the same file) | `observability/telemetry_collector.py`, `debugger/checkpoint_hook.py` |
| W1-4 | 3.4 Tinybird metrics-only projection | `data_platform/clickhouse_sink.py` |
| W1-5 | 7.1 annotator context+sample cut | `evaluation/annotator.py` |
| W1-6 | 7.2 soft-issue digest cut | `services/soft_issue_review.py` |
| W1-7 | 7.3 investigation context truncation | `autonomous/investigation.py` |
| W1-8 | 7.4 batched cluster labeling | `observability/patterns_clusterer.py` |
| W1-9 | 8.1 dead-code deletions (compliance, alerting→alerts, realtime gRPC/SSE/ksqlDB, agent/→agents/) | the deleted packages + their import sites |
| W1-10 | 9.7 judge.regression outbound webhook | `services/webhook_delivery.py` call site + regression-detection site |
| W1-11 | 9.5+6.6 docs honesty sweep + changelog 0.4.x + doc-drift CI | `docs/**`, one CI workflow file |
| W1-12 | 6.2+9.6a OTLP env-var docs + **runtime verification test** (stock proto exporter → /ingest/otel; decides 9.6b scope) | `docs/how-to/connect-any-agent.md`, `tests/integration/test_otlp_ingest.py` |
| W1-13 | 5.5 first-run fixes (1.2s sleep→poll, scroll observer, lazy banner) | `hooks/use-org.tsx`, `settings/page.tsx`, `components/shell/app-shell.tsx` |
| W1-14 | 4.1 Go SDK (gzip, retries, Encoder) | `sdk/go/**` |
| W1-15 | 4.2 Rust SDK background queue | `sdk/rust/**` |
| W1-16 | 4.3 Python SDK hot path + perf gate | `sdk/python/eden_sdk/{trace,capture,config}.py`, `sdk/python/tests/perf` |
| W1-17 | 4.4 TS SDK (Node zstd, OTel errors) | `sdk/ts-ai/src/{client,otel}.ts` |
| W1-18 | 9.13 RTBF fanout per-leg tests → flip `rtbf_fanout_v1` | `services/governance_intel/rtbf_fanout.py` tests + config line |

**End-of-wave ops:** 1.3a run `check_zstd_drop_prerequisites.py`; 7.1/7.2 constants are in
their PRs; verify Upstash daily count after W1-1/W1-2.

### Wave 2 — 12 parallel items

| # | Item | Owned files | Waits for |
|---|---|---|---|
| W2-1 | 2.1 Postgres-primary leader election | `workers/{leader,background,sidecars}.py`, `storage/pg_lease.py` | — |
| W2-2 | 1.3b dual-write off (env) + reader fixes the check script flagged | flagged readers only | 1.3a result |
| W2-3 | 1.5 SSE wiring (traces + notifications), remove polls | `traces-client.tsx`, `hooks/use-observability-stream.ts`, `hooks/use-notifications.tsx`, backend notification emit site | W2-1 (Redis headroom) |
| W2-4 | 5.1 polyfill diet | `next.config.ts`, browserslist | — |
| W2-5 | 5.2+5.3+9.4 **/improve bundle** (RSC prefetch, pagination, snooze UI, PR-iterate — one owner: same page tree) | `app/(portal)/improve/**`, `lib/portal-dehydrate.ts`, portal read-model routes | — |
| W2-6 | 6.1 demo-data seeding | new `api/routes/onboarding_seed.py`, `clerk_webhooks.py:343` hook, demo banner component | — |
| W2-7 | 6.4 first-detection email | `services/alert_email.py`, tour Get-started panel | — |
| W2-8 | 9.1 eval-delta on plans/PRs (code-patch lane now; prompt lane when Wave-A stamping lands) | `improvement/approve.py`, PR-body template, plan-detail evidence block | autonomy branch merged |
| W2-9 | 9.2 fixture export UI + `eden-debugger replay` CLI | trace/issue detail export button, `sdk/python/eden_sdk/replay.py` | — |
| W2-10 | 8.2 config prune (batch 1: 245→~300 remaining) + stale northflank vars | `config.py`, `northflank.yml` | all W1 merged (append-only window closes) |
| W2-11 | 8.8 startup lazy imports (<200ms) | `optimization/cache.py`, `api/app.py` import sites | — |
| W2-12 | 4.5+4.6 LangGraph instrumentation + doctor sampling nudge | `sdk/*/instrumentations/langgraph.*`, doctor modules | **DONE** |

**End-of-wave ops:** 9.6b decision from W1-12's test (fix protobuf/tenant legs if broken —
becomes a W3 item only if needed).

### Wave 3 — 11 parallel items

| # | Item | Owned files | Waits for |
|---|---|---|---|
| W3-1 | 1.4 sampling `balanced` rollout (dogfood → new-org default) | `orgs.py` defaults, cost-page counters | autonomy branch |
| W3-2 | 5.4 RSC-ify top-5 page roots | the 5 page trees (serialized internally, parallel to everything else) | W2-5 |
| W3-3 | 6.3+9.11 MCP PyPI + hosted transport + Resources/Prompts + SKILL.md | `mcp_server/**`, new `packages/eden-mcp/` | — |
| W3-4 | 6.5 billing enablement | `billing.py`, Stripe config, usage-meter UI | ops decision |
| W3-5 | 7.5 daily LLM budget caps + evolution tick | `llmops/evolution_spend.py`, budget gates | — |
| W3-6 | 8.4 route consolidation (21 intelligence_* wrappers) | `api/routes/intelligence_*` | W2-10 |
| W3-7 | 8.6 migration squash 001–160 | `db_migrations/versions/**` | schema churn settled |
| W3-8 | 9.3 issue→span fork/replay glue | issue detail UI, debugger deep-link | checkpoint id fix (autonomy F-B) |
| W3-9 | 9.8 canary traffic-split UI on /prompts | extends `canary-cockpit.tsx` | autonomy branch |
| W3-10 | 9.9 dashboard widget builder v1 (+ un-501 or remove NL builder) | dashboards page tree, dashboard routes | — |
| W3-11 | 9.14 gateway breaker verify→wire | gateway route + fault-injection test | — |

### Wave 4 — long-poles (parallel, each gated on the continuous test lane)

| # | Item | Waits for |
|---|---|---|
| W4-1 | 8.3 single LLM client layer (~3,200→1,200 LOC) | 8.7 coverage of llmops/optimization |
| W4-2 | 8.5 evaluation/experiments runner merge | 8.7 coverage |
| W4-3 | 7.6 caching-model routing + Anthropic Batch API offline lanes | quality evals |
| W4-4 | 9.10 deterministic-judges CRUD (docs-fix already shipped in W1-11) | metric_studio stability |
| W4-5 | 9.12 multi-agent graph panel on trace detail | — |
| W4-6 | 9.15 trace bookmarks | opportunistic |

### Dependency spine (why the waves are ordered this way)

1.1 backfill → read flag · 1.3 check → write-off → (2-week burn-in) → column-drop
migration · 2.1 frees the Redis budget that 1.5's SSE + invalidation traffic would
otherwise compete with · W1 SDK PRs before 4.5 (same directories) · 8.2 config prune
after W1 (everyone stops appending) · 8.7 continuous lane gates W4-1/W4-2 · autonomy
branch gates 1.4, 9.1-prompt-lane, 9.3, 9.8 · 6.1 demo data before any marketing push.

## 5. Measurement & regression guards

| Metric | Baseline (verified 2026-08-12) | Target | Guard |
|---|---|---|---|
| Traces list query | ~203ms (bench, 20k traces) | ~0.5ms (418×) | `bench/trace_summaries.py` in CI vs threshold |
| Upstash commands/day | ~9.5k from locks alone (math from code constants) | <500 total | daily counter alert in self_obs |
| Neon bytes/span | dual-write ≈ raw+compressed (~15× overweight) | compressed-only | `pg_total_relation_size` weekly probe |
| Storage kept traces | 100% | 15% + all P0/P1 signals (opted orgs) | sampling counters on cost page |
| Internal LLM calls | no cache | >10% cache-hit | `llm_cache_hit_total` metric |
| Python SDK traced-call overhead | 56.7µs median (measured) | <35µs gate, ~25µs target | new perf test in sdk/python/tests |
| Go SDK wire bytes | uncompressed | gzip ≥5× | sdk/go unit test asserts Content-Encoding |
| App cold import | 547ms (bench) | <200ms | `bench/startup.py` in CI |
| Portal JS (every page) | 838KB gzip total, 38KB polyfills | −35KB polyfills; measure per-route | build-size budget check (F82 exists as spec) |
| Proxy requests / active user / day | ~11.5k (2-user math) | <1k | Vercel log sampling |
| Time-to-first-value | ~45min (instrument own agent) | ~2min (demo data) | onboarding milestone timestamps |
| Config settings | 411 (245 dead) | ≤170 | AST zero-ref scan in CI |
| Python LOC | 299k / 63 packages | −8–12k LOC, −6 packages | wc in CI report |
| Unit suite | 6,055 pass / 288s | stays green, <360s | CI |
| PR bodies with judge-score delta | 0% (approve.py has zero judge refs — verified) | 100% of guardian PRs | contract test on PR body template |
| Docs claims vs flags | ≥6 stale claims (P0–P3 review) | 0 | doc-drift CI check (9.5) |
| RTBF fanout | `rtbf_fanout_v1=False` (verified) | on, all legs tested | integration test per leg |

## 6. Verification log (what was actually run this session)

- `bench.run_all` fresh: compression 15.0× @35k ops/s, /health p50 0.90ms, app import
  ~547ms (results `bench/results/20260812-015544.json`).
- `pytest tests/unit`: **6,055 passed, 14 skipped, 1 xfailed, 288s**.
- Python SDK micro-bench (subagent, commands in §2.5): 6.2µs raw span, 56.7µs full
  `trace()`, 25.4µs emit (4.1× raw).
- Portal `bun run build`: 2,666KB raw / 838KB gzip JS, polyfills chunk 110KB/38KB.
- Main-session code verification: trace_summaries wiring end-to-end + flag default
  (config.py:1222, zero northflank override); retention actually hosted daily at 03:00 UTC
  via leader maintenance (corrected agent claim); `EDEN_LLM_INPROCESS_CACHE` absent from
  northflank.yml; migration 167 DDL + indexes read directly.
- Upstash math cross-checked against code constants (leader.py:78-79, background.py:66-67,
  sidecars.py:43-44, northflank `REDIS_LEADER_TICK_SECONDS=120`).

*Written by the main planning session. Sub-agent findings were spot-verified; two agent
claims were corrected against code (D2 "unwired" → wired-but-dark; D4 "retention never
called" → hosted daily, TSDB-native paths no-op).*
