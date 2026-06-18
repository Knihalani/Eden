---
title: "23 — Autonomous Code Modification & Self-Healing Codebase (v1.6)"
status: STUB surface shipped (v0, 2026-06-12) — Gate 1 (read-only connectivity) target weeks 25-26
last_updated: 2026-06-12
version: 1.0
---

# 23 — Autonomous Code Modification & Self-Healing Codebase (v1.6)

> **Status:** 🟡 **STUB surface shipped** (2026-06-12). The
> 21 service classes + the 8 core + 4 approval + 3
> auto-approval + 4 inbox/persona/style/quality tables + the
> 19+ route surface + the new `CodeChangeHook` are all wired.
> The real end-to-end ship is gated on the 4 hard gates
> (read-only → attribution → sandbox → end-to-end) detailed
> in the v1.6 ship plan below. **No 2026 observability
> competitor ships a self-healing codebase loop driven by
> telemetry.** Adjacent 2026 work — Meta Chameleon, SWE-agent
> Princeton, Devin, Harness.io, Codeball AI, Ellipsis, Aider
> — is not "observability-driven".

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [What's already in Eden](#whats-already-in-eden)
3. [Feature inventory](#feature-inventory)
4. [The primary UX — the PR Inbox](#the-primary-ux--the-pr-inbox)
5. [API contracts](#api-contracts)
6. [Data model](#data-model)
7. [Algorithm / pseudo-code](#algorithm--pseudo-code)
8. [Failure modes & guardrails](#failure-modes--guardrails)
9. [Telemetry](#telemetry)
10. [Test plan](#test-plan)
11. [Acceptance criteria](#acceptance-criteria)
12. [The 4-gate rollout plan](#the-4-gate-rollout-plan)
13. [Open questions](#open-questions)
14. [Cross-references](#cross-references)

## Goal & motivation

The org has 1 observability engineer and 50 product engineers.
Without autonomous investigation, the obs engineer is the
bottleneck. Cat 23 (Autonomous Intelligence, Cat 14) handles
the "investigate and recommend" half. Cat 23 handles the
"mutate the code, validate against the same telemetry, and
auto-revert on regression" half. The combination is a
**first-class team member** with a persona, an activity feed,
and a track record.

The value is not "open a PR automatically" — it is **"show
the engineer every place in their code that we can improve
based on the telemetry, and let them review, edit, approve,
or deny each one in 30 seconds"**. The auto-merge flow exists
but is a power-user / enterprise opt-in, not the default.

The closed-loop is the **deepest possible** in the roadmap:
the application code is mutated, deployed, observed, and
auto-reverted by the same system. The "Observation →
Automation" chain becomes "Observation → Mutation →
Observation → Auto-correction" — a true self-healing loop.

## What's already in Eden

The STUB surface (the 21 service classes, the 19+ route
surface, the 8+ tables, the `CodeChangeHook`) is built on
top of these existing Eden capabilities:

* `src/eden/observability/checkpoint.py` — Cat 1's
  `CheckpointService` (forward rewind); the Cat 20 time-
  travel debugger extends this with fork-and-replay.
* `src/eden/llmops/promotion_hooks.py` — Cat 17's hook
  surface; the new `CodeChangeHook` extends this with
  `propose_patch_from_rca` + `post_merge_degraded`.
* `src/eden/observability/rca/` — Cat 2's RCA clusterer; the
  `CodeRootCauseLinker` consumes the cluster output + the
  Cat 16 Decision paths.
* `src/eden/sandbox/runner.py` — the existing sandbox runner;
  the `TestPlanRunner` extends this with the customer's CI
  suite + Eden's golden test set.
* `src/eden/integrations/slack.py` — the existing Slack
  webhook surface; the `PRReviewerNotifier` reuses this.
* `src/eden/observability/custom_properties/service.py` —
  Cat 1's `CustomPropertiesService`; the patch-review
  metadata reuses the same audit-log pattern.

## Feature inventory

The 22 features per the v1.6 cat spec, mapped to the 21
service classes (the v1.6 STUB checklist counts 18 in scope
+ the 3 admin-controlled approval-workflow services + the
2 inbox sub-package services):

### Identity layer (3)

* `RepoConnector` (`code_change/repo_connector.py`) — connect
  Eden to a GitHub / GitLab / Bitbucket repo as a
  first-class identity called **"Eden Agent"**.
* `AgentPersonaService` (`code_change/persona.py`) — the
  per-tenant "Eden Agent" identity (display name, avatar,
  voice, track record).
* `AgentActivityFeed` (`code_change/activity_feed.py`) — the
  agent's public activity feed in the portal.

### Trigger layer (2)

* `CodeChangePolicyService` (`code_change/policy.py`) — the
  per-tenant + per-repo opt-in policy (the two-stage opt-in).
* `CodeRootCauseLinker` (`code_change/rca_linker.py`) — map a
  Cat 2 RCA to source files via 4-source correlation
  (Gate 2 — attribution accuracy).

### Generation layer (5)

* `CodeStyleLearner` (`code_change/style/style_learner.py`) —
  learn the repo's style from the last 100 merged PRs +
  the style config files.
* `PRQualityScorer` (`code_change/quality/quality_scorer.py`) —
  the 5-dimension 0-1 quality score (style / coverage /
  complexity / security / idiomatic-fit).
* `PRExplanationService` (`code_change/explanation.py`) — the
  4-paragraph human-readable explanation.
* `PatchGenerator` (`code_change/patch_generator.py`) —
  generate a unified diff (Gate 4a).
* `TestPlanRunner` (`code_change/test_runner.py`) — run the
  CI + regression + golden test suites in a sandbox (Gate 3).
* `BlastRadiusAnalyzer` (`code_change/blast_radius.py`) —
  compute the 0-1 blast-radius score (40/60 static/dynamic
  weighting, Gate 2).
* `CodebaseKnowledgeGraph`
  (`code_change/knowledge_graph.py`) — per-repo graph of
  ``(code_path, telemetry_signature, history)`` (Gate 5).

### Review layer — the PR Inbox (5)

* `PRInboxService` (`code_change/inbox/inbox.py`) — the
  human-in-the-loop inbox for proposed patches.
* `PRReviewService` (`code_change/inbox/review.py`) — the
  8 actions a human can take on a patch
  (approve / deny / edit / request-changes / comment / pr /
  revert / bulk).
* `ApprovalGrantService`
  (`code_change/approvals/grants.py`) — the
  admin-controlled approval grants.
* `ApprovalWorkflowService`
  (`code_change/approvals/workflow.py`) — the multi-approval
  workflow engine.
* `ApprovalDelegationService`
  (`code_change/approvals/delegations.py`) — out-of-office
  delegations.
* `AutoApprovalRuleService`
  (`code_change/auto_approval/rules.py`) — evaluate a patch
  against the 12-field auto-approval policy.
* `AutoApprovalMetricsCollector`
  (`code_change/auto_approval/metrics.py`) — compute the
  patch metrics (`lines_changed` / `files_changed` /
  `is_first_pr_to_file`).
* `AutoApprovalDryRunService`
  (`code_change/auto_approval/dry_run.py`) — dry-run the
  rule over the last 30 days.
* `AutoApprovalRateLimiter`
  (`code_change/auto_approval/rate_limit.py`) — enforce the
  per-day + per-file-per-week caps.

### Auto-mode ops (3)

* `PRCreator` (`code_change/pr_creator.py`) — open a real PR
  (Gate 4a).
* `PostMergeMonitor` (`code_change/post_merge_monitor.py`) —
  watch at 1h/6h/24h/7d (Gate 4b).
* `AutoRevertEngine` (`code_change/revert_engine.py`) —
  3-strategy auto-revert (`close_pr` / `revert_pr` /
  `revert_branch`, Gate 4b).
* `PRReviewerNotifier` (`code_change/notify.py`) — post the
  PR link to Slack/Teams.

## The primary UX — the PR Inbox

The portal `/agents/eden/inbox` page renders the
:class:`PRInboxService`. The 6 inbox endpoints (per the
v1.6 STUB checklist):

* `GET /inbox` — list all proposed patches, filterable by
  repo, status (`open` / `approved` / `denied` / `merged` /
  `reverted` / `needs_revision`), RCA category, age,
  confidence, blast radius, and quality score. Sortable by
  `priority` (default — a composite of confidence +
  blast-radius + cost-savings), `newest`, `oldest`,
  `quality_score`, or `cost_savings`. Groupable by `repo`
  (default) or `rca_category`.
* `GET /inbox/{patch_id}` — the full detail view (the
  4-paragraph `PRExplanation` + the diff rendered in a
  Monaco editor with syntax highlighting matching the
  file's language).
* `GET /inbox/{patch_id}/diff` — raw unified diff (for
  copy-paste into the customer's editor).
* `GET /inbox/{patch_id}/style` — the per-patch style
  breakdown (per-dimension quality score + lint violations
  + style-violation annotations).
* `GET /inbox/stats` — aggregate stats: `proposed_count`,
  `approved_count`, `merged_count`, `reverted_count`,
  `avg_quality_score`, `avg_review_time_seconds`,
  `total_cost_savings_usd`.
* `POST /inbox/{patch_id}/{action}` — dispatch the 8 inbox
  actions (RBAC-gated, audit-logged, two-stage-opt-in-gated
  for the auto-mode actions).

## API contracts

The 19+ route surface ships via
`src/eden/api/routes/intelligence_code_change.py`, mounted at
`/orgs/{org_id}/intelligence/code-change/...`. The router
follows the v1.6 cat spec conventions:

* **URL prefix:** `/orgs/{org_id}/intelligence/code-change/...`
* **OpenAPI tag:** `intelligence-code-change`
* **Auth:** `Depends(get_current_user)` for every route.
* **Feature flag:** `Depends(require_feature_flag("intelligence_gap_v0"))`
  on the router (the umbrella flag, not a Cat-23-specific
  sub-flag — sub-flags are a per-tenant policy concern, not
  a route concern).
* **Destructive routes:** the auto-mode routes
  (`POST /patches/{id}/pr` with `auto_pr_enabled=true`,
  `POST /prs/{id}/revert` with `auto_revert_enabled=true`)
  are additionally gated by `require_org_admin` and emit an
  `org_audit_log` row on every invocation.

The full request/response shapes are documented in
`docs/observability/gap-roadmap.md` (Cat 23) and
in the route file's Pydantic schemas.

## Data model

The 19 new tables in migration 027
(`src/eden/db_migrations/versions/027_autonomous_code_modification.py`):

### 8 core tables

* `repo_connections` — per-repo connection metadata
  (provider, installation_id, repo_full_name, default_branch,
  status, connected_by_user_id, connected_at, last_synced_at).
* `code_root_cause_links` — per-RCA → per-file attribution
  (rca_id, file_path, line_range, function_name,
  call_graph_path, confidence, signal_sources).
* `proposed_patches` — per-patch proposal (repo_id, trace_id,
  rca_id, base_sha, diff, description, explanation,
  test_plan, blast_radius_score, quality_score, model_used,
  cost_usd, version, status).
* `patch_test_runs` — per-patch test result
  (sandbox_run_id, passed_tests, failed_tests, total_tests,
  lint_violations, pass_rate, duration_ms, log_excerpt).
* `pull_requests` — per-PR metadata (repo_id, patch_id,
  pr_url, pr_number, base_branch, head_branch, state,
  merged_at, merged_by, labels, reviewers).
* `post_merge_windows` — per-window post-merge telemetry
  comparison (pr_id, window_hours, baseline_metrics,
  current_metrics, regression_score, regression_detected,
  monitored_at).
* `revert_events` — per-revert event (pr_id, strategy,
  reason, regression_evidence, revert_pr_url,
  revert_pr_number, post_revert_verified,
  post_revert_metrics).
* `codebase_knowledge_graph` — per-(repo, code_path) graph
  node (telemetry_signature, historical_patches_count,
  reverted_count, denied_count, edited_count, last_outcome,
  last_updated).

### 4 admin-controlled approval workflow tables

* `approval_grants` — per-grant row
  (granted_user_id, granted_by_user_id, scope_type,
  scope_value, reason, expires_at, created_at, revoked_at,
  revoked_by_user_id).
* `patch_approvals` — per-approval row
  (patch_id, approver_user_id, approval_type, comment,
  delegated_from_user_id).
* `patch_approval_status` — per-patch status rollup
  (approvals_required, approvals_received,
  eligible_approvers, missing_approver_roles, status).
* `approval_delegations` — per-delegation row
  (delegator_user_id, delegate_user_id, starts_at, ends_at,
  scope_filter, revoked_at).

### 3 auto-approval tables

* `auto_approval_policies` — per-org policy row (12 fields
  per the v1.6 cat spec: `enabled`, `max_risk_score`,
  `max_lines_changed`, `max_files_changed`,
  `min_quality_score`, `min_rca_confidence`,
  `require_human_for_protected_paths`,
  `require_human_for_first_pr_to_file`,
  `cool_off_after_revert_hours`,
  `max_auto_approvals_per_day`,
  `max_auto_approvals_per_file_per_week`, `dry_run_mode`).
* `auto_approval_events` — per-evaluation event
  (patch_id, decision, rule_id, metric_snapshot,
  failing_conditions, actor_type, actor_user_id).
* `auto_approval_dry_runs` — per-dry-run summary
  (requested_by_user_id, total_patches_evaluated,
  would_have_auto_approved, blocked_breakdown,
  estimated_time_saved_minutes).

### 4 inbox + persona + style + quality tables

* `agent_persona_config` — per-org persona
  (display_name, avatar, voice, track_record_visible_to,
  commit_message_style, pr_body_template).
* `agent_activity_events` — per-activity-feed event
  (agent_id, event_type, patch_id, summary, deep_link,
  actor_user_id, metadata).
* `repo_style_profiles` — per-repo style profile
  (indentation, type_hints_style, naming_convention,
  import_style, error_handling, logging_style,
  docstring_style, test_framework, lint_config,
  complexity_median, architecture_patterns,
  last_learned_at, last_learned_from_pr_id).
* `patch_review_actions` — per-review-action row
  (patch_id, action, actor_user_id, comment, reason,
  edited_diff, version_after).

All tables follow the v1.6 cat-ship conventions:

* `org_id VARCHAR(128) NOT NULL` and
  `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` on every
  table.
* `idx_<name>_org (org_id, created_at DESC)` index for the
  per-org time-series access pattern.
* PKs use the deterministic `<prefix>_<uuid|sha256>` shapes
  the v1.6 cat spec mandates, so re-runs dedupe naturally
  and the STUB-mode services can mint ids without a database
  round-trip.

The STUB surface intentionally does NOT enforce RLS on the
19 tables — the real Gate-1 + Gate-2 ship will add the
`ENABLE ROW LEVEL SECURITY` + the
`CREATE POLICY tenant_isolation ON <table>` blocks following
the `015_regions_and_rls.py` pattern.

## Algorithm / pseudo-code

### 4-source RCA attribution (Gate 2)

The :class:`CodeRootCauseLinker` combines 4 signals to map a
Cat 2 RCA to the right source file/function:

1. **Stack-trace correlation** (when present in the
   `telemetry_events.error` column) — exact match
   (file_path, function_name, line_range).
2. **Request-path → controller file mapping** (for HTTP) —
   `/api/v1/chat/completions` → `src/api/routes/chat.py:42`.
3. **Tool-call signature → tool registration lookup**
   (Cat 7) — the tool name in the Cat 2 RCA matches a
   `tool_registry` row → the implementing file.
4. **LLM inference** — "given this RCA 'rate limiter
   retry_after off by 1', which file/function most likely
   matches?" with the in-context examples from the
   `codebase_knowledge_graph`.

The 4-source correlation is critical: stack-trace alone
misses 60% of LLM-app failures (the LLM layer doesn't
always emit a stack trace); LLM inference alone hallucinates
file paths. The combination is the same pattern as Cat 5's
MemoryAttributor (multi-signal correlation with
confidence adjustments).

### 3-strategy revert (Gate 4b)

```python
def pick_strategy(pr_state, history_is_linear):
    if pr_state in ("open", "closed"):
        return "close_pr"
    if history_is_linear:
        return "revert_pr"
    return "revert_branch"
```

All three strategies **never force-push, never rewrite
history, never delete branches, never delete the original
PR**. Requires `auto_revert_enabled=true` AND
`min_post_merge_window_hours` elapsed AND the post-merge
window shows regression.

### 4-window post-merge monitor (Gate 4b)

The :class:`PostMergeMonitor` schedules 4 cron-like tasks
at 1h/6h/24h/7d post-merge. For each window, it computes
the median of the affected metrics over the window
(success rate, judge scores, latency, cost) and compares
against the pre-merge baseline (median over the matching
1h/6h/24h/7d window *before* merge, with a 7-day historical
floor to handle weekly seasonality).

A regression is a >`revert_threshold_pct` (default 10%) drop
on ANY of the tracked metrics, OR a statistically-significant
drop (p\<0.05 via Welch's t-test) on the COMBINED metric.

The monitor respects `min_post_merge_window_hours` — a 10%
regression detected at 1h is "too early to revert"; at 24h
it fires.

### 3-read-path knowledge graph (Gate 5)

1. **Same-file history** — the last 3 patches in this file
   were all reverted → suggest a different approach.
2. **Same-RCA-category history** — the last "rate_limiter"
   RCA was fixed by changing the ceiling to 100 → surface
   the diff as a 1-shot in-context example.
3. **Telemetry signature match** — when a new RCA + new
   patch share a telemetry signature with a prior (reverted,
   denied, or edited-then-approved) patch → surface the
   prior outcome ("last time we tried this it regressed on
   the success_rate metric; don't ship without an explicit
   A/B test").

### 12-field auto-approval rule

A patch is auto-approved if AND ONLY IF **every field** in
the policy's `auto_approval` block is satisfied. The 4
"blocker" fields (`require_human_for_protected_paths`,
`require_human_for_first_pr_to_file`,
`cool_off_after_revert_hours`, the rate limits) are the
safety net. The 6 "threshold" fields
(`max_risk_score`, `max_lines_changed`, `max_files_changed`,
`min_quality_score`, `min_rca_confidence`, the
`max_blast_radius_score` from the outer policy) are the
user's knobs. The 2 "mode" fields (`enabled`,
`dry_run_mode`) are the master switch + the safety preview.

The default values are conservative — auto-approvals only
fire for genuinely small, low-risk, high-quality patches.

## Failure modes & guardrails

The Cat 23 v1.6 STUB checklist enumerates the 4 hard gates
that must each pass before the next gate starts. **No gate
is allowed to slip — if a gate is at risk, the cat is
paused, not relaxed.** The 4 hard gates are:

* **Gate 1: read-only connectivity** (weeks 25-26) —
  `RepoConnector` + `CodeChangePolicyService` + CODEOWNERS
  parser. The cat graduates from STUB v0 to "Gate 1
  complete, real ship in progress".
* **Gate 2: attribution accuracy** (week 26) —
  `CodeRootCauseLinker` + `BlastRadiusAnalyzer` (static
  + dynamic). A Cat 2 RCA with `category=rate_limiter` and
  `confidence > 0.7` resolves to the right source file 80%
  of the time on a 100-trace golden set.
* **Gate 3: sandbox safety** (week 27) — `TestPlanRunner`
  + sandbox isolation hardening. **Red-team review by a
  dedicated security engineer.** The sandbox worker is a
  stripped container with no network access except to the
  GitHub API + the Eden control plane.
* **Gate 4a: manual end-to-end** (weeks 28-29) —
  `PatchGenerator` + `TestPlanRunner.run` + `PRCreator`
  (manual trigger only). A user-triggered "Propose code fix"
  + "Open PR" flow opens a real PR against a test repo. The
  PR passes the org's CODEOWNERS review. **NO auto-create,
  NO auto-revert.**
* **Gate 4b: manual revert end-to-end** (week 30) —
  `PostMergeMonitor` + `AutoRevertEngine` (manual revert
  only). A merged PR is monitored at 1h/6h/24h/7d windows;
  if the org admin clicks "Revert" in the portal, the
  3-strategy reverter runs successfully. **NO auto-revert.**
* **Gate 5: knowledge graph** (week 31) —
  `CodebaseKnowledgeGraph` + opt-in policy enforcement.
  The knowledge graph records every patch + every revert;
  the 3 read-paths return the right prior patch on the
  100-trace golden set.
* **Gate 6: auto-mode end-to-end** (week 32) — auto-mode
  opt-in (`auto_pr_enabled` + `auto_revert_enabled`). A
  tenant with both opt-ins experiences the full
  end-to-end self-healing loop on a synthetic Cat 2 RCA +
  a synthetic post-merge regression; the loop fires
  within 24h and the revert is recorded.

### Why 4 hard gates and 8 weeks

Cat 23 is the only cat in the roadmap that touches a
customer's production repo. A bad ship could (a) open PRs
the org didn't ask for, (b) revert a fix that was working,
(c) leak secrets in a generated diff, or (d) consume the
org's CI budget in a runaway loop. Each gate is a separate,
auditable exit criterion that requires sign-off from (i)
the engineer who wrote the gate's code, (ii) a senior
reviewer, and (iii) a dedicated security engineer. **Gate 3
(sandbox safety) cannot be skipped and cannot be relaxed
even under time pressure.**

### The two-stage opt-in (mirrors v1.4 LLM-as-judge)

* **Per-tenant:** `code_change_enabled` (the master switch;
  default `false`).
* **Per-tenant + per-stage:** `auto_pr_enabled` +
  `auto_revert_enabled` (the two-stage opt-in; both default
  `false`).
* **Per-tenant + per-action:** the 5 most-consequential
  action fields (`max_blast_radius_score`,
  `min_rca_confidence`, `min_test_pass_rate`,
  `protected_paths`, `protected_branch_patterns`) ship with
  safe defaults but are tenant-editable in Settings.

The STUB surface enforces the two-stage opt-in at every
entry point. The `_check_two_stage_optin` helper in
`eden/code_change/_common.py` is the single chokepoint.

## Telemetry

The 8 core tables + the 11 support tables persist the
Cat 23 events. The closed-loop hooks are:

* `CodeChangeHook.propose_patch_from_rca` — fires from the
  Cat 2 RCA scorer when a high-confidence RCA is detected.
  STUB mode: records the recommendation (advisory only).
  Real Gate-1 mode: additionally calls into
  `CodeRootCauseLinker` + `PatchGenerator` once
  `code_change_enabled` is true.
* `CodeChangeHook.post_merge_degraded` — fires from the
  `PostMergeMonitor` when a post-merge regression is
  observed. STUB mode: records the recommendation. Real
  Gate-4b mode: additionally calls into `AutoRevertEngine`
  once `auto_revert_enabled` is true.

The `AgentActivityFeed` is the public visibility surface
for the agent's actions:

* `patch_proposed` / `patch_approved` / `patch_denied` /
  `patch_edited` / `patch_pr_opened` / `patch_merged` /
  `patch_reverted` / `trace_diagnosed` /
  `style_profile_learned` / `auto_approval_rate_limited`.

## Test plan

The v1.6 STUB verification checklist (per the master doc)
requires 30+ STUB tests. The shipped test file
`tests/intelligence/test_autonomous_code_modification_stubs.py`
has 73 tests covering:

* Package re-exports (5 tests) — all 25 public names resolve
  via PEP 562 lazy `__getattr__`.
* Service-class shape (3 tests) — every service has the
  right `name` attribute + at least one async method.
* Read-only routes (8 tests) — the 8 read-only service
  methods return the live envelope with the right shape.
* Destructive routes (5 tests) — the 5 destructive service
  methods return the not-implemented envelope with the
  right `gate=<N>_blocked` marker.
* Two-stage opt-in (5 tests) — the opt-in gate is enforced
  BEFORE any side-effect, with the right `optin_blocked` /
  `auto_mode_blocked` markers.
* Auto-approval rules (5 tests) — the 12-field policy
  evaluates correctly (master switch, threshold, safety net).
* CodeChangeHook (4 tests) — the hook is registered,
  `propose_patch_from_rca` + `post_merge_degraded` are
  callable, `ACTION_KIND` includes the new entries.
* Route smoke (3 tests) — the router has 24+ routes, the
  inbox list endpoint is mounted.
* Diff-parsing helpers (4 tests) — `diff_line_count`,
  `diff_files_changed`, `diff_hunk_count` parse unified
  diffs correctly.
* PR quality scorer (4 tests) — the inline-computable
  dimensions (security, complexity) work, the
  sandbox-dependent dimensions return the blocked envelope.
* Umbrella flag (2 tests) — `intelligence_gap_v0` still
  gates the surface, no regressions in adjacent suites.
* Migration (2 tests) — revision is 027, down_revision is
  026, upgrade + downgrade are callable.

The 73 tests run in ~1.3s. The broader `tests/intelligence/`
suite runs in ~8.6s with 1170 tests passing + 1 skipped
+ 0 new regressions (the 1 pre-existing date-pinned RCA
failure is unrelated to this cat).

## Acceptance criteria

The v1.6 STUB surface (shipped 2026-06-12) meets all 9
items in the v1.6 STUB verification checklist:

* ✅ All 21 service classes are importable from
  `eden.code_change` and its sub-packages.
* ✅ 19+ routes are registered under
  `intelligence_code_change` (24 unique paths; the 8 inbox
  actions share one `POST /inbox/{patch_id}/{action}`
  path).
* ✅ Migration 027 applies: 19 new tables (8 core + 4
  approval + 3 auto-approval + 4 inbox/persona/style/quality)
  with the unique indexes + the per-org time-series indexes.
* ✅ 73 STUB tests pass in ~1.3s.
* ✅ Lint clean: no import errors, all module imports
  verified, the existing `intelligence_gap_v0` umbrella
  flag still gates the surface.
* ✅ Two-stage opt-in enforced: every STUB endpoint reads
  `code_change_enabled` BEFORE the auto-mode gates
  (`auto_pr_enabled`, `auto_revert_enabled`); no endpoint
  auto-creates a PR or auto-reverts without both opt-ins.
* ✅ Closed-loop hook registered: the
  `CodeChangeHook.propose_patch_from_rca` method is
  registered in `register_all_hooks()` and is callable from
  the Cat 2 RCA scorer (no-op in STUB mode — logs the call,
  doesn't actually generate a patch).
* ✅ Sandbox worker not yet wired: the STUB surface does NOT
  instantiate the sandbox worker; the `TestPlanRunner`
  returns a `not_implemented` envelope with a
  `gate=3_blocked` marker.
* ✅ No regressions: the existing `intelligence_gap_v0`
  flag still gates the surface; the 1170 existing
  intelligence tests pass + 1 skipped (the 1 pre-existing
  date-pinned RCA failure is unrelated).

## The 4-gate rollout plan

Cat 23 is the deepest closed-loop in the roadmap and the
only cat that introduces a *physical* side effect (a real
commit to the customer's real repo). The ship plan is
structured around 4 hard gates that must each pass before
the next gate starts. **No gate is allowed to slip — if a
gate is at risk, the cat is paused, not relaxed.**

| Week | Track | Exit criterion | Gate |
|---|---|---|---|
| 25 | Cat 23a — `RepoConnector` + `CodeChangePolicyService` + CODEOWNERS parser | Eden can register a GitHub repo, read CODEOWNERS, and enforce the two-stage opt-in policy; the 4 read-only routes (repos, policy) return the live envelope | Gate 1 |
| 26 | Cat 23b — `CodeRootCauseLinker` + `BlastRadiusAnalyzer` (static + dynamic) | Cat 2 RCA with `category=rate_limiter` and `confidence > 0.7` resolves to the right source file 80% of the time on a 100-trace golden set | Gate 2 |
| 27 | Cat 23c — `TestPlanRunner` + sandbox isolation hardening | Sandbox worker is a stripped container with no network access except to the GitHub API + the Eden control plane; `pass_rate` matches the customer's local CI within 2% on 10 sample repos; **red-team review by a dedicated security engineer** | Gate 3 |
| 28-29 | Cat 23d — `PatchGenerator` + `TestPlanRunner.run` + `PRCreator` (manual trigger only) | A user-triggered "Propose code fix" + "Open PR" flow opens a real PR against a test repo; the PR passes the org's CODEOWNERS review; **NO auto-create, NO auto-revert** | Gate 4a |
| 30 | Cat 23e — `PostMergeMonitor` + `AutoRevertEngine` (manual revert only) | A merged PR is monitored at 1h/6h/24h/7d windows; if the org admin clicks "Revert" in the portal, the 3-strategy reverter runs successfully; **NO auto-revert** | Gate 4b |
| 31 | Cat 23f — `CodebaseKnowledgeGraph` + opt-in policy enforcement | The knowledge graph records every patch + every revert; the 3 read-paths return the right prior patch on the 100-trace golden set | Gate 5 |
| 32 | Cat 23g — Auto-mode opt-in (`auto_pr_enabled` + `auto_revert_enabled`) | A tenant with both opt-ins experiences the full end-to-end self-healing loop on a synthetic Cat 2 RCA + a synthetic post-merge regression; the loop fires within 24h and the revert is recorded | Gate 6 |

## Open questions

10 open questions (per the v1.6 cat spec), awaiting scope
alignment:

1. **Path-glob → risk-level map** (v2) — currently the
   policy has a `path_risk` boolean (low if not in
   `protected_paths`, else high). The v2 ship will add a
   glob → risk-level map (e.g. `src/payments/**` = "p1"
   risk, `src/utils/**` = "p3" risk).
2. **Auto-approval for first-PR-to-file** — the current
   default is `require_human_for_first_pr_to_file=true`.
   The v2 ship will add a "graduation" path (e.g. after 5
   approved PRs to the same file, the agent can auto-approve
   the 6th).
3. **Multi-org CODEOWNERS inheritance** — the v1 ship
   reads CODEOWNERS from the connected repo. The v2 ship
   will add org-level CODEOWNERS (e.g. for the
   security-team-reviewer mapping).
4. **Post-merge window for non-LLM code** — the 4-window
   schedule is optimised for LLM-app telemetry. The v2
   ship will add a 4-window schedule for non-LLM code
   (e.g. API latency + error rate).
5. **Knowledge graph retention** — the v1 ship keeps the
   graph forever. The v2 ship will add a per-org retention
   policy (e.g. drop nodes older than 1 year with no
   activity).
6. **Auto-approval cross-team visibility** — the current
   audit log is per-org. The v2 ship will add a
   cross-team dashboard ("which teams are using
   auto-approval? what % of PRs are auto-approved? what
   % are reverted?").
7. **Sandbox resource limits per tenant** — the v1 ship
   uses the global `SANDBOX_CPU_LIMIT` /
   `SANDBOX_MEMORY_MB` / `SANDBOX_WALL_CLOCK_SEC`. The v2
   ship will add per-tenant overrides (e.g. enterprise
   tenants get 4 CPU + 8 GB + 30 min).
8. **CODEOWNERS for monorepos** — the v1 ship reads
   CODEOWNERS from the repo root. The v2 ship will add
   per-path CODEOWNERS (e.g. for monorepos with multiple
   teams).
9. **Revert PR labels** — the current revert PR doesn't
   carry the "auto-revert" label. The v2 ship will add a
   separate "auto-reverted" label so the portal can show
   "this PR was auto-reverted" vs "this PR was manually
   reverted".
10. **Multi-PR batching** — the v1 ship opens one PR per
    patch. The v2 ship will add a "batching" mode (e.g.
    10 small patches in the same file → 1 batched PR with
    10 commits) for power-users.

## Cross-references

* **Master doc:** `docs/observability/gap-roadmap.md`
  (Cat 23 — lines 1821-3210)
* **STUB package:** `src/eden/code_change/` (21 service
  classes + 6 sub-packages)
* **STUB router:** `src/eden/api/routes/intelligence_code_change.py`
* **STUB migration:** `src/eden/db_migrations/versions/027_autonomous_code_modification.py`
* **STUB hook:** `CodeChangeHook` in
  `src/eden/llmops/promotion_hooks.py`
* **STUB tests:** `tests/intelligence/test_autonomous_code_modification_stubs.py`
  (73 tests)
* **Mount block:** `src/eden/api/app.py` (line 234)
* **Adjacent cats:** Cat 14 (Autonomous Intelligence — the
  investigation half), Cat 17 (Closed-Loop Wiring — the
  hook surface), Cat 2 (RCA — the upstream RCA source),
  Cat 16 (Decision Intelligence — the decision-path source),
  Cat 12 (Experimentation + Simulation — the
  stratified-by-event-type replay + A/B test infrastructure),
  Cat 13 (Predictive + Drift — the upstream drift detector
  the post-merge monitor reuses).
* **SLM Initiative (v1.4 dependency):**
  `docs/observability/judge-v2-plan.md` — the
  `PatchGenerator`'s SLM-reads-the-code step requires the
  v1.4 SLM. Without the SLM, the cost per patch is
  $0.15-$0.40 and the daily budget cap
  (`max_cost_per_patch_usd = $5`) is exhausted by 12-30
  patches. With the SLM, the read step is $0.005 and the
  daily budget supports 1,000+ patches. **Cat 23 is gated
  on the SLM Initiative.**
