# Eden Codebase Ground Truth (for Spec Authors)

> **Purpose:** Keep specs accurate — what is **shipped**, **partial**, **stub**, or **retired** in `/workspace/src/eden`.  
> **Last audit:** July 17, 2026 (Phase 12 U20 portal polish complete)  
> **Phase 0 delta:** July 12, 2026 — see [`.omc/autopilot/ground-truth-delta.md`](../../.omc/autopilot/ground-truth-delta.md). Waves 0–7 on `main` landed issues + closed_loop; rows below marked **STALE→FIXED**.  
> **Wave 1 delta:** July 15, 2026 — F48 portal contracts, F03 prefix cache, F12 search harden, F04 MCP reliability all exit Wave 1. See MCP & debugger, Search, and Portal contracts sections below.

Use this doc when writing implementation steps. Specs MUST NOT assume modules exist without checking here.

---

## 1. Critical wiring gaps (fix before feature UX)

| Gap | Spec says | Reality | Fix spec |
|---|---|---|---|
| Trace quality worker | Running on ingest | **DONE (N14):** Postgres watermark sidecar; leader-gated in `background.py`; `/health` `quality_worker_running` | — |
| StatGate wiring | Active | **DONE (N14):** `install_all()` in `app.py` lifespan (all pods); `statgate_installed` on `/health` | — |
| `register_all_hooks()` | Registers hooks | **DONE (N14):** F46 orchestrator subscribe; demote → `EvalToGuardrailLink.demote` | F46 |
| `src/eden/issues/` | F28/F29/F20 | **SHIPPED (Phase 1):** stumble→issue→triage→Slack; 8 detectors on `standard` profile; `auto_issue_detection_v1=true` default; e2e &lt;60s; F20 on `trace.finalized` Redis | F28–F30, F35, F47 |
| Per-trace signal investigator | F06 | **DONE (Phase 7):** `signals/investigator.py` + `clusterer.py` + `backfill.py`; migration `104_wave8_signals`; API `/signal-clusters`, `/signals/{id}/backfill` | — |
| `src/eden/promotion/evidence_gate.py` | F41 | **DONE (Phase 3):** EvidenceGate + `/promotions` portal inbox; min_n=50; Bayesian canaries; 7d demotion → Ledger DNR | F41 |
| `src/eden/closed_loop/orchestrator.py` | F46 | **STALE→FIXED:** `closed_loop/` shipped + lifespan consumers | F46 |
| Runtime nudges in gateway | F39 | **DONE (Phase 3):** warm cache, tool_block/rewrite/inrun_rescue, trigger DSL parity, portal U02 GA | F39 |
| Ledger vector retrieval | F40 | **DONE (Phase 3):** embeddings on upsert, vector `_top_k`, cold-path warm, portal U05 | F40 |
| LangGraph env-gen pipeline | **REMOVED (N07)** | **RETIRED** — use D6 fixture export + D7 regression memory instead | — |
| `trace_quality_*` settings | Config | **DONE (N14):** in `config.py` | — |
| Weekly optimization cron | Recurring PRs | **STALE→FIXED:** `DEFAULT_POLICY.optimization_schedule`, `cron_tick.scheduled_optimization` | Phase 1C |
| Patch `linked_files` | From triage/RCA | **STALE→FIXED:** `issue_patch_trigger` resolves via RCA linker + triage hints | Phase 1B |
| Triage budget | Optional per org | **STALE→FIXED:** optional org budget in TriageAgent (unset=unlimited) | Phase 1A |
| F53 dataset hub list API | Portal `/datasets` | **DONE (Phase 4):** `datasets/hub.py` + `api/routes/datasets_hub.py` | F53 |
| F49 playground portal | U03 missing | **PARTIAL (Phase 4 / SOTA W0):** `/playgrounds` wired; persistence/matrix → W18 | F49 |
| N01 regression runner | Cases only stored | **DONE (Phase 4):** `regression_runner.py`; gate on resolve + canary >5% | N01 |
| F44 nightly curator | Stub sampling | **DONE (Phase 4):** `cron_tick` 02:00 UTC; 7d telemetry stratification | F44 |
| F52 online scoring rules | STUB | **PARTIAL (Phase 5/8 / SOTA W0):** rules engine + cascade; full U14 UI → W18 | F52 |
| F79 span scoring | STUB | **DONE (Phase 5):** `span_scores` table + `/spans/{id}/scores` API | F79 |
| N03 prod eval sampling | PARTIAL | **DONE (Phase 5):** budget cap; no fake scores; rules-engine wired | N03 |
| N15 eval→guardrail | PARTIAL | **DONE (Phase 5):** shadow promote + EvidenceGate enqueue + gateway filter | N15 |

