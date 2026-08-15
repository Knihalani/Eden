# Eden Strategic Review — Consolidated, Ranked Action List

## What this is

This document consolidates every distinct, actionable finding from the four finalized
(pass-4/5) bug-review documents produced during the 2026-08 strategic review of Eden:

- `bugs/01-dead-code-stale-docs.md` — dead code (backend + portal) and stale tracking-doc claims
- `bugs/02-data-consistency.md` — agent-identity, status-enum, and data-consistency bugs
- `bugs/03-api-mcp-contracts.md` — API/MCP schema and contract mismatches
- `bugs/04-frontend-and-test-failures.md` — test-suite results, frontend runtime bugs, sweeps

Those four docs were each independently re-verified across 2-5 review passes (adversarial
re-checking of file:line citations, re-running greps/tests fresh, re-tracing reachability). This
document does not re-verify their findings from scratch; it takes their pass-4/5 conclusions —
including corrected severities — as reliable, extracts every independently-actionable point,
merges points that multiple source docs corroborated independently, and produces one global
ranking.

**59 distinct points** were extracted. Three points are explicitly cross-doc corroborations
(same underlying bug independently found by 2-3 docs, merged into one entry each, cited
accordingly) — see the Appendix for the full list of merges.

## Ranking methodology

Primary sort key: **severity/impact, weighted by *current, live* blast radius** — not
theoretical worst-case severity. Concretely this means:

- A technically-correct, well-evidenced bug sitting behind a **deleted frontend surface** (e.g.
  the `rcaApi` client was removed from the portal 3 days before this review) or a
  **soft-retired feature** (MCP: zero internal callers, HTTP transport off by default, its own
  onboarding doc marked `draft: true`) ranks **lower** than a live P0, even if the code defect
  itself is more severe in the abstract. Several source-doc severity corrections already apply
  this logic (documented inline, e.g. `bugs/02`'s Bug 3 was demoted from "worst finding" once its
  frontend caller was confirmed deleted; `bugs/03`'s MCP-only findings were downgraded P0→P1).
  This document inherits and applies that logic consistently across all four docs' findings, not
  just the ones the source docs already re-ranked.
- Frequency matters as much as consequence: a bug that fires on **every** relevant request (e.g.
  every trace page view) ranks above a bug that only fires under a narrower trigger condition
  (e.g. a stale JS chunk after a deploy), even if the narrower bug's failure mode is more
  dramatic once triggered.
- "Live" means: reachable today from the portal UI, a mounted REST route with a real caller, or
  an always-on backend pipeline (ingestion, scoring, triage) — as opposed to code that is
  implemented and even routed, but has zero current callers (deleted frontend, unmounted router,
  soft-retired protocol).

Secondary sort key: **confidence** (High/Medium/Low). Corroboration by 2+ independently-written
source docs is treated as a strong confidence signal and is called out explicitly.

**Effort** (Small/Medium/Large) is reported for every point but is not a ranking key — it's
prioritization context. Points that are both high-severity and small-effort are flagged
**QUICK WIN**.

## Tiers used below

**Critical** — live, high-frequency, and either a functional break of a core workflow or a
silent correctness/data-integrity failure visible to most/all users of the affected surface.
**High** — live and significant, but narrower in frequency, blast radius, or immediate
visibility than Critical.
**Medium** — live but low-frequency/narrow-trigger, or a real capability gap that doesn't
corrupt data or crash anything.
**Low** — either a real code bug with **no current live caller** (dead/retired surface), or a
pure dead-code/stale-documentation cleanup item.

---

## Ranked list

### #1 — Fix `TriageAgent`'s `UnboundLocalError` that crashes every successful (non-error) investigation

**Source:** `bugs/04-frontend-and-test-failures.md` §7b(i)

**Description:** `src/eden/issues/triage_agent.py:282` reads `if llm_error:` but `llm_error` is
only ever assigned in two places: `:266` (`llm_error = False`), which sits **after** a `return`
inside the `except TimeoutError:` block and is therefore dead/unreachable, and `:270`
(`llm_error = True`) inside `except Exception as exc:`. There is no assignment on the normal
success path. `git blame` traces both additions to commit `ab490f2a1` ("make two silent
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

---

### #2 — Fix the portal trace-status badge that renders `timeout`/`crash` traces as green "ok"

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

---

### #3 — Reject (don't silently coerce) invalid `resolve_issue` status values

**Source:** `bugs/02-data-consistency.md` Bug 8a **+** `bugs/03-api-mcp-contracts.md` #10
(independently found from an API-contract-correctness angle; that doc's own top-ranked finding)
— **corroborated by 2 independent docs.**

**Description:** `src/eden/api/routes/agent_issues.py:107-114` (`ResolveRequest`,
`_RESOLVE_STATUSES = {"open","acknowledged","resolved","ignored"}`) and `:167-223`
(`resolve_issue`) do `target = body.status if body.status in _RESOLVE_STATUSES else "resolved"`
— any out-of-scope or typo'd status value (a DB-legal-but-out-of-scope value like `"triaged"`,
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

---

### #4 — Fix "Acknowledge" issue-status button, which silently no-ops today

**Source:** `bugs/02-data-consistency.md` Bug 8b (with 8c's full audit confirming this is the
*only* broken status control)

**Description:** The portal Issues board's "Acknowledge" button sends `status="acknowledged"`
(`clients/portal/src/lib/api/resources.ts:2740-2744`, `issues-client.tsx:496-520`), which passes
the API-layer allowlist (`_RESOLVE_STATUSES` includes it) but is **not a legal value** in the
`agent_issues.status` Postgres CHECK constraint (`db_migrations/versions/136_issue_status_escalated.py:36-38,64`
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

---

### #5 — Give `next/dynamic`-loaded panels a working retry path (session/trace/tree detail views)

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
retry button doesn't retry**; only a hard browser reload recovers. 18 total `next/dynamic` call
sites across the portal share the same no-error-handling pattern; these 3 are the highest-traffic
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
highest-traffic sites, ideally all 18.
**Confidence:** High (mechanism traced through actual installed library source, not inferred).

---

### #6 — Fix the "ghost agent card" split on the portal Agents dashboard

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

---

### #7 — Surface NULL-`agent_id` traffic on the Agents dashboard instead of silently dropping it

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
`SELECT count(*) runs, sum(cost_usd) cost FROM telemetry_events WHERE org_id=$1 AND agent_id IS NULL AND timestamp > $2`.

**Blast radius:** Same live, high-traffic Agents dashboard as #6 — any org with agent_id-less
telemetry (common for OTel/webhook-sourced traffic, per `bugs/02`'s Bug 3 ingestion audit) has
some fraction of its real activity simply invisible, with zero indication anything is missing.

**Severity:** High.
**Effort:** Small-Medium — add one aggregate query + a new dashboard row.
**Confidence:** High.

---

### #8 — Fix prompt-evolution creating orphan prompts instead of versioning the real agent prompt

**Source:** `bugs/02-data-consistency.md` Bug 1

**Description:** `src/eden/agents/evolution/components.py:772` (`IssuePromptEvolver.evolve_from_issue`)
calls `PromptService.create_version(org_id, agent, template=revised, ...)`, passing `agent`
(`agent_id or issue.agent_id`, often a server-minted UUID) positionally as `prompt_name`.
`create_version` (`prompt_versioning.py:223`) has zero notion of `agent_id` — prompts are keyed
purely by `(org_id, prompt_name)`. If no prompt exists under that exact name (the common case,
since an org's actual prompt template name rarely equals its agent's UUID),
`create_version` falls through to `create_prompt` (`:242`) and mints a **brand-new, unrelated
prompt** rather than versioning the agent's real production prompt. This is now reachable from a
second call site: `resolve_issue`'s "resolved" branch unconditionally calls
`evolve_from_issue`, including when the target status was silently coerced (see #3) — a bad
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

---

### #9 — Add a UI path for the "ignored"/dismiss issue status (currently unreachable end-to-end)

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

---

### #10 — Surface NULL-`agent_id` events dropped from prompt-evolution scoring

**Source:** `bugs/02-data-consistency.md` Bug 2

**Description:** `src/eden/agents/evolution/components.py:78,93` filters
`AND te.attributes->>'agent_id' IS NOT NULL` in the query that feeds judge-score/evolution-trigger
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

---

### #11 — Fix 2 unwrapped-exception log sites flagged by the F75 PII-defensive-logging regression test

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

---

### #12 — Stop collapsing different agents' missing-`agent_id` issues into a shared fingerprint bucket

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

---

### #13 — Validate `agent_id` on stumbles/issues against a real identity system

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

---

### #14 — Clear `resolved_at` when an issue is reopened

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

---

### #15 — Don't retire either `ai_agent`/`ai_insights` router; fix the false "unmounted" tracker claim

**Source:** `bugs/01-dead-code-stale-docs.md` item 13 **+** `bugs/03-api-mcp-contracts.md` §2
(functional trace of unique capabilities in each router) — **corroborated by 2 independent
docs, using the same `app.py:226/229` mount evidence.**

**Description:** `SOTA-WAVE-TRACKER.md:326` claims "Wave 20: aiApi deleted; ai_agent.router
unmounted." The opposite is true: `src/eden/api/app.py:228-229` mounts `ai_agent.router` in the
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

---

### #16 — Add runtime schema validation to the portal's shared API fetch wrapper

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

---

### #17 — Fix ingestion timestamp normalization for offset-less ISO strings

**Source:** `bugs/02-data-consistency.md` Bug 10

**Description:** `src/eden/observability/ingestion/normalizer.py:32-58` (`_normalize_timestamp`)
stamps UTC onto three of four accepted input shapes (`None`, naive `datetime`, epoch number) but
passes a fourth shape — a string that parses via `datetime.fromisoformat` but has **no**
timezone marker (e.g. `"2026-08-04T10:00:00"`) — through **unchanged**, with no UTC assumption
applied. That naive value later binds to a `TIMESTAMPTZ` column
(`telemetry_events`), interpreted by Postgres per the connection's session `timezone` GUC, not
guaranteed UTC. This is inconsistent with `portal.py:_iso()`'s unconditional UTC-stamping on the
read side and the portal frontend's bare `new Date(dateString)` calls
(`format.ts:7-8,90-92`), which — per the JS spec — parse an offset-less string as **local
browser time**, a potential multi-hour display error. **Fix:** apply the same
`tzinfo=UTC` fallback to the string branch that the `datetime`-object branch three lines above
already applies.

**Blast radius:** Today requires an ingestion payload supplying an already-offset-less ISO
string — first-party SDKs and the OTel path (both epoch-based, always-UTC) don't currently
trigger it. A real but narrow, unconfirmed-in-production trigger condition (a raw HTTP API call,
some third-party webhook provider, or a hand-built integration script).

**Severity:** Medium.
**Effort:** Small — one function edit. **QUICK WIN.**
**Confidence:** Medium-High (mechanism fully traced through code; not reproduced against a live
Postgres instance to confirm the exact session-timezone-dependent behavior).

---

### #18 — Fix or caveat the public doc instructing users to call a dead `/mcp/keys` endpoint

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

---

### #19 — Regenerate 3 stale contract/doc snapshots (6 failing tests)

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

---

### #20 — Fix `query_eql` MCP tool's dead target path (only broken MCP tool with confirmed real user impact)

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

---

### #21 — Extend `EdenApiClient` Protocol to cover all client-calling methods

**Source:** `bugs/03-api-mcp-contracts.md` #5

**Description:** The typed `EdenApiClient` Protocol (`client.py:37-46`) covers 17 of 26 distinct
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

---

### #22 — Add ownership validation to `label_tool_call`'s caller-supplied `agent_id`

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

---

### #23 — Mount the `mcp_keys` router (or formally retire the feature)

**Source:** `bugs/01-dead-code-stale-docs.md` item 21

**Description:** `src/eden/api/routes/mcp_keys.py` (prefix `/orgs/{org_id}/mcp/keys`, including
`POST ""` create-key and `GET "" list_mcp_keys`) is fully implemented but its router is never
`include_router()`'d anywhere in `app.py` — confirmed by exhaustively parsing all three of
`app.py`'s mount mechanisms (124 of 125 route files are accounted for; `mcp_keys` is the single
exception). The only code that exercises these handlers is unit tests calling the async handler
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

---

### #24 — Remove the dead `createMcpKey` portal client wrapper

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

---

### #25 — Fix `query_sql` MCP tool's wrong path and `limit`/`max_rows` field mismatch

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

---

### #26 — Fix `get_judge_scores` MCP tool's wrong target path

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

---

### #27 — Fix `list_datasets`/`list_experiments` MCP tools' silently-ignored `limit` filter

**Source:** `bugs/03-api-mcp-contracts.md` §1.B.4-5

**Description:** Both tools send `params={"limit": limit}` to their target GET routes
(`GET /orgs/{org_id}/datasets`, `GET /orgs/{org_id}/experiments/offline`), but neither backend
handler (`datasets_hub.py:71-81`, `experiments_offline.py:34-38`) declares a `limit`/`Query`
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

---

### #28 — Ship the `live` parameter fix for `rerun_debugger`/`checkpoint_rerun` MCP tools

**Source:** `bugs/03-api-mcp-contracts.md` §0a

**Description:** Both MCP tools funnel through the same `HttpEdenClient.rerun_debugger` choke
point (`client.py:245-264`), none of which — nor the Protocol (`client.py:37-46`) nor either
`tools.py` wrapper (`:45-62,470-497`) — has a `live` parameter, even though `RerunRequest`
(`debugger.py:60-93`) has a real `live: bool = False` field that's the only way to reach the
`live_gateway` branch. It's simply never populated from MCP — the live-rerun gateway path has
never worked for any MCP caller since it shipped. The doc includes an exact, already-specified
4-file diff (Protocol + `HttpEdenClient` + both `tools.py` wrappers + both `server.py` schemas,
~6 lines) — see the source doc for the literal patch. `checkpoint_rerun` (added in the most
recent `mcp_server`-touching commit, `64233475`) shipped with the identical gap, showing the
defect is actively spreading to new call sites, not just aging debt. **Fix:** apply the
already-specified 4-file diff; default `checkpoint_rerun`'s new `live` param to `False` (not
`True`) to avoid silently billing/invoking a real model on an unqualified call.

**Blast radius:** MCP surface only, soft-retired, zero internal callers — but worth noting the
defect is actively spreading to new tools as they're added, so leaving it unfixed compounds the
future cleanup cost.
**Severity:** Low (per current live blast radius) — flagged as worth fixing specifically because
it's cheap and spreading.
**Effort:** Small — diff already fully specified in the source doc (4 files, ~6 lines). **QUICK
WIN** (low severity but essentially free to fix, with a ready-made patch).
**Confidence:** High.

---

### #29 — Type `resolve_issue`'s response in the portal API client

**Source:** `bugs/03-api-mcp-contracts.md` #8

**Description:** `resolve_issue`'s response fields (`regression_cases`, `regression_run`,
`prompt_evolution`) are under-typed in `agentIssuesApi.resolve`'s portal return type — callers
get weaker compile-time guarantees than the real response shape provides. **Fix:** add the
missing fields to the TS return type.

**Blast radius:** Portal Issues board's resolve flow — a type-safety gap, not a runtime bug.
**Severity:** Low.
**Effort:** Small — TS type edit.
**Confidence:** High.

---

### #30 — Give `retrain_tool_calibrator` a real Pydantic request model

**Source:** `bugs/03-api-mcp-contracts.md` #9

**Description:** `retrain_tool_calibrator` (`tool_call_labels.py:123-132`) takes an untyped
`body: dict[str, Any]` with no Pydantic model — malformed input returns a 200-with-error-string
instead of a proper 422 validation error. **Fix:** define a Pydantic request model for the
route.

**Blast radius:** Narrow — this specific admin/calibration endpoint only.
**Severity:** Low.
**Effort:** Small.
**Confidence:** High.

---

### #31 — Replace the `outcome == "error"` vocabulary bug with the codebase's own correct idiom (5 sites)

**Source:** `bugs/02-data-consistency.md` Bug 3 (main vocabulary-bug thread; §3d/§3f's undefined-
column variant is #33 below)

**Description:** `intelligence_rca.py:68-69` (`_event_failed`) and 4 more sites in
`insights/rca/_common.py` (`:862-870`, `:1002-1011`, `:728-745`, `:992-999`) all check
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
already used correctly elsewhere in the same file, e.g. `telemetry_collector.py:2270`,
`_common.py:833`).

**Blast radius:** **The entire `rcaApi` portal frontend surface (`analyze`, `explain`,
`clusterIncidents`, `listIncidents`, `summarizeIncident`) was deleted from the portal 3 days
before this review as verified, intentional dead code** (regression-guarded by
`dead-code-removal.test.ts`), and no MCP tool or SDK reaches these routes either. The routes
remain routed/reachable via a direct, undocumented REST call, but today there is no portal
button, MCP tool, or SDK method that reaches any of them — **zero live product blast radius**,
despite the bug being real, well-evidenced, and unconditional in the code as written.

**Severity:** Low (per this doc's live-blast-radius weighting — this was the doc's own
provisionally-"worst finding" until the frontend-deletion fact demoted it).
**Effort:** Small — one shared helper replaces 5 duplicated inline checks. **QUICK WIN** (cheap
fix even though currently unreachable — worth doing opportunistically).
**Confidence:** High.

---

### #32 — Fix the ambiguity/failure risk in `_fetch_trace_events`'s and the clustering query's reference to a nonexistent `error` column

**Source:** `bugs/02-data-consistency.md` Bug 3 §3d, §3f

**Description:** `insights/rca/_common.py:198-213` (`_fetch_failed_traces_in_window`, backing
`/incidents/cluster`) and `:104-140` (`_fetch_trace_events`, backing `/analyze`, `/explain`, and
`/chain`) both reference a bare `error` column in raw SQL against `telemetry_events`. A full
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

---

### #33 — Add `agent_id` to the RCA causal-chain output

**Source:** `bugs/02-data-consistency.md` Bug 6 (chain half)

**Description:** `_build_causal_chain` (`intelligence_rca.py:80-123`) drops `agent_id` entirely
when projecting each event into the chain response — confirmed zero occurrences of `agent_id`
anywhere in the file. The `/chain` endpoint (`rca_chain`, `:126-140`) was added in the most
recent commit touching this file (`64233475`) — a fresh gap, not aged debt. **Fix:** add
`"agent_id": ev.get("agent_id")` to the per-node dict.

**Blast radius:** Same dead-frontend/no-MCP-caller gating as #31/#32 — `/chain` has no portal or
MCP caller today.
**Severity:** Low.
**Effort:** Small — one dict key. **QUICK WIN** (cheap, worth doing opportunistically since the
endpoint is brand new).
**Confidence:** High.

---

### #34 — Stop merging unrelated agents into a shared `"unknown"` incident-cluster key

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

---

### #35 — Stop pooling different unversioned deployments into one "unknown" statistical baseline

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

---

### #36-#50 — Dead backend code: delete or re-wire 15 zero-caller functions

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
    `cockpit_aggregator.py:214`'s `self._from_issues(...)` call resolves to a **different class's
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

---

### #51-#54 — Dead portal (frontend) code: delete ~34 zero-importer exports across 4 groups

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

---

### #55-#58 — Stale tracking-doc claims across 5 `docs/specs/` documents

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

---

## Appendix — cross-doc corroborations merged into single points

The following findings were independently discovered by 2-3 of the four source docs, from
different analytical angles, and were merged into one ranked point above rather than listed
separately. Corroboration across independently-written docs was treated as a strong confidence
signal in each merged point's write-up.

1. **`resolve_issue` silent status coercion** (ranked point **#3**) — `bugs/02` (Bug 8a, deepest
   writeup: traces through the Postgres CHECK constraint and the portal's optimistic-UI silent
   revert) and `bugs/03` (#10, that doc's own top-ranked finding, found from a pure
   API-contract-correctness angle) independently identified the exact same root cause
   (`agent_issues.py:173`).
2. **"Ignored"/dismiss issue status unreachable from the UI** (ranked point **#9**) — `bugs/03`
   (#3, original discovery: backend + API client support it, UI type excludes it), `bugs/04`
   (§5, independently re-confirmed the same 4-layer citation trail end-to-end and additionally
   ruled out a hypothesized kanban-crash risk), and `bugs/02` (§8c, confirmed as a side-finding of
   its own status-control audit that no UI path to `"ignored"` exists) — three independent
   confirmations of the same gap.
3. **`ai_agent`/`ai_insights` dual router — don't retire, "unmounted" claim is false** (ranked
   point **#15**) — `bugs/01` (item 13, discovered the stale-doc/code contradiction via
   `app.py:226/229`'s mount table) and `bugs/03` (§2, independently traced the same mount
   evidence to determine per-route unique functionality and concluded retiring either is unsafe)
   — same underlying code evidence, complementary conclusions (doc-accuracy vs. functional
   safety), merged into one point.

No other overlaps were found: `bugs/02`'s reachability corrections (Bug 3's `rcaApi`-deletion
demotion, points **#31/#32/#33/#34**) independently reached the same "RCA surface has zero live
callers today" conclusion that `bugs/03`'s #7 ("`signal_investigator.py`/`intelligence_rca.py`
remain backend-only... absent from the 28-tool MCP catalog") states directly — `bugs/02` cites
this convergence explicitly in its own §3e. This is noted as corroborating context for those four
points' severity demotion, not merged into a separate ranked point of its own, since `bugs/03`'s
#7 doesn't add a distinct actionable fix beyond what's already captured in #31-#34.
