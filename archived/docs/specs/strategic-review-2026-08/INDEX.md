# Eden Strategic Product Review — Synthesis (Pass 4, Final)

This supersedes the prior `INDEX.md` (which reflected Pass 3). This review
is now four full research passes deep across **26 final documents**: 16
feature specs (`features/01`–`16`), 6 optimization specs
(`optimizations/01`–`06`), and 4 bug-hunt specs (`bugs/01`–`04`). Every one
of the 26 was independently re-verified against live source in Pass 4 by
1–3 agents each, then synthesized here: false, stale, speculative-unlabeled,
and redundant content was pruned; citations were corrected; and every
feature doc now carries a dedicated "User Experience & Value" section.
Pass 4's most consequential findings are two doc-scope corrections that
change what two files are actually about — `features/03-prompt-playground.md`
now covers the real, human-facing `src/eden/playground/` subsystem instead
of the autonomous prompt-evolution loop it previously (mis-)covered (that
material moved to `features/13-continuous-improvement-loop.md`, which also
gained full coverage of a second, ~9,800-line autonomous closed loop,
`src/eden/improvement/`, undocumented through three prior passes) — plus a
correction to `features/12-runtime-guardrails.md`'s core claim about whether
eval→guardrail promotion works at all (two incompatible classes share the
name `EvalToGuardrailLink`), two entirely new subsystems added to
`features/07-security-compliance.md` (red-team probing, a hash-chain
compliance ledger), and a severity re-ranking inside `bugs/02-data-consistency.md`
after a dependency of its previous top finding was deleted as dead code.
This is very likely the last pass before this review is considered done.

`sdk-deletion.md` was independently re-verified this pass and is finalized:
**READY-TO-COMMIT**, unchanged, out of scope for the rest of this document.

## Executive Summary

**What eden is:** an LLM/agent observability platform — tracing, RCA,
guardrails, evals, session analytics, cost governance, and an increasingly
autonomous improvement loop (detect → triage → patch → canary → promote) —
competing against Lemma, LangSmith, Braintrust, Arize Phoenix, Langfuse,
Helicone, Portkey, and OpenRouter, among others.

**The shape of this review:** four passes of increasing depth, ending in 26
standalone documents, each independently re-verified against live code with
file:line citations, plus fresh 2026 competitive research (including direct
confirmation of two Lemma product surfaces via `docs.uselemma.ai`'s public
API reference, not just marketing copy). Pass 4 corrected two doc-scope
errors that had persisted since Pass 1 (`features/03` was tracing the wrong
subsystem entirely; `features/13` was missing a second, larger autonomous
loop), which is itself evidence the "sophisticated backend, missing
last-mile wiring" pattern below applies to this review's own research
process, not just to eden's product.

