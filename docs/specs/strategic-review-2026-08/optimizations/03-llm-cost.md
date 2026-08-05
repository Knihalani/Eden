# O3: LLM Cost Optimization

## Scope

Phase 1 audited `src/eden/services/soft_issue_review.py`, `src/eden/api/routes/signal_investigator.py`,
`src/eden/signals/classifier_pipeline.py`, plus `src/eden/signals/investigator.py`,
`src/eden/signals/classifier_worker.py`, `src/eden/workers/trace_finalized_consumer.py`,
`src/eden/llm/internal_router.py`, `src/eden/optimization/model_router.py`, `src/eden/llm/client.py`,
`src/eden/config.py`.

Phase 2/3 re-verified every Phase 1 claim (all checked out) and widened the net across the **rest
of the codebase** to find every place Eden's *own* product spends real LLM dollars:
`src/eden/issues/triage_agent.py`, `src/eden/autonomous/investigation.py` + `_common.py` (Cat‑14
"Autonomous Intelligence"), `src/eden/autonomous/agent.py` (the interactive AI copilot / "Cmd‑J"
chat), the judge pipeline (`src/eden/llmops/judges/{unified,redis_tailer,_sampling,_router,base}.py`),
evolution/prompt‑gen (`src/eden/agents/evolution/loop.py`), RCA (`src/eden/insights/rca/analyzer.py`),
and guardrails (`src/eden/guardrails/*.py`). It also traced the customer‑visible cost ledger
(`src/eden/llmops/cost_ledger.py`, `src/eden/closed_loop/autonomy_policy.py`) end‑to‑end and found
two live, unfixed bugs: (a) a fake flat cost is written for triage while the real metered cost is
silently dropped because `org_id` never reaches `cost_context`, and (b) `UsageStats.cache_reads`/
`cache_writes` don't match OpenRouter's real usage schema, so Eden can't verify whether it's
already getting DeepSeek's automatic prompt-cache discount.

**Phase 4 (this pass)** goes one level deeper on both bugs: it (1) traces the *exact* mechanical
root cause of the `org_id` drop — every function, every missing kwarg, every silently-affected
call site, including four call sites Phase 3 didn't know about — with a precise, minimal fix; (2)
verifies OpenRouter's real usage-accounting schema live against current docs (not just cited) and
fix-specs the cache field names exactly, including a field OpenRouter reports that Eden doesn't
capture at all; (3) separates "dollar-miscounted" from "unverifiable" for the cache bug, which
turns out to be an important distinction; and (4) produces a bounded, assumption-labeled estimate
of the dollar blast radius of both bugs together, since neither Phase 1-3 pass attempted one.

This is about **Eden's own internal LLM spend** (COGS to run Eden's product features) — not
customer cost governance/observability of *customers'* agent spend, which is a separate
feature doc's territory. All calls below share one fact confirmed at `src/eden/config.py:443`:
there is a single global `openrouter_api_key` — no per‑org BYOK — so every call in this file is
billed to Eden, not passed through to a customer's own key.

## Headline finding: the investigator's "LLM cost" is still $0, and it's not alone — RCA is $0 too, guardrails have zero LLM calls, and virtually all *remaining* live LLM spend already collapsed onto one $0.14/1M‑input flash model in the 2026‑08‑01 "Soft Autonomy" change

