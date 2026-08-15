# Autonomous Error Diagnosis & Maintenance Loop — Implementation Prompt

> **Audience:** A stronger implementation model executing this work in the Eden repo.  
> **Goal:** Wire disconnected diagnosis capabilities into a continuous loop that detects issues, diagnoses root cause, escalates appropriately, and prevents repeat/cost blowups — without rebuilding what already ships.  
> **Ground truth:** Read `docs/specs/CODEBASE-GROUND-TRUTH.md`, `docs/specs/AUTONOMOUS-MAINTENANCE.md`, and `docs/specs/FEATURE-GAP-MASTER.md` before coding.  
> **Constraints:** Follow `prompts/01_constraints.md` through `prompts/10_iteration.md` for repo-wide rules.

---

## 0. What you are actually building

Eden already has **pieces** of error diagnosis. There is no single wired system. Your job is to connect them into a loop:

```
monitor → detect → triage/diagnose → escalate (alert | recommend | heal | PR | human)
         → verify → learn → (cost/dedup gates throughout)
```

**Do not** treat `InvestigationAgent` as the whole product. It is one tool inside a larger orchestration layer (F46) that must be triggered automatically — not only via manual portal POST.

**Do not** rebuild:** StatGate (`supplementaries/phase_6_stat_gate/gate.py`), quality sidecar (`observability/quality_pipeline/worker.py`), HookBus (`llmops/hooks_bus.py`), RCA rules (`insights/rca/analyzer.py`), or Cat 23 scheduler (`code_change/scheduler.py`). Extend and wire them.

---

## 1. As-implemented baseline (verify before changing)

| Component | Path | Today |
|-----------|------|-------|
| LLM investigation (manual) | `src/eden/autonomous/investigation.py` | `InvestigationAgent.investigate(org_id, trigger="type:id")` — 4 trigger types |
| Rule-based RCA (manual) | `src/eden/insights/rca/analyzer.py` | `RootCauseAnalyzer.categorize/explain` — on-demand POST |
| Incident clustering | `src/eden/insights/incidents/clusterer.py` | Runs via insights loop; hooks broken |
| Closed-loop queue | `src/eden/llmops/closed_loop_executor.py` | `apply_approved()` is **v0 no-op** |
| Hook recording | `src/eden/llmops/promotion_hooks.py` | 20+ hooks; `register_all_hooks()` is **no-op** |
| Self-heal | `investigation.py:419` `SelfHealer` | Queue + manual execute routes; no worker |
| Code patches | `src/eden/code_change/scheduler.py` | Cluster-based; not issue-scoped |
| Trace quality | `observability/trace_quality/wiring.py` | `install_all()` exists; **not called** |
| Quality worker | `observability/quality_pipeline/worker.py` | `start_worker()` exists; **not called** |
| Issues layer | `src/eden/issues/` | **Does not exist** |
| Orchestrator | `src/eden/closed_loop/` | **Does not exist** |
| Policy engine | N22 | **Does not exist** |

### Lifespan reality (`src/eden/api/app.py`)

| Started | Lines | Notes |
|---------|-------|-------|
| Insights detector loop | ~296–308 | `start_insights_detector_loop()` |
| `register_all_hooks()` | ~311–318 | Logs only — no subscriptions |
| `shutdown_trace_quality()` | ~377–382 | Teardown exists; startup wiring missing |

### Latest migration

Alembic tip: **`083`** (`src/eden/db_migrations/versions/083_fix_pr_rejection_memory_index.py`). New migrations start at **`084_`**.

---

## 2. Known bugs — fix these as you wire (not optional polish)

These are real defects blocking a working loop. Fix them in the wave where you touch each file; add regression tests.

