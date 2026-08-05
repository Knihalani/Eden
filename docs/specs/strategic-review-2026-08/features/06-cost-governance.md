# Feature Research: Cost Governance & Budget Controls

**Scope:** Per-org/team budget controls, spend alerts, cost attribution, and cost-aware model
routing — Portkey, Helicone, LiteLLM proxy, OpenRouter, CloudZero vs. eden.
**Method:** Web research (cited) + direct inspection of `src/eden` and `clients/portal` (not just
doc claims or backend-only tracing). This corrects an earlier draft that concluded eden had "no
evidence" of a user-facing budget feature — wrong; eden has a real, working, org-scoped
budget/spend-alert feature, cited throughout below.

**What this document establishes, end to end:** eden's budget backend is real and, on the
enforcement side, ahead of Helicone's (fail-closed hard limits, on by default). But two separate
problems compound on top of that backend: (1) a **structural, permanent consumption-tracking
split** — for an org whose traffic is 100% ordinary gateway-proxy calls (the dominant traffic
shape), the dashboard's spend number never accrues at all, and no reconciliation job exists to fix
it (§2d); the *limit* side is split too — the number a customer configures isn't the number that
actually gets enforced (§2d.4); and (2) most of the customer-facing control surface for this
feature was never built in the portal — there is no UI to set a budget, and the built-and-working
in-app alert system is never mounted (see **User Experience & Value**, below). The `AIGateway`
cost-aware routing method referenced in §2c is real but unreachable from live customer traffic;
see §3 item 5 for why that belongs to eden's AI-gateway strategy, not this file.

---

## 1. Competitor landscape

