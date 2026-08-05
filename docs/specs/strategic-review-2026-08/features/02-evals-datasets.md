# Feature Review: Evals, Datasets, and the "Rubric-Free Online Eval" Question

Date: 2026-08-05 (pass 3)
Scope: Pass 3 goes deeper on two things the prior two passes established but did
not fully resolve: **(1)** a precise, file:line-grounded consolidation plan across
every dataset/eval subsystem in `src/eden/` — this pass found a **tenth** (an
already-built, Postgres-backed, API-mounted offline-experiment engine the prior
passes missed entirely), and **(2)** what 2026 competitors actually publish about
dataset-versioning/CI-gating mechanics and whether "rubric-free" eval has any real
accuracy evidence behind it, vs. marketing. The rubric-free *positioning* question
(competitive framing vs. Lemma, the shadow-detector wiring gap) is now owned by
`features/16-issue-extraction-online-evals.md` — cross-referenced, not re-derived,
in §4 below.

**VERDICT: RESCOPE (unchanged, now sharper).** Eden does not need a new
golden-dataset/CI-regression product, and does not need a new "rubric-free online
eval" product. What changed this pass: eden already has a **second**,
previously-unnoticed Braintrust-`Eval()`-shaped abstraction — `F51`
(`src/eden/experiments/offline_runner.py` + `experiments/compare.py`) — sitting on
top of the real `datasets`/`dataset_items` schema, with real improvement/
regression/tradeoff/tie diff grading, live at
`/orgs/{org_id}/experiments/offline` (`api/app.py:249`). Every score it produces
is a **self-documented synthetic heuristic stub** (`offline_runner.py:266-288`).
This changes the highest-leverage fix from "build a scorer path into
RegressionRunner" (pass 2's framing) to "make F51's `_run_row` call a real model
and a real scorer" — smaller, better-scoped, and reuses more of what already
exists than pass 2 credited.

## 1. Competitive baseline, deepened: how the mechanics actually work

Pass 2 named seven vendors converging on "online eval." Pass 3 read the
*implementation* writeups (not the marketing pages) for dataset versioning, CI
gating, and scorer libraries, plus found three more vendors shipping the
failure-clustering shape.

