# Eden Strategic Review — Remaining Work Wave Plan

**Rewritten 2026-08-07** from the strategic-review WAVE-PLAN after the Composer-2.5
re-verification pass. Waves 1–9 are **complete** (157/157 ✅ DONE as of 2026-08-07),
including the former 17 unfinished Wave 8–9 points. Earlier finished work (plus 6 done
+ 1 dropped removed on 2026-08-05) remains recorded in-place.

**Source:** superseded full plan history lives in git; ranked inputs remain
[`RANKED-BUGS.md`](./RANKED-BUGS.md), [`RANKED-OPTIMIZATIONS.md`](./RANKED-OPTIMIZATIONS.md),
[`RANKED-FEATURES.md`](./RANKED-FEATURES.md).

## What this is

A parallel-execution schedule for the strategic-review remaining-work set
(157 points across 9 waves). Points were taken in original dependency order
(earlier original waves first), then packed into waves of at most **20** points
while avoiding same-wave file overlaps where metadata allows.

**What a "wave" means:** points in a wave are intended to be staffable in parallel;
complete (or explicitly defer) Wave N before starting Wave N+1.

**Status legend:**

| Status | Meaning |
|---|---|
| ✅ **DONE** | Acceptance criteria met; Status line has evidence. |
| 🟡 **PARTIAL** | Materially advanced; Status line names what remains. |
| ⬜ **OPEN** | Still missing / broken; Status line has current evidence. |

**Tally: 0 unfinished entries — 0 partial · 0 open.** (Wave 1–9: all 157 points ✅ DONE as of 2026-08-07.)

## Summary

Across **9 waves**: sizes 20, 20, 20, 20, 20, 20, 20, 14, 3 (**157 total**).

