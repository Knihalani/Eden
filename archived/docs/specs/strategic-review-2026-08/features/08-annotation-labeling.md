# F08 — Annotation / Labeling Queues

Date: 2026-08-05 (third pass — deepens Phase 2's IAA-collision and concurrency
questions; web research replaced with primary-doc UX detail, not marketing pages)
Scope: Human-in-the-loop annotation/labeling queue features in LangSmith, Braintrust,
Label Studio, and Scale/Surge AI (queueing, inter-rater agreement, keyboard shortcuts,
batch actions, disagreement resolution, queue fairness), vs. what actually exists and
is wired live in `src/eden/`.

**Verdict: KEEP — pure frontend build against a finished, tested backend, plus one
concrete backend hardening item this pass surfaced (lease/status recovery on
reviewer disconnect) and one concrete consolidation (delete the dead second IAA
engine).**

**Correction to prior draft of this file**: an earlier pass concluded
`tool_call_labels.py` (F21 tool-call thumbs-up/down) was "eden's only human-labeling
surface" and recommended skipping IAA tooling. That is wrong — eden already has a
second, separate, more capable general-purpose annotation-queue subsystem
(`src/eden/evaluation/labeling.py` + `labeling_queues.py` + `iaa.py` +
`api/routes/labeling.py`) that the earlier pass missed. This version supersedes it.

**Pass 4 (final) note**: every non-trivial claim in this doc was re-verified
against source this pass and held up — this is the most heavily re-checked doc in
the review set. Two off-by-one line-count citations were fixed
(`labeling_leases.py` is 110 lines, not 111; `api/routes/labeling.py` is 502
lines, not 503). No content was cut as false, stale, or speculative. The one
substantive addition is §5a, "User Experience & Value" — the doc previously had
an implementation-oriented build plan (§6) but no narrative on who the reviewer
user is, what the flow feels like once built, and where the current plan
under-specifies the experience (pop latency, keyboard completeness, bulk
actions, disagreement-aware sort).

## 1. What the backend actually does (verified)

`src/eden/evaluation/labeling.py` is 949 lines, docstring-labeled "Labeling queue
service (Phase D — Cat 3 HiL real)" (`labeling.py:1`).

- **Data model** (`labeling.py:66-105`): `LabelingItem` (id, org_id, payload,
  label_schema, prompt, status, tags, `annotations_required`, `required_skills`,
  `source_trace_id`/`source_span_id`/`source_dataset_id`/`source_synthetic_qa_id`,
  `assigned_to`) and `Annotation` (id, item_id, annotator_id, label, confidence,
  notes, `time_spent_ms`, `skills_exercised`, timestamps). `IAAReport`
  (`labeling.py:106-124`) carries `kappa`, `alpha`, `overall_agreement`,
  `item_count`, `annotation_count`, plus `per_item`/`per_pair` breakdowns via
  `to_dict()`.
- **Stats are real, not stubs**: `cohens_kappa()` (`labeling.py:145-173`) computes
  observed vs. chance agreement over paired labels and returns `None` on degenerate
  input (empty/mismatched lists, <2 distinct labels, `p_e >= 1.0`) rather than
  raising or silently returning 0. `krippendorffs_alpha()` (`labeling.py:176-241`)
  implements the nominal-metric variant — pairwise disagreement across annotators
  per item vs. expected disagreement across the full label distribution — also with
  `None` guards for empty input. `agreement_rate()` (`labeling.py:244-248`) is a
  plain pairwise-match percentage. `compute_iaa()` (`labeling.py:636-812`) assembles
  all three plus a `per_item`/`per_pair` breakdown by grouping annotations per item
  and per annotator pair.
- **`LabelingService`** (`labeling.py:254-861`): `seed()` inserts a new item;
  `find_or_seed_trace_score_item()` (`labeling.py:310-341`) is the trace-level
  find-or-create used by the score-a-trace endpoint; `list_items()` paginates with
  annotation counts; `pop()` (`labeling.py:393-497`) implements a real three-tier
  priority queue (detailed in §1a below); `annotate()` (`labeling.py:501-598`)
  upserts a label and releases the lease; `skip()` (`labeling.py:602-632`) marks an
  item un-labelable; `export()` (`labeling.py:816-861`) emits JSONL of completed
  labels.
- **API surface**: `api/routes/labeling.py` (502 lines) exposes **15 routes** —
  its own module docstring (`api/routes/labeling.py:1-13`) is internally
  self-contradictory about this: it literally says "Six routes" directly above a
  list of 8 bullets, and the real count is 15 (three different numbers: 6
  claimed, 8 listed, 15 real). This is a pre-existing bug in the source's own
  documentation, not a doc error here — worth a one-line docstring fix whenever
  anyone next touches the file, independent of the frontend build below.
- **Test coverage is substantive, not a throwaway prototype**: `tests/unit/
  evaluation/test_labeling.py` — 676 lines, 39 test functions — covers the service
  and both stats functions but, notably, **has zero tests that call `pop()` twice
  concurrently or simulate a lease race** (`grep -n "async def test_pop"
  test_labeling.py` finds single-caller tests only — no `asyncio.gather`, no
  multi-annotator contention test). `tests/unit/evaluation/test_labeling_queues.py`
  (15 lines, 1 test — thin); `tests/unit/api/test_labeling_path_org_access_jul19.py`
  (146 lines, 10 tests) — verifies every route rejects cross-org access, but not
  concurrency.