**The single biggest headline, confirmed and sharpened across all three
passes:** eden already has far more sophisticated engineering built than its
own product surface, documentation, or sales positioning reflects — a real
IAA/kappa labeling engine, a real autonomous prompt-evolution/canary system,
a real fail-closed guardrails engine, a real six-table GDPR fanout
implementation, a real cohort/funnel analytics module, a real counterfactual
trace-forking engine with no known competitor analog. And yet, **a recurring
pattern across nearly every one of the 26 documents is that the hard 80% is
built and the last-mile wiring is missing, disconnected, or silently
broken** — not missing capability, but capability that never got connected
to the code path a real user or a real production event actually travels
through. Where Pass 1/2 read this as "adoption debt," Pass 3's deeper trace
found the wiring gap is frequently not cosmetic: in at least five cases
(guardrails, alerting, budget tracking, incident clustering, GDPR erasure)
the disconnected wiring means a customer-facing claim ("your content was
screened," "you'll be paged," "your spend is tracked," "your data was
erased") is **false today**, silently, with no error surfaced anywhere.

## Part 0 — Top-Priority Findings, Re-Ranked From Scratch

Findings are tagged **P0** (silent failure or safety/correctness break in a
shipped, default-on, customer-facing path), **P1** (real bug or major gap,
contained blast radius or requires an uncommon trigger), or **P2**
(hygiene, dead code with no live consumer, or process/documentation issue).
Ranking is by blast radius × silence × how "normal" the trigger condition
is — a P0 that fires on the *common* case outranks one that needs a rare
trigger.

### 1. [P0] Runtime guardrails silently swap PII/injection screening for cost checks — the review's own top-ranked finding

`features/12-runtime-guardrails.md`. `InterventionEngine.evaluate_and_act`
(`src/eden/guardrails/intervention.py:440`) is a real, fail-closed
pre-response guardrail engine with exactly **one production caller** in the
whole codebase: `POST /guardrails/evaluate`
(`src/eden/api/routes/intelligence_guardrails.py:148`), which accepts
`trace_id` as an **optional query parameter** (`Query(None)`) set entirely
by whichever external caller hits the endpoint. `install_cat15_trajectory_
replaces_intervention()` (`src/eden/observability/trace_quality/
wiring.py:279-364`) monkey-patches `InterventionEngine.evaluate_and_act` at
the class level: whenever a caller passes `trace_id` — the *normal* case
for any properly-instrumented integration, not an edge case — it silently
reroutes to `evaluate_trajectory_step`, which runs 8 purely numeric/metadata
checks (cost, tokens, loop, tool-dedup, retry-storm, schema, latency,
finish-reason) and **never inspects `text`/`context` for PII, prompt
injection, or hallucination at all**. The wrapper's returned envelope
(`wiring.py:353`, `"edited_text": text`) echoes the raw, unredacted input
back in the exact response shape the real PII-redaction path uses — a
caller cannot tell the difference from the response alone. This is wired at
API boot unconditionally (`install_all()`, called from
`src/eden/api/app.py:814`), and both governing flags default **on**
(`trace_quality_enabled`/`trace_quality_hot_path_enabled`,
`src/eden/config.py:937,942`). It is shipped and tested, not
work-in-progress. **Confirmed zero monitoring on the bypass path**: the only
write to `intervention_log` (`intervention.py:102,127`) happens inside the
*original*, un-patched method — the monkey-patched wrapper never calls it —
and a repo-wide grep across `helm/`, `deploy/`, `tinybird/`, and the portal
for `guardrail`, `intervention_log`, `pii`, `prompt_injection`,
`trajectory_guardrail` returns **zero matches everywhere**. The doc's own
author explicitly argues this should outrank the review's flagship product
bets: *"the only finding where the system tells a customer 'your content
passed a safety check' when no content-safety check ran, for a trigger
condition that is the normal, expected behavior of any properly-
instrumented integration."* This needs a decision — not adoption work —
before any SDK auto-invoke wrapper is built on top of it.

**Pass 4 addendum — a second, independent break in the same doc:** the
"eval verdicts get promoted into an enforced guardrail" claim is also
false today, for an unrelated reason. **Two different, non-interoperating
classes share the name `EvalToGuardrailLink`.** The one this doc's prior
passes cited (`eden.guardrails.intervention.EvalToGuardrailLink`,
`intervention.py:789-957`, reachable via the documented-sounding
`POST /guardrails/promote-judge`) is toothless — its `judge_link` policy
type is hard-excluded from `InterventionEngine`'s `_enforced_types`
(`intervention.py:521-528`), so promoting through it silently enforces
nothing while the dashboard shows `status: "active"`. A second, separate
class (`eden.evaluation.eval_intel.integration.EvalToGuardrailLink`,
`integration.py:69-256`) is the one that actually hot-reloads the live
gateway filter — but it lives under a different, undocumented route
(`POST /intelligence/eval/promote-to-guardrail`), has zero portal
affordance, and **has no demote/disable method anywhere in the codebase**,
so a promotion through the path that actually works can never be undone
short of hand-editing in-memory state. Net: a user who wants to promote a
judge finding into a guardrail either uses the documented endpoint and
silently gets nothing, or has to already know about a second, unlisted
endpoint to get real enforcement they then cannot turn back off.

### 2. [P0] The entire P0 security-alert path is decorative, end-to-end

`features/04-alerting-oncall.md`. `AlertStreamProcessor.process_event()`
(`src/eden/realtime/alert_stream.py:194`) has **zero external callers**
anywhere in the codebase or test suite — the only invocation is a
usage-example inside its own module docstring. The P0 rule's trigger event,
`sandbox.security_alert` (`alert_stream.py:181`), is **never emitted** by
any code in the repo; the sandbox's real escape guard
(`src/eden/sandbox/runner.py`, lines 117/128/134/158/161) raises a plain
`ValueError` with no connection to alerting whatsoever. Even if an event
somehow reached the processor, `_dispatch_pagerduty`
(`alert_stream.py:427-429`) is a two-line no-op (`logger.info("PagerDuty
alert skipped:not_configured...")`, no HTTP call, no config lookup at all),
and `EMAIL` — the one channel with a real "leaves the building" delivery
mechanism — isn't even in the P0 rule's channel list. `kafka_consumer.py`'s
own module docstring self-admits *"NOT WIRED — nothing in this codebase
calls `get_kafka_consumer` or starts a `KafkaEventConsumer` outside of this
module's own tests."* Separately, `AnomalyDetectorLoop.tick_once`
(`anomaly_alerts.py`) hardcodes `channels=["in_app"]` regardless of
severity — a `critical` PII-breach finding gets identical treatment to a
routine warning. Pass 2 characterized this as "PagerDuty is a silent
no-op, everything else works." Pass 3 found that undersold it: **rule
engine, trigger emission, and every notification channel are each
independently broken**, so a customer relying on eden to page a human for a
P0 security event would never be paged, full stop, and there is no test
coverage anywhere that would catch this (`grep -rl "alert_stream" tests/`
returns nothing).

### 3. [P0] Portal trace badge shows green "ok" for `timeout`/`crash` traces on every trace page view — promoted this pass to the doc's worst finding, displacing a bug whose only live consumer was deleted

`bugs/02-data-consistency.md`. **Re-ranked this pass.** `_map_trace_outcome`
(`src/eden/api/routes/portal.py:177-183`) — the function backing the
portal's `/traces` list and trace-detail status badge, hit on every trace
page view for every org today — omits `timeout`/`crash` from its error
check even though the correct set (`_ERROR_OUTCOMES`, defined nine lines
below at `:187-189` and used by the same two endpoints' `error_detail` SQL)
already includes them. The practical effect: a trace that timed out or
crashed renders the same green/neutral "ok" badge as a genuinely
successful trace, with no visual distinction anywhere in the primary trace
UI. This is now the doc's single worst finding, ahead of the previous
top-ranked bug below, because it has no reachability caveat — it is the
primary, unambiguously live customer-facing surface, not gated behind any
flag or a deleted frontend.

**Demoted this pass, same doc — `POST /incidents/cluster` queries a column
that was never migrated into existence:** the endpoint
(`src/eden/api/routes/intelligence_rca.py:159-168`) calls
`IncidentClusterer.cluster` (`src/eden/insights/incidents/
clusterer.py:125-170`), which calls `_fetch_failed_traces_in_window`
(`src/eden/insights/rca/_common.py:178-214`) with SQL that references a
bare `error` column no migration in the repo ever added to
`telemetry_events` (migration 067 added only the differently-named
`error_type`). Every call raises `UndefinedColumnError`, caught by a bare
`except Exception as exc: logger.debug(...); return []`
(`_common.py:211-213`), and the caller returns an indistinguishable
`"clusters": [], "total_failed_traces": 0`. **This bug is real and still
worth fixing, but this pass found its entire live blast radius is
currently zero**: the only frontend surface that would ever reach it —
`rcaApi` (`analyze`, `explain`, `clusterIncidents`, `listIncidents`,
`summarizeIncident`) — was deleted from the portal as intentional,
zero-consumer dead code 3 days before this review, independently
confirmed by `bugs/03-api-mcp-contracts.md`. Worth fixing cheaply, but no
longer the doc's headline risk.

### 4. [P0] Autonomous prompt-evolution loop can canary but can never promote — two compounding, independently-fatal bugs

**Citation corrected this pass:** this material lived in
`features/03-prompt-playground.md` through Pass 3; that doc was tracing
the wrong subsystem (see the Pass 4 scope correction in the header above)
and this finding now lives in `features/13-continuous-improvement-loop.md`
(`## A third related mechanism`), unchanged on the facts.
`promotion_candidates.ref_id` is
declared `UUID NOT NULL` (`db_migrations/versions/
092_market_ready_consolidated.py:195`), but both the autonomous path
(`src/eden/llmops/promotion.py:358`) and the human-triggered API route
(`src/eden/api/routes/prompt_canary.py:194`) insert a composite string,
`f"{agent}:{candidate_version}"`, into it. Postgres rejects the insert;
`EvidenceGate.enqueue` swallows the exception and returns `None` — silent
on the autonomous path, surfaced only as a bare `503 "EvidenceGate enqueue
failed — promote blocked"` on the manual path
(`prompt_canary.py:200`). Independently, even with that bug fixed,
`_metrics_from_outcomes` (`src/eden/promotion/evidence_gate.py:121`)
hardcodes `if kind != "nudge" or not ref_id: return []` — meaning any
candidate of `kind="prompt_version"` (i.e., every prompt-canary promotion
that exists) always gets an empty control/treatment sample set, so
`evaluate_bayesian` can never pass regardless of the first bug. The one
unit test covering this (`tests/unit/llmops/test_promotion_loop.py`) mocks
`_evidence_gate_promote` directly rather than exercising the real gate
against Postgres, so this has never been caught by CI. **Net effect: in
production, autonomous or human-triggered prompt-canary promotion can never
succeed — it can only roll back (which needs no gate and works
unconditionally) or stall in "keep" limbo indefinitely.** This is likely
the single largest undiscovered differentiator in the whole review
(a fully autonomous mutate → canary → statistically-gated promote loop,
something no researched competitor ships) sitting one migration-column-type
fix and one conditional away from actually working end-to-end.

### 5. [P0] `budget_consumption` never accrues for pure gateway-proxy orgs; zero reconciliation exists

`features/06-cost-governance.md`. `budget_service.record_usage()`
(`src/eden/services/budget_service.py:275`) has exactly three callers in
the entire codebase — `optimization/cost_tracker.py:132` (itself an
orphaned route), `llmops/cost_ledger.py:316` (the judges/Improve path), and
`llmops/ai_gateway.py:721` inside `AIGateway.complete()`, which is only
reachable from offline replay paths, never live traffic. The actual live
`/gateway/v1/chat/completions` route (`src/eden/api/routes/gateway.py`)
calls `_call_upstream()` (line 1715) directly, bypassing `AIGateway`
entirely. **For any org whose traffic is 100% ordinary gateway-proxy
calls, `budget_consumption` stays at exactly $0 forever** — not
intermittently, structurally. `grep -c "budget_consumption"
src/eden/workers/cron_tick.py` returns `0`; no reconciliation job exists
anywhere in the repo between `budget_consumption` and the real
`usage_events`/`customer_cost_events` tables. Compounding this, the
customer-configured `budgets.cost_hard_limit_usd` value is never read by
the middleware that actually enforces spend caps
(`QuotaEnforcementMiddleware` reads a separate, unrelated
`org_resource_limits.cost_hard_limit_usd` instead) — a customer who lowers
their budget in the UI gets no real protection from that action. Separately
and more narrowly, `optimizations/03-llm-cost.md` traces a real (if small,
sub-$1/org/day) cost-*ledger* miscount rooted in the autonomous
investigator's LLM-cost accounting: `org_id` never reaches `cost_context`
across the chain `_common.py:181-211` → `internal_router.py:93-123` →
`cost_ledger.py:98-124,187-201`, affecting `investigate()`
(`autonomous/investigation.py:162`, def at `:81`), `report()`
(`:296`, def at `:234`), and — newly discovered and previously
undocumented this pass — **"Ask Eden"**, a natural-language query interface
(`src/eden/autonomous/nl_interface/query.py`) with four direct call sites
plus one indirect call via `report()`, now the largest single contributor
to this bug's blast radius. (A third call site, `_llm_rationale` at
`investigation.py:1174`, is confirmed genuinely dead — zero callers — which
corrects a prior pass's narrower "3 call sites" framing to the real,
larger set.)

### 6. [P0] `TriageAgent` crashes on every successful investigation as of a 2026-08-04 commit — automatic triage is completely defeated, though a human does eventually get an escalation

`bugs/04-frontend-and-test-failures.md`. Commit `ab490f2a1` (2026-08-04,
"fix(loop): make two silent dishonesty paths loud (chaos rows c + d)" — an
irony the review notes) introduced an `UnboundLocalError`:
`src/eden/issues/triage_agent.py:282` reads `if llm_error:`, but `llm_error`
is only ever assigned inside the `except TimeoutError:` branch (dead code —
placed after a `return`) or the generic `except Exception:` branch
(`:270`) — **never on the success path**, which is the common case. This
was found by running the *full* backend test suite (not a filtered
subset) — the first time in this review that was done — and is confirmed
to fire on every successful investigation, not a rare branch. **Correction
this pass, from re-reading the orchestrator, not just the crash site:**
the failure is not fully silent. `orchestrator.py:46` caps retries at
`_TRIAGE_MAX_ATTEMPTS = 2`, and once that deterministic failure exhausts
the retry budget, `orchestrator.py:199-200,222` calls `_escalate_human(...,
reason="triage_failed")` — every affected issue is retried once and then
escalated to a human rather than silently vanishing forever. That softens
"silent" but not the core finding: the intended outcome (automatic
LLM/heuristic triage) is completely defeated on every normal-path run in
production, and the human who sees the escalation gets no crash report or
alert explaining why — just an issue that skipped straight to needing a
person's attention.

### 7. [P0/P1] Five additional MCP tools broken beyond the known rerun bug — three guaranteed to fail every call

`bugs/03-api-mcp-contracts.md`. `query_eql` posts to
`/orgs/{org_id}/alerts/nl/preview` (`mcp_server/tools.py:339-340`) — no such
route exists anywhere in `intelligence_dsl.py`. `query_sql` posts to
`/orgs/{org_id}/sql` (`tools.py:365-368`), missing the `/execute` segment
the real route requires (`sql_query.py:108`), and also sends a `limit`
field the real request schema doesn't define at all. `get_judge_scores`
gets `/orgs/{org_id}/observability/traces/{trace_id}/scores`
(`tools.py:415-417`) — no such route exists; the real endpoint is
`GET /orgs/{org_id}/observability/judges` (`judges.py:49,191`). **All
three are guaranteed to fail on every invocation in production — P0 for
tool reliability, though not a data-safety issue.** Two more,
`list_datasets` and `list_experiments` (`tools.py:379-404`), send a
`limit` parameter their target routes silently ignore (`datasets_hub.py:
72-81`, `experiments_offline.py:35-44` accept no such param) — P1, a
silently-ignored contract rather than a hard failure. This is on top of
the already-known `rerun_mode="live"` field being dropped between the MCP
client and `RerunRequest` (`mcp_server/client.py:245-264`,
`debugger.py:74-82`), now confirmed to affect a second tool
(`checkpoint_rerun`) as well — doubling the broken rerun surface.

### 8. [P1] Signal-clustering embedding call is dead code — independently confirmed twice, and simulation shows ~95% mega-cluster collapse

`optimizations/01-hotpath-perf.md` and `optimizations/02-db-queries.md`,
confirmed independent (different investigation paths, no cross-reference
between the two docs) during this synthesis. `SignalEventClusterer._embed`
(`src/eden/signals/clusterer.py:195-212`) imports
`eden.kb.embeddings.get_default_embedder` — **a function that does not
exist**; the real embeddings module lives at `src/eden/kb/ledger/
embeddings.py` and exports `embed_text`, a differently-named, differently-
located function. The `ImportError` is swallowed by a catch-all at
debug-level logging (`clusterer.py:~205`) and the code falls back to a
deterministic hash (`stable_hash`) instead of any real semantic embedding —
so every "clustering by similarity" call has actually been clustering by
hash collision since this shipped. This synthesis independently
reproduced the claimed ~96% mega-cluster collapse by running the real
`stable_hash`/cosine/grouping loop against 500 synthetic texts: **476/500
(95.2%) collapsed into one cluster**, with a minimum cosine similarity of
0.098 matching the reviewed doc's cited figure to three decimal places —
not a guess, a reproducible result. Compounding this, `signal_events`
(`db_migrations/versions/092_market_ready_consolidated.py:44-60`) has
exactly one index (`trace_id`), while the real read pattern filters on
`(org_id, signal_id, ...)` — every clustering call does an unindexed
fetch of up to 500 rows, a dead embedding call, then an O(n²) scan (up to
250,000 comparisons), all `await`ed synchronously inside one of only 5
concurrency slots on the shared, all-org trace-finalized ingest consumer.

### 9. [P1, was P0 candidate] Storage retention: 6 of 8 declared policies are structurally unenforced (correcting an over-broad "all 8" framing)

`optimizations/06-storage-retention.md`. This synthesis's own
verification pass corrected an imprecise "all 8 are dead" characterization
that had been carried into this task's brief: the doc's actual, precise
claim is that **6 of 8** declared policies
(`derived_metrics`, `user_feedback`, `training_datasets`, `audit_logs`,
`error_logs`, `quarantine_events`) have both their archive and delete
branches structurally unreachable in `run_retention_policy`'s dispatch
(`src/eden/data_platform/retention.py:456-503` — `archive_table is None`
and `delete_after_days > warm_days` for every one of the six), while only
**2 of 8** (`raw_traces`, `debug_dumps`) have real, working code paths.
Four of the six no-op categories (`error_logs`, `audit_logs`,
`derived_metrics`, `training_datasets`) reference tables that don't exist
in Postgres at all. The test suite only ever asserts the policy *keys*
exist, never that a row was touched
(`tests/data_platform/test_retention_cron.py:17-51`). Separately, the live
checkpoint/rewind write path is actually `trace_replay_sessions`
(`db_migrations/versions/020_intelligence_gap_tables.py:87-100`), not the
legacy `checkpoint_blobs` a prior pass named — it has an unbounded
`state_json TEXT` column and no retention policy at all, accumulating one
permanent row per distinct trace ever rewound. **Correction applied here:**
treat this as "6 of 8 are no-ops, 2 genuinely work" — not "all 8" — the
substantive risk (false confidence that a mature, system-wide retention
program exists) is unchanged either way.

### 10. [P1] `Artifacts` and `Issue Extraction` are now confirmed real Lemma products — with two different strengths of evidence, not equally strong

`features/15-artifacts-behavior-record.md`,
`features/16-issue-extraction-online-evals.md`. **Artifacts is confirmed
via primary-source documentation**: `docs.uselemma.ai`'s OpenAPI-derived
reference has a dedicated `Artifacts` tag with 7 endpoints
(upload/list/get/delete/regenerate), plus a
`GET /issues/{issue_id}/artifact-context` endpoint under the `Issues` tag
that explicitly joins the two concepts — Lemma's own API documentation,
not marketing copy, and notably the term "Artifacts" does *not* appear
anywhere on Lemma's marketing site at all (nav, `/artifacts`, `/product`,
changelog all absent/404), so this finding is deliberately sourced from
where the marketing surface *doesn't* corroborate it. **Issue Extraction's
provenance is weaker and should not be conflated with Artifacts':** the
exact term "Issue Extraction" does not surface anywhere in Lemma's public
materials (`uselemma.ai/issue-extraction` is a live 404); the underlying
capability is confirmed via direct marketing-site quotes, but under a
different name — Lemma's actual shipped, named feature is **"Issues"**
(audits traces against agent instructions, groups recurring failures,
creates a post-fix online eval that reopens the issue on regression). The
brand name "Issue Extraction" itself rests on the product owner's
assertion as ground truth, not an independent public-source confirmation
like Artifacts got. Both build recommendations are real and should be
positioned as informed by genuine competitive research (not blind
cloning): eden's Artifacts equivalent (a versioned per-agent
`agent_artifacts` table, reusing the existing nightly scout, prompt-
versioning hash pattern, and issue-resolve hook, ~1.5-2 weeks) and eden's
ranking gap for its own already-built issue-extraction mechanism (eden's
`soft_issue_review.py` L1/L3/L4 pipeline already does extraction/dedup/
validation without rubrics or judges — the missing piece is that extracted
issues are never *ranked* by severity/confidence/blast-radius, only sorted
by recency). **Both are explicitly sequenced as downstream dependents of
finding #11 below (F13) — see Part 2.** **Reframed this pass, F15
specifically:** the prior three passes wrote F15 as "build a new system"
(a new `agent_artifacts` schema, ~1.5–2 weeks). Pass 4 found eden already
ships a GA-**default-on** artifacts/ledger system (`BookGenerator`,
`LedgerGenerator`, `diff_since_version()`) with **zero portal UI wiring** —
`/artifacts` and `/ledger` are both listed in the portal's dead-stub map.
The verdict changed accordingly, from RESCOPE-and-build to **UN-STUB and
wire**, and the estimate dropped from ~1.5–2 weeks to **~5–7 days** across
six phases (un-stub the two portal pages against APIs that already exist;
ship `diff_since_version()` as a "what changed" view; wire `TriageAgent`
to read `LedgerGenerator.get_latest()` before its expensive 8-call ReAct
evidence loop; add the one genuinely-missing piece, team-uploaded
`.txt`/`.md` context; wire the one missing regeneration trigger).

