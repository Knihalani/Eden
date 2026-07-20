# Optimization ID Checklist

Canonical Wave-1 / Wave-2 register. Agents update their rows only.

| ID | Owner | Severity | Status | Notes |
|---|---|---|---|---|
| K1 | A1 | P0 | DONE | Shared RQ `["auth","me"]` via `hooks/use-me-query.ts`; Auth+Org cold mount = 1 network call |
| K2 | A1 | P0 | DONE | ChatSidebar `dynamic()`; BudgetTicker `intervalMs` = 30_000 |
| P1 | A1 | P0 | DONE | Notifications `enabled` only when signed-in; PortalProviders consumed by P2-phase2 portal layout |
| P2-phase1 | A1 | P0 | DONE | Lazy islands: ChatSidebar, CommandPalette, OnboardingOverlay via `dynamic()` |
| P2-phase2 | W15-a | P2 | DONE | `(portal)/layout.tsx` RSC shell wraps `PortalProviders` + `PortalChrome`; providers removed from root |
| P8 | A1 | P1 | DONE | Toast state/actions context split + `useMemo` |
| P9 | A1 | P1 | DONE | Notifications state/actions context split + `useMemo` |
| P20 | A1 | P1 | DONE | `auth-brand-panel` uses `usePolling` (no raw `setInterval`) |
| P21 | A1 | P1 | DONE | OnboardingOverlay/ProductTour loaded via `dynamic()` |
| P22 | A1 | P1 | DONE | CommandPalette `dynamic()` + mount after first open |
| P25 | A1 | P1 | DONE | W15-e: intl skipped in proxy body for portal/API; matcher excludes more static; root skips getMessages + NextIntlClientProvider on portal via x-eden-pathname |
| P28 | A1 | P2 | DONE | Feature-flag probe deferred with ChatSidebar lazy boundary |
| P35 | A1 | P2 | DONE | PerformanceObservers gated to `NODE_ENV === "development"` |
| K31 | A7 | P0 | DONE | Search fallback tenant+time bounded; Typesense circuit breaker; pg_trgm mig 113 |
| K32 | A7 | P1 | DONE | issues/alerts/automations/scim/labeling_queues list projections |
| K33 | A7 | P1 | DONE | jobs.request::text gin_trgm expression index (mig 113) |
| K34 | A7 | P1 | DONE | Home cost KPI prefers CH/Tinybird when clickhouse_url set; PG soft-fail |
| B4 | A7 | P0 | DONE | retention archive_to_cold keyset chunked LIMIT |
| B11 | A7 | P1 | DONE | GitHub org repos asyncio.gather + 60s cache |
| B12 | A7 | P1 | DONE | playgrounds/automations/labeling API default limit ≤100; A2 portal passes `?limit=100` |
| B13 | A7 | P1 | DONE | labeling board + list items le=100; A2 portal labeling/playgrounds request bounded |
| B22 | A7 | P1 | DONE | SignalClusterer max_signals=500 |
| B29 | A7 | P2 | DONE | silver_etl usage_events column projection |
| B30 | A7 | P2 | DONE | labeling_items / labeling_queues SELECT projection |
| K35 | A8 | P0 | DONE | Py+TS gzip Content-Encoding on ingest POST |
| K36 | A8 | P0 | DONE | Go SDK queue+batch flush |
| K37 | A8 | P0 | DONE | Rust send_batch raw JSON array |
| K38 | A8 | P1 | DONE | Py chunk retries+Retry-After; batch_size default 50 |
| K39 | A8 | P1 | DONE | TS sideEffects:false + model-advisor subpath |
| K40 | A8 | P1 | DONE | Py ModelAdvisor PEP 562 lazy import |
| S3 | A8 | P0 | DONE | redact_on_client/redactOnClient default false + changelog |
| S4 | A8 | P0 | DONE | capture_chunk_text/captureChunkText default false |
| S5 | A8 | P0 | DONE | TS instrument() httpCapture default false |
| S6 | A8 | P0 | DONE | Py http_capture skips stream bodies |
| S7 | A8 | P0 | DONE | MCP HttpEdenClient long-lived httpx |
| S8 | A8 | P0 | DONE | streaming.py executemany + per-span locks |
| S11 | A8 | P1 | DONE | Py/TS multi-format flush concurrent |
| S12 | A8 | P1 | DONE | Offline queue persistent SQLite conn |
| S13 | A8 | P1 | DONE | logging forwarder default WARNING |
| S14 | A8 | P1 | DONE | OTel XOR native instrument enforced |
| S15 | A8 | P2 | DONE | apm_depth identity map trimmed |
| S16 | A8 | P2 | DONE | MCP structuredContent + concurrent batch RPC |
| K23 | A5 | P0 | DONE | CH flush size≥250 or timer≤5s; never per-event (Wave 2: 100→250) |
| K24 | A5 | P0 | DONE | NUMSUB==0 skip + pipeline; eden_sse_publish_skipped |
| K25 | A5 | P0 | DONE | compress_many/decompress_many via asyncio.to_thread |
| K26 | A5 | P1 | DONE | Checkpoint fire-and-forget; billing batched/deferred |
| K27 | A5 | P1 | DONE | Typesense time flush + non-blocking enqueue |
| K28 | A5 | P1 | DONE | CH→PG fallback executemany |
| S1 | A5 | P0 | DONE | OTel dual-emit batched flush |
| S2 | A5 | P0 | DONE | Dual-emit content gated off by default |
| S9 | A5 | P0 | DONE | Single to_dict() per Redis route |
| S9b | A5 | P1 | DONE | Sparse Redis stream EXPIRE refresh |
| S10 | A5 | P0 | DONE | Enrich hash without full sorted payload dump |
| S17 | A5 | P2 | DONE | OTel exporter caches settings |
| K41 | A9 | P0 | DONE | API `EDEN_RUN_BACKGROUND_WORKERS=0`; worker job `=1`; config default false; background.start guards |
| K42 | A9 | P1 | DONE | `CostTracker.check_budget` → `budget_service` PG |
| B5 | A9 | P0 | DONE | `bounded_create_task` + cost_ledger/warm_learn/logging_shim/intervention/predictive |
| B6 | A9 | P0 | DONE | quality_pipeline SidecarWorker semaphore concurrency ≥8 |
| B19 | A9 | P1 | DONE | closed_loop verify due-rows gather + semaphore |
| B20 | A9 | P1 | DONE | bronze_sink single flusher (Event wake) |
| B21 | A9 | P1 | DONE | logging_shim concurrent ingest + billing get_plans Cache-Control |
| K3 | A2 | P0 | DONE | Removed dead `home-dashboard` fetch |
| K4 | A2 | P0 | DONE | TraceDetailPanel meta+tree via `Promise.all` |
| K5 | A2 | P0 | DONE | Session traces batch `trace_ids` (≤1 request); BE `list_traces` + attach_traces |
| K6 | A2 | P0 | DONE | LiveTail default off; pauses on `visibilitychange` |
| K7 | A2 | P0 | DONE | Users/Analytics `enabled: activeTab` / overview tab-gate |
| K8 | A2 | P1 | DONE | Dashboard+traces share `queryKeys.observability.traces` incl. `days: 7` |
| P4 | A2 | P0 | DONE | Alerts/events poll 30s; gated off Signals/Rules tabs |
| P5 | A2 | P0 | DONE | Budget page refetchInterval 30s |
| P6 | A2 | P0 | DONE | Top-8 pages migrated to `useOrgQuery` (remainder → P6b) |
| P6b | W15-a | P2 | DONE | Batch migrate (~16) high-traffic hand-rolled → `useOrgQuery`; remainder → P6b-remainder |
| P6b-remainder | W15-a | P2 | DEFERRED | 11 low-traffic surfaces left on hand-rolled fetch (not blocking P0/P1): profile/page, replay/page, settings autonomous-tab, TraceShareModal, AnnotateTraceDialog, 2fa-setup-dialog, api-keys-settings, invite-panel, members-settings, transfer-ownership-dialog, SpanSearchBar |
| P7 | A2 | P1 | DONE | Extended `query-keys.ts` (cost.kpi, sessionTraces, tokens, P6 domains) |
| P12 | A2 | P1 | DONE | Alerts + improve queue use `VirtualizedList` |
| P18 | A2 | P1 | DONE | `portal-dehydrate.ts` + dashboard/traces layouts hydrate via Eden `/auth/me` org UUID + shared days |
| P26 | A2 | P1 | DONE | Deleted dead IntelligenceGrid module |
| P27 | A2 | P2 | DONE | StreamingSparkline → `useOrgQuery` |
| B9 | A2 | P1 | DONE | `acknowledge_alerts_batch` single `ANY($1::uuid[])` UPDATE |
| B10 | A2 | P1 | DONE | `attach_traces` bulk on session end |