---

## 2. Shipped assets to leverage (do NOT rebuild)

### Trace quality / StatGate / ETEC

| Asset | Path |
|---|---|
| 5-step quality sidecar | `src/eden/observability/quality_pipeline/worker.py` |
| Hot-path guardrails (8 checks) | `src/eden/observability/trace_quality/hooks.py` |
| StatGate 5-check gate | `supplementaries/phase_6_stat_gate/gate.py` |
| StatGate-gated executor | `supplementaries/phase_7_detection/stat_gated_executor.py` |
| Cat 15/17/22 wiring shim | `src/eden/observability/trace_quality/wiring.py` |
| Trace quality API | `src/eden/api/routes/trace_quality.py` (mounted `app.py:705`) |
| ETEC composite | `supplementaries/phase_2_efficiency/composite.py` |

### Gateway & cost

| Asset | Path |
|---|---|
| **Only extension point:** `GatewayFilter` | `src/eden/llmops/filters/base.py:18–41` |
| Filter pipeline in gateway | `src/eden/llmops/ai_gateway.py:593–629` |
| Exact + semantic cache, budgets | `ai_gateway.py:598–616` |
| zstd JSONB compression (~15×) | `src/eden/storage/compression.py` |
| Optimization layer | `src/eden/optimization/` |
| Budget service | `src/eden/services/budget_service.py` |
| OTel tail sampling config | `deploy/otel-collector-config.yaml` |
| Loop trace keep-rate hook | `wiring.py:23–27` (`detector_keep_rate_loop`) |

### Closed loop & improvement

