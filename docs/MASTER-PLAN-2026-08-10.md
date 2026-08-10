# Eden — Finalized Master Plan (2026-08-10)

The definitive, point-by-point execution plan. Consolidates every audit pass
(A–N in `docs/optimization-plan-2026-08.md`, §1–10 in
`docs/EXHAUSTIVE-AUDIT-2026-08-10.md`) plus this final innovation pass (O).

Every item is **measured** — each fix lists its verified baseline, the expected
gain, the exact files, and how to verify it. Items are ordered by **impact ÷
effort** within their priority tier.

Legend: 🔴 P0 (costs money / breaks now) · 🟠 P1 (clear waste, safe) ·
🟡 P2 (nice-to-have) · 🟢 P3 (hygiene).

---

## Part 1 — Active cost & broken things (fix first)

### 🔴 P0-1 · Stop the Redis command burn (the only active $ loss)
**Baseline:** Upstash 500k commands/9d = **55k/day vs 10k free tier**. Root
cause: `XREADGROUP` consumers don't sleep on empty (Upstash ignores `BLOCK`),
leader renews every 20 s.

| Step | File | Change | Verify |
|---|---|---|---|
| 1.1 | `workers/trace_finalized_consumer.py` | ✅ **timing-based** sleep-on-empty (sleep remainder of `block_ms` when server ignores BLOCK — self-adapting, ≤10k/day on Upstash; a flat 1.0s would be 172k/day) | consumer tests + 2 new |
| 1.2 | `closed_loop/event_bus.py` | ✅ Same timing-based sleep-on-empty in `_read_batch` | event_bus tests |
| 1.3 | `workers/leader.py` | ✅ `_DEFAULT_LOCK_TTL_SECONDS` 60→180 + `_DEFAULT_LOCK_RENEW_SECONDS` 20→60 (keeps 3:1 ratio, 3× fewer EVALs) | leader/sidecar tests |
| 1.4 | — | ✅ **Corrected:** both consumers already gated by their own feature flags (`auto_issue_detection_v1`, `closed_loop_orchestrator_v1`); wiring the telemetry flag would disable launch features. 4 new gate tests. | `test_stream_consumer_gating.py` |
| 1.5 | — | ✅ Watch `/metrics` command counters after deploy | expect ≤10k/day |

