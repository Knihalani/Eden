# F12 Runtime Guardrails — Pass 4, Agent B (UX/Value)

Scope per assignment: primary deliverable is a deep USER EXPERIENCE & VALUE
section grounded in `evaluator.py`/`intervention.py`'s real promote/demote
mechanism and any policy-config UI; secondary is an independent fact-check
pass (I did not coordinate with Agent A, who owns the `trace_id`-bypass
verification — any overlap below is convergent, not copied).

All line numbers below are from direct reads this pass, not carried over
from the doc.

---

## USER EXPERIENCE & VALUE

### Who is the user, really?

The doc's own audit (and my independent re-check) establishes something the
current draft doesn't say out loud: **eden's own product surfaces are not
the user of this subsystem.** `POST /guardrails/evaluate` has exactly one
production caller repo-wide (`intelligence_guardrails.py:148`), and eden's
portal, both SDKs, the MCP server, and every internal worker/agent never
call it (KNOWN-SUBSYSTEMS.md's audit, independently spot-checked: zero hits
for `promote-judge`, `promote_to_guardrail`, `eval_to_guardrail`,
`EvalToGuardrailLink`, or `judge_link` anywhere under `clients/portal/src`).
So the realistic persona is **an external customer's backend/platform
engineer** calling the REST API directly to get a verdict, and — separately
— **a customer's safety/compliance lead** who wants to *author* org-level
policy. Today's product does not build a UI for either of these people; it
builds a read-only list view for a third persona (an internal admin
browsing what policies exist) and nothing for the two personas who'd
actually configure or act on this system.

### Flow 1 — authoring a policy today

There is no form. `GuardrailPolicy.create` (`policy.py:251-317`) is reachable
only via `POST /orgs/{org_id}/intelligence/guardrails/policies`
(`intelligence_guardrails.py:109-120`) — a raw JSON body with `name`, `type`
(one of 5 enum values: `prompt_injection`, `pii_redaction`, `hallucination`,
`content_policy`, `judge_link` — `policy.py:68-76`), `spec` (an untyped
`dict`, shape varies per `type` and is documented nowhere but the detector
source — e.g. `content_policy` needs `{"blocklist": [...]}` with optional
`re:`-prefixed regex entries, per `policy.py:342-354`), `action` (one of 5 —
`policy.py:81-83`), and `direction` (`policy.py:92`). A platform engineer
has to read Python source to know the JSON contract; there is no schema doc,
no example library, and no client-side validation anywhere in the portal.

I confirmed the portal never surfaces this endpoint at all.
`guardrails-detail-view.tsx` (full file read, 155 lines) and
`guardrails-list-view.tsx` (full file read, 199 lines) contain zero create,
edit, enable/disable, or delete affordances — the detail view is a `<dl>` of
stats plus three outbound links (Issue/Traces/Agent). The one interactive
tab beyond "Policies" (`GuardrailsTestView`, `guardrails-detail-view.tsx:129-154`)
explicitly renders `EmptyState({title: "Dry-run not connected", body:
"Guardrail test samples are not wired to an API yet..."})`, and the nav
component that would host it, `GuardrailsTabNav`
(`guardrails-chrome.tsx:44-64`), only ever renders a single "Policies" tab —
`parseGuardrailTab` (`guardrails-chrome.tsx:15-19`) hard-returns `"policies"`
for any input with the comment "Test dry-run is not a live surface." So
today's honest UX for "author a policy" is: *hit a REST endpoint directly,
with no documentation, no UI, and no way to preview effect before it goes
live* (creating a policy immediately sets `status='active'` and the
`InterventionEngine` starts consulting it on every `/evaluate` call —
`policy.py:237-240`).