| ID | File | Bug | Fix direction |
|----|------|-----|---------------|
| G1 | `api/app.py` lifespan | `install_all()` + `start_worker()` never called | N14 activation task |
| G2 | `config.py` | `trace_quality_*`, `stat_gate_*`, `quality_pipeline_*` missing | Copy from `prompts/06_settings.md` |
| G3 | `clients/portal/src/lib/api.ts` + `autonomous/page.tsx` | Portal sends `{question, trace_id?}`; API expects `{trigger}` | Align contract (see Task 0.3) |
| G4 | `incidents/clusterer.py:489–520` | `_fire_drift_alerts` calls `on_drift_alert` (rollback_canary), never `IncidentHook.on_clustered`; async not awaited | Call `get_incident_hook().on_clustered(...)` with `await` |
| G5 | `autonomous/_common.py:304` | `incident:` trigger queries `cluster_id` column; table PK is `id` | `WHERE id = $2` (match `_fetch_cluster_row` in `rca/_common.py:259`) |
| G6 | `hooks_bus.py:353` | `_persist_hook_event` hardcodes `action_kind='hook_bus'` | Use `_infer_action_kind(event)` |
| G7 | `code_change/scheduler.py:416–444` | `PromotionHook.on_drift_alert` called as classmethod; invalid kwargs | Instance call + correct signature |
| G8 | `closed_loop_executor.py:301–308` | `apply_approved` fetches `limit=1` then scans for id | Fetch by `action_id` directly |
| G9 | `promotion_hooks.py:1667` | `register_all_hooks()` no-op | Replace with orchestrator subscription (F46) |
| G10 | `quality_pipeline/worker.py:1082` | Settings attrs missing → worker no-ops even if called | G2 first |
| G11 | `SelfHealer.approve` ~L546 | `on_drift_alert(..., context=)` invalid kwarg | Match `DriftAlertHook` signature |

---

## 3. Escalation model (what the loop must decide)

Implement escalation as **policy-gated actions**, not as a single LLM call. Tiers are ordered; each step checks N22 policy + cost gates before proceeding.

| Tier | Name | Mechanism | Cost profile | Existing code to reuse |
|------|------|-----------|--------------|------------------------|
| T0 | Observe | Record stumble/issue, metrics only | $0 | New F28 writer |
| T1 | Alert | Slack Block Kit (F47), `eden_alerts` stream | $0 | `observability/alerts.py` pattern |
| T2 | Deterministic diagnose | StatGate P0 + RCA rules | $0 | `supplementaries/phase_6_stat_gate/gate.py`, `rca/analyzer.py`, `_classify_events` in `rca/_common.py:818` |
| T3 | LLM triage | Issue-scoped ReAct or single-shot fallback | $ | Extend `InvestigationAgent` → `TriageAgent` |
| T4 | Recommend | `closed_loop_actions` row, portal approval | $0 | `promotion_hooks._record_action`, `ClosedLoopExecutor` |
| T5 | Runtime heal | rollback / reweight / cache_bust | $0 | `SelfHealer.execute_heal` |
| T6 | Code fix PR | PatchGenerator → review inbox | $$ | `code_change/scheduler.py`, `PatchGenerator` |
| T7 | Human escalate | N17 cockpit + F47 urgent | $0 | Hook `requires_human_approval=True` |

### Cost / repeat-prevention gates (apply at every tier)

| Gate | Where | Behavior |
|------|-------|----------|
| Hook dedup | `hooks_bus.py` | 5 min window per `(reason, org_id, entity_id)` |
| Severity suppression | `hooks_bus.py` | Same severity within 1h → increment `repetition_count` only |
| Cascade depth | `hooks_bus.py` | Max 5 parent→child hook depth |
| StatGate-first | F30/N08 | P0 loop → skip LLM triage |
| LLM budget | N22 `daily_maintenance_budget_usd` | Deny T3+ when exceeded |
| Patch caps | `config.py` | `patch_max_per_day`, `patch_cluster_min_size`, `max_cost_per_user_per_day` |
| Kill switches | `config.py` `_KILL_SWITCH_DEFAULT` | Per-action defaults |

---

