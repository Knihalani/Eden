# Eden — Proactive Agent Improvement Plan (2026-08-11)

**Goal:** make the tagline's "proactive" word real — Eden doesn't just show you what's
wrong, it **fixes the agent** (prompt / tool / code), **proves the fix worked**, and
**gets smarter per agent** with every cycle. No reporting/digest features in scope; this
plan is exclusively the detect → triage → fix → verify → ship → learn machinery.

**Status legend:** ✅ live · 🟡 built-but-inert (wiring missing) · ⬜ missing · ❌ **broken**
(verified this pass).

---

## Part 0 — Verified ground truth (what the validation pass proved)

Every claim below was re-verified against current code on 2026-08-11 (not the earlier
strategic-review dates). Two prior claims were **corrected**; the headline finding got
**bigger**.

### Corrected claims (previous research was wrong)

| # | Earlier claim | Truth (verified) |
|---|---|---|
| C1 | StatGate "not packaged in Docker → EvidenceGate degrades to hold in prod" | ❌ **Wrong.** `Dockerfile:101–106` copies `supplementaries/phase_6_stat_gate/gate.py` into the image; `EvidenceGate.evaluate()`'s Bayesian/StatGate path **works in prod**. The "stat_gate unavailable" comment in `evidence_gate.py:320` is stale. |
| C2 | "Replay-before-approve / test-gate flag-gated off in prod" | ❌ **Wrong.** `config.py:1358` `replay_verify_enabled: bool = True`, `config.py:1368` `test_gate_enabled: bool = True`. Both verify-before-ship gates are **live by default** (only `test_gate_synthesis_v1`, the LLM-writes-your-tests leg, is off by design — honesty). |
| C3 | "`record_shadow_feedback` has zero callers" (2026-08-07 strategic review) | ❌ **Stale — wired since.** `agent_issues.py:287` calls it on resolve/ignore; MCP `confirm_shadow_detector` tool (`mcp_server/tools.py:462`) calls it. Loop-1 feedback is live. |
| C4 | "Autonomy mostly proposed, not shipped" | ❌ **Understated.** N20 autonomous code fix **DOGFOOD (SOTA W26)**; N21 self-heal **SHIPPED** (`autonomous/investigation.py` SelfHealer, `_HEALABLE={rollback,reweight,cache_bust}`, `auto_runtime_heal=True` default); N22 policy engine **SHIPPED v0**; N23 recurring improvement agent **SHIPPED v0** (portal `/improve/plans`, `/improve/runs`, weekly cron `0 3 * * 0`). |
| C5 | "Prod-failure → regression-suite growth needs building" (prior F-3 draft) | ❌ **Already built.** `regression_builder.on_issue_resolved` + `RegressionRunner.run_suite` + `IssuePromptEvolver.evolve_from_issue` all fire on `POST /agent-issues/{id}/resolve` (`agent_issues.py:250-265`). |

### The headline finding (bigger than reported)

**The prompt-canary A/B loop is dead at both ends.** Eden can *enroll* a canary
(`PromptEvolvers._auto_create_canary` writes `prompt_canary_experiments` +
`prompt_version_assignments` — ✅ verified working), but:

1. **Selection is never called.** `pick_canary_version` (`src/eden/agents/prompt_canary.py`)
   — the per-tenant traffic split — has **zero production callers** (only tests + comment
   references). `PromptLoader` (`agents/base.py`) loads the global active prompt and never
   consults `prompt_version_assignments`.
2. **Evidence is never written.** `PromotionLoop._evaluate_one` and
   `EvidenceGate._prompt_version_outcome_metrics` both query
   `telemetry_events.attributes->>'prompt_version'` — but **no code anywhere writes it**:
   - The 48-column `TELEMETRY_INSERT_SQL` (`telemetry_collector.py`) has no
     `prompt_version` attribute and no `prompt_version_id` column.
   - The other two `INSERT INTO telemetry_events` sites (time-travel recorder,
     debugger checkpoints) stamp `cacheable/cache_key/step_index` — never a version.
   - `agents/base.py` stores `self._prompt_version` and exposes a `prompt_version()`
     property — **nothing reads it for stamping**.
   - The `@prompt` SDK decorator's docstring claims it "records the call into
     `telemetry_events` with the current `prompt_version_id`" — **the implementation
     never writes to `telemetry_events` at all** (doc-vs-code drift).