The task brief (and the scorecard's §2 line "Deterministic before LLM … F34 classifiers before
F06 investigator | **MET**") frames F34 (`classifier_pipeline.py`) as reducing reliance on a live
per-signal LLM investigator. That premise is stale:

- `signal_investigator.py:260-266` (docstring) states plainly: "the per-signal LLM path was
  retired, see `eden.signals.investigator`". `investigate_trace()` in
  `src/eden/signals/investigator.py:186-316` only ever takes the `statgate_rule` (deterministic,
  `_eval_statgate_rule`, L111-155) or `_heuristic_match` (keyword matcher, L76-108) branches. The
  `elif inv_prompt:` branch (L278-282) explicitly says *"LLM investigator path removed —
  heuristics only"* and calls `_heuristic_match`, not an LLM.
- The actual LLM call stubs are dead: `run_investigator_llm_batch` (L158-165) always returns `{}`;
  `_one_completion` (`investigator.py:168-170`) `raise RuntimeError("signal investigator LLM path
  removed")` — confirmed verbatim, exact line 170.
- `classifier_worker.py:12-25` documents this directly: `INVESTIGATOR_COST_USD = 0.03` is
  annotated *"NOT a real price… skipping it saves compute and database writes, not model spend…
  It is deliberately only ever added to the local `savings` counter… must not be written to
  `cost_usd` on a CostEvent"*. `trace_finalized_consumer.py:700-709` documents that this used to be
  a real bug — the consumer previously booked a hardcoded $0.03 of fictitious spend per
  investigated trace into the real cost ledger — and has since been fixed to `cost_usd=0.0`.

**Two more Cat‑2/Cat‑6 surfaces the task brief didn't name turned out to be the same story:**

- **RCA is also $0 today.** `src/eden/insights/rca/analyzer.py:1-18` (module docstring):
  `RootCauseAnalyzer` is *"a rule-based pre-filter that walks a 6-rule table … Phase 1 upgrade path
  (deferred): an LLM-as-judge fallback for cases where no rule fires with confidence > 0.6."* Every
  response carries `model: "rule_based_v1"` (docstring, `categorize()` at L79-90). There is no LLM
  call anywhere in `src/eden/insights/rca/` — the upgrade is explicitly not built. Same pattern as
  the investigator: a "cost optimization" target that is already free.
- **Guardrails have zero live model calls.** `grep`-ing every symbol that reaches an LLM client
  (`OpenRouterClient`, `get_llm_client`, `route_sync`, `route_async`, a bare `model=` kwarg) across
  `src/eden/guardrails/{policy,intervention,detectors,__init__}.py` returns nothing. Guardrail
  checks are regex/threshold detectors (`detectors.py`), not an LLM judge.

**Where the real, non-zero Eden-internal LLM spend actually is** (detailed below) turns out to be
concentrated in nine call-site families, and as of the 2026-08-01 "Soft Autonomy" change
(`model_router.py:25-39`) **every one of them resolves to the same single flash-tier model**
(`eden.llm.models.INTERNAL_CHAT_MODEL`, default `"deepseek/deepseek-v4-flash-0731"`,
`llm/models.py:19-20`) via `TIER_MODELS` — because T1/T2/T3 all alias to `internal_chat_chain()`
now. This means the classic "smaller-model routing" lever (route classification/simple tasks to a
cheap model, save the expensive model for reasoning) is **already fully applied platform-wide** —
there is no live call site anywhere in this audit where an expensive model is doing cheap work.
The actual savings opportunities that remain are a live cost-**accounting** bug — present in two
independent code paths (`_call_llm`/`route_async`, and separately `ModelRouter`) — an
unverified/likely-broken cache-telemetry read, and one piece of stale in-code commentary — not a
routing or model-selection fix.

## Live LLM call sites (real, non-zero $ spend) and their volume/caching posture

1. **`llmops/judges/unified.py` + `redis_tailer.py` — the highest-volume live path.**
   `RedisTailer` (`redis_tailer.py:14-24` docstring) is started from the API lifespan and tails
   *every tenant's* `telemetry:{tenant_id}:{trace_id}:events` Redis stream, running the judge
   registry on qualifying events. Without a gate this would be a per-production-event LLM call
   across the whole fleet; the gate is `production_sample_matches()`
   (`llmops/judges/_sampling.py:12,40-49`): **1.2% deterministic sampling**
   (`PRODUCTION_SAMPLE_RATE = 0.012`) with an unconditional bypass for `p0`/`stumble`-tagged
   events. `UnifiedJudge.score()` (`llmops/judges/unified.py:98-151`) already batches *all* axes
   (hallucination/correctness/tone/etc.) into **one** LLM call per sampled event
   (`route_judge_call(... agent="judge_unified", max_tokens=450)`, L114-121) rather than one call
   per axis — that dedup is already done. `model_slot = "fast"` (L76) resolves through
   `ModelRouter`/`TIER_MODELS` to the same DeepSeek flash model as everything else. Net: this is
   real, continuous, fleet-wide spend, but it is already sampled to ~1% with a safety bypass and
   already multi-axis-batched — the two most common "LLM-judge cost" mistakes (scoring 100% of
   traffic, one call per metric) are both already fixed here.
2. **`issues/triage_agent.py` → `autonomous/investigation.py` (`InvestigationAgent.investigate`).**
   Per-issue, event-driven (fires when an issue is triaged), and StatGate-first:
   `TriageAgent.triage()` (`triage_agent.py:107-315`) only reaches the LLM branch
   (`InvestigationAgent().investigate(...)`, L223-230) when StatGate does **not** auto-escalate
   (L164) and the org's **triage-specific** daily cap isn't exhausted (`_budget_ok`, L187, checked
   below — this pass corrects Phase 3's citation of the wrong config knob). `slot="fast"` is
   explicitly pinned (comment at L214-217: *"pin triage classification to T1/SLM … so a
   TaskClassifier heuristic change cannot silently upgrade the tier"*) — another already-applied
   cheap-model-routing guardrail. Bounded evidence gathering caps at 8 tool calls
   (`_MAX_REACT_CALLS = 8`, L47) and the LLM call itself has a hard 90s timeout
   (`_LLM_TIMEOUT_S = 90.0`, L41).
3. **`autonomous/agent.py` `ChatService` — the interactive AI copilot ("Cmd‑J" chat).** Per
   user chat message. `_pick_model()` (`agent.py:1428-1443`) calls
   `chat_sota.model_for_tier(ModelTier.T2)`, which is `TIER_MODELS.get(ModelTier.T2)[0]`
   (`chat_sota.py:61-63`) — the same `TIER_MODELS` dict that Soft Autonomy collapsed onto DeepSeek
   flash (`model_router.py:25-39`). **This makes the in-code comment at `agent.py:1462-1466`
   stale**: it says *"Anthropic prompt-cache: tag the system message with an ephemeral
   `cache_control` breakpoint so Sonnet/Opus re-bills the prefix at 1/10 cost … the single biggest
   line item in the agent budget."* That comment describes pre-Soft-Autonomy economics — T2 no
   longer resolves to Sonnet/Opus, so the `cache_control` branch it's justifying
   (`_is_anthropic_model(model)` at L1470) is a no-op today for the same reason it's a no-op in
   `soft_issue_review.py` (see below). Low-priority doc hygiene: the comment should say what model
   T2 actually resolves to today, or the `_call_llm` docstring will mislead the next engineer who
   reads it into thinking Claude cost is still the chat copilot's dominant line item. Note this
   file's chat-cost write-through is **not** subject to the `org_id` bug found below — `_call_llm`
   at `agent.py:1684-1688` is a private `ChatService` method, unrelated to `autonomous/_common.py`'s
   module-level `_call_llm`, and it writes its `CostEvent` directly with `org_id=tenant_id`
   (`agent.py:1707-1717`) rather than going through `route_async`'s `cost_context`. This is the
   pattern the fix below should mirror.
4. **`services/soft_issue_review.py` `_scout_novel_patterns`** — unchanged from Phase 1: DeepSeek
   flash, bounded at `_MAX_ORGS_PER_NIGHT = 20` (L46) × `_MAX_AGENTS_PER_ORG = 3` (L47), ≈
   $0.01/org/night → **≤ ~$0.20/night, ≤ ~$6/month** system-wide worst case (module docstring,
   `soft_issue_review.py:21-25`). Also unaffected by the `org_id` bug — its `route_async(...)` call
   (`soft_issue_review.py:286-295`) explicitly passes `org_id=org_id, feature="soft_issue_review"`.
5. **`agents/evolution/loop.py` — background prompt-evolution tick.** `evolution_loop_enabled:
   bool = False` (`config.py:692`, **off by default**); when on, ticks every
   `evolution_loop_interval_seconds` (default 300s, `config.py:693`), gated by
   `EvolutionSpendBudget.may_spend(0.05)` (`loop.py:85-96`) against
   `max_evolution_ops_usd_per_org_day: float = 2.0` (`config.py:1442`) on a single platform-wide
   pseudo-org (`ops_org = "eden-ops"`, `loop.py:79`) — not per-tenant. Worst case **$2/day**,
   disabled by default.

**Not a live call site (on-demand only, not background/per-event):** `decision/decision_scorer.py`
`DecisionScorer` — the only caller found repo-wide is `api/routes/intelligence_replay.py:336`,
one route hit per user viewing a trace's decisions. Naturally bounded by request volume; not
worth budgeting as a recurring cost line.

**Three more live call-site families that share `autonomous/_common.py`'s
`_call_llm` with triage** (all affected by the same `org_id` bug, detailed below):

6. **`api/routes/intelligence_autonomous.py` — direct customer-facing API routes.** This is the
   HTTP surface for `InvestigationAgent` itself: `POST /orgs/{org_id}/intelligence/autonomous/investigate`
   (`intelligence_autonomous.py:160-179`, calls `_investigator.investigate(org_id, trigger=trigger)`
   at L179) and `POST .../report` (L182-187, calls `_investigator.report(org_id, period=body.period)`
   at L187). Unlike triage, this path is **not** gated by StatGate or a triage-specific budget cap
   at all — any authorized user hitting the route triggers a real LLM call. Volume is bounded by
   request rate, not a code-level cap.
7. **`autonomous/nl_interface/query.py` — the natural-language ("Ask Eden") query interface.**
   Imports `_call_llm` directly (`query.py:34`) and calls it four times — L136 and L182 (inside the
   method that takes `org_id` at L111), L264 (method takes `org_id` at L247), and L335 (method
   takes `org_id` at L324) — plus a fifth path through `InvestigationAgent().report(org_id,
   period=period)` at L372. Every one of these five calls has `org_id` sitting in local scope and
   drops it the same way triage does.
8. **`llmops/closed_loop_executor.py` — human-approved closed-loop action side effects.**
   `InvestigationAgent().investigate(org_id, trigger=trigger)` at `closed_loop_executor.py:266`,
   inside the `apply_approved` side-effect dispatcher — fires once per human-approved
   `investigate`-kind closed-loop action, so lower volume than the other paths, but still real spend
   that's currently invisible (see root-cause section).

**A ninth family, reaching the LLM through a structurally separate router, with its own
independent instance of the same cost-ledger bug:**

9. **`patches/patch_generator.py` + `patches/rca_linker.py` (via `optimization/model_router.py`'s
   `ModelRouter`) — the autonomous issue→patch→test→auto-merge closed loop.** Reaches the LLM
   through `ModelRouter.route()`/`.aroute()` (`model_router.py:461-654`) →
   `OpenRouterClient.call()` (`llm/client.py:375-388`), not through `autonomous/_common.py`'s
   `_call_llm` → `route_async`. Live callers: the main patch-generation call
   (`patch_generator.py:963-967`, `slot="reasoning"`/T2), the critic-review call
   (`patch_generator.py:575`, `slot="fast"`/T1), and RCA-to-code linking (`rca_linker.py:186-211`).
   `PatchGenerator` is constructed from `improvement/issue_patch_trigger.py`,
   `improvement/guardian.py`, `improvement/approve.py`, and `llmops/promotion_hooks.py` — the
   `improvement/` closed loop, **enabled by default** (`config.py:320`,
   `improvement_schedule_enabled: bool = True`), gated per-call by
   `improvement/sweep_budget.py::try_consume_llm_call()` (fails closed if no budget is armed — a
   real spend ceiling, but it doesn't affect the ledger bug below). Same DeepSeek-flash pricing as
   items 1-8 via the same `TIER_MODELS` collapse. This family has its own independent instance of
   the `org_id`-drop bug — see Root cause section below — not sized to a dollar estimate in this
   pass (no visibility into sweep-budget cadence or per-org call frequency).

## Root cause, precisely: the exact call chain where `org_id` gets dropped, and every fix site

This is a *pure omission* bug, not a scoping problem — at every point in the chain below, `org_id`
is already sitting in local scope as a function parameter; it's simply never passed to the next
call. Traced end-to-end, hop by hop:

1. **`autonomous/_common.py:181-188`** — `_call_llm`'s signature is
   `_call_llm(prompt, *, agent, slot=DEFAULT_LLM_SLOT, system_prompt=None, max_tokens=600) ->
   str | None`. **There is no `org_id` (or `feature`) parameter at all.** It cannot forward what it
   was never given.
2. **`autonomous/_common.py:203-211`** — inside `_call_llm`, the only outbound call is
   `await route_async(agent, prompt, slot=slot, system_prompt=system_prompt,
   max_tokens=max_tokens, output_type="json", requires_quality_check=False)` — no `org_id=`, no
   `feature=` kwarg.
3. **`llm/internal_router.py:93-105`** — `route_async`'s signature has `org_id: str | None = None`
   and `feature: str = "unknown"` as keyword-only defaults. Since step 2 never supplies them, both
   silently fall back to `None`/`"unknown"`.
4. **`llm/internal_router.py:123`** — `with cost_context(org_id, feature, agent_id=agent):` binds
   the ambient attribution context for the call — with `org_id=None`.
5. **`llmops/cost_ledger.py:98-124`** (`cost_context`) — `if org_id is not None:
   tokens.append((_org_id, _org_id.set(org_id)))` (line 110). Because `org_id` is `None`, this
   branch is skipped entirely, so the `_org_id` contextvar (default `None`, `cost_ledger.py:48-50`)
   is **never set** for the duration of the call — it isn't overwritten with `None`, it's just left
   at its already-`None` default. No caller upstream of this ever bound it either (triage's
   `record_spend`/`record_cost_event` path, traced separately below, is a completely different
   write that doesn't touch this contextvar).
6. **`llm/client.py:652-668`** (`_log_usage`) — after the real OpenRouter call completes, this
   calls `schedule_record_from_usage(model=..., prompt_tokens=..., completion_tokens=...,
   total_tokens=..., cost_usd=...)` — **note it passes no `org_id=` or `feature=` kwarg either**;
   it relies entirely on the ambient `cost_context` set in step 4/5.
7. **`llmops/cost_ledger.py:187-201`** (`schedule_record_from_usage`) — `ctx =
   current_cost_context(); oid = org_id or ctx.get("org_id"); if not oid: return`. Both sides of
   the `or` are `None` (no explicit `org_id` kwarg from step 6, and the contextvar was never set in
   step 5), so this is where the real, token-metered CostEvent is discarded — before it is even
   constructed, let alone written to Postgres.

**The fix is a two-line signature change plus threading `org_id=org_id` (already in local scope
everywhere it's needed) through six call sites:**

- `autonomous/_common.py:181-188` — add `org_id: str | None = None, feature: str = "unknown"` to
  `_call_llm`'s signature.
- `autonomous/_common.py:203-211` — add `org_id=org_id, feature=feature` to the `route_async(...)`
  call.
- `autonomous/investigation.py:162-167` (`investigate()`, `org_id` param at L83) — add
  `org_id=org_id, feature="autonomous_investigation"`.
- `autonomous/investigation.py:296-301` (`report()`, `org_id` param at L236) — add `org_id=org_id,
  feature="autonomous_report"`.
- `autonomous/nl_interface/query.py:136, 182` (`org_id` param at L111) — add `org_id=org_id,
  feature="nl_query"` to both.
- `autonomous/nl_interface/query.py:264` (`org_id` param at L247) — add `org_id=org_id,
  feature="nl_query"`.
- `autonomous/nl_interface/query.py:335` (`org_id` param at L324) — add `org_id=org_id,
  feature="nl_query"`.

No caller of `investigate()`/`report()` (triage, the API route, `closed_loop_executor`,
`nl_interface`) needs to change — they already pass `org_id` as a positional/keyword arg into
`InvestigationAgent.investigate`/`.report`; the gap is entirely inside `_common.py`/
`investigation.py`/`query.py`, one layer below where the last correctly-threaded call happens. This
exactly mirrors the pattern already used correctly twice elsewhere in the same codebase — worth
copying verbatim: `soft_issue_review.py:286-295` passes `org_id=org_id, feature="soft_issue_review"`
into `route_async` directly, and `autonomous/agent.py:1707-1717` (chat copilot) skips `route_async`'s
`cost_context` machinery altogether and constructs `CostEvent(org_id=tenant_id, feature=
"chat_sidebar", cost_usd=cost_usd, ...)` by hand. Either pattern closes the gap; the `route_async`
kwarg-threading fix above is the smaller diff since `_call_llm` already calls `route_async`.

**A second, structurally independent instance of the same bug: `optimization/model_router.py`'s
`ModelRouter`.** `ModelRouter.aroute()` (`model_router.py:538-546`) accepts an `org_id: str | None
= None` keyword parameter but never uses it anywhere in the method body (`model_router.py:552-613`)
— not forwarded to `self.llm_client.call(...)` (`model_router.py:578-585`, no `org_id=`/`feature=`
kwarg) and never bound into a `cost_context`. `ModelRouter.route()` (sync, `model_router.py:461-538`)
doesn't even accept `org_id` as a parameter. A grep of the whole file for `org_id`/`cost_context`
usage returns zero matches — `PipelineTask.org_id` (`model_router.py:70`) and `aroute`'s `org_id`
kwarg are both write-only. Both methods route through the same `OpenRouterClient.call()` →
`_log_usage()` → `schedule_record_from_usage()` chain as the `_call_llm` family
(`client.py:457,652-668`), so the same `if not oid: return` guard (`cost_ledger.py:199-201`)
silently drops the cost — for every call `ModelRouter` makes, including calls where a caller
*does* pass `org_id=org_id` (e.g. `patch_generator.py:963-967`), since `aroute` discards it
regardless. **Fix mirrors the one above:** thread `org_id`/`feature` through `ModelRouter.route`/
`.aroute` into `self.llm_client.call(...)`. This is call-site family 9 in the inventory above
(`patch_generator.py`/`rca_linker.py`), not one of the original five — it wasn't found by the
repo-wide grep that covered the other five because it follows a different call chain
(`ModelRouter.aroute` rather than `route_async`).

**Correction to the Phase 3 finding:** it stated `_call_llm` is "shared by `investigate()`,
`report()`, and `_llm_rationale()`, so this org_id-not-threaded gap silently zeroes out the real
cost-ledger entry for every Cat-14 'Autonomous Intelligence' LLM call." Verified in this pass:
`_llm_rationale()` (`investigation.py:1170-1187`) has **zero callers anywhere in the repository**
(`grep -rn "_llm_rationale" src/eden/` matches only its own definition). The surrounding code
explains why — a `ponytail` comment at `investigation.py:456-460` says the `RecommendationEngine`
class that would have called it "was deleted per upgradespec §D.4 … a v2 ship can restore the full
LLM-rationale + persistence path" — `_llm_rationale` is dead code left behind from that deletion,
not a live third call site. The bug's actual live blast radius is **six** call-site groups sharing a root cause (`org_id`
sitting in local scope but never threaded to where cost gets recorded): `investigate()` (triage,
the API route, `closed_loop_executor`), `report()` (the API route, `nl_interface`'s report path),
`nl_interface/query.py`'s four direct `_call_llm` calls, and — a structurally separate instance of
the same bug, described above — `ModelRouter.route()`/`.aroute()` (patch generation, critic
review, RCA-linking) — not three, and not five.

**Correction to Phase 3's budget citation:** Phase 3 said triage's `_budget_ok` (`triage_agent.py:
187`) checks "the org's shared `daily_maintenance_budget_usd` (`config.py:1278`, default
$25/org/day, shared with patches)." Re-read in this pass: `_budget_ok` (`triage_agent.py:466-486`)
calls `_resolve_budget_cap` (`triage_agent.py:439-464`), which reads org policy's
`max_triage_cost_usd_per_day`, falling back to `settings.max_triage_cost_usd_per_day` —
**`config.py:1263`, default `5.0`**, a distinct, tighter, triage-specific cap — not the $25 shared
maintenance budget. `daily_maintenance_budget_usd` (`config.py:1278`, `autonomy_policy.py:88,319`)
is a separate, wider cap enforced elsewhere (`evaluate_mode`'s downgrade logic), which `_debit_budget`
also feeds via `record_spend` (`triage_agent.py:489-500`) — the file's own comment at
`triage_agent.py:489-494` says explicitly there are two independent budgets, "the tighter triage
ceiling stays enforced independently of the org-wide budget." The $5/day figure matters for the
blast-radius estimate below; the $25/day figure does not gate triage's LLM branch at all.

## New finding (Phase 3, re-verified): a live, unfixed recurrence of the exact cost-ledger bug Phase 1 found already-fixed elsewhere

Phase 1 found that `trace_finalized_consumer.py` used to book a fictitious flat $0.03 into the
real `cost_usd` ledger for the (now-dead) investigator, and that this was fixed. The same failure
mode exists **today, unfixed, and live** in `issues/triage_agent.py`:

- `_TRIAGE_COST_ESTIMATE_USD = 0.02` (`triage_agent.py:36`) is a flat, non-metered constant.
- `triage()` calls `await self._debit_budget(org_id, _TRIAGE_COST_ESTIMATE_USD)` only when
  `llm_used` is true (`triage_agent.py:311-312`).
- `_debit_budget()` (`triage_agent.py:488-520`) calls
  `record_spend(org_id, amount, feature="triage", model="triage")`
  (`triage_agent.py:496-500`) — note `model="triage"` is a synthetic label, not a real model id.
- `autonomy_policy.record_spend()` (`closed_loop/autonomy_policy.py:331-379`) does two things:
  increments a Redis daily-spend counter, **and** unconditionally calls
  `record_cost_event(CostEvent(org_id=org_id, feature="triage", model="triage",
  cost_usd=float(usd), ...))` (`autonomy_policy.py:360-376`) — its own docstring at L360 labels
  this *"Customer-visible CostEvent (FinOps explorer)"*. This is the same ledger table Phase 1
  confirmed is the real, customer-facing cost record. Note this write path is entirely independent
  of the `cost_context`/`route_async` machinery traced above — it's a hand-built `CostEvent` with
  `org_id` correctly attached, which is exactly why the fake $0.02 lands while the real number does
  not: two unrelated code paths, one correct on attribution but wrong on amount (synthetic
  constant), one correct on amount (real metered tokens) but wrong on attribution (drops `org_id`).
- **Net effect:** for every triage that actually uses the LLM, Eden's own customer-facing FinOps
  ledger records a flat, invented $0.02 line tagged `model="triage"`, and the real (token-metered,
  DeepSeek-flash-priced) OpenRouter cost for that same call is never recorded anywhere.
- **Recommendation:** thread `org_id` through `_call_llm` → `route_async` per the precise fix above,
  and once real cost flows through, stop writing the synthetic `_TRIAGE_COST_ESTIMATE_USD`
  CostEvent so the ledger reflects metered dollars instead of a guess.

## Blast radius: how much of Eden's own LLM spend is miscounted or unverifiable

No production telemetry (call counts, actual org counts, actual daily issue/query volume) exists
in this repository, so this is a bounded order-of-magnitude estimate from code-level constants
(prompt shapes, `max_tokens` caps, budget ceilings) plus externally-verified per-token pricing —
**not** a measurement. Assumptions are stated inline.

**Real per-call cost, `org_id`-dropped paths (DeepSeek `v4-flash`, cache-miss pricing).** Verified
live against DeepSeek's own pricing docs (Aug 2026): **$0.14/1M input tokens, $0.28/1M output
tokens** on a cache miss (confirms the figure Phase 2/3 cited from secondary trackers).
`_INVESTIGATION_SYSTEM_PROMPT` (`investigation.py:55-62`) is ~60 words (~80 tokens); combined with
trigger context + up to 5 wrapped stumbles (`triage_agent.py:218,528-561`) and StatGate/evidence
summaries, a generous estimate is 500-2,000 input tokens per call. `max_tokens` caps: 600
(`investigate`), 300 (`report`), so realistic output is well under those. At the high end of that
range (2,000 in / 600 out): `2,000 × $0.14/1e6 + 600 × $0.28/1e6 ≈ $0.00028 + $0.000168 ≈
$0.00045` — **under half a cent per call**, and potentially ~98% lower still if the static system
prompt prefix is hitting DeepSeek's automatic disk cache (unverifiable today — see next section).

**Dollar-miscounting from the ledger bug, per org per day:**
- *Triage specifically* (the only one of the six affected groups with a budget ceiling tied to
  this exact ledger): the corrected $5/org/day cap (`config.py:1263`) bounds the **fake** recorded
  spend at $5/org/day/org if an org maxes it out (≈250 LLM-used triages/day at $0.02 each). At that
  same call volume, the **real** dropped spend is ≈`250 × $0.00045 ≈ $0.11/org/day` — so even at
  the theoretical ceiling, the fake number the ledger shows is **~45× the real number it's
  silently discarding**, and the true figure (a little over a dime) is immaterial to Eden's P&L.
  Realistic per-org triage volume (StatGate resolves most P0s deterministically, and repeat triages
  hit the result cache at `triage_agent.py:150-160`) is very likely far below the cap, making both
  numbers smaller still — but the *ratio* (fake ≈ real × ~45, per the math above — the doc's own
  numbers don't support a wider range) is the more important artifact of this bug than either
  absolute figure.
- *The `ModelRouter`-routed family* (item 9 — patch generation, critic review, RCA-linking): not
  sized in this pass — no visibility into sweep cadence or per-org call frequency for
  `improvement/sweep_budget.py::try_consume_llm_call()`. Per-call cost is very likely in the same
  sub-cent range (same DeepSeek-flash pricing), but total volume — and therefore whether it changes
  the aggregate bound below — is unknown.
- *The four newly-found call-site groups* (API-route investigate/report, `closed_loop_executor`,
  `nl_interface`'s 4 calls) have **no fake number at all** — nothing is written to the ledger for
  them, positive or negative. Their real spend (bounded by request/approval volume, likely lower
  than triage's since none of them auto-fire per-issue) is **100% invisible**, not merely
  miscounted. In relative terms that's a full write-off of whatever fraction of Cat-14's total LLM
  spend flows through `autonomous/_common.py::_call_llm` — which is the shared LLM helper for 3 of
  Eden's now-8 documented live call-site groups (`investigate`, `report`, `nl_interface` query/
  report), more than half the *count* of distinct call-site families in this file even though each
  individually is lower-volume than the judges pipeline.
- **Aggregate order-of-magnitude:** even assuming every org in a hypothetical fleet hits triage's
  $5/day cap *and* generates a comparable volume through the four newly-found paths, total real
  dollars mis-recorded (understated) across all Cat-14 `_call_llm` paths is very likely **well
  under $1/org/day** — this is a correctness bug in Eden's own telemetry, not a cost-reduction
  opportunity; the dollar amounts involved were never large enough for this bug to matter as
  spend, only as trust in the number. *(The `ModelRouter`-routed family, item 9, is excluded from
  this bound — see the bullet above; it's a different code path serving a different subsystem,
  `improvement/`'s closed loop, not Cat-14.)*

**This bug also reaches outside Eden's own COGS accounting, into `features/06-cost-governance.md`'s
territory.** The fake `$0.02` `CostEvent` triage writes
(`autonomy_policy.record_spend()` → `record_cost_event()`, `closed_loop/autonomy_policy.py:360-376`)
lands in the `customer_cost_events` table (`cost_ledger.py:279`) — one of the sources
`UsageService._sum_org_cost_usd()` sums (`usage_service.py:268-330`, docstring: "Sum monthly Eden
COGS for credits enforcement") to compute `get_budget_status()` (`usage_service.py:334`), the
figure `QuotaEnforcementMiddleware._check_hard_limits` reads to block a customer's own gateway
requests once their credits are exhausted (06's hard-enforcement path). So the fix here isn't
purely internal telemetry hygiene: it also nudges the customer-facing credit-consumption number 06
enforces against, by the same ~$0.0196/triage-call delta (fake $0.02 vs. real $0.00045), in the
direction of overcounting a customer's own spend. Small — well inside the aggregate bound above —
but genuinely customer-facing, which "immaterial to Eden's P&L" undersells; that framing is about
Eden's own cost, not the customer's credit balance.

**Fraction miscounted vs. fraction merely unverifiable (cache-field bug) — these are different
things, verified in this pass:** `llm/client.py:634-635` reads `getattr(response.usage,
"cache_reads", 0)` / `"cache_writes"` into `UsageStats` (fields at `client.py:83-84`) — attribute
names OpenRouter's `usage` object does not have, so both are always `0`. **But** `cost=
getattr(response.usage, "cost", None)` (`client.py:633`) is read correctly — verified live against
OpenRouter's usage-accounting docs (Aug 2026): `usage.cost` is described as *"the total amount
charged to your account,"* i.e. the actual post-discount billed figure, not a pre-discount list
price, and (also verified live, correcting an implicit assumption from earlier passes) OpenRouter
no longer requires an opt-in `usage: {include: true}` flag — full usage/cost data, including cache
fields, is included in every response by default as of the current docs, and Eden's request code
(`client.py`, `chat.completions.create(...)`) sets no such opt-in flag either way, which is moot
now but was worth checking. **Conclusion: the cache-field bug does not, by itself, cause any
dollar-figure miscounting** — when `org_id` is present, the `cost_usd` written to the ledger is
already the real, already-discounted number. Its actual effect is **100% loss of cache-attribution
visibility**: Eden cannot show, for any of its own calls, what fraction of that already-correct
dollar figure came from a cache hit vs. a cache miss, or produce a "cache savings" line for
reporting — even though the discount (up to ~98% per DeepSeek's own pricing) may already be fully
banked. That's a 100% opacity rate on a metric that's currently un-computed for every single Eden-
internal LLM call, not a 100% miscounting rate on dollars.

## Prompt caching: DeepSeek/OpenRouter likely already give this for free, and Eden can't see it

Phase 1 found `soft_issue_review.py`'s static system prompt gets no caching benefit from Eden's
own `cache_control` code because that code only fires `if self._is_anthropic_model(model)`
(`llm/client.py:606`), and DeepSeek isn't Anthropic. That's correct as far as it goes, but it
understates the picture:

- **DeepSeek's own API caches automatically, with no `cache_control` header needed.** DeepSeek
  ships disk-based prefix caching: identical prompt *prefixes* (e.g., a static system prompt sent
  first, every time) are billed at the cache-hit rate automatically — no SDK flag, no opt-in.
  Verified live against DeepSeek's pricing docs (Aug 2026, `api-docs.deepseek.com`): V4 Flash is
  **$0.14/1M input on a cache miss vs. $0.0028/1M on a cache hit — exactly a 98% discount**.
- **OpenRouter passes this through.** OpenRouter documents "sticky routing" that keeps repeat
  requests on the same upstream provider specifically to preserve implicit/automatic caching for
  providers that support it — DeepSeek is one of the providers explicitly called out as supporting
  this pass-through reliably (unlike some other OpenRouter-routed models where the discount does
  not survive the trip) (OpenRouter prompt-caching docs and blog, Aug 2026).
- **Eden cannot currently see whether it's getting this benefit — and the schema mismatch is more
  specific than previously documented.** Verified live against OpenRouter's own docs (Aug 2026,
  `openrouter.ai/docs/guides/best-practices/prompt-caching` and `.../use-cases/usage-accounting`):
  cache activity is reported as **`usage.prompt_tokens_details.cached_tokens`** (cache-hit tokens)
  and **`usage.prompt_tokens_details.cache_write_tokens`** (cache-write tokens) — both nested under
  the *same* `prompt_tokens_details` sub-object, not two independent flat fields — plus a separate
  **top-level `cache_discount`** field on the response body (outside `usage` entirely, not inside
  it), which Eden's `UsageStats` doesn't capture in any form today. Since `response.usage` is the
  stock `openai` SDK's `CompletionUsage` model, `getattr(response.usage, "cache_reads", 0)` and
  `getattr(response.usage, "cache_writes", 0)` (`llm/client.py:634-635`) fall through to `0` on
  every single call — confirmed dead, not merely "likely dead."
- **Precise fix** (`llm/client.py:629-635`):
  ```python
  ptd = getattr(response.usage, "prompt_tokens_details", None)
  usage = UsageStats(
      prompt_tokens=response.usage.prompt_tokens if response.usage else 0,
      completion_tokens=response.usage.completion_tokens if response.usage else 0,
      total_tokens=response.usage.total_tokens if response.usage else 0,
      cost=getattr(response.usage, "cost", None),
      cache_reads=getattr(ptd, "cached_tokens", 0) or 0,
      cache_writes=getattr(ptd, "cache_write_tokens", 0) or 0,
  )
  ```
  plus a new field (`UsageStats.cache_discount: float | None = None`, `client.py:76-84`) populated
  from `getattr(response, "cache_discount", None)` — read off `response`, not `response.usage` — to
  capture the one number OpenRouter reports that Eden currently discards entirely. This doesn't
  change spend by itself (per the blast-radius section above, `cost_usd` is already correct
  independent of this fix) — it's the prerequisite instrumentation to find out whether Eden's
  five original live call sites (esp. the judges' repeated system-prompt template and
  `soft_issue_review`'s static ~500-token prompt) are already getting a ~90%+ discount for free, or
  whether prompt structure (e.g., interpolating variable content *before* the static suffix,
  breaking the shared prefix) is accidentally defeating it.
- **Batch APIs do not fit any current call site.** Anthropic/OpenAI Batch APIs trade a ≤24h
  turnaround for a flat 50% discount (Anthropic Batches docs, Aug 2026) — but none of Eden's live
  call sites tolerate that latency: judges score events within seconds of ingestion via a
  Redis tail, triage has a 90s SLA, chat is synchronous/streaming, evolution and soft_issue_review
  are already small enough that batching's fixed integration cost wouldn't pay back. Considered and
  correctly not used anywhere in the current code — not a missed lever.
- **Semantic (application-level) caching:** the one real duplicate-work pattern found (repeated
  near-identical digest lines and `existing_block` re-sends across agents in
  `soft_issue_review._scout_novel_patterns`) was already flagged in Phase 1 and downgraded to CUT
  in the Phase 2 verdict below (absolute spend too small to matter). No new semantic-caching
  opportunity worth tracking was found across the wider call-site inventory (now 9 groups) —
  `UnifiedJudge` already collapses all axes into one call per event, and StatGate-first gating in
  `TriageAgent`/`signal_investigator.py` already prevents the LLM from ever being invoked on
  deterministically-resolvable cases, which is the highest-leverage form of "caching" (never
  calling the model at all) already implemented ahead of any request-level cache.

## `signal_investigator.py` (F06 route) — no cost, misleading name only

`investigate_trace_endpoint` (`signal_investigator.py:252-323`) is flag-gated by
`signal_investigator_llm_v1` (`config.py:1449`, default `False`) and returns a `disabled` envelope
when off. Even when explicitly turned on, per the finding above, `investigate_trace()` never calls
an LLM — `findings[*].cost_usd` will be `0.0` for every finding, so `total_cost` at L308 is always
`0`. The flag/endpoint name (`signal_investigator_llm_v1`, "F06 per-trace signal investigator LLM
path") is the only thing left that implies live LLM cost; recommend renaming or annotating the flag
to avoid a future engineer re-adding a real LLM call here under the belief they're restoring
existing behavior, when they'd actually be introducing new spend.

## Prioritized levers (highest impact first)

1. **(Process, $0 code change) Fix the scorecard/roadmap narrative around F34, RCA, and
   guardrails.** All three already yield $0 real LLM savings potential (target was already $0);
   don't let future roadmap cycles spend engineering time "optimizing" LLM cost on paths that have
   no LLM in them. Highest-impact item because it prevents misallocated effort across three
   separate features, not just one.
2. **(Small, concrete, correctness not cost) Thread `org_id`/`feature` through `_common.py`'s
   `_call_llm` → `route_async` (plus the 4 call sites in `nl_interface/query.py`) and, separately,
   through `ModelRouter.route`/`.aroute` into `self.llm_client.call(...)`; stop writing the
   synthetic `_TRIAGE_COST_ESTIMATE_USD` CostEvent once real cost flows through.** Precise diff for
   the `_call_llm` family: one 2-kwarg signature change, one call-site update inside `_call_llm`
   itself, and 6 call sites (`investigate`, `report`, `query.py` ×4) each adding `org_id=org_id,
   feature="..."` — all of which already have `org_id` in local scope. A second, smaller diff
   mirrors this for `ModelRouter`. Fixes a live recurrence of the exact "fictitious spend in the
   real ledger" bug already found fixed for the investigator, except this one drops the real
   number to zero for 6 call-site groups (not double-counted-and-real, silently discarded) instead
   of just adding a fake one, and also quietly overcounts the same org's customer-facing
   credit-consumption figure that `features/06-cost-governance.md`'s hard-enforcement path reads
   (see Blast radius section). Small dollar impact (bounded at well under $1/org/day even at each
   path's respective ceiling for the sized families), but this is Eden's own cost telemetry being
   wrong, which is the thing this audit is supposed to get right.
3. **(Small, verification-first) Fix `UsageStats.cache_reads`/`cache_writes` field names in
   `llm/client.py:634-635`** to `usage.prompt_tokens_details.{cached_tokens,cache_write_tokens}`,
   and add a new `cache_discount` field sourced from the top-level `response.cache_discount` (not
   captured today in any form). Verified in this pass that this bug is a **visibility** gap, not a
   dollar-miscounting one — `cost_usd` is already the real, post-discount figure when `org_id` is
   present — so the payoff is purely being able to report/verify a savings number that (per
   DeepSeek's confirmed ~98% cache-hit discount) may already be fully banked with zero further code
   changes.
4. **(Housekeeping) Rename/annotate `signal_investigator_llm_v1`**, and update the stale
   Anthropic/Claude-economics comment at `autonomous/agent.py:1462-1466`, so neither invites a
   costly regression or misleads about which model/cost is actually live today.
5. **(Not a P0, unchanged from Phase 1) `_scout_novel_patterns` digest/`existing_block` dedup** —
   real but already-tiny (≤~$6/month worst case); see Phase 2 verdict below (CUT — revisit only if
   volume grows).

## Confidence

High on the headline (investigator + RCA + guardrails all $0 LLM today) and on the model-collapse
claim (`model_router.py:25-39` is unambiguous) — both backed by direct source reads with exact
line citations. High on the `org_id` root-cause chain — traced all 7 hops
(`_call_llm` signature → `route_async` call → `route_async` defaults → `cost_context` → the
contextvar skip → `_log_usage` → `schedule_record_from_usage`'s guard) by direct source read, and
separately confirmed that the bug's live blast radius within the `_call_llm`/`route_async` family
is 5 call-site groups (not 3 — `_llm_rationale` is dead code with zero callers) across 3 files not
previously all named in this doc (`investigation.py`, `nl_interface/query.py`,
`intelligence_autonomous.py`, `closed_loop_executor.py`). That grep covered the `_call_llm`/
`route_async` family exhaustively but did not extend to `ModelRouter.route`/`.aroute`, a separate
code path into `llm/client.py::call()` with its own independent instance of the same bug —
bringing the total live blast radius to 6 call-site groups (see Root cause section). High on the
two corrections to Phase 3
(the $5-vs-$25 budget knob, the dead `_llm_rationale` claim) — both are direct line reads, not
inference. Medium-high on the cache-field fix, upgraded from Phase 3's "medium" — the exact schema
(`prompt_tokens_details.{cached_tokens,cache_write_tokens}`, top-level `cache_discount`, `usage.cost`
already reflecting post-discount billed amount, no opt-in required) was verified live against
current OpenRouter docs rather than cited from secondary sources; still medium on whether Eden's
actual prompts preserve a stable shared prefix in production (unmeasured against live traffic — the
whole reason the recommendation is "instrument and verify," not "assume savings already banked").
The blast-radius dollar estimate is explicitly **low-to-medium confidence by construction** — no
production call-volume telemetry exists in this repo, so it is a bounded, assumption-labeled
estimate from code constants and externally-verified per-token pricing, not a measurement; the
qualitative conclusions (fake ≈ ~45× real per triage call, per the math shown above; the
newly-found call sites have zero ledger presence rather than a wrong one; the cache-field bug is a
visibility gap with ~0 independent dollar effect) are held with higher confidence than any
absolute dollar figure. Did not
re-benchmark the digest-dedup estimate from Phase 1 (still an unmeasured structural estimate,
already downgraded to CUT in Phase 2).

## Sources (2026 LLM cost-optimization research)

- **OpenRouter usage-accounting schema (fetched live, Aug 2026):**
  [Prompt Caching - Optimize AI Model Costs with Smart Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
  (confirms `usage.prompt_tokens_details.{cached_tokens,cache_write_tokens}` and top-level
  `cache_discount`) and
  [Usage Accounting](https://openrouter.ai/docs/use-cases/usage-accounting)
  (confirms `usage.cost` is the actual post-discount billed amount, and that the `usage: {include:
  true}` opt-in is deprecated/no-op — full usage data is returned by default).
- **DeepSeek V4 Flash pricing (fetched live, Aug 2026):**
  [DeepSeek API Pricing](https://api-docs.deepseek.com/quick_start/pricing) — confirms $0.14/1M
  input (cache miss) vs. $0.0028/1M input (cache hit), a 98% discount, and $0.28/1M output.
- Anthropic Batch API (flat 50% discount, ≤24h turnaround) and prompt caching (~90% discount on
  cache reads, 1.25× write premium): summarized across multiple Aug‑2026 pricing trackers, e.g.
  [Anthropic API Pricing in 2026: Complete Guide — Models, Caching, Batch & Optimization](https://www.finout.io/blog/anthropic-api-pricing),
  [Claude Cost Optimization 2026: Batch API (50% Off) and Prompt Caching (90% Off)](https://pecollective.com/tools/claude-pricing-guide/),
  [Anthropic vs OpenAI Prompt Caching 2026: Cost Math + 3 Cache-Miss Fixes](https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/).
- OpenRouter prompt-caching pass-through and provider sticky routing (DeepSeek supported reliably;
  not all providers pass the discount through):
  [OpenRouter Prompt Caching: What Cached Tokens Cost](https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/),
  [Kimi K3's cache discount doesn't survive OpenRouter](https://www.paulsprogrammingnotes.com/2026/08/kimi-k3-cache-discount-openrouter.html).
Eden's own judge pipeline (1.2% sampling + P0/stumble bypass, multi-axis-per-call batching) already
implements the sampling/batching hygiene most cost-optimization guidance recommends; the gap that
remains is cache *visibility* (item 3 above) and ledger *attribution* (item 2 above), not cache or
sampling *strategy*.

---

## Audit history (condensed)

This doc was built across four verification passes plus a final synthesis pass; corrections are
folded into the body above rather than kept as a separate log. Net trajectory: Pass 1 established
the headline ($0 LLM cost for the investigator/RCA/guardrails) and the live call-site inventory;
Pass 2 confirmed the headline and cut an unmeasured dedup estimate as immaterial; Pass 3 added the
triage cost-ledger bug and the cache-field mismatch; Pass 4 traced the `org_id` root cause hop by
hop, corrected the affected-group count from 3 to 5 (`_llm_rationale` is dead code) and a stale
budget-knob citation ($5/day, not $25/day), and produced the bounded blast-radius estimate. This
final synthesis pass added a sixth, independently-discovered instance of the same bug in
`ModelRouter` (patch-generation/critic/RCA-linking, bringing the total to 6 call-site groups /
9 live call-site families overall), narrowed an unsupported "40-100×" ratio to the ~45× the doc's
own math actually supports, and traced the triage ledger bug's secondary effect on the
customer-facing credit-consumption figure `features/06-cost-governance.md` enforces against.
