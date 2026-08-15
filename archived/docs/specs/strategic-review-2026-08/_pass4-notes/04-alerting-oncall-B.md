# Pass 4 — Agent B (UX/Value) notes on `features/04-alerting-oncall.md`

Scope: I did not coordinate with Agent A. This is an independent UX/value pass plus my own
fact-check sweep. Everything below is grep/read-verified against source in this session
(2026-08-05), not inferred from the doc's own claims.

---

## USER EXPERIENCE & VALUE (primary output)

### 0. The framing problem: the doc audits the wrong "front door"

The existing doc spends ~90% of its length tracing `src/eden/realtime/alert_stream.py` — a
Kafka rule engine with zero external callers (§0a of the doc, re-verified: `grep -rn
"\.process_event(\|\.process_batch(" src/eden` really does turn up nothing outside the module
itself). That conclusion is correct, but it leaves the reader with the impression that eden's
alerting *product surface* is `alert_stream.py`. It is not. I traced the portal's actual Inbox
UI (the bell icon, `clients/portal/src/lab/alerts-panel.tsx`, wired into the real app shell —
confirmed live, not orphaned: `grep -rln "AlertsModal" clients/portal/src` hits
`components/shell/app-shell.tsx` and `components/shell/sidebar-nav.tsx`) back to its data
source, and it is **not** `alert_stream.py` or the `notifications` table story in the doc's §0a.
It's `GET /orgs/{org}/portal/alerts/rules` and `/alerts/events`
(`src/eden/api/routes/portal.py:2092-2170`), which call
`eden.alerts.repo.list_nl_rules`/`list_alert_events` (`src/eden/alerts/repo.py:64-84,167-199`) —
a **third, previously-uninventoried alerting subsystem**: `src/eden/alerts/` (routes.py,
compiler.py, repo.py, triage_judge.py), bridged to `src/eden/dsl/alerts.py`'s `AlertAsCode`
("Cat 19"/EQL alert-as-code engine). This pair is the one alert pipeline in the whole codebase
that is **both live-wired end to end and reaches a human** — a real cron watchdog
(`AlertAsCode.fire_due`, hosted on `eden-worker`,
`src/eden/workers/main.py:589-620`, leader-gated, runs every `eql_watchdog_interval_seconds`)
evaluates due rules, a triage judge classifies firings, and a `real_incident` verdict at
confidence ≥ 0.7 emails the org's owner/admins (`send_nl_incident_email`,
`src/eden/services/alert_email.py:143-176`). This deserves to be pass 4's headline "what UX
should we build around" subsystem — not `alert_stream.py`, which nothing in the product UI even
reads from.

This reframing matters for UX specifically because the doc's recommendation (§3/§4: wire up
`process_event`, emit `sandbox.security_alert`, then fix PagerDuty) does nothing for the
actual configuration/consumption experience a user has today, which runs entirely through the
`nl_alert_rules` / `eql_alert_rules` / `alert_events` pipeline the doc treats as a footnote
("a third, separate pipeline ... only recently bridged").

### 1. Who is the user, and what do they actually see?

Two personas, and eden's current product only serves one of them:

**(a) The rule author** — a PM or eng who wants "page me when error rate exceeds 5%." This
person needs a create flow: name the condition, pick severity, pick where it goes (Slack /
email / PagerDuty / webhook), save, and later edit or disable it without re-typing it.

**(b) The on-call consumer** — someone who gets paged, or who checks an inbox after the fact,
and needs the payload to tell them *what broke* and *what to do about it*, with one click to the
underlying trace/issue.

Persona (b) is served, moderately well, by the Inbox modal. Persona (a) is **not served by any
UI in the product at all** — see §2.

### 2. The authoring flow: real backend, zero frontend