3. **Tests can't catch it.** `test_promotion_loop.py` stubs `fetchrow` with fake stats and
   stubs `_evidence_gate_promote`; `test_evolver_canary.py` asserts only the canary
   INSERTs + audit log, never the span stamp. Suite green; loop can never fire.

Net: **canary promotion returns `keep` forever and EvidenceGate returns `hold` forever.**
The "Eden automatically improves your prompts" story is a machine with no fuel.

### Other verified state (unchanged from prior passes)

| Item | State |
|---|---|
| `evolution_loop_enabled` | ⬜ `False` at config (`config.py:686`) **and** per-org new-org default (`orgs.py:557`) — the only loop still off |
| `promotion_loop_enabled` | ✅ `True` (but starved — no evidence, see headline) |
| Per-agent detection calibration (Loop 1) | 🟡 **feedback wired** (resolve + MCP); ⬜ per-agent dimension not built — `nl_signals` still has no `agent_id` column (no live migration), `resolve_profile(org_id)` is org-only |
| Post-merge monitoring | ⬜ `post_merge_windows` table exists (migration 027), **zero non-migration writers/readers** — dead schema |
| EvidenceGate outcome sources | 🟡 `nudge` ✅ real (`nudge_outcomes`); `prompt_version` 🟡 code exists but starved (headline); `guardrail` / `model_routing` / `kb_skill` / `pr_merge` ⬜ honest-empty `[]` — file documents exactly which tables each needs (F41 spec: **PARTIAL**) |
| Replay-verify + test gate | ✅ live by default (`replay_verify_enabled`, `test_gate_enabled`) |
| Auto-merge | 🟡 `auto_code_patch_merge` defaults `False` (dark by design), `auto_merge_max_per_week=2` — process-gated, correct |
| Improvement sweep | ✅ `ImprovementAgent` recurring weekly sweep (z-scores, ev_capture, $25/day budget, 60s cap), GitHub-linked orgs only, advisory/code/prompt lanes |
| Self-heal / policy / code-fix machinery | ✅ N20 DOGFOOD, N21 SHIPPED, N22 SHIPPED v0, N23 SHIPPED v0 |

---

## Part 1 — The plan (fix what's broken, then prove it)

Ordered by dependency. Waves are parallelizable within themselves.

### Wave A (P0) — Fuel the canary loop: select + stamp + prove

The single highest-value change in the codebase. Three shipped subsystems
(evolution loop, PromotionLoop, EvidenceGate) become real instead of decorative.

