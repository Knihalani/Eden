# F10 — Model/Provider Gateway & Routing

## Competitor landscape (2026: a consolidating, well-capitalized category)

LLM gateways sit *in front of* provider calls and add automatic failover, load balancing, and unified cross-provider observability as a byproduct of owning the request path. As of mid-2026 this category is no longer scrappy open-source tooling — it has consolidated around three well-funded (or acquired) leaders, which materially raises the bar for anyone considering building a competing gateway product:

- **Portkey** — unified API to 1,600+ LLMs across 250+ providers. Automatic fallback on failed requests (configurable trigger errors) with exponential-backoff retries; load balancing distributes traffic across providers/keys with weights and is composable with conditional routing; sticky sessions via a two-tier (in-memory + Redis) cache for multi-instance deployments; 40+ observability metrics (cost, quality, latency) plus full request/response logging. Fully open-sourced (including governance/observability/auth) as of March 2026, and the gateway itself runs in the critical path of production systems at large scale — 1T+ tokens and 120M+ requests/day, $180M+ in annualized LLM spend under management, 24,000+ organizations. **Palo Alto Networks completed its acquisition of Portkey in May 2026**, folding it into the Prisma AIRS platform as "the central control plane" for monitoring, routing, and securing enterprise AI-agent traffic — i.e. the market's leading observability-forward gateway is now owned by a $100B+ cybersecurity company and reframed as agent-security infrastructure, not a standalone dev tool.
  [Load Balancing — Portkey Docs](https://portkey.ai/docs/product/ai-gateway/load-balancing) · [Portkey-AI/gateway (GitHub)](https://github.com/Portkey-AI/gateway) · [Palo Alto Networks Completes Acquisition of Portkey to Secure AI Agents](https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-portkey-to-secure-ai-agents) · [Securing and Governing AI Agents At Scale Through A Unified AI Gateway](https://www.paloaltonetworks.com/blog/2026/05/securing-and-governing-ai-agents-at-scale-through-a-unified-ai-gateway/)

- **OpenRouter** — default behavior *load-balances every request* across the providers serving a given model: filters out providers with recent outages, then weights remaining candidates by the inverse square of price (strongly favoring the cheapest stable option), with the rest kept as ordered fallbacks. Two distinct resilience layers: **provider failover** (same model, different backend) and **model fallback** (`models: [...]` array). One OpenAI-compatible endpoint in front of 400+ models / 60+ providers, 8M+ users, weekly token volume up 5x (5T→25T) over a six-month stretch in early 2026. Raised a **$113M Series B in May 2026 led by Google's CapitalG** (with NVIDIA, ServiceNow, MongoDB, Snowflake, and Databricks venture arms also participating), taking its valuation to roughly **$1.3B** — more than double its valuation from eleven months prior — explicitly to expand "routing, governance and optimization capabilities."
  [Provider Routing docs](https://openrouter.ai/docs/guides/routing/provider-selection) · [How OpenRouter Model Routing Works](https://openrouter.ai/blog/insights/model-routing/) · [OpenRouter more than doubles valuation to $1.3B in a year (TechCrunch)](https://techcrunch.com/2026/05/26/openrouter-more-than-doubles-valuation-to-1-3b-in-a-year/) · [OpenRouter raises $113M to bring order to enterprise AI inference routing (SiliconANGLE)](https://siliconangle.com/2026/05/26/openrouter-raises-113m-bring-order-enterprise-ai-inference-routing/)

- **LiteLLM** (Berri AI) — open-source, self-hosted OpenAI-compatible proxy/SDK in front of 140+ providers / ~1,900 models; router supports retries, cooldowns, and weighted/latency-based load balancing across deployments. Remains the most widely deployed *self-hosted* option (40K–53K GitHub stars depending on source) for teams that want zero vendor lock-in and are willing to own the ops burden (Postgres/Redis, upgrades, on-call); Enterprise tier adds SSO/RBAC/audit logs from ~$250/mo up to ~$30K/yr for premium support.
  [Router docs](https://docs.litellm.ai/docs/routing) · [Routing & Load Balancing](https://docs.litellm.ai/docs/routing-load-balancing) · [BerriAI/litellm (GitHub)](https://github.com/BerriAI/litellm) · [LiteLLM Pricing 2026: Open-Source & Enterprise Cost Breakdown](https://www.truefoundry.com/blog/litellm-pricing-guide)

Common thread: all three are *proxy/routing products first* — a single endpoint owns every outbound LLM call, decides which provider/model serves it, and observability (cost/latency/quality dashboards attributed per-provider) falls out of that ownership for free. None of them is primarily a debugging/RCA tool; they compete on reliability infrastructure (uptime, rate-limit absorption, spend control, and — post-Portkey/PANW — agent security/governance), not on diagnosing *why* an agent misbehaved. The category has also gotten more expensive to enter credibly since the original review: Portkey's acquisition by a major security vendor and OpenRouter's $1.3B raise both signal enterprise buyers increasingly expect gateway vendors to also own governance/compliance/SLA guarantees, which is capital- and headcount-intensive infrastructure work orthogonal to eden's actual differentiation.

## Eden's current model (Python backend + SDKs)

Eden is **not a gateway that customer LLM traffic is expected to flow through by default** — the platform's default posture is: the customer calls OpenAI/Anthropic/Bedrock/Gemini SDKs directly, and Eden's `eden_sdk` instrumentation wraps those calls passively to emit trace events (`sdk/python/eden_sdk/instrumentations/{openai,anthropic,bedrock,gemini,cohere,groq,mistral,...}.py`; ingestion-side decoders at `src/eden/observability/ingestion/providers.py` normalize OpenAI/Anthropic/Bedrock/Gemini payloads into a common `TelemetryEvent`). This is the primary, load-bearing path.

However, the codebase does contain real gateway-shaped infrastructure that a strategic review should not miss, and it splits into three distinct, differently-mature pieces:

1. **`eden.llmops.ai_gateway.AIGateway`** (`src/eden/llmops/ai_gateway.py`) is a genuine multi-provider routing engine: a `Provider` enum (openai, openrouter, minimax, anthropic, ollama, ollama_cloud, vllm, lmstudio, llamacpp, self_hosted) with a `PROVIDER_SPECS` table of cost/quality/latency/reliability per provider, a per-provider `CircuitBreaker` (`class CircuitBreaker`, line 312), cost-based provider selection (`_select_provider`, line 892) and automatic fallback across up to 3 additional providers on failure (`_select_fallback`, line 921; `complete()`, line 630), plus semantic/exact caching and budget enforcement. This is architecturally comparable to what Portkey/LiteLLM do.
   - **But it is confirmed dormant in production.** `register_providers_from_env()` (`def register_providers_from_env`, line 1579) — the only function that populates `AIGateway._providers` from cloud API keys / local servers — has **zero call sites** anywhere in `src/eden` outside its own definition and its own docstring/alias reference. Its backward-compatible alias `register_default_providers` (line 1656) is likewise never called. `grep -rn "register_providers_from_env\|register_default_providers" src/eden` returns only: the definition (1579), one docstring cross-reference (line 54, in a module docstring explaining what the function *would* do), the alias definition (1656) and its one-line body calling through to the real function (1663). No route handler, worker, startup hook, CLI entry point, or test fixture calls either name.
   - There are **three live `AIGateway()` instantiations** in the codebase — `src/eden/api/routes/llmops.py:42` (`_ai_gateway = AIGateway()`), `src/eden/api/routes/gateway.py:332` (`_gateway = AIGateway(semantic_cache=_get_semantic_cache())`), and a defensive fallback constructor inside `src/eden/llmops/learn_wiring.py:49` (used only if an import of the shared `_ai_gateway` singleton fails) — and **none of the three calls `register_providers_from_env`/`register_default_providers`**. All three start with an empty `_providers` dict and nothing else in the call graph registers a provider.
   - `Settings` (`src/eden/config.py`) confirms the same story from the config side: it declares `openrouter_api_key`/`openrouter_base_url` (lines 443–444) and a MiniMax upstream (`use_minimax`, `minimax_api_key`, `minimax_base_url`, lines 449–451) but has **no `openai_api_key`/`anthropic_api_key` fields** — i.e. there is no config surface for the customer-facing multi-provider deployment `register_providers_from_env` would need. So the cost-aware selection + circuit-breaker + fallback loop, while fully implemented and unit-testable, has no live multi-provider population to route across, by construction, not by oversight.
   - **`gateway.py`/`llmops.py` never call `.complete()` — but two other production paths do, and both currently fail silently.** `grep -n "_ai_gateway\." src/eden/api/routes/llmops.py` returns exactly two call sites, `get_metrics()` (line 612) and `get_provider_health()` (line 622); `grep -n "get_ai_gateway()\." src/eden/api/routes/gateway.py` shows the gateway route only ever touches `._filters` (lines 923, 1280) and `.cost_resolver` (line 1645) — neither invokes `.complete()`. And because `get_metrics()`/`get_provider_health()` read `self.metrics`/`self._health` (`ai_gateway.py:1241-1248`), which are populated **only** inside `complete()`/`_execute_provider`, the two "live" endpoints in `llmops.py` that expose them (`/llmops/metrics`, `/llmops/provider-health`) return **empty lists in production today**. However, `.complete()` itself is *not* zero-caller: `src/eden/time_travel/replayer.py:453` (inside `TraceReplayer._re_execute_step`, `:326-464`, reachable from `src/eden/api/routes/intelligence_time_travel.py`) and `src/eden/improvement/replay_verify.py:355` (inside `_gateway_complete`, `:334-361`, imported by `closed_loop/orchestrator.py`, `improvement/evidence_plane.py`, `improvement/issue_patch_trigger.py`, `evaluation/regression_runner.py`) both do `gw = get_ai_gateway(); ... await gw.complete(req)` against the same shared production singleton wired in `gateway.py`. Because `_select_provider` (`:892`) always returns `None` against an always-empty `_providers`, `complete()` always raises `ProviderUnavailableError` (`:674`) at both call sites — both wrap it in broad `try/except Exception` and degrade gracefully (`replayer.py:441-464`, `replay_verify.py:524-526`/`824-826`), so this isn't a crash, but it does mean Time Travel's "re-execute step live" and the Replay-Verify auto-merge gate's "live gateway completion" check are **silently non-functional in production today** — a distinct, previously-undocumented bug, and a second, functionally-broken activation surface for this dead routing path beyond the `llmops.py` metrics endpoints.
   - **Concrete deletion inventory** (what "fully delete `AIGateway`'s dead call graph" means file-by-file):
     - `src/eden/llmops/ai_gateway.py` — delete `class CircuitBreaker` (line 312), `class ProviderSpec` + the `PROVIDER_SPECS` table (lines 94–233, consumed only by `_select_provider`/`_select_fallback`), `_select_provider` (892), `_select_fallback` (921), `_execute_provider` (1157), the three provider-wrapper classes `OllamaClient` (1267, `.complete` at 1307), `OpenAICompatibleClient` (1340, `.complete` at 1391), `AnthropicCompatibleClient` (1447, `.complete` at 1497), `register_providers_from_env` (1579) and its alias `register_default_providers` (1656) — roughly 900 of the file's 1,663 lines. Delete `complete()` (630) outright rather than trim it, since (per the two real call sites traced above) it currently only ever raises; `get_metrics`/`get_provider_health` (1241/1247) should be deleted or repointed at real data, not left returning empty lists.
     - `src/eden/api/routes/llmops.py` — remove the `get_metrics`/`get_provider_health` route handlers (lines 612, 622) or replace their data source, since they'd otherwise call methods on a class that no longer tracks that state at all.
     - `src/eden/api/routes/gateway.py`, `src/eden/llmops/learn_wiring.py`, `src/eden/llmops/__init__.py` (lazy `"AIGateway": "ai_gateway"` mapping, line 48) — **no change needed**: all three exercise only the surviving filters/cache/cost_resolver surface, not the deleted routing internals.
     - **`src/eden/time_travel/replayer.py` and `src/eden/improvement/replay_verify.py` — do require a change, and are the one place the "no change needed" framing above does not extend to.** Both currently call `gw.complete(req)` against the real production `AIGateway` singleton (`replayer.py:453`, `replay_verify.py:355`); deleting `complete()` outright turns their existing `try/except Exception` fallback (already the only code path that ever executes today, since `complete()` always raises) into an `AttributeError` unless the call sites are updated first. Since both already silently no-op today, the lowest-risk fix is to replace `gw.complete(req)` with a direct call to eden's actual live internal model client, `eden.llm.client.OpenRouterClient` (already used for 100% of other internal LLM traffic, see below) — or, if "live re-execution"/"live gateway completion" isn't worth wiring up right now, explicitly mark both as not-yet-implemented (`cannot_replay=True` / skip) rather than leave them silently calling a deleted method.
     - Tests — **delete outright**: `tests/unit/llmops/test_ai_gateway_providers.py` (tests `register_providers_from_env`/`register_default_providers`/`_select_provider`/`_select_fallback`/`CircuitBreaker` directly) and `tests/unit/llmops/test_ai_gateway_ollama.py` (tests `register_default_providers` wiring `OllamaClient`) — both test only the code being deleted. **Rewrite the fallback-depth assertions in** `tests/api/test_session22_p16_p20.py` (its "P-19" block explicitly tests `AIGateway.complete` walking multiple fallback providers). **Adapt (construction still works, drop provider-registration setup if present)**: `tests/unit/llmops/test_ai_gateway_filters.py`, `tests/unit/llmops/test_pricing.py`, `tests/unit/llmops/conftest.py` (the `gateway()` fixture already constructs a bare, provider-free `AIGateway()`), `tests/unit/test_gateway_semantic_cache_wiring.py`, `tests/unit/llmops/test_cost_resolver.py`, `tests/unit/llmops/test_session14_dl11_dl15.py`. **No change needed**: `tests/unit/test_wave6_medium_features.py` and `tests/unit/api/test_wave3_wiring.py` only reference `AIGateway` via mocks/docstrings, not the deleted internals.
     - Comment/docstring-only references requiring no functional change (cosmetic cleanup only, confirmed via `grep -n AIGateway` per file — none contain an actual `import` of the deleted symbols): `src/eden/config.py:227`, `src/eden/time_travel/recorder.py`, `src/eden/time_travel/__init__.py`, `src/eden/api/routes/intelligence_time_travel.py` (its own reference is docstring-only even though its sibling `replayer.py` is not), `src/eden/llmops/{pricing.py,openai_adapter.py,filters/__init__.py,filters/pii.py}`.
     - `src/eden/llmops/semantic_cache.py` (`class SemanticCache`) and `src/eden/llmops/filters/{base,book,guardrail,nudge,pii,prompt_deploy,trajectory}.py` (the `FilterRegistry` machinery) are **already standalone modules** — `AIGateway.__init__` just orchestrates them, it doesn't own their logic — confirming the "slim the class down to filters+cache+cost-attribution" plan is a clean subtraction, not a rewrite: `complete()`'s own step ordering (filter chain → exact cache → semantic cache → budget check → *[deleted: provider selection/fallback]*) shows the routing steps are already the last, separable stage of the pipeline, not entangled with the surviving steps.
   - **Bottom line: still delete, but it's a ~900-line subtraction plus two production call-site fixes, not a pure no-op removal.** `gateway.py` and `learn_wiring.py` already avoid the routing internals entirely, and the `llmops.py` metrics/health endpoints already return empty data in production either way — those parts really are risk-free. But `replayer.py`/`replay_verify.py` are real (if currently always-failing) production callers of `complete()`, so "no partially-working feature to preserve" overstates it slightly: there are two silently-broken features (Time Travel live re-execution, Replay-Verify's live gateway-completion check) whose `except`-branch fallback behavior would need to become their primary, intentional behavior rather than an accidental side effect of a routing bug.
   - **Reconciling with `06-cost-governance.md`'s "cheap to reconnect" framing.** `06-cost-governance.md` traces the same `_select_provider`/`.complete()` code, finds it "already wired to `budget_service.record_usage`," and explicitly hands the build-vs-delete call to "whatever finding owns eden's AI-gateway product strategy" (i.e., this doc), noting the plumbing is "cheap to reconnect if/when that separate decision is made." Having now traced the two real call sites above, that decision is still **delete, not reconnect** — for a reason specific to this doc's competitor-landscape analysis, not a technical one: "reconnecting" `_select_provider` would mean building real multi-provider credential/config plumbing (`Settings` has no `openai_api_key`/`anthropic_api_key` to reconnect *to* — see above) in order to compete with a $1.3B OpenRouter and a PANW-owned Portkey on customer-facing routing, which this doc recommends against on market grounds. The two internal callers that motivated "cheap to reconnect" don't actually need multi-provider selection at all — they need *a* working model call, which `eden.llm.client.OpenRouterClient` (see below) already provides for every other piece of internal eden traffic. So: delete the multi-provider routing engine per this doc's recommendation, and separately re-point `replayer.py`/`replay_verify.py` at the already-live single-provider client rather than resurrect the dead one.

2. **`/gateway/v1/*`** (`src/eden/api/routes/gateway.py`) is a real, customer-facing OpenAI-compatible HTTP proxy ("Customers point their app at `https://api.edenobservability.com/gateway/v1`"). It supports per-request upstream overrides via `X-Upstream-Base-Url` / `X-Upstream-Api-Key` / `X-Upstream-Provider` headers, and falls back to the server-configured single upstream (MiniMax if `use_minimax`, else OpenRouter) when headers are absent. Critically, its own code comment is explicit that it does **not** use `AIGateway`'s smart routing for the actual model call: *"the actual provider call goes through the openai client above (the AIGateway's internal `ModelRequest` model is prompt-string-only and doesn't fit OpenAI's full request shape)"* (`get_ai_gateway()` docstring, line ~310, `src/eden/api/routes/gateway.py:309-312`). `AIGateway` is wired in only for PII filtering, nudge/guardrail filters, semantic caching, and metrics — not for provider selection or failover. So today `/gateway/v1` is a single-upstream pass-through with observability/safety add-ons, not a multi-provider failover router, per request.

3. **`eden.sdk.provider_routing` / `ProviderRoutingService`** (`src/eden/sdk/provider_routing.py`, `src/eden/services/observability/provider_routing.py`, `src/eden/api/routes/observability_provider_routing.py`) is explicitly an **observation layer over the customer's own gateway**, not a router. Its own docstrings say it: "wires the 4 decisions to the customer's existing provider-routing middleware (LiteLLM / Portkey / OpenRouter)" and "circuit-breaker logic belongs in the customer's routing middleware... rather than in the Eden DB." It records routing attempts (`provider_routing_attempts` table) — success/fallback/retry/abort — that the *customer's* LiteLLM/Portkey/OpenRouter setup already made, purely so Eden can display failure-rate/repeated-failure dashboards and correlate them with traces. `retry_with_fallback()` is offered as an opt-in convenience helper for customers with no gateway of their own, but it's a thin best-effort SDK wrapper, not a production routing engine (no cost-based selection, no weighted load balancing, no persistent circuit-breaker state — deliberately left to "the customer's routing middleware"). `grep -rli portkey src/eden` outside these three files returns **nothing** — confirming Portkey is purely something eden *observes* customers using, never something eden itself calls.

Also relevant: **`eden.optimization.model_router.ModelRouter`** (`src/eden/optimization/model_router.py`) and **`eden.llm.internal_router`** are tier-based routers (T1–T4) but exclusively for **Eden's own internal agent traffic** (patch generation, critics, chat sidebar) — not customer LLM calls. As of the "Soft Autonomy" change noted in-code, T1/T2/T3 all resolve to the same single internal model (`INTERNAL_CHAT_MODEL`, a DeepSeek model via OpenRouter), so even this internal router currently has no cross-provider diversity to route across. **This closes off, rather than opens, the "internal-only activation surface for `AIGateway`" idea floated in the prior pass**: tracing the actual call path shows eden's internal LLM traffic doesn't go anywhere near `AIGateway` at all. `src/eden/llm/models.py` is the single source of truth — `INTERNAL_CHAT_MODEL = "deepseek/deepseek-v4-flash-0731"` (an OpenRouter/DeepInfra model id), used by every internal chat/completion call (triage, annotator, patch generation, AI Insights, novelty review, nudge authoring, compile-signal, playground slots per its own module docstring) — and the actual HTTP calls go through **`eden.llm.client.OpenRouterClient`** (`src/eden/llm/client.py:165`), a completely separate, already-live client with its **own** `CircuitBreaker` (`client.py:98`, per-agent, independent of `AIGateway`'s), retries, and cost tracking, hitting `https://openrouter.ai/api/v1` directly (`client.py:171`). So eden already has *two* parallel circuit-breaker/routing implementations: one dead (`AIGateway`, hypothetically for customer-facing multi-provider), one live (`OpenRouterClient`, powering 100% of internal traffic). Wiring the dead `AIGateway` routing path up for internal use would mean building a second, redundant circuit-breaker/failover system next to one that's already shipped and running — there is no real activation surface here, dormant or otherwise.

