# Pass 4 Notes — 06-cost-governance.md (Agent B: UX/Value)

Scope note: I did not edit the original doc. This file is my independent draft +
fact-check for synthesis. I did not coordinate with Agent A.

---

## USER EXPERIENCE & VALUE (primary — full draft)

### Who is the user, really?

The doc never names a persona; the code answers the question by omission. Budget
*editing* is gated to `require_org_owner` — the org owner, and only the org owner
(`src/eden/api/routes/budgets.py:88-91`, `POST /orgs/{org_id}/budget` handler
`upsert_budget`). Budget *alert emails* go slightly wider, to org owner **and**
admin emails pulled straight from org membership
(`src/eden/services/alert_email.py` — `_org_alert_recipients()`, `SELECT DISTINCT
u.email FROM users u JOIN org_members m ... WHERE m.role IN ('owner','admin')
... LIMIT 10`). There is no "finance," "billing," or "budget admin" role
anywhere in this path — the implicit persona eden built for is a
founder/eng-lead who *is* the org owner on a small team, not a dedicated
FinOps/finance stakeholder watching spend across many teams. That's a
reasonable bet for eden's actual customer size today, but it's worth being
explicit about, because it's the opposite of where the competitive set is
headed: LiteLLM's team soft-budget alerts explicitly route to "finance or a
team lead — not necessarily team members" (doc §1, LiteLLM section) — i.e.
alerting to *non-members*, a capability eden's `_org_alert_recipients()` query
structurally cannot express (it only ever resolves emails of people already in
`org_members`).

### Flow 1 — Setting a budget: real backend, missing product

This is the single biggest UX gap this pass surfaces, and it isn't in the
original doc at all. Trace the full "set a budget" path from the portal
outward:

- `clients/portal/src/lib/api/budget.ts:35-37` — the thin client the Cost page
  actually uses — exports exactly one function, `get()`. No `set`, `upsert`,
  or `update`. Read-only, by construction.
- `clients/portal/src/lib/api/resources.ts:2245-2261` — a **second**, unused
  client wrapper *does* define `upsertBudget(orgId, body)`, wrapping `POST
  /orgs/{org_id}/budget` with the exact typed body the backend expects
  (`cost_soft_limit_usd`, `cost_hard_limit_usd`, `enforcement_enabled`,
  `window`, `action_on_exceed`, `threshold_alert_pct`). I grepped the entire
  portal source tree for call sites of `upsertBudget` — `grep -rn
  "upsertBudget\b" clients/portal/src` returns exactly one line: the
  definition itself (`resources.ts:2245`). **Zero components call it.**
- `clients/portal/src/app/(portal)/cost/page.tsx` and
  `clients/portal/src/lab/cost/cost-spend-view.tsx:121-153` render the budget
  as a read-only progress bar + `BudgetChip` status pill. There is no input
  field, no "Edit budget" button, no settings-page link, no onboarding step
  that mentions setting a spend cap anywhere in the portal (checked
  `components/onboarding/ProductTour.tsx` — its only "budget" hits are an
  unrelated frame-render-time budget and a reference to the *autonomy* patch
  budget, not cost governance).
- I also checked the org-wide `settings-workspace-view.tsx` — one incidental
  "budget" hit, unrelated to cost config.

**Net: the only way to actually configure a budget in eden today is a raw API
call** (`curl -X POST /orgs/{org_id}/budget -d '{...}'`, or hand-rolling a
request against a route only discoverable by reading the OpenAPI schema or the
source). That's a fine workflow for the engineer who built the integration,
and a non-starter for the "team lead setting a budget cap" persona the task
brief asks about — that person is not going to curl an endpoint. The
frustrating part is how close this is to shipped: the backend contract,
validation, and even a typed frontend client function all already exist
(`resources.ts:2220-2261`); the only missing piece is a form. The doc's
framing that eden ships "a shipped, discoverable settings/dashboard surface,
not internal-only plumbing" (`06-cost-governance.md:174-177`) is accurate for
*viewing* spend, but overstates the *configuration* side — "discoverable
settings surface" is doing a lot of work in that sentence for a feature that,
per the grep above, has no editable settings surface in the product at all.

### Flow 2 — Monitoring spend: the dashboard visibly disagrees with itself

Separate from the doc's backend-only §2d drift analysis (Path A vs. Path B),
the *portal itself* surfaces two different cost numbers on the same page and
says so in the copy:

- The page's primary "Spend · 24h" KPI is sourced from **agent telemetry**
  (`cost/page.tsx:236-249`, `sourceLabel: "Telemetry · 24h"`), aggregated
  client-side from `agents[].costUsd24h`.
