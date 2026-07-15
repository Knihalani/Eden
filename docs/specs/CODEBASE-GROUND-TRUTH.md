# Eden Codebase Ground Truth (for Spec Authors)

> **Purpose:** Keep specs accurate — what is **shipped**, **partial**, **stub**, or **retired** in `/workspace/src/eden`.  
> **Last audit:** July 15, 2026 (bloat-cut pass — Cat 23 retired, N23 spec)  
> **Phase 0 delta:** July 12, 2026 — see [`.omc/autopilot/ground-truth-delta.md`](../../.omc/autopilot/ground-truth-delta.md). Waves 0–7 on `main` landed issues + closed_loop; rows below marked **STALE→FIXED**.  
> **Wave 1 delta:** July 15, 2026 — F48 portal contracts, F03 prefix cache, F12 search harden, F04 MCP reliability all exit Wave 1. See MCP & debugger, Search, and Portal contracts sections below.

Use this doc when writing implementation steps. Specs MUST NOT assume modules exist without checking here.

---

## 1. Critical wiring gaps (fix before feature UX)

| Gap | Spec says | Reality | Fix spec |
|---|---|---|---|
| Trace quality worker | Running on ingest | **STALE→FIXED (Phase 0):** started in `app.py` lifespan | **N14** |
| StatGate wiring | Active | `trace_quality/wiring.py:install_all()` — verify still not called from lifespan | **N14** |
| `register_all_hooks()` | Registers hooks | `promotion_hooks.py` — still no-op shim / lazy singletons (confirm) | **N14**, F46 |
| `src/eden/issues/` | F28/F29/F20 | **SHIPPED (Wave 2 full):** stumble→issue→triage→Slack loop; `detection_settings.py`, SDK `eden.record_stumble()`, MCP `get_trace_stumbles`, F35 bridge | F28–F30, F35, F47 |
| Per-trace signal investigator | F06 | **PARTIAL** — `signals/investigator.py` (StatGate-first + F35 LLM batch); cluster/backfill still missing | F06 |
| `src/eden/promotion/evidence_gate.py` | F41 | **PARTIAL** — StatGate + HookBus shipped; `EvidenceGate` service + `promotion_candidates` table still greenfield | F41 |
| `src/eden/closed_loop/orchestrator.py` | F46 | **STALE→FIXED:** `closed_loop/` shipped + lifespan consumers | F46 |
| Runtime nudges in gateway | F39 | **PARTIAL** — `NudgeEngine` + `NudgeGatewayFilter` wired via `learn_wiring.py`; missing author-from-issue, demotion, dedicated UI, YAML export | F39 |
| LangGraph env-gen pipeline | **REMOVED (N07)** | **RETIRED** — use D6 fixture export + D7 regression memory instead | — |
| `trace_quality_*` settings | Config | In `prompts/06_settings.md` only, **not in `config.py`** | N14 |
| Weekly optimization cron | Recurring PRs | **STALE→FIXED:** `DEFAULT_POLICY.optimization_schedule`, `cron_tick.scheduled_optimization` | Phase 1C |
| Patch `linked_files` | From triage/RCA | **STALE→FIXED:** `issue_patch_trigger` resolves via RCA linker + triage hints | Phase 1B |
| Triage budget | Optional per org | **STALE→FIXED:** optional org budget in TriageAgent (unset=unlimited) | Phase 1A |

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
| Investigation agent | `src/eden/autonomous/investigation.py` |
| **SelfHealer (queue only)** | `investigation.py` — rollback/reweight/cache_bust |
| **Cat 23 code_change package** | **RETIRED (July 2026 bloat cut)** — ~62 files + `intelligence_code_change.py` removed; core patch modules salvaged to `src/eden/improvement/` per [N23](features/n23-recurring-improvement-agent.md) |
| `proposed_patches` (legacy) | **READ-ONLY** — historical rows preserved; new writes → `improvement_plans` (N23) |
| DriftAlertHook | `promotion_hooks.py` |
| **Autonomy policy engine** | **SHIPPED** — `closed_loop/autonomy_policy.py` (N22) |
| **Heal / verify worker** | **SHIPPED (partial)** — `closed_loop/verify.py` started in lifespan |
| **Issue-scoped patch trigger** | **SALVAGED (v0)** — `issue_patch_trigger.py` (moving to `improvement/`) resolves `linked_files` via RCA linker + triage hints; will enqueue `improvement_plans` under N23 |
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
| **Debugger prefix cache (F03)** | **SHIPPED (Wave 1)** — `src/eden/debugger/cache.py` (`llm_input_hash`, `PrefixCacheService`); `096_debugger_llm_cache.py` Alembic migration; `checkpoint_hook.py` upserts both audit (`CheckpointStore`) + cache rows; `LivePrefixEngine` prefers `debugger_llm_cache`; flag `debugger_checkpoint_ingest_v1`. Stretch: 1k-trace/hr backfill bench, hot-path p99 microbench. |
| Checkpoint rewind | `src/eden/observability/checkpoint/rewind.py` |
| Compliance evidence | `src/eden/compliance/evidence_generator.py` |

### Search (F12)

| Asset | Path |
|---|---|
| **Typesense span search (F12)** | **SHIPPED (Wave 1)** — `src/eden/observability/search_service.py` + `typesense_client.py`; EQL/Postgres fallback when Typesense unavailable; PII redacted at index; `typesense_search_v1` flag; `eden_search_*` Prometheus metrics; 90d TTL cleanup cron; portal `SpanSearchBar.tsx` fallback banner. Stretch: 10M-span p95 <200ms load bench (measure in staging before GA). |

### Portal contracts (F48)

| Asset | Path |
|---|---|
| **Portal API contracts (F48)** | **SHIPPED (Wave 1)** — `clients/portal/src/lib/api.ts` `debuggerApi`/`signalsApi` paths/types match backend; dead `rewind`/`compile` removed; Signals + Debugger visible in sidebar; `/debugger?trace_id=…` deep-link reads `useSearchParams`; 9 contract tests green in `tests/unit/api/test_f48_portal_contracts.py`. |

---

## 3. App lifespan (`src/eden/api/app.py`) — what actually starts

| Started | Notes |
|---|---|
| Alembic upgrade | Non-fatal on failure |
| KB init + probe | |
| Insights detector loop | |
| Anomaly detector loop | |
| Evolution loop | |
| `register_all_hooks()` | Still primarily lazy/no-op shim — confirm |
| quality_pipeline worker | **STARTED** (was NOT on Jul 9) |
| F20 `trace_finalized` consumer | **STARTED** |
| F46 closed-loop event consumer | **STARTED** |
| F46 verify worker | **STARTED** |

**Still verify / not assumed:** `trace_quality/wiring.py:install_all()`, judge Redis tailer (per deploy).

---

## 4. Spec accuracy rules

1. **Greenfield modules** — mark as MISSING; list exact path to create
2. **Wire before build** — N14 before F20/F28 if ETEC data needed live
3. **Gateway changes** — implement as `GatewayFilter`, not monkey-patch `complete()`
4. **Failure reproduction** — use D6 fixture export + F01 debugger + N01 regression; do not reference removed env-gen / N07
5. **Cost claims** — cite `storage/compression.py` (15× zstd) + N09 dedupe + N16 sampling
6. **Autonomous actions** — always gate with N22 + log to N06; `SelfHealer` queue-only; Cat 23 **removed** — recurring PR agent is [N23](features/n23-recurring-improvement-agent.md) (spec only)
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
