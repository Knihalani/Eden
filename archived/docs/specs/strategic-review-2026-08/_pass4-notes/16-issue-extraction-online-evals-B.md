# Pass 4 notes — Agent B (UX/Value) on `features/16-issue-extraction-online-evals.md`

Scope per assignment: primary deliverable is a deep "User Experience & Value" section
grounded in eden's real `evaluation/`/`issues/`/`services/soft_issue_review.py`/portal
code (not just what the doc's engineering trace covers); secondary is an independent
fact-check pass, especially for overlap with `13-continuous-improvement-loop.md` and
`15-artifacts-behavior-record.md`. Original doc not edited.

---

## USER EXPERIENCE & VALUE (primary deliverable)

### 1. Who is the user — and who the current UI actually serves

The doc frames this as "online evals that surface, validate, and rank recurring
failures." In practice eden's shipped surface splits into two very different personas,
only one of which the current portal genuinely serves:

- **On-call/triaging engineer** — the portal's `/issues` page is built for this person.
  It is a three-column Kanban (`Open | In progress | Resolved`,
  `clients/portal/src/app/(portal)/issues/issues-client.tsx:57-61`), each `IssueRow`
  shows a severity badge, status chip, and occurrence count
  (`issues-client.tsx:80-115`), and the detail panel's action bar is verb-first and
  fix-oriented: **Ask AI**, **In progress**, **Resolve**, **Reopen**, a **Dataset**
  link (`/evals?mode=datasets&from=...`), and a **Signal** link
  (`issues-client.tsx:196-259`). This is a genuinely usable triage surface today,
  independent of anything this doc proposes.
- **PM / trend-tracker ("what's breaking across my fleet this week")** — this persona
  is essentially unserved today, and not just because of the ranking gap §4 of the doc
  already found. The default (and only) list order is `ORDER BY last_seen DESC`
  (`src/eden/issues/repo.py:297`, confirmed independently this pass), so a p3 issue
  that fired five minutes ago visually outranks a p0 issue affecting 500 users from
  yesterday. There is no "top issues this week," no trend chart, no cross-agent
  rollup — a PM has to read a raw recency feed and mentally re-sort it.
- **The person who actually validates/dismisses a shadow detector** (the closest
  analog to Lemma's "every issue you validate or dismiss updates what it looks for
  next") has **no UI surface at all** today. `record_shadow_feedback` — the only
  writer of confirm/dismiss counts — has zero production callers
  (`soft_issue_review.py:571-618`, independently re-grepped this pass, matching both
  F13 and F16's own finding). The weekly promote/delete job's only output is a Slack
  message (`_notify_shadow_promoted`, `soft_issue_review.py:621-643`) — so today this
  persona is literally "whoever reads the eden-alerts Slack channel," not a portal
  user at all.

### 2. What does an auto-extracted issue actually look like, end to end

Traced this pass from the LLM call that invents the pattern text through to what
renders in the portal — the doc's §2/§4 stop at the mechanism/schema level and don't
follow the string all the way to pixels, which is where the actual "does this feel
like Lemma's Issue Extraction" judgment has to be made:

1. **The raw extracted pattern is a single LLM-authored sentence**, nothing more
   structured. The novelty scout's system prompt (`soft_issue_review.py:270-280`)
   literally asks for output like *"agent repeatedly re-asks the user for information
   it already received"* and returns `{"patterns": [string, ...]}`, capped at 3
   patterns per agent per night, 20–300 chars each (`_parse_patterns`,
   `soft_issue_review.py:298-329`). There is no severity, no confidence, no structured
   fields at this stage — just prose that becomes a compiled rule
   (`cat2_intel.signals.compile_signal`) inside a disabled `nl_signals` row.
2. **Once the compiled rule fires on a real trace**, the resulting `agent_stumbles`
   row's `title` is mechanically generated, not LLM-authored at match time:
   `title=f"Signal fired: {_s(row['name'])}"` (`src/eden/signals/investigator.py:387`).
   So the issue a user first sees (before triage enrichment) is literally **"Signal
   fired: agent repeatedly re-asks the user for information it already received"** —
   functional, but visibly mechanical/templated compared to Lemma's worked example
   ("flagged as affecting 33 of the last 50 runs... 23 fabricated lookups, 15 orphaned
   tickets, 7 escalations"), which reads as a synthesized narrative, not a rule name.
3. **`IssueCard.title`/`summary`/`body`/`impact`/`suggestedFix` are then derived from
   `TriageAgent`'s output, with graceful fallback to the raw title if triage hasn't
   run** (`src/eden/issues/issue_promoter.py:~230-260`, e.g.
   `summary=_clip_text(triage.get("summary") or root_cause or i.title or "", 400)`).
   This is the one part of the pipeline that can produce genuinely narrative,
   Lemma-quality prose — but it's a *second*, separately-triggered LLM call
   (`TriageAgent.triage`, `src/eden/issues/triage_agent.py`), not part of extraction
   itself, and it's cached/suppressed under several conditions (active-work suppress,
   budget limits, `_MAX_REACT_CALLS = 8`) so a freshly-extracted issue can sit with
   only the mechanical "Signal fired: ..." title until triage runs.
4. **Confidence exists in two disconnected forms, and neither is visible where a user
   would look for it.** (a) `TriageAgent` computes a per-issue root-cause confidence,
   0.0–0.95, via `_max_confidence` (`triage_agent.py:718-723`, e.g. `0.95` for the
   deterministic StatGate path at `:167`, `0.0` for LLM/timeout failures at `:190`,
   `:239`) — this is stored in `triage_result` and is fetchable from the raw API
   (`GET /orgs/{org_id}/agent-issues/{issue_id}/triage`,
   `src/eden/api/routes/agent_issues.py:245-266`) but **`IssueCard` never carries
   it** — grepped the full model (`src/eden/api/portal_contracts.py:149-174`), no
   `confidence` field exists on it at all, so it never reaches the issue detail panel.
   (b) The "was this pattern actually validated" confidence — `evaluate_shadow_precision`'s
   `precision` (`soft_issue_review.py:547`) — is the one the doc's §4f already found
   hardcoded to `None` via `relatedSignalId`. **These are two different numbers
   answering two different questions** ("how sure is the root-cause diagnosis" vs.
   "how often do humans confirm this detector is real"), and a user evaluating "is
   this a trustworthy auto-extracted issue" would reasonably want both — today they
   get neither in the UI.
5. **Linking back to the source trace is the one part of this flow that genuinely
   works today**, and is worth stating positively since the doc is mostly about gaps.
   `IssueCard.occurrenceTraceIds` (built at `issue_promoter.py`, deduped from
   `example_stumble_ids` via a stumble→trace map) feeds the detail panel's **Runs**
   tab, which lists each occurrence with severity badge, duration, tokens, cost, and
   the actual error message inline, each linking to `/traces?id=...&tab=signals`
   (`issues-client.tsx:340-378`). An on-call engineer really can go from "here's an
   auto-surfaced issue" to "here's the exact trace and the exact error line" in two
   clicks. This part of the value prop is already real and shouldn't be lost in a
   gap-focused reading of the doc.

### 3. The triage/confirm/dismiss flow, as it exists vs. as Lemma's copy implies it

- **Status transitions available in the portal today:** `open → acknowledged` ("In
  progress"), `acknowledged/open → resolved`, and `resolved/acknowledged → open`
  ("Reopen") (`issues-client.tsx:205-249`). Resolve fires four real backend side
  effects — regression-case builder, `RegressionRunner`, `IssuePromptEvolver`, flywheel
  coordinator (`agent_issues.py`, per F13's independently-verified line trace) — so
  "Resolve" is not a no-op; it genuinely tries to prevent recurrence by mutating the
  prompt. This is a legitimately strong story to tell about eden's loop, and it's
  *not* gated on the ranking work this doc proposes.
- **There is no "Dismiss" / "not a real pattern" button anywhere in the component**
  (confirmed again this pass, `issues-client.tsx:196-260` has exactly the three verbs
  above plus links) — matching the doc's 4g finding exactly. For the specific UX
  promise in the product-owner's ground-truth copy — *"every issue you validate or
  dismiss updates what it looks for next"* — this means a human today has no way to
  tell eden "this auto-extracted pattern is noise," full stop, from the primary
  surface they'd be looking at it from.
- **New finding this pass, not in the original doc: even after the doc's proposed
  §6d "Dismiss" button ships, dismissed and resolved issues would be visually
  indistinguishable in the portal.** `_map_issue_status`
  (`src/eden/api/routes/portal.py:156-166`) collapses both backend statuses into the
  same portal-facing bucket:
  ```python
  if s in ("resolved", "ignored"):
      return "resolved"
  ```
  So a genuinely-fixed issue and a dismissed-as-noise issue both land in the
  "Resolved" Kanban column with an identical green "resolved" status chip
  (`IssueStatusChip`, `issues-client.tsx:65-75`, which has no branch for `ignored` at
  all). This directly undercuts the value the confirm/dismiss loop is supposed to
  deliver: a user scanning the board can't tell "we fixed this" from "we told eden to
  stop flagging this," which matters both for trusting the feed (are these 40
  "resolved" issues real fixes or 40 dismissed false positives?) and for anyone trying
  to audit whether the shadow-detector confirm/dismiss signal is actually being
  generated. **This is a second, independent gap the doc's §6d step should fix
  alongside adding the button** — either a distinct status chip/column for `ignored`,
  or at minimum a visually distinct badge — otherwise wiring `record_shadow_feedback`
  (F13's P0-B) produces data a user has no visual confirmation they're generating.

### 4. Why "online" (real-time) extraction would matter more than what exists today — and where eden's mechanism genuinely is, and isn't, already online

The doc treats "online evals" mostly as Lemma's marketing term for the whole
rank+validate+surface pipeline and doesn't examine eden's actual online/offline split
on its own terms. That split is real and matters for the value story:

- **The deterministic L0/L1 detector layer genuinely is online** — `AutoIssueScanner`
  is invoked from `trace_finalized_consumer.py` (`:92`, per-trace, at ingest time), so
  the eight pre-built detectors (`tool_error`, `loop`, `hallucination`, `timeout`,
  etc.) surface an issue essentially as soon as a trace finishes, no next-day wait.
  For an on-call engineer, this is the actual "catches it in real time" value, and it
  ships today, independent of everything this doc's §6 proposes.
- **The novelty/shadow-detector layer — the part that discovers genuinely *new*
  failure shapes, i.e. the "issues you didn't know to look for" half of the pitch —
  is deliberately nightly batch, not online, and budget-capped in a way that limits
  it at scale.** `SoftIssueReviewer` runs once, in a fixed 03:30–03:40 UTC window
  (`src/eden/workers/cron_tick.py:409-420`, `_once_per_window(..., ttl_seconds=20*3600)`
  guarding against double-runs), and even within that window is hard-capped to
  `_MAX_ORGS_PER_NIGHT = 20` orgs, `_MAX_AGENTS_PER_ORG = 3` agents, and
  `_MAX_NEW_DETECTORS_PER_ORG = 3` new patterns per org (`soft_issue_review.py:45-48`,
  independently re-verified this pass). **This means at any deployment with more than
  ~20 active orgs, most orgs are silently skipped on a given night** — a real,
  concrete scaling ceiling on the "surfaces recurring failures automatically" promise
  that neither this doc nor the prior passes flag, and one that a value narrative
  should be honest about: eden's novel-pattern discovery is closer to "a nightly batch
  job that gets to ~20 orgs before running out of night" than "online evals."
- **Net value argument for closing the online gap (not built anywhere today, worth
  naming even though out of this doc's build scope):** the highest-leverage version of
  "online" here isn't making the LLM novelty call run per-trace (that would be a cost
  explosion given the digest-based, budget-checked design) — it's shrinking the
  latency between "a shadow detector gets promoted" and "it starts contributing to a
  ranked feed a human can act on," and separately, prioritizing which of the >20 orgs
  get tonight's LLM budget by something smarter than the current `_hot_agents`
  recency/volume heuristic (`soft_issue_review.py:119-135`) — e.g. weighting toward
  orgs whose last scout run is oldest, so no org goes indefinitely unscouted at scale.
  This is a genuine, currently-undocumented product-value gap adjacent to, but
  distinct from, the ranking gap this doc's §4–§6 already covers in depth.

### 5. Value framing, summarized by persona

- **On-call engineer, today, no new work required:** real value already exists —
  online deterministic detection, trace-linked evidence, a working resolve→prompt-evolution
  loop. This should be part of any sales narrative independent of the ranking gap.
- **On-call engineer, once this doc's §6 ships:** meaningfully better — ranked feed
  surfaces the highest blast-radius issue first instead of whatever fired most
  recently, and a visible confidence badge tells them whether "the pattern behind
  this issue has been validated by 20+ firings at 80%+ precision" or "this is a
  same-night, unvalidated shadow pattern." Genuinely differentiating, contingent on
  F13's P0 landing first (both docs agree, correctly).
- **PM/trend-tracker persona:** still weak even after this doc's proposed build — no
  trend chart, no "new this week" view, no cross-agent rollup beyond the ranked list
  itself. Worth naming as an explicit non-goal of this doc's scope rather than
  silently absent.
- **The "close the loop" persona (confirm/dismiss):** blocked entirely on F13's P0,
  and even once unblocked, blocked a second time by the `_map_issue_status`
  ignored→resolved collapse found in this pass — both must land for the UX to
  actually deliver on "every issue you validate or dismiss updates what it looks for
  next."

---

## VERIFIED (independent fact-check, this pass)

- `IssuesRepo.list_issues` `ORDER BY last_seen DESC` unconditional —
  `src/eden/issues/repo.py:297` — confirmed exactly as the doc states; independently
  re-read the surrounding function, no alternate sort path exists.
- `IssueCard` has no blast-radius (`userCount`) or `confidence` field —
  `src/eden/api/portal_contracts.py:149-174` — confirmed by direct read of the full
  model this pass, matches doc §4d/4f.
- `relatedSignalId=None` hardcoded at the `IssueCard` build site — confirmed;
  `issue_promoter.py`'s `IssueCard(...)` construction passes `relatedSignalId=None`
  literally, matching doc §4f exactly.
- No "Dismiss" action in `issues-client.tsx` — confirmed by direct read of the action
  bar (`:196-260`); only "In progress"/"Resolve"/"Reopen" exist. Matches doc §4g.
- `record_shadow_feedback` has zero production callers — re-grepped this pass
  (`rg -n "record_shadow_feedback" src/eden`), only its own definition and
  `tests/unit/services/test_shadow_promote.py` match. Matches doc §2 and F13.
- `_scout_novel_patterns` budget caps — `_MAX_ORGS_PER_NIGHT=20`,
  `_MAX_AGENTS_PER_ORG=3`, `_MAX_NEW_DETECTORS_PER_ORG=3` at
  `soft_issue_review.py:45-48` (doc cites `:46-50`; actual constants start at line 45
  in this checkout — an off-by-one in the doc's line citation, not a substantive
  error, noting under CUT below).
- Nightly schedule at 03:30 UTC — `src/eden/workers/cron_tick.py:409-420` — confirmed,
  `now.hour == 3 and 30 <= now.minute < 40`.
- `soft_issue_review.py` is 651 lines and the module reads as described — confirmed
  by direct read of the relevant sections (not the full 651 lines line-by-line, but
  every section the doc cites was independently read and matches).
- Doc's overlap-avoidance claims: correctly does not re-derive `record_shadow_feedback`
  wiring (defers to F13) and correctly does not re-derive the Artifact schema/design
  (defers to F15) — read both F13 and F15 in full this pass; no unacknowledged
  duplication found. The one place all three docs touch the same code
  (`nl_signals.agent_id`, the confirm/dismiss loop) is consistently attributed to F13
  as the owning doc across all three files.

## CUT (quote + reason)

- No content recommended for outright removal on fact-check grounds — the doc's
  engineering claims independently re-verified clean. One **minor citation
  correction**, not a "cut": `evaluate_shadow_precision, evaluate the L4 shadow
  detector"..."Cost is bounded (_MAX_ORGS_PER_NIGHT=20, ..., :46-50)"` — in this
  checkout the four `_MAX_*` constants sit at lines 45–49, not 46–50 (the doc's range
  is off by one line at the start). Not load-bearing; flagging only because the pass's
  own instructions ask for precise file:line citation quality.
- No overlap with `13-continuous-improvement-loop.md` or `15-artifacts-behavior-record.md`
  rises to the level of redundant/fillerworthy — the doc's explicit
  "goes deeper than, and does not duplicate" framing (line 14) holds up; each doc's
  citations of the shared `nl_signals`/`record_shadow_feedback` material are one-line
  cross-references, not restatement.

## NEW FINDINGS (this pass, UX-angle)

1. **`_map_issue_status` collapses `ignored` into the same portal bucket as
   `resolved`** (`src/eden/api/routes/portal.py:156-166`) — see §3 above. This means
   the doc's own §6d fix (add a Dismiss button) is necessary but not sufficient to
   make the confirm/dismiss signal visible to a user; the status-mapping function also
   needs an `ignored`-aware branch (its own chip/column) or dismissed issues will be
   indistinguishable from resolved ones in the Kanban board. Recommend folding this
   into the doc's §6d line item explicitly.
2. **Two disconnected "confidence" concepts exist in the codebase, and neither
   reaches the issue detail UI** — `TriageAgent`'s per-issue root-cause confidence
   (`triage_agent.py:718-723`, exposed only via the raw `GET .../triage` API, never in
   `IssueCard`) versus the shadow-detector validation precision the doc already
   covers (`evaluate_shadow_precision`, hardcoded `None` today). The doc's §6b/§6c
   only wires the second one. Worth a one-line scope note: even after §6c lands,
   "confidence" in the UI will mean "how often has this detector been confirmed," not
   "how sure is eden this diagnosis is right" — the two are easy to conflate in a demo
   and should be labeled distinctly if both ever reach the DTO.
3. **The novelty-discovery layer is hard-capped to ~20 orgs/night** — a real,
   previously-unflagged scaling ceiling on the "surfaces recurring failures
   automatically" promise (see §4 above), orthogonal to the ranking gap. Not a
   blocker for this doc's proposed build, but worth naming in any customer-facing
   value narrative so "online evals" claims stay honest at scale.
4. **The raw extracted-pattern text is templated ("Signal fired: {description}"),
   not narrative**, until a separate `TriageAgent` call enriches it — a concrete,
   previously-untraced UX gap between what a freshly-extracted issue looks like on
   first render vs. Lemma's narrative worked example. Not a "build this" finding, just
   a grounding fact useful for setting expectations about summary quality in any demo
   of eden's current issue feed.
