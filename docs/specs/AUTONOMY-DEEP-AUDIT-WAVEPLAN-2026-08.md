# Eden — Autonomy Deep Audit & Wave Plan (2026-08-11)

The full-source audit of every autonomy subsystem (N18–N23 + shared infra), with the
verified findings and a point-by-point, wave-by-wave execution plan.

**Method:** read every core file in full (`closed_loop/orchestrator.py`,
`autonomy_policy.py`, `playbook_router.py`, `improvement/agent.py`, `approve.py`,
`auto_merge.py`, `guardian.py`, `issue_patch_trigger.py`, `supervise.py`,
`autonomous/investigation.py`, `kb/flywheel/coordinator.py`, `agents/base.py`,
`evolution/components.py`, `evolution/loop.py`, SDK `trace.py`, migrations
009/010/012/034/055), ran the full autonomy test baseline (**420 passed**), and
re-verified every cross-table dependency against the live schema.

**Status legend:** ✅ working (verified) · 🟡 works but starved/miswired · ❌ broken
(verified) · ⬜ missing.

---

## Part 1 — The audit: every autonomy system, node by node

### The loop map (what actually exists)

```
DETECT ──► TRIAGE ──► DECIDE(N22) ──► HEAL/PATCH ──► VERIFY ──► SHIP ──► GUARD ──► LEARN
  ▲            │            │             │            │          │         │         │
  └────────────┴────────────┴─────────────┴────────────┴──────────┴─────────┴─────────┘
                   8 detectors     playbook      SelfHealer   replay/test   PR+merge   post-merge  flywheel/KG
                   stumbles       router 22      improve      verify        guardian    N01 case    Ledger DNR
                   shadow loop    kinds          sweep        evidence     auto-revert  (DEAD)      KB skills
```

### N22 — Autonomy policy engine ✅ (the safety envelope is the strongest part)

Verified working: `resolve(org_id, agent_id)` → org default beats agent row beats
config defaults; `decide()` is pure + O(1); compliance hard-override (hipaa→observe,
soc2_strict→no merge); daily-budget downgrade (`evaluate_mode` → observe when
exhausted); every decision audited to `autonomy_audit_log`; policy-errors fail-safe
to `require_approval` (never widen the envelope). Tier ladder T0–T4 is coherent.
Config defaults (verified `config.py`): `default_maintenance_mode="assisted"`,
`autonomous_actions_v0=True` (heals on), `code_change_enabled=False` /
`auto_pr_enabled=False` / `auto_revert_enabled=False` (patch/merge dark),
`daily_maintenance_budget_usd=25`, `auto_merge_max_per_week=2`.

### N21 — Self-heal 🟡 **one confirmed broken node**

`heal_from_issue` → queue → auto-approve (policy already granted) → `execute_heal`
with precheck + decision_id threading + idempotency — all sound. **But:**

> **F-F (❌ P0, NEW): the rollback heal targets a dead table.**
> `_execute_rollback` (investigation.py:1006,1022) and `_capture_before_state`
> (:1252) read/write **`prompt_canaries`** — a legacy table **nothing writes**
> (only this file touches it). Live canaries live in **`prompt_canary_experiments`**
> + `prompt_version_assignments` (migration 012; `PromptEvolvers`, `PromotionLoop`).
> Net: the flagship "Eden rolls back a bad canary" autonomous heal **can never find a
> canary to roll back**. `reweight` (model_router_weights) and `cache_bust`
> (ExactMatchCache) are wired to live targets and fine.

### N20 — Autonomous code fix ✅ DOGFOOD (verified)

`issue_patch_trigger` gates (verified): fingerprint ≥ `patch_cluster_min_size=5`,
triage confidence ≥ `patch_min_triage_confidence=0.65`, severity ≥ medium,
`improvement_agent_v1=True`, per-org gate, N22 may-propose, sweep budget.
`approve_plan` (verified): N22 gate → static preverify (+regenerate-on-fail) →
materialize diff → open PR → evidence-tier auto-merge ladder. `auto_merge.py`
(verified): M15 ladder with TOCTOU-safe weekly slot claim (`pg_advisory_xact_lock`),
KG revert-history block, branch-protection check, fail-closed everywhere.
`guardian.py` (verified): post-merge verify-failed → inverse-diff revert (static-checked
against HEAD) or PatchGenerator follow-up, `parent_plan_id` chain, canary-class
auto-revert gated on `auto_revert_enabled=False`, KG `reverted` outcome only on real
reverts. **This is the healthiest subsystem.**

> **F-H (🟡 P2): non-GitHub orgs can accumulate unapprovable drafts.**
> `approve_plan` hard-requires a repo (`_resolve_repo_id` → "Connect a GitHub repo"),
> but only the repo-health signal class is github-gated in the sweep
> (`agent.py:852`). Issue/metric/cost signals can still draft `code_patch` plans for
> an org with no GitHub install → plans stuck in draft with a dead-end error. Should
> degrade the plan to `advisory` or gate generation up-front.

### N23 — Recurring improvement agent 🟡 **the schedule never runs in prod**

Weekly cron machinery is fully built (`improvement_schedule_cron="0 3 * * 0"`,
`schedule.py` cron-matcher + `is_due` + watermark, `run_due_sweeps` sweeping every
due org), sweep budget is a real gate (`sweep_budget.py`: `_llm_budget_required`
ContextVar — LLM calls without an armed budget fail), five parallel signal classes
(issue-patch / traces / metrics / repo-health / cost / prompt-nudge), z-score +
ev_capture ranking, `runs_repo` run records, portal `/improve/plans` + `/improve/runs`.

> **F-I (❌ P1, NEW — final sweep): `run_due_sweeps` has zero hosts.**
> `grep run_due_sweeps` across the repo: only its own definition (`schedule.py:129`)
> and a northflank.yml comment. `cron_tick.py:519` intentionally omits it
> ("improvement_sweeps intentionally omitted — issue-driven drafts only"),
> `main.py:701` repeats it ("Improvement sweeps stay off"), and northflank.yml pins
> `IMPROVEMENT_SCHEDULE_ENABLED=false` with the comment *"Leaving this true
> advertised a schedule that never ran. Keep false until a worker Service hosts
> `run_due_sweeps` for real."* So the N23 spec's headline — "recurring agent on a
> per-org cron" — **does not run in production**. Only two paths into `sweep()`
> exist: the manual `POST /improve/runs` endpoint and the F46 orchestrator
> `request_sweep` (post-triage `code_change` / nudge-prompt hints). The whole
> metrics / traces / repo-health / cost signal classes are therefore **only
> reachable manually** — the "proactive" half of N23 is dormant.

