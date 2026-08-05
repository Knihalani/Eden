# Pass 4 Notes — 06-cost-governance.md — Agent A (Fact-Verifier & Pruner)

Scope: re-ground every eden-code claim against current source, re-verify the "$0 forever for
gateway-proxy orgs" finding with fresh evidence, prune false/speculative/redundant content, draft
a first-pass UX & Value section. Did not coordinate with Agent B.

---

## Headline re-verification: does budget tracking stay at $0 forever for pure gateway-proxy orgs?

**CONFIRMED — TRUE, and I found a piece of first-party evidence pass 3 didn't cite that makes
this stronger, not weaker.**

`src/eden/api/routes/gateway.py:844-848` (inside `_get_or_build_upstream_client`, the function
that builds/caches the raw `AsyncOpenAI` client `_call_upstream()` uses) contains an explicit
engineering comment:

```python
# Wave 4 note: budget ``record_usage`` on the success path is
# intentionally deferred — cost already flows through the usage /
# quota snapshot pipeline; wiring a second write here is invasive.
# Free-tier ``enforcement_enabled=True`` (defaults + migration 134)
# is the cost-control gate for new orgs.
```

This is a first-party admission that the gap is **known and intentional**, not an oversight —
someone on the eden team looked at this exact spot and chose not to wire `record_usage()` in,
reasoning (correctly, per §2d Path B) that hard *enforcement* still works via `UsageService`. What
this comment does not acknowledge is that the **dashboard/alert/self-throttle** consumers (Path A)
were left silently wrong as a side effect — which is exactly the doc's finding. Recommend citing
this comment directly in the doc as the strongest single piece of evidence for §2d; it's better
than any grep because it's the codebase admitting the tradeoff in its own words.

I independently re-traced the full mechanism and it holds:
- `_call_upstream()` (`gateway.py:1715-1719`) calls the raw `AsyncOpenAI` SDK client directly
  (`client.chat.completions.create(...)`) — not `eden.llm.client`'s higher-level wrapper class.
- That higher-level wrapper's `_log_usage()` method (`src/eden/llm/client.py:648-666`) is the one
  that calls `eden.llmops.cost_ledger.schedule_record_from_usage` (which eventually calls
  `record_usage`) — but `gateway.py` never instantiates or calls that wrapper; it only imports the
  unrelated `get_async_openai_client()` factory function from the same module (`gateway.py:835`).
  This is a second, independent confirmation (via a completely different code path than the one
  pass 3 traced) that live `/gateway/v1` traffic never reaches `record_usage()`.
- `record_usage()`'s three real callers (`cost_tracker.py:132`, `cost_ledger.py:316`,
  `ai_gateway.py:721` — I re-verified all three exact line numbers via grep, all match) are
  confirmed unreachable from `/gateway/v1` traffic, as pass 3 found.
- `evaluate_budget_alerts()` (`budget_service.py:449`) is only called from the same three
  unreachable sites (`cost_tracker.py:139`, `cost_ledger.py:319`, and inside `budget_service`
  itself) — so alert emails for a gateway-proxy-only org's real spend genuinely never fire.
- `QuotaEnforcementMiddleware` never reads the `budgets` table at all — re-ran
  `grep -n "FROM budgets\|budgets\.\|budget_service" src/eden/api/middleware/quota_enforcement.py`
  → zero hits. Confirms §2d.4's limit-config split independently.

**Net: the "$0 forever" finding is correct and, if anything, under-cited — the strongest evidence
(the Wave-4 comment) wasn't in the doc.**

---

## VERIFIED (line-level re-check against current source — all passed)

Every numbered citation below was independently re-derived (not just grepped for existence) and
matches the doc exactly:

- `src/eden/services/budget_service.py`: `DEFAULT_ALERT_THRESHOLDS` at `:62` ✓, `get_consumption`
  at `:215` ✓ (returns `{"cost_usd": 0.0, "source": "defaults"}` when no row/no client — read the
  actual function body, confirmed), `record_usage` at `:275` ✓, `evaluate_budget_alerts` at `:449`
  ✓, `_notify_budget_alert` at `:527` ✓, `upsert_budget` at `:566` (doc says `:573` — off by 7
  lines, the def line vs. a later line in the signature block; immaterial).