> A2 verify: `bun run test -- src/hooks/__tests__/a2-portal-data.done-when.test.ts` PASS (14). Backend batch tests PASS (8). `bun run typecheck` after portal-dehydrate fix.
> W15-a verify: `bun run typecheck` + vitest `w15a-portal-longtail.done-when` + `a1-chrome.done-when`.

| K9 | A3 | P0 | DONE | Removed unused `@xyflow/react` from package.json + lockfile |
| K10 | A3 | P0 | DONE | `BrowserReplayPanel` dynamic `import("rrweb-player")` only |
| K11 | A3 | P1 | DONE | Inter dropped from root; Geist ± Mono only; `--font-display` → Geist |
| K12 | A3 | P0 | DONE | Marketing `force-dynamic` removed; landing RSC + `SignedInGate` |
| K13 | A3 | P1 | DONE | `lib/api/{core,resources,agents,observability,improve,integrations,misc,auth-client,index}` split + barrel |
| K14 | A3 | P1 | DONE | vercel.json Cache-Control for `/_next/static` + favicon/icons |
| K15 | A3 | P2 | DONE | Deleted `public/service-worker.js` |
| P3 | A3 | P0 | DONE | Marketing landing RSC; client islands only where needed |
| P10 | A3 | P1 | DONE | LatencyHistogram CSS bars (no framer-motion) |
| P11 | W15-a | P2 | DONE | Removed AnimatePresence/framer-motion from portal page surfaces (alerts/users/tools/studio/obs/opt/…) |
| P13 | A3 | P1 | DONE | TranscriptView images → `next/image` (unoptimized remote) |
| P14 | A3 | P1 | DONE | Profile avatar → `next/image` |
| P15 | W15-a | P2 | DONE | PII + retention policy tabs: JSON dirty-check gates save (skip redundant writes) |
| P16 | A3 | P1 | DONE | TranscriptView `LazyJson` expand-on-demand |
| P17 | A3 | P2 | DONE | `fetchApi` dedupKey skips stringify when body absent |
| P19 | A3 | P1 | DONE | Subprocessors server-fetch; contact/do-not-sell RSC + form islands |
| P23 | A3 | P1 | DONE | `grain-overlay` marketing-layout only |
| P24 | A3 | P1 | DONE | Purged unused stage-pulse/border-pulse/code-streaming/logo-animate |
| P31 | A3 | P2 | DONE | check-bundle-size recurses chunks; ceilings 400KB/6MB (coord A10) |
| P32 | A3 | P2 | DONE | `/settings/{gateway,exports,…}` → `?tab=` via next.config redirects |
| P33 | A3 | P2 | DONE | InstallSection deep-imports `@/components/ui/code-chip` |
| P34 | A3 | P2 | DONE | optimizePackageImports + cmdk/radix/clerk; xyflow removed |
| — | A3 | — | NOTE | Created `(portal)/providers.tsx`; P2-phase2 mounts it from portal layout (off root) |
| A4-jsonx | A4 | P0 | DONE | `eden.util.jsonx` orjson; postgres/redis/SSE hot path |
| A4-asgi | A4 | P0 | DONE | Idempotency/Quota/RLS pure ASGI |
| A4-deps | A4 | P0 | DONE | last_seen debounce 60s + org id cache TTL 60s |
| A4-clerk | A4 | P1 | DONE | clerk `_USER_CACHE` LRU max 2048 + org LRU |
| A4-email | A4 | P1 | DONE | email_service singleton httpx |
| A4-auth-log | A4 | P2 | DONE | `/auth/me` HIT → debug |
| A4-tier | A4 | P1 | DONE | tenant_rate_limit `_tier_cache_ttl` = 60s |
| K16 | A4 | P0 | DONE | billing Stripe SDK via `_stripe_call` / `asyncio.to_thread` |
| K17 | A4 | P0 | DONE | qdrant `*_async` to_thread; vector_client awaits async wrappers |
| K18 | A4 | P0 | DONE | gateway deleted `_run_async`; PII helpers async; B24 pricing coalesce |
| K19 | A4 | P1 | DONE | SendGrid/email_service shared httpx (not per-send client) |
| K20 | A4 | P1 | DONE | avatars `_S3_CLIENT` singleton; bronze_sink singleton + jsonx NDJSON |
| K21 | A4 | P1 | DONE | rate-limit tier cache TTL 5s → 60s |
| K22 | A4 | P1 | DONE | IdempotencyMiddleware pure ASGI; body buffer only with Idempotency-Key |
| B1 | A4 | P0 | DONE | `last_seen_at` UPDATE debounced ≥60s in deps.py |
| B2 | A4 | P0 | DONE | `resolve_eden_org_id` in-process TTL cache 60s |
| B3 | A4 | P0 | DONE | Quota + RLS + Idempotency converted to pure ASGI |
| B8 | A4 | P0 | DONE | orjson via `eden.util.jsonx` on postgres JSONB, redis cache, SSE |
| B14 | A4 | P1 | DONE | `/auth/me` HIT log level → debug |
| B15 | A4 | P1 | DONE | Clerk user cache OrderedDict LRU cap 2048 |
| B16 | A4 | P1 | DONE | Clerk org cache LRU + get_organization cached |
| B17 | A4 | P1 | DONE | slack alerts/interactive `_shared_httpx` (never async-with shared) |
| B18 | A4 | P1 | DONE | budget_service + llmops/pricing `_shared_httpx` |
| B23 | A4 | P1 | DONE | internal_health probes via `asyncio.gather` |
| B24 | A4 | P1 | DONE | gateway pricing refresh coalesced into one create_task |
| B31 | A4 | P2 | DONE | Middleware stack remains LIFO-correct; ASGI conversion preserves order |
| B32 | A4 | P2 | DONE | Quota skips docs/metrics/ready/internal health; anonymous early exit |
| B26 | W15-b | P2 | DONE | Deferred intelligence_* routers via mount_deferred_routers() in lifespan; cold import skips them |
| B27 | W15-b | P2 | DONE | Hot modules (auth/billing/clerk_auth/logging/idempotency/invitation/telemetry) no import-time get_settings() |
| B28 | W15-b | P2 | DONE | Removed dead module-level settings=get_settings() side effects in hot path modules |
| B33 | W15-c | P2 | N/A | Wave-2 audit: plan §5 lists B26–B35 range but never defines B33 inventory; searched plan/transcripts/docs/specs — no description. Cannot invent work. |
| B34 | W15-c | P2 | N/A | Wave-2 audit: same as B33 — no inventory definition found anywhere. |
| B35 | W15-c | P2 | N/A | Wave-2 audit: same as B33 — no inventory definition found anywhere. |
| K29 | A6 | P0 | DONE | Idle job WS: Redis pub/sub wake or ≥10s timeout; ≤1 get_job per cycle (`websocket.py`) |
| K30 | A6 | P1 | DONE | Blobs incremental; code_fragment truncated ≤32 KiB on wire |
| B7 | A6 | P0 | DONE | live_tail idle backoff + Redis wake; reused client (no fixed 1s PG forever) |
| B25 | A6 | P1 | DONE | mobile_sse shared poller per job_id (not N independent PG loops) |
| K43 | A10 | P1 | DONE | Bundle CI ceilings ≤400KB/chunk ≤6MB total; recursive chunk walk |
| K44 | A10 | P1 | DONE | `GET /orgs/{org}/admin/slow-queries` + `slow_query.py` ring buffer |
| K45 | A10 | P1 | DONE | Prometheus `eden_ingest_redis_commands`, `eden_ch_flush_batch_size`, `eden_sse_publish_skipped` |
| P29 | A10 | P2 | DONE | Golden-path sleep debt documented in `docs/runbooks/golden-paths.md` |
| P30 | A10 | P2 | DONE | Vitest whole-source `readFileSync` debt documented (hygiene; no expand) |
| S18 | A10 | P2 | DONE | `tests/perf/test_redact_chunk_dual_emit_bench.py` redact/chunk/dual-emit cases |

> A2 verify: vitest `a2-portal-data.done-when` 14 pass; `bun run typecheck` green; pytest ack-batch + list_traces batch + ingest attach_traces 7 pass.
> A3 verify: `bun run typecheck` + `bun run check:bundle` OK; w13-w17 rrweb tests pass.
> A4 verify: `pytest tests/unit/api/test_a4_async_io.py tests/unit/api/test_middleware_perf.py tests/unit/api/test_quota_lp10_fail_open.py tests/unit/storage -q` → **140 passed**
> A6 verify: code in websocket/live_tail/mobile_sse; tests under `tests/unit/realtime/`.
> A10 verify: scorecard §6 + `scripts/opt_id_audit.md` + checklist harness.
> Wave-2: restored missing A6/A10 rows (merge drop); B33–B35 → N/A; P6b-remainder → DEFERRED.
