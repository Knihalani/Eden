# Pass 4 review notes — features/10-model-gateway.md

Reviewer: A (sole reviewer, pass 4/final)

## VERIFIED

All line-number/call-graph claims below were independently re-traced against
source in this pass (not just re-read from the doc) and confirmed accurate:

- `src/eden/llmops/ai_gateway.py` structure matches doc exactly: `Provider`
  enum + `ProviderSpec`/`PROVIDER_SPECS` (lines 49, 94, 129), `CircuitBreaker`
  class at `:312`, `AIGateway` class at `:384`, `complete()` at `:630`,
  `_select_provider` at `:892`, `_select_fallback` at `:921`,
  `_execute_provider` at `:1157`, `get_metrics`/`get_provider_health` at
  `:1241`/`:1247`, `OllamaClient`/`.complete` at `:1267`/`:1307`,
  `OpenAICompatibleClient`/`.complete` at `:1340`/`:1391`,
  `AnthropicCompatibleClient`/`.complete` at `:1447`/`:1497`,
  `register_providers_from_env` at `:1579`, `register_default_providers`
  alias at `:1656` (body `:1663`). File is 1,663 lines total, matching the
  "~900 of 1,663 lines" deletion-inventory arithmetic.
- `grep -rn "register_providers_from_env\|register_default_providers"
  src/eden` returns exactly 5 hits: the two definitions, the alias's own
  pass-through call, and one docstring cross-reference at `ai_gateway.py:54`
  — confirmed zero real call sites anywhere else in the tree.
- Three `AIGateway()` instantiations confirmed exactly where cited, none
  registering providers: `src/eden/api/routes/llmops.py:42`
  (`_ai_gateway = AIGateway()`), `src/eden/api/routes/gateway.py:332`
  (`_gateway = AIGateway(semantic_cache=_get_semantic_cache())`),
  `src/eden/llmops/learn_wiring.py:49`.
- `src/eden/config.py:443-451` confirmed: `openrouter_api_key`,
  `openrouter_base_url`, `use_minimax`, `minimax_api_key`,
  `minimax_base_url` all present; `openai_api_key`/`anthropic_api_key`
  confirmed absent (grep for both returns nothing in `config.py`).
- `llmops.py`'s only two `_ai_gateway.` call sites are `get_metrics()`
  (`:612`) and `get_provider_health()` (`:622`) — confirmed via grep, no
  other method calls.
- `gateway.py`'s docstring for `get_ai_gateway()` (lines ~309-322) contains
  the quoted sentence verbatim: *"the actual provider call goes through the
  openai client above (the AIGateway's internal `ModelRequest` model is
  prompt-string-only and doesn't fit OpenAI's full request shape)."*
  `get_ai_gateway()` is called at `gateway.py:923` and `:1280` (both assign
  `gw = get_ai_gateway()`, immediately followed by `gw._filters` at `:944`
  and `:1287` respectively — doc's line citations for the "touches only
  `._filters`" claim point at the `get_ai_gateway()` call sites, which is a
  fair and accurate paraphrase), plus one direct `.cost_resolver` chain at
  `:1645`. No call to `.complete()` anywhere in `gateway.py`.
- `src/eden/optimization/model_router.py` (656 lines) fully matches the
  doc's characterization: `ModelTier` enum T1-T4 (`:16`), `TaskClassifier`
  (`:98`), `QualityValidator` (`:278`), `ModelRouter` (`:432`) wrapping
  `OpenRouterClient`. Confirmed **live and actively used** (not dead code)
  — real call sites in `src/eden/llm/internal_router.py:29,33`,
  `src/eden/patches/patch_generator.py:772-773`,
  `src/eden/patches/rca_linker.py:37`, `src/eden/improvement/test_gate.py:313`,
  `src/eden/api/routes/optimization.py:159`, `src/eden/autonomous/agent.py:1441`.
  This matches `KNOWN-SUBSYSTEMS.md:31-32`'s note that `model_router.py`'s
  `ModelRouter` "is a full internal model-routing/gateway layer (F10
  territory)" — **the doc does not make any "eden lacks a routing layer"
  claim; it correctly documents this code as existing and live.**
- `TIER_MODELS` construction (`model_router.py:31-39`) and
  `_chat_tiers_share_model()` (`:42-54`) confirmed: T1/T2/T3 all resolve to
  `internal_chat_chain()` (from `eden.llm.models`), i.e. the same model list,
  per the doc's "Soft Autonomy" claim — confirmed via the in-code comment
  "Soft Autonomy 2026-08-01: ALL Eden-owned chat tiers resolve to the single
  internal model SSOT."