- The budget progress bar directly below it is captioned, verbatim, "**gateway
  budget (separate from telemetry spend above)**"
  (`clients/portal/src/lab/cost/cost-spend-view.tsx:137-139`).

That caption is the frontend admitting, in its own UI copy, to the exact split
the doc traces at the backend level in §2d — two independently-computed
numbers, shown stacked on one screen, with a footnote instead of a
reconciliation. For a customer this reads as "which number is my real spend?"
with no way to know from inside the product. Layer in §2d's finding that
`budget_consumption` (the number driving that second, "gateway budget" bar,
via `budget_service.get_consumption()`) can sit at **exactly $0.00
indefinitely** for an org whose traffic is 100% ordinary `/gateway/v1` calls,
and the practical experience is: a customer with real, growing upstream spend
opens their one Cost dashboard and sees a budget bar frozen at 0% used,
forever — while the *other* number on the same screen (telemetry-sourced) is
climbing normally. That's not a subtle drift bug at that point; it's a
dashboard actively telling a paying customer their spend controls aren't
tracking anything.

### Flow 3 — Getting alerted: designed for three tiers, delivered for one, and undeliverable in-app

`budget_service.evaluate_budget_alerts()` (`budget_service.py:449-511`) is a
genuinely well-built piece of alerting logic: debounced (~45s) so it doesn't
hammer Postgres on every dollar of spend, idempotent per threshold/window via
an action-log scan, and fires at each of 50/80/100% by default. What happens
to a human when it fires:

- **In-app**: writes a `notifications` row (`_notify_budget_alert()`,
  `budget_service.py:527`). The portal has a fully-built consumer for this —
  `clients/portal/src/hooks/use-notifications.tsx` defines a
  `NotificationsProvider` with 30s/300s adaptive polling, unread counts,
  mark-as-read, delete — but I grepped the entire portal tree for
  `NotificationsProvider` and it appears in exactly two files: its own
  definition (`use-notifications.tsx:57`) and a code comment in
  `resources.ts:175`. **It is never mounted anywhere in the app** — no
  provider wraps the layout, no bell icon, no toast, no notification panel
  exists in the rendered product. Every in-app alert eden's backend writes for
  a budget threshold crossing (50%, 80%, and 100%) is invisible to the
  customer. This is a striking, concrete finding on its own: a full
  notifications *system* (backend table + write path + a completely built,
  tested-shaped React provider) with zero UI surface consuming it anywhere in
  the product.
