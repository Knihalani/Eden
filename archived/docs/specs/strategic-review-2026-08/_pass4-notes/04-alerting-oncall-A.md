# Pass 4 Notes — 04-alerting-oncall.md — Agent A (Fact-Verifier & Pruner)

Scope: re-grounded every non-trivial code claim in `features/04-alerting-oncall.md` against
current source. Also chased the KNOWN-SUBSYSTEMS.md pointer to `automations/engine.py` since the
doc as written does not cite that file at all despite it being flagged as "F4 territory."

## VERDICT ON THE CORE FINDING

**"P0 alert path is decorative end-to-end" — RE-VERIFIED, STILL ACCURATE, and I found a third
example that makes it stronger, not weaker.** Every §0 claim I checked (rule engine has zero
external callers, trigger event has zero emitters, PagerDuty/webhook channels are no-ops/unconfigured
by default, EMAIL is omitted from the P0 rule's channel list) held exactly as cited. See VERIFIED
below for line-by-line confirmation. The new automations/engine.py finding (see NEW FINDINGS) is a
*third*, independently-decorative alert path, worse in one respect: it's the one path that's
genuinely wired to a live production event stream, and its UI actively promises delivery that
doesn't exist in the backend.

## VERIFIED

All file:line citations below were independently re-checked against current source, not just
grepped for existence — I read the surrounding function bodies.

- `alert_stream.py:194` `process_event` and `:217` `process_batch` — confirmed only two call
  sites in the whole `src/eden` tree: `alert_stream.py:10` (inside the module docstring, a
  triple-quoted comment) and `alert_stream.py:221` (process_batch's own internal loop calling
  process_event on itself). **Zero external callers**, confirmed via
  `grep -rn "\.process_event(\|\.process_batch("` — the only src/eden hits outside this file are
  unrelated (`insights_service.py:228,268` call a different `dataset_engine.process_batch`).
- `alert_stream.py:178-183` `rule_sandbox_escape` — confirmed exact:
  `event_types=["sandbox.security_alert"]`, `channels=[AlertChannel.IN_APP, AlertChannel.WEBSOCKET,
  AlertChannel.PAGERDUTY, AlertChannel.WEBHOOK]`. EMAIL is genuinely absent from this list.
- `sandbox.security_alert` emitters — confirmed zero. The only match anywhere in `src/eden` for
  that string is the rule definition itself (`alert_stream.py:181`).
- `alert_stream.py:427-429` `_dispatch_pagerduty` — confirmed one-line no-op, exact text: `logger.info("PagerDuty alert skipped:not_configured: %s", alert.title)`, no HTTP call.
- `config.py:1546` `alert_webhook_url: str | None = None` — confirmed exact line and default.
- `notifications.py:54` — confirmed the only `@router.get("")` list endpoint; POST/PATCH/DELETE
  also exist (lines 156, 242, 276, 299) but none are push/fan-out, consistent with the doc's
  narrower "no push fan-out" claim.
- `anomaly_alerts.py:426-460` `dispatch_alerts`, `:457-458` — confirmed exact:
  `elif channel in ("slack", "pagerduty"): logger.info("%s alert skipped:not_configured", channel)`.
  Both channels hardcoded no-op, confirmed.
- `anomaly_alerts.py:348` `check_pii_breach` — confirmed `severity="critical"` is unconditional
  (the only `severity=` assignment in that function; contrast with the other three anomaly checks
  in the same file at lines 186/265/308, which are all conditional `"critical" if ... else
  "warning"`). The doc's "always critical" claim is accurate and, notably, the *one* unconditional
  critical-severity case in the file.
- `anomaly_detector_loop.py:79-83` `_is_enabled` (defaults `True` via `anomaly_loop_enabled`),
  `:109-127` `tick_once`, `:122` `channels=["in_app"]` hardcoded unconditionally — all confirmed
  exact.
- `alert_stream.py:66-67` `auto_escalate`/`escalation_delay_seconds` dataclass fields, `:159`
  `rule_cost_spike` is the only rule setting `auto_escalate=True` — confirmed. Also confirmed the
  doc correctly avoids conflating this with the *different*, unrelated `auto_escalate` field on
  `StatGate`/`TriageScore` (`statgate_scorer.py`, `triage_agent.py`, `orchestrator.py:366`) — those
  are a separate concept on a separate dataclass; the doc's "read nowhere outside their own
  definition" claim is specifically and correctly scoped to the `AlertRule` field.
- `slack_notify.py` — confirmed OAuth token lookup (`get_bot_token`, line 149), sparse policy
  (`if sev not in (...)`, line 177), `_SEV_EMOJI` (line 86). Confirmed the 6 event senders listed
  (`notify_issue_detected`, `notify_pr_opened`, `notify_ci_failure`, `notify_needs_approval`,
  `notify_regression`, `notify_loop_dead`) match exactly, and all their callers
  (`closed_loop/verify.py`, `closed_loop/orchestrator.py`, `improvement/approve.py`,
  `improvement/guardian.py`, `improvement/issue_patch_trigger.py`, `api/routes/github.py`,
  `services/soft_issue_review.py`) are closed-loop/self-improvement machinery — none touch
  `alert_stream.py`. "Fed exclusively by the closed-loop issue-triage path" holds.
- `alert_email.py` — confirmed `_org_alert_recipients` queries `users`/`org_members` joined on
  `role IN ('owner','admin')` (lines 27-42), `_allow_send` is Redis SETNX + hourly cap, fail-open
  if Redis is `None` (lines 54-69). Confirmed real.
- `webhook_delivery.py` — confirmed retry-ladder comment "0s, 1s, 5s, 25s, 2m, 10m, 1h, then DLQ"
  (line 44), HMAC `X-Eden-Signature` header (multiple sites), SSRF guard `_assert_public_ip` that
  re-resolves DNS at delivery time (~line 139) — confirmed real and distinct from
  `alert_stream.py`'s own bare-`aiohttp` `_dispatch_webhook`.
- `playbook_router.py:58` `fleet_slo_breach` → `("escalate", ...)` and the "22 hardcoded playbook
  categories" claim — confirmed exact count (`grep -c '": ('` = 22).
- Migration `136_issue_status_escalated.py` exists at the cited path. Did not re-verify line 64
  content specifically (low-value check on a migration file), flagging as unverified-but-plausible.
- Opsgenie: confirmed zero matches for "opsgenie" anywhere in `src/eden`.
- Push/SMS/APNs/FCM/Twilio: confirmed zero real implementation matches; the only hits are unrelated
  taxonomy/regex pattern strings (`descriptors/taxonomy.py:194`, `descriptors/signals.py:258`) used
  for classifying trace *content*, not sending notifications.
- `dsl/alerts.py` (AlertAsCode / `eql_alert_firings` / `send_nl_incident_email`) — confirmed real
  and, additionally (not currently stated in the doc): **`fire_due()` is actually called from
  `workers/main.py:604`** — this third alerting pipeline is live-wired to a scheduled worker, unlike
  `alert_stream.py`. Worth a one-line addition since it slightly undersells how real this path is
  relative to the two broken ones — reinforces the doc's own "rescope, don't build a full on-call
  product" framing (eden clearly *can* wire alerting correctly when it tries).

## CUT (quote + reason)

1. **Redundant appendix, quote: lines 309-330, "Appendix: Phase 1-3 pass (retained for
   traceability; content folded into §1-5 above)."** The doc's own text admits this content is
   "folded into §1-5 above" — i.e., it says nothing the main body doesn't already say, at greater
   length. Concretely: line 311's `alert_stream.py:427-429` re-cite duplicates §1's table row;
   lines 315-320's Phase 3 summary duplicates §4's recommendation bullets; lines 322-330's "Phase 4
   does not overturn any Phase 3 finding... this is a fully decorative alerting path" duplicates the
   Verdict paragraph (lines 6-16) and §0's "Elevated conclusion" (lines 102-107) nearly verbatim.
   For a *final* pass, this whole appendix should be cut to a single sentence ("Phase 2/3 findings
   fully re-verified and superseded by §0-§4 above; no appendix needed") rather than ~20 lines
   restating the headline three more times.

2. **The "decorative/dead path" thesis is stated in full at least five separate times**: Verdict
   (lines 6-16), §0 "Elevated conclusion" (102-107), §3 opening line (204-209), §4 first bullet
   (230-236), §5 Confidence intro (252-256), and the Appendix close (322-330). Each restatement adds
   phrasing variety but no new evidence. Recommend collapsing to: state it once, fully, in the
   Verdict; every other section should reference it in one clause ("per §0...") rather than re-argue
   it. This is the single biggest redundancy in the doc.

3. **Quote: "Two disconnected routing systems exist, as previously noted: the portal Automations
   tab (user-authorable, read-only after create, no severity concept) and `playbook_router.py`"
   (lines 133-134).** Not false, but incomplete/stale given NEW FINDINGS below — the "portal
   Automations tab" is backed by `automations/engine.py`, which the doc never names, and that
   engine's own "alert" action type is *also* a no-op (see NEW FINDINGS). This isn't a CUT so much
   as a gap that should be filled — flagging here since the sentence as currently written
   undersells what's actually there. Recommend replacing "as previously noted" hand-wave with the
   `automations/engine.py` specifics.

4. No claims found to be factually false. No speculative/unverifiable claims found beyond the
   explicitly-flagged "Medium confidence... not re-verified" competitive citations (Galileo, Lemma),
   which are honestly labeled as such already — not a pruning issue.

## USER EXPERIENCE & VALUE (draft — Agent B will go deeper)

**What a customer actually experiences today, walked end to end:**

- A customer configures a "P0 security alert" expectation (implicitly, by the mere existence of a
  `rule_sandbox_escape` rule with `PAGERDUTY` in its channel list, an `AlertChannel.PAGERDUTY` enum,
  and `/alerts`/`/alert-rules` list/acknowledge endpoints in `replay.py`) and reasonably assumes a
  sandbox escape will page someone. **Nothing happens, ever, for this class of event** — not a
  degraded experience, a *nonexistent* one. The customer discovers this only when a real incident
  occurs and no page arrives — the worst possible time to discover an alerting gap, and one that
  actively damages trust once found (a security promise silently unmet is categorically worse than
  a missing feature that was never claimed).
- A customer using the Automations tab in the portal reads the empty-state copy — **"Automations
  react to scored turns — route low-scoring runs to a dataset, ping Slack, or hit a webhook"**
  (`automations-panel.tsx:475`) — and configures a "ping Slack" or "hit a webhook" automation.
  **Nothing is ever sent.** The backend (`automations/engine.py::_execute_action`) has no branch for
  `action_type == "webhook"` or `"slack"` — it falls through to a generic catch-all that returns a
  dict and logs it to an internal `automation_runs` table the UI doesn't even expose (`"run history
  aren't exposed by the API yet"`, line 145-146). This is a materially worse UX failure than the
  PagerDuty gap: it is not "the feature we haven't built yet," it is a live product surface with
  copy that promises delivery, a form that accepts the configuration, a 200 OK on save, and silent,
  permanent non-delivery with no error, no run history, and no way for the customer to discover the
  gap short of independently testing whether the Slack message actually arrived.
- The one alerting path that genuinely reaches a human — `alert_email.py`/`slack_notify.py` via
  `closed_loop.orchestrator`'s escalation — is real and reasonably well-built (real recipient
  resolution, dedupe, rate caps), but it is scoped narrowly to LLM-judge-detected `agent_issues`
  (quality/behavior/regression findings). A customer cannot point this path at their own security or
  infra signal; it isn't user-configurable at all, unlike the (non-functional) Automations tab which
  *looks* configurable.
- Net value assessment: eden's actual alerting *value* today is "we will email/Slack you when our
  own quality judge flags one of your agent's issues" — a real and reasonably differentiated
  capability worth keeping and marketing honestly. Everything adjacent to that (security P0 paging,
  user-authored Slack/webhook automations, PagerDuty/Opsgenie) is either fully inert or actively
  misleading in its current UI framing, and should not be claimed as working in customer-facing
  material, sales conversations, or SOC2/security-questionnaire responses (a "do you have automated
  security alerting" checkbox answered "yes" today would be inaccurate).

## NEW FINDINGS

**A third, independently-decorative alert path: `automations/engine.py`'s "alert"/"webhook"/"slack"
action types are unimplemented, despite the pipeline that reaches them being genuinely
production-wired — and despite the frontend explicitly promising Slack/webhook delivery.**

This directly answers the KNOWN-SUBSYSTEMS.md pointer ("AutomationsEngine.create/on_score/
_execute_action is a real automation/alert-routing engine... this doc should already account for
it"). It currently does not — the doc mentions "the portal Automations tab" twice (lines 133, 243)
but never names `automations/engine.py`, never traces its wiring, and never checks what its "alert"
action actually does. Evidence:

1. **The trigger path is real and live**, unlike `alert_stream.py`'s dead rule engine:
   `telemetry_collector.py:1207` → `maybe_emit_trace_finalized` → Redis stream `trace.finalized` →
   `workers/trace_finalized_consumer.py` (started by `workers/sidecars.py:291`, a default-on
   background task) → `ProductionEvalSampler.maybe_score_trace`
   (`evaluation/production/sampler.py`) → `OnlineScoringRulesEngine.apply_rules_for_trace`
   (`evaluation/online/rules_engine.py:208`) → `_maybe_fire_automations` (line 280, calling the
   method defined at line 487) → `AutomationsEngine(pg=self._pg).on_score(...)`
   (`rules_engine.py:497` → `automations/engine.py:80`). This is a real, tested-by-construction
   production data path — traces are scored live and automations fire on real thresholds.

2. **But `_execute_action` (`automations/engine.py:124-156`) only implements two of the four
   surfaces the product exposes:**
   - `action_type == "dataset"` (line 133-145) — real: calls `DatasetHub.promote_trace`
     (`datasets/hub.py:232`), confirmed real DB write.
   - `action_type == "queue"` (line 146-148) — returns a dict referencing `queue_id`, no evidence of
     an actual queue enqueue call within this function; borderline stub, not verified further.
   - `action_type == "alert"` (line 149-155) — **pure no-op**: constructs and returns
     `{"action": "alert", "trace_id": ..., "score": ..., "message": ...}`. No Slack call, no email
     call, no webhook POST, no write anywhere except the subsequent `_log_run` audit row.
   - Any other `action_type`, **including `"webhook"` and `"slack"`** (the two options the frontend
     literally offers, see below) — falls into the generic default branch (line 156):
     `return {"action": action_type, "trace_id": trace_id, "score": score}`. Zero dispatch logic
     exists for these two action types anywhere in the codebase (confirmed:
     `grep -rn 'action_type == "webhook"\|action_type == "slack"' src/eden` — zero hits).

3. **The frontend actively promises the missing behavior.**
   `clients/portal/src/app/(portal)/signals/automations-panel.tsx:49`:
   `const ACTION_TYPES = ["dataset", "webhook", "slack"] as const;` — offered as create-form
   options. Empty-state copy at line 475: `"Automations react to scored turns — route low-scoring
   runs to a dataset, ping Slack, or hit a webhook."` Only the first of those three claims (dataset)
   is true. There is no error surfaced to the user when a webhook/slack automation "fires" — it
   returns 200, logs a row to `automation_runs`, and that table isn't even readable from the UI
   (`automations-panel.tsx:145-146`: "run history aren't exposed by the API yet").

4. **No test coverage anywhere for `AutomationsEngine`** — `grep -rl
   "AutomationsEngine\|automations.engine" tests/` returns zero files. The one frontend test file
   (`automations-panel.test.tsx`) only covers UI rendering/create-form submission, not actual
   delivery behavior (it never asserts a webhook fires or a Slack message sends, because none does).

**Recommendation for synthesis:** this belongs in the doc as a new §0(d) or a peer bullet to §0(c),
since it's the same species of finding (real-looking UI/schema, zero live dispatch) but for a
*third*, previously uncited subsystem — and it's arguably the most customer-visible of the three,
since it's the one alerting surface a customer can self-serve configure through the product UI
today, with copy that directly promises the missing behavior.

**Minor supplementary finding:** `anomaly_alerts.py::_dispatch_email` (line 573) is a real,
working reuse of `send_issue_alert_email` — so `anomaly_alerts.py` actually has three real
channels (`in_app`, `websocket`, `email`) plus one gated-real (`webhook`, if
`alert_webhook_url` is set) and only two true no-ops (`slack`, `pagerduty`). The doc's existing
framing ("hardcoded no-op for both channels, not just PagerDuty") is accurate but could note that
`tick_once`'s hardcoded `channels=["in_app"]` (line 122) also means the *working* email channel is
never reached either — the bug is entirely in the hardcoded channel list at the call site, not a
lack of working channels in the dispatch function itself. Slightly strengthens the fix
recommendation already in §3 item 5 (make channel selection severity-aware) — that fix is cheaper
than it looks, since `email`/`webhook`/`websocket`/`in_app` are all already implemented; only the
call site needs to stop hardcoding `["in_app"]`.

**dsl/alerts.py (AlertAsCode) is more real than the doc credits.** `fire_due()`
(`dsl/alerts.py:274`) is called from `workers/main.py:604` — a live scheduled path, not just
API-triggered (`intelligence_dsl.py:249` also calls it on-demand). Worth citing alongside
`slack_notify`/`alert_email` as a second example of eden's alerting engineering being capable of
correct end-to-end wiring when it's actually connected — useful counter-evidence against reading
the doc's overall verdict as "eden can't build working alerting," which is not the claim being made
but could be misread from the density of dead-path findings.