## 1a. `pop()` concurrency deep-dive — lease expiry, disconnect, and the double-claim race

This pass read `labeling.py:393-497` and `labeling_leases.py` (110 lines) line by
line rather than at the "Redis-leased" summary level. Three separate mechanisms are
in play, and only one of them is airtight.

**Candidate selection has no row lock.** The three priority-tier `SELECT`s
(`labeling.py:418-427`, `432-443`, `446-457`) are plain reads —
`WHERE status = 'pending' AND assigned_to ...`, no `FOR UPDATE SKIP LOCKED`, no
transaction wrapping the whole `pop()` call. Two concurrent `pop()` invocations can
both select the same candidate row. This is fine *by design* — the code doesn't try
to make the SELECT exclusive; exclusivity is meant to be enforced downstream by the
lease.

**The actual mutex is `labeling_leases.py:37`**: `redis.set(key, annotator_id,
nx=True, ex=ttl)` — a single atomic Redis command (`SET NX EX`). This is the one
genuinely race-free primitive in the whole path: when Redis is reachable, two
concurrent claimants cannot both win it. Stale-holder detection
(`labeling_leases.py:40-43`) re-`GET`s on a failed `SET NX` and retries once if the
key evaporated between the two calls (a benign TOCTOU window, not a correctness
bug) or short-circuits `True` if the existing holder *is* the calling annotator
(idempotent re-claim, e.g. page reload).

**Three concrete gaps, each with a citation:**

1. **Fail-open exception swallowing** (`labeling.py:462-468`):
   ```python
   try:
       from eden.evaluation.labeling_leases import claim_lease
       if not await claim_lease(org_id, item.id, annotator_id):
           continue
   except Exception:
       pass
   ```
   `claim_lease()` already catches its own Redis failures internally
   (`labeling_leases.py:32-45`) and falls back to the in-memory dict — so the outer
   `except Exception: pass` only fires on a genuinely unexpected error (e.g. the
   `from ... import claim_lease` failing, or a bug inside the memory-fallback
   branch). When it does fire, `pop()` proceeds **as if the lease had been
   successfully claimed** — it does not `continue`, does not retry, does not
   decline the item. This is fail-open: the one place designed to guarantee
   exclusivity defaults to granting access on unexpected error instead of denying
   it.

2. **The in-memory fallback is process-local, not a real distributed fallback**
   (`labeling_leases.py:13`, `47-52`): `_memory_leases: dict[str, tuple[str,
   float]] = {}` is a plain module-level Python dict. In a horizontally-scaled
   deployment (multiple uvicorn/gunicorn workers or k8s replicas — the normal
   production shape for this kind of API), each process has its own independent
   copy. During a Redis outage, `claim_lease()` silently downgrades from a
   cluster-wide mutex to a per-process one: two reviewers hitting two different
   pods can each be told they hold the lease for the same item, because neither
   pod's dict knows about the other's grant. **This is the actual answer to "what
   happens when two reviewers claim the same item": it cannot happen while Redis is
   up (SET NX EX is atomic), but it silently becomes possible the moment Redis is
   unavailable in a multi-process deployment** — and nothing surfaces that
   degradation to an operator; `claim_lease` just logs at `debug` level
   (`labeling_leases.py:45`).

3. **No DB-level backstop, and the UPDATE's rowcount is never checked.** The unique
   constraint on `labeling_assignments` is `UNIQUE (item_id, annotator_id)`
   (`migrations/035_labeling.sql:154`) — it dedupes the *same* annotator claiming
   the *same* item twice, but does **nothing** to stop two *different* annotators
   from each getting a `labeling_assignments` row for the same `item_id`; there is
   no `UNIQUE (item_id)` anywhere. The subsequent status flip
   (`labeling.py:487-494`, `UPDATE labeling_items SET status='in_progress' WHERE id
   = $1 AND status = 'pending'`) correctly guards on `status='pending'` so a second
   writer's UPDATE becomes a no-op — but the return value of `self._pg.execute()`
   is discarded (line 487) and the code unconditionally does `item.status =
   "in_progress"; items.append(item)` (`labeling.py:495-496`) regardless of whether
   the UPDATE actually changed a row. So if gap #1 or #2 above lets a second
   claimant through, the API will still report the item as successfully assigned
   to them even though the DB-level guard silently rejected the write.

**Lease expiry / reviewer disconnect has no recovery path at all.** TTL defaults to
900s (`labeling_leases.py:12`, overridable via
`EDEN_LABELING_LEASE_TTL_SECONDS`, floor 30s at `labeling_leases.py:16-21`). When a
reviewer disconnects or sits idle past the TTL, the Redis key simply expires and
`claim_lease()` would let a *new* claimant through — but `labeling_items.status` was
already flipped to `'in_progress'` at claim time and **nothing ever reverts it**.
Repo-wide search confirms this: `grep -rn "in_progress" src/eden` shows only the
one write site (`labeling.py:490`) and no read/reset site; `grep` of
`src/eden/workers/cron_tick.py` and `background.py` for `labeling` returns zero
matches (no reaper/sweep job exists); `grep -n "unassign|reclaim" api/routes/
labeling.py` returns zero matches (no admin endpoint exists either). Because all
three `pop()` tiers filter on `status = 'pending'` (`labeling.py:421, 435, 449`) —
including tier 1 (`assigned_to = annotator_id AND status = 'pending'`, line
421-422) — **even the original annotator cannot re-pop an item they abandoned**;
the lease layer is designed to self-heal via TTL, but the status layer above it has
no matching recovery step, so a disconnected reviewer's item is orphaned in
`in_progress` permanently, recoverable only via a manual DB UPDATE. This is a
concrete, fixable gap: `pop()`'s tier-1 query should also match items whose lease
has expired regardless of current `assigned_to`/status staleness, or a scheduled
sweep should reset `in_progress` items whose lease key is absent back to
`pending`.