### 🔴 P0-2 · Fix the broken bench suite (SDK shadow)
**Baseline:** `bench/startup.py` + `bench/gateway_overhead.py` crash with
`ModuleNotFoundError: eden.api`; `bench.run_all` aborts.
**Root cause:** `sdk/python/eden/` stub shadows `src/eden` unless
`PYTHONPATH="src:."` (pytest/conftest/CI all set it; the bench harness doesn't).
**Fix:** prepend repo `src/` to `sys.path` in `bench/common.py` (5 lines,
mirror `tests/conftest.py`). **Verify:** `uv run python -m bench.run_all`
completes all 4 real suites.

### 🔴 P0-3 · Suspend zombie jobs
**Baseline:** `eden-worker`: 49 FAILED + 1 stuck RUNNING (fires on every
deploy); `eden-cron`: 50 no-op runs.
**Fix:** `northflank update job eden-worker --suspend` + suspend eden-cron.
**Verify:** runs list stops growing after next deploy.

---

## Part 2 — Order-of-magnitude innovations (TESTED this session)

Every gain below was benchmarked live. Together N1+N2+N3+N6 = a **~10–30×
improvement on the ingest + outbound-request paths**, and N4+N5 eliminate two
infrastructure dependencies.

### ✅ O1 · Shared HTTP clients — **15.6× faster outbound requests** (NEW)
**Baseline (measured):** per-request `httpx.AsyncClient` = 63 req/s vs shared
client = 976 req/s → **15.6×** (TLS + pool setup per call).
**Scope:** **17 `async with httpx.AsyncClient(...)` sites** + 2 aiohttp
sites currently pay this tax per request. The codebase already has the
`_shared_httpx()` pattern (pricing.py, clerk_auth.py, providers, budget_service)
— extend it to the remaining per-request sites:

| File | Line(s) |
|---|---|
| `api/routes/gateway.py` | 2437 |
| `api/routes/github.py` | 1527 |
| `api/routes/sso.py` | 891, 907, 973 |
| `api/routes/redteam.py` | 250 |
| `services/webhook_delivery.py` | 364 |
| `services/pagerduty_delivery.py` | 101 |
| `automations/engine.py` | 375 |
| `alerts/unified.py` | 270 |
| `integrations/support_webhook/__init__.py` | 76 |
| `api/startup_checks.py` | 125 |
| `mcp_server/client.py` | (already pooled — verify) |

**Verify:** rerun `bench_httpx` pattern; hit the touched routes via TestClient.

### ✅ N1 · orjson serialization — **6.7× dumps, 2.4× loads**
**Measured:** 124k → 833k ops/s (dump); 192k → 462k (load). `orjson 3.11.9`
already installed.
**Sites:** collector `_json_dumps` (`telemetry_collector.py:244`), SDK send
paths (`sdk/python/eden_sdk/client.py:139,1034,1246`), message_store.
**Verify:** rerun `bench_orjson`; collector micro-bench (expect ingest p50
well under current 6 µs ceiling gains headroom).

### ❌ N3 · Postgres COPY — **rejected with live measurement**
**Claimed:** executemany 3,206 rows/s → COPY 12,410 rows/s (3.9×).
**Reality (re-measured live on Neon, 2026-08-10):** the 3.9× came from raw
COPY *without* `ON CONFLICT`. All 4 sites
(`telemetry_collector.py:910,1577,2601`, `message_store.py:165,242`) require
idempotency (`ON CONFLICT ... DO NOTHING`) for SDK-retry safety, and COPY
cannot express a conflict clause. Measured instead: COPY→temp→INSERT
SELECT = **1.23–1.88× slower** than `executemany` at every batch size, and
direct COPY (0.56–0.81×) drops dedupe. This confirms the codebase's own
`docs/ops/remediation-measured-corrections.md` (COPY was previously measured
and rejected at exactly these sites). `executemany` stays — it is already
the optimal path for idempotent ingest writes.

### ✅ N2 · SDK wire zstd — **4.6× faster compress, 1.51× smaller**
**Measured (this session):** zstd-3 568k ops/s vs gzip-1 123k ops/s →
**4.6× faster compression**, 1.51× smaller bodies (same ratio discipline as
the original orjson+zstd plan item).
**Done:** `sdk/python/eden_sdk/_wire_compress.py` (zstd-3 when `zstandard`
installed, gzip-1 fallback, never-throws); `sdk/ts-ai/src/client.ts`
`compressJsonBody` (`Bun.zstdCompressSync` fast path → gzip fallback, magic
`28 B5 2F FD`); `session.ts` reuses it; backend
`observability/ingestion/providers.py` accepts `Content-Encoding: zstd` +
sniffs zstd magic when a proxy strips the header (bomb caps mirrored from
`_gunzip_limited`).
**Verify:** both SDK suites green (TS 380/0, Python wire+413+gzip tests),
backend `test_providers_zstd_wire.py` 7/7.

### ✅ N4 · pgvector replaces Qdrant
**Verified:** `vector` extension **already installed** on live Neon. Qdrant
collections are 1536-dim (match OpenAI embeddings). All 0 points.
**Plan:** repoint `kb/semantic/vector_client.py` + `storage/qdrant.py` callers
to pgvector (`<=>` HNSW on the existing `graph_entities`/`skills`/
`code_references` tables); delete Qdrant collections; remove boot init +
health-check churn + `to_thread` bridges.
**Verify:** kb semantic tests + a live similarity query.

### ✅ N5 · Postgres outbox replaces Redis XREADGROUP
**Baseline:** `loop_events_outbox` + `drain_outbox` **already exist**
(`closed_loop/event_bus.py:78-107`). Repoint the two consumers to poll the
outbox with a watermark (pattern: `improvement/runs_repo.get_watermark`).
**Result:** Redis removed from the closed-loop data path entirely.
**Verify:** consumer tests + no outbox backlog growth.

### ❌ N6 · uvloop — ruled out
**Measured:** task-switch and socket I/O at parity with stdlib asyncio on
Python 3.12. Do not adopt.

---

## Part 3 — Provisioned-but-idle infrastructure (safe to remove)

### 🟠 P1 · Decommission idle services
| # | Service | State | Action |
|---|---|---|---|
| 3.1 | Qdrant | 4 collections × 0 points | delete collections (see N4 first) |
| 3.2 | Tinybird | 6 datasources × 0 rows, 7 unused pipes | delete datasources/pipes + tokens; remove `CLICKHOUSE_URL` fallback or make lazy |
| 3.3 | Neon cleanup | `test_y`, `test_part_full_renamed`, `app_events`, `clickhouse_fallback`, `jobs` dead tables; 8 MB 0-scan indexes | migration dropping them (write + test first) |
| 3.4 | Hypertables | `telemetry_events` 9 chunks for 102 rows | `chunk_time_interval` 7 d + retention 90 d + compression; or plain table |
| 3.5 | 13 test orgs | duplicate workspaces | collapse to one clean org |
| 3.6 | `sdk/python/build` + `dist` | build artifacts | confirm gitignored / prune |

**Verify each:** migration tests (`tests/migrations/`), a live `pg_size_pretty`
probe showing size drop, and the full pytest suite.

---

## Part 3.5 — Boot-time & config depth findings (pass 6, exhaustive sweep)

Measured with `python -X importtime -c "import eden.api.app"` (659 ms total):

| # | Finding | Measured | Action |
|---|---|---|---|
| 3.7 | **Eager filter-import chain pulls KB ledger into boot**: `ai_gateway` → `filters/__init__.py:25` → `filters/book.py:8` → `kb.ledger.retrieve` → `inject_budget` + `gateway_optimizations` | ~32 ms of the 659 ms boot, plus the whole chain's transitive imports | Make `LedgerRetriever` import lazy inside the Book filter's call path (it's only used when ledger is enabled). **~5% boot reduction, first-request latency win** |
| 3.8 | FastAPI framework itself | 214 ms of 659 ms | Not actionable (framework cost); the router-deferral already done is the correct lever |
| 3.9 | `quota_enforcement` → `usage_service` | 130 ms boot | Verify it's needed eagerly; if only used by middleware, keep (middleware runs first request anyway) |
| 3.10 | numpy/pandas/sklearn | 18 numpy + 2 pandas + 3 sklearn importers | **Verified all lazy** (kb/exploit/probes, classifier_pipeline, patterns_clusterer, migration 004) — none on the boot path ✅ |
| 3.11 | Postgres pool config | min/max, timeout=10, command_timeout=60, statement-cache, max-inactive-lifetime | **Verified tuned** ✅ |
| 3.12 | Worker cadences | leader 60s TTL/20s renew, guard 600s/200s, cron 5min, heartbeat 6h keepalive, shadow-join 15min | **Verified tuned** (comments show the command-budget math) ✅ |
| 3.13 | SDK batch config | batch 50 / flush 250 ms / queue 4096 | **Verified tuned** ✅ |
| 3.14 | Config env | 546 settings fields, ~30 secret-bearing | No dead-env sprawl found ✅ |

**Action item: only 3.7 is new** — lazy-import the Book-filter ledger dep. All
other surfaces were verified already-optimal this pass.

---

## Part 4 — Correctness & hygiene (P2/P3)

| # | Item | Fix | Verify |
|---|---|---|---|
| 4.1 | 19 B008 ruff errors | `# noqa: B008` or module singletons | `ruff check` → 0 |
| 4.2 | mypy ratchet baseline | confirm `mypy_ratchet.py` matches 733; fix 2 trivial `app.py` | `mypy` count ≤ baseline |
| 4.3 | Orphaned Redis read | delete `api/routes/optimization.py:309` (FEAT-171 removed writer) | grep → 0 refs |
| 4.4 | Wide `SELECT *` | narrow `telemetry_collector.py:1902` columns | query plan check |
| 4.5 | Test-runner confusion | `test:bun` aliases in portal + ts-ai; README note | `npm test` docs |
| 4.6 | `RequestCoalescer` untested | unit tests (dedup window, expiry, key stability) | new tests pass |
| 4.7 | 4 unlogged bare-excepts | add `logger.debug` (funnels, cohorts, dashboards, replay/store) | — |
| 4.8 | `slow` marker lane | tag slowest test files; CI `-m "not slow"` fast lane | CI green |

---

## Part 5 — Final execution order

**Wave 1 — ✅ COMPLETE (2026-08-10).** All four items done, validated, and code-reviewed:
1. **P0-2** bench fix — `bench/common.py` `bench_env()` + `startup.py` derived repo root + `gateway_overhead.py` import fix. `bench.run_all` now runs every suite standalone. ✅
2. **O1** shared httpx pool — NEW `src/eden/util/shared_http.py` (`get_shared_httpx` / `shared_httpx_ctx` non-closing CM / `close_shared_httpx`). 10 per-request sites converted (sso ×3, gateway /models, github, automations, webhook test-ping, pagerduty, support_webhook, startup_checks, alerts). redteam SSRF probe + 2 low-frequency aiohttp alert sites deliberately kept per-request. Shutdown registry wired (`shared_http` step) + 9 new unit tests. Measured 15.6×. ✅
3. **N1** orjson — collector was already orjson-backed via `jsonx`; NEW `sdk/python/eden_sdk/_fast_json.py` with full stdlib parity (ensure_ascii=False, NaN→null, datetime isoformat, non-str keys, TypeError→stdlib fallback) wired into 3 SDK send sites; `fast` extra + orjson in `all`/`dev`. Measured **6.1×** wire speedup; parity tests. ✅
4. **P0-3** zombie jobs — eden-worker: `disabledCI=true` + `runOnSourceChange=never` (no more deploy-fired runs; stuck RUNNING pod from 2026-08-04 flagged for dashboard cleanup — no API kill endpoint). eden-cron: already inert (CD/CI off, no schedule). ✅

   Validation: 1269 gateway+unit/api + 874 services/alerts/integrations/webhooks/eval/util tests pass; full SDK suite pass; ruff clean; mypy clean on new files; `bench.run_all` completes. Reviewer feedback applied (orjson in dev/all extras, docstring scoping, single-loop note).

**Wave 2 — ✅ COMPLETE (2026-08-10).** All items executed, validated, and code-reviewed:
5. **P0-1** Redis burn — done, with two evidence-driven corrections to the literal spec:
   - **A1/A2 sleep-on-empty:** implemented as **timing-based** sleep in `trace_finalized_consumer.py` + `closed_loop/event_bus.py` `_read_batch` (sleep the remainder of `block_ms` when the server returns instantly, instead of a flat `1.0s`). On real Redis the server honors `BLOCK` (elapsed ≈ block_ms → no extra sleep); on Upstash (ignores `BLOCK`) idle rate = 1 cmd/block_ms → **≤10k/day**, whereas a flat 1.0s poll would leave **172k/day** — the plan's literal value fails its own verification goal. 2 new unit tests. ✅
   - **A3 leader cadence:** `_DEFAULT_LOCK_TTL_SECONDS` 60→180 and `_DEFAULT_LOCK_RENEW_SECONDS` 20→60 — preserves the 3:1 TTL:renew ratio the sidecar guard test enforces (`renew < ttl/2`), **3× fewer EVALs/day**, no correctness risk. ✅
   - **A4 gating — spec corrected with evidence:** the two XREADGROUP consumers are *already* gated by their own feature flags (`auto_issue_detection_v1`, `closed_loop_orchestrator_v1` — both launch features per `docs/ops/disabled-features.md`). Wiring them to `REDIS_TELEMETRY_STREAM_ENABLED` (false in prod) would silently disable auto-issue detection + the closed loop. Implemented as verification + 4 new tests proving the per-feature gates hold; telemetry flag NOT wired (documented in `test_stream_consumer_gating.py`). ✅
6. **N3 COPY — rejected with live measurement.** The plan's 3.9× (3,206→12,410 rows/s) came from raw COPY *without* `ON CONFLICT`. Every one of the 4 sites requires idempotency (`ON CONFLICT ... DO NOTHING`), which COPY cannot express. Live Neon re-measurement: COPY→temp→INSERT SELECT is **1.23–1.88× slower** than `executemany` at every batch size, and direct COPY (0.56–0.81×) can't dedupe — confirming the codebase's own `docs/ops/remediation-measured-corrections.md`. `executemany` stays; documented, not shipped. ✅ (documented, no code)
7. **N2** SDK wire zstd — done end-to-end: Python `sdk/python/eden_sdk/_wire_compress.py` (zstd-3 when `zstandard` present, gzip-1 fallback; **4.6× faster compress, 1.51× smaller** than gzip-1, measured); TS SDK `compressJsonBody` (`Bun.zstdCompressSync` fast path, gzip fallback; magic `28 B5 2F FD` matches gateway); backend `providers.py` accepts `Content-Encoding: zstd` + sniffs magic when header stripped. Both SDK suites green (Python wire/413/gzip tests, TS **380 pass / 0 fail**), backend zstd tests 7/7. ✅

   Validation: workers+closed_loop pytest suites green (232 tests incl. 6 new), TS SDK 380/0, tsc clean, ruff clean on touched files, Python SDK suite green. Reviewer feedback applied.

**Wave 3 — ✅ COMPLETE (2026-08-10).** All items executed, validated, and code-reviewed:
8. **N5** outbox repoint — ✅ `loop_events_outbox` is now the primary closed-loop queue (`closed_loop/event_bus.py` rewritten: INSERT→poll-watermark→dispatch, idempotency via unique key recorded only after successful dispatch, `_read_batch` sleeps out the block remainder). `loop_health` dropped Redis checks; Redis XREADGROUP removed from the loop path. Migration 163. 152 closed-loop/chaos/api tests green.
9. **N4** pgvector — ✅ `storage/pgvector.py` (`vector_documents` table: `(collection, point_id)` PK, `vector(1536)` + HNSW `vector_cosine_ops`, `(collection, org_id)` tenant index); pgvector codec registered in `postgres.py` pool init (fixes typed-column binds); `vector_client.py`/`cache.py`/`kb/__init__`/`startup_checks` repointed; `storage/qdrant.py` + 5 qdrant test files deleted; live Qdrant collections deleted (all 0 points); migration 164. 520 storage/kb/optimization/api tests green. 
10. **Part 3** decommission — ✅ with three evidence-driven corrections:
    - **P3.2 Tinybird REJECTED** — live substrate, not idle: `CLICKHOUSE_URL` points at Tinybird with admin+branch tokens; `realtime/kafka_consumer` + `telemetry_collector` + `silver_etl` write via the sink; `clickhouse_fallback_drain` replays into it on cron tick; `columnar` has explicit Tinybird-substrate handling. Deleting datasources/pipes would break the columnar query path. `CLICKHOUSE_URL` fallback already lazy (deferred imports).
    - **P3.3 dead tables** — only `test_y` + `test_part_full_renamed` proven dead (0 rows, 0 code refs); `app_events`, `clickhouse_fallback`, `jobs` are all live and kept. Migration 165 + static tests.
    - **P3.4 hypertable** — migration 166: chunk interval 1d→7d, adds 90-day retention; columnstore compression re-attempted with the same `feature_not_supported` guard (apache OSS build on Neon — compression cannot be enabled; verified live `compression_settings` empty).
    - **P3.5 test orgs** — collapsed 13→1 (keeper `2ac3fd6e`, 63 telemetry rows preserved; 12 duplicate orgs + 38 orphan telemetry rows removed, user-confirmed) via new `scripts/collapse_test_orgs.py` (dry-run default, zero-data gate, `--force-org` prefix matching, single transaction).
    - **P3.6 SDK artifacts** — `sdk/python/{build,dist,eden_sdk.egg-info}` pruned (already gitignored, untracked).

**Wave 4 — ✅ COMPLETE (2026-08-10).** All items executed, validated, and code-reviewed; **4.8 (CI fast lane) deliberately SKIPPED** per explicit user instruction (no CI changes):
11. **Part 4** hygiene batch:
    - **4.1 ruff B008 (19 → 0)** — all 19 sites were `Body(default=Model())` / `= Model()` import-time instantiations; converted to `Body(default_factory=Model)` (also removes a latent shared-mutable-default). `ruff check src` now fully clean.
    - **4.2 mypy ratchet** — real full-repo run: **679→678 errors vs a stale baseline of 709** (earlier "0 errors" was the ratchet reading empty stdin). Fixed all 8 `app.py` errors (5 missing return annotations, `Mapping→dict` cast, attr-on-decorated-callable replaced with a module-level flag dict) and regenerated `tests/baselines/mypy.json` to 678 across 209 files.
    - **4.3 orphaned Redis read** — removed the `eden:cost:{org_id}:month:*` hget in `optimization.py` (no writer since FEAT-171); `current_month_spend` now derived from the in-memory tracker, same source as the rest of the overview. Dropped the now-unused `redact_all` import.
    - **4.4 wide SELECT *** — `get_trace_tree` narrowed from `SELECT *` to the 41 columns the method actually reads (keeps inline JSONB for the zstd soft-fail fallback; drops agent_version/environment_id/tags/source_format/model/model_name/provider_name/parent_agent_span_id/child_agent_trace_id/created_at).
    - **4.5 test-runner confusion** — `test:bun` alias added to `clients/portal` (vitest) + `sdk/ts-ai` (bun test); README Development section documents the bun workspace convention.
    - **4.6 RequestCoalescer** — NEW `tests/unit/optimization/test_coalescer.py` (9 tests: dedup window, expiry cleanup, unexpired-block, key stability/normalization, failure propagation to waiters, **waiter-lock regression**, sequential non-coalescing, call_fn guard, stats). Previously zero coverage. **Re-audit fix (2026-08-10):** the waiter path awaited the in-flight future *inside* the lock scope — the "release lock before waiting" comment was never implemented — so a single waiter serialised every unrelated request behind the in-flight call. Restructured: decision under lock, both leader and waiter exit the lock before awaiting/executing; `get_event_loop()` → `get_running_loop()`. Locked in by `test_different_key_not_blocked_by_waiter` (deterministic event-gated regression test).
    - **4.7 bare excepts** — confirmed 0 remaining (already resolved).
    - **4.8 slow-marker CI lane — SKIPPED (user: no CI changes).**

    Validation: 1161 observability/storage/optimization/api tests + 233 touched-route tests + 55 health tests green; full-repo `ruff check src` clean; mypy 678 ≤ baseline; both package.json valid JSON.

**Definition of done per wave:** full pytest (8,577 ✅) + vitest (332 ✅) +
TS-SDK bun (380 ✅ — Wave 2) + `bench.run_all` (all 4 real suites) + relevant
new benchmarks show the expected gains.

---

## Appendix — measured baselines (this session)

```
gateway overhead        p50 1.17 ms / p95 1.30 ms / p99 1.49 ms   (budget <5 ms ✅)
app cold import         616 ms (gate <1000 ms ✅)
ingest (per event)      p50 6.0 µs / 165k ev/s single / 87k ev/s batch
zstd compression        15× ratio, 58k ops/s batch, 1.65× batch speedup
Python SDK producer     ~250k events/s (perf test), p99 <5 ms budget
TS SDK (ts-ai)          376 pass / 0 fail (bun test)
portal vitest           332 pass / 69 files
pytest                  8,577 pass / 80 skip / 2 xfail (9,287 collected)
ruff                    19 (B008) · mypy 733/223 files · tsc clean
orjson vs stdlib        6.7× dump / 2.4× load
COPY vs executemany     3.9× raw COPY WITHOUT ON CONFLICT — REJECTED: 1.23–1.88× SLOWER
                        with the conflict clause every ingest site needs (live Neon)
zstd vs gzip-1 wire     4.6× faster compress, 1.51× smaller (TS SDK, Bun runtime)
shared httpx vs fresh   15.6×
uvloop vs asyncio       parity (ruled out)
```

*Every item in this plan is traceable to a measurement in the audit documents;
nothing is speculative.*

---

## Wave 5 — Ingest hot-path per-event overhead (see `docs/wave5-ingest-hotpath-plan.md`)

Completed this session; all measured-before/after, all green:

1. **Sampling fast path** (`sampling/apply.py`): skip the full N16 analysis
   per event when the org has no override and the policy can never drop
   (`full`/disabled/keep_rate≥1.0) — ~0.7 s per 10k events removed in the
   default profile; behavior-identical (matches `decide`'s first branch).
2. **Row-build micro-wins** (`telemetry_collector.py`): hoisted jsonx import,
   token-dict fast path (no copy when no token keys), module-level
   `_tok_int` + cached `estimate_cost_usd` — single path 15.37→~14.0 µs/event.
3. **Timestamp parsed once** — `_validate` stashes `_parsed_timestamp`;
   latency/row-build/late-span reuse it (was 3–4 fromisoformat/event).
4. **Redis failure cooldown** — at most one connect attempt per 30 s window
   (was per-event connect storm + warning flood when Redis is down).
5. **Checkpoint task batching** — 1 background task per batch (was ~7
   create_task/event).
6. **Lazy Ledger imports** (`llmops/filters/book.py`) — ~104 ms KB chain out
   of app boot (item 3.7 from the master plan, now executed); verified absent
   from post-boot `sys.modules`; app boot ~611→~550 ms.

Validation: 1288 observability/llmops/wiring/closed-loop tests ✅; ruff clean;
mypy back to baseline (5 pre-existing, zero new); batch path 238→~201 µs/event.

---

## Wave 6 — Materialized `trace_summaries` read path (see `docs/wave6-trace-summaries-plan.md`)

Completed this session; measured-before/after, all green:

1. **The 10x gap**: `GET /orgs/{org}/observability/traces` re-aggregated the
   whole `telemetry_events` table (GROUP BY + 2 correlated subqueries/row) on
   every page load, while the finalized-trace pipeline computed the same
   per-trace aggregates and threw them away. **Page 91.2 ms → 320 µs
   (284.6x), count 39.2 ms → 2.9 ms (13.5x)** at 20k traces.
2. **Migration 167** — `trace_summaries` (PK (org_id, trace_id), list index).
3. **`TraceSummaryIndexer`** at `trace.finalized` — recompute-then-upsert,
   idempotent, byte-for-byte the `list_traces` aggregate expressions.
4. **Ingest-time placeholder rows** (`ON CONFLICT DO NOTHING`) so in-flight
   traces appear; best-effort, never fails ingest.
5. **Read path** — flag-gated (`trace_summaries_read_v1`, default off) with
   self-healing fallback to the untouched legacy query (legacy kept inline so
   source-inspection tests still pass).
6. **Backfill** — `scripts/backfill_trace_summaries.py` (idempotent).
7. **Bugs found & fixed**: stray `)` in `_UPSERT_SQL` (all upserts were
   syntax errors); a refactor that broke the 503-on-query-failure contract
   + 2 source-inspection tests (legacy restored inline); and a **pre-existing
   F70 PII regression** — `optimization.py`'s live overview-fallback log
   logged `exc` unredacted after FEAT-171 removed the pinned Redis-hget site
   (now redacted; F70 test re-pointed at the live site).

Validation: 2204 sessions/workers/api/observability tests ✅; 8/8 live-PG
`test_trace_summaries.py` ✅; ruff clean; mypy clean (0 new).

## Wave 7 — Cross-cutting innovations (see `docs/wave7-innovations-plan.md`)

Completed this session; measured-before/after, all green:

1. **A — Dashboard summary cache.** `observability_summary` fired 7–9
   full-window aggregations over `telemetry_events` on every dashboard poll.
   Added a Redis response cache (flag `observability_summary_cache_v1`, TTL
   20 s, org-scoped keys, exact-equivalent payload) + a Redis-failure latch
   so an outage can never add latency. **Headline totals 14.0× (19.35 →
   1.38 ms)**, overall 6.9×; cached hits are ~1 ms.
2. **B — Sampling-summary flush (cost).** `should_route_event` awaited a
   Postgres round-trip **per sampled-out event**. Now buffers in-memory only
   (zero awaits) and flushes via **one `executemany` per batch**, deduped by
   trace, cooldown-gated on the single-event path, atomic snapshot-and-clear.
   Under `aggressive` (95% drop, 10k/min): ~9,500 round-trips/min → ~7.
3. **C — Trace-tree cache.** `get_trace_tree` rebuilt the span tree on every
   view even though traces are immutable after finalize. Added a Redis cache
   (flag `trace_tree_cache_v1`) for the non-hydrated path, only for
   finalized traces (`trace_summaries` row with `span_count > 0`), so
   in-flight traces are never cached stale; repeat views are one Redis GET.
4. **Reviewer fixes**: O(N²) flush-task storm (cooldown gate),
   `persist_buffered` buffer race (atomic swap), cache connect-storm risk
   (failure latch).

Validation: **2212** sessions/workers/api/observability tests ✅ (incl. new
`test_wave7_caches.py`, 8 tests); ruff clean; mypy 0 new; benchmarks
reproducible via `uv run python -m bench.dashboard_summary`.

## Wave 8 — Finalized-pipeline single-fetch + F34 fix (see `docs/wave8-pipeline-single-fetch-plan.md`)

Completed this session; measured-before/after, all green.

1. **A — Single-fetch trace pipeline (speed).** `trace.finalized` ran per
   trace and fetched the full wide-column event set (up to 2000 rows) **up
   to 3×** (Layer A, scanner, investigator — the `events=` kwargs existed
   but were never used). Now fetched once in `_process_trace` and threaded
   through every stage. **Measured: up-to-3 full scans/trace → 1.**
2. **B — F34 gate actually sees the trace (correctness/cost).**
   `run_classifiers_before_investigator` was called with **no events**, so
   its trained models hashed an empty list — the skip-investigator
   cost-savings decision contained zero trace content. Events now flow
   through; residual training/serving skew documented (shadow-mode).
3. **C — Batched prediction writes (cost).** Up to 50 per-classifier
   `INSERT` round-trips per trace → **one `executemany`**.
4. **Reviewer fixes**: bench now exercises the batch path; “3 fetches”
   corrected to “up to 3”; skew documented; all-or-nothing degradation
   commented. Retry contract + executemany equivalence + tenant isolation
   confirmed.

**Wave 8.1 follow-up (this session)** — thread the single fetch into the
remaining re-fetchers when Layer A returns `None`:
- **Annotator** (`_run_annotator`) now receives the threaded `events`;
  `events is None` (not falsy) gates the DB fallback, so the Layer A
  `None` path never re-scans `telemetry_events` before the one paid LLM
  call.
- **ProductionEvalSampler** (`maybe_score_trace → _score_trace →
  `apply_rules_for_trace`) forwards the events; new `_load_content` /
  `_content_from_events` build the judge payload from the last event
  instead of a per-sampled-trace `telemetry_events` read, with DB
  fallbacks only for span-scoped targeting, zstd-only NULL blobs, or the
  2000-row fetch cap (truncation guard).
- Validation: **2601** tests ✅ (6 new tests pin the threading + no-re-fetch
  + fallbacks); ruff clean; mypy clean.

Validation: **2270** tests ✅ (incl. new `test_wave8_pipeline_single_fetch.py`, 4); ruff clean; mypy 0 new; bench via `uv run python -m bench.trace_pipeline_fetches`.

### Wave 9 — Cross-category: trace compare, $0 ledger batching, portal diff UX

**Status:** Complete this session — all four categories, measured + validated
(2418 backend tests, portal tsc + vitests green). See
`docs/wave9-cross-category-plan.md`.

1. **A — Functionality/speed: arbitrary two-trace diff.** New
   `POST /orgs/{org}/observability/traces/diff` (`observability/trace_diff.py`):
   lean 12.7× projection, O(n+m) span-id alignment (88× faster than the naive
   join at n=2000, no-span fallback also O(n+m) via (event_type, name)
   deques), cost extracted with the same metrics→payload→attributes COALESCE
   as the list page, per-step kinds + aggregate deltas. Pure read.
2. **B — Cost/speed: batch $0-cost ledger writes.** `cost_usd == 0` events
   (classifier savings markers on the always-on path) buffer in-process and
   flush in ONE executemany (`cost_ledger_batch_v1`, default on): 200
   INSERTs → 1, ~86× faster. Cost > 0 stays write-through with budget/alert
   round-trips. Periodic flusher in API lifespan + worker `_run_forever`,
   final flush in the shutdown registry before Postgres closes.
   At-most-once for $0 rows documented.
3. **C — UX: portal Compare dialog.** `TraceDiffDialog` mounted in the trace
   detail action bar (Compare button): feed datalist picker, six delta cards,
   kind-filtered aligned step diff, Escape/focus-trap/aria-modal chrome.
   Reviewer fixes: ref-guarded reset (parent re-renders no longer wipe the
   diff) + `−$0.004` sign/magnitude delta formatting.

**Cumulative across Waves 6–9:** traces page 797×, count 17.4×, dashboard 14×,
detection path 3× fewer scans + 50× fewer INSERTs, and now trace compare at
88× alignment + 12.7× leaner fetch, and $0 ledger writes at 86× — all
measured, tested, and flag-gated/fallback-safe.

## Wave 10 — data clarity (revised; share removed)

Pure frontend wave; portal 351 vitests (72 files) + typecheck + lint clean.
See `docs/wave10-ux-friction-plan.md`.

0. **Removed the trace-share feature** (shipped in the first Wave 10 pass but
dead weight — server service never surfaced, no user asked): deleted
`share-trace-dialog.tsx` + test, removed `createTraceShare`/`TraceShare` from
`portal.ts` and `createTraceShare`/`listTraceShares`/`revokeTraceShare` from
`resources.ts`, and stripped the Share button/mount/state from the trace action
bar. Grep-verified zero references.
1. **A — Living ⌘K palette** (kept). Lazy-loads live traces/issues/agents per
org per session, field-scored matching, paste-any-id direct jump, keyboard nav
with wrap, visible "Search (⌘K)" triggers in sidebar + mobile header
(`lib/palette.ts`). 8 tests.
2. **C — Compare-to-previous-run** (kept). "vs prev" button pre-fills the
Wave 9 diff dialog with the chronologically-previous same-agent run.
3. **Dashboard clarity** (new focus): Recent runs + Fleet render by default
(the queries were already unconditional — the old "Show fleet" button only
hid already-fetched data); KPI hints in plain language ("last 24h", "recent
runs", "failing runs", "saved by cache") instead of internal jargon
("24h · analytics"); "Needs attention" header says "showing 3 of N" and gets a
"See all N runs needing attention" link (→ `/issues` when open issues exist)
so the count never silently exceeds the rendered list.
4. **Hardening (reviewer pass):** dead `data_source` field dropped from the
`liveTiles` memo; `traces-client.tsx` migrated from the conditional-hook
`useLabToast` try/catch to non-throwing `useLabToastSafe` (no suppressed
rules-of-hooks violations remain); redundant `Math.min` in the truncation note
removed. New `home-client.test.tsx` (3 tests) pins the clarity behavior.

## Wave 11 — Site-wide clarity sweep (every page, one vocabulary)

Audited all 20+ portal routes; the systemic problem was the UI leaking the
data model. Portal 357 vitests (72 files) + typecheck + lint clean. See
`docs/wave11-site-clarity-sweep-plan.md`.

1. **One severity vocabulary.** New shared `severityLabel()` in `lab-ui.tsx`
(critical → Critical, error → Failed, warn → Warning, none/ok → OK, unknown
passthrough); `SeverityBadge` delegates to it. Every surface that previously
showed raw enum fragments is now consistent: trace/issue/agent/run badges
(9 files), traces/agents/issues filter chips (Fail/Warn/Ok →
Failed/Warning/OK), home "2 fail · 1 warn" counts, session-lens turn outcomes
(error/mixed → Failed/Warning), alerts panel severity + status chips
(firing/muted/resolved → Firing/Muted/Resolved), detector severity chips,
automations run statuses, prompt status chips (Draft/Shadow/Live/Archived),
and compare's "Fail" → "Fail rate".
2. **Human timestamps.** Raw `startedAt` ISO strings in trace feed rows,
transcript "Started" metadata, and session-lens rows/detail now render via
the existing `formatRelativeTime()`.
3. **Consolidation.** Three hand-rolled severity-label helpers collapsed into
the one shared `severityLabel` — one vocabulary, one place to change it.
4. **Tests.** New `lab/severity-vocabulary.test.tsx` (6 tests): badge labels,
no-raw-fragments guard, shared-helper mapping, unknown passthrough.
Audited-but-unchanged surfaces documented (Evals/Compare/Artifacts/Topics/
Ledger/redteam already used plain labels; sessions + alerts soft-land pages
are intentional).