- `src/eden/api/routes/budgets.py`: `get_budget` calls `budget_service.get_consumption` at `:58`
  ✓, `ticker` calls it at `:119` ✓ (exact match via grep). Route docstring itself states: *"The
  middleware enforcement is done by `QuotaEnforcementMiddleware` via `UsageService.get_budget_status`;
  this route is the read + admin surface"* — first-party confirmation of the Path A/Path B split
  from inside the code's own docstring, not just inferred.
- `src/eden/api/middleware/quota_enforcement.py`: `_get_usage_service` at `:171` ✓, calls into it
  at `:487` and `:553` ✓, `_check_hard_limits` at `:537` (doc cites `:553` as the check call site,
  correct).
- `src/eden/services/usage_service.py`: `_sum_org_cost_usd` at `:268-330` ✓ — read the full body;
  confirmed it sums `usage_events` + `customer_cost_events` and takes `max()` against
  `budget_consumption`, exactly as described, including the exact docstring rationale about
  OpenRouter/cost_ledger dual-writing both tables. `get_budget_status` reads
  `org_resource_limits.cost_hard_limit_usd` (`:452-457`) ✓.
- `src/eden/api/routes/gateway.py`: `_emit_gateway_telemetry` at `:400` ✓ builds a
  `TelemetryEvent(event_type="llm_completion", ...)` — confirmed `"llm_completion"` is in
  `telemetry_collector.py`'s `billable_event_types` frozenset (`:726-737`), so this event really
  does land in `usage_events` via `_emit_billing_events` → `UsageService.track_events_batch`. Also
  confirmed the `enforcement_enabled` comment-only claim: `grep -n "enforcement_enabled"
  src/eden/api/routes/gateway.py` → only `:847`, a comment, exactly as the doc states. `_call_upstream`
  at `:1715-1719` ✓ verbatim match.
- `src/eden/optimization/cost_tracker.py`: read in full. `CostTracker.track()` unconditionally
  mirrors into PG via `record_usage` (`:132`) ✓, has the exact "F83 unify" framing pass 3 quotes.
  **Correction**: doc says `grep -rln "CostTracker()"` returns `optimization/__init__.py` AND
  `api/routes/optimization.py`; re-running that exact grep returns **only**
  `api/routes/optimization.py:180`. `optimization/__init__.py` only *imports/re-exports* the
  `CostTracker` class, it doesn't instantiate it (`CostTracker(` with no `()` immediately after
  wouldn't match the grep pattern used, or `__init__.py`'s import line doesn't contain the literal
  string `CostTracker()`). The underlying conclusion (reachable only from
  `routes/optimization.py`) is still correct — just the specific grep-result claim is imprecise.
  Low-stakes, worth a one-line fix, not a structural problem.