`src/eden/alerts/routes.py` is a complete, well-designed NL-to-EQL alert authoring API:
`POST /orgs/{org}/alerts/compile` (`routes.py:100-128`) takes free text like *"Alert me when
error rate exceeds 5% in the last hour"*, runs it through `AlertCompiler.compile`
(`src/eden/alerts/compiler.py:145-210`), which reuses the same NL→structured-rule extractor as
the Detectors/Signals feature (`compile_signal`, `eden.services.cat2_intel.signals`), maps known
metrics (`error_rate`, `refusal_rate`, `latency_p99`, `cost_per_call`, `tool_call_rate`, …) to a
parameterized EQL `SELECT`, lints it through the real DSL parser, and returns the compiled query
plus warnings plus a suggested name — genuinely good "explain what I'm about to alert on" UX if
it had a UI. `POST /orgs/{org}/nl-alert-rules` (`routes.py:142-175`) then persists the rule
*and* bridges it into the cron-fired `eql_alert_rules` table via
`AlertAsCode().compile(...)` (`routes.py:162-168`) in the same request — one API call gets you a
rule that will actually fire.

**No component in `clients/portal` calls any of this.** I checked exhaustively:
`grep -rn "nl-alert-rules\|alerts/compile" clients/portal/src` only matches the typed-but-dead
wrapper functions in `clients/portal/src/lib/api/resources.ts:2092-2133`
(`getAlertRules`, `compileNlAlert`, `listNlAlertRules`) — and `grep -rln
"compileNlAlert\|listNlAlertRules\|overrideAlertVerdict\|getAlertRules\b"
clients/portal/src -l` (excluding `resources.ts` itself) returns **nothing**. There is not even
a `createNlAlertRule`/`updateNlAlertRule` wrapper defined in the client at all — someone wrote
the response *types* for a create/list UI and then the UI itself was never built (or was removed
and the client leftover). The only client actually wired up
(`clients/portal/src/lab/alerts-panel.tsx:24`, `alertsApi` at
`clients/portal/src/lib/api/resources.ts:3461-3480`) exposes exactly two calls: `override`
(resolve/reopen) and `acknowledge` (mute/unmute) — both **read/react on an existing alert**, not
create one.

Net effect: **the only alerting pipeline in eden that can plausibly page a human today has no
self-serve configuration UI.** A customer cannot go into the product and say "alert me when X" —
the only way to populate `nl_alert_rules`/`eql_alert_rules` is a raw authenticated POST to the
API (curl/Postman), which requires org-admin auth (`_require_org_admin`, `routes.py:81-97`) and
knowledge of an undocumented internal endpoint. This is a much more basic adoption blocker than
"PagerDuty is a no-op" — there's no rule-creation UX at all for the pipeline that works.

The two flows a user actually *can* reach from the nav are both different systems with their
own gaps:

- **Detectors tab NL prompt** (`clients/portal/src/app/(portal)/signals/signals-client.tsx`,
  `CreateSignalDialog` at line ~217) — a "Create Signal" dialog that looks like alert authoring
  (free-text prompt → compiled condition) but calls a **Next.js API route**
  (`clients/portal/src/app/api/lab/compile-signal/route.ts`) that hits OpenRouter directly and
  produces a client-side draft (`CompiledSignalDraft`: name/kind/severity/condition/watching).
  It never touches `eden.alerts.compiler.AlertCompiler` or `nl_alert_rules` at all — it's a
  parallel, unrelated NL-compile implementation for a different subsystem (quality/behavior
  Signals/Detectors). Confirmed: `grep -n "channel\|slack\|pagerduty\|webhook\|Notify\|destination"
  signals-client.tsx` returns **zero hits** — there is no notification-destination field
  anywhere in this dialog. A user "creating a detector" here has no way to say where it should
  notify them; it just becomes a visible row in the product.