### N19 — KB flywheel 🟡 PARTIAL (verified)

`on_issue_resolved` drafts shadow skills + nudges, `_may_draft` gates,
`on_promotion` writes Ledger DNR + Book, cockpit notify. **Gap:** `kb_skill`
promotion has no outcome table (F41 kind empty → `[]`), so skill drafts can never
clear EvidenceGate — the flywheel drafts forever, promotes never.

### N18 — Prompt evolution ❌ **dead at all three nodes** (the big one)

| Node | State | Evidence |
|---|---|---|
| Trigger | ❌ **F-A** | `_AGG_QUERY` joins `te.id::text = js.trace_id` (no `id` column — PK is `event_id`, migration 009/034) and reads `te.attributes->>'agent_id'` (never written — SDK/collector use the top-level `agent_id` column). Tests bake `agent_id` into fake rows so the SQL never runs. → evolver always returns 0 degradations |
| Enroll | 🟡 works | `_auto_create_canary` writes `prompt_canary_experiments` + `prompt_version_assignments` (verified), but only runs from the disabled evolution loop or issue-resolve |
| Select | ❌ **A1** | `pick_canary_version` has **zero production callers**; `PromptLoader` never consults `prompt_version_assignments` |
| Evidence | ❌ **A2** | Nothing anywhere writes `attributes->>'prompt_version'` (the key PromotionLoop + EvidenceGate query); `prompt_version_id` FK (migration 055) never populated |
| Promote | ❌ starved | `promotion_loop_enabled=True` but reads only the never-written attribute → `keep` forever |
| Registry | 🟡 **F-C** | Two incompatible registries: legacy `prompt_versions` (int-keyed, global) feeds canary/PromotionLoop/EvidenceGate; per-org `prompts_v2` (UUID) feeds `IssuePromptEvolver`, which refuses legacy APIs and passes a prompts_v2 int into `_auto_create_canary` → version collisions |

### Loop 1 — Detection calibration 🟡 half-wired (verified)

`record_shadow_feedback` **is** wired (resolve endpoint `agent_issues.py:287` +
MCP `confirm_shadow_detector`) — earlier "zero callers" was stale. But the
per-agent dimension is missing: `nl_signals` has no `agent_id` column (no live
migration), `resolve_profile(org_id)` is org-only (`detection_settings.py:115`),
and `evaluate_shadow_precision` promotes only when `precision is not None` — which
still can't happen per-agent. Detection stays org-static.

### Shared infra ✅ (verified)

Orchestrator state machine is event-driven + idempotent with outbox retry
(`::triage-retry`), P0 heal-and-escalate (M10), guardian on verify-failed,
LEARNING→N01 case on verify-passed, email+Slack sparse alerts. Janitors exist:
`fix_pending_janitor` (unsticks 120-min stale fix_pending), `stale_plans_janitor`
(closes 30-day drafts), `loop_dead_alert`. Verify: Postgres-backed
`issue_verifications` with delay + quiet window; 10-min fast window for canary merges.

---

## Part 2 — All findings, ranked

| # | Severity | Finding | Subsystem |
|---|---|---|---|
| F-A | 🔴 P0 | Evolver trigger SQL is dead (`te.id` join + `attributes->>'agent_id'` never written; tests fake the rows) | N18 |
| F-I | 🔴 P0 | **`run_due_sweeps` has zero hosts** — cron_tick + main.py both omit it, northflank pins `IMPROVEMENT_SCHEDULE_ENABLED=false`; N23's recurring sweep never runs in prod, metrics/traces/repo/cost signal classes only reachable via manual `POST /improve/runs` | N23 |
| F-F | 🔴 P0 | Self-heal `rollback` targets legacy `prompt_canaries` — nothing writes it; can never roll back a real canary | N21 |
| F-B | 🔴 P0 | `CheckpointStore.save()` INSERTs `id` (no such column; PK `event_id`) — debugger checkpoints silently fail to persist | debugger/replay |
| A1/A2 | 🔴 P0 | Canary selection never called + version never stamped → PromotionLoop/EvidenceGate starved | N18 |
| F-C | 🟠 P1 | Two prompt registries; `IssuePromptEvolver` version ints collide with legacy canary ints | N18 |
| B1/B3 | 🟠 P1 | No `nl_signals.agent_id`; `resolve_profile` org-only; per-agent thresholds absent | Loop 1 |
| D1–D4 | 🟠 P1 | 4 EvidenceGate kinds (guardrail/model_routing/kb_skill/pr_merge) honest-empty — no outcome tables | F41 |
| C1–C3 | 🟠 P1 | `post_merge_windows` dead schema — no post-merge degradation monitor | N20 guardian |
| F-E | 🟡 P2 | No canary cockpit UI (promotions tab exists; no experiment cards/traffic/history) | portal |
| F-G | 🟡 P2 | Autonomy settings card exposes only `auto_runtime_heal` + budget — no mode, per-agent, compliance, audit-log view | portal |
| F-D | 🟡 P2 | `@prompt` decorator docstring promises telemetry recording; code doesn't | SDK |
| F-H | 🟡 P2 | Non-GitHub orgs can draft code-patch plans they can never approve | N20/N23 |
| F-J | 🟡 P2 | **northflank.yml ships ~10 env vars nothing reads** — `QDRANT_*` block (5 vars) is fully stale (pgvector replaced Qdrant, N4, but the env block remains in prod config), plus `LOG_JSON`, `SANDBOX_MEMORY_MB`, `SANDBOX_CPU_COUNT`, `SANDBOX_MAX_CONCURRENT`, `SANDBOX_SNAPSHOT_POOL_SIZE`, `PIPELINE_TIMEOUT_ENABLED` with zero readers anywhere | prod config |
| F-K | 🟡 P2 | `is_fix_now_item` (cockpit_aggregator.py:1020) is dead code — referenced only from tests | N23 cockpit |

