# Pass 4 notes — sole reviewer on `features/02-evals-datasets.md`

Scope: full independent re-verification of every non-trivial file:line claim in
the doc, plus a concrete "User Experience & Value" draft grounded in the real
`clients/portal` code. Original doc **not edited**. Overall assessment: this is
by far the most rigorously file:line-grounded doc in this review series — nearly
every internal `src/eden/` claim checked out exactly, often to the line. The
issues found are (a) one factual error about `llmops/judges/*` file layout, (b)
one fabricated cross-file claim about `03-prompt-playground.md`, and (c) a real,
previously-undocumented UX/trust gap in how F51's "synthetic" scores reach the
portal — all detailed below.

---

## VERIFIED

All verified by direct `grep`/`sed`/`Read` against `src/eden/` on the current
tree unless noted. Line numbers are quoted from the doc and confirmed exact
unless flagged otherwise.

- **App mounting.** `("eden.api.routes.experiments_offline", "router"),  # experiments/offline (F51)` and `("eden.api.routes.datasets_hub", "router"),  # /orgs/{org_id}/datasets (F53)` both present in `src/eden/api/app.py:249,247` (adjacent lines, order differs slightly from doc's exact citation but both routers are real and mounted). `("eden.api.routes.playgrounds", "router")` also mounted, confirming F49 is live too.
- **`offline_runner.py` (F51), exact line-for-line.**
  - `OfflineExperimentRunner` class at `offline_runner.py:47`. Confirmed.
  - `control = {...}` hardcoded dict at exactly `offline_runner.py:157-162`: `{"score": 0.5, "output": item.get("expected_output") or "", "synthetic": True, "method": "heuristic_stub"}`. Confirmed exact line match.
  - `_run_row` at exactly `offline_runner.py:266` (doc says 266-288; method body runs 266-289, off by one line at most, functionally the doc's range is correct). Logic confirmed exact: `score = 0.7 if expected else 0.5` (L278) then `if expected and expected in input_text: score = 0.9` (L279-280) — a pure substring-match heuristic, no model/LLM call anywhere in the file (confirmed via full-file grep for any HTTP/LLM client import — only `eden.experiments.compare` is imported).
  - `create()` calls `DatasetHub(self._pg).create_snapshot(org_id, dataset_id)` — confirmed, reuses F53 correctly.
  - `run()` fetches `dataset_items` with `WHERE dataset_id = $1::uuid` (confirmed at `offline_runner.py:151-154`) — i.e. `dataset_id` is a proper UUID FK here, matching the doc's contrast against 3a's free-text field.
  - Every score/response path (`run()` return dict, `_run_row` return dict) carries `"synthetic": True, "method": "heuristic_stub"` — confirmed at all four sites (control dict, `_run_row` return, `run()`'s top-level return, and `compare()`'s propagation — spot-checked, present).
- **`experiments/compare.py`.** `grade_datapoint`/`aggregate_grades` imported into `offline_runner.py` (L12) and independently into `src/eden/evaluation/ci_webhook.py:16`, used at `ci_webhook.py:60,62`. Confirmed this is a real shared primitive across the two subsystems as claimed.
- **`ci_webhook.py`.** `build_score_table` at `ci_webhook.py:73` (doc: 73-81 — confirmed, function body runs 73-80). Aggregate-only, per-case scoring absent — confirmed by reading the full function; it only computes rate-based metric rows, no per-datapoint join.
- **`regression_builder.py` / `regression_runner.py` (3a).**
  - `_persist` at `regression_builder.py:267`, `_find_by_fingerprint` at `188`, `_dataset_name` (free-text dataset name generator, not a UUID lookup) at `307` — all confirmed exact.
  - `RegressionCase.dataset_id: str` (plain string field, not UUID) confirmed at `regression_builder.py:20`.
  - `_evaluate_case` at `regression_runner.py:182`, `require_pass_for_canary` at `150` — confirmed. Replay-path methods (`_replay_enabled`, `_replay_ref`, `_replay_caps`, `_run_replay`) all present and roughly at the cited lines (`248/258/283/296` vs doc's `247-255/257-280/282-294/296-340` — close, doc's ranges cover slightly more context but the anchors are correct).
- **`improvement/replay_verify.py`.** `ReplayResult` dataclass at exactly `replay_verify.py:275` with fields `status`, `reason`, `cost_usd`, `traces_checked`, `details` — confirmed **no raw output text field** exists, matching the doc's claim that the replay path cannot feed a scorer without extension.
- **Migration `101_eval_loop.py` schema, byte-for-byte.**
  - `dataset_items.input`/`.expected_output` both `TEXT` — confirmed at lines 40-41 (doc cites 38-39, off by ~2 lines due to counting from the `CREATE TABLE` statement vs. column lines — trivial, not worth flagging as an error).
  - `dataset_snapshots` table at line 56 (doc: 56-64) — confirmed exact.
  - `offline_experiments` at line 69, `experiment_datapoints` at line 86 (doc cites the combined range 66-96, which is correct as an outer bound covering both tables plus the statement preamble).
- **Migration `092_market_ready_consolidated.py`.** `regression_eval_cases` table with `dataset_id VARCHAR(128) NOT NULL DEFAULT 'agent-regressions'` at exactly lines 355-367 as cited — confirmed to the character. This directly substantiates the doc's central "3a is schema-incompatible with F53" claim.
- **`golden_dataset.py` (3d).** 1,295 lines confirmed (`wc -l`). `DatasetRegistry` class at line 194, disk path `./golden_datasets` (constructor default) confirmed, `_CANONICAL_CASES` at line 301, `load_canonical_datasets()` at line 1261 — all confirmed exact.
- **`ci_pipeline.py` (3e).** `subprocess` imported at line 15, `StageName` enum with the six named stages at line 57, `DatasetRegistry`/`load_canonical_datasets` imported from `golden_dataset.py` at line 23, `SKIPPED`/`simulated: True` fallback behavior confirmed in the docstring at lines 202-205. Confirmed not mounted to any API route (no reference in `api/app.py`).
- **`auto_dataset.py` / `EvalScheduler` (3f).** `TraceQualityScorer` weights confirmed exact: `WEIGHT_CORRECTNESS = 0.40`, `WEIGHT_ROBUSTNESS = 0.25`, `WEIGHT_EFFICIENCY = 0.15`, `WEIGHT_DIVERSITY = 0.20` (auto_dataset.py:80-83, doc cites L81-86 — close enough, includes the `MIN_SCORE_FOR_PROMOTION` line too). `AutoDatasetPromoter` class at 213, `_persist_state` writing to `./.eden/auto_datasets` confirmed at 242. `EvalScheduler` confirmed absent from `workers/main.py` and `workers/cron_tick.py` by grep (zero hits).
- **`eval_intel/versioning.py` (3g).** Actual path is `src/eden/evaluation/eval_intel/versioning.py` (doc's shorthand `eval_intel/versioning.py` is accurate as a suffix). `EvalVersioner` class at line 55, `EvalRegistry` at line 214, `on_judge_regression` referenced in the module docstring at line 10. Live route confirmed: `api/routes/intelligence_eval.py` mounted at `api/app.py:148`.
- **`playground/scorers.py` (3h/F49).** `SCORERS` dict at exactly line 121, closing at 128, contents exactly `exact_match, contains, icontains, regex, json_valid, levenshtein_ratio` — confirmed to the letter. `run_scorers` at 131, `aggregate_score` at 169. Docstring lines 5-7 confirm the "llm_judge deliberately absent... a fake judge is worse than none" quote verbatim.
- **`experiment_intel/auto_eval.py` (3j).** Actual path is `src/eden/experiments/experiment_intel/auto_eval.py` — doc's shorthand omits the `experiments/` prefix but the file and its content are real. `AutoEvaluator` class at line 61, `evaluate` at 70, `_fetch_variant_scores` at 255, joins `judge_scores` to `telemetry_events` via `attributes->>'experiment_id'`/`attributes->>'variant'` — all confirmed exact including the SQL join shape at lines 289-295.
- **`prompt_versioning.py` (3l).** `run_auto_eval` at exactly line 378, `_llm_score` at exactly line 447. Confirmed `dataset_id` is accepted as a parameter and inserted into the `prompt_eval_runs` row but never read back/queried inside the function body (grepped the full function span for `dataset_id` — only appears as a parameter and an INSERT value, never in a SELECT).
- **`dataset_engine.py` / `hub.py` (3c/F53).** `_store_entry` at `insights/dataset_engine.py:364`, `self._datasets: dict[...] = {}` at line 207 — confirmed in-memory, no persistence. `DatasetHub.create_dataset` at `datasets/hub.py:124`, `promote_trace` at 232, `create_snapshot` at 285 — all real, all present, confirming the P1 migration plan's target methods actually exist as named.
- **LangSmith "split" field gap claim.** Confirmed no `split` column anywhere in `dataset_items` schema (migration 101 and 129 both checked), and no `split`-related logic in `datasets/hub.py` or `datasets/spreadsheet.py` (only unrelated `str.split()` calls). The competitive gap claim is accurate.
- **Cross-reference to `16-issue-extraction-online-evals.md`.** Confirmed that doc does own the `soft_issue_review.py`/`record_shadow_feedback` deep dive (451 lines, independently traces the same file), and 02's deferral is legitimate, not just a citation of convenience.

## CUT

Two items should be corrected or removed; nothing else in the doc rises to "cut" — it is unusually clean.

1. **False claim about `llmops/judges/*` file layout (§3k).**
   > "`src/eden/llmops/judges/` (1,373 lines across `runner.py`, `registry.py`, `base.py`, and ten judge implementations — `hallucination.py`, `groundedness.py`, `safety.py`, `satisfaction.py`, `correctness.py`, `action_completion.py`, `tool_selection_quality.py`, `relevance.py`, `reasoning_coherence.py`, `tone.py`, plus `unified.py`)."

   **Reason: factually wrong, and stale relative to the doc's own claimed date.** The actual directory (`src/eden/llmops/judges/`) contains 11 files: `__init__.py, _router.py, _sampling.py, base.py, builtin_v9.py, redis_tailer.py, registry.py, runner.py, satisfaction.py, schema.py, unified.py` — summing to 1,373 lines (the doc's total is right, but the breakdown is invented). None of `hallucination.py`, `groundedness.py`, `safety.py`, `correctness.py`, `action_completion.py`, `tool_selection_quality.py`, `relevance.py`, `reasoning_coherence.py`, or `tone.py` exist as files. Those nine axes were **consolidated into a single `UnifiedJudge` class in `unified.py`** (225 lines) that scores all axes in one LLM call — `unified.py`'s own docstring says verbatim: *"Replaces the previous fleet of per-axis judges (hallucination, correctness, tone, groundedness, relevance, safety, action_completion, tool_selection_quality, reasoning_coherence)"* and notes `tone`/`relevance` were "dropped as chat-generic bloat (no longer scored)." `builtin_v9.py` is a 21-line no-op legacy shim explicitly documenting this: *"Cat 3 judges now live in UnifiedJudge... `register_intelligence_judges` is a no-op kept for call-site compatibility."* `git log` shows `unified.py` was last touched 2026-07-16, three weeks before the doc's own "Date: 2026-08-05 (pass 3)" header — this is not a race condition, the doc's claim was simply never checked against the actual directory listing.
   - **Downstream effect on the doc's reasoning**: this doesn't break the P2 recommendation (adapter/extraction work is still needed since `Judge.score(event: TelemetryEvent, ctx: JudgeContext)` is still the real, verified contract at `base.py:110-113`), but "extract one judge's prompt-template logic (e.g. `correctness.py`)" (the doc's own suggested approach) is now moot — there is no `correctness.py` to extract from; the adapter would need to either wrap a `dataset_item` as a fake `TelemetryEvent` for `UnifiedJudge`, or call `UnifiedJudge` and discard 6 of 7 unwanted axes per row. Worth a one-line fix in a future pass, not a rewrite.

2. **Fabricated cross-file consistency claim about `03-prompt-playground.md` (Phase 3 Verdicts section).**
   > "Cross-file consistency note: `03-prompt-playground.md` independently confirms `playground/service.py` imports `run_scorers`/`aggregate_score` from `playground/scorers.py` (3h) for its own manual-testing UI... No conflict with that file's scope; F49's playground usage and F51's automated-eval usage are complementary consumers of the same scorer library."

   **Reason: false — `03-prompt-playground.md` never mentions `scorers.py`, `run_scorers`, `aggregate_score`, `playground/service.py`, or F49 anywhere** (`grep -in "scorer" docs/specs/strategic-review-2026-08/features/03-prompt-playground.md` → zero hits; confirmed by reading the file's actual scope). `03-prompt-playground.md` is about an entirely different subsystem — the **autonomous prompt-evolution/canary/promote loop** (`llmops/promotion.py`, `agents/evolution/components.py`) — a naming collision with the unrelated `playground/` module (F49) this doc discusses. This is exactly the confusion `KNOWN-SUBSYSTEMS.md` already flags: *"F3 (prompt-playground research) was written and completed BEFORE this was discovered and only checked the frontend portal — it incorrectly concluded 'no playground exists.' F3 needs a full redo."* The underlying technical fact this doc wants to support (`playground/service.py` does import `run_scorers`/`aggregate_score` — confirmed independently at `src/eden/playground/service.py:17,383,402,560`) is true; only the citation to `03-prompt-playground.md` "independently confirming" it is fabricated. Fix: cite the direct source (`playground/service.py:17,383,402,560`) instead of a doc that never discusses this, and drop the "no conflict with that file's scope" framing since it implies 03 was read for this and it plainly wasn't (03 has zero content on the topic to conflict or agree with).

## USER EXPERIENCE & VALUE (full draft)

### Who the user is, and where they'd actually touch this today

Eden ships a real, wired frontend for exactly this feature area: `clients/portal/src/app/(portal)/evals/page.tsx` (1,693 lines), a single `/evals` route with three tab
modes — `datasets`, `playground`, `compare` — switched via `EvalsMode`
(`clients/portal/src/lab/evals/evals-chrome.tsx:49-63`). This is not a stub: it
fetches real org data through `useOrgQuery` against `portalApi.evalDatasets`,
`portalApi.evalPlaygrounds`, `portalApi.evalExperiments` (`evals/page.tsx:220-243`),
and the CRUD actions call the real backend — `datasetsApi.create/patch/delete/
addRow/updateRow/deleteRow`, `playgroundApi.create/patch/get/promoteExperiment`,
`offlineExperimentsApi.create/run/compare` (all in `clients/portal/src/lib/api/
resources.ts:3779-4066`, called from `evals/page.tsx:370-1381`). There is also a
narrower `agent-experiments-tab.tsx` surface inside the per-agent view, and a
dedicated `/playgrounds` + `/playgrounds/[id]` route for the standalone editor
experience (`playground-editor.tsx`). Two distinct users show up in this surface:

1. **The person authoring a regression check or dataset** — closer to a data
   scientist / ML-adjacent engineer than an on-call responder. They land on
   `/evals?mode=datasets`, create a dataset (via `datasetsApi.create`), and add
   rows either by hand (`addRow`) or by **promoting a real trace** into a
   dataset row (`datasetsApi.promoteFromTrace`, `evals/page.tsx:1001` — this is
   the "turn a bad production trace into a golden case" flow, and it is wired to
   the real F53 backend, not a fixture).
2. **The person comparing two runs** — lands on `mode=compare`, picks a dataset,
   creates an offline experiment (`offlineExperimentsApi.create` +
   `.run`, `evals/page.tsx:1269-1275`), and is shown a per-case
   improve/regress/tradeoff/tie breakdown via `CompareGradeChip`/`Delta`
   (`clients/portal/src/lab/evals/evals-compare-view.tsx`) — visually, this is a
   real Braintrust/LangSmith-style "did this get better" screen.

### The flow today vs. what it should be — and the gap this pass found that the doc's own recommendation doesn't yet close

Tracing the compare flow end to end surfaces a concrete, previously undocumented
trust problem that sits directly on top of this doc's own P0 recommendation:

- The backend is scrupulously honest about F51 being fake: every response from
  `run()`/`compare()` carries `"synthetic": true, "method": "heuristic_stub"`
  (`offline_runner.py`, confirmed above), and the frontend's own TypeScript API
  client **types these fields explicitly** — `offlineExperimentsApi.run`'s
  return type includes `synthetic?: boolean; method?: string;`
  (`clients/portal/src/lib/api/resources.ts:4045-4046`), and `.compare`'s return
  type repeats the same two fields (`resources.ts:4059-4060`). The plumbing to
  warn the user exists at the type level.
- **But nothing renders it.** `grep -n "synthetic|heuristic" clients/portal/src/
  lab/evals/evals-compare-view.tsx` returns zero hits — the 681-line component
  that renders the improve/regress/tradeoff verdict, the score deltas, and the
  case-by-case grid has no synthetic-data badge, warning banner, or disclaimer
  anywhere in it.
- Worse, tracing exactly where the honesty label gets lost: when the portal runs
  a new experiment, `evals/page.tsx:1269-1287` calls `offlineExperimentsApi.run()`
  (whose response *does* carry `result.synthetic`/`result.method`), then builds
  a `mapped: ExperimentFixture` object to insert into UI state — and that
  literal **never reads `result.synthetic` or `result.method` at all**; it
  hardcodes `avgScores: {}` and drops the run response's grades and honesty
  flags on the floor entirely (`evals/page.tsx:1276-1287`).
- **Net effect for the actual user today**: someone on the "compare two runs"
  persona above who clicks "Run" in the portal gets a confident-looking
  "Treatment is better" / "12 improvements, 3 regressions" screen, with no
  visible indication anywhere in the UI that every score behind that verdict is
  a substring-match heuristic (`expected in input_text`) rather than a real
  model evaluation. This is a materially different, sharper framing than the
  doc's own P0 item 4 ("any customer-facing surface of F51 must keep surfacing
  them [the synthetic labels] — they are currently doing the right thing")
  — verification this pass shows the surface is **not** currently doing the
  right thing; the labels exist in the API contract but die in the frontend's
  data-mapping layer before they ever reach a component. **This should be
  folded into the doc's P0 as an explicit sub-step**: add a `synthetic`/
  `method` badge to `evals-compare-view.tsx` and stop dropping the fields in
  `evals/page.tsx`'s `ExperimentFixture` mapping — small (a few lines, the data
  already round-trips through the API client types), high-value (prevents a
  real user from being silently misled by fabricated numbers), and should ship
  *before or alongside* the real-scoring fix, not after, since it is the
  cheapest possible mitigation while the underlying computation is still fake.

### Why this matters, and what "easy to adopt" looks like from here

The good news this pass reconfirms: eden does not need a new dataset/eval
authoring surface to make this land — the `/evals` page's three-tab structure
(datasets → playground → compare) already maps cleanly onto the
"author a case → sanity-check a prompt → run+compare an experiment" mental model
that Braintrust/LangSmith/Phoenix all converge on externally, and the
promote-trace-to-dataset-row flow (`datasetsApi.promoteFromTrace`) means the
lowest-friction path — "I saw a bad trace, turn it into a regression case" — is
already one click, wired to real data, not a future build. What's missing for
genuine adoption is not new surface area but **making the compare tab trustworthy
before pointing users at it**: once F51's scoring is real (this doc's P0) *and*
the synthetic/real distinction is visibly rendered during the transition (the
gap found this pass), a data scientist or eval-focused engineer has a complete,
already-shipped loop — author dataset → run experiment → read a real diff — that
matches the category's UX bar without inventing anything new.

## NEW FINDINGS (evidence-only)

- **Frontend `/evals` route is real and three-mode-wired, not a stub or a lab-only prototype.** `clients/portal/src/app/(portal)/evals/page.tsx:1-60` imports both `@/lab/fixtures/evals` (naming inherited from an earlier prototype stage) and real resource clients (`datasetsApi`, `offlineExperimentsApi`, `playgroundApi` from `@/lib/api/resources`); `useOrgQuery` calls at `evals/page.tsx:222-243` fetch live org data (`portalApi.evalDatasets/evalPlaygrounds/evalExperiments`), and CRUD actions call real backend endpoints (traced at `resources.ts:3779-4066`). The "lab" directory name is misleading but the wiring is production, confirmed by tracing every `Api.` call site through to a `fetchApi<...>('/orgs/${orgId}/...')` HTTP call.
- **`ExperimentFixture` mapping silently drops F51's `synthetic`/`method` honesty labels before they reach any rendering component.** `resources.ts:4045-4046` and `4059-4060` type the fields on `offlineExperimentsApi.run`/`.compare` responses; `evals/page.tsx:1276-1287`'s literal object construction after a real `.run()` call does not read `result.synthetic` or `result.method` at all. `clients/portal/src/lab/evals/evals-compare-view.tsx` (681 lines, the component that renders the improve/regress verdict and score deltas) has zero references to "synthetic" or "heuristic" anywhere in the file. A user running an offline experiment through the portal today sees a normal-looking pass/fail/tradeoff comparison with no indication the underlying scores are fabricated.
- **`llmops/judges/` directory has already been consolidated from per-axis files into a single `UnifiedJudge` (`unified.py`, 225 lines, last touched 2026-07-16 per `git log`), predating the doc's own claimed pass-3 date by three weeks.** `unified.py`'s docstring (lines 3-5) explicitly states it "Replaces the previous fleet of per-axis judges (hallucination, correctness, tone, groundedness, relevance, safety, action_completion, tool_selection_quality, reasoning_coherence)," and `builtin_v9.py` (21 lines) is a documented no-op legacy shim confirming the same. Any future adapter work described in the doc's P2 item 12 should target `UnifiedJudge.score()` (`unified.py:71`), not a nonexistent `correctness.py`.
- **`03-prompt-playground.md` is about an unrelated subsystem (autonomous prompt-evolution/canary loop, `llmops/promotion.py` + `agents/evolution/components.py`) and contains zero content about `playground/scorers.py`, `playground/service.py`, or F49.** This is the same title collision `KNOWN-SUBSYSTEMS.md` already flags ("F3 needs a full redo" because it "only checked the frontend portal" and predates the F49 discovery). The underlying fact this doc cites it for (`playground/service.py` imports `run_scorers`/`aggregate_score`) is independently true and directly verifiable at `src/eden/playground/service.py:17,383,402,560` — the doc should cite that instead of `03-prompt-playground.md`.
- **`golden_datasets/` also exists as a top-level directory at repo root** (empty, untracked by git, `ls -la` shows 0 files), matching `golden_dataset.py`'s disk-based `DatasetRegistry` default path (`Path("./golden_datasets")`). It has not been populated in this checkout — a minor, not load-bearing confirmation that the disk-based storage path is real and would write there if ever exercised, consistent with (not adding new weight to) the doc's P2 "due-diligence liability" framing for deletion.
