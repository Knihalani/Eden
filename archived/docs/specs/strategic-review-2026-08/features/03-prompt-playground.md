# 03 — Prompt Playground (Pass 4 — corrected scope)

> **Scope correction (pass 4).** Passes 1–3 of this review wrote up the
> *autonomous prompt-evolution loop* (`agents/evolution/`,
> `llmops/promotion.py`, `agents/prompt_canary.py`,
> `promotion/evidence_gate.py`) under this doc's title — a real, well-traced
> subsystem, but the **wrong one**. `KNOWN-SUBSYSTEMS.md` flagged that this
> doc was written before `src/eden/playground/` (`service.py`, `scorers.py`,
> `diff.py`, `llm_handler.py`, `span_seed.py`, the `playgrounds.py` API, and
> a 1000+ line portal editor) was discovered, and that "F3 needs a full
> redo." That redo happens here: the evolution-loop trace (lifecycle,
> promote-path bugs, races, competitive landscape) has been moved to
> `features/13-continuous-improvement-loop.md`, which is its natural home.
> This doc now covers the actual "Prompt Playground" product surface — the
> human-driven, interactive prompt-comparison tool a customer or the sales
> team would mean by that name.
>
> The two subsystems share only the word "prompt" and one real coupling
> point worth remembering when reading either doc: the playground's "Save
> Prompt" action and the evolution loop's canary-candidate generation both
> write into the same `prompt_versions` table (`prompt_versioning.py:263`
> vs. `agents/evolution/components.py`'s canary-enrollment scan). See
> §5 below and `features/13-continuous-improvement-loop.md` for the
> evolution-loop side of that link.

## 1. What it is — architecture, file:line

`src/eden/playground/` is a real, substantial, end-to-end-wired subsystem
(F49/U03), not a stub:

- **`service.py`** (682 lines) — `PlaygroundService` is org-scoped CRUD
  (`list`/`get`/`create`/`update`, lines 86–187) over a `playgrounds`
  Postgres table with an in-memory fallback (`_client`, lines 74–84), plus:
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
    `tasks`/`scorers` config forward (status `"pending"`) — see §4 for why
    this is currently a UX trap.
- **`scorers.py`** (181 lines) — a real, deterministic scorer registry:
  `exact_match`, `contains`, `icontains`, `regex`, `json_valid`,
  `levenshtein_ratio` (pure-Python DP edit distance, lines 91–107),
  dispatched via `run_scorers` (131–166) and averaged by `aggregate_score`
  (169–178). Explicitly honest about missing-expected cases (`None` +
  reason, never a fabricated score, lines 3–7, 38–39) and explicitly does
  **not** ship `llm_judge` ("a fake judge is worse than none," lines 5–7).
- **`diff.py`** (59 lines) — `char_diff` (common prefix/suffix char-level
  diff, capped at 4000 chars) and `grade_outputs` (lines 37–59), which
  labels each row `tie` / `tradeoff` / `improvement` / `regression` from
  score delta, text equality, and a cost-tradeoff check
  (`treatment_cost > control_cost * 1.2`, line 55).
- **`llm_handler.py`** (189 lines) — real execution via
  `eden.llm.internal_router.route_async` (line 134), not a mock:
  fail-closed on an org kill switch (`is_feature_enabled(oid, "playground")`,
  lines 105–111) and a **daily cost cap** (`EDEN_PLAYGROUND_DAILY_CAP_USD`,
  default $5, lines 19–27, checked via `sum_feature_spend_today`, lines
  113–125), with a deterministic offline fallback (`_offline_result`) when
  there's no API key, the feature is kill-switched, spend is over cap, or
  `EDEN_PLAYGROUND_OFFLINE=1` (tests/air-gapped).
- **`span_seed.py`** (147 lines) — `fetch_span_step` queries
  `telemetry_events` (keyed by `tenant_id`, same convention as
  time-travel's `_get_parent_steps` per the module docstring) and
  `extract_span_seed` mirrors the time-travel replayer's extraction
  precedence (explicit `prompt`/`system_prompt` over a `messages` array).

## 2. API surface

Full REST CRUD + streaming, mounted and live:
`src/eden/api/routes/playgrounds.py`, registered at
`src/eden/api/app.py:250` under `/orgs/{org_id}/playgrounds`:
`GET/POST ""`, `POST /from-span`, `GET/PATCH /{id}`, `POST /{id}/run`,
`POST /{id}/run/stream` (SSE: `start`→`cell`→`done`/`error`, lines
209–281), `POST /{id}/promote-experiment`.

## 3. Frontend — a real, first-class portal surface, not a stub

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
- `clients/portal/src/lab/playgrounds/run-client.ts` / `run-stream.ts` —
  consumes the SSE run endpoint live in-browser with a documented fallback
  to non-streaming `run` on stream failure.
- **Trace → Playground**:
  `clients/portal/src/app/(portal)/traces/traces-client.tsx:925-940,1354-1358`
  — a "Playground" button on a trace's LLM span (tooltip "Replay this
  run's LLM span in a playground") calls `playgroundApi.fromSpan` and
  hard-navigates into the new playground (comment at line 331: "U03: span
  replay").
- **"Save Prompt"** (`playground-editor.tsx:476-505`) calls
  `promptsV2Api.createVersion`, landing in the same `prompt_versions`
  table (`services/prompt_versioning.py:263`) the evolution loop reads for
  its canary candidate pool — see §5.
- **Agent-callable**: `src/eden/llmops/insights_tools.py:2399-2478`
  exposes `list_playgrounds`, `create_playground`, `playground_from_span`
  as approval-gated `insights_tool`s — eden's own assistant can open/seed
  playgrounds on a user's behalf.
- **Portal dashboard cards**: `src/eden/api/routes/portal.py:2789-2809`
  serves "eval playground cards" for a home/dashboard widget.

## 4. "Promote to Experiment" is a UX trap

The button reads "+ Experiment"; clicking it fires `promote_experiment`
(`service.py:460-488`), and the success toast says *"Immutable snapshot
promoted — open Evals to compare."* This creates an `offline_experiments`
row carrying the playground's `tasks`/`scorers` config forward — but
**when that experiment is actually executed**
(`OfflineExperimentRunner.run`, `experiments/offline_runner.py:126-198`),
it does not call the playground's LLM handler or `scorers.run_scorers` at
all. `_run_row` (`offline_runner.py:266-287`) is an explicitly-labeled
`"heuristic_stub"`: `score = 0.7 if expected else 0.5`, bumped to `0.9` if
the expected string happens to appear in the input text — a hardcoded
formula, not a model call, and the "control" is *always* a synthetic
`{"score": 0.5}` regardless of what task_a actually produced in the
playground run. An engineer who spent 20 minutes tuning a prompt in the
playground, watched real scorer numbers, and clicked "Promote to
Experiment" expecting that comparison to carry forward into a durable,
re-runnable CI artifact gets a result that has nothing to do with what
they just did. The `synthetic: true` / `method: "heuristic_stub"` labels
are honestly surfaced in the API payload (not a silent lie to a careful
API consumer), but the portal toast and button label actively suggest
otherwise to anyone using the UI as designed.

## 5. Cross-subsystem links and history

- **Legacy sibling surface**: `src/eden/api/routes/prompts.py` still
  exposes an older per-template `/{name}/playground` and `/compare`
  endpoint (module docstring: *"Legacy template playground/compare
  retained; product surface is `/playgrounds`"*) — built on the same
  `Playground`/`PlaygroundResult` classes from `eden.prompts.registry` and
  the same `make_playground_handler`. Confirms the current
  `api/routes/playgrounds.py` superseded an earlier implementation rather
  than being greenfield.
- **Debugger/time-travel reuse**: `src/eden/debugger/checkpoints.py:489`
  imports `playground.diff.char_diff` for checkpoint outcome diffing, and
  `src/eden/api/routes/debugger.py:142-160` calls `playground_llm_handler`
  directly to re-run a debugger checkpoint through the same cost-capped,
  kill-switch-respecting execution path — a real, positive example of
  shared infrastructure across subsystems.
- **`prompt_versions` junction with the evolution loop**: playground's
  "Save Prompt" and the evolution loop's canary-enrollment scan
  (`agents/evolution/components.py`, see
  `features/13-continuous-improvement-loop.md`) both operate on the same
  table. This does not currently cause the loop to auto-pick-up
  playground-authored versions (that requires `ab_test_active=true`,
  which `create_version` doesn't set) — but it's a real coupling point
  worth knowing about if either system's schema changes.
- **Tests**: `tests/unit/playground/test_w18_playgrounds.py` (191 lines)
  covers persistence + matrix runs, LLM-handler routing, kill-switch
  behavior, `from_span`/`promote` dataset requirements, and
  `char_diff`/grading.
- **Not wired to CI**: the only PR/nightly regression gate is
  `.github/workflows/eden-eval.yml`, which POSTs to
  `/orgs/{org}/ci-eval/run` (`api/routes/wave6_online.py:513-514`), backed
  by `eden.evaluation.ci_webhook.CIWebhookHandler` — a completely separate
  code path from `eden.playground`. `grep -rln "eden.playground" src/eden`
  outside `playground/` itself never turns up `regression_runner.py`,
  `ci_webhook.py`, or anything in `.github/`. No scorer defined in
  `scorers.py` ever gates a merge or deploy — see the "what's missing"
  discussion below.

## User Experience & Value

*(Grounded entirely in `src/eden/playground/service.py`, `scorers.py`,
`diff.py`, `llm_handler.py`, the `playgrounds.py` API, and the portal
frontend — not generic playground-product boilerplate.)*

**Who the user is.** A prompt engineer or product/backend developer who
owns an agent's system prompt and wants to iterate on it against real
inputs before shipping a change — the target user for a "compare two
prompt variants" tool, not an end customer.

**The entry points are real, and there are three of them, not one.** An
engineer doesn't have to start from a blank editor:

1. From a **production trace**: click "Playground" on any LLM span in
   Traces. This calls `POST /from-span`, which — server-side, not
   client-side — pulls the actual stored request off `telemetry_events`
   (`span_seed.fetch_span_step`), reconstructs system/user text with the
   same precedence rules as the time-travel replayer, and seeds a
   two-column compare (`task_a` = the original, `task_b` = a `t2`-model
   variant, same system/user text) so the very first thing you see is
   your production prompt sitting next to a ready-to-edit sibling.
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
`service.py:361-379`) — you don't lose a 50-row run because one row's
model call 500'd.

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

**The comparison/diff view is where the actual "should I ship this"
decision happens**, and it's more than a diff: `grade_outputs`
(`diff.py:37-59`) classifies every row as `tie` / `improvement` /
`regression` / `tradeoff` — critically, `tradeoff` fires specifically when
treatment scores higher *but* costs more than 1.2× control, so a variant
that wins on the scorer but is 40% more expensive doesn't get silently
labeled a win. Paired with the row-level `char_diff` (persisted
server-side) and the richer browser-side word-level LCS diff
(`clients/portal/.../lab/playgrounds/diff.ts`, `⌘D` to toggle), a reviewer
can scan a 20-row matrix and immediately see which rows are `regression`
(fix the prompt) vs. `tradeoff` (a genuine cost/quality call to make)
rather than manually reading every output pair.

**"Save Prompt" is the loop-closing move** — once a variant looks good,
`⌘S` writes it as a new version into the same `prompt_versions` table the
autonomous evolution loop reads (`prompt_versioning.py:263`,
`INSERT INTO prompt_versions`). This is a real, useful convergence: a
human who iterated in the playground and a background loop that
self-rewrites under degradation are both landing candidates in one place
(§5).

**Cost is bounded the way you'd want in a shared tenant.** Every real LLM
call in the playground goes through `playground_llm_handler`, which
checks an org-level kill switch and a **$5/day cost cap**
(`EDEN_PLAYGROUND_DAILY_CAP_USD`, `llm_handler.py:19-27`) before
spending — distinct from, and much tighter than, the evolution loop's
$2/day *platform-wide* cap. Once you're over cap or the feature is
killed, you get a clearly-labeled offline stub response
(`"[offline:daily_cap:...]"`) instead of a silent failure or a surprise
bill, and unit tests (`test_playground_llm_handler_respects_kill_switch`)
cover this path.

**Where the workflow breaks down — the part worth a strategy call-out:**

- **"Promote to Experiment" doesn't do what the UI implies** (§4) — an
  engineer's real comparison is silently discarded in favor of a
  hardcoded `heuristic_stub` score once the "experiment" actually runs.
- **No CI gate reads any of this.** The one thing that would make this
  workflow a real "wire prompt iteration into CI gates" feature — a
  merge/deploy check that fails when a playground scorer regresses —
  doesn't exist. `eden-eval.yml` / `ci-eval/run` is a wholly separate code
  path (`ci_webhook.py`) that never imports `eden.playground`. Today, the
  playground is a pre-merge *manual* comparison tool a human runs before
  hand-editing a prompt file or clicking "Save Prompt" — it has no
  automated say over whether a PR merges or a prompt version deploys.
  This is the single highest-leverage gap for adoption: the scorer
  infrastructure to build a real "prompt regression gate" already exists
  (`scorers.py` is deterministic, fast, and dependency-free) and just
  isn't called from anywhere CI-shaped.
- **Dataset rows are ad hoc unless you bring your own.** `run` defaults to
  a single synthetic row (`{"id": "adhoc", "input": params.get("user", "")}`)
  when no `dataset_rows` are supplied (`service.py:298-300`) — there's no
  UI-driven pull from Dataset Hub (F53) visible in the reviewed files, so
  systematic regression testing across a labeled dataset requires the
  caller to assemble `dataset_rows` by hand or via the API, not a
  first-class "attach dataset" flow in the editor matching the
  empty-state copy's promise ("attach a dataset to compare prompts before
  you ship").

**Net picture.** The playground is a well-built, honestly-labeled,
genuinely useful day-to-day prompt-iteration tool — trace-seeded,
live-streamed, cost-capped, deterministically scored, diff-aware — that
stops one step short of being a CI-gating tool despite having exactly the
ingredients (`scorers.py`, `diff.py`) a CI gate would need. The gap isn't
"no scorers exist," it's "the scorers that exist are never called from
anywhere automated," and the one integration point that looks like it
bridges that gap (`promote_experiment`) is currently a UX trap that
discards the real comparison in favor of a stub. Fixing `promote_experiment`
to actually replay the playground's own `tasks`/`scorers`, and wiring
`scorers.py` into a CI check, are the two highest-value next steps for
turning this from "a good manual tool" into "the thing that prevents
prompt regressions from shipping."

## Appendix — evolution-loop material relocated

The remainder of this doc through pass 3 covered the *autonomous
prompt-evolution loop* end to end (lifecycle stages, two compounding
promote-path bugs, races, and a competitive-landscape write-up), which is
accurate, well-cited, and worth keeping — just not under this title. That
content has been moved to `features/13-continuous-improvement-loop.md`.
See the scope-correction note at the top of this doc for the one real
coupling point (`prompt_versions`) between the two subsystems.