| Asset | Path |
|---|---|
| HookBus + 20+ hook kinds | `src/eden/llmops/promotion_hooks.py`, `hooks_bus.py` |
| Closed-loop executor (v0 advisory) | `src/eden/llmops/closed_loop_executor.py` |
| Closed-loop portal API | `src/eden/api/routes/intelligence_closed_loop.py` |
| Insights → KB loop (running) | `src/eden/insights/detector_loop.py` (started in lifespan) |
| Judge prompt evolver + canary | `src/eden/agents/evolution/components.py` |
| Promotion loop | `src/eden/llmops/promotion.py` |
| Eval→guardrail link | `src/eden/evaluation/eval_intel/integration.py` (`EvalToGuardrailLink`) |
| Auto dataset from failures | `AutoDatasetBridge` same file |
| **F53 Dataset hub** | `src/eden/datasets/hub.py`, `api/routes/datasets_hub.py` |
| **F51 Offline experiments** | `src/eden/experiments/offline_runner.py`, `api/routes/experiments_offline.py` |
| **N01 Regression runner** | `src/eden/evaluation/regression_runner.py`, `ci_webhook.py` |
| **F50 Labeling queues** | **PARTIAL** — `src/eden/evaluation/labeling_queues.py` + workstation; full U06 → SOTA W18 |
| **F44 Auto curator** | `src/eden/evaluation/auto_curator.py` + `cron_tick` 02:00 UTC |
| **F52 Online scoring rules** | `src/eden/evaluation/online/rules_engine.py`, `api/routes/wave6_online.py` |
| **F79 Span scores** | `src/eden/evaluation/online/span_scores.py`, migration `102_wave6_online_quality` |
| **F54 Code evaluators** | `src/eden/evaluation/code_evaluator.py` (sandboxed, no imports) |
| **F55 Categorical classifiers** | `src/eden/evaluation/categorical_classifier.py` |
| **F61 Automations** | `src/eden/automations/engine.py` |
| **F57 Dashboards** | `src/eden/monitoring/dashboards.py`, `/dashboards/home` |
| **F60 Cost KPI API** | **DONE** — FinOps explorer `/finops/explorer` + KPI tiles with cache savings (`wave6_online.py` `/cost-analytics/kpi`) |
| **F66 Prompt workspace** | `src/eden/prompts/workspace.py` |
| **F68 Prompt deploy** | `src/eden/prompts/deploy.py`, `llmops/filters/prompt_deploy.py` |
| **F56 CI eval action** | `.github/actions/eden-eval/action.yml` + `/ci-eval/run` |
| **F76 SQL export** | `src/eden/evaluation/sql_export.py` |
| **F75 Late metadata** | `wave6_online.py` `/traces/{id}/metadata` (CustomPropertiesService) |
| **F73 PII settings** | `api/routes/pii_policy.py` + portal `settings/(tabs)/pii` |
| **F62 SLM hook** | **DONE (Phase 8):** `evaluation/online/slm_hook.py` — fast-tier cascade |
| Investigation agent | `src/eden/autonomous/investigation.py` |
| **SelfHealer (execute)** | **DONE (N21):** `heal_from_issue` — rollback/reweight/cache_bust when N22 allows |
| **Cat 23 code_change package** | **RETIRED (July 2026 bloat cut)** — ~62 files + `intelligence_code_change.py` removed; core patch modules salvaged to `src/eden/improvement/` per [N23](features/n23-recurring-improvement-agent.md) |
| `proposed_patches` (legacy) | **READ-ONLY** — historical rows preserved; new writes → `improvement_plans` (N23) |
| DriftAlertHook | `promotion_hooks.py` |
| **Autonomy policy engine** | **DONE (N22):** `closed_loop/autonomy_policy.py`; row seeded on new org create |
| **Heal / verify worker** | **DONE (F46):** `closed_loop/verify.py` + orchestrator learn hook |
| **Issue-scoped patch trigger** | **DONE (N23):** `improvement/issue_patch_trigger.py` → `improvement_plans` |
| **Scheduled optimization (weekly)** | **SHIPPED (v0)** — `DEFAULT_POLICY.optimization_schedule=weekly`, `schedule_due.is_optimization_due`, `cron_tick` → `scheduled_optimization` via `AgentEfficiencyController` |
| **AgentEfficiencyController** | **SHIPPED (v0)** — `closed_loop/efficiency.py` (triage/patch/scheduled coalesce) |
| **Issues + TriageAgent** | **SHIPPED** — `src/eden/issues/` (active-work suppress, severity/StatGate cache invalidate, optional budget) |
| **ClosedLoopOrchestrator** | **SHIPPED** — `closed_loop/orchestrator.py` |

### KB & procedural skills

| Asset | Path |
|---|---|
| Procedural skills (Skill Library) | `src/eden/kb/procedural/client.py` |
| Agent prompt seeds | `src/eden/kb/prompt_versions/seed.py` |
| Pattern → job insert (legacy, gated by `experiments_v1`) | `src/eden/api/routes/patterns.py:126–175` |
| A2A delegation links | `src/eden/services/observability/a2a_links.py` |
| Cat 6 fleet / handoff graph | `src/eden/agents/agent_intel/performance.py` |

### MCP & debugger