**Healthy (no action):** N22 policy engine, N20 approve/auto-merge/guardian,
orchestrator state machine, janitors, verify, spend caps, audit logging, nudge
runtime (engine + shadow_outcomes + demotion_worker all write/read
`nudge_outcomes`), MCP autonomy surface (`search_issues`/`get_issue`/
`triage_issue`/`list_improvement_plans`/`get_improvement_plan`/
`approve_improvement_plan`/`eden_health`). **~2,000 tests green** (420 autonomy +
62 integration/golden-path/chaos/e2e + 265 kb/nudges/services + 1,255 api).

---

## Part 3 — The wave-by-wave plan

Waves are independent unless noted. Each item: files + verify.

### Wave 1 (P0) — Fix the broken nodes ✅ **DONE (2026-08-11)**

All four items shipped with pinning tests; **683 tests green** in the affected
suites (agents/closed_loop/improvement/autonomous/workers/promotion/debugger).

| # | Task | Files | Verify |
|---|---|---|---|
| 1.1 ✅ | **F-A trigger fix:** `_AGG_QUERY` now joins `te.event_id = js.source_event_id` (the judge runner writes the source event id) with a `trace_id` fallback for legacy rows, and reads `te.agent_id` (top-level column) instead of the never-written `attributes->>'agent_id'`. Two pinning tests: SQL-shape capture (asserts the exact join + column, rejects `te.id`/`attributes->>'agent_id'`) and an end-to-end schema-shaped-rows test | `agents/evolution/components.py` + `test_judge_prompt_evolver.py` | Tests fail against the old SQL; pass after; evolver returns degradations on schema-shaped synthetic rows |
| 1.2 ✅ | **F-F rollback fix:** `_execute_rollback` + `_capture_before_state` target `prompt_canary_experiments` / `prompt_version_assignments` keyed by UUID `experiment_id`, mirroring `PromotionLoop._rollback` exactly (both UPDATEs + placeholder/arity alignment). New test file pins live-table SQL, UUID keying, terminal-state refusal, no-op paths, and placeholder ≤ arg-count (caught a real `$2`-with-one-arg bug in review) | `autonomous/investigation.py` + `tests/unit/autonomous/test_self_heal_rollback_live_canary.py` | Active experiment + assignment → rollback ends both; legacy `prompt_canaries` never referenced |
| 1.3 ✅ | **F-B checkpoint fix:** INSERT uses `event_id` (the real PK) + stamps `source_format='debugger_checkpoint'` (the provenance the docstring always promised). Pinning test captures raw SQL and asserts the column list has no bare `id` + carries the tag | `debugger/checkpoints.py` + `tests/unit/test_debugger.py` | Row persists; test asserts event_id column + source_format tag |
| 1.4 ✅ | **F-I host the recurring sweep:** new leader-gated `_leader_improvement_sweep` loop in `workers/main.py` (idle-grid interval, gated on `improvement_schedule_enabled`, delegates per-org gating to `run_due_sweeps`), adopted into the `background.py` fleet bundle, `IMPROVEMENT_SCHEDULE_ENABLED=true` in northflank (comment updated), and `cron_tick` reason string updated to point at the new host. Tests pin flag-off no-op, flag-on `run_due_sweeps(dry_run=False)` call, error re-raise, and fleet adoption | `workers/main.py`, `workers/background.py`, `northflank.yml`, `workers/cron_tick.py` + `test_improvement_sweep_host.py`, `test_background_hosts_full_fleet.py`, `test_cron_tick_w8_2.py` | Due orgs are swept on their cron without manual `POST /improve/runs`; flag-off is a cheap no-op |

### Wave 2 (P0) — Fuel the canary loop (the differentiator) — DONE 2026-08-11

**Discovery (bigger than F-C):** migration 055 (live chain) **dropped the legacy agent-keyed
`prompt_versions` table** entirely — ``PromptVersionsClient`` targeted columns that no longer
exist and raised ``UndefinedColumnError`` on every call (boot seed, PromptLoader, judge
evolver variant writes, canary-route activate). 2.4 was therefore the *prerequisite*, not the
last item; implemented as a compat shim over the v2 schema.

| # | Task | Files | Verify |
|---|---|---|---|
| 2.1 | Wire `pick_canary_version` into `PromptLoader` runtime resolution (consult `prompt_version_assignments` per `(tenant, agent)`; global-active fallback) | `agents/base.py`, `agents/prompt_canary.py` | Assignment at 5% + seeded roll → some runs resolve the canary version; 0% never |
| 2.2 | Stamp the resolved version on every agent.run span (`attributes.prompt_version`) at the SDK emit path | `sdk/python/eden_sdk/trace.py` + `promotion.py` | Span carries `attributes->>'prompt_version'`; PromotionLoop COALESCEs both spellings |
| 2.3 | Fix `@prompt` decorator drift — docstring promised telemetry_events writes it never did; aligned doc + stamp recorded version onto the active span | `sdk/prompt_decorator.py` | Doc matches code; span stamped |
| 2.4 | **Unify the registries (prerequisite):** rewrite `PromptVersionsClient` as a v2-schema compat shim — agent→`prompts.name` under sentinel `SYSTEM_ORG_ID`, legacy fields in `params` jsonb, explicit version + `ON CONFLICT (prompt_id, version)`, race-safe `_ensure_prompt` (RETURNING id) | `kb/prompt_versions/client.py`, `evolution/loop.py`, `evolution/components.py` | 7 pinning tests assert v2 columns; `_enroll_pending_canaries` org-scoped |
| 2.5 | Enable `evolution_loop_enabled` org-scoped on dogfood orgs — **held back**: judge evolver aggregates globally (no tenant filter) and writes variants without `org_id`, so `_auto_create_canary` fails closed and the loop would spend LLM budget on variants that never enroll. Issue-driven path (real org → own canary) works today. Re-enable after org wiring (Wave 3). | `agents/evolution/loop.py`, `orgs.py`, config | — |