- `src/eden/optimization/budget_envelope.py`: read in full. `is_over_soft`/`is_over_hard` at
  `:143,146` — real dataclass logic (`cost_usd >= soft_limit_usd` style checks), matches the
  KNOWN-SUBSYSTEMS.md characterization. Docstring confirms "F83 unify" framing and "different
  windows and storage backends" language pass 3 paraphrased accurately. `grep -rn
  "BudgetEnvelope(" src/eden` → zero call sites, re-confirmed, still dead.
- `src/eden/optimization/model_router.py`: `grep -n "budget"` → zero matches, re-confirmed
  budget-blind.
- `src/eden/autonomous/agent.py:1636-1655`, `src/eden/improvement/agent.py:956-965`: both read
  verbatim, both call `budget_service.get_budget`/`get_consumption` directly (Path A) for
  self-throttle/plan-candidate generation, exactly as cited.
- `052_budgets.py`: line numbers `:60,80,99` (org_id columns across the three tables) and `:62-63`
  (soft/hard USD defaults, `0.80`/`1.00`) — exact match.
- `134_budget_enforcement_default_true.py`: `:31` (`ALTER COLUMN enforcement_enabled SET DEFAULT
  TRUE`) and `:39-41` (the `UPDATE budgets ... WHERE ... cost_hard_limit_usd <= 4.0` block) — exact
  match.
- `002_phase_4_2_data_layer.py` / `015_regions_and_rls.py` as the `org_resource_limits` migration
  lineage — confirmed, `002_...` creates the table (`:83`), `015_...` references it as an existing
  RLS pattern precedent.
- `docs/specs/SOTA-PERF-COST-SCORECARD.md:29` — "Org spend budgets / kill switches: Cost ledger
  (W7), FinOps explorer+kills (W8), N22 autonomy bounds (W24), evolution spend (W25) — **MET**" —
  quoted accurately (doc's §2e paraphrase includes the N22/W24/W25 detail correctly elsewhere).
- `cron_tick.py` / `evaluation/scheduler.py` / `self_obs/scheduler.py`: read/grepped. No
  `budget_consumption`-reconciliation step exists in any scheduled job dispatcher — confirmed.

## Correction to a specific evidentiary claim (§2d.3)

The doc states: *"`grep -rln "reconcil" src/eden` returns exactly one hit outside this file's own
analysis — `src/eden/llmops/ai_gateway.py:281`... aspirational, not implemented."*

Re-running `grep -rln "reconcil" src/eden --include="*.py"` today returns **nine** files, not one:
`api/utils/clerk_client.py`, `api/routes/scim.py`, `llmops/cost_resolver.py`, `llmops/ai_gateway.py`,
`services/invitation_service.py`, `issues/models.py`, and three migration files (`084_agent_issues.py`,
`081_org_cost_overrides.py`, `142_session_summaries.py`). I read every hit. None of them is a
`budget_consumption` reconciliation job:
- `clerk_client.py`, `scim.py`, `invitation_service.py` — webhook/IdP-sync "reconcile later"
  language, unrelated to cost.
- `issues/models.py`, `084_agent_issues.py` — "F28↔F29 kind reconciliation," an issue-taxonomy
  concept, unrelated to cost.
- `142_session_summaries.py` — "reconciled against what traces actually store" in a schema-notes
  docstring, unrelated to cost.
- `cost_resolver.py:24` — same rhetorical pattern as the `ai_gateway.py:281` docstring the doc
  already cites (a `cost_source="unknown"` field so "observability can flag this for review");
  also aspirational, not a job.
- `081_org_cost_overrides.py:33` — this one is genuinely cost-adjacent and worth flagging as new
  context: `org_cost_overrides.source` is an enum that includes a `'reconciliation'` value
  ("derived from observed invoice deltas"), i.e. this table lets ops manually correct the **price
  per token** used for billing (volume discounts, enterprise contracts) — a different axis
  entirely from the **consumption-aggregation drift** `budget_consumption` vs. `usage_events` has.
  It is not a job and does not touch `budget_consumption`.

**Verdict: the doc's substantive conclusion ("no reconciliation job exists between
`budget_consumption` and `usage_events`/`customer_cost_events`") still holds after checking all
nine hits, not just the one the doc cited** — but the "exactly one hit" framing is factually wrong
and should be corrected to avoid an easy "well actually there are 9" gotcha undermining an
otherwise solid finding. Recommend replacing the specific grep-count claim with "read all N hits;
none is a cost-reconciliation job" phrasing.

---

## CUT

1. **"Phase 2 Verdicts" section (entire section, ~19 lines) and "Phase 3 Verdicts" section (entire
   section, ~28 lines) at the bottom of the doc.**
   Quote (representative): *"**'Yes, eden has a real user-facing budget feature' (headline
   correction to an earlier wrong draft)** — VERDICT: KEEP (high confidence)... **Recommendation
   1 — team/agent-scoped budgets**... VERDICT: KEEP (high confidence)..."*
   Reason: this is 100% redundant meta-narration. Every substantive claim in these two sections
   (the budget feature is real, Rec 1 extends scope_id, Rec 2 is the soft-alert email, the
   BudgetEnvelope/ModelRouter rescope, §2d/§2d.3/§2d.4 findings) is already stated — usually more
   precisely — in §2-§4 of the body. These sections add zero new evidence; they only restate
   "VERDICT: KEEP" for things the body already asserts and re-summarize findings already made.
   This is classic multi-pass accretion cruft: process bookkeeping from earlier passes that should
   have been folded into the body or dropped once superseded. Recommend cutting both sections
   entirely in the final doc — if a "what changed each pass" record is wanted, it belongs in a
   changelog/appendix, not duplicated as prose in the main findings doc.

2. **Redundant "this pass" self-references scattered through §1 and §2.**
   Quote: *"**New this pass — actual data model + enforcement mechanics**..."*, *"**New this pass
   — the concurrency fix, not just the concurrency warning:**..."*, *"(new finding this pass)"*
   (×2 in §2d.3/§2d.4 headers, then repeated again in the Phase 3 Verdicts section).
   Reason: these pass-attribution labels were useful for the reviewer sequencing work across
   passes but are filler for a reader trying to understand eden's actual gap — the finding matters
   regardless of which pass surfaced it. Low-priority cut (labels are harmless, just verbose); flag
   for synthesis to decide whether multi-pass provenance is worth keeping for audit-trail purposes.
   Not recommending removal of the *content*, just the "(this pass)" tagging once sections are
   merged into a single stable narrative.

3. **The Portkey Enterprise pricing claim treated as established fact.**
   Quote: *"Enterprise pricing for the tier that unlocks these controls runs **$5k–$10k/month** per
   one comparison source — a real adoption barrier most eden-sized customers won't clear."*
   Reason: sourced to a single third-party blog post (TrueFoundry), not Portkey's own pricing page,
   and the "a real adoption barrier most eden-sized customers won't clear" clause is an
   unsubstantiated inference stacked on top of an unverified number. Not false, but should be
   softened to "one third-party estimate puts Enterprise pricing at $5k-$10k/month" and the
   "won't clear" editorializing cut — that's a claim about eden's customer base's budget that isn't
   sourced at all. This is Agent B's lane more than mine (competitor framing/positioning), flagging
   for their awareness rather than asserting a hard CUT.

## Not cut, but flag as unverifiable-by-me (out of scope for source-code grounding)

All §1 competitor claims (Portkey/Helicone/LiteLLM/OpenRouter/CloudZero mechanics) are sourced to
external web pages I did not re-fetch — that's expected for competitor research and each has a
citation, so I'm not treating uncited/unsupported the way I would an eden-code claim. Flagging only
the one above because its editorializing clause has no citation of its own.

---

## NEW FINDINGS (not in the doc, discovered this pass via direct code read)

**1. Three of the four Budgets API routes are backend-only — the "shipped, discoverable
dashboard surface" claim overstates what the portal frontend actually calls.**

I traced every frontend call site for the four budget routes cited in §2a:

- `GET /orgs/{org_id}/budget` (plain, non-ticker) — **used**. `clients/portal/src/lib/api/budget.ts`
  defines `budgetApi.get()`, called from `cost/page.tsx:81` and
  `components/providers/portal-catalog-sync.tsx:139`.
- `GET /orgs/{org_id}/budget/ticker` — **zero frontend call sites.**
  `grep -rn "budget/ticker\|budgetTicker\|getBudgetTicker" clients/portal/src` returns nothing.
  There is no `budgetApi.ticker()` or equivalent anywhere. The doc's claim ("live consumption +
  last-50 actions, polled every 5s by the portal") does not match what the frontend does.
- `GET /orgs/{org_id}/budget/actions` — **zero frontend call sites.** `resources.ts` defines
  `getBudgetActions()` (the function exists, fully typed) but `grep -rln "getBudgetActions"
  clients/portal/src` returns only `resources.ts` itself — no component imports/calls it. The
  backend route's own docstring says *"Portal 'Recent threshold events' feed"* but that feed does
  not exist in the shipped frontend.
- `POST /orgs/{org_id}/budget` (upsert — the only way a customer can *set* their own soft/hard
  limits) — **zero frontend call sites.** `grep -rln "upsertBudget" clients/portal/src` returns
  only `resources.ts`. I also grepped for any editable-input surface for
  `cost_hard_limit_usd`/`cost_soft_limit_usd` (`grep -rln "cost_hard_limit_usd\|cost_soft_limit_usd"
  clients/portal/src --include="*.tsx"`) and found only display sites (`cost/page.tsx`), never a
  form/input. **There is no UI anywhere in the portal for a customer to configure their budget
  limits.** The only way to call `upsertBudget` today is direct API access.

What actually renders on the Cost page: `budgetApi.get()` (plain GET) feeding a `BudgetChip`
(`clients/portal/src/lab/cost/cost-chrome.tsx:61`) and a spend/limit display
(`clients/portal/src/lab/cost/cost-spend-view.tsx`) — with an explicit inline comment worth
quoting because it independently corroborates the doc's Path A/B split from the *frontend* side:
`cost-spend-view.tsx:138` — `// gateway budget (separate from telemetry spend above)`. A portal
engineer left a comment acknowledging these are two different numbers, which is strong
corroborating (frontend-side) evidence for §2d's dual-path finding.

