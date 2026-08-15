# Pass-4 Notes — F16 Issue Extraction / Online Evals (Agent A: Fact-Verifier & Pruner)

Doc reviewed: `docs/specs/strategic-review-2026-08/features/16-issue-extraction-online-evals.md` (453 lines)

## VERIFIED

Internal code citations were checked line-by-line against the live repo. Verification is
unusually strong for this doc — essentially every internal citation checked out exactly:

- `src/eden/services/soft_issue_review.py` — module docstring L1-31 (DeepSeek, layered
  cost model) — confirmed verbatim. `_MAX_ORGS_PER_NIGHT=20`, `_MAX_AGENTS_PER_ORG=3`,
  `_MAX_TRACES_PER_ORG=50`, `_MAX_NEW_DETECTORS_PER_ORG=3`, `_MAX_DIGEST_CHARS=600` all at
  L45-50 as cited.
- `_rank_hot_orgs` L96-117, `_hot_agents` L119-135 — confirmed, pure SQL `COUNT/GROUP
  BY/ORDER BY` over `agent_issues`.
- `_scout_novel_patterns` L248-304, system prompt L270-280 — confirmed verbatim,
  including "at most 3," "no explanations," `expected_min_length=2`, `slot="fast"`.
- `_create_shadow_detector` L333-376 — confirmed: `cluster_id = f"auto:{signal_signature(description)}"`
  at L345 (exact), `f"[auto:{agent_id}] {description}"` at L363 (exact).
- `evaluate_shadow_precision` L510-568 — confirmed pure function; `if labeled > 0:
  precision = confirms/labeled ... else: precision = None` branch logic matches doc's
  description exactly; `action` only becomes `"promote"`/`"delete"` when `precision is
  not None`, matches.
- `promote_shadow_detectors` L380- (weekly cron), `_notify_shadow_promoted` def at L621 —
  confirmed, matches cited `:621-643` range.
- `record_shadow_feedback` L571-618, in `__all__` at L649 — confirmed exported and fully
  implemented but zero production callers repo-wide (see CUT below re: the test-file
  half of this claim).
- `auto_scanner.py` — exactly **8** `_detect_*` methods confirmed by grep
  (`_detect_tool_errors` L178, `_detect_loops` L242-298, `_detect_task_failure` L299,
  `_detect_slow_trace` L341-379, `_detect_hallucination` L380, `_detect_user_frustration`
  L485, `_detect_confusion_loop` L536, `_detect_high_cost` L579) — matches "eight
  deterministic detectors" claim exactly, and the specific `_detect_loops`/
  `_detect_slow_trace` line ranges are exact to the line.