## 4. Trigger catalog (what should auto-start diagnosis)

Map each signal to: **detector → issue/stumble → orchestrator event → escalation tier**.

| Signal source | Event | Target tier | Wire point |
|---------------|-------|-------------|------------|
| `trace.finalized` (new stream) | F20 auto-scan hit | T0→T1 if P0/P1 | New `workers/trace_finalized_consumer.py` |
| ETEC loop P0 | StatGate in quality worker | T2→T5 if deploy regression | `quality_pipeline/worker.py` after step 3 |
| Incident cluster ≥10 high/critical | `on_incident_clustered` | T2→T3 | Fix `clusterer.py` G4 |
| Judge regression | `on_judge_regression` | T3→T4 | Already records; orchestrator must consume |
| Drift alert | `on_drift_alert` | T2→T4 | `DriftAlertHook` |
| SLA breach / MCP auth / provider failures | Various hooks in `ACTION_KIND` map | T1→T7 | `promotion_hooks.py:55–88` |
| N03 eval drop >2σ | Insights detector | T2→T3 | `insights/detector_loop.py` — emit loop event |
| User satisfaction drop | `on_low_user_satisfaction` | T3 | Hook exists; orchestrator missing |
| Repeat fingerprint ≥5/24h | F29 promoter | T3→T6 | IssuePromoter threshold |

**Manual triggers remain:** `POST .../intelligence/autonomous/investigate` and `POST .../intelligence/rca/{trace_id}/analyze`.

---

## 5. Implementation waves (task-oriented)

Work in order. Each wave has concrete deliverables, files, tests, and verification steps. You may adjust internal design within a wave; do not skip waves.

---

### Wave 0 — Platform activation & contract repair (N14 + G1–G3)

**Outcome:** Existing backends actually run; portal can call investigate without 422.

#### Task 0.1 — Add missing Settings fields

- **File:** `src/eden/config.py`
- **Source of truth:** `prompts/06_settings.md`
- **Add:** `trace_quality_enabled`, `trace_quality_compute_async`, `traceloop_auto_apply`, `stat_gate_min_n`, `stat_gate_min_effect`, `detector_keep_rate_loop`, `detector_keep_rate_error`, `quality_pipeline_workers`, `quality_pipeline_watermark_poll_ms`, `quality_pipeline_batch_size`, `default_action_applied_flag`, `enhancements_*`
- **Verify:** `get_settings().trace_quality_enabled` returns `True`; `worker.py:start_worker` no longer exits early on missing attrs
- **Test:** Extend `tests/api/test_hot_path_p99_regression.py` or add `tests/intelligence/test_n14_activation.py`

#### Task 0.2 — Wire lifespan startup

- **File:** `src/eden/api/app.py` (~after line 318, before `yield`)
- **Do:**
  1. `from eden.observability.trace_quality.wiring import install_all` → call once at startup
  2. `from eden.observability.quality_pipeline.worker import start_worker, stop_worker` → `await start_worker()` startup, `await stop_worker()` in shutdown block (~after insights loop stop)
- **Pattern:** `test_wiring_install_all_idempotent` in `tests/api/test_hot_path_p99_regression.py:154`
- **Verify:** Startup logs contain wiring + quality_pipeline messages; health endpoint reports worker running (add field if missing)
- **Do not:** Call `install_all()` multiple times per request — once per process only

#### Task 0.3 — Fix portal ↔ API contract for autonomous surface

- **Files:**
  - `clients/portal/src/lib/api.ts` (~L3007–3023)
  - `clients/portal/src/app/(portal)/autonomous/page.tsx`
  - Optionally `src/eden/api/routes/intelligence_autonomous.py` if you add a compatibility shim
- **Backend contract today:** `POST /investigate` body `{ "trigger": "incident:<uuid>" | "drift_alert:<id>" | ... }`
- **Choose one approach (document in PR):**
  - **A (preferred):** Update portal to send `trigger` — add trigger picker or derive from trace_id (`incident:` lookup)
  - **B:** Add optional `question` + `trace_id` to backend that resolves to a trigger server-side