- `src/eden/llm/models.py:19-20`: `INTERNAL_CHAT_MODEL` defaults to
  `"deepseek/deepseek-v4-flash-0731"` (OpenRouter/DeepInfra id) — confirmed.
  `:26`: `INTERNAL_CHAT_FALLBACKS: list[str] = []` — confirmed empty.
  `:29-31`: `internal_chat_chain()` returns `[INTERNAL_CHAT_MODEL,
  *INTERNAL_CHAT_FALLBACKS]` — confirmed.
- `src/eden/llm/client.py`: `CircuitBreaker` class at `:98`,
  `OpenRouterClient` class at `:165`, `base_url: str =
  "https://openrouter.ai/api/v1"` at `:171` — all confirmed exactly as
  cited.
- `src/eden/sdk/provider_routing.py` and
  `src/eden/services/observability/provider_routing.py` docstring quotes
  confirmed verbatim (modulo line-wrapping): *"The SDK wires the 4 decisions
  to the customer's existing provider-routing middleware (LiteLLM / Portkey
  / OpenRouter)"* (`services/observability/provider_routing.py:15-17`) and
  *"circuit-breaker logic belongs in the customer's routing middleware...
  rather than in the Eden DB"* (`:24-27`, exact text: "circuit-breaker logic
  belongs in the customer's routing middleware (where per-tenant in-process
  state is available) rather than in the Eden DB").
- `grep -rli portkey src/eden` returns exactly two files —
  `src/eden/sdk/provider_routing.py` and
  `src/eden/services/observability/provider_routing.py` — confirming the
  doc's "outside these three files returns nothing" claim (the third file,
  `api/routes/observability_provider_routing.py`, simply doesn't contain the
  literal string "portkey," which is consistent with, not contradictory to,
  the doc's phrasing).