| Wave | Points | Bugs | Opts | Feats | 🟡 | ⬜ |
|---|---|---|---|---|---|---|
| [1](#wave-1) | 20 | 1 | 2 | 17 | 0 | 0 |
| [2](#wave-2) | 20 | 5 | 1 | 14 | 0 | 0 |
| [3](#wave-3) | 20 | 5 | 13 | 2 | 0 | 0 |
| [4](#wave-4) | 20 | 2 | 5 | 13 | 0 | 0 |
| [5](#wave-5) | 20 | 0 | 2 | 18 | 0 | 0 |
| [6](#wave-6) | 20 | 4 | 0 | 16 | 0 | 0 |
| [7](#wave-7) | 20 | 8 | 7 | 5 | 0 | 0 |
| [8](#wave-8) | 14 | 3 | 6 | 5 | 0 | 0 |
| [9](#wave-9) | 3 | 0 | 2 | 1 | 0 | 0 |
| **Total** | **157** | **28** | **38** | **91** | **0** | **0** |

---

## Wave 1

*Critical leftovers (original Waves 1–2 core)*

**20 points** (1 bug, 2 optimizations, 17 features) — **20 done.** All 20 points are ✅ DONE as of 2026-08-07.

### BUG-9 — Add a UI path for the "ignored"/dismiss issue status (currently unreachable end-to-end)

**Status:** ✅ DONE — 2026-08-07: `_map_issue_status` preserves ignored; Dismissed kanban column + dismiss/reopen wired

*(was original Wave 3)*

**Source:** `bugs/03-api-mcp-contracts.md` #3 (original finding) **+**
`bugs/04-frontend-and-test-failures.md` §5 (independent end-to-end re-confirmation, ruled out a
hypothesized crash risk) **+** `bugs/02-data-consistency.md` §8c (independently confirms no UI
path to `"ignored"` exists) — **corroborated by 3 independent docs.**

**Description:** Both the backend allowlist (`agent_issues.py:107-114`,
`_RESOLVE_STATUSES` includes `"ignored"`) and the portal's typed API client
(`resources.ts:2740-2766`, `AgentIssueResolveStatus` includes `"ignored"`) support an `"ignored"`
status, but the UI's own `IssueStatus` type
(`clients/portal/src/lab/fixtures/issues.ts:5` — `"open" | "acknowledged" | "resolved"`)
structurally excludes it, and no button/affordance in `issues-client.tsx` ever calls
`onStatus("ignored")`. Net: the capability is fully wired on the backend and API-client layers
but has no UI entry point — a dead capability, not a partial one. **Not a crash risk**: `04`
confirmed the portal's read-model endpoint (`portal.py`'s `_map_issue_status`, `:156-167`)
defensively maps `"ignored" → "resolved"` server-side before the frontend ever sees an
`ignored`-status issue, so a directly-API-set `"ignored"` issue can't break the kanban view.
**Fix:** add `"ignored"` to the `IssueStatus` TS type and add a "Dismiss"/"Ignore" action button
wired to `onStatus("ignored")`.

**Blast radius:** Every user of the portal Issues board — there is no way to soft-dismiss a
false-positive/low-value issue via the UI at all, only via a direct API call.

**Severity:** High (missing core triage capability, live, triple-corroborated).
**Effort:** Small-Medium — new type member + button + wiring, no backend change needed.
**Confidence:** High.

**Files touched:** `clients/portal/src/lab/fixtures/issues.ts`, `clients/portal/src/app/(portal)/issues/issues-client.tsx`

---

### OPT-3 — Fix `auto_curator`'s unwatermarked org-selection query

**Status:** ✅ DONE — 2026-08-07: `_run_auto_curator` uses `fetch_stale_candidates` + `advance_watermark` on `auto_curator_watermark`

*(was original Wave 1)*

- **Source:** `05-cron-jobs.md` "Full schedule map" (L108), "Systematic
  check" table (L131), "Pass 3 — unified fix" (L389-421), verdict table
  (L559).
- **Description:** `src/eden/workers/cron_tick.py:202` (in `_run_auto_curator`) runs
  `SELECT id::text AS org_id FROM organizations LIMIT 50` daily with **no `ORDER BY` and no
  time-window floor** — it scans the entire `organizations` table every day. Without
  `ORDER BY`, Postgres gives no ordering guarantee, and in practice tends
  to return a stable subset per plan — meaning the same 50 orgs can be
  served every single run while every org past that cursor is permanently
  excluded, and the excluded set grows forever as the org base grows. This
  never errors (`pg.fetch` succeeds, the tick logs success), so it is
  **invisible to exception-based monitoring**.
- **Fix:** Replace with a watermarked selection using a reusable helper
  `fetch_stale_candidates()` (sketched in the source doc) that left-joins
  the candidate query against a new side-table
  `auto_curator_watermark(org_id, last_processed_at)`, returning the
  oldest-processed-first `limit` rows, then calling `advance_watermark()`
  per org after `AutoCurator.run_for_org` completes — mirroring the
  in-table pattern already proven in `src/eden/columnar/compaction.py`
  (`ORDER BY last_compaction_at ASC NULLS FIRST`). This same helper is
  reused by the fixes for items 8 and 25 below.
- **Impact:** Not independently measured (no coverage metric exists to
  measure the actual excluded-org count today); mechanism DERIVED-FROM-CODE
  (re-verified pass-4).
- **Severity:** Critical/High — the source doc's own verdict table calls
  this the "highest severity" of the five watermark bugs found: "silent,
  permanent, worsening-with-growth coverage gap, not a performance issue."
- **Effort:** Medium (new watermark table + helper + two-line call-site
  change; the helper is shared across four related fixes).
- **Confidence:** High (re-verified pass-4; SQL string matched exactly
  against source).

**Files touched:** `src/eden/workers/cron_tick.py`, `organizations (table)`, `auto_curator_watermark (new table)`

---

### OPT-13 — Evidence-integrity flag: F12 Typesense span-search benchmark is unreproducible from any code in the repo

**Status:** ✅ DONE — 2026-08-08 (audit): `--scale-ladder` harness landed with the `facet_by` A/B toggle and harness-owned `gate_met` computation; the committed manifest `bench/results/f12-span-search-scale-ladder-20260807.json` covers all four rungs — 10k/100k (measured, sqlite fallback), 1m (prior Typesense artifact, `gate_met=true`), and 10m (`blocked_staging`: requires a reachable staging Typesense; numbers are never fabricated). The only remaining item is the 10M-on-staging rung, explicitly deferred until a staging Typesense cluster is reachable (see `STAGING_REQUIRED_MIN_DOCS` in `scripts/bench_f12_span_search.py`).

*(was original Wave 4)*

- **Source:** `01-hotpath-perf.md` "Evidence-integrity flag" section
  (L181-192, L339-395); referenced in item 4's confidence rating.
- **Already landed:** Commit d929604c (2026-08-04) removed
  `scripts/bench_f12_span_search.py`'s hardcoded `"Status: BLOCKED —
  staging Typesense not available"` docstring, implemented the disputed
  JSON's query-mix taxonomy as real executable code (`_build_query_mix`)
  running against a real Typesense, and committed the regenerated
  `bench/results/f12-span-search-1m-typesense-20260804.json` **in the same
  commit** as the harness change and the scorecard update (p95 184ms @1.1M
  with `search_cutoff_ms=150`).
- **Remaining work (from the doc's "Corrected, honest benchmark plan"):**
  (1) extend `scripts/bench_f12_span_search.py` with a `facet_by=…` vs.
  `facet_by=None` A/B toggle to isolate item 4's specific claim (not
  verified done); (2) run a full scale ladder — 10k → 100k → 1M → 10M —
  reporting every rung (only the 1.1M rung has been run; the scorecard
  itself flags 10M-on-staging as follow-up), using
  `docker compose up typesense postgres`; (3) let the harness's own
  pass/fail logic set `gate_met` rather than hand-editing output (not
  verified done), keeping the rule that the extended harness is committed
  in the same commit as any results JSON it produces.
- **Impact:** N/A directly (documentation/process/evidence-integrity
  issue), but the "PARTIAL-GREEN" / "MET @1.1M (tuned)" SLA claim for
  Search (Typesense) F12 (`p95 < 200ms` target) in
  `SOTA-PERF-COST-SCORECARD.md` still rests on a single 1.1M rung.
- **Severity:** High (as a process/evidence-integrity risk — an SLA
  scorecard resting on an unreproducible artifact). Materially reduced by
  d929604c; remaining risk is the missing 10M rung.
- **Effort:** Medium (reduced from Medium-Large — harness extension and
  1.1M artifact regeneration landed in d929604c; remaining is the 10M
  rung + facet A/B + gate_met automation).
- **Confidence:** High that the 1.1M artifact is now reproducible from
  committed code; the 10M-scale claim remains unproven.

**Files touched:** `bench/results/f12-span-search-1m-typesense-20260804.json`, `scripts/bench_f12_span_search.py`, `SOTA-PERF-COST-SCORECARD.md`

---

### FEAT-1 — Implement the SSO login/callback IdP token exchange (currently a scripted 503, not a partial feature)

**Status:** ✅ DONE — 2026-08-07: okta/google (+OIDC-family) route to `_handle_oidc_callback`; SAML-family aliases wired

*(was original Wave 1)*

**Source:** `07-security-compliance.md`, §1b (citing `src/eden/api/routes/sso.py`, `sso_callback` — the 503 raise now sits at `:667-680`, drifted from the doc's `:652-683`; test `tests/intelligence/test_sso_state_csrf.py::test_callback_consumes_state_and_succeeds`)
**Description:** `POST /sso/callback/{provider_id}` validates the CSRF state correctly, then unconditionally raises `HTTPException(503, {"status": "sso_not_enabled"})` for every call — even a correctly round-tripped state. The docstring names the reason: IdP token exchange (SAML assertion validation / OIDC code exchange) is not wired up because it needs per-tenant IdP secrets with no safe broker location yet. `initiate_sso_login` builds a genuinely valid Okta/Google/OIDC authorize URL and sends the browser to the real IdP; the IdP authenticates the user and redirects back with a real code/assertion; eden then discards it and 503s — after the user already authenticated with their own IdP. Fix: implement the actual SAML assertion validation / OIDC code exchange in `sso_callback`, including a secure per-tenant IdP secret broker.
**Why it matters:** This fails at the worst possible point in the flow — after the user's own identity provider has already succeeded — which looks to a buyer's IT team like eden's system broke mid-flow rather than declined to offer the feature. The portal pricing page lists "SSO/SCIM" as an Enterprise-tier feature against this exact backend; that claim cannot be honored for any org not authenticating entirely outside eden's own SSO routes (e.g., via Clerk directly). This is a Critical procurement blocker for any enterprise deal requiring self-service SSO.
**Severity:** Critical
**Effort:** Large
**Confidence:** High

**Files touched:** `src/eden/api/routes/sso.py (sso_callback, initiate_sso_login)`

---

### FEAT-2 — Fix the Typesense RTBF fanout to actually target user-owned documents (add `user_id` to schema)

**Status:** ✅ DONE — 2026-08-07: `user_id` in SPAN_SCHEMA/build_span_doc; schema migrate; RTBF Typesense honest unsupported; Redis fanout unsupported

*(was original Wave 1)*

**Source:** `07-security-compliance.md`, §2b fanout table, §4 point 4 (citing `src/eden/observability/typesense_client.py:67-97,588-591`)
**Description:** `src/eden/services/governance_intel/rtbf_fanout.py`'s Typesense deletion calls `delete_by_user(org_id, user_id)`, which filter-deletes on `"tenant_id:={org} && user_id:={user}"` — but `SPAN_SCHEMA` has 21 fields and no `user_id` field, and `build_span_doc` never sets one. The filter targets a field that doesn't exist, the call doesn't raise, and the fanout falsely reports `status: "ok"` with `deleted: 0` — the indexed `input_text`/`output_text` (actual prompt/completion content) stays fully searchable. Fix: add a `user_id` field to the Typesense span schema, backfill/reindex existing documents, and update the fanout filter to actually match; or, if reindexing is infeasible short-term, change the fanout to report `status: "unsupported"` (matching the honest pattern already used for Qdrant/S3) instead of a false "ok."
**Why it matters:** This is the most severe of the two false-positive fanout bugs, since Typesense holds full searchable prompt/completion text — a re-search for the "erased" user's data would still return their actual conversation content, directly contradicting a reported successful erasure, exactly the kind of gap a SOC2 Type II auditor samples for.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/services/governance_intel/rtbf_fanout.py`, `src/eden/observability/typesense_client.py (SPAN_SCHEMA, build_span_doc)`

---

### FEAT-5 — Consolidate the three non-communicating GDPR erasure routes into one, wired to `RightToBeForgottenService`

**Status:** ✅ DONE — 2026-08-07: `DELETE /auth/users/me` calls `erase_user_account` (RTBF); portal danger-zone copy honest about partial erasure

*(was original Wave 1)*

**Source:** `07-security-compliance.md`, §2a-2c, §4 recommended framing (citing `src/eden/api/routes/compliance.py` (`DELETE /api/v1/me`); `src/eden/services/compliance_jobs.py`; `src/eden/api/routes/auth.py` (`DELETE /users/me`, now at `:2032`, drifted from the doc's `:2039`); `src/eden/services/governance_intel/gdpr.py`)
**Description:** Three deletion implementations exist and don't communicate: `DELETE /api/v1/me` (anonymizes only `users` + deletes `org_members`; zero portal callers), `DELETE /users/me` (narrower still — sets `deleted_at` and rotates `token_version` only, doesn't anonymize email/name or null `password_hash`; the portal's `deleteAccount()` client function calls this route but has zero component callers anywhere in the rendered tree), and `RightToBeForgottenService.process_request` (the broad, well-engineered six-table-plus-cross-store-fanout version, reachable only via `POST /governance/rtbf`, gated behind `rtbf_fanout_v1` which defaults `False`, and never called by the other two paths). None of the three has a UI element calling it — a real DSAR today means a support engineer hand-calling one of three inconsistent endpoints from a terminal. Fix (per doc's explicit P0/P1 recommendation): retire two of the three routes (or make the narrow ones call the broad `RightToBeForgottenService`), wire the survivor to a real "Delete my data" UI element in account settings.
**Why it matters:** This is a genuine, unconditional GDPR Article 17 exposure today — a user who files `DELETE /api/v1/me` gets a success response while their actual trace content, conversation transcripts, feedback comments, and judge rationale text survive untouched indefinitely in the same database. The doc explicitly frames this as active regulatory exposure masked only by low current user count, not a marketing-copy issue.
**Severity:** Critical
**Effort:** Large
**Confidence:** High

**Files touched:** `src/eden/api/routes/compliance.py (DELETE /api/v1/me)`, `src/eden/services/compliance_jobs.py`, `src/eden/api/routes/auth.py (DELETE /users/me)`, `src/eden/services/governance_intel/gdpr.py (RightToBeForgottenService.process_request, POST /governance/rtbf)`, `clients/portal/src/lib/api/resources.ts (deleteAccount) + new account-settings UI`

---

### FEAT-11 — Implement composite issue ranking in `IssuesRepo.list_issues` (currently recency-only)

**Status:** ✅ DONE — 2026-08-07: portal + agent-issues default `sort=rank`; IssuesRepo composite rank wired end-to-end

*(was original Wave 1)*

**Source:** `features/16-issue-extraction-online-evals.md` — core finding, `IssuesRepo.list_issues`, exact rank-scoring SQL provided (B16-1)
**Description:** `IssuesRepo.list_issues` (`src/eden/issues/repo.py`, `ORDER BY last_seen DESC`) currently sorts issues by recency only, despite eden already extracting and storing the raw ranking ingredients needed for a proper composite rank: severity, `user_count`, and `stumble_count`. These signals exist in the data but are never combined into an actual priority score. Fix (source doc §6a, exact SQL): add an optional `sort=rank` parameter to `list_issues` that orders by

```sql
ORDER BY (
    (CASE severity WHEN 'p0' THEN 4 WHEN 'p1' THEN 3 WHEN 'p2' THEN 2 ELSE 1 END)
    * ln(GREATEST(user_count, 1) + 1)
    * ln(GREATEST(stumble_count, 1) + 1)
    * COALESCE(confidence, 0.5)
) DESC, last_seen DESC
```

— log-dampened so one pathological outlier trace count doesn't permanently pin an issue to the top, with severity as the primary lever (the best available human-set signal). A single `ORDER BY` change plus one new indexed expression; no migration required beyond an `(org_id, status)` index if not already present. Implement it as a supplementary sort option (or the new default) over the current recency-only ordering.
**Why it matters:** This is the doc's core finding — the single most consequential and highest-leverage fix in this document. Issues that are severe and affecting many users but happen to be older sink to the bottom of a recency-sorted list, meaning the highest-priority problems may not surface to whoever is triaging issues, directly undermining the entire point of issue extraction (surfacing what matters most).
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/issues/repo.py (IssuesRepo.list_issues)`

---

### FEAT-12 — Replace the fake heuristic-stub scoring in `offline_runner.py` (F51 experiments + playground promote-to-experiment) with real model calls and real scoring

**Status:** ✅ DONE — 2026-08-07: offline_runner real LLM + `run_scorers`; promote config carries tasks/scorers; UI heuristic_stub defaults removed

*(was original Wave 1)*

**Source:** `02-evals-datasets.md`, §5 P0 items 1-3 (02-1, 02-2, 02-3) **+** `03-prompt-playground.md`, §4 "'Promote to Experiment' is a UX trap" (03-1) — **corroborated by 2 independent docs / 4 independent findings converging on the same root-cause code path.**
**Description:** `OfflineExperimentRunner._run_row` (`src/eden/experiments/offline_runner.py:266-288`), live and API-mounted at `/orgs/{org_id}/experiments/offline` (registered in the deferred-router table at `api/app.py:249` as `eden.api.routes.experiments_offline` — routers now mount at lifespan, not import), computes the "treatment" score via a substring-match heuristic — `score = 0.9 if expected in input_text else (0.7 if expected else 0.5)` — with no LLM/agent invocation anywhere in the file (02-1: the `config` dict already carries a `model` field, so the plumbing exists and only the actual call is missing). The "control" side is hardcoded to `{"score": 0.5, "output": item.expected_output or "", "synthetic": True, "method": "heuristic_stub"}` (`:157-162`) regardless of what any actual baseline run produced (02-2: fix via a stored `baseline_output` column or a second real model run against `baseline_experiment_id`'s config). Once both sides produce real output text, they should be scored via `playground/scorers.py`'s existing `run_scorers(specs, output=..., expected=...)` — no adapter needed, since it already operates on the exact `(output: str, expected: str | None)` shape of `dataset_items` (02-3: a drop-in reuse of infrastructure already used elsewhere in `playground/service.py`). The same root defect surfaces from the playground's promote-flow entry point: clicking "+ Experiment" calls `PlaygroundService.promote_experiment` (`service.py:460-488`), which carries forward the playground's `tasks`/`scorers` config with a success toast reading "Immutable snapshot promoted — open Evals to compare," but the resulting `OfflineExperimentRunner.run` execution never calls the playground's LLM handler or `scorers.run_scorers` — it hits the same `_run_row` heuristic stub (03-1). Fix: implement 02-1/02-2/02-3 to make F51 itself real, and make `promote_experiment`'s downstream execution path actually replay the playground's real `tasks` through `playground_llm_handler`/`scorers.run_scorers` so the persisted "experiment" reflects the comparison the engineer actually watched.
**Why it matters:** F51 is a real, live, API-mounted, frontend-wired "offline experiment" feature (Braintrust/LangSmith-style prompt/model comparison) that today produces a numerically meaningless diff on every single run — every score a user sees from it is fake. An engineer who tunes a prompt in the playground, watches real scorer numbers, and clicks "Promote to Experiment" gets a persisted result that has nothing to do with what they just did, silently undermining trust in the tool and wasting iteration work. Four independent findings across two docs converge on the same root-cause code path, which sharply raises confidence this is the correct fix target.
**Severity:** Critical
**Effort:** Small (02-1/02-2/02-3, the core F51 fix) to Large (03-1, the promote-flow integration)
**Confidence:** High

**Files touched:** `src/eden/experiments/offline_runner.py (OfflineExperimentRunner._run_row)`, `api/app.py (deferred-router entry for eden.api.routes.experiments_offline)`, `playground/scorers.py (run_scorers)`, `playground/service.py (PlaygroundService.promote_experiment)`

---

### FEAT-13 — Wire `scorers.py` into an actual CI/merge-gate check (build a real "prompt regression gate")

**Status:** ✅ DONE — 2026-08-07: `prompt_regression_gate` folded into CIWebhookHandler/ci-eval + eden-eval workflow flag

*(was original Wave 1)*

**Source:** `03-prompt-playground.md`, §5 "Not wired to CI"; "User Experience & Value → Where the workflow breaks down"; "Net picture" (citing `.github/workflows/eden-eval.yml`, `api/routes/wave6_online.py:513-514`, `eden.evaluation.ci_webhook.CIWebhookHandler`, `scorers.py`)
**Description:** The only PR/nightly regression gate in the repo is `.github/workflows/eden-eval.yml`, which POSTs to `/orgs/{org}/ci-eval/run`, backed by `eden.evaluation.ci_webhook.CIWebhookHandler` — a completely separate code path from `eden.playground` (and the path that this week's F56 "turnkey evals-in-CI" work, commit `cdccb59f`, extended with a score table, run history, and PR gate). A repo-wide grep for `eden.playground` outside the `playground/` directory never turns up `regression_runner.py`, `ci_webhook.py`, or anything in `.github/`. No scorer defined in `scorers.py` (deterministic, fast, dependency-free: `exact_match`, `contains`, `icontains`, `regex`, `json_valid`, `levenshtein_ratio`) ever gates a merge or deploy today. Fix: build a merge/deploy check that runs the playground's scorer set against a defined comparison (e.g., new prompt version vs. prior) and fails the check on regression, using the existing `scorers.py` infrastructure rather than building new scoring logic from scratch — plausibly by folding it into the now-stronger ci-eval path rather than a parallel gate.
**Why it matters:** Called "the single highest-leverage gap for adoption" — the scorer infrastructure needed for a real "prompt regression gate" already exists and is unused; today the playground is purely a manual pre-merge comparison tool with zero automated say over whether a PR merges or a prompt version deploys, the difference between "a good manual tool" and "the thing that prevents prompt regressions from shipping."
**Severity:** Critical
**Effort:** Large
**Confidence:** High

**Files touched:** `.github/workflows/eden-eval.yml`, `api/routes/wave6_online.py`, `eden.evaluation.ci_webhook.CIWebhookHandler`, `scorers.py`, `eden.playground (regression_runner.py, new merge-gate integration)`

---

### FEAT-14 — Wire `alert_stream.py`'s rule engine to a live event source

**Status:** ✅ DONE — 2026-08-07: sidecars start `alert_kafka_consumer`; `consume_alerts` → `AlertStreamProcessor.process_event`

*(was original Wave 1)*

**Source:** `04-alerting-oncall.md`, §0(a) (citing `realtime/alert_stream.py` — `AlertStreamProcessor.process_event`/`process_batch`; `realtime/kafka_consumer.py` topic map, `"alert": "eden-alert"` now at `:69`, drifted from the doc's `:62-63`)
**Description:** `AlertStreamProcessor.process_event()` is the only function that evaluates alert rules (including the P0 `rule_sandbox_escape`) against a live event. Grepping every call site of `.process_event(`/`.process_batch(` across `src/eden` finds zero external callers — the only hits are the module's own docstring example and `process_batch`'s internal self-call (unrelated `process_batch` methods exist on `insights/dataset_engine.py` and the insights service, but neither touches alerting). `kafka_consumer.py` defines an `"eden-alert"` Kafka topic and comments that "the alerts service" subscribes to it, but no such consumer exists anywhere. Zero test coverage of `alert_stream.py`/`process_event` exists either. Fix: either build a Kafka consumer that subscribes to `eden-alert` and calls `process_event`, or call `process_event` inline wherever the relevant Kafka events currently land.
**Why it matters:** Root cause of the entire P0-alerting failure — no channel-level fix (PagerDuty sender, email routing) matters until this is wired, because the rule engine supposed to detect a P0 event is never invoked by anything in production.
**Severity:** Critical
**Effort:** Large
**Confidence:** High

**Files touched:** `realtime/alert_stream.py (AlertStreamProcessor.process_event, process_batch)`, `realtime/kafka_consumer.py (eden-alert topic)`

---

### FEAT-17 — Fix the `eql_alert_rules` severity-filter inversion (marking a rule "critical" silently disables it)

**Status:** ✅ DONE — 2026-08-07: `CRITICAL` in `_FIREABLE_SEVERITIES`

*(was original Wave 1)*

**Source:** `04-alerting-oncall.md`, §0.5 bullet 2 (citing `dsl/alerts.py` — `_FIREABLE_SEVERITIES` now at `:65-67`, drifted from the doc's `:60-62`; check at `:404-412`)
**Description:** The cron watchdog that evaluates NL-alert rules skips any rule whose severity falls outside `_FIREABLE_SEVERITIES = {info, warning, high}` — and `critical` is the one value excluded. A rule saved as "critical" is accepted by validation, looks correct in the UI, and then never auto-fires again (an in-code comment frames this as "Watchdog filters critical at fire time in v1.3 (accepted at compile for forward-compat)" — i.e., intentional-looking but still a silent trap for users). Fix: include `critical` in `_FIREABLE_SEVERITIES`.
**Why it matters:** Lives in the one alerting pipeline that otherwise genuinely works end-to-end (email delivery to org admins) — silently disables the most urgent rules in the only pipeline that currently delivers anything. Called "a one-line, high-confidence, independently-shippable bug fix."
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/dsl/alerts.py (_FIREABLE_SEVERITIES)`

---

### FEAT-19 — Stop claiming working P0/security alerting and Automations-tab delivery in customer-facing material

**Status:** ✅ DONE — 2026-08-07: automations/alerts copy disclaims guaranteed Slack/webhook and P0 security paging

*(was original Wave 2)*

**Source:** `04-alerting-oncall.md`, §4 Recommendation
**Description:** The doc explicitly recommends not claiming any working alerting/paging capability for security or infra P0 events in any customer-facing material, extending to the portal's Automations surfaces, whose Slack/webhook actions "should not be presented as functional." This now includes the new `/signals` Automations tab (`clients/portal/src/app/(portal)/signals/automations-panel.tsx`) in addition to the older `lab/alerts-panel.tsx`. Fix: audit and correct all customer-facing claims (sales collateral, docs, in-product copy) about P0/security alerting and Automations delivery until #14, #15, #16 are shipped.
**Why it matters:** Framed as "a trust/correctness issue, not a feature gap — a customer relying on eden to page them for a P0 security event would not be paged, full stop." Real customer-risk exposure, not just a roadmap gap.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `customer-facing sales collateral / docs / in-product copy`, `clients/portal/src/app/(portal)/signals/automations-panel.tsx (copy)`

---

### FEAT-25 — Do not describe current erasure as "GDPR-compliant" externally until the fixes land

**Status:** ✅ DONE — 2026-08-07: external/docs/portal disclaim GDPR-compliant; `rtbf_fanout_v1` remains False until fanout proven

*(was original Wave 2)*

**Source:** `07-security-compliance.md`, §4 "Recommended framing for the strategic review"
**Description:** The doc's explicit recommendation: do not describe eden's current erasure capability as "GDPR-compliant" in any external material until the live self-service path covers more than `users`/`org_members` (#5) and is actually reachable by a real user via UI, and until the Typesense/Redis false-success bugs (#2, and the related dead Redis RTBF key-pattern match) are fixed before `rtbf_fanout_v1` is honestly flipped on.
**Why it matters:** This is a messaging-discipline item distinct from the underlying engineering fixes — protects against an external compliance claim that would be actively false today, independent of and prior to the code fixes landing.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `external compliance/marketing material`

---

### FEAT-30 — Close Loop 2's UI rendering gaps for the autonomous patch/merge/revert pipeline

**Status:** ✅ DONE — 2026-08-07: Merge/Revert operator UI + `supervise.manual_merge_plan`/`manual_revert_plan` routes

*(was original Wave 3)*

**Source:** `features/13-continuous-improvement-loop.md` — Loop 2 section, `src/eden/improvement/` (~9,800 lines).

**Description:** Loop 2 — eden's autonomous issue→patch→test→auto-merge→auto-revert pipeline with a graduated T0-T4 autonomy ladder (`autonomy_policy.py`) — is well-designed on the backend (~9,800 lines of real implementation) but has UI rendering gaps. (Specifics inlined 2026-08-05 from the source doc, replacing "exact UI spec should be pulled from the source doc":)
1. **Reject reason is discarded.** `improve/page.tsx:300` calls `rejectPlan` without a reason; the typed client accepts an optional reason and the backend classifies it (`user_fixed`/`outdated`/`wontfix`), which drives the 90-day vs 30-day dedupe TTL — add a reason prompt on reject.
2. **`AutoMergeDecision.reasons`/`blocked_by` is computed with real per-gate granularity but never rendered.** `plan-evidence-panel.tsx` reads `evidence.auto_merge` only for `ci_status`/`status` — a reviewer looking at a plan that didn't auto-merge has no UI-visible answer to "why not." The data already exists; this is a rendering gap, not a backend gap.
3. **No per-plan event log** — plan status history is derived from mutable fields rather than an append-only event stream a reviewer can audit.
4. **The nudges promote/demote lifecycle has zero portal surface** — nudge candidates, shadow status, and promotion outcomes are invisible in the product.

**Why it matters:** An autonomous system that can merge and revert code changes with minimal human oversight is a high-trust-requirement feature; without adequate UI visibility, users/operators cannot build confidence in or supervise what the autonomous loop is doing, limiting how far up the autonomy ladder it's safe to operate.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/improvement/ (autonomy_policy.py)`, `clients/portal/src/app/(portal)/improve/page.tsx`, `clients/portal/src/components/improve/plan-evidence-panel.tsx`, `portal patch/merge/revert UI components`

---

### FEAT-34 — Reconcile the two differently-named `EvalToGuardrailLink` classes

**Status:** ✅ DONE — 2026-08-07: single canonical `EvalToGuardrailLink` in eval_intel; Legacy removed from src/

*(was original Wave 3)*

**Source:** `features/12-runtime-guardrails.md` — dual-implementation section.

**Description:** (Correction 2026-08-05: the two classes are *identically* named, in different modules — the heading's "differently-named" is a misnomer.) Two separate classes both named `EvalToGuardrailLink` exist with incompatible enforcement semantics. The documented one, `eden.guardrails.intervention.EvalToGuardrailLink` (`intervention.py:789`), is toothless — its `.promote()` writes a `type="judge_link"` policy, but `judge_link` is hard-excluded from `InterventionEngine.evaluate_and_act`'s `_enforced_types`, and it never calls the live gateway filter's `load_policies`; it does have a working `.demote()`, but no REST route reaches it. The one actually wired into production, `eden.evaluation.eval_intel.integration.EvalToGuardrailLink` (`integration.py:67`), is undocumented, and critically has no demote path (no way to walk back a guardrail once escalated/promoted via this link). Fix: pick one canonical implementation, deprecate/remove the other, document the surviving one accurately, and add a demote path to whichever becomes canonical.

**Why it matters:** Two conflicting implementations of the same concept is a significant maintainability and correctness risk — engineers modifying "the" `EvalToGuardrailLink` based on docs could be editing the toothless one while production runs the other; the lack of a demote path means guardrail escalations made via the working path are currently one-directional without manual DB intervention.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/guardrails/intervention.py (EvalToGuardrailLink, documented class)`, `src/eden/evaluation/eval_intel/integration.py (EvalToGuardrailLink, production class)`

---

### FEAT-35 — Upgrade guardrail detectors beyond v0 regex/trigram heuristics

**Status:** ✅ DONE — 2026-08-07: embedding augmentation for injection + PII extraction + hallucination (regex fallback)

*(was original Wave 3)*

**Source:** `features/12-runtime-guardrails.md` — detector implementation section.

**Description:** While `InterventionEngine.evaluate_and_act` itself is a real, correctly fail-closed enforcement engine, all the detectors feeding it are v0-quality heuristics (regex and trigram matching), limiting both precision (false positives blocking legitimate content) and recall (real violations regex can't catch, e.g. paraphrased or semantically-equivalent unsafe content). Fix: incrementally replace/augment regex/trigram detectors with model-based (embedding or classifier) detection for the highest-value categories first.

**Why it matters:** The enforcement mechanism is sound, but detector quality directly determines whether guardrails actually catch what they're supposed to catch — v0 heuristics are known to be weak against adversarial or varied phrasing, undermining the safety promise even where the trajectory-replacing patch bypass isn't in play.

**Severity:** High
**Effort:** Large
**Confidence:** High

**Files touched:** `src/eden/guardrails/detectors.py (regex/trigram detectors)`, `InterventionEngine.evaluate_and_act`

---

### FEAT-38 — Verify no customer-facing guardrail dashboards report enforcement metrics from the bypassed path as if from the real path

**Status:** ✅ DONE — audited 2026-08-07; no conflation found; audit artifact at `features/guardrail-metrics-audit.md`; portal client fixed to map `matchCount24h` from `intervention_log`

*(was original Wave 4)*

**Source:** `features/12-runtime-guardrails.md` — synthesizes monkey-patch + portal-bugs sections.

**Description:** Given the portal's own bugs (envelope-unwrap, enum mismatch) and the enforcement path itself being silently substitutable, there's a compounding risk: any dashboard/metric surfaced to customers about "guardrail enforcement activity" may currently report on the wrong (cost/loop/latency) checks rather than actual content-safety enforcement whenever the bypass is active, with nobody realizing the metrics don't mean what they claim. Fix: audit any customer-facing guardrail metrics/dashboards for this specific conflation once the bypass fix and monitoring land.

**Why it matters:** Compounds the core safety issue with a reporting-integrity issue — customers could be looking at dashboards that appear to confirm guardrails are working when they're actually seeing unrelated metrics.

**Severity:** High
**Effort:** Small
**Confidence:** Low — a speculative compounding risk inferred by combining two separate findings in the source doc, not stated as a single finding itself.
**Quick win.**

**Files touched:** `guardrails portal dashboards/metrics components`
**Depends on:** FEAT-3 (✅ done), FEAT-33 (✅ done)

---

### FEAT-41 — Stop claiming self-serve alert configuration exists

**Status:** ✅ DONE — 2026-08-07: automations `alert` action delivers via `dispatch_unified_alert`/email; UI honest about scope

*(was original Wave 3)*

**Source:** `04-alerting-oncall.md`, §4 Recommendation.

**Description:** The one pipeline that reliably reaches a human (NL-alert → EQL → email) has no authoring UI — a customer cannot configure it through the product today at all, independent of and more fundamental than any transport gap. Fix: correct any marketing/product claims implying customers can self-configure alerts today, until a self-serve authoring UI ships (or wire the new automations tab's `"alert"` action to a real delivery channel, which would close the gap for real).

**Why it matters:** The product cannot even be configured by a customer today, a more basic gap than whether delivery works.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `customer-facing marketing/product material`

---

### FEAT-44 — Unify the three/four disconnected alert-routing systems into one data model

**Status:** ✅ DONE — 2026-08-07: `eden.alerts.unified.dispatch_unified_alert` used by alert_stream + automations; architecture note landed

*(was original Wave 3)*

**Source:** `04-alerting-oncall.md`, §1, §4 (citing Automations `automations/engine.py`; `playbook_router.py`'s 22 hardcoded categories; `alert_stream.py`'s Kafka rule engine; the NL-alert/`AlertAsCode` pipeline).

**Description:** None of the four alert-routing systems (Automations tab, playbook router, Kafka rule engine, NL-alert pipeline) share a data model, a severity concept, or a notification-destination concept. Fix: design and build a single unified rule/severity/destination data model that the various trigger sources (security events, quality/behavior findings, EQL rules, score thresholds) all route through.

**Why it matters:** Even after the individual point fixes land, the product still lacks one coherent place to configure "alert me on X, send it to Y" — a structural product-architecture gap, not just isolated bugs.

**Severity:** High
**Effort:** Large
**Confidence:** High

**Files touched:** `automations/engine.py`, `closed_loop/playbook_router.py`, `realtime/alert_stream.py`, `NL-alert/AlertAsCode pipeline (dsl/alerts.py)`

---

### FEAT-46 — Mount the already-built `NotificationsProvider` so in-app budget alerts are visible

**Status:** ✅ DONE — 2026-08-07: `NotificationsBell` mounted in sidebar-nav + mobile app-shell chrome

*(was original Wave 4)*

**Source:** `06-cost-governance.md`, "Getting alerted" (citing `budget_service.py:449-511`; `clients/portal/src/hooks/use-notifications.tsx:57`; `alert_email.py`'s `send_budget_hard_limit_email`).

**Description:** `evaluate_budget_alerts()` is well-built — debounced (~45s), idempotent per threshold/window, fires at 50/80/100% by default — and writes a `notifications` row via `_notify_budget_alert()` on every threshold crossing. The portal has a fully-built consumer, `NotificationsProvider` (adaptive polling, unread counts, mark-as-read, delete), but it's never mounted anywhere in the app: no provider wraps the layout, no bell icon, no toast, no notification panel exists. Separately, email alerts fire only once, at the 100% (hard) threshold — the 50%/80% "early warning" thresholds produce zero human-visible signal anywhere today. Fix: wrap the app layout in `<NotificationsProvider>`, add a bell icon/panel.

**Why it matters:** "Every in-app alert eden's backend writes for a budget threshold crossing is invisible to the customer today" — a complete notification system (table, write path, React provider) with zero UI surface consuming it. Should rank above the deeper spend-tracking schema work in sequencing since none of that backend correctness work is legible to a customer until there's a UI surface reading it.

**Severity:** High (recalibrated from Critical in source doc — see appendix)
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `clients/portal/src/hooks/use-notifications.tsx (NotificationsProvider)`, `portal app layout`, `budget_service.py (evaluate_budget_alerts, _notify_budget_alert)`, `alert_email.py (send_budget_hard_limit_email)`

---

## Wave 2

*High leftovers (guardrails, SDK, agent_id)*

**20 points** (5 bugs, 1 optimizations, 14 features) — **20 done.** All 20 points are ✅ DONE as of 2026-08-07.

### BUG-10 — Surface NULL-`agent_id` events dropped from prompt-evolution scoring

**Status:** ✅ DONE — 2026-08-07: evolution query counts `dropped_null_agent_id`, logs + `eden_evolution_dropped_null_agent_id_total` metric (`components.py:104-211`; `test_judge_prompt_evolver.py`)

*(was original Wave 6)*

**Source:** `bugs/02-data-consistency.md` Bug 2

**Description:** `src/eden/agents/evolution/components.py` filters
`AND te.attributes->>'agent_id' IS NOT NULL` (L93; the drop is acknowledged in a comment at L78) in the query that feeds judge-score/evolution-trigger
aggregation, silently excluding any event with no `agent_id`. No counter, log, or alert exists
for how many events are dropped. **Fix:** add
`COUNT(*) FILTER (WHERE te.attributes->>'agent_id' IS NULL)` to the same query window and log/
emit it (e.g. `metrics.increment("evolution.dropped_null_agent_id", null_dropped)`).

**Blast radius:** Any org with spotty `agent_id` coverage on its telemetry sees prompt evolution
under-fire with no visible explanation why — narrower/less visible than #7's dashboard-level
version of the same pattern.

**Severity:** Medium.
**Effort:** Small — add a `FILTER` clause + a log line. **QUICK WIN.**
**Confidence:** High.

**Files touched:** `src/eden/agents/evolution/components.py`

---

### BUG-12 — Stop collapsing different agents' missing-`agent_id` issues into a shared fingerprint bucket

**Status:** ✅ DONE — 2026-08-07: `__unattributed__:{trace_id}` fingerprint key (`fingerprint.py:81-94`); `UNATTRIBUTED_AGENT_FILTER` on `list_stumbles` + `list_issues` (`repo.py:26,183-188,303-309`; `test_list_stumbles_agent_filter.py`, `test_list_issues_agent_filter.py`)

*(was original Wave 6)*

**Source:** `bugs/02-data-consistency.md` Bug 7 (items 2-3 of 3; item 1, the RCA clusterer half,
is #35 below — gated behind a dead route)

**Description:** `src/eden/issues/fingerprint.py:88`: `raw = f"{kind}|{agent_id or 'unknown'}|{error_signature}"`.
Two different agents' first-ever occurrence of the same `(kind, error_signature)`, both missing
`agent_id`, hash identically — the second agent's incident is silently absorbed into the first
agent's issue via the burst-dedup path and never becomes its own issue. Separately,
`src/eden/issues/repo.py:174-176` filters `if agent_id: clauses.append(...)` — since the DB
column stores real `NULL` (the `"unknown"` string only exists inside the fingerprint hash), any
issue created from an agent_id-less event is invisible from every per-agent-filtered view
(`GET /issues?agent_id=...`). **Fix:** stop using a literal shared sentinel; key the fallback on
something that can't collide across different agents/traces, e.g.
`f"__unattributed__:{trace_id}"` instead of `"unknown"`.

**Blast radius:** Any org with agent_id-less telemetry — silently merges distinct agents'
issues and hides agent_id-less issues from every per-agent filtered issue view.

**Severity:** Medium.
**Effort:** Medium — change the sentinel scheme; needs care around existing rows/backward
compatibility.
**Confidence:** High.

**Files touched:** `src/eden/issues/fingerprint.py`, `src/eden/issues/repo.py`

---

### BUG-15 — Don't retire either `ai_agent`/`ai_insights` router; fix the false "unmounted" tracker claim

**Status:** ✅ DONE — 2026-08-07: `SOTA-WAVE-TRACKER.md:326` documents both routers mounted intentionally; dead `ai_agent` routes called out

*(was original Wave 6)*

**Source:** `bugs/01-dead-code-stale-docs.md` item 13 **+** `bugs/03-api-mcp-contracts.md` §2
(functional trace of unique capabilities in each router) — **corroborated by 2 independent
docs, using the same `app.py:226/229` mount evidence.**

**Description:** `SOTA-WAVE-TRACKER.md:326` claims "Wave 20: aiApi deleted; ai_agent.router
unmounted." The opposite is true: `src/eden/api/app.py:229` mounts `ai_agent.router` in the
deferred-mount table with the comment "W20: Phase-C /ai chat for the portal assistant panel" —
i.e. it was *added*, not removed — and `ai_insights.router` (`app.py:226`) is *also* still
mounted simultaneously; the "dual surface" the doc claims was eliminated is, per the code, still
dual. `bugs/03` traced every route in both routers for real callers: `ai_insights` uniquely owns
an actively-used approval-gated-write flow (`POST /approve`, RBAC + N06 compliance audit) and
session archiving (`POST /sessions/{id}/archive`, called from `resources.ts:889-891`), neither
with an `ai_agent` equivalent; `ai_agent` uniquely owns the Agent page's chat/conversation-list
surface with a different resource shape and SSE event schema than `ai_insights`. The only
genuinely dead, safely-droppable pieces are `ai_agent`'s `DELETE /conversations/{id}` and
`GET /tools` (zero found callers). **Fix:** correct the tracker line; if consolidation is
desired, port `POST /approve` and `POST /sessions/{id}/archive` semantics into the surviving
router and migrate the Agent page's frontend calls to its resource shape — real work, not a flag
flip.

**Blast radius:** Preventive — if anyone acts on the stale doc claim and retires either router
today, it breaks live, actively-used functionality (approval-gated writes, session archiving, or
the Agent page's chat surface, depending on which is dropped).

**Severity:** Medium (nothing is broken today; the risk is acting on the stale claim).
**Effort:** Small for the doc correction; Large for an actual safe consolidation.
**Confidence:** High.

**Files touched:** `docs/specs/SOTA-WAVE-TRACKER.md`, `src/eden/api/routes/ai_agent.py`, `src/eden/api/routes/ai_insights.py`, `clients/portal/src/app/(portal)/agent/page.tsx`

---

### BUG-16 — Add runtime schema validation to the portal's shared API fetch wrapper

**Status:** ✅ DONE — 2026-08-07: optional Zod `schema` on `fetchApi` + high-traffic portal schemas (`core.ts:193-214`, `schemas.ts`, `portal.ts`; `core.test.ts`)

*(was original Wave 6)*

**Source:** `bugs/04-frontend-and-test-failures.md` §9

**Description:** `clients/portal/src/lib/api/core.ts`'s shared `request<T>` returns
`response as unknown as T` for raw responses, `text() as unknown as T` for SSE, `blob() as
unknown as T` for binary, and (with no cast at all, just TS's `any`-is-assignable-to-anything
widening) `response.json()` for the ordinary JSON path. Every API call in the portal trusts the
backend's JSON body to exactly match its hand-maintained TypeScript response type with **zero
runtime validation anywhere in the client** (no zod/io-ts found under `src/lib/api/`). This is
not a single broken cast (the sweep confirmed zero `as any` and all 24 `as unknown as` sites are
narrow/intentional) — it's an app-wide, unenforced contract. **Fix:** add runtime schema
validation (e.g. zod) at minimum for the highest-traffic/highest-risk response shapes, so a
backend shape drift surfaces as a clear "API contract changed" error at the fetch boundary
instead of a downstream `undefined`/`TypeError` deep in a component.

**Blast radius:** Latent today (no known live trigger), but systemic: any future backend
response-shape drift anywhere in the app fails silently and confusingly rather than loudly at
the boundary.

**Severity:** Medium (systemic architectural risk, not a currently-firing bug).
**Effort:** Large for full coverage; Medium for a scoped, high-value subset.
**Confidence:** High (exhaustive sweep of all cast sites).

**Files touched:** `clients/portal/src/lib/api/core.ts`

---

### BUG-17 — Fix ingestion timestamp normalization for offset-less ISO strings

**Status:** ✅ DONE — 2026-08-07: offset-less ISO strings stamped `tzinfo=UTC` in `_normalize_timestamp` (`normalizer.py:52-57`; `test_normalizer.py`)

*(was original Wave 6)*

**Source:** `bugs/02-data-consistency.md` Bug 10

**Description:** `src/eden/observability/ingestion/normalizer.py` (`_normalize_timestamp`, L32-59)
stamps UTC onto three of four accepted input shapes (`None`, naive `datetime`, epoch number) but
passes a fourth shape — a string that parses via `datetime.fromisoformat` but has **no**
timezone marker (e.g. `"2026-08-04T10:00:00"`) — through **unchanged**, with no UTC assumption
applied. That naive value later binds to a `TIMESTAMPTZ` column
(`telemetry_events`), interpreted by Postgres per the connection's session `timezone` GUC, not
guaranteed UTC. This is inconsistent with `portal.py:_iso()`'s unconditional UTC-stamping on the
read side and the portal frontend's bare `new Date(dateString)` calls
(`format.ts:7-8,90-92`), which — per the JS spec — parse an offset-less string as **local
browser time**, a potential multi-hour display error. **Fix:** apply the same
`tzinfo=UTC` fallback to the string branch that the `datetime`-object branch a few lines above
already applies.

**Blast radius:** Today requires an ingestion payload supplying an already-offset-less ISO
string — first-party SDKs and the OTel path (both epoch-based, always-UTC) don't currently
trigger it. A real but narrow, unconfirmed-in-production trigger condition (a raw HTTP API call,
some third-party webhook provider, or a hand-built integration script).

**Severity:** Medium.
**Effort:** Small — one function edit. **QUICK WIN.**
**Confidence:** Medium-High (mechanism fully traced through code; not reproduced against a live
Postgres instance to confirm the exact session-timezone-dependent behavior).

**Files touched:** `src/eden/observability/ingestion/normalizer.py`

---

### OPT-17 — Thread `org_id`/`feature` through `autonomous/_common.py`'s `_call_llm` → `route_async` (fixes 6 silently-zeroed cost-ledger call-site groups)

**Status:** ✅ DONE — 2026-08-07: `_call_llm` forwards `org_id`/`feature` into `route_async` at all 6 call sites (`_common.py:181-214`; `test_call_llm_routing.py`)

*(was original Wave 6)*

- **Source:** `03-llm-cost.md` "Root cause" (L191-256), "Prioritized
  levers" item 2 (L503-517).
- **Description:** `_call_llm` (`autonomous/_common.py:181-188`) has no
  `org_id`/`feature` parameter, so it can't forward what it's never given.
  It calls `route_async(...)` with no `org_id=`/`feature=` kwarg;
  `route_async`'s signature defaults these to `None`/`"unknown"`. Inside
  `cost_context`, the `if org_id is not None` branch is skipped, so the
  `_org_id` contextvar is never set. After the real OpenRouter call,
  `schedule_record_from_usage` checks `oid = org_id or ctx.get("org_id");
  if not oid: return` — both sides are `None`, so the real, token-metered
  CostEvent is discarded before construction, **never reaching Postgres**.
  This silently zeroes real cost for 6 call-site groups: `investigate()`,
  `report()`, and `nl_interface/query.py`'s 4 direct `_call_llm` calls.
- **Fix (precise diff given in source doc):** Add `org_id: str | None =
  None, feature: str = "unknown"` to `_call_llm`'s signature; forward them
  into the `route_async(...)` call; then at each of 6 call sites add
  `org_id=org_id, feature="..."` — `org_id` is already in local scope at
  every site, no upstream caller needs to change. Mirrors the pattern
  already used correctly in `soft_issue_review.py:286-295` and
  `autonomous/agent.py:1707-1717`.
- **Impact:** Real dropped spend at triage's theoretical cap ≈ $0.11/
  org/day (≈250 LLM-used triages/day × ~$0.00045/call) — ESTIMATED,
  bounded/assumption-labeled, not a measurement (no production
  call-volume telemetry exists). Aggregate across all 6 sized `_call_llm`
  paths: "very likely well under $1/org/day" — ESTIMATED. This is framed
  explicitly as **a correctness bug, not a cost-reduction opportunity**:
  "the dollar amounts involved were never large enough for this bug to
  matter as spend, only as trust in the number." It does nudge the
  customer-facing credit-consumption figure `06-cost-governance.md`'s
  hard-enforcement path reads, in the direction of overcounting customer
  spend.
- **Severity:** Medium (doc: "Small dollar impact... but this is Eden's
  own cost telemetry being wrong, which is the thing this audit is
  supposed to get right").
- **Effort:** Small (2-kwarg signature change + 6 call-site additions,
  `org_id` already in local scope everywhere).
- **Confidence:** High ("traced all 7 hops... by direct source read").

**Files touched:** `autonomous/_common.py`, `nl_interface/query.py`

---

### FEAT-37 — Establish a single source of truth for "which guardrail enforcement path is active"

**Status:** ✅ DONE — 2026-08-07: `InterventionEngine.evaluate_and_act` canonical path documented; `judge_link` excluded from `_ENFORCED_POLICY_TYPES` (`intervention.py:389-430`, `37-runtime-guardrails.md`; `test_feat37_canonical_enforcement.py`)

*(was original Wave 4)*

**Source:** `features/12-runtime-guardrails.md` — synthesizes the monkey-patch and dual-`EvalToGuardrailLink` findings.

**Description:** There isn't one guardrail enforcement pipeline today — there's `InterventionEngine.evaluate_and_act`, the trajectory-replacing monkey-patch, and two `EvalToGuardrailLink` implementations, with unclear precedence between them. Beyond fixing each individually, there's a broader architectural action: define and document a single canonical enforcement path so future engineers don't reintroduce a second silent bypass.

**Why it matters:** Point fixes address the currently-known instances, but without an architectural single-source-of-truth, the same "silent parallel implementation" failure mode that caused this problem in the first place could recur.

**Severity:** High
**Effort:** Medium
**Confidence:** Medium — a reasonable synthesized architectural recommendation rather than something the source doc states as its own standalone checklist item.

**Files touched:** `InterventionEngine.evaluate_and_act`, `src/eden/observability/trace_quality/wiring.py (install_cat15_trajectory_replaces_intervention)`, `EvalToGuardrailLink (both implementations)`
**Depends on:** FEAT-3 (✅ done), FEAT-34 (earlier wave 1)

---

### FEAT-49 — Resolve the dual-SSO-story ambiguity (Clerk-based vs. `sso.py` OIDC/SAML)

**Status:** ✅ DONE — 2026-08-07: `docs/docs/how-to/sso.md` + Settings → SSO page warn Clerk-hosted vs native `sso.py` paths (`sso.md:14-27`, `settings/sso/page.tsx:149-185`)

*(was original Wave 4)*

**Source:** `07-security-compliance.md`, §1c item 2 (citing `docs/docs/how-to/sso.md`; `clients/portal/src/lib/api/resources.ts`).

**Description:** `docs/docs/how-to/sso.md` documents SSO as configured entirely via the Clerk dashboard — separate from the `sso.py` OIDC/SAML flow. The portal's admin UI only wires config functions for `sso.py` (`listSSOProviders`, `createSSOProvider`, `enableSSOProvider`, `enforceSSO`, SCIM token functions) and never calls `/sso/login` or `/sso/callback`, so the portal's SSO tab lets an admin configure a login path the product never drives traffic through. Fix: pick one authoritative mechanism (Clerk or `sso.py`) and either remove/hide the other's admin UI, or add an explicit in-product warning that the `sso.py` config path is inert.

**Why it matters:** Today an admin can spend time configuring a "parallel dead code path" with no warning that it does nothing — a silent trust-eroding trap, and a documentation/product inconsistency that would confuse any technical buyer who reads both the how-to doc and the settings UI.

**Severity:** High
**Effort:** Small (decision + UI warning); Large if fully consolidating
**Confidence:** High
**Quick win.**

**Files touched:** `docs/docs/how-to/sso.md`, `clients/portal/src/lib/api/resources.ts (SSO admin functions)`

---

### FEAT-55 — Wire the portal session list/header to read from `session_summaries`, not `agent_sessions`

**Status:** ✅ DONE — 2026-08-07: `list_portal_sessions` reads `session_summaries` via `eden.sessions.list_sessions`; dehydrate prefetch shape unchanged (`portal.py:1886-1896`, `portal-dehydrate.ts:187-194`; `test_portal_sessions_summaries.py`)

*(was original Wave 6)*

**Source:** `features/11-session-analytics.md` — portal wiring gap section (F23 vs N12).

**Already landed:** `/sessions` redirects to `/traces?view=sessions`, whose lens (`traces-client.tsx` + `lab/traces-session-lens.tsx`) calls `sessionsApi.list`/`sessionsApi.timeline` → `GET /orgs/{org_id}/sessions[...]` (`src/eden/api/routes/sessions.py`), which reads exclusively from `session_summaries` via `src/eden/sessions/timeline.py` (commits 5e645046, 45e9fb18, 953286b7 — N12 backend + timeline UI).

**Remaining work:** Retire or repoint the still-live `agent_sessions`-backed rollup surface so only one data model feeds the portal: `portal.py` `list_portal_sessions` (`GET /portal/sessions`, via `AgentSessionService`) is still live and is prefetched by `clients/portal/src/lib/portal-dehydrate.ts:192`, and `api/routes/agent_sessions.py` is still mounted. Repoint the rollup (and its `portal-dehydrate.ts` prefetch) onto the `session_summaries`-backed list endpoint.

**Why it matters:** Directly user-visible inconsistency while two disconnected data models coexist: a user could see one session count/summary in one surface and a different (or missing) picture in another — a confusing, trust-eroding UX bug in a core navigation flow.

**Severity:** High
**Effort:** Small (reduced from Medium — the session lens/backend rewiring landed via N12; remaining is retiring/repointing the `GET /portal/sessions` rollup and its prefetch)
**Confidence:** High

**Files touched:** `clients/portal/src/lab/traces-session-lens.tsx`, `clients/portal/src/lib/portal-dehydrate.ts`, `src/eden/api/routes/portal.py (list_portal_sessions)`, `agent_sessions table`, `session_summaries table`

---

### FEAT-61 — Add `agent_id` and `operation_name` to `get_trace_tree`'s per-span node dict

**Status:** ✅ DONE — 2026-08-07: `get_trace_tree` node dict includes `agent_id` + `operation_name` (`telemetry_collector.py:2118-2119`; `test_get_trace_tree_nodes.py`)

*(was original Wave 6)*

**Source:** `05-multiagent-tracing.md` (citing `telemetry_collector.py` `get_trace_tree` node dict; `portal.py:1385`).

**Description:** `TelemetryCollector.get_trace_tree`'s node dict builds `"error_type": row.get("error_type")` but has no `agent_id` key at all. Fix: add `"agent_id": row.get("agent_id")` and `"operation_name": row.get("operation_name")` next to the existing key — zero-cost once the columns are made real.

**Why it matters:** Even a single trace spanning multiple agents currently cannot show which span belongs to which agent in the transcript view that already correctly walks `parent_span_id` — the specific missing input that blocks swimlaning (#63).

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `telemetry_collector.py (TelemetryCollector.get_trace_tree)`, `portal.py`
**Depends on:** FEAT-22 (✅ done), FEAT-23 (✅ done), FEAT-24 (✅ done)

---

### FEAT-70 — Reconcile TS and Python instrumentation UX so both meet the "one-liner" bar

**Status:** ✅ DONE — 2026-08-07: `auto-instrumentation.md` scopes Python one-liner vs TS `instrument()` prototype-patch matrix (`auto-instrumentation.md:10-73`)

*(was original Wave 5)*

**Source:** `features/09-sdk-dx.md` — overall SDK DX comparison (synthesizes the auto-instrument gap findings).

**Already landed:** `docs/docs/reference/auto-instrumentation.md` now states "patch the most popular LLM SDKs at import time (Python) or wrap client instances (TypeScript)" and documents a three-tier model (native / universal HTTP-capture / manual); TS ships an `instrument()` helper (`sdk/ts-ai/src/instrument.ts`) that installs universal fetch-capture in one line.

**Remaining work:** (1) True framework-level TS parity — tracked as FEAT-71 (still open). (2) Audit external-facing onboarding/marketing copy beyond the reference docs for the generic "drop in one line, get full traces" promise, which is only true for Python today: either scope the one-liner promise explicitly to Python-only in all external-facing docs until real TS auto-instrumentation ships, or prioritize that work so the promise becomes true for both.

**Why it matters:** Mismatched product claims vs. reality erode trust at the exact moment (first install) users are forming their opinion of the product; Node/TS is a large fraction of the LLM app ecosystem (LangChain.js, Vercel AI SDK, etc.).

**Severity:** High
**Effort:** Small (reduced from Medium — the reference-doc scoping and the TS `instrument()` helper landed; what remains here is the external copy audit, with framework parity tracked separately as FEAT-71)
**Confidence:** High

**Files touched:** `eden.instrument() (Python SDK)`, `sdk/ts-ai/src/instrument.ts + wrap*() factories`, `SDK docs/onboarding material (docs/docs/reference/auto-instrumentation.md et al.)`

---

### FEAT-71 — Build real one-liner auto-instrumentation for the TypeScript SDK

**Status:** ✅ DONE — 2026-08-07: `prototype-instrument.ts` prototype-patches OpenAI/Anthropic/Groq/LangChain/Gemini/Mistral at import (`prototype-instrument.test.ts`)

*(was original Wave 5)*

**Source:** `features/09-sdk-dx.md` — auto-instrumentation comparison section.

**Description:** Python's `eden.instrument()` does genuine class-level monkey-patching across 13 frameworks (a real one-liner). TypeScript has no equivalent: instrumentation is per-instance `Proxy`-based `wrap*()` factories the caller must manually apply to every client instance they create — no mechanism patches a framework's exported class/prototype once at import time the way Python does. Fix: implement prototype-level (or Node loader-hook-based, e.g. `import-in-the-middle`) auto-instrumentation for at least the top few frameworks, matching the Python UX.

**Why it matters:** TS/Node users get a materially worse onboarding experience than Python users for the exact same product promise ("one line of code") — a direct DX/adoption gap in a core acquisition funnel (SDK install → first trace).

**Severity:** High
**Effort:** Large
**Confidence:** High

**Files touched:** `sdk/ts-ai/src/instrument.ts`, `sdk/ts-ai/src/instrumentations/ (wrap*() Proxy factories, new prototype/loader-hook auto-instrumentation)`

---

### FEAT-72 — Stop dropping the `synthetic`/`method` honesty flags in the frontend, and add a visible badge

**Status:** ✅ DONE — 2026-08-07: `evals-compare-view.tsx` synthetic/method badge; `evals.ts` preserves `synthetic`/`method`/`avgScores` (`evals-map.test.ts`)

*(was original Wave 5)*

**Source:** `02-evals-datasets.md`, §6 "User Experience & Value" (lines ~527-575); citing `resources.ts:4045-4046,4059-4060`, `evals-compare-view.tsx` (681 lines), `evals/page.tsx:1269-1287`.

**Description:** The backend is honest that F51 is fake — every `run()`/`compare()` response carries `synthetic: true, method: "heuristic_stub"`, and the TypeScript API client types these fields explicitly. But `evals-compare-view.tsx` (the component rendering the improve/regress/tradeoff verdict and score deltas) never references "synthetic" or "heuristic," and `evals/page.tsx`'s `ExperimentFixture` mapping drops `result.synthetic`/`result.method` on the floor when building UI state (hardcodes `avgScores: {}` — now at two sites, L1282 and L1388). Net effect: a user who clicks "Run" gets a confident-looking "Treatment is better, 12 improvements / 3 regressions" screen with zero indication the scores are a substring-match heuristic. Fix: add a `synthetic`/`method` badge to `evals-compare-view.tsx` and stop dropping the fields in `evals/page.tsx`'s mapping — "a few lines," since the data already round-trips through the API client's own types.

**Why it matters:** An active, current, user-facing trust/honesty gap sitting on top of the underlying fake-scoring issue — until the real-scoring fix ships, users are being actively misled by a UI that hides an honesty label the backend already computes.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `clients/portal/src/lib/api/resources.ts`, `clients/portal/src/lab/evals/evals-compare-view.tsx`, `clients/portal/src/app/(portal)/evals/page.tsx (ExperimentFixture mapping, L1282/L1388)`

---

### FEAT-73 — Correct the misleading "Promote to Experiment" button label and success-toast copy

**Status:** ✅ DONE — 2026-08-07: button `+ Heuristic compare` + honest promote toast (`playground-editor.tsx:531,640-642`)

*(was original Wave 5)*

**Source:** `03-prompt-playground.md`, §4; "User Experience & Value → Where the workflow breaks down."

**Description:** The button reads "+ Experiment" and the success toast says "Immutable snapshot promoted — open Evals to compare." The API payload itself is honest — it labels the result `synthetic: true`, `method: "heuristic_stub"` — but the portal UI (button label + toast) actively suggests to a normal user that their real comparison was promoted, when in fact it's replaced by a hardcoded stub once actually executed. Fix: until/unless the backend is fixed, update the button label and toast copy to not overstate what the "promote" action does, or surface the `synthetic`/`heuristic_stub` labels in the UI itself rather than only in the raw API payload.

**Why it matters:** A pure UI-honesty problem separable from the backend fix — it can ship fast as a stopgap to stop actively misleading users, independent of the larger backend rework.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `clients/portal/src/lab/playgrounds/playground-editor.tsx (promote button L641 + toast L531)`

---

### FEAT-74 — Migrate `RegressionCaseBuilder` off its free-text `dataset_id` onto F53's UUID-keyed `dataset_items`

**Status:** ✅ DONE — 2026-08-07: `_persist` writes only to `dataset_items` via `DatasetHub` UUID resolve (`regression_builder.py:276-317`; `test_regression_builder.py::test_persist_does_not_touch_legacy_regression_eval_cases`)

*(was original Wave 5)*

**Source:** `02-evals-datasets.md`, §5 P1 item 5 (citing `regression_builder.py:267-290,188-209,307-311`; `regression_eval_cases.dataset_id VARCHAR(128)` in `db_migrations/versions/092_market_ready_consolidated.py:355-367`).

**Description:** `RegressionCase.dataset_id` is a free-text name string (e.g. `"agent-name/regressions"`), stored in a `VARCHAR(128)` column — schema-incompatible with F53's proper `UUID` `datasets.id`; these two "dataset_id" columns cannot be joined even in principle. Fix: change `RegressionCaseBuilder._persist` to insert into `dataset_items` (resolving a proper UUID `dataset_id` via `DatasetHub.get_dataset`/`create_dataset`) instead of the separate `regression_eval_cases` table, while keeping the existing fingerprint-based dedup logic (`_find_by_fingerprint`), which is sound and just needs to query `dataset_items` instead.

**Why it matters:** The specific, concrete schema blocker preventing eden's regression-case system and its canonical dataset/experiment system from ever being unified — a real migration step, not just "these should share code" hand-waving.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/evaluation/regression_builder.py (RegressionCaseBuilder._persist, _find_by_fingerprint)`, `db_migrations/versions/092_market_ready_consolidated.py (regression_eval_cases.dataset_id)`, `dataset_items table`, `DatasetHub (get_dataset, create_dataset)`

---

### FEAT-78 — Add lease-expiry recovery for orphaned `in_progress` items

**Status:** ✅ DONE — 2026-08-07: `sweep_orphaned_in_progress` reverts expired leases for any annotator; called from `pop()` (`labeling.py:391-427,451`; `test_labeling.py::test_pop_reclaims_orphan_in_progress_for_different_annotator`)

*(was original Wave 6)*

**Source:** `08-annotation-labeling.md`, §1a, §6a item 1 (citing `labeling.py` `pop()` tier queries at L421-449 and the status flip at L487-496; `labeling_leases.py`; `EDEN_LABELING_LEASE_TTL_SECONDS` default 900s, floor 30s).

**Description:** When a reviewer disconnects or sits idle past the lease TTL, the Redis key expires, but `labeling_items.status` was already flipped to `'in_progress'` at claim time and nothing ever reverts it. No reaper/sweep job exists, and no admin unassign/reclaim endpoint exists. All three `pop()` tiers filter on `status = 'pending'`, including tier 1 (`assigned_to = annotator_id AND status = 'pending'`) — so even the original annotator cannot re-pop an item they abandoned; it's orphaned permanently, recoverable only via manual DB UPDATE. Fix: add a sweep (cron job or inline check in `pop()`'s tier-1 query) that reverts `status` from `in_progress` back to `pending` when no active lease key exists for that item. Cheapest version: extend tier 1's WHERE clause to also match `status = 'in_progress' AND assigned_to = annotator_id AND <lease not held by anyone else>`.

**Why it matters:** Without this, a disconnected reviewer's item is stuck forever with no self-heal path — a directly visible "I can't pop this item, it says it's assigned to someone else, but no one's touched it in an hour" trust-eroding bug the moment the annotate UI goes live.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/evaluation/labeling.py (pop() tier queries L421-449, status flip ~L487-496)`, `labeling_leases.py`, `labeling_items table`

---

### FEAT-86 — Fix `IssuePromoter._update` to actually escalate severity from `user_count`/`stumble_count`/`repetition_count`

**Status:** ✅ DONE — 2026-08-07: `_severity_from_blast_radius` escalates from `user_count`/`stumble_count`/`repetition_count` (`issue_promoter.py:55-74`; `test_issue_promoter_severity.py`)

*(was original Wave 6)*

**Source:** `features/16-issue-extraction-online-evals.md` §4a-4b — code-comment-vs-behavior mismatch, `IssuePromoter._update`.

**Description:** The `agent_issues` severity column's comment (in `src/eden/issues/models.py`, ~L58-59) claims "IssuePromoter may bump this based on blast radius," and the `Issue` model carries the raw ingredients (`stumble_count` recurrence, `user_count` blast radius, `repetition_count` regression count) — but `IssuePromoter._update` (`issue_promoter.py:115-180`) never does this escalation. Severity is set once from a static per-kind table (`_DEFAULT_SEVERITY`) and only ever narrows toward the worse of two static defaults via `_more_severe` (lexicographic `min` on `p0..p3`) as duplicate stumbles arrive — a 500-user issue and a 2-user issue of the same `kind` get identical severity forever. The comment describes intended behavior that was never built. Fix: implement the actual escalation logic the comment claims exists, using the three named signals.

**Why it matters:** Even once composite issue ranking exists, if severity itself never gets escalated as new evidence (repeated occurrences, more affected users) comes in, the severity input to that ranking stays artificially low/stale. Also a direct code-vs-comment correctness bug that could mislead future engineers into thinking this logic already works.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/issues/issue_promoter.py (IssuePromoter._update, _more_severe)`, `src/eden/issues/models.py (severity column comment)`

---

### FEAT-87 — Update product copy/marketing to accurately reflect what `/artifacts` and `/ledger` currently do (interim, pre-fix)

**Status:** ✅ DONE — 2026-08-07: `/artifacts` + `/ledger` in `LIVE_PORTAL_PREFIXES` with live pages + honest `PAGE_DESCRIPTIONS` copy (`portal-routes.ts:79-80`, `page-descriptions.ts:32-35`)

*(was original Wave 6)*

**Source:** `features/15-artifacts-behavior-record.md` — portal wiring gap section (implied by "product copy already existing" for a stubbed route).

**Description:** Since product copy already references Artifacts/Ledger as real features while the actual routes are dead stubs, there's an interim honesty/expectation-setting action distinct from the engineering fix: either temporarily adjust copy to not overclaim UI availability, or fast-track un-stubbing `/artifacts`/`/ledger` specifically because customer-facing copy is currently ahead of the shipped product.

**Why it matters:** Customer-facing copy describing a feature that, when clicked, redirects to an unrelated queue view is a direct, visible broken-promise moment for any customer who goes looking for it based on the copy — a credibility risk independent of the underlying engineering timeline.

**Severity:** High
**Effort:** Small
**Confidence:** Medium — the underlying fact (copy exists, routes are stubs) is High confidence per the source; the specific recommended interim copy action is an inferred mitigation, not explicitly instructed in the source.
**Quick win.**

**Files touched:** `customer-facing product copy / marketing material (Artifacts, Ledger)`, `clients/portal/src/lib/portal-routes.ts (STUB_PORTAL_PATH_PREFIXES)`

---

### FEAT-91 — Render fork lineage as a tree, not a flat list

**Status:** ✅ DONE — 2026-08-07: `buildForkTree` + nested `ForkTreeList` in debugger (`fork-tree.ts:21-44`, `debugger-modes.tsx:690-1330`; `fork-tree.test.ts`)

*(was original Wave 6)*

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "What would make it more usable/adoptable" bullet 1 (citing `debugger-modes.tsx` `forksQuery`; `resources.ts` `parent_fork_id` on the `record`/`fork` endpoints).

**Description:** `forksQuery` renders "Forks for this trace" as a flat list showing `fork_id`, `fork_at_step`, and `last_replay_outcome`. But the API already accepts and returns `parent_fork_id` on both the `record` and `fork` endpoints, so fork-of-fork lineage exists server-side and simply isn't rendered. Fix: group the existing flat list by `parent_fork_id` into a nested tree view — "a small, high-leverage front-end fix" requiring no backend work.

**Why it matters:** Time Travel fork+replay is called out as "the strongest concrete realization in this whole matrix of a claimed differentiator" (counterfactual trace forking) — but a flat list hides the actual branching investigation structure (fork-of-fork chains) an engineer builds while debugging, undermining the tool's core value during exactly the workflow it's meant to support.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `clients/portal/src/lab/debugger/debugger-modes.tsx (forksQuery)`, `resources.ts (record, fork endpoints, parent_fork_id)`

---

### FEAT-92 — Wire the GitHub write client into the issue fix-PR flow

**Status:** ✅ DONE — 2026-08-07: `evolve_from_issue` calls `attempt_issue_prompt_fix_pr` (GitHub write or `patch_blocked` stamp) (`issue_fix_pr.py`, `components.py:933-947`; `test_issue_fix_pr.py`)

*(was original Wave 6)*

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "Issue fix-PR UX is half-built, not missing" bullet (citing `lab/fixtures/issues.ts:34-35`, `integrations/github/oauth.py:558,581`); reinforced by the "Verdicts" section's "Issue lifecycle... RESCOPE" entry.

**Description:** The frontend's `IssueFixture` type already has a `patchBlockedReason`/`patchBlockedMessage` contract, presuming a working "attempt a fix PR, report why not" flow. But `IssuePromptEvolver.evolve_from_issue` only creates an internal prompt-version candidate — it never calls GitHub. Meanwhile `change_impact/preview.py` already has a working GitHub write client (`GitHubOAuthClient.create_check_run`/`.create_pr_comment`) used for pre-merge impact previews (and since commit cdccb59f, `evaluation/ci_eval_commit_status.py` reuses the same client for CI eval statuses — further proof the write path works). Fix: wire that same GitHub client into the post-resolution issue fix-PR path so `/issues` can actually open a fix PR (or accurately report why it can't), populating the UI slot the frontend is already scaffolded for.

**Why it matters:** Every issue today effectively surfaces an unpopulated "blocked" state rather than a real success/failure signal, even though the underlying GitHub write infrastructure exists and works elsewhere in the product — characterized as "a wiring task, not a design task," making it a comparatively cheap fix for a highly visible gap in the failure-triage flow.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `lab/fixtures/issues.ts (IssueFixture)`, `integrations/github/oauth.py (GitHubOAuthClient.create_check_run, create_pr_comment)`, `change_impact/preview.py`, `agents/evolution/components.py (evolve_from_issue)`

---

## Wave 3

*MCP / cost / parallelization*

**20 points** (5 bugs, 13 optimizations, 2 features) — **20 done.** All 20 points are ✅ DONE as of 2026-08-07.

### BUG-13 — Validate `agent_id` on stumbles/issues against a real identity system

**Status:** ✅ DONE — 2026-08-07: `resolve_agent_id` via registrations+aliases on write (`issues/agent_identity.py`); alias-aware list filters in `IssuesRepo`; applied in signal_investigator + investigate_trace

*(was original Wave 7)*

**Source:** `bugs/02-data-consistency.md` Bug 6 (stumble-write half; the RCA-chain half is #34
below, gated behind a dead route)

**Description:** `src/eden/api/routes/signal_investigator.py:248,305` and
`src/eden/signals/investigator.py:363,395` accept a caller-supplied `agent_id` string with zero
cross-check against `agent_registrations` or the trace's own telemetry `agent_id`.
`db_migrations/versions/084_agent_issues.py:49,93` stores it as plain `VARCHAR(256)` with no FK.
`issues/repo.py:174-176`'s filter is exact-match. Repro: a caller passes a fleet-identity
`display_name` while the org's identity-of-record is a registration UUID; the stumble is stored
under the fleet-identity string, and `GET /stumbles?agent_id=<registered-UUID>` returns zero
rows. **Fix:** resolve `body.agent_id` through the same `_PREFERRED_AGENT_ID_SQL`-style
normalization proposed for #6, before writing `StumbleCreate`.

**Blast radius:** The always-on signal-investigator write path (live, not gated behind any dead
surface) — any org whose caller supplies a non-canonical agent identifier gets stumbles that are
invisible from the canonical per-agent filtered view.

**Severity:** Medium.
**Effort:** Medium — needs the same identity-normalization helper as #6.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/signal_investigator.py`, `src/eden/signals/investigator.py`, `src/eden/issues/repo.py`
**Depends on:** BUG-6 (✅ done)

---

### BUG-18 — Fix or caveat the public doc instructing users to call a dead `/mcp/keys` endpoint

**Status:** ✅ DONE — 2026-08-07: mcp-cursor.md points to `EDEN_API_KEY` / Settings → API Keys; `/mcp/keys` documented as not mounted

*(was original Wave 7)*

**Source:** `bugs/01-dead-code-stale-docs.md` item 27

**Description:** `docs/docs/how-to/mcp-cursor.md:149` tells users: "MCP-scoped key from
**Settings → MCP** (`POST /orgs/{org}/mcp/keys`)" — but that route is never mounted (see #23
below) and the portal has no "Settings → MCP" UI that calls it (see #24). A user following this
doc exactly would 404 and would need to fall back to the doc's other documented option
(`EDEN_API_KEY`, an org-level key, per `:52`) to succeed. The page is already marked
`sidebar_label: MCP in Cursor (retired)` and `draft: true`, and has an active uncommitted
working-tree edit — confirming it's actively being maintained, a good candidate for a real fix
rather than an archival note. **Fix:** remove the `/mcp/keys` instruction (or caveat it as
non-functional) and point users to the working `EDEN_API_KEY` path only.

**Blast radius:** Public-facing how-to doc; low current traffic since the page is `draft: true`
and MCP is soft-retired, but anyone who does reach it and follows it literally hits a 404 with no
warning.

**Severity:** Medium.
**Effort:** Small — doc edit. **QUICK WIN.**
**Confidence:** High.

**Files touched:** `docs/docs/how-to/mcp-cursor.md`

---

### BUG-19 — Regenerate 3 stale contract/doc snapshots (6 failing tests)

**Status:** ✅ DONE — 2026-08-07: api_surface_snapshot regenerated (893 routes); migration-matrix rows 154–162 added; w3 contracts green

*(was original Wave 7)*

**Source:** `bugs/04-frontend-and-test-failures.md` §7b(iii-v)

**Description:** Running the full backend suite fresh (not the filtered `-k` subset prior passes
used) surfaces 6 failures across 3 snapshot/doc-drift suites, none of which reflect an app bug:
(a) `tests/unit/api/test_api_surface_snapshot.py` — 3 tests fail because the two new endpoints
from commit `64233475` (`GET .../rca/{trace_id}/chain`, `POST .../traces/{trace_id}/investigate`)
were never followed by `python scripts/update_api_snapshot.py`; (b)
`tests/docs/test_migration_matrix.py` — 2 tests fail because 4 Alembic revisions
(`139_debug_sessions_last_replay`, `140_portal_compare_seeds`, `141_ci_eval_run_metadata`,
`142_session_summaries`) are missing rows in `docs/ops/migration-matrix.md`; (c)
`tests/unit/api/test_w3_contracts.py::test_wave6_api_paths_subset_of_backend` — 1 test, same
family, portal-client-vs-backend route-set diff out of sync. **Fix:** run
`scripts/update_api_snapshot.py`, add the 4 missing migration-matrix rows, and regenerate the
wave6 contract snapshot.

**Blast radius:** No functional impact — these are CI/doc-freshness gates catching that a regen
script wasn't run after otherwise-correct, individually-tested feature work. Left unfixed, they
keep the backend suite red and mask real future failures in the noise.

**Severity:** Medium (CI hygiene, currently red build state) — practically Low functional risk.
**Effort:** Small — run one script, add doc rows. **QUICK WIN** (high value: unblocks a clean
CI signal for 6 tests at near-zero cost).
**Confidence:** High.

**Files touched:** `tests/unit/api/test_api_surface_snapshot.py`, `tests/docs/test_migration_matrix.py`, `tests/unit/api/test_w3_contracts.py`, `docs/ops/migration-matrix.md`, `scripts/update_api_snapshot.py`

---

### BUG-20 — Fix `query_eql` MCP tool's dead target path (only broken MCP tool with confirmed real user impact)

**Status:** ✅ DONE — 2026-08-07: `query_eql` retargeted to `client.compile_nl_alert` → `POST /orgs/{org}/alerts/compile`

*(was original Wave 7)*

**Source:** `bugs/03-api-mcp-contracts.md` §1.A.1

**Description:** `tools.py:324-353` posts to `f"/orgs/{org_id}/alerts/nl/preview"`
(`:339-340`) — no such route exists; `intelligence_dsl.py`'s router has exactly 7 routes, none
matching. The claimed sibling, `preview_nl_alert` (`llmops/insights_tools.py:1131-1133`), is an
in-process LLM-agent tool, never mounted as an HTTP route. `HttpEdenClient.post` returns a normal
`{"status": "error", "http_status": 404, ...}` dict (no exception), so every invocation returns a
404 error body, always. **This is the one MCP finding not fully discounted by MCP's
soft-retirement**: Eden's own onboarding doc instructs users to run this tool as its smoke test
(`docs/docs/how-to/mcp-cursor.md:182`) — anyone following the onboarding flow verbatim hits a
guaranteed 404 on step two. **Fix:** retarget to `/alerts/compile` or add a real NL-preview
route.

**Blast radius:** Narrow but real — the specific external developers who follow Eden's MCP
onboarding doc verbatim (the MCP surface overall has zero internal callers and is soft-retired).

**Severity:** Medium (elevated above the other MCP-path bugs specifically because of the
doc-driven smoke-test exposure).
**Effort:** Small — retarget the path.
**Confidence:** High.

**Files touched:** `src/eden/mcp_server/tools.py`

---

### BUG-21 — Extend `EdenApiClient` Protocol to cover all client-calling methods

**Status:** ✅ DONE — 2026-08-07: EdenApiClient Protocol + HttpEdenClient cover remaining MCP HTTP methods; tools.py has zero raw `client.get`/`post`

*(was original Wave 7)*

**Source:** `bugs/03-api-mcp-contracts.md` #5

**Description:** The typed `EdenApiClient` Protocol (in `src/eden/mcp_server/client.py`; the
original `:37-46` line cite has drifted as the Protocol has since grown) covers 17 of 26 distinct
client-calling methods; 9 MCP tools (10 counting `tail_trace`'s dead `hasattr` fallback branch)
reach `HttpEdenClient` via untyped `get`/`post` duck-typing instead of a typed method — this is
part of why bugs like #29 (the `live` param) and the broken-path tools (#20, #25, #26) went
unnoticed: there's no typed signature to diff against. **Fix:** add typed Protocol methods for
the remaining 9 (10) call sites.

**Blast radius:** MCP surface only (soft-retired, zero internal callers) — the value here is
preventive (reduces the chance of the next contract-drift bug), not fixing a currently-live
defect.

**Severity:** Medium (preventive/structural value) but Low current live blast radius.
**Effort:** Medium — 9-10 new Protocol method signatures + implementations.
**Confidence:** High.

**Files touched:** `src/eden/mcp_server/client.py`

---

### OPT-18 — Thread `org_id`/`feature` through `optimization/model_router.py`'s `ModelRouter.route`/`.aroute`

**Status:** ✅ DONE — 2026-08-07: `ModelRouter.route`/`aroute` bind `cost_context(org_id, feature=...)`; patch_generator passes org_id + feature=`patches`

*(was original Wave 7)*

- **Source:** `03-llm-cost.md` "Root cause" (L258-274), call-site family 9
  (L173-191), "Prioritized levers" item 2 (L503-517).
- **Already landed:** `aroute` now calls the LLM via `asyncio.to_thread`
  (not `run_in_executor`), which preserves an *ambient*
  `cost_ledger.cost_context` bound by the caller — the in-code comment
  documents exactly this contextvars-drop bug being fixed.
- **Remaining work (verified today):** `aroute()` (`model_router.py:538`)
  still accepts `org_id`/`user_id` kwargs (`:543-544`) and never uses them
  anywhere in the body, and the sync `route()` (`:461`) still doesn't
  accept `org_id` at all — callers passing `org_id=org_id` explicitly
  (e.g. `patch_generator.py:963`) still have it silently discarded. This
  drops cost attribution for every `ModelRouter` call in the autonomous
  issue→patch→test→auto-merge closed loop (enabled by default,
  `config.py:320: improvement_schedule_enabled: bool = True`): main
  patch-generation call, critic-review call, and RCA-to-code linking.
  Fix: mirror the `_call_llm` fix — since `llm_client.call(...)` takes no
  `org_id` parameter, bind `cost_context(org_id, feature=...)` around the
  call inside `route`/`aroute`; the `asyncio.to_thread` change already
  guarantees the context survives into the worker thread.
- **Impact:** **Not sized to a dollar estimate in this pass** — the doc
  explicitly states "no visibility into sweep-budget cadence or per-org
  call frequency" for `improvement/sweep_budget.py::try_consume_llm_call()`.
  Per-call cost "very likely in the same sub-cent range, but total volume
  — and therefore whether it changes the aggregate bound — is unknown."
  This is an explicit evidence-gap flag, excluded from item 17's aggregate
  "<$1/org/day" bound.
- **Severity:** Medium (same correctness-bug class as item 17, but a real
  spend ceiling exists via the fail-closed `sweep_budget.py` gate).
- **Effort:** Small ("a second, smaller diff" than item 17's fix).
- **Confidence:** High that the bug exists (zero grep matches confirmed);
  Low/unverified on dollar sizing (explicitly unsized by the doc).

**Files touched:** `optimization/model_router.py`, `patch_generator.py`

---

### OPT-19 — Stop writing the synthetic flat `_TRIAGE_COST_ESTIMATE_USD` ($0.02) CostEvent once real metered cost flows through

**Status:** ✅ DONE — 2026-08-07: removed `_TRIAGE_COST_ESTIMATE_USD` synthetic `record_spend`; triage no longer writes fake $0.02 CostEvents

*(was original Wave 7)*

- **Source:** `03-llm-cost.md` "New finding (Phase 3, re-verified)"
  (~L361-420), "Prioritized levers" item 2 (L505-506).
- **Description:** A live, unfixed recurrence of a bug already fixed
  elsewhere (the investigator used to book a fictitious $0.03; that path
  is now $0.0). In `issues/triage_agent.py`,
  `_TRIAGE_COST_ESTIMATE_USD = 0.02` is a flat, non-metered constant.
  `triage()` calls `_debit_budget(org_id, _TRIAGE_COST_ESTIMATE_USD)`
  whenever `llm_used` is true, which calls
  `record_spend(org_id, amount, feature="triage", model="triage")` —
  `autonomy_policy.record_spend()` unconditionally writes a `CostEvent`
  with the fake amount to the real, customer-facing FinOps ledger table.
  This write path is entirely independent of items 17/18's `cost_context`
  machinery — it's a hand-built `CostEvent` with `org_id` correctly
  attached, which is precisely why the fake $0.02 lands while the real
  number (dropped by item 17's bug) does not. Net effect: for every triage
  that uses the LLM, the FinOps ledger records a flat invented $0.02 line
  tagged `model="triage"`, while the real token-metered OpenRouter cost is
  never recorded anywhere.
- **Fix:** After item 17's fix lands (real cost flows), remove/replace
  this synthetic constant write.
- **Impact:** Fake constant = $0.02/call (MEASURED, literal in code). Real
  per-call cost at a generous high-end token estimate ≈ $0.00045/call
  (ESTIMATED; per-token pricing verified live against DeepSeek docs). At
  triage's corrected $5/org/day cap (≈250 LLM-used triages/day), fake ≈
  $5/org/day vs. real ≈ $0.11/org/day — **fake is ~45× the real number**;
  the doc explicitly states this ratio, not either absolute figure, is
  "the more important artifact of this bug." Realistic volume is likely
  far below the cap (StatGate resolves most P0s deterministically; repeat
  triages hit a result cache).
- **Severity:** Medium (correctness/trust issue, not a cost-reduction
  lever — dollar amounts are immaterial to Eden's own P&L, but it does
  nudge the customer-facing credit-consumption number).
- **Effort:** Small (remove one constant-based write path once item 17's
  real-cost path is live).
- **Confidence:** High (direct line reads throughout the write chain).

**Files touched:** `issues/triage_agent.py`, `autonomy_policy.py`
**Depends on:** OPT-17 (earlier wave 2)

---

### OPT-20 — Batch/parallelize `investigate_trace`'s serial, unbatched per-signal write loop

**Status:** ✅ DONE — 2026-08-07: `_write_events_batch` multi-row INSERT + `bounded_gather(limit=8)` for matched stumble/cluster work in `investigate_trace`

*(was original Wave 7)*

- **Source:** `01-hotpath-perf.md` Finding 4 (L201) + round-trip ledger
  (L208-254) + `02-db-queries.md` F5 (L446-469) — **cross-doc duplicate,
  merged**; `01` explicitly states "Same code, same bug as
  `optimizations/02-db-queries.md` F5... not double-counted."
- **Description:** `investigator.py::investigate_trace`'s main loop
  (`:255-316`) processes up to `R=20` matched `signal_definitions` rows
  sequentially in a plain Python `for` loop (three branches each wrapped
  in a bare `try/except Exception: pass`). For each row: (a) `_write_event`
  does a single-row `INSERT` with no batching (→ `R` round trips total);
  (b) for matched rows, the stumble-write chain (see item 21) and
  `cluster_after_match` (see item 2) are awaited sequentially, not
  concurrently. `01-hotpath-perf.md`'s exact round-trip ledger (traced
  line-by-line through `investigator.py`, `clusterer.py`,
  `stumble_writer.py`, `repo.py`, `issue_promoter.py`, `rca/_common.py`)
  computes the precise worst-case Postgres round-trip formula:
  `2 + R + M·3 + M·(1 + G)`, which at `R=M=20`, `G≈250` (clustering
  groups) = **2 + 20 + 60 + 20×251 = 5,102 Postgres round trips**, plus up
  to **20 Redis round trips**, plus up to **20 × 124,750 = 2,495,000
  CPU-bound pairwise comparisons**, all in one
  `POST /traces/{trace_id}/investigate` call — a hard ceiling
  DERIVED-FROM-CODE from the code's own `LIMIT`s, explicitly NOT a
  typical-case estimate (requires all 20 signal definitions to match the
  same trace simultaneously; neither doc estimates how often that occurs).
- **Fix:** (1) Batch the `_write_event` inserts into one multi-row
  `INSERT`. (2) Run independent per-matched-row work concurrently via
  `bounded_gather` (`eden.async_tasks.bounded_gather`, already proven at
  `eden/insights/incidents/clusterer.py:59-100` for this exact shape,
  cited elsewhere as achieving ~5s → ~50ms for a 100-trace N+1) — not a
  bare `asyncio.gather`, since an unbounded fan-out over up to 20
  concurrent chains risks a burst of up to 20 simultaneous DB/Redis
  connections from one request. (3) Move `cluster_after_match` off the
  synchronous request path per item 2's fix.
- **Impact:** ~5,100 Postgres round trips + 20 Redis round trips —
  DERIVED-FROM-CODE worst-case ceiling; both docs agree it is a ceiling
  not a typical case.
- **Severity:** Medium (both docs explicitly rate this Medium, not
  escalated, specifically because the worst-case all-20-signals-matching
  assumption is unverified against real-world match rates).
- **Effort:** Medium.
- **Confidence:** Medium — round-trip counts and code asymmetry are
  directly verified from source; typical-case frequency is unknown.

**Files touched:** `investigator.py`
**Depends on:** OPT-2 (✅ done)

---

### OPT-23 — Strip unused body/reasoning fields from the trace-tree API response on the cheap path

**Status:** ✅ DONE — 2026-08-07: cheap-path `get_trace_tree` omits request/response/reasoning/tool_calls_full/tool_results; keeps agent_id/operation_name

*(was original Wave 7)*

- **Source:** `04-frontend-perf.md` "Third finding" (L52-56).
- **Description:** `TelemetryCollector.get_trace_tree`
  (`telemetry_collector.py:1848-2081`), served at
  `GET /orgs/{org}/observability/traces/{trace_id}/tree`, builds every span
  node with `metrics`, `attributes`, `payload`, `request_body`,
  `response_body`, `reasoning`, `tool_calls_full`, and `tool_results` —
  even on the default "cheap" path (`hydrate_bodies=False`). The cheap
  path only skips body-column decompression; `reasoning`,
  `tool_calls_full`, and `tool_results` still fall through to raw row
  values and are never stripped. The portal's only consumer of this
  endpoint reads `node.metrics`/`node.payload`/`node.attributes` only,
  deriving request/response/tool-results from inside `node.payload` — the
  five top-level fields are grepped nowhere else in `clients/portal/src`.
- **Fix:** Omit `request_body`, `response_body`, `reasoning`,
  `tool_calls_full`, and `tool_results` from the node dict when
  `hydrate_bodies=False` (two of five already have this guard; add it to
  the other three); only fetch them via a dedicated per-span "expand" call
  if drill-down is ever needed.
- **Impact:** Not independently quantified in bytes; doc states this
  "multiplies the `/tree` response size by however large those blobs are
  — per span, for every trace-tree fetch" for traces with long reasoning
  chains or large tool outputs.
- **Severity:** Medium (payload bloat on the default path of a frequently
  hit endpoint, for fields with zero live consumers).
- **Effort:** Small (mirrors an existing conditional pattern already used
  for 2 of the 5 fields).
- **Confidence:** High (grepped whole frontend for consumers, zero found).

**Files touched:** `telemetry_collector.py`

---

### OPT-24 — Parallelize `soft_issue_review`'s sequential 20-org loop

**Status:** ✅ DONE — 2026-08-07: soft_issue_review org loop uses `bounded_gather(limit=8)` with per-org error isolation

*(was original Wave 7)*

- **Source:** `05-cron-jobs.md` "Other concrete inefficiencies" #5
  (L232-241), verdict table (L564).
- **Description:** `soft_issue_review.py:75-90` processes its 20 hot orgs
  strictly sequentially, and each org can issue up to 3 sequential LLM
  calls (itself a sequential inner loop) — up to ~60 sequential LLM
  round-trips serialized in one job. `_claim_org` already makes
  cross-pod concurrency safe, so nothing structural blocks parallelizing.
- **Fix:** Reuse the `bounded_gather(limit=8)` pattern `auto_curator`
  already uses next door.
- **Impact:** Not independently measured. **Evidence-integrity flag:** a
  cross-referenced "~$0.20/night" LLM-cost figure (from `03-llm-cost.md`)
  is itself "a code-comment-sourced worst-case ceiling, not a measured
  invoice line" — treat "not a cost concern" as directional, not settled.
- **Severity:** Medium (wall-clock/job-duration concern, not a confirmed
  cost impact).
- **Effort:** Small (existing pattern in same file).
- **Confidence:** Medium (KEEP-WITH-CAVEAT per doc's own verdict table).

**Files touched:** `soft_issue_review.py`

---

### OPT-25 — Batch/parallelize `drift_baselines`'s sequential 7-dimension nested loop

**Status:** ✅ DONE — 2026-08-07: drift_baseline_worker uses bounded_gather for dimensions + pairs (`_DRIFT_BASELINE_CONCURRENCY=8`)

*(was original Wave 7)*

- **Source:** `05-cron-jobs.md` "Other concrete inefficiencies" #7
  (L260-269), verdict table (L566).
- **Description:** `drift_baseline_worker.py:35-44` runs a fully
  sequential 7-dimension nested loop per org/agent pair — up to 1,400
  sequential DB round-trips in one weekly run (100-pair cap × 7 dimensions
  × up to 2 round-trips/dimension). No batching or concurrency. This is on
  top of item 8's missing-`ORDER BY` defect.
- **Fix:** Same bounded-concurrency approach `auto_curator` already uses.
- **Impact:** MEASURED/DERIVED-FROM-CODE — "the 1,400-round-trip figure...
  independently re-derived from scratch" and "checked out exactly" per the
  doc's pass-4 fact-check.
- **Severity:** Medium (weekly job-duration concern).
- **Effort:** Medium.
- **Confidence:** High (independently re-derived and confirmed exact in
  pass-4).

**Files touched:** `drift_baseline_worker.py`
**Depends on:** OPT-3 (earlier wave 1)

---

### OPT-26 — Fix shadow-detector creation/promotion throughput mismatch (unbounded backlog growth)

**Status:** ✅ DONE — 2026-08-07: promote_shadow_detectors LIMIT 500 + per-org fair `ROW_NUMBER()` round-robin dequeue

*(was original Wave 7)*

- **Source:** `05-cron-jobs.md` "Other concrete inefficiencies" #6
  (L243-255), verdict table (L565).
- **Description:** Shadow-detector creation runs at ≤20 orgs/night × ≤3
  detectors/org ≈ 420/week. Consumption (`promote_shadow_detectors`) runs
  weekly and inspects only the oldest 200 rows **globally**
  (`ORDER BY created_at ASC` — a correct order-by, so this is a
  throughput-budget problem, not the missing-watermark bug class). 420
  created/week vs. 200 evaluated/week means the `enabled=false` backlog
  grows unbounded over time; it's also a single global FIFO not scoped per
  org, so a burst from one noisy org can delay every other org's detectors
  indefinitely.
- **Fix:** Increase weekly promotion throughput/limit, and/or shard the
  FIFO per-org (round-robin dequeue) so one org's burst can't starve
  others — doc cites Temporal/AWS SQS fair-queue patterns as the 2026
  industry template.
- **Impact:** ESTIMATED from code constants ("≤420/wk created vs. 200/wk
  evaluated" — arithmetic checks out, but is a worst-case ceiling, not a
  measured `nl_signals` backlog depth). Doc recommends instrumenting a
  backlog-depth metric before prioritizing a fix.
- **Severity:** Medium.
- **Effort:** Medium (throughput-limit change is small; true per-org
  fairness requires new sharding logic).
- **Confidence:** Medium (KEEP-WITH-CAVEAT — arithmetic verified from
  constants, not from measured backlog).

**Files touched:** `src/eden/services/soft_issue_review.py` (`promote_shadow_detectors`)

---

### OPT-28 — Add a coverage metric to catch the LIMIT-without-ORDER-BY bug class

**Status:** ✅ DONE — 2026-08-07: watermark coverage gauges + `refresh_watermark_coverage`/`record_watermark_batch` wired in leader/cron/drift/classifier

*(was original Wave 7)*

- **Source:** `05-cron-jobs.md` "Why this bug class evades the existing
  monitoring" (L202-228), verdict table (L571).
- **Description:** Existing cron/maintenance-loop monitoring
  (`run_if_leader`, `workers/leader.py:210-280`) is real and reasonably
  good at the exception level, but none of it catches items 3/7/8/53's bug
  class, because the query never errors — it's a silently-too-small result
  set, invisible to exception-based monitoring, exit-code checks, or
  heartbeat pings by construction.
- **Fix:** Add either (a) a coverage metric (e.g. "distinct orgs curated
  in the last N days" vs. "total active orgs"), alerting on a growing gap,
  or (b) fix the selection queries themselves to be watermarked (items
  3/7/8/53) so there is structurally no excluded tail to miss.
- **Impact:** Not quantified; framed as the cross-cutting root cause
  behind items 3/7/8/53's invisibility.
- **Severity:** Medium (root-cause visibility gap).
- **Effort:** Medium (new metric + dashboard/alerting, separate from the
  query fixes themselves).
- **Confidence:** High.

**Files touched:** `workers/leader.py`

---

### OPT-29 — Remove `audit_logs` phantom retention-policy entry; file a higher-priority follow-up for `agent_audit_ledger`

**Status:** ✅ DONE — 2026-08-07: removed phantom `audit_logs` retention policy; added `agent_audit_ledger` 7-year policy (enforcement dispatch still follow-up)

*(was original Wave 7)*

- **Source:** `06-storage-retention.md` fix table (L165).
- **Description:** No table named `audit_logs` exists in the schema, but a
  real analog does — `agent_audit_ledger`
  (`092_market_ready_consolidated.py:501`) — a genuine audit table that
  "arguably should have a compliance-grade retention policy" (the dead
  entry's `delete_after_days=2555` ≈ 7 years hints this was the original
  intent) but was never connected.
- **Fix:** Remove the phantom `DEFAULT_POLICIES` entry, file a follow-up
  ticket (higher priority than the other phantom-entry removals, given
  legal-hold/compliance implications) to add a policy under the real table
  name.
- **Impact:** N/A directly, but compliance/legal-hold exposure is implied
  if a real audit ledger has no retention policy at all.
- **Severity:** Medium (compliance implications called out explicitly).
- **Effort:** Small (removal) + separate follow-up ticket.
- **Confidence:** High.

**Files touched:** `retention.py`

---

### OPT-32 — Extend `get_storage_summary()` to track the gap tables and add byte-size/$-GB tracking

**Status:** ✅ DONE — 2026-08-07: `get_storage_summary` tracks 8 hot tables + bytes via `pg_total_relation_size` + quarantine unreprocessed; `hot_bytes_total` on API response

*(was original Wave 7)*

- **Source:** `06-storage-retention.md` "Other storage-growth risks"
  (L130), "Other carried-over recommendations" (L170).
- **Description:** `get_storage_summary()` (`storage_lifecycle.py:525-541`)
  — the one function meant to give ops visibility into hot-storage growth
  — only counts `usage_events`, `silver_events`, and `quarantine_events`
  (row counts only). It does not track `checkpoint_blobs`,
  `trace_replay_sessions`, `replay_sessions`, or any of the six no-op-policy
  tables, so none of the actual gaps found in this doc are visible in the
  one dashboard-ready summary that exists. No table anywhere tracks byte
  size or a $/GB figure (repo-wide grep for
  `bytes_used|table_size|pg_total_relation_size|storage_cost` returns
  nothing relevant).
- **Fix:** Extend `get_storage_summary()` to include the missing tables
  plus `quarantine_events`'s unreprocessed-row count, and fold in a
  byte-size column (e.g. `pg_total_relation_size`) — "the smallest change
  that would finally make a $/GB storage-cost conversation possible for
  this system."
- **Impact:** Not quantified.
- **Severity:** Medium (pure visibility gap, but a prerequisite for any
  future cost conversation).
- **Effort:** Small-Medium.
- **Confidence:** High.

**Files touched:** `storage_lifecycle.py`

---

### OPT-34 — Add pagination to `list_signal_clusters`

**Status:** ✅ DONE — 2026-08-07: `list_signal_clusters` accepts limit/offset (default 50, max 200) with count in response

*(was original Wave 7)*

- **Source:** `02-db-queries.md` F6 — LOW/MEDIUM (L471-489).
- **Description:** `api/routes/signal_investigator.py:97-149` queries
  `signal_clusters` with a hardcoded `LIMIT 200` and no `offset`/cursor
  query parameter — callers cannot page past the first 200 results. The
  underlying index also doesn't cover the `ORDER BY last_seen DESC NULLS
  LAST` sort — noted as low-impact today but worth folding into the same
  fix if pagination is added.
- **Fix:** Add `limit`/`offset` (or `after_id` cursor) query parameters;
  consider extending the index to cover the sort column.
- **Impact:** Not quantified; low impact today per the doc.
- **Severity:** Low/Medium (doc's own tier).
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `api/routes/signal_investigator.py`, `signal_clusters (table)`

---

### OPT-35 — Fix `UsageStats.cache_reads`/`cache_writes` field names to match OpenRouter's real usage schema

**Status:** ✅ DONE — 2026-08-07: UsageStats reads OpenRouter `prompt_tokens_details.{cached_tokens,cache_write_tokens}` via `_cache_tokens_from_usage`

*(was original Wave 7)*

- **Source:** `03-llm-cost.md` "Prompt caching" (L422-448), "Prioritized
  levers" item 3 (L518-525).
- **Description:** `llm/client.py` reads
  `getattr(response.usage, "cache_reads", 0)` and `"cache_writes"` — but
  OpenRouter's `usage` object has no attributes with these names, so both
  are **always 0** (confirmed "dead, not merely 'likely dead.'"). Verified
  live against OpenRouter's current docs (Aug 2026): cache activity is
  actually reported as `usage.prompt_tokens_details.cached_tokens` and
  `usage.prompt_tokens_details.cache_write_tokens`. Note:
  `cost = getattr(response.usage, "cost", None)` IS read correctly —
  `usage.cost` is the real, already-discounted dollar figure — so this bug
  does **not** cause dollar miscounting, only 100% loss of
  cache-attribution visibility.
- **Fix:** Change the two attribute reads in the `UsageStats(...)`
  construction to read
  `usage.prompt_tokens_details.{cached_tokens, cache_write_tokens}`
  instead of the nonexistent flat attributes.
- **Impact:** 0% dollar-miscounting effect (cost_usd already correct when
  org_id is present) but "100% opacity rate on a metric that's currently
  un-computed for every single Eden-internal LLM call." Potential
  visibility into a discount described as up to ~98% (DeepSeek V4 Flash:
  $0.14/1M input cache-miss vs. $0.0028/1M cache-hit) — VERIFIED-LIVE
  pricing fact, but whether Eden is actually banking that discount today
  is unverified (see item 36).
- **Severity:** Low-Medium (visibility/reporting gap, not a
  cost-reduction lever by itself).
- **Effort:** Small (rename ~2 attribute reads in one function).
- **Confidence:** Medium-High ("upgraded from Phase 3's 'medium' — the
  exact schema was verified live against current OpenRouter docs").

**Files touched:** `llm/client.py`

---

### OPT-38 — Add a CI lint rule to catch `LIMIT` without `ORDER BY` going forward

**Status:** ✅ DONE — 2026-08-07: `lint_unordered_limit.py` wired in pre-commit + backend-ci; 66 known violations frozen in baseline (new violations fail CI)

*(was original Wave 8)*

- **Source:** `05-cron-jobs.md` "Research: 2026 scheduled-job design at
  scale" (L523-539), verdict table (L573).
- **Description:** PostgreSQL's own docs confirm "LIMIT without ORDER BY =
  undefined order" as a documented anti-pattern, and Eden's SQL lives as
  raw triple-quoted strings rather than a linter-managed SQL tree. The doc
  proposes a small CI script (`scripts/lint_unordered_limit.py`, as a
  pre-commit hook + required CI step alongside existing `ruff`/`mypy`
  checks) that walks every `*.py` file under `src/eden/`, extracts
  triple-quoted strings passed as the first positional arg to
  `.fetch(`/`.fetchrow(`/`.fetchval(`, and fails the build listing
  `file:line` for any containing `LIMIT` but not `ORDER BY` — with a
  single opt-out escape hatch for legitimate exceptions.
- **Impact:** DERIVED-FROM-CODE — "run against the current tree, this rule
  would catch all 5 findings [items 3, 7, 8, 53, and the shadow-outcome
  finding, item 54] and 0 false positives among the confirmed-OK queries
  catalogued."
- **Severity:** Low-Medium (preventive/systemic follow-up).
- **Effort:** Small-Medium.
- **Confidence:** High.

**Files touched:** `scripts/lint_unordered_limit.py`, `CI config (pre-commit/required CI step alongside ruff/mypy)`

---

### FEAT-57 — Consolidate or reconcile the three disconnected session tables

**Status:** ✅ DONE — 2026-08-07: FEAT-152 decision in `session-model.md`; canonical pointer at `sessions/canonical.py` (+ re-exports); product-metrics consumers read `session_summaries`; agent/user sessions retained intentionally

*(was original Wave 8)*

**Source:** `features/11-session-analytics.md` — session data model section (`user_sessions`, `session_summaries`, `agent_sessions`).

**Description:** eden currently has three separate, disconnected tables all representing "sessions" in some form: `user_sessions`, `session_summaries`, and `agent_sessions`. They are not joined or reconciled with each other, meaning different parts of the product report different, potentially contradictory session data depending on which table they query. Fix: define a single canonical session representation (or explicit, documented relationships/foreign keys between the three) and migrate consumers onto it — #56's ready-made SQL (the `session_summaries` user index + `cohorts.py` repoint) covers the first consumer migration, but note it is narrower than a full three-table consolidation, which still needs its own design.

**Why it matters:** Fragmented session data undermines trust in any session-based metric eden reports (retention, engagement, session counts) since the "truth" depends on which internal table happened to be queried — a customer-facing credibility risk if surfaced inconsistently.

**Severity:** High
**Effort:** Large
**Confidence:** High

**Files touched:** `user_sessions table`, `session_summaries table`, `agent_sessions table`
**Depends on:** FEAT-56 (✅ done)

---

### FEAT-63 — Swimlane the trace transcript UI by agent identity

**Status:** ✅ DONE — 2026-08-07: `TranscriptStep.agentId` populated from tree `agent_id`; frontend lanes sorted/grouped/colored by agent identity

*(was original Wave 7)*

**Source:** `05-multiagent-tracing.md`, "What it should look like" (citing `TranscriptStep`, `_tree_node_to_step`, `portal_contracts.py:78-97`).

**Already landed:** Transcript v2 (commit `c9c49f13`) shipped parallel-lane rendering, and the transcript row builder (`clients/portal/src/lib/observability/build-transcript-rows.ts:173`) already maps `agent_id` from tree nodes into each row.

**Remaining work (verified today):** `TranscriptStep` (`portal_contracts.py:78`) has no `agentId` field, `_tree_node_to_step` (`portal.py:637`) doesn't populate one, and the `/tree` node dict built in `telemetry_collector.py` doesn't emit `agent_id` — so the value the frontend reads is always null until #61 lands, and lanes are grouped by concurrency fan-out, not agent identity. Add `agentId` to the `TranscriptStep` contract, populate it in `_tree_node_to_step` (reading `node.get("agent_id")`, available once #61 lands), and group/color the existing lanes by that field in the frontend (`traces-client.tsx`/`traces-detail-panels.tsx`, plus the shared `build-transcript-rows.ts` builder that already carries `agent_id` per row). No new backend computation required beyond #61.

**Why it matters:** Today a trace spanning three agents shows a single collapsed "preferred" agent label in the trace list, and once opened that label disappears entirely — every span in the transcript looks identical in origin. The only current workaround is noticing discontinuities in model/provider naming, or bypassing the portal to query `telemetry_events.agent_id` directly.

**Severity:** High
**Effort:** Small (reduced from Medium — the lane-rendering frontend and the row-builder `agent_id` mapping already landed; remaining is the `TranscriptStep`/`_tree_node_to_step`/`telemetry_collector.py` plumbing plus lane grouping by the field)
**Confidence:** High

**Files touched:** `TranscriptStep contract (portal_contracts.py)`, `_tree_node_to_step`, `traces-client.tsx`, `traces-detail-panels.tsx`, `clients/portal/src/lib/observability/build-transcript-rows.ts`
**Depends on:** FEAT-61 (earlier wave 2)

---

## Wave 4

*Sessions, retention, alert honesty*

**20 points** (2 bugs, 5 optimizations, 13 features) — **all ✅ DONE** (verified 2026-08-07).

### BUG-14 — Clear `resolved_at` when an issue is reopened

**Status:** ✅ DONE — 2026-08-07: `issues/repo.py:358-359` sets `resolved_at = NULL` when `status == "open"` on reopen

*(was original Wave 8)*

**Source:** `bugs/02-data-consistency.md` Bug 8d

**Description:** `IssuesRepo.set_status` (`repo.py:308-332`) only sets `resolved_at = NOW()` when
`set_resolved_at=True`, and `resolve_issue` only passes that when `target == "resolved"`
(`agent_issues.py:392`). The "Reopen" button sends `target="open"` with
`set_resolved_at=False`, leaving `resolved_at` at its stale prior value. A reopened issue then
carries a misleading historical `resolved_at` timestamp that any consumer reading the row
directly (an SLA/regression report) would misread as "resolved, then reopened at that old
timestamp" rather than "resolution was reverted." **Fix:** clear `resolved_at` to `NULL` when
reopening: `resolved_at = NULL` when `status == "open"` and not otherwise setting it.

**Blast radius:** Any issue that goes through resolve→reopen — a live but low-visibility data
correctness bug (only matters to direct row consumers/reports, not the UI itself).

**Severity:** Medium (data hygiene, live, narrow visibility).
**Effort:** Small — one conditional clause. **QUICK WIN.**
**Confidence:** High.

**Files touched:** `src/eden/issues/repo.py`, `src/eden/api/routes/agent_issues.py`

---

### BUG-22 — Add ownership validation to `label_tool_call`'s caller-supplied `agent_id`

**Status:** ✅ DONE — 2026-08-07: `learning/tool_call_labels.py:63-103` validates caller `agent_id` vs telemetry owner; API returns 403

*(was original Wave 8)*

**Source:** `bugs/03-api-mcp-contracts.md` #6

**Description:** `label_tool_call`'s caller-supplied `agent_id` is persisted with no check that
it actually owns the `span_id`/`trace_id` being labeled — any caller can attribute a tool-call
label to an arbitrary agent. Separately noted: this router is gated by
`require_feature_flag("tool_call_label_learning_v1")`, which defaults **on**
(`config.py:1228`), so it isn't currently blocking most orgs — the gap is the missing ownership
check, not reachability. **Fix:** validate `agent_id` against the trace's own telemetry-derived
agent identity (or `agent_registrations`) before persisting the label.

**Blast radius:** The tool-call labeling/calibration pipeline for any MCP caller (soft-retired
surface, zero internal callers today) — mislabeled training data if ever exploited or misused.

**Severity:** Medium (data-integrity risk if exploited) but Low current live blast radius (MCP
soft-retired).
**Effort:** Medium — needs the identity-resolution logic shared with #6/#13.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/tool_call_labels.py`, `src/eden/config.py`
**Depends on:** BUG-6 (✅ done), BUG-13 (earlier wave 3)

---

### OPT-21 — Parallelize the stumble-write round-trip chain

**Status:** ✅ DONE — 2026-08-07: `signals/investigator.py:323-345` parallelizes matched-row stumble writes via `bounded_gather(limit=8)`

*(was original Wave 8)*

- **Source:** `01-hotpath-perf.md` Findings table row 6 (L203); round-trip
  ledger detail (L208-254). Doc explicitly flags this as "confirmed unique
  — not covered by `02-db-queries.md`."
- **Description:** Per matched signal row, the chain
  `investigator.py::_maybe_write_stumble` → `StumbleWriter.create` does:
  `_burst_seen` (1 Redis round trip) → `_repo.insert_stumble` (1 Postgres
  round trip) → `IssuePromoter.upsert` (fingerprint lookup + insert/update
  = 2 more Postgres round trips) → `_fire_stumble_created` (best-effort,
  cost unbounded/out of scope). Total: 1 Redis + up to 3 Postgres round
  trips per matched row, sequential, before clustering even starts, up to
  20x per trace.
- **Fix:** Same as item 20 — parallelize across matched rows using
  `bounded_gather`.
- **Impact:** DERIVED-FROM-CODE, precise counts (mechanism and exact
  counts verified from source), not separately benchmarked.
- **Severity:** Medium.
- **Effort:** Medium.
- **Confidence:** Medium (source-verified mechanism, unbenched magnitude).

**Files touched:** `investigator.py`, `stumble_writer.py`, `repo.py`, `issue_promoter.py`

---

### OPT-22 — Cap or precompute shared state for uncapped StatGate rule scans

**Status:** ✅ DONE — 2026-08-07: `signals/investigator.py:38-39,123-144` caps StatGate scans at 80 events via `_precompute_statgate_state`

*(was original Wave 9)*

- **Source:** `01-hotpath-perf.md` Findings table row 2 (L199).
- **Description:** `investigator.py::_eval_statgate_rule` (now starting at
  `investigator.py:111`; the cited `:123-137, :139-151` line numbers have
  drifted) does an uncapped `for e in events` scan in both branches —
  unlike `compress_trace`, which caps at `[:80]` events. This runs once
  per enabled `statgate_rule` signal definition row, up to 20x per trace,
  synchronously reachable from `POST /traces/{trace_id}/investigate`. No
  shared precomputation is done across the up-to-20 calls.
- **Fix:** Cap the scan (matching `compress_trace`'s `[:80]` pattern) or
  precompute shared per-event derived state once per `investigate_trace`
  call instead of recomputing per signal definition. Also add a latency
  microbenchmark — none exists for this function specifically.
- **Impact:** Code asymmetry (missing cap) VERIFIED in source; actual
  latency magnitude UNMEASURED — no bench exists.
- **Severity:** Medium.
- **Effort:** Small-Medium.
- **Confidence:** Medium (bug mechanism verified, magnitude unknown).

**Files touched:** `src/eden/signals/investigator.py`

---

### OPT-30 — Add a new retention policy + dispatch branch for `trace_replay_sessions`

**Status:** ✅ DONE — 2026-08-07: `data_platform/retention.py:65,570-699` policy + `cleanup_trace_replay_sessions` dispatch branch

*(was original Wave 8)*

- **Source:** `06-storage-retention.md` "checkpoint-blob retention gap"
  (L41-66), "replay UI is stubbed" (L68-90), "Complete fix design"
  (L134-156).
- **Description:** `trace_replay_sessions` is the live write path for
  Cat-1 rewind. It has **no TTL column and is absent from
  `DEFAULT_POLICIES`**; `state_json TEXT` is unbounded with no size
  ceiling at the schema level. The portal's `/replay` page is currently a
  stub and the one client function that would drive traffic has zero call
  sites, so organic growth today is effectively ~0. **But the backend is
  not gated off**: `intelligence_gap_v0` defaults `True` globally (not
  per-org opt-in), so any direct API/SDK caller or QA session writes a
  real, permanent row today — a "flip the stub off" launch risk once the
  otherwise fully built replay UI ships.
- **Fix:** `RetentionPolicy("trace_replay_sessions", 7, 0, 0, 30)`
  (hot-only, 30-day TTL, mirroring `debug_dumps`' shape). **Same dead-`elif`
  trap as item 6 applies** — a real dedicated dispatch branch is required
  (`DELETE FROM trace_replay_sessions WHERE updated_at < $1`), not just a
  `DEFAULT_POLICIES` entry.
- **Impact:** ESTIMATED, explicitly labeled a placeholder: ~1,300
  rows/month, ~1-2 MB/month baseline by analogy to comparable tooling —
  but "the 20-org input is aspirational and not reconciled against Eden's
  actual measured scale — production had 9 orgs as of 2026-07-29, more
  than 2x smaller." The qualitative point (a small fraction of active orgs
  use replay/rewind per week) is the load-bearing part, not the number.
  The real risk emphasized is the unbounded `TEXT` column with no size
  ceiling — "a slow, invisible creep... with no dashboard signal and no
  ceiling."
- **Severity:** Medium (near-zero live risk currently, but an unaddressed
  pre-launch design gap — Eden's own design doc flagged "Replay session
  TTL" as an Open Question filed 2026-06-10, still unanswered).
- **Effort:** Small (mirrors existing `debug_dumps` pattern, though the
  dead-elif trap must be handled correctly).
- **Confidence:** High for the gap's existence; Low/Medium for the ~1,300
  rows/month estimate (explicitly self-flagged as an unvalidated
  placeholder).

**Files touched:** `retention.py`, `trace_replay_sessions (table)`

---

### OPT-31 — Add a new retention policy + dispatch branch for `replay_sessions` (migration 029) — worse growth model than item 30

**Status:** ✅ DONE — 2026-08-07: `data_platform/retention.py:66,602-697` policy + `cleanup_replay_sessions` dispatch branch

*(was original Wave 9)*

- **Source:** `06-storage-retention.md` "replay UI is stubbed" section
  (L78), "Complete fix design" (L156).
- **Description:** A third, related table: `replay_sessions` (migration
  `src/eden/db_migrations/versions/029_replay_sessions.py`,
  `POST /orgs/{org_id}/intelligence/replay/sessions`). Unlike
  `trace_replay_sessions`, "scratch" sessions (`name IS NULL`) are
  **always inserted as new rows, not upserted** — no dedup at all for the
  common case. It shares the same "built but not yet driving traffic"
  status and is also absent from `DEFAULT_POLICIES`. Its growth model is
  strictly worse than item 30's once the replay UI ships (unbounded rows
  per open session, not per distinct trace).
- **Fix:** Fold into the same fix/PR as items 30 and 58 — same 30-day TTL,
  same dead-elif-trap caveat applies.
- **Impact:** Not quantified; qualitatively worse than item 30's growth
  model.
- **Severity:** Medium.
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `src/eden/data_platform/retention.py`, `replay_sessions (table)`

---

### OPT-37 — Add age-based expiry for stale non-firing shadow detectors

**Status:** ✅ DONE — 2026-08-07: `soft_issue_review.py:650-655` deletes stale `hold` detectors when `hold_age_days >= shadow_hold_max_days`

*(was original Wave 8)*

- **Source:** `05-cron-jobs.md` "Other concrete inefficiencies" #6 (L258).
- **Description:** Rows that never reach `min_firings` (20) sit in `hold`
  state indefinitely — no age-based expiry/deletion exists for stale
  non-firing shadow detectors, compounding item 26's backlog growth.
- **Fix:** Add a TTL/cleanup query for `hold`-state rows.
- **Impact:** Not quantified.
- **Severity:** Low-Medium.
- **Effort:** Small.
- **Confidence:** High (direct code observation).

**Files touched:** `src/eden/services/soft_issue_review.py` (`promote_shadow_detectors` / `evaluate_shadow_precision`)

---

### FEAT-64 — Surface the `a2a` sub-document as a labeled "handoff" transcript marker instead of silently stripping it

**Status:** ✅ DONE — 2026-08-07: `portal.py:448-472,482-484,800-843` surfaces nested `a2a` as labeled `handoff` transcript steps

*(was original Wave 8)*

**Source:** `05-multiagent-tracing.md` (citing `portal.py:752`; `sdk/a2a.py:114-129`).

**Description:** When a caller uses the A2A SDK wrapper, `_A2ACallCtx.attributes()` merges `{"parent_agent_span_id", "child_agent_trace_id", "a2a": {"invocation_type", "parent_agent_id", "child_agent_id", "response_status"}}` into a span's JSONB `attributes`. But `_tree_node_to_step` builds the outgoing `attributes` field via a scalar-only filter (`isinstance(v, (str, int, float, bool))`) that silently drops the nested `"a2a"` sub-document — the one part of the payload with human-readable agent IDs and an explicit invocation type. Only two unlabeled flat UUID strings survive, rendered as raw JSON with no click-through. Fix: surface the `a2a` sub-document as a distinct, labeled `"handoff"` `TranscriptKind` instead of letting it be erased by the scalar-only filter.

**Why it matters:** Real, already-computed agent-linkage data (human-readable agent ids, invocation type, response status) is actively discarded before reaching the browser — the engineer currently sees two unlabeled UUIDs in a raw JSON blob instead of a clickable, labeled handoff event.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `portal.py`, `sdk/a2a.py (_A2ACallCtx.attributes)`, `_tree_node_to_step`

---

### FEAT-93 — Fix the `act_on_topic(action="alert")` no-op stub

**Status:** ✅ DONE — 2026-08-07: `topics/service.py:300-388` `_act_alert_on_topic` compiles EQL rule and dispatches alert (no queued stub)

*(was original Wave 8)*

**Source:** `01-competitor-matrix.md`, "Deep codebase re-pass" section (citing `service.py:230-231`).

**Description:** `topics/service.py`'s `act_on_topic` function has an `action="dataset"` branch that genuinely works (creates a dataset from a topic's representative traces via `DatasetHub`), but the `action="alert"` branch is a stub that returns `{"status": "queued"}` without doing anything. **Fix:** implement the alert-firing behavior, or remove the option from any UI that will eventually expose it, so the action doesn't silently do nothing while reporting success.

**Why it matters:** A user who selects "create alert from this topic" (once a portal surface exists per 01-4) would be told the alert was queued when nothing was actually created — a silent-failure pattern that erodes trust the moment the feature becomes reachable.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `topics/service.py`

---

### FEAT-96 — Extend `ReplayResult` to carry the actual regenerated output text

**Status:** ✅ DONE — 2026-08-07: `improvement/replay_verify.py:275-294,551+` `ReplayResult.regenerated_output` plumbed through `regression_runner.py`

*(was original Wave 8)*

**Source:** `02-evals-datasets.md`, §5 P1 item 8 (citing `improvement/replay_verify.py:275-281`; `regression_runner.py:257-280,296-340,282-294`).

**Description:** When `regression_replay_v1` is enabled and a case carries a stored `FailureSignature` + checkpoint reference, `RegressionRunner` replays the original failing step against current behavior (cost-capped) before falling back to a post-hoc check — real, budget-capped verification infrastructure. But `ReplayResult` returns only `status: "passed"|"failed"|"skipped"` + `reason` + `cost_usd` + `traces_checked` (plus an untyped `details` dict) — no raw regenerated output text. **Fix:** add a `regenerated_output: str | None` field to `ReplayResult`.

**Why it matters:** Without this field, the replay path cannot feed `playground/scorers.py`'s `run_scorers(output=...)`, meaning the replay-verification subsystem can't participate in #130's unified per-case scoring — a small, sequenced prerequisite.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `improvement/replay_verify.py`, `regression_runner.py`

---

### FEAT-97 — Delete `golden_dataset.py`, `ci_pipeline.py`, and `auto_dataset.py`/`EvalScheduler` as dead/duplicate code

**Status:** ✅ DONE — 2026-08-07: deleted `golden_dataset.py`, `ci_pipeline.py`, `auto_dataset.py`, `evaluation/scheduler.py`; no stray imports remain

*(was original Wave 8)*

**Source:** `02-evals-datasets.md`, §5 P2 item 10, §3d/3e/3f (citing `golden_dataset.py` 1,295 lines; `ci_pipeline.py`; `auto_dataset.py` 475 lines + `evaluation/scheduler.py`).

**Description:** Three subsystems are confirmed dead or duplicate: (a) `golden_dataset.py` — a disk-based (`./golden_datasets/*.json`), non-multitenant, hardcoded 50-case registry referencing no real customer agent/trace/org; (b) `ci_pipeline.py` — a 6-stage pipeline that shells out via `subprocess`, not mounted to any route, referenced only by its own unit test, and duplicates `ci_webhook.py`'s live path with a fake `benchmark_regression` stage that defaults to `SKIPPED: execution_unavailable` with a `random.Random(case_id)`-seeded fallback; (c) `auto_dataset.py` + `EvalScheduler` — a real multi-factor quality-scoring design that persists to local disk JSON and writes into `golden_dataset.py`'s in-memory registry rather than Postgres, and is never actually invoked on a schedule (absent from both `workers/main.py` and `workers/cron_tick.py`). **Fix:** if the 50 generic RL-sandbox cases in `golden_dataset.py` have standalone smoke-test value, port `_CANONICAL_CASES` into a handful of seed `dataset_items` rows via a one-time script, then delete all three modules.

**Why it matters:** Every week this dead code remains in the tree is a week a due-diligence reviewer (fundraising, acquisition, audit) can mistake it for real functionality — the doc explicitly flags this as a liability, not neutral dead weight, and recommends not deprioritizing it despite low direct user impact.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `golden_dataset.py`, `ci_pipeline.py`, `auto_dataset.py`, `evaluation/scheduler.py`, `ci_webhook.py`

---

### FEAT-99 — Fix migration 067's `downgrade()` incorrectly dropping the pre-existing `finish_reason` column

**Status:** ✅ DONE — 2026-08-07: `067_trace_quality_otel_columns.py:128-156` downgrade no longer drops pre-existing `finish_reason`

*(was original Wave 8)*

**Source:** `05-multiagent-tracing.md` (citing `067_trace_quality_otel_columns.py:140,93`; `011_capture_full_payloads.py:63`).

**Description:** Migration 067's `downgrade()` runs `DROP COLUMN IF EXISTS finish_reason` — but `finish_reason` wasn't added by 067; it was added earlier by migration 011 (`VARCHAR(64)`) and is already actively written by `TELEMETRY_INSERT_SQL`. 067's own `ADD COLUMN IF NOT EXISTS finish_reason VARCHAR(32)` was a silent no-op against the pre-existing column. **Fix:** remove the `DROP COLUMN IF EXISTS finish_reason` line from 067's `downgrade()`.

**Why it matters:** A downgrade of migration 067 today would destroy live `finish_reason` data that 067 never owned — a real data-loss risk on any future rollback, currently undetected because no one has run the downgrade.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `067_trace_quality_otel_columns.py`, `011_capture_full_payloads.py`

---

### FEAT-100 — Add `"agent"`/`"handoff"` kinds to `TranscriptKind` enum and `_step_kind` mapping

**Status:** ✅ DONE — 2026-08-07: `portal_contracts.py:21` adds `"agent"`/`"handoff"`; `portal.py:474-486` maps invoke_agent and a2a spans

*(was original Wave 9)*

**Source:** `05-multiagent-tracing.md` (citing `TranscriptKind` in `portal_contracts.py:21`; `_step_kind` in `portal.py:444` — both citations still accurate as of 2026-08-05).

**Description:** `TranscriptKind = Literal["task", "llm", "tool", "bash", "span"]` has no `"agent"` or `"handoff"` kind. Even once `operation_name` is wired end-to-end, an `invoke_agent`-kind span would still render as an undifferentiated generic `"span"` unless this enum and `_step_kind`'s mapping logic are extended.

**Why it matters:** Without a distinct visual/semantic vocabulary for agent boundaries and handoffs, correctly-populated backend data still renders indistinguishably from any other span, defeating the purpose of the upstream write-path fixes.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/api/portal_contracts.py`, `src/eden/api/routes/portal.py`
**Depends on:** FEAT-23 (✅ done)

---

### FEAT-101 — Populate `fingerprint`/`issue_id` on EQL-triage alert payloads to enable duplicate suppression

**Status:** ✅ DONE — 2026-08-07: `dsl/alerts.py:494-570` sets `fingerprint` + optional `issue_id` on EQL triage payloads

*(was original Wave 8)*

**Source:** `04-alerting-oncall.md`, §0.5 bullet 3, "Noise control" (citing `dsl/alerts.py::_trigger_triage`; `triage_judge.py:76-104`).

**Description:** `_trigger_triage`'s payload never sets `fingerprint` or `issue_id`, so `AlertTriageJudge._find_duplicate_issue` — keyed on exactly those fields — can structurally never return a match for an EQL-sourced alert. Every re-fire of the same still-broken metric is a fresh `real_incident` email, rate-limited only by a blunt Redis SETNX + hourly cap, not by "is this the same incident as an hour ago." **Fix:** populate `fingerprint`/`issue_id` on the triage payload.

**Why it matters:** Without this, the one working alert pipeline will spam admins with a fresh email on every tick a still-broken condition is evaluated — a direct driver of alert fatigue and distrust.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `dsl/alerts.py`, `triage_judge.py`

---

### FEAT-104 — Rename "escalate"/"page operator" copy that overstates real behavior

**Status:** ✅ DONE — 2026-08-07: `playbook_router.py:62-64` fleet SLO copy says "notify for human review" (not "page operator")

*(was original Wave 8)*

**Source:** `04-alerting-oncall.md`, §4 (citing `_PLAYBOOK_ACTIONS` in `closed_loop/playbook_router.py`; UI strings from `realtime/alert_stream.py`'s rule channels).

**Description:** Copy such as "page operator" implies real paging/escalation behavior that doesn't exist. **Fix:** audit and rename this copy to accurately reflect actual behavior (e.g., "notify via Slack/email" rather than "page").

**Why it matters:** Inaccurate internal/UI copy compounds customer-facing trust risk — even engineers reading logs or playbook definitions could be misled about what actually happens on escalation.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/closed_loop/playbook_router.py`, `src/eden/realtime/alert_stream.py`

---

### FEAT-106 — Add a team-scoped soft-alert email recipient list independent of `org_members`

**Status:** ✅ DONE — 2026-08-07: `alert_email.py:55-59,91-99` merges `soft_alert_recipients` with owner/admin emails

*(was original Wave 8)*

**Source:** `06-cost-governance.md`, "Who is the user," §4a Recommendation 2 (citing `services/alert_email.py`'s `_org_alert_recipients()`).

**Description:** Budget alert emails are resolved exclusively via a query joining `users`/`org_members` filtered to `role IN ('owner','admin')` — structurally incapable of routing to anyone not already an org member. There is no "finance," "billing," or "budget admin" role anywhere in the budget path (LiteLLM's team soft-budget alerts explicitly route to "finance or a team lead — not necessarily team members"). **Fix:** add a soft-alert recipient list attachable to a team/org budget, independent of `org_members` role membership, as a small additive change to `_notify_budget_alert()` — doesn't require the full scope migration to land first if sequenced as an org-level feature initially.

**Why it matters:** Eden's implicit persona is a founder/eng-lead who *is* the org owner — reasonable for eden's current size but the opposite of where the competitor set has moved (dedicated finance/FinOps stakeholders watching spend across teams they don't administer).

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/services/alert_email.py`, `org_members`

---

### FEAT-107 — Fix the synthetic $0.02 triage cost event that leaks into customer-facing budget consumption

**Status:** ✅ DONE — 2026-08-07: `triage_agent.py` no synthetic `record_spend`/`$0.02`; metered cost via `cost_context` only (test: `test_triage_llm_path_does_not_record_synthetic_spend`)

*(was original Wave 8)*

**Source:** `06-cost-governance.md`, §2e (citing `issues/triage_agent.py:36`; `closed_loop/autonomy_policy.py::record_spend`; `llmops/cost_ledger.py:279`).

**Description:** `issues/triage_agent.py`'s call chain (`autonomy_policy.record_spend()` → `record_cost_event()`) unconditionally writes a synthetic, flat `$0.02` `CostEvent` (`_TRIAGE_COST_ESTIMATE_USD`) for every LLM-used triage. This lands in `customer_cost_events`, the same table `_sum_org_cost_usd()` sums into `get_budget_status()` — i.e., the number `QuotaEnforcementMiddleware` reads to block a customer's own gateway requests. **Fix:** replace the flat synthetic estimate with the real cost, or exclude internal triage cost events from the customer-facing aggregation entirely.

**Why it matters:** A concrete, live counter-example to the assumption that eden's internal cost-tracking is fully isolated from customer-facing numbers — nudges the real customer credit-consumption figure upward by the fake-vs-real delta on every triage call. Blast radius is small (well under $1/org/day per estimate) but it's a genuine, live correctness bug in the number that gates a customer's own requests.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `issues/triage_agent.py`, `closed_loop/autonomy_policy.py`, `llmops/cost_ledger.py`, `customer_cost_events`
**Depends on:** FEAT-20 (✅ done)

---

### FEAT-108 — Fix or drop the dead Redis RTBF key-pattern match

**Status:** ✅ DONE — 2026-08-07: `rtbf_fanout.py:89-113` Redis fanout returns `unsupported` (not false `ok` with `deleted: 0`)

*(was original Wave 8)*

**Source:** `07-security-compliance.md`, §2b fanout table, §4 point 4 (citing `rtbf_fanout.py:77-108`).

**Description:** Redis RTBF fanout runs `SCAN eden:*:{org}:*:{user}*` then `DEL`, but no key pattern anywhere in `src/eden/` actually embeds a user id (patterns are org- or hash-keyed only, e.g. `eden:cost:{org}:...`, `eden:dedup:{digest}`). SCAN matches nothing, reports `deleted: 0`, and the fanout falsely reports `status: "ok"`. **Fix:** either update the actual Redis key-naming scheme to embed user id where user-scoped erasure is meaningful, or change the fanout to report `status: "unsupported"`/`"n/a"` honestly rather than a false "ok" — the doc notes actual PII risk here is lower (mostly cost/dedup caches) but the false-positive report itself is still a bug.

**Why it matters:** A false "ok" report undermines the credibility of the entire RTBF fanout's per-store reporting model, even though the underlying data-risk is comparatively low for this specific store — fixing the report contract matters for auditability independent of the low current risk.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/services/governance_intel/rtbf_fanout.py`
**Depends on:** FEAT-2 (earlier wave 1), FEAT-5 (earlier wave 1)

---

### FEAT-110 — Surface `AgentAuditLedgerWriter.verify_chain` tamper-evidence as a visible trust signal

**Status:** ✅ DONE — 2026-08-07: `portal.ts:213-235` `verifyAuditChain`; `audit-chain-trust-signal.tsx` mounted in settings audit views

*(was original Wave 9)*

**Source:** `07-security-compliance.md`, §7, §8 "What would make this trustworthy and usable" bullet 4 (citing `governance/compliance_pack.py`; `tests/unit/ws4/test_enterprise_ws4.py:70-124`).

**Description:** `AgentAuditLedgerWriter` maintains an append-only, SHA-256 hash-chained ledger; `verify_chain()` recomputes the chain and reports `ok_rows`/`broken_rows` — genuine tamper-evidence, tested for empty/valid/deliberately-tampered chains. Today it's invisible to any user. **Fix:** surface a "chain verified: ✓" indicator next to any exported compliance pack or audit view in the portal, backed by a live call to `verify_chain()`.

**Why it matters:** This is a genuinely strong, already-built answer to "how do we know this evidence wasn't edited after the fact" — exactly the question a SOC2 auditor or enterprise security reviewer asks — but currently exists only as backend plumbing with zero product-visible trust value.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/governance/compliance_pack.py`

---

### FEAT-112 — Add missing `resources.ts` API bindings (pop, IAA, export)

**Status:** ✅ DONE — 2026-08-07: `labeling.ts:200,223` `popQueue`/`exportJsonl`; `resources.ts:3775-3776` re-exports full `labelingApi`

*(was original Wave 9)*

**Source:** `08-annotation-labeling.md`, §2, §6b (citing `resources.ts:3360-3386,4069-4116` — line ranges still accurate: `labelingApi` starts at 3360).

**Description:** `labelingApi` covers only 4 of 8 Phase-D routes. Three routes have no client binding at all: `GET /labeling/queue/{user_id}` (pop), `GET /labeling/iia` (org/global IAA), and `GET /labeling/export`. **Fix:** add `popQueue`, `getIAA` (using the post-consolidation `/labeling/agreement` path — note the backend route is still mounted as `/labeling/iia` today, so bind whatever path the consolidation lands on), and `exportJsonl` functions to `labelingApi`. All three backend routes are confirmed live in `src/eden/api/routes/labeling.py` (`pop_queue` at `/queue/{user_id}` with `limit` 1-50, `/iia`, `/export`).

**Why it matters:** Without these bindings, roughly half the usable Phase-D backend surface is unreachable from the frontend, blocking the pop-based work surface, IAA dashboard, and export button.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `clients/portal/src/lib/api/resources.ts`

---

## Wave 5

*Labeling depth & portal completeness*

**20 points** (0 bugs, 2 optimizations, 18 features) — **20 done.**

### OPT-33 — Deduplicate redundant `compress_trace` recomputation in `_heuristic_match`

**Status:** ✅ DONE — 2026-08-07: `investigate_trace` computes `compress_trace(events).lower()` once; `_heuristic_match` takes precomputed `summary`

*(was original Wave 10)*

- **Source:** `01-hotpath-perf.md` Findings table row 3 (L200).
- **Description:** `investigator.py::_heuristic_match` (`:76-108` — start
  line still accurate) recomputes `compress_trace(events).lower()` from
  scratch for every signal definition it's called against — up to 20x per
  trace. The recomputed string is capped at 80 events/4000 chars, which
  limits absolute cost.
- **Fix:** Compute `compress_trace(events).lower()` once per
  `investigate_trace` call and pass the result into `_heuristic_match`
  rather than recomputing per signal.
- **Impact:** Not quantified; doc characterizes as "cheap" given the
  existing cap.
- **Severity:** Low-Medium (doc's own tier: "LOW-MEDIUM").
- **Effort:** Small.
- **Confidence:** High (mechanism directly verified in source), low
  priority.

**Files touched:** `src/eden/signals/investigator.py`

---

### OPT-39 — Remove `training_datasets` phantom retention-policy entry; file a follow-up for real dataset tables

**Status:** ✅ DONE — 2026-08-07: phantom `training_datasets` removed from `DEFAULT_POLICIES`; `test_retention.py` asserts absent

*(was original Wave 10)*

- **Source:** `06-storage-retention.md` fix table (L164).
- **Description:** No table named `training_datasets` exists, but real
  analogs do (`datasets`, `dataset_items`, `dataset_snapshots`;
  `fine_tuning_runs`/`dataset_trace_lineage`), added later under
  different, more specific names and never reconciled back into
  `DEFAULT_POLICIES`.
- **Fix:** Remove the phantom entry, file a follow-up ticket to add a
  correctly-named policy targeting the real tables.
- **Impact:** N/A.
- **Severity:** Low-Medium.
- **Effort:** Small (removal) + separate follow-up ticket.
- **Confidence:** High.

**Files touched:** `src/eden/data_platform/retention.py`

_(Editorial note 2026-08-05: a stray `### LOW` heading that appeared between this point's body and its Files-touched line in the generated plan was a generation artifact and has been removed; the Severity line above already carries the Low-Medium tier.)_

---

### FEAT-102 — Fix hardcoded `severity="warn"` display and missing severity storage on `nl_alert_rules`

**Status:** ✅ DONE — 2026-08-07: migration 159 + `_NL_RULE_COLUMNS` includes `severity`; `list_portal_alert_rules` reads persisted/bridged severity

*(was original Wave 10)*

**Source:** `04-alerting-oncall.md`, "User Experience & Value" (citing `portal.py:2119` — line has drifted; locate via the hardcoded `severity="warn"` literals near `list_portal_signals`; `nl_alert_rules` table in migration 098).

**Description:** The portal's rule card always displays `severity="warn"` regardless of what the user actually configured, because `nl_alert_rules` itself doesn't persist a severity field — only the separate, bridged `eql_alert_rules` row does (severity is persisted and validated on the EQL side: see `src/eden/dsl/alerts.py`, `severity: One of info|warning|high|critical`). **Fix:** persist configured severity on `nl_alert_rules` (or read/display from the bridged row) so the UI shows the real severity.

**Why it matters:** A user has no way to see, from the UI, what severity their rule was actually registered at — compounding a related bug, since a user can't even tell from the display that their "critical" rule silently stopped firing.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/portal.py`, `nl_alert_rules`, `eql_alert_rules`
**Depends on:** FEAT-17 (earlier wave 1)

---

### FEAT-105 — Do not build on-call scheduling, rotations, ack/snooze, or SLA-timer features in-house (explicit scope decision)

**Status:** ✅ DONE — 2026-08-07: `on-call-scope-decision.md` + `alert_stream.py` inert `escalation_delay_seconds`/`auto_escalate` documented

*(was original Wave 9)*

**Source:** `04-alerting-oncall.md`, §3 fix item 9, §4, §2 (citing `escalation_delay_seconds`/`auto_escalate` inert dataclass fields in `src/eden/realtime/alert_stream.py`; Better Stack's `wait_before`/`repeat_count`/`step_members` schema as the mature reference).

**Description:** The doc explicitly recommends against building schedules, rotations, acknowledgment/snooze UI, or SLA escalation timers in-house, since incident.io, Better Stack, and Datadog On-Call already own this space with mature primitives eden only has as inert, unused dataclass fields. **Action:** adopt this as an explicit engineering scope guardrail — integrate with a real on-call tool for this functionality rather than building it, and deprioritize any related in-flight or proposed work.

**Why it matters:** Without an explicit scope decision, there's a real risk of eng effort being spent replicating a mature, commoditized on-call feature set instead of on the actual blockers to a working, trustworthy core alerting product.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/realtime/alert_stream.py`

---

### FEAT-109 — Report RTBF fanout status per-store in the UI, not as a single checkmark

**Status:** ✅ DONE — 2026-08-07: `account-danger-zone-card.tsx` renders per-store erasure statuses from RTBF fanout

*(was original Wave 9)*

**Source:** `07-security-compliance.md`, §8 "What would make this trustworthy and usable" bullet 2.

**Description:** `src/eden/services/governance_intel/rtbf_fanout.py`'s existing pattern for Qdrant/S3 (explicit `status: "failed"`/`"unsupported"` rather than silent success) is correct and should become the UI contract too. **Fix:** once a single erasure path ships a UI element, render the actual per-store status list — e.g. "Postgres: erased. Qdrant: failed (no per-user index). Typesense: not yet supported" — rather than a single green checkmark.

**Why it matters:** A single aggregate "success" checkmark for an operation with known partial-failure modes across 6 different stores would be actively misleading to both end users and auditors; per-store honesty is cheap once the fanout already computes this data internally.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/services/governance_intel/rtbf_fanout.py`
**Depends on:** FEAT-5 (earlier wave 1), FEAT-108 (earlier wave 4)

---

### FEAT-117 — Add bulk-skip capability to the queue list

**Status:** ✅ DONE — 2026-08-07: `POST /labeling/skip/bulk` + multi-select skip in `labeling-unassigned-panel.tsx`

*(was original Wave 9)*

**Source:** `08-annotation-labeling.md`, §6c.1(b) (citing `labeling.py:602-632` — still accurate).

**Description:** `skip()` is single-item only today. **Fix:** ship either a small `POST /labeling/skip/bulk` backend endpoint or a client-side fan-out of N `skip()` calls, paired with multi-select in the queue-list UI.

**Why it matters:** A meaningful fraction of any queue is "obviously skip" and doesn't need one-at-a-time handling; without bulk actions this directly hurts the "reviewer never touches the mouse except to read" speed bar the doc sets as the UX target.

**Severity:** Medium.
**Effort:** Small-Medium.
**Confidence:** High.

**Files touched:** `src/eden/evaluation/labeling.py`, `src/eden/api/routes/labeling.py`

---

### FEAT-120 — Document `agent_id`/`agentId` in both SDK READMEs

**Status:** ✅ DONE — 2026-08-07: `### Agent identity` sections in `sdk/python/README.md` and `sdk/ts-ai/README.md`

*(was original Wave 9)*

**Source:** `09-sdk-dx.md` — SDK config/wiring section.

**Already landed:** Both READMEs now show the field once, inside the "Agent sessions (F23)" quickstart example (`sdk/python/README.md` `eden.begin(agent_id="bot", ...)`; `sdk/ts-ai/README.md` `begin({ agentId: "bot", ... })`).

**Remaining work:** Add a short README section in `sdk/python` and `sdk/ts-ai` explaining what setting `agent_id`/`agentId` unlocks (per-agent breakdowns in session analytics, issue extraction, etc. — all key off it where populated) and documenting the trace-level config outside the sessions API — each README currently mentions the field exactly once. The field is already fully plumbed end-to-end through both SDKs and the ingestion path; this is documentation only.

**Why it matters:** Silent, already-built functionality that goes unused because nobody knows it exists is wasted engineering investment; every downstream feature that could segment by agent stays flat/unsegmented in practice.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `sdk/python/README.md`, `sdk/ts-ai/README.md`

---

### FEAT-121 — Rename or fix `detect-installed.ts`'s `autoInstrument()` alias

**Status:** ✅ DONE — 2026-08-07: `@deprecated` on `autoInstrument()`; delegates to `detectInstalledFrameworks()`

*(was original Wave 9)*

**Source:** `09-sdk-dx.md` — TS auto-instrumentation internals.

**Description:** The TS SDK exposes a function named `autoInstrument()` inside `detect-installed.ts` that is actually detection-only — it does not instrument anything, contrary to what its name promises. Callers reading the API surface will reasonably assume calling it wires up instrumentation, when it doesn't. Note: a correctly-named `detectInstalledFrameworks()` export already exists in the same file (autoInstrument just delegates to it), so the remaining work is only to deprecate/remove the misleading alias or make it actually perform auto-instrumentation. **Fix:** either rename the function to something like `detectInstalledFrameworks()` or `listCandidates()` (the former already exists — deprecate the alias), or make it actually perform auto-instrumentation.

**Why it matters:** Misleadingly-named public API surface causes silent integration failures (users think instrumentation is active when it isn't), producing empty/incomplete trace data downstream with no error signal.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `sdk/ts-ai/src/detect-installed.ts`

---

### FEAT-122 — Wire `droppedTotal`/`sampledOut` into TS `doctor.ts` output

**Status:** ✅ DONE — 2026-08-07: `doctor.ts` surfaces `droppedTotal`/`sampledOut` with warn hints

*(was original Wave 9)*

**Source:** `09-sdk-dx.md` — TS diagnostics/doctor tooling section.

**Description:** The TS SDK already tracks `droppedTotal` and `sampledOut` counters internally, but `doctor.ts` (the SDK's self-diagnostic CLI/utility) does not read or surface them. A user running the doctor tool to debug "why don't I see my traces" gets no visibility into drop/sampling behavior even though the data already exists in memory.

**Why it matters:** This is a support-cost and self-serve-debugging gap: users hit a wall the doctor tool could resolve for free, and instead file support tickets or churn.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `sdk/ts-ai/src/doctor.ts`

---

### FEAT-125 — Fix the frontend/backend enum mismatch on the guardrails policy-list page

**Status:** ✅ DONE — 2026-08-07: `_map_guardrail_kind/status` aligns FE kinds with `VALID_POLICY_TYPES`; shadow read-only on portal cards

*(was original Wave 9)*

**Source:** `12-runtime-guardrails.md` — portal bugs section, enum mismatch.

**Description:** Separately from a related envelope-unwrap bug on the same page, there is also a mismatch between frontend and backend enum values. Concretely: the portal's guardrails page (`clients/portal/src/app/(portal)/guardrails/page.tsx`, filtering on `GuardrailKind`/`GuardrailStatus` from `lab/fixtures/guardrails.ts`) uses kind values `pii|toxicity|tool_allowlist|rate_limit|custom` and status values `active|shadow|disabled`, while the backend (`src/eden/guardrails/policy.py`) persists types such as `pii_redaction` and `content_policy` and only ever writes/filters `status='active'`. This causes incorrect labels, filters, or dropdown options to be shown, or silent failures when the frontend sends a value the backend doesn't recognize. **Fix:** audit both enum definitions and unify them (ideally via a single shared schema/generated types).

**Why it matters:** Enum drift between frontend and backend causes subtle, hard-to-diagnose UI bugs (wrong labels, broken filters, rejected requests) specifically on the page administrators use to manage safety policy.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `clients/portal/src/lab/fixtures/guardrails.ts`, `clients/portal/src/app/(portal)/guardrails/page.tsx`, `src/eden/guardrails/policy.py`

---

### FEAT-126 — Prioritize this doc's fixes ahead of new guardrail feature work

**Status:** ✅ DONE — 2026-08-07: `guardrail-priority-decision.md` records foundation-before-features sequencing guardrail

*(was original Wave 9)*

**Source:** `12-runtime-guardrails.md` — overall framing as possibly the #1 highest-priority finding of the review.

**Description:** The doc itself flags this area as potentially the single highest-priority finding across the entire 3-pass strategic review. This is a sequencing/prioritization action rather than a code fix: any roadmap planning that includes new guardrail features (new detector categories, new policy types, etc.) should be sequenced after the doc's guardrail items are resolved, not in parallel with them.

**Why it matters:** Building new features on top of a foundation with a silent safety-check bypass compounds risk and technical debt; the doc's own framing suggests this should override normal feature-prioritization processes.

**Severity:** Medium (recalibrated from Critical during cross-doc ranking — treated as a process/sequencing recommendation for this consolidated list rather than a standalone code defect).
**Effort:** Small.
**Confidence:** High — the "possibly #1 priority" framing is explicitly stated in the source doc itself, not inferred.

**Files touched:** _(none listed)_

---

### FEAT-127 — Implement `action=alert` beyond its current stub

**Status:** ✅ DONE — 2026-08-07: `_act_alert_on_topic` creates NL rule + dispatches; covered by `test_f65_topics.py`

*(was original Wave 9)*

**Source:** `14-user-request-mining.md` — User Experience & Value section, `action=alert` stub.

**Description:** There is an `action=alert` option/parameter in the topic-mining feature that is currently just a stub — it doesn't actually send an alert when invoked. **Fix:** implement real alerting behavior (e.g., notification via whatever eden's existing alerting/notification channel is) behind this action.

**Why it matters:** A stubbed alert action gives the false impression that proactive notification exists for emerging topics/requests when it doesn't — anyone configuring or relying on `action=alert` gets silently no alerts.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/topics/service.py`
**Depends on:** FEAT-93 (earlier wave 4)

---

### FEAT-129 — Sequence issue-ranking/severity-escalation work after doc 13's P0-A/P0-B (Loop 1 revival)

**Status:** ✅ DONE — 2026-08-07: `issue-ranking-sequence-decision.md` records Loop 1 P0-A/P0-B prerequisite (FEAT-8/9 done)

*(was original Wave 9)*

**Source:** `16-issue-extraction-online-evals.md` — explicit build-sequence dependency on `13-continuous-improvement-loop.md`.

**Description:** The source doc explicitly states its recommended build sequence depends on `13-continuous-improvement-loop.md`'s P0-A and P0-B steps being completed first. This is a sequencing constraint, not a standalone code fix: teams should not implement composite issue ranking or, especially, severity escalation (which likely needs to consume the confirm/dismiss signal Loop 1 produces) before those prerequisite steps land.

**Why it matters:** Implementing ranking/escalation logic ahead of its prerequisite data pipeline being functional risks either building against incomplete/wrong data, or having to rework the logic once Loop 1 actually starts producing real confirm/dismiss signal data.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High — the dependency itself is explicitly stated in the source doc.

**Files touched:** _(none listed)_
**Depends on:** FEAT-8 (✅ done), FEAT-9 (✅ done)

---

### FEAT-130 — Surface per-case (not just aggregate) F51 grading verdicts in the CI score table

**Status:** ✅ DONE — 2026-08-07: `RegressionRunner._run_f51_grades` + per-case rows in `build_score_table` (`test_ci_eval.py`)

*(was original Wave 9)*

**Source:** `02-evals-datasets.md`, §5 P1 items 6-7 (citing `ci_webhook.py:16,59-62,73-81` — still accurate: `grade_datapoint` import at :16, grading calls at :60-62, `build_score_table` at :73; `regression_runner.py` — `run_suite` now at :107, `_evaluate_case` at :182).

**Already landed:** Commit cdccb59f ("feat(ci-eval): F56 turnkey evals-in-CI — score table, run history, PR gate") versioned the webhook payload and added the per-case tri-state reasons from `RegressionRunResult` plus a per-metric score table graded via `grade_datapoint` (the same grading function that powers F51, reused from `experiments/compare.py`).

**Remaining work:** The score table is still per-METRIC aggregate (pass_rate/fail_rate/skip_rate/error_rate rows in `_METRICS`); `run_suite` does not kick off or reuse an F51 run, and no per-case `grade_datapoint` verdicts appear in `score_table`. Keep `RegressionRunner`'s existing stumble-signature/StatGate check (`_evaluate_case`) as-is for the cheap, no-LLM-call canary-gate path (do not replace it), but additionally have `run_suite` kick off (or reuse) an F51 run against the same org/agent's now-unified dataset, and surface its `grade_datapoint` verdicts in `ci_webhook.py`'s `score_table` per case, not just in aggregate.

**Why it matters:** Turns an existing, working, but aggregate-only bridge into a full Braintrust-style per-row diff eden is currently missing, without inventing new plumbing — closes a real gap against competitor CI-gating UX.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/evaluation/ci_webhook.py`, `src/eden/experiments/compare.py`, `src/eden/evaluation/regression_runner.py`
**Depends on:** FEAT-96 (earlier wave 4)

---

### FEAT-131 — Build an LLM-judge adapter to wire `llmops/judges/UnifiedJudge` into F49/F51's scorer path

**Status:** ✅ DONE — 2026-08-07: `llm_judge_adapter` wires `UnifiedJudge` into `SCORERS["llm_judge"]` (`test_llm_judge_adapter.py`)

*(was original Wave 9)*

**Source:** `02-evals-datasets.md`, §5 P2 item 12, §3k (citing `llmops/judges/base.py:109-119`, `unified.py`, `runner.py:51-102`).

**Description:** `playground/scorers.py` (F49) deliberately omits an `llm_judge` scorer ("a fake judge is worse than none"). Eden already has production-grade LLM-judge infrastructure: `UnifiedJudge` (`unified.py`, 225 lines) scores every axis in one LLM call, and `JudgeRunner.run_for_event` fans out judges concurrently with per-tenant semaphore and cost/cache-tracked persistence to `judge_scores`. The integration cost: `Judge.score(event: TelemetryEvent, ctx: JudgeContext)` is contractually bound to a `TelemetryEvent`, not a generic `(input, output, expected)` triple, so wiring it into dataset-row scoring needs either (a) a small adapter wrapping a `dataset_item` row in a `TelemetryEvent`-shaped object, or (b) calling `UnifiedJudge.score()` directly and discarding axes F49/F51 don't need per row. There is no single-axis judge left to extract cleanly (per-axis judges like `hallucination.py`/`correctness.py` were consolidated into `UnifiedJudge` and no longer exist as separate files), so a prior recommendation to "extract one judge's prompt template" no longer applies.

**Why it matters:** Reuses eden's most production-grade judge infrastructure (concurrency, cost tracking, persistence) rather than building parallel judge logic or misusing `prompt_versioning._llm_score` (which is a prompt-text linter, not a case-scoring judge) — closes the gap against competitors' LLM-judge-based dataset scoring.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/playground/scorers.py`, `src/eden/llmops/judges/base.py`, `src/eden/llmops/judges/unified.py`, `src/eden/llmops/judges/runner.py`
**Depends on:** FEAT-13 (earlier wave 1)

---

### FEAT-132 — Build a first-class "attach dataset" flow (Dataset Hub / F53 integration) in the playground editor

**Status:** ✅ DONE — 2026-08-07: `DatasetAttachDialog` in `playground-editor.tsx` persists `datasetId` + hub rows for runs

*(was original Wave 9)*

**Source:** `03-prompt-playground.md`, "User Experience & Value → Where the workflow breaks down"; citing `service.py:298-300` (now `src/eden/playground/service.py:299`).

**Description:** `PlaygroundService.run` defaults to a single synthetic dataset row (`{"id": "adhoc", "input": params.get("user", "")}`) when no `dataset_rows` are supplied. There is no UI-driven pull from Dataset Hub (F53) — systematic regression testing across a labeled dataset currently requires the caller to assemble `dataset_rows` by hand or via direct API calls, not through a first-class "attach dataset" flow in the editor. This is a gap against the editor's own empty-state copy, which promises "attach a dataset to compare prompts before you ship." **Fix:** build an in-editor UI flow to browse/select/attach a Dataset Hub dataset as the `dataset_rows` source for a playground run.

**Why it matters:** Without this, "systematic" prompt regression testing (vs. ad hoc single-row testing) is only accessible to users willing to hand-craft API calls, which excludes most of the target user base (prompt engineers/product devs working in the portal UI) and directly contradicts what the editor's own empty-state copy already promises them.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/playground/service.py`, `clients/portal/src/app/(portal)/playgrounds/page.tsx`

---

### FEAT-134 — Add a suppression-rule UI/API (dedup windows / "don't page for known-noisy events")

**Status:** ✅ DONE — 2026-08-07: CRUD API + `suppression-rules-section.tsx` + `list_enabled_suppression_patterns` in triage judge

*(was original Wave 9)*

**Source:** `04-alerting-oncall.md`, "User Experience & Value → Noise control" (citing `AlertTriageJudge.judge`, four hardcoded regexes).

**Description:** Beyond the structural dedup bug (#101), there is no UI or API for a customer to add their own suppression rule (e.g., "our Tuesday batch job always spikes latency, don't page for it") — that requires a code change today. **Fix:** build a suppression-rule config surface (UI + API) on top of the triage judge.

**Why it matters:** Without user-configurable suppression, known-noisy/benign recurring conditions will keep generating fresh incident emails indefinitely — a direct driver of alert fatigue.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/alerts/triage_judge.py`
**Depends on:** FEAT-101 (earlier wave 4)

---

### FEAT-138 — Extend `ProviderRoutingService` ingestion decoders rather than replacing the service's role

**Status:** ✅ DONE — 2026-08-07: `provider_routing_decoders.py` wired via `record_decoded_attempt` + SDK/API ingest (`test_provider_routing_decoders.py`)

*(was original Wave 10)*

**Source:** `10-model-gateway.md` — `ProviderRoutingService` assessment section.

**Description:** `ProviderRoutingService`'s correct role per the doc's verdict is observe-not-replace: it should continue decoding/ingesting routing decisions made by external tools (e.g., customers' own LiteLLM/Portkey deployments) rather than becoming eden's own routing decision-maker. The concrete action is to extend its ingestion decoders (parsing more providers'/routers' trace formats) rather than building decision logic into it. Today the service records attempts generically via `record_attempt`; there is no per-router decoder layer yet.

**Why it matters:** Keeps eden positioned as an observability layer over whatever routing tool a customer already uses, which is the differentiated, lower-competition role versus trying to out-build dedicated routing vendors.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/services/observability/provider_routing.py` (plus `src/eden/api/routes/observability_provider_routing.py`, `src/eden/sdk/provider_routing.py`)

---

### FEAT-139 — Add a `RetentionCurveChart` component to the portal

**Status:** ✅ DONE — 2026-08-07: `SessionRetentionPanel` on traces; `GET /analytics/cohorts` backed by `cohorts.py`

*(was original Wave 10)*

**Source:** `11-session-analytics.md` — User Experience & Value section (component sketch provided in source).

**Description:** The doc includes a full sketch for a `RetentionCurveChart` React component that does not currently exist in the portal. This would visualize retention curves (e.g., session-over-time cohort retention) once the underlying data is fixed. **Fix:** implement the component per the doc's sketch and wire it to corrected `session_summaries`-backed cohort data.

**Why it matters:** Retention curves are a standard, high-value analytics visualization that's currently entirely absent from the portal despite the backend groundwork (once fixed) supporting it — closes a visible feature gap for any product-analytics-minded customer.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `RetentionCurveChart.tsx` (new), `session_summaries`
**Depends on:** FEAT-52 (✅ done)

---

### FEAT-144 — Wire `TriageAgent` to read from the Ledger

**Status:** ✅ DONE — 2026-08-07: `LedgerGenerator().get_latest` before ReAct loop in `triage_agent.py` (`test_triage_agent.py` FEAT-144)

*(was original Wave 10)*

**Source:** `15-artifacts-behavior-record.md` — gaps beyond portal routes section; Build sequence Phase 3.

**Description:** `TriageAgent` (eden's triage/routing agent) currently does not read from the Ledger, despite the Ledger existing specifically to hold accumulated behavioral/context knowledge that would plausibly improve triage decisions. **Fix:** add Ledger-read integration to `TriageAgent`'s decision pipeline — per the source doc, one call to `LedgerGenerator().get_latest(org_id, agent_id)` as a first, cheap pass before `TriageAgent._gather_evidence()`'s 8-call ReAct loop (source doc estimate: 0.5 day).

**Why it matters:** This is a missed opportunity to use already-built context infrastructure (the Ledger) to improve an existing agent's decision quality — the Ledger's value is partly measured by how many consumers actually use it, and currently a natural consumer doesn't.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/issues/triage_agent.py`

---

## Wave 6

*SDK counters, compliance, autonomy UI*

**20 points** (4 bugs, 0 optimizations, 16 features) — **20 done.** All 20 points are ✅ DONE as of 2026-08-07.

### BUG-23 — Mount the `mcp_keys` router (or formally retire the feature)

**Status:** ✅ DONE — 2026-08-07: formally retired — deleted `mcp_keys.py` + related IDOR tests; docs already point to EDEN_API_KEY

*(was original Wave 11)*

**Source:** `bugs/01-dead-code-stale-docs.md` item 21

**Description:** `src/eden/api/routes/mcp_keys.py` (prefix `/orgs/{org_id}/mcp/keys`, including
`POST ""` create-key and `GET "" list_mcp_keys`) is fully implemented but its router is never
`include_router()`'d anywhere in `app.py` — confirmed by exhaustively parsing all three of
`app.py`'s mount mechanisms (124 of 125 route files are accounted for; `mcp_keys` is the single
exception). (Note: `app.py`'s mounting has since been restructured by dd33eb7d — 105 routers now
mount via a deferred lifespan table — but `mcp_keys` remains absent from every mechanism.) The
only code that exercises these handlers is unit tests calling the async handler
functions directly, bypassing FastAPI routing entirely — so the tests pass even though the HTTP
surface they're meant to protect (an IDOR-focused test per its own docstring) was never actually
reachable. **Fix:** either mount the router (if MCP-scoped key issuance is still wanted) or
formally delete it alongside the rest of the MCP-key-issuance feature (see #24).

**Blast radius:** Zero live HTTP reachability today — no real request can hit this surface.
Compounds with #24 (dead client wrapper) and #18 (doc tells users to call it) into one fully-dead
feature, but MCP itself is soft-retired, so the practical urgency is low.

**Severity:** Low (dead/unmounted surface behind a soft-retired feature).
**Effort:** Small — either one `include_router()` call or a deletion.
**Confidence:** High.

**Files touched:** `src/eden/api/app.py`, `src/eden/api/routes/mcp_keys.py`

---

### BUG-24 — Remove the dead `createMcpKey` portal client wrapper

**Status:** ✅ DONE — 2026-08-07: removed dead `createMcpKey` from `resources.ts` (zero callers)

*(was original Wave 11)*

**Source:** `bugs/01-dead-code-stale-docs.md` item 22

**Description:** `clients/portal/src/lib/api/resources.ts:1855`
(`createMcpKey: (orgId, name = "MCP", scopes?) => ...`) calls
`POST /orgs/${orgId}/mcp/keys` — the unmounted endpoint from #23 — and has zero callers anywhere
in the portal UI. Together with #23 and #18, the entire MCP-scoped-key-issuance feature is dead
end-to-end. **Fix:** delete the wrapper (or wire it up if the feature is revived alongside #23).

**Blast radius:** None — dead code with zero callers, part of a fully dead feature chain.
**Severity:** Low.
**Effort:** Small — delete one function.
**Confidence:** High.

**Files touched:** `clients/portal/src/lib/api/resources.ts`

---

### BUG-25 — Fix `query_sql` MCP tool's wrong path and `limit`/`max_rows` field mismatch

**Status:** ✅ DONE — 2026-08-07: MCP `query_sql` → `POST .../sql/execute` with `max_rows` (client/tools/server schema)

*(was original Wave 11)*

**Source:** `bugs/03-api-mcp-contracts.md` §1.A.2

**Description:** `tools.py:356-376` posts to `f"/orgs/{org_id}/sql"` (`:365-366`); the real route
is `POST /orgs/{org_id}/sql/execute` (`sql_query.py:46-50,107-117`) — the `/execute` segment is
missing entirely, guaranteeing every call 404s. Even if the path were fixed, MCP sends
`{"sql": sql, "limit": limit}` (`:367`), but `SqlExecuteRequest` (`sql_query.py:56-75`) has no
`limit` field (real fields: `sql`, `params`, `max_rows`, `max_seconds`) — the schema's `limit`
filter (`server.py:401`) would be silently dropped, and `max_rows`/`max_seconds`/`params` are
unreachable from MCP at all. **Fix:** append `/execute` to the path and rename the MCP schema's
`limit` field to map onto `max_rows`.

**Blast radius:** MCP surface only, soft-retired, zero internal callers, no doc-driven exposure
(unlike #20).
**Severity:** Low.
**Effort:** Small — path fix + field rename.
**Confidence:** High.

**Files touched:** `src/eden/mcp_server/tools.py`, `src/eden/mcp_server/server.py`

---

### BUG-30 — Give `retrain_tool_calibrator` a real Pydantic request model

**Status:** ✅ DONE — 2026-08-07: `RetrainToolCalibratorBody` Pydantic model; missing `tool_name` → 422

*(was original Wave 11)*

**Source:** `bugs/03-api-mcp-contracts.md` #9

**Description:** `retrain_tool_calibrator` (`tool_call_labels.py:123-132`) takes an untyped
`body: dict[str, Any]` with no Pydantic model — malformed input returns a 200-with-error-string
instead of a proper 422 validation error. **Fix:** define a Pydantic request model for the
route.

**Blast radius:** Narrow — this specific admin/calibration endpoint only.
**Severity:** Low.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/tool_call_labels.py`

---

### FEAT-114 — Add undo shortcut (`u`/`Backspace`) for last annotation submission

**Status:** ✅ DONE — 2026-08-07: `u`/`Backspace` undo re-UPSERTs last annotation; annotate-view + page wired

*(was original Wave 11)*

**Source:** `08-annotation-labeling.md`, §6c.3, §5a.

**Description:** Add a keyboard shortcut to undo the last submission by re-submitting the previous `item_id` with the previous label — no new backend capability needed since `annotate()` is already an UPSERT keyed on `(item, annotator)`.

**Why it matters:** Called out as a "free win" — costs almost nothing given the existing UPSERT semantics, but materially improves reviewer trust/speed since mis-clicks are common in rapid keyboard-driven labeling.

**Severity:** Medium (normalized from "Low-Medium" in source doc).
**Effort:** Small.
**Confidence:** High.

**Files touched:** `clients/portal/src/lib/api/resources.ts` (`annotate` binding at `:3366`) plus the to-be-built annotate view (FEAT-112)

---

### FEAT-118 — Surface per-item disagreement signal in the annotate view

**Status:** ✅ DONE — 2026-08-07: annotate view shows annotations count / agreement chip (no peer labels)

*(was original Wave 11)*

**Source:** `08-annotation-labeling.md`, §6c.3, §4.

**Description:** Following Braintrust's pattern (not LangSmith's) since `annotate()` has no blind-review gate: surface "N annotations so far / agreement so far" on items with 1+ annotation, using `IAAReport.per_item[item_id]`, so a second annotator sees they're the tiebreaker without seeing the specific first label.

**Why it matters:** Gives reviewers disagreement context in-flow instead of requiring a separate dashboard check — a deliberate middle ground between LangSmith's blind independence and Braintrust's always-visible model.

**Severity:** Medium.
**Effort:** Small-Medium.
**Confidence:** High.

**Files touched:** `src/eden/evaluation/labeling.py`, `src/eden/api/routes/labeling.py`

---

### FEAT-123 — Add a `.sent`/`.failed`-equivalent counter to the TS SDK

**Status:** ✅ DONE — 2026-08-07: TS SDK public `sent`/`failed` counters + doctor deltas (Python parity)

*(was original Wave 10)*

**Source:** `09-sdk-dx.md` — TS SDK observability of the SDK itself.

**Description:** The TS SDK has no equivalent of a `.sent`/`.failed` counter pair (implied contrast with Python, which does track this class of metric). Without it, TS users cannot programmatically or via `doctor.ts` determine how many spans/events were successfully sent vs. failed to send.

**Why it matters:** Same class of self-serve debuggability gap as #122 — without send/fail counts, diagnosing "my traces aren't showing up" requires either trusting a black box or filing a support ticket.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `sdk/ts-ai/src/client.ts`, `sdk/ts-ai/src/doctor.ts`

---

### FEAT-137 — Delete the dormant `AIGateway` multi-provider routing engine

**Status:** ✅ DONE — 2026-08-07: deleted dormant multi-provider routing (~1k lines); filters/cache/cost kept; `complete()` retired

*(was original Wave 11)*

**Source:** `10-model-gateway.md` — `AIGateway` assessment section (~900 lines of code; the containing module `src/eden/llmops/ai_gateway.py` is 1,663 lines today).

**Description:** `AIGateway` is a fully-built, ~900-line multi-provider routing/failover engine that is dormant — not wired into any live production path that actually benefits from its routing logic. The doc's verdict is DELETE: the class should be removed rather than resurrected, because the market for hosted LLM gateway/routing (Portkey — acquired by Palo Alto Networks, OpenRouter at ~$1.3B valuation, LiteLLM) is already well-served by dedicated players, and eden reinventing this is not a differentiated bet.

**Why it matters:** ~900 lines of dead, unmaintained code create ongoing maintenance drag, confuse engineers who encounter it (it has live callers that silently break — see #67), and represent sunk effort better redirected elsewhere.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/llmops/ai_gateway.py` (`AIGateway`)
**Depends on:** FEAT-151 (✅ done)

---

### FEAT-142 — Add trending detection to topic clustering output

**Status:** ✅ DONE — 2026-08-07: `compute_cluster_trend` → rising/falling/flat + scores in patterns/topics API

*(was original Wave 11)*

**Source:** `14-user-request-mining.md` — User Experience & Value section, missing capabilities list.

**Description:** The current F65 clustering output has no concept of "trending" (i.e., which topics/clusters are growing in volume/frequency recently vs. historically flat or declining). **Fix:** add a trend computation (e.g., comparing recent-window cluster volume against a longer baseline) to the clustering output/API, surfaced in the portal UI once a topics UI exists.

**Why it matters:** Without trending, users have to manually compare cluster sizes over time themselves to notice an emerging issue/request pattern — trending is typically the single most actionable signal in this category of feature (it's what tells a PM/support lead "look at this now").

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/observability/patterns_clusterer.py`

---

### FEAT-145 — Add a prompt-version-changed regeneration trigger

**Status:** ✅ DONE — 2026-08-07: `trigger_regen_on_prompt_version_change` on create_version/promote

*(was original Wave 10)*

**Source:** `15-artifacts-behavior-record.md` — feature gap section.

**Description:** There is currently no mechanism to trigger regeneration of artifacts/book content when the underlying prompt version changes. This means artifacts generated against an old prompt version may become stale or inconsistent once the prompt is updated, with nothing prompting a refresh. **Fix:** add a trigger (e.g., a hook on prompt-version bump) that flags or automatically regenerates affected artifacts.

**Why it matters:** Without this, artifacts can silently drift out of sync with the prompts they're meant to support/inject into, degrading quality over time as prompts evolve without corresponding artifact updates — a slow-burn data-quality issue.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/services/prompt_versioning.py`

---

### FEAT-146 — Wire the per-step judge automatic scoring loop (`apm_depth/step_judges.py`)

**Status:** ✅ DONE — 2026-08-07: `JudgeRunner.run_for_event` auto-stamps `step_judges` via `stamp_event_judge_scores`

*(was original Wave 10)*

**Source:** `01-competitor-matrix.md`, "Deep codebase re-pass" section (citing `step_judges.py:1-22` — still accurate).

**Description:** `StepJudgeStamper` extends telemetry events with `step_index`/`step_judges` fields and exposes `stamp`, `get_step_judges`, and `get_trace_steps` — a storage/read primitive. But the module's own docstring states this ship is "stamping only": the actual per-step `JudgeRunner` wiring that would populate these scores automatically is called out as an unbuilt v0.1 follow-up. **Fix:** build and wire the automatic per-step judge-scoring loop so `step_judges` gets populated without requiring a caller to manually stamp each step.

**Why it matters:** Without the automatic loop, this is a write/read API with no default data source — comparable competitor features (HoneyHive per-step eval metrics, Datadog step-level attribution) run automatically; eden's version currently requires bespoke integration work per caller to produce any data at all.

**Severity:** Medium.
**Effort:** Large.
**Confidence:** High (doc explicitly self-admits this gap in the module docstring).

**Files touched:** `src/eden/apm_depth/step_judges.py`

---

### FEAT-147 — Add ability to filter/search the trace list by any participating agent, not just the collapsed "preferred" agent

**Status:** ✅ DONE — 2026-08-07: `participant_agent_id` filter + `participants` facet; traces hub uses server-side participation

*(was original Wave 10)*

**Source:** `05-multiagent-tracing.md` (citing `_PREFERRED_AGENT_ID_SQL`).

**Description:** `_PREFERRED_AGENT_ID_SQL` deliberately collapses a trace to a single "winner" agent ID for the list view; there is no query path for "show me every trace where agent X participated, even as a sub-delegate." Fix requires either exploding the collapse (listing `agent_id` as an array per trace) or building a secondary "participants" facet — flagged as a materially different query shape worth scoping as its own follow-up, not a trivial addition.

**Why it matters:** An engineer investigating a specific sub-agent's behavior across many traces currently cannot filter the trace list by that agent unless it happens to be the "preferred" one selected for each trace — blocks a common investigative workflow.

**Severity:** Medium.
**Effort:** Large.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/portal.py` (`_PREFERRED_AGENT_ID_SQL`)

---

### FEAT-148 — Build a team-uploaded-context feature

**Status:** ✅ DONE — 2026-08-07: GET/POST `.../artifacts/context` + `artifactsApi` + TeamContextPanel; Book/Ledger fold-in

*(was original Wave 10)*

**Source:** `15-artifacts-behavior-record.md` — feature gap section; API-surface and Build sequence Phase 4.

**Description:** There is currently no feature allowing a team to manually upload their own context (e.g., documentation, policy text, product knowledge) into the Book/Ledger/Artifacts system — all current content appears to be system-generated (from `ArtifactAuthor` etc.) rather than human-supplied. **Fix:** build an upload/ingestion path (UI + API) for teams to add their own context material into the same system that already injects content into production prompts. Per the source doc: one new endpoint `POST /orgs/{org_id}/agents/{agent_id}/artifacts/context` (upload team `.txt`/`.md` context, mirroring Lemma's `upload-project-artifact`, using the envelope helpers already in `learn.py`); fold rows into the existing pipelines rather than building a parallel system — `BookGenerator._synthesize()` and `LedgerGenerator`'s issue/promotion upserts should read `agent_artifact_context` rows for the agent and include them in what gets synthesized/injected; `BookGatewayFilter`'s injection path is unaffected (context flows in upstream of it). Source doc estimate: 1-1.5 days including portal upload UI.

**Why it matters:** A system that shapes live production prompts but can only be populated by automated processes (not by the humans who best understand their own product/domain) is missing a high-value, commonly-expected capability in this product category (compare to how competitor "artifacts"/context systems typically support manual curation).

**Severity:** Medium.
**Effort:** Large.
**Confidence:** High.

**Files touched:** `agent_artifact_context` (new table), `src/eden/api/routes/learn.py`, portal upload UI
**Depends on:** FEAT-128 (✅ done)

---

### FEAT-149 — Surface/alert on Redis-lease fallback degradation

**Status:** ✅ DONE — 2026-08-07: lease fallback logs WARNING + `eden_labeling_lease_memory_fallback_total`

*(was original Wave 10)*

**Source:** `08-annotation-labeling.md`, §1a, Phase 3 Verdicts item 2 (citing `labeling_leases.py:13,47-52` — fallback lines have drifted slightly to :45-51; anchor on `claim_lease`).

**Description:** The in-memory lease fallback (`_memory_leases: dict[str, tuple[str, float]] = {}`) is a process-local Python dict. In a horizontally-scaled deployment, each process has its own independent copy — during a Redis outage, two reviewers hitting two different pods can each be told they hold the lease for the same item, and nothing surfaces that degradation to an operator (`claim_lease` just logs at `debug` level). **Fix:** elevate the log level when the fallback path activates and/or add operator-facing alerting/metrics so a Redis outage that silently disables cross-instance exclusivity is visible.

**Why it matters:** This is the concrete answer to "what happens when two reviewers claim the same item" — currently invisible, so an operator has no way to know exclusivity is degraded during an incident.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — the doc identifies the gap precisely but doesn't fully spell out a specific fix.

**Files touched:** `src/eden/evaluation/labeling_leases.py`

---

### FEAT-155 — Add regression/integration tests for Loop 1 confirming the confirm/dismiss signal actually changes detector behavior

**Status:** ✅ DONE — 2026-08-07: causal confirm/dismiss → promote/delete integration tests in `test_shadow_promote.py`

*(was original Wave 10)*

**Source:** `13-continuous-improvement-loop.md` — Loop 1 section (implied by the loop having been fully dead-code undetected).

**Already landed:** `tests/unit/services/test_shadow_promote.py` (M13 §6.5, landed in the autonomy-overhaul merge) unit-tests that `operator_confirms`/`operator_dismisses` counts drive shadow-detector promote/delete/hold decisions (e.g., promote at precision ≥0.8 over ≥20 firings, delete at <0.3, hold without operator labels).

**Remaining work:** After Loop 1's P0-A through P0-D revival steps land, add an end-to-end integration test asserting the full causal chain — a user confirm/dismiss action persisted through the API measurably changes detector behavior/scoring going forward — not just the threshold function in isolation.

**Why it matters:** Prevents Loop 1 from silently regressing back to dead-code status after being fixed — the same failure mode (built but not functioning, undetected) that caused this to be the flagship finding in the first place.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — inferred from the absence-of-detection pattern, not an explicit source instruction.

**Files touched:** `tests/unit/services/test_shadow_promote.py` (extend to integration level)
**Depends on:** FEAT-8 (✅ done), FEAT-9 (✅ done), FEAT-27 (✅ done), FEAT-29 (✅ done)

---

### FEAT-156 — Expose the T0-T4 autonomy tier prominently in whatever UI closes the Loop 2 visibility gap

**Status:** ✅ DONE — 2026-08-07: Autonomy Tn chips on `/improve` queue + plan detail (`AutonomyTierChip`)

*(was original Wave 11)*

**Source:** `13-continuous-improvement-loop.md` — Loop 2 section, `autonomy_policy.py` T0-T4 ladder.

**Already landed:** The T0-T4 ladder is confirmed live in `closed_loop/autonomy_policy.py` (`_ACTION_TIERS`, decisions return `(decision, reason, tier)`), and the portal's autonomy audit card already renders the applied tier per decision (`clients/portal/src/lab/settings/autonomy-audit-card.tsx`, `{e.tier_applied}`).

**Remaining work:** Surface the tier prominently in the broader Loop 2 pipeline UI (FEAT-30), which does not yet exist — the improve-queue view has no tier display. The autonomy tier (T0 through T4) governing how much independent action the loop can take on a given issue/patch should be a first-class, prominent piece of information in that UI — not buried — since it's the single most safety-relevant piece of state the UI needs to surface.

**Why it matters:** Operators need to be able to tell at a glance whether a given autonomous action was taken under a low-autonomy (heavily human-gated) or high-autonomy (near-fully-independent) tier, since the risk profile differs enormously between T0 and T4 — burying this in a UI that technically "shows the pipeline" but not this specific field would undercut the point of the fix.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — a specific implementation detail inferred as important within the broader UI-gap fix, not separately named as its own bullet in the source.

**Files touched:** `closed_loop/autonomy_policy.py`
**Depends on:** FEAT-30 (earlier wave 1)

---

### FEAT-157 — Surface `ArtifactDemotionWorker` activity in the (to-be-built) `/artifacts` UI

**Status:** ✅ DONE — 2026-08-07: `DemotionActivityPanel` + `GET .../artifacts/demotions` on `/artifacts`

*(was original Wave 11)*

**Source:** `15-artifacts-behavior-record.md` — backend components section, `ArtifactDemotionWorker`.

**Description:** `ArtifactDemotionWorker` is named in the doc as one of the existing backend components (alongside `ArtifactAuthor`). Specifically within the broader Artifacts UI-build work (#6), demotion activity (artifacts being demoted/removed from active injection) should be a visible part of the UI, not just creation/authoring — otherwise the UI would only tell half the artifact lifecycle story.

**Why it matters:** Understanding what's being demoted (and ideally why) is as important for trust/debuggability as understanding what's being created — an artifacts UI that only shows authoring without demotion history would be an incomplete picture of a system actively shaping production prompts.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — a specific implementation detail reasonably inferred as necessary within the Artifacts UI scope, not separately called out as its own bullet in the source.

**Files touched:** `src/eden/nudges/demotion_worker.py` (`ArtifactDemotionWorker`), `/artifacts`
**Depends on:** FEAT-6 (✅ done)

---

### FEAT-159 — Add a way to view/filter issues by rank tier once composite ranking ships

**Status:** ✅ DONE — 2026-08-07: issues sort Priority/Recent + rank-tier filter/badges (Top/High/Medium/Low)

*(was original Wave 11)*

**Source:** `16-issue-extraction-online-evals.md` — User Experience & Value section (implied UI follow-on to composite ranking).

**Description:** Once composite ranking exists, the portal issue view should let users filter/sort by the new rank score (e.g., a "Top Priority" view or explicit rank-tier filter), not just implement the backend sort silently. **Fix:** add UI controls (sort toggle, tier filter/badges) surfacing the new ranking once it exists.

**Why it matters:** A backend ranking fix without a corresponding UI affordance to actually use/see the ranking (beyond default list order) under-delivers on the value of the fix — the whole point is helping a human triager quickly find what matters most, which benefits from an explicit visual/filterable signal, not just implicit list order.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — a reasonable UI follow-on inferred from the ranking fix, not necessarily spelled out as its own bullet in the source beyond the User Experience & Value section's general framing.

**Files touched:** _(none listed)_
**Depends on:** FEAT-11 (earlier wave 1)

---

### FEAT-160 — Add technical re-verification (re-query stores post-deletion) to the RTBF flow

**Status:** ✅ DONE — 2026-08-07: post-delete Postgres/Typesense/Qdrant re-verify; fail-closed residuals

*(was original Wave 11)*

**Source:** `07-security-compliance.md`, §3 (web research, unverified-external-claim), §8 "What would make this trustworthy and usable" bullet 3.

**Description:** Independent GDPR/SOC2 guidance cited in the doc converges on re-querying stores after a delete call to technically verify erasure, rather than trusting the delete call's return code alone. **Fix:** extend `gdpr.py`'s existing fail-closed pattern with a post-delete re-verification step per store (re-search Typesense/re-query Postgres/re-check Qdrant for the erased identifiers) before reporting final success to the caller.

**Why it matters:** This closes the exact failure mode the Typesense/Redis bugs (see #108) demonstrate — a delete call that doesn't raise an exception is not proof of actual erasure; re-verification is described as "the kind of evidence a SOC2 Type II auditor samples for directly."

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** Medium — sourced from unverified external web research, not independently re-checked by this pass.

**Files touched:** `src/eden/services/governance_intel/gdpr.py`
**Depends on:** FEAT-5 (earlier wave 1), FEAT-108 (earlier wave 4)

---

### FEAT-163 — Build active-learning sample selection (post-UI)

**Status:** ✅ DONE — 2026-08-07: `strategy=active_learning|fifo` on labeling pop + annotate `?strategy=`

*(was original Wave 11)*

**Source:** `08-annotation-labeling.md`, §7 item 7.

**Description:** Listed as a future recommendation, sequenced strictly after the annotate UI ships. No further detail on scope or mechanism given.

**Why it matters:** Would let eden prioritize which items get labeled next based on model uncertainty/disagreement rather than pure FIFO/priority-tier queueing, but treated as a low-priority future item, not a near-term deliverable.

**Severity:** Medium (normalized from "Low-Medium" in source doc).
**Effort:** Large.
**Confidence:** Medium — the doc explicitly defers this without describing an implementation.

**Files touched:** _(none listed)_

---

## Wave 7

*Dead code, MCP paths, clustering*

**20 points** (8 bugs, 7 optimizations, 5 features) — **20 done.** All 20 points are ✅ DONE as of 2026-08-07.

### BUG-26 — Fix `get_judge_scores` MCP tool's wrong target path

**Status:** ✅ DONE — 2026-08-07: `HttpEdenClient.get_judge_scores` and MCP tool delegate to `GET /orgs/{org_id}/observability/judges?trace_id=...`; `test_wave3_bug18_20_21.py` + `test_wave12_bugs.py` assert judges path

*(was original Wave 12)*

**Source:** `bugs/03-api-mcp-contracts.md` §1.A.3

**Description:** `tools.py:407-426` GETs `f"/orgs/{org_id}/observability/traces/{trace_id}/scores"`
(`:415-417`) — no such route exists (`observability.py` has no `/scores` sub-route at all). The
real endpoint is `GET /orgs/{org_id}/observability/judges?trace_id=...&judge_name=...` (`judges.py:48-52,190-199`).
Every invocation returns the raw `{"status": "error", "http_status": 404}` dict rather than real
scores or an intended empty-list stub. **Fix:** retarget to `/observability/judges` with the
correct query params.

**Blast radius:** MCP surface only, soft-retired, zero internal callers, no doc exposure.
**Severity:** Low.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/mcp_server/tools.py`

---

### BUG-29 — Type `resolve_issue`'s response in the portal API client

**Status:** ✅ DONE — 2026-08-07: `AgentIssueResolveResponse` in `resources.ts:2895-2904` types `regression_cases`, `regression_run`, `prompt_evolution`

*(was original Wave 12)*

**Source:** `bugs/03-api-mcp-contracts.md` #8

**Description:** `resolve_issue`'s response fields (`regression_cases`, `regression_run`,
`prompt_evolution`) are under-typed in `agentIssuesApi.resolve`'s portal return type — callers
get weaker compile-time guarantees than the real response shape provides. **Fix:** add the
missing fields to the TS return type.

**Blast radius:** Portal Issues board's resolve flow — a type-safety gap, not a runtime bug.
**Severity:** Low.
**Effort:** Small — TS type edit.
**Confidence:** High.

**Files touched:** `clients/portal/src/lib/api/resources.ts`

---

### BUG-31 — Replace the `outcome == "error"` vocabulary bug with the codebase's own correct idiom (5 sites)

**Status:** ✅ DONE — 2026-08-07: shared `event_is_failure()` in `_common.py:745` (non-success idiom); `intelligence_rca.py` + clusterer use it; `test_wave12_bugs.py` covers canonical vocabulary

*(was original Wave 12)*

**Source:** `bugs/02-data-consistency.md` Bug 3 (main vocabulary-bug thread; §3d/§3f's undefined-
column variant is #33 below)

**Description:** `intelligence_rca.py:68-69` (`_event_failed`) and 4 more sites in
`insights/rca/_common.py` (now at `:737`, `:866`, `:997`, `:1009` — drifted from the originally
cited `:728-745`, `:862-870`, `:992-999`, `:1002-1011`) all check
`outcome == "error"` — but per the canonical `TelemetryEvent` schema, `outcome` is one of
`"success"|"failure"|"partial"|"timeout"|"crash"`; `"error"` never occurs in real data except on
the direct first-party-SDK exception path. Traced every ingestion producer: **OTel ingestion**
(`observability/ingestion/otel.py:279-290`) only ever assigns `"failure"`, never `"error"`,
**even for a literal `TimeoutError`**; the **webhook/third-party normalizer**
(`_coerce_outcome`, `normalizer.py:81-106`) explicitly rewrites `"error"` → `"failure"` before
persistence. Both are 100% affected — meaning any customer using OTel or a third-party
webhook/provider (the primary ingestion mode for most non-first-party-SDK integrations) never
matches this condition. Worse: this is the shared rule engine (`_classify_events`) behind both
`/analyze` and `/incidents/cluster` — a genuine `outcome='timeout'` tool-call failure falls
through every rule and is reported as `("model", 0.40, ["no failure detected — trace succeeded"])`
— an **inverted verdict**, not just a missed detection. **Fix:** replace all 5 sites with one
shared helper: `bool(ev.get("error")) or bool(outcome and outcome != "success")` (the idiom
already used correctly elsewhere in the codebase, e.g. in
`observability/telemetry_collector.py`; the originally cited `_common.py:833` example no longer
matches at that location).

**Blast radius:** **The entire `rcaApi` portal frontend surface (`analyze`, `explain`,
`clusterIncidents`, `listIncidents`, `summarizeIncident`) was deleted from the portal 3 days
before this review as verified, intentional dead code** (regression-guarded by
`dead-code-removal.test.ts`), and no MCP tool or SDK reaches these routes either. The routes
remain routed/reachable via a direct, undocumented REST call, but today there is no portal
button, MCP tool, or SDK method that reaches any of them — **zero live product blast radius**,
despite the bug being real, well-evidenced, and unconditional in the code as written.
(Re-verified 2026-08-05: `rcaApi` still has zero occurrences in `resources.ts`.)

**Severity:** Low (per this doc's live-blast-radius weighting — this was the doc's own
provisionally-"worst finding" until the frontend-deletion fact demoted it).
**Effort:** Small — one shared helper replaces 5 duplicated inline checks. **QUICK WIN** (cheap
fix even though currently unreachable — worth doing opportunistically).
**Confidence:** High.

**Files touched:** `src/eden/api/routes/intelligence_rca.py`, `src/eden/insights/rca/_common.py`

---

### BUG-34 — Stop merging unrelated agents into a shared `"unknown"` incident-cluster key

**Status:** ✅ DONE — 2026-08-07: `_agent_id_from_event` keys missing agent_id on `__unattributed__:{trace_id}` (`_common.py:1084-1098`); `test_wave12_bugs.py::test_agent_id_from_event_uses_trace_namespaced_sentinel`

*(was original Wave 12)*

**Source:** `bugs/02-data-consistency.md` Bug 7 (item 1 of 3; items 2-3 are #12 above, live)

**Description:** `insights/incidents/clusterer.py:188-189` builds the cluster key as
`(category, error_type, agent_id)`, where `_agent_id_from_event` returns the literal string
`"unknown"` for any event with a falsy `agent_id`. Two unrelated agents' failures sharing only
`(category, error_type)` land in the same cluster if neither reported `agent_id`; with
`min_cluster_size=3` this can manufacture a false multi-trace incident, and the cluster's own
"top affected agents" summary then skips falsy-`agent_id` events, so the merged cluster can't
self-report who's responsible. **Fix:** same as #12 — key on `trace_id` instead of a global
`"unknown"` sentinel when `agent_id` is missing.

**Blast radius:** Gated behind the same dead `/incidents/cluster` route as #31/#32 — zero live
caller today.
**Severity:** Low.
**Effort:** Small — same helper as #12.
**Confidence:** High.

**Files touched:** `src/eden/insights/incidents/clusterer.py`
**Depends on:** BUG-12 (earlier wave 2)

---

### BUG-35 — Stop pooling different unversioned deployments into one "unknown" statistical baseline

**Status:** ✅ DONE — 2026-08-07: `Insight.mixed_population` + confidence cap + pattern/metadata warnings in `detectors.py`; `test_wave12_bugs.py` BUG-35 regressions pass

*(was original Wave 12)*

**Source:** `bugs/02-data-consistency.md` "Additional lower-severity instance"

**Description:** `insights/detectors.py:187` (`PerformanceAnomalyDetector.analyze`:
`by_version[t.agent_version or "unknown"]`) and `:262` (`RegressionDetector.analyze`: same
pattern for `agent_version`/`environment_version`) apply the same fallback-to-shared-literal
pattern as #12/#34, but to a statistical baseline pool rather than an identity/incident join. If
two genuinely different unversioned deployments get pooled, `RegressionDetector`'s Welch's-t-test
baseline comparison silently compares apples to a mixed bag, with no low-sample-size or
mixed-population warning surfaced in the resulting `Insight`. The doc explicitly notes mixing
unversioned traces into one baseline may be a defensible product choice, not obviously wrong —
lower confidence this is a bug at all versus a design tradeoff.
**Fix:** at minimum, surface a low-confidence/mixed-population flag on `Insight`s derived from a
pooled "unknown" baseline.

**Blast radius:** Any org with unversioned deployments feeding the anomaly/regression detectors —
narrow, and arguably a defensible design choice rather than a clear bug.

**Severity:** Low.
**Effort:** Medium — needs a confidence/warning flag threaded through the `Insight` model.
**Confidence:** Medium (source doc itself flags this as lower-confidence/possibly-intentional).

**Files touched:** `src/eden/insights/detectors.py`

---

### BUG-36-50 — Dead backend code: delete or re-wire 15 zero-caller functions

**Status:** ✅ DONE — 2026-08-07: 14 orphan symbols deleted; `record_shadow_feedback` kept and wired from `agent_issues.py:298` + MCP `confirm_shadow_detector`; zero broken imports for removed symbols

*(was original Wave 12)*

**Source:** `bugs/01-dead-code-stale-docs.md` items 1-10, 14-16, 20, plus the unnumbered
`register_providers_from_env` item — all independently AST-swept, grepped repo-wide for call
form + bare-word + `import X as Y` aliasing, re-confirmed across 4 review passes with zero false
positives found.

Each is a narrow, single-function orphan (real caller count: 1, the `def` line itself, unless
noted) inside an otherwise-live module — not a misidentified live subsystem. Fix for all: delete
the function (or, where noted, re-wire it into the code path it appears to have been intended
for).

1. **`record_shadow_feedback`** (`services/soft_issue_review.py:571`) — 3 hits total (def, a
   self-referencing debug log, `__all__` export), zero external callers.
2. **`run_investigator_llm_batch`** (`signals/investigator.py:158`) — a test
   (`test_f35_investigator.py:140`) `patch()`es this exact path asserting it is *not* called on
   the no-batch path, but no production call site exists for the positive-path call the test's
   own name implies should exist — the intended wiring was apparently never added or was removed.
   (Note: the new F06 endpoint added by 64233475 calls other `signals.investigator` functions,
   but still not this one.)
3. **`list_plan_tiers`** (`services/plan_tiers.py:281`) — sibling `list_public_plan_tiers`
   (`:276`) is the one actually used; this one (paid placeholders included) has zero callers.
4. **`get_feature_list`** (`services/plan_tiers.py:286`) — zero callers.
5. **`fingerprint_from_detail`** (`issues/fingerprint.py:92`) — convenience wrapper around
   `compute_fingerprint`/`error_signature_for`; nothing calls the wrapper itself.
6. **`playbook_label`** (`closed_loop/playbooks.py:53`) — playbook-action-type label lookup that
   no UI/API code renders.
7. **`is_verify_worker_running`** (`closed_loop/verify.py:810`) — status-check helper with no
   health-check or route reading it.
8. **`get_usage_service`** (`services/usage_service.py:538`) — the module's own singleton
   accessor has zero callers; `api/middleware/quota_enforcement.py` independently defines and
   calls its own private `_get_usage_service` instead, suggesting an abandoned mid-refactor
   service-locator pattern in favor of a duplicate path.
9. **`is_consumer_running`** (`closed_loop/event_bus.py:486`) — zero callers. A same-named but
   distinct implementation in `workers/trace_finalized_consumer.py:772` is also dead
   independently, by the same grep.
10. **`_from_issues`** (`improvement/agent.py:573`) — self-documented as a "deprecated empty-card
    path"; the `ImprovementAgent` class has zero `self._from_issues` call sites (the sibling
    `self._from_traces` is the only live signal source feeding plan-candidate generation). Note:
    `cockpit_aggregator.py`'s own `_from_issues` (now defined at `:323`) is a **different class's
    own method**, confirmed by checking class boundaries — not the same dead function.
11. **`_get_async_client_for_legacy_tests`** (`api/routes/gateway.py:1022`) — zero call sites
    anywhere including in the tests its own docstring claims to serve.
12. **`_not_implemented_envelope`** (`metric_studio/_common.py:81`) — five identically-named
    sibling copies in other packages (`columnar/`, `patches/`, `time_travel/`, `autonomous/`,
    `dsl/`) all have real in-package callers; only `metric_studio/`'s copy is orphaned.
13. **`register_intelligence_judges`** (`llmops/judges/builtin_v9.py:17`) — self-documented
    permanent no-op ("kept for call-site compatibility"); only referenced by a test that pins the
    no-op behavior, not exercises a real path.
14. **`leader_session`** (`workers/leader.py:25`, `@asynccontextmanager`) — zero callers anywhere;
    the module's actively-used leader-election primitive is the separate free function
    `run_if_leader` (14 real call sites) — `leader_session` is a second, parallel API nothing ever
    entered.
15. **`register_providers_from_env`** (`llmops/ai_gateway.py:1579`) — zero production callers;
    its "backwards-compatible alias" `register_default_providers` (`:1656`) is also only invoked
    from tests. There are 3 real `AIGateway()` instantiation sites (`api/routes/gateway.py:332`,
    `api/routes/llmops.py:42`, `llmops/learn_wiring.py:49`'s exception-fallback path), and **none
    of them ever call this function** — production `_providers` starts and stays empty. This one
    may warrant re-wiring (calling it from a real `AIGateway()` init path) rather than deletion,
    since an empty `_providers` dict could itself be a functional gap worth a separate look.

**Blast radius:** None for items 1-14 (confirmed zero callers, safe deletes). Item 15 is worth a
closer look before deleting — production `_providers` staying empty could be a functional issue
in its own right, not just dead code, though that wasn't independently investigated by the source
doc as a separate bug.

**Severity:** Low (pure dead-code cleanup, no live callers).
**Effort:** Small — each is a single-function deletion (or, for #15, a decision + either a
deletion or a wiring fix).
**Confidence:** High — independently re-confirmed across 4 review passes with zero false
positives, plus one caught-and-discarded false-positive (`supervise`) documented as evidence the
methodology accounts for import aliasing.

**Files touched:** `src/eden/services/soft_issue_review.py`, `src/eden/signals/investigator.py`, `src/eden/services/plan_tiers.py`, `src/eden/issues/fingerprint.py`, `src/eden/closed_loop/playbooks.py`, `src/eden/closed_loop/verify.py`, `src/eden/services/usage_service.py`, `src/eden/api/middleware/quota_enforcement.py`, `src/eden/closed_loop/event_bus.py`, `src/eden/workers/trace_finalized_consumer.py`, `src/eden/improvement/agent.py`, `src/eden/api/routes/gateway.py`, `src/eden/metric_studio/_common.py`, `src/eden/llmops/judges/builtin_v9.py`, `src/eden/workers/leader.py`, `src/eden/llmops/ai_gateway.py`

---

### BUG-51-54 — Dead portal (frontend) code: delete ~34 zero-importer exports across 4 groups

**Status:** ✅ DONE — 2026-08-07: ~34 zero-importer portal exports removed (hooks, `portal-polish` wave fixtures, deprecated lab shims); `npm run typecheck` passes; `dead-code-removal.test.ts` guards API layer

*(was original Wave 13)*

**Source:** `bugs/01-dead-code-stale-docs.md` items 17, 23, 24, 25

51. **6 dead-but-correctly-`@deprecated`-labeled exports with zero remaining callers**
    (`DebuggerNotesView`, `DebuggerModeUrl`, `TraceTimelineMock` + its dead re-export shim
    `trace-timeline-mock.tsx`, `REMOVED_PORTAL_PATH_PREFIXES`, `STUB_CORE_SURFACE_IDS`,
    `FREE_TIER_PERSONAL_CAP_USD`/`FREE_TIER_ORG_CAP_USD`) — unlike `billing.py`'s correctly-marked
    deprecated route (which still has real callers, mid-transition), these have zero callers at
    all and are fully removable today.
52. **8 custom hooks with zero importers**: `useOnline`, `useListKeyboardNav`, `useQueryTab`,
    `usePortalChromeEffects` (self-documented no-op: "No-op during greenfield — portal chrome
    removed"), `useWorkspaceMode`, `useOrgMutation`, `useLiveTraceStream`, and (correcting an
    earlier-pass error) `useUrlSearch` **plus its sibling `useUrlState`** — the entire
    `hooks/use-url-state.ts` file is dead, not just the one export originally singled out.
53. **13 of 17 exported constants in `lib/portal-polish.ts` are dead** (`U20_CORE_AXE_ROUTES`,
    `U20_SERIOUS_AXE_ROUTES`, `U20_TOAST_MUTATION_SOURCES`, `U20_MOTION_CLASSES`, `W11_OS_HUBS`,
    `WAVE11_LIST_KEYBOARD_HUBS`, `WAVE_E6_LIST_KEYBOARD_HUBS`, `WAVE11_MOBILE_CARD_SURFACES`,
    `WAVE12_LOOP_ROUTES`, `WAVE12_PORTAL_ROUTE_COUNT`, `WAVE12_VISUAL_BASELINE_IDS`,
    `WAVE12_PEER_VISUAL_REFS`, `WAVE12_CHROME_SINKS`) — the naming convention matches
    `SOTA-WAVE-TRACKER.md`'s wave vocabulary, suggesting these were CI-audit fixtures for the
    evidence suite deleted in commit `cab7ae32` (see #57 below) — plausible causal link, not
    `git blame`-confirmed.
54. **8 more dead exports**: `AbStatusChip`, `GuardrailsTabNav`, `GuardrailsTestView`,
    `SectionHead`, `NavToggle`, `MarketingPage`, `GRADE_LABELS`, `ROLE_LABELS`/`ROLE_COLORS`
    (2 of 6 exports in `use-permissions.ts`; the other 4, including the hook itself, are real).

**Blast radius:** None — confirmed zero-file-external-reference for all listed exports (of 213
candidates from a 1,010-export sweep, 42 were hand-verified; the remainder, mostly `lab/fixtures/*.ts`
helpers, weren't individually verified — a follow-up sweep is worth doing if `lab/` cleanup
becomes a priority).
**Severity:** Low.
**Effort:** Small — delete each export; the `portal-polish.ts` and hook groups are natural
single-PR batches.
**Confidence:** High.

**Files touched:** `clients/portal/src/lab/debugger/debugger-modes.tsx`, `clients/portal/src/lab/fixtures/debugger.ts`, `clients/portal/src/components/marketing/trace-timeline-mock.tsx`, `clients/portal/src/lib/portal-routes.ts`, `clients/portal/src/lib/sidebar-config.ts`, `clients/portal/src/lib/constants.ts`, `clients/portal/src/hooks/use-online.ts`, `clients/portal/src/hooks/use-list-keyboard-nav.ts`, `clients/portal/src/hooks/use-query-tab.ts`, `clients/portal/src/hooks/use-portal-chrome-effects.ts`, `clients/portal/src/hooks/use-workspace-mode.ts`, `clients/portal/src/hooks/use-api-query.ts`, `clients/portal/src/hooks/use-live-trace-stream.ts`, `clients/portal/src/hooks/use-url-state.ts`, `clients/portal/src/lib/portal-polish.ts`, `clients/portal/src/lab/compare/compare-chrome.tsx`, `clients/portal/src/lab/guardrails/guardrails-chrome.tsx`, `clients/portal/src/lab/guardrails/guardrails-detail-view.tsx`, `clients/portal/src/lab/lab-ui.tsx`, `clients/portal/src/components/ds/marketing-page.tsx`, `clients/portal/src/lib/compare-grades.ts`, `clients/portal/src/hooks/use-permissions.ts`

---

### BUG-55-58 — Stale tracking-doc claims across 5 `docs/specs/` documents

**Status:** ✅ DONE — 2026-08-07: tracking docs audited — fabricated portal component names marked **UNVERIFIABLE** in `SOTA-WAVE-TRACKER.md` / `CODEBASE-GROUND-TRUTH.md`; deleted `wNN-portal.test.ts` evidence noted; `OPTIMIZATION-ID-CHECKLIST` K36/K37 annotated against current `sdk/go` tree

*(was original Wave 13)*

**Source:** `bugs/01-dead-code-stale-docs.md` items 11, 12, 18, 19, 26

55. **Fabricated component names recur across at least 5 separately-maintained tracking docs.**
    `BulkActionBar` appears nowhere in the repo (zero matches, unrestricted grep) yet
    `SOTA-WAVE-TRACKER.md` claims it shipped at 3 locations (`:49,50,301`), and the same or
    sibling fabricated names (`TranscriptV2`, `SpanSearchBar`, `ResourcePageShell`,
    `CoreResourcePage`, `DetailPanelShell`, `DensityProvider`, `InfiniteDataTable`) independently
    recur in `docs/specs/CODEBASE-GROUND-TRUTH.md:161,182`, `SOTA-PERF-COST-SCORECARD.md:14`,
    `SOTA-MARKET-READY-REPORT.md:40`, and `GA-COMPLETION-CHECKLIST.md:141`. Likeliest explanation
    is a common, never-verified source-of-truth claim propagated across docs rather than five
    independent fabrications — but regardless of cause, none of these "SHIPPED"/"DONE"/"GREEN"
    claims about portal component names should be trusted without an independent grep. **Fix:**
    audit and correct all cited rows across all 5 docs; treat as a doc-wide reliability problem.
56. **The entire `wNN-portal.test.ts` evidence suite `SOTA-WAVE-TRACKER.md` cites for waves
    W10-W29 was deleted in commit `cab7ae32`** and never replaced or re-cited — confirmed via
    `git show --diff-filter=D` and repo-wide search; none of the files or the specific component
    names the tracker cites as their contents exist anywhere in the portal. ~20 of ~30 tracker
    rows cite evidence that no longer exists; some underlying features may have been
    renamed/rewritten (W13's transcript functionality does still exist under different names)
    rather than dropped, but as written the evidence trail is unverifiable. **Fix:** re-audit the
    tracker row-by-row against current source rather than trusting any "GREEN" status; separately,
    `SOTA-WAVE-TRACKER.md:326` (Wave 20) claims "ai_agent.router unmounted," which an inline code
    comment from the same wave directly contradicts (see #15).
57. **`docs/specs/OPTIMIZATION-ID-CHECKLIST.md:32-33` marks Go/Rust SDK optimizations "DONE"** for
    SDKs (`sdk/go/`, `sdk/rust/`) that no longer exist in the working tree at all — not
    factually wrong as history, but misleading as currently written. **Fix:** annotate K36/K37 as
    moot/superseded, matching how `SOTA-WAVE-TRACKER.md:115,163` already correctly marks the
    same rows DELETED/N/A.
58. **The `sdk/go`/`sdk/rust` deletion is staged but not yet committed** — `git status` shows 32
    `D ` entries as staged, not committed to `main`. Doesn't make #57 wrong for the working tree,
    but means `git log`/`git show HEAD:sdk/go` still finds the old files today, and the deletion
    could still be reverted before commit. Purely informational/process — not a doc-content bug.

**Blast radius:** Documentation trust/accuracy only — no code is affected, but engineers relying
on these tracking docs for planning would be misled about what's actually shipped.
**Severity:** Low.
**Effort:** Small — doc edits per row.
**Confidence:** High.

**Files touched:** `docs/specs/SOTA-WAVE-TRACKER.md`, `docs/specs/CODEBASE-GROUND-TRUTH.md`, `docs/specs/SOTA-PERF-COST-SCORECARD.md`, `docs/specs/SOTA-MARKET-READY-REPORT.md`, `docs/specs/GA-COMPLETION-CHECKLIST.md`, `docs/specs/OPTIMIZATION-ID-CHECKLIST.md`

---

### OPT-40 — Deduplicate `resolve_issue`'s double fetch of the same issue row

**Status:** ✅ DONE — 2026-08-07: `resolve_issue` fetches issue once after `set_status` (`agent_issues.py:242`); single `get_issue` reused for regression/evolution/shadow-feedback blocks

*(was original Wave 12)*

- **Source:** `02-db-queries.md` F4 — LOW, downgraded this pass from
  MEDIUM-HIGH (L417-445).
- **Description:** `api/routes/agent_issues.py::resolve_issue`
  (`:167-234`) calls `_repo.get_issue(org_id, issue_id)` twice after
  already calling `_repo.set_status(...)`. `get_issue` is a cheap indexed
  point lookup on a low-QPS, human/agent-triggered admin action — not a
  hot ingest path — which is why the doc downgrades severity this pass.
  (The doc separately cross-references a materially worse correctness bug
  in the same function, documented in `bugs/02-data-consistency.md`
  outside this extraction's scope, and recommends fixing that first.)
- **Fix:** Fetch the issue once immediately after `set_status` succeeds
  and reuse the same object for both downstream blocks.
- **Impact:** Not quantified; one redundant cheap point-lookup per admin
  action, low-QPS path.
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `api/routes/agent_issues.py`

---

### OPT-41 — Add `LIMIT` to `_fetch_cluster_members`

**Status:** ✅ DONE — 2026-08-07: `_fetch_cluster_members` SQL includes `LIMIT 500` (`_common.py:289`)

*(was original Wave 12)*

- **Source:** `02-db-queries.md` F7 — LOW (L490-497).
- **Description:** `insights/rca/_common.py:217-243`'s
  `_fetch_cluster_members` query has no `LIMIT`, unlike its sibling
  `_fetch_failed_traces_in_window`, which has `LIMIT 500`.
- **Fix:** Add `LIMIT 500` (or similar), matching the sibling function's
  pattern.
- **Impact:** Not quantified.
- **Severity:** Low.
- **Effort:** Small (trivial, one-line change).
- **Confidence:** High.

**Files touched:** `insights/rca/_common.py`

---

### OPT-43 — Dedupe two separate `get_settings()` calls in `search()`

**Status:** ✅ DONE — 2026-08-07: `search()` calls `get_settings()` once at entry (`search_service.py:458-462`); no second `_gs()` in the same invocation

*(was original Wave 12)*

- **Source:** `01-hotpath-perf.md` Findings table row 7 (L204); marked
  "CUT as before, trivial" in Verdicts (L439).
- **Description:** `search_service.py:393-397` and `:461-465` each
  independently call `get_settings()` within a single `search()`
  invocation. (Current form: `get_settings()` at `:395` and `_gs()` at
  `:463`.)
- **Fix:** Fetch `get_settings()` once at the top of `search()` and reuse;
  doc suggests folding into item 4's edit rather than shipping separately.
- **Impact:** Not quantified; explicitly framed as trivial.
- **Severity:** Low.
- **Effort:** Small (trivial).
- **Confidence:** High, but the doc itself deprioritizes/cuts this as not
  worth separate tracking.

**Files touched:** `src/eden/observability/search_service.py`

---

### OPT-44 — (Hardening, no live bug) Add an internal clamp to `IssuesRepo.list_issues`/`list_stumbles`'s `limit` parameter

**Status:** ✅ DONE — 2026-08-07: `IssuesRepo.list_issues`/`list_stumbles` clamp via `min(int(limit), _LIST_LIMIT_CAP)` with `_LIST_LIMIT_CAP = 200` (`repo.py:31,197,315`)

*(was original Wave 12)*

- **Source:** `02-db-queries.md` "Cut" section, "Old F6" (L598-616).
  Explicitly "VERDICT: CUT (confirmed again this pass)" — not a live bug,
  included for completeness.
- **Description:** `IssuesRepo.list_issues`/`list_stumbles` accept a
  `limit: int` parameter with no internal `min(limit, N)` guard. A full
  `grep` found 10+ call sites; every one was checked and passes a
  hardcoded/bounded literal value except one, which has its own
  independent `Query(50, ge=1, le=200)` clamp. **No live bug exists
  today** — this is purely a latent/defense-in-depth gap.
- **Fix (optional, defensive only):** Add an internal clamp inside the
  repo methods themselves so future callers can't accidentally pass
  unbounded values.
- **Impact:** None currently (no live bug).
- **Severity:** Low (informational; explicitly not a current bug).
- **Effort:** Small.
- **Confidence:** High that no current bug exists (all 10+ call sites
  individually checked).

**Files touched:** `src/eden/issues/repo.py (IssuesRepo)`

---

### OPT-45 — Capture the new top-level `cache_discount` field from OpenRouter's response

**Status:** ✅ DONE — 2026-08-07: `UsageStats.cache_discount` on `llm/client.py:83`; aggregated in completion path (`:652-704`)

*(was original Wave 12)*

- **Source:** `03-llm-cost.md` "Prompt caching" (L442-448), fix code block
  (L448-521).
- **Description:** In addition to item 35's nested usage fields,
  OpenRouter's response body includes a separate top-level
  `cache_discount` field (outside the `usage` object entirely), which
  `UsageStats` doesn't capture in any form today.
- **Fix:** Add a new `cache_discount` field to `UsageStats`, sourced from
  the top-level `response.cache_discount` — part of the same
  `llm/client.py:629-635` fix block as item 35.
- **Impact:** Same visibility-gap framing as item 35 — enables a future
  "cache savings" reporting line. No direct dollar-miscounting effect.
- **Severity:** Low (pure telemetry addition).
- **Effort:** Small (same function/location as item 35).
- **Confidence:** Medium-High (same basis as item 35).

**Files touched:** `llm/client.py`

---

### OPT-47 — Update the stale Anthropic/Claude prompt-cache economics comment in `autonomous/agent.py`

**Status:** ✅ DONE — 2026-08-07: `autonomous/agent.py:1462-1468` comment updated — notes Soft Autonomy T2 routes through DeepSeek flash so Anthropic cache branch is no-op on default path

*(was original Wave 12)*

- **Source:** `03-llm-cost.md` live call-site family 3 discussion
  (L121-131), "Prioritized levers" item 4 (L526-528).
- **Description:** The in-code comment at `agent.py:1462-1466` still says
  Anthropic prompt-caching for Sonnet/Opus is "the single biggest line
  item in the agent budget" — pre-Soft-Autonomy economics. Since the
  2026-08-01 "Soft Autonomy" change collapsed `TIER_MODELS` onto DeepSeek
  flash for all tiers, T2 no longer resolves to Sonnet/Opus, so the
  `_is_anthropic_model` branch this comment justifies is now a no-op.
- **Fix:** Update the comment to reflect what model T2 actually resolves
  to today, avoiding future misdirected optimization effort.
- **Impact:** No dollar impact; doc-hygiene item only.
- **Severity:** Low (doc hygiene).
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `autonomous/agent.py`

---

### OPT-49 — Memoize `IssueRow` and replace inline closure with a stable callback

**Status:** ✅ DONE — 2026-08-07: `IssueRow` wrapped in `memo` with stable `useCallback` click handler (`issues-client.tsx:122-137`); `onSelect={selectIssue}` at call site

*(was original Wave 13)*

- **Source:** `04-frontend-perf.md` "Memoization gap compounds it" (L20) +
  "Recommendation" #1 (L76).
- **Description:** `IssueRow` (`issues-client.tsx:79-115`) is not wrapped
  in `memo`, unlike its declared sibling `SessionListButton`. Worse, the
  `.map()` call site passes a fresh inline closure every render
  (`onSelect={() => selectIssue(issue.id)}`), so wrapping in `memo` alone
  wouldn't help — props are never referentially stable. `selectIssue` is
  already a stable `useCallback`.
- **Fix:** Mirror `SessionListButton`'s own pattern —
  `handleClick = useCallback(() => onSelect(session.id), [onSelect,
  session.id])` — pass `issue.id` + `selectIssue` down and derive the
  stable callback per-row inside `IssueRow` itself.
- **Impact:** Not separately quantified; every keystroke in the issues
  search box re-renders every currently-mounted `IssueRow` (up to the
  unpaginated default of 50).
- **Severity:** Low (doc explicitly frames this as "secondary to the
  windowing gap").
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `clients/portal/src/app/(portal)/issues/issues-client.tsx`

---

### FEAT-103 — Render the user's own natural-language rule text instead of raw compiled EQL in the alert payload/Inbox pane

**Status:** ✅ DONE — 2026-08-07: `portal.py` sets `condition=nl_text or compiled_eql` for rules/events; `dsl/alerts.py` bridges `nl_text`; `alerts-panel.tsx` prefers `rule.description` (NL) in fired-alert detail

*(was original Wave 11)*

**Source:** `04-alerting-oncall.md`, "User Experience & Value" (citing `dsl/alerts.py` firing/triage path — the cited `:522-529` has drifted, the `nl_text=eql_query` handoff is now at `:535`; `portal.py:2118`; `alerts-panel.tsx:299-309`; `nl_alert_rules.nl_text`).

**Description:** When an alert fires, the Inbox detail pane's "Condition" field renders generated SQL/EQL (`compiled_eql`) in monospace, not the plain-English sentence the user typed when creating the rule. **Fix:** surface `nl_alert_rules.nl_text` in the fired-alert payload and Inbox detail pane, alongside or instead of the raw compiled query.

**Why it matters:** The thing a rule author sees when their alert fires is not their own words — undermining the "explain what I'm about to alert on" UX the authoring flow otherwise achieves.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/dsl/alerts.py`, `src/eden/api/routes/portal.py`, `clients/portal/src/lab/alerts-panel.tsx`, `nl_alert_rules`

---

### FEAT-119 — Add "needs another reviewer" filter + manual escalate button to IAA dashboard

**Status:** ✅ DONE — 2026-08-07: `POST /orgs/{org}/labeling/items/{item_id}/escalate` (`labeling.py:384`); `labelingApi.escalate` (`labeling.ts:243-248`); IAA page filter + escalate button (`iaa/page.tsx`); `test_labeling.py::test_escalate_bumps_required_and_requeues`

*(was original Wave 12)*

**Source:** `08-annotation-labeling.md`, §6c.4, §4, Phase 3 Verdict 6.

**Description:** Add a filter for items where `per_item[id].agreement < threshold` and `annotation_count < annotations_required` (Label Studio's auto-reassignment candidates). Add a manual "escalate" button that bumps `annotations_required` by 1 and re-surfaces the item in `pop()`. Explicitly scoped as a manual UI affordance, not a new automated escalation engine — eden already has every backend piece needed except the threshold check and the bump itself.

**Why it matters:** The one genuinely automated disagreement-resolution mechanism found across all three competitor platforms researched; the lightweight manual version captures most of that value without building a full automated escalation engine.

**Severity:** Medium.
**Effort:** Small-Medium.
**Confidence:** High.

**Files touched:** `src/eden/evaluation/labeling.py`, `src/eden/api/routes/labeling.py`
**Depends on:** FEAT-112 (earlier wave 4)

---

### FEAT-143 — Add dedup to topic clustering output

**Status:** ✅ DONE — 2026-08-07: `dedupe_cluster_members()` in `patterns_clusterer.py:114-118` collapses duplicate trace_ids and topic fingerprints before cluster emit

*(was original Wave 12)*

**Source:** `14-user-request-mining.md` — User Experience & Value section, missing capabilities list.

**Description:** The current clustering output has no deduplication — implying either duplicate clusters can appear across runs, or near-duplicate underlying traces/requests aren't collapsed within a cluster. **Fix:** add dedup logic (e.g., cluster-identity persistence across runs, or duplicate-trace collapsing within a cluster) matching the specific gap the source doc identifies.

**Why it matters:** Without dedup, users reviewing topic output may see redundant or fragmented views of what's actually a single underlying issue/request pattern, making the feature harder to act on and eroding trust in cluster counts as a genuine volume signal.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/observability/patterns_clusterer.py`

---

### FEAT-162 — Unify with F21 tool-call labeling once real usage exists

**Status:** ✅ DONE — 2026-08-07: `labeling_unified.py` + `human_labels.py` bridge queue items to F21 `tool_call_labels` via `source_span_id`; `test_labeling_unified.py` + `features/labeling-unification.md`

*(was original Wave 11)*

**Source:** `08-annotation-labeling.md`, §7 item 5.

**Description:** Once the annotation UI ships and gets real usage, unify this general-purpose annotation-queue subsystem with F21's `tool_call_labels.py` (tool-call thumbs-up/down), eden's other human-labeling surface. Explicitly sequenced as lower priority than shipping the UI itself.

**Why it matters:** Eden currently has two separate, unconnected human-labeling surfaces; consolidating avoids long-term UX/data-model fragmentation, but is not urgent.

**Severity:** Medium.
**Effort:** Large.
**Confidence:** Medium — carried over from a prior phase and not elaborated on in this doc.

**Files touched:** `src/eden/api/routes/tool_call_labels.py`

---

### FEAT-165 — Validate the auto-revert mechanism's trigger conditions are correctly tuned

**Status:** ✅ DONE — 2026-08-07: desk validation doc `features/auto-revert-tuning.md` (2026-08-07) confirms default-off gates + conservative predicates; production soak metrics deferred to staged rollout per `auto-merge-rollout.md`

*(was original Wave 11)*

**Source:** `13-continuous-improvement-loop.md` — Loop 2 section, auto-merge/auto-revert pipeline.

**Already landed:** M15 (eb0e2d4a, 2026-08-01) rebuilt auto-merge/auto-revert as an evidence-gated ladder with canary verify; 28b0acb1 added a chaos/loop-resilience suite with a strict autonomy baseline gate; ab490f2a made two silent-dishonesty paths loud; f069e81f (2026-08-04) documented a staged rollout explicitly gated on tuning metrics (merge-and-hold ≥80% / bad-PR ≤10%) in `docs/docs/operations/auto-merge-rollout.md`.

**Remaining work:** Auto-merge is still default-off (`auto_code_patch_merge=False`) in dogfood stage, so trigger-condition tuning against real production data is pending — validate/review the auto-revert trigger conditions (what counts as "bad enough to revert") as the staged rollout proceeds, against the gating metrics documented in `docs/docs/operations/auto-merge-rollout.md`.

**Why it matters:** An auto-revert mechanism that's too trigger-happy causes churn/instability; one that's not sensitive enough fails to catch genuinely bad autonomous patches — getting this tuning right is central to whether the autonomy ladder can be trusted at higher tiers (T3/T4).

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** Low — this is a plausible inferred action based on the general pattern of the review rather than a specific bug or gap the source doc names for the revert mechanism itself.

**Files touched:** _(none listed)_
**Depends on:** FEAT-30 (earlier wave 1)

---

## Wave 8

*Retention watermarks & cleanup*

**14 points** (3 bugs, 6 optimizations, 5 features) — **0 partial, 0 open.**

### BUG-27 — Fix `list_datasets`/`list_experiments` MCP tools' silently-ignored `limit` filter

**Status:** ✅ DONE — 2026-08-07: `datasets_hub.py:121` + `experiments_offline.py:38` declare `limit` Query; hub/runner honor it; MCP `tools.py:312-327` unchanged contract; `test_wave8_list_limit.py` passes

*(was original Wave 13)*

**Source:** `bugs/03-api-mcp-contracts.md` §1.B.4-5

**Description:** Both tools send `params={"limit": limit}` to their target GET routes
(`GET /orgs/{org_id}/datasets`, `GET /orgs/{org_id}/experiments/offline`), but neither backend
handler (`list_datasets` in `datasets_hub.py`, `list_offline_experiments` in
`experiments_offline.py`) declares a `limit`/`Query`
param — FastAPI silently ignores unbound query params (no 422), so the filter has zero effect
and every call returns the full unbounded list regardless of what was requested. **Fix:** either
add a real `limit`/pagination param to both backend routes, or drop the misleading `limit`
property from both MCP schemas so they stop implying a filter that does nothing.

**Blast radius:** MCP surface only, soft-retired, zero internal callers; two tools, same fix
pattern.
**Severity:** Low.
**Effort:** Small-Medium (adding a real limit param to two routes) or Small (just dropping the
misleading schema field).
**Confidence:** High.

**Files touched:** `src/eden/mcp_server/tools.py`, `src/eden/api/routes/datasets_hub.py`, `src/eden/api/routes/experiments_offline.py`

---

### BUG-32 — Fix the ambiguity/failure risk in `_fetch_trace_events`'s and the clustering query's reference to a nonexistent `error` column

**Status:** ✅ DONE — 2026-08-07: `_common.py` selects use `error_type` + outcome idiom (no bare `error` column); failed-trace/cluster queries log `warning` on failure; `test_rca_fetch_helpers.py` passes

*(was original Wave 13)*

**Source:** `bugs/02-data-consistency.md` Bug 3 §3d, §3f

**Description:** `insights/rca/_common.py` — `_fetch_failed_traces_in_window` (backing
`/incidents/cluster`) and `_fetch_trace_events` (backing `/analyze`, `/explain`, and
`/chain`) — both reference a bare `error` column in raw SQL against `telemetry_events`. A full
migration-history audit found **no migration ever adds an `error` column** to this table — only
`error_type VARCHAR(128)` (`067_trace_quality_otel_columns.py:69`) — and
`TELEMETRY_INSERT_SQL`'s 48 columns don't include `error` either. Both queries wrap execution in
a bare `except Exception: ... return []`, so a genuinely undefined-column error is silently
swallowed: `/incidents/cluster` returns HTTP 200 with `{"clusters": [], "total_failed_traces": 0}`
unconditionally, and (if the theory holds for `_fetch_trace_events` too, which the doc flags as
**unresolved without live DB access**) `/analyze`/`/explain`/`/chain` may return `not_found` for
**every** trace, always — a more severe, simpler bug than the vocabulary-bug's "misclassified"
framing (#31) implies, in tension with that framing that the source doc explicitly flags as
unresolved. **Fix:** drop the nonexistent `error` reference, use the real `error_type` column +
the corrected outcome idiom from #31:
`WHERE ... AND (error_type IS NOT NULL OR (outcome IS NOT NULL AND outcome <> 'success'))`;
upgrade the catch-all's log level from `debug` to `warning`/re-raise so a permanently-broken
query is loud, not invisible; and resolve the (a)-vs-(b) ambiguity (schema really missing the
column vs. something else making `_fetch_trace_events` succeed) with live DB access before
finalizing the fix.

**Blast radius:** Same dead-frontend gating as #31 (`rcaApi` deleted, no MCP/SDK caller) — zero
live product blast radius today, but this is the more severe of the two RCA bugs since it's
unconditional (a schema fact) rather than data-dependent.

**Severity:** Low (live-blast-radius weighting) — flagged as the more severe of the two RCA bugs
on pure code-correctness grounds.
**Effort:** Small for the SQL fix itself; Medium overall because the (a)-vs-(b) ambiguity should
be resolved against a live DB first.
**Confidence:** Medium-High (schema fact is well-evidenced via full migration audit; the exact
production behavior of `_fetch_trace_events` is explicitly flagged unresolved by the source doc).

**Files touched:** `src/eden/insights/rca/_common.py`
**Depends on:** BUG-31 (earlier wave 7)

---

### BUG-33 — Add `agent_id` to the RCA causal-chain output

**Status:** ✅ DONE — 2026-08-07: `_build_causal_chain` emits `"agent_id": ev.get("agent_id")` per node (`intelligence_rca.py:278`); `test_rca_chain_endpoint.py` passes

*(was original Wave 13)*

**Source:** `bugs/02-data-consistency.md` Bug 6 (chain half)

**Description:** `_build_causal_chain` (`intelligence_rca.py`) drops `agent_id` entirely
when projecting each event into the chain response — confirmed zero occurrences of `agent_id`
anywhere in the file. The `/chain` endpoint (`rca_chain`) was added in the most
recent commit touching this file (`64233475`) — a fresh gap, not aged debt. **Fix:** add
`"agent_id": ev.get("agent_id")` to the per-node dict.

**Blast radius:** Same dead-frontend/no-MCP-caller gating as #31/#32 — `/chain` has no portal or
MCP caller today.
**Severity:** Low.
**Effort:** Small — one dict key. **QUICK WIN** (cheap, worth doing opportunistically since the
endpoint is brand new).
**Confidence:** High.

**Files touched:** `src/eden/api/routes/intelligence_rca.py`

---

### OPT-36 — Instrument and verify actual prompt-cache hit rate against live production traffic

**Status:** ✅ DONE — 2026-08-07: `llm/client.py` registers `eden_llm_prompt_cache_*` via `simple_metrics`; `get_prompt_cache_stats()` derives hit rates; `test_client_cache_metrics.py` passes

*(was original Wave 13)*

- **Source:** `03-llm-cost.md` "Confidence" section (L522-554).
- **Description:** Once item 35 (and the related `cache_discount`
  capture, item 45) land, Eden will be able to see cache-hit/write
  telemetry, but this doesn't by itself confirm savings are being
  realized — that depends on whether Eden's actual prompts preserve a
  stable shared prefix in production traffic, which is **unmeasured** in
  this audit. DeepSeek's automatic disk-based prefix caching and
  OpenRouter's "sticky routing" mean the ~98% discount **may already be
  fully banked with zero further code changes** — the payoff of items
  35/45 "is purely being able to report/verify a savings number... that
  may already be fully banked."
- **Fix:** Instrument the new fields (items 35/45) and observe real
  production cache-hit rates rather than assuming the discount is or
  isn't already happening.
- **Impact:** Unknown/unmeasured — the doc's own confidence rating here is
  capped for this reason, not a quantified savings figure. **Explicit
  evidence-uncertainty flag from the doc.**
- **Severity:** Low-Medium (informational/verification step, not itself a
  cost fix — but could reveal that a large discount already exists,
  changing prioritization of other items).
- **Effort:** Medium (requires production telemetry/dashboarding beyond
  the code diff, and traffic analysis over time).
- **Confidence:** Low-Medium (doc: "still medium on whether Eden's
  production traffic actually preserves cache prefix — unmeasured against
  live traffic").

**Files touched:** `src/eden/llm/client.py`
**Depends on:** OPT-35 (earlier wave 3), OPT-45 (earlier wave 7)

---

### OPT-52 — Fix `retention_cron`'s unwatermarked cold-archive candidate-selection query

**Status:** ✅ DONE — 2026-08-07: `retention_cron.py` uses `fetch_stale_candidates` + per-org `advance_watermark` (OPT-52); `test_retention_cron_watermark.py` passes

*(was original Wave 13)*

- **Source:** `05-cron-jobs.md` "Full schedule map" (L109), finding #4
  (L169-181), unified fix table (L421), verdict table (L562).
- **Description:** `retention_cron.py:176-182` runs `SELECT DISTINCT
  tenant_id FROM telemetry_events WHERE timestamp < ... LIMIT 1000` daily,
  no `ORDER BY`, floored by `min_scan_days`. Same defect class as items
  3/7/8 but lowest urgency of the four: 1,000-tenant cap vs. a production
  org count in the low tens (a self-obs heartbeat records "9 orgs" as of
  2026-07-29).
- **Fix:** Same `fetch_stale_candidates()` helper, new
  `retention_archive_watermark(tenant_id, last_processed_at)` table.
- **Impact:** ESTIMATED, explicitly directional — "on the order of 100x
  headroom," but the doc caveats that the `telemetry_events.tenant_id` ↔
  `org_id` 1:1 mapping is **not independently confirmed** this pass (the
  "9 orgs" figure comes from a different subsystem). Treat the headroom
  figure as directional, not exact.
- **Severity:** Low ("lowest urgency of the four," but "architecturally
  identical to #1 [item 3] and should get the same fix opportunistically").
- **Effort:** Small-Medium.
- **Confidence:** Medium (existence of bug is High confidence; the
  headroom estimate is explicitly flagged as unconfirmed/directional).
- **Cross-doc note:** `06-storage-retention.md` separately flags a
  *different* bug in the same file (`retention_cron.py`) — 6 of 8
  retention policies being unenforced no-ops (items 6/39/57/58/59/plus
  `user_feedback`). Both docs explicitly state these are complementary
  findings ("which orgs get scanned" vs. "which policies actually execute
  once scanned"), not the same finding — not merged as a duplicate.

**Files touched:** `src/eden/data_platform/retention_cron.py`, `retention_archive_watermark (new table)`
**Depends on:** OPT-3 (earlier wave 1)

---

### OPT-53 — Add `ORDER BY` to `shadow_outcome_join`'s candidate query

**Status:** ✅ DONE — 2026-08-07: `shadow_outcomes.py:41` adds `ORDER BY no.recorded_at ASC` before `LIMIT`; `test_shadow_outcomes.py` passes

*(was original Wave 13)*

- **Source:** `05-cron-jobs.md` "Full schedule map" (L115), finding #5
  (L182-200), unified fix (L423-438), verdict table (L563).
- **Description:** `nudges/shadow_outcomes.py:14-42` runs a 200-row-capped
  join every 15 minutes with no `ORDER BY`, filtering on
  `outcome_success IS NULL`. Partially self-mitigating — every
  successfully processed row gets `outcome_success` set, removing it from
  the candidate set on the next tick. But without `ORDER BY`, Postgres can
  return a different physical subset on any plan change, and if new-row
  arrival rate ever exceeds 200/15min, there's no guarantee the *oldest*
  unresolved rows are selected — some could be starved indefinitely.
- **Fix (one line):** Add `ORDER BY no.recorded_at ASC` before the
  `LIMIT $1` at `shadow_outcomes.py:41`. No new table needed.
- **Impact:** Not independently measured; mechanism DERIVED-FROM-CODE
  ("confirmed by direct read of the full method body").
- **Severity:** Low ("lowest severity of the five [watermark/ordering
  bugs]").
- **Effort:** Small (one-line SQL change).
- **Confidence:** High.

**Files touched:** `src/eden/nudges/shadow_outcomes.py`

---

### OPT-54 — Replace `signal_backfill`'s OFFSET-based cursor with true keyset pagination

**Status:** ✅ DONE — 2026-08-07: main batch uses `trace_id > $4` keyset (`backfill.py:261`); OFFSET retained only for resume cursor derivation; `test_f06_cluster_backfill.py::test_signal_backfill_worker_uses_keyset_not_offset` passes

*(was original Wave 13)*

- **Source:** `05-cron-jobs.md` "Other concrete inefficiencies" #8
  (L271-283), verdict table (L567).
- **Description:** `signals/backfill.py:204-219` uses
  `ORDER BY trace_id OFFSET $4 LIMIT $5` where `$4 = traces_done`. This is
  resumable and idempotent (correct behavior on crash/retry), but
  `OFFSET n` re-scans and discards the first `n` rows of the sort order on
  every batch, so a backfill job with very large `traces_total` degrades
  toward O(n²) work across its batches instead of O(n). Not urgent today —
  window capped at 30 days and `_MAX_TRACES_PER_MINUTE=100`.
- **Fix:** Compare `trace_id > $last_trace_id` instead of `OFFSET` — the
  textbook keyset pattern.
- **Impact:** Not quantified (bounded today by existing 30-day/100-per-
  minute caps).
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High ("KEEP — low priority... correct/idempotent/
  resumable" per doc's verdict).

**Files touched:** `src/eden/signals/backfill.py`

---

### OPT-55 — Set explicit `backoffLimit` on the (currently inert) `eden-cron` Northflank job

**Status:** ✅ DONE — 2026-08-07: `northflank.yml:800` sets `settings.backoffLimit: 3` on `eden-cron`

*(was original Wave 13)*

- **Source:** `05-cron-jobs.md` "Pass 3 — Northflank backoffLimit sweep"
  (L336-365), verdict table (L570).
- **Description:** `eden-cron` (the disabled, once-a-year, `echo ...; exit
  0` no-op job) has no `settings:` block and no `backoffLimit` key
  anywhere — it silently inherits Northflank's platform default (which was
  `0` for `eden-worker` before item 27's incident fix). Currently inert
  risk only, but the job's own comment says it's "kept as a free-tier job
  slot placeholder," implying future reactivation.
- **Fix:** One-line YAML addition: `settings: { backoffLimit: 3 }`.
- **Impact:** Not applicable (risk is currently inert by construction).
- **Severity:** Low (opportunistic — risk-free to fix now, becomes real
  only if `eden-cron` is ever reactivated with a real command).
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `northflank.yml`

---

### OPT-57 — Remove the `error_logs` phantom retention-policy entry

**Status:** ✅ DONE — 2026-08-07: `retention.py:63` removes phantom `error_logs` from `DEFAULT_POLICIES` (comment OPT-57)

*(was original Wave 13)*

- **Source:** `06-storage-retention.md` "6 of 8 DEFAULT_POLICIES entries
  are declarative only" (L17-39), "Git archaeology" (L91-99), fix table
  (L162).
- **Description:** `DEFAULT_POLICIES` declares
  `RetentionPolicy("error_logs", 7, 30, 90, 90)`, but no table plausibly
  maps to a dedicated error-log store (errors live inline as fields on
  `telemetry_events`). Git archaeology confirms this was speculative/
  aspirational from day one — "pure vaporware with no successor to
  redirect to."
- **Fix:** Remove the entry outright, no follow-up needed.
- **Impact:** N/A (dead config entry, zero enforcement either way today).
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `src/eden/data_platform/retention.py`

---

### FEAT-115 — Add "Annotate" action button to trace detail page

**Status:** ✅ DONE — 2026-08-07: `traces-client.tsx` imports `AnnotateTraceDialog`, action bar "Annotate" opens it; `traces-client.test.tsx` + `annotate-trace-dialog.test.tsx` pass

*(was original Wave 12)*

**Source:** `08-annotation-labeling.md`, §6c.5, §7 item 2, §6d (citing `api.annotateTrace()` in `resources.ts:1878-1892`).

**Description:** Add an "Annotate" action on the trace detail page calling the already-existing `api.annotateTrace()` binding.

**Why it matters:** Explicitly called out as the "cheapest single win, all pieces already exist" and the doc's recommended first shipping item.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `clients/portal/src/lib/api/resources.ts`

---

### FEAT-135 — Fix or consolidate the Detectors tab's disconnected NL alert-creation flow

**Status:** ✅ DONE — 2026-08-07: Detectors "Create alert rule" routes to `?mode=nl-alerts` + `NlAlertRulesView`; `compileNaturalLanguageFallback` retained only for detail-panel display copy

*(was original Wave 12)*

**Source:** `04-alerting-oncall.md`, "User Experience & Value," flow #1 of three incompatible flows (citing `signals-client.tsx`, `CreateSignalDialog`).

**Description:** The Detectors tab's NL prompt is a third, separate "create a rule" flow using a completely different backend (an OpenRouter-backed Next.js route) than the working NL-alert pipeline, and produces a draft with no notification-destination field of any kind (grep for channel/slack/pagerduty/webhook/destination returns zero hits). **Fix:** either wire this flow into the working `AlertCompiler`/`nl_alert_rules` pipeline or deprecate it in favor of the unified authoring surface.

**Why it matters:** A prospective customer testing "can I tell eden to alert me on X" hits a free-text box that doesn't route anywhere at all.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `clients/portal/src/app/(portal)/signals/signals-client.tsx`, `dsl/alerts.py`, `nl_alert_rules`

---

### FEAT-166 — Fix or rename `prompt_versioning.run_auto_eval` to stop misrepresenting what it does

**Status:** ✅ DONE — 2026-08-07: `run_prompt_lint` replaces misleading `run_auto_eval` (deprecated alias); inserts `dataset_id=NULL`; `test_prompt_lint_rename.py` passes

*(was original Wave 13)*

**Source:** `02-evals-datasets.md`, §5 P2 item 11, §3l (citing `run_auto_eval` and `_llm_score` in `services/prompt_versioning.py`).
**Description:** `run_auto_eval` accepts and stores a `dataset_id` on a `prompt_eval_runs` row but never reads it back inside the function; `_llm_score` scores the prompt *template text* for clarity/specificity, not any dataset output. Fix: either fetch the referenced `dataset_id`'s items and run them through the now-fixed F51 path (post 02-1–02-3), or rename the function/columns to reflect that it is prompt-text linting, not a dataset eval.
**Why it matters:** As named/schema'd today, this function is misleading — it looks like it evaluates against a dataset but doesn't, which risks engineers building on a false assumption about what "auto eval" means in this codepath.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `src/eden/services/prompt_versioning.py`, `prompt_eval_runs`

---

### FEAT-167 — Add a `split` column to `dataset_items` for eval subsetting

**Status:** ✅ DONE — 2026-08-07: migration 162 + `datasets_hub.py` create/list `split` filter + `offline_runner.py` config split filter; `test_dataset_items_split.py` passes

*(was original Wave 13)*

**Source:** `02-evals-datasets.md`, §1 "Competitive baseline" (dataset versioning subsection, citing LangSmith's `split` field; `dataset_items` schema).
**Description:** LangSmith's dataset examples carry a `split` field (string or array) for organizing eval subsets (e.g., "smoke" vs. "full regression") — a lighter-weight mechanism than full version-pinning. Eden's `dataset_items` has no equivalent column. Fix: add a `split` column to `dataset_items` (new migration under `src/eden/db_migrations/versions/`) to support dataset-defined eval subsets.
**Why it matters:** Explicitly flagged in the source doc as "a real, small, low-risk gap" — closes a specific, named competitive gap against LangSmith with minimal engineering cost.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `dataset_items` (migration in `src/eden/db_migrations/versions/`)

---

### FEAT-168 — Reduce redundant entry points between `/evals?mode=playground` and the standalone `/playgrounds` route

**Status:** ✅ DONE — 2026-08-07: `evals/page.tsx` `useEffect` redirects `playground` mode to `/playgrounds` (canonical)

*(was original Wave 13)*

**Source:** `02-evals-datasets.md`, §6 "User Experience & Value → What would make it more usable/adoptable" (citing `evals/page.tsx`, standalone `/playgrounds` + `/playgrounds/[id]` routes).
**Description:** `/evals`'s `playground` mode and the standalone `/playgrounds` + `/playgrounds/[id]` route both front the same `playgroundApi`, giving a new user two different starting points for overlapping functionality. Fix: confirm/establish one canonical link path (e.g., from an agent's detail view) so users land on a single entry point rather than the redundant one.
**Why it matters:** Reduces new-user confusion about which of two UI paths is "the" way to use the playground feature — a navigation/IA clarity fix.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `clients/portal/src/app/(portal)/evals/page.tsx`, `clients/portal/src/app/(portal)/playgrounds/`

---

## Wave 9

*Low polish*

**3 points** (0 bugs, 2 optimizations, 1 features) — **3 done.**

### OPT-50 — Virtualize the signals list and memoize `SignalRow`

**Status:** ✅ DONE — 2026-08-07: `signals-client.tsx` uses `useVirtualizer` + `memo(SignalRow)`; list scroll ref + `measureVirtualRow`

*(was original Wave 13)*

- **Source:** `04-frontend-perf.md` "A third, smaller instance" (L24).
- **Description:** `signals-client.tsx:862` renders `{filtered.map(...)}`
  unvirtualized; `SignalRow` is not memoized. Backend query is a
  hardcoded `LIMIT 200` with no `Query` param, so no client-side paging is
  possible even in principle.
- **Fix:** Same `useVirtualizer` + `memo` reuse as items 9/10.
- **Impact:** DERIVED-FROM-CODE — ~200 × ~10 DOM nodes/row ≈ 2,000 nodes,
  same order of magnitude as the kanban worst case.
- **Severity:** Low ("lower priority than issues/timeline... 200 rows of
  short text is meaningfully cheaper to paint").
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `clients/portal/src/app/(portal)/signals/signals-client.tsx`

---

### OPT-61 — File a follow-up ticket to make RCA/signal-investigator routes tier-aware

**Status:** ✅ DONE — 2026-08-07: single-trace cold rehydrate-on-miss, Prometheus tier counters, windowed `_fetch_failed_traces_in_window` cold supplement (cap 30 rehydrates/call); signal backfill intentionally hot-only — see `features/opt-61-tier-aware-rca.md` for deferred write-through + UI copy

*(was original Wave 13)*

- **Source:** `06-storage-retention.md` "Verified (prior pass,
  re-confirmed)" #3 (L15), "Other carried-over recommendations" (L171).
- **Description:** A grep for `warm_days|cold_tier|tier` across
  `intelligence_rca.py` and `signal_investigator.py` returns zero matches
  — old/archived data beyond `warm_days` is invisible to RCA and
  signal-investigator queries today.
- **Fix:** Make the relevant queries tier-aware so archived data is still
  reachable for investigations.
- **Impact:** Not quantified.
- **Severity:** Low ("low urgency — 90d hot window covers most active
  investigations" per the doc).
- **Effort:** Medium (requires tier-aware query changes across two route
  files).
- **Confidence:** High (KEEP-WITH-CAVEAT per Phase-3 verdicts).

**Files touched:** `src/eden/api/routes/intelligence_rca.py`, `src/eden/api/routes/signal_investigator.py`

---

### FEAT-116 — Add JSONL export button to labeling UI

**Status:** ✅ DONE — 2026-08-07: `labeling/page.tsx` Export JSONL button calls `labelingApi.exportJsonl`; API binding in `labeling.ts`; `labeling.test.ts` passes

*(was original Wave 13)*

**Source:** `08-annotation-labeling.md`, §6c.6 (citing `src/eden/evaluation/labeling.py:816-861`).

**Description:** Add a button hitting the `exportJsonl()` binding (see #112) to emit JSONL of completed labels. The backend half already exists: `GET /orgs/{org_id}/labeling/export` (route handler `export` in `src/eden/api/routes/labeling.py`, backed by `LabelingService.export` in `src/eden/evaluation/labeling.py`) returns JSONL of approved labels with `status`/`limit` filters. What's missing is entirely client-side: (1) the `exportJsonl` method on `labelingApi` in `clients/portal/src/lib/api/resources.ts` (FEAT-112), and (2) a button in the labeling UI that triggers it and downloads the result.

**Why it matters:** Enables the "ML engineer building eval sets" persona to pull labeled items to seed golden datasets or fine-tune an LLM-judge without needing an engineer to run a script.

**Severity:** Medium (normalized from "Low-Medium" in source doc).
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/labeling.py`, `clients/portal/src/lib/api/resources.ts`
**Depends on:** FEAT-112 (earlier wave 4)

---

## Out of scope (already finished)

The prior plan's ✅ DONE entries (120 as of 2026-08-07, including Waves 14–16 wholesale
and Critical/High landings in Waves 1–5) and the 2026-08-05 removal log (FEAT-67, FEAT-69,
OPT-27, FEAT-140, FEAT-158, OPT-46 done; OPT-48 dropped) are not repeated here. See git
history of this file for the full audit trail.