- **Also fix:** `heal` body (`action_type` not `component`), `report` (`period` not `topic`/`period_days`), response envelope (`data.findings` is list, not string)
- **Test:** Add `tests/intelligence/test_portal_autonomous_contract.py` or portal integration test

#### Task 0.4 — Fix incident investigation trigger resolver (G5)

- **File:** `src/eden/autonomous/_common.py:301–308`
- **Change:** `cluster_id` → `id` in SQL
- **Test:** `tests/intelligence/test_autonomous_intelligence.py` — add case `trigger="incident:<uuid>"` with mock row

#### Task 0.5 — Fix clusterer → IncidentHook wiring (G4)

- **File:** `src/eden/insights/incidents/clusterer.py`
- **Change `_fire_drift_alerts`:**
  - Make async (or schedule with `asyncio.create_task` from async caller)
  - For qualifying clusters: `await get_incident_hook().on_clustered(org_id, cluster_id=..., trace_count=..., sample_trace_ids=...)`
  - Keep `on_drift_alert` only when rollback semantics apply (separate threshold)
- **Test:** New `tests/intelligence/test_incident_hook_clusterer.py`

**Wave 0 acceptance:**
- [ ] `install_all()` + `start_worker()` run on API startup
- [ ] `trace_quality_*` settings exist and are env-driven
- [ ] Portal investigate POST returns 200 (not 422)
- [ ] `incident:<id>` trigger resolves against `incident_clusters.id`

---

### Wave 1 — Issues foundation (F28 + F29 + migration 084)

**Outcome:** Atomic stumbles and grouped issues exist; hooks can fire on new issues.

#### Task 1.1 — Create `src/eden/issues/` package

```
src/eden/issues/
  __init__.py
  models.py          # StumbleKind enum, dataclasses
  fingerprint.py     # compute_fingerprint() per F29 spec
  stumble_writer.py  # StumbleWriter.create() with dedup
  issue_promoter.py  # IssuePromoter.upsert() on new stumble
  repo.py            # Postgres CRUD
```

- **Spec:** `docs/specs/features/f28-agent-stumbles.md`, `f29-agent-issues-sentry.md`
- **Reuse:** `_fetch_trace_events` from `insights/rca/_common.py:104`; severity helpers `_severity_for_count` at `:898`
- **Dedup:** `UNIQUE (trace_id, kind, fingerprint)` on stumbles; `UNIQUE (org_id, fingerprint)` on issues

#### Task 1.2 — Migration `084_agent_issues.py`

- **Tables:** `agent_stumbles`, `agent_issues`, `issue_stumble_link` (if needed)
- **Indexes:** per F29 — `(org_id, status, severity, last_seen DESC)`, `(org_id, fingerprint, detected_at DESC)`
- **Do not** use raw `migrations/` SQL folder — use Alembic in `src/eden/db_migrations/versions/`

#### Task 1.3 — API routes

- **File:** `src/eden/api/routes/agent_issues.py` (new)
- **Mount in:** `src/eden/api/app.py`
- **Routes:** `GET /orgs/{org_id}/agent-issues`, `GET .../{id}`, `POST .../{id}/resolve`, `GET /orgs/{org_id}/stumbles`
- **Pattern:** Copy envelope style from `intelligence_autonomous.py`

#### Task 1.4 — Hook on issue create

- **File:** `src/eden/llmops/promotion_hooks.py`
- **Add:** `on_issue_created` handler → `_record_action(..., action_kind="investigate")` + emit to orchestrator event bus (Wave 3)
- **Test:** `tests/intelligence/test_agent_issues.py`

**Wave 1 acceptance:**
- [ ] `StumbleWriter.create()` persists and promotes to issue
- [ ] Second identical stumble increments `stumble_count`, not duplicate issue
- [ ] Resolve → regressed on new matching stumble