- `sdk/python/eden_sdk/instrumentations/` confirmed to contain
  `openai.py`, `anthropic.py`, `bedrock.py`, `gemini.py`, `cohere.py`,
  `groq.py`, `mistral.py` (plus framework instrumentations not cited:
  `autogen.py`, `crewai.py`, `langchain.py`, etc.) — matches doc's
  `{openai,anthropic,bedrock,gemini,cohere,groq,mistral,...}.py` citation.
  `sdk/go` and `sdk/rust` confirmed absent from disk (matches the deleted
  status visible in `git status` and the doc's "reconfirmed... zero
  dangling references" claim).

## CUT (quote + reason)

1. **FALSE — headline factual error, high-severity.** Quote: *"Deeper
   trace: `complete()` — the one method that would exercise the dead
   path — is itself never called in production."* and *"`complete()`
   (`ai_gateway.py:630`) — the only method that exercises
   `_select_provider`/`_select_fallback`/`CircuitBreaker`/the
   provider-wrapper classes — has **zero production callers**."*
   (appears in the §1 bullet list and is restated as fact in the Phase 3
   Verdicts section: *"has zero production callers"*).

   **This is contradicted by the actual codebase.** `AIGateway.complete()`
   has two real call sites that were missed:
   - `src/eden/time_travel/replayer.py:453` — inside
     `TraceReplayer._re_execute_step()` (`:326-464`), which does
     `gw = get_ai_gateway()` then `resp = await gw.complete(req)`. This is
     the *same shared production singleton* wired in `gateway.py`, not a
     separate test instance. `TraceReplayer` is invoked from a real API
     route, `src/eden/api/routes/intelligence_time_travel.py`.
   - `src/eden/improvement/replay_verify.py:355` — inside
     `_gateway_complete()` (`:334-361`), identical pattern:
     `gw = get_ai_gateway(); ...; resp = await gw.complete(req)`. This
     module is imported by `src/eden/closed_loop/orchestrator.py`,
     `src/eden/improvement/evidence_plane.py`,
     `src/eden/improvement/issue_patch_trigger.py`, and
     `src/eden/evaluation/regression_runner.py` — all real production
     subsystems in eden's autonomous improvement/auto-merge and
     regression-evaluation loops.

   Nuance that does *not* fully rescue the doc's argument but should be
   folded in: because `_providers` is always empty (nothing calls
   `register_providers_from_env`), `_select_provider()` (`ai_gateway.py:892`)
   always returns `None`, so `complete()` always raises
   `ProviderUnavailableError` at `ai_gateway.py:674` when called from these
   two sites today. Both callers wrap the call in `try/except Exception`
   (`replayer.py:441/464`, `replay_verify.py:524-526` and `:824-826`) and
   degrade gracefully (e.g. `cannot_replay=True`), so this isn't a crashing
   bug — but it means the Time Travel "re-execute step live" feature and the
   Replay-Verify auto-merge gate's "one live gateway completion" check are
   **currently silently broken/no-op in production** (every call fails and
   falls into the except branch), which is itself a finding the doc never
   surfaces. See NEW FINDINGS below — this changes the risk profile of the
   "delete `complete()` outright" option and the doc's "no partially-working
   feature to preserve" / "low-risk" framing, since the concrete deletion
   inventory in §1 never mentions `replayer.py` or `replay_verify.py` as
   files needing an update.

2. **Redundant with `06-cost-governance.md` — should be flagged, not
   silently duplicated.** `06-cost-governance.md` §2c ("`AIGateway`
   cost-aware routing: real, but unreachable from live customer traffic")
   and its "Concrete evidence trail" (`06-cost-governance.md:589-599`)
   independently trace the exact same call graph — `AIGateway`,
   `_select_provider` (`:892`), `.complete()` (`:630-729`),
   `register_providers_from_env`-adjacent dead-path reasoning — covering
   essentially the same ground as `10-model-gateway.md` §1. This is not
   automatically wrong (cross-referencing is fine and the two docs do
   cross-link, e.g. `01-competitor-matrix.md:511` points to
   `06-cost-governance.md` for the same `AIGateway` finding), but it means a
   reader has to reconcile two independently-written trace narratives of the
   same code, and — more importantly — `06-cost-governance.md` reaches a
   **materially different framing** on the same evidence that
   `10-model-gateway.md` does not engage with at all (see NEW FINDINGS #2
   below: the "RESCOPE... cheap to reconnect" handoff).

3. **Low-value / self-referential filler**, minor: the doc carries a full
   "Phase 2 Verdicts" section (`10-model-gateway.md:63-114`) and a full
   "Phase 3 Verdicts" section (`:116-185`) that substantially restate each
   other's verdicts on the same three-plus-one recommendations (item 1
   "delete/scope `AIGateway`," item 2 "keep `/gateway/v1` honest," item 3
   "double down on `ProviderRoutingService`," item 4 "populate
   `INTERNAL_CHAT_FALLBACKS`") with only incremental deltas ("upgraded from
   Phase 2's 'either/or' framing"). This is consistent with this review's
   multi-pass audit-trail convention (seen in sibling docs too) so I'm not
   recommending deletion, but by pass 4/final, retaining two nearly
   duplicate ~50-line verdict blocks when only the Phase 3 (latest) verdict
   is actionable is filler weight a final-pass consolidation could trim —
   flagging for the doc owner's judgment call, not asserting as an error.

4. **Speculative-adjacent, but disclosed as such — not a hard cut, noting
   for completeness.** Quote: *"a risk that's higher now that prospects will
   reasonably ask 'how do you compare to Portkey/OpenRouter' given those
   names' 2026 visibility."* This is a reasonable inference from the cited
   market data (Portkey/PANW, OpenRouter Series B) but is itself
   unverifiable (no evidence any prospect has actually asked this). It's
   framed as reasoning rather than fact and doesn't materially weaken the
   recommendation, so I'm not recommending its removal — just noting it's
   the one clearly speculative sentence in an otherwise tightly
   evidence-cited document.

## USER EXPERIENCE & VALUE (full draft)

*(This section did not exist in the doc before this pass; drafted fresh per
the task brief. It intentionally does not argue eden should build a
customer-facing gateway product — consistent with the doc's own
recommendation — but describes what configuring **eden's existing,
narrower routing/fallback surfaces** actually looks like today for a
platform engineer, since that's the surface eden genuinely ships.)*

### What a platform engineer configures today

Eden does not ask a customer to point production LLM traffic through it by
default, and this doc correctly recommends it stay that way rather than
rebuild Portkey/OpenRouter-grade routing. But there are two real,
already-shipped configuration surfaces a platform engineer actually
touches:

1. **`/gateway/v1` as an opt-in single-upstream proxy.** A team that wants
   PII redaction, semantic caching, and cost/latency observability on a
   subset of traffic points that traffic at
   `https://api.edenobservability.com/gateway/v1` and either relies on the
   server-configured upstream (MiniMax or OpenRouter, chosen via
   `Settings.use_minimax`) or overrides it per request with
   `X-Upstream-Base-Url` / `X-Upstream-Api-Key` / `X-Upstream-Provider`
   headers. Concretely, this looks like: swap the base URL in an existing
   OpenAI SDK client, keep the same request/response shape, and get
   PII-filtered, cached, cost-attributed traffic for free — with zero
   provider-failover behavior, which the engineer needs to know going in
   (this doc's recommendation #2 is exactly "keep that honest," which this
   review agrees with).
2. **`ProviderRoutingService` as an observation hook over a gateway the
   customer already runs.** If the platform engineer already has
   Portkey/LiteLLM/OpenRouter in front of their own traffic (increasingly
   the default given this doc's 2026 market data — Portkey folded into
   PANW's Prisma AIRS, OpenRouter at $1.3B post-Series-B), the SDK-side
   `retry_with_fallback()` helper (`src/eden/sdk/provider_routing.py`) is an
   *opt-in convenience wrapper*, not a router replacement — the engineer's
   own gateway keeps making routing/circuit-breaker decisions, and eden
   just records what happened (`provider_routing_attempts` table) so it can
   surface failure-rate and repeated-failure dashboards correlated with
   traces.

### Why this is useful (cost, latency, reliability)

- **Cost**: `/gateway/v1`'s semantic cache and PII filter reduce redundant
  spend without the engineer having to instrument caching themselves; the
  cost-attribution layer means a team can see "$X spent, Y% cache-hit" per
  org/tenant without wiring a separate cost pipeline.
- **Latency**: because `/gateway/v1` is a thin pass-through (confirmed —
  it calls the upstream OpenAI-compatible client directly, not
  `AIGateway.complete()`'s multi-step selection/circuit-breaker machinery),
  there's no extra provider-selection latency tax on the hot path — a
  deliberate, disclosed tradeoff against the fuller routing sophistication
  of Portkey/OpenRouter.
- **Reliability**: for the "own gateway already exists" case,
  `ProviderRoutingService` gives visibility into failover events the
  engineer's existing tooling already generates, without eden owning (and
  thus becoming a second point of failure for) the failover decision
  itself — the engineering team keeps the failure domain they already
  understand and trust.

### What would make this easy to trust and adopt

For a platform engineer evaluating whether to route real production traffic
through any part of eden's gateway surface, or to configure fallbacks for
eden's own internal LLM dependency, the trust bar is the same three things
in both directions:

1. **Visibility into the actual decision made, not just the outcome.**
   Today, `get_metrics()`/`get_provider_health()` on `AIGateway`
   (`ai_gateway.py:1241`/`:1247`) exist as API surface
   (`/llmops/metrics`, `/llmops/provider-health`) but — per this pass's
   finding above — return empty data in production because nothing
   populates `self.metrics`/`self._health` outside the dead `complete()`
   path. If/when `INTERNAL_CHAT_FALLBACKS` is populated (this doc's own
   recommendation #4) or `/gateway/v1` grows any failover behavior, a
   platform engineer will want a concrete, populated "why did this request
   land on model B instead of model A" trace — provider chosen, fallback
   depth, reason (circuit open / quality threshold / latency budget) — not
   just an aggregate uptime number. That means whichever routing decision
   *is* live (today: `OpenRouterClient`'s per-agent `CircuitBreaker` at
   `client.py:98`, which powers 100% of internal traffic) needs its state
   exposed somewhere inspectable, not just logged.
2. **Config that's declarative and diffable, not buried in code.** The
   clearest existing example of what "trustworthy" looks like here is
   `INTERNAL_CHAT_FALLBACKS: list[str] = []` in `src/eden/llm/models.py` —
   a single, obviously-named list with an in-code comment explaining *why*
   it's empty ("keeps cost + behaviour predictable"). Populating it (this
   doc's recommendation #4) is a one-line, git-reviewable, git-blameable
   change — exactly the shape of change a platform engineer can approve in
   a five-minute PR review, unlike an opaque cost-weighted provider-scoring
   table.
3. **An easy, fast rollback path.** The `INTERNAL_CHAT_MODEL` docstring
   already models this well: *"Rollback: set `EDEN_INTERNAL_CHAT_MODEL` to
   the previous model id"* (`src/eden/llm/models.py:8`) — an env-var
   override with no redeploy needed. Any future fallback-chain or
   `/gateway/v1` routing config should hold to that same bar: a single
   env var or config flag that reverts to the previous, known-good
   single-upstream behavior immediately, without requiring a code
   rollback. Given the reliability data this doc surfaces (OpenRouter: 3
   outages / 8 months, no published SLA), an engineer adopting a fallback
   chain will specifically want to verify *the rollback path itself doesn't
   depend on the thing that's currently failing* — e.g. the
   `EDEN_INTERNAL_CHAT_MODEL` override should not itself route back through
   OpenRouter if OpenRouter is the thing that's down.

## NEW FINDINGS (evidence-only)

1. **`AIGateway.complete()` is not dead code — it has two real production
   call sites the doc missed, and both are currently broken/no-op as a
   side effect of the same "no providers ever registered" root cause the
   doc correctly identifies elsewhere.**
   - `src/eden/time_travel/replayer.py:453` (`gw.complete(req)` inside
     `TraceReplayer._re_execute_step`, `:326-464`), reachable from
     `src/eden/api/routes/intelligence_time_travel.py`.
   - `src/eden/improvement/replay_verify.py:355` (`gw.complete(req)`
     inside `_gateway_complete`, `:334-361`), reachable from
     `src/eden/closed_loop/orchestrator.py`,
     `src/eden/improvement/evidence_plane.py`,
     `src/eden/improvement/issue_patch_trigger.py`,
     `src/eden/evaluation/regression_runner.py`.
   - Root cause confirmed: `_select_provider` (`ai_gateway.py:892-918`)
     iterates `Provider` and skips every entry not in `self._providers`
     (`:897-898`); since `_providers` is always empty (per the doc's own
     `register_providers_from_env`-never-called finding), the loop always
     yields zero candidates and returns `None`. `complete()` then raises
     `ProviderUnavailableError` at `ai_gateway.py:674`. Both call sites
     wrap the call in broad `try/except Exception`
     (`replayer.py:441-464`, `replay_verify.py:524-526`, `:824-826`) and
     degrade gracefully rather than crash — but this means the Time Travel
     "re-execute step live" feature and the Replay-Verify gate's live
     gateway-completion check are silently non-functional in production
     today, a distinct bug from anything this doc currently documents.
   - **Actionable implication for the doc's own recommendation**: the
     "Concrete deletion inventory" (§1) should add `time_travel/replayer.py`
     and `improvement/replay_verify.py` to the list of call sites requiring
     an update if `complete()` is deleted outright (one of the two options
     the doc itself offers) — currently these two files are absent from
     that inventory entirely.

2. **`06-cost-governance.md` explicitly defers a decision to "whichever
   finding covers eden's AI-gateway product strategy" that
   `10-model-gateway.md` never picks up or rebuts.** `06-cost-governance.md`
   (`:643-653`, "Former Recommendation 2") traces the same
   `_select_provider` code and finds it "already exists, already does
   exactly this, and is already wired to `budget_service.record_usage`"
   (citing `ai_gateway.py:711-721`), then explicitly RESCOPEs its own
   recommendation to "reconnect `_select_provider`... to the live
   `/gateway/v1` request path" out of the cost-governance doc, stating: *"it
   belongs in whatever finding owns eden's AI-gateway product strategy, not
   this one... 'the plumbing exists and is cheap to reconnect if/when that
   separate decision is made.'"* `10-model-gateway.md`'s own recommendation
   #1 is a **definitive DELETE** of exactly this code
   (`_select_provider`/`_select_fallback`/`CircuitBreaker`), with no mention
   of `06-cost-governance.md`'s handoff or the "cheap to reconnect" framing
   it explicitly flags. This is a genuine cross-doc reconciliation gap: two
   docs in the same review package reach opposite implicit conclusions
   (delete vs. cheap-to-reconnect-if-decided) about the same code without
   citing each other on this specific point, even though `01-competitor-matrix.md:511`
   and `06-cost-governance.md` both cross-reference `10-model-gateway.md`
   elsewhere. Given finding #1 above (real production callers exist, though
   currently broken), the DELETE recommendation may still be the right
   call, but the doc should explicitly address why it overrides
   `06-cost-governance.md`'s "cheap to reconnect" framing rather than
   leaving the two documents silently talking past each other.
