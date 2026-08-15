# Pass 4 notes — Agent A (Fact-Verifier & Pruner) — optimizations/03-llm-cost.md

Scope of my check per assignment: ground every claim against `src/eden/optimization/`
(cost_tracker.py, cache.py, token_optimizer.py, coalescer.py, plus model_router.py and
budget_envelope.py/tool_intel for completeness), verify the doc's own citations, and prune
false/unverifiable/speculative/redundant content. Cross-checked against
`docs/specs/strategic-review-2026-08/KNOWN-SUBSYSTEMS.md`.

## Headline calibration check (does the doc wrongly claim "Eden lacks LLM cost optimization"?)

**No — the doc does not make that claim, and its scope carve-out is legitimate, not a dodge.**
The doc explicitly states (L33-37): "This is about Eden's own internal LLM spend (COGS to run
Eden's product features) — not customer cost governance/observability of *customers'* agent
spend, which is a separate feature doc's territory." I verified this carve-out against the
actual `src/eden/optimization/` package (not just taking the doc's word for it, since the doc
never cites cost_tracker.py/cache.py/token_optimizer.py/coalescer.py at all):

- `optimization/cache.py` (`ExactMatchCache`, `SemanticCache`) is wired into
  `api/routes/gateway.py` — the customer-facing OpenAI-compatible HTTP gateway
  (`gateway.py:1-13`: "Customers point their app at
  `https://api.edenobservability.com/gateway/v1`... existing AIGateway (PII, caching, circuit
  breakers, budgets) is in the path"). It is **not** wired into any of the doc's 8 internal
  call sites (`llm/client.py` never imports `ExactMatchCache`/`SemanticCache`). Confirmed via
  repo-wide grep: importers are `config.py`, `time_travel/recorder.py`, `api/routes/gateway.py`,
  `autonomous/investigation.py` (only for a `cache_bust` self-heal *invalidation* action, not
  active caching of Eden's own calls), `api/routes/llmops.py`, `llmops/ai_gateway.py`.
  → **The doc's scope decision to exclude `cache.py` is correct**: it's customer-gateway
  infrastructure, genuinely out of this doc's territory.
- `optimization/cost_tracker.py` (`CostTracker`) is wired only into
  `api/routes/optimization.py` (customer-facing `/orgs/{org_id}/optimization` monitoring API),
  `api/routes/cost.py`, and `services/usage_service.py` — again customer cost
  visibility/attribution, not Eden's internal COGS ledger (which is `llmops/cost_ledger.py`,
  the file the doc actually audits). → **Correct exclusion.**
- `optimization/token_optimizer.py` (`PromptCompressor`, `ContextWindowManager`) and
  `optimization/coalescer.py` (`RequestCoalescer`) are **dead code** — repo-wide grep (excluding
  `optimization/__init__.py`'s re-export) finds **zero** importers anywhere in `src/` or
  `tests/`. They exist, are exported in `optimization/__init__.py:22,34`, but nothing calls
  them. This is worth noting precisely *because* KNOWN-SUBSYSTEMS.md's blanket description of
  `optimization/` as "real substantive code" is true at the file-content level but not uniformly
  true at the integration level — two of the seven files it lists are unused.
- `optimization/budget_envelope.py` (`BudgetEnvelope.is_over_soft/is_over_hard`, cited in
  KNOWN-SUBSYSTEMS.md as "real budget-cap logic") has real unit tests
  (`tests/unit/optimization/test_budget_envelope.py`, `from_budget_service`/`from_cost_tracker`
  factories both tested) but, like the two above, has **no production caller** outside
  `optimization/__init__.py`'s re-export — tested but not integrated anywhere I could find.
- `optimization/tool_intel/attribution.py` is an unrelated legacy shim
  (`attribution.py:1-9`: "legacy Cat 7 entry point... delegate to
  `eden.services.tool_intel.services`") — tool-call attribution/comparison, not LLM $ cost.
  Correctly irrelevant to this doc.

**Conclusion on the meta-check**: the doc passes — it does not deny or ignore Eden's
cost-optimization infrastructure; it correctly scopes around the parts of `optimization/` that
serve the customer-facing gateway/cost-visibility product rather than Eden's own COGS, which is
exactly the boundary KNOWN-SUBSYSTEMS.md implies exists ("a separate feature doc's territory").

## VERIFIED

- **`model_router.py:25-39` (the doc's one live citation into `optimization/`) — exact and
  correct.** Read `src/eden/optimization/model_router.py:25-39` directly: `TIER_MODELS` maps
  `ModelTier.T1/T2/T3` all to `list(_INTERNAL_CHAIN)` where `_INTERNAL_CHAIN =
  internal_chat_chain()`, with the comment "Soft Autonomy 2026-08-01: ALL Eden-owned chat tiers
  resolve to the single internal model SSOT... the model id is identical across T1/T2/T3." This
  matches the doc's headline claim verbatim (doc L76-81). `ModelTier.T4` is a separate
  `"custom/fine-tuned"` placeholder, also correctly described by the doc as never an Eden
  internal chat target.
- **`chat_sota.py` imports `TIER_MODELS`/`ModelTier` from `eden.optimization.model_router`**
  (confirmed at `llmops/chat_sota.py:12`), consistent with doc L116-117's claim that
  `chat_sota.model_for_tier(ModelTier.T2)` resolves through the same collapsed `TIER_MODELS`
  dict.
- **`llm/internal_router.py` and `llm/client.py` both import from
  `eden.optimization.model_router`** (`internal_router.py:18` imports `TIER_MODELS, ModelRouter,
  ModelTier, PipelineTask`; `client.py:284` imports `TIER_MODELS, ModelTier` inside
  `_models_and_tokens_for_slot`), confirming `optimization/model_router.py` is genuinely the
  single source of truth for tier→model resolution across the internal call sites the doc
  audits — the doc's implicit treatment of `optimization/model_router.py` as foundational
  infrastructure (not a separate/ignorable subsystem) is correct.
- File-line citations for `optimization/__init__.py`'s docstring ("Eden Cost Optimization Layer
  (Phase 6.1)... Intelligent model routing... Multi-layer caching... Token optimization...
  Request coalescing... Granular cost tracking") — read directly, confirmed this is an
  accurate table of contents for the package, and none of it contradicts the doc's framing.

## CUT (or correct)

- **Quote (Confidence section, doc L470-473):** *"High on the `org_id` root-cause chain in this
  pass — traced all 7 hops... and separately confirmed, by grepping every reference repo-wide,
  that the bug's live blast radius is 5 call-site groups (not 3...)."*
  **Reason to cut/correct: this "grepped every reference repo-wide" claim is not true — there is
  a sixth, structurally distinct instance of the exact same org_id-drop bug the doc never found,
  in `eden/optimization/model_router.py`'s `ModelRouter.route()`/`aroute()`, reached via
  `patches/patch_generator.py` and `patches/rca_linker.py` (both real, wired, LLM-cost-bearing
  call sites — see NEW FINDINGS below).** The doc's repo-wide grep evidently only followed the
  `autonomous/_common.py::_call_llm` → `route_async` chain; it never traced callers of
  `ModelRouter.aroute`/`.route`, which is a separate code path into `llm/client.py::call()` that
  bypasses `internal_router.py`/`cost_context` entirely. "5 call-site groups" and "grepped every
  reference" should be softened to reflect that the audit covered the `_call_llm`/`route_async`
  family exhaustively but not the `ModelRouter.aroute`/`.route` family, which has its own,
  independent instance of the bug.
- **No other quotes tied to `optimization/*.py` warrant cutting** — the doc's only direct
  citation into that directory (`model_router.py:25-39`) is accurate, and its decision not to
  cite `cost_tracker.py`/`cache.py`/`token_optimizer.py`/`coalescer.py`/`budget_envelope.py` is
  correct (see meta-check above), so there's no false/speculative claim about those files to
  prune — the gap is an *omission* (a missing call-site family), not a wrong claim about a cited
  file. I did not find redundant/filler text specifically attributable to `optimization/`
  coverage; the file's other sections (RCA, guardrails, judges, triage, chat copilot) are outside
  my assigned grounding scope and I did not re-verify them beyond the spot checks above.

## NEW FINDINGS

1. **A sixth, independent instance of the org_id cost-attribution bug, in
   `eden/optimization/model_router.py`'s `ModelRouter`, affecting Eden's autonomous
   patch-generation pipeline — entirely missing from the doc's inventory and blast-radius
   count.**
   - `ModelRouter.aroute()` (`optimization/model_router.py:538-546`) accepts `org_id: str | None
     = None` as a keyword parameter but **never uses it** anywhere in the method body
     (`model_router.py:552-613`) — not forwarded to `self.llm_client.call(...)`
     (`model_router.py:578-585`, no `org_id=`/`feature=` kwarg), not bound into any
     `cost_context`. `ModelRouter.route()` (sync, `model_router.py:461-538`) doesn't even accept
     `org_id` as a parameter at all. Grepped the whole file for `org_id` usage
     (`grep -n "task\.org_id\|cost_context\|\.org_id\b" model_router.py`): **zero matches** —
     the `PipelineTask.org_id` dataclass field (`model_router.py:70`) and `aroute`'s `org_id`
     kwarg are both write-only/dead.
   - Both `route()`/`aroute()` call `self.llm_client.call(...)` (sync `OpenRouterClient.call`,
     `llm/client.py:375-388`), which after a successful response calls `self._log_usage(response)`
     (`client.py:457`). `_log_usage` (`client.py:652-668`) calls
     `schedule_record_from_usage(model=..., prompt_tokens=..., ..., cost_usd=...)` with **no
     `org_id=`/`feature=` kwarg** — identical pattern to the async path the doc traced
     (`client.py:652-668`, already cited by the doc for the `_call_llm`/`route_async` chain at
     doc L198-201). Since `ModelRouter` never establishes `cost_context(org_id, ...)`,
     `schedule_record_from_usage`'s `oid = org_id or ctx.get("org_id"); if not oid: return`
     guard (`llmops/cost_ledger.py:187-201`, already cited by the doc) silently drops the real
     cost the same way, for every call routed through `ModelRouter`.
   - **This is a live, wired call path, not a hypothetical one.** `ModelRouter()` is
     instantiated and `router.aroute(...)` is called in:
     - `patches/patch_generator.py:963-967` — the main patch-generation LLM call (`slot=
       "reasoning"`, i.e. T2, resolving to the same DeepSeek flash model per Soft Autonomy),
       `org_id=org_id` *is* passed here — but it's a no-op since `aroute` discards it.
     - `patches/patch_generator.py:772-773,884` (`_router = ModelRouter()`) and
       `patch_generator.py:575` (critic review call, `slot="fast"`/T1) — critic call passes no
       `org_id` at all, compounding the same drop.
     - `patches/rca_linker.py:186-211` (`aroute` call for RCA-to-code linking).
   - `PatchGenerator` is constructed in `improvement/issue_patch_trigger.py`,
     `improvement/guardian.py`, `improvement/approve.py`, and `llmops/promotion_hooks.py` — this
     is KNOWN-SUBSYSTEMS.md's `improvement/` closed loop ("full autonomous
     issue→patch→test→auto-merge→auto-revert-on-regression"), which is **enabled by default**
     (`config.py:320`, `improvement_schedule_enabled: bool = True`), gated per-call by
     `improvement/sweep_budget.py::try_consume_llm_call()` (fails closed if a budget wasn't
     armed — a real ceiling exists, but it doesn't affect the cost-ledger bug).
   - **Net: the doc's "5 live call-site groups" affected by the org_id bug (doc L245-248,
     confidence section L473) should be 6+**, and its blast-radius dollar estimate (doc
     L292-336) doesn't account for patch-generation/critic/RCA-linking spend at all. This is a
     second, real, non-zero LLM-cost line item (autonomous patch generation, same DeepSeek flash
     pricing per the doc's own `_chat_tiers_share_model()`/`TIER_MODELS` logic) that both (a)
     should have appeared in the "Live LLM call sites" inventory (doc's numbered list 1-8) as a
     9th family, and (b) has its own independent cost-ledger silent-drop bug that needs its own
     fix (thread `org_id`/`feature` through `ModelRouter.route`/`.aroute` into
     `self.llm_client.call(...)`, mirroring the fix already specced for `_call_llm`).
   - I did not attempt a dollar estimate for this call site (no visibility into sweep frequency/
     `try_consume_llm_call` ceilings in this pass) — flagging for Agent B / synthesis to size,
     since precise blast-radius sizing is explicitly Agent B's remit this pass.

2. **`token_optimizer.py` (`PromptCompressor`, `ContextWindowManager`) and `coalescer.py`
   (`RequestCoalescer`) are dead code** — zero callers anywhere outside
   `optimization/__init__.py`'s re-export, confirmed by repo-wide grep across `src/` and
   `tests/`. Not currently referenced by the doc (correctly out of scope for this doc's COGS
   focus), but worth a one-line mention if a future pass audits `optimization/` itself as a
   product surface — two of its seven advertised capabilities ("Token optimization," "Request
   coalescing" per `optimization/__init__.py:1-9`) don't run anywhere.

3. **`budget_envelope.py`'s `BudgetEnvelope` is tested but has no production caller** outside
   `optimization/__init__.py` (unit tests exist and pass conceptually —
   `tests/unit/optimization/test_budget_envelope.py` exercises `from_budget_service`/
   `from_cost_tracker` — but nothing in `src/eden/` outside the package itself constructs a
   `BudgetEnvelope`). Same caveat as #2: not this doc's territory, but relevant if
   KNOWN-SUBSYSTEMS.md's "real budget-cap logic (F6 territory)" framing is used elsewhere to
   imply it's live/enforcing budgets today — it isn't wired to an enforcement path I could find.

## Confidence

High on all `VERIFIED` items (direct source reads, exact line matches). High on finding #1 (the
`ModelRouter.aroute`/`.route` org_id drop) — read the full method bodies
(`model_router.py:461-654`), grepped for any `org_id` usage inside the file (zero hits besides
the two dead parameters), and confirmed live callers via grep + read of call sites in
`patch_generator.py`/`rca_linker.py`/`improvement/issue_patch_trigger.py`/`config.py:320`.
Medium on the *materiality* of finding #1 (didn't size dollar impact — no visibility into sweep
cadence/org count in this pass, and that's explicitly Agent B's job this pass, not mine). High
on findings #2/#3 (repo-wide grep is a strong negative signal for "zero callers," though I can't
rule out dynamic/reflective invocation I wouldn't catch with grep).