## User Experience & Value

This doc's recommendation is explicitly *not* to build a customer-facing
multi-provider gateway product — so "who's the user and what's the UX" isn't
about a Portkey/OpenRouter competitor. It's about the two narrower,
already-shipped surfaces above (`/gateway/v1`, `ProviderRoutingService`) plus
eden's own internal routing config, all of which are config/API-only today —
there is no gateway or routing UI anywhere in the eden portal.

**Who the user is.** A platform/infra engineer at a customer org (not a
data scientist or app developer) who owns LLM spend/reliability and is
deciding either (a) whether to point some traffic at `/gateway/v1` for
PII redaction, caching, and cost attribution, or (b) how to correlate their
own Portkey/LiteLLM/OpenRouter failover events with eden's traces. Separately,
an eden engineer/SRE is the "user" of eden's own internal-routing config
(`INTERNAL_CHAT_FALLBACKS`).

**What the actual flow looks like today.**
1. *`/gateway/v1` as an opt-in single-upstream proxy* — a team wanting PII
   redaction, semantic caching, and cost/latency observability on a subset of
   traffic points that traffic at `https://api.edenobservability.com/gateway/v1`,
   either relying on the server-configured upstream (MiniMax or OpenRouter,
   via `Settings.use_minimax`) or overriding it per request with
   `X-Upstream-Base-Url` / `X-Upstream-Api-Key` / `X-Upstream-Provider`
   headers. Concretely: swap the base URL in an existing OpenAI SDK client,
   keep the same request/response shape, get PII-filtered, cached,
   cost-attributed traffic — with zero provider-failover behavior, which the
   engineer needs to know going in (this doc's recommendation #2, "keep that
   honest," is exactly about setting that expectation correctly).
2. *`ProviderRoutingService` as an observation hook over a gateway the
   customer already runs* — if the platform engineer already has
   Portkey/LiteLLM/OpenRouter in front of their own traffic (an increasingly
   likely default given the 2026 market data above), the SDK-side
   `retry_with_fallback()` helper (`src/eden/sdk/provider_routing.py`) is an
   opt-in convenience wrapper, not a router replacement — the customer's own
   gateway keeps making routing/circuit-breaker decisions, and eden just
   records what happened (`provider_routing_attempts` table) so it can
   surface failure-rate and repeated-failure dashboards correlated with
   traces.

**Why this is useful.**
- *Cost*: `/gateway/v1`'s semantic cache and PII filter reduce redundant
  spend without the engineer instrumenting caching themselves; per-org/tenant
  cost attribution comes for free instead of requiring a separate pipeline.
- *Latency*: `/gateway/v1` is a thin pass-through (it calls the upstream
  OpenAI-compatible client directly, not `AIGateway.complete()`'s multi-step
  selection machinery), so there's no extra provider-selection latency tax on
  the hot path — a deliberate, disclosed tradeoff against Portkey/OpenRouter's
  fuller routing sophistication.
- *Reliability*: for the "customer already has a gateway" case,
  `ProviderRoutingService` gives visibility into failover events the
  customer's existing tooling already generates, without eden owning (and
  thus becoming a second point of failure for) the failover decision itself.

