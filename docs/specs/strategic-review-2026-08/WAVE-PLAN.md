# Eden Strategic Review — Parallel Execution Wave Plan

**Finalized 2026-08-05.** All 284 verified points were individually triaged against the codebase
as of `6f2a09d3` (2026-08-05); 6 already-done points and 1 dropped point were removed from the
plan body, and the plan now carries **277 actionable entries** (12 partial, 265 open), each with a
**Status** line. See [Finalization pass](#finalization-pass-2026-08-05) for the verification
method, status legend, plan-level audit findings, and the removal log.

## What this is

This document is the final execution plan for the 2026-08 strategic review of Eden. It takes
every distinct, actionable point from the review's three ranked backlogs —
[`RANKED-BUGS.md`](./RANKED-BUGS.md) (58 points, ids `BUG-N`; the doc's own header claims 59 but
defines only BUG-1–BUG-58), [`RANKED-OPTIMIZATIONS.md`](./RANKED-OPTIMIZATIONS.md)
(61 points, ids `OPT-N`), and [`RANKED-FEATURES.md`](./RANKED-FEATURES.md) (185 points, ids `FEAT-N`) — and
organizes them into 16 sequential "waves" of parallel work. The plan originally carried
**284 entries**: 281 single points plus 3 grouped entries (`BUG-36-50` in Wave 12, `BUG-51-54` and
`BUG-55-58` in Wave 13) that cover 23 closely-related bug ids as batches; after the 2026-08-05
removal of finished/dropped work (6 done + 1 dropped — see the removal log) it now carries
**277 entries**. Coverage was complete at verification time: every id defined in the three ranked
backlogs appeared in exactly one of the 284 entries, including the 7 since removed (verified
2026-08-05).

**How this was built:** (1) Each point was tagged with the concrete set of files it
touches and, where a point's fix genuinely presupposes another point's fix landing first, the ids
it depends on — this metadata lives in `_pass4-notes/WAVE-META-{bugs,optimizations,features-1,features-2}.json`.
(2) That metadata was fed into a dependency/conflict graph over all 284 points. (3) A greedy
programmatic scheduler (`_pass4-notes/schedule_waves.py`) walked the graph — respecting
dependency ordering, avoiding any two same-wave points that touch a common file, prioritizing
higher-severity points into earlier waves, and **capping each wave at 20 points** — to produce the
wave assignment in `_pass4-notes/WAVE-ASSIGNMENT.json`. That assignment is trusted as-is here; this
document does not re-derive it, only renders it with full point-level detail restored from the
three source docs.

An earlier, uncapped version of this schedule produced only 9 waves, but its first wave alone held
150 of the 284 points — not a practically actionable single batch for any real team or agent fleet
to pick up at once. This version instead caps each wave at **20 points**, reflecting a realistic
ceiling on how many points can be staffed and landed truly simultaneously (roughly ~20 parallel
engineers/agents), spreading the same dependency-respecting, conflict-free schedule across more,
smaller waves instead.

**What a "wave" means:** every point in a given wave touches **no files in common** with any other
point in that same wave, and **every prerequisite it depends on is satisfied by an earlier wave**.
Practically: all points in a wave can be assigned to separate engineers (or separate agents) and
worked on **simultaneously**, with zero risk of merge conflicts or of one engineer's change
invalidating an assumption another engineer's fix depends on. The waves are meant to be worked
**in order** — complete every point in Wave N (or explicitly defer/reassign it) before starting
Wave N+1, since Wave N+1's own no-conflict/dependency-satisfied guarantee assumes Wave N's file
changes have already landed. *(See the finalization audit below for five known same-wave file
overlaps that weaken this guarantee in Waves 1–2.)*

**Point ordering within each wave:** bugs first, then optimizations, then features; each group
internally ordered by its original rank in the source doc (i.e. severity-first, as originally
ranked). Each point below is reproduced at full fidelity from its source doc — title, source
citation, description/fix, blast-radius/impact, severity, effort, and confidence — with three
lines appended: **Status** (from the 2026-08-05 finalization pass), **Files touched** (from the
wave-scheduling metadata) and, where non-empty, **Depends on** (prerequisite ids; always satisfied
by an earlier wave, included here for traceability only).

## Finalization pass (2026-08-05)

Every point was re-verified against the working tree at `6f2a09d3` with a decisive code-level
check (targeted grep / file read of the cited sites, plus `git log -S` where a recent fix was
plausible). The review's source docs predate a week of heavy landing activity (F49 playground,
F56 CI evals, F58/F61/N12 portal work, F06/F12, the deferred-router refactor `dd33eb7d`, the
Typesense fixes, the Go/Rust SDK deletion), so statuses — not just descriptions — needed
establishing. Line-number citations that had drifted were re-anchored (preferring symbol names
over raw line numbers); descriptions contradicted by current code were corrected in place; thin
points that deferred to "as specified in the source doc" now inline the concrete specifics so each
point is self-contained and executable.

**Status legend** (first line of every point):

| Status | Meaning |
|---|---|
| 🟡 **PARTIAL** | Materially advanced by landed work; the Status line names exactly what remains. |
| ⬜ **OPEN** | Re-verified still present/missing on 2026-08-05, with one-line evidence. |

Done/dropped entries were removed from the plan body — see *Removed from the plan* below.

**Tally: 277 actionable entries — 12 partial · 265 open** (of 284 verified; 6 done + 1 dropped removed, logged below).

### Removed from the plan (2026-08-05)

Six points were verified already done and one was dropped; their full entries were removed to keep the plan action-only:

- **FEAT-67** (W4, done) — Fix `time_travel/replayer.py:453` — always-raising `AIGateway.complete()` call site: `_re_execute_step` now routes through the shared `get_ai_gateway()` singleton and falls back to recorded hash/tokens/cost on gateway failure (`re_executed=False, cannot_replay=True`; guard landed in 16451d16/67a00d35), and the "AIGateway is dormant" premise is obsolete — `get_ai_gateway()` serves the live `/gateway/v1/chat/completions` path.
- **FEAT-69** (W5, done) — Make Python's missing-`org_id` failure loud instead of silently swallowed: `EdenConfig.validate()` (`sdk/python/eden_sdk/config.py:314-329`) now raises a `ValueError`, called automatically by `configure()` (`config.py:489`), so a missing `org_id` fails loudly at startup instead of being swallowed at flush time (commit 05d4bb5b, sdk 0.2.8).
- **OPT-27** (W7, done) — Fix duplicate-fleet-on-deploy risk (`eden-worker`'s `runOnSourceChange: cd-promote`): resolved 2026-07-29 — `northflank.yml` now sets `EDEN_RUN_BACKGROUND_WORKERS: "0"` on the `eden-worker` job (fleet moved into `eden-api`), so deploy-triggered job runs no longer start a duplicate fleet copy; the job is retained as a break-glass host only.
- **FEAT-140** (W10, done) — Add a demote path to the working (undocumented) `EvalToGuardrailLink`: `EvalToGuardrailLink.demote` now exists at `src/eden/guardrails/intervention.py:905` (commit 95401573), calling `_disable_eval_guardrail_link` and refreshing the live guardrail filter wiring, with a `not_found` envelope for unknown judges.
- **FEAT-158** (W11, done) — Audit whether other GA-default-on features have similarly stubbed/misleading portal routes: commit 0ddf3c0f (2026-08-04, "route coherence") performed exactly this audit and made it regression-proof — `STUB_TRY_INSTEAD` extracted to `clients/portal/src/lib/stub-try-instead.ts`, a nav ↔ registry ↔ live-page parity test (`nav-registry-parity.test.ts`), all 129 redirect rules verified live, and `/playgrounds` un-stubbed.
- **OPT-46** (W12, done) — Rename/annotate the `signal_investigator_llm_v1` feature flag to prevent accidental reintroduction of real LLM spend: the "annotate" option landed — the flag definition now carries an explicit "LLM path removed — StatGate/heuristics only" comment (`config.py:1448-1449`), and commit 64233475's rebuilt `investigate_trace_endpoint` docstring states the LLM path was retired and the flag-off state returns an honest `disabled` envelope.
- **OPT-48** (W13, dropped) — (Deprioritized/CUT) `_scout_novel_patterns` digest/`existing_block` dedup in `soft_issue_review.py`: the source doc itself downgraded this to CUT — worst-case system-wide impact ≤~$6/month against a run already bounded at 20 orgs × 3 agents nightly; revisit only if nightly volume grows.

**Plan-level audit findings** (full detail in [`_finalize/coverage.md`](./_finalize/coverage.md)):

- **Coverage is complete** — measured over the original 284 verified entries, including the 7
  since removed as done/dropped. All 304 ids defined across the three ranked backlogs mapped into
  those 284 entries (281 singles + 3 grouped entries covering 23 bug ids). No plan id is absent
  from a ranked doc; no duplicates. `WAVE-ASSIGNMENT.json` matches the verified set exactly
  (284/284 — the 277 entries here plus the 7 logged in *Removed from the plan* above).
  `RANKED-BUGS.md`'s claimed "59 points" is a header off-by-one — BUG-59 was never defined.
- **Dependencies are sound.** All 66 `Depends on:` edges reference an existing point scheduled in
  a strictly earlier wave; zero violations.
- **Five known same-wave file overlaps** (the scheduler compared raw file strings, so
  `file.py (func)` annotations and path-spelling variants defeated its conflict check):
  Wave 1 — FEAT-8/FEAT-10 (`soft_issue_review.py`), FEAT-12/FEAT-13 (`playground/scorers.py`),
  FEAT-14/FEAT-15 (`realtime/alert_stream.py`); Wave 2 — BUG-4/FEAT-18
  (`clients/portal/src/lib/api/resources.ts`), BUG-4/OPT-9 (`issues-client.tsx`).
  Assign each overlapping pair to the same engineer/agent or sequence them within the wave.
  Waves 3–16 were not exhaustively re-checked for the same defect; treat the no-conflict guarantee
  as strong-but-not-absolute there too. 21 FEAT points carry no files-touched metadata at all
  (`_(none listed)_`), making the guarantee vacuous for them.
- **Migration-number coordination required.** Three separate fixes each reserve migration number
  `143_*` (OPT-1/OPT-16's `143_signal_events_indexes`, FEAT-56's
  `143_session_summaries_user_index`, and doc 13's `143_nl_signals_agent_id`), and the tree
  already contains two colliding `135_*` migrations (see FEAT-98). Assign migration numbers at
  implementation time, not from these docs.
- **Generation artifacts repaired.** Six stray severity-tier headings (`### HIGH`,
  `### MEDIUM-HIGH`, `### MEDIUM`, `### LOW-MEDIUM`, `### LOW`) that had been emitted inside
  point bodies were removed, and the three `## High` / `## Medium` / `## Low` tier dividers that
  had split FEAT-26, FEAT-92, and FEAT-165 from their own **Files touched** lines were moved to
  sit cleanly between waves.

## Summary

Across **16 waves**: sizes 20, 20, 20, 19, 19, 20, 19, 20, 20, 19, 19, 19, 19, 18, 3, 3 (**277 total**).

The waves are grouped below into four **severity bands** by their predominant tier — Critical (Waves 1–2), High (3–6), Medium (7–11), Low (12–16). A few points straddle bands; the table has exact per-wave mixes.

| Wave | Points | Critical | High | Medium | Low | Bugs | Opts | Feats | 🟡 | ⬜ |
|---|---|---|---|---|---|---|---|---|---|---|
| [1](#wave-1) | 20 | 20 | 0 | 0 | 0 | 3 | 2 | 15 | 0 | 20 |
| [2](#wave-2) | 20 | 11 | 9 | 0 | 0 | 4 | 7 | 9 | 0 | 20 |
| [3](#wave-3) | 20 | 1 | 19 | 0 | 0 | 2 | 4 | 14 | 0 | 20 |
| [4](#wave-4) | 19 | 1 | 18 | 0 | 0 | 0 | 2 | 17 | 1 | 18 |
| [5](#wave-5) | 19 | 0 | 19 | 0 | 0 | 0 | 0 | 19 | 2 | 17 |
| [6](#wave-6) | 20 | 0 | 12 | 8 | 0 | 6 | 2 | 12 | 1 | 19 |
| [7](#wave-7) | 19 | 0 | 2 | 17 | 0 | 5 | 12 | 2 | 2 | 17 |
| [8](#wave-8) | 20 | 0 | 2 | 18 | 0 | 2 | 4 | 14 | 0 | 20 |
| [9](#wave-9) | 20 | 0 | 0 | 20 | 0 | 0 | 2 | 18 | 2 | 18 |
| [10](#wave-10) | 19 | 0 | 0 | 19 | 0 | 0 | 2 | 17 | 1 | 18 |
| [11](#wave-11) | 19 | 0 | 0 | 15 | 4 | 4 | 0 | 15 | 3 | 16 |
| [12](#wave-12) | 19 | 0 | 0 | 5 | 14 | 6 | 7 | 6 | 0 | 19 |
| [13](#wave-13) | 19 | 0 | 0 | 2 | 17 | 5 | 10 | 4 | 0 | 19 |
| [14](#wave-14) | 18 | 0 | 0 | 2 | 16 | 1 | 2 | 15 | 0 | 18 |
| [15](#wave-15) | 3 | 0 | 0 | 0 | 3 | 0 | 1 | 2 | 0 | 3 |
| [16](#wave-16) | 3 | 0 | 0 | 0 | 3 | 0 | 1 | 2 | 0 | 3 |
| **Total** | **277** | **33** | **81** | **106** | **57** | **38** | **58** | **181** | **12** | **265** |

---

## Critical band (Waves 1–2)

---

## Wave 1

**20 points** (3 bugs, 2 optimizations, 15 features) — severity mix: 20 Critical. All points in this wave touch disjoint file sets and have no unmet prerequisites — this is the starting wave. **Status as of 2026-08-05:** 20 remaining (0 partial, 20 open).

### BUG-1 — Fix `TriageAgent`'s `UnboundLocalError` that crashes every successful (non-error) investigation

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/issues/triage_agent.py` still assigns `llm_error` only at `:266`/`:270`, both inside `except` blocks; no initializer before the `try`, so `if llm_error:` at `:282` still raises on the normal path)

**Source:** `bugs/04-frontend-and-test-failures.md` §7b(i)

**Description:** `src/eden/issues/triage_agent.py:282` reads `if llm_error:` but `llm_error` is
only ever assigned in two places: `:266` (`llm_error = False`), which sits **after** a `return`
inside the `except TimeoutError:` block and is therefore dead/unreachable, and `:270`
(`llm_error = True`) inside `except Exception as exc:`. There is no assignment on the normal
success path. `git blame` traces both additions to commit `ab490f2a` ("fix(loop): make two silent
dishonesty paths loud"), which shipped with the initializer misplaced. Confirmed by running the
full backend test suite fresh: `tests/integration/golden_path/test_scenario_code_bug.py::test_issue_created_triage_transition`
and `tests/intelligence/test_triage_agent.py::test_triage_falls_back_to_llm` both fail with this
exact `UnboundLocalError`, and the orchestrator's own log shows it firing on the **normal**
investigation path. **Fix:** initialize `llm_error = False` at the top of the function (before
the `try`), one line.

**Blast radius:** Every real triage run in production that resolves normally (the common case)
degrades: `orchestrator.py`'s retry cap (`_TRIAGE_MAX_ATTEMPTS = 2`) exhausts, then escalates to
a human (`_escalate_human`, `reason="triage_failed"`) instead of crashing outright — so issues
don't vanish, but **automatic LLM/heuristic triage is completely defeated end-to-end**, with no
alert/error surfaced beyond a human seeing an unexplained escalation.

**Severity:** Critical (core automation feature broken on its main path, live today).
**Effort:** Small — one-line fix. **QUICK WIN.**
**Confidence:** High (reproduced via fresh full-suite run, root-caused via `git blame` to an
exact commit and line).

**Files touched:** `src/eden/issues/triage_agent.py`

---

### BUG-2 — Fix the portal trace-status badge that renders `timeout`/`crash` traces as green "ok"

**Status:** ⬜ OPEN — verified 2026-08-05 (`_map_trace_outcome` at `portal.py:177-183` still checks the narrow 5-value tuple; `_ERROR_OUTCOMES` still defined at `:187` and used by the same endpoints at `:460`/`:649`)

**Source:** `bugs/02-data-consistency.md` Bug 9 (doc's own "worst finding," promoted pass 5)

**Description:** `src/eden/api/routes/portal.py:177-183` (`_map_trace_outcome`) checks
`o in ("error", "failed", "failure", "fail", "errored")` for the "error" status, omitting
`"crash"` and `"timeout"` — even though the correct set, `_ERROR_OUTCOMES` (`:187-189`,
`{"error","failed","failure","fail","errored","crash","timeout"}`), is defined nine lines below
it and is used by the exact same two endpoints (`GET /traces` list at `:1284`, trace detail at
`:1464`) to compute the `error_detail` field in the *same* response payload. Net effect: a trace
whose only failure is `outcome='timeout'` shows a green/neutral "ok" badge while the same
response's `error_detail` field may contain a real error message — visually "fine" while
displaying error text. Existed since ~2026-07-23 (~2 weeks before this review), not aged debt.
**Fix:** make `_map_trace_outcome` reuse `_ERROR_OUTCOMES` instead of its own narrower tuple.

**Blast radius:** The primary customer-facing trace list and trace-detail pages, for every org,
on every page view of a timeout/crash trace — no reachability caveat, no dead code in the path.

**Severity:** Critical (live, high-frequency, visibly-wrong core UI signal).
**Effort:** Small — swap one literal tuple for the existing frozenset. **QUICK WIN.**
**Confidence:** High.

**Files touched:** `src/eden/api/routes/portal.py`

---

### BUG-3 — Reject (don't silently coerce) invalid `resolve_issue` status values

**Status:** ⬜ OPEN — verified 2026-08-05 (`agent_issues.py:173` still reads `target = body.status if body.status in _RESOLVE_STATUSES else "resolved"`; `_RESOLVE_STATUSES` now at `:114`)

**Source:** `bugs/02-data-consistency.md` Bug 8a **+** `bugs/03-api-mcp-contracts.md` #10
(independently found from an API-contract-correctness angle; that doc's own top-ranked finding)
— **corroborated by 2 independent docs.**

**Description:** `src/eden/api/routes/agent_issues.py` (`ResolveRequest` +
`_RESOLVE_STATUSES = {"open","acknowledged","resolved","ignored"}` at `:114`) and
`resolve_issue` (`:167-223`) do `target = body.status if body.status in _RESOLVE_STATUSES else "resolved"`
(`:173`) — any out-of-scope or typo'd status value (a DB-legal-but-out-of-scope value like `"triaged"`,
or a plain typo) silently becomes `"resolved"` rather than a 400. This is not inert: the
`resolved` branch unconditionally fires **four** side-effect pipelines —
`on_issue_resolved` (creates regression test cases), `RegressionRunner().run_suite` (kicks off a
full regression run), `IssuePromptEvolver().evolve_from_issue` (see #8 below — can itself trigger
an orphan-prompt bug), and the flywheel coordinator's `on_issue_resolved`. **Fix:**
`raise HTTPException(400, ...)` when `body.status not in _RESOLVE_STATUSES` instead of coercing.

**Blast radius:** Every caller of `POST /orgs/{org}/agent-issues/{id}/resolve` (portal Issues
board, any direct API caller) that sends an unexpected status value silently resolves the issue
and kicks off four automation pipelines the caller never asked for.

**Severity:** Critical (silent, unintended trigger of real automation/regression pipelines).
**Effort:** Small — replace ternary with an `HTTPException`. **QUICK WIN.**
**Confidence:** High — independently discovered by two review docs from different angles.

**Files touched:** `src/eden/api/routes/agent_issues.py`

---

### OPT-1 — Add missing composite indexes for `signal_events`'s two real read paths

**Status:** ⬜ OPEN — verified 2026-08-05 (only index remains `idx_signal_events_trace` from migration `092_market_ready_consolidated.py:58`; both read paths intact — `list_signal_events` at `signal_investigator.py:41` with `ORDER BY detected_at DESC` at `:64`, `cluster_signal` at `clusterer.py:57` with `matched = TRUE ... ORDER BY detected_at DESC` at `:78-80`. Note: latest migration is `142_session_summaries`, so `143` is next — but doc 13's Loop 1 plan (FEAT-8's parent Task 1a) also reserves `143_nl_signals_agent_id.py`; whichever lands second must renumber.)

**QUICK WIN — Critical severity, Small effort, migration fully drafted.**

- **Source:** `02-db-queries.md` F1 (L73-213) — the source doc's own #1
  priority item, "Priority order for execution."
- **Description:** `signal_events` has shipped since migration 092 with
  exactly one index — a bare `(trace_id)` btree — which serves neither of
  the table's two real read patterns: (1) `list_signal_events`
  (`src/eden/api/routes/signal_investigator.py`, `async def list_signal_events` at `:41`) filters
  `WHERE org_id = $1 AND signal_id = $2 [AND matched = $3] ORDER BY
  detected_at DESC`; (2) `cluster_signal` (`src/eden/signals/clusterer.py:57-80`) filters
  `WHERE org_id = $1 AND signal_id = $2 AND matched = TRUE AND
  detected_at >= $3 ORDER BY detected_at DESC LIMIT 500`. Neither query can
  use the trace_id index. Write volume: up to 20 rows per trace (bounded by
  `signal_definitions`' `LIMIT 20`), from `investigator.py`'s per-row
  insert loop. The team's own `scripts/cost_model.py` documents
  `ROWS_PER_TRACE=35` at `TRACES_PER_ORG_DAY=1,000` for an
  "actively-instrumented org" (a documented cost assumption, not measured
  production data).
- **Fix (exact migration provided in source doc):** New migration
  `src/eden/db_migrations/versions/143_signal_events_indexes.py` (renumber if
  doc 13's `143_nl_signals_agent_id.py` lands first) adding two
  `CREATE INDEX IF NOT EXISTS`
  statements: (a) a full composite
  `idx_signal_events_org_signal_detected ON signal_events (org_id,
  signal_id, detected_at DESC)`, needed because `list_signal_events` passes
  `matched` as a bound parameter (not provable at plan time); (b) a partial
  index `idx_signal_events_org_signal_matched_detected ON signal_events
  (org_id, signal_id, detected_at DESC) WHERE matched = TRUE`, usable
  because `clusterer.py` hardcodes `matched = TRUE` as a literal. No
  `CONCURRENTLY` needed — `signal_events` is INSERT-only, so a plain
  `CREATE INDEX IF NOT EXISTS` never blocks inserts. Both additive, zero
  downtime, no backfill.
- **Impact:** Not independently latency-benchmarked (no live Postgres
  available during review), but the missing-index fact is VERIFIED with
  certainty against migration files and live application code, and both
  real read-path queries provably cannot use the existing index.
- **Severity:** Critical (source doc's own top-ranked tier).
- **Effort:** Small (migration fully drafted, additive, zero-downtime).
- **Confidence:** High.

**Files touched:** `src/eden/api/routes/signal_investigator.py`, `src/eden/signals/clusterer.py`, `src/eden/db_migrations/versions/143_signal_events_indexes.py (new)`, `signal_events (table)`

---

### OPT-3 — Fix `auto_curator`'s unwatermarked org-selection query

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/workers/cron_tick.py:202` in `_run_auto_curator` still runs the verbatim `SELECT id::text AS org_id FROM organizations LIMIT 50` with no `ORDER BY` and no watermark)

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

### FEAT-1 — Implement the SSO login/callback IdP token exchange (currently a scripted 503, not a partial feature)

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/api/routes/sso.py` `sso_callback` still unconditionally raises `HTTPException(503, {"status": "sso_not_enabled"})` after state validation, at `:667-680`; no SSO commits in the last week's log)

**Source:** `07-security-compliance.md`, §1b (citing `src/eden/api/routes/sso.py`, `sso_callback` — the 503 raise now sits at `:667-680`, drifted from the doc's `:652-683`; test `tests/intelligence/test_sso_state_csrf.py::test_callback_consumes_state_and_succeeds`)
**Description:** `POST /sso/callback/{provider_id}` validates the CSRF state correctly, then unconditionally raises `HTTPException(503, {"status": "sso_not_enabled"})` for every call — even a correctly round-tripped state. The docstring names the reason: IdP token exchange (SAML assertion validation / OIDC code exchange) is not wired up because it needs per-tenant IdP secrets with no safe broker location yet. `initiate_sso_login` builds a genuinely valid Okta/Google/OIDC authorize URL and sends the browser to the real IdP; the IdP authenticates the user and redirects back with a real code/assertion; eden then discards it and 503s — after the user already authenticated with their own IdP. Fix: implement the actual SAML assertion validation / OIDC code exchange in `sso_callback`, including a secure per-tenant IdP secret broker.
**Why it matters:** This fails at the worst possible point in the flow — after the user's own identity provider has already succeeded — which looks to a buyer's IT team like eden's system broke mid-flow rather than declined to offer the feature. The portal pricing page lists "SSO/SCIM" as an Enterprise-tier feature against this exact backend; that claim cannot be honored for any org not authenticating entirely outside eden's own SSO routes (e.g., via Clerk directly). This is a Critical procurement blocker for any enterprise deal requiring self-service SSO.
**Severity:** Critical
**Effort:** Large
**Confidence:** High

**Files touched:** `src/eden/api/routes/sso.py (sso_callback, initiate_sso_login)`

---

### FEAT-2 — Fix the Typesense RTBF fanout to actually target user-owned documents (add `user_id` to schema)

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/observability/typesense_client.py` contains no `user_id` outside `delete_by_user` at `:588-590`, whose filter `tenant_id:={org} && user_id:={user}` still targets a field `SPAN_SCHEMA` never defines; `rtbf_fanout.py` still calls it and reports per-store "ok")

**Source:** `07-security-compliance.md`, §2b fanout table, §4 point 4 (citing `src/eden/observability/typesense_client.py:67-97,588-591`)
**Description:** `src/eden/services/governance_intel/rtbf_fanout.py`'s Typesense deletion calls `delete_by_user(org_id, user_id)`, which filter-deletes on `"tenant_id:={org} && user_id:={user}"` — but `SPAN_SCHEMA` has 21 fields and no `user_id` field, and `build_span_doc` never sets one. The filter targets a field that doesn't exist, the call doesn't raise, and the fanout falsely reports `status: "ok"` with `deleted: 0` — the indexed `input_text`/`output_text` (actual prompt/completion content) stays fully searchable. Fix: add a `user_id` field to the Typesense span schema, backfill/reindex existing documents, and update the fanout filter to actually match; or, if reindexing is infeasible short-term, change the fanout to report `status: "unsupported"` (matching the honest pattern already used for Qdrant/S3) instead of a false "ok."
**Why it matters:** This is the most severe of the two false-positive fanout bugs, since Typesense holds full searchable prompt/completion text — a re-search for the "erased" user's data would still return their actual conversation content, directly contradicting a reported successful erasure, exactly the kind of gap a SOC2 Type II auditor samples for.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/services/governance_intel/rtbf_fanout.py`, `src/eden/observability/typesense_client.py (SPAN_SCHEMA, build_span_doc)`

---

### FEAT-3 — Neutralize or remove the `install_cat15_trajectory_replaces_intervention` hot-path monkey-patch

**Status:** ⬜ OPEN — verified 2026-08-05 (patch still defined at `src/eden/observability/trace_quality/wiring.py:279`, still installed by `install_all()` in the same module — i.e., default-on — which rebinds `InterventionEngine.evaluate_and_act` to the wrapped version)

**Source:** `features/12-runtime-guardrails.md` — core finding, monkey-patch section (B12-1)
**Description:** A default-on hot-path monkey-patch, `install_cat15_trajectory_replaces_intervention` (`src/eden/observability/trace_quality/wiring.py:279`, invoked from `install_all()`), silently swaps out eden's real content-safety guardrail checks (`InterventionEngine.evaluate_and_act`, fail-closed and correctly designed) for unrelated cost/loop/latency checks whenever a `trace_id` is passed. It also returns `edited_text` unredacted, meaning content that should have been redacted per policy passes through untouched. This happens with zero monitoring anywhere in the system to detect that it's occurring. Fix: remove this monkey-patch entirely, or at minimum make it opt-in/explicitly gated rather than default-on, and restore `evaluate_and_act` as the actual enforcement path whenever `trace_id` is present.
**Why it matters:** This is a silent safety-guardrail bypass in a product whose core value proposition includes runtime safety enforcement — any customer relying on eden's guardrails for content safety is currently not actually protected whenever this patch's trigger condition (`trace_id` present) is met, with no alerting anywhere to reveal this. This is a trust and liability-level issue, not just a bug.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/observability/trace_quality/wiring.py (install_cat15_trajectory_replaces_intervention, install_all)`, `InterventionEngine.evaluate_and_act`

---

### FEAT-5 — Consolidate the three non-communicating GDPR erasure routes into one, wired to `RightToBeForgottenService`

**Status:** ⬜ OPEN — verified 2026-08-05 (all three routes still present and still non-communicating: `DELETE /api/v1/me` in `compliance.py`; `DELETE /users/me` at `auth.py:2032`; `RightToBeForgottenService` in `governance_intel/gdpr.py` — zero `rtbf`/`RightToBeForgotten` references in `compliance.py` or `auth.py`; portal `deleteAccount` at `resources.ts:455` still has zero component callers)

**Source:** `07-security-compliance.md`, §2a-2c, §4 recommended framing (citing `src/eden/api/routes/compliance.py` (`DELETE /api/v1/me`); `src/eden/services/compliance_jobs.py`; `src/eden/api/routes/auth.py` (`DELETE /users/me`, now at `:2032`, drifted from the doc's `:2039`); `src/eden/services/governance_intel/gdpr.py`)
**Description:** Three deletion implementations exist and don't communicate: `DELETE /api/v1/me` (anonymizes only `users` + deletes `org_members`; zero portal callers), `DELETE /users/me` (narrower still — sets `deleted_at` and rotates `token_version` only, doesn't anonymize email/name or null `password_hash`; the portal's `deleteAccount()` client function calls this route but has zero component callers anywhere in the rendered tree), and `RightToBeForgottenService.process_request` (the broad, well-engineered six-table-plus-cross-store-fanout version, reachable only via `POST /governance/rtbf`, gated behind `rtbf_fanout_v1` which defaults `False`, and never called by the other two paths). None of the three has a UI element calling it — a real DSAR today means a support engineer hand-calling one of three inconsistent endpoints from a terminal. Fix (per doc's explicit P0/P1 recommendation): retire two of the three routes (or make the narrow ones call the broad `RightToBeForgottenService`), wire the survivor to a real "Delete my data" UI element in account settings.
**Why it matters:** This is a genuine, unconditional GDPR Article 17 exposure today — a user who files `DELETE /api/v1/me` gets a success response while their actual trace content, conversation transcripts, feedback comments, and judge rationale text survive untouched indefinitely in the same database. The doc explicitly frames this as active regulatory exposure masked only by low current user count, not a marketing-copy issue.
**Severity:** Critical
**Effort:** Large
**Confidence:** High

**Files touched:** `src/eden/api/routes/compliance.py (DELETE /api/v1/me)`, `src/eden/services/compliance_jobs.py`, `src/eden/api/routes/auth.py (DELETE /users/me)`, `src/eden/services/governance_intel/gdpr.py (RightToBeForgottenService.process_request, POST /governance/rtbf)`, `clients/portal/src/lib/api/resources.ts (deleteAccount) + new account-settings UI`

---

### FEAT-6 — Un-stub the `/artifacts` portal route

**Status:** ⬜ OPEN — verified 2026-08-05 (no `artifacts` directory exists under `clients/portal/src/app/(portal)/`; the stub is a redirect rule in `clients/portal/next.config.ts:275-280` sending `/artifacts` and `/artifacts/:path*` to `/improve?mode=queue`)

**Source:** `features/15-artifacts-behavior-record.md` — portal wiring gap section (B15-1)
**Description:** The `/artifacts` route in the portal is currently a dead stub that redirects to `/improve?mode=queue` — implemented not as a route file but as redirect rules in `clients/portal/next.config.ts` (`{ source: "/artifacts", destination: "/improve?mode=queue", permanent: false }` plus a `/artifacts/:path*` rule) — despite eden already having shipped the actual backend equivalent of Lemma's "Artifacts" feature (`nudges`/`ArtifactAuthor`/`ArtifactDemotionWorker`, GA-default-on, injected live into production prompts) and despite product copy already referencing this as a real feature. Fix: build the real `/artifacts` view backed by the existing API (which the doc confirms already exists) as a new `clients/portal/src/app/(portal)/artifacts` route, and remove the next.config.ts redirect rules.
**Why it matters:** This is a fully-built, GA-default-on production feature (already affecting live prompts) that customers cannot actually view or manage through the product UI — arguably worse than a feature gap, because the feature is actively running in production unobserved by the people it affects.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `clients/portal/next.config.ts (redirect rules)`, `clients/portal/src/app/(portal)/artifacts (new route)`, `nudges API / ArtifactAuthor`, `ArtifactDemotionWorker`

---

### FEAT-7 — Un-stub the `/ledger` portal route

**Status:** ⬜ OPEN — verified 2026-08-05 (no `ledger` directory exists under `clients/portal/src/app/(portal)/`; redirect rules at `clients/portal/next.config.ts:281-286` still send `/ledger` and `/ledger/:path*` to `/improve?mode=queue`)

**Source:** `features/15-artifacts-behavior-record.md` — portal wiring gap section (B15-2)
**Description:** Same pattern as #6: `/ledger` also redirects to `/improve?mode=queue` as a dead stub (redirect rules in `clients/portal/next.config.ts`, same shape as `/artifacts`; note a separate rule for `/agents/:id/ledger` exists at `:146` only to keep an agent cross-link from 404ing), despite the Ledger (`src/eden/kb/ledger/`) being a real, GA-default-on (`ledger_v1` flag) production system. Fix: build the real `/ledger` view backed by the existing Ledger API as a new `clients/portal/src/app/(portal)/ledger` route, and remove the redirect rules.
**Why it matters:** Same rationale as #6 — a live, production-affecting feature (the Ledger, which per the doc backs prompt injection via `BookGatewayFilter`) has no way for customers to see or audit what's in it, undermining transparency into a system actively shaping production prompts.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `clients/portal/next.config.ts (redirect rules)`, `clients/portal/src/app/(portal)/ledger (new route)`, `src/eden/kb/ledger/`, `BookGatewayFilter`

---

### FEAT-8 — Fix Loop 1 (shadow-detector confirm/dismiss loop) — step P0-A of the revival plan

**Status:** ⬜ OPEN — verified 2026-08-05 (`record_shadow_feedback` at `soft_issue_review.py:571` still has zero callers outside its own module; `resolve_issue`'s side-effect gate is still `resolved`-only at `agent_issues.py:180`)

**Source:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-A fix step (B13-1)
**Description:** Loop 1 (the shadow-detector confirm/dismiss loop backing `src/eden/services/soft_issue_review.py` and the `nl_signals` table) is currently fully dead code — built but not actually functioning end-to-end: `record_shadow_feedback(org_id, signal_id, *, confirm=None, dismiss=None)` (`soft_issue_review.py:571-618`), the sole writer of the `rule.operator_confirms`/`rule.operator_dismisses` counters, has zero production callers, so the weekly `promote_shadow_detectors()` job always hits the `labeled == 0` branch of `evaluate_shadow_precision` (`precision = None`) and can never promote anything. **P0-A ("Recover `signal_id` at resolve time") — the exact fix per the source doc's Task 1(b)/(c):** in `src/eden/api/routes/agent_issues.py`, extend the `resolve_issue` gate at `:180` from `if ok and target == "resolved":` to also cover `"ignored"` for the feedback call only, then: fetch the issue (`_repo.get_issue`), take `issue.example_stumble_ids[0]`, fetch the stumble via the **already-existing** `IssuesRepo.get_stumble` (`src/eden/issues/repo.py:193-206` — no new repo method needed), proceed only if `stumble["detected_by"] == "signal_investigator"`, extract `signal_id` from `stumble["detail"]` — **guarding `isinstance(detail, str)` and `json.loads`-ing it first**, because `PostgresClient.fetchrow` registers no JSONB codec and returns `detail` as a raw JSON string (a latent bug the source doc found in the existing `_serialize_stumble` caller too) — and finally call `record_shadow_feedback(org_id, signal_id, confirm=(target == "resolved") or None, dismiss=(target == "ignored") or None)`. The four existing `resolved`-only side-effect pipelines stay `resolved`-only. This is step P0-A of the four-step P0-A/B/C/D revival plan (P0-B widens the gate wiring, P0-C makes dismiss auto-disable detectors inline, P0-D adds the MCP tool).
**Why it matters:** This is step one of reviving what the doc frames as the review's flagship finding — a fully-built but entirely non-functional feedback loop where user confirm/dismiss signals should be improving detector quality over time but currently do nothing.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/api/routes/agent_issues.py (resolve_issue)`, `src/eden/services/soft_issue_review.py (record_shadow_feedback)`, `nl_signals table`

---

### FEAT-10 — Build a confirm/dismiss front door for shadow-detector issues — no UI affordance exists anywhere in the portal

**Status:** ⬜ OPEN — verified 2026-08-05 (`record_shadow_feedback` has zero callers in `clients/portal/src` or anywhere else; "dismiss" in the portal matches only onboarding/shell components, nothing under `app/(portal)/issues`)

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section (01-1) **+** `features/16-issue-extraction-online-evals.md`, portal gap section (B16-4) — **corroborated by 2 independent docs**, each reaching the same gap from a different angle (differentiator-value analysis vs. issue-extraction UX audit).
**Description:** `src/eden/services/soft_issue_review.py` (`_create_shadow_detector` at `:333` through `evaluate_shadow_precision`/`promote_shadow_detectors` at `:380-568`) implements a real shadow-detector precision/promote/delete lifecycle — one of the doc's strongest claimed differentiators (no competitor analog found across 19 researched competitors) — but `record_shadow_feedback` (`:571-618`), the function that would let a human confirm or dismiss a shadow-detector finding, has zero callers anywhere in the codebase, and a repo-wide grep for `shadow` under `clients/portal/src` returns only Tailwind `shadow-[...]` box-shadow CSS utility classes, no UI references at all (01-1). Independently, the portal has no Dismiss button/action for issues at all, despite a confirm/dismiss signal being the entire mechanism doc 13's Loop 1 needs to feed back into detector quality (B16-4). Fix: add a confirm/dismiss affordance to `/issues` or `/traces` that calls `record_shadow_feedback` / the correct post-revival dismiss endpoint, giving the on-call engineer a way to interact with this capability and giving Loop 1 (#8, #9) a working UI-side terminus.
**Why it matters:** This is characterized as eden's strongest differentiator with no competitor analog, but until it has any UI entry point it is completely invisible to the only persona who could use or validate it — the capability cannot be adopted, marketed with a live demo, or even dogfooded internally. It is also a hard blocker for Loop 1 (doc 13) ever working end-to-end in production: even a perfectly-fixed backend confirm/dismiss loop is useless with no UI affordance for a real user to dismiss an issue.
**Severity:** Critical
**Effort:** Small–Medium
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/services/soft_issue_review.py (record_shadow_feedback)`, `clients/portal/src/app/(portal)/issues`, `clients/portal/src/app/(portal)/traces`

---

### FEAT-11 — Implement composite issue ranking in `IssuesRepo.list_issues` (currently recency-only)

**Status:** ⬜ OPEN — verified 2026-08-05 (`list_issues` in `src/eden/issues/repo.py` still builds `ORDER BY last_seen DESC LIMIT ... OFFSET ...` with no sort variant, no query param, and no use of `user_count`/`stumble_count`)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`_run_row` still at `offline_runner.py:266`, still labels every score `"method": "heuristic_stub"` at `:287`; control-side stub markers at `:161`/`:196`/`:247`; route still mounted via the deferred-router table at `api/app.py:249`)

**Source:** `02-evals-datasets.md`, §5 P0 items 1-3 (02-1, 02-2, 02-3) **+** `03-prompt-playground.md`, §4 "'Promote to Experiment' is a UX trap" (03-1) — **corroborated by 2 independent docs / 4 independent findings converging on the same root-cause code path.**
**Description:** `OfflineExperimentRunner._run_row` (`src/eden/experiments/offline_runner.py:266-288`), live and API-mounted at `/orgs/{org_id}/experiments/offline` (registered in the deferred-router table at `api/app.py:249` as `eden.api.routes.experiments_offline` — routers now mount at lifespan, not import), computes the "treatment" score via a substring-match heuristic — `score = 0.9 if expected in input_text else (0.7 if expected else 0.5)` — with no LLM/agent invocation anywhere in the file (02-1: the `config` dict already carries a `model` field, so the plumbing exists and only the actual call is missing). The "control" side is hardcoded to `{"score": 0.5, "output": item.expected_output or "", "synthetic": True, "method": "heuristic_stub"}` (`:157-162`) regardless of what any actual baseline run produced (02-2: fix via a stored `baseline_output` column or a second real model run against `baseline_experiment_id`'s config). Once both sides produce real output text, they should be scored via `playground/scorers.py`'s existing `run_scorers(specs, output=..., expected=...)` — no adapter needed, since it already operates on the exact `(output: str, expected: str | None)` shape of `dataset_items` (02-3: a drop-in reuse of infrastructure already used elsewhere in `playground/service.py`). The same root defect surfaces from the playground's promote-flow entry point: clicking "+ Experiment" calls `PlaygroundService.promote_experiment` (`service.py:460-488`), which carries forward the playground's `tasks`/`scorers` config with a success toast reading "Immutable snapshot promoted — open Evals to compare," but the resulting `OfflineExperimentRunner.run` execution never calls the playground's LLM handler or `scorers.run_scorers` — it hits the same `_run_row` heuristic stub (03-1). Fix: implement 02-1/02-2/02-3 to make F51 itself real, and make `promote_experiment`'s downstream execution path actually replay the playground's real `tasks` through `playground_llm_handler`/`scorers.run_scorers` so the persisted "experiment" reflects the comparison the engineer actually watched.
**Why it matters:** F51 is a real, live, API-mounted, frontend-wired "offline experiment" feature (Braintrust/LangSmith-style prompt/model comparison) that today produces a numerically meaningless diff on every single run — every score a user sees from it is fake. An engineer who tunes a prompt in the playground, watches real scorer numbers, and clicks "Promote to Experiment" gets a persisted result that has nothing to do with what they just did, silently undermining trust in the tool and wasting iteration work. Four independent findings across two docs converge on the same root-cause code path, which sharply raises confidence this is the correct fix target.
**Severity:** Critical
**Effort:** Small (02-1/02-2/02-3, the core F51 fix) to Large (03-1, the promote-flow integration)
**Confidence:** High

**Files touched:** `src/eden/experiments/offline_runner.py (OfflineExperimentRunner._run_row)`, `api/app.py (deferred-router entry for eden.api.routes.experiments_offline)`, `playground/scorers.py (run_scorers)`, `playground/service.py (PlaygroundService.promote_experiment)`

---

### FEAT-13 — Wire `scorers.py` into an actual CI/merge-gate check (build a real "prompt regression gate")

**Status:** ⬜ OPEN — verified 2026-08-05 (zero `playground` references in `src/eden/evaluation/` or `.github/workflows/`; note commit `cdccb59f` "feat(ci-eval): F56 turnkey evals-in-CI — score table, run history, PR gate" landed this week but built on the separate `ci_webhook` path, which strengthens rather than closes this point's premise)

**Source:** `03-prompt-playground.md`, §5 "Not wired to CI"; "User Experience & Value → Where the workflow breaks down"; "Net picture" (citing `.github/workflows/eden-eval.yml`, `api/routes/wave6_online.py:513-514`, `eden.evaluation.ci_webhook.CIWebhookHandler`, `scorers.py`)
**Description:** The only PR/nightly regression gate in the repo is `.github/workflows/eden-eval.yml`, which POSTs to `/orgs/{org}/ci-eval/run`, backed by `eden.evaluation.ci_webhook.CIWebhookHandler` — a completely separate code path from `eden.playground` (and the path that this week's F56 "turnkey evals-in-CI" work, commit `cdccb59f`, extended with a score table, run history, and PR gate). A repo-wide grep for `eden.playground` outside the `playground/` directory never turns up `regression_runner.py`, `ci_webhook.py`, or anything in `.github/`. No scorer defined in `scorers.py` (deterministic, fast, dependency-free: `exact_match`, `contains`, `icontains`, `regex`, `json_valid`, `levenshtein_ratio`) ever gates a merge or deploy today. Fix: build a merge/deploy check that runs the playground's scorer set against a defined comparison (e.g., new prompt version vs. prior) and fails the check on regression, using the existing `scorers.py` infrastructure rather than building new scoring logic from scratch — plausibly by folding it into the now-stronger ci-eval path rather than a parallel gate.
**Why it matters:** Called "the single highest-leverage gap for adoption" — the scorer infrastructure needed for a real "prompt regression gate" already exists and is unused; today the playground is purely a manual pre-merge comparison tool with zero automated say over whether a PR merges or a prompt version deploys, the difference between "a good manual tool" and "the thing that prevents prompt regressions from shipping."
**Severity:** Critical
**Effort:** Large
**Confidence:** High

**Files touched:** `.github/workflows/eden-eval.yml`, `api/routes/wave6_online.py`, `eden.evaluation.ci_webhook.CIWebhookHandler`, `scorers.py`, `eden.playground (regression_runner.py, new merge-gate integration)`

---

### FEAT-14 — Wire `alert_stream.py`'s rule engine to a live event source

**Status:** ⬜ OPEN — verified 2026-08-05 (repo-wide grep finds no external caller of `AlertStreamProcessor`; the only `alert_stream` reference outside the module is a docstring mention in `realtime/ksql_cep.py:12`; `kafka_consumer.py` still maps `"alert": "eden-alert"` in its topic table at `:69` with no consumer)

**Source:** `04-alerting-oncall.md`, §0(a) (citing `realtime/alert_stream.py` — `AlertStreamProcessor.process_event`/`process_batch`; `realtime/kafka_consumer.py` topic map, `"alert": "eden-alert"` now at `:69`, drifted from the doc's `:62-63`)
**Description:** `AlertStreamProcessor.process_event()` is the only function that evaluates alert rules (including the P0 `rule_sandbox_escape`) against a live event. Grepping every call site of `.process_event(`/`.process_batch(` across `src/eden` finds zero external callers — the only hits are the module's own docstring example and `process_batch`'s internal self-call (unrelated `process_batch` methods exist on `insights/dataset_engine.py` and the insights service, but neither touches alerting). `kafka_consumer.py` defines an `"eden-alert"` Kafka topic and comments that "the alerts service" subscribes to it, but no such consumer exists anywhere. Zero test coverage of `alert_stream.py`/`process_event` exists either. Fix: either build a Kafka consumer that subscribes to `eden-alert` and calls `process_event`, or call `process_event` inline wherever the relevant Kafka events currently land.
**Why it matters:** Root cause of the entire P0-alerting failure — no channel-level fix (PagerDuty sender, email routing) matters until this is wired, because the rule engine supposed to detect a P0 event is never invoked by anything in production.
**Severity:** Critical
**Effort:** Large
**Confidence:** High

**Files touched:** `realtime/alert_stream.py (AlertStreamProcessor.process_event, process_batch)`, `realtime/kafka_consumer.py (eden-alert topic)`

---

### FEAT-15 — Emit `sandbox.security_alert` events from a real producer

**Status:** ⬜ OPEN — verified 2026-08-05 (repo-wide grep for `sandbox.security_alert` still matches only the rule definition inside `realtime/alert_stream.py`; no producer exists)

**Source:** `04-alerting-oncall.md`, §0(b) (citing `alert_stream.py:178-183`; `sandbox/runner.py:114`; `evaluation/security_scanner.py`)
**Description:** The P0 rule `rule_sandbox_escape` only fires on event type `sandbox.security_alert`. A repo-wide grep for that string matches exactly one line — the rule definition itself. Nothing constructs or emits this event. The actual sandbox runtime guard (`src/eden/sandbox/runner.py`) just raises a plain `ValueError` on a path escape with no connection to Kafka. `security_scanner.py`'s `SANDBOX_ESCAPE` is a static-analysis finding category, not a runtime event. Fix: add event emission from the sandbox runtime escape guard and/or the guardrails policy engine, neither of which currently talks to Kafka or `alert_stream.py`.
**Why it matters:** Even if #14 is fixed, the P0 rule still cannot fire — its trigger condition is literally never produced by any code path today.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `realtime/alert_stream.py (rule_sandbox_escape rule)`, `sandbox/runner.py`, `evaluation/security_scanner.py`

---

### FEAT-16 — Implement Slack/webhook dispatch in the Automations engine's `_execute_action`

**Status:** ⬜ OPEN — verified 2026-08-05 (`_execute_action` in `src/eden/automations/engine.py` handles `"dataset"` (`:133`), `"queue"` (`:146`), and a no-op `"alert"` (`:149`); `"webhook"`/`"slack"` still fall through to the bare `return {...}` default at `:156` — no dispatch. The self-serve surface got *more* prominent this week: commit `953286b7` shipped the portal automations tab)

**Source:** `04-alerting-oncall.md`, §0(d), §1 transport table (citing `automations/engine.py` `_execute_action` (`:127-156`); `automations-panel.tsx:475,49`)
**Description:** The portal's self-service Automations tab lets a customer configure Slack/webhook actions today, gets a 200 on save, and the trigger path is genuinely live (traces are scored in real time and automations fire on real thresholds). But `_execute_action` only implements `action_type == "dataset"` and (since the doc was written) a `"queue"` branch; `"alert"` is a no-op that builds and returns a dict with no dispatch; `"webhook"` and `"slack"` — the two options the frontend actually offers — fall into a generic default branch that also just returns a dict. A repo-wide grep for `action_type == "webhook"|"slack"` returns zero hits anywhere. Fix: implement real Slack and webhook dispatch in `_execute_action`.
**Why it matters:** Called "a materially worse UX failure than the PagerDuty gap" — a live, self-serve surface with copy that promises delivery, a form that accepts the config, silent permanent non-delivery, no error, and no way for a customer to discover the gap short of independently testing whether the message ever arrives.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/automations/engine.py (_execute_action)`, `automations-panel.tsx`

---

### FEAT-17 — Fix the `eql_alert_rules` severity-filter inversion (marking a rule "critical" silently disables it)

**Status:** ⬜ OPEN — verified 2026-08-05 (`_FIREABLE_SEVERITIES: frozenset[str] = frozenset({"info", "warning", "high"})` now at `src/eden/dsl/alerts.py:65-67` — `critical` still excluded; the skip check `if not force and severity not in _FIREABLE_SEVERITIES:` at `:404` returns `reason: "severity_filtered"` without firing)

**Source:** `04-alerting-oncall.md`, §0.5 bullet 2 (citing `dsl/alerts.py` — `_FIREABLE_SEVERITIES` now at `:65-67`, drifted from the doc's `:60-62`; check at `:404-412`)
**Description:** The cron watchdog that evaluates NL-alert rules skips any rule whose severity falls outside `_FIREABLE_SEVERITIES = {info, warning, high}` — and `critical` is the one value excluded. A rule saved as "critical" is accepted by validation, looks correct in the UI, and then never auto-fires again (an in-code comment frames this as "Watchdog filters critical at fire time in v1.3 (accepted at compile for forward-compat)" — i.e., intentional-looking but still a silent trap for users). Fix: include `critical` in `_FIREABLE_SEVERITIES`.
**Why it matters:** Lives in the one alerting pipeline that otherwise genuinely works end-to-end (email delivery to org admins) — silently disables the most urgent rules in the only pipeline that currently delivers anything. Called "a one-line, high-confidence, independently-shippable bug fix."
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/dsl/alerts.py (_FIREABLE_SEVERITIES)`

---
## Wave 2

**20 points** (4 bugs, 7 optimizations, 9 features) — severity mix: 11 Critical, 9 High. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 1 or earlier. **Status as of 2026-08-05:** 20 remaining (0 partial, 20 open).

### BUG-4 — Fix "Acknowledge" issue-status button, which silently no-ops today

**Status:** ⬜ OPEN — verified 2026-08-05 (migration 136's CHECK still excludes `acknowledged`; `_RESOLVE_STATUSES` at `agent_issues.py:114` still allows it; `set_status` at `repo.py:308-332` still swallows the `CheckViolation` in a bare `except Exception` and `resolve_issue` still returns HTTP 200 with `{"updated": false}`)

**Source:** `bugs/02-data-consistency.md` Bug 8b (with 8c's full audit confirming this is the
*only* broken status control)

**Description:** The portal Issues board's "Acknowledge" button sends `status="acknowledged"`
(`clients/portal/src/lib/api/resources.ts:2736-2760` resolve wrapper; `issues-client.tsx` — the
`onStatus("acknowledged")` card action and the `onStatus={(status) => {...}}` optimistic-update
handler around `:727`), which passes
the API-layer allowlist (`_RESOLVE_STATUSES` includes it) but is **not a legal value** in the
`agent_issues.status` Postgres CHECK constraint (`src/eden/db_migrations/versions/136_issue_status_escalated.py`
— legal values are `open, triaged, fix_pending, verifying, resolved, regressed, ignored,
learning, escalated`; `acknowledged` is absent). `IssuesRepo.set_status` (`repo.py:308-332`)
wraps the `UPDATE` in a bare `except Exception`, catches the `CheckViolation`, logs a warning,
and returns `False` — no exception propagates. `resolve_issue` still returns HTTP 200 with
`{"updated": false}`, echoing `"status": "acknowledged"` as if it worked. The portal does an
optimistic local update, and its error-revert path only fires on a thrown exception — which
never happens, since the server returns 200 — so the click **silently reverts on next refetch**
with zero error toast. **Fix:** map the app-level `"acknowledged"` concept onto the closest real
DB status (e.g. `"triaged"`) before writing, and make `set_status` re-raise a genuine DB error
instead of collapsing "no such row" and "the UPDATE itself raised" to the same `False`.

**Blast radius:** Every user of the portal Issues board who clicks "Acknowledge" (confirmed the
only reachable path to this state — Resolve and Reopen both send DB-legal values and work fine,
per Bug 8c's full audit of every status control).

**Severity:** Critical (core, frequently-used UI control silently broken with zero error
surfaced to the user).
**Effort:** Small — one status-mapping dict + re-raise the specific DB error. **QUICK WIN.**
**Confidence:** High.

**Files touched:** `src/eden/api/routes/agent_issues.py`, `src/eden/issues/repo.py`, `clients/portal/src/lib/api/resources.ts`, `clients/portal/src/app/(portal)/issues/issues-client.tsx`

---

### BUG-5 — Give `next/dynamic`-loaded panels a working retry path (session/trace/tree detail views)

**Status:** ⬜ OPEN — verified 2026-08-05 (`traces-client.tsx:89-117` still declares `RunTranscript`/`SessionReader`/`TreePanel` via bare `dynamic()` with no error handling; no retry helper exists anywhere in the portal, and the call-site count has grown to 42 `= dynamic(` sites)

**Source:** `bugs/04-frontend-and-test-failures.md` §6, §8

**Description:** `clients/portal/src/app/(portal)/traces/traces-client.tsx`'s `SessionReader`,
`RunTranscript`, and `TreePanel` (the session reader, default trace-tab, and tree-tab panels)
are all loaded via `next/dynamic` with only a `loading` fallback and no error handling. Traced
line-for-line through the installed `next@16.2.10`/`react@19.2.7` source: `next/dynamic` here is
a thin wrapper over `React.lazy` + `Suspense`; on a rejected chunk import, `React.lazy`'s
internal state (`_status`) is permanently cached as rejected, and the `Lazy` object re-throws on
every subsequent render — Suspense doesn't catch a genuine throw, so it propagates to the
nearest error boundary, `(portal)/error.tsx`, tearing down the **entire traces page** to a
generic "Something went wrong" screen. Worse: clicking "Try again" re-renders the same
permanently-rejected module-scoped `Lazy` singleton, which throws again immediately — **the
retry button doesn't retry**; only a hard browser reload recovers. 42 total `next/dynamic` call
sites across the portal now share the same no-error-handling pattern (18 at the time of the
source doc; the portal has grown since); these 3 are the highest-traffic
(mounted on every trace/session detail view). **Fix:** wrap the dynamic imports with a retry
helper that races the `import()` against a timeout, catches rejection, and either re-invokes
`import()` with a cache-busted URL or exposes a real retry affordance instead of relying on
React's permanently-cached rejection state.

**Blast radius:** Triggered by a stale/evicted JS chunk after a deploy (a real, if intermittent,
production condition — flaky CDN edge cache, mid-deploy client). When it fires, it takes down
the entire traces workspace for that user with no working recovery short of a hard reload.

**Severity:** High (severe when triggered — full-page crash + broken recovery UX — but
conditional/lower-frequency than #1-#4's always-on triggers).
**Effort:** Medium — needs a reusable retry-wrapper component applied to (at minimum) the 3
highest-traffic sites, ideally all 42.
**Confidence:** High (mechanism traced through actual installed library source, not inferred).

**Files touched:** `clients/portal/src/app/(portal)/traces/traces-client.tsx`

---

### BUG-6 — Fix the "ghost agent card" split on the portal Agents dashboard

**Status:** ⬜ OPEN — verified 2026-08-05 (`agent_identity_aliases` exists nowhere in `src/`; `_load_registry`/`_load_metrics` still at `portal.py:886`/`:929` and `_PREFERRED_AGENT_ID_SQL` still applied at exactly the 4 cited sites `:954, 1021, 1233, 1343` with no alias table)

**Source:** `bugs/02-data-consistency.md` Bug 4

**Description:** `src/eden/api/routes/portal.py` loads agent identity from three independent
sources that don't reconcile: `_load_registry` (`:886`) lists agents from
`agent_registrations`; `_load_metrics` (`:929`) computes per-agent metrics `GROUP BY agent_id`
over raw telemetry, where `agent_id` may be a framework-instrumentation label
(`pydantic-ai:OpenAIChatModel()`) rather than the registered id; the merge (`:1100-1101,
1151-1177`) joins by **exact string equality** with no alias table. Concrete repro: an org
registers `agent_id="checkout-agent"`, but its SDK stamps telemetry with the raw instrumentation
label. Result: the `"checkout-agent"` card reads `runs=0, status="idle"` (looks dead), and a
**second, unrecognizable ghost card** appears for the raw label with the real metrics. A partial
mitigation (`_PREFERRED_AGENT_ID_SQL`) is applied consistently at all 4 relevant call sites
(`:954, 1021, 1233, 1343`) but only helps if *some* event on the trace carries the real id — if
none ever does, the ghost split persists. **Fix:** persist a real
`agent_identity_aliases(org_id, synthetic_label, agent_id, first_seen, last_seen)` mapping
whenever `_PREFERRED_AGENT_ID_SQL` successfully resolves a pairing, and resolve through that
table before falling back to raw-label ghost-card creation.

**Blast radius:** The primary Agents dashboard, for any org whose registered `agent_id` doesn't
get wired into its own telemetry attributes (a real, common integration gap) — a genuinely live,
high-traffic surface with no reachability caveat.

**Severity:** High.
**Effort:** Large (new schema/table + backfill logic + merge-path rewrite); a smaller interim
mitigation (surface both cards more legibly, or flag "possible split identity") is Medium.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/portal.py`, `clients/portal/src/app/(portal)/agents/agents-client.tsx`, `agent_identity_aliases`

---

### BUG-8 — Fix prompt-evolution creating orphan prompts instead of versioning the real agent prompt

**Status:** ⬜ OPEN — verified 2026-08-05 (`components.py:772-774` still calls `svc.create_version(org_id, agent, ...)` with the agent id positionally as `prompt_name`; `create_version` at `prompt_versioning.py:223` still falls through to `create_prompt` at `:242` when no prompt exists under that name)

**Source:** `bugs/02-data-consistency.md` Bug 1

**Description:** `src/eden/agents/evolution/components.py:772` (`IssuePromptEvolver.evolve_from_issue`,
defined at `:674`)
calls `PromptService.create_version(org_id, agent, template=revised, ...)`, passing `agent`
(`agent_id or issue.agent_id`, often a server-minted UUID) positionally as `prompt_name`.
`create_version` (`prompt_versioning.py:223`) has zero notion of `agent_id` — prompts are keyed
purely by `(org_id, prompt_name)`. If no prompt exists under that exact name (the common case,
since an org's actual prompt template name rarely equals its agent's UUID),
`create_version` falls through to `create_prompt` (`:242`) and mints a **brand-new, unrelated
prompt** rather than versioning the agent's real production prompt. This is now reachable from a
second call site: `resolve_issue`'s "resolved" branch unconditionally calls
`evolve_from_issue`, including when the target status was silently coerced (see #3 — `resolve_issue`
still coerces any unknown `body.status` to `"resolved"` before the gate) — a bad
status value can trigger this orphan-prompt creation on a resolve nobody actually asked for.
**Fix:** resolve the agent's real registered prompt name before calling `create_version`, and
fail loudly (log + skip) rather than silently minting a prompt, if no such mapping exists; ideally
also add a strict mode to `create_version` that refuses to implicitly `create_prompt` when
invoked from an automated evolution path.

**Blast radius:** Every issue-resolution-triggered prompt evolution for an org where the prompt
template name doesn't equal the agent's UUID — likely the common case — silently creates junk
prompt rows rather than iterating on the agent's actual production prompt.

**Severity:** High (silent data-integrity failure in a core self-improvement feature, live).
**Effort:** Medium — requires resolving the correct prompt-name mapping (may need a schema
lookup or a new field) plus a fail-loud path.
**Confidence:** High.

**Files touched:** `src/eden/agents/evolution/components.py`, `src/eden/services/prompt_versioning.py`

---

### OPT-2 — Fix dead `eden.kb.embeddings` import that silently disables real clustering (produces an 88.7%-false-positive mega-cluster) and the O(n²) grouping cost it masks

**Status:** ⬜ OPEN — verified 2026-08-05 (`import eden.kb.embeddings` still raises `ModuleNotFoundError` — reproduced live today; `get_default_embedder` still referenced in both `signals/clusterer.py` and `observability/patterns_clusterer.py`, and no watermark/offload work has touched the grouping loop)

- **Source:** `01-hotpath-perf.md` Finding 5 (L36-179) + `02-db-queries.md`
  F2 (L215-368, CRITICAL) — **cross-doc duplicate, merged**; `01`
  explicitly states "This is the same bug `optimizations/02-db-queries.md`
  documents in more depth as its F2." `02` is the fuller forensic version.
- **Description:** Two independently-actionable sub-problems the source
  docs insist must be fixed together (fixing one alone makes things
  worse):
  - **(a) Broken import → silent no-op → degenerate clustering
    (correctness bug).** `signals/clusterer.py::_embed` (`:195-212`) does
    `from eden.kb.embeddings import get_default_embedder` inside a `try`.
    This module does not exist anywhere in the source tree — confirmed by
    direct live import (`ModuleNotFoundError`) in both docs independently,
    and re-confirmed live on 2026-08-05.
    `git log --diff-filter=A` shows `clusterer.py` and the real module
    (`eden/kb/ledger/embeddings.py`, which doesn't even define
    `get_default_embedder`) were added in the **same commit** (`95401573`)
    — this has never worked, it isn't a regression. The identical broken
    import exists at a second call site,
    `observability/patterns_clusterer.py:147-148`. The `except Exception`
    at `:205` catches this on every call at **debug level only**
    (invisible in production), then falls through to a deterministic
    hash-based 8-dim fallback vector. `02-db-queries.md` proved via
    simulation (500 real summary strings, actual `stable_hash`) that this
    fallback isn't just cheap-but-harmless: pairwise cosine similarity
    across the hash vectors is min=0.098, p50=0.999, max=1.0, with
    **88.7% of the 124,750 unique pairs scoring ≥ the 0.82 clustering
    threshold** (MEASURED via simulation), and running the actual grouping
    loop collapses **478 of 500 rows into one semantically-meaningless
    mega-cluster**. This is written to `signal_clusters` and surfaced to
    users via the portal / `GET /signal-clusters`. All three call sites in
    `investigator.py` also wrap `cluster_after_match` in a bare
    `except Exception: pass` with zero logging, compounding the
    invisibility.
  - **(b) O(n²) grouping loop, real and currently masked by (a), runs
    directly on the event loop.** The pairwise grouping loop
    (`clusterer.py:105-119`) is bounded by `C(n,2) = 124,750` calls at
    n=500 (a corrected number vs. an earlier pass's incorrect n²=250,000
    estimate). This is a worst-case bound reached only when nothing
    clusters — real hash vectors currently cluster so aggressively that
    actual call counts land far lower (400-2,400 at n=500, MEASURED via
    reruns but not consistently reproducible). If the import bug were
    fixed and a real embedder wired in: `02-db-queries.md` measured
    ~53.8µs/comparison at 384 dims (~6.7s worst-case total at n=500,
    MEASURED); `01-hotpath-perf.md`'s independent bench gives ~5-15s at
    dim=384 / ~20-85s at dim=1536 at n=500 — but explicitly flags this as
    "not committed anywhere in the repo," disagreeing with the other doc's
    own number by 2-5x, and states "treat it as a corroborated order of
    magnitude, not a measurement." At the documented
    `TRACES_PER_ORG_DAY=1,000` / 14-day lookback, the `LIMIT 500` fetch
    saturates whenever a signal's match rate is ≥ ~3.6% — a low bar, so
    n=500 is the steady state for any moderately active signal, not a tail
    case (DERIVED-FROM-CODE). The loop is not `to_thread`'d — it blocks
    the entire single-threaded asyncio event loop for its full duration,
    stalling every other concurrent request/org sharing that worker
    process. (Python's own docs confirm `to_thread` wouldn't help
    CPU-bound work anyway.) A separate, smaller inefficiency: `_cosine`
    recomputes the outer-loop vector's L2 norm from scratch on every
    pairwise call even though it's invariant across the inner loop.
- **Fix:** (1) Apply the F1/item-1 index fix first (cheapest lever,
  shrinks the fetch cost regardless). (2) Either point `_embed` at a real
  embedder or replace the degenerate fallback with something that doesn't
  systematically over-cluster (e.g. Jaccard similarity on summary text).
  (3) Upgrade the swallowed exceptions to error-level logging/metrics at
  both `_embed` and the three `investigator.py` call sites. (4) Cap/batch
  the O(n²) grouping and move it to a process pool (not `to_thread`) or off
  the synchronous request path entirely. (5) Precompute vector norms once.
  (6) Batch the per-group cluster INSERTs (currently unbatched, up to
  ⌊n/2⌋ per call). (7) Debounce clustering instead of running on every
  match. **Do not fix the import in isolation** — doing so without also
  fixing the O(n²) cost would convert a silent correctness bug into a
  synchronous multi-second-to-tens-of-seconds event-loop stall, up to 20x
  per `investigate_trace` request, or blocking the 5-slot-concurrent async
  ingest consumer.
- **Impact:** 88.7% false-positive-cluster rate (MEASURED via simulation).
  O(n²) cost: 333ms at d=8 / ~6.7s at d=384 (MEASURED, `02`) vs. ~5-15s at
  d=384 / ~20-85s at d=1536 (MEASURED but explicitly flagged
  non-reproducible/order-of-magnitude-only, disagreeing 2-5x across
  independent runs, `01`). Comparison-count ceiling of 124,750 at n=500 is
  DERIVED-FROM-CODE (provable bound).
  This bug also fires on the async ingest path (`trace_finalized_consumer.py::_run_signal_investigator`),
  not only the synchronous `investigate_trace` HTTP route.
- **Severity:** Critical (both docs' own tier — `02-db-queries.md`
  explicitly rates this CRITICAL, reframed from "a perf problem" to "a
  shipped, invisible product-correctness bug that also costs CPU on the
  shared ingest path").
- **Effort:** Medium-Large (touches embedder wiring, algorithm, threading
  model, and logging across two call sites).
- **Confidence:** High on the dead-import reproduction and the 88.7%
  mega-cluster simulation (both independently reproduced by both docs).
  Medium on the exact O(n²) cost magnitude (real and order-of-magnitude
  confirmed, but figures disagree 2-5x across independent measurements and
  scripts aren't committed to the repo).

**Files touched:** `signals/clusterer.py`, `observability/patterns_clusterer.py`, `investigator.py`, `eden/kb/ledger/embeddings.py`, `signal_clusters (table)`, `api/routes/signal_investigator.py`, `trace_finalized_consumer.py`
**Depends on:** OPT-1

---

### OPT-4 — Make Typesense faceting opt-in instead of always-on in `search()`

**Status:** ⬜ OPEN — verified 2026-08-05 (`search()` still defaults to `DEFAULT_FACET_FIELDS` when `facet_by` is None — `search_service.py:441` `facets = ",".join(facet_by) if facet_by else ",".join(self.DEFAULT_FACET_FIELDS)`, sent at `:449`. Note: commit `d929604c` (2026-08) capped per-query compute via `search_cutoff_ms` (p95 555→164ms @1.1M docs), which mitigates latency but does not make faceting opt-in — the structural fix here is untouched)

**QUICK WIN candidate — High severity (code-level), Small effort.**

- **Source:** `01-hotpath-perf.md` Findings table row 1 (L198); mechanism
  corroborated L303-322.
- **Description:** `SearchService.search()`
  (`src/eden/observability/search_service.py:441-449`)
  always requests `facet_by=DEFAULT_FACET_FIELDS` (5 fields,
  `max_facet_values=25`) on every call — including empty-query (`q=""`)
  calls that Typesense treats as match-all, where facet aggregation cost is
  computed over the entire matched corpus. `suggest()` in the same file
  already narrows to a single facet (`:559`) specifically to avoid this
  cost — `search()` doesn't follow its own established pattern.
- **Fix:** Default `facet_by=None` in `search()`; move faceting to the
  existing, currently underused `SearchService.facets()` method
  (`:570-584`), invoked only when the filter panel UI is actually open,
  with a short TTL cache on the result.
- **Impact:** Typesense's own docs confirm facet cost scales with
  `max_facet_values` and matched-corpus size; a community benchmark showed
  ~3ms flat facet cost up to ~78ms at `max_facet_values=100000` on a
  ~3k-doc collection — explicitly labeled "weak circumstantial
  corroboration, not a stand-in for an Eden-specific measurement" (that
  test collection is 3-4 orders of magnitude smaller than Eden's 1.1M-doc
  target). No Eden-specific ms number exists; magnitude is UNMEASURED/
  ESTIMATED.
- **Severity:** High (code-level bug is a fact) / Medium (exact magnitude
  uncertain, pending the unreproducible F12 benchmark — see item 13).
- **Effort:** Small.
- **Confidence:** High on the code-level bug; Medium on quantified impact.

**Files touched:** `src/eden/observability/search_service.py`

---

### OPT-5 — Fix `rca_chain`'s double-fetch of an unbounded, wide `telemetry_events` query

**Status:** ⬜ OPEN — verified 2026-08-05 (`rca_chain` at `intelligence_rca.py:127` still fetches at `:138` then calls `_rca.categorize` at `:143`, which re-fetches at `analyzer.py:89`; `categorize(self, org_id, trace_id)` still has no `events` parameter, and the `_common.py` trace-events SELECT — `payload`, `attributes`, `tool_calls_full`, `request_body`, `response_body`, etc. — still has no LIMIT)

- **Source:** `02-db-queries.md` F3 — HIGH (L370-416).
- **Description:** `api/routes/intelligence_rca.py::rca_chain` (`:127-148`)
  calls `_fetch_trace_events(org_id, trace_id)` directly, then calls
  `_rca.categorize(org_id, trace_id)`, which internally
  (`insights/rca/analyzer.py:89`) calls `_fetch_trace_events` **again**
  for the identical `(org_id, trace_id)` pair — a redundant second fetch
  within the same HTTP request. The underlying query
  (`insights/rca/_common.py:104-140`) has **no `LIMIT`** and selects the
  heaviest columns on the table unconditionally, including `payload`,
  `attributes`, `tags`, `tool_calls_full`, `tool_results`, `request_body`,
  `response_body`. The existing index
  (`idx_telemetry_events_trace_id (trace_id, timestamp ASC)`) already
  fully serves the query, so no new index is needed — the problem is
  purely the double-fetch and the unbounded/wide `SELECT`. (Contrast:
  `RootCauseAnalyzer.explain` correctly reuses `categorize()`'s result and
  does one bounded query — this bug is specific to `rca_chain`.)
- **Fix:** Give `RootCauseAnalyzer.categorize`/`explain` an optional
  `events: list[dict] | None = None` parameter so `rca_chain` can pass its
  already-fetched events instead of triggering a second fetch. Add a
  `LIMIT` (e.g. 2000 rows or a byte-budget) to `_fetch_trace_events`, and
  create a "thin" variant excluding the heaviest columns for the
  chain/list view where they aren't needed.
- **Impact:** Not independently latency-benchmarked; the doubled
  unbounded/wide fetch is source-VERIFIED as a structural inefficiency
  (one full extra round trip plus unnecessary bandwidth/memory for the
  heaviest columns, on every `rca_chain` call, scaling with unbounded
  trace size).
- **Severity:** High (source doc's own tier).
- **Effort:** Small-Medium.
- **Confidence:** High (verified directly from source, unchanged across
  passes).

**Files touched:** `api/routes/intelligence_rca.py`, `insights/rca/analyzer.py`, `insights/rca/_common.py`

---

### OPT-6 — Implement real retention enforcement for `quarantine_events`

**Status:** ⬜ OPEN — verified 2026-08-05 (`run_retention_policy` at `data_platform/retention.py:456` still has only `debug_dumps` (`:484`) and `raw_traces` (`:494`) branches; the dead `elif policy.delete_after_days <= policy.warm_days` trap is still at `:498`; the only `DELETE FROM quarantine_events` remains `silver_etl.py:803` inside `reprocess_quarantine` (`:757`), success-path only)

**QUICK WIN — High severity, Small effort, only no-op policy with a
confirmed live unbounded-growth mechanism.**

- **Source:** `06-storage-retention.md` fix table (L167), "Other
  storage-growth risks" (L129).
- **Description:** `quarantine_events` has a real backing table
  (`008_phase_5_5_data_platform.py:77-99`) and a declared policy (`7, 30,
  90, 90` — `data_platform/retention.py:59`), but it silently no-ops:
  `run_retention_policy`
  (`retention.py:456-505`) has no PII branch, no archive branch, and the
  deletion `elif policy.delete_after_days <= policy.warm_days` at `:498`
  is False (90 ≤ 30 is False) — this dead-`elif` trap is confirmed false
  for **all 8** current `DEFAULT_POLICIES` entries, so it silently
  disables enforcement across the board, not just here. Unlike the other
  five no-op policies (items 39/57/58/59 below), this one has a
  **currently confirmed live growth mechanism**: its only deletion path is
  `silver_etl.py:803` (inside `reprocess_quarantine`), which removes rows
  only on successful
  reprocessing — rows with unparseable payloads, or that are never
  reprocessed, are kept forever with no age-based cleanup.
- **Fix:** Add a dedicated dispatch branch (mirroring the existing
  `debug_dumps` pattern at `retention.py:484-489`):
  `elif policy.data_type == "quarantine_events": DELETE FROM
  quarantine_events WHERE quarantined_at < $1` at the existing
  `delete_after_days=90`, independent of `resolution`.
- **Impact:** Not quantified in rows/GB, but explicitly flagged as a live,
  ongoing unbounded-growth risk — not just a hygiene/false-confidence issue
  like the other five no-op policies.
- **Severity:** High.
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `src/eden/data_platform/retention.py`, `quarantine_events (table)`, `src/eden/data_platform/silver_etl.py`

---

### OPT-7 — Fix `classifier_retrain`'s unwatermarked org/signal-pair selection query (highest tick frequency of the watermark bugs)

**Status:** ⬜ OPEN — verified 2026-08-05 (`SELECT DISTINCT org_id::text, signal_id::text` still at `signals/classifier_pipeline.py:236` with no `ORDER BY`; zero references to `classifier_retrain_watermark` or a `fetch_stale_candidates` helper anywhere in `src/`)

- **Source:** `05-cron-jobs.md` "Full schedule map" (L114), finding #3
  (L158-168), unified fix table (L420), verdict table (L561).
- **Description:** `src/eden/signals/classifier_pipeline.py:234-241` runs `SELECT DISTINCT
  org_id, signal_id FROM signal_events WHERE detected_at > now()-7d LIMIT
  50` every 15 minutes — **96 ticks/day, the highest frequency of the five
  buggy queries found** — with no `ORDER BY`. A `SELECT DISTINCT` on a
  stable, mostly-append-only table commonly gets served by the same
  hash-aggregate plan run to run, meaning the same 50 (org, signal) pairs
  could win every tick indefinitely and every other pair's classifier
  never retrains — this "self-heals" only if Postgres happens to vary its
  plan, which is not guaranteed.
- **Fix:** Same `fetch_stale_candidates()` helper as item 3, new
  `classifier_retrain_watermark(org_id, signal_id, last_processed_at)`
  table. The doc notes this is literally the same shape as
  `insights/detector_loop.py`'s already-working watermark for a
  near-identical problem — copy that table rather than reinventing it.
- **Impact:** Not independently measured; DERIVED-FROM-CODE.
- **Severity:** High (same defect class as items 3/8, but highest tick
  frequency of the five).
- **Effort:** Small-Medium (existing near-identical template to copy).
- **Confidence:** High (re-verified pass-4).

**Files touched:** `src/eden/signals/classifier_pipeline.py`, `classifier_retrain_watermark (new table)`
**Depends on:** OPT-3

---

### OPT-8 — Fix `drift_baselines`'s unwatermarked org/agent-pair selection query

**Status:** ⬜ OPEN — verified 2026-08-05 (`SELECT DISTINCT` still at `insights/drift_baseline_worker.py:27`; zero references to `drift_baseline_watermark` anywhere in `src/`)

- **Source:** `05-cron-jobs.md` "Systematic check" table (L132), finding
  #2 (L153-157), unified fix table (L419), verdict table (L560).
- **Description:** `src/eden/insights/drift_baseline_worker.py:27-33` runs `SELECT DISTINCT
  org_id, agent_id FROM agent_issues WHERE last_seen >= now()-7d LIMIT
  100` weekly with no `ORDER BY`. The 7-day activity window narrows the
  blast radius vs. item 3 (the candidate set changes week to week), but
  it's the same missing-watermark defect.
- **Fix:** Same `fetch_stale_candidates()` helper, new
  `drift_baseline_watermark(org_id, agent_id, last_processed_at)` table,
  advance after the 7-dimension loop (see item 25) completes for that
  pair.
- **Impact:** Not independently measured; DERIVED-FROM-CODE.
- **Severity:** High.
- **Effort:** Medium.
- **Confidence:** High (re-verified pass-4).

**Files touched:** `src/eden/insights/drift_baseline_worker.py`, `drift_baseline_watermark (new table)`
**Depends on:** OPT-3

---

### OPT-9 — Virtualize the issues kanban board

**Status:** ⬜ OPEN — verified 2026-08-05 (`{items.map((issue) => (` still at `issues-client.tsx:704` with no `useVirtualizer` anywhere in the file; the shared helper `clients/portal/src/lab/virtual-list.ts` still exists to reuse)

**QUICK WIN — High severity, Small effort, existing in-repo pattern to
reuse.**

- **Source:** `04-frontend-perf.md` "Worst offender" section +
  "Recommendation" #1 (L15-16, 34-40, 73-76).
- **Description:** `issues-client.tsx:704-709` renders every issue in
  every kanban column as a real, un-windowed DOM node via `.map()` —
  despite `@tanstack/react-virtual` + a shared helper
  (`clients/portal/src/lab/virtual-list.ts`) already being a proven,
  test-covered pattern one directory over in `traces-client.tsx`.
- **Fix:** Reuse `useVirtualizer` + `measureVirtualRow` exactly as
  `traces-client.tsx:848-858` does; no new dependency or infra needed.
- **Impact:** DERIVED-FROM-CODE — worst case is all 200 issues (server
  cap) in one column → ~200 × ~10 DOM nodes/row ≈ 2,000 DOM nodes.
  "Bounded and modest in absolute terms even at the cap," per the doc.
- **Severity:** High (source doc's own priority-#1 recommendation).
- **Effort:** Small (existing helper + pattern, no new dependency).
- **Confidence:** High (doc's fact-check status: 3 internal verification
  passes, no claim found false/unverifiable).

**Files touched:** `clients/portal/src/app/(portal)/issues/issues-client.tsx`, `clients/portal/src/lab/virtual-list.ts`

---

### FEAT-4 — Redact `edited_text` correctly once the correct enforcement path is restored

**Status:** ⬜ OPEN — verified 2026-08-05 (the monkey-patched replacement in `src/eden/observability/trace_quality/wiring.py` still returns `"edited_text": text` — the raw, unredacted input — from its `evaluate_trajectory_step` result envelope; FEAT-3's bypass fix has not landed)

**Source:** `features/12-runtime-guardrails.md` — monkey-patch section, "returns unredacted edited_text" (B12-12)
**Description:** Called out separately from #3 because it's a distinct observable symptom worth its own acceptance criterion: currently, whenever the bypass fires, `edited_text` is returned unredacted even though redaction should have occurred per policy. When #3 is fixed, this specific behavior (redaction actually happening on `edited_text`) should be explicitly verified, not just "the right function gets called."
**Why it matters:** This is the concrete, customer-visible consequence of the bypass — unredacted sensitive/unsafe content reaching wherever `edited_text` is consumed (potentially end-user-facing) — and should be a specific test/verification target, not assumed to be automatically fixed by #3's broader fix.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/observability/trace_quality/wiring.py (install_cat15_trajectory_replaces_intervention guardrails monkey-patch)`, `src/eden/guardrails/intervention.py (InterventionEngine.evaluate_and_act — edited_text redaction)`
**Depends on:** FEAT-3

---

### FEAT-9 — Fix Loop 1 (shadow-detector confirm/dismiss loop) — step P0-B of the revival plan

**Status:** ⬜ OPEN — verified 2026-08-05 (`resolve_issue`'s side-effect gate is still `if ok and target == "resolved":` at `agent_issues.py:180`, and `record_shadow_feedback` — `src/eden/services/soft_issue_review.py:571` — is never called from the resolve path)

**Source:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-B fix step (B13-2)
**Description:** Second step of the four-part fix plan to revive Loop 1's dead confirm/dismiss loop, following directly from P0-A (#8, which recovers the `signal_id` at resolve time via the already-existing `IssuesRepo.get_stumble`). **P0-B — wire the feedback call for both outcomes:** in `resolve_issue` (`src/eden/api/routes/agent_issues.py`), extend the `:180` gate (`if ok and target == "resolved":`) to `target in ("resolved", "ignored")` **for the `record_shadow_feedback` call only** — `resolved` recorded as an implicit *confirm*, `ignored` as an implicit *dismiss*. The four existing side effects (regression-case builder, `RegressionRunner`, `IssuePromptEvolver`, flywheel coordinator) stay `resolved`-only. Today the dismiss half of the operator signal (`ignore_issue`) is discarded entirely — operators are already producing confirm/dismiss labels for free and they never reach detector quality.
**Why it matters:** Same as #8 — necessary sequential step to make the shadow-detector confirm/dismiss loop functional; also an explicit dependency named by doc 16 (see #10 below, which depends on P0-A/P0-B being done).
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/services/soft_issue_review.py`, `src/eden/api/routes/agent_issues.py`, `nl_signals table`
**Depends on:** FEAT-8

---

### FEAT-18 — Ship a self-serve authoring UI for the NL-alert pipeline

**Status:** ⬜ OPEN — verified 2026-08-05 (repo-wide grep: `nl-alert-rules`/`alerts/compile` still appear only in `resources.ts` wrappers; zero `.tsx` components reference them. Note: the new Automations tab shipped in `953286b7` (`app/(portal)/signals/automations-panel.tsx`) fronts the separate `/automations` backend (`wave6_online.py`), not this NL-alert EQL pipeline — the gap stands)

**Source:** `04-alerting-oncall.md`, §0.5 bullet 1, "User Experience & Value," §4 (citing the `alerts/routes.py` NL-alert endpoints — compile plus `GET/POST /orgs/{org_id}/nl-alert-rules` at `:131`/`:142` and per-rule `GET/PATCH/DELETE` at `:178`/`:192`/`:216`; dead wrappers in `resources.ts` (search `nl-alert-rules`); `alerts-panel.tsx:24`)
**Description:** The backend for this flow is genuinely good: takes free text ("alert me when error rate exceeds 5% in the last hour"), reuses the Detectors feature's NL→structured-rule extractor, maps to a parameterized EQL query, lints it, returns the compiled query plus warnings and a suggested name — and full rule CRUD endpoints exist (`POST /orgs/{org_id}/nl-alert-rules` at `alerts/routes.py:142`). But a repo-wide grep for `nl-alert-rules|alerts/compile` in the portal only finds dead typed wrapper functions — no component calls any of it. A customer cannot create a working NL alert rule through the product at all. Fix: build the frontend authoring UI against the already-complete backend API.
**Why it matters:** Ranked the single most basic blocker — more fundamental than any transport/PagerDuty issue — because it's the one pipeline that actually delivers, and it has zero front door.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/alerts/routes.py`, `clients/portal/src/lib/api/resources.ts (nl-alert-rules wrappers)`, `clients/portal/src/lab/alerts-panel.tsx`

---

### FEAT-19 — Stop claiming working P0/security alerting and Automations-tab delivery in customer-facing material

**Status:** ⬜ OPEN — verified 2026-08-05 (no copy/collateral audit has landed; the concern has in fact widened — the new signals Automations tab (`953286b7`, `automations-panel.tsx`) presents `ACTION_TYPES = ["dataset", "webhook", "slack"]` and copy inviting users to "ping Slack, or hit a webhook")

**Source:** `04-alerting-oncall.md`, §4 Recommendation
**Description:** The doc explicitly recommends not claiming any working alerting/paging capability for security or infra P0 events in any customer-facing material, extending to the portal's Automations surfaces, whose Slack/webhook actions "should not be presented as functional." This now includes the new `/signals` Automations tab (`clients/portal/src/app/(portal)/signals/automations-panel.tsx`) in addition to the older `lab/alerts-panel.tsx`. Fix: audit and correct all customer-facing claims (sales collateral, docs, in-product copy) about P0/security alerting and Automations delivery until #14, #15, #16 are shipped.
**Why it matters:** Framed as "a trust/correctness issue, not a feature gap — a customer relying on eden to page them for a P0 security event would not be paged, full stop." Real customer-risk exposure, not just a roadmap gap.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `customer-facing sales collateral / docs / in-product copy`, `clients/portal/src/app/(portal)/signals/automations-panel.tsx (copy)`

---

### FEAT-20 — Wire live gateway traffic into the `budget_consumption` write path to fix the Path A/Path B spend-tracking drift

**Status:** ⬜ OPEN — verified 2026-08-05 (the Wave-4 deferral comment is still at `gateway.py:844`; `record_usage` still has exactly three callers — `optimization/cost_tracker.py:132`, `llmops/cost_ledger.py:316` (fed by internal LLM spend via `record_cost_event`, not gateway traffic), `llmops/ai_gateway.py:721` (dormant gateway) — none on the live `/gateway/v1` request path)

**Source:** `06-cost-governance.md`, §2d "Two live budget-status paths" (citing `budget_service.py:275-361`; `gateway.py:844-848,400-458`)
**Description:** For an org whose traffic is 100% ordinary `/gateway/v1/chat/completions` calls, `budget_consumption` (Path A, read by `budget_service.get_consumption()`, the portal Budgets UI/ticker, `evaluate_budget_alerts()`, and internal agent self-throttles) never receives a write, because its only writer, `record_usage()`, has exactly three callers — none of which sit on the live `/gateway/v1` request path (`gateway.py`'s `_call_upstream()` bypasses `AIGateway.complete()` entirely; called out in code as an intentional Wave-4 deferral). Meanwhile Path B (`UsageService.get_budget_status()`, read by `QuotaEnforcementMiddleware`) correctly sums real spend via `usage_events`, fed synchronously by `_emit_gateway_telemetry()`. For a concrete traced example (`org_growth`, $500 real spend, 10,000 calls), the Budgets UI/ticker shows $0/0% utilized indefinitely while enforcement correctly sees $500 — and no reconciliation job exists anywhere to correct `budget_consumption` after the fact. Fix: add a `record_usage()` call directly inside `_emit_gateway_telemetry()` in `routes/gateway.py`, right after `_stamp_gateway_cost_usd()` computes `cost_usd`.
**Why it matters:** A customer checking the dashboard to avoid a surprise bill sees a budget bar frozen at 0% used, right up until enforcement (reading a third, invisible number) silently starts blocking requests with no preceding alert. Called "a budget feature that actively misleads you about your own risk — arguably worse for trust than no dashboard at all."
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `routes/gateway.py (_emit_gateway_telemetry, _stamp_gateway_cost_usd, _call_upstream)`, `budget_service.py (record_usage, get_consumption)`, `budget_consumption table`

---

### FEAT-21 — Fix the limit-config split — point enforcement at the customer-configured budget, not `org_resource_limits`

**Status:** ⬜ OPEN — verified 2026-08-05 (`api/middleware/quota_enforcement.py` still reads limits via `UsageService.get_budget_status` + `org_resource_limits`; zero `FROM budgets` reads and zero `enforcement_enabled` references in either `quota_enforcement.py` or `usage_service.py`)

**Source:** `06-cost-governance.md`, §2d.4 (citing `budgets.cost_hard_limit_usd` in `052_budgets.py:63`; `org_resource_limits.cost_hard_limit_usd` in `002_phase_4_2_data_layer.py`/`015_regions_and_rls.py`)
**Description:** Independent of the consumption drift (#20), the *limit* side is also split. `budgets.cost_hard_limit_usd` is customer-editable via `POST /orgs/{org_id}/budget`, but `QuotaEnforcementMiddleware` never reads the `budgets` table at all — its hard cap comes from the separate `org_resource_limits` table or the plan-tier default. No functional code reads `budgets.enforcement_enabled`/`budgets.cost_hard_limit_usd` in the live gateway route. Fix: point `QuotaEnforcementMiddleware` at the same scope-aware `get_consumption()`/limit source as the Budgets UI (or extend `UsageService` with matching parameters), making `budgets.cost_hard_limit_usd` the one limit actually checked.
**Why it matters:** "A customer who sets a custom hard budget via the Budgets UI is not actually capping their live gateway spend" — the number they configure and see on screen is disconnected from the number that blocks requests, which they can neither see nor edit. Sharper than #20: even with perfectly synced consumption numbers, the limit itself is the wrong one on the enforcement side.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `budgets table (cost_hard_limit_usd, 052_budgets.py)`, `org_resource_limits table (002_phase_4_2_data_layer.py, 015_regions_and_rls.py)`, `QuotaEnforcementMiddleware (src/eden/api/middleware/quota_enforcement.py)`, `UsageService (src/eden/services/usage_service.py)`

---

### FEAT-22 — Add missing OTel/A2A fields to the `TelemetryEvent` dataclass

**Status:** ⬜ OPEN — verified 2026-08-05 (zero occurrences of `operation_name`, `provider_name`, `parent_agent_span_id`, or `child_agent_trace_id` in `telemetry_collector.py`; the `TelemetryEvent` dataclass at `:40` with `to_dict`/`from_dict` at `:102`/`:145` is unchanged)

**Source:** `05-multiagent-tracing.md`, "New finding" (citing `src/eden/observability/telemetry_collector.py:40-142`)
**Description:** Migrations 058 and 067 added DB columns `operation_name`, `provider_name`, `error_type`, `parent_agent_span_id`, `child_agent_trace_id` to `telemetry_events`, but the `TelemetryEvent` dataclass that `TELEMETRY_INSERT_SQL` serializes never gained matching fields, so nothing is ever available to insert into them. Fix: add all 5 fields (typed `str | None = None`) to the dataclass after `service_tier`, plus matching keys in `to_dict()` and `from_dict()`.
**Why it matters:** Root cause of the whole ingestion write-path gap — every downstream fix (operation_name mapping, agent-boundary rendering, error causal chains) is blocked on this one dataclass change.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/observability/telemetry_collector.py (TelemetryEvent dataclass, to_dict, from_dict)`

---

### FEAT-25 — Do not describe current erasure as "GDPR-compliant" externally until the fixes land

**Status:** ⬜ OPEN — verified 2026-08-05 (`rtbf_fanout_v1: bool = False` still the default at `config.py:1252`, gating the fanout routes in `intelligence_governance.py`. Recent commits `2a92dd76` (Postgres erase path fail-closed) and `73069cce` (Tinybird tenant-row erase) landed real erasure fixes, but the self-service-coverage and Typesense/Redis false-success conditions are not all met, so the messaging discipline still applies)

**Source:** `07-security-compliance.md`, §4 "Recommended framing for the strategic review"
**Description:** The doc's explicit recommendation: do not describe eden's current erasure capability as "GDPR-compliant" in any external material until the live self-service path covers more than `users`/`org_members` (#5) and is actually reachable by a real user via UI, and until the Typesense/Redis false-success bugs (#2, and the related dead Redis RTBF key-pattern match) are fixed before `rtbf_fanout_v1` is honestly flipped on.
**Why it matters:** This is a messaging-discipline item distinct from the underlying engineering fixes — protects against an external compliance claim that would be actively false today, independent of and prior to the code fixes landing.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `external compliance/marketing material`

---

### FEAT-26 — Fix `improvement/replay_verify.py:355` — always-raising `AIGateway.complete()` call site inside the flagship improvement loop's verification step

**Status:** ⬜ OPEN — verified 2026-08-05 (commit `fc123c6f` reworked replay verification but still routes through the dormant gateway: `resp = await gw.complete(req)` at `replay_verify.py:355` inside the new `_gateway_complete` helper (`:334`), now invoked from **two** call sites (`:525`, `:825`). `AIGateway.__init__` starts with `self._providers = {}`, `get_ai_gateway()` never registers providers, and `register_providers_from_env` has zero callers repo-wide — so `complete()` raises `ProviderUnavailableError` unconditionally on this instance)

**Source:** `features/10-model-gateway.md` — undocumented production call sites (B10-5)
**Description:** This call site unconditionally calls `AIGateway.complete()`, which always raises since `AIGateway` is dormant. This one sits inside the replay-verification step of eden's own autonomous improvement loop (doc 13), meaning the closed-loop patch-verification pipeline itself is silently broken at this step whenever it's exercised. Since the `fc123c6f` rework, the call lives in `_gateway_complete` (`replay_verify.py:334-359`, via `get_ai_gateway()`) and is reached from two verification paths (`:525`, `:825`) — the blast radius has grown, not shrunk. Fix: repoint to the real internal LLM client or remove/guard pending `AIGateway` deletion.
**Why it matters:** This is arguably more severe than the sibling `AIGateway.complete()` call-site bug because it breaks eden's own flagship autonomous-improvement feature at a verification step meant to gate whether an autonomous patch is safe to merge — a broken verification step could mean patches are being verified incorrectly or verification is silently no-op'ing.
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `improvement/replay_verify.py`

---

## High band (Waves 3–6)

---

## Wave 3

**20 points** (2 bugs, 4 optimizations, 14 features) — severity mix: 1 Critical, 19 High. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 2 or earlier.

**Status as of 2026-08-05:** 20 remaining (0 partial, 20 open).

### BUG-7 — Surface NULL-`agent_id` traffic on the Agents dashboard instead of silently dropping it

**Status:** ⬜ OPEN — verified 2026-08-05 (`portal.py` `_load_metrics` still filters `AND agent_id IS NOT NULL` at :941, `_load_open_issues` likewise at :1076; zero occurrences of "Unattributed" anywhere in `src/eden` or `clients/portal/src`).

**Source:** `bugs/02-data-consistency.md` Bug 5

**Description:** `src/eden/api/routes/portal.py:941` (`_load_metrics`'s `recent` CTE:
`... AND agent_id IS NOT NULL AND timestamp > ...`) and `:1076` (`_load_open_issues`: same
`agent_id IS NOT NULL` filter) both exclude any trace/issue whose events never got an `agent_id`
stamped — before the identity-resolution logic in #6 even runs. Same root cause one layer down:
`src/eden/issues/auto_scanner.py:106,170-173`'s `_infer_agent_id` returns `None` when no event
on a trace has a truthy `agent_id`, so auto-detected issues on such traces are silently dropped
from every agent's open-issue count too. No counter or log anywhere surfaces how much traffic is
excluded. **Fix:** sum the excluded rows into an explicit "Unattributed" card/row rather than
omitting the traffic:
`SELECT count(*) runs, sum(cost_usd) cost FROM telemetry_events WHERE tenant_id=$1 AND agent_id IS NULL AND timestamp > $2`.
(Correction 2026-08-05: `telemetry_events` keys on `tenant_id`, not `org_id` — `_load_metrics`'s
own CTE uses `WHERE tenant_id = $1`; the previously suggested `WHERE org_id=$1` would fail.)

**Blast radius:** Same live, high-traffic Agents dashboard as #6 — any org with agent_id-less
telemetry (common for OTel/webhook-sourced traffic, per `bugs/02`'s Bug 3 ingestion audit) has
some fraction of its real activity simply invisible, with zero indication anything is missing.

**Severity:** High.
**Effort:** Small-Medium — add one aggregate query + a new dashboard row.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/portal.py`, `src/eden/issues/auto_scanner.py`, `clients/portal/src/app/(portal)/agents/agents-client.tsx`

---

### BUG-9 — Add a UI path for the "ignored"/dismiss issue status (currently unreachable end-to-end)

**Status:** ⬜ OPEN — verified 2026-08-05 (`clients/portal/src/lab/fixtures/issues.ts:5` `IssueStatus` is still `"open" | "acknowledged" | "resolved"`; the only `"ignored"` literal in the portal is the typed API client at `resources.ts:2744`; `issues-client.tsx` never calls `onStatus("ignored")`).

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

### OPT-10 — Virtualize the session-turn timeline list (no server-side cap at all)

**Status:** ⬜ OPEN — verified 2026-08-05 (`traces-session-lens.tsx` still renders turns via plain `.map()` at :312/:320; zero `useVirtualizer` references in the file; the session-timeline UI shipped 2026-08-04 in 953286b7 did not add windowing).

- **Source:** `04-frontend-perf.md` "Worst offender" points 2-3 (L17-18) +
  "Concrete DOM-cost estimates" (L42) + "Recommendation" #1 (L73, 75).
- **Description:** `clients/portal/src/lab/traces-session-lens.tsx:312,320`
  renders the session-turn timeline as plain `.map()` with no windowing.
  This is structurally worse than item 9 because the underlying data has
  **no server-side cap at all** — a long-running agent session can produce
  an unbounded number of turns, each a full `TurnCard` subtree (already
  `memo`-wrapped, so this fix is windowing-only).
- **Fix:** Same `useVirtualizer`/`measureVirtualRow` reuse as item 9.
- **Impact:** DERIVED-FROM-CODE for per-row cost (~11-15 DOM
  nodes/`TurnCard`). Worst-case row *count* is explicitly ESTIMATED/
  illustrative, not measured: the doc models ~2,880 turns over a 24h
  session as "on the order of tens of thousands of DOM nodes" — the doc is
  explicit that "the specific node-count multiplier is a plausibility
  illustration... not evidence in itself." The only independently-verified
  fact is that no server cap exists at all.
- **Severity:** High ("higher priority than it looks" per the doc — the
  only list in the audited surface with no bound in either direction).
- **Effort:** Small (existing helper + pattern).
- **Confidence:** High for the existence of the no-cap bug; Low/Medium for
  the illustrative node-count figure (doc explicitly disclaims it as
  non-evidentiary).

**Files touched:** `clients/portal/src/lab/traces-session-lens.tsx`

---

### OPT-11 — Add limit/offset pagination to the session-timeline endpoint (backend query fix + frontend infinite query)

**Status:** ⬜ OPEN — verified 2026-08-05 (`get_session_timeline` signature is still `(org_id, session_id, *, client)` — no limit/offset; `enumerate(turn_rows, start=1)` unchanged at `timeline.py:210`; `traces-session-lens.tsx` has zero `useInfiniteQuery` usage). Note the N12 timeline backend/UI that landed 2026-08-04 (5e645046, 953286b7) shipped without pagination, so the gap is now live in production UI.

- **Source:** `04-frontend-perf.md` "Session-timeline pagination" (L44-50)
  + "Recommendation" #2 (L77).
- **Description:** This is the payload/fetch-cost root cause behind item
  10 (which only bounds render cost, not fetch cost). Backend:
  `sessions_timeline` (`sessions.py`, now at :267 — line drifted from the
  cited :264-270) needs `limit`/`offset` query params mirroring its sibling
  `sessions_list`. Inside `get_session_timeline`
  (`src/eden/sessions/timeline.py`, function starts :170), naively slicing
  `trace_ids[offset:offset+limit]` is **wrong** because `trace_ids` is not
  chronologically ordered. The correct fix appends `LIMIT $3 OFFSET $4` to
  `_TURNS_SQL` itself (which already has `ORDER BY min(timestamp)`;
  correction 2026-08-05: `_TURNS_SQL` is defined in
  `src/eden/sessions/rollup.py` and imported at `timeline.py:25`, so either
  parameterize it there or wrap it at the timeline call site), then
  derives `page_trace_ids` from the *paginated* result for the stumbles/
  issues sub-queries (today both scan every turn in the session on every
  fetch). `enumerate(turn_rows, start=1)` must become
  `enumerate(turn_rows, start=offset+1)`. Frontend: `sessionsApi.timeline`
  (`resources.ts`, `sessionsApi` at :4353) needs the same `URLSearchParams`
  treatment as `sessionsApi.list`; `SessionTurnsSection`
  (`clients/portal/src/lab/traces-session-lens.tsx`) needs to become a
  `useInfiniteQuery`.
- **Impact:** No separate quantified figure beyond item 10's DOM-cost
  estimate; this is the fetch-cost half of the same root cause.
- **Severity:** High (doc frames this as "the actual root cause of the
  timeline's unbounded worst-case").
- **Effort:** Medium (backend SQL restructuring + new frontend
  infinite-query wiring, though both sides have close in-repo templates).
- **Confidence:** High — the doc explicitly corrected its own earlier
  draft here ("the naive fix... is wrong") after tracing
  `_session_trace_ids`, so this is a verified, not assumed, design.

**Files touched:** `sessions.py`, `src/eden/sessions/timeline.py`, `src/eden/sessions/rollup.py (_TURNS_SQL)`, `clients/portal/src (sessionsApi.timeline)`, `clients/portal/src (SessionTurnsSection)`

---

### OPT-12 — Correct the roadmap/scorecard narrative for F34 (signal investigator), RCA, and guardrails — none have a live LLM call

**Status:** ⬜ OPEN — verified 2026-08-05 (all three code facts unchanged: `run_investigator_llm_batch` still returns `{}` and `_one_completion` still raises `RuntimeError("signal investigator LLM path removed")` at `investigator.py:165/:170`; `rca/analyzer.py:148` still stamps `model: "rule_based_v1"`; `guardrails/detectors.py` imports only `re`. No commit since has landed the explicit narrative correction; the 2026-08-04 F06 endpoint work (64233475) exposes the rule-based paths, it does not add an LLM).

**QUICK WIN — prevents misallocated engineering effort, Small effort
(documentation), High confidence.**

- **Source:** `03-llm-cost.md` intro (L41-72), "Prioritized levers" item 1
  (L498-502).
- **Description:** Three features framed elsewhere as LLM-cost-optimization
  targets have **no live LLM call in them at all**, so there is nothing to
  optimize: (a) the signal investigator —
  `run_investigator_llm_batch` always returns `{}`; `_one_completion`
  raises `RuntimeError("signal investigator LLM path removed")`;
  `INVESTIGATOR_COST_USD = 0.03` in `classifier_worker.py` is documented as
  "NOT a real price," used only for a local savings counter, never written
  to a real CostEvent; (b) RCA — `RootCauseAnalyzer` is a rule-based
  6-rule table with a deferred LLM-as-judge upgrade path never built
  (every response carries `model: "rule_based_v1"`); (c) guardrails — a
  repo-wide grep for every symbol reaching an LLM client across
  `guardrails/*.py` returns zero matches; checks are regex/threshold
  detectors only.
- **Fix:** Correct the internal roadmap/scorecard documentation so future
  cycles don't spend engineering time "optimizing" paths with no LLM in
  them.
- **Impact:** $0 real LLM spend today on all three (target was already
  $0). No dollar savings — the impact is preventing misallocated
  engineering effort across 3 separate features. MEASURED (direct source/
  line reads, confirmed verbatim in code/docstrings).
- **Severity:** High (source doc's own words: "prevents misallocated
  effort across three separate features, not just one").
- **Effort:** Small (process/documentation change, $0 code change).
- **Confidence:** High.

**Files touched:** `SOTA-PERF-COST-SCORECARD.md`

---

### OPT-14 — Add agent-scoped, paginated traces query for the agent-detail page

**Status:** ⬜ OPEN — verified 2026-08-05 (`list_portal_traces` signature at `portal.py:1186-1191` still has only `window`/`limit`, no `agent_id` param; client-side `.filter((t) => t.agentId === agent.id)` now at `agents-client.tsx:369`; the 2026-08-04 agent-detail work (e0287f5a) did not add scoping).

- **Source:** `04-frontend-perf.md` "Secondary finding" (L58-60) +
  "Recommendation" #3 (L78).
- **Description:** `agents-client.tsx` (filter now at :369; cited :361-374
  drifted slightly) fetches the org-wide, unscoped, most-recent-50/24h
  trace list and does `.filter((t) => t.agentId === agent.id)`
  client-side to derive one agent's runs. This is both wasteful (every
  agent-detail view pays for and discards traces belonging to every other
  agent) **and a correctness bug**: an agent whose activity is older than
  the org's most-recent 50 traces renders an **empty run list even though
  data exists**. `list_portal_traces` currently has no `agent_id` scoping
  parameter at all (confirmed by reading the full signature,
  `portal.py:1186-1192`).
- **Fix:** Add an `agent_id` filter to the route/repo query (real fix), or
  at minimum widen `limit`/`window` for this call site as a stopgap.
- **Impact:** Not quantified numerically; framed as a functional
  under-reporting bug plus wasted fetch/filter cost.
- **Severity:** Medium-High (correctness bug — silently under-reports data
  for less-recently-active agents, not just wasted bandwidth).
- **Effort:** Medium (backend route/repo change plus client-side call-site
  change).
- **Confidence:** High.

**Files touched:** `clients/portal/src/app/(portal)/agents/agents-client.tsx`, `portal.py`

---

### FEAT-23 — Wire ingestion assembly to derive `operation_name` and pull agent-linkage fields out of the `attributes` blob into real columns

**Status:** ⬜ OPEN — verified 2026-08-05 (`_OPERATION_NAME_MAP` still exists only in `otel_exporter.py:36`, not shared; zero `operation_name` occurrences in `api/routes/ingestion.py`; `a2a.py` `_A2ACallCtx.attributes()` (:114) still emits `parent_agent_span_id`/`child_agent_trace_id` only into the attributes blob).

**Source:** `05-multiagent-tracing.md` (citing `ingestion.py:317-332`; `src/eden/sdk/a2a.py:114-129`; `otel_exporter.py:36-49`)
**Description:** At the point the ingestion route builds a `TelemetryEvent` (same place `agent_id` is resolved from `X-Eden-Agent-Id`), derive `operation_name` via an extended `_OPERATION_NAME_MAP`. The existing map only covers LLM-call event types (mapping everything to `"chat"`) with zero entries for eden's own `"tool.call"`, `"span.start"`, `"env.step"` types — reusing it verbatim would mislabel every tool-call/agent-boundary span as `"chat"`. Fix: (a) move `_OPERATION_NAME_MAP` into a shared module imported by both the exporter and ingestion; (b) add `"tool.call": "execute_tool"` and a rule that any event carrying `attributes["parent_agent_span_id"]` or arriving via `wrap_a2a_invocation` gets `operation_name = "invoke_agent"`; (c) pull `parent_agent_span_id`/`child_agent_trace_id` out of `event.attributes` (already built by `_A2ACallCtx.attributes()`, currently only merged into the JSONB blob) back into the two real dataclass fields at the same call site.
**Why it matters:** Without this, even with dataclass/DB columns fixed (#22), no code path actually populates `operation_name` or the agent-linkage fields on ingest — they'd remain permanently null. (Note: read-side SQL in `observability.py` already selects `provider_name`/`error_type` columns, so the read path is waiting on exactly this write-side gap.)
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

**Files touched:** `ingestion.py (_OPERATION_NAME_MAP)`, `src/eden/sdk/a2a.py (_A2ACallCtx.attributes, wrap_a2a_invocation)`, `otel_exporter.py`
**Depends on:** FEAT-22

---

### FEAT-28 — Fix the confirmed UUID type-mismatch bug in `EvidenceGate`/`promotion_candidates`

**Status:** ⬜ OPEN — verified 2026-08-05 (`llmops/promotion.py:358` still enqueues `ref_id=f"{agent}:{candidate_version}"` into `promotion_candidates.ref_id UUID NOT NULL`; `evidence_gate.py` unchanged since 2026-07-23 (c6c9dede), i.e. before the review).

**Source:** `features/13-continuous-improvement-loop.md` — third mechanism section, `EvidenceGate`/`promotion_candidates`.

**Description:** (Specifics inlined 2026-08-05 from the source doc, replacing the earlier vague "likely a column typed inconsistently" summary.) `PromotionLoop._evidence_gate_promote` (`src/eden/llmops/promotion.py`, method at :343, enqueue at :358) enqueues `ref_id=f"{agent}:{candidate_version}"` — a composite string like `"checkout-agent:7"` — into `promotion_candidates.ref_id`, a column declared `UUID NOT NULL` (`db_migrations/versions/092_market_ready_consolidated.py:195`). The `INSERT` always raises (asyncpg's UUID codec rejects a non-hex string), caught by a bare `except Exception: return None` in `EvidenceGate.enqueue` (`src/eden/promotion/evidence_gate.py`) — so `_evidence_gate_promote` always returns `False` and prompt-canary promotion can never reach `"promote"` via this path. 100%-reproducible, not probabilistic. The manual-promote API route has the identical bug and surfaces it as an explicit error (`prompt_canary.py`, `HTTPException(503, "EvidenceGate enqueue failed — promote blocked")`), but nothing in the codebase or tests currently trips it. Fix: either migrate `promotion_candidates.ref_id` from `UUID` to `TEXT` (it must hold composite refs across six kinds), or enqueue a real UUID and carry the composite `agent:version` ref in the `evidence` JSONB — then align every reader.

**Why it matters:** A type-mismatch bug in the promotion gating table causes silent failures when candidates should be gated/promoted, undermining the gate's core job of controlling what gets promoted to production.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/llmops/promotion.py (_evidence_gate_promote)`, `src/eden/promotion/evidence_gate.py (EvidenceGate.enqueue)`, `promotion_candidates table (092 migration)`, `prompt_canary.py (manual promote route)`

---

### FEAT-29 — Fix Loop 1: step P0-C per source's exact plan

**Status:** ⬜ OPEN — verified 2026-08-05 (`record_shadow_feedback` — defined at `src/eden/services/soft_issue_review.py:571` — still has zero callers outside its own module, so the confirm/dismiss loop remains dead end-to-end and P0-C has not started).

**Source:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-C fix step.

**Description:** Third step of the four-part plan to revive Loop 1's dead shadow-detector confirm/dismiss loop, continuing from P0-A/P0-B. (Specifics inlined 2026-08-05 from the source doc:) **P0-C — make dismiss consequential independent of the weekly job:** after `record_shadow_feedback(..., dismiss=True)`, check `rule.operator_dismisses` inline and auto-disable the shadow detector when N dismissals accumulate within a window, rather than waiting for the weekly batch job to notice. (For context, P0-A recovers `signal_id` at resolve time via the already-existing `IssuesRepo.get_stumble` — noting `stumble["detail"]` comes back as a raw JSON string, not a dict, and needs `json.loads`; P0-B extends the resolve-path gate to `target in ("resolved", "ignored")` for the `record_shadow_feedback` call only.)

**Why it matters:** Required to complete the revival of the review's flagship dead-code finding — a fully-built confirm/dismiss loop that currently does nothing to improve detector quality.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/services/soft_issue_review.py`, `nl_signals table`
**Depends on:** FEAT-8, FEAT-9

---

### FEAT-30 — Close Loop 2's UI rendering gaps for the autonomous patch/merge/revert pipeline

**Status:** ⬜ OPEN — verified 2026-08-05 (`improve/page.tsx:300` still calls `rejectPlan` with no reason argument; `components/improve/plan-evidence-panel.tsx` still reads only `evidence.auto_merge` status fields — zero `reasons`/`blocked_by` references; the only "nudge" string in the portal is the typed client in `resources.ts`. The 2026-08-04 agent/improve-plan detail views (e0287f5a) did not close these gaps).

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

### FEAT-32 — Fix the guardrails portal policy-list page envelope-unwrap bug

**Status:** ⬜ OPEN — verified 2026-08-05 (`portal.ts:196-197` still types `guardrailPolicies` as `fetchApi<GuardrailPolicyFixture[]>` with no `.data` unwrap anywhere in the chain).

**Source:** `features/12-runtime-guardrails.md` — portal bugs section, policy-list page.

**Description:** (Specifics inlined 2026-08-05 from the source doc:) The guardrails portal's only live network call, `portalApi.guardrailPolicies` (`clients/portal/src/lib/api/portal.ts:196-197`), is typed `fetchApi<GuardrailPolicyFixture[]>`, but the backend returns an envelope: `GuardrailPolicy.list` wraps rows as `{status, feature, live, timestamp, data: {policies, count}}` via `_ok_envelope` (`guardrails/policy.py`), and the route (`intelligence_guardrails.py`) passes it through unchanged. Any real, non-empty response is an envelope object, not the array the frontend (and the downstream `.filter()`/`.length`/`.find()` calls in `guardrails-list-view.tsx`) assumes — the page "works" today only because it silently falls back to the empty fixture array for the zero-policy test org. Fix: unwrap `data.policies` in the client, and while there reconcile the frontend `kind` filter enum with the backend `type` enum (the two currently share zero values; drop `toxicity`/`tool_allowlist`/`rate_limit`, which describe protections eden doesn't have). Note the frontend also declares columns (`severity`, `matchCount24h`, `lastHit`, `ruleSummary`, `agentId`, `issueId`, `traceIds`) the backend never computes — those stats render blank even after the unwrap fix.

**Why it matters:** A broken policy-list page means administrators/customers cannot reliably view or manage the guardrail policies protecting their deployment through the UI — forcing API-level workarounds for a core administrative task.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `clients/portal/src/lib/api/portal.ts (guardrailPolicies)`, `clients/portal/src/lab/guardrails/guardrails-list-view.tsx`

---

### FEAT-33 — Add monitoring/alerting to detect when the trajectory-replaces-intervention patch fires

**Status:** ⬜ OPEN — verified 2026-08-05 (`install_cat15_trajectory_replaces_intervention` still defined at `wiring.py:279` and auto-installed at :374; zero metric counters in the module; the `"feature": "trajectory_guardrail"` response marker (wiring.py:349) is still surfaced nowhere).

**Source:** `features/12-runtime-guardrails.md` — monkey-patch section (monitoring gap explicitly noted).

**Description:** eden ships a default-on hot-path monkey-patch, `install_cat15_trajectory_replaces_intervention` (`src/eden/observability/trace_quality/wiring.py:279`), that silently swaps out the real content-safety guardrail checks (`InterventionEngine.evaluate_and_act`) for unrelated cost/loop/latency checks whenever a `trace_id` is passed, with zero monitoring anywhere to detect it. Independent of removing the patch outright, adding a metric/log/alert every time the cost/loop/latency path is taken instead of the real content-safety check would make the bypass observable as an interim mitigation, even before the patch itself is removed. The patched path already tags its responses `"feature": "trajectory_guardrail"` — a counter keyed on that marker is the cheapest possible implementation.

**Why it matters:** Defense in depth — even after the underlying patch is removed, this class of "safety check silently replaced" failure mode could recur elsewhere; observability into it is valuable independent of the specific current instance.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/observability/trace_quality/wiring.py (install_cat15_trajectory_replaces_intervention, metric/log/alert hooks)`

---

### FEAT-34 — Reconcile the two differently-named `EvalToGuardrailLink` classes

**Status:** ⬜ OPEN — verified 2026-08-05 (both classes still exist: `guardrails/intervention.py:789` and `evaluation/eval_intel/integration.py:67`; `judge_link` is still excluded from `_enforced_types`).

**Source:** `features/12-runtime-guardrails.md` — dual-implementation section.

**Description:** (Correction 2026-08-05: the two classes are *identically* named, in different modules — the heading's "differently-named" is a misnomer.) Two separate classes both named `EvalToGuardrailLink` exist with incompatible enforcement semantics. The documented one, `eden.guardrails.intervention.EvalToGuardrailLink` (`intervention.py:789`), is toothless — its `.promote()` writes a `type="judge_link"` policy, but `judge_link` is hard-excluded from `InterventionEngine.evaluate_and_act`'s `_enforced_types`, and it never calls the live gateway filter's `load_policies`; it does have a working `.demote()`, but no REST route reaches it. The one actually wired into production, `eden.evaluation.eval_intel.integration.EvalToGuardrailLink` (`integration.py:67`), is undocumented, and critically has no demote path (no way to walk back a guardrail once escalated/promoted via this link). Fix: pick one canonical implementation, deprecate/remove the other, document the surviving one accurately, and add a demote path to whichever becomes canonical.

**Why it matters:** Two conflicting implementations of the same concept is a significant maintainability and correctness risk — engineers modifying "the" `EvalToGuardrailLink` based on docs could be editing the toothless one while production runs the other; the lack of a demote path means guardrail escalations made via the working path are currently one-directional without manual DB intervention.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/guardrails/intervention.py (EvalToGuardrailLink, documented class)`, `src/eden/evaluation/eval_intel/integration.py (EvalToGuardrailLink, production class)`

---

### FEAT-35 — Upgrade guardrail detectors beyond v0 regex/trigram heuristics

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/guardrails/detectors.py` still imports only `re` for detection; its own docstrings still promise a future "learned classifier behind the same surface").

**Source:** `features/12-runtime-guardrails.md` — detector implementation section.

**Description:** While `InterventionEngine.evaluate_and_act` itself is a real, correctly fail-closed enforcement engine, all the detectors feeding it are v0-quality heuristics (regex and trigram matching), limiting both precision (false positives blocking legitimate content) and recall (real violations regex can't catch, e.g. paraphrased or semantically-equivalent unsafe content). Fix: incrementally replace/augment regex/trigram detectors with model-based (embedding or classifier) detection for the highest-value categories first.

**Why it matters:** The enforcement mechanism is sound, but detector quality directly determines whether guardrails actually catch what they're supposed to catch — v0 heuristics are known to be weak against adversarial or varied phrasing, undermining the safety promise even where the trajectory-replacing patch bypass isn't in play.

**Severity:** High
**Effort:** Large
**Confidence:** High

**Files touched:** `src/eden/guardrails/detectors.py (regex/trigram detectors)`, `InterventionEngine.evaluate_and_act`

---

### FEAT-36 — Clarify and document what "fail-closed" guarantees actually cover given the bypass existed

**Status:** ⬜ OPEN — verified 2026-08-05 (the bypass patch is still installed — see FEAT-33 — and existing guardrail docs (`docs/docs/observability/15-runtime-protection-guardrails.md`, `37-runtime-guardrails.md`) discuss fail-open/fail-closed policy but nowhere disclose the trajectory-bypass condition or its scope).

**Source:** `features/12-runtime-guardrails.md` — core finding framing.

**Description:** `InterventionEngine.evaluate_and_act` is described as fail-closed by design, but the existence of a bypass (the trajectory-replacing monkey-patch) that routes around it entirely means the fail-closed guarantee only holds when this specific code path is actually invoked — a nuance not documented anywhere for customers or internal stakeholders relying on the "fail-closed" claim. Fix: once the bypass is resolved, document precisely which conditions guarantee fail-closed behavior end-to-end, and consider the historical gap for incident/customer disclosure per eden's policies.

**Why it matters:** "Fail-closed" is a strong safety claim; if it was not actually true under a default-on condition, this has potential customer trust/disclosure implications beyond just the code fix.

**Severity:** High
**Effort:** Small
**Confidence:** Medium — the technical finding (bypass exists) is High confidence; the disclosure/documentation framing is an inferred product-policy action.
**Quick win.**

**Files touched:** `guardrails documentation (fail-closed guarantee docs)`
**Depends on:** FEAT-3

---

### FEAT-39 — Add EMAIL channel to `rule_sandbox_escape`'s channel list

**Status:** ⬜ OPEN — verified 2026-08-05 (`alert_stream.py`: rule at :178, channel list at :183 is `[IN_APP, WEBSOCKET, PAGERDUTY, WEBHOOK]` — still no `AlertChannel.EMAIL`, while the EMAIL dispatch branch exists at :321).

**Source:** `04-alerting-oncall.md`, §0(c)/§1 transport table (citing `alert_stream.py:178-183,394-408`; `alert_email.py`).

**Description:** Even in the counterfactual where the rule fully fires, its channel list excludes email — the one channel with a real "leaves the building" delivery mechanism. `IN_APP` only reaches a single GET list endpoint with no push/SMS fan-out; `WEBSOCKET` only reaches a browser tab already open on the exact affected entity's page. Fix: add `AlertChannel.EMAIL` to the rule's channel list and reuse the existing `send_issue_alert_email` (already called by `_dispatch_email`, just not from this rule).

**Why it matters:** Without this, even a perfectly wired and triggered P0 rule reaches a human only if they happen to have the exact right browser tab open at the exact right moment.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `alert_stream.py (rule_sandbox_escape channel list)`, `alert_email.py (send_issue_alert_email, _dispatch_email)`

---

### FEAT-40 — Fix `anomaly_alerts.py`'s severity-blind channel dispatch

**Status:** ⬜ OPEN — verified 2026-08-05 (`AnomalyDetectorLoop.tick_once` still hardcodes `await detector.dispatch_alerts(report.alerts, channels=["in_app"])` — now at `anomaly_detector_loop.py:122`).

**Source:** `04-alerting-oncall.md`, §0 anomaly-detection paragraph, §3 fix item 5 (citing `data_platform/anomaly_detector_loop.py:109-127,122`; `check_pii_breach` ~L320-357/348; `anomaly_alerts.py:426-460,573`).

**Description:** `AnomalyDetector.dispatch_alerts` already correctly implements `in_app`, `websocket`, `email`, and a gated-real `webhook` channel — only `slack`/`pagerduty` are true no-ops there. But the caller, `AnomalyDetectorLoop.tick_once` (runs by default on a ~1200s cadence, `anomaly_loop_enabled` defaults `True`), hardcodes `channels=["in_app"]` on every single call regardless of severity. A detected PII breach (hardcoded `severity="critical"`) dispatches through the exact same call as a routine warning. Fix: make `tick_once` select channels based on `alert.severity` instead of the hardcoded list — a call-site-only change since the channel implementations already exist.

**Why it matters:** A critical PII breach anomaly currently produces one Postgres notification row, full stop — no email, no webhook, nothing that reaches a human, despite the underlying dispatch code already supporting it.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `data_platform/anomaly_detector_loop.py (AnomalyDetectorLoop.tick_once)`, `anomaly_alerts.py (AnomalyDetector.dispatch_alerts)`

---

### FEAT-41 — Stop claiming self-serve alert configuration exists

**Status:** ⬜ OPEN — verified 2026-08-05 (the NL-alert → EQL → email pipeline still has no authoring UI; no claim-correction commit evidenced. Nuance: the F61 automations tab shipped 2026-08-04 (953286b7) does give customers a rule-authoring UI on /signals, but its `"alert"` action is a no-op dict return in `automations/engine.py:_execute_action` — no delivery — so the core claim stands).

**Source:** `04-alerting-oncall.md`, §4 Recommendation.

**Description:** The one pipeline that reliably reaches a human (NL-alert → EQL → email) has no authoring UI — a customer cannot configure it through the product today at all, independent of and more fundamental than any transport gap. Fix: correct any marketing/product claims implying customers can self-configure alerts today, until a self-serve authoring UI ships (or wire the new automations tab's `"alert"` action to a real delivery channel, which would close the gap for real).

**Why it matters:** The product cannot even be configured by a customer today, a more basic gap than whether delivery works.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `customer-facing marketing/product material`

---

### FEAT-42 — Build a real PagerDuty Events API v2 sender, and stop claiming working PagerDuty alerting until it ships

**Status:** ⬜ OPEN — verified 2026-08-05 (`_dispatch_pagerduty` at `alert_stream.py:427-429` is still exactly a docstring + one `logger.info("PagerDuty alert skipped:not_configured...")` line — no HTTP call, no config lookup).

**Source:** `01-competitor-matrix.md`, "Verdicts" section, "PagerDuty alerting" entry (citing `alert_stream.py:427-429`; cross-referenced in `04-alerting-oncall.md`) **+** `04-alerting-oncall.md`, §1 transport table, §4 Recommendation (citing `alert_stream.py:427-429`; `anomaly_alerts.py:457-458`; `webhook_delivery.py`) — two review docs independently flag the same dead PagerDuty integration from a messaging angle and a build angle respectively; merged into one entry.

**Description:** `AlertChannel.PAGERDUTY` is a real enum wired into the P0 rule, but `_dispatch_pagerduty()` is exactly two lines: a log statement, no HTTP call, no config lookup — the same no-op pattern repeats in `anomaly_alerts.py`. Two named competitors (LangSmith, Arize AX) are sourced with live PagerDuty integration. Fix: (1) build a real PagerDuty Events API v2 sender, reusing `webhook_delivery.py`'s existing HMAC-SHA256 signing / retry ladder (`0s,1s,5s,25s,2m,10m,1h`→DLQ) / SSRF-safe DNS re-resolution infrastructure rather than a bare unretried POST (a generic Opsgenie-compatible webhook is a secondary, lower-priority addition given Opsgenie's 2027 sunset); (2) until it ships, do not cite eden as having working PagerDuty alerting in competitive or customer-facing material.

**Why it matters:** This is the fix most people assume is "the" fix but is step 4 of 4 in the broader alerting-pipeline chain — and overclaiming a no-op integration against named competitors with verified live PagerDuty support is a credibility risk in any competitive-positioning document or sales conversation where the claim could be checked.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `alert_stream.py (_dispatch_pagerduty)`, `anomaly_alerts.py (pagerduty no-op)`, `src/eden/services/webhook_delivery.py (HMAC signing/retry ladder infra)`
**Depends on:** FEAT-14, FEAT-15

---

### FEAT-44 — Unify the three/four disconnected alert-routing systems into one data model

**Status:** ⬜ OPEN — verified 2026-08-05 (all four systems still present and disjoint: `automations/engine.py`, `closed_loop/playbook_router.py`, `realtime/alert_stream.py`, `dsl/alerts.py` — and the F61 automations tab (953286b7) now exposes the Automations system directly to customers, raising the cost of the fragmentation).

**Source:** `04-alerting-oncall.md`, §1, §4 (citing Automations `automations/engine.py`; `playbook_router.py`'s 22 hardcoded categories; `alert_stream.py`'s Kafka rule engine; the NL-alert/`AlertAsCode` pipeline).

**Description:** None of the four alert-routing systems (Automations tab, playbook router, Kafka rule engine, NL-alert pipeline) share a data model, a severity concept, or a notification-destination concept. Fix: design and build a single unified rule/severity/destination data model that the various trigger sources (security events, quality/behavior findings, EQL rules, score thresholds) all route through.

**Why it matters:** Even after the individual point fixes land, the product still lacks one coherent place to configure "alert me on X, send it to Y" — a structural product-architecture gap, not just isolated bugs.

**Severity:** High
**Effort:** Large
**Confidence:** High

**Files touched:** `automations/engine.py`, `closed_loop/playbook_router.py`, `realtime/alert_stream.py`, `NL-alert/AlertAsCode pipeline (dsl/alerts.py)`

---

## Wave 4

**19 points** (0 bugs, 2 optimizations, 17 features) — severity mix: 1 Critical, 18 High. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 3 or earlier.

**Status as of 2026-08-05:** 19 remaining (1 partial, 18 open).

### OPT-13 — Evidence-integrity flag: F12 Typesense span-search benchmark is unreproducible from any code in the repo

**Status:** 🟡 PARTIAL — the 1.1M artifact is now reproducible from committed code; the full scale ladder, facet A/B toggle, and automated `gate_met` remain.

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

### OPT-15 — Wire route-level offset/cursor pagination for the issues list

**Status:** ⬜ OPEN — verified 2026-08-05 (`list_portal_issues` at `portal.py:1599` still declares only `limit: Query(50, ge=1, le=200)` and hardcodes `offset=0` in the repo call at :1609).

- **Source:** `04-frontend-perf.md` "Practical impact" (L22) +
  "Recommendation" #4 (L79).
- **Description:** Backend caps issues at `limit: Query(50, ge=1, le=200)`,
  but the client never sends `limit`, so it always gets the server default
  of 50 with no "load more." The doc corrects its own earlier draft: the
  route does **not** already support `offset` — `list_portal_issues`
  hardcodes `offset=0`. The repo layer already accepts an `offset: int = 0`
  kwarg, so the fix is scoped to adding an `offset`/cursor `Query` param to
  the route and threading it to the existing repo parameter, then having
  the client pass `limit`/`offset` and add a "load more" UI.
- **Impact:** Not quantified numerically; framed as a correctness gap —
  "any org with more than 50 issues silently only ever sees the newest 50,
  with no user-visible signal that older issues exist."
- **Severity:** Medium-High (silent data-visibility bug for any org
  exceeding 50 issues).
- **Effort:** Medium (route param + repo wiring already half-built +
  client UI).
- **Confidence:** High (doc explicitly corrected its own earlier "backend
  already supports offset" claim after re-grepping the whole file).

**Files touched:** `portal.py (list_portal_issues)`, `clients/portal issues client ("load more" UI)`

---

### FEAT-24 — Extend `TELEMETRY_INSERT_SQL` and `_build_postgres_row` to actually write the 5 new columns

**Status:** ⬜ OPEN — verified 2026-08-05 (`TELEMETRY_INSERT_SQL` at `telemetry_collector.py:289` still lists 48 columns — none of `operation_name`/`provider_name`/`error_type`/`parent_agent_span_id`/`child_agent_trace_id`; zero occurrences of those names anywhere in the file).

**Source:** `05-multiagent-tracing.md` (citing `telemetry_collector.py:289-314`, `_build_postgres_row` — now at `:1349`, cited `:1370-1447` has drifted)
**Description:** `TELEMETRY_INSERT_SQL`'s column list needs extending from 48 to 53 columns, adding `operation_name, provider_name, error_type, parent_agent_span_id, child_agent_trace_id` before `created_at` with `$49-$53` placeholders. `_build_postgres_row` needs 5 new trailing tuple entries appended after `event.response_message_hashes or None`. Both `_route_postgres` (:1474) and `_route_postgres_many` (:1490) go through this one constant — a single edit point.
**Why it matters:** This is the literal DB-write step that closes the "columns exist but nothing writes them" gap — without it, #22 and #23 compute the right values but never persist them. (Read-side SQL in `observability.py` already selects `provider_name`/`error_type`, so reads light up as soon as writes land.)
**Severity:** Critical
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `telemetry_collector.py (TELEMETRY_INSERT_SQL, _build_postgres_row, _route_postgres, _route_postgres_many)`
**Depends on:** FEAT-22, FEAT-23

---

### FEAT-27 — Fix Loop 1 (shadow-detector confirm/dismiss loop): step P0-D per source's exact plan

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/mcp_server/tools.py` still has zero confirm/dismiss/shadow-feedback matches; `record_shadow_feedback` still has no callers).

**Source:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-D fix step.

**Description:** Loop 1 (the shadow-detector confirm/dismiss loop backing `soft_issue_review.py` and the `nl_signals` table) is currently fully dead code — built but not actually functioning end-to-end. The source doc provides an exact four-step (P0-A/B/C/D) plan to revive it; this is the fourth and final step. (Specifics inlined 2026-08-05 from the source doc:) **P0-D — add the MCP tool + non-issue-flow confirm:** a `confirm_shadow_detector(org_id, signal_id, confirm|dismiss)` MCP tool calling `record_shadow_feedback` directly, so operators working from Cursor/Claude (not the issues UI) can also label detector quality. `mcp_server/tools.py` has zero confirm/dismiss/shadow-feedback matches today.

**Why it matters:** Completes the fix for the review's flagship dead-code finding — a fully-built but entirely non-functional feedback loop where user confirm/dismiss signals should be improving detector quality over time but currently do nothing. Without this final step the loop remains partially non-functional even after the earlier P0 steps.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/services/soft_issue_review.py`, `src/eden/mcp_server/tools.py`, `nl_signals table`
**Depends on:** FEAT-8, FEAT-9, FEAT-29

---

### FEAT-31 — Remove the hardcoded kind-gate blocking non-`nudge` promotion kinds

**Status:** ⬜ OPEN — verified 2026-08-05 (`EvidenceGate._metrics_from_outcomes` still hardcodes `if kind != "nudge" or not ref_id: return []` at `evidence_gate.py:121`; file unchanged since 2026-07-23).

**Source:** `features/13-continuous-improvement-loop.md` — third mechanism section, kind-gate restriction.

**Description:** `EvidenceGate`/`PromotionLoop` has a hardcoded restriction such that only `nudge`-kind candidates can actually be promoted through it — prompt-canary, guardrail, model_routing, and kb_skill kinds are all blocked from promotion despite being intended to use the same gating mechanism. (Correction/precision 2026-08-05: the promote branch itself, `promote_if_passed`, already handles `guardrail`/`prompt_version`/`kb_skill` kinds — the blocking gate is upstream in **evidence derivation**: `_metrics_from_outcomes` (`evidence_gate.py:121`) returns `[]` for any non-`nudge` kind, so `evaluate()`/`evaluate_bayesian()` always return `passed=False, recommendation="hold"` for those kinds and the multi-kind promote branch is unreachable.) Fix: generalize evidence derivation per kind (each kind needs its own outcome source) so all intended promotion kinds can flow through the gate, once the UUID type-mismatch bug (#28) is also fixed — they likely need to be fixed together to properly test the broader-kind path.

**Why it matters:** A scoping bug that silently limits a shared infrastructure piece (the promotion gate) to a fraction of its intended use cases — prompt-canary and guardrail promotion (both safety/quality-relevant) currently can't use the evidence-gated promotion path at all, likely forcing riskier ungated promotion or blocking those features from having a promotion path entirely.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/promotion/evidence_gate.py (_metrics_from_outcomes kind-gate)`
**Depends on:** FEAT-28

---

### FEAT-37 — Establish a single source of truth for "which guardrail enforcement path is active"

**Status:** ⬜ OPEN — verified 2026-08-05 (all three parallel mechanisms still present: `evaluate_and_act`, the monkey-patch at `wiring.py:279`, and both `EvalToGuardrailLink` classes — see FEAT-33/34).

**Source:** `features/12-runtime-guardrails.md` — synthesizes the monkey-patch and dual-`EvalToGuardrailLink` findings.

**Description:** There isn't one guardrail enforcement pipeline today — there's `InterventionEngine.evaluate_and_act`, the trajectory-replacing monkey-patch, and two `EvalToGuardrailLink` implementations, with unclear precedence between them. Beyond fixing each individually, there's a broader architectural action: define and document a single canonical enforcement path so future engineers don't reintroduce a second silent bypass.

**Why it matters:** Point fixes address the currently-known instances, but without an architectural single-source-of-truth, the same "silent parallel implementation" failure mode that caused this problem in the first place could recur.

**Severity:** High
**Effort:** Medium
**Confidence:** Medium — a reasonable synthesized architectural recommendation rather than something the source doc states as its own standalone checklist item.

**Files touched:** `InterventionEngine.evaluate_and_act`, `src/eden/observability/trace_quality/wiring.py (install_cat15_trajectory_replaces_intervention)`, `EvalToGuardrailLink (both implementations)`
**Depends on:** FEAT-3, FEAT-34

---

### FEAT-38 — Verify no customer-facing guardrail dashboards report enforcement metrics from the bypassed path as if from the real path

**Status:** ⬜ OPEN — verified 2026-08-05 (prerequisites FEAT-3/FEAT-33 have not landed — bypass still installed, no monitoring — so this audit cannot have been meaningfully done; no audit artifact found).

**Source:** `features/12-runtime-guardrails.md` — synthesizes monkey-patch + portal-bugs sections.

**Description:** Given the portal's own bugs (envelope-unwrap, enum mismatch) and the enforcement path itself being silently substitutable, there's a compounding risk: any dashboard/metric surfaced to customers about "guardrail enforcement activity" may currently report on the wrong (cost/loop/latency) checks rather than actual content-safety enforcement whenever the bypass is active, with nobody realizing the metrics don't mean what they claim. Fix: audit any customer-facing guardrail metrics/dashboards for this specific conflation once the bypass fix and monitoring land.

**Why it matters:** Compounds the core safety issue with a reporting-integrity issue — customers could be looking at dashboards that appear to confirm guardrails are working when they're actually seeing unrelated metrics.

**Severity:** High
**Effort:** Small
**Confidence:** Low — a speculative compounding risk inferred by combining two separate findings in the source doc, not stated as a single finding itself.
**Quick win.**

**Files touched:** `guardrails portal dashboards/metrics components`
**Depends on:** FEAT-3, FEAT-33

---

### FEAT-45 — Build the missing budget-setting UI form in the portal

**Status:** ⬜ OPEN — verified 2026-08-05 (`budget.ts`'s `budgetApi` still exports exactly one function, `get` (:36); `upsertBudget` at `resources.ts:2245` still has zero call sites).

**Source:** `06-cost-governance.md`, "Setting a budget: a real backend, a missing product" (citing `clients/portal/src/lib/api/budget.ts`; unused `upsertBudget()` in `resources.ts:2245`; `cost-spend-view.tsx:121-153`).

**Description:** `budget.ts` (the client the Cost page actually uses) exports exactly one function, `get()` — no `set`/`upsert`/`update`. A second, fully-typed but entirely unused client wrapper, `upsertBudget(orgId, body)`, already wraps `POST /orgs/{org_id}/budget` with the exact typed body the backend expects (`cost_soft_limit_usd`, `cost_hard_limit_usd`, `enforcement_enabled`, `window`, `action_on_exceed`, `threshold_alert_pct`) but has zero call sites anywhere in the portal. `cost/page.tsx` renders the budget as a read-only progress bar + status pill — no input field, no "Edit budget" button. Fix: build the form UI (soft/hard USD inputs, window picker, alert-threshold multiselect defaulting to `[50, 80, 100]`, `action_on_exceed` selector) and wire it to the already-existing `upsertBudget()` client function.

**Why it matters:** "The only way to actually configure a budget in eden today is a raw API call" — a non-starter for the actual buyer persona (a team lead who is not going to curl an endpoint). Called "arguably the cheapest, highest-visible-impact fix" in the doc since the backend contract, validation, and typed client already exist.

**Severity:** High (recalibrated from Critical in source doc — see appendix)
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `clients/portal/src/lib/api/budget.ts`, `clients/portal/src/lib/api/resources.ts (upsertBudget)`, `cost-spend-view.tsx`, `cost/page.tsx`

---

### FEAT-46 — Mount the already-built `NotificationsProvider` so in-app budget alerts are visible

**Status:** ⬜ OPEN — verified 2026-08-05 (`NotificationsProvider` is still defined at `use-notifications.tsx:57` and mounted nowhere — its only references are its own module and a comment in `resources.ts`; no layout wraps it, no bell icon/panel exists).

**Source:** `06-cost-governance.md`, "Getting alerted" (citing `budget_service.py:449-511`; `clients/portal/src/hooks/use-notifications.tsx:57`; `alert_email.py`'s `send_budget_hard_limit_email`).

**Description:** `evaluate_budget_alerts()` is well-built — debounced (~45s), idempotent per threshold/window, fires at 50/80/100% by default — and writes a `notifications` row via `_notify_budget_alert()` on every threshold crossing. The portal has a fully-built consumer, `NotificationsProvider` (adaptive polling, unread counts, mark-as-read, delete), but it's never mounted anywhere in the app: no provider wraps the layout, no bell icon, no toast, no notification panel exists. Separately, email alerts fire only once, at the 100% (hard) threshold — the 50%/80% "early warning" thresholds produce zero human-visible signal anywhere today. Fix: wrap the app layout in `<NotificationsProvider>`, add a bell icon/panel.

**Why it matters:** "Every in-app alert eden's backend writes for a budget threshold crossing is invisible to the customer today" — a complete notification system (table, write path, React provider) with zero UI surface consuming it. Should rank above the deeper spend-tracking schema work in sequencing since none of that backend correctness work is legible to a customer until there's a UI surface reading it.

**Severity:** High (recalibrated from Critical in source doc — see appendix)
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `clients/portal/src/hooks/use-notifications.tsx (NotificationsProvider)`, `portal app layout`, `budget_service.py (evaluate_budget_alerts, _notify_budget_alert)`, `alert_email.py (send_budget_hard_limit_email)`

---

### FEAT-48 — Make `enforce_sso` actually block password login, or remove the toggle

**Status:** ⬜ OPEN — verified 2026-08-05 (zero `enforce_sso` references in `api/routes/auth.py`; all 6 references live in `sso.py` itself plus the column definition in `001_initial_schema.py:401`. The 2026-07-30 SSO route remount (49334952) did not wire enforcement into the password-login path).

**Source:** `07-security-compliance.md`, §1c item 1 (citing `sso.py:379-405`; `auth.py` password-login path).

**Description:** `enforce_sso` is written by `POST /sso/providers/{id}/enforce` and read back only by `list_sso_providers`'s own response — nothing in `auth.py`'s password-login path ever checks it. The docstring's claim that it "blocks password login for org members" is currently false: flipping the toggle in the portal changes no login behavior for anyone. Fix: either wire `auth.py`'s password-login path to check and honor `enforce_sso`, or remove/relabel the toggle so it doesn't imply a security control that doesn't exist.

**Why it matters:** An admin who enables this toggle believing it closes the password-login bypass for their org is operating under a false security assumption — this is a silent security-control gap, since the UI implies protection that isn't applied.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `sso.py (POST /sso/providers/{id}/enforce, list_sso_providers)`, `auth.py (password-login path)`

---

### FEAT-49 — Resolve the dual-SSO-story ambiguity (Clerk-based vs. `sso.py` OIDC/SAML)

**Status:** ⬜ OPEN — verified 2026-08-05 (`docs/docs/how-to/sso.md` still documents the Clerk path — 22 Clerk mentions; zero portal references to `/sso/login` or `/sso/callback`; the `sso.py` admin functions incl. `enforceSSO` remain wired in `resources.ts`. The 2026-07-30 commits (49334952, 9557bdce) repointed/trimmed `sso.py` routes but did not resolve which mechanism is authoritative).

**Source:** `07-security-compliance.md`, §1c item 2 (citing `docs/docs/how-to/sso.md`; `clients/portal/src/lib/api/resources.ts`).

**Description:** `docs/docs/how-to/sso.md` documents SSO as configured entirely via the Clerk dashboard — separate from the `sso.py` OIDC/SAML flow. The portal's admin UI only wires config functions for `sso.py` (`listSSOProviders`, `createSSOProvider`, `enableSSOProvider`, `enforceSSO`, SCIM token functions) and never calls `/sso/login` or `/sso/callback`, so the portal's SSO tab lets an admin configure a login path the product never drives traffic through. Fix: pick one authoritative mechanism (Clerk or `sso.py`) and either remove/hide the other's admin UI, or add an explicit in-product warning that the `sso.py` config path is inert.

**Why it matters:** Today an admin can spend time configuring a "parallel dead code path" with no warning that it does nothing — a silent trust-eroding trap, and a documentation/product inconsistency that would confuse any technical buyer who reads both the how-to doc and the settings UI.

**Severity:** High
**Effort:** Small (decision + UI warning); Large if fully consolidating
**Confidence:** High
**Quick win.**

**Files touched:** `docs/docs/how-to/sso.md`, `clients/portal/src/lib/api/resources.ts (SSO admin functions)`

---

### FEAT-50 — Wire the "Audit → packs" screen to `ComplianceEvidenceGenerator`/`CompliancePackGenerator` instead of a raw ledger query

**Status:** ⬜ OPEN — verified 2026-08-05 (`portal.py`'s `audit/packs` endpoint still calls `AgentAuditLedgerWriter` — 2 references — and has zero references to `ComplianceEvidenceGenerator`/`CompliancePackGenerator`).

**Source:** `07-security-compliance.md`, §5b, §7 (citing `settings/page.tsx:143-168`; `api/routes/portal.py:2692`; `services/governance_intel/compliance.py`, 811 lines; `governance/compliance_pack.py`, 244 lines).

**Description:** The one live, wired compliance-adjacent screen in the portal (Audit → packs) calls `GET /orgs/{orgId}/portal/audit/packs`, which traces to `AgentAuditLedgerWriter().query()` directly — not to `ComplianceEvidenceGenerator` (811 lines, tested to generate 50+ SOC2 controls / 18 HIPAA safeguards / 10 GDPR controls / 14 ISO27001 families) or the newer agent-scoped `CompliancePackGenerator` (enabled by default via `compliance_pack_export_v1`). So the one screen a compliance officer can actually load shows a raw hash-chained audit-event ledger, not a framework-mapped evidence report. Fix: repoint this screen, or add a new one, that calls `CompliancePackGenerator.generate_agent_pack` (or `ComplianceEvidenceGenerator` directly) instead of the raw ledger query.

**Why it matters:** A compliance officer running a vendor security questionnaire needs a framework-mapped evidence report, not a raw event ledger — today's live screen serves the less useful one despite the better one already existing and being enabled by default in production.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `settings/page.tsx`, `api/routes/portal.py (GET /orgs/{orgId}/portal/audit/packs)`, `services/governance_intel/compliance.py (ComplianceEvidenceGenerator)`, `governance/compliance_pack.py (CompliancePackGenerator)`

---

### FEAT-51 — Ship a portal admin UI for SSO/RBAC/SCIM/PII-policy configuration

**Status:** ⬜ OPEN — verified 2026-08-05 (`settings-chrome.tsx:15` still declares `SettingsMode = "workspace" | "keys" | "members" | "audit"`; `scim` (:28) and `pii` (:30) still alias to `workspace`; `app/(portal)/settings/` still contains only `layout.tsx` + `page.tsx` — no roles/sso/scim/pii sub-routes).

**Source:** `07-security-compliance.md`, §5b, §5e items 1-3 (citing `settings-chrome.tsx`; `resources.ts:1531-1534`).

**Description:** `clients/portal/src/lab/settings/settings-chrome.tsx` exposes only four modes (`workspace`/`keys`/`members`/`audit`); legacy `scim`/`pii` tab params alias to `workspace` with no dedicated screen, and no `settings/roles`, `settings/sso`, `settings/scim`, or `settings/pii` sub-routes exist. Every SSO/RBAC/SCIM/PII-policy function in `resources.ts` has zero external consumers. A stale code comment at `resources.ts:1531-1534` describes a planned `/settings/roles` page that was never built. Fix, per the doc's gap-ranked recommendation: P0 ship SSO/SAML self-service admin screen (paired with the SSO login-flow fix); P1 ship RBAC role/permission management screen; P1 ship a PII policy configuration screen ("eden's strongest technical story, currently invisible to buyers").

**Why it matters:** RBAC (custom roles + permission catalogue at `rbac.py`, 715 lines) and PII redaction (multiple modules, 35 matching test files) are real, tested, working backends with zero portal path to configure them — disqualifying for a self-serve security review by a security-conscious buyer regardless of backend quality.

**Severity:** High
**Effort:** Large (all three screens); Medium per individual screen
**Confidence:** High

**Files touched:** `clients/portal/src/lab/settings/settings-chrome.tsx`, `clients/portal/src/lib/api/resources.ts (SSO/RBAC/SCIM/PII functions)`, `new routes: settings/roles, settings/sso, settings/scim, settings/pii`, `rbac.py`
**Depends on:** FEAT-1

---

### FEAT-52 — Repoint `cohorts.py` at `session_summaries` instead of `jobs`

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/analytics/cohorts.py` still has 2 `FROM jobs` queries and zero `session_summaries` references). Note: the N12 `session_summaries` table + rollup landed 2026-08-04 (5e645046), so the correct target table now exists and is populated — the repoint is unblocked.

**Source:** `features/11-session-analytics.md` — analytics code / wrong-table bug section, `cohorts.py`.

**Description:** `cohorts.py` (cohort analysis logic, `src/eden/analytics/cohorts.py`) currently queries the `jobs` table, which is not the correct source for session/cohort analytics — it should query `session_summaries` (the N12 table). This appears to be orphaned code written against an earlier/wrong schema assumption. Fix: repoint the queries to `session_summaries` and validate output against expected cohort semantics.

**Why it matters:** Cohort analysis output is currently either wrong or meaningless (querying job records, not session records, for what should be session-based cohort retention data) — any feature or dashboard relying on `cohorts.py` is silently producing incorrect numbers.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/analytics/cohorts.py`, `session_summaries table`, `jobs table`

---

### FEAT-54 — Fix the nonexistent `audit_log` table reference (also breaks `export_audit_log`)

**Status:** ⬜ OPEN — verified 2026-08-05 (`funnels.py:93` and `api/routes/audit.py:210` — inside `export_audit_log`, :186 — still query `FROM audit_log`; migrations define only `org_audit_log` (001_initial_schema.py:328), and the 2026-07-30 "create 13 missing tables" commit (deb44d29) did not include `audit_log`).

**Source:** `features/11-session-analytics.md` — schema bug section, `audit_log` table.

**Description:** Beyond being the wrong semantic source for funnels (#53), `audit_log` as referenced in code does not actually exist as a table in the current schema — a harder failure than a wrong-table bug, meaning any code path hitting this reference (including `export_audit_log` at `src/eden/api/routes/audit.py:186`) fails outright rather than returning wrong data. Fix: either create the missing `audit_log` table with correct schema if audit logging is still wanted, or remove/repoint all references (`src/eden/analytics/funnels.py`, `export_audit_log`) to the correct current audit/event source (likely `org_audit_log`).

**Why it matters:** A harder, more visible failure than the pure wrong-table bugs (likely throws exceptions rather than silently returning wrong data), and it affects at least two independent code paths, suggesting the underlying schema drift is broader than a single file.

**Severity:** High (recalibrated from Critical in source doc — see appendix)
**Effort:** Medium
**Confidence:** High

**Files touched:** `audit_log table (migration)`, `src/eden/analytics/funnels.py`, `src/eden/api/routes/audit.py (export_audit_log)`

---

### FEAT-59 — Fix broken `org_id`/`tenant_id` column mismatch in `_fetch_telemetry_rollup_for_agent`'s sub-queries

**Status:** ⬜ OPEN — verified 2026-08-05 (`_common.py` still queries `telemetry_events WHERE org_id = $1` (:295) and `judge_scores WHERE org_id = $1` (:331) inside `_telemetry_rows`/`_judge_rows`; both failures still swallowed by `except Exception: logger.debug`).

**Source:** `05-multiagent-tracing.md`, "What eden actually has" (citing `src/eden/agents/agent_intel/_common.py` — `_telemetry_rows`/`_judge_rows`/`_cost_rows`, cited line ranges :238-340/:291-299/:325-333 have drifted slightly; `010_judge_scores.py:32`).

**Description:** `_fetch_telemetry_rollup_for_agent` fires three parallel queries via `asyncio.gather`. `_telemetry_rows()` (queries `telemetry_events WHERE org_id = $1`) and `_judge_rows()` (queries `judge_scores WHERE org_id = $1`) both filter on a column, `org_id`, that doesn't exist on either table — both key on `tenant_id`. Only `_cost_rows()` (against `usage_events`, which genuinely has `org_id`) works. Each sub-fetch is independently wrapped in `except Exception: logger.debug(...)`, silently swallowing the failures. Fix: change the WHERE clause in `_telemetry_rows()`/`_judge_rows()` from `org_id = $1` to `tenant_id = $1`, and add real error surfacing instead of silent `logger.debug`.

**Why it matters:** Every call to this rollup silently returns `n_traces: 0, success_rate: None, judge_avg: None` — only `cost_usd` is ever populated. Any UI/report depending on this rollup shows agents as having zero traces and no success rate.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/agents/agent_intel/_common.py (_fetch_telemetry_rollup_for_agent, _telemetry_rows, _judge_rows, _cost_rows)`, `telemetry_events table`, `judge_scores table`, `010_judge_scores.py`

---

### FEAT-60 — Add matching fields to `TelemetryEventIngest` Pydantic ingest model

**Status:** ⬜ OPEN — verified 2026-08-05 (`TelemetryEventIngest` at `observability.py:65` still declares none of the 5 fields; the `error_type`/`provider_name` occurrences elsewhere in the file are read-side SQL only).

**Source:** `05-multiagent-tracing.md` (citing `src/eden/api/routes/observability.py:65`).

**Description:** The Pydantic model validating the wire payload before it becomes a `TelemetryEvent` lacks `operation_name`, `provider_name`, `error_type`, `parent_agent_span_id`, `child_agent_trace_id`. Fix: add the same 5 fields as `Optional[...]`, default `None`.

**Why it matters:** Without this, incoming payloads carrying these values from SDKs/exporters would be validated away before ever reaching the dataclass.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/api/routes/observability.py (TelemetryEventIngest)`

---

### FEAT-66 — Build a portal UI panel for the org-wide delegation graph (`FleetService.delegation_graph`) and update the guard test blocking `fleetApi`/`a2aApi` reintroduction

**Status:** ⬜ OPEN — verified 2026-08-05 (`delegation_graph` at `fleet/service.py:404` remains live server-side; repo-wide grep of `clients/portal/src` for `fleetApi`/`delegation` still returns only `dead-code-removal.test.ts` — zero real consumers, no Delegation panel).

**Source:** `05-multiagent-tracing.md` (citing `fleet/service.py:128-158,404-443`; route `fleet.py:60-62`; `agents-client.tsx`; `dead-code-removal.test.ts:32`; `stub-try-instead.ts`).

**Description:** The backend is fully correct and self-refreshing: `refresh_delegation_edges` rebuilds `agent_delegation_edges` from a 7-day `a2a_links` aggregation, and `delegation_graph()` calls it inline on every request, returning `{nodes: [{id, label, delegation_trust}], edges: [{source, target, call_count_7d, error_rate_7d, delegation_trust, blast_radius}]}` via `GET /orgs/{org_id}/fleet/delegation` (gated behind `require_feature_flag("fleet_health_v1")`, default `True` — live, not dark-launched). But there are zero real frontend consumers of any `FleetHealthService` endpoint — a repo-wide grep for `fleetApi`/`/fleet/...` returns nothing except a test asserting `fleetApi`/`a2aApi` stay deleted; `/fleet` is coded as a *retired* route redirecting to `/agents`. Fix: add a "Delegation" panel/tab to the existing detail pane in `agents-client.tsx` (or an org-level sub-view under `/agents`), calling the existing endpoint. Do NOT resurrect a standalone `/fleet` page. Requires deliberately updating `dead-code-removal.test.ts:32`, not working around it.

**Why it matters:** A materially correct, live, self-refreshing backend feature (org-wide agent delegation graph with trust scores and blast radius) is completely invisible to any user today — a pure presentational gap, not a backend gap. Also directly informs #65's causal-chain work and reuses the same node/edge rendering shape.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `fleet/service.py (FleetService.delegation_graph, refresh_delegation_edges)`, `fleet.py (GET /orgs/{org_id}/fleet/delegation)`, `agents-client.tsx`, `dead-code-removal.test.ts`, `stub-try-instead.ts`

---

### FEAT-68 — Populate `INTERNAL_CHAT_FALLBACKS` for eden's own internal LLM traffic

**Status:** ⬜ OPEN — verified 2026-08-05 (`INTERNAL_CHAT_FALLBACKS: list[str] = []` — still empty, at `src/eden/llm/models.py:26`; consumed by the model-candidates helper at :31).

**Source:** `features/10-model-gateway.md` — eden's internal LLM usage section, `eden.llm.client.OpenRouterClient`.

**Description:** 100% of eden's own internal LLM traffic (calls eden itself makes to LLMs — evals, nudge generation, issue extraction, etc.) goes through `eden.llm.client.OpenRouterClient`. This client has an `INTERNAL_CHAT_FALLBACKS` provider/model-fallback mechanism that is currently unpopulated (empty), meaning there is no actual fallback behavior configured — a single OpenRouter/upstream outage takes down all internal LLM-dependent eden features simultaneously with no fallback. (Correction 2026-08-05: the constant lives in `src/eden/llm/models.py:26`, not on the client class itself.)

**Why it matters:** eden's own product features (evals, nudges, issue extraction, all LLM-dependent internal pipelines) have a single point of failure with no fallback configured, despite the fallback mechanism already existing in code — a cheap reliability win being left on the table.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/llm/models.py (INTERNAL_CHAT_FALLBACKS)`, `eden.llm.client.OpenRouterClient`

---
## Wave 5

**19 points** (0 bugs, 0 optimizations, 19 features) — severity mix: 19 High. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 4 or earlier.

**Status as of 2026-08-05:** 19 remaining (2 partial, 17 open).

### FEAT-43 — Make `nl_alert_rules.channels` actually route to the configured channel

**Status:** ⬜ OPEN — verified 2026-08-05 (`send_nl_incident_email` (`src/eden/services/alert_email.py:143`) still takes no channel argument and sends unconditional email; its live caller `src/eden/alerts/triage_judge.py:168` passes no channel config; zero `channels` references anywhere in `alert_email.py` or `triage_judge.py` — the only `channels` code is storage/CRUD in `src/eden/alerts/repo.py:13,38,57,112`).

**Source:** `04-alerting-oncall.md`, §0.5 bullet 3, "User Experience & Value" (citing `alerts/repo.py:57`; `portal.py:324-350`; `alert_email.py:143-176`).

**Description:** `nl_alert_rules.channels` is collected, stored, and displayed back to the user, but the only live send path (`send_nl_incident_email`) is unconditional email to org admins with no channel argument at all. A user who configures `channels: {"slack": true}` still only ever gets email, if anything. Fix: thread the `channels` config through to the actual send path so it's honored.

**Why it matters:** The UI presents channel selection as a working feature; today it is entirely cosmetic, misleading a customer configuring notification routing.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/alerts/repo.py`, `src/eden/alerts/triage_judge.py (send call site)`, `src/eden/services/alert_email.py (send_nl_incident_email)`

---

### FEAT-47 — Add team/agent-scoped budgets via `scope_type`/`scope_id` schema migration

**Status:** ⬜ OPEN — verified 2026-08-05 (zero `scope_type` references in `src/eden/services/budget_service.py` or `src/eden/api/routes/budgets.py`; `src/eden/db_migrations/versions/052_budgets.py` unchanged, no later budget-scope migration — versions run only to `142_session_summaries.py`).

**Source:** `06-cost-governance.md`, §2b, §3 Verdict items 1-2, §4a (citing `budget_service.py`, `budgets.py`, `052_budgets.py`).

**Description:** Eden's budgets are org-level only — all three budget tables (`budgets`, `budget_consumption`, `budget_actions`) are keyed only on `(org_id, "window")`. Both Portkey (workspace→key→tag) and LiteLLM (key/team/user/customer/project) support multi-scope budgets; eden does not. Fix, modeled on LiteLLM's "one shared budget object referenced by scope" pattern: `ALTER TABLE budgets/budget_consumption/budget_actions ADD COLUMN scope_type VARCHAR(16) DEFAULT 'org', scope_id VARCHAR(128) NULL`, replace unique indexes to include scope, give `get_consumption()`/`record_usage()` new keyword-only `scope_type`/`scope_id` params. Must ship combined with — not sequenced after — the underlying spend-tracking correctness fixes, and should not ship before the budget-editing UI (#45) and alert-surfacing (#46) land, since "shipping `scope_id` without first shipping an editing UI just adds a second thing that's only reachable by curl."

**Why it matters:** A two-vendor competitive gap (both Portkey and LiteLLM ship it); without it eden cannot offer per-team or per-agent cost governance at all.

**Severity:** High
**Effort:** Large
**Confidence:** High

**Files touched:** `budgets table`, `budget_consumption table`, `budget_actions table`, `src/eden/db_migrations/versions/052_budgets.py (+ new migration)`, `src/eden/services/budget_service.py (get_consumption, record_usage)`
**Depends on:** FEAT-45, FEAT-46

---

### FEAT-53 — Repoint `funnels.py` at `session_summaries` instead of `audit_log`

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/analytics/funnels.py` still contains `FROM audit_log` in its funnel query; zero `session_summaries` references in the file — even though the `session_summaries` table now exists via migration `142_session_summaries.py`, so the correct target is available).

**Source:** `features/11-session-analytics.md` — analytics code / wrong-table bug section, `funnels.py`.

**Description:** `funnels.py` (funnel analysis logic, at `src/eden/analytics/funnels.py`) currently queries `audit_log`, which is both semantically wrong (audit logs are not funnel/session step data) and references a table that doesn't even exist (see #54) — migrations create only `org_audit_log` (001) and `autonomy_audit_log` (086), never a bare `audit_log`. Fix: repoint to `session_summaries` (now real, shipped in migration 142 with a working rollup in `src/eden/sessions/rollup.py`) and rebuild funnel-step logic against the correct schema.

**Why it matters:** Funnel analytics are silently non-functional or wrong, and any downstream reporting or optimization decisions based on funnel data are built on broken foundations.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/analytics/funnels.py`, `session_summaries table`

---

### FEAT-58 — Fix `export_audit_log` independent of the `funnels.py` fix

**Status:** ⬜ OPEN — verified 2026-08-05 (`export_audit_log` at `src/eden/api/routes/audit.py:186` still streams `SELECT ... FROM audit_log WHERE org_id = $1`; no bare `audit_log` table is created by any migration — only `org_audit_log` and `autonomy_audit_log` exist).

**Source:** `features/11-session-analytics.md` — schema bug section, `audit_log` table (see also #54).

**Description:** `export_audit_log` (route handler in `src/eden/api/routes/audit.py`, streaming JSONL/CSV export gated on `audit:view`) is a separate consumer of the nonexistent `audit_log` table from `funnels.py`, and may need its own fix (e.g., a genuinely different data source than `session_summaries`, since "audit log" and "session funnel" are different concepts) rather than being folded into the same repoint as the funnels fix. Its selected columns (`user_id`, `user_email`, `action`, `target_type`, `ip_address`, `prev_hash`, `entry_hash`) closely match `org_audit_log` (created in `001_initial_schema.py`), which is the likely intended source. Fix: determine `export_audit_log`'s correct intended data source (likely `org_audit_log`, not session data) and repoint or rebuild it separately.

**Why it matters:** Treating this as identical to the funnels fix risks mis-fixing it (funnels and audit export are semantically different features that happened to share a broken table reference); calling it out separately ensures it gets its own correct fix.

**Severity:** High
**Effort:** Medium
**Confidence:** Medium — the underlying bug (#54) is High confidence; the specific claim that it needs an independently different fix from funnels is a reasonable inference, not explicit in the source.

**Files touched:** `src/eden/api/routes/audit.py (export_audit_log)`, `audit_log table / correct audit data source (likely org_audit_log)`

---

### FEAT-62 — Fix `error_type` permanently-null bug and its downstream effect on session-level error detection

**Status:** ⬜ OPEN — verified 2026-08-05 (the only `error_type` reference in `telemetry_collector.py` is still the read in `get_trace_tree`'s node dict — the collector's `INSERT INTO telemetry_events` column list does not include `error_type`, so the column is still never written; `_turn_errored` in `src/eden/sessions/rollup.py:138-140` still does `bool(row["error_type"]) or outcome in _ERROR_OUTCOMES`. Note: ingestion now stamps `error_type` into the `attributes` JSON (`normalizer.py:160-165`, `otel.py:435-437`), but that does not populate the dedicated column the two consumers read.)

**Source:** `05-multiagent-tracing.md` (citing `get_trace_tree` `:1848-2109`, node dict `:2092`; `sessions/rollup.py` `_turn_errored`).

**Description:** Since `error_type` has never been written, every span node the portal's trace-detail view renders has had an always-`None` `error_type` since migration 067 shipped. Second live consumer: `sessions/rollup.py`'s `_turn_errored(row)` does `bool(row["error_type"]) or outcome in _ERROR_OUTCOMES` — since `error_type` is always null, that first disjunct is always `False`, meaning session-level error detection today runs entirely on the `outcome` fallback. Fixed as a side effect of the write-path fixes, but flagged separately because it's a live, currently-silent correctness bug in a second consumer that should be explicitly verified/tested once the write-path fix lands.

**Why it matters:** Session-level error detection is currently missing a whole detection signal, silently relying only on `outcome`-based detection — some session errors are likely undercounted today with no visible symptom.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `telemetry_collector.py (get_trace_tree node dict)`, `sessions/rollup.py (_turn_errored)`
**Depends on:** FEAT-22, FEAT-23, FEAT-24

---

### FEAT-65 — Build within-trace causal-chain navigation for agent delegation failures

**Status:** 🟡 PARTIAL — per-trace RCA chain endpoint exists; delegation-link traversal and a consuming portal UI remain.

**Source:** `05-multiagent-tracing.md` (citing `parent_agent_span_id`/`a2a.parent_agent_id`; contrasted with `FleetService.delegation_graph`'s org-wide `_delegation_trust_score`, `fleet/service.py:404-443`).

**Already landed:** Commit 64233475 (2026-08-04) shipped a per-trace RCA chain endpoint (`rca_chain` + `_build_causal_chain` in `src/eden/api/routes/intelligence_rca.py`) that turns an ordered trace-event list into a deep-linkable causal chain with `span_id`/`parent_span_id` links, plus MCP transcript tools.

**Remaining work:** Extend the chain to traverse `parent_agent_span_id`/`a2a.parent_agent_id` (zero references in `intelligence_rca.py` today), so an engineer can walk backward from a failing child-agent span to see which agent's delegation produced the failing call and whether the parent agent then also failed as a consequence — the new `rca_chain` endpoint is the natural place to add the delegation-link traversal (distinct from the org-wide aggregate blast radius `FleetService.delegation_graph` already computes — see #66). Then build the UI path that consumes the endpoint: no portal UI consumes it yet.

**Why it matters:** Without this, a failure shows up as "just a red dot" with no way to trace which delegation chain produced it — core debugging functionality for a multi-agent observability product, directly blocking root-cause analysis of cascading agent failures.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `parent_agent_span_id / a2a.parent_agent_id fields`, `src/eden/api/routes/intelligence_rca.py (rca_chain, _build_causal_chain)`, `trace detail UI (causal-chain navigation)`
**Depends on:** FEAT-22, FEAT-23, FEAT-24

---

### FEAT-70 — Reconcile TS and Python instrumentation UX so both meet the "one-liner" bar

**Status:** 🟡 PARTIAL — reference docs now scope the mechanisms honestly; framework-level parity and the wider copy audit remain.

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

**Status:** ⬜ OPEN — verified 2026-08-05 (all 10 framework instrumentations in `sdk/ts-ai/src/instrumentations/` remain per-instance `Proxy`-based `wrap*()` factories; zero `prototype` patching and zero `import-in-the-middle`/`require-in-the-middle` usage anywhere in `sdk/ts-ai`. `instrument()` does give a one-line *HTTP-level* capture via global fetch patching plus `detectInstalledFrameworks()`, but no mechanism patches a framework's exported class once at import time the way Python does.)

**Source:** `features/09-sdk-dx.md` — auto-instrumentation comparison section.

**Description:** Python's `eden.instrument()` does genuine class-level monkey-patching across 13 frameworks (a real one-liner). TypeScript has no equivalent: instrumentation is per-instance `Proxy`-based `wrap*()` factories the caller must manually apply to every client instance they create — no mechanism patches a framework's exported class/prototype once at import time the way Python does. Fix: implement prototype-level (or Node loader-hook-based, e.g. `import-in-the-middle`) auto-instrumentation for at least the top few frameworks, matching the Python UX.

**Why it matters:** TS/Node users get a materially worse onboarding experience than Python users for the exact same product promise ("one line of code") — a direct DX/adoption gap in a core acquisition funnel (SDK install → first trace).

**Severity:** High
**Effort:** Large
**Confidence:** High

**Files touched:** `sdk/ts-ai/src/instrument.ts`, `sdk/ts-ai/src/instrumentations/ (wrap*() Proxy factories, new prototype/loader-hook auto-instrumentation)`

---

### FEAT-72 — Stop dropping the `synthetic`/`method` honesty flags in the frontend, and add a visible badge

**Status:** ⬜ OPEN — verified 2026-08-05 (zero "synthetic"/"heuristic" references in `evals-compare-view.tsx`; `evals/page.tsx` still hardcodes `avgScores: {}` at lines 1282 and 1388; and the backend still emits `synthetic: True, method: "heuristic_stub"` from `src/eden/experiments/offline_runner.py`, so the honesty badge is still needed).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (exact copy still present in `clients/portal/src/lab/playgrounds/playground-editor.tsx`: toast "Immutable snapshot promoted — open Evals to compare." at L531 and button `{promoting ? "Promoting…" : "+ Experiment"}` at L641; backend still returns `heuristic_stub` per `experiments/offline_runner.py`).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/evaluation/regression_builder.py` still does `INSERT INTO regression_eval_cases` at L274 and queries `regression_eval_cases` at L85/L173/L202; zero `dataset_items` references in the file).

**Source:** `02-evals-datasets.md`, §5 P1 item 5 (citing `regression_builder.py:267-290,188-209,307-311`; `regression_eval_cases.dataset_id VARCHAR(128)` in `db_migrations/versions/092_market_ready_consolidated.py:355-367`).

**Description:** `RegressionCase.dataset_id` is a free-text name string (e.g. `"agent-name/regressions"`), stored in a `VARCHAR(128)` column — schema-incompatible with F53's proper `UUID` `datasets.id`; these two "dataset_id" columns cannot be joined even in principle. Fix: change `RegressionCaseBuilder._persist` to insert into `dataset_items` (resolving a proper UUID `dataset_id` via `DatasetHub.get_dataset`/`create_dataset`) instead of the separate `regression_eval_cases` table, while keeping the existing fingerprint-based dedup logic (`_find_by_fingerprint`), which is sound and just needs to query `dataset_items` instead.

**Why it matters:** The specific, concrete schema blocker preventing eden's regression-case system and its canonical dataset/experiment system from ever being unified — a real migration step, not just "these should share code" hand-waving.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/evaluation/regression_builder.py (RegressionCaseBuilder._persist, _find_by_fingerprint)`, `db_migrations/versions/092_market_ready_consolidated.py (regression_eval_cases.dataset_id)`, `dataset_items table`, `DatasetHub (get_dataset, create_dataset)`

---

### FEAT-75 — Make `dataset_engine.py`'s generated datasets durable via `DatasetHub` instead of an in-memory dict

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/insights/dataset_engine.py` unchanged: `self._datasets: dict[str, Dataset] = {}` still at L207, `_store_entry` still writes only to the in-memory dict at L364-381; zero `DatasetHub` references in the file).

**Source:** `02-evals-datasets.md`, §5 P1 item 9, §3c (citing `dataset_engine.py:207,364-381,61`; `hub.py:124-167,232-283`).

**Description:** `DatasetGenerationEngine` is wired live via `InsightsService` → `api/routes/insights.py`, but `self._datasets: dict[str, Dataset] = {}` (constructor, L207) populated by `_store_entry` (L364-381) means every generated dataset is lost on process restart despite being API-reachable. Fix: replace the in-memory dict with calls into `DatasetHub.create_dataset`/`promote_trace` so detected patterns persist past a restart. The rule-based taxonomy (`DatasetRule.matches`, L61) does not need to change — only the storage backend.

**Why it matters:** A live, API-reachable feature silently loses all its data on every process restart — a durability bug that would surprise any user who generated a dataset and then found it gone.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/insights/dataset_engine.py (DatasetGenerationEngine, _store_entry)`, `hub.py (DatasetHub.create_dataset, promote_trace)`, `api/routes/insights.py`

---

### FEAT-76 — Fail-closed the lease-claim exception handler

**Status:** ⬜ OPEN — verified 2026-08-05 (`except Exception: pass` still present at `src/eden/evaluation/labeling.py:467-468`, immediately after the `claim_lease` call at L465 inside `pop()` — control falls through and treats the item as claimed).

**Source:** `08-annotation-labeling.md`, §1a, §6a item 2 (citing `labeling.py:462-468`).

**Description:** Current code catches any unexpected exception from `claim_lease()` with `except Exception: pass`, then proceeds *as if the lease had been successfully claimed* instead of declining the item (`claim_lease()` already catches its own Redis failures internally, so this only fires on a genuinely unexpected error). Fix: change `except Exception: pass` to `except Exception: continue` (or log + skip).

**Why it matters:** This is the one place designed to guarantee exclusivity between reviewers; defaulting to "grant access on error" instead of "deny" defeats the purpose of the lease mechanism on any unexpected failure.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/evaluation/labeling.py (claim_lease call site in pop(), L462-468)`

---

### FEAT-77 — Check UPDATE rowcount before confirming item claimed

**Status:** ⬜ OPEN — verified 2026-08-05 (`labeling.py:487-494` still executes `UPDATE labeling_items SET status='in_progress' WHERE id = $1 AND status = 'pending'` with the return value of `self._pg.execute()` discarded, then unconditionally sets `item.status = "in_progress"` and appends at L495-496).

**Source:** `08-annotation-labeling.md`, §1a, §6a item 3 (citing `labeling.py:487-497`).

**Description:** The status-flip `UPDATE labeling_items SET status='in_progress' WHERE id = $1 AND status = 'pending'` correctly guards on `status='pending'`, so a second writer's UPDATE becomes a no-op — but the return value of `self._pg.execute()` is discarded and the code unconditionally flips `item.status = "in_progress"` and appends it regardless of whether the UPDATE actually changed a row. Fix: only append/flip in Python if the UPDATE's returned status string confirms a row was affected (e.g., `"UPDATE 1"` vs `"UPDATE 0"`).

**Why it matters:** If the lease-claim gaps (#76 and its sibling) let a second claimant through, the API will still report the item as successfully assigned to them even though the DB-level guard silently rejected the write — a silent data-integrity inconsistency.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/evaluation/labeling.py (~L487-496)`, `labeling_items table`

---

### FEAT-79 — Consolidate the two duplicate IAA engines (delete dead code, repoint, rename)

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/evaluation/iaa.py` still exists; `queue_iaa()` still mounted at `api/routes/labeling.py:446-447` as `GET /queues/{queue_id}/iaa`; the `/iia` route still registered at `api/routes/labeling.py:349`; no `/agreement` route exists).

**Source:** `08-annotation-labeling.md`, §3, §6a item 4, §7 item 3 (citing `evaluation/iaa.py`, 44 lines; `api/routes/labeling.py:446-471`; `LabelingQueueService.add_item()`; `test_w18_playgrounds.py:9,187-189`).

**Description:** `src/eden/evaluation/iaa.py` is dead code in production. Its sole consumer, `queue_iaa()`, reads `label_a`/`annotator_1`/`label_b`/`annotator_2` keys from a kanban item's JSON payload — but nothing in the codebase ever writes those keys, and there's no API route to add an item to a queue at all. Net effect: `GET /orgs/{org}/labeling/queues/{queue_id}/iaa` returns `{"kappa": 0.0, "n": 0, "agreement_rate": 0.0}` for every queue created through the normal product flow, today. Fix (3 steps, same PR): (1) repoint `queue_iaa()` to call `LabelingService(pg).compute_iaa(org_id, item_ids)` (the real, tested κ+α engine); (2) delete `evaluation/iaa.py` and its one test, migrating its assertions to call `cohens_kappa()`/`agreement_rate()` from `labeling.py`; (3) rename `/labeling/iia` → `/labeling/agreement` and `/queues/{id}/iaa` → `/queues/{id}/agreement` to remove the `/iia` vs `/iaa` visual collision, in the same PR.

**Why it matters:** Confirmed dead/broken code that would otherwise ship into a brand-new IAA dashboard UI (#81) as a permanently-empty widget — must be fixed before/alongside the UI build.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/evaluation/iaa.py (delete)`, `api/routes/labeling.py (queue_iaa, GET /labeling/iia, /queues/{id}/iaa -> /labeling/agreement, /queues/{id}/agreement)`, `labeling.py (LabelingService.compute_iaa, cohens_kappa, agreement_rate)`, `test_w18_playgrounds.py`

---

### FEAT-82 — Build `/labeling` queue-list page with disagreement-first default sort

**Status:** ⬜ OPEN — verified 2026-08-05 (no `labeling` directory exists under `clients/portal/src/app/(portal)/`, and `/labeling` is still listed in `STUB_PORTAL_PATH_PREFIXES` in `clients/portal/src/lib/portal-routes.ts`, hard-redirecting to `/unavailable`).

**Source:** `08-annotation-labeling.md`, §6c.1.

**Description:** Build a table of F50 queues plus an "Unassigned items" panel sourced from `labelingApi.listItems`. Default sort ascending by `per_item[id].agreement` for items with 1+ annotation, so disagreement-needing items surface to the top automatically — "the single highest-leverage unification missing from the plan." Requires removing `/labeling` from `STUB_PORTAL_PATH_PREFIXES`.

**Why it matters:** This is the entry point of the annotation flow and currently doesn't exist at all — no page or route matches `label`/`annotat` anywhere in the portal.

**Severity:** High
**Effort:** Large
**Confidence:** High

**Files touched:** `clients/portal/src/app/(portal)/labeling page (new)`, `clients/portal/src/lib/portal-routes.ts (STUB_PORTAL_PATH_PREFIXES)`, `labelingApi.listItems`

---

### FEAT-83 — Build `/labeling/annotate` keyboard-driven work surface (core page)

**Status:** ⬜ OPEN — verified 2026-08-05 (no labeling pages exist in the portal; `/labeling` still stubbed in `portal-routes.ts`; the backend `pop`/`annotate`/lease/IAA machinery in `src/eden/evaluation/labeling.py` and `api/routes/labeling.py` remains reachable only via curl).

**Source:** `08-annotation-labeling.md`, §6c.3.

**Description:** Build the primary annotator page: one item at a time, showing `item.prompt`/`item.payload` with a link back to `source_trace_id`/`source_span_id`, a form driven by `item.label_schema`, confidence slider, and notes field. Keyboard shortcuts: `1-9` for labels, `s` = skip, `Enter` = submit.

**Why it matters:** This is the primary persona's (annotator/QA reviewer's) entire work surface and the single highest-leverage missing page — the backend behind it (`pop`, `annotate`, lease, IAA) is already fully built and tested, but a human reviewer today can only reach it via curl.

**Severity:** High (recalibrated from Critical in source doc — see appendix)
**Effort:** Large
**Confidence:** High

**Files touched:** `clients/portal/src/app/(portal)/labeling/annotate page (new)`, `labeling.py (pop, annotate endpoints)`

---

### FEAT-84 — Populate `IssueCard` DTO's `relatedSignalId` instead of hardcoding `None`

**Status:** ⬜ OPEN — verified 2026-08-05 (`relatedSignalId=None` still hardcoded in the `IssueCard` construction in `src/eden/api/routes/portal.py:1670`; the DTO field is declared in `src/eden/api/portal_contracts.py:166`).

**Source:** `features/16-issue-extraction-online-evals.md` — DTO bug, `IssueCard.relatedSignalId`.

**Description:** The `IssueCard` data-transfer-object's `relatedSignalId` field (declared `str | None = None` in `portal_contracts.py`) is currently hardcoded to always return `None` in the portal issues mapping (`portal.py`, where sibling fields like `signalCount` are populated from `stumble_count`), regardless of whether an actual related signal exists. This breaks any downstream consumer (portal UI or otherwise) that expects to navigate from an issue card to its underlying signal record. Fix: populate this field with the actual related signal ID from the underlying data model.

**Why it matters:** Breaks traceability from a surfaced issue back to the raw signal(s) that generated it — a core expectation for any triage workflow where a user wants to inspect "why was this flagged" and currently cannot navigate there from the issue card.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/api/routes/portal.py (IssueCard mapping, ~L1670)`, `src/eden/api/portal_contracts.py (IssueCard.relatedSignalId)`

---

### FEAT-85 — Wire the new Dismiss action to also emit the signal Loop 1's P0 fixes expect to consume

**Status:** ⬜ OPEN — verified 2026-08-05 (no dismiss action exists anywhere yet: zero "dismiss" references in `clients/portal/src/app/(portal)/issues/` or in `src/eden/issues/`; this integration requirement remains for when FEAT-10 builds the button).

**Source:** `features/16-issue-extraction-online-evals.md` — portal gap section, synthesized with doc 13's Loop 1 dependency.

**Description:** Called out separately from adding a Dismiss button itself because it's a specific integration-correctness requirement: the new Dismiss button shouldn't just remove/hide the issue in the UI — it needs to write the dismiss signal in the exact shape/location that Loop 1's revived pipeline (post #27/#29 P0 steps) expects to read from. Fix: coordinate the Dismiss button's backend call with whatever data contract Loop 1's P0 steps establish.

**Why it matters:** If the Dismiss button is built independently of Loop 1's actual signal contract, it risks becoming another instance of "looks like it works in the UI but doesn't actually feed the intended downstream system" — the exact class of disconnect this review repeatedly found (e.g., the session-analytics portal wiring gap, the artifacts/ledger stub routes).

**Severity:** High
**Effort:** Small
**Confidence:** Medium — the integration risk is a reasonable inference from the explicitly-stated Loop 1 dependency, not a separately named bullet in the source itself.
**Quick win.**

**Files touched:** `portal issue Dismiss action component`, `soft_issue_review.py`, `nl_signals table`
**Depends on:** FEAT-10, FEAT-27, FEAT-29

---

## Wave 6

**20 points** (6 bugs, 2 optimizations, 12 features) — severity mix: 12 High, 8 Medium. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 5 or earlier.

**Status as of 2026-08-05:** 20 remaining (1 partial, 19 open).

### BUG-10 — Surface NULL-`agent_id` events dropped from prompt-evolution scoring

**Status:** ⬜ OPEN — verified 2026-08-05 (the `AND te.attributes->>'agent_id' IS NOT NULL` filter is still in the aggregation query at `components.py:93` — L78 is now a comment acknowledging the drop, not a second filter — and no `FILTER`-clause counter, log line, or metric for the dropped rows exists in the file).

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

### BUG-11 — Fix 2 unwrapped-exception log sites flagged by the F75 PII-defensive-logging regression test

**Status:** ⬜ OPEN — verified 2026-08-05 (`gateway.py:280` still logs raw `exc` — `logger.debug("gateway: semantic cache unavailable: %s", exc)` — while four other sites in the same file use `redact_all(str(exc))`; `sessions.py:226` still logs raw `exc` in `_sessions_unavailable` and the file has zero `redact_all` references).

**Source:** `bugs/04-frontend-and-test-failures.md` §7b(ii)

**Description:** `tests/unit/api/test_pii_defensive_sweep_f75.py::test_no_unwrapped_exc_log_sites`
fails against current `HEAD`, flagging two newer log sites that don't follow the codebase's
established defensive-logging policy: `src/eden/api/routes/gateway.py:280` and
`src/eden/api/routes/sessions.py:226` both log a raw exception object (`exc`) directly instead of
`redact_all(str(exc))`. This is a real, contained security-hygiene gap — if an upstream provider
(Clerk/Stripe/GitHub/Helicone) ever changes its error-message format to include sensitive data,
these two sites would leak it unredacted into logs. **Fix:** wrap both sites in the same
`redact_all(str(exc))` pattern the rest of the codebase already uses.

**Blast radius:** Contained to error paths in the gateway and sessions routes — a live regression
in a defensive-logging policy, but narrow (only fires on those specific exception paths).

**Severity:** Medium.
**Effort:** Small — two log-call edits. **QUICK WIN.**
**Confidence:** High (caught by a dedicated, currently-failing regression test).

**Files touched:** `src/eden/api/routes/gateway.py`, `src/eden/api/routes/sessions.py`

---

### BUG-12 — Stop collapsing different agents' missing-`agent_id` issues into a shared fingerprint bucket

**Status:** ⬜ OPEN — verified 2026-08-05 (`raw = f"{kind}|{agent_id or 'unknown'}|{error_signature}"` still at `src/eden/issues/fingerprint.py:88`; the `if agent_id:` clause-append filter still at `src/eden/issues/repo.py:174`).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`SOTA-WAVE-TRACKER.md:326` still reads "Dual surface: aiApi deleted; ai_agent.router unmounted", while `src/eden/api/app.py` still mounts both: `eden.api.routes.ai_insights` at L226 and `eden.api.routes.ai_agent` at L229 in the deferred-mount table).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (zero `zod`/`io-ts` imports under `clients/portal/src/lib/api/`; the unvalidated casts remain in `core.ts` — `response as unknown as T` at L413, `text() as unknown as T` at L489, `blob() as unknown as T` at L492 — with the JSON path still relying on TS widening).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`_normalize_timestamp`'s string branch at `normalizer.py:48-55` still validates with `datetime.fromisoformat(s)` then `return s` unchanged — it converts a trailing `"Z"` to `+00:00` but applies no `tzinfo=UTC` fallback for offset-less strings, unlike the naive-`datetime` branch at L41-42).

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

### OPT-16 — Add missing composite index for `tool_call_labels`

**Status:** ⬜ OPEN — verified 2026-08-05 (no `idx_tool_call_labels` index in any migration under `src/eden/db_migrations/versions/` — versions run to `142_session_summaries.py` and the cited `143_signal_events_indexes.py` does not exist yet, it is the migration the sibling signal-events index point would create; the `list_for_agent`/`count_labels` read paths in `src/eden/learning/tool_call_labels.py:96,124` are unchanged).

- **Source:** `02-db-queries.md` F9 — MEDIUM (L516-573).
- **Description:** `tool_call_labels` has no secondary index beyond its
  `UNIQUE (org_id, span_id)` constraint. Two live, confirmed read paths in
  `learning/tool_call_labels.py` don't use `agent_id` in a way the unique
  constraint covers: `list_for_agent` (`WHERE org_id = $1 AND agent_id =
  $2 [AND tool_name = $3] ORDER BY created_at DESC LIMIT 200`) and
  `count_labels` (`WHERE org_id = $1 AND agent_id = $2 AND tool_name =
  $3`). Both are called from real API routes and an MCP tool. Lower
  urgency than item 1 because write volume here is gated by explicit
  human/agent labeling actions, not one row per trace per signal.
- **Fix:** `CREATE INDEX IF NOT EXISTS
  idx_tool_call_labels_org_agent_created ON tool_call_labels (org_id,
  agent_id, created_at DESC)`. Recommended to bundle into the same
  migration as item 1 ("same shape, same risk profile, zero marginal
  deploy cost").
- **Impact:** Not independently benchmarked; index gap and query shapes
  VERIFIED directly against live application code and migration history.
- **Severity:** Medium.
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `src/eden/learning/tool_call_labels.py`, `tool_call_labels (table)`, `src/eden/db_migrations/versions/ (new shared index migration, planned as 143_signal_events_indexes.py)`

---

### OPT-17 — Thread `org_id`/`feature` through `autonomous/_common.py`'s `_call_llm` → `route_async` (fixes 6 silently-zeroed cost-ledger call-site groups)

**Status:** ⬜ OPEN — verified 2026-08-05 (`_call_llm`'s signature at `autonomous/_common.py:181-188` is unchanged — `(prompt, *, agent, slot, system_prompt, max_tokens)` with no `org_id`/`feature` parameter — so the cost-context/`schedule_record_from_usage` drop described below still occurs).

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

### FEAT-55 — Wire the portal session list/header to read from `session_summaries`, not `agent_sessions`

**Status:** 🟡 PARTIAL — the primary session surface is now `session_summaries`-backed; the `agent_sessions`-backed rollup surface still coexists.

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

**Status:** ⬜ OPEN — verified 2026-08-05 (the node dict in `TelemetryCollector.get_trace_tree` — `telemetry_collector.py`, `"error_type"` key now at L2092 — still has no `agent_id` or `operation_name` key; verified by enumerating every key in the dict literal).

**Source:** `05-multiagent-tracing.md` (citing `telemetry_collector.py` `get_trace_tree` node dict; `portal.py:1385`).

**Description:** `TelemetryCollector.get_trace_tree`'s node dict builds `"error_type": row.get("error_type")` but has no `agent_id` key at all. Fix: add `"agent_id": row.get("agent_id")` and `"operation_name": row.get("operation_name")` next to the existing key — zero-cost once the columns are made real.

**Why it matters:** Even a single trace spanning multiple agents currently cannot show which span belongs to which agent in the transcript view that already correctly walks `parent_span_id` — the specific missing input that blocks swimlaning (#63).

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `telemetry_collector.py (TelemetryCollector.get_trace_tree)`, `portal.py`
**Depends on:** FEAT-22, FEAT-23, FEAT-24

---

### FEAT-78 — Add lease-expiry recovery for orphaned `in_progress` items

**Status:** ⬜ OPEN — verified 2026-08-05 (all three `pop()` tiers in `src/eden/evaluation/labeling.py` still filter `status = 'pending'` — L421, L435, L449 — and no reaper/sweep/expiry-revert code exists in `labeling.py` or `labeling_leases.py`; an item flipped to `in_progress` whose lease expires is still permanently orphaned).

**Source:** `08-annotation-labeling.md`, §1a, §6a item 1 (citing `labeling.py` `pop()` tier queries at L421-449 and the status flip at L487-496; `labeling_leases.py`; `EDEN_LABELING_LEASE_TTL_SECONDS` default 900s, floor 30s).

**Description:** When a reviewer disconnects or sits idle past the lease TTL, the Redis key expires, but `labeling_items.status` was already flipped to `'in_progress'` at claim time and nothing ever reverts it. No reaper/sweep job exists, and no admin unassign/reclaim endpoint exists. All three `pop()` tiers filter on `status = 'pending'`, including tier 1 (`assigned_to = annotator_id AND status = 'pending'`) — so even the original annotator cannot re-pop an item they abandoned; it's orphaned permanently, recoverable only via manual DB UPDATE. Fix: add a sweep (cron job or inline check in `pop()`'s tier-1 query) that reverts `status` from `in_progress` back to `pending` when no active lease key exists for that item. Cheapest version: extend tier 1's WHERE clause to also match `status = 'in_progress' AND assigned_to = annotator_id AND <lease not held by anyone else>`.

**Why it matters:** Without this, a disconnected reviewer's item is stuck forever with no self-heal path — a directly visible "I can't pop this item, it says it's assigned to someone else, but no one's touched it in an hour" trust-eroding bug the moment the annotate UI goes live.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/evaluation/labeling.py (pop() tier queries L421-449, status flip ~L487-496)`, `labeling_leases.py`, `labeling_items table`

---

### FEAT-80 — Build `/labeling/queues/[queueId]` kanban board page

**Status:** ⬜ OPEN — verified 2026-08-05 (no `labeling` directory under `clients/portal/src/app/(portal)/`; `/labeling` still in `STUB_PORTAL_PATH_PREFIXES`; the #79 agreement-endpoint consolidation this page's IAA strip depends on is also still open).

**Source:** `08-annotation-labeling.md`, §6c.2.

**Description:** Build columns `todo / in_progress / done / skipped`. Since no drag-and-drop library is installed in the portal today, ship v1 with a per-card "Move to →" dropdown instead. Add an IAA summary strip at top calling the unified agreement endpoint (post-#79 fix).

**Why it matters:** F50's kanban queue model has zero UI today; this is a core missing page, and its IAA strip would be permanently broken without the #79 consolidation fix landing first.

**Severity:** High (normalized from "Medium-High" in source doc — see appendix)
**Effort:** Medium
**Confidence:** High

**Files touched:** `clients/portal/src/app/(portal)/labeling/queues/[queueId] page (new)`, `IAA summary strip component`
**Depends on:** FEAT-79

---

### FEAT-81 — Build IAA dashboard page

**Status:** ⬜ OPEN — verified 2026-08-05 (no labeling/IAA pages exist in the portal; `LabelingService.compute_iaa` remains server-side only, reachable solely via the API routes in `api/routes/labeling.py`).

**Source:** `08-annotation-labeling.md`, §6c.4.

**Description:** Build headline kappa/alpha/overall-agreement tiles, a per-pair table, and a per-item table sorted ascending by agreement — the "disagreement drill-down" every competitor examined (LangSmith, Braintrust, Label Studio) ships.

**Why it matters:** `compute_iaa()`'s per-item/per-pair breakdown is already computed correctly server-side but is literally unreachable — no dashboard exists to view it, so the team lead/quality-owner persona has no way to spot low-agreement items or ambiguous rubrics.

**Severity:** High
**Effort:** Medium-Large
**Confidence:** High

**Files touched:** `clients/portal/src/app/(portal)/labeling IAA dashboard page (new)`, `labeling.py (LabelingService.compute_iaa)`
**Depends on:** FEAT-79

---

### FEAT-86 — Fix `IssuePromoter._update` to actually escalate severity from `user_count`/`stumble_count`/`repetition_count`

**Status:** ⬜ OPEN — verified 2026-08-05 (`IssuePromoter._update` in `src/eden/issues/issue_promoter.py` still computes only `new_severity = _more_severe(existing["severity"], severity)` at L139 — the min of two static per-kind defaults — and never reads `user_count`/`stumble_count`/`repetition_count` for severity; the aspirational comment ("IssuePromoter may bump this based on blast radius") still sits on the severity column in `src/eden/issues/models.py`).

**Source:** `features/16-issue-extraction-online-evals.md` §4a-4b — code-comment-vs-behavior mismatch, `IssuePromoter._update`.

**Description:** The `agent_issues` severity column's comment (in `src/eden/issues/models.py`, ~L58-59) claims "IssuePromoter may bump this based on blast radius," and the `Issue` model carries the raw ingredients (`stumble_count` recurrence, `user_count` blast radius, `repetition_count` regression count) — but `IssuePromoter._update` (`issue_promoter.py:115-180`) never does this escalation. Severity is set once from a static per-kind table (`_DEFAULT_SEVERITY`) and only ever narrows toward the worse of two static defaults via `_more_severe` (lexicographic `min` on `p0..p3`) as duplicate stumbles arrive — a 500-user issue and a 2-user issue of the same `kind` get identical severity forever. The comment describes intended behavior that was never built. Fix: implement the actual escalation logic the comment claims exists, using the three named signals.

**Why it matters:** Even once composite issue ranking exists, if severity itself never gets escalated as new evidence (repeated occurrences, more affected users) comes in, the severity input to that ranking stays artificially low/stale. Also a direct code-vs-comment correctness bug that could mislead future engineers into thinking this logic already works.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/issues/issue_promoter.py (IssuePromoter._update, _more_severe)`, `src/eden/issues/models.py (severity column comment)`

---

### FEAT-87 — Update product copy/marketing to accurately reflect what `/artifacts` and `/ledger` currently do (interim, pre-fix)

**Status:** ⬜ OPEN — verified 2026-08-05 (`/ledger` and `/artifacts` are still listed in `STUB_PORTAL_PATH_PREFIXES` in `clients/portal/src/lib/portal-routes.ts` — lines 22 and 24 — and hard-redirect to `/unavailable`, so the copy-vs-product mismatch condition persists; the copy itself lives outside this repo and could not be re-verified here).

**Source:** `features/15-artifacts-behavior-record.md` — portal wiring gap section (implied by "product copy already existing" for a stubbed route).

**Description:** Since product copy already references Artifacts/Ledger as real features while the actual routes are dead stubs, there's an interim honesty/expectation-setting action distinct from the engineering fix: either temporarily adjust copy to not overclaim UI availability, or fast-track un-stubbing `/artifacts`/`/ledger` specifically because customer-facing copy is currently ahead of the shipped product.

**Why it matters:** Customer-facing copy describing a feature that, when clicked, redirects to an unrelated queue view is a direct, visible broken-promise moment for any customer who goes looking for it based on the copy — a credibility risk independent of the underlying engineering timeline.

**Severity:** High
**Effort:** Small
**Confidence:** Medium — the underlying fact (copy exists, routes are stubs) is High confidence per the source; the specific recommended interim copy action is an inferred mitigation, not explicitly instructed in the source.
**Quick win.**

**Files touched:** `customer-facing product copy / marketing material (Artifacts, Ledger)`, `clients/portal/src/lib/portal-routes.ts (STUB_PORTAL_PATH_PREFIXES)`

---

### FEAT-88 — Ship a minimal red-team UI (list probes, run scan, view findings) and stop citing red-team probing as portal-reachable until it does

**Status:** ⬜ OPEN — verified 2026-08-05 (`/redteam` still in `STUB_PORTAL_PATH_PREFIXES` at `portal-routes.ts:13`; `guardrails-url.ts` still normalizes `tab=redteam` away to `policies` — "Illegal `redteam` (and unknowns) map to default policies"; `redteamApi` is still defined and exported in `resources.ts` with zero `.tsx` component consumers).

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "Topics, drift, and red-team probes have no portal surface at all" bullet — kept as a distinct final entry from the paired Topics/Drift findings in the same source point per explicit review instruction not to over-merge — **+** `07-security-compliance.md`, §5e item 6, §6, §8 "Ship the cheapest UI win" (citing `redteam/probes.py`, 699 lines; `api/routes/redteam.py:127-206`; `app.py`; `portal-routes.ts:13`; `guardrails-url.ts:3,70,100`; `resources.ts (redteamApi)`).

**Description:** `src/eden/redteam/probes.py` is a fully built, tested, API-live adversarial red-team subsystem — 12 named probes (jailbreak/prompt-injection/PII-leak/excessive-agency), SSRF-hardened target-endpoint validation, four mounted routes, a dedicated findings table, and two dedicated test files — but has no corresponding route anywhere under `clients/portal/src/app/(portal)/`. The portal's `/redteam` path is explicitly listed in `STUB_PORTAL_PATH_PREFIXES` and gets hard-redirected to `/unavailable`; a legacy `tab=redteam` query param under the Guardrails hub is silently normalized away to `policies` with no explanation. `redteamApi` exists in `resources.ts` with three real client methods and zero component consumers. Fix: build a list-probes + run-scan + view-findings screen under the existing Guardrails hub (where the URL grammar already has a home for it) — called "the strongest 'backend built, unreachable in product' case" and the cheapest UI win in the entire security/compliance area, requiring no further backend work; until it ships, don't cite red-team probing as a portal-reachable capability against named competitors (e.g. Patronus AI's Percival).

**Why it matters:** A security engineer wanting to red-team their own agent today has to read the FastAPI route file to discover the capability exists at all — a real, API-live, differentiated capability that's completely unreachable by the target engineer persona regardless of backend maturity.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `src/eden/redteam/probes.py`, `api/routes/redteam.py`, `clients/portal/src/lib/portal-routes.ts`, `guardrails-url.ts`, `resources.ts (redteamApi)`, `new portal route under Guardrails hub`

---

### FEAT-89 — Ship a portal route/tab for drift detection (PSI-based output/embedding drift) — currently zero portal surface

**Status:** ⬜ OPEN — verified 2026-08-05 (no `/drift` page and no drift surface anywhere under `clients/portal/src/app/(portal)/` — the only "drift" match is a comment about a legacy `/agents/:id/drift` redirect in `agents/[id]/page.tsx`; no `driftApi` client exists. Note: the suggested landing spot is now even more concrete — the `/signals` automations tab shipped in commit 953286b7 as `app/(portal)/signals/automations-panel.tsx`.)

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "Topics, drift, and red-team probes have no portal surface at all" bullet; "Deep codebase re-pass" section for the underlying backend description (citing `predictive/drift.py`) — kept as a standalone final entry from the same source point (01-4) that also covers Topics and Red-team probes, per explicit review instruction not to over-merge; see the paired Topics (#90) and Red-team (#88) entries for the sibling capabilities from this same source point.

**Description:** `predictive/drift.py` — a real backend capability performing PSI-based output/embedding drift detection — has no corresponding route anywhere under `clients/portal/src/app/(portal)/`. No `/drift` page exists, and "drift" doesn't appear inside `/issues`, `/signals`, or `/traces` either. Fix: add a dedicated route, or at minimum a new tab inside `/signals` (which already hosts the automations panel for detector/automation config).

**Why it matters:** Drift detection claims explicit "Phoenix/Datadog parity" as a real, API-live, differentiated capability, but is completely unreachable by the target engineer persona today regardless of backend maturity — it cannot be adopted, demoed, or credited in competitive positioning if a prospect can't click into it.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `predictive/drift.py`, `new /drift route or tab inside clients/portal/src/app/(portal)/signals (automations-panel.tsx)`

---

### FEAT-90 — Ship a portal UI for Topics/pattern clustering (F65) — a fully-built backend capability with zero portal surface

**Status:** ⬜ OPEN — verified 2026-08-05 (no `/topics` page and zero "topics" matches anywhere under `clients/portal/src/app/(portal)/`; no `topicsApi` client exists in the portal API layer).

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "Topics, drift, and red-team probes have no portal surface at all" bullet (citing `topics/service.py`) — kept as a standalone final entry from the same source point covering Drift (#89) and Red-team (#88), per explicit review instruction not to over-merge **+** `features/14-user-request-mining.md` — User Experience & Value section, `src/eden/topics/` + `patterns_clusterer.py` (F65) — two review docs independently identify the same fully-built, UI-less Topics/clustering capability from a competitive-parity angle and a market-category angle respectively; merged into one entry.

**Description:** eden already has a real, working backend feature (F65) — `topics/service.py` combined with `src/eden/observability/patterns_clusterer.py` — that performs HDBSCAN-based trace clustering, functionally eden's own analog to the "user request mining" competitor category (Langfuse/Arize/Helicone/LangSmith all ship variants). It has zero portal UI; it can only be accessed some other way (API/script), not through the product — no `/topics` page exists, and "topics" doesn't appear inside `/issues`, `/signals`, or `/traces`. Fix: build a portal view surfacing discovered topic clusters, or at minimum a new tab inside `/signals`.

**Why it matters:** eden has already done the hard engineering work (HDBSCAN clustering) that competitors charge for as a distinct feature category, but customers cannot actually use it because there's no way to see it in the product — a pure UI-wiring gap sitting on top of otherwise-complete, differentiated functionality; it cannot be adopted, demoed, or credited in competitive positioning if a prospect can't click into it.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `topics/service.py`, `src/eden/observability/patterns_clusterer.py`, `new /topics route or tab inside clients/portal/src/app/(portal)/signals`

---

### FEAT-91 — Render fork lineage as a tree, not a flat list

**Status:** ⬜ OPEN — verified 2026-08-05 (`forksQuery` at `clients/portal/src/lab/debugger/debugger-modes.tsx:750` still renders a flat list — zero `parent_fork_id` references in the component — while the API client still types `parent_fork_id` on both endpoints at `resources.ts:3030` and `:3114`, so the lineage data remains available and unrendered).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (the only consumers of `GitHubOAuthClient.create_check_run` (`oauth.py:558`) / `create_pr_comment` (`oauth.py:581`) are `change_impact/preview.py` and the newer `evaluation/ci_eval_commit_status.py` (F56 CI evals) — `evolve_from_issue` (`src/eden/agents/evolution/components.py:674`) still contains zero GitHub references, and the `patchBlockedReason`/`patchBlockedMessage` fields at `lab/fixtures/issues.ts:34-35` remain an unpopulated frontend contract).

**Source:** `01-competitor-matrix.md`, "User Experience & Value" section, "Issue fix-PR UX is half-built, not missing" bullet (citing `lab/fixtures/issues.ts:34-35`, `integrations/github/oauth.py:558,581`); reinforced by the "Verdicts" section's "Issue lifecycle... RESCOPE" entry.

**Description:** The frontend's `IssueFixture` type already has a `patchBlockedReason`/`patchBlockedMessage` contract, presuming a working "attempt a fix PR, report why not" flow. But `IssuePromptEvolver.evolve_from_issue` only creates an internal prompt-version candidate — it never calls GitHub. Meanwhile `change_impact/preview.py` already has a working GitHub write client (`GitHubOAuthClient.create_check_run`/`.create_pr_comment`) used for pre-merge impact previews (and since commit cdccb59f, `evaluation/ci_eval_commit_status.py` reuses the same client for CI eval statuses — further proof the write path works). Fix: wire that same GitHub client into the post-resolution issue fix-PR path so `/issues` can actually open a fix PR (or accurately report why it can't), populating the UI slot the frontend is already scaffolded for.

**Why it matters:** Every issue today effectively surfaces an unpopulated "blocked" state rather than a real success/failure signal, even though the underlying GitHub write infrastructure exists and works elsewhere in the product — characterized as "a wiring task, not a design task," making it a comparatively cheap fix for a highly visible gap in the failure-triage flow.

**Severity:** High
**Effort:** Small
**Confidence:** High
**Quick win.**

**Files touched:** `lab/fixtures/issues.ts (IssueFixture)`, `integrations/github/oauth.py (GitHubOAuthClient.create_check_run, create_pr_comment)`, `change_impact/preview.py`, `agents/evolution/components.py (evolve_from_issue)`

---

## Medium band (Waves 7–11)

---

## Wave 7

**19 points** (5 bugs, 12 optimizations, 2 features) — severity mix: 2 High, 17 Medium. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 6 or earlier.
**Status as of 2026-08-05:** 19 remaining (2 partial, 17 open).

### BUG-13 — Validate `agent_id` on stumbles/issues against a real identity system

**Status:** ⬜ OPEN — verified 2026-08-05 (all four cited call sites re-verified at the same lines; zero grep hits for `_PREFERRED_AGENT_ID_SQL`/normalization/`agent_registrations` in either file)

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
**Depends on:** BUG-6

---

### BUG-18 — Fix or caveat the public doc instructing users to call a dead `/mcp/keys` endpoint

**Status:** ⬜ OPEN — verified 2026-08-05 (`docs/docs/how-to/mcp-cursor.md:149` still instructs `POST /orgs/{org}/mcp/keys`; the current uncommitted working-tree edit only removes `unlisted: true` from the frontmatter, not the dead instruction)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (re-ran all three suites fresh today: exactly 6 failed / 15 passed; `docs/ops/migration-matrix.md` still has zero rows matching any of the 4 named revisions)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`tools.py:340` still posts to `f"/orgs/{org_id}/alerts/nl/preview"`; repo-wide grep of `src/eden/` outside `mcp_server/` finds zero routes matching `nl/preview`)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (9 raw `client.get(`/`client.post(` duck-typed call sites remain in `tools.py` today; commit `64233475` grew the Protocol with new typed methods — e.g. `list_checkpoints`, `rerun_debugger` — but did not retire the untyped call sites)

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

**Status:** 🟡 PARTIAL — the adjacent contextvars-drop bug is fixed; `org_id`/`feature` are still not threaded through `route`/`aroute`.

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`_TRIAGE_COST_ESTIMATE_USD = 0.02` still at `issues/triage_agent.py:36`; `triage()` still debits it at `:312` via `_debit_budget` (`:488`) → `autonomy_policy.record_spend` (`:496-498`); no `cost_context` anywhere in `triage_agent.py`)

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
**Depends on:** OPT-17

---

### OPT-20 — Batch/parallelize `investigate_trace`'s serial, unbatched per-signal write loop

**Status:** ⬜ OPEN — verified 2026-08-05 (`investigate_trace` at `investigator.py:186`; the loop's three branches still `await _write_event(...)` one row at a time at `:264/:284/:301` and still `await cluster_after_match(...)` inline at `:275/:295/:312`; zero `gather`/`bounded_gather` in the file)

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
**Depends on:** OPT-2

---

### OPT-23 — Strip unused body/reasoning fields from the trace-tree API response on the cheap path

**Status:** ⬜ OPEN — verified 2026-08-05 (node dict built at `telemetry_collector.py:2053-2081` still unconditionally emits all five fields; on `hydrate_bodies=False` the bodies fall back to inline JSONB previews and `reasoning`/`tool_calls_full`/`tool_results` fall through to raw row values — none are omitted)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/services/soft_issue_review.py:75` still iterates `for org_id in org_ids:` strictly sequentially; no `gather`/`bounded_gather` in the file)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/insights/drift_baseline_worker.py:38` still runs the sequential `for dim in DRIFT_DIMENSIONS:` inner loop; no batching or concurrency in the file)

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
**Depends on:** OPT-3

---

### OPT-26 — Fix shadow-detector creation/promotion throughput mismatch (unbounded backlog growth)

**Status:** ⬜ OPEN — verified 2026-08-05 (`promote_shadow_detectors` — which lives at `src/eden/services/soft_issue_review.py:380`, not a standalone module — still scans `ORDER BY created_at ASC LIMIT 200` globally at `:408-409`)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`run_if_leader` still at `workers/leader.py:210`; zero grep hits for any coverage-style metric — "distinct orgs curated" or similar — anywhere under `src/eden/workers/`)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`RetentionPolicy("audit_logs", 7, 90, 2555, 2555)` still at `src/eden/data_platform/retention.py:56`; zero grep hits for `agent_audit_ledger` in `retention.py`/`retention_cron.py`)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`get_storage_summary()` at `storage_lifecycle.py:525` still loops over exactly `["usage_events", "silver_events", "quarantine_events"]` with `SELECT COUNT(*)` row counts only — no byte-size or $/GB tracking anywhere)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`list_signal_clusters` at `api/routes/signal_investigator.py:98` still has hardcoded `LIMIT 200` at `:124` and no `offset`/cursor query parameter)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`cache_reads=getattr(response.usage, "cache_reads", 0)` and the `cache_writes` twin still present in the `UsageStats(...)` construction in `llm/client.py` — the original `:634-635` cite has drifted a few lines; anchor on the `UsageStats(` construction after the `chat.completions.create` call)

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

### FEAT-56 — Provide exact migration SQL to consolidate/backfill session tables

**Status:** ⬜ OPEN — verified 2026-08-05 (no `143_*` migration exists — `142_session_summaries.py` is still the highest-numbered file — and `analytics/cohorts.py` still queries `FROM jobs` at both cited query sites). Description below corrected: the source doc's ready-made SQL is an **index migration + query repoint**, not a three-table backfill/consolidation.

**Source:** `features/11-session-analytics.md` — "Precise migration + repoint diff (this pass)" section (exact SQL provided in source).

**Description:** The source doc provides two exact, ready-to-review diffs (a narrower scope than
the "backfill and reconcile the three tables" framing this point originally carried — the full
three-table consolidation design remains #57's Large-effort work):

1. **New migration `143_session_summaries_user_index.py`** (down_revision
   `142_session_summaries`), exact SQL:
   `CREATE INDEX IF NOT EXISTS idx_session_summaries_org_user ON session_summaries (org_id, user_id, session_start DESC)`
   (downgrade: `DROP INDEX IF EXISTS idx_session_summaries_org_user`). Column order deliberately
   mirrors the existing `idx_session_summaries_org_agent_start` shape (tenant column first, join
   key second, time DESC third) so both the per-user `cohort_retention()` scan and a future
   "sessions for user X, most recent first" query hit the same index. B-tree indexes handle NULL
   `user_id` fine, so no backfill or constraint change is required.
2. **Repoint `cohort_retention()` in `analytics/cohorts.py`** — two queries currently against
   `jobs` (verified still true today at `cohorts.py:75` and `:124`): swap
   `FROM jobs` → `FROM session_summaries`, `created_at` → `session_start`, in both
   `_cohorts_postgres()` and `cohort_retention()`'s bulk activity query;
   `count(DISTINCT user_id)` is unchanged (identical column name in both tables — a swap, not a
   rewrite). `_cohorts_clickhouse()` needs no change (different, correctly-named `user_activity`
   table; silently falls back to Postgres).

**Numbering caveat:** two distinct `135_*` migration files already exist in
`src/eden/db_migrations/versions/` (an undetected collision), and #98's source doc *also*
proposes a `143_*` migration — verify/assign the next free number by hand and coordinate with
FEAT-98 before landing.

**Why it matters:** Having ready-made migration SQL substantially lowers the effort bar for the broader consolidation — the hard design work is already done, just needs review and execution.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `src/eden/db_migrations/versions/143_session_summaries_user_index.py` (new), `src/eden/analytics/cohorts.py`, `session_summaries table`

---

### FEAT-63 — Swimlane the trace transcript UI by agent identity

**Status:** 🟡 PARTIAL — parallel-lane rendering shipped on the frontend; the `agentId` contract/backend plumbing is still missing.

**Source:** `05-multiagent-tracing.md`, "What it should look like" (citing `TranscriptStep`, `_tree_node_to_step`, `portal_contracts.py:78-97`).

**Already landed:** Transcript v2 (commit `c9c49f13`) shipped parallel-lane rendering, and the transcript row builder (`clients/portal/src/lib/observability/build-transcript-rows.ts:173`) already maps `agent_id` from tree nodes into each row.

**Remaining work (verified today):** `TranscriptStep` (`portal_contracts.py:78`) has no `agentId` field, `_tree_node_to_step` (`portal.py:637`) doesn't populate one, and the `/tree` node dict built in `telemetry_collector.py` doesn't emit `agent_id` — so the value the frontend reads is always null until #61 lands, and lanes are grouped by concurrency fan-out, not agent identity. Add `agentId` to the `TranscriptStep` contract, populate it in `_tree_node_to_step` (reading `node.get("agent_id")`, available once #61 lands), and group/color the existing lanes by that field in the frontend (`traces-client.tsx`/`traces-detail-panels.tsx`, plus the shared `build-transcript-rows.ts` builder that already carries `agent_id` per row). No new backend computation required beyond #61.

**Why it matters:** Today a trace spanning three agents shows a single collapsed "preferred" agent label in the trace list, and once opened that label disappears entirely — every span in the transcript looks identical in origin. The only current workaround is noticing discontinuities in model/provider naming, or bypassing the portal to query `telemetry_events.agent_id` directly.

**Severity:** High
**Effort:** Small (reduced from Medium — the lane-rendering frontend and the row-builder `agent_id` mapping already landed; remaining is the `TranscriptStep`/`_tree_node_to_step`/`telemetry_collector.py` plumbing plus lane grouping by the field)
**Confidence:** High

**Files touched:** `TranscriptStep contract (portal_contracts.py)`, `_tree_node_to_step`, `traces-client.tsx`, `traces-detail-panels.tsx`, `clients/portal/src/lib/observability/build-transcript-rows.ts`
**Depends on:** FEAT-61

---

## Wave 8

**20 points** (2 bugs, 4 optimizations, 14 features) — severity mix: 2 High, 18 Medium. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 7 or earlier.
**Status as of 2026-08-05:** 20 remaining (0 partial, 20 open).

### BUG-14 — Clear `resolved_at` when an issue is reopened

**Status:** ⬜ OPEN — verified 2026-08-05 (`set_status` at `repo.py:308` still builds `", resolved_at = NOW()" if set_resolved_at else ""` at `:319` — no `NULL`-clearing branch on reopen)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`tool_call_labels.py` still persists `body.agent_id` directly and feeds it to `should_train`/`train_and_persist` with no ownership cross-check; `tool_call_label_learning_v1: bool = True` confirmed at `config.py:1228`)

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
**Depends on:** BUG-6, BUG-13

---

### OPT-21 — Parallelize the stumble-write round-trip chain

**Status:** ⬜ OPEN — verified 2026-08-05 (the per-matched-row chain is still awaited sequentially inside `investigate_trace`'s loop; zero `gather`/`bounded_gather` anywhere in `signals/investigator.py`)

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

### OPT-30 — Add a new retention policy + dispatch branch for `trace_replay_sessions`

**Status:** ⬜ OPEN — verified 2026-08-05 (zero grep hits for `trace_replay_sessions` in `data_platform/retention.py`/`retention_cron.py`; `intelligence_gap_v0: bool = True` confirmed at `config.py:225`)

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

### OPT-37 — Add age-based expiry for stale non-firing shadow detectors

**Status:** ⬜ OPEN — verified 2026-08-05 (`evaluate_shadow_precision` in `src/eden/services/soft_issue_review.py` still returns `action = "hold"` for any row below `min_firings` with no age check; the only `DELETE FROM nl_signals` is the low-precision "delete" decision, not an age-based expiry)

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

### OPT-38 — Add a CI lint rule to catch `LIMIT` without `ORDER BY` going forward

**Status:** ⬜ OPEN — verified 2026-08-05 (`scripts/lint_unordered_limit.py` does not exist; no such rule referenced in `.pre-commit-config.yaml` or `.github/workflows/`)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (all three tables remain live and disconnected: `user_sessions`, `session_summaries` — added by N12 migration 142 with its own rollup in `sessions/rollup.py` — and `agent_sessions` with its own ingest route; `analytics/cohorts.py` still computes retention from a fourth source, `jobs`)

**Source:** `features/11-session-analytics.md` — session data model section (`user_sessions`, `session_summaries`, `agent_sessions`).

**Description:** eden currently has three separate, disconnected tables all representing "sessions" in some form: `user_sessions`, `session_summaries`, and `agent_sessions`. They are not joined or reconciled with each other, meaning different parts of the product report different, potentially contradictory session data depending on which table they query. Fix: define a single canonical session representation (or explicit, documented relationships/foreign keys between the three) and migrate consumers onto it — #56's ready-made SQL (the `session_summaries` user index + `cohorts.py` repoint) covers the first consumer migration, but note it is narrower than a full three-table consolidation, which still needs its own design.

**Why it matters:** Fragmented session data undermines trust in any session-based metric eden reports (retention, engagement, session counts) since the "truth" depends on which internal table happened to be queried — a customer-facing credibility risk if surfaced inconsistently.

**Severity:** High
**Effort:** Large
**Confidence:** High

**Files touched:** `user_sessions table`, `session_summaries table`, `agent_sessions table`
**Depends on:** FEAT-56

---

### FEAT-64 — Surface the `a2a` sub-document as a labeled "handoff" transcript marker instead of silently stripping it

**Status:** ⬜ OPEN — verified 2026-08-05 (the scalar-only filter `safe_attrs = {k: v for k, v in attrs.items() if isinstance(v, (str, int, float, bool))}` is still in `_tree_node_to_step` at `portal.py:~752`, and `TranscriptKind` is still `Literal["task", "llm", "tool", "bash", "span"]` — no `"handoff"`)

**Source:** `05-multiagent-tracing.md` (citing `portal.py:752`; `sdk/a2a.py:114-129`).

**Description:** When a caller uses the A2A SDK wrapper, `_A2ACallCtx.attributes()` merges `{"parent_agent_span_id", "child_agent_trace_id", "a2a": {"invocation_type", "parent_agent_id", "child_agent_id", "response_status"}}` into a span's JSONB `attributes`. But `_tree_node_to_step` builds the outgoing `attributes` field via a scalar-only filter (`isinstance(v, (str, int, float, bool))`) that silently drops the nested `"a2a"` sub-document — the one part of the payload with human-readable agent IDs and an explicit invocation type. Only two unlabeled flat UUID strings survive, rendered as raw JSON with no click-through. Fix: surface the `a2a` sub-document as a distinct, labeled `"handoff"` `TranscriptKind` instead of letting it be erased by the scalar-only filter.

**Why it matters:** Real, already-computed agent-linkage data (human-readable agent ids, invocation type, response status) is actively discarded before reaching the browser — the engineer currently sees two unlabeled UUIDs in a raw JSON blob instead of a clickable, labeled handoff event.

**Severity:** High
**Effort:** Medium
**Confidence:** High

**Files touched:** `portal.py`, `sdk/a2a.py (_A2ACallCtx.attributes)`, `_tree_node_to_step`

---

### FEAT-93 — Fix the `act_on_topic(action="alert")` no-op stub

**Status:** ⬜ OPEN — verified 2026-08-05 (`topics/service.py:230-231` still reads `if action != "dataset": return {"action": action, "topic_id": topic_id, "status": "queued"}` — reports success, does nothing)

**Source:** `01-competitor-matrix.md`, "Deep codebase re-pass" section (citing `service.py:230-231`).

**Description:** `topics/service.py`'s `act_on_topic` function has an `action="dataset"` branch that genuinely works (creates a dataset from a topic's representative traces via `DatasetHub`), but the `action="alert"` branch is a stub that returns `{"status": "queued"}` without doing anything. **Fix:** implement the alert-firing behavior, or remove the option from any UI that will eventually expose it, so the action doesn't silently do nothing while reporting success.

**Why it matters:** A user who selects "create alert from this topic" (once a portal surface exists per 01-4) would be told the alert was queued when nothing was actually created — a silent-failure pattern that erodes trust the moment the feature becomes reachable.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `topics/service.py`

---

### FEAT-94 — Frame GitHub write capability accurately: "wired to pre-merge preview, not to post-resolution fix delivery"

**Status:** ⬜ OPEN — verified 2026-08-05 (both cited files exist and unchanged in role: `integrations/github/oauth.py` + `change_impact/preview.py`; the recent autonomy/auto-merge commit series targets Eden's own improvement loop, not customer-repo fix-PR delivery, so the framing correction still applies)

**Source:** `01-competitor-matrix.md`, "Verdicts" section, "Issue lifecycle... RESCOPE, sharpened" entry.

**Description:** Prior-pass framing that eden is "GitHub-blind" is corrected — `integrations/github/oauth.py` has working Check-Run/PR-comment methods, used by `change_impact/preview.py`. But the issue-resolution path specifically still does not open a fix PR (see #92). **Fix:** use the doc's recommended framing in any strategic/competitive material — "eden has GitHub write infrastructure; it is wired to pre-merge impact preview today, not to post-resolution fix delivery" — rather than either "GitHub-blind" or an unqualified "auto-fix PR" claim.

**Why it matters:** Both the overclaim and underclaim versions of this story are inaccurate; getting the framing right avoids both underselling a real capability and overselling one that doesn't exist yet for the issue-resolution use case specifically.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `integrations/github/oauth.py`, `change_impact/preview.py`
**Depends on:** FEAT-92

---

### FEAT-95 — Cite Topics/drift/per-step-judges as "shipped, narrower than the named competitor feature," not flat differentiators

**Status:** ⬜ OPEN — verified 2026-08-05 (`apm_depth/step_judges.py`'s module docstring still self-describes "The v0 ship is **stamping only** — the actual per-step judge_runner wiring is the v0.1 follow-up"; maturity-gap framing still accurate)

**Source:** `01-competitor-matrix.md`, "Verdicts" section, "New rows this pass... VERDICT: ADD, mixed maturity" entry.

**Description:** Three newly-found capabilities each carry a self-admitted maturity gap versus the competitor they're being compared to: Topics is thinner than Braintrust's Topics (derived from existing pattern-clustering rather than an independent per-trace LLM classification pass); drift detection uses a hash-bucket proxy instead of a learned embedding model for the embedding-drift axis (self-admitted in the module docstring); per-step judges (`apm_depth/step_judges.py`) is "stamping only" — the automatic per-step `JudgeRunner` scoring loop that would populate scores is an unbuilt follow-up. **Fix:** use the doc's recommended framing — "shipped, narrower than the named competitor feature" — for these three specifically, rather than listing them as unqualified differentiators in the matrix or in sales material.

**Why it matters:** Prevents overclaiming parity with Braintrust/Phoenix/Datadog/HoneyHive on capabilities that are real but materially incomplete versus the named comparison — protects credibility if a prospect or competitor does a detailed technical comparison.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `apm_depth/step_judges.py`

---

### FEAT-96 — Extend `ReplayResult` to carry the actual regenerated output text

**Status:** ⬜ OPEN — verified 2026-08-05 (`ReplayResult` at `improvement/replay_verify.py:275-282` has `status`/`reason`/`cost_usd`/`traces_checked` plus a generic `details: dict` — still no dedicated `regenerated_output` field)

**Source:** `02-evals-datasets.md`, §5 P1 item 8 (citing `improvement/replay_verify.py:275-281`; `regression_runner.py:257-280,296-340,282-294`).

**Description:** When `regression_replay_v1` is enabled and a case carries a stored `FailureSignature` + checkpoint reference, `RegressionRunner` replays the original failing step against current behavior (cost-capped) before falling back to a post-hoc check — real, budget-capped verification infrastructure. But `ReplayResult` returns only `status: "passed"|"failed"|"skipped"` + `reason` + `cost_usd` + `traces_checked` (plus an untyped `details` dict) — no raw regenerated output text. **Fix:** add a `regenerated_output: str | None` field to `ReplayResult`.

**Why it matters:** Without this field, the replay path cannot feed `playground/scorers.py`'s `run_scorers(output=...)`, meaning the replay-verification subsystem can't participate in #130's unified per-case scoring — a small, sequenced prerequisite.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `improvement/replay_verify.py`, `regression_runner.py`

---

### FEAT-97 — Delete `golden_dataset.py`, `ci_pipeline.py`, and `auto_dataset.py`/`EvalScheduler` as dead/duplicate code

**Status:** ⬜ OPEN — verified 2026-08-05 (all four files still present: `src/eden/evaluation/golden_dataset.py`, `ci_pipeline.py`, `auto_dataset.py`, `scheduler.py`)

**Source:** `02-evals-datasets.md`, §5 P2 item 10, §3d/3e/3f (citing `golden_dataset.py` 1,295 lines; `ci_pipeline.py`; `auto_dataset.py` 475 lines + `evaluation/scheduler.py`).

**Description:** Three subsystems are confirmed dead or duplicate: (a) `golden_dataset.py` — a disk-based (`./golden_datasets/*.json`), non-multitenant, hardcoded 50-case registry referencing no real customer agent/trace/org; (b) `ci_pipeline.py` — a 6-stage pipeline that shells out via `subprocess`, not mounted to any route, referenced only by its own unit test, and duplicates `ci_webhook.py`'s live path with a fake `benchmark_regression` stage that defaults to `SKIPPED: execution_unavailable` with a `random.Random(case_id)`-seeded fallback; (c) `auto_dataset.py` + `EvalScheduler` — a real multi-factor quality-scoring design that persists to local disk JSON and writes into `golden_dataset.py`'s in-memory registry rather than Postgres, and is never actually invoked on a schedule (absent from both `workers/main.py` and `workers/cron_tick.py`). **Fix:** if the 50 generic RL-sandbox cases in `golden_dataset.py` have standalone smoke-test value, port `_CANONICAL_CASES` into a handful of seed `dataset_items` rows via a one-time script, then delete all three modules.

**Why it matters:** Every week this dead code remains in the tree is a week a due-diligence reviewer (fundraising, acquisition, audit) can mistake it for real functionality — the doc explicitly flags this as a liability, not neutral dead weight, and recommends not deprioritizing it despite low direct user impact.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `golden_dataset.py`, `ci_pipeline.py`, `auto_dataset.py`, `evaluation/scheduler.py`, `ci_webhook.py`

---

### FEAT-98 — Add an index + bounded backfill migration for the new agent-linkage columns

**Status:** ⬜ OPEN — verified 2026-08-05 (no `idx_telemetry_events_tenant_operation_name_agent` index exists in any migration — 067's existing partial index covers only `(tenant_id, operation_name)`; the `135_*` numbering collision is confirmed real: exactly two `135_*` files exist in `src/eden/db_migrations/versions/`; latest migration is `142_session_summaries.py`)

**Source:** `05-multiagent-tracing.md` (proposing migration `143_agent_link_columns_backfill.py`).

**Description:** No new `ALTER TABLE` is needed (058/067 already added the columns) — only indexing/backfill. Add `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_telemetry_events_tenant_operation_name_agent ON telemetry_events (tenant_id, operation_name, agent_id) WHERE operation_name IN ('invoke_agent','create_agent')` to support "list agent-invocation spans for tenant X" queries the new portal panel needs, plus a bounded backfill (`UPDATE ... SET operation_name = 'unknown' WHERE operation_name IS NULL AND created_at > now() - interval '30 days' AND event_type = 'tool.call'`). Downgrade must drop only the new index — must NOT touch `finish_reason` (see #99). Note: verify the next migration number by hand since the doc flags an existing undetected numbering collision (two distinct `135_*` files, confirmed) — and #56's source doc *also* claims number `143` for its `session_summaries` index migration, so the two must be sequenced/renumbered together.

**Why it matters:** Without the index, the new "list agent-invocation spans" query pattern would be slow/unindexed; the backfill gives recently-ingested rows a non-null default before the write-path fix takes effect going forward.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/db_migrations/versions/143_agent_link_columns_backfill.py` (new; renumber as needed), `telemetry_events`
**Depends on:** FEAT-23, FEAT-24

---

### FEAT-99 — Fix migration 067's `downgrade()` incorrectly dropping the pre-existing `finish_reason` column

**Status:** ⬜ OPEN — verified 2026-08-05 (`067_trace_quality_otel_columns.py:93` still has the no-op `ADD COLUMN IF NOT EXISTS finish_reason VARCHAR(32)` and `:140` still runs `ALTER TABLE telemetry_events DROP COLUMN IF EXISTS finish_reason` in `downgrade()`)

**Source:** `05-multiagent-tracing.md` (citing `067_trace_quality_otel_columns.py:140,93`; `011_capture_full_payloads.py:63`).

**Description:** Migration 067's `downgrade()` runs `DROP COLUMN IF EXISTS finish_reason` — but `finish_reason` wasn't added by 067; it was added earlier by migration 011 (`VARCHAR(64)`) and is already actively written by `TELEMETRY_INSERT_SQL`. 067's own `ADD COLUMN IF NOT EXISTS finish_reason VARCHAR(32)` was a silent no-op against the pre-existing column. **Fix:** remove the `DROP COLUMN IF EXISTS finish_reason` line from 067's `downgrade()`.

**Why it matters:** A downgrade of migration 067 today would destroy live `finish_reason` data that 067 never owned — a real data-loss risk on any future rollback, currently undetected because no one has run the downgrade.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `067_trace_quality_otel_columns.py`, `011_capture_full_payloads.py`

---

### FEAT-101 — Populate `fingerprint`/`issue_id` on EQL-triage alert payloads to enable duplicate suppression

**Status:** ⬜ OPEN — verified 2026-08-05 (zero grep hits for `fingerprint`/`issue_id` anywhere in `dsl/alerts.py`; `AlertTriageJudge._find_duplicate_issue` — `alerts/triage_judge.py:76` — still bails at `:84-85` when `payload.get("fingerprint")` is empty)

**Source:** `04-alerting-oncall.md`, §0.5 bullet 3, "Noise control" (citing `dsl/alerts.py::_trigger_triage`; `triage_judge.py:76-104`).

**Description:** `_trigger_triage`'s payload never sets `fingerprint` or `issue_id`, so `AlertTriageJudge._find_duplicate_issue` — keyed on exactly those fields — can structurally never return a match for an EQL-sourced alert. Every re-fire of the same still-broken metric is a fresh `real_incident` email, rate-limited only by a blunt Redis SETNX + hourly cap, not by "is this the same incident as an hour ago." **Fix:** populate `fingerprint`/`issue_id` on the triage payload.

**Why it matters:** Without this, the one working alert pipeline will spam admins with a fresh email on every tick a still-broken condition is evaluated — a direct driver of alert fatigue and distrust.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `dsl/alerts.py`, `triage_judge.py`

---

### FEAT-104 — Rename "escalate"/"page operator" copy that overstates real behavior

**Status:** ⬜ OPEN — verified 2026-08-05 (`"fleet_slo_breach": ("escalate", "Fleet SLO breach — page operator")` still at `src/eden/closed_loop/playbook_router.py:58`)

**Source:** `04-alerting-oncall.md`, §4 (citing `_PLAYBOOK_ACTIONS` in `closed_loop/playbook_router.py`; UI strings from `realtime/alert_stream.py`'s rule channels).

**Description:** Copy such as "page operator" implies real paging/escalation behavior that doesn't exist. **Fix:** audit and rename this copy to accurately reflect actual behavior (e.g., "notify via Slack/email" rather than "page").

**Why it matters:** Inaccurate internal/UI copy compounds customer-facing trust risk — even engineers reading logs or playbook definitions could be misled about what actually happens on escalation.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/closed_loop/playbook_router.py`, `src/eden/realtime/alert_stream.py`

---

### FEAT-106 — Add a team-scoped soft-alert email recipient list independent of `org_members`

**Status:** ⬜ OPEN — verified 2026-08-05 (`_org_alert_recipients()` at `src/eden/services/alert_email.py:27` still joins on `m.role IN ('owner', 'admin')` at `:41`; no finance/billing/extra-recipient concept anywhere in the file)

**Source:** `06-cost-governance.md`, "Who is the user," §4a Recommendation 2 (citing `services/alert_email.py`'s `_org_alert_recipients()`).

**Description:** Budget alert emails are resolved exclusively via a query joining `users`/`org_members` filtered to `role IN ('owner','admin')` — structurally incapable of routing to anyone not already an org member. There is no "finance," "billing," or "budget admin" role anywhere in the budget path (LiteLLM's team soft-budget alerts explicitly route to "finance or a team lead — not necessarily team members"). **Fix:** add a soft-alert recipient list attachable to a team/org budget, independent of `org_members` role membership, as a small additive change to `_notify_budget_alert()` — doesn't require the full scope migration to land first if sequenced as an org-level feature initially.

**Why it matters:** Eden's implicit persona is a founder/eng-lead who *is* the org owner — reasonable for eden's current size but the opposite of where the competitor set has moved (dedicated finance/FinOps stakeholders watching spend across teams they don't administer).

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/services/alert_email.py`, `org_members`

---

### FEAT-107 — Fix the synthetic $0.02 triage cost event that leaks into customer-facing budget consumption

**Status:** ⬜ OPEN — verified 2026-08-05 (full chain re-verified: `_TRIAGE_COST_ESTIMATE_USD = 0.02` at `issues/triage_agent.py:36` → `_debit_budget` at `:312/:488` → `record_spend()` at `closed_loop/autonomy_policy.py:331` — the cited `:360-376` has drifted — → `record_cost_event()` `INSERT INTO customer_cost_events` at `llmops/cost_ledger.py:279`)

**Source:** `06-cost-governance.md`, §2e (citing `issues/triage_agent.py:36`; `closed_loop/autonomy_policy.py::record_spend`; `llmops/cost_ledger.py:279`).

**Description:** `issues/triage_agent.py`'s call chain (`autonomy_policy.record_spend()` → `record_cost_event()`) unconditionally writes a synthetic, flat `$0.02` `CostEvent` (`_TRIAGE_COST_ESTIMATE_USD`) for every LLM-used triage. This lands in `customer_cost_events`, the same table `_sum_org_cost_usd()` sums into `get_budget_status()` — i.e., the number `QuotaEnforcementMiddleware` reads to block a customer's own gateway requests. **Fix:** replace the flat synthetic estimate with the real cost, or exclude internal triage cost events from the customer-facing aggregation entirely.

**Why it matters:** A concrete, live counter-example to the assumption that eden's internal cost-tracking is fully isolated from customer-facing numbers — nudges the real customer credit-consumption figure upward by the fake-vs-real delta on every triage call. Blast radius is small (well under $1/org/day per estimate) but it's a genuine, live correctness bug in the number that gates a customer's own requests.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `issues/triage_agent.py`, `closed_loop/autonomy_policy.py`, `llmops/cost_ledger.py`, `customer_cost_events`
**Depends on:** FEAT-20

---

### FEAT-108 — Fix or drop the dead Redis RTBF key-pattern match

**Status:** ⬜ OPEN — verified 2026-08-05 (`pattern = f"eden:*:{org_id}:*:{user_id}*"` still at `src/eden/services/governance_intel/rtbf_fanout.py:93`, and `_fanout_redis` (`:77`) still returns `{"store": ..., "status": "ok", "deleted": deleted}` at `:105`; the file's existing `"unsupported"` status is used only for a different store)

**Source:** `07-security-compliance.md`, §2b fanout table, §4 point 4 (citing `rtbf_fanout.py:77-108`).

**Description:** Redis RTBF fanout runs `SCAN eden:*:{org}:*:{user}*` then `DEL`, but no key pattern anywhere in `src/eden/` actually embeds a user id (patterns are org- or hash-keyed only, e.g. `eden:cost:{org}:...`, `eden:dedup:{digest}`). SCAN matches nothing, reports `deleted: 0`, and the fanout falsely reports `status: "ok"`. **Fix:** either update the actual Redis key-naming scheme to embed user id where user-scoped erasure is meaningful, or change the fanout to report `status: "unsupported"`/`"n/a"` honestly rather than a false "ok" — the doc notes actual PII risk here is lower (mostly cost/dedup caches) but the false-positive report itself is still a bug.

**Why it matters:** A false "ok" report undermines the credibility of the entire RTBF fanout's per-store reporting model, even though the underlying data-risk is comparatively low for this specific store — fixing the report contract matters for auditability independent of the low current risk.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/services/governance_intel/rtbf_fanout.py`
**Depends on:** FEAT-2, FEAT-5

---

## Wave 9

**20 points** (0 bugs, 2 optimizations, 18 features) — severity mix: 20 Medium. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 8 or earlier.

**Status as of 2026-08-05:** 20 remaining (2 partial, 18 open).

### OPT-22 — Cap or precompute shared state for uncapped StatGate rule scans

**Status:** ⬜ OPEN — verified 2026-08-05 (`_eval_statgate_rule` in `src/eden/signals/investigator.py` still does uncapped `for e in events` scans in both branches — lines 129 and 142 — while `compress_trace` caps at `events[:80]`).

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

### OPT-31 — Add a new retention policy + dispatch branch for `replay_sessions` (migration 029) — worse growth model than item 30

**Status:** ⬜ OPEN — verified 2026-08-05 (`DEFAULT_POLICIES` in `src/eden/data_platform/retention.py` still lists only 8 policies, none covering `replay_sessions`; `INSERT INTO replay_sessions` at `src/eden/api/routes/intelligence_replay.py:169` still has no `ON CONFLICT` upsert).

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

### FEAT-100 — Add `"agent"`/`"handoff"` kinds to `TranscriptKind` enum and `_step_kind` mapping

**Status:** ⬜ OPEN — verified 2026-08-05 (`portal_contracts.py:21` still reads `TranscriptKind = Literal["task", "llm", "tool", "bash", "span"]`; no `"agent"`/`"handoff"` members).

**Source:** `05-multiagent-tracing.md` (citing `TranscriptKind` in `portal_contracts.py:21`; `_step_kind` in `portal.py:444` — both citations still accurate as of 2026-08-05).

**Description:** `TranscriptKind = Literal["task", "llm", "tool", "bash", "span"]` has no `"agent"` or `"handoff"` kind. Even once `operation_name` is wired end-to-end, an `invoke_agent`-kind span would still render as an undifferentiated generic `"span"` unless this enum and `_step_kind`'s mapping logic are extended.

**Why it matters:** Without a distinct visual/semantic vocabulary for agent boundaries and handoffs, correctly-populated backend data still renders indistinguishably from any other span, defeating the purpose of the upstream write-path fixes.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/api/portal_contracts.py`, `src/eden/api/routes/portal.py`
**Depends on:** FEAT-23

---

### FEAT-105 — Do not build on-call scheduling, rotations, ack/snooze, or SLA-timer features in-house (explicit scope decision)

**Status:** ⬜ OPEN — verified 2026-08-05 (`escalation_delay_seconds: int = 300` still an inert dataclass field at `src/eden/realtime/alert_stream.py:67`, defined but never read; no in-house on-call/rotation code has appeared, and no explicit scope guardrail has been recorded).

**Source:** `04-alerting-oncall.md`, §3 fix item 9, §4, §2 (citing `escalation_delay_seconds`/`auto_escalate` inert dataclass fields in `src/eden/realtime/alert_stream.py`; Better Stack's `wait_before`/`repeat_count`/`step_members` schema as the mature reference).

**Description:** The doc explicitly recommends against building schedules, rotations, acknowledgment/snooze UI, or SLA escalation timers in-house, since incident.io, Better Stack, and Datadog On-Call already own this space with mature primitives eden only has as inert, unused dataclass fields. **Action:** adopt this as an explicit engineering scope guardrail — integrate with a real on-call tool for this functionality rather than building it, and deprioritize any related in-flight or proposed work.

**Why it matters:** Without an explicit scope decision, there's a real risk of eng effort being spent replicating a mature, commoditized on-call feature set instead of on the actual blockers to a working, trustworthy core alerting product.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/realtime/alert_stream.py`

---

### FEAT-109 — Report RTBF fanout status per-store in the UI, not as a single checkmark

**Status:** ⬜ OPEN — verified 2026-08-05 (no RTBF/erasure UI exists anywhere in `clients/portal/src` — zero grep hits for rtbf/erasure/forgotten — so the per-store contract is still unclaimed; blocked behind FEAT-5/FEAT-108 shipping any erasure UI at all).

**Source:** `07-security-compliance.md`, §8 "What would make this trustworthy and usable" bullet 2.

**Description:** `src/eden/services/governance_intel/rtbf_fanout.py`'s existing pattern for Qdrant/S3 (explicit `status: "failed"`/`"unsupported"` rather than silent success) is correct and should become the UI contract too. **Fix:** once a single erasure path ships a UI element, render the actual per-store status list — e.g. "Postgres: erased. Qdrant: failed (no per-user index). Typesense: not yet supported" — rather than a single green checkmark.

**Why it matters:** A single aggregate "success" checkmark for an operation with known partial-failure modes across 6 different stores would be actively misleading to both end users and auditors; per-store honesty is cheap once the fanout already computes this data internally.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/services/governance_intel/rtbf_fanout.py`
**Depends on:** FEAT-5, FEAT-108

---

### FEAT-110 — Surface `AgentAuditLedgerWriter.verify_chain` tamper-evidence as a visible trust signal

**Status:** ⬜ OPEN — verified 2026-08-05 (`verify_chain` is referenced only in `src/eden/governance/compliance_pack.py`, `src/eden/api/routes/compliance_pack.py`, and tests; zero references anywhere in `clients/portal/src` — no portal indicator exists. Note a backend verify endpoint also exists at `src/eden/api/routes/audit.py::verify_audit_chain`, tested in `tests/unit/api/test_audit_tamper.py`, so the UI only needs to call an already-mounted route).

**Source:** `07-security-compliance.md`, §7, §8 "What would make this trustworthy and usable" bullet 4 (citing `governance/compliance_pack.py`; `tests/unit/ws4/test_enterprise_ws4.py:70-124`).

**Description:** `AgentAuditLedgerWriter` maintains an append-only, SHA-256 hash-chained ledger; `verify_chain()` recomputes the chain and reports `ok_rows`/`broken_rows` — genuine tamper-evidence, tested for empty/valid/deliberately-tampered chains. Today it's invisible to any user. **Fix:** surface a "chain verified: ✓" indicator next to any exported compliance pack or audit view in the portal, backed by a live call to `verify_chain()`.

**Why it matters:** This is a genuinely strong, already-built answer to "how do we know this evidence wasn't edited after the fact" — exactly the question a SOC2 auditor or enterprise security reviewer asks — but currently exists only as backend plumbing with zero product-visible trust value.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/governance/compliance_pack.py`

---

### FEAT-112 — Add missing `resources.ts` API bindings (pop, IAA, export)

**Status:** ⬜ OPEN — verified 2026-08-05 (`labelingApi` in `clients/portal/src/lib/api/resources.ts` still binds only items/annotate/skip/queue-management; no binding for `GET /labeling/queue/{user_id}`, org-level `GET /labeling/iia`, or `GET /labeling/export` — only the queue-scoped `/labeling/queues/{queueId}/iaa` binding at resources.ts:4114 exists).

**Source:** `08-annotation-labeling.md`, §2, §6b (citing `resources.ts:3360-3386,4069-4116` — line ranges still accurate: `labelingApi` starts at 3360).

**Description:** `labelingApi` covers only 4 of 8 Phase-D routes. Three routes have no client binding at all: `GET /labeling/queue/{user_id}` (pop), `GET /labeling/iia` (org/global IAA), and `GET /labeling/export`. **Fix:** add `popQueue`, `getIAA` (using the post-consolidation `/labeling/agreement` path — note the backend route is still mounted as `/labeling/iia` today, so bind whatever path the consolidation lands on), and `exportJsonl` functions to `labelingApi`. All three backend routes are confirmed live in `src/eden/api/routes/labeling.py` (`pop_queue` at `/queue/{user_id}` with `limit` 1-50, `/iia`, `/export`).

**Why it matters:** Without these bindings, roughly half the usable Phase-D backend surface is unreachable from the frontend, blocking the pop-based work surface, IAA dashboard, and export button.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `clients/portal/src/lib/api/resources.ts`

---

### FEAT-117 — Add bulk-skip capability to the queue list

**Status:** ⬜ OPEN — verified 2026-08-05 (`skip` is still single-item only: `LabelingService.skip` at `src/eden/evaluation/labeling.py:602` and route handler at `src/eden/api/routes/labeling.py:332`; no `/labeling/skip/bulk` endpoint exists).

**Source:** `08-annotation-labeling.md`, §6c.1(b) (citing `labeling.py:602-632` — still accurate).

**Description:** `skip()` is single-item only today. **Fix:** ship either a small `POST /labeling/skip/bulk` backend endpoint or a client-side fan-out of N `skip()` calls, paired with multi-select in the queue-list UI.

**Why it matters:** A meaningful fraction of any queue is "obviously skip" and doesn't need one-at-a-time handling; without bulk actions this directly hurts the "reviewer never touches the mouse except to read" speed bar the doc sets as the UX target.

**Severity:** Medium.
**Effort:** Small-Medium.
**Confidence:** High.

**Files touched:** `src/eden/evaluation/labeling.py`, `src/eden/api/routes/labeling.py`

---

### FEAT-120 — Document `agent_id`/`agentId` in both SDK READMEs

**Status:** 🟡 PARTIAL — the field appears once in each README; the "what setting it unlocks" documentation is missing.

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`sdk/ts-ai/src/detect-installed.ts:138` still exports `autoInstrument()`, which is a one-line delegation to `detectInstalledFrameworks()` and instruments nothing; no `@deprecated` tag anywhere in the file).

**Source:** `09-sdk-dx.md` — TS auto-instrumentation internals.

**Description:** The TS SDK exposes a function named `autoInstrument()` inside `detect-installed.ts` that is actually detection-only — it does not instrument anything, contrary to what its name promises. Callers reading the API surface will reasonably assume calling it wires up instrumentation, when it doesn't. Note: a correctly-named `detectInstalledFrameworks()` export already exists in the same file (autoInstrument just delegates to it), so the remaining work is only to deprecate/remove the misleading alias or make it actually perform auto-instrumentation. **Fix:** either rename the function to something like `detectInstalledFrameworks()` or `listCandidates()` (the former already exists — deprecate the alias), or make it actually perform auto-instrumentation.

**Why it matters:** Misleadingly-named public API surface causes silent integration failures (users think instrumentation is active when it isn't), producing empty/incomplete trace data downstream with no error signal.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `sdk/ts-ai/src/detect-installed.ts`

---

### FEAT-122 — Wire `droppedTotal`/`sampledOut` into TS `doctor.ts` output

**Status:** ⬜ OPEN — verified 2026-08-05 (`sdk/ts-ai/src/doctor.ts` — 197 lines, `runDoctor()` — contains zero references to `droppedTotal` or `sampledOut`; the counters exist in `sdk/ts-ai/src/client.ts` at :578/:590 but are never surfaced).

**Source:** `09-sdk-dx.md` — TS diagnostics/doctor tooling section.

**Description:** The TS SDK already tracks `droppedTotal` and `sampledOut` counters internally, but `doctor.ts` (the SDK's self-diagnostic CLI/utility) does not read or surface them. A user running the doctor tool to debug "why don't I see my traces" gets no visibility into drop/sampling behavior even though the data already exists in memory.

**Why it matters:** This is a support-cost and self-serve-debugging gap: users hit a wall the doctor tool could resolve for free, and instead file support tickets or churn.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `sdk/ts-ai/src/doctor.ts`

---

### FEAT-125 — Fix the frontend/backend enum mismatch on the guardrails policy-list page

**Status:** ⬜ OPEN — verified 2026-08-05 (frontend `clients/portal/src/lab/fixtures/guardrails.ts` defines `GuardrailKind = "pii" | "toxicity" | "tool_allowlist" | "rate_limit" | "custom"` and `GuardrailStatus = "active" | "shadow" | "disabled"`, while backend `src/eden/guardrails/policy.py` uses policy types like `"pii_redaction"`/`"content_policy"` and has zero occurrences of `"shadow"` — the drift is still live).

**Source:** `12-runtime-guardrails.md` — portal bugs section, enum mismatch.

**Description:** Separately from a related envelope-unwrap bug on the same page, there is also a mismatch between frontend and backend enum values. Concretely: the portal's guardrails page (`clients/portal/src/app/(portal)/guardrails/page.tsx`, filtering on `GuardrailKind`/`GuardrailStatus` from `lab/fixtures/guardrails.ts`) uses kind values `pii|toxicity|tool_allowlist|rate_limit|custom` and status values `active|shadow|disabled`, while the backend (`src/eden/guardrails/policy.py`) persists types such as `pii_redaction` and `content_policy` and only ever writes/filters `status='active'`. This causes incorrect labels, filters, or dropdown options to be shown, or silent failures when the frontend sends a value the backend doesn't recognize. **Fix:** audit both enum definitions and unify them (ideally via a single shared schema/generated types).

**Why it matters:** Enum drift between frontend and backend causes subtle, hard-to-diagnose UI bugs (wrong labels, broken filters, rejected requests) specifically on the page administrators use to manage safety policy.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `clients/portal/src/lab/fixtures/guardrails.ts`, `clients/portal/src/app/(portal)/guardrails/page.tsx`, `src/eden/guardrails/policy.py`

---

### FEAT-126 — Prioritize this doc's fixes ahead of new guardrail feature work

**Status:** ⬜ OPEN — verified 2026-08-05 (the underlying silent safety-check bypass is still live: `install_cat15_trajectory_replaces_intervention` in `src/eden/observability/trace_quality/wiring.py` still replaces `InterventionEngine.evaluate_and_act` with a wrapper that skips all policy evaluation whenever `trace_id` is present — so the doc's "highest-priority" framing remains valid).

**Source:** `12-runtime-guardrails.md` — overall framing as possibly the #1 highest-priority finding of the review.

**Description:** The doc itself flags this area as potentially the single highest-priority finding across the entire 3-pass strategic review. This is a sequencing/prioritization action rather than a code fix: any roadmap planning that includes new guardrail features (new detector categories, new policy types, etc.) should be sequenced after the doc's guardrail items are resolved, not in parallel with them.

**Why it matters:** Building new features on top of a foundation with a silent safety-check bypass compounds risk and technical debt; the doc's own framing suggests this should override normal feature-prioritization processes.

**Severity:** Medium (recalibrated from Critical during cross-doc ranking — treated as a process/sequencing recommendation for this consolidated list rather than a standalone code defect).
**Effort:** Small.
**Confidence:** High — the "possibly #1 priority" framing is explicitly stated in the source doc itself, not inferred.

**Files touched:** _(none listed)_

---

### FEAT-127 — Implement `action=alert` beyond its current stub

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/topics/service.py:230-231`: `if action != "dataset": return {"action": action, "topic_id": topic_id, "status": "queued"}` — the alert branch still returns a fake "queued" response and sends nothing).

**Source:** `14-user-request-mining.md` — User Experience & Value section, `action=alert` stub.

**Description:** There is an `action=alert` option/parameter in the topic-mining feature that is currently just a stub — it doesn't actually send an alert when invoked. **Fix:** implement real alerting behavior (e.g., notification via whatever eden's existing alerting/notification channel is) behind this action.

**Why it matters:** A stubbed alert action gives the false impression that proactive notification exists for emerging topics/requests when it doesn't — anyone configuring or relying on `action=alert` gets silently no alerts.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/topics/service.py`
**Depends on:** FEAT-93

---

### FEAT-128 — Create the `agent_artifact_context` table per the source's exact SQL

**Status:** ⬜ OPEN — verified 2026-08-05 (zero references to `agent_artifact_context` anywhere in `migrations/`, `src/eden/db_migrations/`, or `src/eden` — the table does not exist).

**Source:** `15-artifacts-behavior-record.md` — schema section (exact SQL at features/15-artifacts-behavior-record.md L116-128).

**Description:** The source doc provides exact SQL for a new `agent_artifact_context` table, the schema backing for the team-uploaded-context feature (FEAT-148) and richer per-agent artifact scoping:

```sql
CREATE TABLE agent_artifact_context (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_id     TEXT NOT NULL,
    filename     VARCHAR(256),
    content_type VARCHAR(32) NOT NULL DEFAULT 'text/markdown',
    content      TEXT NOT NULL,
    created_by   VARCHAR(128) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_agent_artifact_context_agent ON agent_artifact_context (org_id, agent_id, created_at DESC);
```

**Fix:** create this table per the provided SQL (as a new migration under `src/eden/db_migrations/versions/`) as a foundational step for FEAT-148 and related work.

**Why it matters:** Having ready-made schema SQL substantially lowers the effort bar for FEAT-148 and any related per-agent-context work — concrete, reviewable starting point rather than a design-from-scratch task.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `agent_artifact_context` (new table/migration)

---

### FEAT-129 — Sequence issue-ranking/severity-escalation work after doc 13's P0-A/P0-B (Loop 1 revival)

**Status:** ⬜ OPEN — verified 2026-08-05 (sequencing constraint; its prerequisites FEAT-8/FEAT-9 have not been marked done, and no composite issue-ranking/severity-escalation implementation has landed that would violate or moot the constraint).

**Source:** `16-issue-extraction-online-evals.md` — explicit build-sequence dependency on `13-continuous-improvement-loop.md`.

**Description:** The source doc explicitly states its recommended build sequence depends on `13-continuous-improvement-loop.md`'s P0-A and P0-B steps being completed first. This is a sequencing constraint, not a standalone code fix: teams should not implement composite issue ranking or, especially, severity escalation (which likely needs to consume the confirm/dismiss signal Loop 1 produces) before those prerequisite steps land.

**Why it matters:** Implementing ranking/escalation logic ahead of its prerequisite data pipeline being functional risks either building against incomplete/wrong data, or having to rework the logic once Loop 1 actually starts producing real confirm/dismiss signal data.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High — the dependency itself is explicitly stated in the source doc.

**Files touched:** _(none listed)_
**Depends on:** FEAT-8, FEAT-9

---

### FEAT-130 — Surface per-case (not just aggregate) F51 grading verdicts in the CI score table

**Status:** 🟡 PARTIAL — per-metric aggregate score table shipped; per-case F51 `grade_datapoint` verdicts are still absent.

**Source:** `02-evals-datasets.md`, §5 P1 items 6-7 (citing `ci_webhook.py:16,59-62,73-81` — still accurate: `grade_datapoint` import at :16, grading calls at :60-62, `build_score_table` at :73; `regression_runner.py` — `run_suite` now at :107, `_evaluate_case` at :182).

**Already landed:** Commit cdccb59f ("feat(ci-eval): F56 turnkey evals-in-CI — score table, run history, PR gate") versioned the webhook payload and added the per-case tri-state reasons from `RegressionRunResult` plus a per-metric score table graded via `grade_datapoint` (the same grading function that powers F51, reused from `experiments/compare.py`).

**Remaining work:** The score table is still per-METRIC aggregate (pass_rate/fail_rate/skip_rate/error_rate rows in `_METRICS`); `run_suite` does not kick off or reuse an F51 run, and no per-case `grade_datapoint` verdicts appear in `score_table`. Keep `RegressionRunner`'s existing stumble-signature/StatGate check (`_evaluate_case`) as-is for the cheap, no-LLM-call canary-gate path (do not replace it), but additionally have `run_suite` kick off (or reuse) an F51 run against the same org/agent's now-unified dataset, and surface its `grade_datapoint` verdicts in `ci_webhook.py`'s `score_table` per case, not just in aggregate.

**Why it matters:** Turns an existing, working, but aggregate-only bridge into a full Braintrust-style per-row diff eden is currently missing, without inventing new plumbing — closes a real gap against competitor CI-gating UX.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/evaluation/ci_webhook.py`, `src/eden/experiments/compare.py`, `src/eden/evaluation/regression_runner.py`
**Depends on:** FEAT-96

---

### FEAT-131 — Build an LLM-judge adapter to wire `llmops/judges/UnifiedJudge` into F49/F51's scorer path

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/playground/scorers.py` docstring still states "``llm_judge`` is deliberately absent … a fake judge is worse than none"; `unified.py` still 225 lines; `Judge.score` still at `base.py:110`; no per-axis judge files exist in `src/eden/llmops/judges/`).

**Source:** `02-evals-datasets.md`, §5 P2 item 12, §3k (citing `llmops/judges/base.py:109-119`, `unified.py`, `runner.py:51-102`).

**Description:** `playground/scorers.py` (F49) deliberately omits an `llm_judge` scorer ("a fake judge is worse than none"). Eden already has production-grade LLM-judge infrastructure: `UnifiedJudge` (`unified.py`, 225 lines) scores every axis in one LLM call, and `JudgeRunner.run_for_event` fans out judges concurrently with per-tenant semaphore and cost/cache-tracked persistence to `judge_scores`. The integration cost: `Judge.score(event: TelemetryEvent, ctx: JudgeContext)` is contractually bound to a `TelemetryEvent`, not a generic `(input, output, expected)` triple, so wiring it into dataset-row scoring needs either (a) a small adapter wrapping a `dataset_item` row in a `TelemetryEvent`-shaped object, or (b) calling `UnifiedJudge.score()` directly and discarding axes F49/F51 don't need per row. There is no single-axis judge left to extract cleanly (per-axis judges like `hallucination.py`/`correctness.py` were consolidated into `UnifiedJudge` and no longer exist as separate files), so a prior recommendation to "extract one judge's prompt template" no longer applies.

**Why it matters:** Reuses eden's most production-grade judge infrastructure (concurrency, cost tracking, persistence) rather than building parallel judge logic or misusing `prompt_versioning._llm_score` (which is a prompt-text linter, not a case-scoring judge) — closes the gap against competitors' LLM-judge-based dataset scoring.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/playground/scorers.py`, `src/eden/llmops/judges/base.py`, `src/eden/llmops/judges/unified.py`, `src/eden/llmops/judges/runner.py`
**Depends on:** FEAT-13

---

### FEAT-132 — Build a first-class "attach dataset" flow (Dataset Hub / F53 integration) in the playground editor

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/playground/service.py:299` still defaults to `dataset_rows or [{"id": "adhoc", "input": params.get("user", "")}]`; the portal playgrounds page — shipped since, commits d5b3688f/33f5f218 — hardcodes `datasetId: null` at `clients/portal/src/app/(portal)/playgrounds/page.tsx:69` and its empty-state copy at :131 still promises "attach a dataset to compare prompts before you ship" with no picker UI).

**Source:** `03-prompt-playground.md`, "User Experience & Value → Where the workflow breaks down"; citing `service.py:298-300` (now `src/eden/playground/service.py:299`).

**Description:** `PlaygroundService.run` defaults to a single synthetic dataset row (`{"id": "adhoc", "input": params.get("user", "")}`) when no `dataset_rows` are supplied. There is no UI-driven pull from Dataset Hub (F53) — systematic regression testing across a labeled dataset currently requires the caller to assemble `dataset_rows` by hand or via direct API calls, not through a first-class "attach dataset" flow in the editor. This is a gap against the editor's own empty-state copy, which promises "attach a dataset to compare prompts before you ship." **Fix:** build an in-editor UI flow to browse/select/attach a Dataset Hub dataset as the `dataset_rows` source for a playground run.

**Why it matters:** Without this, "systematic" prompt regression testing (vs. ad hoc single-row testing) is only accessible to users willing to hand-craft API calls, which excludes most of the target user base (prompt engineers/product devs working in the portal UI) and directly contradicts what the editor's own empty-state copy already promises them.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/playground/service.py`, `clients/portal/src/app/(portal)/playgrounds/page.tsx`

---

### FEAT-134 — Add a suppression-rule UI/API (dedup windows / "don't page for known-noisy events")

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/alerts/triage_judge.py` still classifies via the hardcoded `_BENIGN_PATTERNS` tuple at :16; zero "suppression" references anywhere in `src/eden/api/routes` — no config surface exists).

**Source:** `04-alerting-oncall.md`, "User Experience & Value → Noise control" (citing `AlertTriageJudge.judge`, four hardcoded regexes).

**Description:** Beyond the structural dedup bug (#101), there is no UI or API for a customer to add their own suppression rule (e.g., "our Tuesday batch job always spikes latency, don't page for it") — that requires a code change today. **Fix:** build a suppression-rule config surface (UI + API) on top of the triage judge.

**Why it matters:** Without user-configurable suppression, known-noisy/benign recurring conditions will keep generating fresh incident emails indefinitely — a direct driver of alert fatigue.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/alerts/triage_judge.py`
**Depends on:** FEAT-101

---

## Wave 10

**19 points** (0 bugs, 2 optimizations, 17 features) — severity mix: 19 Medium. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 9 or earlier.

**Status as of 2026-08-05:** 19 remaining (1 partial, 18 open).

### OPT-33 — Deduplicate redundant `compress_trace` recomputation in `_heuristic_match`

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/signals/investigator.py:81` — `_heuristic_match` still computes `compress_trace(events).lower()` internally, and is still invoked per signal definition at investigator.py:281 and :299).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`RetentionPolicy("training_datasets", 7, 90, 2555, 2555)` still present at `src/eden/data_platform/retention.py:55`; no table named `training_datasets` exists anywhere in `migrations/` or `src/eden/db_migrations/` — the only other reference is `gold_layer.py`'s unrelated `generate_training_datasets` method).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (two hardcoded `severity="warn",` payload sites remain in `src/eden/api/routes/portal.py` in the ~L2000-2300 region around `list_portal_signals`/`get_portal_workspace`; the `nl_alert_rules` table in `src/eden/db_migrations/versions/098_nl_alert_rules_f81.py` still has no severity column — only the sibling `alert_events` table stores `severity TEXT NOT NULL DEFAULT 'warning'`).

**Source:** `04-alerting-oncall.md`, "User Experience & Value" (citing `portal.py:2119` — line has drifted; locate via the hardcoded `severity="warn"` literals near `list_portal_signals`; `nl_alert_rules` table in migration 098).

**Description:** The portal's rule card always displays `severity="warn"` regardless of what the user actually configured, because `nl_alert_rules` itself doesn't persist a severity field — only the separate, bridged `eql_alert_rules` row does (severity is persisted and validated on the EQL side: see `src/eden/dsl/alerts.py`, `severity: One of info|warning|high|critical`). **Fix:** persist configured severity on `nl_alert_rules` (or read/display from the bridged row) so the UI shows the real severity.

**Why it matters:** A user has no way to see, from the UI, what severity their rule was actually registered at — compounding a related bug, since a user can't even tell from the display that their "critical" rule silently stopped firing.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/portal.py`, `nl_alert_rules`, `eql_alert_rules`
**Depends on:** FEAT-17

---

### FEAT-111 — Add end-to-end/route-level tests for `compliance_pack.py`'s FastAPI routes

**Status:** ⬜ OPEN — verified 2026-08-05 (`compliance_pack`/`generate_agent_pack` are referenced in tests only by `tests/unit/ws4/test_enterprise_ws4.py` unit tests; `tests/unit/api/test_audit_tamper.py` covers the separate `api/routes/audit.py::verify_audit_chain` route, not the three `/orgs/{org_id}/compliance` routes; `compliance_pack_export_v1: bool = True` still at `src/eden/config.py:1451`).

**Source:** `07-security-compliance.md`, §7 (citing `governance/compliance_pack.py`, `api/routes/compliance_pack.py`; `config.py:1451` — still accurate).

**Description:** `compliance_pack_export_v1` defaults `True` (live in production configuration by default), and its three routes (`verify`, `ledger`, `agents/{agent_id}/export`) are mounted at `/orgs/{org_id}/compliance`. But only the underlying `AgentAuditLedgerWriter.verify_chain()` has unit tests — nothing tests `generate_agent_pack` or the FastAPI routes themselves end to end. **Fix:** add route-level/integration tests exercising all three mounted endpoints, since this is enabled-by-default production surface with no regression safety net today.

**Why it matters:** A capability that's on by default in production with zero end-to-end test coverage is a silent regression risk — a break here wouldn't be caught by any existing test, and would surface first as a live production incident against a compliance-sensitive endpoint.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/governance/compliance_pack.py`, `src/eden/api/routes/compliance_pack.py`, `src/eden/config.py`

---

### FEAT-113 — Implement prefetch/batch-buffer for `pop()` in the annotate UI

**Status:** ⬜ OPEN — verified 2026-08-05 (no annotate UI exists at all: zero `labelingApi` usage in any `clients/portal/src` .tsx file and no labeling page directory under `app/(portal)`; the backend batch pop is confirmed ready — `pop_queue` at `src/eden/api/routes/labeling.py` takes `limit: int = Query(default=5, ge=1, le=50)`).

**Source:** `08-annotation-labeling.md`, §6c.3 (citing `labeling.py:392-411` — `LabelingService.pop`).

**Description:** Call `popQueue(limit=5)` (already supports batch prefetch) once, hold 4 items in a client-side buffer, and only re-call when the buffer runs low — rather than popping one item per submit and waiting on the round-trip.

**Why it matters:** Popping one item per submit would reintroduce exactly the latency a keyboard-driven flow is supposed to eliminate — required to hit the "fast" UX bar.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/evaluation/labeling.py`, `clients/portal/src/lib/api/resources.ts`
**Depends on:** FEAT-112

---

### FEAT-123 — Add a `.sent`/`.failed`-equivalent counter to the TS SDK

**Status:** ⬜ OPEN — verified 2026-08-05 (`sdk/ts-ai/src/client.ts` tracks `sampledOut` (:578) and `droppedTotal` (:590) but has no sent/failed counter pair; a comment at client.ts:623 even acknowledges events users "sent with no SDK-side counter to explain why").

**Source:** `09-sdk-dx.md` — TS SDK observability of the SDK itself.

**Description:** The TS SDK has no equivalent of a `.sent`/`.failed` counter pair (implied contrast with Python, which does track this class of metric). Without it, TS users cannot programmatically or via `doctor.ts` determine how many spans/events were successfully sent vs. failed to send.

**Why it matters:** Same class of self-serve debuggability gap as #122 — without send/fail counts, diagnosing "my traces aren't showing up" requires either trusting a black box or filing a support ticket.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `sdk/ts-ai/src/client.ts`, `sdk/ts-ai/src/doctor.ts`

---

### FEAT-138 — Extend `ProviderRoutingService` ingestion decoders rather than replacing the service's role

**Status:** ⬜ OPEN — verified 2026-08-05 (`ProviderRoutingService` at `src/eden/services/observability/provider_routing.py:81` remains observe-only — `record_attempt`/`get_attempts_for_trace`/`list_attempts`/`get_failure_rate`/`detect_repeated_failures`, no routing decision logic — but no per-router format decoders (LiteLLM/Portkey/OpenRouter trace-format parsing) have been added either; the extension work remains).

**Source:** `10-model-gateway.md` — `ProviderRoutingService` assessment section.

**Description:** `ProviderRoutingService`'s correct role per the doc's verdict is observe-not-replace: it should continue decoding/ingesting routing decisions made by external tools (e.g., customers' own LiteLLM/Portkey deployments) rather than becoming eden's own routing decision-maker. The concrete action is to extend its ingestion decoders (parsing more providers'/routers' trace formats) rather than building decision logic into it. Today the service records attempts generically via `record_attempt`; there is no per-router decoder layer yet.

**Why it matters:** Keeps eden positioned as an observability layer over whatever routing tool a customer already uses, which is the differentiated, lower-competition role versus trying to out-build dedicated routing vendors.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/services/observability/provider_routing.py` (plus `src/eden/api/routes/observability_provider_routing.py`, `src/eden/sdk/provider_routing.py`)

---

### FEAT-139 — Add a `RetentionCurveChart` component to the portal

**Status:** ⬜ OPEN — verified 2026-08-05 (zero references to `RetentionCurveChart` anywhere in `clients/portal/src`; note the backend groundwork has moved — commit 5e645046 "N12 session timeline backend — summaries table, rollup, timeline API" landed a session-summaries table, which may satisfy part of the FEAT-52 dependency).

**Source:** `11-session-analytics.md` — User Experience & Value section (component sketch provided in source).

**Description:** The doc includes a full sketch for a `RetentionCurveChart` React component that does not currently exist in the portal. This would visualize retention curves (e.g., session-over-time cohort retention) once the underlying data is fixed. **Fix:** implement the component per the doc's sketch and wire it to corrected `session_summaries`-backed cohort data.

**Why it matters:** Retention curves are a standard, high-value analytics visualization that's currently entirely absent from the portal despite the backend groundwork (once fixed) supporting it — closes a visible feature gap for any product-analytics-minded customer.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `RetentionCurveChart.tsx` (new), `session_summaries`
**Depends on:** FEAT-52

---

### FEAT-141 — Make topic clustering run on a background schedule, not on-demand only

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/observability/patterns_clusterer.py` docstring L15-16 still claims "runs as a background job (the FastAPI lifespan starts it)", but nothing outside the file references `PatternsClusterer`, no `create_task`/loop/scheduler exists in it, and the only invocation is on-demand via `get_patterns_clusterer().run_once()` from `src/eden/topics/service.py:151`; config flags `patterns_clusterer_enabled`/`_lookback_days`/`_min_cluster_size` exist at `config.py:1523-1525` but no job consumes them on a schedule).

**Source:** `14-user-request-mining.md` — User Experience & Value section, scheduling gap.

**Description:** `patterns_clusterer.py`'s own docstring claims background-job scheduling, but in actual current behavior it only runs on-demand — the claimed scheduled/background execution doesn't happen. **Fix:** either implement actual background scheduling (e.g., periodic job via whatever eden's existing job/cron infrastructure is) to match the docstring's claim, or correct the docstring if on-demand-only is the intended final behavior.

**Why it matters:** A discovery feature like topic/pattern clustering is far more valuable running continuously in the background (so new emergent topics surface automatically) than requiring someone to remember to trigger it manually — the current gap between documented and actual behavior suggests this was an unfinished implementation, not an intentional design choice.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/observability/patterns_clusterer.py`

---

### FEAT-144 — Wire `TriageAgent` to read from the Ledger

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/issues/triage_agent.py` contains no reference to `LedgerGenerator` or the behavior-record Ledger; its only "ledger" mentions — lines ~490/501 — are the unrelated Redis `autonomy:spend:` cost ledger).

**Source:** `15-artifacts-behavior-record.md` — gaps beyond portal routes section; Build sequence Phase 3.

**Description:** `TriageAgent` (eden's triage/routing agent) currently does not read from the Ledger, despite the Ledger existing specifically to hold accumulated behavioral/context knowledge that would plausibly improve triage decisions. **Fix:** add Ledger-read integration to `TriageAgent`'s decision pipeline — per the source doc, one call to `LedgerGenerator().get_latest(org_id, agent_id)` as a first, cheap pass before `TriageAgent._gather_evidence()`'s 8-call ReAct loop (source doc estimate: 0.5 day).

**Why it matters:** This is a missed opportunity to use already-built context infrastructure (the Ledger) to improve an existing agent's decision quality — the Ledger's value is partly measured by how many consumers actually use it, and currently a natural consumer doesn't.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/issues/triage_agent.py`

---

### FEAT-145 — Add a prompt-version-changed regeneration trigger

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/services/prompt_versioning.py` contains zero references to artifacts, regeneration, or Book/Ledger hooks — no trigger exists on version bump).

**Source:** `15-artifacts-behavior-record.md` — feature gap section.

**Description:** There is currently no mechanism to trigger regeneration of artifacts/book content when the underlying prompt version changes. This means artifacts generated against an old prompt version may become stale or inconsistent once the prompt is updated, with nothing prompting a refresh. **Fix:** add a trigger (e.g., a hook on prompt-version bump) that flags or automatically regenerates affected artifacts.

**Why it matters:** Without this, artifacts can silently drift out of sync with the prompts they're meant to support/inject into, degrading quality over time as prompts evolve without corresponding artifact updates — a slow-burn data-quality issue.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/services/prompt_versioning.py`

---

### FEAT-146 — Wire the per-step judge automatic scoring loop (`apm_depth/step_judges.py`)

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/apm_depth/step_judges.py` docstring L13-14 still states "The v0 ship is **stamping only** — the actual per-step judge_runner wiring is the v0.1 follow-up"; `StepJudgeStamper` is referenced only by `apm_depth/__init__.py` and the `intelligence_apm_depth` route — no automatic `JudgeRunner` wiring exists).

**Source:** `01-competitor-matrix.md`, "Deep codebase re-pass" section (citing `step_judges.py:1-22` — still accurate).

**Description:** `StepJudgeStamper` extends telemetry events with `step_index`/`step_judges` fields and exposes `stamp`, `get_step_judges`, and `get_trace_steps` — a storage/read primitive. But the module's own docstring states this ship is "stamping only": the actual per-step `JudgeRunner` wiring that would populate these scores automatically is called out as an unbuilt v0.1 follow-up. **Fix:** build and wire the automatic per-step judge-scoring loop so `step_judges` gets populated without requiring a caller to manually stamp each step.

**Why it matters:** Without the automatic loop, this is a write/read API with no default data source — comparable competitor features (HoneyHive per-step eval metrics, Datadog step-level attribution) run automatically; eden's version currently requires bespoke integration work per caller to produce any data at all.

**Severity:** Medium.
**Effort:** Large.
**Confidence:** High (doc explicitly self-admits this gap in the module docstring).

**Files touched:** `src/eden/apm_depth/step_judges.py`

---

### FEAT-147 — Add ability to filter/search the trace list by any participating agent, not just the collapsed "preferred" agent

**Status:** ⬜ OPEN — verified 2026-08-05 (`_PREFERRED_AGENT_ID_SQL` still present in `src/eden/api/routes/portal.py`; zero "participant" references in the file — no participants facet or any-agent filter query path exists).

**Source:** `05-multiagent-tracing.md` (citing `_PREFERRED_AGENT_ID_SQL`).

**Description:** `_PREFERRED_AGENT_ID_SQL` deliberately collapses a trace to a single "winner" agent ID for the list view; there is no query path for "show me every trace where agent X participated, even as a sub-delegate." Fix requires either exploding the collapse (listing `agent_id` as an array per trace) or building a secondary "participants" facet — flagged as a materially different query shape worth scoping as its own follow-up, not a trivial addition.

**Why it matters:** An engineer investigating a specific sub-agent's behavior across many traces currently cannot filter the trace list by that agent unless it happens to be the "preferred" one selected for each trace — blocks a common investigative workflow.

**Severity:** Medium.
**Effort:** Large.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/portal.py` (`_PREFERRED_AGENT_ID_SQL`)

---

### FEAT-148 — Build a team-uploaded-context feature

**Status:** ⬜ OPEN — verified 2026-08-05 (no `agent_artifact_context` table, no `POST .../artifacts/context` upload endpoint in `api/routes/learn.py`, and no upload UI exist anywhere in the repo).

**Source:** `15-artifacts-behavior-record.md` — feature gap section; API-surface and Build sequence Phase 4.

**Description:** There is currently no feature allowing a team to manually upload their own context (e.g., documentation, policy text, product knowledge) into the Book/Ledger/Artifacts system — all current content appears to be system-generated (from `ArtifactAuthor` etc.) rather than human-supplied. **Fix:** build an upload/ingestion path (UI + API) for teams to add their own context material into the same system that already injects content into production prompts. Per the source doc: one new endpoint `POST /orgs/{org_id}/agents/{agent_id}/artifacts/context` (upload team `.txt`/`.md` context, mirroring Lemma's `upload-project-artifact`, using the envelope helpers already in `learn.py`); fold rows into the existing pipelines rather than building a parallel system — `BookGenerator._synthesize()` and `LedgerGenerator`'s issue/promotion upserts should read `agent_artifact_context` rows for the agent and include them in what gets synthesized/injected; `BookGatewayFilter`'s injection path is unaffected (context flows in upstream of it). Source doc estimate: 1-1.5 days including portal upload UI.

**Why it matters:** A system that shapes live production prompts but can only be populated by automated processes (not by the humans who best understand their own product/domain) is missing a high-value, commonly-expected capability in this product category (compare to how competitor "artifacts"/context systems typically support manual curation).

**Severity:** Medium.
**Effort:** Large.
**Confidence:** High.

**Files touched:** `agent_artifact_context` (new table), `src/eden/api/routes/learn.py`, portal upload UI
**Depends on:** FEAT-128

---

### FEAT-149 — Surface/alert on Redis-lease fallback degradation

**Status:** ⬜ OPEN — verified 2026-08-05 (`src/eden/evaluation/labeling_leases.py` — `_memory_leases` dict still at :13; both Redis-failure fallback paths still log at `logger.debug` only, in `claim_lease` at :45 and the release path at :67; no metrics or operator alerting).

**Source:** `08-annotation-labeling.md`, §1a, Phase 3 Verdicts item 2 (citing `labeling_leases.py:13,47-52` — fallback lines have drifted slightly to :45-51; anchor on `claim_lease`).

**Description:** The in-memory lease fallback (`_memory_leases: dict[str, tuple[str, float]] = {}`) is a process-local Python dict. In a horizontally-scaled deployment, each process has its own independent copy — during a Redis outage, two reviewers hitting two different pods can each be told they hold the lease for the same item, and nothing surfaces that degradation to an operator (`claim_lease` just logs at `debug` level). **Fix:** elevate the log level when the fallback path activates and/or add operator-facing alerting/metrics so a Redis outage that silently disables cross-instance exclusivity is visible.

**Why it matters:** This is the concrete answer to "what happens when two reviewers claim the same item" — currently invisible, so an operator has no way to know exclusivity is degraded during an incident.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — the doc identifies the gap precisely but doesn't fully spell out a specific fix.

**Files touched:** `src/eden/evaluation/labeling_leases.py`

---

### FEAT-151 — Audit for other silent `AIGateway` call sites beyond the two found

**Status:** ⬜ OPEN — verified 2026-08-05 (`AIGateway` still exists — `src/eden/llmops/ai_gateway.py:384`, and the file is 1,663 lines, larger than the doc's "~900 lines" figure; 14 files across `src/eden` reference `AIGateway`, including `config.py` and the `time_travel` recorder/replayer — no systematic call-site audit has been recorded and deletion #137 has not happened).

**Source:** `10-model-gateway.md` — undocumented production call sites section (implied completeness gap).

**Description:** The doc found two previously-undocumented, silently-broken call sites via manual investigation, not via a systematic search. Given `AIGateway` is large (now 1,663 lines, not ~900 as the doc estimated) and dormant, there is a reasonable chance additional call sites exist elsewhere in the codebase that weren't caught by this pass — a current grep shows 14 referencing files. **Fix:** run a full repo-wide reference search for `AIGateway` usage before proceeding with deletion (#137), to ensure no other silent failures are lurking.

**Why it matters:** Deleting `AIGateway` (#137) without first confirming all call sites are accounted for risks either missing more broken production paths or breaking something unexpectedly during removal.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — this is a reasonable inferred precaution rather than an explicit instruction in the source doc.

**Files touched:** `src/eden/llmops/ai_gateway.py` (`AIGateway`)

---

### FEAT-153 — Add regression tests asserting `evaluate_and_act` is the active path whenever `trace_id` is present

**Status:** ⬜ OPEN — verified 2026-08-05 (the bypass itself is still live: `_wrapped` in `src/eden/observability/trace_quality/wiring.py::install_cat15_trajectory_replaces_intervention` only calls the original `evaluate_and_act` when `trace_id` is falsy, and returns `matched_policies: []` from `evaluate_trajectory_step` otherwise; the only related tests — `tests/unit/api/test_wave3_wiring.py::test_hot_path_flag_false_skips_wiring`/`test_hot_path_flag_true_applies_wiring` — assert whether the monkey-patch is installed per feature flag, not that policy evaluation still runs when `trace_id` is present).

**Source:** `12-runtime-guardrails.md` — monkey-patch section (implied test gap given the bug went undetected).

**Description:** The fact that a related bypass bug existed undetected implies there is no existing test asserting the correct guardrail path runs under the exact condition (`trace_id` present) that triggers the bypass. **Fix:** add an explicit regression test (unit or integration) that fails if the trajectory/cost-check path is taken instead of `evaluate_and_act` under that condition, to prevent regression after the bypass is fixed.

**Why it matters:** Without a regression test, fixing the bypass once does not guarantee it (or an equivalent one) won't be silently reintroduced by a future change — this is the actual root-cause-level fix that makes the fix durable.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — inferred from the absence-of-monitoring finding rather than an explicit source instruction.

**Files touched:** `tests/unit/api/test_wave3_wiring.py` (extend), `src/eden/observability/trace_quality/wiring.py` (under test)
**Depends on:** FEAT-3

---

### FEAT-154 — Document the relationship/precedence between Loop 1, Loop 2, and `EvidenceGate`

**Status:** ⬜ OPEN — verified 2026-08-05 (no dedicated architecture note exists; `EvidenceGate` is mentioned only in scattered spec reports — `SOTA-MARKET-READY-REPORT.md`, `SOTA-WAVE-TRACKER.md`, `FEATURE-GAP-MASTER.md`, `GA-ACHIEVEMENT-REPORT.md`, `CODEBASE-GROUND-TRUTH.md` — none of which maps the three mechanisms' interaction).

**Source:** `13-continuous-improvement-loop.md` — overall structure (three distinct mechanisms covered in one doc).

**Description:** The doc covers three separate "loop"/gating mechanisms (Loop 1 shadow-detector, Loop 2 autonomous patch pipeline, and `EvidenceGate`/`PromotionLoop`) that all relate to continuous improvement but aren't explicitly documented as to how they relate to or depend on each other architecturally. **Fix:** produce (or extract from the source doc if already present in narrative form) an explicit architecture note describing how these three mechanisms interact, to prevent future confusion or duplicate-effort fixes.

**Why it matters:** Without a clear map of how these three systems relate, engineers fixing one may not realize the fix has implications for the others — architectural clarity reduces the risk of fragmented, inconsistent fixes.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — inferred organizational recommendation; the source doc's structure implies this need but doesn't necessarily instruct it as a standalone action item.

**Files touched:** _(none listed)_

---

### FEAT-155 — Add regression/integration tests for Loop 1 confirming the confirm/dismiss signal actually changes detector behavior

**Status:** 🟡 PARTIAL — threshold-function unit tests exist; the end-to-end integration test is still missing.

**Source:** `13-continuous-improvement-loop.md` — Loop 1 section (implied by the loop having been fully dead-code undetected).

**Already landed:** `tests/unit/services/test_shadow_promote.py` (M13 §6.5, landed in the autonomy-overhaul merge) unit-tests that `operator_confirms`/`operator_dismisses` counts drive shadow-detector promote/delete/hold decisions (e.g., promote at precision ≥0.8 over ≥20 firings, delete at <0.3, hold without operator labels).

**Remaining work:** After Loop 1's P0-A through P0-D revival steps land, add an end-to-end integration test asserting the full causal chain — a user confirm/dismiss action persisted through the API measurably changes detector behavior/scoring going forward — not just the threshold function in isolation.

**Why it matters:** Prevents Loop 1 from silently regressing back to dead-code status after being fixed — the same failure mode (built but not functioning, undetected) that caused this to be the flagship finding in the first place.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — inferred from the absence-of-detection pattern, not an explicit source instruction.

**Files touched:** `tests/unit/services/test_shadow_promote.py` (extend to integration level)
**Depends on:** FEAT-8, FEAT-9, FEAT-27, FEAT-29

---
## Wave 11

**19 points** (4 bugs, 0 optimizations, 15 features) — severity mix: 15 Medium, 4 Low. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 10 or earlier.

**Status as of 2026-08-05:** 19 remaining (3 partial, 16 open).

### BUG-23 — Mount the `mcp_keys` router (or formally retire the feature)

**Status:** ⬜ OPEN — verified 2026-08-05 (repo-wide grep: `mcp_keys` appears nowhere in `src/eden` outside `src/eden/api/routes/mcp_keys.py` itself — still absent even from the new deferred lifespan mount table introduced by dd33eb7d, which moved 105 routers out of import-time mounting).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`createMcpKey` still at `resources.ts:1855`; grep confirms zero callers anywhere else in the portal source).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`tools.py:366-367` still posts to `f"/orgs/{org_id}/sql"` with `{"sql": sql, "limit": limit}`; real route remains `POST .../sql/execute` — prefix at `sql_query.py:47`, `/execute` route decorator at `:108`, `max_rows` field at `:66`).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`tool_call_labels.py:123-125` still declares `body: dict[str, Any] = Body(default_factory=dict)`).

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

### FEAT-103 — Render the user's own natural-language rule text instead of raw compiled EQL in the alert payload/Inbox pane

**Status:** ⬜ OPEN — verified 2026-08-05 (`portal.py:2118` still builds `condition=str(r.get("compiled_eql") or r.get("nl_text") or "")` — compiled EQL wins whenever present; `alerts-panel.tsx` renders `{rule.condition}` in the detail pane; `nl_text` appears nowhere else in portal components. Additional evidence: the AlertAsCode firing path in `dsl/alerts.py` passes `nl_text=eql_query` into `AlertTriageJudge().run_for_event` — raw EQL supplied where NL text is expected).

**Source:** `04-alerting-oncall.md`, "User Experience & Value" (citing `dsl/alerts.py` firing/triage path — the cited `:522-529` has drifted, the `nl_text=eql_query` handoff is now at `:535`; `portal.py:2118`; `alerts-panel.tsx:299-309`; `nl_alert_rules.nl_text`).

**Description:** When an alert fires, the Inbox detail pane's "Condition" field renders generated SQL/EQL (`compiled_eql`) in monospace, not the plain-English sentence the user typed when creating the rule. **Fix:** surface `nl_alert_rules.nl_text` in the fired-alert payload and Inbox detail pane, alongside or instead of the raw compiled query.

**Why it matters:** The thing a rule author sees when their alert fires is not their own words — undermining the "explain what I'm about to alert on" UX the authoring flow otherwise achieves.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/dsl/alerts.py`, `src/eden/api/routes/portal.py`, `clients/portal/src/lab/alerts-panel.tsx`, `nl_alert_rules`

---

### FEAT-114 — Add undo shortcut (`u`/`Backspace`) for last annotation submission

**Status:** ⬜ OPEN — verified 2026-08-05 (no annotation UI exists anywhere in the portal — a repo-wide grep for "annotat" across `clients/portal/src` matches only the API bindings in `resources.ts`; the shortcut has nowhere to live until the annotate view (FEAT-112) ships).

**Source:** `08-annotation-labeling.md`, §6c.3, §5a.

**Description:** Add a keyboard shortcut to undo the last submission by re-submitting the previous `item_id` with the previous label — no new backend capability needed since `annotate()` is already an UPSERT keyed on `(item, annotator)`.

**Why it matters:** Called out as a "free win" — costs almost nothing given the existing UPSERT semantics, but materially improves reviewer trust/speed since mis-clicks are common in rapid keyboard-driven labeling.

**Severity:** Medium (normalized from "Low-Medium" in source doc).
**Effort:** Small.
**Confidence:** High.

**Files touched:** `clients/portal/src/lib/api/resources.ts` (`annotate` binding at `:3366`) plus the to-be-built annotate view (FEAT-112)

---

### FEAT-118 — Surface per-item disagreement signal in the annotate view

**Status:** ⬜ OPEN — verified 2026-08-05 (no annotate view exists in the portal; `IAAReport` lives in `src/eden/evaluation/labeling.py` / `src/eden/api/routes/labeling.py` but nothing surfaces per-item agreement in any UI).

**Source:** `08-annotation-labeling.md`, §6c.3, §4.

**Description:** Following Braintrust's pattern (not LangSmith's) since `annotate()` has no blind-review gate: surface "N annotations so far / agreement so far" on items with 1+ annotation, using `IAAReport.per_item[item_id]`, so a second annotator sees they're the tiebreaker without seeing the specific first label.

**Why it matters:** Gives reviewers disagreement context in-flow instead of requiring a separate dashboard check — a deliberate middle ground between LangSmith's blind independence and Braintrust's always-visible model.

**Severity:** Medium.
**Effort:** Small-Medium.
**Confidence:** High.

**Files touched:** `src/eden/evaluation/labeling.py`, `src/eden/api/routes/labeling.py`

---

### FEAT-137 — Delete the dormant `AIGateway` multi-provider routing engine

**Status:** ⬜ OPEN — verified 2026-08-05 (`class AIGateway` still at `src/eden/llmops/ai_gateway.py:384`; the module is 1,663 lines — the "~900 lines" figure understates current size. Production `_providers` still starts empty: `register_providers_from_env`/`register_default_providers` have zero callers outside `ai_gateway.py` itself — see BUG-36-50 item 15).

**Source:** `10-model-gateway.md` — `AIGateway` assessment section (~900 lines of code; the containing module `src/eden/llmops/ai_gateway.py` is 1,663 lines today).

**Description:** `AIGateway` is a fully-built, ~900-line multi-provider routing/failover engine that is dormant — not wired into any live production path that actually benefits from its routing logic. The doc's verdict is DELETE: the class should be removed rather than resurrected, because the market for hosted LLM gateway/routing (Portkey — acquired by Palo Alto Networks, OpenRouter at ~$1.3B valuation, LiteLLM) is already well-served by dedicated players, and eden reinventing this is not a differentiated bet.

**Why it matters:** ~900 lines of dead, unmaintained code create ongoing maintenance drag, confuse engineers who encounter it (it has live callers that silently break — see #67), and represent sunk effort better redirected elsewhere.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/llmops/ai_gateway.py` (`AIGateway`)
**Depends on:** FEAT-151

---

### FEAT-142 — Add trending detection to topic clustering output

**Status:** ⬜ OPEN — verified 2026-08-05 (no trend/trending logic anywhere in `src/eden/observability/patterns_clusterer.py` — note corrected path; the file is under `observability/`, not `insights/`).

**Source:** `14-user-request-mining.md` — User Experience & Value section, missing capabilities list.

**Description:** The current F65 clustering output has no concept of "trending" (i.e., which topics/clusters are growing in volume/frequency recently vs. historically flat or declining). **Fix:** add a trend computation (e.g., comparing recent-window cluster volume against a longer baseline) to the clustering output/API, surfaced in the portal UI once a topics UI exists.

**Why it matters:** Without trending, users have to manually compare cluster sizes over time themselves to notice an emerging issue/request pattern — trending is typically the single most actionable signal in this category of feature (it's what tells a PM/support lead "look at this now").

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/observability/patterns_clusterer.py`

---

### FEAT-152 — Document/decide the intended relationship between `user_sessions`, `session_summaries`, and `agent_sessions`

**Status:** 🟡 PARTIAL — `session_summaries` is now the documented portal rollup; the explicit three-table decision doc is still missing.

**Source:** `11-session-analytics.md` — session data model section.

**Already landed:** The N12 session-timeline work (5e645046 / migration `142_session_summaries.py`, 2026-08-04) created and extensively documented a new `session_summaries` rollup table (one row per `(org_id, session_id)`, upserted by `eden.sessions.rollup.SessionRollupIndexer` off `trace.finalized`; the portal session list/timeline now reads it) — a de-facto scope decision for the portal surface.

**Remaining work:** `user_sessions` (`src/eden/services/user_intel/`) and `agent_sessions` (`src/eden/services/agent_sessions.py`, `api/routes/agent_sessions.py`) both remain live, and no explicit decision doc records their intended fate/relationship. Explicitly decide and document each table's intended scope going forward (e.g., is `agent_sessions` meant to be agent-specific and `session_summaries` the general-purpose canonical one, with `user_sessions` deprecated?) before the merge engineering work proceeds, to avoid the migration itself encoding an accidental/undiscussed decision.

**Why it matters:** Without an explicit decision, a migration risks silently making an architectural choice (which table "wins") that should be a deliberate product/eng decision, potentially requiring rework later.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — this is a reasonable inferred prerequisite rather than something explicitly named as a separate action in the source.

**Files touched:** `user_sessions`, `session_summaries`, `agent_sessions`

---

### FEAT-156 — Expose the T0-T4 autonomy tier prominently in whatever UI closes the Loop 2 visibility gap

**Status:** 🟡 PARTIAL — tier ladder live and rendered on the autonomy audit card; prominent surfacing in the Loop 2 pipeline UI remains.

**Source:** `13-continuous-improvement-loop.md` — Loop 2 section, `autonomy_policy.py` T0-T4 ladder.

**Already landed:** The T0-T4 ladder is confirmed live in `closed_loop/autonomy_policy.py` (`_ACTION_TIERS`, decisions return `(decision, reason, tier)`), and the portal's autonomy audit card already renders the applied tier per decision (`clients/portal/src/lab/settings/autonomy-audit-card.tsx`, `{e.tier_applied}`).

**Remaining work:** Surface the tier prominently in the broader Loop 2 pipeline UI (FEAT-30), which does not yet exist — the improve-queue view has no tier display. The autonomy tier (T0 through T4) governing how much independent action the loop can take on a given issue/patch should be a first-class, prominent piece of information in that UI — not buried — since it's the single most safety-relevant piece of state the UI needs to surface.

**Why it matters:** Operators need to be able to tell at a glance whether a given autonomous action was taken under a low-autonomy (heavily human-gated) or high-autonomy (near-fully-independent) tier, since the risk profile differs enormously between T0 and T4 — burying this in a UI that technically "shows the pipeline" but not this specific field would undercut the point of the fix.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — a specific implementation detail inferred as important within the broader UI-gap fix, not separately named as its own bullet in the source.

**Files touched:** `closed_loop/autonomy_policy.py`
**Depends on:** FEAT-30

---

### FEAT-157 — Surface `ArtifactDemotionWorker` activity in the (to-be-built) `/artifacts` UI

**Status:** ⬜ OPEN — verified 2026-08-05 (the worker is live at `src/eden/nudges/demotion_worker.py` and registered in `workers/main.py`, but `/artifacts` is still a stub entry in `clients/portal/src/lib/stub-try-instead.ts` redirecting to `/improve?mode=queue` — no artifacts UI exists, and no portal code references demotion).

**Source:** `15-artifacts-behavior-record.md` — backend components section, `ArtifactDemotionWorker`.

**Description:** `ArtifactDemotionWorker` is named in the doc as one of the existing backend components (alongside `ArtifactAuthor`). Specifically within the broader Artifacts UI-build work (#6), demotion activity (artifacts being demoted/removed from active injection) should be a visible part of the UI, not just creation/authoring — otherwise the UI would only tell half the artifact lifecycle story.

**Why it matters:** Understanding what's being demoted (and ideally why) is as important for trust/debuggability as understanding what's being created — an artifacts UI that only shows authoring without demotion history would be an incomplete picture of a system actively shaping production prompts.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — a specific implementation detail reasonably inferred as necessary within the Artifacts UI scope, not separately called out as its own bullet in the source.

**Files touched:** `src/eden/nudges/demotion_worker.py` (`ArtifactDemotionWorker`), `/artifacts`
**Depends on:** FEAT-6

---

### FEAT-159 — Add a way to view/filter issues by rank tier once composite ranking ships

**Status:** ⬜ OPEN — verified 2026-08-05 (no "composite"/"rank" references in `src/eden/issues/` or the portal issues page — the prerequisite composite ranking (FEAT-11) has not shipped, so this follow-on remains blocked and unstarted).

**Source:** `16-issue-extraction-online-evals.md` — User Experience & Value section (implied UI follow-on to composite ranking).

**Description:** Once composite ranking exists, the portal issue view should let users filter/sort by the new rank score (e.g., a "Top Priority" view or explicit rank-tier filter), not just implement the backend sort silently. **Fix:** add UI controls (sort toggle, tier filter/badges) surfacing the new ranking once it exists.

**Why it matters:** A backend ranking fix without a corresponding UI affordance to actually use/see the ranking (beyond default list order) under-delivers on the value of the fix — the whole point is helping a human triager quickly find what matters most, which benefits from an explicit visual/filterable signal, not just implicit list order.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — a reasonable UI follow-on inferred from the ranking fix, not necessarily spelled out as its own bullet in the source beyond the User Experience & Value section's general framing.

**Files touched:** _(none listed)_
**Depends on:** FEAT-11

---

### FEAT-160 — Add technical re-verification (re-query stores post-deletion) to the RTBF flow

**Status:** ⬜ OPEN — verified 2026-08-05 (no post-delete re-verification/re-query logic in `src/eden/services/governance_intel/gdpr.py` — the only "verified" mentions are docstring notes about schema verification).

**Source:** `07-security-compliance.md`, §3 (web research, unverified-external-claim), §8 "What would make this trustworthy and usable" bullet 3.

**Description:** Independent GDPR/SOC2 guidance cited in the doc converges on re-querying stores after a delete call to technically verify erasure, rather than trusting the delete call's return code alone. **Fix:** extend `gdpr.py`'s existing fail-closed pattern with a post-delete re-verification step per store (re-search Typesense/re-query Postgres/re-check Qdrant for the erased identifiers) before reporting final success to the caller.

**Why it matters:** This closes the exact failure mode the Typesense/Redis bugs (see #108) demonstrate — a delete call that doesn't raise an exception is not proof of actual erasure; re-verification is described as "the kind of evidence a SOC2 Type II auditor samples for directly."

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** Medium — sourced from unverified external web research, not independently re-checked by this pass.

**Files touched:** `src/eden/services/governance_intel/gdpr.py`
**Depends on:** FEAT-5, FEAT-108

---

### FEAT-161 — Audit all other analytics modules for the same wrong-table pattern as `cohorts.py`/`funnels.py`

**Status:** ⬜ OPEN — verified 2026-08-05 (the two known instances aren't even fixed yet: `src/eden/analytics/cohorts.py` still queries `FROM jobs` in its cohort SQL, and `funnels.py` still references the legacy table — so the broader audit has clearly not happened; note corrected package path `src/eden/analytics/`).

**Source:** `11-session-analytics.md` — analytics code section (implied by the pattern found in two sibling files).

**Description:** Since both `cohorts.py` and `funnels.py` independently ended up pointed at wrong/legacy tables (`jobs`, `audit_log`), it's likely other analytics modules in the same package have the same class of bug (schema drift not propagated to all consumers). **Fix:** systematically review all modules under the analytics package for table references and validate each against the current canonical schema.

**Why it matters:** Given two out of however-many analytics modules were checked both had this exact bug, the prior probability of additional undiscovered instances is high; each one silently produces wrong numbers until found.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** Medium — this is an inferred audit recommendation based on the pattern found, not a specific additional bug the source doc names.

**Files touched:** `src/eden/analytics/cohorts.py`, `src/eden/analytics/funnels.py`
**Depends on:** FEAT-52, FEAT-53

---

### FEAT-162 — Unify with F21 tool-call labeling once real usage exists

**Status:** ⬜ OPEN — verified 2026-08-05 (no unification work; `tool_call_labels.py` and the annotation-queue subsystem remain fully separate, and the explicit precondition — a shipped annotation UI with real usage — is unmet since no annotate UI exists in the portal).

**Source:** `08-annotation-labeling.md`, §7 item 5.

**Description:** Once the annotation UI ships and gets real usage, unify this general-purpose annotation-queue subsystem with F21's `tool_call_labels.py` (tool-call thumbs-up/down), eden's other human-labeling surface. Explicitly sequenced as lower priority than shipping the UI itself.

**Why it matters:** Eden currently has two separate, unconnected human-labeling surfaces; consolidating avoids long-term UX/data-model fragmentation, but is not urgent.

**Severity:** Medium.
**Effort:** Large.
**Confidence:** Medium — carried over from a prior phase and not elaborated on in this doc.

**Files touched:** `src/eden/api/routes/tool_call_labels.py`

---

### FEAT-163 — Build active-learning sample selection (post-UI)

**Status:** ⬜ OPEN — verified 2026-08-05 (no active-learning/uncertainty-sampling code in `src/eden/evaluation/`; prerequisite annotate UI also unshipped).

**Source:** `08-annotation-labeling.md`, §7 item 7.

**Description:** Listed as a future recommendation, sequenced strictly after the annotate UI ships. No further detail on scope or mechanism given.

**Why it matters:** Would let eden prioritize which items get labeled next based on model uncertainty/disagreement rather than pure FIFO/priority-tier queueing, but treated as a low-priority future item, not a near-term deliverable.

**Severity:** Medium (normalized from "Low-Medium" in source doc).
**Effort:** Large.
**Confidence:** Medium — the doc explicitly defers this without describing an implementation.

**Files touched:** _(none listed)_

---

### FEAT-164 — Audit all other hot-path monkey-patches in the codebase for similar silent-override risk

**Status:** ⬜ OPEN — verified 2026-08-05 (`install_cat15_trajectory_replaces_intervention` still lives in `src/eden/observability/trace_quality/wiring.py`; no audit artifact or monitoring for monkey-patch overrides found in the repo).

**Source:** `12-runtime-guardrails.md` — monkey-patch section (pattern-level implication).

**Description:** Given that `install_cat15_trajectory_replaces_intervention` is one instance of a monkey-patch silently overriding intended behavior, and eden's Python SDK auto-instrumentation also relies heavily on monkey-patching as a technique, there's reasonable cause to audit other monkey-patches in the codebase (not just this one) for the same "silently swaps behavior with no monitoring" risk pattern.

**Why it matters:** If this pattern happened once in a safety-critical path, it's a codebase-culture signal worth checking elsewhere — better to proactively find other instances than wait for another one to be discovered post-incident.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** Low — this is a broad inferred audit suggestion, not something the source doc names as a specific finding beyond the one instance.

**Files touched:** _(none listed)_
**Depends on:** FEAT-3

---

### FEAT-165 — Validate the auto-revert mechanism's trigger conditions are correctly tuned

**Status:** 🟡 PARTIAL — validation scaffolding and a staged, metric-gated rollout landed; tuning against real production data is pending.

**Source:** `13-continuous-improvement-loop.md` — Loop 2 section, auto-merge/auto-revert pipeline.

**Already landed:** M15 (eb0e2d4a, 2026-08-01) rebuilt auto-merge/auto-revert as an evidence-gated ladder with canary verify; 28b0acb1 added a chaos/loop-resilience suite with a strict autonomy baseline gate; ab490f2a made two silent-dishonesty paths loud; f069e81f (2026-08-04) documented a staged rollout explicitly gated on tuning metrics (merge-and-hold ≥80% / bad-PR ≤10%) in `docs/docs/operations/auto-merge-rollout.md`.

**Remaining work:** Auto-merge is still default-off (`auto_code_patch_merge=False`) in dogfood stage, so trigger-condition tuning against real production data is pending — validate/review the auto-revert trigger conditions (what counts as "bad enough to revert") as the staged rollout proceeds, against the gating metrics documented in `docs/docs/operations/auto-merge-rollout.md`.

**Why it matters:** An auto-revert mechanism that's too trigger-happy causes churn/instability; one that's not sensitive enough fails to catch genuinely bad autonomous patches — getting this tuning right is central to whether the autonomy ladder can be trusted at higher tiers (T3/T4).

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** Low — this is a plausible inferred action based on the general pattern of the review rather than a specific bug or gap the source doc names for the revert mechanism itself.

**Files touched:** _(none listed)_
**Depends on:** FEAT-30

---

## Low band (Waves 12–16)

---

## Wave 12

**19 points** (6 bugs, 7 optimizations, 6 features) — severity mix: 5 Medium, 14 Low. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 11 or earlier.

**Status as of 2026-08-05:** 19 remaining (0 partial, 19 open).

### BUG-26 — Fix `get_judge_scores` MCP tool's wrong target path

**Status:** ⬜ OPEN — verified 2026-08-05 (`tools.py:416` still GETs `f"/orgs/{org_id}/observability/traces/{trace_id}/scores"`; the real judges router prefix `/orgs/{org_id}/observability/judges` confirmed at `judges.py:49`).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (grep for `regression_cases`/`regression_run`/`prompt_evolution` in `resources.ts`: zero hits; `agentIssuesApi` at `:2746` still under-types the resolve response).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (all 5 sites still present: `intelligence_rca.py:69` (`_event_failed`) plus `_common.py:737`, `:866`, `:997`, `:1009` — line numbers updated below for drift).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`clusterer.py:188-189` still keys on `(category, error_type, agent_id)` via `_agent_id_from_event`, which still returns the literal `"unknown"` for falsy `agent_id` — the helper is defined in `insights/rca/_common.py` (`_agent_id_from_event`, `:1014`) and imported at `clusterer.py:34`).

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
**Depends on:** BUG-12

---

### BUG-35 — Stop pooling different unversioned deployments into one "unknown" statistical baseline

**Status:** ⬜ OPEN — verified 2026-08-05 (`detectors.py:187` `by_version[t.agent_version or "unknown"]` and `:262` `(t.agent_version or "unknown", t.environment_version or "unknown")` both unchanged; no mixed-population flag on `Insight`).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (spot-checked all 15 via repo-wide grep: every function still exists with zero external callers — e.g. `record_shadow_feedback` 3 hits (def/log/`__all__`), `leader_session` 1 hit, `get_usage_service` no callers outside its own def, `register_providers_from_env`/`register_default_providers` never called outside `ai_gateway.py`, `metric_studio/_common.py:81`'s `_not_implemented_envelope` referenced only by its own module docstring).

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

### OPT-40 — Deduplicate `resolve_issue`'s double fetch of the same issue row

**Status:** ⬜ OPEN — verified 2026-08-05 (`resolve_issue` at `agent_issues.py:167` still contains one `_repo.set_status(...)` followed by two separate `_repo.get_issue(org_id, issue_id)` calls).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`_fetch_cluster_members` still at `_common.py:217-243` with no `LIMIT` clause in its query).

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

### OPT-42 — Add index for `signal_definitions`'s actual filter/sort shape (optional, low priority)

**Status:** ⬜ OPEN — verified 2026-08-05 (no `idx_signal_definitions_org_enabled_created` or equivalent partial index in any `db_migrations/versions/` file; the `enabled = TRUE` query shape in `signals/investigator.py` is unchanged).

- **Source:** `02-db-queries.md` F8 — LOW/minor (L500-514).
- **Description:** `signal_definitions` has only a primary key on `id`; a
  later migration adds `(org_id, template_id)`, which doesn't cover the
  actual query shape used in `investigator.py`:
  `WHERE org_id = $1 AND enabled = TRUE [AND id = $2] ORDER BY created_at
  ASC LIMIT 20`. Low priority because rows are created manually/rarely,
  per-org counts are small, and the query is already `LIMIT 20`-bounded.
- **Fix:** `CREATE INDEX idx_signal_definitions_org_enabled_created ON
  signal_definitions (org_id, created_at ASC) WHERE enabled = TRUE`.
  Recommended to bundle into other index migration work rather than
  shipping alone.
- **Impact:** Not quantified; explicitly framed as low blast radius.
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `signal_definitions (table)`, `investigator.py`

---

### OPT-43 — Dedupe two separate `get_settings()` calls in `search()`

**Status:** ⬜ OPEN — verified 2026-08-05 (still two settings fetches per `search()` invocation: `get_settings()` at `search_service.py:395` and the aliased `_gs()` at `:463` — the second site was rewritten by d929604c (typesense_search_cutoff_ms) using a local `from eden.config import get_settings as _gs` import, not deduplicated; note the file lives at `src/eden/observability/search_service.py`).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (no `min(limit, N)`-style clamp inside `src/eden/issues/repo.py` — `list_stumbles` at `:149`, `list_issues` at `:270`; unchanged, and still explicitly a CUT/defensive-only item).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`cache_discount` appears nowhere in `src/eden`; the `UsageStats` construction in `llm/client.py` (~`:629`) is unchanged).

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

**Status:** ⬜ OPEN — verified 2026-08-05 (the comment block at `agent.py:1462-1466` still reads "single biggest line item in the agent budget", and the `_is_anthropic_model` branch it justifies is still at `:1470`).

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

### FEAT-115 — Add "Annotate" action button to trace detail page

**Status:** ⬜ OPEN — verified 2026-08-05 (`api.annotateTrace` binding still at `resources.ts:1878` with zero UI callers — a portal-wide grep for "annotat" matches only `resources.ts`; no Annotate action exists on the trace detail page, including in the new Transcript v2 action bar from c9c49f13).

**Source:** `08-annotation-labeling.md`, §6c.5, §7 item 2, §6d (citing `api.annotateTrace()` in `resources.ts:1878-1892`).

**Description:** Add an "Annotate" action on the trace detail page calling the already-existing `api.annotateTrace()` binding.

**Why it matters:** Explicitly called out as the "cheapest single win, all pieces already exist" and the doc's recommended first shipping item.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `clients/portal/src/lib/api/resources.ts`

---

### FEAT-119 — Add "needs another reviewer" filter + manual escalate button to IAA dashboard

**Status:** ⬜ OPEN — verified 2026-08-05 (zero "escalate" hits in `src/eden/evaluation/labeling.py` and `src/eden/api/routes/labeling.py`; no threshold-filter or `annotations_required`-bump mechanics exist, and no annotation UI has shipped).

**Source:** `08-annotation-labeling.md`, §6c.4, §4, Phase 3 Verdict 6.

**Description:** Add a filter for items where `per_item[id].agreement < threshold` and `annotation_count < annotations_required` (Label Studio's auto-reassignment candidates). Add a manual "escalate" button that bumps `annotations_required` by 1 and re-surfaces the item in `pop()`. Explicitly scoped as a manual UI affordance, not a new automated escalation engine — eden already has every backend piece needed except the threshold check and the bump itself.

**Why it matters:** The one genuinely automated disagreement-resolution mechanism found across all three competitor platforms researched; the lightweight manual version captures most of that value without building a full automated escalation engine.

**Severity:** Medium.
**Effort:** Small-Medium.
**Confidence:** High.

**Files touched:** `src/eden/evaluation/labeling.py`, `src/eden/api/routes/labeling.py`
**Depends on:** FEAT-112

---

### FEAT-124 — Keep `/gateway/v1` honest as a single-upstream pass-through — do not rebuild routing on top of it

**Status:** ⬜ OPEN — verified 2026-08-05 (guidance/guard-rail point, not yet actioned: `api/routes/gateway.py` still instantiates the dormant `AIGateway` (`:332` — see BUG-36-50 item 15) with an empty provider registry, so the honest-scoping cleanup remains coupled to the FEAT-137 deletion).

**Source:** `10-model-gateway.md` — `/gateway/v1` assessment section.

**Description:** `/gateway/v1` is real and working today, but only as a single-upstream pass-through (not a multi-provider router). The recommendation is explicit: keep it scoped to what it actually does rather than layering `AIGateway`-style routing ambitions onto it. Any product copy or roadmap language implying `/gateway/v1` does multi-provider routing/failover should be corrected to match reality.

**Why it matters:** Prevents scope creep into a market segment (routing/failover-as-a-service) eden has already decided not to compete in (see #137), and prevents customer-facing overpromising about what the endpoint does.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** High.

**Files touched:** `/gateway/v1` (`src/eden/api/routes/gateway.py`)
**Depends on:** FEAT-137

---

### FEAT-135 — Fix or consolidate the Detectors tab's disconnected NL alert-creation flow

**Status:** ⬜ OPEN — verified 2026-08-05 (`clients/portal/src/app/(portal)/signals/signals-client.tsx`: zero hits for channel/slack/pagerduty/webhook/destination, and no references to `nl_alert_rules`/`AlertCompiler` — the flow remains disconnected from the working NL-alert pipeline).

**Source:** `04-alerting-oncall.md`, "User Experience & Value," flow #1 of three incompatible flows (citing `signals-client.tsx`, `CreateSignalDialog`).

**Description:** The Detectors tab's NL prompt is a third, separate "create a rule" flow using a completely different backend (an OpenRouter-backed Next.js route) than the working NL-alert pipeline, and produces a draft with no notification-destination field of any kind (grep for channel/slack/pagerduty/webhook/destination returns zero hits). **Fix:** either wire this flow into the working `AlertCompiler`/`nl_alert_rules` pipeline or deprecate it in favor of the unified authoring surface.

**Why it matters:** A prospective customer testing "can I tell eden to alert me on X" hits a free-text box that doesn't route anywhere at all.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `clients/portal/src/app/(portal)/signals/signals-client.tsx`, `dsl/alerts.py`, `nl_alert_rules`

---

### FEAT-143 — Add dedup to topic clustering output

**Status:** ⬜ OPEN — verified 2026-08-05 (no dedup logic in `src/eden/observability/patterns_clusterer.py` — note corrected path, same as FEAT-142).

**Source:** `14-user-request-mining.md` — User Experience & Value section, missing capabilities list.

**Description:** The current clustering output has no deduplication — implying either duplicate clusters can appear across runs, or near-duplicate underlying traces/requests aren't collapsed within a cluster. **Fix:** add dedup logic (e.g., cluster-identity persistence across runs, or duplicate-trace collapsing within a cluster) matching the specific gap the source doc identifies.

**Why it matters:** Without dedup, users reviewing topic output may see redundant or fragmented views of what's actually a single underlying issue/request pattern, making the feature harder to act on and eroding trust in cluster counts as a genuine volume signal.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `src/eden/observability/patterns_clusterer.py`

---

### FEAT-150 — Correct roadmap/product narrative away from "build eden's own multi-provider gateway"

**Status:** ⬜ OPEN — verified 2026-08-05 (the prerequisite `AIGateway` deletion (FEAT-137) has not happened, so no narrative correction has been recorded either. Scope note: a repo-wide grep of `docs/specs` outside the strategic review finds no doc currently pitching a multi-provider gateway as a strategic bet, so the remaining work may reduce to a confirm-and-close sweep of pitch/planning materials during FEAT-137).

**Source:** `10-model-gateway.md` — overall verdict framing, competitive landscape section.

**Description:** Given the DELETE verdict on `AIGateway` (#137) and the crowded, well-capitalized competitive landscape (Portkey/Palo Alto Networks, OpenRouter, LiteLLM), any existing roadmap items, pitch materials, or internal planning docs that describe eden building its own multi-provider LLM gateway/router as a strategic bet should be revised or removed. This is a documentation/planning hygiene action distinct from the code deletion itself.

**Why it matters:** Prevents future engineering time being allocated toward rebuilding what was just decided against, and keeps external-facing/investor-facing narrative consistent with actual product direction.

**Severity:** Medium.
**Effort:** Small.
**Confidence:** Medium — the doc's verdict clearly implies this, but it's an inferred follow-on action rather than something the source explicitly instructs as a checklist item.

**Files touched:** _(none listed)_
**Depends on:** FEAT-137

---

## Wave 13

**19 points** (5 bugs, 10 optimizations, 4 features) — severity mix: 2 Medium, 17 Low. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 12 or earlier.

**Status as of 2026-08-05:** 19 remaining (0 partial, 19 open).

### BUG-27 — Fix `list_datasets`/`list_experiments` MCP tools' silently-ignored `limit` filter

**Status:** ⬜ OPEN — verified 2026-08-05 (`tools.py` still sends `params={"limit": limit}` at :388/:402; neither `list_datasets` (`datasets_hub.py:71`) nor `list_offline_experiments` (`experiments_offline.py:34`) declares a `limit` param)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (bare `error` column still referenced in `_common.py`: SELECT projection `duration_ms, outcome, error, parent_span_id` in `_fetch_trace_events` (:127) and `AND (error IS NOT NULL OR outcome = 'error')` in `_fetch_failed_traces_in_window` (:204))

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
**Depends on:** BUG-31

---

### BUG-33 — Add `agent_id` to the RCA causal-chain output

**Status:** ⬜ OPEN — verified 2026-08-05 (`grep agent_id src/eden/api/routes/intelligence_rca.py` returns zero matches; `_build_causal_chain` (:80) and `rca_chain` (:127) unchanged)

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

### BUG-51-54 — Dead portal (frontend) code: delete ~34 zero-importer exports across 4 groups

**Status:** ⬜ OPEN — verified 2026-08-05 (spot-checked 21 of the listed exports — `DebuggerNotesView`, `TraceTimelineMock`, `useOnline`, `useUrlState`, `U20_CORE_AXE_ROUTES`, `WAVE12_LOOP_ROUTES`, `AbStatusChip`, `MarketingPage`, `GRADE_LABELS`, `ROLE_LABELS`, etc.; every one still exists and is referenced only by its own defining file — `TraceTimelineMock` by 2 files: definition + its dead re-export shim, as described)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`BulkActionBar` still claimed at `SOTA-WAVE-TRACKER.md:49,50,301` and still zero matches in portal source; sibling fabricated names confirmed at all cited doc lines; `OPTIMIZATION-ID-CHECKLIST.md` K36/K37 rows still say DONE; `sdk/go`/`sdk/rust` deletion still staged, not committed)

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

### OPT-36 — Instrument and verify actual prompt-cache hit rate against live production traffic

**Status:** ⬜ OPEN — verified 2026-08-05 (no `cache_discount` capture anywhere in the repo, so prerequisites OPT-35/OPT-45 have not landed; `src/eden/llm/client.py` has only the pre-existing `cache_reads`/`_cache_hits` accounting, present since the initial commit)

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
**Depends on:** OPT-35, OPT-45

---

### OPT-49 — Memoize `IssueRow` and replace inline closure with a stable callback

**Status:** ⬜ OPEN — verified 2026-08-05 (`function IssueRow` at `issues-client.tsx:79` is still unmemoized and the map call site still passes `onSelect={() => selectIssue(issue.id)}` (:709))

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

### OPT-50 — Virtualize the signals list and memoize `SignalRow`

**Status:** ⬜ OPEN — verified 2026-08-05 (`{filtered.map(...)}` still at `signals-client.tsx:862`; `function SignalRow` (:55) still unmemoized; no `useVirtualizer` in the file)

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

### OPT-51 — Virtualize the automations panel list and memoize `AutomationRow`

**Status:** ⬜ OPEN — verified 2026-08-05 (`{automations.map(...)}` still at `automations-panel.tsx:489`; `function AutomationRow` (:51) still unmemoized; no `useVirtualizer` in the file)

- **Source:** `04-frontend-perf.md` "A fourth instance" (L26).
- **Description:** `automations-panel.tsx:489` renders
  `{automations.map(...)}` unvirtualized and unmemoized. Backend
  `GET /automations` caps at `limit: Query(100, ge=1, le=100)`,
  hard-capped again in `AutomationsEngine.list_automations`.
- **Fix:** Same `useVirtualizer` + `memo` reuse.
- **Impact:** Not separately quantified beyond the 100-row cap; doc notes
  "automations are typically small, admin-configured lists in practice."
- **Severity:** Low ("noted for completeness, not urgent").
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `clients/portal/src/app/(portal)/signals/automations-panel.tsx`, `AutomationsEngine (list_automations)`

---

### OPT-52 — Fix `retention_cron`'s unwatermarked cold-archive candidate-selection query

**Status:** ⬜ OPEN — verified 2026-08-05 (`SELECT DISTINCT tenant_id FROM telemetry_events` still at `retention_cron.py:178` with no `ORDER BY`; no `retention_archive_watermark` table or `fetch_stale_candidates` helper exists yet)

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
**Depends on:** OPT-3

---

### OPT-53 — Add `ORDER BY` to `shadow_outcome_join`'s candidate query

**Status:** ⬜ OPEN — verified 2026-08-05 (`shadow_outcomes.py` still has `LIMIT $1` at :41 with no `ORDER BY` anywhere in the file)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`OFFSET $4` still at `backfill.py:212`; no keyset `trace_id >` comparison in the file)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (the only `settings: backoffLimit: 3` block in `northflank.yml` (:622-623) belongs to `eden-worker`; the `eden-cron` job block (~:790 onward) still has no `settings:`/`backoffLimit` key)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (`RetentionPolicy("error_logs", 7, 30, 90, 90)` still present at `retention.py:57`)

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

### OPT-61 — File a follow-up ticket to make RCA/signal-investigator routes tier-aware

**Status:** ⬜ OPEN — verified 2026-08-05 (`grep -c 'warm_days|cold_tier|tier'` returns 0 for both `intelligence_rca.py` and `signal_investigator.py`)

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

**Status:** ⬜ OPEN — verified 2026-08-05 (backend `GET /orgs/{org_id}/labeling/export` exists — `export` handler in `src/eden/api/routes/labeling.py` (:364) delegating to `LabelingService.export` (`src/eden/evaluation/labeling.py:816`) — but `labelingApi` in `clients/portal/src/lib/api/resources.ts` has no `exportJsonl` binding and no portal code references `/labeling/export`; prerequisite FEAT-112 has not landed)

**Source:** `08-annotation-labeling.md`, §6c.6 (citing `src/eden/evaluation/labeling.py:816-861`).

**Description:** Add a button hitting the `exportJsonl()` binding (see #112) to emit JSONL of completed labels. The backend half already exists: `GET /orgs/{org_id}/labeling/export` (route handler `export` in `src/eden/api/routes/labeling.py`, backed by `LabelingService.export` in `src/eden/evaluation/labeling.py`) returns JSONL of approved labels with `status`/`limit` filters. What's missing is entirely client-side: (1) the `exportJsonl` method on `labelingApi` in `clients/portal/src/lib/api/resources.ts` (FEAT-112), and (2) a button in the labeling UI that triggers it and downloads the result.

**Why it matters:** Enables the "ML engineer building eval sets" persona to pull labeled items to seed golden datasets or fine-tune an LLM-judge without needing an engineer to run a script.

**Severity:** Medium (normalized from "Low-Medium" in source doc).
**Effort:** Small.
**Confidence:** High.

**Files touched:** `src/eden/api/routes/labeling.py`, `clients/portal/src/lib/api/resources.ts`
**Depends on:** FEAT-112

---

### FEAT-166 — Fix or rename `prompt_versioning.run_auto_eval` to stop misrepresenting what it does

**Status:** ⬜ OPEN — verified 2026-08-05 (`run_auto_eval` in `src/eden/services/prompt_versioning.py` still INSERTs `dataset_id` into `prompt_eval_runs` and then calls `_llm_score(org_id, prompt_version_id)` without ever reading the dataset back; `_llm_score` still scores template text only)

**Source:** `02-evals-datasets.md`, §5 P2 item 11, §3l (citing `run_auto_eval` and `_llm_score` in `services/prompt_versioning.py`).
**Description:** `run_auto_eval` accepts and stores a `dataset_id` on a `prompt_eval_runs` row but never reads it back inside the function; `_llm_score` scores the prompt *template text* for clarity/specificity, not any dataset output. Fix: either fetch the referenced `dataset_id`'s items and run them through the now-fixed F51 path (post 02-1–02-3), or rename the function/columns to reflect that it is prompt-text linting, not a dataset eval.
**Why it matters:** As named/schema'd today, this function is misleading — it looks like it evaluates against a dataset but doesn't, which risks engineers building on a false assumption about what "auto eval" means in this codepath.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `src/eden/services/prompt_versioning.py`, `prompt_eval_runs`

---

### FEAT-167 — Add a `split` column to `dataset_items` for eval subsetting

**Status:** ⬜ OPEN — verified 2026-08-05 (no `split` column in any `dataset_items` migration under `src/eden/db_migrations/versions/` — the table's home migration is `101_eval_loop.py` — nor anywhere else in the schema)

**Source:** `02-evals-datasets.md`, §1 "Competitive baseline" (dataset versioning subsection, citing LangSmith's `split` field; `dataset_items` schema).
**Description:** LangSmith's dataset examples carry a `split` field (string or array) for organizing eval subsets (e.g., "smoke" vs. "full regression") — a lighter-weight mechanism than full version-pinning. Eden's `dataset_items` has no equivalent column. Fix: add a `split` column to `dataset_items` (new migration under `src/eden/db_migrations/versions/`) to support dataset-defined eval subsets.
**Why it matters:** Explicitly flagged in the source doc as "a real, small, low-risk gap" — closes a specific, named competitive gap against LangSmith with minimal engineering cost.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `dataset_items` (migration in `src/eden/db_migrations/versions/`)

---

### FEAT-168 — Reduce redundant entry points between `/evals?mode=playground` and the standalone `/playgrounds` route

**Status:** ⬜ OPEN — verified 2026-08-05 (both entry points still exist: `clients/portal/src/app/(portal)/evals/page.tsx` still wires a `playground` mode via `playgroundApi`/`evals-playground-view`, and the standalone `clients/portal/src/app/(portal)/playgrounds/` route directory is still present)

**Source:** `02-evals-datasets.md`, §6 "User Experience & Value → What would make it more usable/adoptable" (citing `evals/page.tsx`, standalone `/playgrounds` + `/playgrounds/[id]` routes).
**Description:** `/evals`'s `playground` mode and the standalone `/playgrounds` + `/playgrounds/[id]` route both front the same `playgroundApi`, giving a new user two different starting points for overlapping functionality. Fix: confirm/establish one canonical link path (e.g., from an agent's detail view) so users land on a single entry point rather than the redundant one.
**Why it matters:** Reduces new-user confusion about which of two UI paths is "the" way to use the playground feature — a navigation/IA clarity fix.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `clients/portal/src/app/(portal)/evals/page.tsx`, `clients/portal/src/app/(portal)/playgrounds/`

---
## Wave 14

**18 points** (1 bugs, 2 optimizations, 15 features) — severity mix: 2 Medium, 16 Low. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 13 or earlier.
**Status as of 2026-08-05:** 18 remaining (0 partial, 18 open).

### BUG-28 — Ship the `live` parameter fix for `rerun_debugger`/`checkpoint_rerun` MCP tools

**Status:** ⬜ OPEN — verified 2026-08-05 (the MCP chain plumbs `live_prefix` but still has no `live` parameter anywhere — Protocol `client.py:37`, `HttpEdenClient.rerun_debugger` `client.py:245`, both `tools.py` wrappers, `server.py` schemas — so `RerunRequest.live` is never populated and the `live_gateway` branch remains unreachable from MCP).

**Source:** `bugs/03-api-mcp-contracts.md` §0a

**Description:** Both MCP tools funnel through the same `HttpEdenClient.rerun_debugger` choke
point (`client.py:245`, `rerun_debugger`), none of which — nor the Protocol (`client.py:37`) nor either
`tools.py` wrapper (`rerun_debugger` at `:45`, `checkpoint_rerun` at `:470`) — has a `live` parameter, even though `RerunRequest`
(`api/routes/debugger.py:60`, `live: bool` field at `:74`) has a real `live: bool = False` field that's the only way to reach the
`live_gateway` branch (`rerun_traced` sets `rerun_mode = "live_gateway"` only `if body.live`). It's simply never populated from MCP — the live-rerun gateway path has
never worked for any MCP caller since it shipped. The doc includes an exact, already-specified
4-file diff (Protocol + `HttpEdenClient` + both `tools.py` wrappers + both `server.py` schemas,
~6 lines) — see the source doc for the literal patch. `checkpoint_rerun` (added in the most
recent `mcp_server`-touching commit, `64233475`) shipped with the identical gap, showing the
defect is actively spreading to new call sites, not just aging debt. **Fix:** apply the
already-specified 4-file diff; default `checkpoint_rerun`'s new `live` param to `False` (not
`True`) to avoid silently billing/invoking a real model on an unqualified call.

**Verification note (2026-08-05):** `live_prefix` (cached-prefix + live tail, F01
`cached_live` mode) IS now plumbed through the whole MCP chain, and `HttpEdenClient` also
sends a `rerun_mode` body key — but `RerunRequest` declares no `rerun_mode` field, so Pydantic
silently drops it; neither addition reaches the `live_gateway` branch. The described defect
fully persists.

**Blast radius:** MCP surface only, soft-retired, zero internal callers — but worth noting the
defect is actively spreading to new tools as they're added, so leaving it unfixed compounds the
future cleanup cost.
**Severity:** Low (per current live blast radius) — flagged as worth fixing specifically because
it's cheap and spreading.
**Effort:** Small — diff already fully specified in the source doc (4 files, ~6 lines). **QUICK
WIN** (low severity but essentially free to fix, with a ready-made patch).
**Confidence:** High.

**Files touched:** `src/eden/mcp_server/client.py`, `src/eden/mcp_server/tools.py`, `src/eden/mcp_server/server.py`

---

### OPT-56 — Fix stale/incorrect docstrings in `cron_tick.py` and `retention_cron.py`

**Status:** ⬜ OPEN — verified 2026-08-05 (both docstrings unchanged: `cron_tick.py` still lists "EQL alert watchdog" and "N23 improvement sweeps" steps its own `run_maintenance_due` docstring says are skipped; `retention_cron.py` still claims Northflank `0 2 * * *` and "all 7 retention policies" while `DEFAULT_POLICIES` has 8).

- **Source:** `05-cron-jobs.md` "Correction to the deployment/scope
  framing" (L42-53, 73-89).
- **Description:** `cron_tick.py`'s module docstring is wrong on two of
  three claims: it claims the tick includes an "EQL alert watchdog +
  columnar compaction" step and runs "N23 improvement sweeps when org
  schedule is due" — the EQL-watchdog and N23-sweeps claims are false
  (`run_maintenance_due`'s own docstring: "Skips EQL watchdog, artifact
  demotion, and improvement sweeps — those are hosted separately on
  ``eden-worker`` or intentionally off"). *Correction to the original
  finding:* the columnar-compaction half is now true — the tick does run
  an hourly `_run_columnar_compaction` step — so only the EQL-watchdog and
  N23 wording needs fixing. `retention_cron.py`'s module docstring claims
  "Northflank: a daily scheduled job (cron: `0 2 * * *`)" — stale, since
  the daily retention run actually fires at `now.hour == 3` via
  `_run_daily` inside `run_maintenance_due` in `cron_tick.py`, not via a
  real Northflank cron; and elsewhere claims
  "Runs all 7 retention policies" when `DEFAULT_POLICIES` has had 8
  entries since the file was introduced (cosmetic; doesn't affect behavior
  since the code iterates `retention.policies`, not a hardcoded count).
- **Fix:** One-line doc-comment corrections in both files.
- **Impact:** N/A — documentation-only.
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `src/eden/workers/cron_tick.py`, `src/eden/data_platform/retention_cron.py`

---

### OPT-58 — Remove the `derived_metrics` phantom retention-policy entry

**Status:** ⬜ OPEN — verified 2026-08-05 (`RetentionPolicy("derived_metrics", 7, 90, 2555, 2555)` still present in `DEFAULT_POLICIES`, `src/eden/data_platform/retention.py:53`).

- **Source:** `06-storage-retention.md`, same sections as item 57; fix
  table (L163).
- **Description:** Same defect class as item 57 — no table anywhere named
  or shaped like `derived_metrics`. Real analogs (`custom_metric_runs`,
  `telemetry_streaming_metrics`) were built later under different names
  and never reconciled back into `DEFAULT_POLICIES`.
- **Fix:** Remove outright, no follow-up.
- **Impact:** N/A.
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `src/eden/data_platform/retention.py`

---

### FEAT-133 — Add edit/delete/toggle (lifecycle management) to the Automations engine

**Status:** ⬜ OPEN — verified 2026-08-05 (`AutomationsEngine` still exposes only `list_automations`/`create`/`on_score` plus private helpers — no `update`/`delete`/`toggle`; `wave6_online.py` has only GET/POST `/automations` at :209/:217; `resources.ts:4388` comment confirms "Backend today exposes only GET/POST").

**Source:** `04-alerting-oncall.md`, §1 (citing `automations/engine.py`; `api/routes/wave6_online.py:209,217`; `resources.ts:4419-4434`).

**Description:** The Automations engine is create-only — no `update`, `delete`, or `toggle` method exists anywhere in the class. **Fix:** add update/delete/toggle endpoints and engine methods, plus corresponding UI controls.

**Why it matters:** A customer who saves an automation with a typo'd Slack channel or a dead webhook URL cannot fix it once saved — it can only be orphaned, not corrected.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `automations/engine.py`, `api/routes/wave6_online.py`, `resources.ts`

---

### FEAT-136 — Add concurrency/race-condition test coverage for `pop()`

**Status:** ⬜ OPEN — verified 2026-08-05 (zero `asyncio.gather` occurrences in `tests/unit/evaluation/test_labeling.py` (676 lines); `test_labeling_queues.py` still 15 lines — no concurrent-`pop()` or lease-race tests exist).

**Source:** `08-annotation-labeling.md`, §1 (citing `tests/unit/evaluation/test_labeling.py`, 676 lines/39 tests; `test_labeling_queues.py`, 15 lines/1 test).

**Description:** The test suite has zero tests that call `pop()` twice concurrently or simulate a lease race (no `asyncio.gather`, no multi-annotator contention test). **Fix:** add tests exercising concurrent `pop()` calls, lease contention, and related fail-open/rowcount gaps.

**Why it matters:** The doc identifies real concurrency bugs in `pop()` that this missing coverage would have caught; without tests, regressions in the lease/claim path will ship silently.

**Severity:** Medium.
**Effort:** Medium.
**Confidence:** High.

**Files touched:** `tests/unit/evaluation/test_labeling.py`, `test_labeling_queues.py`, `labeling.py`

---

### FEAT-169 — Stop fabricating `gen_ai.conversation.id` from the trace ID in the OTel exporter

**Status:** ⬜ OPEN — verified 2026-08-05 (`add("gen_ai.conversation.id", event.trace_id)` still present at `otel_exporter.py:264`; the class docstring at :215 even documents the fabrication).

**Source:** `05-multiagent-tracing.md` (citing `src/eden/observability/otel_exporter.py:264`, `_event_to_otlp_span`).
**Description:** `_event_to_otlp_span` does `add("gen_ai.conversation.id", event.trace_id)` — fabricating a conversation ID from the trace ID, which the OTel GenAI spec explicitly warns instrumentors not to do. Fix: only set the attribute when a real conversation id is present in `event.attributes`, otherwise omit it (and update the docstring bullet at `otel_exporter.py:215` that documents the fabricated mapping).
**Why it matters:** Sends non-compliant/misleading telemetry to customers' own OTel backends (Honeycomb/Datadog/Tempo) via the dual-emit exporter — any customer tooling grouping by `gen_ai.conversation.id` would incorrectly treat every span in a trace as one fabricated "conversation."
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `src/eden/observability/otel_exporter.py`

---

### FEAT-170 — Expose automation run history via the API

**Status:** ⬜ OPEN — verified 2026-08-05 (no `automation_runs` reference anywhere under `src/eden/api/routes/`; `automations-panel.tsx:145` still renders "Editing, enable/disable and run history aren't exposed by the API").

**Source:** `04-alerting-oncall.md`, §0(d) (citing `automations-panel.tsx:145-146`; `automation_runs` table).
**Description:** Automation executions are logged to an `automation_runs` table (via `AutomationsEngine._log_run`), but the UI doesn't expose it because the API doesn't return it yet. Fix: add an endpoint to surface `automation_runs` (natural home: the F61 automations block in `src/eden/api/routes/wave6_online.py`) and wire it into the Automations tab UI.
**Why it matters:** Without run history, once the underlying automation-trigger bugs are fixed, users still have no way to verify whether their automation actually fired/delivered.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `src/eden/api/routes/wave6_online.py`, `src/eden/automations/engine.py`, `clients/portal/src/app/(portal)/signals/automations-panel.tsx` *(correction: `automation_runs` is a table, not a file — the endpoint work lands in the route/engine files listed)*

---

### FEAT-171 — Resolve two more orphaned budget-status endpoints reading a dead Redis pipeline

**Status:** ⬜ OPEN — verified 2026-08-05 (`routes/cost.py` `/cost/comparison` still reads the CostTracker-written Redis hash per its own docstring; `optimization.py` `GET /budget` at :589 still reads Redis via `get_redis_client()`; no rewire or removal has landed).

**Source:** `06-cost-governance.md`, §2d.5 (citing `routes/cost.py`; `optimization.py:589-625,776`).
**Description:** `GET /orgs/{org_id}/cost/comparison` states in its own docstring that its source of truth is a Redis hash written by `CostTracker` — since `CostTracker.track()` is unreachable from live gateway traffic (same root cause underlying other 06-series findings), this endpoint returns `null` for any gateway-proxy-only org; its frontend wrapper has zero call sites. `GET /orgs/{org_id}/optimization/budget` reads the same dead Redis hash for spend; its frontend wrapper also has zero call sites. Neither is reachable from the shipped product today, confirming the "CostTracker/Redis never fed by live traffic" root cause has recurred across at least four backend budget-status computations, not two. Fix: either wire these into the live telemetry path alongside the primary fix, or remove the dead endpoints and frontend wrappers as unmaintained surface area.
**Why it matters:** Low current customer impact (not reachable today), but latent dead/broken surface area that will confuse future engineers and represents duplicated, uncoordinated budget-status logic that should be consolidated.
**Severity:** Low
**Effort:** Small
**Confidence:** Medium — the doc documents the existence and root cause clearly but does not itself prescribe a specific fix.

**Files touched:** `routes/cost.py`, `optimization.py`
**Depends on:** FEAT-20

---

### FEAT-172 — Build spend-anomaly detection (causal, same-day) as a future differentiation capability

**Status:** ⬜ OPEN — verified 2026-08-05 (no spend/cost anomaly detection exists; the only change-point detector in the codebase, `src/eden/predictive/cusum.py`, targets daily judge-score series for `QualityPredictor` — it could serve as a building block but nothing feeds it spend data).

**Source:** `06-cost-governance.md`, §3 Verdict item 4.
**Description:** Neither eden's customer-facing budget system nor its internal cost ledger does anything beyond static 50/80/100% threshold crossings. CloudZero's 2026 positioning frames same-day, causally-explained anomaly detection ("which team/workload caused this spike") as materially different from threshold alerting, and no LLM-native competitor (Portkey/Helicone/LiteLLM/OpenRouter) has this either. The doc explicitly does not scope this now, flagging it "as a candidate for a future pass" since it needs a baseline/expected-spend model, not just a comparator threshold.
**Why it matters:** A real, named competitive-differentiation opportunity, but explicitly deprioritized by the doc's own authors relative to the correctness/UI fixes above — should be tracked as backlog, not next-sprint work.
**Severity:** Low
**Effort:** Large
**Confidence:** High

**Files touched:** _(none listed)_

---

### FEAT-173 — Fix self-contradictory docstring in `api/routes/labeling.py`

**Status:** ⬜ OPEN — verified 2026-08-05 (module docstring still says "Six routes:" above a list of 8 bullets; the file has 15 `@router` decorators).

**Source:** `08-annotation-labeling.md`, §1 (citing `api/routes/labeling.py:1-13`).
**Description:** The module docstring literally says "Six routes" immediately above a list of 8 bullets, while the actual route count is 15. Fix: update the docstring to accurately describe all 15 routes the file exposes.
**Why it matters:** Misleading internal documentation slows down any engineer trying to understand the API surface before building the UI layer on top of it.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `api/routes/labeling.py`

---

### FEAT-177 — Resolve the inert `tool_call_inference_v1` flag

**Status:** ⬜ OPEN — verified 2026-08-05 (flag still defined default-off in `src/eden/config.py` (`tool_call_inference_v1: bool = False`) and still gates persistence in `src/eden/learning/tool_call_calibrator.py`, which bails with reason `"tool_call_inference_v1_off"` at two call sites; nothing in the repo enables it).

**Source:** `08-annotation-labeling.md`, §7 item 6.
**Description:** Listed as an "unchanged, orthogonal" recommendation item — the doc names this flag but does not describe its current behavior or a specific fix within this document (relates to F21 territory). *Concrete current state (verified):* the flag is declared in `src/eden/config.py` with default `False`, and `src/eden/learning/tool_call_calibrator.py` checks it twice, skipping persistence and returning `{"persisted": False, "reason": "tool_call_inference_v1_off"}` when off. "Inert" = the calibrator computes metrics but can never persist them in any shipped configuration. Fix: decide whether to enable the flag (flipping the default or wiring per-org config) or delete the flag and the dead persistence path.
**Why it matters:** Flagged as lingering config/tech debt worth cleaning up, though the doc gives no detail on user/product impact.
**Severity:** Low
**Effort:** Small
**Confidence:** Medium — named as an action item but no supporting detail on what "inert" means or the concrete fix.

**Files touched:** `src/eden/config.py`, `src/eden/learning/tool_call_calibrator.py`

---

### FEAT-178 — Extend Python monkey-patch auto-instrumentation coverage / keep it current

**Status:** ⬜ OPEN — verified 2026-08-05 (`sdk/python/eden_sdk/instrumentations/__init__.py` `__all__` still lists exactly 13 frameworks — anthropic, autogen, bedrock, cohere, crewai, gemini, groq, langchain, llama_index, mastra, mistral, openai, pydantic_ai — and no framework-addition process/checklist exists; note the 2026-08-05 Go/Rust SDK deletion leaves Python + TS as the only SDKs, which slightly raises this point's relative weight).

**Source:** `features/09-sdk-dx.md` — Python auto-instrumentation, 13-framework list.
**Description:** Python's `eden.instrument()` (`sdk/python/eden_sdk/__init__.py`, `instrument()`) currently covers 13 frameworks via class-level monkey-patching. The doc implies this list needs to be treated as a living target (new frameworks/SDKs emerge frequently in the LLM app space) rather than a one-time build. Fix: establish a lightweight process/checklist for adding new framework support as they gain adoption, so Python's advantage over TS doesn't quietly erode as the ecosystem shifts.
**Why it matters:** Auto-instrumentation coverage is a moving target; a framework list that goes stale silently degrades the "just works" promise for any user on a newer/less-common stack.
**Severity:** Low
**Effort:** Medium
**Confidence:** Medium — this is an inferred forward-looking recommendation rather than a specific bug the source doc pins to a line/behavior.

**Files touched:** `sdk/python/eden_sdk/instrumentations/`

---

### FEAT-179 — Add export capability for topic clustering results

**Status:** ⬜ OPEN — verified 2026-08-05 (no export/CSV anywhere in the read surface: `api/routes/patterns.py` exposes only GET list + GET `/{pattern_id}`, `api/routes/topics.py` only GET list + POST `/generate` and a topic-action route; `patterns_clusterer.py` has no export path).

**Source:** `features/14-user-request-mining.md` — User Experience & Value section, missing capabilities list.
**Description:** There is currently no way to export topic/cluster results (e.g., to CSV, or to another system) from F65. Fix: add an export endpoint/button (likely alongside the portal UI work for the topics/patterns clusterer) allowing results to be pulled out of eden for use elsewhere (reporting, sharing with product/support teams who may not have portal access).
**Why it matters:** Export is a common, low-effort, high-leverage feature for analytics/discovery tools — many teams' actual workflow for using this kind of data (sharing with stakeholders, feeding into other tools) requires getting the data out of the product, not just viewing it in-app.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `src/eden/api/routes/patterns.py`, `src/eden/api/routes/topics.py`, `patterns_clusterer.py`

---

### FEAT-181 — Position F65 explicitly against the competitor "user request mining" category in product messaging

**Status:** ⬜ OPEN — verified 2026-08-05 (non-code/product-marketing item; its precondition — a shipped topics/patterns portal UI — is also still unmet: no topics or patterns page exists under `clients/portal/src/app/(portal)/`).

**Source:** `features/14-user-request-mining.md` — overall doc framing (competitor research + F65 as eden's analog).
**Description:** Given the bulk of the source doc is competitor market research (Langfuse/Arize/Helicone/LangSmith issue-mining features, HN skepticism threads on AI-fix reliability) establishing this as a real, validated product category, and given eden already has a working (if UI-less) analog in F65, there's a product-positioning action once a portal UI ships: explicitly message F65 as eden's answer to this category rather than leaving it undiscovered/unmarketed.
**Why it matters:** eden has already done the hard engineering work (HDBSCAN clustering) that competitors charge for as a distinct feature category — once the UI gap closes, capturing the positioning value requires deliberate messaging, not just shipping the UI silently.
**Severity:** Low
**Effort:** Small
**Confidence:** Medium — this is a reasonable product-marketing inference from the doc's framing, not an explicit build instruction in the source.

**Files touched:** _(none listed)_

---

### FEAT-182 — Incorporate the HN AI-fix-skepticism findings into how any auto-fix-suggestion UI is framed

**Status:** ⬜ OPEN — verified 2026-08-05 (design-guidance item for a not-yet-built UI; the topics/patterns portal UI it would apply to still does not exist).

**Source:** `features/14-user-request-mining.md` — competitor research section, HN threads on AI-fix skepticism.
**Description:** The doc's research surfaces real user skepticism (from HN threads) about AI-generated fix suggestions in this product category — implying that if/when eden's topic-mining UI (14-1) or related features (e.g., the autonomous patch/merge/revert loop) present AI-suggested fixes to users, framing/trust-building (e.g., showing confidence, evidence, or requiring explicit human review before action) matters more than raw AI-fix capability, per the researched market sentiment.
**Why it matters:** Building a feature that presents AI-generated fixes without accounting for documented user skepticism about this exact category risks lower adoption/trust even if the underlying suggestions are technically good — this is a UX-framing lesson from competitor research that should inform the design, not just its existence.
**Severity:** Low
**Effort:** Small
**Confidence:** Low — this is a speculative, indirect inference connecting competitor market research to a design recommendation for a not-yet-built UI; the source doc presents the research but doesn't explicitly prescribe this as a design mandate.

**Files touched:** _(none listed)_

---

### FEAT-183 — Build an MCP tool for Artifacts/Ledger/Book

**Status:** ⬜ OPEN — verified 2026-08-05 (no artifact/ledger/book tool anywhere in `src/eden/mcp_server/server.py`; the Book system exists at `src/eden/kb/book/`, and the cited MCP precedent — checkpoint re-run + transcript tools, commit `64233475` — is confirmed).

**Source:** `features/15-artifacts-behavior-record.md` — feature gap section.
**Description:** There is currently no MCP (Model Context Protocol) tool exposing the Artifacts/Book/Ledger system, meaning it can't be accessed/queried by MCP-compatible agent tooling. Fix: build an MCP tool surfacing read (and potentially write) access to this system, consistent with how eden exposes other functionality via MCP elsewhere (the doc references an existing MCP checkpoint/transcript tooling precedent from recent commits).
**Why it matters:** MCP tool support is increasingly the standard interface for agent tooling to access product context programmatically; without it, the Artifacts/Ledger system can only be used through the (currently also broken/stubbed) portal UI or direct API — missing a distribution channel that's become table-stakes for this category of feature.
**Severity:** Low
**Effort:** Medium
**Confidence:** Medium — the specific existence of an MCP precedent is confirmed context, but the priority/necessity of an MCP tool specifically for this feature is a reasonable but not explicitly emphasized recommendation in the source.

**Files touched:** `src/eden/mcp_server/` (new tool), `src/eden/kb/book/`

---

### FEAT-184 — Audit for other DTOs/fields with the same hardcoded-stub pattern as `relatedSignalId`

**Status:** ⬜ OPEN — verified 2026-08-05 (the anchor instance persists: `relatedSignalId: str | None = None` declared in `src/eden/api/portal_contracts.py:166` and hardcoded `relatedSignalId=None` in the issue-card build in `src/eden/api/routes/portal.py`; no audit of sibling DTO fields has landed).

**Source:** `features/16-issue-extraction-online-evals.md` — DTO bug section (pattern-level implication).
**Description:** Since `IssueCard.relatedSignalId` was found hardcoded to `None` despite apparently being intended to carry real data (16-3), there's a reasonable chance other DTO fields in the issue-extraction/eval pipeline have similar stub-not-yet-wired patterns. Fix: review `IssueCard` and related DTOs for other fields that may be silently stubbed rather than fully wired.
**Why it matters:** The same class of bug (a DTO field silently hardcoded rather than genuinely populated) is easy to miss during code review since it type-checks and "works" (just always returns a default) — worth a broader pass once one instance is confirmed.
**Severity:** Low
**Effort:** Small
**Confidence:** Low — inferred audit suggestion from a single confirmed instance, not a specific additional finding in the source.

**Files touched:** `src/eden/api/portal_contracts.py`, `src/eden/api/routes/portal.py`

---

### FEAT-185 — Correct or remove the misleading code comment in `IssuePromoter._update`

**Status:** ⬜ OPEN — verified 2026-08-05 (the misleading comment survives at `src/eden/issues/models.py:59` — "IssuePromoter may bump this based on blast radius" — while `_update` still computes `new_severity = _more_severe(existing["severity"], severity)` from static per-kind defaults and never reads `user_count`/`stumble_count`/`repetition_count`).

**Source:** `features/16-issue-extraction-online-evals.md` — code-comment-vs-behavior mismatch (see also 16-2).
**Description:** Distinct from implementing the actual escalation logic (16-2), there's a lower-effort interim action: correct the false comment claiming severity escalation already happens, so engineers reading the code aren't misled in the meantime. *Location correction:* the comment lives on the `agent_issues.severity` field in `src/eden/issues/models.py` ("IssuePromoter may bump this based on blast radius", `:59`), not literally inside `IssuePromoter._update` — `_update` (in `src/eden/issues/issue_promoter.py`) only narrows toward the worse of two static per-kind default severities via `_more_severe` and never consults blast-radius fields.
**Why it matters:** Same rationale as the `patterns_clusterer.py` docstring fix (14-7) — a misleading comment actively misinforms anyone reading the code about current behavior, independent of when the real fix ships.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `src/eden/issues/models.py`

---

## Wave 15

**3 points** (0 bugs, 1 optimizations, 2 features) — severity mix: 3 Low. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 14 or earlier.
**Status as of 2026-08-05:** 3 remaining (0 partial, 3 open).

### OPT-59 — Implement real retention enforcement for `user_feedback`

**Status:** ⬜ OPEN — verified 2026-08-05 (`user_feedback` still in `DEFAULT_POLICIES` at `retention.py:54` with no dedicated dispatch branch — the only data-type branches are `debug_dumps` and `raw_traces`).

- **Source:** `06-storage-retention.md` fix table (L166), "Precise
  dispatch trace" (L101-126).
- **Description:** `user_feedback` has a real backing table but its
  policy (`7, 90, 2555, 2555`) currently no-ops silently for the same
  dead-`elif` reason as item 6 (2555 ≤ 90 is False). Existing configured
  values are already sane (7-year window); this is a low-urgency honesty
  fix, not a live growth risk.
- **Fix:** Add a real dedicated dispatch branch (mirroring `debug_dumps`):
  `elif policy.data_type == "user_feedback": DELETE FROM user_feedback
  WHERE created_at < $1`.
- **Impact:** N/A (7-year window rarely fires in practice; low urgency,
  but "should be honest" that the config lies about being enforced today).
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `src/eden/data_platform/retention.py`, `user_feedback (table)`

---

### FEAT-174 — Widen `annotate()` and related TS types to match backend response shapes

**Status:** ⬜ OPEN — verified 2026-08-05 (`labeling.annotate` at `resources.ts:3366` still types the body as `{ item_id: string; label: string; notes?: string }` — no `confidence?`, `time_spent_ms?`, or `skills_exercised?`; `LabelingItem`/`LabelingAnnotation` interfaces at :3340/:3350 remain narrower than the backend shapes).

**Source:** `08-annotation-labeling.md`, §6b (citing `resources.ts`).
**Description:** Widen the existing `annotate()` request body type to include `confidence?`, `time_spent_ms?`, `skills_exercised?`, and widen `LabelingItem`/`LabelingAnnotation` TS interfaces to fully match the backend's `ItemResponse`/`AnnotationResponse` shapes.
**Why it matters:** Without these fields typed, the frontend can't submit confidence scores, time-tracking, or skills data — all of which the backend data model already supports and several UX features (session counter, confidence shortcut) depend on.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `clients/portal/src/lib/api/resources.ts`

---

### FEAT-180 — Correct or update the `patterns_clusterer.py` docstring to match actual behavior

**Status:** ⬜ OPEN — verified 2026-08-05 (module docstring still claims "The clusterer runs as a background job (the FastAPI lifespan starts it...)" — but nothing in `api/app.py`'s lifespan starts it; the only invocation path is on-demand via `eden.topics.service.generate_topics` → `get_patterns_clusterer().run_once()`, reached from `POST /topics/generate`).

**Source:** `features/14-user-request-mining.md` — User Experience & Value section, scheduling gap (see also 14-2).
**Description:** Distinct from actually fixing the on-demand-only scheduling gap, there's a lower-effort interim/parallel action: the docstring itself currently makes a claim (background scheduling — "runs as a background job (the FastAPI lifespan starts it; it's idempotent and time-bounded)") that's false about current behavior, which is actively misleading to any engineer reading the code to understand what it does. Fix: update the docstring to accurately reflect current on-demand-only behavior (triggered by `POST /topics/generate` via `topics/service.py`), regardless of whether/when the scheduling fix ships.
**Why it matters:** Inaccurate docstrings actively mislead engineers making changes near this code, independent of the scheduling feature gap itself — this is a quick, low-risk correctness fix that should not wait on the larger feature work.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `src/eden/observability/patterns_clusterer.py`

---

## Wave 16

**3 points** (0 bugs, 1 optimizations, 2 features) — severity mix: 3 Low. All points in this wave touch disjoint file sets and have every prerequisite satisfied by Wave 15 or earlier.
**Status as of 2026-08-05:** 3 remaining (0 partial, 3 open).

### OPT-60 — Add a new retention policy + dispatch branch for `checkpoint_blobs` (defense-in-depth)

**Status:** ⬜ OPEN — verified 2026-08-05 (`checkpoint_blobs` still absent from `DEFAULT_POLICIES` in `retention.py`; the table is still read live in `api/routes/websocket.py` — three `FROM checkpoint_blobs` queries — so it remains not-fully-dead with no retention coverage).

- **Source:** `06-storage-retention.md` "checkpoint-blob retention gap"
  (L41-59), "Complete fix design" (L134-156).
- **Description:** `checkpoint_blobs` (migration 001) has no TTL column
  and is absent from `DEFAULT_POLICIES`. It is legacy — writes go through
  an upsert bounding growth per key, and
  `insert_checkpoint_blob`/`get_checkpoint_blob(s)`/
  `delete_checkpoint_blobs` have **zero production callers anywhere in
  `src/eden`** (only referenced in a mocked test fixture).
  `rewind.py:8-19` confirms this table "predates the trace_id naming
  convention" and is "read-only per the Phase 2 cutover." It is still read
  live via `websocket.py` (three `FROM checkpoint_blobs` queries in the
  live job-trace stream handlers), so it's not fully dead code.
- **Fix:** `RetentionPolicy("checkpoint_blobs", 7, 0, 0, 30)` with a
  dedicated dispatch branch — "cheap insurance against a not-yet-found
  write path."
- **Impact:** Not quantified (no confirmed active write path today, so
  growth is likely near-zero currently).
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

**Files touched:** `src/eden/data_platform/retention.py`, `checkpoint_blobs (table)`

---

### FEAT-175 — Add confidence-field keyboard shortcut (`Shift+1..5`)

**Status:** ⬜ OPEN — verified 2026-08-05 (no `shiftKey`-gated confidence handling anywhere in the portal's labeling/evals surface; blocked on FEAT-174 since `annotate()`'s request type at `resources.ts:3366` cannot yet carry `confidence`).

**Source:** `08-annotation-labeling.md`, §6c.3, §5a.
**Description:** Add a `Shift+1..5` keyboard shortcut for setting the `confidence` field, so setting confidence doesn't require reaching for the mouse.
**Why it matters:** Without it, confidence-setting is the one part of the annotate flow that breaks the keyboard-only flow state.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** `clients/portal/src/lib/api/resources.ts` + the portal annotate UI component
**Depends on:** FEAT-174

---

### FEAT-176 — Add session progress counter to annotate UI

**Status:** ⬜ OPEN — verified 2026-08-05 (no session counter / "labeled this session" element in the portal; the backend prerequisite holds — `time_spent_ms` is captured per-annotation in `labeling.py`).

**Source:** `08-annotation-labeling.md`, §6c.3 (citing `labeling.py:66-105`, `time_spent_ms`).
**Description:** Add a small persistent session counter ("N labeled this session, avg Xs/item") — a pure frontend read of `time_spent_ms`, already captured per-annotation server-side.
**Why it matters:** Keeps a reviewer in flow with a natural stopping point during long labeling sessions; no new backend work required.
**Severity:** Low
**Effort:** Small
**Confidence:** High

**Files touched:** portal annotate UI component (`clients/portal/src/...`) *(correction: this is a pure frontend change — `labeling.py` is the backend capture site cited as evidence, not a file this point touches)*
**Depends on:** FEAT-174

---
