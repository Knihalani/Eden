# F16 — "Issue Extraction" / rubric-free online evals: ranking + portal surface

Date: 2026-08-05
Scope: Product owner has confirmed, as ground truth, that Lemma (YC F25) ships a
capability marketed as **"Issue Extraction — the first version of online evals
that catches issues you didn't know to look for, no judges, rubrics, or monitors
needed. Automatically surfaces recurring failures across thousands of agent
traces, validates them, and turns them into ranked, actionable issues."** This
doc does not re-litigate whether that capability exists at Lemma — it treats it
as real and asks a narrower, engineering question: **what is the precise gap
between eden's existing mechanism and a shipped product experience that matches
that description**, and what is the exact build to close it.

This file goes deeper than, and does not duplicate, `02-evals-datasets.md` §3
(which first identified `soft_issue_review.py` as eden's analog) and
`13-continuous-improvement-loop.md` (which fully owns the `record_shadow_feedback`
wiring plan — cited here, not re-derived). The net-new material in this pass is:
(1) a harder, second search pass for the exact term "Issue Extraction" in
Lemma's public materials, (2) an independent line-by-line verification of
whether eden's mechanism is actually judge-free, (3) a previously-undocumented
finding — **eden extracts issues but never ranks them** — traced all the way
from the Postgres column to the portal React component, and (4) a concrete
build sequence for a ranked "Issues" feed that would make eden's existing
sentence-for-sentence claim true.

## 0. TL;DR / verdict

**RESCOPE, not build-from-scratch.** Eden's `soft_issue_review.py` +
`issues/` stack already does the extraction, deduplication, and precision-gated
validation half of "Issue Extraction." It does **not** do the "ranked" half —
independently confirmed this pass, with citations below, that eden's issue list
is sorted by recency only (`ORDER BY last_seen DESC`, `repo.py:297`) and that
severity, recurrence frequency, and blast radius, despite existing as real
columns on `agent_issues`, are never combined into a rank. That is a smaller,
more precisely scoped gap than "build Lemma," and it is additive to
`13-continuous-improvement-loop.md`'s P0 (`record_shadow_feedback` wiring) rather
than a competitor to it — the ranking work is close to worthless until that
wiring makes the `confirms`/`dismisses`-derived precision signal real.
This pass also found direct evidence, missed by the prior pass, that Lemma's
own API (`docs.uselemma.ai`, not just its marketing site) ships exactly this:
a composite `lane_scores` priority score and a `validation.confidence` field
on every issue (§1) — the clearest confirmation yet of what eden's ranking
gap needs to close to match the target capability.

## 1. Lemma's public materials, searched harder this pass

Repeating the prior pass's method (site, YC profile, launch coverage) plus the
sources this pass's brief specifically asked for: uselemma.ai's own
`/issue-extraction`, `/product`, `/platform`, `/features`, `/evals` sub-pages,
Wayback Machine, Product Hunt, X/Twitter, LinkedIn.

- `https://www.uselemma.ai/issue-extraction` → **HTTP 404.** No such page
  exists on the live site.
- `/product`, `/platform`, `/features`, `/evals` were not independently
  reachable as distinct pages either (Lemma's site is a single marketing page
  per the prior pass's structure; WebFetch of the root domain, repeated this
  pass, again returns only the "Issues" feature name, never "Issue
  Extraction" — see quotes below).
- Wayback Machine (`web.archive.org/web/*/uselemma.ai`) — **not fetchable from
  this environment** (`Claude Code is unable to fetch from web.archive.org`).
  Flagging this as a real tooling limitation, not a negative finding — a human
  operator with normal web access should re-run this specific check.
- X/Twitter (`site:x.com`/`site:twitter.com "uselemma" "issue extraction"`) →
  no indexed results; X's crawler restrictions mean this is inconclusive
  either way, not a negative result.
- LinkedIn — the one hit found (also surfaced by the prior pass) is the
  founders' "Reintroducing Lemma" relaunch post
  (`linkedin.com/posts/uselemma_reintroducing-lemma-wwwuselemmaai-activity-7470944859797737474-tFZc`),
  which does not use the term "Issue Extraction" in the visible excerpt.
- **`docs.uselemma.ai` (the API reference subdomain) — not checked by the
  prior pass, and the actual location of the term.** Fetched
  `docs.uselemma.ai/llms.txt` (the doc index), then
  `docs.uselemma.ai/api-reference/traces/list-thread-issue-summaries.md`
  directly this pass. The endpoint description reads: *"Batch-fetch issue
  extraction completion and destin issues for thread_ids (join key for eval
  trial_hash)."* Its 200 response schema has a literal top-level field named
  **`extraction`** (`completed: bool`, `status: enum[running|completed|
  skipped|failed]`, `reason: enum[issues_found|no_issues_found|no_spans|
  unsupported_trace|error]`), alongside a sibling `issues` array (`issue_id`,
  `title`, `category`, `rationale`). Further, `docs.uselemma.ai/api-reference/
  issues/get-issue.md` and `list-issues.md` show Lemma's real `Issue` object
  carries **`lane_scores`** (an A/B/C composite priority score),
  **`raw_lane_scores`** (`impact_occurrences`, `impact_trace_share`,
  `spike_ratio`, `persistence_active_days`, `resolution_floor`),
  **`priority_computed_at`**, and a **`validation` object** with `status`
  (valid/invalid/inconclusive/failed/not_run) and a numeric `confidence`
  field. This is real, shipped API surface, not marketing copy — it is
  stronger evidence for "ranked, actionable issues" than anything else found
  either pass, and it directly sharpens §4 below: eden genuinely lacks the
  analog of `lane_scores`/`priority_computed_at`, and Lemma genuinely has it,
  at the schema level.

**What Lemma's live site actually says, quoted directly (`uselemma.ai`,
re-fetched this pass):**
> "Lemma detects failed outcomes directly from live traffic, and it
> automatically identifies the exact cause in an agent chain."

> "Agent tracing observability with live drift detection, regression alerts,
> and performance visibility" across real user interactions.

> Their feature is named **Issues**, not "Issue Extraction": Lemma "audits
> every trace against your agent's instructions and groups recurring failures
> into issues." The worked example: a support agent invents placeholder
> customer IDs instead of asking, flagged as affecting 33 of the last 50 runs
> (23 fabricated lookups, 15 orphaned tickets, 7 escalations to nonexistent
> tickets) — every one of which returned `success`, so nothing surfaced in
> ordinary error monitoring.

> After a fix ships, "Lemma creates an online eval" that "scores every new
> trace against this failure mode," and one example shows an issue marked
> **"Reopened"** after it "Recurred 2m ago."

**Conclusion, corrected this pass:** the prior pass's finding was right about
*marketing* copy — "Issue Extraction" as a verbatim term does not appear
anywhere on `www.uselemma.ai`, and the named marketing feature is "Issues" —
but incomplete about *API* docs, where "issue extraction" is literal endpoint
language and `extraction` is a literal response-schema field
(`docs.uselemma.ai`, above). Combined with the `lane_scores`/
`priority_computed_at`/`validation.confidence` fields on Lemma's real `Issue`
object, this is materially stronger evidence than the marketing-site 404s
alone that the target capability — surface, validate, *and rank* — is a real,
shipped mechanism at Lemma, not just sales language. Per the task's explicit
instruction, whether Lemma calls it "Issue Extraction" publicly is beside the
point either way: the rest of this document treats "online evals that
surface, validate, and rank recurring failures with no rubric/judge/monitor
authoring required" as the target capability, and builds eden's version of it
from what already exists in `src/eden`.

## 2. Independent re-verification: what `soft_issue_review.py` actually does

Read in full this pass (`src/eden/services/soft_issue_review.py`, 650 lines).
Confirms and extends `02-evals-datasets.md` §3b/`13-continuous-improvement-loop.md`'s
findings with exact mechanics:

- **L1 rank** — `_rank_hot_orgs` (`:96-117`) and `_hot_agents` (`:119-135`):
  pure SQL `COUNT(*) ... GROUP BY ... ORDER BY n DESC` over `agent_issues` in
  the last 24h. Zero LLM cost. This is the "which agent does the paid layer
  look at tonight" ranking — **it ranks where to look, not what to show a
  human**, a distinction that matters for §4 below.
- **L3 novelty scout** — `_scout_novel_patterns` (`:248-304`): exactly **one**
  LLM call (`route_async(..., slot="fast", ...)`, DeepSeek per the module
  docstring `:1-31`) per hot agent, given a ≤50-trace digest
  (`_sample_traces`, `:200-233`, capped at `_MAX_DIGEST_CHARS=600` per line,
  `:50`) plus up to 100 existing detector descriptions
  (`_existing_signal_descriptions`, `:235-246`). System prompt (`:270-280`)
  explicitly asks for patterns **not already covered**, capped at 3, and
  requires plain-English one-sentence descriptions "a rule compiler could
  match" — there is no rubric, no expected output, no golden answer anywhere
  in this call. Cost is bounded (`_MAX_ORGS_PER_NIGHT=20`,
  `_MAX_AGENTS_PER_ORG=3`, `_MAX_NEW_DETECTORS_PER_ORG=3`, `:46-50`) and
  budget-checked (`check_budget`, `:142-150`) before any spend.
- **L4 shadow detector** — `_create_shadow_detector` (`:333-376`): compiles
  each candidate via `cat2_intel.signals.compile_signal` into a rule and
  inserts a **disabled** (`enabled=FALSE`) `nl_signals` row, content-deduped
  via `cluster_id = f"auto:{signal_signature(description)}"` (`:345`). The
  agent id is smuggled into free text as `f"[auto:{agent_id}] {description}"`
  (`:363`) — confirmed independently this pass, matching
  `13-continuous-improvement-loop.md` point 4 exactly (`nl_signals` has no
  `agent_id` column).
- **Validation** — `evaluate_shadow_precision` (`:510-568`, pure function,
  independently re-read): `precision = confirms / (confirms + dismisses)`
  when `labeled > 0`; **never auto-promotes on `match_count` alone** — the
  comment "never auto-promote on match_count alone without labels" is backed
  by the actual branch logic (`:546-561`: `if labeled > 0: precision = ...
  else: precision = None`, and `action` can only become `"promote"`/`"delete"`
  when `precision is not None`). This is the self-service validation step —
  "ground truth" is measured operator agreement, not a pre-written expected
  output, matching Lemma's "validates them" framing structurally.
- **Promote/delete** — `promote_shadow_detectors` (`:380-478`, weekly cron):
  precision ≥ 0.8 over ≥ 20 firings → `enabled=TRUE` + Slack
  (`_notify_shadow_promoted`, `:621-643`); precision < 0.3 → `DELETE`.
- **The wiring gap, re-confirmed independently this pass:**
  `record_shadow_feedback` (`:571-618`) is exported (`__all__`, `:646-649`)
  and fully implemented (bumps `rule.operator_confirms`/`operator_dismisses`
  via `jsonb_set`), but a fresh `grep -rn "record_shadow_feedback" src/eden`
  this pass finds only its own definition (plus its own log line and
  `__all__` entry) inside `soft_issue_review.py` — **zero callers anywhere in
  the repo, including the test suite** (`test_shadow_promote.py` does not
  reference it at all). This exact finding and its fix are
  `13-continuous-improvement-loop.md`'s
  entire subject and are not re-derived here; it is restated because every
  ranking recommendation in §4 below is contingent on it (a ranking that
  sorts by "confidence" is meaningless while confidence never accrues real
  data).

## 3. Is eden's mechanism actually judge-free? (independently verified)

The brief asks this directly because "no judges, rubrics, or monitors needed"
is a specific, falsifiable claim. Verified by reading the two candidate
LLM-touching code paths end to end, not by keyword grep alone:

- **`_scout_novel_patterns` (novelty layer, §2 above) is not a judge.** It is
  a single generative call that proposes candidate failure *descriptions* from
  a trace digest — it never scores an existing output against a rubric, never
  compares to a reference/golden answer, and its own system prompt (`:270-280`)
  frames the task as pattern discovery, not grading. This is the correct
  technical distinction: "LLM-as-judge" specifically means an LLM scoring an
  output against criteria; a generative novelty-detection call is a different
  primitive even though it also happens to be "an LLM call." Eden's own
  scorer library documents this design choice explicitly —
  `src/eden/playground/scorers.py`'s docstring (cited independently in
  `02-evals-datasets.md` §2g) states *"`llm_judge` is deliberately absent"*
  from eden's scorer registry — confirming this is a considered, repo-wide
  stance, not an accident of this one module.