---

### Wave 2 — Auto detection (F20 + trace.finalized consumer)

**Outcome:** Issues appear without operator configuration.

#### Task 2.1 — Emit `trace.finalized` events

- **Find:** Where traces complete today — likely `observability/` telemetry collector or trace store finalization
- **Add:** Redis `XADD trace.finalized` with `{org_id, trace_id, agent_id, session_id, user_id, finalized_at}`
- **Stream:** Single global stream or per-org — match existing Redis patterns in `observability/alerts.py` (`eden_alerts`)

#### Task 2.2 — `AutoIssueScanner`

- **File:** `src/eden/issues/auto_scanner.py`
- **Implement 7 detectors** from F20 spec (start with 4: `tool_error`, `loop_detected`, `task_failure`, `slow_trace`)
- **Reuse:**
  - Loop: quality report / ETEC attrs from sidecar output
  - Tool error: `_classify_events` patterns
- **Concurrency:** 5 scans/org max; batch with semaphore

#### Task 2.3 — Consumer worker

- **File:** `src/eden/workers/trace_finalized_consumer.py`
- **Register:** In `app.py` lifespan (after quality worker)
- **Flow:** XREADGROUP → `AutoIssueScanner.scan()` → `StumbleWriter` → `IssuePromoter`
- **Test:** `tests/intelligence/test_auto_issue_scanner.py` with fixture trace events

**Wave 2 acceptance:**
- [ ] Finalizing a trace with TOOL error creates stumble + issue within 60s
- [ ] Loop trace (ETEC ≥0.85) creates `loop` stumble
- [ ] Detectors respect org `detection_profile` (add settings row or default `standard`)

---

### Wave 3 — StatGate scorer + triage (N08 + F30)

**Outcome:** Issues get structured `triage_result`; LLM skipped when StatGate P0.

#### Task 3.1 — `StatGateIncidentScorer`

- **File:** `src/eden/issues/statgate_scorer.py`
- **Wrap:** `supplementaries/phase_6_stat_gate/gate.py`
- **Output:** `{auto_escalate: bool, p0_checks: [...], suggested_heal: "rollback"|"cache_bust"|None}`
- **Test:** Deterministic cases — no LLM mock needed

#### Task 3.2 — `TriageAgent`

- **File:** `src/eden/issues/triage_agent.py`
- **Flow:**
  1. Load issue + top 5 example stumbles/traces
  2. Run `StatGateIncidentScorer` — if P0, write deterministic `triage_result`, return
  3. Else ReAct loop (max 8 tool calls, 90s) OR extend `InvestigationAgent.investigate` with `trigger="issue:<id>"`
- **Tools (implement minimally):** `GetTranscriptTool`, `GetTraceQualityTool`, `SearchSimilarIssuesTool`
- **Persist:** `agent_issues.triage_result` JSONB
- **Route:** `POST /orgs/{org_id}/agent-issues/{id}/triage`

#### Task 3.3 — Add `issue:` trigger type

- **File:** `src/eden/autonomous/_common.py` — extend `KNOWN_TRIGGER_TYPES` + resolver
- **Wire:** Orchestrator auto-calls triage on `issue_created` (Wave 4)

**Wave 3 acceptance:**
- [ ] P0 loop issue triages in <200ms without LLM
- [ ] Non-P0 issue produces `triage_result` with `suggested_actions[]`
- [ ] Triage respects N22 budget (deny LLM when over cap)

---

### Wave 4 — Closed-loop orchestrator (F46)

**Outcome:** Events drive state machine; disconnected hooks become one loop.

#### Task 4.1 — Create `src/eden/closed_loop/` package