Shipped in this wave: v2 compat shim (2.4), loop/evolver v2 reads (2.4), SDK `prompt_version`
passthrough + PromotionLoop tolerant read (2.2), `pick_canary_version` wiring + tenant-aware
`a_load_prompt` (2.1), decorator drift (2.3), latent ``await get_prompt_versions_client()``
TypeError on the promote path fixed. 15 new pinning tests; 1054 unit + SDK suites green.

### Wave 3 (P1) — Per-agent learning (Loop 1 + F41 evidence) — **SHIPPED 2026-08-11**

| # | Task | Files | Verify |
|---|---|---|---|
| 3.1 | Migration 168: `ALTER TABLE nl_signals ADD COLUMN agent_id` + regex backfill from `[auto:{agent_id}]` | `db_migrations/versions/168_nl_signals_agent_id.py` | Backfill maps rows; promote job uses it |
| 3.2 | `resolve_profile(org_id)` → per-agent thresholds fed by per-agent confirm/dismiss rates (feedback already lands) | `issues/detection_settings.py` | Two agents with different histories → different thresholds; promote fires for the good one |
| 3.3 | `evaluate_shadow_precision` decisions drive thresholds (not Slack strings); promote path unblocked | `services/soft_issue_review.py` | Weekly promote job promotes a confirmed detector |
| 3.4 | Four outcome tables mirroring `nudge_outcomes`: `guardrail_outcomes`, `routing_decisions`, `skill_outcomes`, `pr_outcomes` — each with a producer | F41 kinds + producers | EvidenceGate `_metrics_from_outcomes` returns real data for all 6 kinds |

**Shipped notes (2026-08-11):**

* **3.1 — agent_id column.** ``agent_id VARCHAR(256)`` (matches
  ``agent_issues.agent_id`` and telemetry's string agent names — the plan
  said UUID, but the data is strings; corrected at implementation).
  ``_create_shadow_detector`` now writes the column directly;
  ``promote_shadow_detectors`` selects + reports it; the 168 backfill
  regex was verified against live-shaped rows.
* **3.2 — per-agent threshold multiplier.**
  ``resolve_agent_threshold_multiplier(org_id, agent_id)`` (TTL-cached)
  computes <1.0 (more sensitive) for confirm-heavy agents and >1.0 (less
  sensitive) for dismiss-heavy agents from ``agent_issues`` status rates
  **plus** shadow-detector ``rule.operator_confirms/dismisses``.
  ``AutoIssueScanner.scan`` takes ``threshold_multiplier`` and scales the
  slow-trace / high-cost / loop-repeat / confusion-repeat thresholds; the
  trace.finalized consumer resolves it per (org, agent).
* **3.3 — decisions drive thresholds.** ``record_shadow_feedback`` and the
  weekly promote/delete decisions invalidate the agent's cached multiplier
  immediately (public ``invalidate_agent_multiplier``) so the next scan
  reacts instead of waiting out the TTL. The promote job already ran
  weekly (cron_tick ``shadow_promote``); its details now carry
  ``agent_id``.
* **3.4 — real evidence for all six F41 kinds.** Migration 169 adds
  ``guardrail_outcomes``, ``routing_decisions``, ``skill_outcomes``,
  ``pr_outcomes`` (all mirror ``nudge_outcomes``; ``pr_outcomes`` has
  ``UNIQUE (org_id, plan_id)`` so re-merged/re-reverted events upsert).
  New ``promotion/outcome_records.py`` owns producers + readers; wired
  producers: guardrail bypass/promote/demote (intervention + EvidenceGate),
  routing classify (ModelRouter, org-scoped only), skill issue
  resolve/ignore (agent_issues route), PR merge + guardian revert
  (approve.py + guardian.py). ``EvidenceGate._metrics_from_outcomes``
  dispatches all six kinds to real readers — the FEAT-31 "no evidence"
  branches for guardrail/model_routing/kb_skill/pr_merge are gone.

**Known honest gap (carried from Wave 2):** ``model_routing`` candidates
are only recorded when ``task.org_id`` is set AND tiers diverge — under
``_chat_tiers_share_model()`` (the current single-model config) routing has
no value, so the producer is correctly inert and the gate holds rather than
fabricating evidence. It activates automatically once tiers diverge.

### Wave 4 (P1) — Post-merge guard (the missing ship→verify node)

| # | Task | Files | Verify |
|---|---|---|---|
| 4.1 | Producer: after a guardian/auto-merge PR merges, write `post_merge_windows` rows (1h/24h/7d) | new `improvement/post_merge_monitor.py` | Windows written on merge (webhook + poll) |
| 4.2 | Comparator: on window expiry compare post vs pre-merge rates; on material regression create a follow-up via `parent_plan_id` (guardian path exists) | `improvement/approve.py`, guardian | Synthetic degradation → follow-up plan with `parent_plan_id` |
| 4.3 | Surface post-merge status on plan detail (event log is already append-only) | portal plan components | Portal shows "post-merge watch: degrading, follow-up filed" |

**Shipped notes (2026-08-11):**

* **4.1 — producer at the merge choke point.** New
  ``improvement/post_merge_monitor.py``; ``plans_repo.mark_merged`` — the
  single path every merge funnels through (approve auto-merge,
  supervise, GitHub webhook) — opens a 1h/24h/7d
  ``post_merge_windows`` watch per merged plan via
  ``schedule_for_plan``, snapshotting the agent's pre-merge issue rate
  (168h lookback on ``agent_issues``) as the baseline.
  ``UNIQUE (org_id, plan_id, window_hours)`` keeps re-delivered merge
  events from double-opening.
* **4.2 — comparator hosted on the cron.** ``run_due`` is a cheap
  indexed ``closes_at <= now() AND status='pending'`` scan registered in
  cron_tick's 15-min mcp slot. Per due window it compares the agent's
  post-merge issue rate against the snapshot; a material regression
  (≥ `revert_threshold_pct` from the org's code-change policy, with a
  min-sample floor of 3 issues) marks ``degrading``, emits a
  ``post_merge_degrading`` plan event, and files an ``advisory``
  follow-up plan linked via ``parent_plan_id`` (never an approvable empty
  code_patch — advisory-only per M6). Clean windows close ``ok``.