**Dataset versioning — three different designs, one shared idea (pin the
version, not the data):**
- **Braintrust**: every insert/update/delete to a dataset is versioned; an
  *experiment* record stores the exact `dataset_version` it ran against
  (`dataset_id` + `dataset_version` fields, settable via the Experiments API),
  so a historical experiment stays reproducible even after the dataset mutates
  later. This is the same shape as eden's `dataset_snapshots` table
  (`src/eden/db_migrations/versions/101_eval_loop.py:56-64`) + F51's
  `dataset_snapshot_id` field (`offline_runner.py:23,37,75-80`) — eden already
  independently arrived at the identical pattern (snapshot-on-run, not
  live-query), it is just fed fake scores today.
  ([braintrust.dev/docs/reference/api/Experiments](https://www.braintrust.dev/docs/reference/api/Experiments), [braintrust.dev/docs/platform/datasets](https://www.braintrust.dev/docs/platform/datasets))
- **Arize Phoenix**: identical insert/update/delete versioning; "experiments
  build on datasets and are versioned — every experiment tracks a dataset
  version." Phoenix ships a documented, literal CI workflow: a GitHub Actions
  job (`AI Search - Correctness Check` in their own example) installs
  `arize-phoenix`, runs a Python experiment script on push to specific paths —
  no bespoke webhook handler, just `run_experiment` invoked from a normal CI
  job. Eden's equivalent (`ci_webhook.py` + `api/routes/github.py`) is a real
  webhook handler with its own history/baseline-resolution logic
  (`CIEvalHistoryStore`) — more custom-built than Phoenix's "just run a script
  in CI" approach, for better or worse (more control, more surface to
  maintain).
  ([arize.com/docs/ax/develop/datasets-and-experiments/ci-cd-for-automated-experiments](https://arize.com/docs/ax/develop/datasets-and-experiments/ci-cd-for-automated-experiments))
- **LangSmith**: dataset examples carry a `split` field (string or array) for
  organizing eval subsets — a lighter-weight mechanism than Braintrust/Phoenix's
  full version-pinning; LangSmith's public docs did not surface an equivalent
  "pin to exact version" API in this pass's research, suggesting it leans more
  on split-based subsetting than snapshot-based reproducibility. Eden has
  neither concept (`dataset_items` has no `split` column) — a real, small,
  low-risk gap if eden wants dataset-defined eval subsets (e.g. "smoke" vs
  "full regression").
  ([docs.langchain.com/langsmith/evaluation-concepts](https://docs.langchain.com/langsmith/evaluation-concepts))

**Failure clustering ("rubric-free" issue discovery) — now confirmed as a
six-vendor convergence, not three:** Braintrust ships **Topics**, a daily
pipeline that needs ≥100 "facet summaries" before clustering activates, scores
every trace by three built-in facets (Issues / Task / Sentiment) plus
user-defined custom facets, renders a scatterplot of trace clusters, and offers
a four-way "turn a confirmed cluster into" action: deterministic scorer,
LLM-judge scorer, eval dataset, or human review queue. Braintrust's own
documentation is explicit that cluster labels are **model-generated and
unverified** — "topic summaries come from model-generated labels" needing
manual trace-level confirmation before use, and warns against acting on
"a three-trace cluster" — i.e. Braintrust Topics has **no automated
promote/demote-by-precision loop**; a human must open sample traces and decide.
LangSmith's Insights feature does clustering "without lifecycle tracking — no
issue states, no frequency-ranked dashboard," and turning an Insight into a
tested eval case is a documented multi-step manual process. Latitude and
Langfuse both lack native automated clustering (Langfuse's documented path is
export-to-dataset → cluster externally → hand-build a judge). **This is a
materially different competitive picture than "Lemma has a moat": every
credible competitor's failure-clustering feature stops at
detection-plus-human-judgment; eden's `soft_issue_review.py` is the only one in
this survey designed to self-promote or self-delete a detector by measured
precision with no required human step** — a real differentiator, contingent
entirely on the wiring fix owned by `13-continuous-improvement-loop.md` and
positioned in `features/16-issue-extraction-online-evals.md`.
([braintrust.dev/articles/discover-hidden-failure-patterns-production-traffic-2026](https://www.braintrust.dev/articles/discover-hidden-failure-patterns-production-traffic-2026), [latitude.so/blog/ai-agent-failure-detection-guide](https://latitude.so/blog/ai-agent-failure-detection-guide))

**Academic grounding for failure-taxonomy discovery**: a 2026 arXiv paper,
*Unsupervised Discovery of Failure Taxonomies from Deployment Logs*
(2506.06570v4), validates a clustering pipeline (LLM-based failure
explanation → taxonomy discovery → trajectory-to-cluster assignment) against
**RoboFail**, an expert-labeled ground-truth taxonomy of 8 failure modes across
100 robot-manipulation videos — i.e. rigorous quantitative validation of this
category *exists* in academia, but none of the commercial vendors surveyed
(including eden) publish an equivalent precision/recall number against
human-labeled ground truth for their own clustering. Eden's
`evaluate_shadow_precision` (cited in `13-continuous-improvement-loop.md` and
`features/16`) is closer to this than any competitor's public claim, once wired.
([arxiv.org/html/2506.06570v4](https://arxiv.org/html/2506.06570v4))

## 2. Is "rubric-free" evaluation actually as accurate as judge-based eval? Evidence check

The task asked directly: is there real evidence, or is this mostly marketing?
**Weak evidence, and what evidence exists points the other way from the
marketing framing** — not "rubric-free judges are as good," but "LLM judges of
any kind, rubric-based or reference-free, are measurably lenient versus human
experts," which is a different and more useful claim for eden's positioning.

- **Quantified leniency vs. human experts**: a merchant-risk-assessment study
  (arXiv 2602.05110) found LLM judges score **0.46 points higher on average**
  than the consensus of 26 payment-industry domain experts, across 23 of 25
  evaluation pairs, and the bias **persists under anonymization** (+0.43 with
  model identity concealed vs. +0.46 disclosed) — i.e. it is not a
  self-preference artifact, it is a general leniency disposition.
  ([arxiv.org/pdf/2602.05110](https://arxiv.org/pdf/2602.05110))
- **Leniency is formalized, not anecdotal**: *Judging the Judges* (arXiv
  2406.12624) defines "leniency bias" as `P+` — the probability a judge marks
  a response "correct" even when its own stated evaluation criteria are not
  met — and finds `P+ ≫ 0.5` for most models tested.
  ([arxiv.org/pdf/2406.12624](https://arxiv.org/pdf/2406.12624))
- **The bias is implicit and CoT-invisible**: *Context Over Content: Exposing
  Evaluation Faking in Automated Judges* (arXiv 2604.15224) ran 18,240
  controlled judgments and found leniency bias in all three judges tested
  (mean shift −2.2 to −3.5 pp, peaking at −9.8 pp), and — the sharper finding —
  **chain-of-thought inspection cannot detect it**; the bias is not visible in
  the judge's own stated reasoning, which undercuts the common mitigation of
  "read the judge's rationale to sanity-check it."
  ([arxiv.org/html/2604.15224](https://arxiv.org/pdf/2604.15224))
- **Reference-free specifically scores higher than reference-based on the same
  outputs**: a 2026 tool-calling-agent evaluation study (surfaced via search
  synthesis, arXiv 2605.15104's literature context; full-text extraction of the
  primary comparison numbers was not obtainable in this pass — flagged as
  **unverified at the primary-source level**, included because it is directly
  on-topic and internally consistent with the leniency-bias literature above)
  reportedly found reference-free judge scores were **systematically and
  significantly higher** (p < 0.001) than reference-aware scores for the same
  outputs, suggesting judges penalize minor deviations from a gold label even
  when the output is functionally correct — i.e. reference-free judging may
  read as "the agent is doing great" partly *because* it has nothing to
  penalize against, not because it is more accurate.
- **Honest framing from the tooling vendors themselves**: LangSmith's own docs
  frame reference-free evaluators as suited to *subjective* qualities
  (clarity, tone, helpfulness) and reference-based evaluators as needed for
  *precise correctness* checks — i.e. even the vendors selling "rubric-free"
  do not claim it substitutes for reference-based grading on factual
  correctness, only that it is useful for a different, softer class of
  question. Braintrust Topics' own docs (§1 above) require a human to confirm
  every cluster before it becomes a scorer — an implicit admission that
  unsupervised clustering alone is not trustworthy at production stakes.

**Conclusion for eden's positioning**: "rubric-free" is not proven equally
accurate to judge-based eval on correctness-type questions — the literature
suggests the opposite for that narrow claim. What eden's mechanism
(`soft_issue_review.py`, detailed in `features/16`) is actually good for, and
should be marketed as, is exactly what the literature and every competitor
converge on: **discovering failure shapes nobody wrote a check for yet**, not
replacing graded correctness checking. Eden's `evaluate_shadow_precision`
(operator-agreement-gated promote/delete) is closer to a real accuracy
guarantee than any competitor's public clustering feature, but it should not be
marketed as "as accurate as a judge" — it should be marketed as "the only
production-wired auto-promote/auto-delete loop in the category," a narrower and
more defensible claim.

## 3. What eden already has: ten subsystems, precisely mapped

Six subsystems were identified in pass 2. This pass reads all ten fully
(including two missed entirely) and traces exact schema/API-mount evidence for
each, to support a real migration plan rather than a "these should merge"
gesture.

### 3a. RegressionRunner / RegressionCaseBuilder (N01) — real, CI-gated, schema-isolated
`src/eden/evaluation/regression_runner.py`, `regression_builder.py`. Deeper
detail this pass:
- `RegressionCase.dataset_id` (`regression_builder.py:20`) is a **free-text
  name string** like `"agent-name/regressions"`
  (`_dataset_name`, `regression_builder.py:307-311`), stored in
  `regression_eval_cases.dataset_id VARCHAR(128) NOT NULL DEFAULT
  'agent-regressions'` (`db_migrations/versions/092_market_ready_consolidated.py:355-367`).
  F53's `datasets.id` is a `UUID` (`101_eval_loop.py:17-31`). **These two
  "dataset_id" columns cannot be joined even if someone tried** — this is a
  schema-level fact, not just "no shared code," and it is the concrete reason
  §5's unification plan requires a migration step, not a config flag.
- `_evaluate_case` (`regression_runner.py:182-243`) is genuinely more
  sophisticated than pass 2 credited: when `regression_replay_v1` is enabled
  (`_replay_enabled`, L247-255) and the case carries a stored
  `FailureSignature` + checkpoint reference (`_replay_ref`, L257-280), it
  **replays the original failing step against current behavior**
  (`_run_replay`, L296-340, cost-capped via `_replay_caps`, L282-294) before
  falling back to the post-hoc stumble-signature check. This is real,
  budget-capped verification infrastructure — but `ReplayResult`
  (`src/eden/improvement/replay_verify.py:275-281`) returns only
  `status: "passed"|"failed"|"skipped"` + `reason` + `cost_usd` +
  `traces_checked` — **no raw regenerated output text**. This matters for §5:
  the replay path cannot feed `playground/scorers.py`'s `run_scorers(output=...)`
  without first extending `ReplayResult` to surface the actual replayed text,
  which it does not do today.
- `ci_webhook.py:16,59-62` already imports and reuses `grade_datapoint` from
  `eden.experiments.compare` — the *same* grading function that powers F51
  (§3i below) — to grade **aggregate** pass/fail/skip/error-rate deltas
  against a baseline run (`build_score_table`, `ci_webhook.py:73-81`). This is
  a real, working, undocumented bridge between 3a and 3i today — but only at
  the suite-summary level, never per-case. §5 turns this into a per-case
  bridge instead of inventing a new one.

### 3b. Dataset Hub (F53) — real, versioned, Postgres-backed
`src/eden/datasets/hub.py`, mounted at `/orgs/{org_id}/datasets`
(`api/app.py:247`). `dataset_items` (`101_eval_loop.py:37-49`) already has an
`expected_output TEXT` column, populated (empty string) on trace-promotion
(`hub.py:267-278`) — i.e. **the exact field pass 2's recommendation #6 proposed
adding to `RegressionCase` already exists in the table that should become
canonical.** This pass also found a documented, already-fixed cross-tenant
security bug in `hub.py:358-395` (`_trace_payload`): `promote_trace` originally
queried `telemetry_events` by `trace_id` alone, letting org A promote org B's
trace content into org A's dataset by guessing/naming B's `trace_id` (HTTP 200,
no error, up to 100 KB of B's prompt/completion text copied). The fix threads
`tenant_id` into the query (L381). Included here as evidence F53 has received
real production security scrutiny — a datapoint in favor of building on it as
the canonical store rather than a from-scratch dataset abstraction.

### 3c. `insights/dataset_engine.py` — in-memory, well-designed taxonomy, non-durable
`DatasetGenerationEngine` (class at `dataset_engine.py:137`), wired live via
`InsightsService` → `api/routes/insights.py` (`api/app.py:284`). Confirmed
verbatim: `self._datasets: dict[str, Dataset] = {}` at `dataset_engine.py:207`
(constructor `__init__`, L204), populated by `_store_entry` (L364-381) — every
generated dataset is lost on process restart despite being API-reachable.

### 3d. `golden_dataset.py` — 1,295 lines, hardcoded, disk-based, non-multitenant
`DatasetRegistry` (class at `golden_dataset.py:194`, disk path
`./golden_datasets/*.json`, L209) holds 50 hand-written `GoldenCase` entries
(`_CANONICAL_CASES`, L301-1258, across `agent_sandbox` / `llm_agent_eval` /
`tool_use` / `multi_agent` / `adversarial` / `simulation`) loaded via
`load_canonical_datasets()` (L1261-1296). None reference any customer agent,
trace, or org.

### 3e. `CIPipeline` — dead, duplicate, and scoped wider than "eval"
`src/eden/evaluation/ci_pipeline.py` — a 6-stage pipeline (`StageName`,
L57-65: `static_analysis`, `unit_tests`, `integration_tests`,
`benchmark_regression`, `performance_tests`, `security_scan`) that shells out
via `subprocess` (imported L15) for static analysis/test stages — i.e. it is
not even scoped to "eval," it is a parallel, dead CI orchestrator. Its
`benchmark_regression` stage imports `golden_dataset.py`'s `DatasetRegistry` /
`load_canonical_datasets` directly (`ci_pipeline.py:23`) and — per pass 2's
finding, reconfirmed — defaults to `SKIPPED: execution_unavailable` with an
opt-in `simulated: True` fallback via `random.Random(case_id)`. Not mounted to
any route; referenced only by its own unit test.

### 3f. `auto_dataset.py` / `EvalScheduler` — promotion loop that never runs
`TraceQualityScorer.score` (`auto_dataset.py:88-153`) computes a real
multi-factor composite (correctness 0.40 / robustness 0.25 / efficiency 0.15 /
diversity 0.20 weights, L81-86) — reasonably designed math — but
`AutoDatasetPromoter` (L213 on) persists results to
`./.eden/auto_datasets/*.json` (`_persist_state`, L437-440) and writes into
`golden_dataset.py`'s in-memory `DatasetRegistry` (3d), not Postgres.
`evaluation/scheduler.py`'s `EvalScheduler` is the only thing that would ever
call this on a schedule, and it is absent from both `workers/main.py` and
`workers/cron_tick.py` — confirmed by grep, unchanged from pass 2.

### 3g. `eval_intel/versioning.py`'s `EvalVersioner`/`EvalRegistry` — a fourth "regression" concept
Binds judge scores to a deployment SHA + prompt version, fires
`PromotionHook.on_judge_regression` on a 7-day rolling-mean regression. Live
via `intelligence_eval.py` routes. Functionally sound but yet another parallel
regression-detection algorithm (rolling mean, not diff-grading or
percentile-comparison — see 3j).

### 3h. `playground/scorers.py` (F49) — the real scorer library, wired to the wrong feature
`SCORERS` registry (`scorers.py:121-128`): `exact_match`, `contains`,
`icontains`, `regex`, `json_valid`, `levenshtein_ratio`. `run_scorers`
(L131-166) and `aggregate_score` (L169-178) both operate on plain
`(output: str, expected: str | None)` — **the exact shape of
`dataset_items.input`/`expected_output`, both `TEXT` columns**
(`101_eval_loop.py:38-39`) — meaning no data-shape adapter is needed to wire
this into F51 (3i) or F53; it is a drop-in call. Docstring L5-7: `llm_judge` is
"deliberately absent" because "a fake judge is worse than none" — see 3k below
for why this framing undersold what eden already has elsewhere.

### 3i. `experiments/offline_runner.py` (F51) — **new this pass**: a second, more complete `Eval()` abstraction, entirely missed by pass 2
`OfflineExperimentRunner` (class at `offline_runner.py:47`), mounted live at
`/orgs/{org_id}/experiments/offline` (`api/app.py:249`, routes in
`api/routes/experiments_offline.py`), backed by `offline_experiments` +
`experiment_datapoints` (`101_eval_loop.py:66-96`, created in the *same*
migration as `datasets`/`dataset_items`). This is materially different from
3a-3h:
- `create()` (L63-124) snapshots the dataset via `DatasetHub.create_snapshot`
  (L77-80) — correctly reuses F53, unlike 3a.
- `run()` (L126-207) reads real `dataset_items` rows (`dataset_id` is a proper
  `UUID` FK here, L152 — unlike 3a's string field) and for each row computes a
  `control` and `treatment` dict, grades them via `grade_datapoint` from
  `experiments/compare.py` (L164, imported L12), and persists per-row
  `control_output`/`treatment_output`/`grade`/`score_delta` to
  `experiment_datapoints` (L166-181).
- `compare()` (L209-249) returns the full per-row diff plus an
  `aggregate_grades` summary (`improvement`/`regression`/`tradeoff`/`tie`
  counts) against an optional `baseline_experiment_id`.
- **The catch, verified directly**: `control` is hardcoded
  `{"score": 0.5, "output": item.expected_output or "", "synthetic": True,
  "method": "heuristic_stub"}` (L157-162), and `_run_row` (L266-288) — the
  "treatment" — computes `score = 0.9 if expected in input_text else (0.7 if
  expected else 0.5)`: a **substring-match heuristic**, not a real model call.
  There is no LLM/agent invocation anywhere in this file. Both control and
  treatment are labeled `synthetic: True` / `method: heuristic_stub` end to
  end and the API responses propagate those flags (`compare()` L246-247,
  `run()` L195-196) — this is self-aware, honest fake data, not a hidden bug,
  but it means **every experiment run through this live, API-mounted feature
  today produces a numerically meaningless diff.**
- `experiments/compare.py`'s `grade_datapoint` (L10-28) and `aggregate_grades`
  (L31-36) are, independent of the fake inputs, real and reusable:
  tie-threshold 0.01, cost-aware tradeoff detection (`t_cost > c_cost * 1.2`),
  four-way verdict. This is the same function `ci_webhook.py` already reuses
  (3a) — confirming it is eden's one actually-shared grading primitive across
  two otherwise-disconnected subsystems.

### 3j. `experiment_intel/auto_eval.py` ("Cat 12") — a third regime, online A/B judge comparison, correctly out of scope for this consolidation
`AutoEvaluator.evaluate` (`auto_eval.py:70-197`) reads **real** `judge_scores`
rows (not synthetic) joined to `telemetry_events` by
`attributes->>'experiment_id'`/`attributes->>'variant'` (`_fetch_variant_scores`,
L255-305) — i.e. it compares two live canary/A-B traffic splits by judge-score
median/p5/p95, not by replaying a dataset. This is a genuinely different data
regime (online, real judge scores, real traffic) from 3a/3i (offline, dataset
rows). It should **not** be merged into the dataset/regression consolidation —
but it is the third distinct "is this a regression" algorithm in the codebase
(percentile-diff here, `grade_datapoint`'s tie/improvement/regression/tradeoff
in 3a/3i, 7-day rolling mean in 3g), and no shared vocabulary exists across the
three. Lower priority than the dataset-side consolidation, flagged for future
cleanup only.

### 3k. `llmops/judges/*` — the LLM-judge substrate eden already has, mis-cited by pass 2's fix (and mis-described by pass 3 — corrected this pass)
Pass 2 recommended reusing `prompt_versioning._llm_score`'s "LLM-call infra" to
add the judge `playground/scorers.py` deliberately omits. This pass found that
undersells eden's actual judge infrastructure: `src/eden/llmops/judges/`
(1,373 lines total). Pass 3's breakdown of that total was wrong: the directory
holds 11 files — `__init__.py`, `_router.py`, `_sampling.py`, `base.py`,
`builtin_v9.py`, `redis_tailer.py`, `registry.py`, `runner.py`,
`satisfaction.py`, `schema.py`, `unified.py` — not a "ten judge
implementations" fleet of per-axis files. Those per-axis files
(`hallucination.py`, `correctness.py`, `tone.py`, etc.) do not exist; they
were consolidated into a single `UnifiedJudge` class in `unified.py` (225
lines) that scores every axis in one LLM call. `unified.py`'s own docstring
says verbatim it "replaces the previous fleet of per-axis judges
(hallucination, correctness, tone, groundedness, relevance, safety,
action_completion, tool_selection_quality, reasoning_coherence)"; `tone` and
`relevance` were dropped outright as "chat-generic bloat" and are no longer
scored. `builtin_v9.py` is a 21-line no-op legacy shim kept only for
call-site compatibility. `JudgeRunner.run_for_event` (`runner.py:51-102`)
fans out judges concurrently with a per-tenant semaphore and persists to
`judge_scores` (`_persist`, L104-150, cost/cached tracking included) — this is
production-grade, and it is what actually powers `_detect_hallucination` in
`auto_scanner.py` (per pass 2's finding) and Cat 12 (3j above). **The real
integration cost, found this pass**: `Judge.score(event: TelemetryEvent, ctx:
JudgeContext)` (`base.py:109-119`) is contractually bound to a
`TelemetryEvent`, not a generic `(input, output, expected)` triple. Reusing
this for dataset-row scoring in F51/F49 is not a one-line import — it needs
either (a) a small adapter that wraps a `dataset_item` row in a
`TelemetryEvent`-shaped object, or (b) calling `UnifiedJudge.score()` directly
and discarding the axes F51/F49 don't need per row (there is no single-axis
judge left to extract cleanly, so pass 2's "extract one judge's prompt
template" framing no longer applies). Either is a half-day-to-day task, not a
new build — but it is real work pass 2's phrasing ("reuse ... infra") glossed
over.

### 3l. `prompt_versioning.run_auto_eval` — unchanged from pass 2, confirmed
`src/eden/services/prompt_versioning.py:378-444` accepts and stores
`dataset_id` on a `prompt_eval_runs` row but never reads it back inside the
function; `_llm_score` (L447-476) scores the prompt *template text* for
clarity/specificity, not any dataset output. Confirmed unchanged.

## 4. The online, rubric-free path — see `features/16-issue-extraction-online-evals.md`

`src/eden/services/soft_issue_review.py`'s novelty-scout → shadow-detector →
precision-gated promote/delete loop (§3 in pass 2's draft) is eden's real
analog to Lemma's "Issue Extraction," `auto_scanner.py`'s deterministic
detectors are the L0/L1 layer, and the wiring gap (`record_shadow_feedback` has
zero callers) is the single blocker to shipping this as a competitive claim.
**This mechanism, its Lemma/LangSmith-Engine/Galileo-Insights competitive
framing, and its detailed positioning are now owned by
`features/16-issue-extraction-online-evals.md`** — not re-derived here. What
this file adds on top (§1-§2 above) is the wider competitive evidence that six
vendors, not three, now ship some form of this, and that most of them
(Braintrust Topics, LangSmith Insights) explicitly require a human
confirmation step eden's mechanism is designed to skip — reinforcing, from a
different angle, why `13-continuous-improvement-loop.md`'s wiring fix is worth
prioritizing.

## 5. Consolidation plan: canonical system, migration steps, deletions

**Canonical system: F53 (`datasets`/`dataset_items`/`dataset_snapshots`, 3b)
for storage + F51 (`offline_experiments`/`experiment_datapoints`, 3i) for
execution and grading.** These two are already schema-compatible with each
other (3i correctly uses F53's UUID `dataset_id`), already both live and
API-mounted, and already produce a real diff-grading vocabulary
(`grade_datapoint`'s improvement/regression/tradeoff/tie) that a third
subsystem (`ci_webhook.py`, 3a) already independently reuses at the aggregate
level. This is a materially different (smaller, more concrete) claim than pass
2's "unify on the F53 dataset abstraction" — the execution/grading layer to
unify onto also already exists.

**P0 — fix F51's fake scoring (highest leverage, smallest scope):**
1. Replace `offline_runner.py:266-288`'s `_run_row` substring heuristic with a
   real call: the row's `input`/`payload` against the `config`'s
   model/prompt reference (the `config` dict already carries a `model` field,
   L277 — the plumbing exists, only the call is missing).
2. Replace the hardcoded `control` dict (L157-162) with either a stored
   baseline output (if `dataset_items` gains a `baseline_output` column) or a
   second real run against `baseline_experiment_id`'s config.
3. Score both via `playground/scorers.py:131` `run_scorers(specs, output=...,
   expected=item["expected_output"])` (3h) — no adapter needed, string-in/
   string-out shapes already match. Feed the aggregate via `aggregate_score`
   (L169-178) as the `score` key `grade_datapoint` already expects.
4. Remove the `synthetic: True` labels once real scoring lands; until then,
   any customer-facing surface of F51 must keep surfacing them (they are
   currently doing the right thing — do not remove the honesty labels before
   fixing the underlying computation).

**P1 — migrate 3a (RegressionRunner/Builder) onto the canonical system:**
5. Change `RegressionCaseBuilder._persist` (`regression_builder.py:267-290`)
   to insert into `dataset_items` (with a proper UUID `dataset_id` resolved
   via `DatasetHub.get_dataset`/`create_dataset`, not the current free-text
   `_dataset_name` string) instead of `regression_eval_cases`. Keep the
   fingerprint-based dedup logic (`_find_by_fingerprint`,
   `regression_builder.py:188-209`) — it is sound, just needs to query
   `dataset_items` instead.
6. Keep `RegressionRunner`'s existing stumble-signature/StatGate check
   (`_evaluate_case`, `regression_runner.py:182-243`) as-is for the canary-gate
   path — it is cheap (no LLM call) and real-trace-grounded, which is exactly
   right for a `>5% canary traffic` blocking gate (`require_pass_for_canary`,
   L150-180). Do **not** replace it with F51's scored path; add F51 alongside
   it.
7. Have `run_suite` additionally kick off (or reuse an existing) F51 run
   against the same org/agent's now-unified dataset, and surface its
   `grade_datapoint` verdicts in `ci_webhook.py`'s `score_table`
   (`build_score_table`, `ci_webhook.py:73-81`) **per case**, not just at the
   aggregate pass/fail-rate level it already computes today (L59-62). This
   turns an existing, working, but aggregate-only bridge into the full
   Braintrust-style per-row diff eden is missing, without inventing new
   plumbing.
8. `ReplayResult` (`improvement/replay_verify.py:275-281`) needs a
   `regenerated_output: str | None` field before the replay path (3a) can
   participate in step 7's scoring — currently it only returns a pass/fail
   verdict, not the text needed for `run_scorers`. Small, real addition;
   sequence after step 5-7 land since it is additive.

**P1 — migrate 3c (`dataset_engine.py`) onto F53:**
9. Replace `DatasetGenerationEngine._store_entry`'s
   `self._datasets: dict[...] = {}` (`dataset_engine.py:207, 364-381`) with
   calls into `DatasetHub.create_dataset`/`promote_trace`
   (`hub.py:124-167, 232-283`) so `InsightsService`-detected patterns persist
   past a process restart. The rule-based taxonomy (`DatasetRule.matches`,
   L61) does not need to change — only the storage backend.

**P2 — delete (due-diligence liability, not neutral dead weight):**
10. `golden_dataset.py` (1,295 lines, 3d), `ci_pipeline.py` (3e — duplicates
    `ci_webhook.py`'s live path with a fake benchmark stage), `auto_dataset.py`
    + `EvalScheduler` (3f, 475 + scheduler lines). If the 50 generic
    RL-sandbox cases in `golden_dataset.py` have standalone value as a smoke
    test, port `_CANONICAL_CASES` (L301-1258) into a handful of seed
    `dataset_items` rows via a one-time script, then delete the module —
    do not keep the disk-based registry alive as a second storage path.

**P2 — smaller fixes:**
11. `prompt_versioning.run_auto_eval` (3l): either fetch `dataset_id`'s items
    and run them through the now-fixed F51 path, or rename the function/columns
    to reflect it is prompt-text linting, not a dataset eval.
12. Judge scoring (3k): when adding an LLM-judge option to F49/F51's scorer
    path, build the small adapter/extraction described in 3k rather than
    reusing `prompt_versioning._llm_score` — reuses more real infrastructure
    (`JudgeRunner`'s concurrency/cost-tracking/persistence) for a comparable
    amount of new code.

**Explicitly not consolidated:** Cat 12 (3j, online A/B judge comparison) and
`eval_intel/versioning.py` (3g, prompt-version rolling-mean regression) stay
separate — different data regimes, forcing them into F51's shape would be
premature abstraction. Flagged for a future pass only if a fourth online
regression concept appears.

**Revised effort estimate**: P0 (F51 real scoring) is now assessed as
**small-to-medium** (a few days) — the storage, API routes, grading math, and
even the "control vs. treatment" data model are 100% built; only the two model
calls and one scorer call are missing. P1 (migrate 3a and 3c onto the
canonical system) is **medium** (schema migration + dual-write period +
`ReplayResult` extension). P2 (deletions) is **small** and should not be
deprioritized — every week `golden_dataset.py`/`ci_pipeline.py` remain in the
tree is a week a due-diligence reviewer can mistake dead code for
functionality. Total revised estimate: **2-3 weeks** for P0+P1, well under
pass 2's implicit framing of this as open-ended "unify six systems" work,
because two of what looked like six separate builds (F53 and F51) turn out to
already be one coherent, working design that only needs its inputs fixed.

## 6. User Experience & Value

### Who the user is, and where they touch this today

Eden ships a real, wired frontend for this feature area:
`clients/portal/src/app/(portal)/evals/page.tsx` (1,693 lines), a single
`/evals` route with three tab modes — `datasets`, `playground`, `compare` —
switched via `EvalsMode` (`clients/portal/src/lab/evals/evals-chrome.tsx:49-63`).
This is not a stub: `useOrgQuery` calls fetch live org data through
`portalApi.evalDatasets`/`evalPlaygrounds`/`evalExperiments`
(`evals/page.tsx:220-243`), and CRUD actions hit the real backend —
`datasetsApi.create/patch/delete/addRow/updateRow/deleteRow`,
`playgroundApi.create/patch/get/promoteExperiment`,
`offlineExperimentsApi.create/run/compare` (`clients/portal/src/lib/api/
resources.ts:3779-4066`, called from `evals/page.tsx:370-1381`). A narrower
`agent-experiments-tab.tsx` surface also exists inside the per-agent view,
plus a standalone `/playgrounds` + `/playgrounds/[id]` editor route.

Two personas show up in this surface, not one:
1. **The dataset/regression-case author** — a data-scientist-adjacent
   engineer, not an on-call responder. Lands on `/evals?mode=datasets`,
   creates a dataset (`datasetsApi.create`), and adds rows by hand (`addRow`)
   or by **promoting a real production trace into a dataset row**
   (`datasetsApi.promoteFromTrace`, `evals/page.tsx:1001`) — a real,
   F53-backed "turn a bad trace into a golden case" flow, not a fixture.
2. **The run-comparer** — lands on `mode=compare`, picks a dataset, creates
   an offline experiment (`offlineExperimentsApi.create` + `.run`,
   `evals/page.tsx:1269-1275`), and sees a per-case improve/regress/
   tradeoff/tie breakdown via `CompareGradeChip`/`Delta`
   (`clients/portal/src/lab/evals/evals-compare-view.tsx`) — visually a real
   Braintrust/LangSmith-style "did this get better" screen.

### The value, and a trust gap on top of §5's P0

The lowest-friction path in the category — "I saw a bad trace, turn it into a
regression case" — is already one click and wired to real data
(`promoteFromTrace`), and the three-tab structure (author → sanity-check →
compare) already maps onto the mental model every competitor in §1 converges
on externally. That is genuine, shipped value; eden does not need new surface
area to make this land.

But tracing the compare flow end to end surfaces a concrete, previously
undocumented trust problem sitting directly on top of this doc's own P0:
- The backend is honest about F51 being fake — every `run()`/`compare()`
  response carries `synthetic: true, method: "heuristic_stub"` (§3i), and the
  frontend's TypeScript client even types these fields explicitly
  (`offlineExperimentsApi.run`'s return type includes `synthetic?: boolean;
  method?: string;` at `resources.ts:4045-4046`, repeated for `.compare` at
  `4059-4060`).
- **Nothing renders it.** `evals-compare-view.tsx` (681 lines, the component
  that renders the improve/regress/tradeoff verdict and score deltas) has
  zero references to "synthetic" or "heuristic" anywhere in the file.
- The honesty label is lost in between: after `offlineExperimentsApi.run()`
  returns (with `result.synthetic`/`result.method` populated),
  `evals/page.tsx:1269-1287` builds a `mapped: ExperimentFixture` object for
  UI state that never reads `result.synthetic` or `result.method` — it
  hardcodes `avgScores: {}` and drops the run's grades and honesty flags on
  the floor.
- **Net effect**: a user on the run-comparer persona who clicks "Run" gets a
  confident-looking "Treatment is better, 12 improvements / 3 regressions"
  screen with no visible indication that every score behind it is a
  substring-match heuristic, not a model evaluation. This sharpens §5's P0
  item 4 ("any customer-facing surface of F51 must keep surfacing the
  synthetic labels") — the surface is not currently doing that; the labels
  exist in the API contract but die in the frontend's data-mapping layer
  before reaching a component.

### What would make it more usable/adoptable

- **Fold the badge fix into P0, ship it first.** Add a `synthetic`/`method`
  badge to `evals-compare-view.tsx` and stop dropping the fields in
  `evals/page.tsx`'s `ExperimentFixture` mapping. This is a few lines — the
  data already round-trips through the API client's own types — and should
  land before or alongside the real-scoring fix, since it is the cheapest
  possible mitigation while the underlying computation is still fake.
- **Close the loop once scoring is real.** Once F51 produces real scores (P0)
  and the synthetic/real distinction is visibly rendered during the
  transition, the existing "author dataset → run experiment → read a real
  diff" loop is complete and needs no further UI investment to match the
  category's UX bar.
- **Reduce entry-point ambiguity.** `/evals`'s `playground` mode and the
  standalone `/playgrounds` + `/playgrounds/[id]` route both front
  `playgroundApi`, giving a new user two different starting points for
  overlapping functionality; worth confirming there is one canonical link
  path (e.g. from an agent's detail view) so users don't land on the
  redundant one.

## Sources
- [Braintrust — Experiments API reference](https://www.braintrust.dev/docs/reference/api/Experiments)
- [Braintrust — Datasets docs](https://www.braintrust.dev/docs/platform/datasets)
- [Braintrust — Discover hidden failure patterns in production traffic (2026)](https://www.braintrust.dev/articles/discover-hidden-failure-patterns-production-traffic-2026)
- [Arize — CI/CD for automated experiments](https://arize.com/docs/ax/develop/datasets-and-experiments/ci-cd-for-automated-experiments)
- [LangChain — Evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts)
- [Latitude — AI agent failure detection guide](https://latitude.so/blog/ai-agent-failure-detection-guide)
- [arXiv 2506.06570v4 — Unsupervised Discovery of Failure Taxonomies from Deployment Logs](https://arxiv.org/html/2506.06570v4)
- [arXiv 2602.05110 — Understanding LLM Evaluator Behavior (merchant risk assessment)](https://arxiv.org/pdf/2602.05110)
- [arXiv 2406.12624 — Judging the Judges: Evaluating Alignment and Vulnerabilities in LLMs-as-Judges](https://arxiv.org/pdf/2406.12624)
- [arXiv 2604.15224 — Context Over Content: Exposing Evaluation Faking in Automated Judges](https://arxiv.org/pdf/2604.15224)
- [arXiv 2506.22316 — Evaluating Scoring Bias in LLM-as-a-Judge](https://arxiv.org/abs/2506.22316)
- [arXiv 2605.15104 — From Text to Voice: A Reproducible and Verifiable Framework for Evaluating Tool Calling LLM Agents](https://arxiv.org/abs/2605.15104)
- Pass 1/2 sources (Braintrust, LangSmith, promptfoo, OpenAI Evals, Arize Phoenix, Galileo, Lemma competitive baseline) carried forward — see `features/16-issue-extraction-online-evals.md` for the Lemma-specific citations.

## Phase 3 Verdicts (this pass)

- **F51's fake scoring is the highest-leverage single fix in this file** —
  VERDICT: KEEP, raised priority to P0 (new this pass). Higher leverage than
  pass 2's "wire scorers.py into RegressionRunner" because F51's storage,
  API surface, and grading math are already built and already reused elsewhere
  (`ci_webhook.py`); RegressionRunner's storage is schema-incompatible with
  F53 and must be migrated first before it can share a scorer path.
- **Unify on F53 + F51 as the canonical system** — VERDICT: KEEP (high
  confidence, upgraded from pass 2's "unify on F53" alone). Verified F51
  already correctly uses F53's UUID dataset_id where 3a does not
  (`offline_runner.py:152` vs `regression_builder.py:20,307-311` vs
  `092_market_ready_consolidated.py:355-367`).
  - Confirmed directly, not via cross-file citation: `playground/service.py`
    imports and calls `run_scorers`/`aggregate_score` from
    `playground/scorers.py` (3h) for its own manual-testing UI
    (`playground/service.py:17,383,402,560`) — the same functions this file
    recommends wiring into F51's `_run_row`. (An earlier pass cited
    `03-prompt-playground.md` as independently confirming this; that citation
    was wrong — `03-prompt-playground.md` covers an unrelated subsystem, the
    autonomous prompt-evolution/canary loop, and contains no content on
    scorers or F49. The underlying fact holds, it just needed the direct
    source instead.) F49's playground usage and F51's automated-eval usage
    are complementary consumers of the same scorer library.
- **Delete `golden_dataset.py`/`ci_pipeline.py`/`auto_dataset.py`+`EvalScheduler`**
  — VERDICT: KEEP (high confidence, unchanged from pass 2, re-verified with
  exact line ranges this pass).
- **Make `dataset_engine.py` durable via `DatasetHub`, not a new store** —
  VERDICT: KEEP (high confidence, sharpened: reuse F53's existing
  `create_dataset`/`promote_trace` rather than building new Postgres tables).
- **Add LLM-judge scoring** — VERDICT: KEEP-WITH-CAVEAT, revised: reuse
  `llmops/judges/*` (3k) via a small `TelemetryEvent` adapter, or by calling
  `UnifiedJudge.score()` directly and discarding unneeded axes — not
  `prompt_versioning._llm_score` as pass 2 suggested — that function is a
  prompt-text linter (3l), not a case-scoring judge, and reusing it would
  replicate architecture eden already solved better elsewhere.
- **Reposition eden's rubric-free mechanism competitively** — VERDICT: KEEP,
  now with materially stronger evidence (six-vendor convergence, not three;
  most competitors require manual cluster confirmation eden's design is meant
  to skip) but a **more careful accuracy claim**: market eden's mechanism as
  "the only auto-promote/auto-delete-by-precision loop in the category," not
  as "as accurate as a judge" — the literature on reference-free/rubric-free
  judging (§2) shows real, quantified leniency bias versus human experts, and
  eden should not adopt marketing language its own competitive research
  contradicts. Full positioning owned by `features/16-issue-extraction-online-evals.md`.