| # | Task | Files | Verify |
|---|---|---|---|
| A1 | **Wire canary selection into runtime prompt resolution.** `PromptLoader` must consult `prompt_version_assignments` via `pick_canary_version(assignments, tenant_id, agent)` and serve the winner (with global-active fallback) — today it serves global-only. Per-tenant org_id → `telemetry_events.tenant_id` mapping already exists | `src/eden/agents/base.py`, `src/eden/agents/prompt_canary.py` | New test: assignment row at 5% + seeded roll → some runs resolve canary version; 0% → never |
| A2 | **Stamp the resolved version on every agent.run span.** Add `attributes.prompt_version = <resolved>` at the emit path (the resolved version flows through `PromptLoader._prompt_version` into the span's attributes JSONB). This is the single missing write everything downstream reads | `src/eden/agents/base.py` (+ span-emission path in `telemetry_collector.py`/OTel exporter if stamping belongs there) | New test: enroll canary → emit run → assert `attributes->>'prompt_version'` present and correct |
| A3 | **Fix the `@prompt` decorator drift.** Either implement the documented telemetry write or correct the docstring — it currently promises recording and records nothing | `src/eden/sdk/prompt_decorator.py` | Doc matches code; decorator test asserts recorded call if implemented |
| A4 | **Turn the loop on, org-scoped.** Flip `evolution_loop_enabled` for a dogfood org (not globally), set `evolver_auto_canary_pct` sensibly, and watch one full promote/rollback complete end-to-end on real telemetry | `src/eden/agents/evolution/loop.py`, `src/eden/api/routes/orgs.py`, config | Golden-path: canary enrolls → evidence accumulates → PromotionLoop promotes (or rolls back) → `prompt_version_assignments` goes 100% / `rolled_back` |

**Why it matters (market):** the web research confirmed **no observability vendor
auto-promotes a prompt canary from online convergence** — LangSmith/Langfuse/Braintrust
all do *manual* environment promotion or external CI/CD wiring. "Autonomous winner
declaration with statistical evidence" is a genuine 2026 market gap, and Eden's machinery
already exists — it just needs fuel. This is the differentiator.

### Wave B (P1) — Per-agent adaptive detection (the "gets smarter" half)

Loop 1's flagship upgrade, still not built. The strategic-review F13 doc already contains
the full engineer-ready spec (migration SQL, backfill, `detail` JSON-string gotcha).

| # | Task | Files | Verify |
|---|---|---|---|
| B1 | **Migration:** `ALTER TABLE nl_signals ADD COLUMN agent_id UUID` + regex backfill from the `[auto:{agent_id}]` description prefix (next migration number: **168**, live chain is Alembic under `src/eden/db_migrations/versions/`; the top-level `migrations/` dir is dead legacy) | `src/eden/db_migrations/versions/168_nl_signals_agent_id.py` | Migration applies; backfill maps existing rows correctly |
| B2 | ~~Wire the only feedback writer~~ — ✅ **already wired** (resolve + MCP, verified this pass) | — | — |
| B3 | **Per-agent precision.** Extend `resolve_profile(org_id)` → per-agent thresholds, fed by per-agent confirm/dismiss rates (now actually written by B2's wiring); `evaluate_shadow_precision` decisions drive thresholds instead of Slack strings | `src/eden/issues/detection_settings.py` | Two agents with different precision histories get different thresholds; promote fires for the good one |
| B4 | **Un-stick the promote path.** `evaluate_shadow_precision` needs `precision is not None` to promote — with feedback now landing (B2 verified) the `labeled > 0` branch can finally run | `src/eden/services/soft_issue_review.py` | Weekly promote job promotes a real confirmed detector |

### Wave C (P1) — Watch the merge (post-merge degradation → auto-revert)

The "ship → verify" node has no implementation — the table is dead schema.

| # | Task | Files | Verify |
|---|---|---|---|
| C1 | **Producer:** after a guardian code/prompt PR merges, write `post_merge_windows` rows (1h / 24h / 7d windows keyed on `pr_id`) sampling the merged change's error rate vs baseline | new `src/eden/improvement/post_merge_monitor.py` | Windows written on merge (webhook + poll fallback) |
| C2 | **Comparator:** on window expiry, compare post-merge vs pre-merge rates; on material regression, create a follow-up plan via the existing `parent_plan_id` guardian mechanism (revert path already exists) | `src/eden/improvement/approve.py`, guardian | Synthetic degradation → follow-up plan created with `parent_plan_id` set |
| C3 | **Surface:** post-merge status visible on the plan detail page (event log already append-only) | portal plan components | Portal shows "post-merge watch: degrading, follow-up filed" |

### Wave D (P2) — Evidence for every fix class

`EvidenceGate._metrics_from_outcomes` documents exactly what each kind needs. Four
producer tables + writers; all follow the `nudge_outcomes` pattern.

| # | Kind | Table + producer |
|---|---|---|
| D1 | `guardrail` | `guardrail_outcomes` (outcome_success per verdict) fed by a reviewer/override action — mirror `nudge_outcomes` |
| D2 | `model_routing` | Persist ModelRouter's in-memory tier/fallback counters to a `routing_decisions` table |
| D3 | `kb_skill` | `skill_applications`/`skill_outcomes` (did the applied skill help?) keyed by skill_id, fed by the flywheel |
| D4 | `pr_merge` | Merge/revert outcome source ("was this PR reverted/hotfixed?") — feeds Wave C's data |

### Wave E (P2) — Earned autonomy (the T4 dogfood program)

Process, not code. The autonomy ladder (T0 observe → T4 auto-merge) is documented and
correct; `auto_merge_max_per_week=2` and `auto_code_patch_merge=False` are deliberate.
Note N20 is already **DOGFOOD** — the code-fix lane is live; this wave extends that
dogfood to the prompt-canary lane once Wave A lands.

| # | Task |
|---|---|
| E1 | Add the Wave-A canary lane to the existing dogfood orgs; run at T2/T3 with `evolution_loop_enabled` + Wave A |
| E2 | Publish the documented "5 consecutive clean auto-merges" metric per org (EvidenceGate + post-merge windows are the proof) |
| E3 | When an org earns it, flip `auto_code_patch_merge=True` for that org only — T4 stays process-gated |

---

## Part 2 — Proposed features (researched + grounded)

Market research (2026): what's real vs vaporware, and where Eden can win. Sources:
LangSmith/Langfuse/Braintrust/Helicone/PromptLayer product surfaces, Datadog LLM
Observability, Arize Phoenix, Promptfoo/DeepEval, Devin/Cursor/Claude Code.

### Feature proposals (each builds on verified code + a verified market gap)

| # | Feature | Market gap (verified) | Builds on | Effort |
|---|---|---|---|---|
| **F-1** | **Canary Auto-Promotion with evidence** — enroll → split → stamp → evaluate → promote/rollback, fully autonomous with Statistical/Bayesian proof | Nobody auto-promotes prompt canaries from online data; manual promotion is the 2026 norm | Wave A (all of it) | S (after A) |
| **F-2** | **Post-Merge Guard** — auto-revert prompt/code change when post-merge metrics degrade | Datadog auto-reverts microservice deploys, but nothing does it for agent prompts/graphs | Wave C | M |
| **F-3** | **Prod-failure → regression-suite growth** — every resolved issue generates a replay case into the regression suite (trace → case via `extract_failure_signature`) | Market confirmed: "test cases go stale; nothing auto-generates cases from production failures" (researcher-verified gap) | `RegressionRunner`, `replay_verify`, `on_issue_resolved` | S |
| **F-4** | **Per-agent adaptive detection** — detection thresholds that learn per agent from confirm/dismiss + precision | Static thresholds everywhere in 2026; "smarter per agent" is unclaimed | Wave B | M |
| **F-5** | **Guardrail shadow → live with proof** — shadow verdicts accumulate `guardrail_outcomes`; EvidenceGate promotes shadow to live-block only on evidence | Shadow-mode exists everywhere; automated shadow→live transition on confidence is a stated tuning pain | Wave D1 | M |
| **F-6** | **Do-not-repeat ledger surfaced in the fix loop** — Ledger DNR + KB skills injected into the *next* patch/prompt generation (not just triage context) | KB flywheels are "mostly marketing" per research; Eden's is built — surfacing it in fix generation is the differentiator | `LedgerGenerator`, `BookGenerator`, `ImprovementAgent` context | S–M |
| **F-7** | **Issue → fix → verify → ship evidence trail** — a single "autonomy ledger" per issue (plan, replay result, test gate, merge, post-merge window, EvidenceGate report) rendered on the plan page | No vendor shows the whole closed loop as one trustworthy trail; trust is the gating factor for autonomy | existing plan-event-log, `post_merge_windows`, EvidenceGate | S |

### Sequencing

- **Wave A first.** F-1 is the flagship and everything downstream (F-2 evidence, F-7
  trail) leans on the fuel line. A1–A3 are independent and parallelizable; A4 gates on
  A1–A3.
- **Waves B + C parallel after A** (different files, no overlap with A).
- **Wave D** tables can be built in parallel with B/C (schema-only, no shared files).
- **Wave E** starts the moment A4 produces its first real promote.

---

## What this buys the tagline

After A+B+C: Eden **detects** (8 detectors + per-agent-adaptive thresholds), **fixes**
(prompt canaries with real evidence, code patches through guardian, nudges), **proves**
(replay-verify + test gate + EvidenceGate on real data), **ships** (guardian PRs +
post-merge windows + auto-revert on degradation), and **learns** (per-agent calibration,
Ledger DNR, KB flywheel) — every step measured on data that actually exists. The
machinery is ~85% built; Wave A is the difference between "Eden proposes fixes" and
"Eden fixes your agent, proves it worked, and gets smarter the next time."

**Next action:** implement Wave A (fuel line: A1 select + A2 stamp + A3 decorator +
A4 enable-on-dogfood), with the two pinning tests added first so the gap can never
silently regress.

---

## Part 3 — The winnowed feature list (2026-08-11 validation pass)

Every candidate from Part 2 was re-tested against live code + its suites
(evolution/promotion/evidence 46 ✅, shadow/regression/replay/test-gate 78 ✅). This is
the final list of **actually useful** items — candidates that turned out to already be
built were dropped, not listed.

### ✅ Worth building (verified gap, verified value)

| # | Feature | Verified gap | Why it's useful | Effort |
|---|---|---|---|---|
| **1** | **Canary fuel line** (A0 trigger fix + A1 select + A2 stamp + A3 decorator + A4 registry unify + A5 enable) | **Trigger dead too:** `_AGG_QUERY` joins `te.id` (no such column) to `js.trace_id` and reads `attributes->>'agent_id'` (never written) → evolver always returns 0 (Part 4 F-A). Plus `pick_canary_version` zero prod callers; nothing writes `attributes->>'prompt_version'`; `@prompt` docstring ≠ code; two incompatible prompt registries (F-C); `evolution_loop_enabled=False` everywhere | The differentiator: autonomous prompt winner-promotion from online data (market gap — no vendor does it). Everything hangs on it | M (A0–A4) + M (A5) |
| **1b** | **Checkpoint persist fix** (F-B) | `CheckpointStore.save()` INSERTs into non-existent `id` column → debugger checkpoints silently fail to persist; docstring promises `source_format` that the INSERT never sets | Debugger replay/verify (the fix-verification backbone) currently can't record checkpoints against real Postgres | S |
| **2** | **Per-agent detection calibration** (B1 migration + B3 per-agent thresholds) | `nl_signals.agent_id` absent; `resolve_profile(org_id)` org-only | "Gets smarter per agent" — the only Loop-1 dimension still missing; feedback wiring (B2) already landed | M |
| **3** | **Post-merge guard** (C1 producer + C2 comparator + C3 surface) | `post_merge_windows` is dead schema; no auto-revert for agent changes anywhere | Closes ship→verify; market gap (nothing auto-reverts agent prompts/graphs) | M |
| **4** | **Four outcome tables** (D1–D4: guardrail, routing, skill, merge) | F41 spec: **PARTIAL**; `_metrics_from_outcomes` returns honest `[]` for 4 of 6 kinds | Every fix class learns; unblocks EvidenceGate promote for guardrail/kb_skill/merge | M (4×S tables, same pattern) |
| **5** | **Autonomy ledger per issue** (F-7) | Plans show replay/test/merge events, but no single evidence trail rendered end-to-end | Trust is the gating factor for autonomy adoption; cheap surfacing of data that already exists | S |

### ❌ Dropped (already built / not useful after validation)

| Candidate | Why dropped |
|---|---|
| Prod-failure → regression-suite growth (F-3) | **Already built** — `on_issue_resolved` + `RegressionRunner` + `IssuePromptEvolver` fire on every resolve (`agent_issues.py:250-265`) |
| Guardrail shadow→live (F-5 as standalone) | Already exists as `_activate_live_guardrail`; only its *evidence source* (D1) is missing — folded into #4 |
| Do-not-repeat ledger surfaced in fix generation (F-6) | Ledger/KB context already injected into triage + prompt evolution; the remaining gap is measurement (folded into #4/kb_skill) |
| Wave-B2 feedback wiring | Already wired (resolve + MCP) |
| Self-heal / policy / code-fix / recurring agent builds | Already SHIPPED or DOGFOOD (N20–N23) |
| StatGate packaging (earlier 6.2) | Already shipped in Docker |
| Replay-verify / test-gate flags (earlier 4.1) | Already on by default |

### Sequencing

**#1 (A0→A1→A2→A3→A4→A5) → (#2 ∥ #3 ∥ #4 tables) → #5.** A0 (trigger) gates
A1/A2's meaning; A4 (registry unify) must land before A5 can promote sanely. #1b is
a 20-minute fix that can land anytime. #2/#3/#4 touch disjoint files and
parallelize. #5 is independent and can land anytime after #1.

---

## Part 4 — Deep-dive findings (2026-08-11, second pass)

Full source reads of the fuel-line core (`agents/base.py`, `evolution/loop.py`,
`evolution/components.py`, `prompt_canary.py`, SDK `trace.py`, migrations 009/010/012/034)
plus schema/join verification. **Three new silent failures found** — the evolution
loop is dead at its *trigger* as well as its selection and evidence nodes.

### F-A (P0, NEW) — The evolver trigger can never attribute scores to an agent

`JudgeScorePromptEvolver._AGG_QUERY` (`components.py:76-107`) does:

```sql
SELECT ... te.attributes->>'agent_id' AS agent_id
FROM judge_scores js
LEFT JOIN telemetry_events te ON te.id::text = js.trace_id
WHERE j.agent_id IS NOT NULL
```

Two independent breaks:

1. **`te.attributes->>'agent_id'` is never written.** The SDK emits `agent_id` as a
   *top-level payload field* (`sdk/python/eden_sdk/trace.py:373`), which the
   collector persists into the *top-level `agent_id` column* (migration 009). Grep
   across `src/eden/observability/` for any writer of `attributes['agent_id']`:
   **zero hits**. So `attributes->>'agent_id'` is always NULL → the
   `WHERE agent_id IS NOT NULL` filter drops every row → evolver always reports
   `degradations_detected: 0`.
2. **The join key is wrong on two counts.** `telemetry_events` PK is `event_id`
   (migration 009; rebuilt as `(event_id, timestamp)` in 034) — **no `id` column
   exists** in any of the 20+ migrations touching the table. So `te.id` errors at
   runtime (caught → `[]`), or — if a pre-Alembic `id` column survives from legacy
   DDL — it compares event-id to judge `trace_id`, a namespace mismatch (SDK
   `trace_id` is a UUID hex; `event_id` is `eden_span_<span_id>`). Either way the
   join can never match.
3. **Tests can't catch it.** `test_judge_prompt_evolver.py` fixtures bake
   `agent_id="planner"` directly into fake joined rows and mock the postgres
   `fetch()` — the real SQL never executes. 12/12 tests pass while prod is a no-op.
   The `dropped_null_agent_id` counter (`components.py:31`) exists precisely because
   someone observed rows never carrying an agent — the symptom, not the fix.

**Fix (Wave A, item A0, before A1):** join `te.trace_id = js.trace_id` (both are
UUID-hex trace ids) and read the real agent source — either `te.agent_id` (top-level
column, populated for SDK framework events) or keep `attributes->>'agent_id'` and
add a one-line stamp in the collector's attribute merge. Then assert with a test that
runs the SQL against a real/fake schema instead of pre-joined rows.

### F-B (P0, NEW) — `CheckpointStore.save()` writes to a non-existent `id` column

`debugger/checkpoints.py:207-217` INSERTs into `telemetry_events (id, tenant_id,
...)` — but the live schema has `event_id`, not `id`. If `save()` runs against real
Postgres it raises `UndefinedColumnError` (the checkpoint silently fails to persist
or the caller swallows it). Doc drift too: the module docstring promises
`source_format = "debugger_checkpoint"`, the INSERT never sets `source_format` and
uses `event_type = 'debugger.checkpoint'` instead. **Fix:** use `event_id` + set
`source_format`; add a schema-touching test.

### F-C (architecture, NEW) — Two prompt systems that don't talk

* **Legacy `prompt_versions`** (int-keyed, global, `active` flag): read by
  `PromptLoader`/`JudgeScorePromptEvolver`/`PromotionLoop`/`EvidenceGate`; the
  canary tables (`prompt_version_assignments`, `prompt_canary_experiments`, migration
  012) are int-version-keyed against it.
* **Per-org `prompts_v2`** (UUID-keyed, migration 055): used by
  `IssuePromptEvolver` — which *explicitly refuses* the legacy APIs and documents
  BUG-8 (no `agent_id → prompt_name` mapping exists in prompts_v2).

Consequence: the issue-driven evolver and the canary/promotion machinery operate on
two incompatible version namespaces. `IssuePromptEvolver` passes prompts_v2's
per-prompt int (`new_version`) into `_auto_create_canary`, which writes
`prompt_version_assignments` keyed as if it were a legacy version — a version 1 in
one system can silently mean a different prompt than version 1 in the other.
**Fix (Wave A):** unify on one registry — either backfill prompts_v2 rows into the
legacy table with real legacy ints, or (preferred) migrate `PromotionLoop`/
`EvidenceGate`/`pick_canary_version` to key on `prompt_version_id` (UUID) and keep
legacy as read-only shim.

### F-D — `@prompt` decorator still claims telemetry it doesn't write

Confirmed again in the full read: `sdk/prompt_decorator.py` docstring promises
"records the call into `telemetry_events` with the current `prompt_version_id`";
the implementation only touches `prompts`/`prompt_versions` rows. Doc-vs-code drift.

### F-E — Canary cockpit is a backend-only story

Portal surfaces for canaries/promotion are limited: `improve/page.tsx` renders
`NudgesPromotionsPanel`; `improve-chrome.tsx` has a `promotions` tab — but no
canary experiment cards, traffic %, or promote/rollback history render anywhere.
Even once F-A/A1–A2 land, operators have no UI to watch a canary. (Feature #5's
evidence trail is the natural home.)

### Revised Wave A (fuel line, now with the trigger)

| # | Task | Files | Verify |
|---|---|---|---|
| A0 | **Fix the evolver trigger** — join `te.trace_id = js.trace_id`, read `te.agent_id` (or stamp `attributes.agent_id`), assert with a schema-touching test | `agents/evolution/components.py`, `observability/telemetry_collector.py` | SQL test runs against real schema shape; `degradations_detected > 0` on synthetic judge rows |
| A1 | Wire canary selection into `PromptLoader` (consult `prompt_version_assignments` via `pick_canary_version`) | `agents/base.py`, `agents/prompt_canary.py` | Assignment at 5% + seeded roll → some runs resolve canary version |
| A2 | Stamp resolved version on every agent.run span (`attributes.prompt_version`) | `agents/base.py`, SDK `trace.py` | Span carries `attributes->>'prompt_version'` |
| A3 | Fix `@prompt` decorator drift (implement telemetry write or fix docstring) | `sdk/prompt_decorator.py` | Doc matches code |
| A4 | Unify the two prompt registries (or bridge versions) | `prompts_v2` + legacy | Canary ints and prompts_v2 versions never collide |
| A5 | Enable `evolution_loop_enabled` org-scoped; watch a real promote | `evolution/loop.py`, config | Golden-path promote on real telemetry |

Also fixed along the way: `CheckpointStore.save()` `id`→`event_id` (F-B).