**Usability/adoption gaps.**
- **No UI at all — this is config/API-only.** There's no portal screen to
  toggle `/gateway/v1` upstream, set per-request override headers, view which
  upstream is currently active, or browse `provider_routing_attempts`
  failover events visually; a customer has to read API/SDK docs and set HTTP
  headers or call `retry_with_fallback()` directly. For a platform engineer
  evaluating adoption, that's a real friction point relative to Portkey/
  OpenRouter's dashboards.
- **The one piece of "visibility into the decision" that does exist as API
  surface is broken.** `get_metrics()`/`get_provider_health()` on `AIGateway`
  (`ai_gateway.py:1241`/`1247`) back `/llmops/metrics` and
  `/llmops/provider-health`, but — per the corrected finding above — return
  empty data in production because nothing populates `self.metrics`/
  `self._health` outside the dead `complete()` path. Any customer who
  discovers and calls these endpoints today gets an empty response with no
  indication why; that's an adoption trap the doc's deletion recommendation
  directly fixes (either endpoint goes away or gets repointed at real data).
- **Config that's declarative and diffable, not buried in code, builds
  trust.** The clearest existing example of "trustworthy" is
  `INTERNAL_CHAT_FALLBACKS: list[str] = []` in `src/eden/llm/models.py` — a
  single, obviously-named list with an in-code comment explaining *why* it's
  empty ("keeps cost + behaviour predictable"). Populating it (recommendation
  #4 above) is a one-line, git-reviewable change — the shape of change a
  platform engineer can approve in a five-minute PR review, unlike an opaque
  cost-weighted provider-scoring table.
- **A fast, independent rollback path matters more than usual here**, given
  the OpenRouter reliability data above (3 outages / 8 months, no published
  SLA). `INTERNAL_CHAT_MODEL`'s own docstring already models this well —
  *"Rollback: set `EDEN_INTERNAL_CHAT_MODEL` to the previous model id"*
  (`src/eden/llm/models.py:8`), an env-var override with no redeploy needed.
  Any future fallback-chain or `/gateway/v1` routing config should hold to
  that same bar, and specifically should verify the rollback path itself
  doesn't depend on the thing that's currently failing (e.g. the override
  shouldn't itself route back through OpenRouter if OpenRouter is down).

## Internal LLM routing — a separate question from the customer-facing gateway decision

The gateway recommendation above is about whether eden should *build/ship* a competing gateway *product*. A distinct question — whether eden should route its *own* internal LLM calls (triage, patch generation, etc.) through a proxy like OpenRouter/LiteLLM rather than calling providers directly — turns out to already be answered in the codebase: **it does, today, for 100% of internal traffic**, via `eden.llm.client.OpenRouterClient` (see above). So this is not a "should we start" decision; it's a "should we change the existing setup" decision, and the 2026 market changes cut two different ways on it:

- **Portkey's PANW acquisition is irrelevant here.** Eden doesn't use Portkey internally at all (confirmed by the `grep -rli portkey` result above) — it's purely a tool eden *observes* customers using. Nothing about Portkey's ownership changes eden's own internal LLM cost/reliability posture.
- **OpenRouter's fee structure has not materially worsened post-raise, but it is a real, non-zero cost eden is already paying.** As of mid-2026, OpenRouter charges a **5.5% fee on credit-card credit purchases** (5.0% on crypto) with a **$0.80 minimum**, and passes through underlying provider rates with no additional per-token markup on top of that; BYOK usage is fee-free up to 1M requests/month then 5% beyond that (raised to 5M/month on a negotiated Enterprise tier). This is unchanged in kind since before the Series B — it's OpenRouter's standing model, not a new post-funding tax — but it is worth eden's finance/infra owner confirming which billing mode (credit purchase vs. BYOK) the `openrouter_api_key` in `Settings` (`src/eden/config.py`) is actually using, since the two have very different cost profiles at eden's internal call volume.
- **OpenRouter's reliability is the more concrete, actionable finding.** 2026 sources document **three OpenRouter outages in an eight-month window, each 35–50 minutes**, including a Feb 19/21, 2026 caching-layer failure that returned confusing `401 "User not found"` errors during what was actually an infrastructure incident (since fixed to return `503`). OpenRouter **does not publish a standard uptime SLA**; a contractual SLA exists only via negotiated Enterprise procurement, with terms undisclosed. Cross-referenced against eden's own code: `INTERNAL_CHAT_FALLBACKS: list[str] = []` in `src/eden/llm/models.py`, explicitly "empty by design... a single internal model keeps cost + behaviour predictable." That means every eden-internal, LLM-backed feature (triage, patch generation, AI Insights, etc.) currently has **one point of failure at the OpenRouter layer itself**, with no configured fallback chain to fall back *to* — `OpenRouterClient`'s per-agent `CircuitBreaker` (`client.py:98`) will fail fast and stop hammering OpenRouter during an outage, but there is nothing else in `INTERNAL_CHAT_FALLBACKS` for it to fail over *to*.
- **Recommendation: don't switch away from OpenRouter (no evidence a direct-API or LiteLLM alternative would be more reliable or cheaper for eden's own usage), but do populate `INTERNAL_CHAT_FALLBACKS` with at least one entry that doesn't transit OpenRouter's own infrastructure** (e.g. a direct DeepSeek/DeepInfra API key, or a second cheap model on a different backend) — closing the one concrete gap the 2026 reliability data surfaces, without touching the customer-facing `AIGateway`/`/gateway/v1` decision above at all.

## Recommendation

**Don't build out `AIGateway` into a competing multi-provider gateway product, and don't try to make `/gateway/v1` match Portkey/OpenRouter/LiteLLM's routing sophistication.** That verdict is *stronger*, not weaker, after the 2026 market check: this is now a category with a $1.3B-valuation independent leader (OpenRouter, freshly backed by Google/NVIDIA/Snowflake/Databricks money) and a market leader absorbed into a major cybersecurity platform (Portkey → Palo Alto Networks Prisma AIRS) to compete on agent governance/security at enterprise scale. Matching that credibly would require sustained, well-funded infrastructure investment orthogonal to eden's differentiation (post-hoc detection, RCA, behavior tracking). Concretely:

1. **Delete `register_providers_from_env` / the cost-based `_select_provider`/`_select_fallback`/`CircuitBreaker`/provider-wrapper-class path — definitively, not "either/or."** Tracing every call site (this pass) confirms `_select_provider` always returns `None` (nothing ever populates `_providers`), so `complete()` always raises before doing anything routing-shaped; the two production call sites that touch `AIGateway` for anything routing-adjacent in `llmops.py` (`get_metrics`/`get_provider_health`) already return empty data today because nothing populates the state they read. `complete()` does have two real production callers beyond those — `time_travel/replayer.py` and `improvement/replay_verify.py` — but both currently only ever hit its exception path and degrade gracefully, so deleting it converts an accidental no-op into an intentional one (see the deletion inventory above for the two-line fix each needs, pointing them at `OpenRouterClient` instead). There is no internal activation surface for keeping `AIGateway`'s routing either: eden's own internal LLM traffic already runs through a separate, live client (`eden.llm.client.OpenRouterClient`) with its own circuit breaker, so wiring `AIGateway` up for internal use would duplicate infrastructure that already ships. This also resolves a cross-doc question: `06-cost-governance.md` traces the same code and defers a build-vs-delete call to "whatever finding owns eden's AI-gateway product strategy," noting the plumbing is "cheap to reconnect" — that's this doc, and the answer is delete, because reconnecting would mean building customer-facing multi-provider credential plumbing (`Settings` has no `openai_api_key`/`anthropic_api_key`) to compete with a $1.3B OpenRouter and a PANW-owned Portkey, which the market analysis above argues against; the two internal callers that made "reconnect" tempting don't need multi-provider selection, just a working model call, which `OpenRouterClient` already is. See the concrete file/line deletion inventory above (`src/eden/llmops/ai_gateway.py` ~900 lines, two test files deleted, one test rewritten, two production call sites re-pointed at `OpenRouterClient`, three other production files unchanged). Keep only the already-standalone filters/semantic-cache/cost-resolver machinery that `/gateway/v1` actually depends on. Shipping unreachable "gateway" code invites confident-but-wrong claims about eden's routing capabilities in sales/positioning conversations — a risk that's higher now that prospects will reasonably ask "how do you compare to Portkey/OpenRouter" given those names' 2026 visibility.
2. **Keep `/gateway/v1` honest about what it is**: a single-upstream, OpenAI-compatible pass-through proxy with PII redaction, semantic caching, and observability — not a failover router. If there's a real customer ask for provider failover on the gateway path, it's cheaper and more credible to document "bring your own Portkey/LiteLLM/OpenRouter in front of `/gateway/v1`" than to rebuild routing logic that would now be competing with a $1.3B-valuation product and a PANW-backed one.
3. **Double down on `ProviderRoutingService`'s current framing — observe, don't replace.** This is the right architectural bet, and it gets *more* valuable as the gateway market consolidates: customers are increasingly likely to already run Portkey, LiteLLM, or OpenRouter in front of their LLM calls, so ingesting the routing decisions those tools already make and exposing failure-rate/repeated-failure detection plus cross-provider cost/latency attribution in eden's dashboards is additive, not competitive. Extend the ingestion decoders (`src/eden/observability/ingestion/providers.py`) to parse gateway-specific response metadata (Portkey's `x-portkey-*` headers, OpenRouter's per-response `provider`/`model` fields, LiteLLM's callback payloads) so cost/latency get attributed to the *actual* serving provider even when traffic is gateway-routed upstream of eden — a small ingestion-schema addition, not a new subsystem.
4. **Separately (see internal-routing section above): populate `INTERNAL_CHAT_FALLBACKS` in `src/eden/llm/models.py` with at least one non-OpenRouter-transiting fallback**, given OpenRouter's confirmed 2026 incident history (3 outages / 8 months, no published SLA). This is unrelated to the customer-facing gateway product decision and doesn't change the CUT verdict on `AIGateway` above — it's routine hardening of eden's own internal LLM dependency, orthogonal to whether eden builds a gateway product.