* **4.3 — portal surface.** New ``getPostMergeWindows`` API + route
  (``GET /orgs/{org_id}/improve/plans/{plan_id}/post-merge-windows``),
  ``PostMergeWindow`` type, and a ``PlanPostMergeWatch`` section on plan
  detail: per-window pending/ok/degrading with the issue-rate delta and
  a follow-up link. Renders nothing for non-merged plans.
* **Dead-schema resolution (audit C1–C3).** Migration 170 found an
  orphan ``post_merge_windows`` table from migration 027 (never wired,
  FORCE-RLS from 097 — a footgun for cron-context writes since the
  policy rejects rows when the ``app.current_org_id`` GUC is unset).
  170 drops it and creates the wired shape keyed by ``plan_id`` with a
  plain ``org_id`` column (same worker-write convention as the 169
  outcome tables). Downgrade restores the 027 shape so the 097
  downgrade chain stays resolvable.

**Validation:** 8 new pinning tests (producer windows + idempotency,
clean vs regression evaluation + follow-up filing, mark_merged wiring,
route serialization); real-DB end-to-end smoke (3 windows opened → forced
due → all evaluated); 1705 tests green across improvement/workers/api/
patches; ruff clean; portal ``tsc --noEmit`` clean; API surface snapshot
regenerated (+1 route, reviewed). Mypy delta: only pre-existing findings.

### Wave 5 (P2) — Trust UX (canary cockpit + full settings + ledger)

| # | Task | Files | Verify |
|---|---|---|---|
| 5.1 | **Canary cockpit:** experiment cards (agent, control vs candidate, traffic %, elapsed, status), promote/rollback buttons with the evidence report, history | `improve-chrome.tsx`, new `canary-panel` | Canary appears with live traffic + evidence; promote/rollback from UI |
| 5.2 | **Autonomy settings:** full N22 surface — mode selector (observe/assisted/autonomous), per-agent policy rows, compliance profile, budget edit, audit-log viewer | `autonomy-settings-card.tsx`, new API fields | Every policy knob editable + reflected in `autonomy_audit_log` |
| 5.3 | **Autonomy ledger per issue:** one evidence trail — triage, decision_id + N22 verdict, heal/patch result, replay/test gate, merge, post-merge windows, EvidenceGate report | `plan-detail-enrichment.tsx`, `plan-event-log.tsx` | Full loop rendered as one trustworthy trail |
| 5.4 | **F-H:** non-GitHub orgs get `advisory`/`config_change` plans only (no unapprovable code_patch drafts) | `issue_patch_trigger.py`, `agent.py` | No code_patch plan for an org without a repo |

**Shipped notes (2026-08-11):**

* **5.1 — canary cockpit (F-E).** New org-wide
  ``GET /orgs/{org_id}/prompts/canaries`` route (every experiment across
  agents, with agent + control/candidate + traffic % + elapsed + status),
  a ``promptsApi`` resource set (list / promote / rollback), and a
  ``CanaryCockpit`` section on the Improve queue page — experiment
  cards with promote-to-100% and rollback controls. Promote runs the
  W25 evidence gate on the backend; a held flip shows the gate report
  (recommendation / sample floor) inline.
* **5.2 — full autonomy settings (F-G).** New
  ``GET /orgs/{org_id}/settings/autonomy/agents`` route lists per-agent
  override rows (resolved policy + override flag);
  ``AutonomySettingsCard`` now has the maintenance-mode selector
  (observe/assisted/autonomous), compliance-profile selector
  (standard/HIPAA/SOC2 strict — HIPAA forces observe), an editable daily
  budget, and per-agent mode + self-heal rows — all PATCHed through the
  existing N22 API (audit-log view already shipped in ``AutonomyAuditCard``).
* **5.3 — one-loop ledger (FEAT-30).** The approve verify choke point
  (``queue_verify_for_plan``) now emits a ``verify_queued`` plan event,
  and the portal event log labels + tones the full trail: lifecycle,
  ``verify_queued``, ``post_merge_ok`` / ``post_merge_degrading`` (with
  the rate delta rendered from the event payload). Verify outcomes
  (passed/failed) resolve the *issue* via the orchestrator — the plan
  ledger's verify leg is queued → merged → post-merge watch.
* **5.4 — F-H sweep gate.** ``ImprovementAgent._sweep_body`` resolves
  repo presence once and skips the code-patch lane outright when no repo
  is connected (the issue path already gated via ``repo_not_connected``;
  the sweep no longer churns cheap-gate collection + ranking), stamps
  ``sweep.repo_not_connected`` on the run row, and returns it in the
  sweep result. Advisory / nudge / prompt lanes are repo-independent and
  still run.

**Validation:** 11 new pinning tests (sweep gate on/off + run stamp,
verify_queued event + failure isolation, canaries + autonomy agents
routes); 1702 tests green across improvement/api/closed_loop/providers;
ruff + mypy clean on changed files (2 mypy findings in prompt_canary.py
verified pre-existing at HEAD); portal tsc + eslint clean; API surface
snapshot regenerated (+2 routes, reviewed).

**Full-suite closure (2026-08-11):** ``tests/unit`` is green end-to-end at
**6038 passed** (14 skipped, 1 xfailed). The full-suite run surfaced three
deploy-guard failures, all closed:

* **No-untracked-shipped-sources:** 5 new modules from Waves 3–4
  (``post_merge_monitor.py``, ``outcome_records.py``, migrations
  168–170) were untracked — the built image would have missed them
  (``ModuleNotFoundError`` in prod while every local check passed).
  ``git add``ed (test explicitly instructs this).
* **Background-bundle manifest test:** the Wave 1 fix that hosted the
  recurring sweep added ``improvement_sweep`` to the leader fleet;
  the guard pinned exactly five loops. Updated the expected set to six
  with a note explaining the deliberate addition.
* **Unordered-limit ratchet:** 5 "new" violations were the same
  baselined SQL line-shifted — +16 lines in ``deps.py`` (committed
  before this work; file untouched by these waves) and +6 in
  ``checkpoints.py`` (Wave 1 edit). Regenerated the baseline via the
  project's own ``--write-baseline`` burn-down helper; diff verified to
  contain only the 5 line-number changes, count unchanged (50), zero
  genuinely-new violations.

### Wave 6 (P2) — Earned autonomy (process; lands after 2.5 + 4.x)