**New finding, not in the current doc — the read-only viewer is itself
broken against its own backend.** The frontend's policy row type,
`GuardrailPolicyFixture` (`fixtures/guardrails.ts:23-38`), declares fields
`kind` (`"pii"|"toxicity"|"tool_allowlist"|"rate_limit"|"custom"`),
`severity`, `matchCount24h`, `lastHit`, `ruleSummary`, `agentId`, `issueId`,
`traceIds`. None of these exist on the real backend row. `_fetch_policies`'
SQL (`policy.py:185-191`) selects exactly `id, org_id, name, type,
spec_json, action, direction, status, created_at` — no `kind`, no
`severity`, no `matchCount24h`, no `lastHit`, no `ruleSummary`, no
`agentId`. And the backend's `type` enum (`prompt_injection`,
`pii_redaction`, `hallucination`, `content_policy`, `judge_link` —
`policy.py:70-74`) shares **zero values** with the frontend's `kind` enum
(`pii`, `toxicity`, `tool_allowlist`, `rate_limit`, `custom` —
`fixtures/guardrails.ts:8-13`) — `toxicity`, `tool_allowlist`, and
`rate_limit` are pure UI fiction; no backend policy `type` can ever produce
them (and per KNOWN-SUBSYSTEMS.md / the doc's own detector audit, eden has
no tool-allowlist or rate-limit enforcement in `guardrails/` at all, so
those two filter chips describe a category of guardrail that doesn't
exist). Separately, the API response itself is an envelope, not a bare
array: `GuardrailPolicy.list` returns `_ok_envelope(self.name,
{"policies": rows, "count": len(rows)})` (`policy.py:333-336`), and
`_ok_envelope` (`policy.py:483-500`) wraps that as `{status, feature, live,
timestamp, data: {...}}`. The route (`intelligence_guardrails.py:124-127`)
returns this envelope unchanged. The frontend call,
`portalApi.guardrailPolicies` (`clients/portal/src/lib/api/portal.ts:196-197`),
is typed `fetchApi<GuardrailPolicyFixture[]>(...)` with **no unwrap** — I
traced `fetchApi` to its terminal `return response.json();`
(`clients/portal/src/lib/api/core.ts:452`) and there is no `.data`
extraction anywhere in that call chain. Net effect, read statically end to
end: if this endpoint ever returned a real, non-empty policy list, `page.tsx`'s
`const policies = livePolicies` and the `.filter()`/`.length`/`.find()` calls
built on it (`clients/portal/src/app/(portal)/guardrails/page.tsx`,
`guardrails-list-view.tsx:49-61`) would run against an envelope *object*,
not an array. This is a static-read finding, not a live repro — I did not
run the app — but the type mismatch is unambiguous at every layer (SQL
columns, envelope shape, fetch typing), which suggests this page has never
actually been exercised against an org with real guardrail policies; it
"works" today only because the org under test has none (fixtures fall back
to an empty `GUARDRAIL_POLICIES: GuardrailPolicyFixture[] = []`,
`fixtures/guardrails.ts:56`).

### Flow 2 — seeing a policy trigger

There is no dashboard. `InterventionLog.query` and `GuardrailMetrics.dashboard`
(`intervention.py:973`, `:1014`) and their REST surface (`GET /log`, `GET
/metrics`, `intelligence_guardrails.py:206-233`) exist server-side, but the
portal's guardrails nav has exactly one tab (confirmed above) and no
component anywhere under `clients/portal/src/lab/guardrails/` renders
`/log` or `/metrics`. Even the two "activity" fields the detail view *does*
render — `Hits / 24h` and `Last hit` (`Stat` calls at
`guardrails-detail-view.tsx:88-89`, sourced from `matchCount24h`/`lastHit`)
— have no backend column to source them from (see the SQL-column list
above), so even after fixing the envelope/array bug, those two stats would
render as `undefined`/blank forever, not just today — there's no code path
that ever computes them. Combined with the doc's headline finding (which I
independently re-verified: `wiring.py:278-355`, `if not trace_id: return
await original(...)` else route to `evaluate_trajectory_step`, with
`edited_text` set to the raw input text and a `"feature":
"trajectory_guardrail"` marker nothing renders), a platform engineer who
*does* call the API directly has no reliable way to distinguish "this
verdict came from the real detectors" from "this verdict came from an
unrelated cost/loop/latency check" — the one field that would tell them
(`feature`) isn't surfaced anywhere in the product.

### Flow 3 — confirm/dismiss promotion (the mechanism this pass is
supposed to ground the UX section in)

This is the most consequential thing I found this pass and it isn't in the
current doc at all: **there are two different classes, in two different
modules, both named `EvalToGuardrailLink`, with divergent and
non-interoperating behavior**, and the doc (and KNOWN-SUBSYSTEMS.md) only
describes one of them.