| Asset | Path |
|---|---|
| MCP ingest | `src/eden/api/routes/observability_mcp.py`, `sdk/mcp.py` |
| **Eden MCP server (F04)** | **SHIPPED (Wave 1)** — `src/eden/mcp_server/` tools: traces, issues, debugger, fix, improve queue; `eden-mcp` console script wired in `pyproject.toml`; self-telemetry (SEP-414 attrs); `rerun_mode`/cache-stats honesty. Stretch deferred: eql/sql/eval tools, `/v1/mcp/keys` CRUD, Streamable HTTP, separate PyPI package. |
| **Improvement cockpit (N17)** | **SHIPPED (v0)** — `src/eden/improvement/cockpit_aggregator.py`, `GET /orgs/{id}/improve/queue`, portal `/improve` |
| Hermetic debugger | `src/eden/debugger/checkpoints.py` |
| **Debugger prefix cache (F03)** | **SHIPPED (Phase 1)** — `cache.py` microbench (`microbench_llm_input_hash`, `microbench_backfill_throughput` ≥1k traces/hr); `PrefixCacheService`; checkpoint hook; flag `debugger_checkpoint_ingest_v1`. |
| **Cached-prefix live debugger (F01)** | **SHIPPED (Phase 6)** — `POST /debugger/rerun` `live_prefix=true` + `PrefixCacheService` on `LivePrefixEngine`; `microbench_prefix_replay` p95&lt;2s; portal toggle on `/traces?view=debug` |
| **Debug sessions (F74 / U13)** | **SHIPPED (Phase 6)** — `src/eden/debugger/session.py`; migration `103_wave7_debugger_browser`; `/debugger/sessions` API; portal `/debugger-sessions` |
| **Issue fix chat (F22)** | **DELETED (SOTA W26)** — removed `issue_fix_chat.py`, `/issues/[id]/fix`, fix routes/flags; use N20 `improvement_plans` + coding-agent handoff |
| **Autonomous code fix (N20)** | **DOGFOOD (SOTA W26)** — fingerprint≥5 → `improvement/issue_patch_trigger` → `improvement_plans`; N22 + cost-ledger budget; approve → GitHub App PR + N01 merge advice + N06 ledger |
| **Failure fixture export (D6)** | **SHIPPED (Phase 6)** — `src/eden/issues/fixture_export.py`; `POST /agent-issues/{id}/export-fixture`; issue one-click download |
| **Regression memory (D7)** | **SHIPPED (Phase 6)** — `RegressionCaseBuilder.list_for_issue`; GET/POST regression-cases; issue overview panel |
| **Browser recording (F09)** | **SHIPPED (Phase 6)** — `src/eden/replay/store.py`; `browser_sessions` API; `BrowserReplayPanel` on session page |
| **Agent session contract (D12)** | **SHIPPED (Phase 6)** — `GET /agent-sessions/contract`; F23 SDK + `agent_sessions` service |
| Checkpoint rewind | `src/eden/observability/checkpoint/rewind.py` |
| Compliance evidence | `src/eden/compliance/evidence_generator.py` |

### Search (F12)

| Asset | Path |
|---|---|
| **Typesense span search (F12)** | **SHIPPED (Phase 1)** — `search_service.py` + `typesense_client.py`; PII redacted at index (`TestPIIRedaction`); staging 10M p95 proof runbook `docs/ops/F12-STAGING-10M-SPAN-SEARCH.md` (**BLOCKED** — Typesense unavailable; local N=50k proxy only); `typesense_search_v1` flag; `eden_search_*` metrics. |
| **F84 dogfood status** | **PARTIAL (SOTA W0)** — `/orgs/{id}/admin/eden-status` + synthetics; full heartbeats/flags/MCP health → W9 |
| **F70 in-product copilot** | **DONE (SOTA W23)** — ChatSidebar is the copilot; not F22/MCP |

### Portal contracts (F48)

| Asset | Path |
|---|---|
| **Portal API contracts (F48)** | **SHIPPED (Wave 1)** — `clients/portal/src/lib/api.ts` `debuggerApi`/`signalsApi` paths/types match backend; dead `rewind`/`compile` removed; Signals + Debugger visible in sidebar; `/debugger?trace_id=…` deep-link reads `useSearchParams`; contract tests in `tests/unit/api/test_f48_portal_contracts.py`. |