| # | Task |
|---|---|
| 6.1 | Dogfood orgs run T2 heals (real, post-1.2) + T3 prompt canaries (post-Wave 2) + code patches (already DOGFOOD) |
| 6.2 | Publish the documented "5 consecutive clean auto-merges" metric per org (EvidenceGate + post-merge windows are the proof) |
| 6.3 | When an org earns it, flip `auto_code_patch_merge=True` org-scoped — T4 stays process-gated |

**Shipped notes (2026-08-11):**

* **6.2 — the earned-autonomy ledger.** New
  ``improvement/earned_autonomy.py``:
  ``clean_auto_merge_streak`` walks the org's auto-merged plans (one
  JOIN over ``improvement_plans`` + the Wave 4 ``post_merge_windows``;
  manual merges of Eden PRs count too — a human-approved track record
  is what earns the ladder) and counts consecutive *proven* clean
  merges: every watch window evaluated ``ok``. Pending head plans are
  ``in_flight`` (provisional); a ``degrading`` window breaks the
  streak; a windowless plan (pre-Wave-4 / watch never opened) stops it
  conservatively. Failure paths return a full ``_error_status`` shape
  — never a partial dict. Published via
  ``GET /orgs/{org_id}/settings/autonomy/earnings`` and rendered in the
  Autonomy settings card (streak progress, in-flight count, per-plan
  trail, earned badge).
* **6.3 — the automatic T4 grant.** ``grant_if_earned`` flips
  ``auto_code_patch_merge=True`` org-scoped when the streak clears
  ``earned_autonomy_min_streak`` (default 5) **and** the org opted into
  the program (new ``earned_autonomy_enabled`` policy field; dogfood
  orgs get it at org-create via ``_maybe_seed_dogfood``, alongside the
  previously-held-back ``evolution_loop_enabled``). The grant is
  retrospective by design (documented): a merge that lands *after* the
  5th clean one doesn't delay or revoke it — its own watch catches any
  regression. Idempotent, compliance-blocked (``hipaa``/
  ``soc2_strict``), read-back-verified before success is claimed, and
  audited via an ``earned_autonomy_grant`` row. Triggered from
  ``PostMergeMonitor.run_due`` — the grant lands the moment the 7d
  window of the 5th clean merge closes (``earned_grants`` in the tick
  summary).
* **Pre-existing P0 found + fixed (real-DB smoke):** ``upsert_policy``
  used plain ``ON CONFLICT (org_id, agent_id)``, which Postgres cannot
  infer against migration 086's *partial* unique indexes — every N22
  settings PATCH (the Wave 5.2 surface) silently failed to persist.
  Conflict targets now carry the matching predicate
  (``... WHERE agent_id IS NOT NULL`` / ``(org_id) WHERE agent_id IS
  NULL``); the smoke proved both org-default and per-agent upserts
  persist, and a SQL-shape pin test guards the regression.

**Validation:** 15 new pinning tests (streak: clean/pending/degrading/
unproven/empty/manual; grant: flip+audit, opt-in gate, idempotency,
streak gate, compliance block, dry-run, upsert SQL-shape); 6054 tests
green (full suite); real-DB smoke passed end-to-end (streak 5 → grant
persists T4 → audit row → idempotent → per-agent upsert persists); ruff
+ mypy clean on changed files (3 findings verified pre-existing at
HEAD); portal tsc + eslint clean; API surface snapshot +1 route;
unordered-limit baseline line-shift regenerated (orgs.py +51 shifted a
baselined violation 787→838, verified same SQL).

### Wave 7 (P2, hygiene) — Dead schema, dead flags, stale tracking

From the exhaustion-pass sweeps (Part 4). None of these block autonomy; they clear
inert surface so the real posture is visible.

| # | Task | Files | Verify |
|---|---|---|---|
| 7.1 | **Wire or drop 20 dead tables.** Investigate `org_approval_policies` first (potential N22 per-action approval surface); drop or document the orphans (`env_cards*`, `spec_*`, `ai_insights_chat_*`, `interview_sessions`, `builder_graphs`, `circuit_breaker_state`, `retrieval_relevance_scores`, `org_sso_*`, `org_regions`, `pr_decision_audit`, `pr_dedupe_index`) | migrations | Schema-reality check passes; dead tables removed or referenced |
| 7.2 | **Resolve 13 dead flags + 10 dead prod env vars (F-J).** Wire the True-ones that should gate (e.g. `trace_quality_hot_path_enabled`), delete the False-ones, or document as intentional; drop the `QDRANT_*` block (pgvector replaced it in N4) and the unread `LOG_JSON`/`SANDBOX_*`/`PIPELINE_TIMEOUT_ENABLED` vars from northflank.yml | `config.py`, `northflank.yml` | Flag-audit script reports zero unused; prod env set matches code readers |
| 7.4 | **Drop F-K dead code:** remove `is_fix_now_item` (and its test) or wire it into the cockpit queue-split it was built for | `improvement/cockpit_aggregator.py` | Function gone or referenced; tests green |
| 7.3 | **Fix stale tracking.** F41→SHIPPED (EvidenceGate shipped), re-check every PARTIAL in `FEATURE-GAP-MASTER.md` + `GA-COMPLETION-CHECKLIST.md` against code | docs | Doc statuses match verified code |

---

---

## Part 4 — Systemic sweeps (exhaustion pass, 2026-08-11)

Two repo-wide sweeps ran to confirm nothing is left: every table created by a
migration was checked for a non-migration code reference, and every config flag for
a non-config reader. Both found real, previously-unreported items.

### Dead schema — 20 tables created by migrations, zero code references

These tables exist in the schema but **no `src/eden` code (and no portal code) ever
reads or writes them** — they are schema-only. The autonomy-relevant ones are
flagged; the rest are product-surface orphans.