- **`auto_scanner.py`'s `_detect_hallucination` (L0/L1 deterministic layer) is
  the one exception, independently re-verified this pass:** it calls
  `eden.insights.rca._common._fetch_judge_scores` (import at
  `auto_scanner.py:391`, called `:393`) and checks
  `row.get("judge_name") == "hallucination"` (`:398`) **before** falling back
  to a heuristic threshold on `hallucination_score`/`hhe_score` attributes.
  So: eden's mechanism is **judge-optional-with-fallback** for one of eight
  deterministic detectors, and **judge-free** for the novelty/shadow-detector
  layer that is the actual analog to "Issue Extraction." A precise, honest
  claim eden could make is "no rubric or manually-configured monitor is
  required to discover a new failure pattern" — true — rather than "zero LLM
  calls anywhere in the pipeline" — not quite true, and also not what Lemma's
  own "detects failed outcomes directly from live traffic" language implies
  either (an LLM almost certainly sits behind "identifies the exact cause,"
  it's just not exposed to the customer as a judge/rubric to configure).
- **No "monitor" authoring is required either.** `_scout_novel_patterns` runs
  against whatever traces exist in `telemetry_events` — there is no
  `signal_definitions` row a human must author first for the novelty layer to
  fire (that's the L0/L1 deterministic layer's job, and it too ships eight
  pre-built detectors with zero required configuration —
  `auto_scanner.py`'s `_detect_tool_errors`/`_detect_loops`/etc., `:178-620`
  per `02-evals-datasets.md` §3a, independently spot-checked this pass by
  reading `_detect_loops` `:242-298` and `_detect_slow_trace` `:341-379`,
  both pure statistical thresholds with zero config required).

**Verdict on this sub-question: yes, eden's issue-discovery mechanism really
is rubric-free and monitor-free**, and mostly judge-free (one deterministic
detector out of eight is judge-optional). This is a stronger, more precisely
qualified claim than "no LLM ever," and it is defensible in a sales
conversation once §4's ranking gap and `13-continuous-improvement-loop.md`'s
wiring gap are both closed.

## 4. The gap that is new this pass: extraction and validation exist, ranking does not

This is the primary new finding of this document. Traced from the Postgres
column through the API contract to the React component:

**4a. `agent_issues` has the raw ingredients for a rank.** `models.py`
(`src/eden/issues/models.py:117-139`) defines `Issue` with `severity`
(`p0`-`p3`), `stumble_count` (recurrence), `user_count` (blast radius —
`affected_user_ids` cardinality), and `repetition_count` (regression count).
The table comment at `:58-59` even says *"IssuePromoter may bump this based
on blast radius"* about severity.

**4b. That comment is aspirational, not implemented.** `IssuePromoter._update`
(`src/eden/issues/issue_promoter.py:115-180`) computes
`new_severity = _more_severe(existing["severity"], severity)` (`:139`), where
`_more_severe` (`:32-34`) is `min(a, b)` on the two kind-default severity
strings (`p0 < p1 < p2 < p3` lexicographically) — **it never reads
`user_count`, `stumble_count`, or `repetition_count` to escalate severity.**
Severity is set once from a static per-kind table
(`_DEFAULT_SEVERITY`, `models.py:60-71`) and only ever *narrows toward* the
worse of two static defaults as duplicate stumbles arrive — a 500-user issue
and a 2-user issue of the same `kind` get identical severity forever.

**4c. `list_issues` has no rank at all — only recency.** `IssuesRepo.list_issues`
(`src/eden/issues/repo.py:270-306`) builds `ORDER BY last_seen DESC` (`:297`)
unconditionally. `status`/`severity` are filter clauses (`:284-289`), not sort
keys. There is no `ORDER BY` variant, no query param, and no code path
anywhere in `repo.py` that sorts by `user_count`, `stumble_count`, or any
composite score.

**4d. Blast radius doesn't even reach the portal.** `IssueCard`
(`src/eden/api/portal_contracts.py:149-174`) — the DTO the portal actually
renders — has `signalCount` (`:165`, populated from `stumble_count` at
`src/eden/api/routes/portal.py:1669`) but **no `userCount`/blast-radius field
at all.** Grepped
the full `IssueCard` definition; confirmed no such field exists. The portal
cannot rank or even display blast radius today because the wire contract
never carries it, independent of any frontend sort logic.

**4e. The portal never sorts either.** `clients/portal/src/app/(portal)/issues/issues-client.tsx`
— grepped for `.sort(` across the entire file: **zero matches.** `scopedIssues`
(`:526-551`) only filters by `severityFilter`/`query`/`agent`; whatever order
the API returned (recency, per 4c) is the display order, with `severity`
usable only as a filter chip (`:665-670`), never a sort key.

**4f. Confidence doesn't exist as an issue-level field at all.**
`evaluate_shadow_precision`'s `precision` (soft_issue_review.py `:547`) lives
only in `nl_signals.rule` JSONB — it is never joined onto `agent_issues`. The
one place a join *could* exist — `IssueCard.relatedSignalId`
(`portal_contracts.py:166`) with a portal button already wired to link to
`/signals?id=${issue.relatedSignalId}` (`issues-client.tsx:256-259`) — is
**hardcoded to `None`** at the single call site that builds `IssueCard`
(`portal.py:1670`: `relatedSignalId=None,`). This is a second, independent
dead wire from the one `13-continuous-improvement-loop.md` found on the
backend: the **portal UI is already built** to show a confidence-bearing link
from an issue to its originating shadow signal, and the backend field feeding
it is a literal `None` constant, not even attempted.

**4g. Also missing: an explicit dismiss action in the portal.** The issue
detail panel's action buttons (`issues-client.tsx:196-260`) offer "In
progress" (`acknowledged`), "Resolve," and "Reopen" — there is no "Dismiss" /
"Not an issue" button anywhere in the component. This matches
`13-continuous-improvement-loop.md`'s finding that `resolve_issue`'s side
effects (including the not-yet-wired `record_shadow_feedback` call) only fire
on `target == "resolved"`, never `"ignored"` — but extends it: even once the
backend is fixed to act on `ignored`, **the portal today has no button that
sends `ignored`**, so a human "this isn't a real pattern" signal cannot reach
the API at all without new UI, not just new backend wiring.

**Net: eden extracts and validates issues, but "ranked" in the Lemma
description — implying a composite of recurrence, blast radius, and
confidence that the operator sees at a glance and acts on in order — is not
implemented anywhere in the stack, from column to component.** This is the
one piece of the target capability that does not already exist in some form
in `src/eden`, unlike extraction (exists) and validation (exists, but dead
per the wiring gap). §1's `docs.uselemma.ai` finding gives this gap a concrete
shape to build toward: Lemma's shipped `Issue` object carries a composite
`lane_scores` field and a `priority_computed_at` timestamp — i.e. a rank that
is computed and cached, not derived ad hoc at query time — which is the same
shape §6a's rank formula below produces, independently arrived at from
eden's own schema before this corroboration was found.

## User Experience & Value

**Who the user is.** Concretely, the person this feature is for is an eval
engineer or on-call agent operator triaging the `/issues` tab in the eden
portal (`clients/portal/src/app/(portal)/issues/issues-client.tsx`) — the
same surface cited throughout §4. They did not write a rubric, a judge
prompt, or a monitor config to get there; `agent_issues` populated itself
overnight via the L1→L4 pipeline in §2. That is the actual value
proposition eden already delivers today: open the tab, and failure patterns
nobody explicitly went looking for are already there, deduplicated
(`cluster_id`) and precision-gated before they ever reach the UI.

**The flow as it exists today.** Operator opens `/issues`, sees a list
ordered by `last_seen DESC` (§4c) with a `SeverityBadge`
(`issues-client.tsx:104`, `:173`) and a `signalCount` badge on each
`IssueCard`. They can filter by severity chip or by agent
(`:665-670`), or free-text search, but cannot sort — order is whatever the
API returned. Clicking into an issue's detail panel offers three actions:
"In progress," "Resolve," "Reopen" (`:196-260`). There is no confidence
indicator, no blast-radius count, and the "jump to the signal that generated
this issue" link exists as a rendered element but is wired to a field
(`relatedSignalId`) hardcoded to `None` server-side (§4f) — so for every
issue today, that link either silently fails to render or renders nothing
useful.

**Why this is genuinely valuable, not just novel.** For an operator managing
an agent fleet with thousands of daily traces, the alternative to this flow
is manually sampling traces, writing detector rules by hand, or waiting for
a user complaint. Eden's L0/L1 deterministic scanners plus the L3 novelty
scout (§2-3) replace that with a queue that fills itself, and — once
`13-continuous-improvement-loop.md`'s wiring lands — should get more precise
the more the operator uses it (`confirms`/`dismisses` feeding
`evaluate_shadow_precision`). That is the same underlying promise as
Lemma's `validation.confidence` field (§1): the system should learn from
operator feedback rather than requiring the operator to author correctness
criteria up front. Eden's mechanism for this already exists in the backend;
it just does not close the loop through the UI yet.

**Concrete usability gaps that block adoption, in order of how a first-time
user would hit them:**
- **Nothing tells the operator what to look at first.** With recency as the
  only order (§4c), a P0 issue affecting 500 users can sit below a P3 issue
  that recurred five minutes ago. For a fleet-scale operator, this defeats
  the point of automatic surfacing — they still have to read every row to
  find what matters, which is the exact "digging through logs" experience
  this capability is supposed to remove. This is the single highest-leverage
  fix in §6a, and the cheapest (an `ORDER BY` change).
- **A visibly broken link erodes trust faster than a missing feature would.**
  The `relatedSignalId` button (`issues-client.tsx:256-259`) is real UI,
  wired to a real route (`/signals?id=...`), gated on a field that is always
  `None` (§4f). A first-time user who notices this either concludes the
  feature is broken or, worse, doesn't notice and never learns the shadow
  detector behind an issue even exists to be inspected or trusted.
- **There is no way to say "this isn't a real pattern."** Without a Dismiss
  action (§4g), the only available response to a false positive is
  "Resolve," which is semantically wrong (resolved means fixed) and — once
  `13-continuous-improvement-loop.md`'s P0-B lands — would silently route a
  false positive into "resolved" metrics instead of the precision-learning
  path. Every operator who mislabels a false positive as resolved degrades
  the very confidence signal (`evaluate_shadow_precision`) the ranking in
  §6a depends on — a data-quality cost compounding on top of the immediate
  friction.
- **Triage is one issue at a time, with no bulk action.** At fleet scale,
  an operator reviewing dozens of newly surfaced issues after a bad deploy
  has no way to acknowledge or dismiss more than one at a time — not fixed
  by anything in §6, but worth flagging as the next usability gap once
  ranking and dismiss ship.
- **Shipping the "Ranked" sort before the confidence wiring lands would be a
  net negative for trust, not neutral.** A toggle that claims to rank by
  confidence but silently degrades to severity-only ordering (because
  `confidence` is permanently null until `13-continuous-improvement-loop.md`'s
  P0-A/P0-B land) is worse than no ranking toggle — it's a UI promising a
  capability it doesn't yet have. This is why §6/§7's sequencing
  (wiring before ranking UI) is a UX requirement, not only an engineering
  dependency.

**A secondary user, once §6e's MCP tool lands.** `13-continuous-improvement-loop.md`
P0-D specifies `confirm_shadow_detector(org_id, signal_id, confirm|dismiss)`
as an MCP tool. Once that exists, a coding agent working on behalf of a
developer — not just a human clicking through the portal — can validate or
dismiss extracted issues programmatically, mirroring Lemma's own "pull
context into your coding agent" positioning. This doc does not treat that as
required for adoption, but it is the natural second surface once the human
portal flow above is fixed, since the underlying data (issue, signal,
confidence) is the same either way.

## 5. Broader 2026 market context: "rubric-free" / "online eval" framing

- **Braintrust** — production trace → eval/dataset → regression gate,
  explicitly marketed as turning every trace into a test case
  (`braintrust.dev/articles/arize-phoenix-vs-braintrust`); "Topics" (beta) —
  corrected this pass, the cited source actually says Topics **does**
  cluster failure patterns but "doesn't track them as lifecycle issues"
  (`latitude.so/blog/best-braintrust-alternatives-ai-agent-evaluation`). The
  gap versus eden's target is lifecycle tracking (open/ack/resolved/regressed
  states), not an absence of pattern-clustering — a different, narrower axis
  than the prior draft of this doc claimed.