## Verdicts

Fact-checked: `Provider`/`ProviderSpec`/`CircuitBreaker` classes and `_select_provider`
(line 892)/`_select_fallback` (line 921) in `ai_gateway.py` — all confirmed at
cited lines (`CircuitBreaker` at line 312, `AIGateway` class at line 384,
`complete()` at line 630). `register_providers_from_env` (defined line 1579,
alias `register_default_providers` at line 1656) — confirmed **zero call sites**
anywhere in `src/eden` outside its own definition/docstring mention. All three
live `AIGateway()` instantiations (`api/routes/llmops.py:42`,
`api/routes/gateway.py:332`, `llmops/learn_wiring.py:49`) confirmed to never
populate providers. `Settings` in `config.py` confirmed to have
`openrouter_api_key`/`use_minimax`/`minimax_api_key` (lines 443–451) but no
`openai_api_key`/`anthropic_api_key` fields, supporting the "no live
multi-provider population" claim. The core finding — a fully-built cost-aware
multi-provider router that is completely dormant/unreachable *as a router* in
production — is real and precisely evidenced, with one correction below:
`complete()` is not zero-caller, it's caller-but-always-fails.

Correction (final pass): `complete()` (`ai_gateway.py:630`) — the method that
exercises `_select_provider`/`_select_fallback`/`CircuitBreaker`/the
provider-wrapper classes — has **two real production callers**,
`src/eden/time_travel/replayer.py:453` and
`src/eden/improvement/replay_verify.py:355`, both calling the same shared
`get_ai_gateway()` singleton used in `gateway.py`. Because `_select_provider`
always returns `None` against an always-empty `_providers`, both calls always
raise `ProviderUnavailableError` and are silently caught, so the practical
effect is the same as zero-caller (no code path that depends on `complete()`
succeeding exists in production), but the framing matters: Time Travel's live
re-execution and the Replay-Verify auto-merge gate's live-completion check are
two additional, previously-undocumented silently-broken features riding on
this dead path, and both need a one-line fix (re-point at `OpenRouterClient`)
alongside the `ai_gateway.py` deletion — see the deletion inventory and
Recommendation §1 above, which have been updated accordingly. `llmops.py`'s
`get_metrics`/`get_provider_health` endpoints (lines 612, 622) independently
return empty data in production, since `self.metrics`/`self._health`
(`ai_gateway.py:1241`/`1247`) are populated only inside the same dead path.