| Table | Likely owner | Note |
|---|---|---|
| `org_sso_providers` / `org_sso_sessions` / `org_regions` | org/SSO | Schema exists; zero code refs (sso_enabled=True but surface unbuilt) |
| `org_approval_policies` | autonomy | **Potential N22 sibling** — approval policies table with no code |
| `circuit_breaker_state` | gateway | Zero refs — circuit breaker never wired |
| `pr_decision_audit` / `pr_dedupe_index` | PR/approve | Zero refs — PR decisions not audited to these |
| `retrieval_relevance_scores` | retrieval tuner | Zero refs |
| `env_cards` / `env_card_versions` / `env_card_reviews` / `env_card_ratings` / `env_card_fork_lineage` | env cards | Full orphan family |
| `builder_graphs` | builder | Zero refs |
| `ai_insights_chat_sessions` / `ai_insights_chat_messages` | insights chat | Zero refs |
| `interview_sessions` | ? | Zero refs |
| `spec_templates` / `spec_approvals` / `spec_comments` | specs | Zero refs |

**Action (Wave 7, hygiene):** either wire or drop. `org_approval_policies` is the
one worth investigating — an N22-style table that nothing uses may be a planned
per-action approval surface.

### Dead config flags — 13 flags never read outside config.py

Verified with a repo-wide grep: these are defined (some default `True`) but **no
code reads them** (11 of 13 have zero references even in tests):

| Flag | Default | Note |
|---|---|---|
| `trace_quality_hot_path_enabled` | True | Hot-path trace quality gating is **off-by-absence** — but only referenced in a test, so the flag is inert either way |
| `checkpoint_enabled` | True | Debugger checkpoint gating never read |
| `issue_experiments_v1` / `signal_backfill_v1` / `deep_search_to_signal_v1` / `f65_topics_v1` | True | Shipped-flag claims with no readers — feature may be live *unconditionally* or dead |
| `debugger_checkpoint_backfill_v1` | False | Zero refs |
| `ai_agent_real_cost` | False | Zero refs (only a test) |
| `interrupt_before_archivist` / `interrupt_before_human_review` | True | Zero refs — interrupt gates never read |
| `traceloop_auto_apply` | False | Zero refs |
| `enhancements_no_drop_invariant_enforced` | True | Zero refs |
| `zero_label_onboarding_v1` | False | Zero refs |

**Action (Wave 7, hygiene):** delete, wire, or document each. Inert `True` flags are
the dangerous kind — a feature whose gate is never checked is either silently always-
on or silently always-off.

### Verified healthy (exhaustion confirmation — no action)

| Area | Evidence |
|---|---|
| Detection pipeline | `auto_scanner.py` — 8 always-on detectors, profile-gated, `_infer_agent_id`; stumbles writer in `issues/repo.py:128`; signals investigator F06/F35 with StatGate rules (no LLM) |
| Verify backbone | `replay_verify.py` (FailureSignature, hermetic rerun, `checkpoint_available`), `test_gate.py` (sandbox, honest env-skips, synthesis off), `evidence_plane.py` (static checks, failure pack, hermetic preverify) |
| Workers wiring | `workers/main.py` + `background.py` leader-gated supervisor with liveness (`worker_loops_running`), `sidecars.py` guard TTL, `cron_tick.py` daily 03:00 jobs, `run_if_leader` everywhere |
| SDK agent_id stamping | `client.py:560-564` stamps configured `agent_id` on enqueue; TS SDK mirrors; framework instrumentations set `agent_id` per event |
| Tests | **~2,000 green:** 420 autonomy + 62 integration/golden-path/chaos/e2e + 265 kb/nudges/services + 1,255 api |
| Loop wiring (final-sweep confirms) | `trace_finalized_consumer` → `AutoIssueScanner` → `IssueHook.on_issue_created` → orchestrator — all live; `register_all_hooks` (→ orchestrator `subscribe`) called from `main.py:208` + `background.py:446`; `start_evolution_loop` from both; `start_verify_worker` from `sidecars.py:317`; nudge runtime fully wired (engine→`nudge_outcomes`→shadow_outcomes/demotion_worker/EvidenceGate) |
| Spend enforcement (final-sweep confirms) | `record_spend` callers: issue_patch_trigger, signal_investigator, annotator, slm_hook, soft_issue_review; sweep budget is a hard ContextVar gate (`sweep_budget.py`) |
| MCP autonomy surface | `search_issues` / `get_issue` / `triage_issue` / `list_improvement_plans` / `get_improvement_plan` / `approve_improvement_plan` / `eden_health` — all registered |

### Tracking drift (final confirmation)