- **LangSmith** — corrected this pass: the cited source describes a named
  feature, **Insights**, as doing real "LLM-based clustering of traces into
  failure categories" — not "without much semantic-pattern tooling," as the
  prior draft of this doc stated. Its actual limitation per the same source
  is "clustering without lifecycle tracking — no issue states, no
  frequency-ranked dashboard" plus manual eval-case conversion
  (`latitude.so/blog/best-llm-observability-tools-agents-latitude-vs-langfuse-langsmith`)
  — again a lifecycle/ranking gap, not a pattern-detection gap.
- **Arize Phoenix** — observability-first, OTel-native, LLM-as-judge scoring;
  leans manual/export-based for turning a bad trace into a formal test case
  rather than automatic clustering (`sentrial.com/blog/arize-vs-braintrust-what-neither-tool-catches`).
- **Academic framing directly on point:** *"Insights Generator: Systematic
  Corpus-Level Trace Diagnostics for LLM Agents"* (arXiv 2605.21347) asks
  systems to "surface the notable behavioural patterns in the corpus:
  recurring errors, silent failures, systematic efficiency issues, unexpected
  strengths" — the same framing as both Lemma's and eden's novelty layer.
  *"Catching One in Five: LLM-as-Judge Blind Spots in Production Multi-Turn
  Transaction Agents"* (arXiv 2606.10315) documents concretely why a
  rubric/judge-based approach under-catches state-tracking and recovery
  failures — the structural argument for why a judge-free discovery layer
  (eden's L3 novelty scout) is a genuinely different, complementary
  capability, not a worse version of LLM-as-judge. FutureAGI's "Reference-Free
  Evaluation" glossary entry (`futureagi.com/glossary/reference-free-eval/`)
  gives the standard industry vocabulary: scoring against task
  instructions/policy instead of a golden answer — exactly what eden's L0/L1
  scanners and L3 novelty scout both do, with no golden answer anywhere in
  either path.

**Takeaway, revised this pass:** the raw pattern-surfacing step is less
differentiated than the prior draft claimed — Braintrust's Topics and
LangSmith's Insights both already do LLM-based failure clustering, in kind
comparable to eden's L3 novelty scout. What none of the three (Braintrust,
LangSmith, or eden today) ship is the *lifecycle* layer on top: tracked issue
states, frequency/blast-radius ranking, and a confidence signal a human acts
on in order — exactly what Lemma's `lane_scores`/`validation.confidence` API
fields (§1) suggest it has built. So the market's real differentiator in 2026
is "surface recurring failures **and** turn them into a ranked, tracked,
actionable queue without a human-authored rubric," not pattern-surfacing
alone — consistent with, and sharpening, `13-continuous-improvement-loop.md`'s
market-context finding that "closing this loop is a market differentiator,
not table stakes yet." Eden is not late to the pattern-surfacing half; it is
missing the ranked, lifecycle-tracked, portal-visible half, which §4 shows is
also the one part of the stack with no implementation today, not just
unwired plumbing.