**(a) `eden.guardrails.intervention.EvalToGuardrailLink`**
(`intervention.py:789-957`) — this is the one the doc and
KNOWN-SUBSYSTEMS.md cite. `.promote()` (`:812-903`) creates a
`type="judge_link"` policy row plus a link row, reachable via `POST
/orgs/{org_id}/intelligence/guardrails/promote-judge`
(`intelligence_guardrails.py:188-196`, instantiated at `:52`). But
`InterventionEngine.evaluate_and_act` **explicitly refuses to enforce**
`judge_link`-type policies: `_enforced_types` (`intervention.py:521-528`)
is `{prompt_injection, pii_redaction, hallucination, content_policy}` —
`judge_link` is not in it. If a `judge_link` policy is the only active
policy, the verdict is hard-coded to `block, live: false, reason:
"judge_link_not_enforced"` (`intervention.py:532-548`, comment at `:519-520`:
*"judge_link policies are declared but not evaluated here — do not
advertise live enforcement solely because they exist"*). `.promote()` also
never calls the live gateway filter's `load_policies` — I grepped every
caller of `load_policies` repo-wide and `intervention.py:812-903` isn't one
of them. **So confirming a judge through the one promote endpoint this doc
documents produces a policy that the primary evaluation engine is
hard-coded to ignore.**

**(b) `eden.evaluation.eval_intel.integration.EvalToGuardrailLink`**
(`integration.py:69-256`) — a *different* class, same name, different
module, not mentioned in the current F12 doc or in KNOWN-SUBSYSTEMS.md's
`guardrails/` entry. `.promote_to_guardrail()` (`:79-207`) has real quality
gates — ≥100 judge samples in the last 30 days and FPR ≤5%
(`integration.py:99-118`, constants `MIN_SAMPLES_FOR_PROMOTION`,
`MAX_FPR_FOR_PROMOTION`) — and **does** hot-reload
`eden.llmops.filters.guardrail.GuardrailGatewayFilter`
(`integration.py:177-192`), which is the actual live-enforcement point: a
pattern/keyword scan that runs at the LLM gateway
(`llmops/filters/guardrail.py:38-69`), architecturally separate from
`InterventionEngine`/`evaluate_and_act` entirely. This is reachable via
`POST /orgs/{org_id}/intelligence/eval/promote-to-guardrail`
(`intelligence_eval.py:214-221`), a route that lives under `/intelligence/eval/`,
not `/intelligence/guardrails/` — a different REST namespace than the one
this doc documents — plus a shadow variant, `.promote_to_shadow()`, at
`POST /orgs/{org_id}/intelligence/eval/promote-to-shadow-guardrail`
(`wave6_online.py:617-624`).

**(c) Demote/dismiss is even more broken.** Only class (a) has a `.demote()`
method (`intervention.py:905-957`) — and it has **no REST route at all**; I
grepped `intelligence_guardrails.py`'s full route list (12 routes) and none
of them is a demote/disable path. The only caller of `.demote()` anywhere
in the repo is the automatic hook `GuardrailHook.on_judge_below_floor`
(`promotion_hooks.py:860-894`, docstring: *"A promoted guardrail is now too
noisy — auto-disable it"*) — an internal noise-detection trigger, never a
human action. Class (b) — the one that actually enforces at the gateway —
has **no demote/disable method anywhere** in `integration.py`,
`intelligence_eval.py`, or `wave6_online.py`. Once a judge is promoted
through the path that actually does something, there is no code path, API
route, or UI to take it back.

**And neither promote path has ever been wired to a UI action.** I grepped
`clients/portal/src` for `promote-judge`, `promote_to_guardrail`,
`promote-to-guardrail`, `eval_to_guardrail`, `EvalToGuardrailLink`, and
`judge_link` — zero hits. Both `on_judge_threshold_breach`
(`promotion_hooks.py:801-858`) and `on_judge_below_floor`
(`promotion_hooks.py:860-894`) are framed in their own docstrings as
automatic, judge-reliability-driven triggers ("A judge has reliably
triggered below its threshold," "now too noisy"), not as the backing logic
for a person clicking "confirm" or "dismiss." So "confirm/dismiss-driven
promotion mechanism" (KNOWN-SUBSYSTEMS.md's framing, which this pass was
asked to ground the UX section in) overstates what exists today: there is
no interactive confirm/dismiss workflow anywhere in the product. What
exists is two disconnected automated backend loops — one that a human
*could* trigger via a raw API call but which does nothing to live traffic
(a), and one that does something to live traffic but that no UI, and no F12
documentation, currently surfaces, and that can't be undone via any API (b).

### What a genuinely trustworthy, low-friction version looks like

Given the pieces that already exist (the FPR/sample-count gate in (b), the
shadow-mode `promote_to_shadow`, the `EvidenceGate` staging concept at
`integration.py:196-222`), the shape of the fix is mostly *consolidation and
surfacing*, not new engineering:

1. **Collapse to one `EvalToGuardrailLink`.** Either make (a)'s `promote()`
   call the same gateway-filter hot-reload (b) does, or delete (a) and
   repoint `POST /promote-judge` at (b)'s `promote_to_guardrail`. Two
   same-named classes with incompatible enforcement semantics is the kind
   of thing that produces exactly the "customer thinks X is live, it isn't"
   failure mode the doc's `trace_id`-bypass finding already illustrates —
   this is a second instance of the same anti-pattern, one layer up, in the
   "confirm" mechanism itself rather than in the evaluator.
2. **Give (b) a demote/disable route**, symmetric with promote — a judge
   that gets noisy today has to be fixed by hand-editing the gateway
   filter's in-memory `_policies` dict; there is no product-facing way to
   turn off a live-enforced promoted guardrail.
3. **Build the confirm/dismiss UI it's missing.** A minimal version: the
   existing `promote_to_shadow` + `EvidenceGate` staging flow already
   produces a candidate ("this judge would have blocked N% of the last 30
   days' traffic at threshold T, at estimated FPR F%") — surface that as a
   card with Promote/Dismiss buttons, wired to (2)'s consolidated
   promote/demote routes. That turns a two-hop, undocumented, UI-invisible
   backend loop into the actual "validate a signal → one click → it's a
   live guardrail, one click → it's gone" experience the KNOWN-SUBSYSTEMS
   framing implies eden already has.
4. **Fix the policy list page before anything else** — per the envelope/type
   mismatch above, the one UI surface that exists for this subsystem may
   not render real data today; that's a bigger blocker to "trustworthy" than
   detector quality.
5. **Surface `GuardrailMetrics.dashboard`/`InterventionLog.query`** in the
   portal at all — right now a customer has zero visibility, in-product,
   into whether their policies have ever fired.
6. **Make the `judge_link_not_enforced` / `trajectory_guardrail` state
   visible wherever a verdict is shown** — both are "this isn't really
   protecting you" states that currently produce a normal-looking `verdict`
   field with no accompanying signal a caller would notice without reading
   source.

---

## VERIFIED (independent re-check, convergent with the doc's claims)

- `InterventionEngine.evaluate_and_act`'s fail-closed branches — re-verified
  by direct read: `policy_fetch_failed` (`intervention.py:490-504`),
  `no_active_policies` (`:505-517`), `judge_link_not_enforced` /
  `no_enforced_policies` (`:519-548`, confirmed `_enforced_types` excludes
  `judge_link`). Matches the doc.
- The `trace_id`-bypass hot-path collision — independently re-read
  `install_cat15_trajectory_replaces_intervention` and `_wrapped`
  (`wiring.py:278-355`): `if not trace_id: return await original(...)`,
  else route to `evaluate_trajectory_step`; `edited_text` set to the raw
  input `text` (not redacted); response tagged
  `"feature": "trajectory_guardrail"`. Matches the doc's claims exactly.
- `install_cat15_trajectory_replaces_intervention` is called unconditionally
  from `app.py` lifespan startup (confirmed at the `install_all()` call
  site, `app.py` ~`:808-816`) and gated only by
  `Settings.trace_quality_hot_path_enabled` (default `True`,
  `config.py` ~`:940-941`, confirmed alongside `trace_quality_enabled`
  default `True`).
- Portal is a pure, read-only viewer of guardrail policy config with no
  create/edit/promote/demote/dismiss action anywhere in
  `guardrails-list-view.tsx` or `guardrails-detail-view.tsx` — matches
  KNOWN-SUBSYSTEMS.md's characterization, confirmed by full-file reads.
- `VALID_POLICY_TYPES` / `VALID_ACTIONS` / `VALID_DIRECTIONS`
  (`policy.py:68-92`) confirm the doc's 4 enforced policy types plus
  `judge_link`, and the 5-action verdict space (`allow/warn/redact/block/escalate`).

## CUT (quote + reason)

I found no filler, redundancy, or cross-doc overlap worth cutting inside
F12 itself, and no other feature doc mentions guardrails at all —
confirmed via `grep -rn -i "guardrail"` across every file in
`docs/specs/strategic-review-2026-08/features/` other than
`12-runtime-guardrails.md`: zero hits. Also confirmed zero hits for
`EvalToGuardrailLink`, `judge_link`, `promote_to_guardrail`,
`promote-judge`, `InterventionEngine` in every other feature doc. So there
is nothing to cut for cross-file redundancy — F12 is the sole owner of this
territory and should stay that way.

The one passage I'd flag as *slightly* overclaiming, not for deletion but
for a small correction alongside my new findings: the doc's "What already
exists" bullet —

> `EvalToGuardrailLink.promote`/`.demote` (`intervention.py:812`, `:905`;
> class starts `:788`) — an eval verdict (Cat 3 judge) can be promoted into
> a live enforced policy

— "promoted into a live enforced policy" is not accurate for the class this
citation points at: per my Flow-3 finding above, `judge_link` policies
created by *this specific* `.promote()` are explicitly excluded from
`_enforced_types` and are documented in-code as not evaluated
(`intervention.py:519-520`). The doc should either fix this line or add
the (b) class (`eval_intel/integration.py`) as the one that's actually
"live enforced," since they're not the same code path.

## NEW FINDINGS (not covered by the current doc)

1. **Two classes named `EvalToGuardrailLink`, incompatible enforcement
   semantics.** `intervention.py:789-957` (declared-only, never touches the
   gateway filter, `promote-judge` route) vs. `eval_intel/integration.py:69-256`
   (real FPR/sample gates, hot-reloads the actual gateway enforcement point,
   separate `/intelligence/eval/promote-to-guardrail` and
   `/promote-to-shadow-guardrail` routes). See Flow 3 above for full trace.
2. **No demote/dismiss exists for the enforcement path that actually
   matters.** The only class with a working live-enforcement promote
   (`eval_intel/integration.py`) has no demote method or route anywhere.
   The only class with a demote method (`intervention.py`) is never called
   by any human-triggerable route — only by an automatic hook.
3. **Zero UI wiring for either promotion path.** Confirmed by repo-wide
   grep of `clients/portal/src` for all the relevant symbols/route
   fragments — nothing renders a promote or demote action anywhere. The
   "confirm/dismiss" framing in KNOWN-SUBSYSTEMS.md describes backend
   plumbing, not a product feature that exists today.
4. **The guardrails policy list page likely does not render real data.**
   Traced the full chain: SQL row shape (`policy.py:185-191`) → envelope
   wrapper (`policy.py:483-500`, `:333-336`) → route pass-through
   (`intelligence_guardrails.py:124-127`) → untyped/unwrapped fetch
   (`portal.ts:196-197`, `core.ts:452`) → array-shaped consumer code
   (`page.tsx`, `guardrails-list-view.tsx:49-61`). Every layer disagrees
   with the next: no `kind`/`severity`/`matchCount24h`/`lastHit`/`ruleSummary`/
   `agentId` columns exist server-side; the `type` enum and the frontend
   `kind` enum share no values; and the response is an envelope object, not
   the bare array the frontend types assume. This is a static-read finding
   (not a live repro) but the mismatch is unambiguous at every layer.
5. **Two of the portal's five `kind` filter chips describe guardrail
   categories eden doesn't have.** `"tool_allowlist"` and `"rate_limit"`
   (`fixtures/guardrails.ts:8-13`, chips at `guardrails-list-view.tsx:66-70`)
   have no corresponding backend policy `type` (`policy.py:68-76`) and no
   detector anywhere in `guardrails/` — consistent with the doc's own
   "no tool-call/action-boundary validation anywhere" finding, but this is
   a new, more concrete instance: the UI actively offers to filter by a
   category of protection that cannot exist, which is a direct
   false-confidence vector for anyone browsing the portal.