- **Automations tab** (`clients/portal/src/app/(portal)/signals/automations-panel.tsx`) — the
  one flow that *does* let you pick `slack`/`webhook`/`dataset` as an action
  (`ACTION_TYPES`, line 49) against `score_threshold`/`stumble`/`error_rate` triggers. But
  confirmed **create-only** on both ends: `src/eden/automations/engine.py` defines
  `list_automations`/`create`/`on_score`/`_execute_action`/`_log_run` and nothing else — no
  `update`/`delete`/`toggle` method exists in the class at all. The route surface matches:
  `grep -n "@router\.\(get\|post\)" src/eden/api/routes/wave6_online.py` (lines 209, 217) shows
  only `GET`/`POST /automations`, and the frontend client
  (`clients/portal/src/lib/api/resources.ts:4419-4434`) exposes only `list`/`create`. **You
  cannot fix a typo'd Slack channel or dead webhook URL in an Automation once it's saved** —
  your only recourse is creating a new row and living with the orphaned old one (there's no
  delete either), or a DB operator doing it by hand. For a "set it and forget it" alerting
  primitive, the lack of an edit path is a real day-2 UX failure, not a nice-to-have.

### 3. The consumption flow: genuinely decent, with one glaring gap

The Inbox modal (`alerts-panel.tsx`) is the strongest piece of alerting UX in the codebase and
deserves credit the original doc doesn't give it:

- Filter chips: Open / Firing / Muted / Resolved / All, with live counts
  (`alerts-panel.tsx:382-405`).
- Detail pane cross-links to the Issue, the Run (trace), the Detector (rule), and the Agent —
  all real navigable deep links (`alerts-panel.tsx:196-296`), which is exactly the kind of
  "actionable payload" an on-call engineer needs to go investigate, not just a title string.
- Actions map directly onto the real backend triage state machine: **Resolve** →
  `alertsApi.override(orgId, id, "benign")`, **Reopen** → `override(..., "real_incident")`,
  **Mute/Unmute** → `acknowledge(orgId, id, true/false)` (`alerts-panel.tsx:633-652`), which land
  on `src/eden/alerts/routes.py:249-267,270-323` and persist to `alert_triage_feedback`
  (`repo.py:224-280`) — i.e., human overrides of the triage judge are captured as structured
  feedback, not just a UI toggle. That's a real foundation for a "teach the detector" loop, even
  if nothing downstream currently retrains on it (I did not find a consumer of
  `alert_triage_feedback` beyond the insert — worth a follow-up, out of scope here).
- The `/alerts` route itself is an intentional soft-redirect (`clients/portal/src/app/(portal)/
  alerts/page.tsx:6-11`: *"Firing alerts open from the bell Inbox ... there is no separate Alerts
  page anymore"*) — a deliberate, sane IA decision (one inbox, not two competing list views),
  not an oversight.

**The gap: the payload is a raw SQL fragment, not an explanation.** `_trigger_triage`
(`src/eden/dsl/alerts.py:480-541`) builds the `alert_events.payload` from `eql_query`, `n_rows`,
`sample_rows`, `data_source` — no natural-language summary, no runbook link, no "why does this
matter" beyond a compiled `SELECT ... FROM telemetry_events WHERE ...` string and a row count.
The Inbox detail pane renders this verbatim as **"Condition"** in monospace
(`alerts-panel.tsx:299-309`, `rule.condition` sourced from `compiled_eql` at
`portal.py:2118`). For persona (a) — the PM who typed "alert me when error rate exceeds 5%" in
plain English — the thing they see when it fires is generated SQL, not their own sentence. The
`nl_text` the user actually wrote is stored (`nl_alert_rules.nl_text`) but the event/detail view
surfaces `compiled_eql`, not `nl_text` — a small but real regression in "does the alert explain
itself in the terms I configured it in."

### 4. Noise/false-positive control is thin and mostly unreachable

`AlertTriageJudge.judge` (`src/eden/alerts/triage_judge.py:24-74`) is the whole noise-control
story: four hardcoded regexes for "this is a known marketing campaign" (lines 16-21), a
duplicate-issue lookup keyed on `payload.get("issue_id")` or `payload.get("fingerprint")` (lines
76-104), and otherwise defaults to `real_incident` at confidence 0.75. Two problems specific to
UX/value:

- **The duplicate-suppression path is dead for the one alert source that actually fires.**
  `_trigger_triage`'s payload (`dsl/alerts.py:522-529`) never sets `fingerprint` or `issue_id` —
  only `alert_id`, `firing_id`, `eql_query`, `n_rows`, `data_source`, `sample_rows`. So
  `_find_duplicate_issue` will always return `None` for every EQL-sourced alert, meaning the
  "duplicate" verdict — the one that would suppress a repeat page for the same ongoing incident —
  can structurally never trigger from the pipeline's only live producer. Every re-fire of the
  same broken metric is a fresh `real_incident` email (rate-limited only by the blunt Redis SETNX
  + hourly-cap in `alert_email.py`, not by "is this the same issue as an hour ago").
- **The benign-pattern list is a fixed 4-regex allowlist, not a learnable/configurable
  mechanism** — there's no UI or API to add "our Tuesday batch job always spikes latency,
  don't page for it," which is exactly the kind of noise a real on-call tool (per the doc's own
  §2 competitive research on incident.io/Better Stack) treats as a first-class config surface
  (suppression windows, maintenance mode, dedup keys). Here it's a code change.