### Portal OS & Observe (Phase 2 — Wave 3)

| Asset | Path / status |
|---|---|
| **U12 IA freeze** | **SHIPPED** — `sidebar-config.ts` ≤12 core items; Observe/Improve/Evaluate groups; `CORE_NAV_ITEM_COUNT`; legacy redirects in `next.config.ts` |
| **U00 portal-os** | **PARTIAL / REMOVED** — `clients/portal/src/components/portal-os/` **absent** (2026-08-07). Real shell: `AppShell` (`components/shell/app-shell.tsx`), `MobileBottomNav` (`components/shell/mobile-nav.tsx`), `SavedViewsMenu`. Fabricated names with 0 repo matches: `ResourcePageShell`, `CoreResourcePage`, `DetailPanelShell`, `DensityProvider`, `QueryFilterBar`, `ViewsMenu`, `InfiniteDataTable`, `BulkActionBar` |
| **U18 portal overhaul** | **PARTIAL** — `(portal)/layout.tsx` wired through `AppShell`; trace/issue/alert detail in `traces-client.tsx` / `issues-client.tsx` (no `DetailPanelShell` / `CoreResourcePage` — **UNVERIFIABLE**); mobile nav via `MobileBottomNav`; `portal-routes.ts` + `sidebar-config.ts`; `u18-portal.test.ts` evidence **DELETED** (cab7ae32) |
| **U19 portal improvement** | **PARTIAL** — `lib/portal-cross-links.ts` matrix (no `CrossLinkBar` component); `portal-polish.ts`; bulk/archive via page-local UX (no `BulkActionBar`); `DriftHistogram` **UNVERIFIABLE**; `u19-portal.test.ts` evidence **DELETED** (cab7ae32) |
| **U20 portal polish** | **PARTIAL** — `lib/portal-polish.ts` (axe routes, microcopy, toast registry); motion via CSS tokens; toasts on mutations; `scripts/audit-a11y.cjs`; `portal-ci.yml` a11y job; `status-badge.tsx` **REMOVED**; `u20-portal.test.ts` evidence **DELETED** (cab7ae32) |
| **F58 / U08 saved views** | **SHIPPED** — wraps Phase N `saved-searches` API via `savedViewsApi`; `?view=` + `?q=` on `/traces` |
| **U01 traces hub** | **SHIPPED** — `/traces` with `traces-client.tsx` + `traces-detail-panels.tsx`; split-pane detail; `?traceId=` deep-link; virtualized list/transcript via `@tanstack/react-virtual` |
| **F23 agent sessions** | **SHIPPED** — `sdk/python/eden_sdk/session.py` `begin()`; `agent_sessions` table + API; Sessions tab + `/sessions/[sessionId]` |
| **N12 session timeline** | **SHIPPED** — `SessionTurnTimeline` + `TurnCard` on session page; keyboard ←/→ |
| **N13 transcript v2** | **PARTIAL** — `traces-detail-panels.tsx` virtualized transcript/tree; swimlanes / RRWeb types present; **F21 labels DONE (W27)**; `TranscriptV2` / `VirtualizedTranscript` component names **UNVERIFIABLE** (0 repo matches) |
| **N11 live streaming** | **DONE (W27)** — Redis `trace:live:{org}:{session}`; `observability/live/*` + `observability_live` routes; portal Live badge; SDK `EDEN_LIVE`/`stream=True`; MCP `tail_trace` |
| **F21 tool labels** | **DONE (W27)** — label API + calibrator; transcript ✓/✗; MCP `label_tool_call`; mig `111_w27_live_labels` |

### Signals & topics (Phase 7 — Wave 8)