```
src/eden/closed_loop/
  __init__.py
  events.py           # LoopEvent dataclass, event types
  orchestrator.py     # ClosedLoopOrchestrator.on_event()
  state_machine.py    # OPEN → TRIAGED → FIX_PENDING → VERIFYING → RESOLVED/REGRESSED
  event_bus.py        # Redis stream eden.loop.events
  subscribers.py      # Bridge from hooks/issues/quality worker
```

- **Spec:** `docs/specs/features/f46-closed-loop-orchestrator.md`
- **State table:** `issue_state_transitions` — migration `085_issue_state_transitions.py`

#### Task 4.2 — Implement `on_event` handlers

For each event type, write a handler that calls existing services:

| Event | Handler must call |
|-------|-------------------|
| `stumble_created` | `IssuePromoter` (if not already), maybe alert T1 |
| `issue_created` | `_schedule_triage`, F47 alert if P0/P1 |
| `triage_completed` | `_suggest_fix_actions`, `_maybe_autonomous_heal`, `_maybe_autonomous_patch` |
| `heal_executed` | `_transition(FIX_PENDING)`, schedule verify |
| `verify_passed` | resolve issue, N01 regression case (stub OK), N19 KB (stub OK) |
| `verify_failed` | regress, escalate T7 |
| `statgate_p0` | priority heal path |

#### Task 4.3 — Replace `register_all_hooks()` body

- **File:** `src/eden/llmops/promotion_hooks.py:1667`
- **Do:** `ClosedLoopOrchestrator.subscribe()` — register listeners that translate hook callbacks → `LoopEvent` → `XADD eden.loop.events`
- **Also fix G6** in `hooks_bus.py` while here

#### Task 4.4 — Consumer

- **Start in lifespan:** Single consumer group `eden-closed-loop` per deployment
- **Idempotency:** Event id in Redis stream entry; dedup in Postgres

#### Task 4.5 — Implement `ClosedLoopExecutor.apply_approved` handlers (G8)

- **File:** `src/eden/llmops/closed_loop_executor.py`
- **Map `action_kind` → handler:**
  - `investigate` → `InvestigationAgent.investigate` or `TriageAgent.triage`
  - `rollback` / `reweight` / `cache_bust` → `SelfHealer`
  - `propose_patch` → `code_change` path
- **Gate:** `install_cat17_stat_gate_gating` already wraps apply — ensure it runs (Wave 0)

**Wave 4 acceptance:**
- [ ] New issue auto-triages within 90s
- [ ] `on_incident_clustered` flows: cluster → hook → orchestrator → triage
- [ ] Approved closed-loop action executes real side effect (not `v0_noop`)
- [ ] State transitions logged in `issue_state_transitions`

---

### Wave 5 — Autonomy policy engine (N22)

**Outcome:** Escalation tiers are gated per org/agent; cost caps enforced.

#### Task 5.1 — Policy module

- **File:** `src/eden/closed_loop/autonomy_policy.py`
- **API:** `resolve(org_id, agent_id) -> AutonomousMaintenancePolicy`, `may(policy, action) -> bool`
- **Migration:** `086_autonomy_policies.py` — tables per N22 spec
- **Seed:** Org default from scattered flags: `autonomous_actions_v0`, `code_change_enabled`, `auto_pr_enabled`

#### Task 5.2 — Integrate into orchestrator

Before T5/T6/T7, call `autonomy_policy.may(policy, "self_heal"|"code_patch"|"alert")`.
Log denials to `autonomy_audit_log`.

#### Task 5.3 — Policy API + portal settings page (minimal)

- `GET/PATCH /orgs/{org_id}/settings/autonomy`
- Expose `maintenance_mode`: `observe` | `assisted` | `autonomous`

**Wave 5 acceptance:**
- [ ] `observe` mode: detect + triage + alert only; no heal execute
- [ ] `hipaa` profile forces observe
- [ ] Daily LLM budget blocks triage when exceeded

---

### Wave 6 — Remediation execution (N21 + N20)

**Outcome:** Triage suggestions become heals or PRs; verify loop closes issues.