Also: `budgetApi.get()` is fetched via React Query with `SHELL_QUERY`
(`clients/portal/src/lib/portal-query.ts:21-25`) — `staleTime: 90_000ms` (`OBSERVE_STALE`),
`refetchOnWindowFocus: false`, `refetchOnMount: false`, **no `refetchInterval` at all**. This is a
cache-first, manual-refresh-on-stale pattern, not a 5-second poll. `grep -rn "refetchInterval"
clients/portal/src --include="*.tsx" --include="*.ts" | grep -i "cost\|budget"` returns nothing.

**Recommendation for synthesis:** revise §2a's "This is a shipped, discoverable settings/dashboard
surface, not internal-only plumbing" framing. It's accurate for *viewing* current spend/status
(read-only, and even that refreshes on a ~90s cache, not 5s), but **the config side (setting your
own budget) and the audit/ticker surfaces described in the API section are not reachable from the
UI at all** — a customer who wants to actually set a budget has to call the API directly, which
most eden customers won't do. This matters a lot for the "value" half of the UX assessment: the
feature's *enforcement* is real (fail-closed, on by default), but its *self-service configurability*
is not — today, org-owners inherit whatever `FREE_TIER_DEFAULTS` (`$3.20`/`$4.00`) or plan-tier
`org_resource_limits` sets, and cannot change it without going around the product.