## 6. Product surface design: a ranked Issues feed

Concrete, minimal-new-infrastructure design, sequenced to depend on
`13-continuous-improvement-loop.md`'s P0 rather than duplicate it.

**6a. Rank score (backend, additive SQL, no new tables).** Add an optional
`sort=rank` parameter to `IssuesRepo.list_issues` that orders by a computed
composite instead of `last_seen DESC`:

```sql
ORDER BY (
    (CASE severity WHEN 'p0' THEN 4 WHEN 'p1' THEN 3 WHEN 'p2' THEN 2 ELSE 1 END)
    * ln(GREATEST(user_count, 1) + 1)
    * ln(GREATEST(stumble_count, 1) + 1)
    * COALESCE(confidence, 0.5)  -- see 6c
) DESC, last_seen DESC
```

Log-dampened so one pathological outlier trace count doesn't permanently pin
an issue to the top; severity stays the primary lever since it is still the
best available human-set signal. This is a single `ORDER BY` change plus one
new indexed expression — no migration required beyond an index on
`(org_id, status)` if not already present (check before adding).

**6b. Surface blast radius and confidence in the DTO.** Add `userCount: int`
and `confidence: float | None` to `IssueCard` (`portal_contracts.py`), and
populate them at the one existing call site (`portal.py:~1649-1684`) from
`i.user_count` (already on the `Issue` dataclass, just unused in the DTO
build) and — once §6c lands — from the joined shadow-detector precision.