#### Task 6.1 — `SelfHealer.heal_from_issue(issue_id)`

- **File:** `src/eden/autonomous/investigation.py`
- **Map** `triage_result.suggested_actions` → heal action_type
- **Fix G11** invalid kwargs in approve path

#### Task 6.2 — Issue-scoped patch trigger (N20)

- **File:** `src/eden/code_change/issue_patch_trigger.py` (new)
- **Wire:** orchestrator `_maybe_autonomous_patch` → `PatchGenerator.generate(rca_id=issue_id, ...)`
- **Fix G7** in scheduler while touching code_change

#### Task 6.3 — Verify loop (stub → real)

- **File:** `src/eden/closed_loop/verify.py`
- **V1 checks:** stumble rate on fingerprint drops to 0 for 30min; StatGate P0 cleared
- **Schedule:** Delayed job 5–30min post-heal (asyncio or Redis delayed queue)

#### Task 6.4 — Heal executor worker (optional if manual execute sufficient for v1)

- Background task that processes approved heals — only if portal approval latency is too high

**Wave 6 acceptance:**
- [ ] Triage `root_cause=cache_poison` → auto `cache_bust` in autonomous mode
- [ ] Triage `root_cause=code_bug` → patch proposed in inbox
- [ ] Verify pass resolves issue; verify fail reopens + escalates

---

### Wave 7 — Alerts & visibility (F47 + N17 + portal)

**Outcome:** Operators see issues and escalation outcomes.

#### Task 7.1 — Slack Block Kit (F47)

- **File:** `src/eden/integrations/slack/alerts.py` (new)
- **Trigger:** P0/P1 issue create, verify fail, human escalation
- **Config:** `SLACK_WEBHOOK_URL` or per-org integration row

#### Task 7.2 — Portal issue pages

- **Files:**
  - `clients/portal/src/app/(portal)/issues/page.tsx` (list)
  - `clients/portal/src/app/(portal)/issues/[id]/page.tsx` (detail + triage + heal)
- **API client:** `agentIssuesApi` in `api.ts`

#### Task 7.3 — Closed-loop dashboard enhancements

- Show issue link on `closed_loop_actions` rows
- Surface `repetition_count` > 1 as "repeat incident" badge

**Wave 7 acceptance:**
- [ ] P0 issue fires Slack alert (or logs in dev)
- [ ] Portal lists issues with severity, status, stumble count
- [ ] Operator can triage, approve heal, view triage_result from UI

---

## 6. Test strategy

Follow patterns in `tests/intelligence/`:

| Pattern | Example file | Use for |
|---------|--------------|---------|
| Service + mock Postgres | `test_autonomous_intelligence.py` | TriageAgent, IssuePromoter |
| Mock LLM | `_make_llm_client()` helper | Triage ReAct paths |
| Route smoke | `TestClient` + `get_current_user` override | agent_issues routes |
| Hook capture | `patch _record_action` | Hook → orchestrator |
| Idempotency | `test_hot_path_p99_regression.py:154` | `install_all()` |
| Redis | `test_session12_live_tail_dl.py` | trace.finalized consumer |

**Minimum new test files:**
- `tests/intelligence/test_n14_activation.py`
- `tests/intelligence/test_agent_issues.py`
- `tests/intelligence/test_auto_issue_scanner.py`
- `tests/intelligence/test_triage_agent.py`
- `tests/intelligence/test_closed_loop_orchestrator.py`
- `tests/intelligence/test_autonomy_policy.py`
- `tests/intelligence/test_incident_hook_clusterer.py`

Run: `pytest tests/intelligence/ -q` after each wave.

---

## 7. Files to create (summary)