## 2. The "zero UI consumers" claim — verified, and actually broader than the prior draft found

- `clients/portal/src/lib/api/resources.ts` defines `labelingApi` (`listItems`,
  `annotate`, `skip`, `seedItem` — resources.ts:3360-3386) and `labelingQueuesApi`
  (`list`, `create`, `get`, `board`, `move`, `pushToDataset`, `iaa` —
  resources.ts:4069-4116), plus two more labeling-related bindings living directly
  on the top-level `api` object: `labelToolCall()` (resources.ts:1861-1875) and
  `annotateTrace()` (resources.ts:1878-1892).
- Repo-wide grep of `clients/portal/src` for `labelingApi`, `labelingQueuesApi`,
  `annotateTrace`, and `labelToolCall` finds each one only inside `resources.ts`
  itself — zero call sites in any page or component.
- No page or route exists under `clients/portal/src/app` matching `label` or
  `annotat`, and no component matches `kappa`, `krippendorff`, or
  `inter-annotator` outside `resources.ts`. There is no annotator-facing page: no
  "pop next item," no kanban board, no IAA dashboard.
- **The existing bindings are also incomplete, not just unused.** `labelingApi`
  covers 4 of the 8 Phase-D routes. Three Phase-D routes have no client binding at
  all: `GET /labeling/queue/{user_id}` (pop), `GET /labeling/iia` (org/global IAA,
  distinct from `labelingQueuesApi.iaa`), and `GET /labeling/export`.

**Conclusion unchanged from Phase 2**: every labeling-related binding in the
portal is orphaned, and the existing bindings cover roughly half the usable
surface.

## 3. The two-IAA-engine collision — resolved

Phase 2 found the collision (`labeling.py`'s κ+α engine vs. `evaluation/iaa.py`'s
κ-only engine, feeding confusingly-named `/iia` vs. `/iaa` endpoints) but stopped at
"worth a rename." This pass traced both engines' actual callers and data
dependencies to reach a decisive call.

**`src/eden/evaluation/iaa.py` (44 lines: `cohen_kappa()` at `iaa.py:9`,
`iaa_from_annotation_pairs()` at `iaa.py:27`) is not just redundant — it is
effectively dead code in production.** Its sole consumer, `queue_iaa()`
(`api/routes/labeling.py:446-471`), reads `payload.get("label_a")` /
`payload.get("annotator_1")` and `payload.get("label_b")` /
`payload.get("annotator_2")` out of each kanban item's JSON payload
(`api/routes/labeling.py:467-468`). **Nothing in the codebase ever writes those
keys.** `LabelingQueueService.add_item()` (`labeling_queues.py:142-168`), the only
write path that populates `labeling_items.payload` for a `queue_id`-scoped item,
sets `payload = {"trace_id": trace_id}` only (`labeling_queues.py:150,
155-156`) — no `label_a`/`label_b`/`annotator_1`/`annotator_2` anywhere. A
repo-wide grep for those four key names
(`grep -rn "label_a\|label_b\|annotator_1\|annotator_2" src/`) returns matches
**only inside `api/routes/labeling.py:467-468` itself** — the reader exists, the
writer does not. Confirmed further: there is no API route to add an item to an F50
queue at all (`grep -n "queue_id\|add_item" api/routes/labeling.py` shows `board`,
`move`, `push-to-dataset`, and `iaa`, but no `POST /queues/{id}/items`) —
`add_item()` is only reachable from Python (`push_to_dataset`'s sibling seeding
path, F76 SQL export), so the realistic way today to get an item into a queue never
produces the shape `queue_iaa()` expects. And the only test that imports
`iaa_from_annotation_pairs` (`tests/unit/playground/test_w18_playgrounds.py:9,187-189`)
exercises the pure math function directly with hand-built tuples — it never drives
the endpoint or the payload-parsing path, so there is no test coverage that would
have caught this. Net effect: `GET /orgs/{org}/labeling/queues/{queue_id}/iaa`
will return `{"kappa": 0.0, "n": 0, "agreement_rate": 0.0}` for every queue created
through the normal product flow, today, in production.

**Recommendation: delete `iaa.py`, don't rename it.** There is no genuine second
use case here — `iaa_from_annotation_pairs()` is a strict functional subset of
`LabelingService.compute_iaa()` (kappa only, no alpha, no per-item/per-pair
breakdown, no persistence-aware grouping) fed by a schema convention that has no
writer. The two "queue models" (`LabelingService`/`labeling_items`+`annotations`
vs. `LabelingQueueService`'s kanban view over the same `labeling_items` table with
`queue_id`/`kanban_status` columns) may have a defensible short-term reason to
coexist as a lighter MVP kanban surface — that is a separate, larger question this
pass did not need to resolve to make the IAA call. But the IAA duplication has no
such justification. **Exact consolidation path:**

