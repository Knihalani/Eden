# Pass 4 review notes — `features/01-competitor-matrix.md`

Reviewer: sole reviewer, pass 4 (final). Doc under review NOT edited — see
target doc at `docs/specs/strategic-review-2026-08/features/01-competitor-matrix.md`.

Method: every eden `file:line` citation in the doc was independently re-read
against `main` (HEAD `6f2a09d3`, matches the doc's own claimed HEAD) via
direct file reads/greps, not trusted from the doc's prose. External
(competitor) claims could not be re-verified this pass — `WebSearch` returned
"session has used its web search budget (200 of 200)" for every query
attempted (LangSmith Engine pricing, Patronus Series B, W&B/CoreWeave). This
is disclosed wherever it affects a verdict below; no external claim is marked
VERIFIED, only "internally consistent / plausible / not independently
re-checked."

---

## VERIFIED

All of the following eden-side `file:line` citations were opened and read in
full this pass and match the doc's description of their content:

- `src/eden/topics/service.py:18-59` (`list_topics`), `:147-153`
  (`generate_topics` calls `patterns_clusterer.run_once()`, does not run a
  fresh per-trace LLM pass), `:156-212` (`_sync_patterns_to_topics` mirrors
  top-50 `trace_patterns` rows, `LIMIT 50` confirmed literally at line 172),
  `:217-256` (`act_on_topic`, `DatasetHub` bridge confirmed). The doc's
  characterization — "derived from, not independent of, the existing
  pattern-clustering engine" — is accurate.
- `src/eden/time_travel/forker.py:1-30` (docstring explicitly says v1.3 does
  NOT clone `telemetry_events`, confirmed verbatim), `:52-124`
  (`TraceForker.fork`, `parent_fork_id`/`edits_json`/`cache_lookups`
  mechanics all confirmed as described).
- `src/eden/redteam/probes.py:334-511` (all 12 named probes — `stan_jailbreak`
  through `tool_amplification` — confirmed present in the `PROBES` dict at
  those exact names), `probes.py:552-657` (`ProbeRunner`, `run_probe` at 574,
  `run_suite` at 619, `_persist_finding` at 634, `_fire_drift_alert` at 658 —
  confirmed it logs a warning and defers to a route-layer-wired callback
  rather than directly calling the Cat 13 pipeline, matching the doc's
  characterization).
- `src/eden/predictive/drift.py:1-38` (docstring self-admits the
  hash-bucket embedding-drift proxy verbatim, confirmed), `:97-186`
  (`detect_output_drift`), `:187-285` (`detect_embedding_drift`), `:286`
  (`_severity_for_psi`) — all line numbers exact.
- `src/eden/change_impact/preview.py:75` (`ChangeDetector` class),
  `:100` (`ImpactPreviewOrchestrator` class), `:426-477`
  (`post_github_check_and_comment`, confirmed it returns
  `{"skipped": True, "reason": "github_not_configured"}` verbatim when
  `not is_configured()`) — exact match.
- `src/eden/integrations/github/oauth.py:558` (`create_check_run`), `:581`
  (`create_pr_comment`) — exact line match, confirming eden does have a
  working GitHub write client (the doc's "not GitHub-blind" correction is
  well-supported).
- `src/eden/apm_depth/step_judges.py:1-22` — docstring literally says "The v0
  ship is **stamping only**", confirmed verbatim; `stamp`/`get_step_judges`/
  `get_trace_steps` all present as named.
- `src/eden/services/soft_issue_review.py:333-478` (shadow-detector
  lifecycle; `evaluate_shadow_precision` defaults confirmed exactly:
  `min_firings=20, promote_precision=0.8, delete_precision=0.3`) — matches
  the doc's "precision≥0.8 & ≥20 firings → promote, precision<0.3 → delete"
  claim exactly. `record_shadow_feedback` defined at line 571 (doc cites
  571) — **confirmed zero call-sites repo-wide** via
  `grep -rn "record_shadow_feedback(" --include="*.py" .` (only the `def`
  itself and a `__all__`/debug-log string match) — this is a real, checkable
  finding, not an assertion.
- `src/eden/agents/evolution/components.py` — `IssuePromptEvolver`
  (`evolve_from_issue`, class at line 662, method at 674) confirmed to
  contain zero `github`/`pull_request`/`create_pr` references
  (`grep -in "github\|pull_request\|create_pr"` on the file returned
  nothing) — the "creates an internal prompt-version candidate, no PR" claim
  is accurate.
- `src/eden/api/routes/intelligence_rca.py:80-123` (`_build_causal_chain`),
  `:126-156` (`/chain` endpoint, `rca_chain` at 127), `:159`
  (`/incidents/cluster`), `:179` (`/incidents/{cluster_id}/resolve`) — all
  confirmed at the cited lines.
- `src/eden/realtime/alert_stream.py:427-429` — confirmed exactly:
  `_dispatch_pagerduty` at line 427, and line 429 is literally
  `logger.info("PagerDuty alert skipped:not_configured: %s", alert.title)` —
  the "literal no-op stub" characterization is accurate and precisely cited.
- `src/eden/api/routes/sessions.py:153-171` (`SessionSummaryItem`, incl.
  `total_cost_usd`) and `:188-202` (`SessionTurn`, incl. `cost_usd`) both
  confirmed — reused legitimately across two different matrix rows (cost
  tracking and session timeline), not a duplication error.
- `src/eden/guardrails/intervention.py:440-517` — confirmed the fail-closed
  branch returns `verdict: "block"` with `reason: "no_active_policies"`
  when no policies are active, matching "fail-closed on no active policies."
- `src/eden/evaluation/golden_dataset.py` — confirmed `expected_behavior` is
  a per-*test-case* dict field (appears ~50 times as a literal dict key in
  hardcoded test-case definitions, not a per-agent object) and confirmed via
  grep there is no `agent_spec`/`behavior_contract` symbol anywhere under
  `src/eden` — the "Missing" verdict for a persistent per-agent behavior
  object (pre-Artifacts-correction) is accurate.
- Cross-checked against `KNOWN-SUBSYSTEMS.md`: all six "new this pass"
  modules (`topics/`, `time_travel/forker.py`, `redteam/`, `predictive/`,
  `change_impact/`, `apm_depth/`) are indeed either absent from, or only in
  the "not yet inspected" list of, the ground-truth inventory — consistent
  with the doc's claim these were previously uncovered.

**Overall:** the eden-side sourcing in this doc is unusually rigorous —
every citation checked resolved to the exact claimed content, and several
(the `record_shadow_feedback` zero-callers claim, the PagerDuty stub, the
GitHub-write-client discovery) are independently re-confirmable with a
single grep, which I did. This is a high-trust doc on the internal-evidence
axis.

---

## CUT

1. **Quote:** (Verdicts section) *"PagerDuty alerting... Now 5 of the 18
   competitors researched across all three passes (LangSmith, Langfuse,
   Arize AX, AgentOps via its RBAC/export tier, and implicitly Datadog) ship
   live PagerDuty integration."*
   **Reason:** unsupported by the doc's own evidence. Grepping the whole doc
   for "PagerDuty" turns up exactly two locations: the main matrix row
   (which sources PagerDuty specifically only for LangSmith and Arize AX —
   Langfuse's cell just says "Have" with no PagerDuty-specific sourcing) and
   this Verdicts sentence itself. **AgentOps's own paragraph earlier in the
   doc never mentions PagerDuty at all** — it lists "Free (5,000 events),
   Pro $40/mo (unlimited events, retention, export, RBAC), Enterprise
   (on-prem/self-hosted)" with no alerting-channel detail, so "via its
   RBAC/export tier" is a non-sequitur inference, not a sourced fact.
   **Datadog is only mentioned once elsewhere**, in the extended-landscape
   spot-check table, for "unsupervised weekly anomaly/outlier detection" —
   never for PagerDuty — so "implicitly Datadog" is a bare guess (Datadog
   plausibly has PagerDuty integration given its own incident-management
   product line, but that's an inference the doc doesn't source, and the
   doc's own evidence-quality notes elsewhere are careful to flag
   unsourced framing — this sentence doesn't hold itself to that bar).
   Recommend either dropping the "5 of 18... (names)" enumeration entirely
   and keeping only the two actually-sourced names (LangSmith, Arize AX),
   or explicitly re-flagging Langfuse/AgentOps/Datadog as "plausible but not
   sourced this pass."

2. **Quote:** (Headline finding, lines ~40-91) the full endpoint-by-endpoint
   restatement of Lemma's Artifacts API (six endpoints enumerated with
   descriptions) and Issue Extraction schema (`lanes_fired`, `lane_scores`,
   `validation.status`, `confirmation_verdict` fields spelled out in full).
   **Reason:** redundant with sibling docs. The doc's own scope note (lines
   3-13) states Artifacts and Issue Extraction "now have their own
   standalone spec-depth docs... this file cross-links to them rather than
   duplicating their depth" — but the Headline finding section is ~60 lines
   of the same field-level API detail (`knowledge_md`/`mermaid`,
   `workflow_id`, the six endpoint names, the `lanes_fired`/
   `confirmation_verdict` schema) that `15-artifacts-behavior-record.md`
   (`docs.uselemma.ai`'s Artifacts tag, lines 21-33 of that doc) and
   `16-issue-extraction-online-evals.md` already carry at the same or
   greater depth. Recommend trimming the Headline finding to ~2 paragraphs
   (the verdict-reversal fact + a pointer to 15/16) and moving the endpoint
   enumeration into those docs only, consistent with the doc's own stated
   intent for every *other* row in the matrix (which correctly stay
   one-line-and-a-pointer, e.g. the Evals/Cost/RBAC/Alerting/Dataset rows).

3. **Quote:** *"Company overview (YC/Fondo) claims 90% reduction in manual
   prompt iteration, 'minutes instead of days' for production-drift fixes,
   and ~40% agent-performance drop within weeks of shipping due to input
   drift — self-reported, unverified by a third party."*
   **Reason:** not a cut for falseness (the doc correctly hedges it as
   self-reported/unverified), but flagging that per-task guidance this is
   the kind of number that adds low value once properly caveated — it's
   marketing copy the doc itself says not to trust. Low priority to keep;
   could be dropped without losing any decision-relevant information since
   no matrix row or verdict depends on it. Optional trim, not urgent.

4. **No cut recommended for the "18 competitors" count** (Verdicts: *"now
   spanning 18 competitors across three passes (4 → 12 → 18)"*) — flagged
   instead under NEW FINDINGS below as a minor arithmetic inconsistency,
   not a fabrication, so it doesn't rise to a "false claim" cut; a one-line
   fix is more appropriate than removal.

---

## USER EXPERIENCE & VALUE

The matrix compares *capability existence* across vendors; it says little
about what would make eden's version of each capability actually good to
use day-to-day. Per capability area the matrix covers:

**Span-level tracing + causal-chain RCA** (`intelligence_rca.py`) — Parity
on "Have" is cheap; the daily-use bar is: can an on-call engineer go from a
Slack alert to the exact failing span, with the causal chain already
rendered (not a flat span list they have to manually correlate), in under
10 seconds and zero extra clicks? The value isn't "we have a `/chain`
endpoint," it's whether the *default* trace view opens already collapsed to
the causal path, with the non-causal 95% of spans folded away. If engineers
still have to switch from "trace view" to "RCA view" as a separate mode,
the causal-chain feature is a checkbox, not a workflow win.

**Incident/failure clustering** (`IncidentClusterer`) — Value here lives or
dies on cluster *naming quality* and *triage speed*, not cluster count. A
clustering engine that produces 40 technically-correct-but-vaguely-labeled
clusters ("Issue #38: response quality degradation") is worse to use than
one that produces 10 well-named ones an engineer can triage without opening
each one. Day-to-day good means: cluster names are specific enough to skip
70% of clusters without opening them, clusters are stable week-to-week (not
re-splitting/re-merging every night, which erodes trust and makes "assign
to me" workflows meaningless), and there's a one-click "this cluster and
that cluster are the same, merge them" affordance feeding back into the
clusterer — not just an admin-only override.

**Topics / faceted classification** (`topics/service.py`, F65) — Given it's
explicitly derived from the top-50 `trace_patterns` (not a fresh per-trace
pass), the honest UX framing to ship is "recurring pattern explorer," not
"100% traffic classification" — overselling this against Braintrust's
Topics (which genuinely runs on all traffic) will produce a bad first
impression the moment a user asks "why isn't trace X reflected in any
topic?" and it's the 51st-most-common pattern that day. Good day-to-day use
means the UI is honest about sample coverage (e.g., "based on your top 50
recurring patterns" shown inline, not buried), and the stub `action="alert"`
button should either be removed from the UI entirely or disabled with a
tooltip until it does something — a button that returns `{"status":
"queued"}` and then nothing ever happens is the single fastest way to
destroy user trust in the rest of the feature.

**Shadow-detector lifecycle / auto-propose-promote-delete** — This is
eden's most differentiated capability per the matrix, but its value is
currently *entirely theoretical* to a user: `record_shadow_feedback` has
zero callers, meaning no UI in the product can currently generate the
confirm/dismiss signal the promotion algorithm depends on. For this to be
good day-to-day, a user needs: (a) a visible "shadow detectors" inbox
showing candidate detectors with their current precision/firing-count
against the promote/delete thresholds (0.8 / 20 firings / 0.3), so a user
understands *why* something got promoted or deleted rather than it
happening silently overnight, and (b) confirm/dismiss buttons wired to the
existing `record_shadow_feedback` function on every place a shadow-flagged
issue surfaces (trace view, incident cluster, Slack alert) — right now this
is a backend primitive with no front door.

**Counterfactual trace forking** (`TraceForker`) — The most novel
differentiator found across 18+ competitors, but forking-with-edits is
worthless day-to-day unless the diff between original and forked-and-edited
run is immediately visible side-by-side (not "open two trace tabs and
eyeball it"). Good UX: a fork action available directly from any failing
span ("fork here, edit the tool response, re-run"), a built-in diff view of
before/after judge scores and output text, and fork-of-fork lineage
rendered as an actual tree the user can navigate — not just a
`parent_fork_id` foreign key they'd need the API to explore.

**Red-team probe suite** (`redteam/probes.py`) — 12 named probes with
detectors is a strong start, but the value for an eng/ML user is in
*continuous* running, not one-off manual runs: good day-to-day use means
probes run automatically pre-deploy (gate a PR the way `change_impact`
already gates config diffs) and post-deploy on a schedule, with a trend
view ("jailbreak resistance dropped after last week's prompt change") — a
probe suite you have to remember to click "run" on is a compliance
checkbox, not a safety net. Given `_fire_drift_alert` currently only logs a
warning unless a route layer wires the real callback, the gap between
"probe ran and failed" and "someone got paged" needs to be closed and made
visible in the UI (a probe-failure state should look and feel identical to
any other production alert, not live in a separate, easily-ignored tab).

**Drift detection (PSI, output + embedding)** — Given the doc's own
self-admitted limitation (embedding drift is a 64-bucket text hash, not a
learned embedding), the honest day-to-day UX is to *label the two signals
differently in the product* — output-drift (judge scores) should be
presented with full confidence, embedding/content drift should carry a
visible "coarse signal" indicator so users calibrate trust correctly and
don't file a false-negative bug report when a genuine topic shift doesn't
trip it. Good use also means drift severity (warning/high) should link
directly to the specific traces driving the shift, not just a PSI number —
a number alone doesn't tell an engineer what changed.

**Pre-merge CI trace-replay gate** (`change_impact/preview.py`) — Strongest
differentiator per the doc (real production trace replay vs. static eval
datasets). Value depends entirely on speed and signal-to-noise in the PR
comment: if replaying "stratified production traces" takes 20+ minutes per
PR or produces a wall of noisy per-trace diffs, engineers will start
merging past it. Good day-to-day use: sub-5-minute turnaround for typical
config diffs, a single clear pass/fail/regressed-N-traces summary in the
Check Run (not a raw dump), and a "show me the 3 traces most likely to be
customer-facing regressions" ranking — not all N stratified traces given
equal weight in the comment.

**Per-step judges** (`apm_depth/step_judges.py`) — Explicitly "stamping
only" with no automatic scoring loop wired. There is currently nothing for
a user to experience here — it's pure backend. If/when this ships,
day-to-day value requires the per-step scores to render inline in the trace
timeline (score badge on each step, not a separate query), and for a
degraded step-score trend to be independently alertable from the
trace-level judge score — otherwise this collapses into "we already have
per-trace judges" with no incremental workflow benefit.

**Persistent per-agent "behavior record" (Artifacts-equivalent)** —
Currently `Missing`. If eden builds this, the day-to-day bar Lemma sets is
high: the record has to be something an engineer actually opens instead of
grepping the prompt file, which means it needs a rendered diagram
(Lemma ships `mermaid`), a changelog/version history a human can skim in
under a minute, and — critically, per `15-artifacts-behavior-record.md`'s
own finding — a real confirm/dismiss signal underneath, which today doesn't
exist (same `record_shadow_feedback`-zero-callers gap). Shipping the
descriptive record without first wiring the confirm/dismiss loop would
produce a record whose "confidence" is fake, which is worse for trust than
not shipping it at all.

**Auto-generated fix as a GitHub PR** — eden has the GitHub write primitives
(`create_check_run`, `create_pr_comment`) but they're wired to pre-merge
impact preview, not post-resolution fix delivery. For day-to-day parity
with Lemma/LangSmith Engine, the differentiator that would actually matter
to a user isn't just "can also open a PR" — it's PR quality: a fix PR that
includes the *specific stratified production traces* that motivated it
(which eden already has access to via `change_impact`'s trace-replay
machinery) as regression-test fixtures in the same PR, something neither
Lemma nor LangSmith Engine's marketing claims to do. That would be a real
differentiator worth building toward rather than parity-matching the raw
"open a PR" checkbox.

**Tool-call misuse classifier** (`tool_call_calibrator.py`) — A trained
per-tool classifier is only useful day-to-day if false positives are cheap
to correct and that correction actually retrains the model. Good UX: every
flagged tool-call misuse should have a one-click "not a misuse" action
visible right where the flag appears (trace view, not a separate admin
console), and the precision-floor gate (0.6, confirmed at
`tool_call_calibrator.py:244`) should be visible to users as a live
per-tool precision number, not a hidden backend threshold — so a user
understands why a given tool's misuse detection got disabled if precision
drops below floor.

**Pointer-only rows (evals, cost, alerting, datasets, RBAC — deep-dived in
sibling docs)** — not re-covered here to avoid the exact redundancy this
review is asked to prune; see `02-evals-datasets.md`, `06-cost-governance.md`,
`04-alerting-oncall.md`, `07-security-compliance.md` for UX treatment of
those areas specifically.

**Session timeline** (`sessions.py`) — Value is in scannability across a
long multi-turn conversation: turn cards need to be collapsible/expandable
with the failing turn auto-expanded and auto-scrolled-to on open (not "turn
1 of 40, scroll to find the bad one"), and linked issues should show inline
on the turn card itself, not require a separate issue-lookup.

**Guardrail fail-closed enforcement** (`guardrails/intervention.py`) — A
fail-closed default ("no active policies" → block) is the right safety
posture, but it's a latency and false-block risk in production if a policy
fetch is slow or flaky (the code already has a `policy_fetch_failed` →
block branch). Day-to-day good means the fail-closed path is *rare and
loud* — instrumented and alertable in its own right (a spike in
`reason: policy_fetch_failed` blocks is itself an incident, not just a
guardrail doing its job), so it doesn't silently degrade the product for
users while looking "correct" in a dashboard.

---

## NEW FINDINGS (evidence-only)

1. **`topics/service.py` stub-citation is off by 4 lines.** The doc cites
   `service.py:226-227` for the `action="alert"` no-op stub
   (`{"status": "queued"}`). The actual lines are **230-231**
   (`if action != "dataset": return {"action": action, "topic_id": topic_id,
   "status": "queued"}`), confirmed via
   `grep -n "action != \"dataset\"" src/eden/topics/service.py`. Substance
   of the claim is correct; only the pinpoint line numbers are off.
   Low-severity, worth a one-line fix.

2. **`intelligence_rca.py:159-204` citation for `IncidentClusterer`
   slightly overstates what's at that location.** `IncidentClusterer` is
   not defined in `intelligence_rca.py` — it's imported
   (`from eden.insights.incidents.clusterer import IncidentClusterer,
   IncidentStore`, confirmed at the top of the file) and instantiated as
   `_clusterer = IncidentClusterer()` at module scope. The cited lines
   159-204 do correctly contain the `/incidents/cluster` (159) and
   `/incidents/{cluster_id}/resolve` (179) route handlers that *use* the
   clusterer, so the row's evidence isn't wrong, but a reader following the
   citation expecting to find the `IncidentClusterer` class definition at
   that file/line will not. Minor precision issue, not a factual error.

3. **The "18 competitors" running total doesn't reconcile against the
   doc's own named-entity list.** Counting every distinct entity named in
   the doc's competitor sections: 5 primary (Lemma, LangSmith, Langfuse,
   Braintrust, Arize Phoenix/AX) + 8 extended-landscape (Galileo, Datadog,
   Helicone, PromptLayer, HoneyHive, Maxim AI, Traceloop/OpenLLMetry,
   "Fiddler AI/WhyLabs" — itself two distinct companies bundled as one
   matrix entry) + 6 new-this-pass (Weave, Opik, Confident AI/DeepEval,
   AgentOps, Coval, Patronus AI) = **19 distinct named entities** (or 20 if
   Fiddler AI and WhyLabs, which are different companies, are counted
   separately, as the "Fiddler AI/WhyLabs" naming pattern in the extended
   table implies they should be). The doc's Verdicts section states the
   running total as exactly **18** ("4 → 12 → 18") in two places. This is a
   minor, self-contained arithmetic inconsistency checkable entirely within
   the document — worth a one-line correction, not a substance issue since
   no verdict actually depends on the precise count.

4. **PagerDuty "5 of 18" claim (see CUT #1) is only sourced for 2 of the 5
   named vendors within this document** — LangSmith and Arize AX are
   sourced with PagerDuty specifically in the main matrix row; Langfuse,
   AgentOps, and Datadog are not mentioned alongside "PagerDuty" anywhere
   else in the document (confirmed via full-document grep for "PagerDuty",
   2 hits total, both already accounted for above).
