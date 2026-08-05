# Eden subsystem inventory (ground truth — read this before writing any gap claim)

`src/eden/` has 63 top-level subsystem directories (1561 source files total across the repo).
Several early research directives in this review were written *before* this inventory existed
and assumed things were missing that already have dedicated subsystems. Any "eden lacks X" or
"eden should build X" claim MUST be checked against this list first — grep/outline the relevant
directory before concluding something doesn't exist.

## Full directory list
agent, agents, alerts, analytics, api, apm_depth, automations, autonomous, change_impact,
closed_loop, columnar, compliance, data_platform, datasets, db_migrations, debugger, decision,
dogfood, dsl, evaluation, experiments, exports, fleet, governance, guardrails, improvement,
insights, integrations, issues, kb, learning, llm, llmops, mcp_server, metric_studio,
monitoring, nudges, observability, optimization, patches, playground, predictive, preview,
promotion, prompts, providers, realtime, redteam, replay, sandbox, scripts, sdk, search,
self_obs, services, sessions, signals, storage, time_travel, topics, util, workers

## High-stakes subsystems already confirmed substantive (checked first-pass, Aug 2026 review)

- **`guardrails/`** (policy.py, detectors.py, evaluator.py, intervention.py) — real runtime
  guardrail engine. `evaluator.py`'s `GuardrailPolicy`/`evaluate()` runs regex/blocklist/length/
  LLM-judge checks. `intervention.py`'s `InterventionEngine.evaluate_and_act` is a live
  pre-response intervention path, and `EvalToGuardrailLink.promote`/`demote` is a
  confirm/dismiss-driven promotion mechanism for turning evals into active guardrails —
  **this contradicts the "eden is post-hoc-only" framing used in earlier feature/optimization
  research in this review; revise F12 and re-check the Turn-1 "no feedback loop" claim from
  this conversation against it.**
- **`optimization/`** (cost_tracker.py, cache.py, token_optimizer.py, budget_envelope.py,
  coalescer.py, model_router.py, tool_intel/attribution.py) — `budget_envelope.py`'s
  `BudgetEnvelope.is_over_soft/is_over_hard` is real budget-cap logic (F6 territory).
  `model_router.py`'s `ModelRouter` (tiers, fallback chains, heuristic+LLM task classification,
  `QualityValidator`) is a full internal model-routing/gateway layer (F10 territory).
- **`improvement/`** (planner.py, auto_merge.py, guardian.py, test_gate.py, agent.py,
  issue_patch_trigger.py, replay_verify.py) — a full autonomous issue→patch→test→auto-merge→
  auto-revert-on-regression closed loop (`evaluate_auto_merge_eligibility`,
  `merge_pull_request`, `guardian.handle_regression`, `_maybe_auto_execute_revert`). This is
  much bigger than the soft_issue_review.py shadow-detector loop covered in F13 — the two
  appear complementary (shadow detectors learn *what's an issue*; improvement/ autonomously
  *fixes* confirmed issues) but F13 needs to fold this in.
- **`time_travel/`** (replayer.py, recorder.py, diff.py, forker.py) — `TraceReplayer.replay_from`
  with step-level cache lookup/re-execution is almost certainly the real engine behind
  mcp_server/tools.py's checkpoint rerun. Relevant to F11 and to the agent-identity/time-travel
  design discussed earlier in this conversation (that discussion did not know this subsystem
  existed — its "time travel is keyed by trace_id, doesn't need to change" conclusion should be
  re-verified against this, not assumed still correct).
- **`nudges/`** (engine.py, author.py, shadow_outcomes.py, demotion_worker.py, trigger_eval.py,
  composer.py) — `NudgeEngine` evaluates/applies nudges to requests/prompts with a shadow-log →
  `ShadowOutcomeJoiner` outcome-join → promote/demote lifecycle, and `ArtifactAuthor.from_issue`/
  `from_nl` auto-authors nudges from issues or natural language. **This is close to the
  competitor "behavior record + validate/dismiss retrains the detector" mechanism discussed at
  the start of this conversation — that discussion did not know `nudges/` existed and may have
  been too pessimistic about eden's current capability. Needs reconciliation with the
  soft_issue_review.py shadow-detector findings (are these the same mechanism, overlapping ones,
  or genuinely separate systems?).**
- **`automations/engine.py`** — `AutomationsEngine.create`/`on_score`/`_execute_action` is a real
  automation/alert-routing engine (F4 territory), separate from `closed_loop/playbook_router.py`.
- **`compliance/evidence_generator.py`** — exists but `file_outline` found no function/class
  definitions; likely a short script or constants file. Needs an actual read, not just an outline,
  before concluding what it does (F7 territory).
- **`datasets/`** (hub.py "Dataset Hub" F53, spreadsheet.py) — per F2's research, exists but is
  unwired to the regression/CI gate.
- **`playground/`** (service.py, scorers.py, diff.py, llm_handler.py, span_seed.py) — per F2's
  research, `scorers.py` has real exact-match/regex/json_valid/levenshtein scorers wired only to
  a manual playground UI, not to CI. **F3 (prompt-playground research) was written and completed
  BEFORE this was discovered and only checked the frontend portal — it incorrectly concluded "no
  playground exists." F3 needs a full redo.**

## Not yet inspected but plausibly relevant — check before claiming a gap in these areas
`compliance/`, `governance/`, `redteam/probes.py`, `decision/`, `dsl/`, `autonomous/`,
`predictive/`, `promotion/`, `realtime/`, `self_obs/`, `integrations/`, `kb/`, `llm/`, `llmops/`,
`providers/`, `metric_studio/`, `apm_depth/`, `change_impact/`, `monitoring/`, `insights/`,
`patches/`, `sandbox/`, `preview/`, `exports/`, `dogfood/`, `topics/`, `columnar/`, `data_platform/`