- **Email**: fires exactly once, only at the 100% (hard) threshold
  (`src/eden/services/alert_email.py:1-8` docstring: *"budget hard-limit
  (100%) breach"*; `send_budget_hard_limit_email`). The 50%/80% "early
  warning" thresholds — the entire point of having more than one threshold —
  produce **zero human-visible signal** anywhere in the product. By the time a
  human finds out anything through eden's alerting system, they are, by
  design, already at the limit — not warned in advance of it. Given §2d.1,
  even that single email may never fire at all for the dominant gateway-proxy
  traffic shape, since `evaluate_budget_alerts()` reads the same
  permanently-stuck-at-$0 `budget_consumption` path.
- **Enforcement-side signal**: when `QuotaEnforcementMiddleware` actually
  blocks a request, the caller gets a `429` with `{"detail": ..., "type":
  "quota_exceeded"}` (`src/eden/api/middleware/quota_enforcement.py:409-415`).
  That's a fine machine-readable contract for an SDK to catch and retry/back
  off on, but it is not a human-facing "you're over budget" moment — a team
  lead who isn't watching raw API error logs learns nothing from it. And per
  the doc's §2d.4, the limit that produces this 429
  (`org_resource_limits.cost_hard_limit_usd`, a separate plan-tier table) is
  **not the number the customer configured** via the Budgets UI/API at all —
  so even a customer who *did* successfully call the (UI-less) budget-set
  endpoint and lowered their cap would see requests keep sailing through past
  their configured number, then start failing later for a reason (a
  plan-tier cap) they can't see or edit anywhere in the product.

### What a genuinely usable version looks like — and why it's a small lift, not a rebuild

The encouraging finding here is that the *backend* is not the blocker for
most of this. Concretely, closing the human-facing gap doesn't require new
infrastructure:

1. **Setting**: build the form. The typed contract already exists on both
   sides (`upsertBudget()` in `resources.ts:2245` ↔ `POST
   /orgs/{org_id}/budget` in `budgets.py:88`) — this is a UI-only task:
   soft/hard USD inputs, a window picker (daily/weekly/monthly), an
   alert-threshold multiselect (defaulting to the existing `[50, 80, 100]`,
   `budget_service.py:62`), and an `action_on_exceed` selector
   (throttle/kill/alert). Ship this and the org owner has, for the first
   time, an actual way to set a cap without curl.
2. **Monitoring**: this is where the doc's own §4a/§2d fix pays double —
   fixing the write-path drift (routing `record_usage()` through
   `_emit_gateway_telemetry()` per the doc's recommendation) collapses the
   "telemetry" and "gateway budget" numbers into one, so the dashboard stops
   contradicting itself in its own caption text.
3. **Alerting**: mount `NotificationsProvider` (it's built — this is one
   `<NotificationsProvider>` wrapper in the app layout plus a bell icon) and
   wire it to the 50/80/100 thresholds that already fire on the backend. Add
   a soft-alert recipient list independent of `org_members` (mirroring
   LiteLLM's team/finance routing) as a small, additive change to
   `_notify_budget_alert()` — this is exactly the doc's own Recommendation 2
   (§4a item 2), and this UX trace is independent corroboration that it's
   worth prioritizing, not just a nice-to-have: it's the only lever that
   makes the *existing* 50%/80% early-warning design (already coded, already
   debounced, already idempotent) actually reach a human before the hard
   stop.
4. **Per-team/per-project caps** (the doc's §4a schema sketch): valid and
   well-reasoned, but from a UX lens it's the *third* priority, not the
   first — shipping `scope_id` without first shipping an editing UI just adds
   a second thing that's only reachable by curl. Sequence editing-UI and
   alert-surfacing ahead of or alongside the scope migration, not after.

### Why this matters

The doc's own sourced comparator research makes the stakes concrete: a
runaway agent burned ~$22/day, invisible to downstream cost tracking, until
the invoice arrived (`06-cost-governance.md:109-111`, GitHub issue #5598).
That is precisely the failure mode a "team lead sets a cap and gets warned
before it's blown" flow exists to prevent — and it's precisely the flow eden
has built the *backend* half of (fail-closed hard enforcement, a
already-designed three-tier alert threshold system, org isolation) while
leaving the *human* half (configure it, see it agree with itself, get warned
early, know who to route the warning to) effectively unshipped. Eden's
backend cost-governance sophistication is real and, per the doc, ahead of
Helicone's — but sophistication that's invisible or unreachable to the buyer
persona doesn't move a sales conversation or prevent a surprise invoice. If I
had to rank this pass's findings by "cheapest fix, highest visible impact,"
mounting an already-built notification provider and wiring an already-typed
form to an already-working endpoint would rank above the deeper Path A/Path B
schema work — not instead of it, but ahead of it in sequencing, because none
of the backend correctness work is legible to a customer until there's a UI
surface reading it.

---

## VERIFIED (independent fact-check, spot-checks of doc's claims)

- `POST /orgs/{org_id}/budget` is org-owner-gated via `require_org_owner`
  dependency — confirmed, `src/eden/api/routes/budgets.py:88-91`. GET/ticker/
  actions routes are gated only by `require_path_org_access` (any org member),
  not owner — confirmed at `:55`, `:113`, `:135`.
- Portal Cost page (`cost/page.tsx`) and `BudgetChip`/spend/drivers views are
  real and render live data — confirmed by direct read of
  `clients/portal/src/app/(portal)/cost/page.tsx` and
  `clients/portal/src/lab/cost/cost-spend-view.tsx`.
- `budget_service.evaluate_budget_alerts()` default thresholds `[50, 80, 100]`
  and debounce behavior — confirmed, `budget_service.py:449-462` (`~45s`
  debounce via `_ALERT_EVAL_DEBOUNCE_S`, idempotent scan of recent
  `budget_actions`).
- `BudgetEnvelope` (`src/eden/optimization/budget_envelope.py`) — read the
  full file: a well-formed dataclass with `from_budget_service`/
  `from_cost_tracker` constructors, `is_over_soft`/`is_over_hard`, `as_dict`.
  Confirmed doc's "still unwired" claim independently: `grep -rn
  "BudgetEnvelope(" src/eden --include="*.py"` returns zero call sites outside
  its own class-method definitions.
- `QuotaEnforcementMiddleware` blocks with HTTP 429 and JSON body `{"detail":
  ..., "type": "quota_exceeded"}` — confirmed,
  `src/eden/api/middleware/quota_enforcement.py:409-415`.

## NEW FINDINGS (not in the original doc — UX-specific, code-grounded)

1. **Budget editing has no UI anywhere in the portal.** `clients/portal/src/
   lib/api/budget.ts:35-37` (the client the Cost page actually uses) exposes
   only `get()`. A second, unused client wrapper,
   `resources.ts:2245 upsertBudget()`, wraps the working `POST
   /orgs/{org_id}/budget` endpoint but has zero call sites anywhere in
   `clients/portal/src` (verified via grep). The only way to set a budget
   today is a direct API call — there is no discoverable settings surface for
   the "configure my cap" half of the feature, only for the "view my spend"
   half.
2. **The in-app notification system for budget alerts is fully built and
   completely unmounted.** `clients/portal/src/hooks/use-notifications.tsx`
   defines a complete `NotificationsProvider` (polling, unread count,
   mark-read, delete) that consumes the same `notifications` table
   `_notify_budget_alert()` writes to (`budget_service.py:527`) — but
   `NotificationsProvider` is never rendered/mounted anywhere in the app
   (grep across `clients/portal/src` finds it only in its own definition file
   and a code comment). The 50%/80% early-warning thresholds
   `evaluate_budget_alerts()` computes produce literally zero human-visible
   output anywhere in the product; only the 100% hard-breach email is
   deliverable to a human.
3. **Alert-threshold design (3 tiers) vs. delivery (1 tier, 1 channel).**
   `evaluate_budget_alerts()` is architected for graduated 50/80/100% warning,
   but per finding #2, only the 100% tier reaches a human at all (via email);
   the 50/80% tiers are backend-only today. This is a design/delivery gap the
   original doc doesn't surface (it documents the alert *logic* accurately
   but doesn't trace whether alerts are actually visible to end users).
4. **Alert recipients are structurally limited to org members.**
   `alert_email.py`'s `_org_alert_recipients()` queries `org_members` for
   `role IN ('owner','admin')` — there's no way to route a budget alert to a
   non-member email (e.g., a shared finance inbox), unlike LiteLLM's
   team-soft-alert pattern the doc itself cites approvingly in §1. Concretely
   grounds the doc's Recommendation 2 (§4a) in a specific code constraint.
5. **The portal UI itself visually admits the Path A/Path B split the doc's
   §2d documents at the backend level.** `cost-spend-view.tsx:137-139` labels
   the budget progress bar "gateway budget (separate from telemetry spend
   above)" right next to a differently-sourced "Spend · 24h" KPI — i.e. the
   product surfaces two disagreeing cost numbers on one screen with a
   footnote rather than a reconciliation. Independent, UI-level corroboration
   of §2d's backend-level finding.
6. **Cross-doc tension worth flagging to synthesis (not a "fact error" in
   06, but a real inconsistency between docs):** `06-cost-governance.md`
   §3 item 4 frames `AIGateway._select_provider` as "cheap to reconnect if/when
   [a separate decision] is made," deferring the call to whichever finding
   owns AI-gateway strategy. That finding is `10-model-gateway.md`, and its
   verdict (independently re-checked, `10-model-gateway.md` line ~57) is not
   "reconnect if wanted" — it's an explicit, high-confidence recommendation to
   **delete** `_select_provider`/`_select_fallback`/`CircuitBreaker`/
   `register_providers_from_env` outright ("definitively, not 'either/or'"),
   ~900 lines of `ai_gateway.py`. 06's "cheap to reconnect" framing (line
   439-443) reads as still-live optionality that the sibling doc has already
   foreclosed. Synthesis should reconcile: either 06's §3 item 4 should note
   the sibling doc's DELETE verdict explicitly, or the "cheap to reconnect"
   language should be softened/removed since the option it describes is
   recommended for deletion elsewhere in the same review.
7. **Minor terminology inconsistency across docs:**
   `01-competitor-matrix.md:511` calls `AIGateway` "dormant," while
   `06-cost-governance.md:253-256` explicitly argues against exactly that
   framing ("this is a materially different — and more precise — finding than
   'dormant/unused': the code isn't dead, it's orphaned from the production
   request path"). Not a factual conflict (both are describing the same
   underlying reality), but worth aligning terminology across docs in
   synthesis since 06 makes a point of distinguishing the two framings.

## CUT (candidates for trimming — quote + reason)

- No content in `06-cost-governance.md` struck me as false or filler on a
  full read — Agent A owns the primary fact-check pass and I did not find
  contradicting evidence in anything I independently verified (see VERIFIED
  above). I'm not proposing cuts to the doc's existing analysis.
- The one soft candidate for trimming, flagged for synthesis discretion, not
  as an error: §1's Portkey/LiteLLM/OpenRouter/CloudZero competitor writeups
  (lines 27–140) are long relative to how much of that material actually
  informs §4's recommendations — the §4a data-model sketch draws specifically
  on the LiteLLM shared-budget-object and Portkey policy-object framing
  (already called out inline), but the OpenRouter and CloudZero sections
  (lines 101–127) don't connect to any recommendation in §4 and read more as
  landscape completeness than load-bearing evidence. Not "cut," but a
  candidate for moving to an appendix/summary table if the doc needs to
  shrink — this is a judgment call for synthesis, not a factual issue.
