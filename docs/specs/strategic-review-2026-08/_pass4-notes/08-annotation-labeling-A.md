# Pass 4 notes — F08 Annotation / Labeling Queues

Reviewer: sole reviewer, pass 4 (final). Target doc:
`docs/specs/strategic-review-2026-08/features/08-annotation-labeling.md` (not edited).

## VERIFIED

This is the most heavily re-verified doc in the review set (third pass already), and
every non-trivial claim I re-checked against source held up exactly. Spot-checks
performed this pass, all confirmed:

- **File sizes / line counts**: `labeling.py` 949 lines, `labeling_queues.py` 252,
  `iaa.py` 44, `labeling_leases.py` 110 (doc says 111 — off by one, trivial),
  `api/routes/labeling.py` 502 (doc says 503 — off by one, trivial). Test files:
  `test_labeling.py` 676 lines, `test_labeling_queues.py` 15 lines,
  `test_labeling_path_org_access_jul19.py` 146 lines — exact.
- **`pop()` mechanics** (`labeling.py:392-497`): confirmed line-by-line. Three plain
  `SELECT`s with no `FOR UPDATE SKIP LOCKED`; the `try: claim_lease(...) except
  Exception: pass` fail-open pattern is real (`labeling.py:462-468` — my read shows
  it at 461-467, one-line offset from doc, immaterial); the UPDATE's return value is
  discarded and status is unconditionally flipped in Python
  (`labeling.py:486-496`).
- **`labeling_leases.py`**: `SET NX EX` atomic claim at line 37, stale-holder retry
  at lines 40-43, module-level `_memory_leases: dict[str, tuple[str, float]] = {}`
  at line 13, TTL default 900 / floor `max(30, ...)` at lines 12/16-21 — all exact.
- **Two-IAA-engine dead-code claim**: fully reproduced by direct read.
  `queue_iaa()` (`api/routes/labeling.py:446-471`) reads
  `payload.get("label_a") or payload.get("annotator_1")` /
  `payload.get("label_b") or payload.get("annotator_2")`; `LabelingQueueService
  .add_item()` (`labeling_queues.py:142-168`) writes only
  `payload = {"trace_id": trace_id}`. Grep for `label_a|label_b|annotator_1|
  annotator_2` across `src/` returns matches only inside the reader
  (`api/routes/labeling.py:467-468`) — confirmed fresh, zero writers anywhere.
  `queue_iaa()` is dead code returning `{"kappa": 0.0, "n": 0, "agreement_rate":
  0.0}` for every real queue.
- **Route-count claim**: docstring at `api/routes/labeling.py:1-13` lists 8 routes
  (header literally says "Six routes" then lists 8 — a pre-existing doc bug in the
  source itself, worth noting); `grep -c "^@router\."` finds 15 actual route
  decorators. Confirmed.
- **`labeling_assignments` UNIQUE constraint**: `migrations/035_labeling.sql:154`
  is `UNIQUE (item_id, annotator_id)` on the `labeling_assignments` table — dedupes
  same-annotator-twice, does nothing to stop two different annotators claiming one
  item. Confirmed exactly, including that `annotations` (a different table, line
  126) has the same constraint pattern for a different purpose (label revision, not
  claim exclusivity).
- **No reaper / no recovery path**: fresh greps this pass — `grep -in
  "unassign|reclaim" api/routes/labeling.py` → zero matches; `grep -in "labeling"
  src/eden/workers/background.py` → zero matches; `grep -n "labeling"
  src/eden/workers/cron_tick.py` → zero matches. Confirmed independently.
- **Zero UI consumers**: fresh greps for `labelingApi`, `labelingQueuesApi`,
  `annotateTrace`, `labelToolCall` across `clients/portal/src` (excluding
  `resources.ts` itself) → zero hits each. `find clients/portal/src/app -iname
  "*label*" -o -iname "*annotat*"` → zero. Grep for `kappa|krippendorff|
  inter-annotator` outside `resources.ts` → zero. Confirmed exactly as claimed —
  every labeling-related binding in the portal is genuinely orphaned.
- **No drag-and-drop lib installed**: confirmed — no `dnd`/`drag` match in
  `clients/portal/package.json`.
- **F21 `tool_call_labels.py` and `tool_call_inference_v1` flag**: both exist
  (`src/eden/learning/tool_call_labels.py`, `src/eden/api/routes/
  tool_call_labels.py`, `config.py:1229`, gated in `tool_call_calibrator.py:127-128,
  218`). The "correction to prior draft" framing is grounded, not invented.