### 11. [P0/flagship] The continuous-improvement loop is still unwired — and F15/F16 cannot ship meaningfully until it is

`features/13-continuous-improvement-loop.md`. `record_shadow_feedback`
(`src/eden/services/soft_issue_review.py:571-618`), the only writer of
`operator_confirms`/`operator_dismisses`, has **zero callers** anywhere
(`grep` confirms only the definition, an internal debug-log reference, and
its own `__all__` export). `resolve_issue`
(`src/eden/api/routes/agent_issues.py:167-`) — the endpoint the portal
actually calls on every confirm/dismiss — never calls it, and has no
branch at all for `target == "ignored"`. The fix is a real 4-step plan, not
a one-line change: (a) the `signal_id` needed is one join away via
`agent_stumbles.detail->>'signal_id'` (only present when
`detected_by == "signal_investigator"`) — and this pass found a new bug in
that join itself: `agent_stumbles.detail` is JSONB but
`PostgresClient.fetchrow` (`storage/postgres.py:839-847`) returns it as a
raw string with no type codec registered, so a prior pass's proposed fix
(`.get("detail", {}).get(...)`) would crash with `AttributeError` on first
use; (b) `nl_signals` has no `agent_id` column at all — it's smuggled into
free text as `[auto:{agent_id}]` (`soft_issue_review.py:363`), requiring a
schema migration, not just a query change; (c) `resolve_profile`
(`detection_settings.py:115-119`) cannot consume per-agent precision today
— it needs a wholly new aggregation function, a new table, and a
cache-key widening, not just a parameter. **Explicitly, per the doc, F15
and F16 are downstream dependents of this wiring, not parallel,
unrelated work** — both new files state their own recommendations are
"close to worthless" until the confirm/dismiss signal this loop produces
is real, and both sequence their own build steps strictly after this
item's P0/P1 steps land. This remains the single highest-leverage wiring
fix in the review — Lemma ships the functionally-identical loop
(issue → suggested fix → online eval that reopens on regression) fully
wired end-to-end today, making eden structurally behind a live competitor
here, not just internally incomplete.