### 5. The channel/severity story is a UX facade, not just a backend gap

This compounds the doc's existing "PagerDuty is a no-op" finding with a UX-specific one the doc
doesn't surface: **even where a config *field* exists in the UI/API for channel or severity, it
is cosmetic.**

- `nl_alert_rules.channels` is collected by the (unused) create API
  (`routes.py:40-49,142-175`) and defaults to `{"in_app": True}` (`repo.py:57`) — but nothing
  ever reads it to decide where to send a notification. The only live notification call,
  `send_nl_incident_email` (triggered from `triage_judge.py:167-176`), is **unconditional email
  to org admins**, full stop — it takes no channel argument. A user who painstakingly configured
  `channels: {"slack": true}` would still only ever get an email (if they get anything). The
  field exists to be displayed (`_pick_channel`, `portal.py:324-350`, used only in the read-model
  card), not to route.
- **`severity` on the rule that actually fires (`eql_alert_rules`) has an inverted-expectations
  landmine**: `AlertAsCode.compile` accepts `info|warning|high|critical`
  (`dsl/alerts.py:60-62`, validated), but the cron watchdog's own evaluation function skips any
  rule whose severity is outside `_FIREABLE_SEVERITIES = {info, warning, high}` on every
  non-forced tick (`_evaluate_rule`, `dsl/alerts.py:404-412`, `if not force and severity not in
  _FIREABLE_SEVERITIES: ... return {"fired": False, "reason": "severity_filtered"}`), and
  `fire_due` — the only thing the cron watchdog ever calls — always passes `force=False`
  (`dsl/alerts.py:333`). **Marking a rule `severity="critical"` is accepted by the UI/API,
  looks correct, and then silently never auto-fires again**, because `critical` is the one value
  excluded from `_FIREABLE_SEVERITIES`. It only evaluates via the on-demand `evaluate(force=True)`
  path, which has no UI trigger either. This is the exact opposite of what a user would assume
  ("critical" reads as *more* urgent, not *disabled*), and it is a distinct, independently
  serious trust problem from the `alert_stream.py` P0 dead-path the doc already flags — it lives
  in the pipeline the doc treats as the working one.
- The portal's rule card additionally **hardcodes `severity="warn"` for every NL alert rule**
  regardless of what was actually configured (`portal.py:2119`, `AlertRuleCard(..., severity=
  "warn", ...)`) — `nl_alert_rules` doesn't even store severity (only `eql_alert_rules` does,
  via the bridge call), so the portal literally cannot display the real value even if it wanted
  to. A user has no way to see, from the UI, what severity their rule was actually registered
  at.

### 6. Why this matters for adoption

Put together, today's "alerting" story for a prospective customer is:

1. You cannot configure an alert through the product. The one flow that works end-to-end
   (NL→EQL→cron→triage→email) requires a raw authenticated API call known only to someone who
   has read this source.