**6c. Fix `relatedSignalId` from `None` to real, joining the way
`13-continuous-improvement-loop.md` P0-A already specifies.** That doc's
P0-A adds the stumble→`nl_signals` join needed for `record_shadow_feedback`
at resolve time (`agent_issues.py`, extending the `resolve_issue` handler).
The exact same join — `example_stumble_ids[0]` → `agent_stumbles.detail->>
'signal_id'` → `nl_signals.id` — is what `portal.py`'s `IssueCard` builder
needs to populate `relatedSignalId` and `confidence` (from
`evaluate_shadow_precision(row)["precision"]`) instead of the current
hardcoded `None`. **Sequence this after P0-A, reusing its join, not before
or in parallel** — building a second, slightly different join here would
create exactly the kind of parallel-implementation drift this review
repeatedly flags elsewhere (see `02-evals-datasets.md` §2's six-way dataset
fragmentation as the cautionary precedent).

**6d. Portal: sort control + dismiss action.**
- Add a "Sort: Recent / Ranked" toggle to `issues-client.tsx`'s filter bar
  (next to the existing severity chips, `:665-687`), defaulting to Ranked.
  Render `userCount` and `confidence` (when present) as small badges next to
  the existing `SeverityBadge` (`:104`, `:173`).
- Add a "Dismiss" button alongside the existing "Resolve"/"In progress"
  buttons (`:205-249`), wired to `onStatus("ignored")` — closing gap 4g. This
  is the button that makes `13-continuous-improvement-loop.md`'s P0-B
  (wiring `record_shadow_feedback` on both `resolved` and `ignored`) reachable
  from the UI at all, not just from a raw API call.