**New this pass — a second, much larger closed loop the doc's title
promised but its first three passes never covered:** `src/eden/improvement/`
(`planner.py`, `auto_merge.py`, `guardian.py`, `test_gate.py`,
`issue_patch_trigger.py`, `replay_verify.py`, ~9,800 lines across 15
files) is a fully autonomous issue → patch → test → auto-merge →
auto-revert-on-regression loop, complementary to (not overlapping with)
the shadow-detector loop above: Loop 1 learns *what counts as an issue*,
`improvement/` autonomously *fixes* confirmed ones. Unlike Loop 1, this
loop is genuinely well-wired, including a real portal review UI
(`/improve`, `/improve/plans/[id]`) with a diff pane, RCA/"why" text,
guardian-drafted-revert provenance, evidence chips with honest empty
states, and a "Preview impact" button that replays a proposed change
against production traffic before a human approves it — arguably the
strongest trust-building mechanic surfaced anywhere in this review. Its
gaps are narrower than Loop 1's: a reject reason is captured by the
backend but discarded by the live UI (every rejection falls into a
generic 30-day bucket regardless of the real reason), and — like the
`nudges/` promotion mechanism below — it has no reconciliation with Loop 1
today, even though both are shadow-candidate→promote systems answering
different halves of the same question.

### 12. [P1] Genuine differentiator with no competitor analog: counterfactual trace forking

`features/01-competitor-matrix.md`. `src/eden/time_travel/forker.py`
(`class TraceForker`, `:52`; `async def fork`, `:55`) branches a
production trace at a chosen step index into a new `fork_id`, replaying
earlier steps from cache and re-executing live from the fork point,
optionally with customer-supplied per-step edits, with fork-of-fork
lineage via `parent_fork_id`. Confirmed to exist and match its description
in the doc; the "no competitor analog found anywhere" claim is a
research-coverage statement (18 vendors researched across 3 passes, none
documented an equivalent) rather than something verifiable from source
alone, but nothing in the codebase or competitor research contradicts it.
This is arguably the single most underexposed genuine differentiator
surfaced by the whole review.