1. Repoint `queue_iaa()` (`api/routes/labeling.py:446-471`) to fetch the item ids
   in the queue (`SELECT id FROM labeling_items WHERE org_id=$1 AND
   queue_id=$2::uuid`) and call the existing `LabelingService(pg).compute_iaa(org_id=org_id,
   item_ids=item_ids)` — which already reads from the real `annotations` table
   (proper multi-row, multi-annotator model with annotator_id/confidence/notes/
   timestamps) and is a strict superset of what `iaa_from_annotation_pairs()`
   computes.
2. Delete `src/eden/evaluation/iaa.py` and the one test that imports it
   (`test_w18_playgrounds.py:9,187-189` — migrate the two assertions to call
   `cohens_kappa()`/`agreement_rate()` from `labeling.py` instead, since those are
   the surviving canonical functions).
3. Rename the two remaining endpoints to remove the `/iia` vs. `/iaa` visual
   collision — e.g. `/labeling/iia` (Phase-D global) → `/labeling/agreement`, and
   `/queues/{id}/iaa` (F50, now backed by the same engine) → `/queues/{id}/agreement`.
   Do this rename in the same PR as step 1 so there is never a window with two
   near-identical paths returning different shapes.

This leaves exactly **one** IAA engine (`labeling.py`'s κ+α + per-item/per-pair
breakdown) as canonical everywhere, and turns a currently-broken endpoint into a
correctly-populated one for free.

## 4. Competitive baseline — disagreement resolution and queue fairness, in depth

Phase 2's competitive section listed capabilities. This pass went into each
platform's actual assignment/adjudication mechanics via primary docs (not
marketing pages), specifically for reviewer disagreement resolution and queue
fairness (round-robin vs. skill-matched).

**LangSmith annotation queues** — queue fairness is **not round-robin**; it's a
count threshold plus optional named assignment, backed by short-lived
reservations:
[docs.langchain.com/langsmith/annotation-queues](https://docs.langchain.com/langsmith/annotation-queues).
- **"Number of reviewers per run"**: any workspace member can pick up an item
  until that many people have marked it Done — no scheduling algorithm, first-come
  pull-based.
- **"Assigned reviewers" toggle**: a multi-select user picker restricts who counts
  toward completion; non-assigned members can still annotate but their input
  doesn't close the item — items with assigned reviewers move through **"Needs
  Review → Needs Others' Review → Completed."**
- **Reservations, not leases-with-manual-recovery**: while an item is reserved,
  other reviewers can view it but cannot add feedback; if a reviewer abandons an
  item, "the reservation will expire after the specified Reservation length,"
  releasing it back to the pool — i.e., LangSmith's reservation TTL *does* have a
  release-back-to-pool step, which is exactly the recovery step eden's `pop()` is
  missing (§1a above: eden's lease expires but the item status doesn't follow it
  back to `pending`).
- **Disagreement is preserved, not reconciled**: "Reviewers cannot view the
  feedback left by other reviewers" (comments are the one shared channel) — no
  consensus scoring, no conflict alert, no adjudication step described anywhere in
  the docs. LangSmith's answer to "disagreement resolution" is really "keep
  reviewers independent, resolve downstream via Align Evals" (using human
  corrections to calibrate an LLM-judge, not to reconcile two humans).
- **PAQ mechanics**: exactly two experiments selected → LangSmith auto-pairs runs
  chronologically → reviewer sees Run A / Run B side by side with hotkeys `A`/`B`/`E`
  (Equal) per rubric item → binary feedback is recorded on both runs behind the
  scenes from one comparative judgment. Change note vs. Phase 2: PAQ was previously
  cited as "reservations prevent double-grading" at the feature-list level; this
  pass confirms the specific mechanism is the same reservation system used for
  single-run queues, not a separate PAQ-only lock.

