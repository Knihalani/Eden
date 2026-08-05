# Pass 4 review notes — `features/03-prompt-playground.md`

**Reviewer:** sole reviewer, pass 4 (final)
**Verdict up front:** The on-disk doc is internally accurate about the subsystem
it actually covers (the autonomous prompt-evolution loop:
`agents/evolution/`, `llmops/promotion.py`, `agents/prompt_canary.py`,
`promotion/evidence_gate.py`). But it is titled "03 — Prompt Playground" and
**still contains zero references to `src/eden/playground/`** —
`service.py`, `scorers.py`, `diff.py`, `llm_handler.py`, `span_seed.py` are
not mentioned once (`grep -n "eden/playground\|scorers.py\|diff.py\|llm_handler.py\|span_seed.py\|PlaygroundService" features/03-prompt-playground.md` → 0 hits). This is
exactly the gap `KNOWN-SUBSYSTEMS.md` flags: *"F3 (prompt-playground
research) was written and completed BEFORE this was discovered and only
checked the frontend portal — it incorrectly concluded 'no playground
exists.' F3 needs a full redo."* **That redo has not happened.** Three prior
passes have deepened the evolution-loop trace but never pivoted to cover the
feature the doc is named after. This is the headline finding for pass 4 —
see NEW FINDINGS.

---

## VERIFIED

### A. The doc's actual content (autonomous prompt evolution) — re-verified, still accurate

Spot-checked the doc's most load-bearing claims against current `main`
source; all hold exactly as written, no drift since pass 3:

- Config defaults/line numbers all match current `src/eden/config.py`:
  `evolver_auto_canary_pct=5` (line 655), `evolver_max_variants_per_run=3`
  (681), `evolver_min_samples=20` (685), `evolver_degradation_threshold=0.7`
  (689), `evolution_loop_enabled=False` (692), `evolution_loop_interval_seconds=300`
  (693), `promotion_min_calls=30` (698), `promotion_max_judge_regression=0.05`
  (701), `promotion_confidence_band=0.02` (702), `promotion_lookback_minutes=60`
  (703), `max_evolution_ops_usd_per_org_day=2.0` (1442).
- **Bug A (promote-path UUID mismatch)** confirmed live: schema
  `db_migrations/versions/092_market_ready_consolidated.py` declares
  `promotion_candidates.ref_id UUID NOT NULL`; both call sites still pass a
  composite string — `src/eden/llmops/promotion.py:358` and
  `src/eden/api/routes/prompt_canary.py:194` both do
  `ref_id=f"{agent}:{candidate_version}"`. This still cannot insert against
  a real Postgres instance.
- **"Zero portal UI" for the evolution loop** confirmed still true today:
  `find clients/portal/src/app -iname "*evolution*"` and
  `grep -rl "evolution" clients/portal/src` both return nothing. No
  `/orgs/{org}/prompts/evolution` page or any frontend reference to the
  evolution loop exists. (Contrast with playground/ below, which *does*
  have a full frontend — see NEW FINDINGS on why this makes the doc's
  framing dangerous.)
- `promotion.py` stage numbering, the `_evaluate_one` control-query
  "assumes only two variants" comment (lines 183–187), and the
  `EvidenceGate._metrics_from_outcomes` `kind != "nudge"` hardcode (line
  121, Bug B) all check out unchanged against current source.

**Conclusion on this content:** it is solid, precisely cited, and should be
kept — but it belongs in a doc about the autonomous evolution loop (there is
already a natural home: `features/13-continuous-improvement-loop.md`), not
under the "Prompt Playground" title, because it is crowding out and standing
in for coverage of the actual playground.

### B. The real playground/ subsystem (what the doc should have covered)

Confirmed `src/eden/playground/` is real, substantial, and wired end-to-end
— not a stub:

- **`src/eden/playground/service.py`** (682 lines) — `PlaygroundService`
  is org-scoped CRUD (`list`/`get`/`create`/`update`, lines 86–187) over a
  `playgrounds` Postgres table with an in-memory fallback
  (`_client`, lines 74–84), plus:
  - `from_span` (lines 210–270) — seeds a playground directly from a
    production trace/span via `span_seed.fetch_span_step` +
    `extract_span_seed`, building a two-task (`task_a`/`task_b`) compare
    config automatically.
  - `run` (lines 272–458) — executes the task × dataset-row matrix under a
    bounded `asyncio.Semaphore` (`concurrency` clamped 1–10, default 5,
    `_clamp_concurrency` line 521), streaming `start`/`cell`/`done` events
    via an `on_event` callback, scoring every cell with
    `scorers.run_scorers`, and computing a pairwise `grade_outputs`/
    `char_diff` between the first two task columns per row
    (`_build_run_payload`, lines 564–618).
  - `promote_experiment` (lines 460–488) — creates an
    `OfflineExperimentRunner` experiment carrying the playground's
    `tasks`/`scorers` config forward (status `"pending"`).
- **`src/eden/playground/scorers.py`** (181 lines) — real, deterministic
  scorer registry: `exact_match`, `contains`, `icontains`, `regex`,
  `json_valid`, `levenshtein_ratio` (pure-Python DP edit distance, lines
  91–107), dispatched via `run_scorers` (131–166) and averaged by
  `aggregate_score` (169–178). Explicitly honest about missing-expected
  cases (`None` + reason, never a fabricated score, lines 3–7, 38–39) and
  explicitly does **not** ship `llm_judge` ("a fake judge is worse than
  none," lines 5–7).
- **`src/eden/playground/diff.py`** (59 lines) — `char_diff` (common
  prefix/suffix char-level diff, capped at 4000 chars) and `grade_outputs`
  (lines 37–59), which labels each row `tie` / `tradeoff` / `improvement` /
  `regression` from score delta, text equality, and a cost-tradeoff check
  (`treatment_cost > control_cost * 1.2`, line 55).
- **`src/eden/playground/llm_handler.py`** (189 lines) — real execution
  path via `eden.llm.internal_router.route_async` (line 134), not a mock:
  fail-closed on org kill switch (`is_feature_enabled(oid, "playground")`,
  lines 105–111) and a **daily cost cap**
  (`EDEN_PLAYGROUND_DAILY_CAP_USD`, default $5, lines 19–27, checked via
  `sum_feature_spend_today` lines 113–125), with a deterministic offline
  fallback (`_offline_result`) when no API key, kill-switched, over cap, or
  `EDEN_PLAYGROUND_OFFLINE=1` (tests/air-gapped).
- **`src/eden/playground/span_seed.py`** (147 lines) — `fetch_span_step`
  queries `telemetry_events` (keyed by `tenant_id`, same convention as
  time-travel's `_get_parent_steps` per the module docstring) and
  `extract_span_seed` mirrors the time-travel replayer's extraction
  precedence (explicit `prompt`/`system_prompt` over `messages` array).

**API surface** — full REST CRUD + streaming, mounted and live:
`src/eden/api/routes/playgrounds.py`, registered at
`src/eden/api/app.py:250` under `/orgs/{org_id}/playgrounds`:
`GET/POST ""`, `POST /from-span`, `GET/PATCH /{id}`, `POST /{id}/run`,
`POST /{id}/run/stream` (SSE: `start`→`cell`→`done`/`error`, lines
209–281), `POST /{id}/promote-experiment`.

**Frontend** — a real, first-class portal surface, not a stub:
- Sidebar nav entry "Playgrounds" (`clients/portal/src/lab/nav.ts:55-58`,
  `sidebar-nav.tsx:45`).
- List page `clients/portal/src/app/(portal)/playgrounds/page.tsx` (183
  lines) and detail editor `.../playgrounds/[id]/page.tsx` +
  `clients/portal/src/lab/playgrounds/playground-editor.tsx` (1025 lines)
  — keyboard shortcuts `⌘Enter` run, `⌘S` save-as-prompt-version, `⌘D`
  toggle diff view (lines ~544–560).
- `clients/portal/src/lab/playgrounds/diff.ts` — an independent word-level
  LCS diff (green/red highlighting) for the browser UI, separate from the
  server's `char_diff` (used for the persisted run payload's row-level
  diff).
- `clients/portal/src/lab/playgrounds/run-client.ts` /
  `run-stream.ts` — consumes the SSE run endpoint live in-browser with a
  documented fallback to non-streaming `run` on stream failure.
- **Trace → Playground**: `clients/portal/src/app/(portal)/traces/traces-client.tsx:925-940`
  — a "Playground" button on a trace's LLM span calls
  `playgroundApi.fromSpan` and hard-navigates into the new playground
  (comment at line 331: "U03: span replay").
- **"Save Prompt"** (`playground-editor.tsx:476-505`) calls
  `promptsV2Api.createVersion`, which lands in the **same** `prompt_versions`
  table (`src/eden/services/prompt_versioning.py:263`, `INSERT INTO
  prompt_versions`) that the autonomous evolution loop reads for its
  canary candidate pool — a genuine (if inert by default) cross-subsystem
  link the doc's evolution-loop framing never surfaces.
- **Agent-callable**: `src/eden/llmops/insights_tools.py:2399-2478`
  exposes `list_playgrounds`, `create_playground`, `playground_from_span`
  as approval-gated `insights_tool`s — eden's own assistant can open/seed
  playgrounds on a user's behalf.
- **Portal dashboard cards**: `src/eden/api/routes/portal.py:2789-2809`
  serves "eval playground cards" for a home/dashboard widget.
- **Legacy sibling surface**: `src/eden/api/routes/prompts.py` still
  exposes an older per-template `/{name}/playground` and `/compare`
  endpoint (module docstring line 4: *"Legacy template playground/compare
  retained; product surface is `/playgrounds`"*) — built on the same
  `Playground`/`PlaygroundResult` classes from `eden.prompts.registry` and
  the same `make_playground_handler`. Confirms F49/U03
  (`api/routes/playgrounds.py`) superseded an earlier playground
  implementation rather than being greenfield.
- **Debugger/time-travel reuse**: `src/eden/debugger/checkpoints.py:489`
  imports `playground.diff.char_diff` for checkpoint outcome diffing, and
  `src/eden/api/routes/debugger.py:142-160` calls
  `playground_llm_handler` directly to re-run a debugger checkpoint through
  the same cost-capped, kill-switch-respecting execution path.

**Tests** — real, targeted unit coverage exists:
`tests/unit/playground/test_w18_playgrounds.py` (191 lines):
`test_playground_persists_in_memory_and_runs_matrix`,
`test_playground_llm_handler_routes_when_keyed`,
`test_playground_llm_handler_respects_kill_switch`,
`test_playground_from_span_and_promote_requires_dataset`,
`test_char_diff_and_grades`. (Could not execute the suite in this sandbox —
system Python is 3.9 and `eden.api.utils.auth` requires `datetime.UTC`
[3.11+]; this is a local-env limitation, not a repo issue, verified by
reading `tests/conftest.py:57` and `src/eden/api/utils/auth.py:6`.)

**Not wired to CI** — confirmed, matching `KNOWN-SUBSYSTEMS.md`'s framing:
the only PR/nightly regression gate is `.github/workflows/eden-eval.yml`,
which POSTs to `/orgs/{org}/ci-eval/run`
(`src/eden/api/routes/wave6_online.py:513-514`), backed by
`eden.evaluation.ci_webhook.CIWebhookHandler` — a completely separate code
path from `eden.playground`. `grep -rln "eden.playground" src/eden` outside
`playground/` itself never turns up `regression_runner.py`, `ci_webhook.py`,
or anything in `.github/`. No scorer defined in `scorers.py` ever gates a
merge or deploy.

**"Promote to Experiment" is a UX trap** (new, not previously documented
anywhere in this review series — see NEW FINDINGS below for detail): the
button exists, is wired, and the toast tells the user to "open Evals to
compare" — but the thing it produces, once actually run, does not use the
playground's own scorers/LLM calls at all.

---

## CUT (quote + reason)

The doc's prose itself is tight and well-cited — there is very little
outright-false content to prune at the sentence level (see VERIFIED-A: the
evolution-loop claims all check out). The pruning call for pass 4 is
structural, not sentence-level:

> "# 03 — Prompt Playground / Autonomous Prompt Evolution (Pass 3 — deep trace)"

**Reason to cut/split:** conflates two materially different subsystems
under one title and one review slot. `src/eden/playground/` (F49/U03) is a
human-driven, interactive prompt-comparison tool with a full portal UI,
scorer registry, and diffing. `agents/evolution/` +
`llmops/promotion.py` + `agents/prompt_canary.py` is an unrelated
background daemon that autonomously rewrites and canaries prompts with zero
human interaction by default. They share only the word "prompt" and (as
newly found above) the `prompt_versions` table. Keeping them fused means
the doc that's supposed to be the strategic review's single source of truth
on "prompt playground" contains no information about the actual playground
product surface a customer or the sales team would ask about.

> "This pass traces the loop end to end at file:line precision, and the
> headline finding **changes the risk picture**: the loop's final promote
> step is structurally broken..."

**Reason to flag, not delete:** this sentence and everything under it
(§1–§3) is accurate and should be *kept*, but relocated. It reads as the
headline finding of *this* doc, when it is actually the headline finding of
a doc about the evolution loop — recommend moving §1–§4 (lifecycle trace,
Bug A/B, other failure modes, competitive landscape) verbatim into
`features/13-continuous-improvement-loop.md` (which already exists and is
the natural home per the KNOWN-SUBSYSTEMS.md directory listing showing
`improvement/` as a distinct, larger closed-loop subsystem), and rewriting
`03-prompt-playground.md` from scratch around `src/eden/playground/`.

> "§4 Competitive landscape ... **Verdict**: no competitor found ships
> eden's exact combination ... The *design* is genuinely differentiated as
> of this research."

**Reason to flag as lower-confidence, not cut:** this is disclosed
web-research (arXiv IDs, vendor names), appropriately hedged, and not
making unverifiable claims about eden's own code — it's fine as
supplementary color for whichever doc ends up owning the evolution-loop
material, but it should not be read as part of a "Prompt Playground"
competitive analysis. A genuine playground-vs-competitors comparison
(Braintrust playgrounds, PromptLayer, LangSmith prompt hub, Vellum) is
conspicuously absent and would be the actually-relevant competitive
material for this doc's stated topic.

No claim in the current doc was found to be outright false, unverifiable-and-
unflagged, or redundant filler at the sentence level — the cut here is
almost entirely "this is the wrong document for this content," which is a
scope/title problem the parent reviewer should resolve by splitting the
file, not something a per-sentence prune can fix.

---

## USER EXPERIENCE & VALUE

*(Grounded entirely in `src/eden/playground/service.py`, `scorers.py`,
`diff.py`, `llm_handler.py`, the `playgrounds.py` API, and the portal
frontend — not generic playground-product boilerplate.)*

**The entry points are real, and there are three of them, not one.** An
engineer doesn't have to start from a blank editor:

1. From a **production trace**: click "Playground" on any LLM span in
   Traces (`traces-client.tsx:1354-1358`, tooltip "Replay this run's LLM
   span in a playground"). This calls `POST /from-span`, which — server-side,
   not client-side — pulls the actual stored request off
   `telemetry_events` (`span_seed.fetch_span_step`), reconstructs
   system/user text with the same precedence rules as the time-travel
   replayer, and seeds a two-column compare (`task_a` = the original,
   `task_b` = a `t2`-model variant, same system/user text) so the very
   first thing you see is your production prompt sitting next to a ready-
   to-edit sibling.
2. From a **blank playground** (`+ New playground` on the list page) —
   defaults to the same `task_a`/`task_b` compare shape
   (`_default_config`, `service.py:646-662`), with `exact_match` as the
   starting scorer.
3. From **eden's own assistant** — `create_playground` /
   `playground_from_span` insights tools let a user ask the assistant to
   open a playground from a described trace or issue, approval-gated.

**The iteration loop itself is what you'd actually want at your desk.**
Edit either task's system/user text, hit `⌘Enter`, and watch cells fill in
live over SSE (`start` → one `cell` event per task×row → `done`) rather
than waiting on a blocking POST — for a 2-task × N-row matrix this means
you see task_a's outputs land before task_b even finishes, and a
mid-flight cancel persists whatever completed as a `"cancelled"` run
instead of throwing the work away (`service.py:424-439`). Failures are
row-scoped, not run-scoped: one provider timeout on row 7 shows up as an
`error` cell with `totals["errors"]` incremented, while every other cell
in the matrix keeps running (`_run_cell` exception handling,
`service.py:361-379`) — you don't lose a 50-row run because one row's model
call 500'd.

**Scoring is honest, not decorative.** `scorers.py`'s design choice to
return `None` + a reason instead of a fabricated score when `expected` is
missing (rather than silently defaulting to 0 or 0.5) means the aggregate
score you see on a row genuinely reflects only what could be measured —
important because `aggregate_score` is a plain mean over whatever scored,
so a row with two working scorers and one `None` doesn't get silently
dragged down by an unscoreable dimension. The deliberate absence of
`llm_judge` (module docstring: "a fake judge is worse than none") means
this tool doesn't pretend to have a quality dimension it can't actually
back with a real judge call — an engineer comparing two prompt variants
gets `exact_match`/`regex`/`json_valid`/`levenshtein_ratio` as concrete,
auditable numbers, not an opaque "9.2/10" from an unaudited judge prompt.

**The comparison view is where the actual "should I ship this" decision
happens**, and it's more than a diff: `grade_outputs` (`diff.py:37-59`)
classifies every row as `tie` / `improvement` / `regression` / `tradeoff` —
critically, `tradeoff` fires specifically when treatment scores higher
*but* costs more than 1.2× control, so a variant that wins on the scorer
but is 40% more expensive doesn't get silently labeled a win. Paired with
the row-level `char_diff` (persisted server-side) and the richer
browser-side word-level LCS diff (`clients/portal/.../lab/playgrounds/diff.ts`,
`⌘D` to toggle), a reviewer can scan a 20-row matrix and immediately see
which rows are `regression` (fix the prompt) vs. `tradeoff` (a genuine
cost/quality call to make) rather than manually reading every output pair.

**"Save Prompt" is the loop-closing move** — once a variant looks good,
`⌘S` writes it as a new version into the *same* `prompt_versions` table the
autonomous evolution loop reads (`prompt_versioning.py:263`,
`INSERT INTO prompt_versions`). This is a real, useful convergence: a human
who iterated in the playground and a background loop that self-rewrites
under degradation are both landing candidates in one place. It also means
a prompt a human hand-tuned and saved could, in principle, later be picked
up by the evolution loop's canary machinery if it also flips
`ab_test_active` — worth stating explicitly since neither doc currently
connects these two systems (see NEW FINDINGS).

**Cost is bounded the way you'd want in a shared tenant.** Every real LLM
call in the playground goes through `playground_llm_handler`, which checks
an org-level kill switch and a **$5/day cost cap**
(`EDEN_PLAYGROUND_DAILY_CAP_USD`, `llm_handler.py:19-27`) before spending —
distinct from, and much tighter than, the evolution loop's $2/day
*platform-wide* cap (doc §1 Stage 0). Once you're over cap or the feature
is killed, you get a clearly-labeled offline stub response
(`"[offline:daily_cap:...]"`) instead of a silent failure or a surprise
bill, and unit tests (`test_playground_llm_handler_respects_kill_switch`)
cover this path.

**Where the workflow breaks down — the part worth a strategy call-out:**

- **"Promote to Experiment" doesn't do what the UI implies.** The button
  reads "+ Experiment," clicking it fires `promote_experiment`
  (`service.py:460-488`), and the success toast says *"Immutable snapshot
  promoted — open Evals to compare."* This creates an `offline_experiments`
  row carrying the playground's `tasks`/`scorers` config forward — but
  **when that experiment is actually executed** (`OfflineExperimentRunner.run`,
  `experiments/offline_runner.py:126-198`), it does not call the
  playground's LLM handler or `scorers.run_scorers` at all. `_run_row`
  (`offline_runner.py:266-287`) is an explicitly-labeled
  `"heuristic_stub"`: `score = 0.7 if expected else 0.5`, bumped to `0.9`
  if the expected string happens to appear in the input text — a
  hardcoded formula, not a model call, and the "control" is *always* a
  synthetic `{"score": 0.5}` regardless of what task_a actually produced
  in the playground run. An engineer who spent 20 minutes tuning a prompt
  in the playground, watched real scorer numbers, and clicked "Promote to
  Experiment" expecting that comparison to carry forward into a durable,
  re-runnable CI artifact gets a result that has nothing to do with what
  they just did. The `synthetic: true` / `method: "heuristic_stub"` labels
  are honestly surfaced in the API payload (so this isn't a silent lie to
  a careful API consumer), but the portal toast and the button label
  actively suggest otherwise to anyone using the UI as designed.
- **No CI gate reads any of this.** The one thing that would make this
  workflow "wire prompt iteration into CI gates" in the way the task
  framing anticipates — a merge/deploy check that fails when a playground
  scorer regresses — doesn't exist. `eden-eval.yml` / `ci-eval/run` is a
  wholly separate code path (`ci_webhook.py`) that never imports
  `eden.playground`. Today, the playground is a pre-merge *manual*
  comparison tool a human runs before hand-editing a prompt file or
  clicking "Save Prompt" — it has no automated say over whether a PR
  merges or a prompt version deploys. For a strategy review, this is the
  single highest-leverage gap: the scorer infrastructure to build a real
  "prompt regression gate" already exists (`scorers.py` is deterministic,
  fast, and dependency-free) and just isn't called from anywhere CI-shaped.
- **Dataset rows are ad hoc unless you bring your own.** `run` defaults to
  a single synthetic row (`{"id": "adhoc", "input": params.get("user", "")}`)
  when no `dataset_rows` are supplied (`service.py:298-300`) — there's no
  UI-driven pull from `datasets/hub.py` (Dataset Hub, F53) visible in the
  reviewed files, so systematic regression testing across a labeled
  dataset requires the caller to assemble `dataset_rows` by hand or via the
  API, not a first-class "attach dataset" flow in the editor matching the
  empty-state copy's promise ("attach a dataset to compare prompts before
  you ship").

**Net picture for the doc's actual title:** the playground is a
well-built, honestly-labeled, genuinely useful day-to-day prompt-iteration
tool — trace-seeded, live-streamed, cost-capped, deterministically scored,
diff-aware — that stops one step short of being a CI-gating tool despite
having exactly the ingredients (`scorers.py`, `diff.py`) a CI gate would
need. The gap isn't "no scorers exist," it's "the scorers that exist are
never called from anywhere automated," and the one integration point that
looks like it bridges that gap (`promote_experiment`) is currently a UX
trap that discards the real comparison in favor of a stub.

---

## NEW FINDINGS

1. **Critical, still-open process bug:** despite `KNOWN-SUBSYSTEMS.md`
   explicitly stating F3 "needs a full redo" because it "incorrectly
   concluded no playground exists," and despite this being pass 4 of a
   4-pass review, the on-disk `features/03-prompt-playground.md` still
   contains zero references to `src/eden/playground/`. The redo never
   happened; pass 3 instead went deeper into a different, real subsystem
   (the autonomous evolution loop) that happens to share the word
   "prompt." Recommend, for whoever integrates pass 4 findings: split the
   doc — move the evolution-loop trace (current §1–§4) into
   `features/13-continuous-improvement-loop.md`, and replace
   `03-prompt-playground.md`'s content with coverage of the actual
   `src/eden/playground/` subsystem (material provided in full above,
   under VERIFIED-B and USER EXPERIENCE & VALUE, ready to drop in).
2. **`promote_experiment` → `OfflineExperimentRunner.run` is a synthetic
   stub, not a real re-run.** `experiments/offline_runner.py:266-287`
   labels itself `heuristic_stub` in its own docstring and hardcodes
   `score = 0.7 if expected else 0.5` (0.9 if the expected string appears
   substring-wise in the input) — it ignores the `tasks`/`scorers` config
   the playground handed it and never calls `eden.llm` or
   `eden.playground.scorers`. The portal UI's toast ("Immutable snapshot
   promoted — open Evals to compare") and button label ("+ Experiment")
   do not disclose this to the user, though the API payload does
   (`synthetic: true`, `method: "heuristic_stub"`). This was not
   previously documented anywhere in this review series and is a genuine,
   verifiable, user-facing gap.
3. **Playground's scorer infrastructure is CI-gate-ready but unwired.**
   `scorers.py` is pure-Python, dependency-free, and deterministic
   (no network calls except the LLM generation step itself) — it is
   architecturally the cheapest possible thing to run in a GitHub Action.
   The existing `.github/workflows/eden-eval.yml` / `ci-eval/run` gate
   uses a completely separate evaluation path (`ci_webhook.py`) and never
   imports `eden.playground`. Building a "playground scorers as a
   merge-blocking check" feature would be additive engineering on top of
   code that already exists, not a from-scratch build.
4. **`prompt_versions` is a real, previously-undocumented junction
   between the playground and the evolution loop.** Playground's
   "Save Prompt" (`playground-editor.tsx:476-505` →
   `promptsV2Api.createVersion` → `prompt_versioning.py:263`) writes into
   the exact same `prompt_versions` table that
   `agents/evolution/components.py`'s canary-enrollment sweep scans
   (per the doc's own Stage 1–2 trace). Neither the evolution-loop doc nor
   `KNOWN-SUBSYSTEMS.md`'s one-line playground summary surfaces this. It
   doesn't currently cause the evolution loop to pick up
   playground-authored versions automatically (that requires
   `ab_test_active=true`, which `create_version` doesn't set), but it's a
   real coupling point worth knowing about if either system's schema
   changes.
5. **A legacy playground surface still exists and is explicitly marked
   superseded.** `src/eden/api/routes/prompts.py` (module docstring:
   "Legacy template playground/compare retained; product surface is
   `/playgrounds`") exposes an older per-template `/{name}/playground` and
   `/compare` pair built on the same `Playground`/`PlaygroundResult`
   primitives. Confirms F49/U03 replaced an earlier implementation rather
   than being greenfield — useful context if the strategic review is
   assessing engineering velocity/rework in this area.
6. **`playground.diff.char_diff` is reused by the time-travel debugger**
   for checkpoint outcome diffing (`debugger/checkpoints.py:489`), and
   `api/routes/debugger.py:142-160` calls `playground_llm_handler`
   directly to re-run a debugger checkpoint — the same cost-capped,
   kill-switch-respecting execution path the playground itself uses. This
   is a real, positive example of shared infrastructure across
   subsystems that neither the debugger doc nor a playground doc
   currently credits.