### Portkey
- Workspace Budget Limits: cost- or token-based caps with alert thresholds and periodic resets
  (weekly/monthly/custom), configurable via admin API. Complements API-key-level budgets. Gated to
  **Enterprise (and select Pro)** plans. ([Portkey: Enforce Workspace Budget and Rate Limits](https://portkey.ai/docs/product/administration/enforce-workspace-budget-limts-and-rate-limits))
- As of 2026, third-party comparisons describe a **four-tier budget hierarchy: org → workspace →
  key → tag**, i.e. finer-grained than a single workspace cap. ([Tokonomics: Helicone vs Tokonomics](https://tokonomics.ca/blog/helicone-vs-tokonomics))
- Cost-aware routing: the gateway normalizes every provider's usage into one cost structure and
  tags cost per-team/per-user at the routing layer; routing itself reacts to provider
  health/latency more than to live budget state. Portkey's own material notes budgets are only as
  reliable as upstream cost-reporting accuracy (a $0-reported model never trips an alert). ([Portkey: AI cost observability](https://portkey.ai/blog/ai-cost-observability-a-practical-guide-to-understanding-and-managing-llm-spend/))
- One third-party comparison estimates Enterprise pricing for the tier that unlocks these controls
  at **$5k–$10k/month** (not sourced from Portkey's own pricing page, so treat as directional).
  ([TrueFoundry: Portkey Pricing Guide 2026](https://www.truefoundry.com/blog/portkey-pricing-guide))
- **Policy data model:** Portkey's newer (2026) "Usage & Rate Limit Policies"
  primitive (Enterprise Self-Hosting, gateway ≥1.17.0) is not a per-scope table at all — it's a
  single policy object with `conditions` (match on `api_key`, `virtual_key`, `provider`, `config`,
  `prompt`, `model`, or any `metadata.*` key) and a `group_by` list over the same dimension set
  (plus `workspace_id`), so one policy can express "cap spend for every request where
  `metadata.team == "growth"`, grouped per `api_key` within that team" without a dedicated
  `team_budgets` table. This is a materially different shape from LiteLLM's per-entity-type tables
  below — condition/group-by over arbitrary metadata vs. fixed scope columns — worth weighing for
  eden's design (§4a). ([Portkey: Usage & Rate Limit Policies](https://portkey.ai/docs/product/enterprise-offering/budget-policies))

### Helicone
- Tracks and surfaces cost in-dashboard but **does not stop spend before it starts** — multiple
  2026 sources independently confirm Helicone has no true hard-cap/blocking enforcement; overruns
  are visible only after the fact. Alerts + HQL query language ship in the $79/mo Pro tier. ([Tokonomics: Hard Spending Caps for LLM APIs](https://tokonomics.ca/blog/feature-hard-spending-caps)); ([TrueFoundry: Helicone Pricing 2026](https://www.truefoundry.com/blog/helicone-pricing))
- No RBAC at the model/tool level — doesn't govern which teams can call which models. ([Tokonomics: Hard Spending Caps for LLM APIs](https://tokonomics.ca/blog/feature-hard-spending-caps))
- Context: Mintlify acquired Helicone in March 2026; public commit velocity has slowed since, worth
  weighting accordingly when treating it as a moving target. ([Tokonomics: Hard Spending Caps for LLM APIs](https://tokonomics.ca/blog/feature-hard-spending-caps))

### LiteLLM proxy (closest open-source comparator)
- **Multi-scope hard budgets**: `max_budget` can be set per key, team, internal user, end
  customer, and model/project, each with its own `budget_duration` reset cadence (seconds through
  days); requests are rejected once the cap is hit. ([LiteLLM: Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users))
- **Team soft-budget alerts** are a distinct, newer primitive from hard budgets: a soft budget on
  a team fires an **email to configured recipients** (e.g. finance or a team lead — not
  necessarily team members) on breach, without blocking requests; it activates automatically once
  a soft budget + alerting email are set on a team, no proxy restart needed, checked on every
  request. Hard (`max_budget`) and soft budgets are meant to be layered on the same team: soft for
  early warning, hard for the stop. ([LiteLLM: Team Soft Budget Alerts](https://docs.litellm.ai/docs/proxy/ui_team_soft_budget_alerts))
- Spend attribution is granular — tracked per key, user, team, org, tool, agent, and MCP server,
  across 140+ providers, enabling chargeback. ([LiteLLM homepage](https://www.litellm.ai/))
- Operational caveat directly relevant to eden's own architecture: a production deployment guide
  warns that **SQLite races budget decrements under concurrent requests** and Postgres is required
  for correctness — the same class of concurrency risk eden's own dual budget-read paths raise
  (§2d below). ([Stack Harbor: Deploying LiteLLM proxy with per-team budgets](https://stackharbor.com/en/knowledge-base/litellm-proxy-budgets-deploy/))
- **Actual data model + enforcement mechanics** (not just the feature list above):
  LiteLLM's Postgres/Prisma schema is `Organization → Team → Project → Key`, with `User` a member
  of orgs/teams, and — the detail most relevant to eden's design — **most of those entity tables do
  not carry their own budget columns**. They hold a foreign key into one shared,
  `LiteLLM_BudgetTable` (`max_budget`, `budget_duration`, `budget_reset_at` — the same three
  columns regardless of which entity references them), so a budget policy is authored once and
  attached to an org/team/key/end-user row rather than re-implemented per entity type. Precedence
  is explicit and documented, not implicit: **key-level budget → user-level → team-member
  (`max_budget_in_team` on `TeamMembership`) → team-level → org-level**, checked in that order, and
  if a key belongs to a team **only the team (and team-member) budget applies — the key owner's
  personal budget is ignored**, avoiding the "which of two configured limits wins" ambiguity eden's
  current architecture doesn't have to answer yet (single scope) but will the moment a second scope
  is added. ([LiteLLM: Database Schema and Models — DeepWiki](https://deepwiki.com/BerriAI/litellm/3.5.4-database-schema-and-models); [LiteLLM: Team Management — DeepWiki](https://deepwiki.com/BerriAI/litellm/3.5.2-team-management))
- **The concurrency fix, not just the concurrency warning:** LiteLLM's answer to
  the SQLite-race caveat above is a **budget reservation pattern**, not just "use Postgres."
  Before a request reaches the provider, the proxy estimates worst-case cost and **pre-reserves**
  that amount in a Redis+in-memory `DualCache` across every applicable scope (key, team, user,
  end-user) simultaneously, applying the strictest limit; the DB write of actual spend happens
  after the response, reconciling the reservation. This directly targets the class of problem
  eden's dual-path (§2d) has: rather than reading two independently-lagging aggregates and hoping
  they agree, LiteLLM keeps one fast synchronous counter that every scope's enforcement check reads
  *before* the request is allowed to proceed, and treats the durable DB row as the settlement
  layer, not the enforcement layer. ([LiteLLM: Budget and Spend Tracking — DeepWiki](https://deepwiki.com/BerriAI/litellm/3.3-budget-and-spend-tracking))
- Also notable: requests to `input_cost_per_token: 0` / `output_cost_per_token: 0` models are
  **exempt from budget checks entirely**, so a budget-exhausted key/team can still fall back to a
  free/self-hosted model — a pattern eden has no equivalent of today (its `action_on_exceed` is
  throttle/kill/alert, not "route to a free-tier model"). ([LiteLLM: Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users))

### OpenRouter
- Dashboard-level spend controls: monthly credit caps, budget alerts, and per-API-key spending
  limits/usage counters — keys are the isolation unit for teams/environments (prod ≠ sandbox ≠
  CI), each separately capped and attributable. ([OpenRouter usage limits explained](https://www.datastudios.org/post/openrouter-usage-limits-explained-rate-limits-spending-controls-provider-errors-fallbacks-byok))
- **Cost-aware routing is a first-class, default behavior**: default provider sort is `price`
  (cheapest stable provider); `:floor` picks the cheapest model able to do the task, `:nitro`
  picks the fastest; `provider.order` and `max_price` let callers hard-cap per-request economics.
  Failed calls before token generation aren't billed. ([OpenRouter provider routing](https://sidsaladi.substack.com/p/openrouter-101-the-complete-guide))
- Gap: usage reporting is fragmented across free-model quotas, key budgets, provider capacity, and
  routing policy — a documented incident shows a runaway agent burning ~$22/day invisible to
  downstream app cost tracking until the invoice arrived. ([GitHub issue #5598, paperclipai/paperclip](https://github.com/paperclipai/paperclip/issues/5598))

### CloudZero (general-purpose FinOps, not LLM-native)
- Positions itself around **unit economics**, not raw spend caps: its CostFormation engine maps
  LLM/GPU spend to cost-per-feature, cost-per-customer, cost-per-deployment; native tracking
  across OpenAI, Anthropic, Bedrock. ([CloudZero: AI cost monitoring](https://www.cloudzero.com/blog/ai-cost-monitoring/))
- **Anomaly detection is explanatory, not just threshold-based**: it aims to identify which
  team/service/workload caused a spend spike, not merely that spend rose — CloudZero's own 2026
  survey frames same-day detection as the bar that separates real monitoring from monthly
  after-the-fact accounting. ([CloudZero: The Complete Guide to Cloud Cost Management 2026](https://www.cloudzero.com/blog/cloud-cost-management/))
- Explicitly frames governance as "guardrails, not restrictions" — visibility/attribution first,
  optimization second — a philosophy distinct from OpenRouter/Portkey/LiteLLM's block-the-request
  posture. ([CloudZero: FinOps for AI](https://www.cloudzero.com/blog/finops-for-ai/))
- Independent analysts note CloudZero is "less mature on LLM-specific attribution" than
  purpose-built LLM gateways — it's a cloud-cost platform extending into AI, not an LLM proxy.
  This makes it a poor **routing/enforcement** comparator for eden but a fair **anomaly-detection**
  comparator (a capability eden has none of — see §3). ([Finout: Best AI Cost Observability Tools 2026](https://www.finout.io/blog/best-ai-cost-observability-tools-in-2026))

**Cross-vendor pattern:** all of Portkey, LiteLLM, and OpenRouter enforce (or claim to enforce)
budgets **at the gateway/proxy chokepoint** every model call passes through — not in application
code — and increasingly at **multiple scopes** (org/workspace/team/key/user), not just one
org-wide number. Hard enforcement (blocking, not just alerting) plus soft-budget email routing to
non-member recipients (LiteLLM) are the current state of the art; Helicone explicitly lacks the
former. CloudZero adds a third axis none of the LLM-native tools do well: causal anomaly
explanation ("which team caused this spike"), not just threshold alerts. The two mature
open/enterprise implementations (LiteLLM, Portkey) converge on the same underlying principle even
though their schemas differ: **one canonical budget object referenced by scope, not N duplicated
budget tables** — and LiteLLM additionally treats the fast in-memory/Redis counter, not the
Postgres row, as the enforcement source of truth, exactly the inversion eden's current design
lacks (§2d).

---

## 2. Eden's current state (verified by direct code read, not just grep)

Eden has a real, working, **user-facing, org-scoped** budget/spend-alert feature — not just
internal SLA tracking. It is comparable in shape to Portkey's single-tier workspace budgets or
LiteLLM's org-level budget, minus the multi-scope (team/key/user) hierarchy both of those ship.

### 2a. User-facing budget API and enforcement
- `GET /orgs/{org_id}/budget` — config + current-window consumption + rollup (`pct_of_hard`,
  `thresholds_breached`, `alert_breached`, `exceeded`).
- `POST /orgs/{org_id}/budget` — org-owner-gated upsert (soft/hard USD limits, `window`
  daily/weekly/monthly, `action_on_exceed` = throttle/kill/alert, `alert_thresholds` list, default
  `[50, 80, 100]`). `src/eden/services/budget_service.py:62` (`DEFAULT_ALERT_THRESHOLDS`), `:566`
  (`upsert_budget` def, `action_on_exceed: str = "throttle"`). Also org-owner-gated at the route
  level: `POST /orgs/{org_id}/budget` requires `require_org_owner` (`budgets.py:88-91`); GET/ticker/
  actions require only org membership (`require_path_org_access`, `:55`, `:113`, `:135`).
- `GET /orgs/{org_id}/budget/ticker` — live consumption + last-50 actions. Backend-only: no
  frontend call site anywhere in `clients/portal` (see **User Experience & Value**).
- `GET /orgs/{org_id}/budget/actions` — paginated threshold/exceeded audit log. Also backend-only —
  the route's own docstring calls it the "Portal 'Recent threshold events' feed," but no such feed
  is rendered anywhere in the shipped portal.
  All four routes: `src/eden/api/routes/budgets.py`.
- `evaluate_budget_alerts()` (`budget_service.py:449`) fires at 50/80/100% crossings, writes to
  `budget_actions`, and calls `_notify_budget_alert()` (`:527`) — an in-app `notifications` row on
  every threshold, plus a real transactional **email** on the 100% (hard) breach via
  `src/eden/services/alert_email.py`.
- `QuotaEnforcementMiddleware._check_hard_limits` (`src/eden/api/middleware/quota_enforcement.py`,
  around line 553) does **real hard enforcement**: it calls `self._get_usage_service()` (`:171`)
  → `UsageService.get_budget_status(org_id)`, blocks mutating requests when hard limits are
  exceeded, and **fails closed** (blocks) if a fresh quota snapshot can't be verified during a DB
  outage — a stricter posture than Helicone's soft-only alerts, and comparable to LiteLLM's hard
  `max_budget` blocking.
- Free-tier default is `enforcement_enabled=True` (hard-stop by default, not opt-in) — migration
  `src/eden/db_migrations/versions/134_budget_enforcement_default_true.py:31,39-41`.

**Portal UI**: `clients/portal/src/app/(portal)/cost/page.tsx` renders a live Cost page —
`BudgetChip` status pill, spend view, cost-drivers view, per-agent filter — backed by
`clients/portal/src/lib/api/budget.ts`, which fetches via React Query with a 90s `staleTime` and
**no `refetchInterval`** (cache-first, manual-refresh-on-stale — not a live poll). This is a real,
discoverable *viewing* surface for current spend/status. It is not a *configuration* surface: the
only client function `budget.ts` exports is `get()` — there is no `set`/`upsert` call anywhere in
the portal, and `POST /orgs/{org_id}/budget` (the only way to actually set a budget) has zero
frontend call sites. See **User Experience & Value** below for the full trace of what is and isn't
reachable from the product.

### 2b. Granularity gap vs. Portkey/LiteLLM
Budgets in eden are **org-level only**. `grep -rn "team_id|per_team|team_budget"` across
`budget_service.py`, `budgets.py`, and migration `052_budgets.py` returns **zero hits**. The
`052_budgets.py` migration's three tables (`budgets`, `budget_consumption`, `budget_actions`) are
all keyed on `(org_id, "window")` only — `src/eden/db_migrations/versions/052_budgets.py:60,80,99`
— confirming there is no schema-level room for team/key scoping without a migration. There is only
a single org-wide budget row per window. The portal's "per-agent" cost filter is a *read-side*
breakdown (attribution), not a separate enforceable budget per agent/team. This is now a two-vendor
gap, not one: both Portkey (workspace/key/tag tiers) and LiteLLM (key/team/user/customer/project
scopes, each independently cap-able) do multi-scope budgets; eden does not.

### 2c. `AIGateway` cost-aware routing: real, but unreachable from live customer traffic

This required tracing call graphs, not just grepping for the class name — `AIGateway` is **not**
globally dead code, an earlier assumption this doc corrects. It's a large, actively-maintained
module (`src/eden/llmops/ai_gateway.py`, docstring: *"Unified chokepoint... Enforces security,
cost management, observability, caching, and automatic failover"*) with a real cost-aware
provider-selection method:

```python
# src/eden/llmops/ai_gateway.py:892
def _select_provider(self, request: ModelRequest) -> Provider | None:
    """Select the cheapest provider that meets quality/latency requirements."""
    ...
    candidates.sort(key=lambda x: x[1])  # x[1] = cost
    return candidates[0][0]
```

`_select_provider` is only invoked from `AIGateway.complete()` (`ai_gateway.py:672`), and
`.complete()` in turn is called from exactly **three** places in the whole tree:
- `src/eden/time_travel/replayer.py:453` — offline replay/time-travel re-execution.
- `src/eden/improvement/replay_verify.py:355` — internal improvement-loop replay verification.
- `src/eden/api/routes/llmops.py` — but the one HTTP route that used to expose this,
  `POST /llmops/gateway/complete`, was **retired 2026-07-04** and now unconditionally returns
  `410 Gone`:

```python
# src/eden/api/routes/llmops.py:583-599
@router.post("/gateway/complete", response_model=dict[str, Any])
async def gateway_complete(...):
    # Audit 2026-07-04 — the previous implementation returned a
    # hardcoded mock response with fabricated cost / latency /
    # provider values. That silently shipped fabricated metrics into
    # the LLMOps dashboard and the judge-eval pipeline. The real
    # provider call lives in ``eden.api.routes.gateway`` (mounted
    # under ``/gateway/v1``). Surface a 501 so callers route there.
    raise HTTPException(status_code=410, detail=(
        "Legacy /llmops/gateway/complete stub retired 2026-07-04; "
        "use /gateway/v1/chat/completions instead."))
```

The route the retirement message points customers to — `/gateway/v1/chat/completions`, eden's real
production OpenAI-compatible gateway (`src/eden/api/routes/gateway.py`, mounted in
`src/eden/api/app.py:1256`) — **does not call `AIGateway.complete()` either.** Its request handler
resolves a single upstream provider from request headers (`X-Upstream-Base-Url` /
`X-Upstream-Provider`) or server config (`use_minimax` flag → MiniMax, else OpenRouter) and calls
it directly:

```python
# src/eden/api/routes/gateway.py:1715-1719
async def _call_upstream() -> dict[str, Any]:
    response = await client.chat.completions.create(**upstream_kwargs, stream=False)
    return shape_chat_completion_response(response)
```

`get_ai_gateway()` is used inside `/gateway/v1` only for its PII filter (line ~923, a cheap
`gpt-4o-mini` guardrail classification call — not the main completion) and its `cost_resolver`
component (`gateway.py:1645`, for pricing/billing telemetry after the fact) — never for
`_select_provider`'s cheapest-provider decision.

**Net finding:** eden's live customer-facing gateway makes a single, caller-specified (or
server-config-default) provider choice per request; it does **not** shop across providers for
price the way `AIGateway._select_provider` (or OpenRouter's default `:floor` sort) does. The
cost-aware routing logic exists, is well-formed, and is exercised in offline replay/verification —
but it is unreachable from the one HTTP path a real customer request takes. This is a materially
different — and more precise — finding than "dormant/unused": the code isn't dead, it's
**orphaned from the production request path** after a 2026-07-04 stub retirement redirected
traffic to a sibling route that never wired it back in.

### 2d. Two live budget-status paths (of at least four in the backend) — traced end to end, quantified

The task brief flagged a `get_usage_service` / `quota_enforcement.py` duplication —
confirmed in earlier passes. This pass traces **every writer and every reader** of both paths to
construct a concrete scenario rather than restate the existence of the split.

**Path A — `budget_service.get_consumption()`** (`src/eden/services/budget_service.py:215-269`):
a single `SELECT cost_usd, requests_count FROM budget_consumption WHERE org_id = $1 AND "window" =
$2 AND window_start = $3` against the **`budget_consumption` rollup table**. The only writer is
`budget_service.record_usage()` (`:275-361`), an idempotent
`INSERT ... ON CONFLICT (org_id, "window", window_start) DO UPDATE SET cost_usd = cost_usd +
EXCLUDED.cost_usd`. `record_usage()` has exactly **three callers** in the whole tree:
1. `CostTracker.track()` (`src/eden/optimization/cost_tracker.py:132`) — reached only via
   `src/eden/api/routes/optimization.py`'s `/costs/track`, `/budget`, `/budget/check` endpoints,
   i.e. the same **orphaned cost-aware-router surface** as §2c (`grep -rln "CostTracker()"
   src/eden` returns only `api/routes/optimization.py:180`; `optimization/__init__.py` merely
   imports/re-exports the class, it never instantiates it).
2. `cost_ledger.py:316` — the `CostEvent` persist path used by **judges, Improve, chat, and
   OpenRouter-direct** flows (per `usage_service.py`'s own docstring), not the main proxy.
3. `AIGateway.complete()` (`ai_gateway.py:711-721`, "DL-15: per-tenant cost tracking... skip when
   cost_usd is 0 (a cache hit)") — but per §2c, `.complete()` is reachable **only** from
   `time_travel/replayer.py` and `improvement/replay_verify.py`, not from live traffic.

**Path B — `UsageService.get_budget_status()`** (`src/eden/services/usage_service.py:334-478`,
called by `QuotaEnforcementMiddleware` — the actual request-blocking gate): its cost figure comes
from `_sum_org_cost_usd()` (`:268-330`), which sums three sources and takes
`max(usage_events_sum + customer_cost_events_sum, budget_consumption_sum)` — explicitly to avoid
double-counting the OpenRouter/cost-ledger paths that dual-write both `customer_cost_events` *and*
`budget_consumption`. The dominant writer into `usage_events` is
`TelemetryCollector._emit_billing_events()` (`src/eden/observability/telemetry_collector.py:696-819`),
which is fed **synchronously, on every proxied call**, by
`_emit_gateway_telemetry()` inside `src/eden/api/routes/gateway.py:400-458` — the live
`/gateway/v1/chat/completions` / `/completions` / `/embeddings` handlers construct a
`TelemetryEvent(event_type="llm_completion", ...)` for their own request and hand it to the
collector directly. This is a completely separate write path from `record_usage()` / Path A.

#### 2d.1 Concrete drift scenario (traced, not hypothetical)

Take an org, `org_growth`, whose traffic is 100% ordinary `/gateway/v1/chat/completions` calls
(the common case — no judges, no Improve runs, no direct OpenRouter calls, and the cost-aware
router in §2c/§2d is orphaned so `CostTracker.track()` never fires for them):

1. Customer calls `POST /gateway/v1/chat/completions` 10,000 times this month, totaling **$500**
   in real upstream cost.
2. Each call: `gateway.py` → `_call_upstream()` (direct `AsyncOpenAI` client, bypassing
   `AIGateway.complete()`) → success → `_stamp_gateway_cost_usd()` computes `cost_usd` via
   `CostResolver` → `_emit_gateway_telemetry()` builds a `TelemetryEvent` → async-ingested by
   `TelemetryCollector.ingest_batch()` → `_emit_billing_events()` → `UsageService.track_events_batch()`
   → 10,000 rows land in `usage_events`, `SUM(cost_usd) = 500.00`.
3. **`record_usage()` is never called for any of these 10,000 requests** — none of its three
   callers (above) sit on this code path. `budget_consumption` for `org_growth` this month:
   **zero rows, `cost_usd = 0.0`** (or a stale/absent row from a prior month if the org previously
   used judges/Improve).
4. `budget_service.get_consumption("org_growth", window="monthly")` now returns
   `{"cost_usd": 0.0, "source": "defaults"}` (no row) for the entire month, regardless of how much
   real spend accrues, because nothing ever writes to `budget_consumption` for this traffic shape.
   `UsageService.get_budget_status("org_growth")` correctly returns `total_cost_usd ≈ 500.0` via
   the `usage_events` sum.
5. **Divergence is unbounded, not a race window.** There is no point at which Path A
   self-corrects toward Path B's number — the two write pipelines are structurally disjoint for
   this traffic shape, not merely lagged. The gap grows by exactly the org's real monthly spend,
   every month, indefinitely (bounded only by the org's actual total spend, which for an
   active paying customer has no natural ceiling).

**Concrete consequences, each traceable to a specific caller of Path A:**
- `GET /orgs/org_growth/budget` / the portal ticker (`routes/budgets.py:58,119`, `BudgetChip` /
  `cost/page.tsx`) shows **$0 of, say, a $1,000 configured hard limit — 0% utilized** — while the
  org has actually spent $500 (50%), because that endpoint reads `budget_service.get_consumption()`
  exclusively, never `UsageService`.
- `evaluate_budget_alerts()` (`budget_service.py:449`, called from `record_usage()`'s callers and
  from `CostTracker.track()`) **never fires** the 50/80/100% threshold alerts for this org's real
  spend — it reads `get_consumption()`, sees $0, and has no other input.
- The autonomous agent's own budget self-throttle (`src/eden/autonomous/agent.py:1636-1655`,
  `src/eden/improvement/agent.py:956-960`, both calling `budget_service.get_consumption()` directly)
  believes the org has 100% of its budget headroom left and never voluntarily backs off, even
  though the org's *actual* total spend (correctly seen only by `UsageService`) may already be
  well past the configured hard limit.
- Meanwhile `QuotaEnforcementMiddleware` (Path B) **does** correctly see the $500 and will still
  block once the credit/cost cap in `org_resource_limits` is hit — so end-customer requests are not
  silently unmetered end-to-end. But see §2d.4: the cap `QuotaEnforcementMiddleware` actually
  enforces is not the same cap the customer configured via the Budgets UI.

#### 2d.2 Why the two consumption paths were never designed to agree

This gap is **known and intentional, not an oversight** — the codebase says so in its own words.
`_get_or_build_upstream_client()` (`src/eden/api/routes/gateway.py:844-848`), the function that
builds the client `_call_upstream()` uses, carries this comment directly above the call site that
would have wired Path A in:

```python
# Wave 4 note: budget ``record_usage`` on the success path is
# intentionally deferred — cost already flows through the usage /
# quota snapshot pipeline; wiring a second write here is invasive.
# Free-tier ``enforcement_enabled=True`` (defaults + migration 134)
# is the cost-control gate for new orgs.
```

Someone on the eden team looked at exactly this spot and chose not to wire `record_usage()` in,
reasoning — correctly, per Path B — that hard *enforcement* still works via `UsageService`. What
the comment does not acknowledge is that the **dashboard/alert/self-throttle** consumers of Path A
were left silently wrong as a side effect. That's the gap this section quantifies.

`_sum_org_cost_usd()`'s own `max(events_sum, budget)` is itself an admission that the two paths
disagree by construction — but that reconciliation logic runs **only inside Path B**. Path A
(the number the Budgets UI and the agents' own self-throttle actually read) has no equivalent
correction; it only ever sees what `record_usage()` happened to write. There is no code anywhere
that backfills or reconciles `budget_consumption` from `usage_events`/`customer_cost_events` after
the fact — Path A's number, once behind, stays behind for the rest of the window.

#### 2d.3 No reconciliation job exists

Searched for any batch/cron process that would close this gap: `grep -rln "reconcil" src/eden
--include="*.py"` returns **nine** files. Read all nine — none is a `budget_consumption`
reconciliation job. Six are unrelated to cost entirely (webhook/IdP-sync "reconcile later"
language in `api/utils/clerk_client.py`, `api/routes/scim.py`, `services/invitation_service.py`;
an issue-taxonomy concept in `issues/models.py`/`084_agent_issues.py`; a schema-notes docstring in
`142_session_summaries.py`). Two are cost-adjacent but aspirational, not implemented:
`src/eden/llmops/ai_gateway.py:281`, a docstring comment on `ModelResponse.cost_source`
(*"cost_source... tells the operator which tier produced this number... so post-hoc
reconciliation can flag drift"*), and `src/eden/llmops/cost_resolver.py:24`, the same rhetorical
pattern for a `cost_source="unknown"` field — neither is read by any reconciliation code. One is
genuinely cost-related but a different axis: `081_org_cost_overrides.py:33` defines
`org_cost_overrides.source`, an enum including a `'reconciliation'` value ("derived from observed
invoice deltas") — this table lets ops manually correct the **price-per-token** used for billing
(volume discounts, enterprise contracts), not the **consumption-aggregation drift**
`budget_consumption` vs. `usage_events` has; it doesn't touch `budget_consumption`. There is no
`budget_consumption`-related entry in `src/eden/workers/cron_tick.py` (eden's scheduled-job
dispatcher), no reconciliation task in `src/eden/evaluation/scheduler.py` or
`src/eden/self_obs/scheduler.py`, and no migration or service function that recomputes
`budget_consumption` from `usage_events`/`customer_cost_events`.
**Confirmed: no reconciliation job exists between the `budget_consumption` rollup and
`usage_events`/`customer_cost_events`.** The only "reconciliation" in the system is `UsageService`'s
own `max()` guard against double-counting the sources it *does* see — which papers over the gap
for enforcement purposes but does nothing to correct `budget_consumption` itself, so every other
consumer of Path A (dashboard, alerts, agent self-throttle) stays wrong indefinitely.

#### 2d.4 A second, adjacent split: the configured hard limit isn't the enforced one

Independent of the consumption-drift issue above, the **limit** side of the two paths is also two
different configs, not one. `budgets.cost_hard_limit_usd` (`052_budgets.py:63`, default `1.00`,
customer-editable via `POST /orgs/{org_id}/budget`) is read only by Path A callers
(`budget_service`, `CostTracker`, the two agent self-throttle call sites). `QuotaEnforcementMiddleware`
never reads the `budgets` table at all — it reads `UsageService.get_budget_status()`, whose hard
cap comes from `org_resource_limits.cost_hard_limit_usd` (a separate table, separate migration
lineage — first referenced in `002_phase_4_2_data_layer.py`/`015_regions_and_rls.py`, unrelated to
`052_budgets.py`) or the plan-tier default if that column is unset. `grep -n "enforcement_enabled"
src/eden/api/routes/gateway.py` returns only a comment (`:847`) — no functional code path in the
live gateway route reads `budgets.enforcement_enabled` or `budgets.cost_hard_limit_usd`. Net
effect: **a customer who sets a custom hard budget via the Budgets UI is not actually capping their
live gateway spend** — that UI only drives the dashboard/alert/agent-self-throttle surfaces (Path
A); the number that actually blocks `/gateway/v1` requests is the org's plan-tier
`org_resource_limits` cap, which the customer cannot see or edit from the same screen. This is a
sharper problem than the consumption-drift alone: even with perfectly synced consumption numbers,
the *limit itself* is the wrong one on the enforcement side.

#### 2d.5 Two more orphaned budget-status computations (same root cause, currently inert)

Two additional endpoints independently compute an org's budget status, both fed by the same
unreachable `CostTracker`/Redis pipeline as §2c/§2d, and both currently dead on the frontend (so
not customer-visible today, but worth noting since "two independently-computed budget-status
paths" undercounts what actually exists in the backend):
- `GET /orgs/{org_id}/cost/comparison` (`src/eden/api/routes/cost.py`) — its own docstring states
  *"Source of truth: the Redis hash `eden:cost:{org_id}:month:{YYYY-MM}` written by `CostTracker`
  on every tracked event."* Since `CostTracker.track()` is unreachable from live gateway traffic,
  this would show `null` (not a misleading `$0` — the code explicitly returns `null` by design) for
  a gateway-proxy-only org. The frontend wrapper (`getCostComparison` in `resources.ts`) exists but
  has zero call sites.
- `GET /orgs/{org_id}/optimization/budget` (`optimization.py:589-625`) — reads `org_plans.plan_name`
  for limits and the same Redis hash for spend. Its frontend wrapper (`getOptimizationBudget`,
  `resources.ts:776`) also has zero call sites.

Neither is reachable from the shipped product, so they don't compound the customer-facing drift in
§2d.1 — but they confirm the root cause (`CostTracker`/Redis never fed by live gateway traffic) has
independently recurred across at least four backend budget-status computations, not two, only two
of which (`budget_service`/Path A, `UsageService`/Path B) are reachable from any live surface today.

### 2e. Internal-only cost tracking (separate system, not customer-facing)
`docs/specs/SOTA-PERF-COST-SCORECARD.md` scores cost as an SLA/scorecard dimension — "Org spend
budgets / kill switches: Cost ledger (W7), FinOps explorer+kills (W8) — **MET**" — plus
`src/eden/llmops/cost_ledger.py` (per-feature `CostEvent`, `sum_feature_spend_today`,
`explorer_summary`) and `src/eden/llmops/feature_kills.py` (org-scoped feature kill switches).
These feed the FinOps explorer and internal autonomy/evolution spend caps (`N22`, `W24`, `W25`) —
a third, adjacent system from both the customer-facing `budgets.py`/`budget_service.py` path and
`UsageService`, used to gate eden's *own* internal agent loops rather than customer spend.

**Correction — one write path from this "internal-only" system is not, in fact, isolated from
customer-facing numbers.** `optimizations/03-llm-cost.md` (Phase 3 finding) traces a live,
unfixed bug in `issues/triage_agent.py` where `autonomy_policy.record_spend()` →
`record_cost_event()` (`closed_loop/autonomy_policy.py:360-376`) unconditionally writes a
synthetic, flat `$0.02` `CostEvent` (`_TRIAGE_COST_ESTIMATE_USD`, `triage_agent.py:36`) for every
LLM-used triage. That `CostEvent` lands in the `customer_cost_events` table
(`cost_ledger.py:279`) — the same table `_sum_org_cost_usd()` (`usage_service.py:268-330`, §2d
above) sums into `get_budget_status()` (`usage_service.py:334`), which is Path B, the figure
`QuotaEnforcementMiddleware._check_hard_limits` reads to block a customer's own gateway requests.
So while this system is internal-only in intent and in most of its effects, this one code path is
a concrete, live counter-example: it nudges the customer-facing Path B credit-consumption number
upward by the fake-vs-real delta (~$0.0196/triage call) — small in aggregate (well under $1/org/
day, per `optimizations/03-llm-cost.md`'s blast-radius estimate) but genuinely customer-facing,
not merely an internal telemetry-hygiene issue. See `optimizations/03-llm-cost.md`'s "This bug
also reaches outside Eden's own COGS accounting..." section for the full trace.

---

## User Experience & Value

Everything above establishes that eden's budget *backend* is real and, on enforcement, ahead of
Helicone's. This section traces what that backend actually looks like from the seat of the person
who's supposed to use it — and finds a second gap, independent of §2d's data-drift finding: most of
the customer-facing control surface for this feature was never built.

### Who is the user

The doc never names a persona explicitly; the code answers by omission. Budget *editing* is gated
to `require_org_owner` — the org owner, and only the org owner
(`src/eden/api/routes/budgets.py:88-91`). Budget *alert emails* go slightly wider, to org owner and
admin, resolved by querying org membership directly
(`src/eden/services/alert_email.py`'s `_org_alert_recipients()`: `SELECT DISTINCT u.email FROM
users u JOIN org_members m ... WHERE m.role IN ('owner','admin') ... LIMIT 10`). There is no
"finance," "billing," or "budget admin" role anywhere in this path. The implicit persona eden built
for is a founder/eng-lead who *is* the org owner on a small team — not a dedicated finance/FinOps
stakeholder watching spend across many teams. That's a reasonable bet for eden's current customer
size, but it's the opposite of where the comparator set has moved: LiteLLM's team soft-budget
alerts explicitly route to "finance or a team lead — not necessarily team members" (§1) — alerting
to *non-members* — a capability `_org_alert_recipients()` structurally cannot express, since it only
ever resolves emails of people already in `org_members`.

### Flow 1 — Setting a budget: a real backend, a missing product

Trace the "set a budget" path end to end, from the portal outward:
- `clients/portal/src/lib/api/budget.ts` — the client the Cost page actually uses — exports exactly
  one function, `get()`. No `set`, `upsert`, or `update`.
- `clients/portal/src/lib/api/resources.ts:2245` — a **second**, unused client wrapper *does*
  define `upsertBudget(orgId, body)`, wrapping `POST /orgs/{org_id}/budget` with the exact typed
  body the backend expects (`cost_soft_limit_usd`, `cost_hard_limit_usd`, `enforcement_enabled`,
  `window`, `action_on_exceed`, `threshold_alert_pct`). It has **zero call sites** anywhere in
  `clients/portal/src` outside its own definition.
- `cost/page.tsx` and `cost-spend-view.tsx:121-153` render the budget as a read-only progress bar +
  `BudgetChip` status pill. There is no input field, no "Edit budget" button, no settings-page link,
  and no onboarding step that mentions setting a spend cap anywhere in the portal.

**Net: the only way to actually configure a budget in eden today is a raw API call.** That's a fine
workflow for the engineer who built the integration, and a non-starter for a team lead who wants to
set a cap — they are not going to `curl` an endpoint. The frustrating part is how close this is to
shipped: the backend contract, validation, and even a typed frontend client function already exist;
the only missing piece is a form. §2a's characterization of this as a "discoverable settings
surface" has been narrowed above to reflect this — it's accurate for *viewing* spend, but there is
no editable settings surface in the product for *configuring* it.

### Flow 2 — Monitoring spend: the dashboard visibly disagrees with itself

Separate from §2d's backend-level Path A/B drift, the *portal itself* surfaces two different cost
numbers on the same screen and says so in its own copy:
- The page's primary "Spend · 24h" KPI is sourced from agent telemetry (`cost/page.tsx:236-249`,
  `sourceLabel: "Telemetry · 24h"`), aggregated client-side from `agents[].costUsd24h`.
- The budget progress bar directly below it — fed by `budgetApi.get()`, i.e. Path A
  (`budget_service.get_consumption()`) — is captioned, verbatim, "**gateway budget (separate from
  telemetry spend above)**" (`cost-spend-view.tsx:137-139`).

That caption is the frontend admitting, in its own UI copy, to the exact split §2d traces at the
backend level — two independently-computed numbers, shown stacked on one screen, with a footnote
instead of a reconciliation. Combine this with §2d.1: for an org whose traffic is 100% ordinary
`/gateway/v1` calls, `budget_consumption` — the number driving that "gateway budget" bar — sits at
exactly $0.00 indefinitely, while the *other* number on the same screen climbs normally. A customer
who checks their dashboard specifically to avoid a surprise bill sees a budget bar frozen at 0%
used, forever, right up until `QuotaEnforcementMiddleware` (reading a third, invisible-to-the-
customer number, `org_resource_limits` — §2d.4) starts silently blocking requests with no preceding
alert. That's close to the worst version of this feature's UX: not "no budget feature" (eden clears
that bar) but "a budget feature that actively misleads you about your own risk" — arguably worse for
trust than no dashboard at all, since the customer did the right thing and got a false all-clear.

### Flow 3 — Getting alerted: designed for three tiers, delivered for one, and undeliverable in-app

`evaluate_budget_alerts()` (`budget_service.py:449-511`) is genuinely well-built: debounced
(~45s) so it doesn't hammer Postgres on every dollar of spend, idempotent per threshold/window, and
fires at each of 50/80/100% by default. What happens to a human when it fires:
- **In-app**: writes a `notifications` row (`_notify_budget_alert()`, `:527`). The portal has a
  fully-built consumer for this — `clients/portal/src/hooks/use-notifications.tsx` defines a
  `NotificationsProvider` with adaptive polling, unread counts, mark-as-read, delete — but it is
  **never mounted anywhere in the app**: no provider wraps the layout, no bell icon, no toast, no
  notification panel exists in the rendered product. Every in-app alert eden's backend writes for a
  budget threshold crossing is invisible to the customer today. This is a complete notification
  *system* — backend table, write path, and a fully-built React provider — with zero UI surface
  consuming it anywhere in the product.
- **Email**: fires exactly once, only at the 100% (hard) threshold
  (`src/eden/services/alert_email.py`, `send_budget_hard_limit_email`). The 50%/80% "early warning"
  thresholds — the entire point of having more than one — produce zero human-visible signal
  anywhere in the product. By the time a human learns anything through eden's alerting system, they
  are, by design, already at the limit, not warned in advance of it. Per §2d.1, even that single
  email may never fire at all for the dominant gateway-proxy traffic shape, since
  `evaluate_budget_alerts()` reads the same permanently-stuck-at-$0 `budget_consumption` path.
- **Enforcement-side signal**: when `QuotaEnforcementMiddleware` blocks a request, the caller gets
  an HTTP 429 with a machine-readable body (`quota_exceeded`) — fine for an SDK to catch, but not a
  human-facing "you're over budget" moment. And per §2d.4, the limit that produces that 429
  (`org_resource_limits.cost_hard_limit_usd`) is not the number the customer configured via the
  Budgets API at all — so even a customer who *did* successfully call the (UI-less) budget-set
  endpoint and lowered their cap would see requests keep sailing through past their configured
  number, then start failing later for a reason they can't see or edit anywhere in the product.

### What a genuinely usable version looks like

The encouraging part is that the backend is not the blocker for most of this — closing the
human-facing gap is a small lift, not a rebuild:
1. **Setting.** Build the form. The typed contract already exists on both sides
   (`upsertBudget()` ↔ `POST /orgs/{org_id}/budget`) — soft/hard USD inputs, a window picker, an
   alert-threshold multiselect (defaulting to `[50, 80, 100]`), and an `action_on_exceed` selector.
   This alone gives the org owner, for the first time, an actual way to set a cap without `curl`.
2. **Monitoring.** This is where §4a's write-path fix pays double: routing `record_usage()` through
   `_emit_gateway_telemetry()` collapses the "telemetry" and "gateway budget" numbers into one, so
   the dashboard stops contradicting itself in its own caption text.
3. **Alerting.** Mount `NotificationsProvider` (one `<NotificationsProvider>` wrapper in the app
   layout plus a bell icon) and wire it to the 50/80/100 thresholds that already fire on the
   backend. Add a soft-alert recipient list independent of `org_members` (mirroring LiteLLM's
   team/finance routing) — this is §4a's Recommendation 2, and this trace is independent
   corroboration that it's worth prioritizing: it's the only lever that makes the *existing*
   50%/80% early-warning design (already coded, already debounced, already idempotent) reach a
   human before the hard stop.
4. **Per-team/per-project caps** (§4a's schema sketch) are valid and well-reasoned, but from a UX
   lens they're the *third* priority, not the first — shipping `scope_id` without first shipping an
   editing UI just adds a second thing that's only reachable by `curl`. Sequence the editing UI and
   alert-surfacing ahead of or alongside the scope migration, not after.

### Why this matters

§1's own sourced comparator research makes the stakes concrete: a runaway agent burned ~$22/day,
invisible to downstream cost tracking, until the invoice arrived (GitHub issue #5598). That's
precisely the failure mode a "set a cap, get warned before it's blown" flow exists to prevent — and
it's precisely the flow eden has built the *backend* half of (fail-closed hard enforcement, an
already-designed three-tier alert system, org isolation) while leaving the *human* half
(configure it, see it agree with itself, get warned early, know who to route the warning to)
effectively unshipped. Eden's backend cost-governance sophistication is real and, per §3, ahead of
Helicone's — but sophistication that's invisible or unreachable to the buyer persona doesn't move a
sales conversation or prevent a surprise invoice. Ranked by cheapest fix / highest visible impact:
mounting an already-built notification provider and wiring an already-typed form to an
already-working endpoint should rank above the deeper Path A/Path B schema work in sequencing — not
instead of it, but ahead of it — because none of the backend correctness work is legible to a
customer until there's a UI surface reading it.

---

## 3. Verdict: what's the real, scoped cost-governance gap?

**Eden already has a real user-facing budget/alert feature that clears the Helicone bar and
approaches the Portkey/LiteLLM bar at a single scope.** It ships org-level budget config, a live
ticker, threshold alert log (in-app + email), and a portal Cost page with hard enforcement
(fail-closed) by default — ahead of Helicone (confirmed no hard-cap enforcement in 2026 sources)
and comparable to Portkey's Enterprise tier / LiteLLM's org-level `max_budget`, but at one scope
only, and — per §2d — with a consumption-tracking split severe enough that the dashboard showing
that org-level number can be silently wrong indefinitely, and a limit-config split severe enough
that the number the customer configures isn't the number enforced.

**Gaps genuinely in the "budgets/alerts/attribution" lane — worth building:**
1. **No team/key-level budget scoping.** Both 2026-refreshed comparators (Portkey's
   org→workspace→key→tag hierarchy, LiteLLM's key/team/user/customer/project scopes) treat this as
   table stakes. Eden's schema (`052_budgets.py`) has no room for it without a migration.
2. **The Path A/Path B consumption split (§2d.1-§2d.3) and the limit-config split (§2d.4) should be
   fixed *before* or *as part of* adding team/agent scoping** — extending a schema that's already
   silently wrong at one scope will just replicate the bug at N scopes. This reframes the
   recommendation below: the data-model work for multi-scope budgets and the fix for §2d are the
   same piece of work, not sequential ones.
3. **No customer-facing way to configure or see alerts for the feature that exists** (see
   **User Experience & Value** above). The backend contract for setting a budget
   (`POST /orgs/{org_id}/budget`) and for in-app alerting (`notifications` table +
   `NotificationsProvider`) is fully built; neither has a reachable UI in the portal today. This is
   arguably the cheapest, highest-visible-impact fix in this file — cheaper than the schema work in
   item 2 — and should be sequenced alongside or ahead of it, not after.
4. **No spend-anomaly detection.** Neither eden's budget system nor its internal cost ledger does
   anything beyond static threshold crossings (50/80/100%). CloudZero's 2026 positioning
   (same-day, causally-explained anomaly alerts — "which team/workload caused this spike") is a
   materially different capability from threshold alerting and one no LLM-native competitor in
   this set (Portkey/Helicone/LiteLLM/OpenRouter) does either — a genuine differentiation
   opportunity, but a bigger lift (needs a baseline/expected-spend model, not just a comparator) and **not** included in the two recommendations below; flagging as a candidate for a future pass rather than scoping it now.

**One item is *not* a budgets/alerts/attribution gap — it's a model-gateway-completeness gap, and
should be kept separate:**
5. **Cost-aware model routing (`_select_provider` reachability).** `AIGateway._select_provider`
   exists, picks the cheapest provider meeting quality/latency constraints, and is wired to
   `budget_service.record_usage` for spend recording (`ai_gateway.py:711-721`) — but it is
   unreachable from the one HTTP path (`/gateway/v1/chat/completions`) real customer requests take
   (§2c). This file does not own the decision about what to do with that code, and — per the
   sibling finding that does own eden's AI-gateway/routing strategy
   (`features/10-model-gateway.md`) — that decision has already been made: after tracing every
   call site, that finding recommends **deleting** `_select_provider`/`_select_fallback`/
   `CircuitBreaker`/`register_providers_from_env` and the provider-wrapper classes outright
   (~900 lines of `ai_gateway.py`), not reconnecting them — because there is no live activation
   surface for multi-provider routing on either side: `/gateway/v1` resolves a single upstream
   provider per request by design, and eden's own internal LLM traffic already runs through a
   separate, live client (`eden.llm.client.OpenRouterClient`) with its own circuit breaker, so
   wiring `AIGateway`'s routing back in would duplicate infrastructure that already ships. **This
   file should not describe `_select_provider` as "cheap to reconnect"** — that framing is
   superseded by `10-model-gateway.md`'s definitive delete verdict. The only claim this file makes
   is narrower and still true: the code is not dead in the sense of being unmaintained or
   unexercised (it runs in offline replay/verification, §2c), it is simply orphaned from the live
   request path — and per the sibling finding, it is being removed rather than reconnected.

---

## 4. Recommendation (budgets/alerts/attribution lane only)

### 4a. Concrete data-model sketch for team/agent-scoped budgets

Informed directly by §1's LiteLLM/Portkey findings: LiteLLM's win is **one shared budget object
referenced by scope**, not a table per scope type; its precedence rule is explicit and
documented; and its enforcement counter is a fast synchronous cache, with Postgres as settlement,
not the read path a live request blocks on. Portkey's `Usage & Rate Limit Policies` shows the
alternative shape — conditions/`group_by` over metadata instead of fixed scope columns — but that
generality isn't needed yet for eden's two concrete scopes (team, agent); a LiteLLM-style explicit
scope column is simpler to reason about and enforce, and matches eden's existing `org_id`-keyed
tables closely enough to be an additive migration rather than a parallel system.

**Schema (extends `052_budgets.py`, does not replace it):**

```sql
-- One budget config row per scope, replacing the org_id-only PK.
-- scope_type + scope_id together identify what's being capped;
-- org_id is retained on every row for RLS / tenant isolation and
-- so a single query can still answer "all budgets for this org."
ALTER TABLE budgets
    ADD COLUMN scope_type   VARCHAR(16) NOT NULL DEFAULT 'org',   -- 'org' | 'team' | 'agent' | 'key'
    ADD COLUMN scope_id     VARCHAR(128) NULL;                    -- NULL when scope_type = 'org'
-- Existing rows backfill scope_type='org', scope_id=NULL — no data migration beyond the DEFAULT.
DROP INDEX idx_budgets_org_window;              -- was UNIQUE (org_id, "window")
CREATE UNIQUE INDEX idx_budgets_scope_window
    ON budgets (org_id, scope_type, COALESCE(scope_id, ''), "window");

ALTER TABLE budget_consumption
    ADD COLUMN scope_type   VARCHAR(16) NOT NULL DEFAULT 'org',
    ADD COLUMN scope_id     VARCHAR(128) NULL;
DROP INDEX idx_budget_consumption_active;        -- was UNIQUE (org_id, "window", window_start)
CREATE UNIQUE INDEX idx_budget_consumption_active
    ON budget_consumption (org_id, scope_type, COALESCE(scope_id, ''), "window", window_start);

ALTER TABLE budget_actions
    ADD COLUMN scope_type   VARCHAR(16) NOT NULL DEFAULT 'org',
    ADD COLUMN scope_id     VARCHAR(128) NULL;

-- LiteLLM-style explicit precedence, made concrete for eden's two
-- new scopes: agent-scoped budget (if one exists for the acting
-- agent) is checked first, then team-scoped (if the agent/key
-- belongs to a team with its own budget), then org-scoped as the
-- always-present fallback. Unlike LiteLLM's "team overrides key
-- owner" rule, eden's narrower precedence is: most-specific
-- configured scope wins; org is the floor, never overridden.
```

**Service-layer change:** `budget_service.get_consumption(org_id, *, window, scope_type="org",
scope_id=None)` and `record_usage(org_id, cost_usd, *, scope_type="org", scope_id=None)` gain the
two new keyword-only parameters (default preserves today's org-only behavior for every existing
caller — no call-site churn required for the rollout). `record_usage()` is called **twice** per
billable event once agent/team scoping ships — once at `scope_type="org"` (today's behavior,
unchanged) and once at the most specific scope known for that request (e.g. `scope_type="agent",
scope_id=agent_id`) — so a team/agent cap and the org cap are both kept current from the same
write, rather than requiring a second independent rollup.

**Fixing §2d as part of this, not after it:** the new `record_usage()` call must be added to the
actual live write path — `_emit_gateway_telemetry()` in `routes/gateway.py`, right after
`_stamp_gateway_cost_usd()` computes `cost_usd` — rather than only to `AIGateway.complete()` (§2c,
unreachable) or `CostTracker.track()` (§2d, also unreachable). This single change closes §2d.1's
drift for the dominant traffic path *and* gives the new team/agent scopes a working consumption
signal from day one, instead of shipping scoped budgets on top of the same broken plumbing.
`QuotaEnforcementMiddleware` should also be pointed at the same `scope_id`-aware `get_consumption()`
call (or `UsageService` extended with matching scope parameters) so the enforcement decision and
the dashboard/alert numbers read the same rollup — closing §2d.4's config split at the same time by
making `budgets.cost_hard_limit_usd` (whichever scope it's attached to) the one limit
`QuotaEnforcementMiddleware` actually checks, rather than leaving `org_resource_limits` as an
uncoordinated second cap.

1. **Add `scope_type`/`scope_id` to the existing budget schema and API per the sketch above**,
   defaulting to org-scope when absent, so `budgets`/`budget_consumption`/`budget_actions` gain two
   key columns rather than a parallel system, and reuse the existing ticker/alert/audit-log
   machinery (`evaluate_budget_alerts`, `_notify_budget_alert`, `QuotaEnforcementMiddleware`)
   end-to-end. Directly closes the gap vs. Portkey's workspace/key tiers and LiteLLM's team/key/user
   scopes, and — because the write path must be corrected to make the new scopes meaningful — closes
   §2d.1/§2d.3/§2d.4 in the same migration rather than leaving them as a separate cleanup.
2. **Add a team-scoped *soft*-alert email-recipient list, separate from the hard-block owner
   gate**, mirroring LiteLLM's team soft-budget-alert pattern (alert routed to finance/team-lead
   emails, independent of who owns the org). This is a small, additive change to
   `_notify_budget_alert()` and doesn't require the full scope migration in (1) to land first if
   sequenced as an org-level feature initially.

**Explicitly not recommended in this file:** wiring `_select_provider`/`BudgetEnvelope`-style
budget-aware model downgrade into the live gateway request path. `10-model-gateway.md` recommends
deleting that code outright (§3 item 5) — this file has no dependency on that decision either way,
since the write-path fix above targets `_emit_gateway_telemetry()`, not `AIGateway.complete()`.

---

## Sources
- [Portkey: Enforce Workspace Budget and Rate Limits](https://portkey.ai/docs/product/administration/enforce-workspace-budget-limts-and-rate-limits)
- [Portkey: How to implement budget limits and alerts in LLM applications](https://portkey.ai/blog/budget-limits-and-alerts-in-llm-apps/)
- [Portkey: AI cost observability — a practical guide](https://portkey.ai/blog/ai-cost-observability-a-practical-guide-to-understanding-and-managing-llm-spend/)
- [Portkey: Usage & Rate Limit Policies](https://portkey.ai/docs/product/enterprise-offering/budget-policies)
- [TrueFoundry: Understanding Portkey AI Gateway Pricing For 2026](https://www.truefoundry.com/blog/portkey-pricing-guide)
- [Helicone: Cost Tracking & Optimization cookbook](https://docs.helicone.ai/guides/cookbooks/cost-tracking)
- [Zuplo: Best AI Gateways in 2026 (Helicone rate/budget caps)](https://zuplo.com/learning-center/best-ai-gateway-buyers-guide)
- [Tokonomics: Hard Spending Caps for LLM APIs](https://tokonomics.ca/blog/feature-hard-spending-caps)
- [Tokonomics: Helicone vs Tokonomics](https://tokonomics.ca/blog/helicone-vs-tokonomics)
- [TrueFoundry: Helicone Pricing 2026](https://www.truefoundry.com/blog/helicone-pricing)
- [LiteLLM: Team Soft Budget Alerts](https://docs.litellm.ai/docs/proxy/ui_team_soft_budget_alerts)
- [LiteLLM: Budgets, Rate Limits](https://docs.litellm.ai/docs/proxy/users)
- [LiteLLM: Spend Tracking](https://docs.litellm.ai/docs/proxy/cost_tracking)
- [LiteLLM: Database Schema and Models — DeepWiki](https://deepwiki.com/BerriAI/litellm/3.5.4-database-schema-and-models)
- [LiteLLM: Team Management — DeepWiki](https://deepwiki.com/BerriAI/litellm/3.5.2-team-management)
- [LiteLLM: Budget and Spend Tracking — DeepWiki](https://deepwiki.com/BerriAI/litellm/3.3-budget-and-spend-tracking)
- [LiteLLM homepage](https://www.litellm.ai/)
- [Stack Harbor: Deploying LiteLLM proxy with per-team budgets](https://stackharbor.com/en/knowledge-base/litellm-proxy-budgets-deploy/)
- [OpenRouter Usage Limits Explained](https://www.datastudios.org/post/openrouter-usage-limits-explained-rate-limits-spending-controls-provider-errors-fallbacks-byok)
- [OpenRouter 101: provider routing, price/floor/nitro sort](https://sidsaladi.substack.com/p/openrouter-101-the-complete-guide)
- [GitHub issue #5598, paperclipai/paperclip — runaway agent spend invisible until invoice](https://github.com/paperclipai/paperclip/issues/5598)
- [CloudZero: AI cost monitoring](https://www.cloudzero.com/blog/ai-cost-monitoring/)
- [CloudZero: The Complete Guide to Cloud Cost Management 2026](https://www.cloudzero.com/blog/cloud-cost-management/)
- [CloudZero: FinOps for AI](https://www.cloudzero.com/blog/finops-for-ai/)
- [Finout: Best AI Cost Observability Tools in 2026](https://www.finout.io/blog/best-ai-cost-observability-tools-in-2026)

## Eden code references
- `src/eden/api/routes/budgets.py` — budget admin/ticker/actions API (`:58`, `:119` call
  `budget_service.get_consumption`)
- `src/eden/services/budget_service.py` — budget CRUD (`:62` thresholds, `:215-269`
  `get_consumption`, `:275-361` `record_usage`, `:449` `evaluate_budget_alerts`, `:527`
  `_notify_budget_alert`, `:566` `upsert_budget`)
- `src/eden/api/middleware/quota_enforcement.py` — hard-limit enforcement, fail-closed (`:171`
  `_get_usage_service`, `:487`, `:553` `_check_hard_limits`, both calling `UsageService.get_budget_status`)
- `src/eden/services/usage_service.py` — second, independent budget-status computation (`:227-265`
  `get_current_spend`, `:268-330` `_sum_org_cost_usd` — the `max(events_sum, budget)` reconciliation
  that only protects Path B, `:334-478` `get_budget_status`, `:538` `get_usage_service()`)
- `src/eden/observability/telemetry_collector.py:696-819` — `_emit_billing_events`, the writer
  that lands live gateway traffic into `usage_events` via `UsageService.track_events_batch`
- `src/eden/api/routes/gateway.py:400-458` — `_emit_gateway_telemetry`, called on every proxied
  request; feeds `telemetry_collector` (Path B) but never calls `budget_service.record_usage`
  (Path A) directly
- `src/eden/optimization/cost_tracker.py` — `CostTracker.track()` (`:66-139`, unconditional PG
  mirror into `budget_consumption` via `record_usage`), `check_budget()` (`:141-172`, reads
  `get_consumption`); reachable only from `src/eden/api/routes/optimization.py` (orphaned surface,
  same as §2c)
- `src/eden/optimization/budget_envelope.py` — `BudgetEnvelope` dataclass documenting the "F83
  unify" gap between `budget_service` (PG) and `CostTracker` (Redis) explicitly in its own
  docstring; still unwired (`grep -rn "BudgetEnvelope(" src/eden` returns zero call sites)
- `src/eden/services/alert_email.py` — hard-breach email
- `clients/portal/src/app/(portal)/cost/page.tsx`, `clients/portal/src/lib/api/budget.ts` — portal
  Cost page; `budget.ts` exports only `get()`, no `set`/`upsert`
- `clients/portal/src/lib/api/resources.ts:2245` — `upsertBudget()`, a fully-typed second client
  wrapper for `POST /orgs/{org_id}/budget` with zero call sites anywhere in `clients/portal/src`
- `clients/portal/src/lab/cost/cost-spend-view.tsx:121-153` — read-only budget progress bar;
  `:137-139` captions it "gateway budget (separate from telemetry spend above)," the frontend's own
  acknowledgment of the §2d Path A/B split
- `clients/portal/src/hooks/use-notifications.tsx:57` — `NotificationsProvider`, a fully-built
  in-app alert consumer (polling, unread count, mark-read) never mounted anywhere in the app
- `src/eden/llmops/ai_gateway.py` — `AIGateway`, `_select_provider` (`:892`), `.complete()`
  (`:630-729`, includes `record_usage` call into `budget_service` at `:711-721`) — real cost-aware
  routing, reachable only from replay/verify paths (§2c); `ModelResponse.cost_source` (`:277-282`)
  — the only "reconciliation" reference in the codebase, aspirational/unimplemented (§2d.3).
  `10-model-gateway.md` recommends deleting `_select_provider` and its supporting classes outright
  (see §3 item 5 of this doc) — treat this citation as documenting existing, soon-to-be-removed
  code, not a reconnect candidate.
- `src/eden/time_travel/replayer.py:453`, `src/eden/improvement/replay_verify.py:355` — the only
  live call sites of `AIGateway.complete()`
- `src/eden/api/routes/llmops.py:583-599` — retired `/llmops/gateway/complete` stub (410, since
  2026-07-04) that used to be the HTTP path to `AIGateway.complete()`
- `src/eden/api/routes/gateway.py` (mounted `src/eden/api/app.py:1256`) — live
  `/gateway/v1/chat/completions` production route; calls `_call_upstream()` directly (`:1715-1719`),
  bypassing `_select_provider`; `enforcement_enabled` appears only in a comment (`:847`), never read
- `src/eden/autonomous/agent.py:1636-1655`, `src/eden/improvement/agent.py:956-960` — internal
  agent self-throttle, both read `budget_service.get_consumption()` (Path A) directly
- `src/eden/optimization/model_router.py`, `src/eden/optimization/__init__.py` — separate,
  budget-blind `ModelRouter`/`TaskClassifier` (task-complexity tiering, zero references to `budget`)
- `src/eden/llmops/cost_ledger.py`, `src/eden/llmops/feature_kills.py` — internal cost-ledger/kill-switch system (third, adjacent, internal-facing)
- `docs/specs/SOTA-PERF-COST-SCORECARD.md` — internal cost-hierarchy scorecard
- `src/eden/db_migrations/versions/052_budgets.py` (`:60,80,99` — org+window-only keys, no
  team/key column, `:62-63` `cost_soft_limit_usd`/`cost_hard_limit_usd` defaults),
  `134_budget_enforcement_default_true.py` — schema + enforcement-default migrations
- `src/eden/db_migrations/versions/002_phase_4_2_data_layer.py`, `015_regions_and_rls.py` —
  `org_resource_limits` origin, the separate table/migration lineage `QuotaEnforcementMiddleware`
  actually enforces against (§2d.4), unrelated to `052_budgets.py`
- `src/eden/workers/cron_tick.py`, `src/eden/evaluation/scheduler.py`, `src/eden/self_obs/scheduler.py`
  — eden's scheduled-job dispatchers; none contain a `budget_consumption` reconciliation task (§2d.3)