| Path | Wave |
|------|------|
| `src/eden/issues/*.py` | 1–3 |
| `src/eden/workers/trace_finalized_consumer.py` | 2 |
| `src/eden/closed_loop/*.py` | 4–6 |
| `src/eden/integrations/slack/alerts.py` | 7 |
| `src/eden/code_change/issue_patch_trigger.py` | 6 |
| `src/eden/api/routes/agent_issues.py` | 1 |
| `src/eden/db_migrations/versions/084_*.py` | 1 |
| `src/eden/db_migrations/versions/085_*.py` | 4 |
| `src/eden/db_migrations/versions/086_*.py` | 5 |
| `clients/portal/src/app/(portal)/issues/**` | 7 |

## 8. Files to modify (summary)

| Path | Waves |
|------|-------|
| `src/eden/api/app.py` | 0, 2, 4 |
| `src/eden/config.py` | 0 |
| `src/eden/autonomous/_common.py` | 0, 3 |
| `src/eden/insights/incidents/clusterer.py` | 0 |
| `src/eden/llmops/promotion_hooks.py` | 1, 4 |
| `src/eden/llmops/hooks_bus.py` | 4 |
| `src/eden/llmops/closed_loop_executor.py` | 4 |
| `src/eden/autonomous/investigation.py` | 3, 6 |
| `src/eden/code_change/scheduler.py` | 6 |
| `clients/portal/src/lib/api.ts` | 0, 7 |
| `clients/portal/src/app/(portal)/autonomous/page.tsx` | 0 |

---

## 9. Out of scope for this prompt (do not block on)

- F41 `evidence_gate.py` full implementation — stub gate that returns `needs_evidence=True` is OK for v1
- F39 runtime nudges in gateway — separate feature; triage may *suggest* nudge
- N17 full improvement cockpit — minimal issue list is sufficient
- Retired LangGraph env-gen pipeline (N07 removed — use D6/D7 instead)
- Cross-pod Redis dedup for HookBus — in-process dedup is acceptable v1
- Auto-merge PRs — default human merge per N22

---

## 10. Definition of done (end-to-end)

A reviewer can demonstrate this script without manual API calls:

1. Deploy API with Wave 0 complete — logs show `install_all` + `quality_pipeline: started`
2. Ingest a trace with a tool error → within 60s: `agent_stumbles` row + `agent_issues` row (Wave 2)
3. Orchestrator auto-triages → `triage_result` populated (Wave 3–4)
4. In `autonomous` maintenance_mode: heal executes for `cache_poison` playbook (Wave 5–6)
5. Verify job runs → issue status `resolved` (Wave 6)
6. Repeat same error → `repetition_count` increments; no duplicate LLM triage within dedup window (cost gate)
7. Portal `/issues` shows the issue lifecycle (Wave 7)

---

## 11. Decision log (record in PR descriptions)

For each wave, document choices you made where the prompt allows flexibility:

- Portal contract approach (0.3 A vs B)
- `trace.finalized` stream topology (global vs per-org)
- Triage ReAct vs extended single-shot InvestigationAgent
- Verify loop implementation (polling vs delayed queue)
- Which F20 detectors shipped in v1 vs deferred

---

## 12. Reference reading order

1. `docs/specs/CODEBASE-GROUND-TRUTH.md` — what exists
2. `docs/specs/AUTONOMOUS-MAINTENANCE.md` — playbooks & product promise
3. `docs/specs/features/n14-production-platform-activation.md` — Wave 0 spec
4. `docs/specs/features/f28-agent-stumbles.md` + `f29-agent-issues-sentry.md` — data model
5. `docs/specs/features/f20-zero-config-auto-issue-detection.md` — detectors
6. `docs/specs/features/f30-triage-agent.md` — triage contract
7. `docs/specs/features/f46-closed-loop-orchestrator.md` — state machine
8. `docs/specs/features/n22-autonomy-policy-engine.md` — safety bounds
9. `prompts/06_settings.md` — config fields
10. `tests/intelligence/test_autonomous_intelligence.py` — test patterns

---

*This prompt is intentionally task-oriented. Execute waves in order; fix known bugs in the files you touch; prefer extending shipped code over greenfield rewrites.*
