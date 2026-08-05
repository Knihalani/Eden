# F4 — Real-time Alerting & On-Call Integration

Date: 2026-08-05 (Phase 4 — deepened pass; supersedes Phase 1-3 content below, which is retained
inline for traceability)

**Verdict: RESCOPE, severity elevated to CRITICAL/trust-breaking.** Phase 3 characterized this as
"PagerDuty is a silent no-op, everything else works." That undersold it. Phase 4 traced the full
path from a P0-worthy event to a human being notified, end-to-end, with every hop verified against
source — and the honest answer is **a P0 alert does not reach a human today, through any channel,
because the rule engine that is supposed to detect it is never invoked by anything in production.**
"Add a real PagerDuty sender" (Phase 3's headline fix) would not fix this — it would wire a working
transport onto a rule engine that nothing ever calls. Slack/email/webhook delivery infrastructure
genuinely is real and well-built (confirmed again below) — but that infrastructure serves a
*different* subsystem (`closed_loop.orchestrator`'s issue-triage escalation), not the Kafka-driven
severity-routing engine in `alert_stream.py` that actually defines the P0 rule (`rule_sandbox_escape`).
The two were never connected.

This pass adds two more pieces to the picture. **First**, a third path is now confirmed
independently decorative, and it's the most customer-visible of the three: the portal's
self-service Automations tab (`automations/engine.py`) accepts and saves Slack/webhook automation
configs, returns 200, and never sends anything — a live UI, with copy that explicitly promises
delivery it doesn't provide (§0d). **Second**, earlier passes under-weighted the one alerting
pipeline that *is* both live and reaches a human outside the security/P0 path: the NL-alert-to-EQL
pipeline (`src/eden/alerts/` + `src/eden/dsl/alerts.py`'s `AlertAsCode`, cron-fired from
`workers/main.py`), which is what the portal's actual Inbox UI reads from. It works end-to-end for
email — but has no self-serve authoring UI, a severity-filter bug that silently disables
`"critical"`-marked rules, and a `channels` field that is stored and displayed but never consulted
when sending (§0.5, and User Experience & Value below).

## 0. Does a P0 alert reach a human today? No — verified two independent ways.

**(a) The rule engine that defines the P0 rule is never invoked by production code.**
`AlertStreamProcessor.process_event()` (`src/eden/realtime/alert_stream.py:194`) is the only entry
point that evaluates rules — including `rule_sandbox_escape` — against a live event and dispatches
to channels. Grepping every call site of `.process_event(` / `.process_batch(` across the entire
`src/eden` tree turns up exactly two hits: the module's own docstring usage example
(`alert_stream.py:10`, inside a triple-quoted comment, not executable) and `process_batch`'s
internal loop calling it on itself (`alert_stream.py:221`). **Zero external callers.** The Kafka
consumer (`src/eden/realtime/kafka_consumer.py`) defines an `"eden-alert"` topic and a comment
(lines 62-63) describing "the alerts service" as a hypothetical subscriber to it — but no such
consumer exists anywhere in the repo (`grep -rn "eden-alert\|consume_bronze\|KafkaEventConsumer("`
outside `kafka_consumer.py` itself returns nothing). `ksql_cep.py` only name-drops
`eden.realtime.alert_stream` in a docstring (line 12). `grpc_server.py` lists `eden-alert` as a
known topic string in a comment, nothing more. There is also no test coverage:
`grep -rl "alert_stream\|AlertStreamProcessor\|process_event" tests/` returns zero files — this
rule engine is not exercised by anything, including CI. `AlertStreamProcessor` is only reachable
today from `src/eden/api/routes/replay.py`'s `list_alerts`/`acknowledge_alert`/`list_alert_rules`
GET/POST endpoints, which read/write the `notifications` Postgres table directly and never call
`process_event` either — so those endpoints will always show an empty feed, because nothing ever
populates it via the rule path.

**(b) Even in the counterfactual where something called `process_event`, the P0 rule's own event
source is never emitted.** `rule_sandbox_escape` (`alert_stream.py:178-183`) only matches
`event_types=["sandbox.security_alert"]`. `grep -rn "sandbox.security_alert" src/eden` matches
exactly one line in the entire codebase: the rule definition itself. Nothing constructs or emits
this event type. The actual sandbox runtime guard (`src/eden/sandbox/runner.py:114`) raises a plain
`ValueError` when a path escapes the workdir — it has no connection to the alert stream, Kafka, or
any notification path. `src/eden/evaluation/security_scanner.py`'s `SANDBOX_ESCAPE` category is a
**static-analysis (SAST) finding class** used to flag `eval`/`exec`-style code patterns during
scanning, not a runtime security event — it never dispatches an alert either. So the rule exists,
its channels are wired (including `PAGERDUTY`), but the trigger condition it's written to catch has
no producer anywhere in the system. This is a rule that literally cannot fire.

**(c) Even in the double-counterfactual where both (a) and (b) were fixed, the channel list itself
would not reach a human.** `rule_sandbox_escape`'s `channels=[IN_APP, WEBSOCKET, PAGERDUTY,
WEBHOOK]` (`alert_stream.py:183`) — note **`EMAIL` is not in this list**, the one channel in this
file with a real "leaves the building" implementation. Checked each of the four it does list:
  - `PAGERDUTY` → confirmed hardcoded no-op (Phase 2/3 finding, re-verified: `alert_stream.py:427-429`).
  - `WEBHOOK` → `_dispatch_webhook` (`alert_stream.py:410-425`) only fires if
    `settings.alert_webhook_url` is set; the field defaults to `None`
    (`src/eden/config.py:1546`: `alert_webhook_url: str | None = None`) and there is no seeded
    default in `docker/`, `helm/`, or `deploy/` config found for it — silent no-op out of the box.
  - `IN_APP` → real DB write (`_dispatch_in_app`, `alert_stream.py:330-378`, inserts into
    `notifications`), but it is **pull-only**: `src/eden/api/routes/notifications.py` exposes a
    single `@router.get("")` list endpoint (line 54) with no push/APNs/FCM/SMS fan-out anywhere in
    `src/eden` (`grep -rni "push_notification\|send_push\|apns\|fcm\|twilio\|sms\b" src/eden`
    returns nothing outside unrelated matches). A human only sees this if they are already looking
    at the product.
  - `WEBSOCKET` → `_dispatch_websocket` (`alert_stream.py:380-392`) calls
    `broadcast_to_job_websockets(entity_id, ...)` — only reaches a browser tab with a live socket
    already open on that exact `entity_id`'s job page. No one has that open for an attack they don't
    know is happening yet.

  Net: even a perfectly wired, perfectly triggered P0 rule under today's channel list reaches a
  human only if they happen to have the exact right browser tab open at the exact right moment.
  That is not alerting — it is, at best, a live dashboard.

**(d) A third, independently-decorative alert path exists — and it's the one a customer can
actually reach.** `src/eden/automations/engine.py` backs the portal's Automations tab
(`clients/portal/src/app/(portal)/signals/automations-panel.tsx`), whose empty-state copy reads
"Automations react to scored turns — route low-scoring runs to a dataset, ping Slack, or hit a
webhook" (line 475) and whose create form literally offers `ACTION_TYPES = ["dataset", "webhook",
"slack"]` (line 49). Unlike `alert_stream.py`, the trigger path here is real and live:
`telemetry_collector.py:1207`'s `maybe_emit_trace_finalized` → Redis stream `trace.finalized` →
`workers/trace_finalized_consumer.py` (started by `workers/sidecars.py:291`, default-on) →
`ProductionEvalSampler` → `OnlineScoringRulesEngine.apply_rules_for_trace`
(`evaluation/online/rules_engine.py:208`) → `_maybe_fire_automations` (line 280) →
`AutomationsEngine.on_score` (`automations/engine.py:80`) — traces are scored live and
automations genuinely fire on real thresholds. But `_execute_action`
(`automations/engine.py:124-156`) only implements `action_type == "dataset"` (a real
`DatasetHub.promote_trace` call). `action_type == "alert"` is a pure no-op that constructs and
returns a dict with no dispatch. `"webhook"` and `"slack"` — the two options the frontend actually
offers — fall into a generic default branch that also just returns a dict; `grep -rn
'action_type == "webhook"\|action_type == "slack"' src/eden` returns zero hits anywhere in the
codebase. The action is logged to an `automation_runs` table the UI doesn't even expose ("run
history aren't exposed by the API yet," `automations-panel.tsx:145-146`). No test anywhere
(`tests/`) exercises `AutomationsEngine` delivery behavior. This is a materially worse UX failure
than the PagerDuty gap: it's a live, self-serve product surface with copy that promises delivery,
a form that accepts the config, a 200 on save, and silent, permanent non-delivery with no error and
no way for a customer to discover the gap short of independently testing whether the Slack message
ever arrives.

**Contrast with what *is* real.** `src/eden/services/alert_email.py`'s `send_issue_alert_email` is
a genuinely working "reach a human" path — real recipient resolution (`_org_alert_recipients`,
queries `users`/`org_members` for `owner`/`admin` emails), Redis SETNX dedupe + hourly cap
(`_allow_send`), and an actual `EmailService.send_email` call. But its only callers are
`src/eden/closed_loop/orchestrator.py`'s `_maybe_alert` (invoked from `_escalate_human`, itself
reached via `route_playbook()`'s `"escalate"` verdicts on **LLM-judge-detected `agent_issues`**) and
`slack_notify.py`'s parallel Slack path. **Neither is wired to `alert_stream.py`'s rule engine or to
`sandbox.security_alert` events.** These are two structurally disconnected alerting subsystems: one
(issue-triage escalation) has working transports but is fed by LLM-judge quality/behavior findings,
not security events; the other (`alert_stream.py`'s Kafka rule engine, the one that actually defines
`rule_sandbox_escape`) has a channel list including PagerDuty/webhook but is never invoked at all.

**`anomaly_alerts.py` (data platform) confirms the same pattern with different mechanics.**
`AnomalyDetector.dispatch_alerts` (`src/eden/data_platform/anomaly_alerts.py:426-460`) explicitly
handles `channel in ("slack", "pagerduty")` with `logger.info("%s alert skipped:not_configured",
channel)` (line 457-458) — a hardcoded no-op for **both** channels, not just PagerDuty. This
function is unlike `alert_stream.py` in one respect: it **is** wired to a live producer —
`AnomalyDetectorLoop.tick_once()` (`src/eden/data_platform/anomaly_detector_loop.py:109-127`) runs
on a background asyncio task started by default (`anomaly_loop_enabled` defaults `True`,
`_is_enabled`, line 79-83) on a ~1200s/grid-aligned cadence. But `tick_once` hardcodes
`channels=["in_app"]` (line 122) on every call, unconditionally — **severity is never consulted
when choosing channels.** `check_pii_breach` (line ~320-357) always assigns `severity="critical"`
(confirmed literal: line 348) for a detected PII breach — the platform's closest analog to a P0 —
yet it is dispatched through the exact same `channels=["in_app"]` call as a routine `"warning"`
throughput blip. A critical PII breach anomaly gets one Postgres row in `notifications`, full stop.

**Elevated conclusion (see verdict above): this is an end-to-end dead path, not a single missing
integration** — shipping only a PagerDuty sender (Phase 3's original fix) would wire a working
transport onto a rule engine nothing calls, evaluating an event nothing emits. The fix has three
parts, all required together (§3).

## 0.5. The pipeline that actually reaches a human today — and its own bugs

§0 establishes that the security/P0 path (`alert_stream.py`) is dead. But it is not the only
alerting pipeline in eden, and it is not the one the product's own UI is built on. The portal's
live Inbox modal (bell icon, `clients/portal/src/lab/alerts-panel.tsx`, wired into the app shell —
`grep -rln "AlertsModal" clients/portal/src` hits `components/shell/app-shell.tsx` and
`sidebar-nav.tsx`) reads from `GET /orgs/{org}/portal/alerts/rules` and `/alerts/events`
(`src/eden/api/routes/portal.py:2092-2170`), which call `eden.alerts.repo.list_nl_rules`/
`list_alert_events` (`src/eden/alerts/repo.py:64-84,167-199`) — a previously undocumented-in-this-doc
subsystem, `src/eden/alerts/` (routes.py, compiler.py, repo.py, triage_judge.py), bridged into
`src/eden/dsl/alerts.py`'s `AlertAsCode` engine (`eql_alert_rules`/`eql_alert_firings`). This pair
is the one alert pipeline in the codebase that is **both live-wired end to end and reaches a
human**: a real cron watchdog (`AlertAsCode.fire_due`, `dsl/alerts.py:274`) runs on `eden-worker`
(`workers/main.py:589-620`, `_leader_eql_alert_watchdog`, leader-gated, interval-configurable),
evaluates due rules, `AlertTriageJudge.judge` classifies each firing, and a `real_incident` verdict
at confidence ≥ 0.7 emails the org's owner/admins (`send_nl_incident_email`,
`services/alert_email.py:143-176`). `intelligence_dsl.py:249` also calls `fire_due`-equivalent
logic on-demand. Unlike the security-P0 path, this one genuinely works, end to end, today — for
email, to admins, when the rule fires. It has three independent, high-confidence bugs of its own:

- **No self-serve authoring UI exists for the pipeline that works.** `POST
  /orgs/{org}/alerts/compile` (`alerts/routes.py:100-128`) and `POST /orgs/{org}/nl-alert-rules`
  (`routes.py:142-175`) form a complete, well-designed NL-to-EQL create flow — but `grep -rn
  "nl-alert-rules\|alerts/compile" clients/portal/src` only matches typed-but-dead wrapper
  functions in `clients/portal/src/lib/api/resources.ts:2092-2133`
  (`getAlertRules`/`compileNlAlert`/`listNlAlertRules`); no component in `clients/portal` calls
  any of it, and there isn't even a `createNlAlertRule` wrapper defined. The only client actually
  wired up (`alerts-panel.tsx:24`, `alertsApi` at `resources.ts:3461-3480`) exposes `override`
  (resolve/reopen) and `acknowledge` (mute/unmute) — read/react only. A customer cannot create a
  working alert rule through the product; the only path is a raw authenticated POST requiring
  org-admin auth and knowledge of an undocumented endpoint.
- **Severity-filter inversion: marking a rule "critical" silently disables it.**
  `AlertAsCode.compile` accepts `info|warning|high|critical` (`dsl/alerts.py:60-62`), but the
  cron watchdog's own evaluator skips any rule whose severity falls outside
  `_FIREABLE_SEVERITIES = {info, warning, high}` on every non-forced tick (`_evaluate_rule`,
  `dsl/alerts.py:404-412`), and `fire_due` — the only thing the cron watchdog ever calls — always
  passes `force=False` (line 333). `critical` is the one value excluded from
  `_FIREABLE_SEVERITIES`. A rule saved as `"critical"` is accepted by validation, looks correct,
  and then never auto-fires again — the exact opposite of what "critical" implies, and a distinct,
  independently serious trust bug living in the one pipeline the earlier passes treated as
  basically fine.
- **`channels` is collected, stored, and displayed, but never routes anything.**
  `nl_alert_rules.channels` defaults to `{"in_app": True}` (`alerts/repo.py:57`) and is shown back
  to the user (`_pick_channel`, `portal.py:324-350`), but the only live send path,
  `send_nl_incident_email`, is unconditional email to org admins with no channel argument — a user
  who configures `channels: {"slack": true}` still only ever gets email, if anything. Compounding
  this, `_trigger_triage`'s payload (`dsl/alerts.py:522-529`) never sets `fingerprint` or
  `issue_id`, so `AlertTriageJudge._find_duplicate_issue` (`triage_judge.py:76-104`) can
  structurally never return a duplicate for an EQL-sourced alert — every re-fire of the same
  broken metric is a fresh `real_incident` email, rate-limited only by a blunt Redis SETNX +
  hourly cap, not by "is this the same incident as an hour ago."

Net: eden's actual alerting *value* today is narrower and more specific than either "P0 paging
works" or "P0 paging is fully dead" — it is "we will email your org admins when an EQL rule you
configured via a raw API call fires and our triage judge calls it real," a real capability, but one
with no discoverable front door and a silent severity bug that can make the most urgent rules the
ones least likely to fire. See User Experience & Value below for the full customer-facing walk
through.

## 1. eden's own code: what's real vs. stubbed (Phase 2/3 findings, re-verified)

Three real transports exist, all gated by Redis SETNX dedup + hourly org rate caps (fail-open if
Redis is down):

| Transport | File | Status |
|---|---|---|
| Slack | `src/eden/services/slack_notify.py` | **Real.** OAuth-connected bot token per org (`slack_store.get_bot_token(org_id)`, line 149), sparse P0/P1-only policy (line 177: `if sev not in ("P0", "P1", "CRITICAL", "HIGH")`), Redis SETNX dedupe + hourly org cap fail-open (lines 55-73), per-severity emoji (`_SEV_EMOJI`, line 86). Covers: issue detected, fix PR opened, CI failure on an eden PR, approval needed, post-merge regression, loop-dead watchdog. Fed exclusively by the closed-loop issue-triage path, not `alert_stream.py` — confirmed §0. |
| Email | `src/eden/services/alert_email.py` | **Real.** Sends to org owner/admin emails from `alerts@edenobservability.com`. Same sparse P0/P1 policy, plus self-obs degraded and budget hard-limit (100%) alerts. Docstring positions it as "the P0/P1 emergency fallback" behind Slack. Also disconnected from `alert_stream.py`'s rule channel list (`rule_sandbox_escape` omits `AlertChannel.EMAIL` entirely — §0c). |
| Generic webhook | `src/eden/services/webhook_delivery.py` | **Real and production-grade.** HMAC-SHA256 signed (`X-Eden-Signature`, Stripe-style v1 scheme, lines 4/205/216), retry schedule of exactly `0s, 1s, 5s, 25s, 2m, 10m, 1h, then DLQ` (line 44 comment — 7 attempts before DLQ), Postgres-backed outbox with atomic CAS claims, DLQ with bounded/rate-limited replay (capped at 3 replays, line 401), delivery-time SSRF guard that re-resolves DNS (line 141, 827-841). This is the most mature piece of the whole alerting stack — built for delivery reliability, not incident-routing semantics. Note this is a **different** webhook sender than `alert_stream.py`'s own `_dispatch_webhook` (a bare `aiohttp` POST with no retry/HMAC/DLQ) — the hardened sender is not the one wired to the P0 rule's channel list. |
| PagerDuty | `src/eden/realtime/alert_stream.py`, `src/eden/data_platform/anomaly_alerts.py` | **Stubbed, not implemented — confirmed by direct read.** `AlertChannel.PAGERDUTY` is a real enum value (`alert_stream.py:48`) wired into a genuine-looking P0 rule — `rule_sandbox_escape` (line 178-183). But `_dispatch_pagerduty()` (**lines 427-429**) is exactly: `async def _dispatch_pagerduty(self, alert): """Send alert to PagerDuty — gated when PagerDuty is not configured."""; logger.info("PagerDuty alert skipped:not_configured: %s", alert.title)`. No HTTP call, no config lookup. Same pattern in `anomaly_alerts.py:457-458`, which also silently no-ops **Slack** on that code path, distinct from the working `slack_notify.py`. As shown in §0, fixing only this function would not make a P0 alert reachable — the rule engine around it is never invoked. Note `anomaly_alerts.py`'s dispatch function itself is otherwise real for three channels (`in_app`, `websocket`, `email` via `_dispatch_email`, line 573) plus a gated-real `webhook` — only `slack`/`pagerduty` are true no-ops there; the practical bug is that the *caller*, `AnomalyDetectorLoop.tick_once`, hardcodes `channels=["in_app"]` on every call (line 122), so even the working `email` channel is never reached regardless of severity. |
| Automations (Slack/webhook actions) | `src/eden/automations/engine.py` | **Stubbed, not implemented — the most customer-visible gap of the three.** See §0d: the portal's Automations tab lets a user configure `slack`/`webhook` actions today; `_execute_action` has no dispatch logic for either, only for `dataset`. |
| Opsgenie | — | **Does not exist anywhere in the codebase.** `grep -rni opsgenie src/eden` returns zero matches. |

**Escalation semantics.** `route_playbook()` (`src/eden/closed_loop/playbook_router.py`) maps
`issue_kind`/`root_cause`/StatGate checks/stumble signals to one of 22 hardcoded playbook
categories, e.g. `fleet_slo_breach` → `("escalate", "Fleet SLO breach — page operator")` (line 58).
Tracing the consumer (`orchestrator.py`), `action_type == "escalate"` flows into `_escalate_human()`
→ `agent_issues.status = 'escalated'` (migration `136_issue_status_escalated.py:64`) — the issue
becomes visible in the portal queue as "needs a human," and (per §0) also triggers a real
`send_issue_alert_email`/Slack post. **This is eden's one genuinely-working "P0 reaches a human"
path today — but it only covers LLM-judge-detected `agent_issues` (quality/behavior/regression
findings), never the security/infra event stream `alert_stream.py` and `anomaly_alerts.py` are
meant to cover.** No backup-responder concept, no unacknowledged-alert timeout, no secondary tier.

Three disconnected routing systems exist. **The portal Automations tab** (`automations/engine.py`)
is create-only — `list_automations`/`create`/`on_score`/`_execute_action`/`_log_run` is the entire
class, no `update`/`delete`/`toggle` method exists anywhere in it, and the route/client layers
above it (`api/routes/wave6_online.py:209,217`, `resources.ts:4419-4434`) independently confirm no
mutate-after-create path exists at any layer — and, per §0d, its Slack/webhook actions don't
dispatch at all. **`playbook_router.py`** is hardcoded (22 categories) and drives the one working
escalation path (LLM-judge issue-triage → Slack/email), but has no user-facing configuration
surface — a customer cannot tell eden "escalate to *this* Slack channel for *this* class of issue"
through any UI. **`src/eden/dsl/alerts.py`'s `AlertAsCode`**, bridged from `src/eden/alerts/`'s
NL-rule API, is the pipeline detailed in §0.5 above — real and cron-fired, but with no authoring UI
of its own and a severity-filter bug. None of the three share a data model, a severity concept, or
a notification-destination concept; a customer who wants "alert me on X, send it to Y" has to pick
one of three incompatible, individually broken systems, and one of the three (the only one with
working delivery) has no UI at all.

## User Experience & Value

**Who is the user.** Two distinct personas, and eden's product currently serves only one of them.
**(a) The rule author** — a PM or on-call engineer who wants "page me when error rate exceeds 5%"
or "tell me about a sandbox escape." This person needs to author a condition, name it, pick a
destination (Slack/email/PagerDuty/webhook), save it, and edit or disable it later without
re-typing it. **(b) The on-call consumer** — someone who gets notified, or checks an inbox after
the fact, and needs the payload to say *what broke* and *what to do about it*, with a click to the
underlying trace or issue.

**The flow, walked end to end, for the pipeline that actually works (§0.5).** A rule is created via
a raw authenticated `POST /orgs/{org}/nl-alert-rules` call (no UI) → the cron watchdog on
`eden-worker` evaluates it on an interval → a firing is triage-judged → a `real_incident` verdict
emails the org's owner/admins → the portal's bell-icon Inbox (`alerts-panel.tsx`) surfaces it with
filter chips (Open/Firing/Muted/Resolved/All, live counts) and deep links to the Issue, Run, and
Detector → the user clicks **Resolve** (`alertsApi.override(..., "benign")`), **Reopen**
(`override(..., "real_incident")`), or **Mute/Unmute** (`acknowledge`), which land on
`alerts/routes.py:249-267,270-323` and persist as structured feedback to `alert_triage_feedback`
(`alerts/repo.py:224-280`) — a real foundation for a "teach the detector" loop, though nothing
currently consumes that feedback table beyond the insert. The `/alerts` route is an intentional
soft-redirect ("Firing alerts open from the bell Inbox … there is no separate Alerts page anymore,"
`app/(portal)/alerts/page.tsx:6-11`) — a deliberate single-inbox IA decision, not an oversight. This
consumption half of the loop is the strongest piece of alerting UX in the codebase and is
underrepresented in a security/PagerDuty-focused reading of this feature: it gives an on-call
consumer real, actionable, cross-linked context, not just a title string.

**But the authoring half of the loop — persona (a) — does not exist in the product.** The backend
is genuinely good: `POST /orgs/{org}/alerts/compile` takes free text ("alert me when error rate
exceeds 5% in the last hour"), reuses the same NL→structured-rule extractor as the Detectors
feature, maps known metrics (`error_rate`, `refusal_rate`, `latency_p99`, `cost_per_call`,
`tool_call_rate`, …) to a parameterized EQL query, lints it, and returns the compiled query plus
warnings and a suggested name — exactly the "explain what I'm about to alert on" UX a rule author
needs. No component in `clients/portal` calls it. The result is three separate, incompatible
"create a rule that watches your traces" flows in the product, none of which is the one that
works:
1. **Detectors tab NL prompt** (`signals-client.tsx`, `CreateSignalDialog`) — free text through a
   *different*, OpenRouter-backed Next.js API route that never touches `AlertCompiler` or
   `nl_alert_rules`; produces a client-side draft with no channel/destination field at all (`grep -n
   "channel\|slack\|pagerduty\|webhook\|Notify\|destination" signals-client.tsx` — zero hits).
2. **Automations tab** — the only flow with a visible Slack/webhook destination field, but per §0d
   the actions don't dispatch, and per §0's routing-systems note it's also create-only with no
   edit/delete/toggle at any layer of the stack — a typo'd Slack channel or dead webhook URL cannot
   be fixed once saved, only orphaned.
3. **The NL-alert API** (§0.5) — has channels, has severity, is the one pipeline where delivery
   actually works, and has no UI at all.
A prospective customer evaluating "can I tell eden to alert me on X" today would find a
free-text box that doesn't route anywhere, a routing UI that doesn't deliver, and a working
delivery pipeline reachable only by reading this codebase.

**Even where the working pipeline's config fields exist, they're cosmetic.** `nl_alert_rules.channels`
is collected, defaulted, and displayed on the rule card — but the only live send path
(`send_nl_incident_email`) is unconditional email with no channel argument, so configuring `{"slack":
true}` still only ever produces email, if anything (§0.5). The portal's rule card additionally
hardcodes `severity="warn"` for every NL alert rule regardless of what was configured
(`portal.py:2119`) — `nl_alert_rules` doesn't even store severity, only the bridged
`eql_alert_rules` row does — so a user has no way to see, from the UI, what severity their rule was
actually registered at, compounding the severity-filter inversion bug in §0.5.

**The payload doesn't speak the language the user configured it in.** `_trigger_triage` builds the
alert payload from `eql_query`/`n_rows`/`sample_rows` — no natural-language summary, no runbook
link. The Inbox detail pane renders this as **"Condition,"** in monospace, sourced from
`compiled_eql` (`portal.py:2118`, `alerts-panel.tsx:299-309`) — generated SQL, not the plain-English
sentence (`nl_alert_rules.nl_text`) the user actually typed when creating the rule. For persona (a),
the thing they see when their alert fires is not their own words.

**Noise control is thin and structurally broken for the pipeline that fires.**
`AlertTriageJudge.judge` is four hardcoded regexes for known-benign patterns plus a duplicate-issue
lookup keyed on `fingerprint`/`issue_id` — fields `_trigger_triage`'s payload never populates
(`dsl/alerts.py:522-529`), so duplicate suppression can structurally never trigger for an
EQL-sourced alert (§0.5). Every re-fire of the same still-broken metric is a fresh `real_incident`
email, rate-limited only by a blunt Redis SETNX + hourly cap, not by "is this the same incident as
an hour ago." There is no UI or API to add a suppression rule ("our Tuesday batch job always spikes
latency, don't page for it") — that requires a code change today, where competitors in §2 treat
suppression windows and dedup keys as first-class config.

**Net adoption read.** Ranked by how basic the blocker is: (1) you cannot configure a working alert
through the product at all — the one pipeline that delivers has no UI, full stop, a more
fundamental gap than any transport issue; (2) if you did configure one via a raw API call, the
channel you picked is ignored and marking it "critical" silently stops it from ever auto-firing;
(3) the Automations tab *looks* like the missing authoring UI — Slack/webhook destination picker,
clean create form — but doesn't deliver anything and can't be edited once saved; (4) what does
arrive is a SQL fragment, not the user's own words, with no working repeat-suppression. Against
that, the consumption side (Inbox, deep links, resolve/reopen/mute mapped to a real triage
feedback table) is genuinely good and worth keeping and building on — the value gap is almost
entirely on the authoring/configuration side, not the display side. None of this requires the §3
`alert_stream.py` fix to address; it requires shipping a frontend for an authoring API that already
exists, fixing the severity-filter inversion, making `channels` route, and giving the triage judge
a real dedup signal (§3 items 6-8) — a materially different, and in some ways smaller, engineering
lift than the PagerDuty work, and a precondition for any of it being sellable: a working PagerDuty
sender behind an unreachable rule-creation UI is exactly as useless to a customer as a working
PagerDuty sender behind an unreachable rule *engine*.

## 2. Competitive landscape — technical escalation-routing architecture (deepened, primary sources)

Phase 3 covered product-page-level comparisons. Phase 4 dug into how severity-based routing and
escalation timers are actually implemented under the hood at three vendors, to make explicit the
mechanism gap between eden's `alert_stream.py` (a rule → channel list, no timers, no acknowledgment
state machine) and a real escalation engine:

**incident.io** — routing is condition-based over alert *metadata*, not event type: alert tags/labels
(environment, service, severity) are matched against a Service Catalog to select an escalation path
without custom code — e.g. a CPU spike tagged `service:api` routes to the platform team while a
failed-payment webhook tagged `service:payments` routes to payments engineering. This is the
mechanism eden's `route_playbook()` approximates for issue-triage, but nothing analogous exists for
`alert_stream.py`'s rule engine (rules match on hardcoded `event_types` lists, not tenant-configurable
metadata routing). **Webhook retry semantics are explicit and time-boxed**: a non-2xx response
triggers resend-with-backoff for up to 24 hours; if an endpoint fails for 5 consecutive days it is
auto-disabled and the owner is emailed. eden's own `webhook_delivery.py` retry ladder (0s→1h, 7
attempts, then DLQ) is faster to give up but otherwise structurally similar — the ladder plus DLQ
pattern is industry-standard, not incident.io-specific.
[Escalation policies guide](https://incident.io/blog/incident-escalation-policies-guide), [incident.io Webhooks API docs](https://api-docs.incident.io/tag/Webhooks/), [Escalations API / triggering from external systems](https://incident.io/blog/incident-escalation-policies-guide)

**Better Stack** exposes escalation timers as literal, structured API fields, not prose config: a
`policies` object has `repeat_count`/`repeat_delay` (how many times and how often the whole ladder
re-runs) and a `steps` array, each step typed `"escalation"` / `"time_branching"` /
`"metadata_branching"`, carrying `wait_before` (seconds before that step fires — the actual
escalation-timer primitive), `urgency_id` (severity/urgency binding), and `step_members`
(`current_on_call` / `entire_team` / `all_slack_integrations`). A documented example: step 1
`wait_before: 0` pages current on-call; step 2 `wait_before: 600` (10 min unacknowledged) pages the
entire team; the whole policy can `repeat_count: 3` with `repeat_delay: 1800`. **`alert_stream.py`
has none of this** — no `wait_before`, no repeat/re-page semantics, no acknowledgment-gated
progression; `AlertRule.escalation_delay_seconds`/`auto_escalate` fields exist on the dataclass
(`alert_stream.py:66-67`) but `grep -rn "auto_escalate\|escalation_delay_seconds" src/eden` shows
they are read nowhere outside their own definition and the one rule that sets `auto_escalate=True`
(`rule_cost_spike`) — the fields are inert schema, not implemented behavior.
[Better Stack escalation policies API](https://betterstack.com/docs/uptime/api/create-escalation-policy/), [Better Stack escalation policy guide](https://betterstack.com/community/guides/incident-management/escalation-policies/), [Response attributes](https://betterstack.com/docs/uptime/api/escalation-policies-api-response-params/)

**Datadog On-Call** routes on explicit "Routing Rules" that set a Page's urgency and select an
escalation policy by event metadata, with a support-hours concept: inside support hours the policy
runs immediately; outside support hours (with "hold" enabled) the Page is created immediately but
notification is postponed to the next window — i.e. the P0 is never silently dropped, only delayed
with the record preserved. Escalation steps default to "Notify All" (every target in the step
simultaneously) with an opt-in Round Robin mode. **Webhook idempotency/atomicity is treated as a
first-class reliability requirement**: because Datadog may resend the same alert on network retry,
processing must be idempotent, and all related writes (ticket creation, team assignment, escalation
schedule) are expected to happen as a single atomic transaction to avoid partial state — a
discipline `alert_stream.py`'s per-channel try/except-and-continue dispatch loop
(`_dispatch_alert`, lines 313-328) does not attempt: a partial failure (e.g. in-app succeeds,
webhook throws) is logged and swallowed per-channel with no compensating action or retry.
[Datadog Escalation Policies](https://docs.datadoghq.com/incident_response/on-call/escalation_policies/), [Datadog Routing Rules](https://docs.datadoghq.com/incident_response/on-call/routing_rules/), [Datadog webhook best practices](https://datadog.criticalcloud.ai/best-practices-for-datadog-webhooks/)

**Net technical gap eden has vs. all three**: real escalation engines key on (1) tenant-configurable
metadata-based routing, not hardcoded event-type lists; (2) an explicit `wait_before`/timer field
per step, driving genuine re-paging on non-acknowledgment; (3) idempotent, atomic multi-channel
dispatch. `alert_stream.py` has a rule → static channel list and nothing else — and, per §0, isn't
even reachable from a live event today.

**(Phase 3 competitive content — PagerDuty, Opsgenie sunset dates, Arize/Galileo/Lemma/Langfuse/
Helicone, and incident.io's AI-triage-on-classic-escalation-policies pattern — re-verified, unchanged,
retained in the Phase 1-3 appendix below rather than restated here.)**

## 3. Assessment: minimum real alerting surface vs. building a full on-call product

**Do not build a full on-call product.** Unchanged from Phase 3 — PagerDuty/Opsgenie(until 2027)/
Better Stack already own schedules, rotations, mobile ack, silent-vs-paging policies, and SLA timers,
and Better Stack undercuts on price with its own AI root-cause agent. Building a competing on-call
product is out of scope.

**The minimum real surface eden needs — reordered by what §0 proved is actually blocking:**
1. **Wire `alert_stream.py`'s rule engine to a live event source.** Today `process_event` is dead
   code (§0a) — the highest-priority fix, ahead of any channel work, since no channel fix matters
   until rules actually evaluate against real events. This means either subscribing an "alerts
   service" consumer to the `eden-alert` Kafka topic (as `kafka_consumer.py`'s own comment already
   assumes exists) or calling `process_event` inline wherever Kafka events land today.
2. **Emit `sandbox.security_alert` events from an actual security-relevant source.** No producer
   exists (§0b). Candidates: the sandbox runtime's escape guard (`sandbox/runner.py`) and/or the
   guardrails policy engine (`src/eden/guardrails/`), neither of which currently talks to Kafka or
   `alert_stream.py` at all.
3. **Add `EMAIL` to `rule_sandbox_escape`'s channel list** and reuse the already-working
   `send_issue_alert_email` (or extend `_dispatch_email`, which already calls it — line 394-408 —
   just not from this rule) — the only channel in this file with a real "leaves the building"
   mechanism, and it's currently the one omitted from the P0 rule.
4. **Then**, and only then, build a working PagerDuty Events API v2 sender (Phase 3's original
   recommendation still stands as a channel-level fix) and a generic Opsgenie-compatible webhook,
   reusing `webhook_delivery.py`'s existing HMAC/retry/DLQ/SSRF infrastructure rather than the bare
   `aiohttp` POST currently in `_dispatch_webhook`.
5. **Fix `anomaly_alerts.py`'s severity-blind dispatch**: `AnomalyDetectorLoop.tick_once` should pass
   channels based on `alert.severity`, not a hardcoded `["in_app"]` — a `severity="critical"` PII
   breach finding should not be dispatched identically to a `"warning"` throughput blip. Since
   `email`/`webhook`/`websocket`/`in_app` are all already implemented in the dispatch function
   itself (only `slack`/`pagerduty` are true no-ops there), this fix is cheaper than it looks — it's
   entirely a call-site change, not new channel-implementation work.
6. **Fix the `eql_alert_rules` severity-filter inversion** (§0.5): `_FIREABLE_SEVERITIES` currently
   excludes `critical`, silently disabling the most urgent rules on every non-forced tick — a
   one-line, high-confidence, independently-shippable bug fix in the one pipeline that otherwise
   works end to end.
7. **Ship a self-serve authoring UI for the NL-alert pipeline** (`alerts/compile` +
   `nl-alert-rules`, §0.5) — it is fully built server-side and reachable only via raw authenticated
   API calls today. This is a smaller, more valuable lift than the PagerDuty work above, since it's
   the one pipeline where delivery already works.
8. **Make `nl_alert_rules.channels` actually route**, and populate `fingerprint`/`issue_id` on
   EQL-triage payloads so duplicate-alert suppression (`AlertTriageJudge._find_duplicate_issue`)
   can trigger — both currently inert (§0.5).
9. **Do not** build schedules, rotations, ack/snooze UI, or SLA timers in-house — let a real on-call
   tool own that graph, per §2's technical comparison.

## 4. Recommendation

- **Do not claim any working alerting/paging capability for security or infra P0 events** in any
  customer-facing material — not just "don't claim PagerDuty support." The entire path from a
  sandbox-escape/security event to a human is non-functional today: no producer emits the trigger
  event, no consumer evaluates the rule, and even a manually-constructed test event would route
  through a channel list that excludes the one working "reach a human" transport. This is a
  trust/correctness issue, not a feature gap — a customer relying on eden to page them for a P0
  security event would not be paged, full stop. The same caution applies to the portal's
  Automations tab (§0d): its Slack/webhook actions should not be presented as functional — the UI
  currently promises delivery it does not provide.
- **Do not claim self-serve alert configuration** either. The one pipeline that reliably reaches a
  human (§0.5, NL-alert → EQL → email) has no authoring UI — a customer cannot configure it through
  the product today at all, independent of and more fundamental than any transport gap.
- **Sequence the fix as §3 orders it**: wire the event source and consumer before touching PagerDuty
  transport, since a working PagerDuty sender changes nothing while `process_event` is unreachable.
  In parallel, the §0.5 fixes (severity-filter inversion, channel routing, authoring UI) are cheaper,
  independent, and higher-value, since they complete a pipeline that already delivers.
- **Build a PagerDuty Events API v2 sender** (and, lower priority given the 2027 sunset, a generic
  Opsgenie webhook) reusing `webhook_delivery.py`'s retry/DLQ/SSRF infrastructure — but only as step
  4 of the §3 sequence, not the headline fix.
- **Do not build schedules/rotations/ack/snooze/mobile paging.** Out of scope per §2/§3.
- **Unify the three routing systems**: the Automations tab, `playbook_router.py`, and
  `alert_stream.py`'s Kafka rule engine share no data model, severity concept, or notification
  destination concept today, and the NL-alert/`AlertAsCode` pipeline (§0.5) is a fourth, separate
  system again. A customer who wants "alert me on X, send it to Y" has no single place to configure
  that.
- **Rename "escalate"/"page operator" copy** in `_PLAYBOOK_ACTIONS` and any UI string derived from
  `alert_stream.py`'s rule channels — both currently overstate real behavior.

## 5. Confidence

**High** on all §0 dead-path claims — each is a grep-verified absence (zero external callers of
`process_event`; zero emitters of `sandbox.security_alert`; zero push/SMS/APNs/FCM code; zero test
coverage of `alert_stream.py`), not an inference from partial reading, cross-checked against
`kafka_consumer.py`, `ksql_cep.py`, `grpc_server.py`, `notifications.py`, `sandbox/runner.py`, and
`security_scanner.py` to rule out an alternate wiring path being missed.

**High** on eden's transport-level code claims (Phase 2/3, re-verified in this pass):
`alert_stream.py:48,66-67,178-183,313-328,330-392,394-408,410-425,427-429`,
`anomaly_alerts.py:122(anomaly_detector_loop.py),348,426-460,573`, `anomaly_detector_loop.py:79-83,109-127`,
`config.py:1546`, `playbook_router.py:58`, `orchestrator.py` (`_escalate_human`/`_maybe_alert`),
`alert_email.py` (full file), `notifications.py:54`, migration `136_issue_status_escalated.py:64`.

**High** on §0d and §0.5's findings — independently grep/read-verified in this pass, not inferred:
`automations/engine.py:80,124-156`, `rules_engine.py:208,280,487,497`,
`automations-panel.tsx:49,145-146,475`, zero hits for `action_type == "webhook"|"slack"` anywhere
in `src/eden`; `alerts/routes.py:81-97,100-128,142-175`, `alerts/repo.py:57,64-84,167-199,224-280`,
`alerts/triage_judge.py:24-104`, `dsl/alerts.py:60-62,274,333,404-412,522-529`,
`workers/main.py:589-620`, `portal.py:2092-2170,2118-2119,324-350`, `alerts-panel.tsx:24,196-296,
299-309,633-652`, `resources.ts:2092-2133,3461-3480,4419-4434`; zero-hit greps confirmed for any
`clients/portal` caller of `nl-alert-rules`/`alerts/compile`.

**High** on the incident.io/Better Stack/Datadog technical-architecture claims in §2 — sourced from
each vendor's own API docs (Better Stack's `steps`/`wait_before`/`repeat_count` schema, incident.io's
webhook retry-window/auto-disable policy, Datadog's routing-rules support-hours and idempotency
guidance) rather than marketing pages.

**Medium** on the Phase 3 competitive claims retained below (Galileo, Lemma) — unchanged confidence
from the prior pass, not re-verified in this pass.

## Sources

**New in this pass:**
- [incident.io — Incident escalation policies guide](https://incident.io/blog/incident-escalation-policies-guide)
- [incident.io — Webhooks API docs (retry/backoff/auto-disable semantics)](https://api-docs.incident.io/tag/Webhooks/)
- [Better Stack — Create escalation policy API (steps/wait_before/repeat_count schema)](https://betterstack.com/docs/uptime/api/create-escalation-policy/)
- [Better Stack — Escalation policy design guide](https://betterstack.com/community/guides/incident-management/escalation-policies/)
- [Better Stack — Escalation policy API response attributes](https://betterstack.com/docs/uptime/api/escalation-policies-api-response-params/)
- [Datadog — Escalation Policies (On-Call)](https://docs.datadoghq.com/incident_response/on-call/escalation_policies/)
- [Datadog — Routing Rules (support hours, urgency mapping)](https://docs.datadoghq.com/incident_response/on-call/routing_rules/)
- [Datadog webhook best practices — idempotency/atomicity guidance](https://datadog.criticalcloud.ai/best-practices-for-datadog-webhooks/)

**Carried forward from Phase 1-3 (re-cited, unchanged):**
- [PagerDuty — Escalation Policy Basics](https://support.pagerduty.com/main/docs/escalation-policies)
- [PagerDuty — Escalation Policies and Schedules](https://support.pagerduty.com/main/docs/escalation-policies-and-schedules)
- [PagerDuty Full-Service Ownership — Escalation Policies](https://ownership.pagerduty.com/escalations/)
- [Datadog Integration Guide (PagerDuty docs)](https://www.pagerduty.com/docs/guides/datadog-integration-guide/)
- [Opsgenie ↔ Datadog (Atlassian)](https://www.atlassian.com/software/opsgenie/datadog)
- [Opsgenie shutdown guide (Spike)](https://spike.sh/blog/opsgenie-shutdown-what-you-need-to-know-and-your-next-steps/)
- [Atlassian Opsgenie availability changes effective June 4, 2025 (Adaptavist)](https://www.adaptavist.com/blog/atlassian-opsgenie-availability-changes-effective-june-4-2025)
- [Opsgenie migration guide (incident.io)](https://incident.io/blog/how-to-migrate-opsgenie-playbook)
- [Better Stack — Incident Management](https://betterstack.com/incident-management)
- [Better Stack Review 2026 (SoftwareTestingHelp)](https://www.softwaretestinghelp.com/better-stack-review/)
- [Arize AX — Alerting Integrations](https://arize.com/docs/ax/observe/production-monitoring/alerting-integrations)
- [Arize AX — PagerDuty](https://arize.com/docs/ax/observe/production-monitoring/pagerduty)
- [Arize — OpsGenie integration](https://docs.arize.com/arize/integrations/monitoring-integrations/opsgenie)
- [Galileo vs Braintrust](https://galileo.ai/blog/galileo-vs-braintrust)
- [Lemma — Production monitoring for AI agents](https://www.uselemma.ai/)
- [Lemma on Y Combinator](https://www.ycombinator.com/companies/uselemma)
- [Langfuse — webhooks/Slack integrations](https://langfuse.com/docs/prompt-management/features/webhooks-slack-integrations)
- [incident.io — Escalation policy best practices](https://incident.io/blog/escalation-policy-best-practices)
- [incident.io — Escalating incidents (docs)](https://docs.incident.io/incidents/escalating)
- [AI Agent Incident Response: From Alert to Fix (Augment Code)](https://www.augmentcode.com/guides/ai-agent-incident-response)
- [Escalation policy tools comparison: incident.io vs. PagerDuty vs. Opsgenie](https://incident.io/blog/escalation-policy-tools-comparison)

---

## Appendix: Phase 1-3 pass

Phase 1-3 findings (PagerDuty no-op, hardcoded playbook categories, Automations tab read-only after
create, Opsgenie sunset timeline, Arize AX's native PagerDuty/OpsGenie integrations, Better Stack's
AI-SRE agent) were fully re-verified in Phase 4 and are superseded by, and folded into, §0-§5 above;
no standalone appendix content remains.