### 13. [P0] SSO login cannot complete end-to-end today, despite admin config genuinely working now

`features/07-security-compliance.md`. The IdP callback route
(`src/eden/api/routes/sso.py:653-675`) unconditionally raises
`HTTPException(503, {"status": "sso_not_enabled"})` — by explicit, tested
design; its own docstring states *"Rather than ship a half-implemented
exchange that silently mismints sessions, this deployment declines the
callback with a structured, unambiguous 503."* Confirmed via test
(`test_callback_consumes_state_and_succeeds`) that even a **successfully
validated CSRF state still results in a 503** — a user who authenticated
correctly with their real IdP gets a dead end at the very last step. The
admin-side config/setup flow genuinely was fixed 2026-08-02 (2-3 days
before this review), which is real progress, but should not be
represented as "SSO works" in any customer-facing context until the
callback itself is implemented.

**New this pass — two entire security-domain subsystems this doc
previously missed altogether, both real backends with zero portal
wiring:** `src/eden/redteam/probes.py` (699 lines) is a fully built,
tested, SSRF-hardened adversarial red-team probe suite (12 named probes
across jailbreak/injection/PII-leak/excessive-agency families, four
mounted routes, its own findings table) that no prior pass covered
despite `KNOWN-SUBSYSTEMS.md` explicitly flagging it as unchecked — the
portal's `/redteam` path is hard-redirected to `/unavailable` and a
former `tab=redteam` query param under Guardrails is now silently
normalized away, evidence a UI once existed and was removed without
replacement. `src/eden/governance/compliance_pack.py` is an agent-scoped
compliance evidence generator layered on a genuine SHA-256 hash-chained,
tamper-evident audit ledger (`verify_chain()`, unit-tested for
deliberately-tampered chains) that is **enabled by default** — also
entirely unmentioned by prior passes. Both are the same "backend built,
unreachable in product" shape as everything else in this section, just
newly discovered.

### 14. [P0] GDPR erasure: 2-table shallow live path vs. a real 6-table+multi-store fanout sitting behind an unchecked, default-off flag