- Wire the already-present `relatedSignalId` link (`:256-259`) to actually
  render once `confidence` is non-null — no new component needed, just real
  data flowing into an existing conditional.

**6e. MCP tool parity.** `13-continuous-improvement-loop.md` P0-D specifies
adding `confirm_shadow_detector(org_id, signal_id, confirm|dismiss)` to
`mcp_server/tools.py`. Once that lands, an agent-driven client (e.g. a coding
agent, mirroring Lemma's own "pull context into your coding agent" MCP
positioning) can validate/dismiss extracted issues the same way a human does
in the portal — this is the one place this doc recommends new MCP surface,
and it is additive to, not a duplicate of, P0-D.

## 7. KEEP / CUT / RESCOPE verdict

**RESCOPE.** Do not build a new "Issue Extraction" product. Do not skip this
either — the ranking gap in §4 is real and is the one piece of the target
capability eden is missing outright, not just "has, but unwired."

**Effort estimate:**
- §6a (rank SQL) — 0.5–1 day, additive `ORDER BY` + optional index.
- §6b (DTO fields) — 0.5 day.
- §6c (real `relatedSignalId`/confidence join) — **blocked on and shares code
  with** `13-continuous-improvement-loop.md` P0-A (stumble join, estimated
  there at "a few lines + one new/extended repo method"); once P0-A lands,
  this is another 0.5 day to reuse it in the `IssueCard` builder.