- **All five external competitor claims spot-checked via WebFetch against primary
  docs, verbatim**:
  - LangSmith (`docs.langchain.com/langsmith/annotation-queues`): "Number of
    reviewers per run," "Use assigned reviewers" toggle, reservation-expiry
    releases item back to queue, "Reviewers cannot view the feedback left by other
    reviewers," hotkeys A/B/E for pairwise — all confirmed verbatim.
  - Braintrust (`braintrust.dev/docs/annotate/human-review/multiple-reviewers` —
    note: doc's §4 citation list points readers to `manage-review-work` for this
    material, but the actual quoted content lives on `multiple-reviewers`; the
    Sources section does list both URLs, so this is not a sourcing error, just
    worth flagging that a reader following only the first-listed link for this
    paragraph would land on the wrong page): auto-averaging of numeric/categorical
    scores, "Set as base span value"/"Set as root value," "N total reviews"
    consensus indicator, "Review spans" dropdown, no blind review — all confirmed
    verbatim.
  - Label Studio (`docs.humansignal.com/guide/quality` +
    `humansignal.com/blog/enhancing-data-quality-with-label-studio-automated-
    workflows`): bulk-assign reviewers, Task Ordering (sequential/random) + Task
    Limit (%), order-by-agreement, Accept/Fix & Accept/Reject, and (on the second,
    correctly-cited URL) automatic reassignment when agreement falls below
    threshold — all confirmed verbatim, split correctly across the two sources the
    doc actually cites.
- **Checked against `KNOWN-SUBSYSTEMS.md`**: no entry there references
  `evaluation/labeling.py` or contradicts this doc's framing; nothing in the
  ground-truth inventory suggests this doc is missing a bigger subsystem or
  mischaracterizing an existing one. No "eden lacks X" claim in this doc needed
  correction against the inventory.
- **No redundancy with other feature docs**: grepped all 15 sibling docs in
  `features/` for `labeling|annotat|IAA|kappa`. Four hit (`01`, `10`, `13`, `15`)
  but on inspection none restate F08's specific findings — `13` and `15` reference
  active-learning theory and competitor "living asset" framing in service of their
  own topics (shadow-detector confirm/dismiss, behavior-record), not eden's
  `labeling.py` subsystem. No cross-doc duplication to prune.

## CUT

Nothing found that is false, unverifiable, or filler. This doc is unusual among the
set in that every claim I attempted to falsify instead confirmed. The only two
things I'd flag as candidates for a trim, not removal:

1. **Two off-by-one line-count citations** (`labeling_leases.py` cited as "111
   lines," actual 110; `api/routes/labeling.py` cited as "503 lines," actual 502).
   > "`api/routes/labeling.py` (503 lines) exposes **15 routes**"
   Reason: trivially wrong by one line each (likely counted before/after a trailing
   newline), doesn't affect any conclusion, but since this doc is otherwise
   citation-perfect it's worth a one-character fix for internal consistency. Not
   worth a CUT, just a correction — noting here since the "PRUNE false claims"
   instruction technically applies to any wrong number, however trivial.
2. **Sources list has 15 entries but the doc's body only inline-cites/uses roughly
   10 of them directly** (e.g. `changelog.langchain.com/.../pairwise-annotation-
   queues`, the "8 best human-in-the-loop platforms" Braintrust listicle,
   `labelstud.io/blog/label-studio-1-21-0`, `uselemma.ai`, and the FutureAGI
   roundup are listed but never quoted or cited by claim in the body). This is
   normal practice for a research doc (background reading informing framing even
   when not directly quoted) and I would not cut it, but flagging since a stricter
   pruning pass could trim the Sources list to only directly-cited URLs without
   losing any verified claim.

No section, paragraph, or sentence in the doc met the bar for CUT (false /
unverifiable / speculative / redundant / filler). This is a keep-as-is doc on
content; the only doc-level action from this pass is the new UX section below,
which the doc currently lacks (it has a "Concrete UI build plan," §6, which is
implementation-oriented — page list, API additions, sequencing — but no
experience-quality narrative comparing eden's *would-be* flow to what fast
labeling UX actually feels like once built, hour-in-the-life level. That gap is
what §"USER EXPERIENCE & VALUE" below fills.)

## USER EXPERIENCE & VALUE

### The flow today: there isn't one

This is the load-bearing fact for this whole section: **eden has no reviewer-facing
annotation experience at all**, verified fresh this pass (zero call sites for any
labeling API binding anywhere in `clients/portal/src`, no page under
`clients/portal/src/app` matching `label` or `annotat`). A human at eden today who
wants to label a trace or eval result has exactly one option: call the API
directly (`POST /orgs/{org}/labeling/traces/{trace_id}/annotate` or the generic
`POST /orgs/{org}/labeling/annotate`) with `curl` or a script. There is no queue to
pull from in a browser, no kanban board, no IAA dashboard — the backend
(`labeling.py`, §1 above) is real and tested, but a human reviewer cannot reach it
without writing code. This is worth stating plainly in the doc's own voice because
"zero UI consumers" as a grep result understates the product reality: it's not that
the UX is *rough*, it's that **the UX does not exist**. Every comparison below is
therefore not "eden's flow vs. competitors' flow" but "the flow eden's backend
already supports vs. what should be built," since there is nothing live to
critique today.

### What a fast, low-friction labeling UX actually requires

Drawing on the primary-source competitor research this doc already did (§4) plus
what "fast" concretely means for a reviewer doing hundreds of labels in a
sitting — the bar is not "has a form," it's "a reviewer never touches the mouse
except to read":

1. **Zero-latency pop-and-label loop.** The unit of work is one item: read
   `item.prompt`/`item.payload` (with a link to `source_trace_id`/
   `source_span_id` for context), pick a label, submit, and the *next* item should
   already be loading before the submit round-trip finishes. eden's
   `LabelingService.pop(limit=5)` (`labeling.py:392-411`) already supports
   batch-prefetching 5 items in one call — the frontend should pop 5, hold 4 in a
   client-side buffer, and only re-call `pop()` when the buffer runs low, so the
   *perceived* latency per item is zero even though the network round-trip isn't.
   This is a real design decision the doc's §6c.3 doesn't call out: it describes
   `popQueue()` as called "on load," which if implemented literally (pop 1, wait,
   submit, pop 1 again) reintroduces exactly the latency a keyboard-driven flow is
   supposed to eliminate.
2. **Keyboard-only path for the common case.** The doc's §6c.3 already specifies
   `1-9` for labels, `s` for skip, `Enter` to submit — correct and consistent with
   every competitor researched (LangSmith's `A`/`B`/`E` for pairwise, Label
   Studio's task-stream model). What's missing from that spec: (a) an
   **undo/back key** (`u` or `Backspace`) to fix the last submission without
   navigating away — none of the three competitors document this explicitly but
   it's a standard omission that causes real annotator frustration (a mis-key on
   item 40 of 200 with no undo means either a wrong label ships or the reviewer
   has to know the API well enough to hand-fix it), and eden's `annotate()` is
   already an UPSERT keyed on `(item, annotator)` (`labeling.py:501-598` docstring:
   "revisions overwrite") — undo is a free win, it's just re-submitting the
   previous item_id with the previous label, no new backend capability needed;
   (b) a **confidence shortcut** — the schema already has a `confidence` field
   (0-1) per annotation (`migrations/035_labeling.sql:110-111`) but the doc's key
   bindings don't reserve a key for it; a reviewer who has to reach for a mouse to
   drag a confidence slider once per item defeats the keyboard-only goal. A
   simple `Shift+1..5` for confidence tiers (or holding a modifier while pressing
   the label key) keeps the whole loop keyboard-native.
3. **Batch actions for the boring 80%.** Individual pop-and-label is right for
   items that need real judgment, but a meaningful fraction of any queue is
   "obviously fine" or "obviously skip" (e.g., a trace that errored before any
   model output — nothing to label). LangSmith, Braintrust, and Label Studio all
   support multi-select in their table/kanban views (bulk-assign, bulk status
   change). eden's `list_items()` (`labeling.py:341-391`) already returns
   paginated items with tags and source — the queue-list page (§6c.1 in the doc)
   should support multi-select + bulk-skip at minimum, since `skip()`
   (`labeling.py:602-632`) is a single-item call today with no bulk variant; that's
   a small, cheap backend addition (a `POST /labeling/skip/bulk` taking a list of
   item_ids, or just have the frontend fan out N `skip()` calls client-side since
   volume here is unlikely to be huge) that meaningfully changes throughput for a
   reviewer working through a large backlog.
4. **Inter-annotator agreement should be visible mid-flow, not just in a
   dashboard.** The doc's §6c.3 already proposes the right middle ground
   (Braintrust-style "N annotations so far / agreement so far" surfaced via
   `IAAReport.per_item`, without full blind-review or full shared-visibility) —
   this is good and should stay. What the UX draft should add: this signal needs
   to be visible **before** the reviewer opens the item, not just after, so a
   reviewer prioritizing their own queue can see "this item already has 1
   annotation, low confidence, needs a tiebreaker" at a glance in the list view —
   i.e., the queue-list page (§6c.1) and the IAA "needs another reviewer" filter
   (§6c.4) are really the same underlying signal (`per_item[id].agreement` +
   `annotation_count < annotations_required`) and should be the *same* visual
   affordance (a small badge/icon in the item list), not two separate pages a
   reviewer has to cross-reference. This is the single highest-leverage UX
   unification the doc's plan is currently missing — Label Studio's "order by
   agreement" (confirmed via primary-source fetch this pass: "Order tasks by
   agreement, to review annotations with more uncertainty among annotators first")
   is exactly this pattern applied as a default sort, not a separate dashboard
   view, and eden should default the queue-list sort to
   ascending-agreement-first for items with existing annotations, so
   disagreement-needing items surface to the top of every reviewer's queue
   automatically rather than requiring someone to remember to check the IAA
   dashboard.
5. **Session-level throughput feedback.** None of LangSmith/Braintrust/Label
   Studio's docs mention this, but it's a well-established annotation-tooling
   pattern (Scale/Surge-style workforce tooling): a persistent, unobtrusive counter
   ("47 labeled this session, avg 8s/item") keeps a reviewer in flow state and
   gives them a natural stopping point. eden's `Annotation.time_spent_ms`
   (`labeling.py:66-105`) is already captured per-annotation — this is a pure
   frontend read of data the backend already persists, zero new backend work,
   and should be a small addition to the annotate work-surface (§6c.3) rather than
   a separate feature.
6. **Fail loudly, not silently, on the concurrency gaps this doc already found.**
   Once a real annotate UI ships, §1a's fail-open lease-claim exception and
   orphaned-`in_progress` items become *directly visible* to reviewers as "I can't
   pop this item, it says it's assigned to someone else, but no one's touched it
   in an hour" — a confusing, trust-eroding failure mode for exactly the audience
   this UI is trying to make productive. This is additional weight behind the
   doc's own §6d sequencing recommendation (backend hardening before real usage,
   not after) — from a pure UX-quality standpoint, a labeling tool that
   occasionally and silently locks reviewers out of their own queue is worse than
   having no tool, because it erodes trust in the tool itself, not just in one
   item's data.