- `_detect_hallucination`'s judge fallback: `from eden.insights.rca._common import
  _fetch_judge_scores` at L391, called L393, `row.get("judge_name") == "hallucination"`
  (actually `!= "hallucination"` guard) at L398 — confirmed exact.
- `src/eden/playground/scorers.py` docstring — confirmed `llm_judge` is deliberately
  absent (L5 area), matches quoted claim.
- `src/eden/issues/models.py` — `Issue` dataclass at L118 (`:117-139` cited, off-by-one
  for the `@dataclass` decorator line, immaterial), `_DEFAULT_SEVERITY` table L60-71,
  comment "IssuePromoter may bump this based on blast radius" at L58-59 — confirmed
  verbatim. `ISSUE_STATUSES` frozenset confirmed to include `"ignored"` at exactly L52.
- `src/eden/issues/issue_promoter.py` — `_more_severe` (`min(a,b)`) at L32-34 confirmed
  exact; `IssuePromoter._update` L115-180 confirmed exact range (next method starts
  L182); `new_severity = _more_severe(existing["severity"], severity)` at L139 confirmed
  exact; the `UPDATE agent_issues` statement never references `user_count`/
  `stumble_count`/`repetition_count` when computing `severity` — confirmed by reading
  the full method body.
- `src/eden/issues/repo.py` — `list_issues` L270-306, `ORDER BY last_seen DESC` at
  **exactly L297** (grep-confirmed) — no other `ORDER BY` in the file sorts by
  `user_count`/`stumble_count`/composite (only other `ORDER BY` in the file, L184, sorts
  a different query by `detected_at DESC`).
- `src/eden/api/portal_contracts.py` — `IssueCard` L149-174, `signalCount` at L165,
  `relatedSignalId` at **exactly L166** — confirmed no `userCount`/blast-radius field
  exists anywhere in the class body.
- `src/eden/api/routes/portal.py` (doc cites as `portal.py` without the `routes/`
  segment — see CUT/minor below) — `signalCount=int(getattr(i, "stumble_count", 0) or
  0),` at L1669 and `relatedSignalId=None,` at **exactly L1670** — confirmed exact,
  hardcoded `None` literal, not a bug in a conditional.
- `clients/portal/src/app/(portal)/issues/issues-client.tsx` — grepped `.sort(` across
  the entire file: **zero matches**, confirmed. No "Dismiss"/`ignored` action anywhere in
  the component (`onStatus(` calls found: `"acknowledged"`, `"resolved"` ×2, `"open"`
  ×2 — never `"ignored"`) — confirmed 4g's finding exactly. `relatedSignalId` link at
  L256/258 confirmed present and gated on `issue.relatedSignalId` truthiness.
  `SeverityBadge` at L104 and L173 confirmed. Severity filter chip logic around
  L536/551/665/687 confirmed present, no sort control anywhere.
- `nl_signals` table (`migrations/036_nl_signals.sql`) — confirmed **no `agent_id`
  column** (columns are id, org_id, description, rule, enabled, created_by, cluster_id,
  last_matched_at, match_count, created_at, ...) — corroborates the "agent id smuggled
  into free text" finding independently of doc 13.
- `compile_signal` (`src/eden/services/cat2_intel/signals.py:257`) and
  `signal_signature` (`:402`) — both confirmed to exist at the cited module.
- Academic sources: `arXiv 2605.21347` ("Insights Generator: Systematic Corpus-Level
  Trace Diagnostics for LLM Agents") and `arXiv 2606.10315` ("Catching One in Five:
  LLM-as-Judge Blind Spots in Production Multi-Turn Transaction Agents") both resolve to
  real papers with abstracts matching the doc's paraphrase (multi-agent hypothesis
  system, 30.4pp scaffold improvement; judge "surfaces well under a quarter of
  human-confirmed systematic problems," 2/9 patterns caught) — confirmed genuine, not
  fabricated (IDs are 2026-05/06, consistent with the in-universe Aug-2026 present, not
  future-dated as a naive check might flag).
- Braintrust primary source (`braintrust.dev/articles/arize-phoenix-vs-braintrust`) —
  confirmed "Braintrust turns every production trace into a test case... Every trace
  becomes a test case" is a real, direct quote.

## NEW FINDINGS (external corroboration — significant, not in original doc)

1. **The doc's own external-verification pass missed `docs.uselemma.ai` (the API
   reference subdomain) entirely — it only checked the marketing site
   (`www.uselemma.ai`) and a guessed `/issue-extraction` marketing-page URL (404).**
   I fetched `docs.uselemma.ai/llms.txt` (the doc index) and then
   `docs.uselemma.ai/api-reference/traces/list-thread-issue-summaries.md` directly this
   pass. Finding, independently confirmed:
   - The endpoint description reads: *"Batch-fetch issue extraction completion and
     destin issues for thread_ids (join key for eval trial_hash)."*
   - Its 200 response schema has a **literal top-level field named `extraction`**
     (object: `completed: bool`, `statuses: enum[running|completed|skipped|failed]`,
     `reasons: enum[issues_found|no_issues_found|no_spans|unsupported_trace|error]`),
     alongside a sibling `issues` array (`issue_id`, `title`, `category`, `rationale`).
   - This is exactly the evidence the task briefing described ("a real 'extraction'
     object" at an "issue-summary" endpoint) — it exists, but **the current doc text
     does not cite it or mention `docs.uselemma.ai` at all.** The doc's §1 conclusion
     ("Issue Extraction as a verbatim term does not surface in Lemma's current public
     materials") is true for *marketing* copy but incomplete for *API* docs, where the
     word "extraction" is a literal, real schema field.
   - Further, `docs.uselemma.ai/api-reference/issues/get-issue.md` and `list-issues.md`
     show Lemma's real `Issue` object has **`lane_scores` (A/B/C composite priority
     score)**, **`raw_lane_scores`** (`impact_occurrences`, `impact_trace_share`,
     `spike_ratio`, `persistence_active_days`, `resolution_floor`),
     **`priority_computed_at`**, and a **`validation` object with `status`
     (valid/invalid/inconclusive/failed/not_run) and a numeric `confidence` field**.
     This is a real, shipped composite-ranking-plus-validation mechanism — stronger
     corroboration for Lemma's "ranked, actionable issues" marketing claim than
     anything the doc currently cites, and it sharpens (rather than undermines) §4's
     central finding: eden genuinely lacks the analog of `lane_scores`/`priority_computed_at`,
     and Lemma genuinely has it, at the API level, not just in marketing prose.
   - This should be added to the doc as corroborating evidence in §1 and/or §4 — it
     materially strengthens the doc's argument and should not be dropped in synthesis.

2. **Two of §5's competitor characterizations are inversions of what their own cited
   sources say**, verified by re-fetching both this pass:
   - **Braintrust "Topics"**: doc says Topics "is reported as not yet doing full
     pattern-clustering." The cited source (`latitude.so/.../best-braintrust-alternatives`)
     actually says the opposite of the clustering half: *"Braintrust's Topics (beta)
     clusters failure patterns without tracking them"* and *"groups failure patterns but
     doesn't track them as lifecycle issues."* Topics **does** cluster; what it lacks is
     lifecycle tracking (open/ack/resolved/regressed states), a different axis than
     "pattern-clustering."
   - **LangSmith**: doc says LangSmith "shows logs end-to-end without much
     semantic-pattern tooling on top." The cited source
     (`latitude.so/.../langsmith` comparison) actually describes a named feature,
     **Insights**, as *"LLM-based clustering of traces into failure categories"* — real
     semantic-pattern tooling. Its actual limitation per the source is *"clustering
     without lifecycle tracking — no issue states, no frequency-ranked dashboard"* and
     manual eval-case conversion — again a lifecycle/automation gap, not an absence of
     pattern tooling.
   - **Net effect on the doc's argument**: eden's differentiation is narrower than §5
     implies. At least two competitors (Braintrust, LangSmith) already ship
     LLM-based failure clustering comparable in kind to eden's L3 novelty scout; the
     real gap for all three (eden included, per §4) is closing the loop from cluster →
     ranked, tracked, actionable issue — which is consistent with, and actually
     reinforces, `13-continuous-improvement-loop.md`'s framing, but §5 as written
     overstates how differentiated the raw "pattern surfacing" step is.

## CUT (quote + reason)

1. > "Product Hunt (`producthunt.com/products/lemma-4`, guessed slug) → **HTTP 404**"
   Minor filler — a guessed slug returning 404 tells us nothing (it isn't evidence the
   listing doesn't exist under a different slug). Doesn't materially support or refute
   any claim; keep the surrounding methodology note but this specific line adds noise
   without information.

2. > "**Galileo** — the closest public claim to automatic, rubric-free
   pattern-clustering in production traces (`genai.qa/ai-agent-trajectory-testing-2026/`),
   though one comparison source flags this attribution should be verified directly
   against Galileo's own site before citing it in a sales deck."
   **CUT — re-verified this pass and the citation does not support the claim.** I
   re-fetched `genai.qa/ai-agent-trajectory-testing-2026/` directly: it describes
   Galileo only via "hallucination detection depth," "trajectory insights (emerging
   capability for multi-step agent analysis)," and "newer to the trajectory space than
   LangSmith or Braintrust." **No mention of rubric-free clustering, pattern discovery,
   or anything resembling "closest public claim to automatic clustering" appears
   anywhere on that page.** The doc's own self-caveat ("should be verified... before
   citing in a sales deck") was correct to be worried — on verification, the claim
   should be dropped, not merely caveated. Do not carry this sentence into synthesis.

3. > "[arXiv 2606.09863 — From Confident Closing to Silent Failure: Characterizing False
   Success in LLM Agents](https://arxiv.org/pdf/2606.09863)" (Sources list)
   **CUT — orphaned citation.** This paper is listed in Sources but is never quoted,
   paraphrased, or referenced anywhere in the document body (§5's academic-framing
   paragraph cites only 2605.21347 and 2606.10315). An unused source in a numbered
   Sources list is filler; either cite it for a specific claim or remove it.

4. > "a fresh `grep -rn "record_shadow_feedback" src/eden` this pass still finds only
   its own definition and `tests/unit/services/test_shadow_promote.py` — zero
   production callers."
   **Partially false — re-verified this pass.** `grep -c "record_shadow_feedback"
   tests/unit/services/test_shadow_promote.py` returns **0**. The current
   `test_shadow_promote.py` (130 lines, 5 test functions) does not reference
   `record_shadow_feedback` anywhere; the only repo-wide matches are the function's own
   definition/log-line/`__all__` entry inside `soft_issue_review.py` itself (a stale
   compiled `.pyc` in `__pycache__` appears to be the source of the doc's confusion —
   not a valid citation). The underlying conclusion ("zero production callers") is
   actually **stronger** than stated once corrected — it's zero callers *anywhere*, not
   "zero except one test file." Fix the citation in synthesis; don't drop the finding.

5. Citation-path imprecision (not a content error, note for synthesis hygiene): the doc
   cites `portal.py:1669`/`portal.py:1670`/`portal.py:~1649-1684` throughout §4f/§6b/§6c.
   The actual file is `src/eden/api/routes/portal.py` (there is only one `portal.py` in
   the repo, so the citation is unambiguous, but the path segment `routes/` is dropped
   every time). Low severity — content and line numbers are exact — but worth
   normalizing if this doc is merged/edited downstream.

6. Minor: `soft_issue_review.py` is stated as "651 lines" (§2 intro); actual is
   **650 lines** (`wc -l`). Trivial off-by-one, not worth a correction pass on its own
   but noting for completeness since the doc leans heavily on line-precision as a
   credibility signal.

7. `scopedIssues` is cited as `issues-client.tsx:526-551`, but `scopedIssues` itself is
   only L526-529 (a 4-line `useMemo`); the filtering logic actually described (severity
   +query filter) is a separate `filtered` `useMemo` at L533-549. The substance of the
   claim (no `.sort(` anywhere, order is API-determined) is correct, but the two memos
   are conflated under one variable name/line range. Minor — not worth a CUT of the
   claim, just a citation-precision note.

## USER EXPERIENCE & VALUE (draft — Agent B goes deeper)

**Who feels this today:** an eden operator already gets `agent_issues` populated
automatically (extraction + validation work, per §2-3) — they see issues appear in the
portal without having written a rubric, judge prompt, or monitor config. That part of
the promise is real and already shipping. What they *don't* get is the payoff Lemma's
marketing (and now, per NEW FINDINGS above, Lemma's real API schema) implies: opening
the Issues tab and immediately seeing the 2-3 things that matter most, ranked, with a
visible confidence signal. Today the list is recency-ordered only (`repo.py:297`), so a
high-severity issue affecting 500 users can sit below a 2-user issue that merely
recurred five minutes ago — an operator has to read every row to find what's important,
which is precisely the "digging through logs" experience "rubric-free online evals"
positioning promises to eliminate.

**Trust/credibility gap, not just a UX gap.** §4f's finding — `relatedSignalId` is
wired end-to-end in the frontend (a real button, a real route) but hardcoded to `None`
on the backend — is the sharper version of this: it isn't merely that ranking is
missing, it's that a link a user can *see* and *click* on the issue card silently does
nothing useful today (or the button/section is simply absent because the field is
always null). That's worse for trust than an absent feature, because it looks broken
rather than unbuilt. Same shape as `13-continuous-improvement-loop.md`'s
`record_shadow_feedback` dead wire, but on the read side rather than the write side —
together they describe a full loop (surface → act → learn) that is wired at both
UI ends and dead in the middle.

**The missing "Dismiss" button (4g) is a value problem, not just a completeness gap.**
Without it, an operator's only way to say "this pattern isn't real" is to mark the
issue "Resolved," which is semantically wrong (resolved implies fixed, not
false-positive) and, per `13-continuous-improvement-loop.md`, doesn't even route to the
precision-learning path today regardless. Every false positive an operator has to
mislabel as "Resolved" pollutes eden's own status semantics and (once P0-B lands)
would silently miscount toward "resolved" metrics instead of the "ignored"/precision
counters — a second-order data-quality cost on top of the immediate UX friction.

**Sequencing matters for perceived value, not just engineering cost.** The doc's own
§6 sequencing point is a UX point in disguise: shipping the ranked sort (§6a) before
`13-continuous-improvement-loop.md`'s P0-A/P0-B lands would put a "Ranked" toggle in
front of users that silently degrades to severity-only ordering (since `confidence`
would be permanently null) — a UI that claims a capability it can't yet deliver is a
worse demo experience than no ranking toggle at all. This is worth stating explicitly
as a UX risk, not just an engineering sequencing note.

**Net value if built as scoped:** closing §4's gap doesn't require new ML or new
infrastructure — it's an `ORDER BY` change, two DTO fields, one join reuse, and one
button. The value-to-effort ratio here is unusually good (~2.5-3.5 days per the doc's
own estimate) *because* eden already collects every input the rank formula needs
(`severity`, `user_count`, `stumble_count` are already correctly populated, per 4a) —
the blocker is entirely in the read/display path, not the data model. That asymmetry
(data exists, presentation doesn't) is itself worth surfacing prominently in synthesis
as the reason this is a rescope, not a build.

## Summary for orchestrator

Doc 16 is the most internally rigorous of the four I'd expect in this batch — every
checked code citation (line-level, ~30+ spot-checks across `soft_issue_review.py`,
`issue_promoter.py`, `repo.py`, `models.py`, `portal_contracts.py`, `portal.py`,
`issues-client.tsx`, `auto_scanner.py`, migration SQL) matched exactly or within
trivial off-by-one tolerance. The weak point is external corroboration in §5: two
competitor claims (Braintrust Topics, LangSmith) invert what their own cited sources
say, and the Galileo claim is unsupported by its citation and should be cut outright.
Separately, and most importantly for the task's specific brief: the doc's own
"harder second search pass" (§1) never checked `docs.uselemma.ai` (API reference docs),
which — verified fresh this pass — contains a literal `extraction` response-schema
object and a real composite `lane_scores`/`priority_computed_at`/`validation.confidence`
mechanism on Lemma's `Issue` object. This is stronger evidence for the target
capability being real and ranked than anything currently in the doc, and should be
added, not treated as already covered by the marketing-site 404 findings in §1.