**Braintrust human review** —
[braintrust.dev/docs/annotate/human-review/multiple-reviewers](https://www.braintrust.dev/docs/annotate/human-review/multiple-reviewers),
[braintrust.dev/docs/annotate/human-review/manage-review-work](https://www.braintrust.dev/docs/annotate/human-review/manage-review-work).
Fairness is **manual assignment, not round-robin**: select a row → click the flag
icon → "Assign" → pick a specific team member, across logs/experiments/datasets
tables; assignees get an email and (if configured) a Slack DM with a preview.
Broader load-balancing happens through **saved/filtered views** ("Awaiting review,"
"Assigned to me," personal > project > organization view precedence), not an
automatic distribution algorithm. The kanban queue is exactly three columns —
**Backlog → Pending → Complete** — cards drag between them, saving automatically.
**Disagreement reconciliation is genuinely differentiated and worth copying**:
- Numeric/categorical-resolvable scores are **auto-averaged** into the parent
  span's value — no manual step.
- Free-form-text or expected-output scores **can't** be averaged, so a human
  explicitly picks a winner via "Set as base span value" (or "Set as root value"
  on dataset rows) from the score's options menu.
- Disagreement is surfaced via an **"N total reviews" indicator** — hovering shows
  how many reviewers' scores match the current base value and how many diverge,
  and a "Review spans" dropdown lets you flip between "Review by [reviewer]" and
  the resolved "Base span" view.
- No blind review: all reviewers see each other's scores (the inverse of
  LangSmith's independence-by-default model) — a real design trade-off between the
  two products (blind-then-reveal vs. always-visible-with-a-reconciliation-step)
  that eden should pick deliberately, not by accident.

**Label Studio Enterprise** —
[docs.humansignal.com/guide/quality](https://docs.humansignal.com/guide/quality),
[humansignal.com/blog/enhancing-data-quality-with-label-studio-automated-workflows](https://humansignal.com/blog/enhancing-data-quality-with-label-studio-automated-workflows/).
Assignment is **manual or Manual/Automatic distribution with overlap**, not named
round-robin: bulk-select tasks in the Data Manager → "Assign Reviewers" → pick
names → Assign; Enterprise review streams add **Task Ordering** ("By Task ID
(sequential)" or "Random") and a **Task Limit (%)** cap for random ordering.
Reviewers can additionally choose to work the queue **ordered by agreement**
("review annotations with more uncertainty among annotators first") — the closest
analogue to a fairness/priority policy in the docs, but it's a manual sort choice,
not a system-enforced policy. **Disagreement resolution is a three-action manual
adjudication**, not automatic: for each annotation a reviewer picks **Accept /
Fix & Accept / Reject** (reject doesn't return it to the annotator automatically —
re-labeling requires deleting the annotation and returning it to the label stream
manually). **Low-agreement tasks do get automatic reassignment** — this is the one
genuinely automated mechanism found across all three platforms: when a task's
measured agreement (config: out-of-the-box or custom definition, N annotations
required) falls under the configured threshold, Label Studio "add[s] additional
annotators to try to bump the score over the threshold" — an iterative,
as-needed escalation rather than a fixed additional-N count. This directly
validates the Scale/Surge "disagreement routing" pattern noted in Phase 2 and gives
eden a concrete implementable version: **when `compute_iaa()`'s per-item kappa for
an item falls below a threshold, auto-bump that item's `annotations_required` by 1
and re-surface it in `pop()`** — eden already has every piece needed
(`per_item` breakdown, `annotations_required` column, `pop()`'s pending-item
matching) except the threshold check and the bump itself.

## 5. Comparison table (extended)

| Capability | Scale | Labelbox | LangSmith | Label Studio | Braintrust | eden `evaluation/labeling` |
|---|---|---|---|---|---|---|
| General annotation queue | yes | yes | yes | yes | yes | yes |
| Batch/kanban review | yes | yes | partial | yes | yes (3-col) | yes (F50, backend only) |
| Multi-annotator IAA (κ / α) | via workforce QA | yes (consensus) | thin, 3rd-party | yes, multi-view dashboard | avg + manual reconcile | yes — real κ + Krippendorff's α (backend only, and after §3's fix, the *only* engine) |
| Disagreement drill-down (per-item/per-pair) | yes | yes | no | yes (confusion matrix) | "N total reviews" indicator | data computed, **not surfaced anywhere** |
| Automatic low-agreement reassignment | yes (auto-reassigned) | n/a | no | **yes** (threshold-triggered) | no | no — but `per_item` + `annotations_required` are the exact primitives needed |
| Queue fairness model | reservation/marketplace | n/a | count-threshold + reservation | manual/auto distribution + overlap | manual assignment + saved views | skill-match tiers + Redis lease (§1a: sound when Redis is up, silently degrades to per-process on Redis outage) |
| Lease/reservation recovery on disconnect | yes | n/a | yes (reservation expiry → pool) | n/a (task-based, not lease-based) | n/a (manual reassign) | **no** (§1a: status never reverts to `pending`) |
| Reviewer independence vs. shared visibility | independent | independent | independent by default | configurable | **shared, always visible** | independent (no UI exists to violate this either way) |
| Portal UI | yes | yes | yes | yes | yes | **none found** |

## 5a. User Experience & Value

### Who this is for

Three distinct users would touch this surface, none of whom eden currently
serves with anything but the raw API:

- **The annotator/QA reviewer** — a human (in-house or contracted) working
  through a queue of hundreds of items in a sitting: labeling trace outputs
  correct/incorrect, scoring eval results, or resolving disagreements. This is
  the primary persona for §6c.3's work surface and the one this section is
  mostly about.
- **The ML engineer building eval sets** — pulls labeled items via `export()`
  (`labeling.py:816-861`, JSONL of completed labels) to seed golden datasets or
  fine-tune an LLM-judge. Cares about label quality (IAA) and export ergonomics,
  not the moment-to-moment labeling loop.
- **The team lead / quality owner** — watches the IAA dashboard (§6c.4) to spot
  low-agreement items and decide whether a rubric is ambiguous, an annotator
  needs coaching, or an item genuinely needs a third opinion. Consumes
  `compute_iaa()`'s per-item/per-pair breakdown, which today is computed
  correctly (§1) but literally unreachable — no dashboard exists to view it.

### The flow today: there isn't one

This is the load-bearing fact for this whole section: **eden has no
reviewer-facing annotation experience at all** (§2's "zero UI consumers" grep
result). A human at eden today who wants to label a trace has exactly one
option — call `POST /orgs/{org}/labeling/traces/{trace_id}/annotate` (or the
generic `POST /orgs/{org}/labeling/annotate`) with `curl` or a script. There is
no queue to pull from in a browser, no kanban board, no IAA dashboard. The
backend is real and well-tested (§1), but a human reviewer cannot reach it
without writing code. "Zero UI consumers" as a grep result understates this:
it isn't that the UX is rough, it's that **the UX does not exist**. Everything
below is therefore "the flow eden's backend already supports vs. what should be
built," not a critique of something live.

### The flow eden's backend already supports: queue → annotate → submit → aggregate

1. **Queue.** `list_items()` (`labeling.py:341-391`) returns paginated items
   with tags, source, and annotation counts — the raw material for a queue list
   page. `pop(limit=5)` (`labeling.py:392-497`) is the actual per-reviewer
   claim step: a real three-tier priority queue (skill-matched → assigned →
   general pool), backed by a Redis lease (§1a) so two reviewers can't be
   handed the same item while Redis is up.
2. **Annotate.** One item, one form driven by `item.label_schema`, with
   `confidence` and `notes` fields already in the data model
   (`migrations/035_labeling.sql:110-111`).
3. **Submit.** `annotate()` (`labeling.py:501-598`) is an UPSERT keyed on
   `(item, annotator)` — revisions overwrite, which is what makes a cheap undo
   possible (§6c.3).
4. **Aggregate.** `compute_iaa()` (`labeling.py:636-812`) turns submitted
   annotations into κ, Krippendorff's α, and a per-item/per-pair breakdown —
   already correct and tested (§1), and after §3's fix, the single canonical
   engine feeding every consumer.

Every step in this flow has a working backend implementation. The entire gap is
presentation.

### Why this is valuable

The value isn't "add a page" — it's that eden already has the harder half of a
competitive annotation product (a real statistical IAA engine, a real
lease-based claim mechanism, a real skill-matched priority queue) and is
getting zero product credit for it because nothing surfaces it. Every
competitor examined in §4 — LangSmith, Braintrust, Label Studio — ships a
weaker or equivalent backend behind a materially better front door. Shipping
even a minimal `/labeling/annotate` page converts a backend-only capability
into something an ML engineer can point a QA contractor at without an
engineering escort, which is the actual unlock: cheaper, faster golden-dataset
construction and LLM-judge calibration data, without adding backend headcount.

### What "fast" concretely requires (gaps in the current build plan)

Drawing on §4's primary-source competitor research plus what "fast" means for a
reviewer doing hundreds of labels in a sitting — the bar is "a reviewer never
touches the mouse except to read," not "has a form." §6c already captures most
of this after the additions folded in above; the two gaps worth calling out
explicitly:

- **Unify list-view prioritization and the IAA dashboard's "needs another
  reviewer" filter into one signal**, not two pages a reviewer has to
  cross-reference. Both are `per_item[id].agreement` +
  `annotation_count < annotations_required` under the hood (§6c.1, §6c.4) — this
  is Label Studio's "order by agreement" pattern (confirmed via primary source,
  §4) applied as a default sort rather than a separate dashboard view, and it's
  the single highest-leverage unification missing from the plan: it makes
  disagreement-needing items surface automatically instead of requiring someone
  to remember to check a dashboard.
- **Fail loudly, not silently, on the concurrency gaps §1a already found.** Once
  a real annotate UI ships, the fail-open lease-claim exception and the
  orphaned-`in_progress` item (no recovery when a reviewer disconnects) stop
  being theoretical and become directly visible to reviewers as "I can't pop
  this item, it says it's assigned to someone else, but no one's touched it in
  an hour." A labeling tool that occasionally and silently locks reviewers out
  of their own queue is worse than no tool — it erodes trust in the tool
  itself, not just in one item's data. This is the strongest reason the doc's
  §6d sequencing puts backend hardening before real usage, not after.

### Net assessment

Nothing here needs to be built to reach data-model parity with
LangSmith/Braintrust/Label Studio — `labeling.py`'s κ+α engine, skill-matched
priority queue, and lease mechanism are already competitive. The gap is
entirely the reviewer-facing loop: pop latency, keyboard completeness, bulk
actions for the low-judgment majority of items, and unifying the
disagreement-needs-review signal into the list a reviewer already looks at
instead of a separate dashboard. All of this is additive to §6, already folded
into §6c.1 and §6c.3 above — this section is the "why it matters" and "who it's
for" that motivates those specific additions.

## 6. Concrete UI build plan (engineer-ready, updated)

This is primarily a frontend build; §1a and §3 add two small, well-scoped backend
items worth bundling into the same effort since they touch the same files.

### 6a. Backend hardening (small, do first — unblocks a correct UI)

1. **Lease-expiry recovery** (`labeling.py:487-497`, `labeling_leases.py`): add a
   sweep (either a `cron_tick.py` job or a check inline in `pop()`'s tier-1 query)
   that reverts `labeling_items.status` from `in_progress` back to `pending` when
   no active lease key exists for that item — mirroring LangSmith's
   reservation-expiry-releases-to-pool behavior. Cheapest version: extend tier 1's
   `WHERE` clause to also match `status = 'in_progress' AND assigned_to =
   annotator_id AND <lease not held by anyone else>`, so an annotator can always
   resume their own abandoned item.
2. **Fail-closed the lease claim** (`labeling.py:462-468`): change `except
   Exception: pass` to `except Exception: continue` (or log + skip) so an
   unexpected error declines the item instead of silently granting it.
3. **Check the UPDATE rowcount** (`labeling.py:487-494`): only append to `items`
   and flip `item.status` in Python if the UPDATE's returned status string
   confirms a row was affected (most PG drivers return `"UPDATE 1"` vs `"UPDATE
   0"` from `execute()`) — turns a silent inconsistency into an explicit skip.
4. **IAA consolidation** (§3): repoint `queue_iaa()`, delete `iaa.py`, rename
   `/iia` → `/agreement` and `/iaa` → `/agreement` on the queue route.

### 6b. `resources.ts` additions

```ts
// add to labelingApi
popQueue: (orgId: string, userId: string, limit = 5) =>
  fetchApi<{ items: ItemResponse[] }>(
    `/orgs/${orgId}/labeling/queue/${userId}?limit=${limit}`,
    { headers: { "X-Org-Id": orgId } },
  ),
getIAA: (orgId: string, itemIds?: string[]) =>
  fetchApi<IIAResponse>(
    `/orgs/${orgId}/labeling/agreement${itemIds ? `?item_ids=${itemIds.join(",")}` : ""}`,
    { headers: { "X-Org-Id": orgId } },
  ),
exportJsonl: (orgId: string, status = "completed", limit = 10000) =>
  fetchApi<string>(
    `/orgs/${orgId}/labeling/export?status=${status}&limit=${limit}`,
    { headers: { "X-Org-Id": orgId } },
  ),
```
Also widen the existing `annotate()` body type to include `confidence?`,
`time_spent_ms?`, `skills_exercised?`, and widen `LabelingItem`/
`LabelingAnnotation` to match `ItemResponse`/`AnnotationResponse` fully.

### 6c. Pages (under `clients/portal/src/app/.../labeling/`)

1. **`/labeling` — Queue list.** Table of F50 queues plus an "Unassigned items"
   panel from `labelingApi.listItems`. Two additions from §5a's UX pass: (a)
   default sort ascending by `per_item[id].agreement` for items that already have
   1+ annotation, so disagreement-needing items surface to the top automatically
   instead of requiring a separate dashboard check; (b) multi-select + bulk-skip
   — `skip()` (`labeling.py:602-632`) is single-item only today, so ship this as
   either a small `POST /labeling/skip/bulk` or a client-side fan-out of N
   `skip()` calls, since a meaningful fraction of any queue is "obviously skip"
   and doesn't need one-at-a-time handling.
2. **`/labeling/queues/[queueId]` — Kanban board.** Columns `todo / in_progress /
   done / skipped`; no drag-and-drop lib installed in the portal today — ship v1
   with a per-card "Move to →" dropdown. IAA summary strip at top now calls the
   *unified* agreement endpoint (post-§3 fix), so it will actually populate for
   every queue instead of only ones with hand-seeded `label_a`/`label_b` payloads.
3. **`/labeling/annotate` — the work surface.** One item at a time:
   `item.prompt`/`item.payload` with a link back to `source_trace_id`/
   `source_span_id`, a form driven by `item.label_schema`, confidence slider,
   notes. **Prefetch, not pop-on-demand**: call `popQueue(limit=5)`
   (`labeling.py:392-411` already supports batch prefetch) once, hold 4 items in
   a client-side buffer, and only re-call when the buffer runs low — popping one
   item per submit and waiting on the round-trip would reintroduce exactly the
   latency a keyboard-driven flow is supposed to eliminate. Keyboard shortcuts
   `1-9` for labels, `s` = skip, `Enter` = submit, plus two additions from §5a:
   `u`/`Backspace` to undo the last submission (free win — `annotate()` is
   already an UPSERT keyed on `(item, annotator)`, so "undo" is just
   re-submitting the previous item_id with the previous label, no new backend
   capability), and `Shift+1..5` for the `confidence` field so setting it doesn't
   require reaching for a mouse. A small persistent session counter ("N labeled
   this session, avg Xs/item") is a pure frontend read of `time_spent_ms`
   (`labeling.py:66-105`), already captured per-annotation, and keeps a reviewer
   in flow with a natural stopping point. **Disagreement-aware addition from §4**:
   follow Braintrust's pattern, not LangSmith's, for eden's first cut — since
   eden's `annotate()` is already an UPSERT keyed on (item, annotator) with no
   blind-review gate, don't retrofit blind review; instead surface Braintrust-style
   "N annotations so far / agreement so far" on items that already have 1+
   annotation, using
   `IAAReport.per_item[item_id]`, so a second annotator sees they're the tiebreaker
   without seeing the *specific* first label (a middle ground between the two
   competitors' models).
4. **IAA dashboard.** Headline kappa/alpha/overall-agreement tiles, per-pair table,
   per-item table sorted ascending by agreement — the "disagreement drill-down"
   every competitor above has. **New from §4**: add a "needs another reviewer"
   filter — items where `per_item[id].agreement < threshold` and
   `annotation_count < annotations_required` are exactly Label Studio's
   auto-reassignment candidates; even a manual "escalate" button here (bump
   `annotations_required` by 1) captures most of that platform's value without
   building a full automatic escalation engine.
5. **Trace detail page integration.** Add an "Annotate" action calling
   `api.annotateTrace()` — cheapest single win, all pieces already exist.
6. **Export.** Button hitting `exportJsonl()`.

### 6d. Sequencing recommendation

(5) trace-detail annotate button → §6a backend hardening (small, unblocks correct
concurrency before real usage) → (3) annotate/pop work surface → (4) IAA dashboard
→ (1)/(2) queue list + kanban board → (6) export.

## 7. Recommendation

1. **Fix the framing first** (unchanged from Phase 2, re-confirmed): `labeling.py`
   is a legitimately solid IAA engine. The gap is exposure, not capability.
2. **Highest-leverage next step**: ship the trace-detail "Annotate" button, then
   the `/labeling/annotate` pop-based work surface.
3. **Consolidate the two IAA engines now, not "later"** — this pass changes the
   Phase 2 verdict from "worth a rename, sequence after UI" to **do it in the same
   PR as the UI's IAA dashboard**, because it's not just a naming footgun anymore:
   `/queues/{id}/iaa` is confirmed dead code (§3) that would otherwise ship into a
   brand-new UI as a permanently-empty widget. Exact path: repoint
   `queue_iaa()` → `compute_iaa()`, delete `iaa.py`, rename both endpoints to
   `/agreement`. The two **queue models** (`LabelingService` vs.
   `LabelingQueueService`) can stay separate longer — that consolidation is a
   bigger question this pass didn't need to resolve to fix the IAA duplication.
4. **Backend concurrency hardening (§1a/§6a) should ship alongside the UI, not
   after.** Today the bug is invisible because nothing calls `pop()` in
   production. The moment the annotate page ships and gets real concurrent usage,
   the lease-expiry/no-recovery gap (items orphaned in `in_progress` forever) and
   the fail-open exception swallow become live correctness bugs, not theoretical
   ones. Three small, precisely-scoped fixes (§6a items 1-3) close the gap.
5. **Unify with F21** once there's real usage — unchanged from Phase 2, still
   lower priority than shipping the UI.
6. **Resolve the inert `tool_call_inference_v1` flag** — unchanged, orthogonal.
7. **Active-learning sample selection** — unchanged, sequence after the UI ships.

**Priority: medium-high**, same as Phase 2, with the addendum that the
concurrency-safety and IAA-collision items (§1a, §3) are cheap enough (three
small diffs + one file deletion) that there's no reason to sequence them after the
UI ships — they belong in the same PR as the pages that would otherwise expose
them.

## Phase 3 Verdicts (this pass)

New findings verified against current code (not carried over from Phase 2 on
faith):

1. **The Redis lease is a real, atomic mutex when Redis is reachable** — `SET NX
   EX` at `labeling_leases.py:37` is a single atomic command; confirmed no
   TOCTOU window in the happy path. **VERDICT: sound design, correctly cited in
   Phase 2's "Redis-backed lease" summary.**
2. **The in-memory fallback is process-local and silently defeats cross-instance
   exclusivity during a Redis outage** — new finding, not present in Phase 2.
   **VERDICT: real gap, concrete fix proposed (§6a).**
3. **Lease-expiry has no corresponding item-status recovery** — confirmed via
   repo-wide grep (zero reaper jobs, zero unassign/reclaim routes). **VERDICT:
   real gap, matches a pattern (reservation → pool release) that LangSmith
   implements and eden does not; concrete fix proposed (§6a.1).**
4. **`labeling_assignments`'s `UNIQUE (item_id, annotator_id)` constraint does not
   prevent two different annotators from both claiming one item** — verified
   against `migrations/035_labeling.sql:154`. **VERDICT: confirms the lease is
   the *only* exclusivity mechanism; no DB-level backstop exists.**
5. **`/queues/{id}/iaa` is dead code in production** (no writer ever populates
   `label_a`/`label_b`/`annotator_1`/`annotator_2`) — new finding, upgrades Phase
   2's "worth a rename" to "delete and repoint, urgently, same PR as any UI work
   that would surface it." **VERDICT: KEEP-WITH-ESCALATION.**
6. **Label Studio's automatic low-agreement reassignment is the one genuinely
   automated disagreement-resolution mechanism among the three platforms
   researched** (LangSmith and Braintrust are both manual/independent-by-default).
   **VERDICT: adopt a lightweight version — threshold-triggered
   `annotations_required` bump — as a §6c.4 UI affordance, not a new automated
   engine, to keep scope proportional.**

## Sources

- [LangSmith — Use annotation queues](https://docs.langchain.com/langsmith/annotation-queues)
- [LangChain Changelog — Pairwise annotation queues for comparing agent outputs](https://changelog.langchain.com/announcements/pairwise-annotation-queues-for-comparing-agent-outputs)
- [Braintrust — Set up human review](https://www.braintrust.dev/docs/annotate/human-review)
- [Braintrust — Review with multiple reviewers](https://www.braintrust.dev/docs/annotate/human-review/multiple-reviewers)
- [Braintrust — Manage review work](https://www.braintrust.dev/docs/annotate/human-review/manage-review-work)
- [Braintrust — 8 best human-in-the-loop LLM evaluation platforms in 2026](https://www.braintrust.dev/articles/best-human-in-the-loop-llm-evaluation-platforms-2026)
- [Label Studio Enterprise — Review annotation quality](https://docs.humansignal.com/guide/quality)
- [Label Studio Enterprise — Task agreement (stats)](https://docs.humansignal.com/guide/stats.html)
- [HumanSignal — Enhancing data quality with Label Studio automated workflows](https://humansignal.com/blog/enhancing-data-quality-with-label-studio-automated-workflows/)
- [Label Studio 1.21.0 release notes](https://labelstud.io/blog/label-studio-1-21-0/)
- [Label Studio — How to measure inter-annotator agreement and build human consensus](https://labelstud.io/tutorials/how_to_measure_inter_annotator_agreement_and_build_human_consensus)
- [Scale AI — SGP Annotation System / annotation queue docs](https://docs.gp.scale.com/docs/annotation-queue)
- [FutureAGI — Best LLM Annotation Tools in 2026](https://futureagi.com/blog/best-llm-annotation-tools-2026/)
- [uselemma.ai — Production monitoring for AI agents](https://www.uselemma.ai/)