This correction also resolves an open cross-doc question with
`06-cost-governance.md`, which traces the same `_select_provider` code and
defers the delete-vs-keep call to "whatever finding owns eden's AI-gateway
product strategy," describing the plumbing as "cheap to reconnect if/when
that separate decision is made." Having now traced the real (if
always-failing) call sites, the answer stays **delete**: reconnecting would
mean building customer-facing multi-provider credential plumbing that doesn't
exist today, in order to compete with a $1.3B OpenRouter and a PANW-owned
Portkey — the opposite of this doc's market-driven recommendation — when the
two internal callers that made "reconnect" look tempting don't need
multi-provider routing at all, just a working model call that
`OpenRouterClient` already provides.

Market check: confirmed via web search that **Portkey was acquired by Palo
Alto Networks, closing May 29, 2026**, folded into the Prisma AIRS platform as
an agent-security control plane, and that **OpenRouter raised a $113M Series B
in May 2026 at a ~$1.3B valuation** led by Google's CapitalG with
NVIDIA/ServiceNow/MongoDB/Snowflake/Databricks venture arms participating.
LiteLLM remains the dominant self-hosted open-source option (40K+ GitHub
stars). This confirms the category is now well-capitalized/consolidating
infrastructure, not a gap eden's dormant gateway is positioned to fill.

