# Eden Strategic Review — Consolidated, Ranked Feature Action List

## What this is

This document consolidates every distinct, actionable finding from the sixteen finalized
(pass-4) feature-review documents produced during the 2026-08 strategic review of Eden:

- `features/01-competitor-matrix.md` — competitive differentiator audit and codebase re-pass
- `features/02-evals-datasets.md` — F49/F51/F53 evals and dataset infrastructure
- `features/03-prompt-playground.md` — prompt playground and promote-to-experiment flow
- `features/04-alerting-oncall.md` — alerting, on-call, and notification-routing pipelines
- `features/05-multiagent-tracing.md` — multi-agent trace linkage and delegation visibility
- `features/06-cost-governance.md` — budgets, spend tracking, and cost enforcement
- `features/07-security-compliance.md` — SSO, RBAC, RTBF/GDPR, and compliance evidence
- `features/08-annotation-labeling.md` — labeling queues, leases, and inter-annotator agreement
- `features/09-sdk-dx.md` — Python/TypeScript SDK developer experience
- `features/10-model-gateway.md` — `AIGateway`, `/gateway/v1`, and provider-routing services
- `features/11-session-analytics.md` — session tables, cohorts, funnels, retention
- `features/12-runtime-guardrails.md` — runtime content-safety guardrail enforcement
- `features/13-continuous-improvement-loop.md` — shadow-detector, autonomous-patch, and evidence-gate loops
- `features/14-user-request-mining.md` — topic/pattern clustering (F65)
- `features/15-artifacts-behavior-record.md` — Artifacts, Ledger, and Book prompt-injection systems
- `features/16-issue-extraction-online-evals.md` — issue extraction, ranking, and online evals

Two research passes independently extracted every actionable point from these sixteen docs into
two raw extract files — `_pass4-notes/RANKED-EXTRACT-features-A.md` (docs 01-08, **111 raw
points**) and `_pass4-notes/RANKED-EXTRACT-features-B.md` (docs 09-16, **79 raw points**), for
**190 raw extracted points** in total. This document does not re-verify the underlying findings
from scratch; it takes each extract's point-level conclusions — including stated severity,
effort, and confidence — as reliable, merges genuine cross-doc duplicates and corroborations,
sanity-checks severity/effort/confidence for internal consistency across the merged set (the two
raw extracts were produced independently and calibrate "High" vs. "Critical" slightly
differently in places), and produces one global ranking.

**185 distinct points** survive the merge. Five points are explicit cross-doc merges (the same
underlying gap independently found by 2+ docs, merged into one entry each, cited accordingly);
one closely related trio of findings (portal surfacing for Topics/Drift/Red-team probing) was
deliberately **kept as three separate points** rather than merged, since each names a distinct,
independently-valuable backend capability with its own fix — see the Appendix for the full
merge list and the rationale for that one non-merge.

This is the third of three sibling documents produced from this review — alongside
`RANKED-BUGS.md` (59 points from the bug-review docs) and `RANKED-OPTIMIZATIONS.md` (from the
optimization-review docs) — built to the same level of rigor and detail.

## Ranking methodology

Primary sort key: **severity/impact**, per the tier definitions below. Secondary sort key:
**confidence** (High/Medium/Low) — corroboration by 2+ independently-written source docs is
treated as a strong confidence signal and is called out explicitly wherever it applies.

**Effort** (Small/Medium/Large) is reported for every point but is not itself a ranking key —
it's prioritization context. Points that are both High-or-Critical severity **and** Small effort
are flagged **Quick win**, so a reader triaging for fast, high-value fixes can scan for that tag
independent of rank position.

Where the two source extracts' stated severities were inconsistent with how the rest of the
merged set was calibrated — most commonly, a point labeled Critical in its source doc that, once
placed alongside the other 25 Critical-tier points, was clearly a step in a larger fix (rather
than itself blocking the core value prop or actively misleading users) — the severity was
adjusted down to keep the tier boundaries meaningful across the whole list. These recalibrations
are noted inline on the affected entries and summarized in the Appendix. No underlying fact,
citation, or proposed fix was second-guessed in this pass — only the severity label, and only
where it was clearly out of step with its neighbors.

## Tiers used below

**Critical** — blocks eden's core value proposition (safety enforcement, data erasure,
authentication, honest scoring) or actively misleads users/buyers about what the product
currently does.
**High** — a significant usability, adoption, or competitive blocker: a real, often
already-built capability that customers cannot reach, trust, or safely operate today.
**Medium** — a real, genuine gap, but narrower in blast radius, frequency, or immediate
visibility than High — a wrong-but-recoverable number, a missing convenience action, a
maintainability/scope-hygiene item.
**Low** — polish, nice-to-have, or a low-priority/speculative follow-on explicitly deferred by
its source doc.

---

## Ranked list

## Critical

### #1. Implement the SSO login/callback IdP token exchange (currently a scripted 503, not a partial feature)
**Source:** `07-security-compliance.md`, §1b (citing `sso.py:652-683`; test `tests/intelligence/test_sso_state_csrf.py::test_callback_consumes_state_and_succeeds`)
**Description:** `POST /sso/callback/{provider_id}` validates the CSRF state correctly, then unconditionally raises `HTTPException(503, {"status": "sso_not_enabled"})` for every call — even a correctly round-tripped state. The docstring names the reason: IdP token exchange (SAML assertion validation / OIDC code exchange) is not wired up because it needs per-tenant IdP secrets with no safe broker location yet. `initiate_sso_login` builds a genuinely valid Okta/Google/OIDC authorize URL and sends the browser to the real IdP; the IdP authenticates the user and redirects back with a real code/assertion; eden then discards it and 503s — after the user already authenticated with their own IdP. Fix: implement the actual SAML assertion validation / OIDC code exchange in `sso_callback`, including a secure per-tenant IdP secret broker.
**Why it matters:** This fails at the worst possible point in the flow — after the user's own identity provider has already succeeded — which looks to a buyer's IT team like eden's system broke mid-flow rather than declined to offer the feature. The portal pricing page lists "SSO/SCIM" as an Enterprise-tier feature against this exact backend; that claim cannot be honored for any org not authenticating entirely outside eden's own SSO routes (e.g., via Clerk directly). This is a Critical procurement blocker for any enterprise deal requiring self-service SSO.
**Severity:** Critical
**Effort:** Large
**Confidence:** High

### #2. Fix the Typesense RTBF fanout to actually target user-owned documents (add `user_id` to schema)
**Source:** `07-security-compliance.md`, §2b fanout table, §4 point 4 (citing `typesense_client.py:67-97,588-591`)
**Description:** `rtbf_fanout.py`'s Typesense deletion calls `delete_by_filter("tenant_id:={org} && user_id:={user}")`, but `SPAN_SCHEMA` has 21 fields and no `user_id` field, and `build_span_doc` never sets one. The filter targets a field that doesn't exist, the call doesn't raise, and the fanout falsely reports `status: "ok"` with `deleted: 0` — the indexed `input_text`/`output_text` (actual prompt/completion content) stays fully searchable. Fix: add a `user_id` field to the Typesense span schema, backfill/reindex existing documents, and update the fanout filter to actually match; or, if reindexing is infeasible short-term, change the fanout to report `status: "unsupported"` (matching the honest pattern already used for Qdrant/S3) instead of a false "ok."
**Why it matters:** This is the most severe of the two false-positive fanout bugs, since Typesense holds full searchable prompt/completion text — a re-search for the "erased" user's data would still return their actual conversation content, directly contradicting a reported successful erasure, exactly the kind of gap a SOC2 Type II auditor samples for.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #3. Neutralize or remove the `install_cat15_trajectory_replaces_intervention` hot-path monkey-patch
**Source:** `features/12-runtime-guardrails.md` — core finding, monkey-patch section (B12-1)
**Description:** A default-on hot-path monkey-patch, `install_cat15_trajectory_replaces_intervention`, silently swaps out eden's real content-safety guardrail checks (`InterventionEngine.evaluate_and_act`, fail-closed and correctly designed) for unrelated cost/loop/latency checks whenever a `trace_id` is passed. It also returns `edited_text` unredacted, meaning content that should have been redacted per policy passes through untouched. This happens with zero monitoring anywhere in the system to detect that it's occurring. Fix: remove this monkey-patch entirely, or at minimum make it opt-in/explicitly gated rather than default-on, and restore `evaluate_and_act` as the actual enforcement path whenever `trace_id` is present.
**Why it matters:** This is a silent safety-guardrail bypass in a product whose core value proposition includes runtime safety enforcement — any customer relying on eden's guardrails for content safety is currently not actually protected whenever this patch's trigger condition (`trace_id` present) is met, with no alerting anywhere to reveal this. This is a trust and liability-level issue, not just a bug.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #4. Redact `edited_text` correctly once the correct enforcement path is restored
**Source:** `features/12-runtime-guardrails.md` — monkey-patch section, "returns unredacted edited_text" (B12-12)
**Description:** Called out separately from #3 because it's a distinct observable symptom worth its own acceptance criterion: currently, whenever the bypass fires, `edited_text` is returned unredacted even though redaction should have occurred per policy. When #3 is fixed, this specific behavior (redaction actually happening on `edited_text`) should be explicitly verified, not just "the right function gets called."
**Why it matters:** This is the concrete, customer-visible consequence of the bypass — unredacted sensitive/unsafe content reaching wherever `edited_text` is consumed (potentially end-user-facing) — and should be a specific test/verification target, not assumed to be automatically fixed by #3's broader fix.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

### #5. Consolidate the three non-communicating GDPR erasure routes into one, wired to `RightToBeForgottenService`
**Source:** `07-security-compliance.md`, §2a-2c, §4 recommended framing (citing `compliance.py:118-140`; `compliance_jobs.py:239-262`; `auth.py:2039`; `governance_intel/gdpr.py`)
**Description:** Three deletion implementations exist and don't communicate: `DELETE /api/v1/me` (anonymizes only `users` + deletes `org_members`; zero portal callers), `DELETE /users/me` (narrower still — sets `deleted_at` and rotates `token_version` only, doesn't anonymize email/name or null `password_hash`; the portal's `deleteAccount()` client function calls this route but has zero component callers anywhere in the rendered tree), and `RightToBeForgottenService.process_request` (the broad, well-engineered six-table-plus-cross-store-fanout version, reachable only via `POST /governance/rtbf`, gated behind `rtbf_fanout_v1` which defaults `False`, and never called by the other two paths). None of the three has a UI element calling it — a real DSAR today means a support engineer hand-calling one of three inconsistent endpoints from a terminal. Fix (per doc's explicit P0/P1 recommendation): retire two of the three routes (or make the narrow ones call the broad `RightToBeForgottenService`), wire the survivor to a real "Delete my data" UI element in account settings.
**Why it matters:** This is a genuine, unconditional GDPR Article 17 exposure today — a user who files `DELETE /api/v1/me` gets a success response while their actual trace content, conversation transcripts, feedback comments, and judge rationale text survive untouched indefinitely in the same database. The doc explicitly frames this as active regulatory exposure masked only by low current user count, not a marketing-copy issue.
**Severity:** Critical
**Effort:** Large
**Confidence:** High