`GA-COMPLETION-CHECKLIST.md` still lists **F41 as PARTIAL ("StatGate only;
EvidenceGate greenfield")** — stale; `EvidenceGate` is fully shipped (Part 1). F12
correctly stays BLOCKED (`TYPESENSE_ENABLED=false` in prod). The trackers under-report
what's built; correcting them is Wave 7 hygiene, not product work.

---

## Part 5 — Wiring-liveness sweep (final, 2026-08-11)

Four systemic checks ran to close the last unknowns: every function defined in
`src/eden` was checked for external references (AST sweep), every Redis stream for
producer/consumer balance, every northflank.yml env var for a code reader, and
every loop-start for a live host. Results:

### Loop entry points — all live (final confirmation)

| Path | Callers |
|---|---|
| `start_evolution_loop` | `workers/main.py:167` + `workers/background.py:437` — both host it |
| `start_quality_and_closed_loop_sidecars` | `main.py:201` + `background.py:474` |
| `register_all_hooks` → `get_orchestrator().subscribe()` | `main.py:208` + `background.py:446`; gated `closed_loop_orchestrator_v1=True` |
| `start_verify_worker` | `workers/sidecars.py:317` (via sidecar start) |
| `trace_finalized_consumer` | its own `run()` in the sidecar fleet; `AutoIssueScanner` imported at :92 |
| `run_due_verifications` / janitors | `verify.py:758` inside `start_verify_worker`; `register_idle_chore` at :134-140 |

**Starved-loop flag posture (verified `config.py`):** `evolution_loop_enabled=False`
(default — the evolver only fires from issue-resolve, matching Part 1),
`promotion_loop_enabled=True` (starved by A2, not off), `evolver_auto_canary_pct=5`,
`promotion_min_calls=30`, `closed_loop_orchestrator_v1=True`.

### Redis stream balance — clean

Every stream is produced and consumed locally: `trace.finalized`
(`trace_finalized.py:110` → `trace_finalized_consumer`), `telemetry:*:events`
(`telemetry_collector.py:1335` → `redis_tailer.py`), `trace:{entity}:events`
(`trace_store.py` write/read pairs). No orphan producers, no ghost consumers.

### Dead-function sweep — mostly FastAPI false positives, two real hits

The AST sweep flagged ~300 names, but nearly all are FastAPI route handlers (the
`@router` decorator registers them within their own file, which the sweep excludes)
or dunders. Verified real hits:

- **`is_fix_now_item`** (cockpit_aggregator.py:1020) — zero callers outside tests
  (F-K). `heal_deny` / `promote_canary` / `post_merge_degraded` / `route_playbook` /
  `run_evolution_pass` / `tier_ladder_level` / `weekly_cap_for_org` — all verified
  wired (decorated routes or internal callers).

### Prod env-var audit — ~10 dead vars in northflank.yml (F-J)

All 96 northflank env vars were checked for readers. Verified dead in prod config:
`QDRANT_HOST/PORT/HTTPS/API_KEY/COLLECTION_PREFIX` (pgvector replaced Qdrant in
N4 — config.py:173 confirms the removal — yet the env block survives in
northflank.yml), `LOG_JSON`, `SANDBOX_MEMORY_MB/CPU_COUNT/MAX_CONCURRENT/`
`SNAPSHOT_POOL_SIZE`, `PIPELINE_TIMEOUT_ENABLED`. (Read via Field alias:
`EDEN_RUN_BACKGROUND_WORKERS`, `EDEN_SAMPLING_PROFILE`, `EDEN_MIGRATIONS_DIR`,
`UPSTASH_REDIS_REST_*` — correctly cleared.) No autonomy-relevant var is dead;
this is hygiene (Wave 7).

---

## Wave 7 — Hygiene sweep (DONE, 2026-08-11)

Deleted-or-wired every dead-schema / dead-flag / dead-code / stale-doc item the
Part 4 exhaustion audit found. Full suite green at 6055 passed.

### 7.1 — Dead schema → dropped

Migration ``171_drop_orphan_schema`` drops 19 tables created by the legacy
``migrations/*.sql`` tree (raw SQL, no code ever read/wrote them):
``org_sso_providers``, ``org_sso_sessions``, ``org_regions``,
``circuit_breaker_state``, ``pr_decision_audit``, ``pr_dedupe_index``,
``retrieval_relevance_scores``, the ``env_cards`` family (5), ``builder_graphs``,
``ai_insights_chat_sessions/messages``, ``interview_sessions``,
``spec_templates/spec_approvals/spec_comments``.

* ``DROP TABLE IF EXISTS`` (no CASCADE) — fails loudly if anything unexpected
  ever FKs to one of them, instead of silently dropping a kept table.
* ``org_approval_policies`` deliberately **kept** — it is a designed N22
  per-action approval surface (``require_approval``/``min_approvers``/
  ``required_roles``/``auto_approve_threshold``/``approval_timeout_hours``)
  reserved for the approval feature.
* Downgrade is a documented no-op (recreating 19 dead tables restores only
  inert schema; original DDL retained in git).
* Validated live: ``alembic upgrade head`` → orphan tables gone, then
  ``downgrade 170`` → ``upgrade head`` chain resolves; ``sql_schema_guard``
  (0 new violations) and ``alembic_schema_reality_check`` both pass; scratch
  DROP sim parses against the live DB.

### 7.2 — Dead flags + dead prod env vars → deleted

11 of 12 audit-flagged settings fields deleted from ``config.py``
(``trace_quality_hot_path_enabled`` was redundant — the pipeline already gates
via ``trace_quality_enabled`` + ``trace_quality_worker_enabled``;
``checkpoint_enabled``/``interrupt_before_*`` were a LangGraph cluster with no
LangGraph integration; the ``*_v1`` experiment flags were one-shot or shipped).
The 12th — ``debugger_checkpoint_backfill_v1`` — was **restored after review**
when a ``scripts/`` scan proved ``backfill_checkpoints.py`` (a live one-shot
script) gates on it; the audit had only grepped ``src/eden``. Its n14 pin test
was updated to the surviving flag. 10 dead env vars removed from
``northflank.yml`` (``QDRANT_*`` / ``LOG_JSON`` / ``SANDBOX_*`` /
``SNAPSHOT_POOL_SIZE`` / ``PIPELINE_TIMEOUT_ENABLED``) — verified zero readers
anywhere including ``scripts/``, docker-compose, and the qdrant client config
path (the app never connects to qdrant in ``src/``; ``build_nf_env_payload.py``
references ``QDRANT_API_KEY`` only as a secret-group-owned name).

### 7.3 — Stale doc tracking → fixed

``FEATURE-GAP-MASTER.md`` line 114 drifted (F41 marked open while the GA
checklist had it DONE) — corrected to match the shipped state.

### 7.4 — Dead code → removed

``is_fix_now_item`` helper removed from ``cockpit_aggregator.py`` (zero
callers; fix-now membership *is* the column returned by
``_queue_column_for_plan``). Queue-split test updated; ``kb_audit.py`` gained
an explicit note that ``retrieval_relevance_scores`` no longer exists.

## Sequencing & dependencies

- **Wave 1 first** (1.1–1.4) — four confirmed dead/hostless nodes, independent,
  each ≤ a day. 1.4 unblocks the "proactive" half of N23 on its own.
- **Wave 2 depends on 1.1** (the evolver trigger must work for canaries to have a source)
  and 1.2 (rollback must work for the loop to be safe). 2.1–2.4 parallelize; 2.5 gates on 2.1–2.4.
- **Waves 3 + 4 parallel after Wave 1** (disjoint files).
- **Wave 5** can interleave from Wave 2 onward (5.1 is the visible proof of 2.x).
- **Wave 6** starts the moment 2.5 produces its first real promote + 4.x confirms it.

## What this buys

After W1–W4: every autonomy node runs on real data — detection (per-agent), triage,
policy-gated heals that actually roll back live canaries, issue→patch→test→PR→merge
with post-merge degradation monitoring, and a learning loop where all six fix classes
accumulate evidence. After W5: operators can see, tune, and trust the whole loop.
The machinery is ~85% built and ~60% wired; Waves 1–2 are the difference between
"Eden proposes fixes" and "Eden fixes your agent, proves it, and learns."