- §6d (portal sort toggle + dismiss button + badge rendering) — 1–1.5 days.
- §6e (MCP tool) — owned by `13-continuous-improvement-loop.md` P0-D, not
  re-estimated here.

**Total incremental to this doc's scope: ~2.5–3.5 engineer-days**, on top of
and sequenced strictly after `13-continuous-improvement-loop.md`'s P0-A/P0-B
(which that doc estimates at 1-2 days). Building the ranking UI before the
wiring fix would ship a "confidence" column that is permanently null and a
"Ranked" sort that degrades to severity-only — technically functional,
dishonest in a demo.

**Precise build sequence:**
1. `13-continuous-improvement-loop.md` P0-A — stumble→`signal_id` join
   (prerequisite; not this doc's to build, but this doc's §6c depends on it).
2. `13-continuous-improvement-loop.md` P0-B — wire `record_shadow_feedback`
   into `resolve_issue` for both `resolved`/`ignored`.
3. This doc §6d (partial) — add the portal "Dismiss" button, since P0-B's
   `ignored` path is otherwise unreachable from the UI (gap 4g). Can land
   in parallel with step 2 provided the API route accepts `ignored` already
   (it does — `models.py:52`, `ISSUE_STATUSES` already includes `"ignored"`;
   only the side-effect gate needs the P0-B change).