**2. The Cost page's `BudgetChip`/spend display is fed by `budgetApi.get()`, which is Path A — so
the exact §2d.1 bug is directly, visibly reachable in the shipped UI, not just a backend
inconsistency.** This is implied but not stated explicitly in the doc: because `cost/page.tsx`
calls the plain `GET /orgs/{org_id}/budget` (Path A, via `budget_service.get_consumption`), a
gateway-proxy-only org's Cost page will show `$0 / $4.00 (0%)` in the `BudgetChip` indefinitely
while `UsageService`'s hard-enforcement gate silently blocks them once real spend crosses
`org_resource_limits`. A customer would see "green, 0% used" right up until requests start getting
blocked with no warning UI ever having fired — worth making this the lead concrete UX illustration
rather than the abstract `org_growth` scenario, since it's now traced end-to-end into the exact
rendered component.

**3. `GET /orgs/{org_id}/cost/comparison` (`src/eden/api/routes/cost.py`) is a third, previously
undocumented cost-read surface with the same root-cause blind spot, also unused by the frontend.**
Its own docstring states: *"Source of truth: the Redis hash `eden:cost:{org_id}:month:{YYYY-MM}`
written by `CostTracker` on every tracked event."* Since `CostTracker.track()` is unreachable from
live gateway traffic (§2c/§2d), this endpoint would also show nothing (`None`/"—", not `$0`, by
explicit design — the code comment says it returns `null` rather than a misleading zero) for a
gateway-proxy-only org. However: `grep -rln "getCostComparison" clients/portal/src` shows the
frontend wrapper exists in `resources.ts` but has **zero call sites** — so this is currently inert,
not a live-but-broken surface. Worth a one-line mention as corroborating evidence that the root
cause (CostTracker/Redis never fed by live gateway traffic) has now affected three independent
read surfaces (`budget_consumption` dashboard, `/optimization/budget`, `/cost/comparison`), two of
which are dead code in the frontend and therefore not currently customer-visible.