2. If you did configure one via the API, the channel you picked is ignored (always email to
   admins) and marking it "critical" would silently stop it from ever firing on its own.
3. If it does fire, the payload you see is a raw SQL fragment and a row count, not your original
   English description or a runbook.
4. If it fires repeatedly for the same root cause, there is no working suppression — every tick
   is a fresh page.
5. The one UI surface that *does* let you pick Slack/webhook (Automations) can't be edited or
   deleted once created.

None of this requires "wire up alert_stream.py" to fix — it requires shipping the frontend for
an authoring API that already exists and is reasonably well-built
(`eden.alerts.compiler.AlertCompiler` + `eden.dsl.alerts.AlertAsCode`), fixing the
severity-filter inversion, making `channels` actually route, and giving the triage judge a real
dedup signal. That's a materially different (and in some ways smaller) engineering lift than the
doc's §3 recommendation sequence, but a **precondition** for any of it to be sellable — a working
PagerDuty sender behind an unreachable rule-creation UI is exactly as useless to a customer as a
working PagerDuty sender behind an unreachable rule *engine*.

---

## VERIFIED (spot-checks of the existing doc's claims, from a UX-adjacent angle)

- `AlertStreamProcessor.process_event` has zero external callers — re-confirmed via
  `grep -rn "\.process_event(\|\.process_batch(" src/eden`. Consistent with doc §0a.
- `AutomationsEngine` (`src/eden/automations/engine.py`) is create/list-only, no update/delete —
  confirmed directly (`grep -n "async def " engine.py` → `_client, list_automations, create,
  on_score, _execute_action, _log_run`). Matches doc's "read-only after create" claim (§1) and
  extends it: confirmed the frontend client (`resources.ts:4419-4434`) and the FastAPI route
  file (`wave6_online.py:209,217`) both independently lack any mutate-after-create path — this
  isn't just an engine gap, no layer of the stack supports it.
- `send_nl_incident_email` is real, sparse (Redis SETNX dedupe via `_allow_send`), and sends to
  org owner/admin emails — confirmed (`alert_email.py:143-176`), consistent with doc's
  characterization of `alert_email.py` overall.
- `AlertAsCode.fire_due` is genuinely wired into a production worker loop
  (`src/eden/workers/main.py:589-620`, `_leader_eql_alert_watchdog`, leader-gated,
  interval-configurable) — the doc mentions `dsl/alerts.py` only in passing and does not surface
  that this is a real, scheduled, running pipeline (unlike `alert_stream.py`). This is worth
  the synthesis pass folding in explicitly, since it changes the "does anything work" verdict
  for at least one delivery path (email, to admins, for EQL-alert-sourced real_incident
  verdicts) from "no" to "yes, but with no authoring UI and a severity bug."

## CUT (claims/framing I'd flag as redundant, overstated, or needing rebalancing — not editing the doc directly)

- > "src/eden/dsl/alerts.py ('AlertAsCode') is a third, separate pipeline (eql_alert_firings),
  > only recently bridged to send_nl_incident_email."
  This one sentence is the doc's entire treatment of the subsystem that turns out to be the
  actual working, actual user-facing alert pipeline (once `src/eden/alerts/` — the F81 NL-rule
  API/repo/triage-judge — and the portal Inbox wiring are traced through). It's not wrong, but
  it's badly under-weighted relative to its importance: the doc spends multiple paragraphs
  proving `alert_stream.py` is a dead path that no UI reads from, and one clause on the pipeline
  that portal.py's `/alerts/rules` and `/alerts/events` (what the Inbox actually calls) are
  built on. Recommend the synthesis pass promote this to its own subsection with the severity
  inversion bug (§5 above) called out — it's a concrete, high-confidence, independently
  fireable trust issue, distinct from the P0/PagerDuty story, and currently invisible in the
  doc.