4. This doc §6a — rank `ORDER BY`, independent of steps 1-3, can land any
   time (severity/user_count/stumble_count are already populated correctly
   today; only `confidence` in the formula needs step 1-2 to be non-null).
5. This doc §6b/§6c — DTO fields + real join, strictly after step 1.
6. This doc §6d (remainder) — sort toggle + badges, after step 5.
7. `13-continuous-improvement-loop.md` P0-D — MCP confirm/dismiss tool;
   this doc's §6e notes the parity but does not block on it.

## Sources

- [uselemma.ai](https://www.uselemma.ai/) — re-fetched this pass, no
  "Issue Extraction" term found on the marketing site; "Issues" is the
  actual marketed feature name.
- [uselemma.ai/issue-extraction](https://www.uselemma.ai/issue-extraction) —
  HTTP 404, checked this pass.
- [docs.uselemma.ai — list-thread-issue-summaries API reference](https://docs.uselemma.ai/api-reference/traces/list-thread-issue-summaries.md) —
  fetched this pass; literal "issue extraction" language and an `extraction`
  response-schema field, missed by the prior pass's marketing-site-only
  search.
- [docs.uselemma.ai — get-issue / list-issues API reference](https://docs.uselemma.ai/api-reference/issues/)
  — fetched this pass; source of the `lane_scores`/`raw_lane_scores`/
  `priority_computed_at`/`validation.confidence` fields cited in §1/§4.
- [YC company profile — uselemma](https://www.ycombinator.com/companies/uselemma)
- [LinkedIn — "Reintroducing Lemma"](https://www.linkedin.com/posts/uselemma_reintroducing-lemma-wwwuselemmaai-activity-7470944859797737474-tFZc)
- [Braintrust — Phoenix vs Braintrust](https://www.braintrust.dev/articles/arize-phoenix-vs-braintrust)
- [Latitude — Braintrust alternatives 2026](https://latitude.so/blog/best-braintrust-alternatives-ai-agent-evaluation) —
  re-fetched this pass to correct §5's Topics characterization.
- [Latitude — LLM observability tools comparison 2026](https://latitude.so/blog/best-llm-observability-tools-agents-latitude-vs-langfuse-langsmith) —
  re-fetched this pass to correct §5's LangSmith characterization.
- [Sentrial — Arize vs Braintrust: the silent failure gap](https://www.sentrial.com/blog/arize-vs-braintrust-what-neither-tool-catches)
- [FutureAGI — Reference-Free Evaluation glossary](https://futureagi.com/glossary/reference-free-eval/)
- [arXiv 2605.21347 — Insights Generator: Systematic Corpus-Level Trace Diagnostics for LLM Agents](https://arxiv.org/pdf/2605.21347)
- [arXiv 2606.10315 — Catching One in Five: LLM-as-Judge Blind Spots in Production Multi-Turn Transaction Agents](https://arxiv.org/pdf/2606.10315)
- `02-evals-datasets.md` §3 (this pass's prerequisite reading — the
  original discovery that `soft_issue_review.py` is eden's Lemma analog)
- `13-continuous-improvement-loop.md` (this pass's prerequisite reading — owns
  the `record_shadow_feedback` wiring plan this doc's §6c/§6d depend on)