**4. `GET /orgs/{org_id}/optimization/budget` (`optimization.py:589-625`) is a fourth, separate
budget-status computation** — distinct from both Path A (`budget_service`) and Path B
(`UsageService`) — that reads `org_plans.plan_name` for limits and the same
`eden:cost:{org_id}:month:{...}` Redis hash for current spend (i.e., it's fed by `CostTracker`,
same as finding #3). Its frontend wrapper `getOptimizationBudget` (`resources.ts:776`) also has
**zero call sites**. Not worth a full write-up in the main doc (it's dead on both ends — backend
reachable only via the orphaned `optimization.py` router, frontend wrapper unused) but worth one
line acknowledging there are now confirmed to be **three independently-computed budget-status
code paths** in the backend (`budget_service`/Path A, `UsageService`/Path B,
`optimization.py`'s `CostTracker`-backed one), not two — the doc's "two independently-computed
budget-status paths" framing in §2d's title should probably become "at least three," even though
only two are reachable from any live surface (Path A read-only via the portal, Path B via
enforcement middleware) and the third is fully orphaned on both backend and frontend.

---

## USER EXPERIENCE & VALUE (first-pass draft — Agent B goes deeper)

**What a customer actually experiences today, traced end to end:**

A new org gets free-tier defaults ($3.20 soft / $4.00 hard, `enforcement_enabled=True`) with zero
setup required — genuinely good default-safe behavior, and rare among comparators (Helicone has no
hard-cap at all; Portkey gates budget controls behind Enterprise pricing). The Cost page shows a
`BudgetChip` and a spend number. For an org whose traffic is dominated by ordinary
`/gateway/v1/chat/completions` calls (the common case for a proxy product), **that spend number is
structurally wrong — permanently pinned near $0 — while the org's real spend accrues invisibly**
until `QuotaEnforcementMiddleware` (which reads a different, invisible-to-the-customer number,
`org_resource_limits`) starts silently blocking requests. From the customer's seat: green
dashboard, then a sudden 4xx with no preceding alert email, no threshold-crossing notification, and
no visual indication anything was ever wrong. This is close to the worst version of a budget
feature's UX — not "no budget feature" (eden clears that bar) but "a budget feature that actively
misleads you about your own risk," which is arguably worse for trust than having no dashboard at
all, since a customer who checked the dashboard specifically *to* avoid a surprise bill did the
right thing and got a false all-clear.

**The configurability gap compounds this.** Even a customer who reads the docs and wants to set a
tighter budget than the $4 free-tier default cannot do so from the product — `POST
/orgs/{org_id}/budget` has no UI. They'd need to call the API directly, which the overwhelming
majority of self-serve customers won't do. So the "user-facing budget feature" is, in practice,
**view-only telemetry of a number that's frequently wrong**, not a control surface. That's a
materially weaker value proposition than "eden has budgets/alerts at parity-minus-scope with
Portkey/LiteLLM," which is roughly how §3's verdict currently reads.

**What is genuinely good and should stay in the doc's framing:** fail-closed hard enforcement by
default (a real differentiator vs. Helicone), free-tier auto-provisioning with no setup, and the
in-app+email threshold-alert *mechanism* (`evaluate_budget_alerts`/`_notify_budget_alert`) is
well-built — it's just fed the wrong number for the dominant traffic shape, and the alerts are the
one thing that plausibly *would* fire correctly for the minority of traffic that does go through
judges/Improve/OpenRouter-direct/replay paths.

**Where I'd focus the value framing for synthesis:** the fix in §4a (wiring `record_usage` into
`_emit_gateway_telemetry`, the actual live write path) is not just a data-hygiene fix — it's the
difference between the Budgets feature being trustworthy vs. actively misleading for eden's most
common traffic shape. That should probably be framed as the single highest-leverage, lowest-effort
trust fix available in this file, ahead of the team/agent-scoping work, since scoping more budgets
that read the same broken number just multiplies the blast radius of the same bug (as §4a's own
sequencing note already argues — I'd make that argument more forcefully as a value/trust point, not
just an engineering-sequencing point). Recommend also surfacing the missing configuration UI
(finding #1 above) as a second, comparably cheap, comparably high-value fix — the backend upsert
endpoint already exists and is org-owner-gated; a settings form is a much smaller lift than the
scope_id migration and directly closes the "I can't actually control my own spend cap" gap.