- The doc's §1 table lists "PagerDuty — Stubbed" and treats fixing it as step 4 of the §3
  sequence. From a UX/adoption standpoint this ordering is right, but the doc doesn't mention
  that even the two channels which *are* real (Slack, Email) are only reachable from the
  closed-loop issue-escalation path, which itself has no user-facing configuration surface
  either — you can't tell eden "escalate to *this* Slack channel for *this* class of issue"
  through any UI I could find; it's the same "backend exists, UI doesn't" pattern as the NL-alert
  authoring gap above. Not a contradiction of anything in the doc, just an angle (persona (a)
  "rule author" needs) that a fact-only pass wouldn't naturally surface, and I think it's
  relevant enough to flag rather than cut silently.
- No overlap/redundancy found with `01-competitor-matrix.md`'s content that I could check without
  reading that doc in full (out of scope for this pass) — the existing doc's §2 already
  cross-references it appropriately by name.

## NEW FINDINGS (not in the current doc)

1. **`src/eden/alerts/` (routes.py, compiler.py, repo.py, triage_judge.py) is a previously
   undocumented-in-this-doc alerting subsystem** — the F81 NL-alert API. It is the actual data
   source for the portal's live Inbox modal (`portal.py:2092-2170` → `alerts_repo.list_nl_rules`/
   `list_alert_events`), making it, in UX terms, more relevant to "does alerting work for a
   real user" than `alert_stream.py`.
2. **The one alert-authoring API that produces a rule which can actually fire and page someone
   (`POST /orgs/{org}/alerts/compile` + `POST /orgs/{org}/nl-alert-rules`) has no frontend caller
   anywhere in `clients/portal`.** Confirmed by exhaustive grep of both the literal endpoint
   paths and the typed client wrapper function names. A customer cannot create a working alert
   rule through the product today, full stop — independent of and more fundamental than the
   PagerDuty-transport gap the doc already documents.
3. **Severity-filter inversion bug**: an `eql_alert_rules` row saved with `severity="critical"`
   is accepted by validation but is the *one* severity value the cron watchdog's default
   (`force=False`) evaluation path always skips (`_FIREABLE_SEVERITIES` excludes `critical`,
   `dsl/alerts.py:65-67,404-412`), so a "critical" alert silently never auto-fires. This is a new,
   independently serious, easily-reproduced trust bug in the pipeline the doc treats as basically
   fine.
4. **`channels` on `nl_alert_rules` is fully inert** — collected by the API, defaulted, stored,
   round-tripped for display — and never consulted by the only live send path
   (`send_nl_incident_email` is unconditional-email, no channel branching). Configuring "Slack"
   as your channel silently gets you nothing (or email, if you're lucky enough to also match the
   confidence/severity conditions) — not what you asked for either way.
5. **Duplicate-alert suppression is structurally unreachable** for the pipeline's only live
   producer: `_trigger_triage`'s payload never populates `fingerprint`/`issue_id`
   (`dsl/alerts.py:522-529`), which is what `AlertTriageJudge._find_duplicate_issue` requires
   (`triage_judge.py:76-104`) to return anything but `None`. Every re-fire of a still-broken
   metric is treated as a brand-new incident.
6. **Three separate "create a rule that watches your traces" flows exist in the product with no
   shared UI, no shared backend table, and inconsistent channel/severity support**: Detectors'
   NL-compile dialog (OpenRouter-backed, client-only draft, zero channel concept — verified via
   grep, zero hits for channel/slack/pagerduty/webhook/destination in `signals-client.tsx`),
   Automations (create-only, Slack/webhook/dataset actions, no severity concept — per the
   existing doc), and the unreachable NL-alert API (has channels, has severity, has no UI). This
   fragmentation is itself a UX cost worth naming even before any individual piece is fixed.
7. **Alert detail payload shows compiled SQL (`compiled_eql`), not the user's own natural-language
   rule text (`nl_text`)**, in the one UI surface that renders it (`alerts-panel.tsx:299-309`
   rendering `rule.condition` sourced from `portal.py:2118`). Minor relative to the above, but a
   concrete "the alert doesn't speak the language I configured it in" gap worth listing since the
   doc's brief spans configuration→consumption.