### #6. Un-stub the `/artifacts` portal route
**Source:** `features/15-artifacts-behavior-record.md` — portal wiring gap section (B15-1)
**Description:** The `/artifacts` route in the portal is currently a dead stub that redirects to `/improve?mode=queue`, despite eden already having shipped the actual backend equivalent of Lemma's "Artifacts" feature (`nudges`/`ArtifactAuthor`/`ArtifactDemotionWorker`, GA-default-on, injected live into production prompts) and despite product copy already referencing this as a real feature. Fix: build the real `/artifacts` view backed by the existing API (which the doc confirms already exists), replacing the redirect stub.
**Why it matters:** This is a fully-built, GA-default-on production feature (already affecting live prompts) that customers cannot actually view or manage through the product UI — arguably worse than a feature gap, because the feature is actively running in production unobserved by the people it affects.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #7. Un-stub the `/ledger` portal route
**Source:** `features/15-artifacts-behavior-record.md` — portal wiring gap section (B15-2)
**Description:** Same pattern as #6: `/ledger` also redirects to `/improve?mode=queue` as a dead stub, despite the Ledger (`src/eden/kb/ledger/`) being a real, GA-default-on (`ledger_v1` flag) production system. Fix: build the real `/ledger` view backed by the existing Ledger API.
**Why it matters:** Same rationale as #6 — a live, production-affecting feature (the Ledger, which per the doc backs prompt injection via `BookGatewayFilter`) has no way for customers to see or audit what's in it, undermining transparency into a system actively shaping production prompts.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #8. Fix Loop 1 (shadow-detector confirm/dismiss loop) — step P0-A of the revival plan
**Source:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-A fix step (B13-1)
**Description:** Loop 1 (the shadow-detector confirm/dismiss loop backing `soft_issue_review.py` and the `nl_signals` table) is currently fully dead code — built but not actually functioning end-to-end. The source doc provides an exact P0-A fix step (with SQL/code specifics) as the first of a four-step (P0-A/B/C/D) plan to revive it. Fix: implement P0-A exactly as specified in the source doc.
**Why it matters:** This is step one of reviving what the doc frames as the review's flagship finding — a fully-built but entirely non-functional feedback loop where user confirm/dismiss signals should be improving detector quality over time but currently do nothing.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #9. Fix Loop 1 (shadow-detector confirm/dismiss loop) — step P0-B of the revival plan
**Source:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-B fix step (B13-2)
**Description:** Second step of the four-part fix plan to revive Loop 1's dead confirm/dismiss loop. The source doc provides exact specifics for this step (following directly from P0-A, #8). Fix: implement P0-B exactly as specified in the source doc.
**Why it matters:** Same as #8 — necessary sequential step to make the shadow-detector confirm/dismiss loop functional; also an explicit dependency named by doc 16 (see #10 below, which depends on P0-A/P0-B being done).
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #10. Build a confirm/dismiss front door for shadow-detector issues — no UI affordance exists anywhere in the portal
**Source:** `01-competitor-matrix.md`, "User Experience & Value" section (01-1) **+** `features/16-issue-extraction-online-evals.md`, portal gap section (B16-4) — **corroborated by 2 independent docs**, each reaching the same gap from a different angle (differentiator-value analysis vs. issue-extraction UX audit).
**Description:** `soft_issue_review.py:333-478` implements a real shadow-detector precision/promote/delete lifecycle — one of the doc's strongest claimed differentiators (no competitor analog found across 19 researched competitors) — but `record_shadow_feedback`, the function that would let a human confirm or dismiss a shadow-detector finding, has zero callers anywhere in the codebase, and a repo-wide grep for `shadow` under `clients/portal/src` returns only Tailwind `shadow-[...]` box-shadow CSS utility classes, no UI references at all (01-1). Independently, the portal has no Dismiss button/action for issues at all, despite a confirm/dismiss signal being the entire mechanism doc 13's Loop 1 needs to feed back into detector quality (B16-4). Fix: add a confirm/dismiss affordance to `/issues` or `/traces` that calls `record_shadow_feedback` / the correct post-revival dismiss endpoint, giving the on-call engineer a way to interact with this capability and giving Loop 1 (#8, #9) a working UI-side terminus.
**Why it matters:** This is characterized as eden's strongest differentiator with no competitor analog, but until it has any UI entry point it is completely invisible to the only persona who could use or validate it — the capability cannot be adopted, marketed with a live demo, or even dogfooded internally. It is also a hard blocker for Loop 1 (doc 13) ever working end-to-end in production: even a perfectly-fixed backend confirm/dismiss loop is useless with no UI affordance for a real user to dismiss an issue.
**Severity:** Critical
**Effort:** Small–Medium
**Confidence:** High
**Quick win.**

### #11. Implement composite issue ranking in `IssuesRepo.list_issues` (currently recency-only)
**Source:** `features/16-issue-extraction-online-evals.md` — core finding, `IssuesRepo.list_issues`, exact rank-scoring SQL provided (B16-1)
**Description:** `IssuesRepo.list_issues` currently sorts issues by recency only, despite eden already extracting and storing the raw ranking ingredients needed for a proper composite rank: severity, `user_count`, and `stumble_count`. These signals exist in the data but are never combined into an actual priority score. The source doc provides exact rank-scoring SQL to implement this. Fix: implement the composite ranking per the provided SQL, replacing (or supplementing as a sort option) the current recency-only ordering.
**Why it matters:** This is the doc's core finding — the single most consequential and highest-leverage fix in this document. Issues that are severe and affecting many users but happen to be older sink to the bottom of a recency-sorted list, meaning the highest-priority problems may not surface to whoever is triaging issues, directly undermining the entire point of issue extraction (surfacing what matters most).
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #12. Replace the fake heuristic-stub scoring in `offline_runner.py` (F51 experiments + playground promote-to-experiment) with real model calls and real scoring
**Source:** `02-evals-datasets.md`, §5 P0 items 1-3 (02-1, 02-2, 02-3) **+** `03-prompt-playground.md`, §4 "'Promote to Experiment' is a UX trap" (03-1) — **corroborated by 2 independent docs / 4 independent findings converging on the same root-cause code path.**
**Description:** `OfflineExperimentRunner._run_row` (`src/eden/experiments/offline_runner.py:266-288`), live and API-mounted at `/orgs/{org_id}/experiments/offline` (`api/app.py:249`), computes the "treatment" score via a substring-match heuristic — `score = 0.9 if expected in input_text else (0.7 if expected else 0.5)` — with no LLM/agent invocation anywhere in the file (02-1: the `config` dict already carries a `model` field at L277, so the plumbing exists and only the actual call is missing). The "control" side is hardcoded to `{"score": 0.5, "output": item.expected_output or "", "synthetic": True, "method": "heuristic_stub"}` (L157-162) regardless of what any actual baseline run produced (02-2: fix via a stored `baseline_output` column or a second real model run against `baseline_experiment_id`'s config). Once both sides produce real output text, they should be scored via `playground/scorers.py`'s existing `run_scorers(specs, output=..., expected=...)` — no adapter needed, since it already operates on the exact `(output: str, expected: str | None)` shape of `dataset_items` (02-3: a drop-in reuse of infrastructure already used elsewhere in `playground/service.py`). The same root defect surfaces from the playground's promote-flow entry point: clicking "+ Experiment" calls `PlaygroundService.promote_experiment` (`service.py:460-488`), which carries forward the playground's `tasks`/`scorers` config with a success toast reading "Immutable snapshot promoted — open Evals to compare," but the resulting `OfflineExperimentRunner.run` execution never calls the playground's LLM handler or `scorers.run_scorers` — it hits the same `_run_row` heuristic stub (03-1). Fix: implement 02-1/02-2/02-3 to make F51 itself real, and make `promote_experiment`'s downstream execution path actually replay the playground's real `tasks` through `playground_llm_handler`/`scorers.run_scorers` so the persisted "experiment" reflects the comparison the engineer actually watched.
**Why it matters:** F51 is a real, live, API-mounted, frontend-wired "offline experiment" feature (Braintrust/LangSmith-style prompt/model comparison) that today produces a numerically meaningless diff on every single run — every score a user sees from it is fake. An engineer who tunes a prompt in the playground, watches real scorer numbers, and clicks "Promote to Experiment" gets a persisted result that has nothing to do with what they just did, silently undermining trust in the tool and wasting iteration work. Four independent findings across two docs converge on the same root-cause code path, which sharply raises confidence this is the correct fix target.
**Severity:** Critical
**Effort:** Small (02-1/02-2/02-3, the core F51 fix) to Large (03-1, the promote-flow integration)
**Confidence:** High

### #13. Wire `scorers.py` into an actual CI/merge-gate check (build a real "prompt regression gate")
**Source:** `03-prompt-playground.md`, §5 "Not wired to CI"; "User Experience & Value → Where the workflow breaks down"; "Net picture" (citing `.github/workflows/eden-eval.yml`, `api/routes/wave6_online.py:513-514`, `eden.evaluation.ci_webhook.CIWebhookHandler`, `scorers.py`)
**Description:** The only PR/nightly regression gate in the repo is `.github/workflows/eden-eval.yml`, which POSTs to `/orgs/{org}/ci-eval/run`, backed by `eden.evaluation.ci_webhook.CIWebhookHandler` — a completely separate code path from `eden.playground`. A repo-wide grep for `eden.playground` outside the `playground/` directory never turns up `regression_runner.py`, `ci_webhook.py`, or anything in `.github/`. No scorer defined in `scorers.py` (deterministic, fast, dependency-free: `exact_match`, `contains`, `icontains`, `regex`, `json_valid`, `levenshtein_ratio`) ever gates a merge or deploy today. Fix: build a merge/deploy check that runs the playground's scorer set against a defined comparison (e.g., new prompt version vs. prior) and fails the check on regression, using the existing `scorers.py` infrastructure rather than building new scoring logic from scratch.
**Why it matters:** Called "the single highest-leverage gap for adoption" — the scorer infrastructure needed for a real "prompt regression gate" already exists and is unused; today the playground is purely a manual pre-merge comparison tool with zero automated say over whether a PR merges or a prompt version deploys, the difference between "a good manual tool" and "the thing that prevents prompt regressions from shipping."
**Severity:** Critical
**Effort:** Large
**Confidence:** High

### #14. Wire `alert_stream.py`'s rule engine to a live event source
**Source:** `04-alerting-oncall.md`, §0(a) (citing `realtime/alert_stream.py:194,10,221`; `realtime/kafka_consumer.py:62-63`)
**Description:** `AlertStreamProcessor.process_event()` is the only function that evaluates alert rules (including the P0 `rule_sandbox_escape`) against a live event. Grepping every call site of `.process_event(`/`.process_batch(` across `src/eden` finds zero external callers — the only hits are the module's own docstring example and `process_batch`'s internal self-call. `kafka_consumer.py` defines an `"eden-alert"` Kafka topic and comments that "the alerts service" subscribes to it, but no such consumer exists anywhere. Zero test coverage of `alert_stream.py`/`process_event` exists either. Fix: either build a Kafka consumer that subscribes to `eden-alert` and calls `process_event`, or call `process_event` inline wherever the relevant Kafka events currently land.
**Why it matters:** Root cause of the entire P0-alerting failure — no channel-level fix (PagerDuty sender, email routing) matters until this is wired, because the rule engine supposed to detect a P0 event is never invoked by anything in production.
**Severity:** Critical
**Effort:** Large
**Confidence:** High

### #15. Emit `sandbox.security_alert` events from a real producer
**Source:** `04-alerting-oncall.md`, §0(b) (citing `alert_stream.py:178-183`; `sandbox/runner.py:114`; `evaluation/security_scanner.py`)
**Description:** The P0 rule `rule_sandbox_escape` only fires on event type `sandbox.security_alert`. A repo-wide grep for that string matches exactly one line — the rule definition itself. Nothing constructs or emits this event. The actual sandbox runtime guard (`sandbox/runner.py:114`) just raises a plain `ValueError` on a path escape with no connection to Kafka. `security_scanner.py`'s `SANDBOX_ESCAPE` is a static-analysis finding category, not a runtime event. Fix: add event emission from the sandbox runtime escape guard and/or the guardrails policy engine, neither of which currently talks to Kafka or `alert_stream.py`.
**Why it matters:** Even if #14 is fixed, the P0 rule still cannot fire — its trigger condition is literally never produced by any code path today.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #16. Implement Slack/webhook dispatch in the Automations engine's `_execute_action`
**Source:** `04-alerting-oncall.md`, §0(d), §1 transport table (citing `automations/engine.py:124-156,80`; `automations-panel.tsx:475,49`)
**Description:** The portal's self-service Automations tab lets a customer configure Slack/webhook actions today, gets a 200 on save, and the trigger path is genuinely live (traces are scored in real time and automations fire on real thresholds). But `_execute_action` only implements `action_type == "dataset"`; `"alert"` is a no-op that builds and returns a dict with no dispatch; `"webhook"` and `"slack"` — the two options the frontend actually offers — fall into a generic default branch that also just returns a dict. A repo-wide grep for `action_type == "webhook"|"slack"` returns zero hits anywhere. Fix: implement real Slack and webhook dispatch in `_execute_action`.
**Why it matters:** Called "a materially worse UX failure than the PagerDuty gap" — a live, self-serve surface with copy that promises delivery, a form that accepts the config, silent permanent non-delivery, no error, and no way for a customer to discover the gap short of independently testing whether the message ever arrives.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #17. Fix the `eql_alert_rules` severity-filter inversion (marking a rule "critical" silently disables it)
**Source:** `04-alerting-oncall.md`, §0.5 bullet 2 (citing `dsl/alerts.py:60-62,404-412,333`)
**Description:** The cron watchdog that evaluates NL-alert rules skips any rule whose severity falls outside `_FIREABLE_SEVERITIES = {info, warning, high}` — and `critical` is the one value excluded. A rule saved as "critical" is accepted by validation, looks correct in the UI, and then never auto-fires again. Fix: include `critical` in `_FIREABLE_SEVERITIES`.
**Why it matters:** Lives in the one alerting pipeline that otherwise genuinely works end-to-end (email delivery to org admins) — silently disables the most urgent rules in the only pipeline that currently delivers anything. Called "a one-line, high-confidence, independently-shippable bug fix."
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

### #18. Ship a self-serve authoring UI for the NL-alert pipeline
**Source:** `04-alerting-oncall.md`, §0.5 bullet 1, "User Experience & Value," §4 (citing `alerts/routes.py:100-128,142-175`; dead wrappers `resources.ts:2092-2133`; `alerts-panel.tsx:24`, `resources.ts:3461-3480`)
**Description:** The backend for this flow is genuinely good: takes free text ("alert me when error rate exceeds 5% in the last hour"), reuses the Detectors feature's NL→structured-rule extractor, maps to a parameterized EQL query, lints it, returns the compiled query plus warnings and a suggested name. But a repo-wide grep for `nl-alert-rules|alerts/compile` in the portal only finds dead typed wrapper functions — no component calls any of it, and there isn't even a client wrapper for rule creation. A customer cannot create a working alert rule through the product at all. Fix: build the frontend authoring UI against the already-complete backend API.
**Why it matters:** Ranked the single most basic blocker — more fundamental than any transport/PagerDuty issue — because it's the one pipeline that actually delivers, and it has zero front door.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #19. Stop claiming working P0/security alerting and Automations-tab delivery in customer-facing material
**Source:** `04-alerting-oncall.md`, §4 Recommendation
**Description:** The doc explicitly recommends not claiming any working alerting/paging capability for security or infra P0 events in any customer-facing material, extending to the portal's Automations tab, whose Slack/webhook actions "should not be presented as functional." Fix: audit and correct all customer-facing claims (sales collateral, docs, in-product copy) about P0/security alerting and Automations delivery until #14, #15, #16 are shipped.
**Why it matters:** Framed as "a trust/correctness issue, not a feature gap — a customer relying on eden to page them for a P0 security event would not be paged, full stop." Real customer-risk exposure, not just a roadmap gap.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

### #20. Wire live gateway traffic into the `budget_consumption` write path to fix the Path A/Path B spend-tracking drift
**Source:** `06-cost-governance.md`, §2d "Two live budget-status paths" (citing `budget_service.py:275-361`; `gateway.py:844-848,400-458`)
**Description:** For an org whose traffic is 100% ordinary `/gateway/v1/chat/completions` calls, `budget_consumption` (Path A, read by `budget_service.get_consumption()`, the portal Budgets UI/ticker, `evaluate_budget_alerts()`, and internal agent self-throttles) never receives a write, because its only writer, `record_usage()`, has exactly three callers — none of which sit on the live `/gateway/v1` request path (`gateway.py`'s `_call_upstream()` bypasses `AIGateway.complete()` entirely; called out in code as an intentional Wave-4 deferral). Meanwhile Path B (`UsageService.get_budget_status()`, read by `QuotaEnforcementMiddleware`) correctly sums real spend via `usage_events`, fed synchronously by `_emit_gateway_telemetry()`. For a concrete traced example (`org_growth`, $500 real spend, 10,000 calls), the Budgets UI/ticker shows $0/0% utilized indefinitely while enforcement correctly sees $500 — and no reconciliation job exists anywhere to correct `budget_consumption` after the fact. Fix: add a `record_usage()` call directly inside `_emit_gateway_telemetry()` in `routes/gateway.py`, right after `_stamp_gateway_cost_usd()` computes `cost_usd`.
**Why it matters:** A customer checking the dashboard to avoid a surprise bill sees a budget bar frozen at 0% used, right up until enforcement (reading a third, invisible number) silently starts blocking requests with no preceding alert. Called "a budget feature that actively misleads you about your own risk — arguably worse for trust than no dashboard at all."
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #21. Fix the limit-config split — point enforcement at the customer-configured budget, not `org_resource_limits`
**Source:** `06-cost-governance.md`, §2d.4 (citing `budgets.cost_hard_limit_usd` in `052_budgets.py:63`; `org_resource_limits.cost_hard_limit_usd` in `002_phase_4_2_data_layer.py`/`015_regions_and_rls.py`)
**Description:** Independent of the consumption drift (#20), the *limit* side is also split. `budgets.cost_hard_limit_usd` is customer-editable via `POST /orgs/{org_id}/budget`, but `QuotaEnforcementMiddleware` never reads the `budgets` table at all — its hard cap comes from the separate `org_resource_limits` table or the plan-tier default. No functional code reads `budgets.enforcement_enabled`/`budgets.cost_hard_limit_usd` in the live gateway route. Fix: point `QuotaEnforcementMiddleware` at the same scope-aware `get_consumption()`/limit source as the Budgets UI (or extend `UsageService` with matching parameters), making `budgets.cost_hard_limit_usd` the one limit actually checked.
**Why it matters:** "A customer who sets a custom hard budget via the Budgets UI is not actually capping their live gateway spend" — the number they configure and see on screen is disconnected from the number that blocks requests, which they can neither see nor edit. Sharper than #20: even with perfectly synced consumption numbers, the limit itself is the wrong one on the enforcement side.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #22. Add missing OTel/A2A fields to the `TelemetryEvent` dataclass
**Source:** `05-multiagent-tracing.md`, "New finding" (citing `src/eden/observability/telemetry_collector.py:40-142`)
**Description:** Migrations 058 and 067 added DB columns `operation_name`, `provider_name`, `error_type`, `parent_agent_span_id`, `child_agent_trace_id` to `telemetry_events`, but the `TelemetryEvent` dataclass that `TELEMETRY_INSERT_SQL` serializes never gained matching fields, so nothing is ever available to insert into them. Fix: add all 5 fields (typed `str | None = None`) to the dataclass after `service_tier`, plus matching keys in `to_dict()` and `from_dict()`.
**Why it matters:** Root cause of the whole ingestion write-path gap — every downstream fix (operation_name mapping, agent-boundary rendering, error causal chains) is blocked on this one dataclass change.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

### #23. Wire ingestion assembly to derive `operation_name` and pull agent-linkage fields out of the `attributes` blob into real columns
**Source:** `05-multiagent-tracing.md` (citing `ingestion.py:317-332`; `src/eden/sdk/a2a.py:114-129`; `otel_exporter.py:36-49`)
**Description:** At the point the ingestion route builds a `TelemetryEvent` (same place `agent_id` is resolved from `X-Eden-Agent-Id`), derive `operation_name` via an extended `_OPERATION_NAME_MAP`. The existing map only covers LLM-call event types (mapping everything to `"chat"`) with zero entries for eden's own `"tool.call"`, `"span.start"`, `"env.step"` types — reusing it verbatim would mislabel every tool-call/agent-boundary span as `"chat"`. Fix: (a) move `_OPERATION_NAME_MAP` into a shared module imported by both the exporter and ingestion; (b) add `"tool.call": "execute_tool"` and a rule that any event carrying `attributes["parent_agent_span_id"]` or arriving via `wrap_a2a_invocation` gets `operation_name = "invoke_agent"`; (c) pull `parent_agent_span_id`/`child_agent_trace_id` out of `event.attributes` (already built by `_A2ACallCtx.attributes()`, currently only merged into the JSONB blob) back into the two real dataclass fields at the same call site.
**Why it matters:** Without this, even with dataclass/DB columns fixed (#22), no code path actually populates `operation_name` or the agent-linkage fields on ingest — they'd remain permanently null.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### #24. Extend `TELEMETRY_INSERT_SQL` and `_build_postgres_row` to actually write the 5 new columns
**Source:** `05-multiagent-tracing.md` (citing `telemetry_collector.py:289-314`, `_build_postgres_row` at `:1370-1447`)
**Description:** `TELEMETRY_INSERT_SQL`'s column list needs extending from 48 to 53 columns, adding `operation_name, provider_name, error_type, parent_agent_span_id, child_agent_trace_id` before `created_at` with `$49-$53` placeholders. `_build_postgres_row` needs 5 new trailing tuple entries appended after `event.response_message_hashes or None`. Both `_route_postgres` and `_route_postgres_many` go through this one constant — a single edit point.
**Why it matters:** This is the literal DB-write step that closes the "columns exist but nothing writes them" gap — without it, #22 and #23 compute the right values but never persist them.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

### #25. Do not describe current erasure as "GDPR-compliant" externally until the fixes land
**Source:** `07-security-compliance.md`, §4 "Recommended framing for the strategic review"
**Description:** The doc's explicit recommendation: do not describe eden's current erasure capability as "GDPR-compliant" in any external material until the live self-service path covers more than `users`/`org_members` (#5) and is actually reachable by a real user via UI, and until the Typesense/Redis false-success bugs (#2, and the related dead Redis RTBF key-pattern match) are fixed before `rtbf_fanout_v1` is honestly flipped on.
**Why it matters:** This is a messaging-discipline item distinct from the underlying engineering fixes — protects against an external compliance claim that would be actively false today, independent of and prior to the code fixes landing.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

### #26. Fix `improvement/replay_verify.py:355` — always-raising `AIGateway.complete()` call site inside the flagship improvement loop's verification step
**Source:** `features/10-model-gateway.md` — undocumented production call sites (B10-5)
**Description:** This call site unconditionally calls `AIGateway.complete()`, which always raises since `AIGateway` is dormant. This one sits inside the replay-verification step of eden's own autonomous improvement loop (doc 13), meaning the closed-loop patch-verification pipeline itself is silently broken at this step whenever it's exercised. Fix: repoint to the real internal LLM client or remove/guard pending `AIGateway` deletion.
**Why it matters:** This is arguably more severe than the sibling `AIGateway.complete()` call-site bug because it breaks eden's own flagship autonomous-improvement feature at a verification step meant to gate whether an autonomous patch is safe to merge — a broken verification step could mean patches are being verified incorrectly or verification is silently no-op'ing.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

## High

### #27. Fix Loop 1 (shadow-detector confirm/dismiss loop): step P0-D per source's exact plan

**Source:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-D fix step.

**Description:** Loop 1 (the shadow-detector confirm/dismiss loop backing `soft_issue_review.py` and the `nl_signals` table) is currently fully dead code — built but not actually functioning end-to-end. The source doc provides an exact four-step (P0-A/B/C/D) plan to revive it; this is the fourth and final step, completing the P0-A→D sequence.

**Why it matters:** Completes the fix for the review's flagship dead-code finding — a fully-built but entirely non-functional feedback loop where user confirm/dismiss signals should be improving detector quality over time but currently do nothing. Without this final step the loop remains partially non-functional even after the earlier P0 steps.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #28. Fix the confirmed UUID type-mismatch bug in `EvidenceGate`/`promotion_candidates`

**Source:** `features/13-continuous-improvement-loop.md` — third mechanism section, `EvidenceGate`/`promotion_candidates`.

**Description:** The `EvidenceGate`/`PromotionLoop` mechanism (a third, separate "shadow→gate→promote" system backing prompt-canary and nudge promotion) has a confirmed UUID type-mismatch bug in its interaction with the `promotion_candidates` table — likely a column typed inconsistently (e.g., string vs. UUID) between writer and reader, causing join/lookup failures. Fix: correct the type mismatch (align column types, add explicit casting, or migrate the column) per the source's specific finding.

**Why it matters:** A type-mismatch bug in the promotion gating table likely causes silent failures or exceptions when candidates should be gated/promoted, undermining the gate's core job of controlling what gets promoted to production.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #29. Fix Loop 1: step P0-C per source's exact plan

**Source:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-C fix step.

**Description:** Third step of the four-part plan to revive Loop 1's dead shadow-detector confirm/dismiss loop, continuing from P0-A/P0-B per the source's exact plan.

**Why it matters:** Required to complete the revival of the review's flagship dead-code finding — a fully-built confirm/dismiss loop that currently does nothing to improve detector quality.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #30. Close Loop 2's UI rendering gaps for the autonomous patch/merge/revert pipeline

**Source:** `features/13-continuous-improvement-loop.md` — Loop 2 section, `src/eden/improvement/` (~9,800 lines).

**Description:** Loop 2 — eden's autonomous issue→patch→test→auto-merge→auto-revert pipeline with a graduated T0-T4 autonomy ladder (`autonomy_policy.py`) — is well-designed on the backend (~9,800 lines of real implementation) but has UI rendering gaps: the portal does not fully surface what this pipeline is doing (patch state, autonomy tier, merge/revert history) in a way users can inspect. Fix: identify and close the specific rendering gaps (exact UI spec should be pulled from the source doc for implementation).

**Why it matters:** An autonomous system that can merge and revert code changes with minimal human oversight is a high-trust-requirement feature; without adequate UI visibility, users/operators cannot build confidence in or supervise what the autonomous loop is doing, limiting how far up the autonomy ladder it's safe to operate.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #31. Remove the hardcoded kind-gate blocking non-`nudge` promotion kinds

**Source:** `features/13-continuous-improvement-loop.md` — third mechanism section, kind-gate restriction.

**Description:** `EvidenceGate`/`PromotionLoop` has a hardcoded restriction such that only `nudge`-kind candidates can actually be promoted through it — prompt-canary, guardrail, model_routing, and kb_skill kinds are all blocked from promotion despite being intended to use the same gating mechanism. Fix: remove or generalize the hardcoded kind check so all intended promotion kinds can flow through the gate, once the UUID type-mismatch bug (#28) is also fixed — they likely need to be fixed together to properly test the broader-kind path.

**Why it matters:** A scoping bug that silently limits a shared infrastructure piece (the promotion gate) to a fraction of its intended use cases — prompt-canary and guardrail promotion (both safety/quality-relevant) currently can't use the evidence-gated promotion path at all, likely forcing riskier ungated promotion or blocking those features from having a promotion path entirely.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #32. Fix the guardrails portal policy-list page envelope-unwrap bug

**Source:** `features/12-runtime-guardrails.md` — portal bugs section, policy-list page.

**Description:** The guardrails portal's policy-list page fails to properly unwrap a response envelope (i.e., an API response wrapper object), likely causing the page to render broken/empty data or crash. Fix: correct the unwrap logic to match the actual API response shape.

**Why it matters:** A broken policy-list page means administrators/customers cannot reliably view or manage the guardrail policies protecting their deployment through the UI — forcing API-level workarounds for a core administrative task.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #33. Add monitoring/alerting to detect when the trajectory-replaces-intervention patch fires

**Source:** `features/12-runtime-guardrails.md` — monkey-patch section (monitoring gap explicitly noted).

**Description:** eden ships a default-on hot-path monkey-patch, `install_cat15_trajectory_replaces_intervention`, that silently swaps out the real content-safety guardrail checks (`InterventionEngine.evaluate_and_act`) for unrelated cost/loop/latency checks whenever a `trace_id` is passed, with zero monitoring anywhere to detect it. Independent of removing the patch outright, adding a metric/log/alert every time the cost/loop/latency path is taken instead of the real content-safety check would make the bypass observable as an interim mitigation, even before the patch itself is removed.

**Why it matters:** Defense in depth — even after the underlying patch is removed, this class of "safety check silently replaced" failure mode could recur elsewhere; observability into it is valuable independent of the specific current instance.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #34. Reconcile the two differently-named `EvalToGuardrailLink` classes

**Source:** `features/12-runtime-guardrails.md` — dual-implementation section.

**Description:** Two separate classes both effectively serving as `EvalToGuardrailLink` exist with incompatible enforcement semantics. The documented one is toothless — it doesn't actually enforce anything meaningful. The one actually wired into production is undocumented, and critically has no demote path (no way to walk back a guardrail once escalated/promoted via this link). Fix: pick one canonical implementation, deprecate/remove the other, document the surviving one accurately, and add a demote path to whichever becomes canonical.

**Why it matters:** Two conflicting implementations of the same concept is a significant maintainability and correctness risk — engineers modifying "the" `EvalToGuardrailLink` based on docs could be editing the toothless one while production runs the other; the lack of a demote path means guardrail escalations made via the working path are currently one-directional without manual DB intervention.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #35. Upgrade guardrail detectors beyond v0 regex/trigram heuristics

**Source:** `features/12-runtime-guardrails.md` — detector implementation section.

**Description:** While `InterventionEngine.evaluate_and_act` itself is a real, correctly fail-closed enforcement engine, all the detectors feeding it are v0-quality heuristics (regex and trigram matching), limiting both precision (false positives blocking legitimate content) and recall (real violations regex can't catch, e.g. paraphrased or semantically-equivalent unsafe content). Fix: incrementally replace/augment regex/trigram detectors with model-based (embedding or classifier) detection for the highest-value categories first.

**Why it matters:** The enforcement mechanism is sound, but detector quality directly determines whether guardrails actually catch what they're supposed to catch — v0 heuristics are known to be weak against adversarial or varied phrasing, undermining the safety promise even where the trajectory-replacing patch bypass isn't in play.

**Severity:** High
**Effort:** Large
**Confidence:** High

---

### #36. Clarify and document what "fail-closed" guarantees actually cover given the bypass existed

**Source:** `features/12-runtime-guardrails.md` — core finding framing.

**Description:** `InterventionEngine.evaluate_and_act` is described as fail-closed by design, but the existence of a bypass (the trajectory-replacing monkey-patch) that routes around it entirely means the fail-closed guarantee only holds when this specific code path is actually invoked — a nuance not documented anywhere for customers or internal stakeholders relying on the "fail-closed" claim. Fix: once the bypass is resolved, document precisely which conditions guarantee fail-closed behavior end-to-end, and consider the historical gap for incident/customer disclosure per eden's policies.

**Why it matters:** "Fail-closed" is a strong safety claim; if it was not actually true under a default-on condition, this has potential customer trust/disclosure implications beyond just the code fix.

**Severity:** High
**Effort:** Small
**Confidence:** Medium — the technical finding (bypass exists) is High confidence; the disclosure/documentation framing is an inferred product-policy action.
**Quick win.**

---

### #37. Establish a single source of truth for "which guardrail enforcement path is active"

**Source:** `features/12-runtime-guardrails.md` — synthesizes the monkey-patch and dual-`EvalToGuardrailLink` findings.

**Description:** There isn't one guardrail enforcement pipeline today — there's `InterventionEngine.evaluate_and_act`, the trajectory-replacing monkey-patch, and two `EvalToGuardrailLink` implementations, with unclear precedence between them. Beyond fixing each individually, there's a broader architectural action: define and document a single canonical enforcement path so future engineers don't reintroduce a second silent bypass.

**Why it matters:** Point fixes address the currently-known instances, but without an architectural single-source-of-truth, the same "silent parallel implementation" failure mode that caused this problem in the first place could recur.

**Severity:** High
**Effort:** Medium
**Confidence:** Medium — a reasonable synthesized architectural recommendation rather than something the source doc states as its own standalone checklist item.

---

### #38. Verify no customer-facing guardrail dashboards report enforcement metrics from the bypassed path as if from the real path

**Source:** `features/12-runtime-guardrails.md` — synthesizes monkey-patch + portal-bugs sections.

**Description:** Given the portal's own bugs (envelope-unwrap, enum mismatch) and the enforcement path itself being silently substitutable, there's a compounding risk: any dashboard/metric surfaced to customers about "guardrail enforcement activity" may currently report on the wrong (cost/loop/latency) checks rather than actual content-safety enforcement whenever the bypass is active, with nobody realizing the metrics don't mean what they claim. Fix: audit any customer-facing guardrail metrics/dashboards for this specific conflation once the bypass fix and monitoring land.

**Why it matters:** Compounds the core safety issue with a reporting-integrity issue — customers could be looking at dashboards that appear to confirm guardrails are working when they're actually seeing unrelated metrics.

**Severity:** High
**Effort:** Small
**Confidence:** Low — a speculative compounding risk inferred by combining two separate findings in the source doc, not stated as a single finding itself.
**Quick win.**

---

### #39. Add EMAIL channel to `rule_sandbox_escape`'s channel list

**Source:** `04-alerting-oncall.md`, §0(c)/§1 transport table (citing `alert_stream.py:178-183,394-408`; `alert_email.py`).

**Description:** Even in the counterfactual where the rule fully fires, its channel list excludes email — the one channel with a real "leaves the building" delivery mechanism. `IN_APP` only reaches a single GET list endpoint with no push/SMS fan-out; `WEBSOCKET` only reaches a browser tab already open on the exact affected entity's page. Fix: add `AlertChannel.EMAIL` to the rule's channel list and reuse the existing `send_issue_alert_email` (already called by `_dispatch_email`, just not from this rule).

**Why it matters:** Without this, even a perfectly wired and triggered P0 rule reaches a human only if they happen to have the exact right browser tab open at the exact right moment.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #40. Fix `anomaly_alerts.py`'s severity-blind channel dispatch

**Source:** `04-alerting-oncall.md`, §0 anomaly-detection paragraph, §3 fix item 5 (citing `data_platform/anomaly_detector_loop.py:109-127,122`; `check_pii_breach` ~L320-357/348; `anomaly_alerts.py:426-460,573`).

**Description:** `AnomalyDetector.dispatch_alerts` already correctly implements `in_app`, `websocket`, `email`, and a gated-real `webhook` channel — only `slack`/`pagerduty` are true no-ops there. But the caller, `AnomalyDetectorLoop.tick_once` (runs by default on a ~1200s cadence, `anomaly_loop_enabled` defaults `True`), hardcodes `channels=["in_app"]` on every single call regardless of severity. A detected PII breach (hardcoded `severity="critical"`) dispatches through the exact same call as a routine warning. Fix: make `tick_once` select channels based on `alert.severity` instead of the hardcoded list — a call-site-only change since the channel implementations already exist.

**Why it matters:** A critical PII breach anomaly currently produces one Postgres notification row, full stop — no email, no webhook, nothing that reaches a human, despite the underlying dispatch code already supporting it.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #41. Stop claiming self-serve alert configuration exists

**Source:** `04-alerting-oncall.md`, §4 Recommendation.

**Description:** The one pipeline that reliably reaches a human (NL-alert → EQL → email) has no authoring UI — a customer cannot configure it through the product today at all, independent of and more fundamental than any transport gap. Fix: correct any marketing/product claims implying customers can self-configure alerts today, until a self-serve authoring UI ships.

**Why it matters:** The product cannot even be configured by a customer today, a more basic gap than whether delivery works.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #42. Build a real PagerDuty Events API v2 sender, and stop claiming working PagerDuty alerting until it ships

**Source:** `01-competitor-matrix.md`, "Verdicts" section, "PagerDuty alerting" entry (citing `alert_stream.py:427-429`; cross-referenced in `04-alerting-oncall.md`) **+** `04-alerting-oncall.md`, §1 transport table, §4 Recommendation (citing `alert_stream.py:427-429`; `anomaly_alerts.py:457-458`; `webhook_delivery.py`) — two review docs independently flag the same dead PagerDuty integration from a messaging angle and a build angle respectively; merged into one entry.

**Description:** `AlertChannel.PAGERDUTY` is a real enum wired into the P0 rule, but `_dispatch_pagerduty()` is exactly two lines: a log statement, no HTTP call, no config lookup — the same no-op pattern repeats in `anomaly_alerts.py`. Two named competitors (LangSmith, Arize AX) are sourced with live PagerDuty integration. Fix: (1) build a real PagerDuty Events API v2 sender, reusing `webhook_delivery.py`'s existing HMAC-SHA256 signing / retry ladder (`0s,1s,5s,25s,2m,10m,1h`→DLQ) / SSRF-safe DNS re-resolution infrastructure rather than a bare unretried POST (a generic Opsgenie-compatible webhook is a secondary, lower-priority addition given Opsgenie's 2027 sunset); (2) until it ships, do not cite eden as having working PagerDuty alerting in competitive or customer-facing material.

**Why it matters:** This is the fix most people assume is "the" fix but is step 4 of 4 in the broader alerting-pipeline chain — and overclaiming a no-op integration against named competitors with verified live PagerDuty support is a credibility risk in any competitive-positioning document or sales conversation where the claim could be checked.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #43. Make `nl_alert_rules.channels` actually route to the configured channel

**Source:** `04-alerting-oncall.md`, §0.5 bullet 3, "User Experience & Value" (citing `alerts/repo.py:57`; `portal.py:324-350`; `alert_email.py:143-176`).

**Description:** `nl_alert_rules.channels` is collected, stored, and displayed back to the user, but the only live send path (`send_nl_incident_email`) is unconditional email to org admins with no channel argument at all. A user who configures `channels: {"slack": true}` still only ever gets email, if anything. Fix: thread the `channels` config through to the actual send path so it's honored.

**Why it matters:** The UI presents channel selection as a working feature; today it is entirely cosmetic, misleading a customer configuring notification routing.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #44. Unify the three/four disconnected alert-routing systems into one data model

**Source:** `04-alerting-oncall.md`, §1, §4 (citing Automations `automations/engine.py`; `playbook_router.py`'s 22 hardcoded categories; `alert_stream.py`'s Kafka rule engine; the NL-alert/`AlertAsCode` pipeline).

**Description:** None of the four alert-routing systems (Automations tab, playbook router, Kafka rule engine, NL-alert pipeline) share a data model, a severity concept, or a notification-destination concept. Fix: design and build a single unified rule/severity/destination data model that the various trigger sources (security events, quality/behavior findings, EQL rules, score thresholds) all route through.

**Why it matters:** Even after the individual point fixes land, the product still lacks one coherent place to configure "alert me on X, send it to Y" — a structural product-architecture gap, not just isolated bugs.

**Severity:** High
**Effort:** Large
**Confidence:** High

---

### #45. Build the missing budget-setting UI form in the portal

**Source:** `06-cost-governance.md`, "Setting a budget: a real backend, a missing product" (citing `clients/portal/src/lib/api/budget.ts`; unused `upsertBudget()` in `resources.ts:2245`; `cost-spend-view.tsx:121-153`).

**Description:** `budget.ts` (the client the Cost page actually uses) exports exactly one function, `get()` — no `set`/`upsert`/`update`. A second, fully-typed but entirely unused client wrapper, `upsertBudget(orgId, body)`, already wraps `POST /orgs/{org_id}/budget` with the exact typed body the backend expects (`cost_soft_limit_usd`, `cost_hard_limit_usd`, `enforcement_enabled`, `window`, `action_on_exceed`, `threshold_alert_pct`) but has zero call sites anywhere in the portal. `cost/page.tsx` renders the budget as a read-only progress bar + status pill — no input field, no "Edit budget" button. Fix: build the form UI (soft/hard USD inputs, window picker, alert-threshold multiselect defaulting to `[50, 80, 100]`, `action_on_exceed` selector) and wire it to the already-existing `upsertBudget()` client function.

**Why it matters:** "The only way to actually configure a budget in eden today is a raw API call" — a non-starter for the actual buyer persona (a team lead who is not going to curl an endpoint). Called "arguably the cheapest, highest-visible-impact fix" in the doc since the backend contract, validation, and typed client already exist.

**Severity:** High (recalibrated from Critical in source doc — see appendix)
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #46. Mount the already-built `NotificationsProvider` so in-app budget alerts are visible

**Source:** `06-cost-governance.md`, "Getting alerted" (citing `budget_service.py:449-511`; `clients/portal/src/hooks/use-notifications.tsx:57`; `alert_email.py`'s `send_budget_hard_limit_email`).

**Description:** `evaluate_budget_alerts()` is well-built — debounced (~45s), idempotent per threshold/window, fires at 50/80/100% by default — and writes a `notifications` row via `_notify_budget_alert()` on every threshold crossing. The portal has a fully-built consumer, `NotificationsProvider` (adaptive polling, unread counts, mark-as-read, delete), but it's never mounted anywhere in the app: no provider wraps the layout, no bell icon, no toast, no notification panel exists. Separately, email alerts fire only once, at the 100% (hard) threshold — the 50%/80% "early warning" thresholds produce zero human-visible signal anywhere today. Fix: wrap the app layout in `<NotificationsProvider>`, add a bell icon/panel.

**Why it matters:** "Every in-app alert eden's backend writes for a budget threshold crossing is invisible to the customer today" — a complete notification system (table, write path, React provider) with zero UI surface consuming it. Should rank above the deeper spend-tracking schema work in sequencing since none of that backend correctness work is legible to a customer until there's a UI surface reading it.

**Severity:** High (recalibrated from Critical in source doc — see appendix)
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #47. Add team/agent-scoped budgets via `scope_type`/`scope_id` schema migration

**Source:** `06-cost-governance.md`, §2b, §3 Verdict items 1-2, §4a (citing `budget_service.py`, `budgets.py`, `052_budgets.py`).

**Description:** Eden's budgets are org-level only — all three budget tables (`budgets`, `budget_consumption`, `budget_actions`) are keyed only on `(org_id, "window")`. Both Portkey (workspace→key→tag) and LiteLLM (key/team/user/customer/project) support multi-scope budgets; eden does not. Fix, modeled on LiteLLM's "one shared budget object referenced by scope" pattern: `ALTER TABLE budgets/budget_consumption/budget_actions ADD COLUMN scope_type VARCHAR(16) DEFAULT 'org', scope_id VARCHAR(128) NULL`, replace unique indexes to include scope, give `get_consumption()`/`record_usage()` new keyword-only `scope_type`/`scope_id` params. Must ship combined with — not sequenced after — the underlying spend-tracking correctness fixes, and should not ship before the budget-editing UI (#45) and alert-surfacing (#46) land, since "shipping `scope_id` without first shipping an editing UI just adds a second thing that's only reachable by curl."

**Why it matters:** A two-vendor competitive gap (both Portkey and LiteLLM ship it); without it eden cannot offer per-team or per-agent cost governance at all.

**Severity:** High
**Effort:** Large
**Confidence:** High

---

### #48. Make `enforce_sso` actually block password login, or remove the toggle

**Source:** `07-security-compliance.md`, §1c item 1 (citing `sso.py:379-405`; `auth.py` password-login path).

**Description:** `enforce_sso` is written by `POST /sso/providers/{id}/enforce` and read back only by `list_sso_providers`'s own response — nothing in `auth.py`'s password-login path ever checks it. The docstring's claim that it "blocks password login for org members" is currently false: flipping the toggle in the portal changes no login behavior for anyone. Fix: either wire `auth.py`'s password-login path to check and honor `enforce_sso`, or remove/relabel the toggle so it doesn't imply a security control that doesn't exist.

**Why it matters:** An admin who enables this toggle believing it closes the password-login bypass for their org is operating under a false security assumption — this is a silent security-control gap, since the UI implies protection that isn't applied.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #49. Resolve the dual-SSO-story ambiguity (Clerk-based vs. `sso.py` OIDC/SAML)

**Source:** `07-security-compliance.md`, §1c item 2 (citing `docs/docs/how-to/sso.md`; `clients/portal/src/lib/api/resources.ts`).

**Description:** `docs/docs/how-to/sso.md` documents SSO as configured entirely via the Clerk dashboard — separate from the `sso.py` OIDC/SAML flow. The portal's admin UI only wires config functions for `sso.py` (`listSSOProviders`, `createSSOProvider`, `enableSSOProvider`, `enforceSSO`, SCIM token functions) and never calls `/sso/login` or `/sso/callback`, so the portal's SSO tab lets an admin configure a login path the product never drives traffic through. Fix: pick one authoritative mechanism (Clerk or `sso.py`) and either remove/hide the other's admin UI, or add an explicit in-product warning that the `sso.py` config path is inert.

**Why it matters:** Today an admin can spend time configuring a "parallel dead code path" with no warning that it does nothing — a silent trust-eroding trap, and a documentation/product inconsistency that would confuse any technical buyer who reads both the how-to doc and the settings UI.

**Severity:** High
**Effort:** Small (decision + UI warning); Large if fully consolidating
**Confidence:** High
**Quick win.**

---

### #50. Wire the "Audit → packs" screen to `ComplianceEvidenceGenerator`/`CompliancePackGenerator` instead of a raw ledger query

**Source:** `07-security-compliance.md`, §5b, §7 (citing `settings/page.tsx:143-168`; `api/routes/portal.py:2692`; `services/governance_intel/compliance.py`, 811 lines; `governance/compliance_pack.py`, 244 lines).

**Description:** The one live, wired compliance-adjacent screen in the portal (Audit → packs) calls `GET /orgs/{orgId}/portal/audit/packs`, which traces to `AgentAuditLedgerWriter().query()` directly — not to `ComplianceEvidenceGenerator` (811 lines, tested to generate 50+ SOC2 controls / 18 HIPAA safeguards / 10 GDPR controls / 14 ISO27001 families) or the newer agent-scoped `CompliancePackGenerator` (enabled by default via `compliance_pack_export_v1`). So the one screen a compliance officer can actually load shows a raw hash-chained audit-event ledger, not a framework-mapped evidence report. Fix: repoint this screen, or add a new one, that calls `CompliancePackGenerator.generate_agent_pack` (or `ComplianceEvidenceGenerator` directly) instead of the raw ledger query.

**Why it matters:** A compliance officer running a vendor security questionnaire needs a framework-mapped evidence report, not a raw event ledger — today's live screen serves the less useful one despite the better one already existing and being enabled by default in production.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #51. Ship a portal admin UI for SSO/RBAC/SCIM/PII-policy configuration

**Source:** `07-security-compliance.md`, §5b, §5e items 1-3 (citing `settings-chrome.tsx`; `resources.ts:1531-1534`).

**Description:** `clients/portal/src/lab/settings/settings-chrome.tsx` exposes only four modes (`workspace`/`keys`/`members`/`audit`); legacy `scim`/`pii` tab params alias to `workspace` with no dedicated screen, and no `settings/roles`, `settings/sso`, `settings/scim`, or `settings/pii` sub-routes exist. Every SSO/RBAC/SCIM/PII-policy function in `resources.ts` has zero external consumers. A stale code comment at `resources.ts:1531-1534` describes a planned `/settings/roles` page that was never built. Fix, per the doc's gap-ranked recommendation: P0 ship SSO/SAML self-service admin screen (paired with the SSO login-flow fix); P1 ship RBAC role/permission management screen; P1 ship a PII policy configuration screen ("eden's strongest technical story, currently invisible to buyers").

**Why it matters:** RBAC (custom roles + permission catalogue at `rbac.py`, 715 lines) and PII redaction (multiple modules, 35 matching test files) are real, tested, working backends with zero portal path to configure them — disqualifying for a self-serve security review by a security-conscious buyer regardless of backend quality.

**Severity:** High
**Effort:** Large (all three screens); Medium per individual screen
**Confidence:** High

---

### #52. Repoint `cohorts.py` at `session_summaries` instead of `jobs`

**Source:** `features/11-session-analytics.md` — analytics code / wrong-table bug section, `cohorts.py`.

**Description:** `cohorts.py` (cohort analysis logic) currently queries the `jobs` table, which is not the correct source for session/cohort analytics — it should query `session_summaries` (the N12 table). This appears to be orphaned code written against an earlier/wrong schema assumption. Fix: repoint the queries to `session_summaries` and validate output against expected cohort semantics.

**Why it matters:** Cohort analysis output is currently either wrong or meaningless (querying job records, not session records, for what should be session-based cohort retention data) — any feature or dashboard relying on `cohorts.py` is silently producing incorrect numbers.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #53. Repoint `funnels.py` at `session_summaries` instead of `audit_log`

**Source:** `features/11-session-analytics.md` — analytics code / wrong-table bug section, `funnels.py`.

**Description:** `funnels.py` (funnel analysis logic) currently queries `audit_log`, which is both semantically wrong (audit logs are not funnel/session step data) and references a table that doesn't even exist (see #54). Fix: repoint to `session_summaries` and rebuild funnel-step logic against the correct schema.

**Why it matters:** Funnel analytics are silently non-functional or wrong, and any downstream reporting or optimization decisions based on funnel data are built on broken foundations.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #54. Fix the nonexistent `audit_log` table reference (also breaks `export_audit_log`)

**Source:** `features/11-session-analytics.md` — schema bug section, `audit_log` table.

**Description:** Beyond being the wrong semantic source for funnels (#53), `audit_log` as referenced in code does not actually exist as a table in the current schema — a harder failure than a wrong-table bug, meaning any code path hitting this reference (including a separate `export_audit_log` function/feature) fails outright rather than returning wrong data. Fix: either create the missing `audit_log` table with correct schema if audit logging is still wanted, or remove/repoint all references (`funnels.py`, `export_audit_log`) to the correct current audit/event source.

**Why it matters:** A harder, more visible failure than the pure wrong-table bugs (likely throws exceptions rather than silently returning wrong data), and it affects at least two independent code paths, suggesting the underlying schema drift is broader than a single file.

**Severity:** High (recalibrated from Critical in source doc — see appendix)
**Effort:** Medium
**Confidence:** High

---

### #55. Wire the portal session list/header to read from `session_summaries`, not `agent_sessions`

**Source:** `features/11-session-analytics.md` — portal wiring gap section (F23 vs N12).

**Description:** The shipped portal session list and session header UI (F23) currently reads from the `agent_sessions` table. Only the turn-detail view (N12) reads from the newer, more complete `session_summaries` table. This means the primary session list a user sees and the detail view they drill into are backed by different, disconnected data models — potentially showing inconsistent session counts, metadata, or timing between the list and the detail page.

**Why it matters:** Directly user-visible inconsistency: a user could see one session count/summary in the list view and a different (or missing) picture when they click into a session's detail — a confusing, trust-eroding UX bug in a core navigation flow.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #56. Provide exact migration SQL to consolidate/backfill session tables

**Source:** `features/11-session-analytics.md` — migration section (exact SQL provided in source).

**Description:** The source doc includes exact migration SQL intended to address the session-table fragmentation (`user_sessions`/`session_summaries`/`agent_sessions` — see #57). Treat as a concrete, ready-to-review action item: run/adapt the provided migration to backfill and reconcile the three tables rather than starting the consolidation design from scratch.

**Why it matters:** Having ready-made migration SQL substantially lowers the effort bar for the broader consolidation — the hard design work is already done, just needs review and execution.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #57. Consolidate or reconcile the three disconnected session tables

**Source:** `features/11-session-analytics.md` — session data model section (`user_sessions`, `session_summaries`, `agent_sessions`).

**Description:** eden currently has three separate, disconnected tables all representing "sessions" in some form: `user_sessions`, `session_summaries`, and `agent_sessions`. They are not joined or reconciled with each other, meaning different parts of the product report different, potentially contradictory session data depending on which table they query. Fix: define a single canonical session representation (or explicit, documented relationships/foreign keys between the three) and migrate consumers onto it — ready-made migration SQL is available (#56).

**Why it matters:** Fragmented session data undermines trust in any session-based metric eden reports (retention, engagement, session counts) since the "truth" depends on which internal table happened to be queried — a customer-facing credibility risk if surfaced inconsistently.

**Severity:** High
**Effort:** Large
**Confidence:** High

---

### #58. Fix `export_audit_log` independent of the `funnels.py` fix

**Source:** `features/11-session-analytics.md` — schema bug section, `audit_log` table (see also #54).

**Description:** `export_audit_log` is a separate consumer of the nonexistent `audit_log` table from `funnels.py`, and may need its own fix (e.g., a genuinely different data source than `session_summaries`, since "audit log" and "session funnel" are different concepts) rather than being folded into the same repoint as the funnels fix. Fix: determine `export_audit_log`'s correct intended data source (likely a real audit/event table, not session data) and repoint or rebuild it separately.

**Why it matters:** Treating this as identical to the funnels fix risks mis-fixing it (funnels and audit export are semantically different features that happened to share a broken table reference); calling it out separately ensures it gets its own correct fix.

**Severity:** High
**Effort:** Medium
**Confidence:** Medium — the underlying bug (#54) is High confidence; the specific claim that it needs an independently different fix from funnels is a reasonable inference, not explicit in the source.

---

### #59. Fix broken `org_id`/`tenant_id` column mismatch in `_fetch_telemetry_rollup_for_agent`'s sub-queries

**Source:** `05-multiagent-tracing.md`, "What eden actually has" (citing `src/eden/agents/agent_intel/_common.py:238-340,291-299,325-333`; `010_judge_scores.py:32`).

**Description:** `_fetch_telemetry_rollup_for_agent` fires three parallel queries via `asyncio.gather`. `_telemetry_rows()` (queries `telemetry_events WHERE org_id = $1`) and `_judge_rows()` (queries `judge_scores WHERE org_id = $1`) both filter on a column, `org_id`, that doesn't exist on either table — both key on `tenant_id`. Only `_cost_rows()` (against `usage_events`, which genuinely has `org_id`) works. Each sub-fetch is independently wrapped in `except Exception: logger.debug(...)`, silently swallowing the failures. Fix: change the WHERE clause in `_telemetry_rows()`/`_judge_rows()` from `org_id = $1` to `tenant_id = $1`, and add real error surfacing instead of silent `logger.debug`.

**Why it matters:** Every call to this rollup silently returns `n_traces: 0, success_rate: None, judge_avg: None` — only `cost_usd` is ever populated. Any UI/report depending on this rollup shows agents as having zero traces and no success rate.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #60. Add matching fields to `TelemetryEventIngest` Pydantic ingest model

**Source:** `05-multiagent-tracing.md` (citing `src/eden/api/routes/observability.py:65`).

**Description:** The Pydantic model validating the wire payload before it becomes a `TelemetryEvent` lacks `operation_name`, `provider_name`, `error_type`, `parent_agent_span_id`, `child_agent_trace_id`. Fix: add the same 5 fields as `Optional[...]`, default `None`.

**Why it matters:** Without this, incoming payloads carrying these values from SDKs/exporters would be validated away before ever reaching the dataclass.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #61. Add `agent_id` and `operation_name` to `get_trace_tree`'s per-span node dict

**Source:** `05-multiagent-tracing.md` (citing `telemetry_collector.py:2053-2094`; `portal.py:1385`).

**Description:** `TelemetryCollector.get_trace_tree`'s node dict builds `"error_type": row.get("error_type")` but has no `agent_id` key at all. Fix: add `"agent_id": row.get("agent_id")` and `"operation_name": row.get("operation_name")` next to the existing key — zero-cost once the columns are made real.

**Why it matters:** Even a single trace spanning multiple agents currently cannot show which span belongs to which agent in the transcript view that already correctly walks `parent_span_id` — the specific missing input that blocks swimlaning (#63).

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #62. Fix `error_type` permanently-null bug and its downstream effect on session-level error detection

**Source:** `05-multiagent-tracing.md` (citing `get_trace_tree` `:1848-2109`, node dict `:2092`; `sessions/rollup.py:137-140`).

**Description:** Since `error_type` has never been written, every span node the portal's trace-detail view renders has had an always-`None` `error_type` since migration 067 shipped. Second live consumer: `sessions/rollup.py:137-140`'s `_turn_errored(row)` does `bool(row["error_type"]) or outcome in _ERROR_OUTCOMES` — since `error_type` is always null, that first disjunct is always `False`, meaning session-level error detection today runs entirely on the `outcome` fallback. Fixed as a side effect of the write-path fixes, but flagged separately because it's a live, currently-silent correctness bug in a second consumer that should be explicitly verified/tested once the write-path fix lands.

**Why it matters:** Session-level error detection is currently missing a whole detection signal, silently relying only on `outcome`-based detection — some session errors are likely undercounted today with no visible symptom.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #63. Swimlane the trace transcript UI by agent identity

**Source:** `05-multiagent-tracing.md`, "What it should look like" (citing `TranscriptStep`, `_tree_node_to_step`, `portal_contracts.py:78-97`).

**Description:** The trace tree already correctly walks `parent_span_id` for intra-agent nesting; the only missing input is `agent_id` on each `TranscriptStep`. Fix: add `agentId` to the `TranscriptStep` contract, populate it in `_tree_node_to_step` (reading `node.get("agent_id")`, available once #61 lands), and group/color the existing flat transcript list by that field in the frontend (`traces-client.tsx`/`traces-detail-panels.tsx`). No new backend computation required beyond #61.

**Why it matters:** Today a trace spanning three agents shows a single collapsed "preferred" agent label in the trace list, and once opened that label disappears entirely — every span in the transcript looks identical in origin. The only current workaround is noticing discontinuities in model/provider naming, or bypassing the portal to query `telemetry_events.agent_id` directly.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #64. Surface the `a2a` sub-document as a labeled "handoff" transcript marker instead of silently stripping it

**Source:** `05-multiagent-tracing.md` (citing `portal.py:752`; `sdk/a2a.py:114-129`).

**Description:** When a caller uses the A2A SDK wrapper, `_A2ACallCtx.attributes()` merges `{"parent_agent_span_id", "child_agent_trace_id", "a2a": {"invocation_type", "parent_agent_id", "child_agent_id", "response_status"}}` into a span's JSONB `attributes`. But `_tree_node_to_step` builds the outgoing `attributes` field via a scalar-only filter (`isinstance(v, (str, int, float, bool))`) that silently drops the nested `"a2a"` sub-document — the one part of the payload with human-readable agent IDs and an explicit invocation type. Only two unlabeled flat UUID strings survive, rendered as raw JSON with no click-through. Fix: surface the `a2a` sub-document as a distinct, labeled `"handoff"` `TranscriptKind` instead of letting it be erased by the scalar-only filter.

**Why it matters:** Real, already-computed agent-linkage data (human-readable agent ids, invocation type, response status) is actively discarded before reaching the browser — the engineer currently sees two unlabeled UUIDs in a raw JSON blob instead of a clickable, labeled handoff event.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #65. Build within-trace causal-chain navigation for agent delegation failures

**Source:** `05-multiagent-tracing.md` (citing `parent_agent_span_id`/`a2a.parent_agent_id`; contrasted with `FleetService.delegation_graph`'s org-wide `_delegation_trust_score`, `fleet/service.py:404-443`).

**Description:** When a child agent's span errors, there is no way for the engineer to walk backward through `parent_agent_span_id`/`a2a.parent_agent_id` to see which agent's delegation produced the failing call, and whether the parent agent then also failed as a consequence. Fix: build a UI/API path letting the engineer traverse this causal chain within a single trace (distinct from the org-wide aggregate blast radius `FleetService.delegation_graph` already computes — see #66).

**Why it matters:** Without this, a failure shows up as "just a red dot" with no way to trace which delegation chain produced it — core debugging functionality for a multi-agent observability product, directly blocking root-cause analysis of cascading agent failures.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #66. Build a portal UI panel for the org-wide delegation graph (`FleetService.delegation_graph`) and update the guard test blocking `fleetApi`/`a2aApi` reintroduction

**Source:** `05-multiagent-tracing.md` (citing `fleet/service.py:128-158,404-443`; route `fleet.py:60-62`; `agents-client.tsx`; `dead-code-removal.test.ts:32`; `stub-try-instead.ts`).

**Description:** The backend is fully correct and self-refreshing: `refresh_delegation_edges` rebuilds `agent_delegation_edges` from a 7-day `a2a_links` aggregation, and `delegation_graph()` calls it inline on every request, returning `{nodes: [{id, label, delegation_trust}], edges: [{source, target, call_count_7d, error_rate_7d, delegation_trust, blast_radius}]}` via `GET /orgs/{org_id}/fleet/delegation` (gated behind `require_feature_flag("fleet_health_v1")`, default `True` — live, not dark-launched). But there are zero real frontend consumers of any `FleetHealthService` endpoint — a repo-wide grep for `fleetApi`/`/fleet/...` returns nothing except a test asserting `fleetApi`/`a2aApi` stay deleted; `/fleet` is coded as a *retired* route redirecting to `/agents`. Fix: add a "Delegation" panel/tab to the existing detail pane in `agents-client.tsx` (or an org-level sub-view under `/agents`), calling the existing endpoint. Do NOT resurrect a standalone `/fleet` page. Requires deliberately updating `dead-code-removal.test.ts:32`, not working around it.

**Why it matters:** A materially correct, live, self-refreshing backend feature (org-wide agent delegation graph with trust scores and blast radius) is completely invisible to any user today — a pure presentational gap, not a backend gap. Also directly informs #65's causal-chain work and reuses the same node/edge rendering shape.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #67. Fix `time_travel/replayer.py:453` — always-raising `AIGateway.complete()` call site

**Source:** `features/10-model-gateway.md` — undocumented production call sites, `time_travel/replayer.py:453`.

**Description:** This call site unconditionally calls `AIGateway.complete()`, and because `AIGateway` (a fully-built, ~900-line multi-provider routing/failover engine, verdict: DELETE) is dormant/non-functional, this call always raises an exception — a previously-undocumented, silently-broken production code path. The feature that depends on it, time-travel replay, is effectively non-functional whenever this path is hit. Fix: either repoint this call at eden's actual internal LLM client (`eden.llm.client.OpenRouterClient`) or remove/guard the code path pending `AIGateway`'s deletion.

**Why it matters:** A production feature (time-travel replay) is silently broken end-to-end; any user or internal workflow depending on it fails with no prior warning, and this bug had not previously been surfaced/tracked anywhere before this review.

**Severity:** High (recalibrated from Critical in source doc — see appendix)
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #68. Populate `INTERNAL_CHAT_FALLBACKS` for eden's own internal LLM traffic

**Source:** `features/10-model-gateway.md` — eden's internal LLM usage section, `eden.llm.client.OpenRouterClient`.

**Description:** 100% of eden's own internal LLM traffic (calls eden itself makes to LLMs — evals, nudge generation, issue extraction, etc.) goes through `eden.llm.client.OpenRouterClient`. This client has an `INTERNAL_CHAT_FALLBACKS` provider/model-fallback mechanism that is currently unpopulated (empty), meaning there is no actual fallback behavior configured — a single OpenRouter/upstream outage takes down all internal LLM-dependent eden features simultaneously with no fallback.

**Why it matters:** eden's own product features (evals, nudges, issue extraction, all LLM-dependent internal pipelines) have a single point of failure with no fallback configured, despite the fallback mechanism already existing in code — a cheap reliability win being left on the table.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #69. Make Python's missing-`org_id` failure loud instead of silently swallowed

**Source:** `features/09-sdk-dx.md` — error-handling comparison, `config.py:216`, `client.py:1238`.

**Description:** Python's `config.py:216` raises a `ValueError` when `org_id` is missing, but the only call site that matters (`client.py:1238`) wraps it in a broad `except` that just does `log.warning(...)` — so in practice the error is unreachable/silent from the user's perspective; they get no signal at all that ingestion will fail. Contrast: the TS SDK emits a synchronous, visible `console.warn` for the equivalent condition. Fix: in Python, surface the same class of visible warning (or raise, depending on desired strictness) at the actual usage site rather than swallowing it in a broad except.

**Why it matters:** A misconfigured Python SDK silently drops all telemetry with no diagnostic signal — one of the worst possible failure modes for an observability product; users won't know their data isn't arriving until they go looking for it and find nothing.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #70. Reconcile TS and Python instrumentation UX so both meet the "one-liner" bar

**Source:** `features/09-sdk-dx.md` — overall SDK DX comparison (synthesizes the auto-instrument gap findings).

**Description:** eden's product story ("drop in one line, get full traces") is only true for Python today. Any marketing/docs/onboarding flow that promises this for "the eden SDK" generically is currently false for TS/Node users. Fix (product-level, not just code): either scope the one-liner promise explicitly to Python-only in all external-facing docs until real TS auto-instrumentation ships, or prioritize that work so the promise becomes true for both.

**Why it matters:** Mismatched product claims vs. reality erode trust at the exact moment (first install) users are forming their opinion of the product; Node/TS is a large fraction of the LLM app ecosystem (LangChain.js, Vercel AI SDK, etc.).

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #71. Build real one-liner auto-instrumentation for the TypeScript SDK

**Source:** `features/09-sdk-dx.md` — auto-instrumentation comparison section.

**Description:** Python's `eden.instrument()` does genuine class-level monkey-patching across 13 frameworks (a real one-liner). TypeScript has no equivalent: instrumentation is per-instance `Proxy`-based `wrap*()` factories the caller must manually apply to every client instance they create — no mechanism patches a framework's exported class/prototype once at import time the way Python does. Fix: implement prototype-level (or Node loader-hook-based, e.g. `import-in-the-middle`) auto-instrumentation for at least the top few frameworks, matching the Python UX.

**Why it matters:** TS/Node users get a materially worse onboarding experience than Python users for the exact same product promise ("one line of code") — a direct DX/adoption gap in a core acquisition funnel (SDK install → first trace).

**Severity:** High
**Effort:** Large
**Confidence:** High

---

### #72. Stop dropping the `synthetic`/`method` honesty flags in the frontend, and add a visible badge

**Source:** `02-evals-datasets.md`, §6 "User Experience & Value" (lines ~527-575); citing `resources.ts:4045-4046,4059-4060`, `evals-compare-view.tsx` (681 lines), `evals/page.tsx:1269-1287`.

**Description:** The backend is honest that F51 is fake — every `run()`/`compare()` response carries `synthetic: true, method: "heuristic_stub"`, and the TypeScript API client types these fields explicitly. But `evals-compare-view.tsx` (the component rendering the improve/regress/tradeoff verdict and score deltas) never references "synthetic" or "heuristic," and `evals/page.tsx:1269-1287`'s `ExperimentFixture` mapping drops `result.synthetic`/`result.method` on the floor when building UI state (hardcodes `avgScores: {}`). Net effect: a user who clicks "Run" gets a confident-looking "Treatment is better, 12 improvements / 3 regressions" screen with zero indication the scores are a substring-match heuristic. Fix: add a `synthetic`/`method` badge to `evals-compare-view.tsx` and stop dropping the fields in `evals/page.tsx`'s mapping — "a few lines," since the data already round-trips through the API client's own types.

**Why it matters:** An active, current, user-facing trust/honesty gap sitting on top of the underlying fake-scoring issue — until the real-scoring fix ships, users are being actively misled by a UI that hides an honesty label the backend already computes.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #73. Correct the misleading "Promote to Experiment" button label and success-toast copy

**Source:** `03-prompt-playground.md`, §4; "User Experience & Value → Where the workflow breaks down."

**Description:** The button reads "+ Experiment" and the success toast says "Immutable snapshot promoted — open Evals to compare." The API payload itself is honest — it labels the result `synthetic: true`, `method: "heuristic_stub"` — but the portal UI (button label + toast) actively suggests to a normal user that their real comparison was promoted, when in fact it's replaced by a hardcoded stub once actually executed. Fix: until/unless the backend is fixed, update the button label and toast copy to not overstate what the "promote" action does, or surface the `synthetic`/`heuristic_stub` labels in the UI itself rather than only in the raw API payload.

**Why it matters:** A pure UI-honesty problem separable from the backend fix — it can ship fast as a stopgap to stop actively misleading users, independent of the larger backend rework.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #74. Migrate `RegressionCaseBuilder` off its free-text `dataset_id` onto F53's UUID-keyed `dataset_items`

**Source:** `02-evals-datasets.md`, §5 P1 item 5 (citing `regression_builder.py:267-290,188-209,307-311`; `regression_eval_cases.dataset_id VARCHAR(128)` in `db_migrations/versions/092_market_ready_consolidated.py:355-367`).

**Description:** `RegressionCase.dataset_id` is a free-text name string (e.g. `"agent-name/regressions"`), stored in a `VARCHAR(128)` column — schema-incompatible with F53's proper `UUID` `datasets.id`; these two "dataset_id" columns cannot be joined even in principle. Fix: change `RegressionCaseBuilder._persist` to insert into `dataset_items` (resolving a proper UUID `dataset_id` via `DatasetHub.get_dataset`/`create_dataset`) instead of the separate `regression_eval_cases` table, while keeping the existing fingerprint-based dedup logic (`_find_by_fingerprint`), which is sound and just needs to query `dataset_items` instead.

**Why it matters:** The specific, concrete schema blocker preventing eden's regression-case system and its canonical dataset/experiment system from ever being unified — a real migration step, not just "these should share code" hand-waving.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #75. Make `dataset_engine.py`'s generated datasets durable via `DatasetHub` instead of an in-memory dict

**Source:** `02-evals-datasets.md`, §5 P1 item 9, §3c (citing `dataset_engine.py:207,364-381,61`; `hub.py:124-167,232-283`).

**Description:** `DatasetGenerationEngine` is wired live via `InsightsService` → `api/routes/insights.py`, but `self._datasets: dict[str, Dataset] = {}` (constructor, L207) populated by `_store_entry` (L364-381) means every generated dataset is lost on process restart despite being API-reachable. Fix: replace the in-memory dict with calls into `DatasetHub.create_dataset`/`promote_trace` so detected patterns persist past a restart. The rule-based taxonomy (`DatasetRule.matches`, L61) does not need to change — only the storage backend.

**Why it matters:** A live, API-reachable feature silently loses all its data on every process restart — a durability bug that would surprise any user who generated a dataset and then found it gone.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #76. Fail-closed the lease-claim exception handler

**Source:** `08-annotation-labeling.md`, §1a, §6a item 2 (citing `labeling.py:462-468`).

**Description:** Current code catches any unexpected exception from `claim_lease()` with `except Exception: pass`, then proceeds *as if the lease had been successfully claimed* instead of declining the item (`claim_lease()` already catches its own Redis failures internally, so this only fires on a genuinely unexpected error). Fix: change `except Exception: pass` to `except Exception: continue` (or log + skip).

**Why it matters:** This is the one place designed to guarantee exclusivity between reviewers; defaulting to "grant access on error" instead of "deny" defeats the purpose of the lease mechanism on any unexpected failure.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #77. Check UPDATE rowcount before confirming item claimed

**Source:** `08-annotation-labeling.md`, §1a, §6a item 3 (citing `labeling.py:487-497`).

**Description:** The status-flip `UPDATE labeling_items SET status='in_progress' WHERE id = $1 AND status = 'pending'` correctly guards on `status='pending'`, so a second writer's UPDATE becomes a no-op — but the return value of `self._pg.execute()` is discarded and the code unconditionally flips `item.status = "in_progress"` and appends it regardless of whether the UPDATE actually changed a row. Fix: only append/flip in Python if the UPDATE's returned status string confirms a row was affected (e.g., `"UPDATE 1"` vs `"UPDATE 0"`).

**Why it matters:** If the lease-claim gaps (#76 and its sibling) let a second claimant through, the API will still report the item as successfully assigned to them even though the DB-level guard silently rejected the write — a silent data-integrity inconsistency.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #78. Add lease-expiry recovery for orphaned `in_progress` items

**Source:** `08-annotation-labeling.md`, §1a, §6a item 1 (citing `labeling.py:487-497`; `labeling_leases.py`; `EDEN_LABELING_LEASE_TTL_SECONDS` default 900s, floor 30s).

**Description:** When a reviewer disconnects or sits idle past the lease TTL, the Redis key expires, but `labeling_items.status` was already flipped to `'in_progress'` at claim time and nothing ever reverts it. No reaper/sweep job exists, and no admin unassign/reclaim endpoint exists. All three `pop()` tiers filter on `status = 'pending'`, including tier 1 (`assigned_to = annotator_id AND status = 'pending'`) — so even the original annotator cannot re-pop an item they abandoned; it's orphaned permanently, recoverable only via manual DB UPDATE. Fix: add a sweep (cron job or inline check in `pop()`'s tier-1 query) that reverts `status` from `in_progress` back to `pending` when no active lease key exists for that item. Cheapest version: extend tier 1's WHERE clause to also match `status = 'in_progress' AND assigned_to = annotator_id AND <lease not held by anyone else>`.

**Why it matters:** Without this, a disconnected reviewer's item is stuck forever with no self-heal path — a directly visible "I can't pop this item, it says it's assigned to someone else, but no one's touched it in an hour" trust-eroding bug the moment the annotate UI goes live.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #79. Consolidate the two duplicate IAA engines (delete dead code, repoint, rename)

**Source:** `08-annotation-labeling.md`, §3, §6a item 4, §7 item 3 (citing `evaluation/iaa.py`, 44 lines; `api/routes/labeling.py:446-471`; `LabelingQueueService.add_item()`; `test_w18_playgrounds.py:9,187-189`).

**Description:** `src/eden/evaluation/iaa.py` is dead code in production. Its sole consumer, `queue_iaa()`, reads `label_a`/`annotator_1`/`label_b`/`annotator_2` keys from a kanban item's JSON payload — but nothing in the codebase ever writes those keys, and there's no API route to add an item to a queue at all. Net effect: `GET /orgs/{org}/labeling/queues/{queue_id}/iaa` returns `{"kappa": 0.0, "n": 0, "agreement_rate": 0.0}` for every queue created through the normal product flow, today. Fix (3 steps, same PR): (1) repoint `queue_iaa()` to call `LabelingService(pg).compute_iaa(org_id, item_ids)` (the real, tested κ+α engine); (2) delete `evaluation/iaa.py` and its one test, migrating its assertions to call `cohens_kappa()`/`agreement_rate()` from `labeling.py`; (3) rename `/labeling/iia` → `/labeling/agreement` and `/queues/{id}/iaa` → `/queues/{id}/agreement` to remove the `/iia` vs `/iaa` visual collision, in the same PR.

**Why it matters:** Confirmed dead/broken code that would otherwise ship into a brand-new IAA dashboard UI (#81) as a permanently-empty widget — must be fixed before/alongside the UI build.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #80. Build `/labeling/queues/[queueId]` kanban board page

**Source:** `08-annotation-labeling.md`, §6c.2.

**Description:** Build columns `todo / in_progress / done / skipped`. Since no drag-and-drop library is installed in the portal today, ship v1 with a per-card "Move to →" dropdown instead. Add an IAA summary strip at top calling the unified agreement endpoint (post-#79 fix).

**Why it matters:** F50's kanban queue model has zero UI today; this is a core missing page, and its IAA strip would be permanently broken without the #79 consolidation fix landing first.

**Severity:** High (normalized from "Medium-High" in source doc — see appendix)
**Effort:** Medium
**Confidence:** High

---

### #81. Build IAA dashboard page

**Source:** `08-annotation-labeling.md`, §6c.4.

**Description:** Build headline kappa/alpha/overall-agreement tiles, a per-pair table, and a per-item table sorted ascending by agreement — the "disagreement drill-down" every competitor examined (LangSmith, Braintrust, Label Studio) ships.

**Why it matters:** `compute_iaa()`'s per-item/per-pair breakdown is already computed correctly server-side but is literally unreachable — no dashboard exists to view it, so the team lead/quality-owner persona has no way to spot low-agreement items or ambiguous rubrics.

**Severity:** High
**Effort:** Medium-Large
**Confidence:** High

---

### #82. Build `/labeling` queue-list page with disagreement-first default sort

**Source:** `08-annotation-labeling.md`, §6c.1.

**Description:** Build a table of F50 queues plus an "Unassigned items" panel sourced from `labelingApi.listItems`. Default sort ascending by `per_item[id].agreement` for items with 1+ annotation, so disagreement-needing items surface to the top automatically — "the single highest-leverage unification missing from the plan."

**Why it matters:** This is the entry point of the annotation flow and currently doesn't exist at all — no page or route matches `label`/`annotat` anywhere in the portal.

**Severity:** High
**Effort:** Large
**Confidence:** High

---

### #83. Build `/labeling/annotate` keyboard-driven work surface (core page)

**Source:** `08-annotation-labeling.md`, §6c.3.

**Description:** Build the primary annotator page: one item at a time, showing `item.prompt`/`item.payload` with a link back to `source_trace_id`/`source_span_id`, a form driven by `item.label_schema`, confidence slider, and notes field. Keyboard shortcuts: `1-9` for labels, `s` = skip, `Enter` = submit.

**Why it matters:** This is the primary persona's (annotator/QA reviewer's) entire work surface and the single highest-leverage missing page — the backend behind it (`pop`, `annotate`, lease, IAA) is already fully built and tested, but a human reviewer today can only reach it via curl.

**Severity:** High (recalibrated from Critical in source doc — see appendix)
**Effort:** Large
**Confidence:** High

---

### #84. Populate `IssueCard` DTO's `relatedSignalId` instead of hardcoding `None`

**Source:** `features/16-issue-extraction-online-evals.md` — DTO bug, `IssueCard.relatedSignalId`.

**Description:** The `IssueCard` data-transfer-object's `relatedSignalId` field is currently hardcoded to always return `None`, regardless of whether an actual related signal exists. This breaks any downstream consumer (portal UI or otherwise) that expects to navigate from an issue card to its underlying signal record. Fix: populate this field with the actual related signal ID from the underlying data model.

**Why it matters:** Breaks traceability from a surfaced issue back to the raw signal(s) that generated it — a core expectation for any triage workflow where a user wants to inspect "why was this flagged" and currently cannot navigate there from the issue card.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #85. Wire the new Dismiss action to also emit the signal Loop 1's P0 fixes expect to consume

**Source:** `features/16-issue-extraction-online-evals.md` — portal gap section, synthesized with doc 13's Loop 1 dependency.

**Description:** Called out separately from adding a Dismiss button itself because it's a specific integration-correctness requirement: the new Dismiss button shouldn't just remove/hide the issue in the UI — it needs to write the dismiss signal in the exact shape/location that Loop 1's revived pipeline (post #27/#29 P0 steps) expects to read from. Fix: coordinate the Dismiss button's backend call with whatever data contract Loop 1's P0 steps establish.

**Why it matters:** If the Dismiss button is built independently of Loop 1's actual signal contract, it risks becoming another instance of "looks like it works in the UI but doesn't actually feed the intended downstream system" — the exact class of disconnect this review repeatedly found (e.g., the session-analytics portal wiring gap, the artifacts/ledger stub routes).

**Severity:** High
**Effort:** Small
**Confidence:** Medium — the integration risk is a reasonable inference from the explicitly-stated Loop 1 dependency, not a separately named bullet in the source itself.
**Quick win.**

---

### #86. Fix `IssuePromoter._update` to actually escalate severity from `user_count`/`stumble_count`/`repetition_count`

**Source:** `features/16-issue-extraction-online-evals.md` — code-comment-vs-behavior mismatch, `IssuePromoter._update`.

**Description:** `IssuePromoter._update` has a code comment claiming it escalates severity based on `user_count`, `stumble_count`, and `repetition_count` signals, but the actual implementation never does this escalation — the comment describes intended behavior that was never built (or was removed without updating the comment). Fix: implement the actual escalation logic the comment claims exists, using the three named signals.

**Why it matters:** Even once composite issue ranking exists, if severity itself never gets escalated as new evidence (repeated occurrences, more affected users) comes in, the severity input to that ranking stays artificially low/stale. Also a direct code-vs-comment correctness bug that could mislead future engineers into thinking this logic already works.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #87. Update product copy/marketing to accurately reflect what `/artifacts` and `/ledger` currently do (interim, pre-fix)

**Source:** `features/15-artifacts-behavior-record.md` — portal wiring gap section (implied by "product copy already existing" for a stubbed route).

**Description:** Since product copy already references Artifacts/Ledger as real features while the actual routes are dead stubs, there's an interim honesty/expectation-setting action distinct from the engineering fix: either temporarily adjust copy to not overclaim UI availability, or fast-track un-stubbing `/artifacts`/`/ledger` specifically because customer-facing copy is currently ahead of the shipped product.

**Why it matters:** Customer-facing copy describing a feature that, when clicked, redirects to an unrelated queue view is a direct, visible broken-promise moment for any customer who goes looking for it based on the copy — a credibility risk independent of the underlying engineering timeline.

**Severity:** High
**Effort:** Small
**Confidence:** Medium — the underlying fact (copy exists, routes are stubs) is High confidence per the source; the specific recommended interim copy action is an inferred mitigation, not explicitly instructed in the source.
**Quick win.**

---

### #88. Ship a minimal red-team UI (list probes, run scan, view findings) and stop citing red-team probing as portal-reachable until it does

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "Topics, drift, and red-team probes have no portal surface at all" bullet — kept as a distinct final entry from the paired Topics/Drift findings in the same source point per explicit review instruction not to over-merge — **+** `07-security-compliance.md`, §5e item 6, §6, §8 "Ship the cheapest UI win" (citing `redteam/probes.py`, 699 lines; `api/routes/redteam.py:127-206`; `app.py:241`; `portal-routes.ts:13`; `guardrails-url.ts:3,70,100`; `resources.ts:3724`).

**Description:** `src/eden/redteam/probes.py` is a fully built, tested, API-live adversarial red-team subsystem — 12 named probes (jailbreak/prompt-injection/PII-leak/excessive-agency), SSRF-hardened target-endpoint validation, four mounted routes, a dedicated findings table, and two dedicated test files — but has no corresponding route anywhere under `clients/portal/src/app/(portal)/`. The portal's `/redteam` path is explicitly listed in `STUB_PORTAL_PATH_PREFIXES` and gets hard-redirected to `/unavailable`; a legacy `tab=redteam` query param under the Guardrails hub is silently normalized away to `policies` with no explanation. `redteamApi` exists in `resources.ts:3724` with three real client methods and zero component consumers. Fix: build a list-probes + run-scan + view-findings screen under the existing Guardrails hub (where the URL grammar already has a home for it) — called "the strongest 'backend built, unreachable in product' case" and the cheapest UI win in the entire security/compliance area, requiring no further backend work; until it ships, don't cite red-team probing as a portal-reachable capability against named competitors (e.g. Patronus AI's Percival).

**Why it matters:** A security engineer wanting to red-team their own agent today has to read the FastAPI route file to discover the capability exists at all — a real, API-live, differentiated capability that's completely unreachable by the target engineer persona regardless of backend maturity.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #89. Ship a portal route/tab for drift detection (PSI-based output/embedding drift) — currently zero portal surface

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "Topics, drift, and red-team probes have no portal surface at all" bullet; "Deep codebase re-pass" section for the underlying backend description (citing `predictive/drift.py`) — kept as a standalone final entry from the same source point (01-4) that also covers Topics and Red-team probes, per explicit review instruction not to over-merge; see the paired Topics (#90) and Red-team (#88) entries for the sibling capabilities from this same source point.

**Description:** `predictive/drift.py` — a real backend capability performing PSI-based output/embedding drift detection — has no corresponding route anywhere under `clients/portal/src/app/(portal)/`. No `/drift` page exists, and "drift" doesn't appear inside `/issues`, `/signals`, or `/traces` either. Fix: add a dedicated route, or at minimum a new tab inside `/signals` (which already hosts the `AutomationsView` component for detector/automation config).

**Why it matters:** Drift detection claims explicit "Phoenix/Datadog parity" as a real, API-live, differentiated capability, but is completely unreachable by the target engineer persona today regardless of backend maturity — it cannot be adopted, demoed, or credited in competitive positioning if a prospect can't click into it.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #90. Ship a portal UI for Topics/pattern clustering (F65) — a fully-built backend capability with zero portal surface

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "Topics, drift, and red-team probes have no portal surface at all" bullet (citing `topics/service.py`) — kept as a standalone final entry from the same source point covering Drift (#89) and Red-team (#88), per explicit review instruction not to over-merge **+** `features/14-user-request-mining.md` — User Experience & Value section, `src/eden/topics/` + `patterns_clusterer.py` (F65) — two review docs independently identify the same fully-built, UI-less Topics/clustering capability from a competitive-parity angle and a market-category angle respectively; merged into one entry.

**Description:** eden already has a real, working backend feature (F65) — `topics/service.py` combined with `src/eden/observability/patterns_clusterer.py` — that performs HDBSCAN-based trace clustering, functionally eden's own analog to the "user request mining" competitor category (Langfuse/Arize/Helicone/LangSmith all ship variants). It has zero portal UI; it can only be accessed some other way (API/script), not through the product — no `/topics` page exists, and "topics" doesn't appear inside `/issues`, `/signals`, or `/traces`. Fix: build a portal view surfacing discovered topic clusters, or at minimum a new tab inside `/signals`.

**Why it matters:** eden has already done the hard engineering work (HDBSCAN clustering) that competitors charge for as a distinct feature category, but customers cannot actually use it because there's no way to see it in the product — a pure UI-wiring gap sitting on top of otherwise-complete, differentiated functionality; it cannot be adopted, demoed, or credited in competitive positioning if a prospect can't click into it.

**Severity:** High
**Effort:** Medium
**Confidence:** High

---

### #91. Render fork lineage as a tree, not a flat list

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "What would make it more usable/adoptable" bullet 1 (citing `debugger-modes.tsx:750-763,1279-1300`; `resources.ts:3114,3128`).

**Description:** `forksQuery` renders "Forks for this trace" as a flat list showing `fork_id`, `fork_at_step`, and `last_replay_outcome`. But the API already accepts and returns `parent_fork_id` on both the `record` and `fork` endpoints, so fork-of-fork lineage exists server-side and simply isn't rendered. Fix: group the existing flat list by `parent_fork_id` into a nested tree view — "a small, high-leverage front-end fix" requiring no backend work.

**Why it matters:** Time Travel fork+replay is called out as "the strongest concrete realization in this whole matrix of a claimed differentiator" (counterfactual trace forking) — but a flat list hides the actual branching investigation structure (fork-of-fork chains) an engineer builds while debugging, undermining the tool's core value during exactly the workflow it's meant to support.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

---

### #92. Wire the GitHub write client into the issue fix-PR flow

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "Issue fix-PR UX is half-built, not missing" bullet (citing `lab/fixtures/issues.ts:33-34`, `integrations/github/oauth.py:558,581`); reinforced by the "Verdicts" section's "Issue lifecycle... RESCOPE" entry.

**Description:** The frontend's `IssueFixture` type already has a `patchBlockedReason`/`patchBlockedMessage` contract, presuming a working "attempt a fix PR, report why not" flow. But `IssuePromptEvolver.evolve_from_issue` only creates an internal prompt-version candidate — it never calls GitHub. Meanwhile `change_impact/preview.py` already has a working GitHub write client (`GitHubOAuthClient.create_check_run`/`.create_pr_comment`) used for pre-merge impact previews. Fix: wire that same GitHub client into the post-resolution issue fix-PR path so `/issues` can actually open a fix PR (or accurately report why it can't), populating the UI slot the frontend is already scaffolded for.

**Why it matters:** Every issue today effectively surfaces an unpopulated "blocked" state rather than a real success/failure signal, even though the underlying GitHub write infrastructure exists and works elsewhere in the product — characterized as "a wiring task, not a design task," making it a comparatively cheap fix for a highly visible gap in the failure-triage flow.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

## Medium

### #93 — Fix the `act_on_topic(action="alert")` no-op stub

**Source:** `01-competitor-matrix.md`, "Deep codebase re-pass" section (citing `service.py:230-231`).

**Description:** `topics/service.py`'s `act_on_topic` function has an `action="dataset"` branch that genuinely works (creates a dataset from a topic's representative traces via `DatasetHub`), but the `action="alert"` branch is a stub that returns `{"status": "queued"}` without doing anything. **Fix:** implement the alert-firing behavior, or remove the option from any UI that will eventually expose it, so the action doesn't silently do nothing while reporting success.

**Why it matters:** A user who selects "create alert from this topic" (once a portal surface exists per 01-4) would be told the alert was queued when nothing was actually created — a silent-failure pattern that erodes trust the moment the feature becomes reachable.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #94 — Frame GitHub write capability accurately: "wired to pre-merge preview, not to post-resolution fix delivery"

**Source:** `01-competitor-matrix.md`, "Verdicts" section, "Issue lifecycle... RESCOPE, sharpened" entry.

**Description:** Prior-pass framing that eden is "GitHub-blind" is corrected — `integrations/github/oauth.py` has working Check-Run/PR-comment methods, used by `change_impact/preview.py`. But the issue-resolution path specifically still does not open a fix PR (see #92). **Fix:** use the doc's recommended framing in any strategic/competitive material — "eden has GitHub write infrastructure; it is wired to pre-merge impact preview today, not to post-resolution fix delivery" — rather than either "GitHub-blind" or an unqualified "auto-fix PR" claim.

**Why it matters:** Both the overclaim and underclaim versions of this story are inaccurate; getting the framing right avoids both underselling a real capability and overselling one that doesn't exist yet for the issue-resolution use case specifically.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #95 — Cite Topics/drift/per-step-judges as "shipped, narrower than the named competitor feature," not flat differentiators

**Source:** `01-competitor-matrix.md`, "Verdicts" section, "New rows this pass... VERDICT: ADD, mixed maturity" entry.

**Description:** Three newly-found capabilities each carry a self-admitted maturity gap versus the competitor they're being compared to: Topics is thinner than Braintrust's Topics (derived from existing pattern-clustering rather than an independent per-trace LLM classification pass); drift detection uses a hash-bucket proxy instead of a learned embedding model for the embedding-drift axis (self-admitted in the module docstring); per-step judges (`apm_depth/step_judges.py`) is "stamping only" — the automatic per-step `JudgeRunner` scoring loop that would populate scores is an unbuilt follow-up. **Fix:** use the doc's recommended framing — "shipped, narrower than the named competitor feature" — for these three specifically, rather than listing them as unqualified differentiators in the matrix or in sales material.

**Why it matters:** Prevents overclaiming parity with Braintrust/Phoenix/Datadog/HoneyHive on capabilities that are real but materially incomplete versus the named comparison — protects credibility if a prospect or competitor does a detailed technical comparison.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #96 — Extend `ReplayResult` to carry the actual regenerated output text

**Source:** `02-evals-datasets.md`, §5 P1 item 8 (citing `improvement/replay_verify.py:275-281`; `regression_runner.py:257-280,296-340,282-294`).

**Description:** When `regression_replay_v1` is enabled and a case carries a stored `FailureSignature` + checkpoint reference, `RegressionRunner` replays the original failing step against current behavior (cost-capped) before falling back to a post-hoc check — real, budget-capped verification infrastructure. But `ReplayResult` returns only `status: "passed"|"failed"|"skipped"` + `reason` + `cost_usd` + `traces_checked` — no raw regenerated output text. **Fix:** add a `regenerated_output: str | None` field to `ReplayResult`.

**Why it matters:** Without this field, the replay path cannot feed `playground/scorers.py`'s `run_scorers(output=...)`, meaning the replay-verification subsystem can't participate in #130's unified per-case scoring — a small, sequenced prerequisite.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #97 — Delete `golden_dataset.py`, `ci_pipeline.py`, and `auto_dataset.py`/`EvalScheduler` as dead/duplicate code

**Source:** `02-evals-datasets.md`, §5 P2 item 10, §3d/3e/3f (citing `golden_dataset.py` 1,295 lines; `ci_pipeline.py`; `auto_dataset.py` 475 lines + `evaluation/scheduler.py`).

**Description:** Three subsystems are confirmed dead or duplicate: (a) `golden_dataset.py` — a disk-based (`./golden_datasets/*.json`), non-multitenant, hardcoded 50-case registry referencing no real customer agent/trace/org; (b) `ci_pipeline.py` — a 6-stage pipeline that shells out via `subprocess`, not mounted to any route, referenced only by its own unit test, and duplicates `ci_webhook.py`'s live path with a fake `benchmark_regression` stage that defaults to `SKIPPED: execution_unavailable` with a `random.Random(case_id)`-seeded fallback; (c) `auto_dataset.py` + `EvalScheduler` — a real multi-factor quality-scoring design that persists to local disk JSON and writes into `golden_dataset.py`'s in-memory registry rather than Postgres, and is never actually invoked on a schedule (absent from both `workers/main.py` and `workers/cron_tick.py`). **Fix:** if the 50 generic RL-sandbox cases in `golden_dataset.py` have standalone smoke-test value, port `_CANONICAL_CASES` into a handful of seed `dataset_items` rows via a one-time script, then delete all three modules.

**Why it matters:** Every week this dead code remains in the tree is a week a due-diligence reviewer (fundraising, acquisition, audit) can mistake it for real functionality — the doc explicitly flags this as a liability, not neutral dead weight, and recommends not deprioritizing it despite low direct user impact.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #98 — Add an index + bounded backfill migration for the new agent-linkage columns

**Source:** `05-multiagent-tracing.md` (proposing migration `143_agent_link_columns_backfill.py`).

**Description:** No new `ALTER TABLE` is needed (058/067 already added the columns) — only indexing/backfill. Add `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_telemetry_events_tenant_operation_name_agent ON telemetry_events (tenant_id, operation_name, agent_id) WHERE operation_name IN ('invoke_agent','create_agent')` to support "list agent-invocation spans for tenant X" queries the new portal panel needs, plus a bounded backfill (`UPDATE ... SET operation_name = 'unknown' WHERE operation_name IS NULL AND created_at > now() - interval '30 days' AND event_type = 'tool.call'`). Downgrade must drop only the new index — must NOT touch `finish_reason` (see #99). Note: verify the next migration number by hand since the doc flags an existing undetected numbering collision (two distinct `135_*` files).

**Why it matters:** Without the index, the new "list agent-invocation spans" query pattern would be slow/unindexed; the backfill gives recently-ingested rows a non-null default before the write-path fix takes effect going forward.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #99 — Fix migration 067's `downgrade()` incorrectly dropping the pre-existing `finish_reason` column

**Source:** `05-multiagent-tracing.md` (citing `067_trace_quality_otel_columns.py:140,93`; `011_capture_full_payloads.py:63`).

**Description:** Migration 067's `downgrade()` runs `DROP COLUMN IF EXISTS finish_reason` — but `finish_reason` wasn't added by 067; it was added earlier by migration 011 (`VARCHAR(64)`) and is already actively written by `TELEMETRY_INSERT_SQL`. 067's own `ADD COLUMN IF NOT EXISTS finish_reason VARCHAR(32)` was a silent no-op against the pre-existing column. **Fix:** remove the `DROP COLUMN IF EXISTS finish_reason` line from 067's `downgrade()`.

**Why it matters:** A downgrade of migration 067 today would destroy live `finish_reason` data that 067 never owned — a real data-loss risk on any future rollback, currently undetected because no one has run the downgrade.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #100 — Add `"agent"`/`"handoff"` kinds to `TranscriptKind` enum and `_step_kind` mapping

**Source:** `05-multiagent-tracing.md` (citing `TranscriptKind` in `portal_contracts.py:21`; `_step_kind` in `portal.py:444`).

**Description:** `TranscriptKind = Literal["task", "llm", "tool", "bash", "span"]` has no `"agent"` or `"handoff"` kind. Even once `operation_name` is wired end-to-end, an `invoke_agent`-kind span would still render as an undifferentiated generic `"span"` unless this enum and `_step_kind`'s mapping logic are extended.

**Why it matters:** Without a distinct visual/semantic vocabulary for agent boundaries and handoffs, correctly-populated backend data still renders indistinguishably from any other span, defeating the purpose of the upstream write-path fixes.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #101 — Populate `fingerprint`/`issue_id` on EQL-triage alert payloads to enable duplicate suppression

**Source:** `04-alerting-oncall.md`, §0.5 bullet 3, "Noise control" (citing `dsl/alerts.py:522-529`; `triage_judge.py:76-104`).

**Description:** `_trigger_triage`'s payload never sets `fingerprint` or `issue_id`, so `AlertTriageJudge._find_duplicate_issue` — keyed on exactly those fields — can structurally never return a match for an EQL-sourced alert. Every re-fire of the same still-broken metric is a fresh `real_incident` email, rate-limited only by a blunt Redis SETNX + hourly cap, not by "is this the same incident as an hour ago." **Fix:** populate `fingerprint`/`issue_id` on the triage payload.

**Why it matters:** Without this, the one working alert pipeline will spam admins with a fresh email on every tick a still-broken condition is evaluated — a direct driver of alert fatigue and distrust.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #102 — Fix hardcoded `severity="warn"` display and missing severity storage on `nl_alert_rules`

**Source:** `04-alerting-oncall.md`, "User Experience & Value" (citing `portal.py:2119`; `nl_alert_rules` table).

**Description:** The portal's rule card always displays `severity="warn"` regardless of what the user actually configured, because `nl_alert_rules` itself doesn't persist a severity field — only the separate, bridged `eql_alert_rules` row does. **Fix:** persist configured severity on `nl_alert_rules` (or read/display from the bridged row) so the UI shows the real severity.

**Why it matters:** A user has no way to see, from the UI, what severity their rule was actually registered at — compounding a related bug, since a user can't even tell from the display that their "critical" rule silently stopped firing.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #103 — Render the user's own natural-language rule text instead of raw compiled EQL in the alert payload/Inbox pane

**Source:** `04-alerting-oncall.md`, "User Experience & Value" (citing `dsl/alerts.py:522-529`; `portal.py:2118`; `alerts-panel.tsx:299-309`; `nl_alert_rules.nl_text`).

**Description:** When an alert fires, the Inbox detail pane's "Condition" field renders generated SQL/EQL (`compiled_eql`) in monospace, not the plain-English sentence the user typed when creating the rule. **Fix:** surface `nl_alert_rules.nl_text` in the fired-alert payload and Inbox detail pane, alongside or instead of the raw compiled query.

**Why it matters:** The thing a rule author sees when their alert fires is not their own words — undermining the "explain what I'm about to alert on" UX the authoring flow otherwise achieves.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #104 — Rename "escalate"/"page operator" copy that overstates real behavior

**Source:** `04-alerting-oncall.md`, §4 (citing `_PLAYBOOK_ACTIONS` in `playbook_router.py`; UI strings from `alert_stream.py`'s rule channels).

**Description:** Copy such as "page operator" implies real paging/escalation behavior that doesn't exist. **Fix:** audit and rename this copy to accurately reflect actual behavior (e.g., "notify via Slack/email" rather than "page").

**Why it matters:** Inaccurate internal/UI copy compounds customer-facing trust risk — even engineers reading logs or playbook definitions could be misled about what actually happens on escalation.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #105 — Do not build on-call scheduling, rotations, ack/snooze, or SLA-timer features in-house (explicit scope decision)

**Source:** `04-alerting-oncall.md`, §3 fix item 9, §4, §2 (citing `escalation_delay_seconds`/`auto_escalate` inert dataclass fields in `alert_stream.py`; Better Stack's `wait_before`/`repeat_count`/`step_members` schema as the mature reference).

**Description:** The doc explicitly recommends against building schedules, rotations, acknowledgment/snooze UI, or SLA escalation timers in-house, since incident.io, Better Stack, and Datadog On-Call already own this space with mature primitives eden only has as inert, unused dataclass fields. **Action:** adopt this as an explicit engineering scope guardrail — integrate with a real on-call tool for this functionality rather than building it, and deprioritize any related in-flight or proposed work.

**Why it matters:** Without an explicit scope decision, there's a real risk of eng effort being spent replicating a mature, commoditized on-call feature set instead of on the actual blockers to a working, trustworthy core alerting product.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #106 — Add a team-scoped soft-alert email recipient list independent of `org_members`

**Source:** `06-cost-governance.md`, "Who is the user," §4a Recommendation 2 (citing `alert_email.py`'s `_org_alert_recipients()`).

**Description:** Budget alert emails are resolved exclusively via a query joining `users`/`org_members` filtered to `role IN ('owner','admin')` — structurally incapable of routing to anyone not already an org member. There is no "finance," "billing," or "budget admin" role anywhere in the budget path (LiteLLM's team soft-budget alerts explicitly route to "finance or a team lead — not necessarily team members"). **Fix:** add a soft-alert recipient list attachable to a team/org budget, independent of `org_members` role membership, as a small additive change to `_notify_budget_alert()` — doesn't require the full scope migration to land first if sequenced as an org-level feature initially.

**Why it matters:** Eden's implicit persona is a founder/eng-lead who *is* the org owner — reasonable for eden's current size but the opposite of where the competitor set has moved (dedicated finance/FinOps stakeholders watching spend across teams they don't administer).

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #107 — Fix the synthetic $0.02 triage cost event that leaks into customer-facing budget consumption

**Source:** `06-cost-governance.md`, §2e (citing `issues/triage_agent.py:36`; `closed_loop/autonomy_policy.py:360-376`; `cost_ledger.py:279`).

**Description:** `issues/triage_agent.py`'s call chain (`autonomy_policy.record_spend()` → `record_cost_event()`) unconditionally writes a synthetic, flat `$0.02` `CostEvent` (`_TRIAGE_COST_ESTIMATE_USD`) for every LLM-used triage. This lands in `customer_cost_events`, the same table `_sum_org_cost_usd()` sums into `get_budget_status()` — i.e., the number `QuotaEnforcementMiddleware` reads to block a customer's own gateway requests. **Fix:** replace the flat synthetic estimate with the real cost, or exclude internal triage cost events from the customer-facing aggregation entirely.

**Why it matters:** A concrete, live counter-example to the assumption that eden's internal cost-tracking is fully isolated from customer-facing numbers — nudges the real customer credit-consumption figure upward by the fake-vs-real delta on every triage call. Blast radius is small (well under $1/org/day per estimate) but it's a genuine, live correctness bug in the number that gates a customer's own requests.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #108 — Fix or drop the dead Redis RTBF key-pattern match

**Source:** `07-security-compliance.md`, §2b fanout table, §4 point 4 (citing `rtbf_fanout.py:77-108`).

**Description:** Redis RTBF fanout runs `SCAN eden:*:{org}:*:{user}*` then `DEL`, but no key pattern anywhere in `src/eden/` actually embeds a user id (patterns are org- or hash-keyed only, e.g. `eden:cost:{org}:...`, `eden:dedup:{digest}`). SCAN matches nothing, reports `deleted: 0`, and the fanout falsely reports `status: "ok"`. **Fix:** either update the actual Redis key-naming scheme to embed user id where user-scoped erasure is meaningful, or change the fanout to report `status: "unsupported"`/`"n/a"` honestly rather than a false "ok" — the doc notes actual PII risk here is lower (mostly cost/dedup caches) but the false-positive report itself is still a bug.

**Why it matters:** A false "ok" report undermines the credibility of the entire RTBF fanout's per-store reporting model, even though the underlying data-risk is comparatively low for this specific store — fixing the report contract matters for auditability independent of the low current risk.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #109 — Report RTBF fanout status per-store in the UI, not as a single checkmark

**Source:** `07-security-compliance.md`, §8 "What would make this trustworthy and usable" bullet 2.

**Description:** `rtbf_fanout.py`'s existing pattern for Qdrant/S3 (explicit `status: "failed"`/`"unsupported"` rather than silent success) is correct and should become the UI contract too. **Fix:** once a single erasure path ships a UI element, render the actual per-store status list — e.g. "Postgres: erased. Qdrant: failed (no per-user index). Typesense: not yet supported" — rather than a single green checkmark.

**Why it matters:** A single aggregate "success" checkmark for an operation with known partial-failure modes across 6 different stores would be actively misleading to both end users and auditors; per-store honesty is cheap once the fanout already computes this data internally.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #110 — Surface `AgentAuditLedgerWriter.verify_chain` tamper-evidence as a visible trust signal

**Source:** `07-security-compliance.md`, §7, §8 "What would make this trustworthy and usable" bullet 4 (citing `governance/compliance_pack.py`; `tests/unit/ws4/test_enterprise_ws4.py:70-124`).

**Description:** `AgentAuditLedgerWriter` maintains an append-only, SHA-256 hash-chained ledger; `verify_chain()` recomputes the chain and reports `ok_rows`/`broken_rows` — genuine tamper-evidence, tested for empty/valid/deliberately-tampered chains. Today it's invisible to any user. **Fix:** surface a "chain verified: ✓" indicator next to any exported compliance pack or audit view in the portal, backed by a live call to `verify_chain()`.

**Why it matters:** This is a genuinely strong, already-built answer to "how do we know this evidence wasn't edited after the fact" — exactly the question a SOC2 auditor or enterprise security reviewer asks — but currently exists only as backend plumbing with zero product-visible trust value.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #111 — Add end-to-end/route-level tests for `compliance_pack.py`'s FastAPI routes

**Source:** `07-security-compliance.md`, §7 (citing `governance/compliance_pack.py`, `api/routes/compliance_pack.py`; `config.py:1451`).

**Description:** `compliance_pack_export_v1` defaults `True` (live in production configuration by default), and its three routes (`verify`, `ledger`, `agents/{agent_id}/export`) are mounted at `/orgs/{org_id}/compliance`. But only the underlying `AgentAuditLedgerWriter.verify_chain()` has unit tests — nothing tests `generate_agent_pack` or the FastAPI routes themselves end to end. **Fix:** add route-level/integration tests exercising all three mounted endpoints, since this is enabled-by-default production surface with no regression safety net today.

**Why it matters:** A capability that's on by default in production with zero end-to-end test coverage is a silent regression risk — a break here wouldn't be caught by any existing test, and would surface first as a live production incident against a compliance-sensitive endpoint.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #112 — Add missing `resources.ts` API bindings (pop, IAA, export)

**Source:** `08-annotation-labeling.md`, §2, §6b (citing `resources.ts:3360-3386,4069-4116`).

**Description:** `labelingApi` covers only 4 of 8 Phase-D routes. Three routes have no client binding at all: `GET /labeling/queue/{user_id}` (pop), `GET /labeling/iia` (org/global IAA), and `GET /labeling/export`. **Fix:** add `popQueue`, `getIAA` (using the post-consolidation `/labeling/agreement` path), and `exportJsonl` functions to `labelingApi`.

**Why it matters:** Without these bindings, roughly half the usable Phase-D backend surface is unreachable from the frontend, blocking the pop-based work surface, IAA dashboard, and export button.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #113 — Implement prefetch/batch-buffer for `pop()` in the annotate UI

**Source:** `08-annotation-labeling.md`, §6c.3 (citing `labeling.py:392-411`).

**Description:** Call `popQueue(limit=5)` (already supports batch prefetch) once, hold 4 items in a client-side buffer, and only re-call when the buffer runs low — rather than popping one item per submit and waiting on the round-trip.

**Why it matters:** Popping one item per submit would reintroduce exactly the latency a keyboard-driven flow is supposed to eliminate — required to hit the "fast" UX bar.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #114 — Add undo shortcut (`u`/`Backspace`) for last annotation submission

**Source:** `08-annotation-labeling.md`, §6c.3, §5a.

**Description:** Add a keyboard shortcut to undo the last submission by re-submitting the previous `item_id` with the previous label — no new backend capability needed since `annotate()` is already an UPSERT keyed on `(item, annotator)`.

**Why it matters:** Called out as a "free win" — costs almost nothing given the existing UPSERT semantics, but materially improves reviewer trust/speed since mis-clicks are common in rapid keyboard-driven labeling.

**Severity:** Medium (normalized from "Low-Medium" in source doc).
**Effort:** Small.
**Confidence:** High.

---

### #115 — Add "Annotate" action button to trace detail page

**Source:** `08-annotation-labeling.md`, §6c.5, §7 item 2, §6d (citing `api.annotateTrace()` in `resources.ts:1878-1892`).

**Description:** Add an "Annotate" action on the trace detail page calling the already-existing `api.annotateTrace()` binding.

**Why it matters:** Explicitly called out as the "cheapest single win, all pieces already exist" and the doc's recommended first shipping item.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #116 — Add JSONL export button to labeling UI

**Source:** `08-annotation-labeling.md`, §6c.6 (citing `labeling.py:816-861`).

**Description:** Add a button hitting the `exportJsonl()` binding (see #112) to emit JSONL of completed labels.

**Why it matters:** Enables the "ML engineer building eval sets" persona to pull labeled items to seed golden datasets or fine-tune an LLM-judge without needing an engineer to run a script.

**Severity:** Medium (normalized from "Low-Medium" in source doc).
**Effort:** Small.
**Confidence:** High.

---

### #117 — Add bulk-skip capability to the queue list

**Source:** `08-annotation-labeling.md`, §6c.1(b) (citing `labeling.py:602-632`).

**Description:** `skip()` is single-item only today. **Fix:** ship either a small `POST /labeling/skip/bulk` backend endpoint or a client-side fan-out of N `skip()` calls, paired with multi-select in the queue-list UI.

**Why it matters:** A meaningful fraction of any queue is "obviously skip" and doesn't need one-at-a-time handling; without bulk actions this directly hurts the "reviewer never touches the mouse except to read" speed bar the doc sets as the UX target.

**Severity:** Medium.
**Effort:** Small-Medium.
**Confidence:** High.

---

### #118 — Surface per-item disagreement signal in the annotate view

**Source:** `08-annotation-labeling.md`, §6c.3, §4.

**Description:** Following Braintrust's pattern (not LangSmith's) since `annotate()` has no blind-review gate: surface "N annotations so far / agreement so far" on items with 1+ annotation, using `IAAReport.per_item[item_id]`, so a second annotator sees they're the tiebreaker without seeing the specific first label.

**Why it matters:** Gives reviewers disagreement context in-flow instead of requiring a separate dashboard check — a deliberate middle ground between LangSmith's blind independence and Braintrust's always-visible model.

**Severity:** Medium.
**Effort:** Small-Medium.
**Confidence:** High.

---

### #119 — Add "needs another reviewer" filter + manual escalate button to IAA dashboard

**Source:** `08-annotation-labeling.md`, §6c.4, §4, Phase 3 Verdict 6.

**Description:** Add a filter for items where `per_item[id].agreement < threshold` and `annotation_count < annotations_required` (Label Studio's auto-reassignment candidates). Add a manual "escalate" button that bumps `annotations_required` by 1 and re-surfaces the item in `pop()`. Explicitly scoped as a manual UI affordance, not a new automated escalation engine — eden already has every backend piece needed except the threshold check and the bump itself.

**Why it matters:** The one genuinely automated disagreement-resolution mechanism found across all three competitor platforms researched; the lightweight manual version captures most of that value without building a full automated escalation engine.

**Severity:** Medium.
**Effort:** Small-Medium.
**Confidence:** High.

---

### #120 — Document `agent_id`/`agentId` in both SDK READMEs

**Source:** `09-sdk-dx.md` — SDK config/wiring section.

**Description:** `agent_id` (Python) and `agentId` (TS) are already fully plumbed end-to-end through both SDKs and the ingestion path, but the field is optional and undocumented in either SDK's README/quickstart. Users have no way to discover that setting it enables per-agent breakdowns downstream (session analytics, issue extraction, etc. all key off it where populated). **Fix:** add a short README section in `sdk/python` and `sdk/ts-ai` showing how to set it and what it unlocks.

**Why it matters:** Silent, already-built functionality that goes unused because nobody knows it exists is wasted engineering investment; every downstream feature that could segment by agent stays flat/unsegmented in practice.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #121 — Rename or fix `detect-installed.ts`'s `autoInstrument()` alias

**Source:** `09-sdk-dx.md` — TS auto-instrumentation internals.

**Description:** The TS SDK exposes a function named `autoInstrument()` inside `detect-installed.ts` that is actually detection-only — it does not instrument anything, contrary to what its name promises. Callers reading the API surface will reasonably assume calling it wires up instrumentation, when it doesn't. **Fix:** either rename the function to something like `detectInstalledFrameworks()` or `listCandidates()`, or make it actually perform auto-instrumentation.

**Why it matters:** Misleadingly-named public API surface causes silent integration failures (users think instrumentation is active when it isn't), producing empty/incomplete trace data downstream with no error signal.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #122 — Wire `droppedTotal`/`sampledOut` into TS `doctor.ts` output

**Source:** `09-sdk-dx.md` — TS diagnostics/doctor tooling section.

**Description:** The TS SDK already tracks `droppedTotal` and `sampledOut` counters internally, but `doctor.ts` (the SDK's self-diagnostic CLI/utility) does not read or surface them. A user running the doctor tool to debug "why don't I see my traces" gets no visibility into drop/sampling behavior even though the data already exists in memory.

**Why it matters:** This is a support-cost and self-serve-debugging gap: users hit a wall the doctor tool could resolve for free, and instead file support tickets or churn.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #123 — Add a `.sent`/`.failed`-equivalent counter to the TS SDK

**Source:** `09-sdk-dx.md` — TS SDK observability of the SDK itself.

**Description:** The TS SDK has no equivalent of a `.sent`/`.failed` counter pair (implied contrast with Python, which does track this class of metric). Without it, TS users cannot programmatically or via `doctor.ts` determine how many spans/events were successfully sent vs. failed to send.

**Why it matters:** Same class of self-serve debuggability gap as #122 — without send/fail counts, diagnosing "my traces aren't showing up" requires either trusting a black box or filing a support ticket.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #124 — Keep `/gateway/v1` honest as a single-upstream pass-through — do not rebuild routing on top of it

**Source:** `10-model-gateway.md` — `/gateway/v1` assessment section.

**Description:** `/gateway/v1` is real and working today, but only as a single-upstream pass-through (not a multi-provider router). The recommendation is explicit: keep it scoped to what it actually does rather than layering `AIGateway`-style routing ambitions onto it. Any product copy or roadmap language implying `/gateway/v1` does multi-provider routing/failover should be corrected to match reality.

**Why it matters:** Prevents scope creep into a market segment (routing/failover-as-a-service) eden has already decided not to compete in (see #137), and prevents customer-facing overpromising about what the endpoint does.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #125 — Fix the frontend/backend enum mismatch on the guardrails policy-list page

**Source:** `12-runtime-guardrails.md` — portal bugs section, enum mismatch.

**Description:** Separately from a related envelope-unwrap bug on the same page, there is also a mismatch between frontend and backend enum values (e.g., policy status/type enums defined differently or drifted out of sync on each side). This likely causes incorrect labels, filters, or dropdown options to be shown, or silent failures when the frontend sends a value the backend doesn't recognize. **Fix:** audit both enum definitions and unify them (ideally via a single shared schema/generated types).

**Why it matters:** Enum drift between frontend and backend causes subtle, hard-to-diagnose UI bugs (wrong labels, broken filters, rejected requests) specifically on the page administrators use to manage safety policy.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #126 — Prioritize this doc's fixes ahead of new guardrail feature work

**Source:** `12-runtime-guardrails.md` — overall framing as possibly the #1 highest-priority finding of the review.

**Description:** The doc itself flags this area as potentially the single highest-priority finding across the entire 3-pass strategic review. This is a sequencing/prioritization action rather than a code fix: any roadmap planning that includes new guardrail features (new detector categories, new policy types, etc.) should be sequenced after the doc's guardrail items are resolved, not in parallel with them.

**Why it matters:** Building new features on top of a foundation with a silent safety-check bypass compounds risk and technical debt; the doc's own framing suggests this should override normal feature-prioritization processes.

**Severity:** Medium (recalibrated from Critical during cross-doc ranking — treated as a process/sequencing recommendation for this consolidated list rather than a standalone code defect).
**Effort:** Small.
**Confidence:** High — the "possibly #1 priority" framing is explicitly stated in the source doc itself, not inferred.

---

### #127 — Implement `action=alert` beyond its current stub

**Source:** `14-user-request-mining.md` — User Experience & Value section, `action=alert` stub.

**Description:** There is an `action=alert` option/parameter in the topic-mining feature that is currently just a stub — it doesn't actually send an alert when invoked. **Fix:** implement real alerting behavior (e.g., notification via whatever eden's existing alerting/notification channel is) behind this action.

**Why it matters:** A stubbed alert action gives the false impression that proactive notification exists for emerging topics/requests when it doesn't — anyone configuring or relying on `action=alert` gets silently no alerts.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #128 — Create the `agent_artifact_context` table per the source's exact SQL

**Source:** `15-artifacts-behavior-record.md` — schema section (exact SQL provided in source).

**Description:** The source doc provides exact SQL for a new `agent_artifact_context` table, presumably intended as the schema backing for the team-uploaded-context feature (#148) and/or richer per-agent artifact scoping. **Fix:** create this table per the provided SQL as a foundational step for #148 and related work.

**Why it matters:** Having ready-made schema SQL substantially lowers the effort bar for #148 and any related per-agent-context work — concrete, reviewable starting point rather than a design-from-scratch task.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

---

### #129 — Sequence issue-ranking/severity-escalation work after doc 13's P0-A/P0-B (Loop 1 revival)

**Source:** `16-issue-extraction-online-evals.md` — explicit build-sequence dependency on `13-continuous-improvement-loop.md`.

**Description:** The source doc explicitly states its recommended build sequence depends on `13-continuous-improvement-loop.md`'s P0-A and P0-B steps being completed first. This is a sequencing constraint, not a standalone code fix: teams should not implement composite issue ranking or, especially, severity escalation (which likely needs to consume the confirm/dismiss signal Loop 1 produces) before those prerequisite steps land.

**Why it matters:** Implementing ranking/escalation logic ahead of its prerequisite data pipeline being functional risks either building against incomplete/wrong data, or having to rework the logic once Loop 1 actually starts producing real confirm/dismiss signal data.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High — the dependency itself is explicitly stated in the source doc.

---

### #130 — Surface per-case (not just aggregate) F51 grading verdicts in the CI score table

**Source:** `02-evals-datasets.md`, §5 P1 items 6-7 (citing `ci_webhook.py:16,59-62,73-81`; `regression_runner.py:182-243,150-180`).

**Description:** `ci_webhook.py` already imports and reuses `grade_datapoint` from `experiments/compare.py` — the same grading function that powers F51 — to grade aggregate pass/fail/skip/error-rate deltas against a baseline run (`build_score_table`), but only at the suite-summary level, never per-case. **Fix:** keep `RegressionRunner`'s existing stumble-signature/StatGate check (`_evaluate_case`) as-is for the cheap, no-LLM-call canary-gate path (do not replace it), but additionally have `run_suite` kick off (or reuse) an F51 run against the same org/agent's now-unified dataset, and surface its `grade_datapoint` verdicts in `ci_webhook.py`'s `score_table` per case, not just in aggregate.

**Why it matters:** Turns an existing, working, but aggregate-only bridge into a full Braintrust-style per-row diff eden is currently missing, without inventing new plumbing — closes a real gap against competitor CI-gating UX.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #131 — Build an LLM-judge adapter to wire `llmops/judges/UnifiedJudge` into F49/F51's scorer path

**Source:** `02-evals-datasets.md`, §5 P2 item 12, §3k (citing `llmops/judges/base.py:109-119`, `unified.py`, `runner.py:51-102`).

**Description:** `playground/scorers.py` (F49) deliberately omits an `llm_judge` scorer ("a fake judge is worse than none"). Eden already has production-grade LLM-judge infrastructure: `UnifiedJudge` (`unified.py`, 225 lines) scores every axis in one LLM call, and `JudgeRunner.run_for_event` fans out judges concurrently with per-tenant semaphore and cost/cache-tracked persistence to `judge_scores`. The integration cost: `Judge.score(event: TelemetryEvent, ctx: JudgeContext)` is contractually bound to a `TelemetryEvent`, not a generic `(input, output, expected)` triple, so wiring it into dataset-row scoring needs either (a) a small adapter wrapping a `dataset_item` row in a `TelemetryEvent`-shaped object, or (b) calling `UnifiedJudge.score()` directly and discarding axes F49/F51 don't need per row. There is no single-axis judge left to extract cleanly (per-axis judges like `hallucination.py`/`correctness.py` were consolidated into `UnifiedJudge` and no longer exist as separate files), so a prior recommendation to "extract one judge's prompt template" no longer applies.

**Why it matters:** Reuses eden's most production-grade judge infrastructure (concurrency, cost tracking, persistence) rather than building parallel judge logic or misusing `prompt_versioning._llm_score` (which is a prompt-text linter, not a case-scoring judge) — closes the gap against competitors' LLM-judge-based dataset scoring.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #132 — Build a first-class "attach dataset" flow (Dataset Hub / F53 integration) in the playground editor

**Source:** `03-prompt-playground.md`, "User Experience & Value → Where the workflow breaks down"; citing `service.py:298-300`.

**Description:** `PlaygroundService.run` defaults to a single synthetic dataset row (`{"id": "adhoc", "input": params.get("user", "")}`) when no `dataset_rows` are supplied. There is no UI-driven pull from Dataset Hub (F53) — systematic regression testing across a labeled dataset currently requires the caller to assemble `dataset_rows` by hand or via direct API calls, not through a first-class "attach dataset" flow in the editor. This is a gap against the editor's own empty-state copy, which promises "attach a dataset to compare prompts before you ship." **Fix:** build an in-editor UI flow to browse/select/attach a Dataset Hub dataset as the `dataset_rows` source for a playground run.

**Why it matters:** Without this, "systematic" prompt regression testing (vs. ad hoc single-row testing) is only accessible to users willing to hand-craft API calls, which excludes most of the target user base (prompt engineers/product devs working in the portal UI) and directly contradicts what the editor's own empty-state copy already promises them.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #133 — Add edit/delete/toggle (lifecycle management) to the Automations engine

**Source:** `04-alerting-oncall.md`, §1 (citing `automations/engine.py`; `api/routes/wave6_online.py:209,217`; `resources.ts:4419-4434`).

**Description:** The Automations engine is create-only — no `update`, `delete`, or `toggle` method exists anywhere in the class. **Fix:** add update/delete/toggle endpoints and engine methods, plus corresponding UI controls.

**Why it matters:** A customer who saves an automation with a typo'd Slack channel or a dead webhook URL cannot fix it once saved — it can only be orphaned, not corrected.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #134 — Add a suppression-rule UI/API (dedup windows / "don't page for known-noisy events")

**Source:** `04-alerting-oncall.md`, "User Experience & Value → Noise control" (citing `AlertTriageJudge.judge`, four hardcoded regexes).

**Description:** Beyond the structural dedup bug (#101), there is no UI or API for a customer to add their own suppression rule (e.g., "our Tuesday batch job always spikes latency, don't page for it") — that requires a code change today. **Fix:** build a suppression-rule config surface (UI + API) on top of the triage judge.

**Why it matters:** Without user-configurable suppression, known-noisy/benign recurring conditions will keep generating fresh incident emails indefinitely — a direct driver of alert fatigue.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #135 — Fix or consolidate the Detectors tab's disconnected NL alert-creation flow

**Source:** `04-alerting-oncall.md`, "User Experience & Value," flow #1 of three incompatible flows (citing `signals-client.tsx`, `CreateSignalDialog`).

**Description:** The Detectors tab's NL prompt is a third, separate "create a rule" flow using a completely different backend (an OpenRouter-backed Next.js route) than the working NL-alert pipeline, and produces a draft with no notification-destination field of any kind (grep for channel/slack/pagerduty/webhook/destination returns zero hits). **Fix:** either wire this flow into the working `AlertCompiler`/`nl_alert_rules` pipeline or deprecate it in favor of the unified authoring surface.

**Why it matters:** A prospective customer testing "can I tell eden to alert me on X" hits a free-text box that doesn't route anywhere at all.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #136 — Add concurrency/race-condition test coverage for `pop()`

**Source:** `08-annotation-labeling.md`, §1 (citing `tests/unit/evaluation/test_labeling.py`, 676 lines/39 tests; `test_labeling_queues.py`, 15 lines/1 test).

**Description:** The test suite has zero tests that call `pop()` twice concurrently or simulate a lease race (no `asyncio.gather`, no multi-annotator contention test). **Fix:** add tests exercising concurrent `pop()` calls, lease contention, and related fail-open/rowcount gaps.

**Why it matters:** The doc identifies real concurrency bugs in `pop()` that this missing coverage would have caught; without tests, regressions in the lease/claim path will ship silently.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #137 — Delete the dormant `AIGateway` multi-provider routing engine

**Source:** `10-model-gateway.md` — `AIGateway` assessment section (~900 lines of code).

**Description:** `AIGateway` is a fully-built, ~900-line multi-provider routing/failover engine that is dormant — not wired into any live production path that actually benefits from its routing logic. The doc's verdict is DELETE: the class should be removed rather than resurrected, because the market for hosted LLM gateway/routing (Portkey — acquired by Palo Alto Networks, OpenRouter at ~$1.3B valuation, LiteLLM) is already well-served by dedicated players, and eden reinventing this is not a differentiated bet.

**Why it matters:** ~900 lines of dead, unmaintained code create ongoing maintenance drag, confuse engineers who encounter it (it has live callers that silently break — see #67), and represent sunk effort better redirected elsewhere.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #138 — Extend `ProviderRoutingService` ingestion decoders rather than replacing the service's role

**Source:** `10-model-gateway.md` — `ProviderRoutingService` assessment section.

**Description:** `ProviderRoutingService`'s correct role per the doc's verdict is observe-not-replace: it should continue decoding/ingesting routing decisions made by external tools (e.g., customers' own LiteLLM/Portkey deployments) rather than becoming eden's own routing decision-maker. The concrete action is to extend its ingestion decoders (parsing more providers'/routers' trace formats) rather than building decision logic into it.

**Why it matters:** Keeps eden positioned as an observability layer over whatever routing tool a customer already uses, which is the differentiated, lower-competition role versus trying to out-build dedicated routing vendors.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #139 — Add a `RetentionCurveChart` component to the portal

**Source:** `11-session-analytics.md` — User Experience & Value section (component sketch provided in source).

**Description:** The doc includes a full sketch for a `RetentionCurveChart` React component that does not currently exist in the portal. This would visualize retention curves (e.g., session-over-time cohort retention) once the underlying data is fixed. **Fix:** implement the component per the doc's sketch and wire it to corrected `session_summaries`-backed cohort data.

**Why it matters:** Retention curves are a standard, high-value analytics visualization that's currently entirely absent from the portal despite the backend groundwork (once fixed) supporting it — closes a visible feature gap for any product-analytics-minded customer.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #140 — Add a demote path to the working (undocumented) `EvalToGuardrailLink`

**Source:** `12-runtime-guardrails.md` — dual-implementation section (demote-path gap specifically).

**Description:** Called out separately because it's independently actionable even before the two class implementations are reconciled: the production-active `EvalToGuardrailLink` implementation has no mechanism to demote/reverse a guardrail escalation it made. **Fix:** add a demote/reversal method mirroring whatever promotion mechanism currently exists.

**Why it matters:** Without a demote path, any false-positive or since-resolved guardrail escalation made through this link is stuck, requiring manual DB intervention to undo — an operational burden and a risk of guardrails becoming stale/overly restrictive over time with no self-correction.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #141 — Make topic clustering run on a background schedule, not on-demand only

**Source:** `14-user-request-mining.md` — User Experience & Value section, scheduling gap.

**Description:** `patterns_clusterer.py`'s own docstring claims background-job scheduling, but in actual current behavior it only runs on-demand — the claimed scheduled/background execution doesn't happen. **Fix:** either implement actual background scheduling (e.g., periodic job via whatever eden's existing job/cron infrastructure is) to match the docstring's claim, or correct the docstring if on-demand-only is the intended final behavior.

**Why it matters:** A discovery feature like topic/pattern clustering is far more valuable running continuously in the background (so new emergent topics surface automatically) than requiring someone to remember to trigger it manually — the current gap between documented and actual behavior suggests this was an unfinished implementation, not an intentional design choice.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #142 — Add trending detection to topic clustering output

**Source:** `14-user-request-mining.md` — User Experience & Value section, missing capabilities list.

**Description:** The current F65 clustering output has no concept of "trending" (i.e., which topics/clusters are growing in volume/frequency recently vs. historically flat or declining). **Fix:** add a trend computation (e.g., comparing recent-window cluster volume against a longer baseline) to the clustering output/API, surfaced in the portal UI once a topics UI exists.

**Why it matters:** Without trending, users have to manually compare cluster sizes over time themselves to notice an emerging issue/request pattern — trending is typically the single most actionable signal in this category of feature (it's what tells a PM/support lead "look at this now").

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #143 — Add dedup to topic clustering output

**Source:** `14-user-request-mining.md` — User Experience & Value section, missing capabilities list.

**Description:** The current clustering output has no deduplication — implying either duplicate clusters can appear across runs, or near-duplicate underlying traces/requests aren't collapsed within a cluster. **Fix:** add dedup logic (e.g., cluster-identity persistence across runs, or duplicate-trace collapsing within a cluster) matching the specific gap the source doc identifies.

**Why it matters:** Without dedup, users reviewing topic output may see redundant or fragmented views of what's actually a single underlying issue/request pattern, making the feature harder to act on and eroding trust in cluster counts as a genuine volume signal.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #144 — Wire `TriageAgent` to read from the Ledger

**Source:** `15-artifacts-behavior-record.md` — gaps beyond portal routes section.

**Description:** `TriageAgent` (eden's triage/routing agent) currently does not read from the Ledger, despite the Ledger existing specifically to hold accumulated behavioral/context knowledge that would plausibly improve triage decisions. **Fix:** add Ledger-read integration to `TriageAgent`'s decision pipeline.

**Why it matters:** This is a missed opportunity to use already-built context infrastructure (the Ledger) to improve an existing agent's decision quality — the Ledger's value is partly measured by how many consumers actually use it, and currently a natural consumer doesn't.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #145 — Add a prompt-version-changed regeneration trigger

**Source:** `15-artifacts-behavior-record.md` — feature gap section.

**Description:** There is currently no mechanism to trigger regeneration of artifacts/book content when the underlying prompt version changes. This means artifacts generated against an old prompt version may become stale or inconsistent once the prompt is updated, with nothing prompting a refresh. **Fix:** add a trigger (e.g., a hook on prompt-version bump) that flags or automatically regenerates affected artifacts.

**Why it matters:** Without this, artifacts can silently drift out of sync with the prompts they're meant to support/inject into, degrading quality over time as prompts evolve without corresponding artifact updates — a slow-burn data-quality issue.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

---

### #146 — Wire the per-step judge automatic scoring loop (`apm_depth/step_judges.py`)

**Source:** `01-competitor-matrix.md`, "Deep codebase re-pass" section (citing `step_judges.py:1-22`).

**Description:** `StepJudgeStamper` extends telemetry events with `step_index`/`step_judges` fields and exposes `stamp`, `get_step_judges`, and `get_trace_steps` — a storage/read primitive. But the module's own docstring states this ship is "stamping only": the actual per-step `JudgeRunner` wiring that would populate these scores automatically is called out as an unbuilt v0.1 follow-up. **Fix:** build and wire the automatic per-step judge-scoring loop so `step_judges` gets populated without requiring a caller to manually stamp each step.

**Why it matters:** Without the automatic loop, this is a write/read API with no default data source — comparable competitor features (HoneyHive per-step eval metrics, Datadog step-level attribution) run automatically; eden's version currently requires bespoke integration work per caller to produce any data at all.

**Severity:** Medium.
**Effort:** Large.
**Confidence:** High (doc explicitly self-admits this gap in the module docstring).

---

### #147 — Add ability to filter/search the trace list by any participating agent, not just the collapsed "preferred" agent

**Source:** `05-multiagent-tracing.md` (citing `_PREFERRED_AGENT_ID_SQL`).

**Description:** `_PREFERRED_AGENT_ID_SQL` deliberately collapses a trace to a single "winner" agent ID for the list view; there is no query path for "show me every trace where agent X participated, even as a sub-delegate." Fix requires either exploding the collapse (listing `agent_id` as an array per trace) or building a secondary "participants" facet — flagged as a materially different query shape worth scoping as its own follow-up, not a trivial addition.

**Why it matters:** An engineer investigating a specific sub-agent's behavior across many traces currently cannot filter the trace list by that agent unless it happens to be the "preferred" one selected for each trace — blocks a common investigative workflow.

**Severity:** Medium.
**Effort:** Large.
**Confidence:** High.

---

### #148 — Build a team-uploaded-context feature

**Source:** `15-artifacts-behavior-record.md` — feature gap section.

**Description:** There is currently no feature allowing a team to manually upload their own context (e.g., documentation, policy text, product knowledge) into the Book/Ledger/Artifacts system — all current content appears to be system-generated (from `ArtifactAuthor` etc.) rather than human-supplied. **Fix:** build an upload/ingestion path (UI + API) for teams to add their own context material into the same system that already injects content into production prompts.

**Why it matters:** A system that shapes live production prompts but can only be populated by automated processes (not by the humans who best understand their own product/domain) is missing a high-value, commonly-expected capability in this product category (compare to how competitor "artifacts"/context systems typically support manual curation).

**Severity:** Medium.
**Effort:** Large.
**Confidence:** High.

---

### #149 — Surface/alert on Redis-lease fallback degradation

**Source:** `08-annotation-labeling.md`, §1a, Phase 3 Verdicts item 2 (citing `labeling_leases.py:13,47-52`).

**Description:** The in-memory lease fallback (`_memory_leases: dict[str, tuple[str, float]] = {}`) is a process-local Python dict. In a horizontally-scaled deployment, each process has its own independent copy — during a Redis outage, two reviewers hitting two different pods can each be told they hold the lease for the same item, and nothing surfaces that degradation to an operator (`claim_lease` just logs at `debug` level). **Fix:** elevate the log level when the fallback path activates and/or add operator-facing alerting/metrics so a Redis outage that silently disables cross-instance exclusivity is visible.

**Why it matters:** This is the concrete answer to "what happens when two reviewers claim the same item" — currently invisible, so an operator has no way to know exclusivity is degraded during an incident.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — the doc identifies the gap precisely but doesn't fully spell out a specific fix.

---

### #150 — Correct roadmap/product narrative away from "build eden's own multi-provider gateway"

**Source:** `10-model-gateway.md` — overall verdict framing, competitive landscape section.

**Description:** Given the DELETE verdict on `AIGateway` (#137) and the crowded, well-capitalized competitive landscape (Portkey/Palo Alto Networks, OpenRouter, LiteLLM), any existing roadmap items, pitch materials, or internal planning docs that describe eden building its own multi-provider LLM gateway/router as a strategic bet should be revised or removed. This is a documentation/planning hygiene action distinct from the code deletion itself.

**Why it matters:** Prevents future engineering time being allocated toward rebuilding what was just decided against, and keeps external-facing/investor-facing narrative consistent with actual product direction.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — the doc's verdict clearly implies this, but it's an inferred follow-on action rather than something the source explicitly instructs as a checklist item.

---

### #151 — Audit for other silent `AIGateway` call sites beyond the two found

**Source:** `10-model-gateway.md` — undocumented production call sites section (implied completeness gap).

**Description:** The doc found two previously-undocumented, silently-broken call sites via manual investigation, not via a systematic search. Given `AIGateway` is ~900 lines and dormant, there is a reasonable chance additional call sites exist elsewhere in the codebase that weren't caught by this pass. **Fix:** run a full repo-wide reference search for `AIGateway` usage before proceeding with deletion (#137), to ensure no other silent failures are lurking.

**Why it matters:** Deleting `AIGateway` (#137) without first confirming all call sites are accounted for risks either missing more broken production paths or breaking something unexpectedly during removal.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — this is a reasonable inferred precaution rather than an explicit instruction in the source doc.

---

### #152 — Document/decide the intended relationship between `user_sessions`, `session_summaries`, and `agent_sessions`

**Source:** `11-session-analytics.md` — session data model section.

**Description:** Distinct from actually merging the tables, there's a prerequisite product/architecture decision needed: what is each table's intended scope going forward (e.g., is `agent_sessions` meant to be agent-specific and `session_summaries` meant to be the general-purpose canonical one, with `user_sessions` deprecated)? This needs to be explicitly decided and documented before the merge engineering work proceeds, to avoid the migration itself encoding an accidental/undiscussed decision.

**Why it matters:** Without an explicit decision, a migration risks silently making an architectural choice (which table "wins") that should be a deliberate product/eng decision, potentially requiring rework later.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — this is a reasonable inferred prerequisite rather than something explicitly named as a separate action in the source.

---

### #153 — Add regression tests asserting `evaluate_and_act` is the active path whenever `trace_id` is present

**Source:** `12-runtime-guardrails.md` — monkey-patch section (implied test gap given the bug went undetected).

**Description:** The fact that a related bypass bug existed undetected implies there is no existing test asserting the correct guardrail path runs under the exact condition (`trace_id` present) that triggers the bypass. **Fix:** add an explicit regression test (unit or integration) that fails if the trajectory/cost-check path is taken instead of `evaluate_and_act` under that condition, to prevent regression after the bypass is fixed.

**Why it matters:** Without a regression test, fixing the bypass once does not guarantee it (or an equivalent one) won't be silently reintroduced by a future change — this is the actual root-cause-level fix that makes the fix durable.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — inferred from the absence-of-monitoring finding rather than an explicit source instruction.

---

### #154 — Document the relationship/precedence between Loop 1, Loop 2, and `EvidenceGate`

**Source:** `13-continuous-improvement-loop.md` — overall structure (three distinct mechanisms covered in one doc).

**Description:** The doc covers three separate "loop"/gating mechanisms (Loop 1 shadow-detector, Loop 2 autonomous patch pipeline, and `EvidenceGate`/`PromotionLoop`) that all relate to continuous improvement but aren't explicitly documented as to how they relate to or depend on each other architecturally. **Fix:** produce (or extract from the source doc if already present in narrative form) an explicit architecture note describing how these three mechanisms interact, to prevent future confusion or duplicate-effort fixes.

**Why it matters:** Without a clear map of how these three systems relate, engineers fixing one may not realize the fix has implications for the others — architectural clarity reduces the risk of fragmented, inconsistent fixes.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — inferred organizational recommendation; the source doc's structure implies this need but doesn't necessarily instruct it as a standalone action item.

---

### #155 — Add regression/integration tests for Loop 1 confirming the confirm/dismiss signal actually changes detector behavior

**Source:** `13-continuous-improvement-loop.md` — Loop 1 section (implied by the loop having been fully dead-code undetected).

**Description:** Since Loop 1 was fully dead code without apparently being caught until this review, there is likely no test asserting the end-to-end effect (a user confirm/dismiss action measurably changes detector behavior/scoring going forward). **Fix:** after Loop 1's P0-A through P0-D revival steps are implemented, add an integration test asserting this causal chain actually holds.

**Why it matters:** Prevents Loop 1 from silently regressing back to dead-code status after being fixed — the same failure mode (built but not functioning, undetected) that caused this to be the flagship finding in the first place.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — inferred from the absence-of-detection pattern, not an explicit source instruction.

---

### #156 — Expose the T0-T4 autonomy tier prominently in whatever UI closes the Loop 2 visibility gap

**Source:** `13-continuous-improvement-loop.md` — Loop 2 section, `autonomy_policy.py` T0-T4 ladder.

**Description:** Specifically within the broader Loop 2 UI-gap fix (#30), the autonomy tier (T0 through T4) that governs how much independent action the loop can take on a given issue/patch should be a first-class, prominent piece of information in the UI — not buried. This is called out separately because it's the single most safety-relevant piece of state the UI needs to surface (how much autonomy is this specific action running under).

**Why it matters:** Operators need to be able to tell at a glance whether a given autonomous action was taken under a low-autonomy (heavily human-gated) or high-autonomy (near-fully-independent) tier, since the risk profile differs enormously between T0 and T4 — burying this in a UI that technically "shows the pipeline" but not this specific field would undercut the point of the fix.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — a specific implementation detail inferred as important within the broader UI-gap fix, not separately named as its own bullet in the source.

---

### #157 — Surface `ArtifactDemotionWorker` activity in the (to-be-built) `/artifacts` UI

**Source:** `15-artifacts-behavior-record.md` — backend components section, `ArtifactDemotionWorker`.

**Description:** `ArtifactDemotionWorker` is named in the doc as one of the existing backend components (alongside `ArtifactAuthor`). Specifically within the broader Artifacts UI-build work (#6), demotion activity (artifacts being demoted/removed from active injection) should be a visible part of the UI, not just creation/authoring — otherwise the UI would only tell half the artifact lifecycle story.

**Why it matters:** Understanding what's being demoted (and ideally why) is as important for trust/debuggability as understanding what's being created — an artifacts UI that only shows authoring without demotion history would be an incomplete picture of a system actively shaping production prompts.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — a specific implementation detail reasonably inferred as necessary within the Artifacts UI scope, not separately called out as its own bullet in the source.

---

### #158 — Audit whether other GA-default-on features have similarly stubbed/misleading portal routes

**Source:** `15-artifacts-behavior-record.md` — overall pattern (Artifacts and Ledger both independently found to have this exact issue).

**Description:** Given both `/artifacts` and `/ledger` independently turned out to be dead stubs despite backing GA-default-on production features, there's a reasonable concern that other portal routes may have the same "stub redirecting elsewhere despite a real, live feature behind it" pattern. **Fix:** audit portal routing config against the list of GA-default-on backend features to check for other instances of this pattern.

**Why it matters:** If this happened twice independently for two of eden's most consequential live-production features (Artifacts and Ledger both directly shape production prompts), the base rate for a third undiscovered instance elsewhere is non-trivial — worth a systematic check rather than assuming these two were the only cases.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — inferred audit recommendation based on the pattern found twice in this doc, not an explicit instruction in the source.

---

### #159 — Add a way to view/filter issues by rank tier once composite ranking ships

**Source:** `16-issue-extraction-online-evals.md` — User Experience & Value section (implied UI follow-on to composite ranking).

**Description:** Once composite ranking exists, the portal issue view should let users filter/sort by the new rank score (e.g., a "Top Priority" view or explicit rank-tier filter), not just implement the backend sort silently. **Fix:** add UI controls (sort toggle, tier filter/badges) surfacing the new ranking once it exists.

**Why it matters:** A backend ranking fix without a corresponding UI affordance to actually use/see the ranking (beyond default list order) under-delivers on the value of the fix — the whole point is helping a human triager quickly find what matters most, which benefits from an explicit visual/filterable signal, not just implicit list order.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — a reasonable UI follow-on inferred from the ranking fix, not necessarily spelled out as its own bullet in the source beyond the User Experience & Value section's general framing.

---

### #160 — Add technical re-verification (re-query stores post-deletion) to the RTBF flow

**Source:** `07-security-compliance.md`, §3 (web research, unverified-external-claim), §8 "What would make this trustworthy and usable" bullet 3.

**Description:** Independent GDPR/SOC2 guidance cited in the doc converges on re-querying stores after a delete call to technically verify erasure, rather than trusting the delete call's return code alone. **Fix:** extend `gdpr.py`'s existing fail-closed pattern with a post-delete re-verification step per store (re-search Typesense/re-query Postgres/re-check Qdrant for the erased identifiers) before reporting final success to the caller.

**Why it matters:** This closes the exact failure mode the Typesense/Redis bugs (see #108) demonstrate — a delete call that doesn't raise an exception is not proof of actual erasure; re-verification is described as "the kind of evidence a SOC2 Type II auditor samples for directly."

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** Medium — sourced from unverified external web research, not independently re-checked by this pass.

---

### #161 — Audit all other analytics modules for the same wrong-table pattern as `cohorts.py`/`funnels.py`

**Source:** `11-session-analytics.md` — analytics code section (implied by the pattern found in two sibling files).

**Description:** Since both `cohorts.py` and `funnels.py` independently ended up pointed at wrong/legacy tables (`jobs`, `audit_log`), it's likely other analytics modules in the same package have the same class of bug (schema drift not propagated to all consumers). **Fix:** systematically review all modules under the analytics package for table references and validate each against the current canonical schema.

**Why it matters:** Given two out of however-many analytics modules were checked both had this exact bug, the prior probability of additional undiscovered instances is high; each one silently produces wrong numbers until found.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** Medium — this is an inferred audit recommendation based on the pattern found, not a specific additional bug the source doc names.

---

### #162 — Unify with F21 tool-call labeling once real usage exists

**Source:** `08-annotation-labeling.md`, §7 item 5.

**Description:** Once the annotation UI ships and gets real usage, unify this general-purpose annotation-queue subsystem with F21's `tool_call_labels.py` (tool-call thumbs-up/down), eden's other human-labeling surface. Explicitly sequenced as lower priority than shipping the UI itself.

**Why it matters:** Eden currently has two separate, unconnected human-labeling surfaces; consolidating avoids long-term UX/data-model fragmentation, but is not urgent.

**Severity:** Medium.
**Effort:** Large.
**Confidence:** Medium — carried over from a prior phase and not elaborated on in this doc.

---

### #163 — Build active-learning sample selection (post-UI)

**Source:** `08-annotation-labeling.md`, §7 item 7.

**Description:** Listed as a future recommendation, sequenced strictly after the annotate UI ships. No further detail on scope or mechanism given.

**Why it matters:** Would let eden prioritize which items get labeled next based on model uncertainty/disagreement rather than pure FIFO/priority-tier queueing, but treated as a low-priority future item, not a near-term deliverable.

**Severity:** Medium (normalized from "Low-Medium" in source doc).
**Effort:** Large.
**Confidence:** Medium — the doc explicitly defers this without describing an implementation.

---

### #164 — Audit all other hot-path monkey-patches in the codebase for similar silent-override risk

**Source:** `12-runtime-guardrails.md` — monkey-patch section (pattern-level implication).

**Description:** Given that `install_cat15_trajectory_replaces_intervention` is one instance of a monkey-patch silently overriding intended behavior, and eden's Python SDK auto-instrumentation also relies heavily on monkey-patching as a technique, there's reasonable cause to audit other monkey-patches in the codebase (not just this one) for the same "silently swaps behavior with no monitoring" risk pattern.

**Why it matters:** If this pattern happened once in a safety-critical path, it's a codebase-culture signal worth checking elsewhere — better to proactively find other instances than wait for another one to be discovered post-incident.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** Low — this is a broad inferred audit suggestion, not something the source doc names as a specific finding beyond the one instance.

---

### #165 — Validate the auto-revert mechanism's trigger conditions are correctly tuned

**Source:** `13-continuous-improvement-loop.md` — Loop 2 section, auto-merge/auto-revert pipeline.

**Description:** Given Loop 2 includes an auto-revert capability (automatically reverting a merged autonomous patch if it's later determined to be bad), and given the broader pattern in this review of components being built but not fully validated in production (mirroring Loop 1's fate), the doc's Loop 2 assessment implies auto-revert's trigger conditions (what counts as "bad enough to revert") warrant explicit validation/tuning review, distinct from the UI-visibility gap.

**Why it matters:** An auto-revert mechanism that's too trigger-happy causes churn/instability; one that's not sensitive enough fails to catch genuinely bad autonomous patches — getting this tuning right is central to whether the autonomy ladder can be trusted at higher tiers (T3/T4).

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** Low — this is a plausible inferred action based on the general pattern of the review rather than a specific bug or gap the source doc names for the revert mechanism itself.

## Low

### #166. Fix or rename `prompt_versioning.run_auto_eval` to stop misrepresenting what it does
**Source:** `02-evals-datasets.md`, §5 P2 item 11, §3l (citing `services/prompt_versioning.py:378-444,447-476`).
**Description:** `run_auto_eval` accepts and stores a `dataset_id` on a `prompt_eval_runs` row but never reads it back inside the function; `_llm_score` scores the prompt *template text* for clarity/specificity, not any dataset output. Fix: either fetch the referenced `dataset_id`'s items and run them through the now-fixed F51 path (post 02-1–02-3), or rename the function/columns to reflect that it is prompt-text linting, not a dataset eval.
**Why it matters:** As named/schema'd today, this function is misleading — it looks like it evaluates against a dataset but doesn't, which risks engineers building on a false assumption about what "auto eval" means in this codepath.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #167. Add a `split` column to `dataset_items` for eval subsetting
**Source:** `02-evals-datasets.md`, §1 "Competitive baseline" (dataset versioning subsection, citing LangSmith's `split` field; `dataset_items` schema).
**Description:** LangSmith's dataset examples carry a `split` field (string or array) for organizing eval subsets (e.g., "smoke" vs. "full regression") — a lighter-weight mechanism than full version-pinning. Eden's `dataset_items` has no equivalent column. Fix: add a `split` column to `dataset_items` to support dataset-defined eval subsets.
**Why it matters:** Explicitly flagged in the source doc as "a real, small, low-risk gap" — closes a specific, named competitive gap against LangSmith with minimal engineering cost.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #168. Reduce redundant entry points between `/evals?mode=playground` and the standalone `/playgrounds` route
**Source:** `02-evals-datasets.md`, §6 "User Experience & Value → What would make it more usable/adoptable" (citing `evals/page.tsx`, standalone `/playgrounds` + `/playgrounds/[id]` routes).
**Description:** `/evals`'s `playground` mode and the standalone `/playgrounds` + `/playgrounds/[id]` route both front the same `playgroundApi`, giving a new user two different starting points for overlapping functionality. Fix: confirm/establish one canonical link path (e.g., from an agent's detail view) so users land on a single entry point rather than the redundant one.
**Why it matters:** Reduces new-user confusion about which of two UI paths is "the" way to use the playground feature — a navigation/IA clarity fix.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #169. Stop fabricating `gen_ai.conversation.id` from the trace ID in the OTel exporter
**Source:** `05-multiagent-tracing.md` (citing `src/eden/observability/otel_exporter.py:264`, `_event_to_otlp_span`).
**Description:** `_event_to_otlp_span` does `add("gen_ai.conversation.id", event.trace_id)` — fabricating a conversation ID from the trace ID, which the OTel GenAI spec explicitly warns instrumentors not to do. Fix: only set the attribute when a real conversation id is present in `event.attributes`, otherwise omit it.
**Why it matters:** Sends non-compliant/misleading telemetry to customers' own OTel backends (Honeycomb/Datadog/Tempo) via the dual-emit exporter — any customer tooling grouping by `gen_ai.conversation.id` would incorrectly treat every span in a trace as one fabricated "conversation."
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #170. Expose automation run history via the API
**Source:** `04-alerting-oncall.md`, §0(d) (citing `automations-panel.tsx:145-146`; `automation_runs` table).
**Description:** Automation executions are logged to an `automation_runs` table, but the UI doesn't expose it because the API doesn't return it yet. Fix: add an endpoint to surface `automation_runs` and wire it into the Automations tab UI.
**Why it matters:** Without run history, once the underlying automation-trigger bugs are fixed, users still have no way to verify whether their automation actually fired/delivered.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #171. Resolve two more orphaned budget-status endpoints reading a dead Redis pipeline
**Source:** `06-cost-governance.md`, §2d.5 (citing `routes/cost.py`; `optimization.py:589-625,776`).
**Description:** `GET /orgs/{org_id}/cost/comparison` states in its own docstring that its source of truth is a Redis hash written by `CostTracker` — since `CostTracker.track()` is unreachable from live gateway traffic (same root cause underlying other 06-series findings), this endpoint returns `null` for any gateway-proxy-only org; its frontend wrapper has zero call sites. `GET /orgs/{org_id}/optimization/budget` reads the same dead Redis hash for spend; its frontend wrapper also has zero call sites. Neither is reachable from the shipped product today, confirming the "CostTracker/Redis never fed by live traffic" root cause has recurred across at least four backend budget-status computations, not two. Fix: either wire these into the live telemetry path alongside the primary fix, or remove the dead endpoints and frontend wrappers as unmaintained surface area.
**Why it matters:** Low current customer impact (not reachable today), but latent dead/broken surface area that will confuse future engineers and represents duplicated, uncoordinated budget-status logic that should be consolidated.
**Severity:** Low
**Effort:** Small
**Confidence:** Medium — the doc documents the existence and root cause clearly but does not itself prescribe a specific fix.

### #172. Build spend-anomaly detection (causal, same-day) as a future differentiation capability
**Source:** `06-cost-governance.md`, §3 Verdict item 4.
**Description:** Neither eden's customer-facing budget system nor its internal cost ledger does anything beyond static 50/80/100% threshold crossings. CloudZero's 2026 positioning frames same-day, causally-explained anomaly detection ("which team/workload caused this spike") as materially different from threshold alerting, and no LLM-native competitor (Portkey/Helicone/LiteLLM/OpenRouter) has this either. The doc explicitly does not scope this now, flagging it "as a candidate for a future pass" since it needs a baseline/expected-spend model, not just a comparator threshold.
**Why it matters:** A real, named competitive-differentiation opportunity, but explicitly deprioritized by the doc's own authors relative to the correctness/UI fixes above — should be tracked as backlog, not next-sprint work.
**Severity:** Low
**Effort:** Large
**Confidence:** High
**Backlog:** tracked as `FEAT-172`, deferred — see [`BACKLOG-FEAT-172-spend-anomaly.md`](BACKLOG-FEAT-172-spend-anomaly.md).

### #173. Fix self-contradictory docstring in `api/routes/labeling.py`
**Source:** `08-annotation-labeling.md`, §1 (citing `api/routes/labeling.py:1-13`).
**Description:** The module docstring literally says "Six routes" immediately above a list of 8 bullets, while the actual route count is 15. Fix: update the docstring to accurately describe all 15 routes the file exposes.
**Why it matters:** Misleading internal documentation slows down any engineer trying to understand the API surface before building the UI layer on top of it.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #174. Widen `annotate()` and related TS types to match backend response shapes
**Source:** `08-annotation-labeling.md`, §6b (citing `resources.ts`).
**Description:** Widen the existing `annotate()` request body type to include `confidence?`, `time_spent_ms?`, `skills_exercised?`, and widen `LabelingItem`/`LabelingAnnotation` TS interfaces to fully match the backend's `ItemResponse`/`AnnotationResponse` shapes.
**Why it matters:** Without these fields typed, the frontend can't submit confidence scores, time-tracking, or skills data — all of which the backend data model already supports and several UX features (session counter, confidence shortcut) depend on.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #175. Add confidence-field keyboard shortcut (`Shift+1..5`)
**Source:** `08-annotation-labeling.md`, §6c.3, §5a.
**Description:** Add a `Shift+1..5` keyboard shortcut for setting the `confidence` field, so setting confidence doesn't require reaching for the mouse.
**Why it matters:** Without it, confidence-setting is the one part of the annotate flow that breaks the keyboard-only flow state.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #176. Add session progress counter to annotate UI
**Source:** `08-annotation-labeling.md`, §6c.3 (citing `labeling.py:66-105`, `time_spent_ms`).
**Description:** Add a small persistent session counter ("N labeled this session, avg Xs/item") — a pure frontend read of `time_spent_ms`, already captured per-annotation server-side.
**Why it matters:** Keeps a reviewer in flow with a natural stopping point during long labeling sessions; no new backend work required.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #177. Resolve the inert `tool_call_inference_v1` flag
**Source:** `08-annotation-labeling.md`, §7 item 6.
**Description:** Listed as an "unchanged, orthogonal" recommendation item — the doc names this flag but does not describe its current behavior or a specific fix within this document (relates to F21 territory).
**Why it matters:** Flagged as lingering config/tech debt worth cleaning up, though the doc gives no detail on user/product impact.
**Severity:** Low
**Effort:** Small
**Confidence:** Medium — named as an action item but no supporting detail on what "inert" means or the concrete fix.

### #178. Extend Python monkey-patch auto-instrumentation coverage / keep it current
**Source:** `features/09-sdk-dx.md` — Python auto-instrumentation, 13-framework list.
**Description:** Python's `eden.instrument()` currently covers 13 frameworks via class-level monkey-patching. The doc implies this list needs to be treated as a living target (new frameworks/SDKs emerge frequently in the LLM app space) rather than a one-time build. Fix: establish a lightweight process/checklist for adding new framework support as they gain adoption, so Python's advantage over TS doesn't quietly erode as the ecosystem shifts.
**Why it matters:** Auto-instrumentation coverage is a moving target; a framework list that goes stale silently degrades the "just works" promise for any user on a newer/less-common stack.
**Severity:** Low
**Effort:** Medium
**Confidence:** Medium — this is an inferred forward-looking recommendation rather than a specific bug the source doc pins to a line/behavior.

### #179. Add export capability for topic clustering results
**Source:** `features/14-user-request-mining.md` — User Experience & Value section, missing capabilities list.
**Description:** There is currently no way to export topic/cluster results (e.g., to CSV, or to another system) from F65. Fix: add an export endpoint/button (likely alongside the portal UI work for the topics/patterns clusterer) allowing results to be pulled out of eden for use elsewhere (reporting, sharing with product/support teams who may not have portal access).
**Why it matters:** Export is a common, low-effort, high-leverage feature for analytics/discovery tools — many teams' actual workflow for using this kind of data (sharing with stakeholders, feeding into other tools) requires getting the data out of the product, not just viewing it in-app.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #180. Correct or update the `patterns_clusterer.py` docstring to match actual behavior
**Source:** `features/14-user-request-mining.md` — User Experience & Value section, scheduling gap (see also 14-2).
**Description:** Distinct from actually fixing the on-demand-only scheduling gap, there's a lower-effort interim/parallel action: the docstring itself currently makes a claim (background scheduling) that's false about current behavior, which is actively misleading to any engineer reading the code to understand what it does. Fix: update the docstring to accurately reflect current on-demand-only behavior, regardless of whether/when the scheduling fix ships.
**Why it matters:** Inaccurate docstrings actively mislead engineers making changes near this code, independent of the scheduling feature gap itself — this is a quick, low-risk correctness fix that should not wait on the larger feature work.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### #181. Position F65 explicitly against the competitor "user request mining" category in product messaging
**Source:** `features/14-user-request-mining.md` — overall doc framing (competitor research + F65 as eden's analog).
**Description:** Given the bulk of the source doc is competitor market research (Langfuse/Arize/Helicone/LangSmith issue-mining features, HN skepticism threads on AI-fix reliability) establishing this as a real, validated product category, and given eden already has a working (if UI-less) analog in F65, there's a product-positioning action once a portal UI ships: explicitly message F65 as eden's answer to this category rather than leaving it undiscovered/unmarketed.
**Why it matters:** eden has already done the hard engineering work (HDBSCAN clustering) that competitors charge for as a distinct feature category — once the UI gap closes, capturing the positioning value requires deliberate messaging, not just shipping the UI silently.
**Severity:** Low
**Effort:** Small
**Confidence:** Medium — this is a reasonable product-marketing inference from the doc's framing, not an explicit build instruction in the source.

### #182. Incorporate the HN AI-fix-skepticism findings into how any auto-fix-suggestion UI is framed
**Source:** `features/14-user-request-mining.md` — competitor research section, HN threads on AI-fix skepticism.
**Description:** The doc's research surfaces real user skepticism (from HN threads) about AI-generated fix suggestions in this product category — implying that if/when eden's topic-mining UI (14-1) or related features (e.g., the autonomous patch/merge/revert loop) present AI-suggested fixes to users, framing/trust-building (e.g., showing confidence, evidence, or requiring explicit human review before action) matters more than raw AI-fix capability, per the researched market sentiment.
**Why it matters:** Building a feature that presents AI-generated fixes without accounting for documented user skepticism about this exact category risks lower adoption/trust even if the underlying suggestions are technically good — this is a UX-framing lesson from competitor research that should inform the design, not just its existence.
**Severity:** Low
**Effort:** Small
**Confidence:** Low — this is a speculative, indirect inference connecting competitor market research to a design recommendation for a not-yet-built UI; the source doc presents the research but doesn't explicitly prescribe this as a design mandate.

### #183. Build an MCP tool for Artifacts/Ledger/Book
**Source:** `features/15-artifacts-behavior-record.md` — feature gap section.
**Description:** There is currently no MCP (Model Context Protocol) tool exposing the Artifacts/Book/Ledger system, meaning it can't be accessed/queried by MCP-compatible agent tooling. Fix: build an MCP tool surfacing read (and potentially write) access to this system, consistent with how eden exposes other functionality via MCP elsewhere (the doc references an existing MCP checkpoint/transcript tooling precedent from recent commits).
**Why it matters:** MCP tool support is increasingly the standard interface for agent tooling to access product context programmatically; without it, the Artifacts/Ledger system can only be used through the (currently also broken/stubbed) portal UI or direct API — missing a distribution channel that's become table-stakes for this category of feature.
**Severity:** Low
**Effort:** Medium
**Confidence:** Medium — the specific existence of an MCP precedent is confirmed context, but the priority/necessity of an MCP tool specifically for this feature is a reasonable but not explicitly emphasized recommendation in the source.

### #184. Audit for other DTOs/fields with the same hardcoded-stub pattern as `relatedSignalId`
**Source:** `features/16-issue-extraction-online-evals.md` — DTO bug section (pattern-level implication).
**Description:** Since `IssueCard.relatedSignalId` was found hardcoded to `None` despite apparently being intended to carry real data (16-3), there's a reasonable chance other DTO fields in the issue-extraction/eval pipeline have similar stub-not-yet-wired patterns. Fix: review `IssueCard` and related DTOs for other fields that may be silently stubbed rather than fully wired.
**Why it matters:** The same class of bug (a DTO field silently hardcoded rather than genuinely populated) is easy to miss during code review since it type-checks and "works" (just always returns a default) — worth a broader pass once one instance is confirmed.
**Severity:** Low
**Effort:** Small
**Confidence:** Low — inferred audit suggestion from a single confirmed instance, not a specific additional finding in the source.

### #185. Correct or remove the misleading code comment in `IssuePromoter._update`
**Source:** `features/16-issue-extraction-online-evals.md` — code-comment-vs-behavior mismatch (see also 16-2).
**Description:** Distinct from implementing the actual escalation logic (16-2), there's a lower-effort interim action: the existing comment in `IssuePromoter._update` claiming severity escalation already happens is currently false and should be corrected or removed regardless of the timeline for the full fix, so engineers reading the code aren't misled in the meantime.
**Why it matters:** Same rationale as the `patterns_clusterer.py` docstring fix (14-7) — a misleading comment actively misinforms anyone reading the code about current behavior, independent of when the real fix ships.
**Severity:** Low
**Effort:** Small
**Confidence:** High

---

## Appendix — cross-doc corroborations merged into single points

The following findings were independently discovered by 2 or more of the sixteen source docs,
from different analytical angles, and were merged into one ranked point above rather than listed
separately. Corroboration across independently-written docs was treated as a strong confidence
signal in each merged point's write-up.

1. **Confirm/dismiss front door for shadow-detector issues** (ranked point **#10**) —
   `01-competitor-matrix.md` ("User Experience & Value" section, discovered via a grep for
   `shadow` under `clients/portal/src` turning up nothing but CSS box-shadow utility classes) and
   `features/16-issue-extraction-online-evals.md` (portal gap section, independently discovered
   the same missing affordance from an issue-extraction-UX angle, noting there is no Dismiss
   button for issues at all). Two independent docs, two different investigative angles,
   converging on the identical missing UI surface.
2. **Fake heuristic-stub scoring in `offline_runner.py` / F51 experiments / playground
   promote-to-experiment** (ranked point **#12**) — `02-evals-datasets.md` (§5 P0 items 1-3,
   three separate sub-findings: the substring-match "treatment" score, the hardcoded "control"
   score, and the missing scorer wiring) plus `03-prompt-playground.md` (§4, independently
   discovered that the playground's own "Promote to Experiment" button routes into the exact
   same broken code path). Four independent findings across two docs converging on a single
   root-cause code path (`OfflineExperimentRunner._run_row`) — the strongest corroboration
   cluster in this document.
3. **Build a real PagerDuty Events API v2 sender** (ranked point **#42**) —
   `01-competitor-matrix.md` ("Verdicts" section, flagging the dead PagerDuty integration from a
   competitive-messaging angle against named competitors with verified live PagerDuty support)
   and `04-alerting-oncall.md` (§1/§4, independently flagging the identical two-line no-op
   `_dispatch_pagerduty()` from a build/engineering angle). Same underlying dead code, merged
   into one point combining both the "build it" fix and the "stop claiming it works" messaging
   correction.
4. **Ship a minimal red-team UI** (ranked point **#88**) — `01-competitor-matrix.md` ("User
   Experience & Value" section, one bullet naming Topics, Drift, and Red-team probing as three
   capabilities with zero portal surface) and `07-security-compliance.md` (§5e/§6/§8,
   independently identifying the same fully-built, API-live `redteam/probes.py` subsystem as
   "the strongest 'backend built, unreachable in product' case" and the cheapest UI win in the
   entire security/compliance area). Merged because both docs are describing the exact same
   unreachable capability; see item 6 below for why this was *not* merged with the Topics and
   Drift findings from the same `01-competitor-matrix.md` bullet.
5. **Ship a portal UI for Topics/pattern clustering (F65)** (ranked point **#90**) —
   `01-competitor-matrix.md` (same "User Experience & Value" bullet as above, competitive-parity
   angle) and `features/14-user-request-mining.md` (User Experience & Value section,
   independently identifying the same fully-built, UI-less clustering capability from a
   market-category angle — eden's own analog to the "user request mining" feature category other
   vendors sell separately). Two independent docs, same underlying gap.

## Appendix — deliberately NOT merged (over-merging avoided)

`01-competitor-matrix.md`'s "Topics, drift, and red-team probes have no portal surface at all"
bullet names three distinct backend capabilities in one sentence. Rather than collapsing this
into a single ranked point, it was split into three: **#88** (red-team probing, merged with the
`07-security-compliance.md` finding above), **#89** (drift detection, kept standalone since no
other source doc independently corroborates it), and **#90** (Topics/pattern clustering, merged
with the `14-user-request-mining.md` finding above). Each names an independently real,
differently-built backend system (`redteam/probes.py`, `predictive/drift.py`,
`topics/service.py` + `patterns_clusterer.py`) with its own fix, its own effort estimate, and its
own competitive framing — treating them as one point would have understated the actual scope of
missing portal surface area and obscured that three separate engineering efforts are needed, not
one.

## Appendix — severity recalibrations

The two source extracts (features-A, covering docs 01-08, and features-B, covering docs 09-16)
were produced independently and did not calibrate severity identically. Once all points were
placed in one ranked list, the following were adjusted so tier boundaries stayed meaningful
across the full set. In every case, the underlying finding, citation, and recommended fix are
unchanged from the source doc — only the severity label moved.

- **#45** (budget-setting UI form) and **#46** (mount `NotificationsProvider`) — both
  recalibrated **High ← Critical**. `06-cost-governance.md` labeled both Critical as the doc's
  own top findings; relative to the rest of the merged Critical tier (SSO auth completely broken,
  guardrail safety bypass, three non-communicating GDPR erasure routes, dead-code shadow-detector
  loop), a missing budget-editing form and an unmounted notifications provider — real,
  high-visibility gaps, but each a contained, already-scoped UI-wiring task with no safety,
  legal, or data-integrity dimension — read as High rather than Critical once placed alongside
  those.
- **#54** (nonexistent `audit_log` table reference) — recalibrated **High ← Critical**.
  `11-session-analytics.md` treated this as its most severe finding; relative to the rest of the
  merged Critical tier it is a scoped, single-area correctness bug (breaks `funnels.py` and
  `export_audit_log`) rather than a cross-cutting trust or safety failure.
- **#67** (`time_travel/replayer.py:453` always-raising call site) — recalibrated **High ←
  Critical**. A real, previously-undocumented broken production path, but narrower in blast
  radius (one feature, time-travel replay) than the Critical-tier points it was originally
  ranked alongside in `10-model-gateway.md`.
- **#83** (build the `/labeling/annotate` work surface) — recalibrated **High ← Critical**.
  `08-annotation-labeling.md` ranked this as its top finding since it's the primary annotator
  persona's entire missing work surface; relative to the rest of the merged Critical tier
  (safety bypass, broken auth, GDPR exposure, misleading GA-default-on feature routes) it is a
  large but contained "build the missing page" item without those cross-cutting trust/legal
  dimensions, so it was placed at the top of High rather than in Critical.
- **#80** (build the `/labeling/queues/[queueId]` kanban board page) — normalized from
  "Medium-High" in the source doc to a clean **High**, for consistency with how hybrid labels
  elsewhere in the set were resolved (round to the higher tier when the source doc's own text
  leans that direction, as `08-annotation-labeling.md`'s did here).
- **#126** (prioritize guardrails fixes ahead of new guardrail feature work) — recalibrated
  **Medium ← Critical**. `12-runtime-guardrails.md` frames its overall subject area as possibly
  the single highest-priority finding of the entire review — but that framing applies to the
  underlying code defects themselves, which are already ranked at Critical/High in this list
  (see #3, #4, #32-#38). This specific point is a process/sequencing recommendation ("don't build
  new guardrail features until the existing ones are fixed"), not an independent code defect, so
  it was recalibrated to Medium to avoid double-counting the same underlying severity twice.
- A small number of Medium-tier points (**#114**, **#116**, **#163**) carried hybrid
  "Low-Medium" labels in the source doc; these were normalized to a clean **Medium** for the same
  round-toward-source-doc-lean reason as #80, with no change in relative ranking.

No point's severity was recalibrated *upward*; the merged set's mix skewed slightly toward
over-labeling in the source extracts (a common pattern when each of 16 docs is written to argue
for its own subject area's priority), so all adjustments in this pass moved a small number of
points down one tier to keep Critical meaningfully reserved for points that block the core value
proposition or actively mislead users/buyers, per the tier definition used consistently across
this document.
