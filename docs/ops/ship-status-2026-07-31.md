# Eden ship status — 2026-07-31 (pre-ship pass update)

Single current status for free-beta production quality. Supersedes stale
claims in `docs/prod-ready-checklist.md` (Jul 3). Detail lives in
`docs/ops/known-issues.md`, `docs/ops/remediation-measured-corrections.md`,
and this file.

## Live surfaces (verified 2026-07-31 evening)

| Surface | Status |
|---|---|
| API `api.edenobservability.com` | `/ready` ready; `/live.commit` = `dd4724c8eb16e27b27c74cdd607ae50320ea6834` |
| Portal `edenobservability.com` | 200 (prior verify) |
| Docs `docs.edenobservability.com` | 200 |
| Redis | Upstash 500k cap → `/ready` reports `quota_exhausted`; Postgres leader leases |
| Typesense | still `TYPESENSE_ENABLED=false` for search product path; leave F12 BLOCKED |

Working tree HEAD matched live deploy SHA at start of this pass; **remediation
fixes below are in the working tree and are not yet on the live image** until
committed + Northflank redeploy.

## Closed in this pre-ship pass (code)

### SDKs (agent overhead / durability)

- **TS** `OfflineQueue`: atomic temp+rename rewrite; O(1) append row cache
  (`sdk/ts-ai/src/offline-queue.ts`). Durability suite **17/17 PASS**.
- **TS** README no longer claims silent drop for oversized batches / missing org.
- **Python**: fork reset now clears offline auto-drain state; prior 413 bisect,
  auto-drain, worker wait/eviction already in tree. Durability+perf tests PASS
  (p99 budget; throughput XPASS under load).
- **Registry skew (publish still required):** tree `0.4.0` vs npm `@eden-ai/sdk@0.3.4`
  and PyPI `eden-sdk@0.2.39`. npm auth not available in this environment —
  publish after review.

### API / workers / data platform

- Gateway telemetry **off response path** via `_emit_gateway_telemetry_bg` +
  `bounded_create_task` (14 call sites); PII scrub via `amask` / literal prefilter.
- `async_tasks`: strong-ref tracking, `drain_background_tasks`, drop accounting.
- Incident clusterer: `LIMIT 500` + `bounded_gather(limit=32)`.
- Archive: one process-local boto3 S3 client; MCP rollup `executemany`;
  trace_quality drain event-driven (`_ACTION_WAKEUP`).
- `mark_obsolete_pre_fix_rows_dead` for ClickHouse fallback backlog.
- Tinybird datasources regenerated from CH DDL (`DateTime64(3)`, LowCardinality, …).

### Portal

- Wired `MobileBottomNav` (sidebar hidden `<md`), `LocalDraftBanner` on detectors
  local drafts, `useCatalogAgents` in `AgentScopeFilter`, `unavailable/layout.tsx`.
- Skeleton CSS already present (`eden-skeleton-pulse`).
- Portal typecheck PASS; vitest **110/110 PASS**.
- `polish:check` still fails pre-existing clutter baselines (tablist / evals
  EmbeddedSurface) — not introduced by this pass; do not block beta on it.

## Local proof matrix (this pass)

| Gate | Result |
|---|---|
| `sdk/ts-ai` durability | 17 pass |
| `sdk/python` 413/fork/offline/worker + perf | pass (1 XPASS throughput) |
| PII prefilter + Tinybird drift | 38 pass (earlier run) |
| Workers perf + CH obsolete + gateway offload + async durability | 25 pass |
| Portal typecheck | pass |
| Portal vitest | 110 pass |
| GitHub Actions | still BILLING BLOCKED |
| Northflank redeploy of this tree | **not done** — needs commit/push; do not partial-patch env |
| SDK npm/PyPI publish 0.4.0 | **not done** — no registry auth here |

## Still open / deferred

| Item | Why |
|---|---|
| **GitHub Actions** | Billing — blocks F85 CI-green on main |
| **F12 Typesense 10M** | `TYPESENSE_ENABLED=false`; no cluster |
| **RLS FORCE** | App-level `tenant_id` predicates remain SoT |
| **SDK publish 0.4.0** | Registries lag tree; required before telling customers to upgrade |
| **Deploy remediation SHA** | Commit thematic slices, then NF deploy with full env merge via `scripts/build_nf_env_payload.py` |
| **Disabled features** | time-travel replay / SSO / RTBF / email verify stay off (`docs/ops/disabled-features.md`) |
| **polish:check baselines** | Pre-existing hub clutter lint failures |

## Deploy rule

Never `northflank patch service combined` with a partial `runtimeEnvironment` —
that route **sets** the whole map and wipes omitted vars. Use
`update service runtime-environment` with a full merged payload
(`scripts/build_nf_env_payload.py`) and `update service build-arguments`
for `EDEN_GIT_SHA`.