| Asset | Path / status |
|---|---|
| **F06 Signal clusterer** | **SHIPPED** — `src/eden/signals/clusterer.py`; cosine grouping; 7d quiet auto-resolve |
| **F06 Signal backfill** | **SHIPPED** — `src/eden/signals/backfill.py`; `signal_backfill_jobs`; 100 traces/min; cron drain |
| **F06 Investigator API** | **SHIPPED** — `api/routes/signal_investigator.py` events/clusters/backfill |
| **F65 Topics** | **SHIPPED** — `src/eden/topics/service.py`, `api/routes/topics.py`; portal `/insights/topics` |
| **F71 Slack interactive** | **SHIPPED** — `integrations/slack/interactive.py`; `/integrations/slack/{commands,interactions}` |
| **N10 Search→signal** | **SHIPPED (backend)** — `search/deep_to_signal.py` preview + backfill; portal `SpanSearchBar` save button **UNVERIFIABLE** (0 repo matches) |

### Enterprise fleet & audit (Phase 9 — Wave 10 P1)

| Asset | Path / status |
|---|---|
| **N05 Fleet health** | **SHIPPED** — `src/eden/fleet/service.py`, `api/routes/fleet.py`; portal `/fleet` + Agents tab; severity score; heatmap; delegation graph; SLA breaches; N22 autonomy + F42 drift badges; N17 queue sorted by fleet severity |
| **N06 Audit trail** | **SHIPPED** — `src/eden/governance/compliance_pack.py` (`AgentAuditLedgerWriter`, `CompliancePackGenerator`); `POST /compliance/verify` chain attestation; portal `/audit-trail` (product name **Audit trail**, not Ledger); JSON pack export |

---

## 3. App lifespan (`src/eden/api/app.py`) — what actually starts

| Started | Notes |
|---|---|
| Alembic upgrade | Non-fatal on failure |
| KB init + probe | |
| `install_all()` (N14) | **Every API pod** — StatGate + Cat 15/17/22 |
| Insights detector loop | Leader-gated |
| Anomaly detector loop | Leader-gated |
| Evolution loop | Leader-gated |
| `register_all_hooks()` | Leader-gated; F46 orchestrator + demote wired |
| quality_pipeline worker | **Leader-gated** — Postgres watermark sidecar |
| F20 `trace_finalized` consumer | **Leader-gated** — Redis stream (separate bus) |
| F46 closed-loop event consumer | Leader-gated |
| F46 verify worker | Leader-gated |

**Architecture:** Quality sidecar ≠ F20 consumer. Do not merge buses.

---

## 4. Spec accuracy rules

1. **Greenfield modules** — mark as MISSING; list exact path to create
2. **Wire before build** — N14 before F20/F28 if ETEC data needed live
3. **Gateway changes** — implement as `GatewayFilter`, not monkey-patch `complete()`
4. **Failure reproduction** — use D6 fixture export + F01 debugger + N01 regression; do not reference removed env-gen / N07
5. **Cost claims** — cite `storage/compression.py` (15× zstd) + N09 dedupe + N16 sampling
6. **Autonomous actions** — always gate with N22 + log to N06; `SelfHealer` executes rollback/reweight/cache_bust when policy allows; Cat 23 **removed** — recurring PR agent is [N23](features/n23-recurring-improvement-agent.md)
7. **Autonomy flags** — `autonomous_actions_v0`, `code_change_enabled`, `evolver_auto_canary_pct` in `config.py` — N22 unifies

---

## 5. Autonomous maintenance config (`config.py`)

| Flag | Default | Spec |
|---|---|---|
| `autonomous_actions_v0` | gated | N21 execute |
| `code_change_enabled` | false | N20 |
| `evolver_auto_canary_pct` | 5 | N18 |
| `evolver_min_samples` | 20 | N18 |
| `patch_max_per_day` | env | N20 |
| `patch_cluster_min_size` | env | N20 |

Org override: `organizations.features.code_change_policy` JSONB.

---

*Update this file when wiring gaps close.*