`features/07-security-compliance.md`. The live, user-facing "delete my
data" path (`compliance.py:123` `delete_me` → `compliance_jobs.py:239-262`
`run_user_delete_job`) touches exactly two tables — `org_members`
(hard delete) and `users` (soft anonymize). A well-engineered six-table,
multi-store fanout implementation genuinely exists
(`src/eden/services/governance_intel/gdpr.py`,
`RightToBeForgottenService.process_request`), but is reachable only via a
separate route (`POST /governance/rtbf`,
`intelligence_governance.py:367-376`) gated behind
`rtbf_fanout_v1` (`config.py:1252`, defaulting `False`) — a flag the live
delete-me path never checks. Even if flipped on, two of the six fanout
stores (Typesense, Redis) would falsely report `status: "ok"` while
erasing nothing (Typesense's `SPAN_SCHEMA` has no `user_id` field at all).
This is genuine, unconditional GDPR Art. 17 exposure today — mitigated
only by low current user count, not by anything in the code.

### 15. [P1] Session timeline UI has unbounded growth with zero backend limit

`optimizations/04-frontend-perf.md`. The timeline route backing the
session UI has no `limit`/`offset`/pagination parameter at all;
`src/eden/sessions/timeline.py:192-195` fetches every trace ID for a
session unbounded. Combined with the per-turn DOM structure in
`TurnCard` (`clients/portal/src/lab/traces-session-lens.tsx:136-211`),
this produces an estimated ~32,000–43,000 DOM nodes for a realistic 24-hour
session — the only list surface in the audited portal with no server-side
cap of any kind (every other unvirtualized list at least has pagination to
fall back on).

### 16. [P1] Doc fabrication is a systemic problem, not an isolated one — 15 citations across 6 separately-maintained tracking docs

`bugs/01-dead-code-stale-docs.md`. `docs/specs/CODEBASE-GROUND-TRUTH.md:161`
— a doc literally named "ground truth" — invents an entire portal
component directory, `clients/portal/src/components/portal-os/`, listing
10 named components, **6 of which have zero matches anywhere in the
repo** (`ResourcePageShell`, `CoreResourcePage`, `DetailPanelShell`,
`DensityProvider`, `InfiniteDataTable`, `BulkActionBar`). This is not an
isolated slip: the same 2-3 fabricated component names
(`BulkActionBar`, `TranscriptV2`, `SpanSearchBar`) recur across
`SOTA-WAVE-TRACKER.md` (3 separate line citations), a second
`CODEBASE-GROUND-TRUTH.md` line (182), `SOTA-PERF-COST-SCORECARD.md:14`,
`SOTA-MARKET-READY-REPORT.md` (lines 40 and 70), and
`GA-COMPLETION-CHECKLIST.md:141` — 15 distinct citations across 6
separately-maintained documents, all independently confirmed absent from
`clients/portal/src` by direct grep. `SOTA-WAVE-TRACKER.md:326`'s claim
that W20 unmounted `ai_agent.router` also runs backwards — it was mounted,
not unmounted, and both `ai_agent.router` and `ai_insights.router` remain
live simultaneously, each uniquely owning routes the other doesn't
replicate (independently reconfirmed in `bugs/03`).

---

## Part 1 — Cross-Cutting Patterns

### (a) "Sophisticated backend, missing last-mile wiring" — the dominant shape of nearly every gap in this review

This is not a one-off observation about one subsystem — it is the load-
bearing pattern of the whole review. A non-exhaustive list of subsystems
that are genuinely complete or near-complete on the backend with **zero or
near-zero live consumers**: the IAA/labeling engine (`labeling.py`, real
Cohen's kappa/Krippendorff's alpha, zero portal callers — `features/08`);
the autonomous prompt-evolution/canary system (`agents/evolution/`,
`llmops/promotion.py` — zero portal UI, and per finding #4, the promote
step itself is separately broken — `features/13`); the human-facing
prompt playground itself (`playground/scorers.py`'s real exact-match/
regex/json_valid/levenshtein scorers, wired only to a manual UI, never to
CI, and its "Promote to Experiment" button silently hands off to a
heuristic-stub scorer instead of the real one the user just watched run —
`features/03`); the cost-aware multi-provider `AIGateway` router (real
`_select_provider` logic, reachable only from offline replay paths,
orphaned via a 410-Gone route retirement on 2026-07-04 — **now a
definitive DELETE verdict, resolved this pass: `features/10` traces every
call site and owns the call, `features/06` defers to it**); the cohort/
funnel analytics module (`analytics/cohorts.py`/`funnels.py`, mounted and
tested, but querying the wrong tables — now confirmed **three**
disconnected tables, not two, after adding `agent_sessions` —
`features/11`); the six-table GDPR fanout (`governance_intel/gdpr.py`,
finding #14); the guardrails engine itself (finding #1) — real and
fail-closed when actually reached, but reached by exactly one caller; and,
new this pass, an entire red-team probe suite and a hash-chain compliance
ledger, both live and tested with zero portal wiring (finding #13,
`features/07`). The pattern repeats at the mechanism level too: eden's
shadow-detector confirm/dismiss loop (finding #11, Loop 1) and its
already-scheduled weekly `promote_shadow_detectors` job are both starved
by the same missing wire, meaning one fix unblocks two disconnected pieces
of otherwise-working machinery at once — and, discovered this pass, a
*second*, much larger autonomous loop (`src/eden/improvement/`, finding
#11 addendum) shows the opposite failure mode: it is well-wired end-to-end
with a real review UI, proof the pattern is about wiring debt, not an
inability to ship a closed loop at all.

### (b) Silent failure is the dominant *bug* shape — at least 25 distinct instances found across the 26 documents

Bare `except Exception` blocks that swallow real errors, dead imports with
silent fallback behavior, and no-ops that return success-shaped output
without raising or logging at a visible level recur constantly. A
representative, non-exhaustive sample spanning multiple categories (the
`bugs/` docs alone yielded 17 distinct instances in this pass's
verification):

- RCA's incident-cluster query swallows `UndefinedColumnError` at debug
  level and returns `[]` (`_common.py:211-213`) — finding #3.
- `resolve_issue` echoes `HTTP 200` with the requested status even when the
  underlying DB write failed a CHECK constraint
  (`agent_issues.py:167-223`, `repo.py:329-331`) — the "Acknowledge" button
  is a silent no-op.
- The guardrails hot-path monkey-patch never calls the one logging function
  that would have surfaced the bypass (`intervention.py:762` vs. the
  wrapper in `wiring.py:279-364`) — finding #1.
- `AlertStreamProcessor` and its PagerDuty channel both fail silently by
  construction (no callers, two-line no-op) — finding #2.
- `SignalEventClusterer._embed`'s missing-module import is caught and
  silently downgrades to a hash fallback — finding #8.
- The MCP `get_judge_scores` tool's own client-side handler has a bare
  `except Exception: pass` that discards the real HTTP error and returns
  a fabricated-looking `{"status": "ok", "scores": []}`
  (`mcp_server/tools.py:418-419`).
- `TriageAgent`'s crash is caught by a bare `except Exception` one layer up
  and downgraded to a warning log — finding #6.
- NULL `agent_id` telemetry is silently dropped from prompt-evolution
  scoring with no counter or alert (`agents/evolution/components.py:78,93`)
  and silently excluded from the entire portal dashboard
  (`api/routes/portal.py:941,1076`).
- The trace status badge silently mismarks `timeout`/`crash` traces as
  green "ok" because `_map_trace_outcome` (`portal.py:177-183`) omits
  values its own sibling constant `_ERROR_OUTCOMES` correctly includes
  nine lines below — now `bugs/02`'s own top-ranked finding, see finding
  #3 above.
- `EvidenceGate.enqueue` silently returns `None` on the promotion type
  mismatch rather than raising — finding #4.
- Six of eight retention policies are silently no-ops with only a key-
  existence test in CI, never a row-touched assertion — finding #9.

This is worth naming as a first-class engineering pattern to fix
systemically (lint rule against bare `except Exception: pass`/`return []`/
`return None` without a log line at `warning`+ level, or a required
telemetry counter on every fallback branch) rather than patching each
instance ad hoc as it's discovered.

### (c) Documentation fabrication spans multiple, separately-maintained tracking docs

Not confined to one file — finding #16 above traces the same 2-3 invented
component names across 6 different `docs/specs/` tracking documents (15
citations total), plus a backwards claim in `SOTA-WAVE-TRACKER.md` about a
router-mount that a prior pass believed it had corrected but Pass 3 found
had not actually been fixed. `optimizations/01`'s finding that a cited
benchmark artifact (`bench/results/f12-span-search-1m-typesense-
20260804.json`, referenced as settled evidence in
`SOTA-PERF-COST-SCORECARD.md`) cannot be reproduced by any code currently
in version control is the same category of problem in a different guise —
tracking docs asserting settled facts that the underlying evidence
doesn't actually support. Treat every "SHIPPED"/"DONE"/"GREEN" claim in
these five trackers as unverified until independently re-checked against
source, not as ground truth.

### (d) Internal implementation runbooks in `supplementaries/` that were partially executed and abandoned

`supplementaries/research/` contains 12 large internal research/runbook
documents (`01_tracerazor_metrics.md` through `12_adversarial.md`, ~11,300
lines total). Of these, **one is confirmed, with direct evidence, to have
been partially executed and then abandoned**: `05_otel_genai.md` (dated
2026-06-28) is a complete implementation runbook — 30 named columns, 6
partial indexes, a CHECK-constraint enum, and an exact `INSERT`/`from_dict`
diff spec — that was executed only through the DDL step (migration 067)
and stops there; the dataclass and Pydantic ingest-model changes it
specifies (`features/05-multiagent-tracing.md`) were never made. Two tells
confirm the doc genuinely predates and diverged from what shipped: it
targets migration slot "066," which was consumed by an unrelated migration,
pushing the actual work to 067 and implying the plan sat unexecuted across
at least one migration-numbering cycle; and it specifies OTel-canonical
column names (`usage_input_tokens`) that don't match what migration 067
actually shipped (`usage_prompt_tokens`), meaning the DDL and the design
doc have already drifted from each other independent of the ingestion gap.
A second, related but distinct reference was found in `features/12`:
`supplementaries/phase_7_detection/detectors.py`, a self-contained
deterministic trace-eval pipeline mentioned only in a comment, not
imported by `src/eden` or wired into `app.py` — this is better classified
as an unused standalone module than a "partially executed runbook," since
there's no evidence it was ever wired in the first place. **This pass did
not trace implementation status for the other 10 research docs in
`supplementaries/research/`** — that is worth a dedicated follow-up pass,
since the one confirmed instance (§05) suggests the pattern may recur.

---

## Part 2 — Revised Phased Build Plan

### Phase A — P0 safety and correctness fixes (ship before any feature work)

These are the items where a shipped, default-on, customer-facing claim is
false today, silently. None require new product surface — all are fixes to
existing, already-live code paths.

1. **Decide and fix the guardrails hot-path collision (finding #1).** This
   is a decision, not just a patch: either restore content-safety checks
   whenever `trace_id` is present, or make the trajectory-check substitution
   explicit and separately surfaced (not silently swapped into the same
   response envelope) — and wire the missing monitoring (an
   `intervention_log` write and/or metric on the bypass path) regardless of
   which direction is chosen. **Bundle in the finding #1 addendum**:
   collapse the two `EvalToGuardrailLink` classes into one — either make
   the documented `promote-judge` endpoint call the same gateway-filter
   hot-reload the working class does, or delete it and repoint the route —
   and give the enforcing class a demote/disable route, since it currently
   has none.
2. **Make the P0 alert path real, or formally cut on-call ambitions
   (finding #2).** At minimum: wire `sandbox.security_alert` emission from
   the real escape guard, give `AlertStreamProcessor.process_event` a real
   caller, and implement (or explicitly remove) PagerDuty/webhook dispatch
   rather than leaving decorative no-ops that look configured.
3. **Fix the trace-badge miscategorization first (finding #3, now the
   top-priority item in this pair)** — a one-line fix to
   `_map_trace_outcome` (`portal.py:177-183`) to include `timeout`/`crash`
   in its error check, live on every trace page view today. **Then**, at
   lower urgency since its only live consumer was deleted, fix or
   gracefully degrade `POST /incidents/cluster`: either add the missing
   `error` column via migration and repoint the query at the real error
   signal, or make the failure loud (raise, log at error level, return a
   degraded-state flag) instead of a silent empty success.
4. **Unblock prompt-canary promotion (finding #4).** Fix the `ref_id`
   type mismatch (cast or change the column type) and extend
   `_metrics_from_outcomes` to populate real samples for
   `kind="prompt_version"`, then add a test that exercises the real gate
   against Postgres, not a mock.
5. **Fix `budget_consumption`'s dead path for gateway-proxy traffic
   (finding #5).** Either route live gateway calls through
   `record_usage`, or add a reconciliation job against
   `usage_events`/`customer_cost_events`; separately, repoint
   `QuotaEnforcementMiddleware` at the customer-configured
   `budgets.cost_hard_limit_usd` rather than the unrelated
   `org_resource_limits` table.
6. **Fix `TriageAgent`'s `UnboundLocalError` regression (finding #6)** —
   trivial, one-variable fix, but currently defeating automatic triage on
   every successful investigation in production (issues still reach a
   human via retry-then-escalate, but never via the intended automatic
   path).
7. **Fix or remove the 3 nonexistent-route MCP tools (finding #7)** —
   `query_eql`, `query_sql`, `get_judge_scores` — before any MCP-surface
   marketing claims are made; fix the `limit`-ignoring pair as a lower-
   priority follow-on.
8. **Resolve the SSO callback (finding #13) and either flip on and harden
   the RTBF fanout or wire the live delete-me path through it
   (finding #14)** before either capability is represented as
   customer-ready in sales conversations. **Not a P0 fix, but cheap and
   worth bundling into the same push**: give the red-team probe suite and
   the compliance-pack ledger (finding #13 addendum, `features/07` §6-7)
   real portal surfaces — both are live, tested backends today with a
   hard-redirected or nonexistent UI, the cheapest exposure win in the
   whole security/compliance area.

### Phase B — Close the flagship loop, then build its cohesive dependents

The wiring fix for finding #11 is presented across the source docs
themselves as a cohesive initiative with its two new dependents — sequence
them together, not as separate roadmap items:

9. **Wire `record_shadow_feedback` end-to-end** per the 4-step plan in
   `features/13` (stumble-join with the JSONB-string fix, resolved/ignored
   both call the feedback path, `nl_signals.agent_id` migration,
   `resolve_profile` per-agent aggregation).
10. **Un-stub eden's already-built Artifacts/Ledger system** (`features/15`
    — reframed this pass from "build a new system" to "un-stub an existing
    one," ~5-7 days not ~1.5-2 weeks). Remove `/artifacts` and `/ledger`
    from the portal's dead-stub map and build both pages against the
    `learn.py` API surface that already exists; ship `diff_since_version()`
    as a "what changed" view (best value/effort ratio in this feature);
    wire `TriageAgent` to read `LedgerGenerator.get_latest()` before its
    8-call ReAct evidence loop; add the one genuinely-missing piece
    (team-uploaded `.txt`/`.md` context); wire the one missing
    regeneration trigger — sequence immediately after step 9, since the
    Ledger's confidence score is otherwise meaningless.
11. **Ship the issue-ranking fix** (`features/16`) — composite
    severity × log(user_count) × log(stumble_count) × confidence ordering,
    `userCount`/`confidence` surfaced in the DTO, `relatedSignalId` wired
    — same sequencing dependency on step 9.
12. **Move `cluster_after_match` off the synchronous ingest path and fix
    the dead embedding call** (finding #8) — add the two missing
    `signal_events` indexes first (cheap, additive), then decouple
    clustering from the shared 5-slot ingest consumer, then repoint
    `_embed` at the real `embed_text` function.

### Phase C — Rescope, expose, and hygiene

13. Ship portal UI against already-complete backends: annotation/labeling
    queues (`features/08`, fixing the lease-recovery gap first), the
    prompt-evolution/canary UI (`features/03`, only after Phase A #4 lands),
    session-analytics repointing at `session_summaries` (`features/11`).
14. Portal-first agent registration + `agent_id` required promotion
    (`features/09`) — already cheap, fully-plumbed in both SDKs.
15. Close the TS SDK auto-instrument gap (`features/09`) — `_safeRequire`
    already resolves the module reference it needs, it just discards it.
16. Fix the 4-instance cron watermark bug (`optimizations/05`) using the
    existing `ColumnarCompactor` `ORDER BY ... NULLS FIRST` pattern.
17. Delete the dormant `AIGateway` routing path (`features/06`,
    `features/10` — now a definitive delete verdict, not a hedge) and
    fix or formally document the 6 no-op retention policies
    (finding #9) rather than leaving them silently aspirational.
18. Add virtualization + a real server-side limit param to the session
    timeline (finding #15) and the other unvirtualized list surfaces.
19. Resolve the F12 search-benchmark provenance flag
    (`optimizations/01`) before citing it in any scorecard again, and
    correct the 15-citation doc-fabrication trail (finding #16) across
    all 6 affected tracking documents.
20. Audit the remaining 10 `supplementaries/research/` runbooks for the
    same partially-executed-and-abandoned pattern confirmed in
    `05_otel_genai.md` (cross-cutting pattern (d)).

---

## Part 3 — Full File Index

### Features (16 files)

| File | One-sentence description |
|---|---|
| `features/01-competitor-matrix.md` | Broad competitor landscape (Lemma, LangSmith, Braintrust, Langfuse, Arize, +7 more) cross-referenced against 6 previously-uncatalogued eden modules, surfacing `time_travel/forker.py` as an unmatched differentiator. |
| `features/02-evals-datasets.md` | Maps ten overlapping eval/dataset subsystems and finds a live, API-mounted "experiments" feature (`offline_runner.py`) produces fake heuristic scores, not real evaluations. |
| `features/03-prompt-playground.md` | Rescoped this pass to the real, human-driven `src/eden/playground/` product surface (CRUD, run, SSE, scorers, a first-class portal editor); finds its "Promote to Experiment" button silently hands the user's real scored comparison off to a heuristic-stub scorer instead. |
| `features/04-alerting-oncall.md` | Traces the P0 alert path from trigger to human notification and finds the entire chain — rule engine, trigger emission, every channel — is unreachable dead code. |
| `features/05-multiagent-tracing.md` | Explains mechanically why OTel/A2A-aligned telemetry columns are never populated by ingestion, and finds a partially-executed internal runbook behind the gap. |
| `features/06-cost-governance.md` | Finds eden's org-level budget feature is real but runs on a structurally disjoint tracking pipeline from the one that enforces spend, with $0 forever for gateway-proxy traffic; defers the `AIGateway` build-vs-delete call to `features/10`. |
| `features/07-security-compliance.md` | Finds SSO's DB layer was fixed 2026-08-02 but the login callback unconditionally 503s, GDPR erasure's live path is 2 tables vs. an unused 6-table fanout behind a default-off flag, and — new this pass — two more live, tested backends (red-team probes, a hash-chain compliance ledger) with zero portal wiring. |
| `features/08-annotation-labeling.md` | Confirms a real, tested IAA/kappa labeling engine with zero portal consumers, plus a lease-recovery gap and a fail-open exception swallow in lease claiming. |
| `features/09-sdk-dx.md` | Confirms `agent_id` is fully plumbed in both SDKs already, and finds the TS SDK's auto-instrument function discards the exact module reference it needs to actually patch. |
| `features/10-model-gateway.md` | Confirms `AIGateway`'s cost-aware routing has zero production callers and owns the cross-doc **definitive DELETE verdict** (resolved this pass), and finds eden's own internal LLM traffic has no provider fallback list at all. |
| `features/11-session-analytics.md` | Corrects a prior pass's "no analytics code exists" claim — real cohort/funnel code exists, mounted and tested, but queries the wrong (pre-`session_summaries`) tables; the session data model is confirmed **three** disconnected tables, not two. |
| `features/12-runtime-guardrails.md` | Finds the guardrails engine's one production caller is silently rerouted away from PII/injection checks whenever `trace_id` is present, with zero monitoring on the bypass — argued as the review's #1 finding — plus, new this pass, two incompatible classes both named `EvalToGuardrailLink` that make eval→guardrail promotion non-functional end-to-end. |
| `features/13-continuous-improvement-loop.md` | The flagship finding: traces exactly why the shadow-detector confirm/dismiss loop (Loop 1) is fully built but never wired, with a corrected, engineer-ready 4-step fix plan; new this pass, documents a second, ~9,800-line autonomous issue→patch→test→auto-merge→auto-revert loop (Loop 2, `src/eden/improvement/`) that — unlike Loop 1 — is genuinely well-wired with a real portal review UI. |
| `features/14-user-request-mining.md` | External signal-mining pass confirming Lemma is already shipping close to the "close the loop" pitch eden's own flagship finding calls a differentiator — competitive window closing. |
| `features/15-artifacts-behavior-record.md` | Confirms Lemma's "Artifacts" (per-agent behavior record) is real via primary-source API docs; reframed this pass from "build a new system" to **un-stub eden's own existing GA-default-on artifacts/ledger system**, which has zero portal wiring — verdict UN-STUB, ~5-7 days (was ~1.5-2 weeks to build). |
| `features/16-issue-extraction-online-evals.md` | NEW. Confirms eden already implements Lemma's "Issue Extraction"-equivalent capability end-to-end except for ranking — traces that gap from Postgres column to React component. |

### Optimizations (6 files)

| File | One-sentence description |
|---|---|
| `optimizations/01-hotpath-perf.md` | Flags that a cited F12 search-latency benchmark artifact cannot be reproduced by any code in version control, and independently confirms the signal-clustering dead embedding call; trimmed this pass (a non-reproducible microbenchmark row cut, redundancy with `optimizations/02` removed — that doc is now the primary treatment of the shared bug). |
| `optimizations/02-db-queries.md` | Finds `signal_events` has no usable index for its real read pattern, and its consumer chains an unindexed fetch + dead embedding call + O(n²) scan inline on the shared ingest path; a prior-pass false-positive finding (F10) is resolved this pass as a no-op. |
| `optimizations/03-llm-cost.md` | Traces a real, small cost-ledger miscount through 5 call sites including a previously-undocumented "Ask Eden" natural-language query feature. |
| `optimizations/04-frontend-perf.md` | Confirms unvirtualized issue/session-turn lists, and finds the session timeline is the only list in the audited surface with no backend limit param at all. |
| `optimizations/05-cron-jobs.md` | Finds the missing-`ORDER BY` cron watermark bug recurs in 4 places (not 1), one of which already caused a realized 7.4-day production outage. |
| `optimizations/06-storage-retention.md` | Finds 6 of 8 declared retention policies are structurally unenforced (2 genuinely work), and that the real unbounded-growth risk is `trace_replay_sessions`, not the legacy table a prior pass named. |

### Bugs (4 files)

| File | One-sentence description |
|---|---|
| `bugs/01-dead-code-stale-docs.md` | A 4-round dead-code sweep plus a stale-docs audit showing the same fabricated component names recur across 6 separately-maintained tracking documents. |
| `bugs/02-data-consistency.md` | Traces agent-identity fragmentation and enum mismatches to their root causes; severity re-ranked this pass — the portal trace badge showing green "ok" for `timeout`/`crash` traces is now the worst finding, displacing the `POST /incidents/cluster` schema bug (demoted after its only frontend consumer, `rcaApi`, was deleted as dead code 3 days before this review). |
| `bugs/03-api-mcp-contracts.md` | A tool-by-tool schema diff of all 28 MCP tools against real backend routes, finding 5 additional broken tools (3 calling nonexistent routes) beyond the known rerun bug; MCP-specific findings downgraded P0→P1 this pass after confirming MCP is in soft-retirement (feature-flagged off, zero internal callers) — two live-portal bugs independent of MCP keep original severity. |
| `bugs/04-frontend-and-test-failures.md` | Reran the full backend and portal test suites fresh, correcting one misdiagnosed failure and discovering a live 2026-08-04 regression that stalls every successful auto-triage. |

---

## Corrections Applied This Pass

Pass 4 re-verified all 26 documents against live source independently
(1-3 agents per doc) rather than trusting prior-pass prose, and pruned
false, stale, or unlabeled-speculative content across the board. Two
corrections were structural enough to change what a document is *about*,
not just what it claims, and are worth naming explicitly rather than
letting them read as routine line-item fixes: **`features/03` was tracing
the wrong subsystem for three full passes** (the autonomous prompt-
evolution loop, now correctly homed in `features/13`, instead of the
real human-facing `src/eden/playground/` product) — the same
`KNOWN-SUBSYSTEMS.md` inventory that caught this also flagged
`src/eden/improvement/` as a second, larger closed loop `features/13`
had never covered, now added as "Loop 2." Every other correction called
out inline above (the two `EvalToGuardrailLink` classes in
`features/12`; the reframe of `features/15` from build-a-schema to
un-stub-an-existing-system; the two new subsystems in `features/07`; the
three-not-two-table correction in `features/11`; the resolved
`AIGateway` DELETE verdict between `features/06`/`features/10`; the
severity re-ranking inside `bugs/02`; the MCP P0→P1 downgrade inside
`bugs/03`) is the current, load-bearing state of this review — treat
findings summarized in Part 0 above as reflecting each source document's
present content, not a snapshot from an earlier pass.

## Why This Still Makes Eden the Best Product in This Category

Every competitor researched across all 16 feature files — Lemma,
LangSmith, Braintrust, Arize Phoenix, Langfuse, Helicone, Portkey,
OpenRouter, LiteLLM, Datadog, Honeycomb, PostHog, and others — either
doesn't attempt eden's core bets (closing the production→detection loop
automatically, counterfactual trace forking, a fully autonomous
prompt-evolution/canary system) or, in Lemma's case, has fully wired the
equivalent machinery while eden has mostly only built, not connected, its
own. The gap this review identifies, repeatedly, is not missing
capability — it's wiring, monitoring, and exposure. Pass 4's discovery of
`src/eden/improvement/` (Loop 2, finding #11) is the clearest existence
proof that this is a wiring problem and not a capability ceiling: it is
the same "shadow candidate → gate → promote" shape as the still-unwired
shadow-detector loop, built by the same engineering org, and it *is*
fully wired end-to-end with a real, trust-building review UI — eden has
already proven it can ship this pattern completely; it just hasn't done
so consistently yet. That reframes the
priority order correctly: fix the handful of places where a silent gap
means a customer-facing claim is actively false today (Part 2, Phase A),
close the flagship feedback loop and its two newly-specified dependents
second (Phase B), then spend the remaining effort exposing already-built
backends and cleaning up hygiene and documentation debt (Phase C) — in
that order, not the reverse.