Confirmed via code trace: eden's own internal LLM traffic (triage, patch
generation, AI Insights, etc., per `src/eden/llm/models.py`'s module
docstring) already runs 100% through **`eden.llm.client.OpenRouterClient`**
(`client.py:165`, hitting `https://openrouter.ai/api/v1` directly, with its
own independent `CircuitBreaker` at `client.py:98`) — not through `AIGateway`.
This closes off "internal routing" as a plausible activation surface for
`AIGateway`'s multi-provider machinery: internal *chat/completion* traffic
never comes near it. (The `replayer.py`/`replay_verify.py` callers above are a
separate, narrower case — internal *tooling* that happens to call the dead
gateway, not internal routing diversity.)

Web research (separate question from the gateway-product verdict): confirmed
OpenRouter's credit-purchase fee is 5.5% ($0.80 min, 5.0% on crypto) with BYOK
free up to 1M requests/month then 5% beyond — a standing fee structure, not a
new post-Series-B tax. Confirmed via web search **three OpenRouter outages in
an eight-month window in 2026 (35–50 min each, including a Feb 19/21
caching-layer failure)**, no published uptime SLA (negotiated-only for
Enterprise). Cross-referenced against `INTERNAL_CHAT_FALLBACKS: list[str] = []`
in `src/eden/llm/models.py` (empty "by design") — eden's internal LLM-backed
features currently have no configured fallback away from OpenRouter's own
infrastructure. Confirmed via `grep -rli portkey src/eden` that eden never
uses Portkey internally, so the PANW acquisition has no bearing on eden's own
internal LLM cost/reliability posture. Reconfirmed: zero dangling references
to the deleted `sdk/rust`/`sdk/go` directories anywhere in this document; both
directories are confirmed absent from the repo.