### Net assessment

The backend eden has today (`labeling.py`'s κ+α engine, real skill-matched priority
queue, real lease mechanism) is a genuinely competitive foundation — nothing here
needs to be built to reach parity with LangSmith/Braintrust/Label Studio on the
*data model* side. The gap is entirely in the reviewer-facing loop: pop latency,
keyboard completeness (undo, confidence), bulk actions for the low-judgment
majority of items, and — most importantly — making disagreement-needs-review a
default sort signal in the list a reviewer already looks at, rather than a
separate dashboard nobody will check proactively. All of the above are additive
to the doc's existing §6 build plan, not replacements for it; §6's page list and
sequencing are sound, the additions above are worth folding into §6c.3
(keyboard/undo/confidence/session-counter) and §6c.1/§6c.4 (unify the
agreement-based prioritization signal instead of treating list view and IAA
dashboard as separate concerns).

## NEW FINDINGS

1. **Docstring/route-count self-contradiction in the source, not just the doc's
   observation of it**: `api/routes/labeling.py:3` literally says "Six routes"
   directly above a list of 8 bullets (`api/routes/labeling.py:5-12`), and the
   actual route count is 15. This is a pre-existing bug in the codebase's own
   documentation (three different numbers: 6 claimed, 8 listed, 15 real) — worth a
   one-line fix in the source itself (update the docstring) whenever anyone next
   touches this file, independent of the frontend build.
2. **`skip()` has no bulk variant** (`labeling.py:602-632` is single-item only) —
   relevant to the "batch actions" UX requirement above; small, cheap addition
   worth bundling into the same PR as the queue-list page (§6c.1) rather than
   treated as a later enhancement.
3. **`Annotation.confidence` and `time_spent_ms` are captured by the backend today
   but neither is reflected anywhere in the doc's proposed keyboard-shortcut set or
   UI plan** — both are free wins for the UX (a confidence hotkey, a session
   throughput counter) since the data model already supports them; no schema or
   backend change needed, purely a frontend gap in the existing §6c plan.
4. **Sourcing-link mismatch (minor, not a factual error)**: the doc's §4 Braintrust
   paragraph's most detailed claims (auto-averaging, "Set as base span value," "N
   total reviews," "Review spans" dropdown) are all sourced from
   `multiple-reviewers`, not `manage-review-work` — both URLs are listed in the
   Sources section so this isn't a fabrication, but a reader trying to verify the
   *first* URL listed inline for that paragraph would come up empty on those
   specific quotes. Worth reordering the inline citation to lead with
   `multiple-reviewers` if this doc is touched again.
5. **Confirmed no cross-doc redundancy** — checked all 15 sibling docs in
   `features/` for labeling/annotation/IAA/kappa mentions; the four that hit (01,
   10, 13, 15) use the terms in service of unrelated topics (active-learning
   theory, competitor "living asset" framing) and do not restate F08's findings.
   No pruning needed on redundancy grounds.