1. Delete the dead `AIGateway` routing path — **VERDICT: DELETE (definitive,
   high confidence)**. Call-site tracing shows the deletion is still low-risk
   (no live caller depends on `complete()` succeeding — both real callers
   already only exercise its exception path), a concrete ~900-line deletion
   inventory is itemized above including the two production call sites that
   now need a one-line fix, and the one hypothetical internal-use
   justification (wiring `AIGateway` up for eden's own multi-model routing)
   is closed off by the discovery that internal chat traffic already has its
   own separate, live `OpenRouterClient` circuit-breaker/routing
   implementation.
2. Keep `/gateway/v1` honest as a single-upstream pass-through, don't rebuild
   Portkey/OpenRouter/LiteLLM-grade routing — **VERDICT: KEEP (high
   confidence)**.
3. Double down on `ProviderRoutingService` as observe-not-replace, extend
   ingestion decoders for gateway-specific metadata — **VERDICT: KEEP (high
   confidence)**. Cheap, additive, and consistent with eden's actual
   positioning; the smallest-effort item of the three and worth prioritizing
   first since it directly extends a subsystem eden already ships.
4. Populate `INTERNAL_CHAT_FALLBACKS` (`src/eden/llm/models.py`) with a
   non-OpenRouter-transiting fallback given OpenRouter's confirmed 2026
   incident history — **VERDICT: ADD (moderate confidence, small/cheap
   change)**. Entirely separate from the customer-facing gateway product
   decision above; it's internal-reliability hardening for a dependency eden
   already has, not a new build.

## Sources

- [Load Balancing — Portkey Docs](https://portkey.ai/docs/product/ai-gateway/load-balancing)
- [Portkey-AI/gateway (GitHub)](https://github.com/Portkey-AI/gateway)
- [Palo Alto Networks Completes Acquisition of Portkey to Secure AI Agents](https://www.paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-acquisition-of-portkey-to-secure-ai-agents)
- [Securing and Governing AI Agents At Scale Through A Unified AI Gateway (Palo Alto Networks blog, May 2026)](https://www.paloaltonetworks.com/blog/2026/05/securing-and-governing-ai-agents-at-scale-through-a-unified-ai-gateway/)
- [Palo Alto Networks to Acquire Portkey to Secure the Rise of AI Agents (PR Newswire)](https://www.prnewswire.com/news-releases/palo-alto-networks-to-acquire-portkey-to-secure-the-rise-of-ai-agents-302759436.html)
- [Provider Routing docs (OpenRouter)](https://openrouter.ai/docs/guides/routing/provider-selection)
- [How OpenRouter Model Routing Works](https://openrouter.ai/blog/insights/model-routing/)
- [Provider Failover vs Model Fallbacks (OpenRouter blog)](https://openrouter.ai/blog/insights/reliability-failover/)
- [OpenRouter more than doubles valuation to $1.3B in a year (TechCrunch, May 2026)](https://techcrunch.com/2026/05/26/openrouter-more-than-doubles-valuation-to-1-3b-in-a-year/)
- [OpenRouter raises $113M to bring order to enterprise AI inference routing (SiliconANGLE)](https://siliconangle.com/2026/05/26/openrouter-raises-113m-bring-order-enterprise-ai-inference-routing/)
- [AI Gateway OpenRouter Raises $113M From Google and NVIDIA (Tech Times)](https://www.techtimes.com/articles/317353/20260529/ai-gateway-openrouter-raises-113m-google-nvidia-route-between-their-models.htm)
- [Router docs (LiteLLM)](https://docs.litellm.ai/docs/routing)
- [Routing & Load Balancing (LiteLLM)](https://docs.litellm.ai/docs/routing-load-balancing)
- [BerriAI/litellm (GitHub)](https://github.com/BerriAI/litellm)
- [LiteLLM Pricing 2026: Open-Source & Enterprise Cost Breakdown (TrueFoundry)](https://www.truefoundry.com/blog/litellm-pricing-guide)
- [OpenRouter revenue, valuation & funding (Sacra)](https://sacra.com/c/openrouter/)
- [OpenRouter Pricing 2026: Plans, Costs, and Hidden Fees (TrueFoundry)](https://www.truefoundry.com/blog/openrouter-pricing)
- [OpenRouter Pricing 2026: the Hidden 5.5% Fee, Itemized (ofox.ai)](https://ofox.ai/blog/openrouter-pricing-hidden-markup-breakdown-2026/)
- [Is OpenRouter Reliable? An Honest Review for Production Use (2026) (ofox.ai)](https://ofox.ai/blog/is-openrouter-reliable-honest-review-2026/)
- [Is OpenRouter Down? OpenRouter API Status Check (apistatuscheck.com)](https://apistatuscheck.com/is-openrouter-down)
