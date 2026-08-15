# Pass 4 notes — F13 (continuous-improvement-loop.md) — Agent B (UX/Value)

**Read first:** the current doc (`features/13-continuous-improvement-loop.md`, 223 lines,
three prior passes) is entirely about one mechanism — the shadow-detector
confirm/dismiss loop (`soft_issue_review.py`, `nl_signals`, `resolve_profile`).
It contains **zero** mentions of `improvement/`, `guardian.py`, `test_gate.py`,
`auto_merge.py`, or `nudges/`. Per `KNOWN-SUBSYSTEMS.md:33-39`, `improvement/`
is "much bigger than the soft_issue_review.py shadow-detector loop covered in
F13 — the two appear complementary... but F13 needs to fold this in." Three
passes have not done this. My assignment (ground the UX/value section in
`guardian.py`/`test_gate.py`) is therefore net-new territory the doc has never
covered — see NEW FINDINGS #1. Everything in the USER EXPERIENCE & VALUE
section below is written against `improvement/` + `closed_loop/autonomy_policy.py`
+ the live `/improve` portal surface, not against the doc's existing shadow-detector
content (which Agent A is fact-checking independently).

---

## USER EXPERIENCE & VALUE

### The trust problem, stated precisely

Eden's `improvement/` subsystem is a real closed loop: an issue clusters from
production failures → `PatchGenerator` drafts a `code_patch` plan → a human
(or, on a narrow canary ladder, Eden itself) approves it → a PR opens and
merges → a post-merge verify check runs → if it fails, `guardian.py` decides
between drafting a revert or a follow-up fix, and on a specific class of merges
can execute that revert itself. Every step from patch generation to merge to
revert can be autonomous. That is exactly the shape of system an eng team
should be *structurally* suspicious of — an LLM that can write code, merge it,
and undo it, unsupervised — so the interesting question isn't "does the loop
work" (Agent A is verifying that) but **what makes an eng team willing to flip
this on for anything past the most reversible tier, and what do they actually
see when it acts.**

Eden's answer, verified against the real code and the real portal, is a
**graduated-autonomy ladder with a matching review surface at every rung** —
not a single trust switch. It's more built-out than the doc's current
"detector loop" framing would suggest, but it also has specific, findable gaps
that matter more here than almost anywhere else in the product, because the
blast radius of a false "trust me" is a bad merge to production code.

### 1. The autonomy ladder is the actual trust scaffold, not a marketing claim

`src/eden/closed_loop/autonomy_policy.py:49-73` defines a five-tier action
ladder (`_ACTION_TIERS`), mirroring what the code calls "the N22 spec's graded
ladder (T0 observe → T4 auto-merge)":

- **T0/T1 (observe)** — alert, recommend, investigate, triage. Always allowed;
  `decide()` returns `"allow"` unconditionally for tier ≤ 1 (`:232-233`).
- **T2 (reversible)** — `rollback`, `reweight`, `cache_bust`, `self_heal`
  (bucketed under `auto_runtime_heal`) and `propose_patch`/`code_change`
  (bucketed under `auto_code_patch_pr`).
- **T3** — prompt canaries, nudge/guardrail promotion.
- **T4 (highest blast radius)** — `code_patch_merge` / `auto_merge`, gated on
  `auto_code_patch_merge`.

The defaults (`AutonomousMaintenancePolicy`, `:76-92`) are deliberately
asymmetric: `auto_runtime_heal: bool = True` (reversible actions execute by
default — "Settings is opt-out," per the class docstring) but
`auto_code_patch_pr: bool = False` and `auto_code_patch_merge: bool = False`
(code changes and merges are opt-*in*). `effective_mode()` (`:94-98`) adds a
hard compliance override: HIPAA orgs are pinned to `"observe"` regardless of
what the org set. This is the right default posture for a UX/value read — the
product doesn't ask a team to trust the scariest capability first; it trusts
them with reversible actions by default and makes T2 (patch PR) and T4
(auto-merge) explicit opt-ins per org, with a distinct HIPAA kill-switch that
can't be overridden from the UI.

`decide()` (`:222-262`) itself is a clean, auditable state machine: in
`"assisted"` mode (the default sits between `observe` and `autonomous`),
`auto_code_patch_pr`/`auto_code_patch_merge`/`auto_nudge_promote`/
`auto_guardrail_promote` all return `"require_approval"` **before** the
fine-grained flag is even checked (`:250-256`, with an explicit comment
explaining why: drafting a plan has no repo side effect, so a human Approve is
the real gate, and the flag shouldn't silently deny every patch draft in
assisted mode). This is the mechanism that makes "propose but don't act"
actually true at the code level, not just at the marketing level — worth
citing directly if this doc keeps any "is eden autonomous or advisory"
framing.

### 2. What an org admin actually configures, and what they see back

`clients/portal/src/lab/settings/autonomy-settings-card.tsx` is a real,
API-wired settings panel (`api.getAutonomyPolicy` / `api.patchAutonomyPolicy`),
not a mockup: a single toggle for `auto_runtime_heal` with copy that states the
concrete consequence of turning it on (`"Reversible actions only · max {N}
rollbacks/day"`, `:44-51`) and turning it off (`"Eden will recommend heals
instead of executing them"`). The card also surfaces `maintenance_mode`,
`compliance_profile` (when non-standard), and the day's budget spend
(`$X of $Y budget today`) inline (`:88-104`).

Paired with it, `autonomy-audit-card.tsx` is a **read-only ledger** —
"Recent allow / deny decisions for runtime heals and maintenance actions"
(`:66-69`) — plus the day's budget (`spent_usd`/`limit_usd`, "paused" when
over), patches-used-today/max-per-day, and a **suppressed-decision count**
("N budget denials today," `:84-90`). This is a materially important UX
primitive: an org can see not just what Eden *did* but what it *refused to do
and why* (budget exhaustion specifically), which is the difference between "a
black box that sometimes acts" and "a system whose restraint is visible."

`lab/autonomy-roi-banner.tsx` is the counterfactual-value surface: when
self-heal is off, it renders *"Eden would have fixed {N} reversible heals in
the last 7 days while self-heal was off"* with a direct link to turn it on
(`:43-54`); when the budget is exhausted it separately flags *"Maintenance
budget exhausted today"* with a link to the audit (`:56-67`). This is a
genuinely good adoption mechanic — it converts "I don't trust this yet" into a
concrete, dated cost of *not* trusting it, without ever forcing the toggle.
It's also honest in the failure direction: it fails soft (`if (!policy ||
policyQuery.isError) return null;`, `:25`) rather than showing a broken
counter.

### 3. Reviewing a proposed patch — the actual flow, not the aspirational one

The live `/improve` page (`clients/portal/src/app/(portal)/improve/page.tsx`)
renders, for `mode=plan`, both `ImprovePlanView` (diff + Approve/Reject) and
`PlanDetailEnrichment` (evidence panel + status history + impact preview) on
the same screen (`page.tsx:433-458`) — this is one real, coherent review
surface, not two disconnected prototypes; `/improve/plans/[id]` is just a
redirect into the same page (`app/(portal)/improve/plans/[id]/page.tsx:5-20`).

What a reviewer sees, concretely:

- **The diff itself** — `DiffPane` renders the unified diff, or a before/after
  split when no unified diff exists (`improve-plan-view.tsx:242-250`).
- **"Why"** — the RCA text, falling back to "Root cause is attached to the
  linked issue" (`:154-157`).
- **Regression-follow-up provenance** — when a plan has a `parentPlanId`
  (i.e., it's a guardian-drafted revert or follow-up), the UI says exactly
  that: *"Eden's post-merge guardian drafted this after the original fix
  regressed"* with a link to the original plan (`:163-176`). This is the
  concrete answer to "how do I see why something got auto-reverted" at the UI
  layer — the causal chain is a first-class, explicit link, not something you
  have to reconstruct from timestamps.
- **Evidence chips** (`plan-evidence-panel.tsx:95-165`) — evidence tier
  (`replay`/`tested`, the same tiers `auto_merge.py`'s `_ELIGIBLE_TIERS` checks
  at `auto_merge.py:32`), static-check status, **sandbox test status with an
  explicit "(synthesized)" suffix** when the test that ran was LLM-authored
  rather than discovered from the repo (`:115-119`), CI status, severity, and
  a numeric confidence percentage. When none of that exists the panel says so
  plainly: *"No evidence attached — this plan was created without a failure
  pack or verification run"* (`:101-105`) — an honest empty state rather than
  a silently blank section.
- **Preview impact — replay before approving** (`plan-impact-preview.tsx`,
  wired live to `POST /orgs/{org}/change-impact/preview`). A reviewer can click
  "Preview impact" and get `traces_replayed`, `trajectory_divergence_rate`,
  `new_predicted_stumbles` (highlighted in the error color when > 0, `:153-161`),
  cost/latency delta, an explicit `recommendation` string colored red/green by
  a regex on "block/reject/no" (`:181-189`), and up to 5 `top_divergences`
  entries. This is a real "dry-run the change against production traffic
  patterns before you click Approve" feature — probably the single strongest
  trust-building mechanism in the whole loop, because it lets a reviewer see
  predicted blast radius instead of trusting the diff's plausibility alone.
  It degrades honestly when the backing flag/store is off (`isFeatureUnavailable`,
  `:41-48`) and is correctly disabled for local (unpersisted) draft plans with
  an explanatory tooltip (`:113-117`).

### 4. What happens when you click Reject — and where the flow quietly loses information

The backend accepts a reason: `POST /plans/{plan_id}/reject` takes a
`RejectRequest` body with `reason: str | None` (`src/eden/api/routes/improve.py:82,190-212`),
and that reason is not just stored — it's classified
(`plans_repo._infer_rejection_type`, `plans_repo.py:584-590`: `"user_fixed"` if
the text contains "user_fixed"/"already fixed", `"outdated"` if it contains
"outdated", else `"wontfix"`) and drives a **different dedupe TTL** per type
(`_rejection_ttl_days`, `:572-581`: 90 days for `user_fixed`, 30 for
everything else, both org-overridable settings) written into
`pr_rejection_memory` (`write_rejection_memory`, `:593-`) so a future sweep
doesn't re-propose a patch the org already rejected. This is a real,
substantive mechanism — reject-with-reason genuinely changes what Eden
proposes next, not just a status flip.

But the live UI never gives the reviewer a reason field. `improvePlansApi.rejectPlan`
accepts an optional third argument (`resources.ts:2976: rejectPlan: (orgId, planId, reason?: string) =>`),
and the call site in the live page is `await improvePlansApi.rejectPlan(orgId, id)`
(`app/(portal)/improve/page.tsx:300`) — no reason passed. The Reject button
itself (`improve-plan-view.tsx:108-117`) is a single click with a tooltip
("Reject permanently via API") and no prompt/textarea. The practical
consequence, traced through `_infer_rejection_type`: every portal-originated
rejection arrives as an empty string, which falls through to the `"wontfix"`
branch and gets a flat 30-day TTL — the richer `user_fixed` (90-day) bucket
that the backend clearly designed for ("I already hand-fixed this, don't
re-suggest it soon") is unreachable from the UI a human reviewer actually
uses. This is a concrete, fixable UX gap directly relevant to trust-building:
the one place a reviewer could explain *why* they don't want Eden's fix, and
have that explanation change Eden's future behavior, is silently discarded.
**This belongs in the doc as a P1 UX fix, not a hypothetical — it's the
literal difference between "the reject reason mechanism exists" (true, in the
backend) and "a reviewer can use it" (false, today).**

### 5. Guardian: what "why did it get reverted" actually looks like

`guardian.handle_regression` (`src/eden/improvement/guardian.py:118-231`) is
triggered from exactly one place — `_on_verify_failed` in
`src/eden/closed_loop/orchestrator.py:271-296` — i.e., the post-merge verify
check the module docstring calls "N01." When it fires:

1. It looks up the merged plan responsible (`_find_merged_plan_for_issue`,
   `:46-79`) and bails cleanly (`{"status": "no_plan"}`) if the regression
   wasn't caused by an Eden PR at all — it does not spuriously attach itself
   to unrelated failures.
2. It checks for an already-open follow-up first (`_existing_follow_up`,
   `:82-103`) specifically so a flapping regression can't spam duplicate
   revert/fix drafts into the queue — a real "don't overwhelm the reviewer"
   guard, not just a dedupe-for-cost reason.
3. **Revert vs. follow-up** is decided by severity (`_REVERT_SEVERITIES =
   {"P0","P1","CRITICAL","HIGH"}`, `:43`) gated by the org's rollback policy
   (`_decide_revert_allowed`, `:106-115`, via `autonomy_policy.decide(...,
   "rollback")` — same T2 tier as runtime heals). A revert is drafted as a
   **real inverted diff**: `invert_unified_diff` on the parent's merged diff,
   statically applied against current HEAD, and only kept if that apply
   passes (`_draft_revert`, `:357-438`); drift or a static failure falls back
   to a follow-up fix with the specific conflict reason recorded in evidence
   (`revert_conflict`, `:534-540`). This is exactly the honesty property you'd
   want from an autonomous revert: it does not fabricate a "clean" revert when
   the codebase has moved on — it tells the human what changed.
4. **Auto-execution is narrower than "canary org, therefore auto-revert."**
   `_maybe_auto_execute_revert` (`:234-298`) only proceeds when the *parent*
   PR is stamped `canary: true` AND `merged: true`
   (`parent_is_canary_auto_merged`, `auto_merge.py:562-572` — an explicit
   stamp is required; a missing key is treated as *not* canary, "avoids
   accidental auto-revert on non-canary merges" per the code comment) AND
   `auto_revert_permitted` passes (its own independent check of
   `auto_revert_enabled`, feature-kill, compliance profile, and
   `auto_code_patch_merge`, `auto_merge.py:575-599`). Any merge a human
   approved manually — the overwhelming majority of merges, since
   `auto_code_patch_merge` defaults `False` — always waits for a human Approve
   on its revert too. The auto-revert path reuses `approve_plan` with
   `approved_by="eden:guardian_auto_revert"` (`guardian.py:284-288`), so the
   human-readable audit trail (`PlanStatusHistory`'s "Approved · by …") shows
   a distinguishable synthetic actor, not a spoofed human name.
5. Only genuine revert/auto-revert actions write knowledge-graph `"reverted"`
   history (`:192-201`, explicitly to avoid follow-up drafts inflating
   `kg_revert_history` and falsely blocking future auto-merges on unrelated
   files — see §6).
6. A Slack alert always fires (`notify_regression`, `:203-216`), deep-linked
   to the issue, regardless of which path was taken.

**Where does a human actually see this?** The plan record itself carries the
full causal chain (`parent_plan_id`, `evidence.guardian_action`,
`evidence.verify_detail`, `evidence.revert_conflict` when applicable), and the
portal renders the parent link (§3 above). What it does *not* render: the
`AutoMergeDecision.reasons`/`blocked_by` structure that `auto_merge.py`
produces (see §6) is written into `evidence.auto_merge` but never read for
`reasons`/`blocked_by` anywhere in the portal (`plan-evidence-panel.tsx` only
reads `ev.auto_merge.ci_status`/`status`, `:78-83`) — so a reviewer looking at
a plan that *didn't* auto-merge has no UI-visible answer to "why not," only
the raw evidence JSON if they go looking. See NEW FINDINGS.

### 6. The canary auto-merge ladder — the part that actually merges code without a human

`auto_merge.py`'s module docstring is unusually candid about where this
capability actually stands: *"DARK by default: requires N22 T4
`auto_code_patch_merge=True` plus every eligibility gate below. Customer offer
stays process-gated until dogfood proves 5 consecutive auto-merges with zero
guardian regressions"* (`:1-5`). That's a real, named bar for turning this on
for customers, not just an internal flag — a genuinely trust-appropriate
rollout gate to cite if this doc discusses maturity/readiness.

`evaluate_auto_merge_eligibility` (`:385-526`) is a linear, all-must-pass gate
chain, and — this matters for the UX argument — **every rejection reason is
distinct and machine-readable**: `feature_killed:auto_merge`,
`compliance:{profile}`, `auto_code_patch_merge=False`,
`evidence_tier:{tier|missing}`, `diff_over_soft_cap:{lines}>{soft}`,
`kg_revert_history`, `weekly_cap:{used}>={cap}`,
`auto_merge_blocked:branch_protection`. Concretely, the ladder requires:
evidence tier ∈ `{replay, tested}` (not just "generated" — the patch needs to
have actually run against something); diff size under a soft cap
(`patch_max_diff_lines_soft`, default 200); the touched files have **zero
prior-revert history** in the knowledge graph (`_kg_has_revert_history`,
`:320-336` — a file Eden has had to revert before doesn't get to ride the
auto-merge lane again); a weekly volume cap (default 2/org,
`_default_weekly_cap`, `:75-81`, org-overridable) enforced via an **atomic
`pg_advisory_xact_lock`-backed slot claim** (`claim_auto_merge_slot`,
`:139-`) specifically to close a TOCTOU race between two concurrent
approvals; and repo branch-protection allowing the GitHub App to merge, with a
fail-closed default (`check_branch_allows_app_merge`, `:362-382` — no
protection-check hook on the provider means "assume blocked," not "assume
allowed"). Compliance is a hard block, not a policy nudge: `hipaa`/
`soc2_strict` orgs are excluded from `_ELIGIBLE_TIERS` entirely (`:34-35`,
`:431-437`), independent of what the org's autonomy toggle says.

This is, structurally, a well-designed set of guardrails for the single
highest-blast-radius action in the product. The gap is not in the mechanism —
it's that none of the *reasoning* it produces (the `reasons`/`blocked_by`
list) currently reaches the human who'd want to see it.

### 7. The test gate — the quiet, load-bearing trust primitive

`test_gate.py` doesn't have a portal surface of its own beyond the "sandbox
tests: {status} (synthesized)" chip (§3), but it's worth treating as a
first-class trust mechanism because of how carefully it's built to never lie:

- **Discovery is free and deterministic** — naming-convention globs only, no
  LLM (`discover_candidate_tests`, `:214-246`), capped at 3 tests
  (`MAX_CANDIDATE_TESTS`, `:40`).
- **Environment failures are never reported as test failures.** A large,
  explicit marker list (`_ENV_ERROR_MARKERS`, `:53-70` — `ImportError`,
  `ModuleNotFoundError`, npm `Cannot find module`, Go `cannot find package`,
  etc.) plus per-language pytest exit-code interpretation
  (`interpret_sandbox_result`, `:340-379`) routes "couldn't run this" to
  `skipped:env_unavailable`/`skipped:no_tests_collected`/`skipped:timeout` —
  only a genuine non-zero exit with no environment marker becomes
  `status="failed"`. This is exactly the honesty property a reviewer needs:
  a green chip means the patch was actually exercised, not "the harness
  happened to not crash."
- **The self-validating-patch trick is explicitly closed**: if the patch
  itself touches the discovered test file(s), those tests are excluded
  (`:434-440`, `patch_touches_tests` skip) — a patch can't rewrite the test
  that's supposed to catch it and then pass trivially.
- **LLM-synthesized tests are default OFF** (`test_gate_synthesis_v1`,
  `:127-143`), and the module docstring states the reasoning plainly: *"LLM-
  authored tests in customer PRs are a trust risk until dogfood review, and
  executing LLM-authored code raises the injection stakes"* (`:16-19`). When
  it is on, synthesis is Python-only, capped at one LLM call via a shared
  sweep budget (`try_consume_llm_call`, `sweep_budget.py:67-81`), and —
  critically — **mandatory network isolation** for the executed test
  (`require_isolation=synthesized`, `run_test_gate` → `run_in_sandbox`,
  `test_gate.py:511`; unavailable isolation skips rather than runs unisolated,
  `:353-354`). This is a well-reasoned, conservative default for the one place
  in the loop where Eden would be both generating *and judging* code.

### Where this leaves the trust argument

Put together, eden's actual answer to "how do you trust an autonomous
patch-and-revert loop" is not one mechanism but four layered ones: (1) a
graduated permission ladder that defaults reversible-on, everything-else-off,
with a hard compliance override; (2) a review surface that shows evidence
tier, test results (honestly labeled, including when synthesized), and a
literal dry-run/replay of the change against production traffic before
Approve; (3) an auto-merge ladder so narrow it requires a named internal bar
(5 consecutive clean auto-merges) before it's even offered to customers, with
every gate individually machine-readable; and (4) a guardian that reverts
conservatively (never fabricating a revert against a drifted codebase) and
only self-executes on the exact canary class whose original merge already
proved itself. That is a genuinely strong design for the trust problem this
feature poses. The places it currently falls short are narrow and fixable,
not structural: the reject-reason field never reaches the reviewer (§4), the
`blocked_by`/`reasons` explanation for "why didn't this auto-merge" is
computed but not rendered (§6/NEW FINDINGS), and the plan-detail "status
history" is an explicitly-labeled derived timeline rather than a real
per-plan event log (`plan-status-history.tsx:1-10`: *"the improve API has no
plan event-history endpoint... this renders a derived timeline from the plan
record"*) — meaning approve/reject/snooze show up, but intermediate guardian
decisions, sweep attempts, or auto-merge-eligibility re-evaluations do not
have a durable, user-visible audit log distinct from the evidence blob. For a
feature whose entire value proposition rests on "you can see what it did and
why," a first-class append-only plan event log (not derived from mutable
status columns) is the single highest-leverage UX investment left.

**Recommended priority for a UX-focused follow-up (not re-deriving the P0/P1
wiring priorities Agent A is independently verifying):**

1. **P1 — Capture reject reason in the live UI.** Smallest possible fix
   (prompt/textarea before calling `rejectPlan(orgId, id, reason)`), directly
   unlocks the `user_fixed` 90-day dedupe bucket that already exists
   server-side and is currently unreachable.
2. **P1 — Surface `AutoMergeDecision.reasons`/`blocked_by` on the plan
   detail page.** The data already exists in `evidence.auto_merge`; this is a
   rendering gap, not a backend gap.
3. **P2 — A real per-plan event log**, not a derived-from-status-fields
   timeline, so guardian decisions, sweep/re-approval attempts, and
   auto-merge re-evaluations are auditable independent of the current status.
4. **P2 — Surface the `improvement/` autonomous loop in this doc at all.**
   See NEW FINDINGS #1 — this is a scope, not a UX, fix, but it blocks any
   reader of this doc from getting the picture above without independently
   reading `improvement/`.

---

## VERIFIED

- `improvement/`, `nudges/` exist as real subsystem directories with
  substantial code (`improvement/`: 15 files, ~9,767 lines;
  `nudges/`: 9 files, ~934 lines) — confirmed via `ls`/`wc -l`, matches
  `KNOWN-SUBSYSTEMS.md:33-39,46-54`.
- `guardian.py`'s `handle_regression` is triggered exactly once, from
  `closed_loop/orchestrator.py:271-296` (`_on_verify_failed`), consistent with
  the guardian module docstring's "post-PR" framing
  (`guardian.py:1-33`).
- `parent_is_canary_auto_merged` requires an explicit `canary: true` AND
  `merged: true` stamp — a missing key is treated as not-canary
  (`auto_merge.py:562-572`), confirmed by reading the function body directly.
- `auto_code_patch_pr` and `auto_code_patch_merge` both default to `False`;
  `auto_runtime_heal` defaults to `True` (`closed_loop/autonomy_policy.py:76-92`).
- HIPAA orgs are pinned to `"observe"` regardless of stored mode
  (`autonomy_policy.py:94-98`, `effective_mode`).
- `evaluate_auto_merge_eligibility` gate order and exact reason strings
  (`feature_killed:auto_merge`, `compliance:{profile}`,
  `auto_code_patch_merge=False`, `evidence_tier:...`,
  `diff_over_soft_cap:...`, `kg_revert_history`, `weekly_cap:...`,
  `auto_merge_blocked:branch_protection`) — read directly from
  `auto_merge.py:385-526`.
- `claim_auto_merge_slot` uses `pg_advisory_xact_lock` to close a TOCTOU race
  on the weekly cap (`auto_merge.py:139-`, function docstring + body).
- `test_gate.py`'s environment-error marker list and the pytest exit-code
  interpretation (`interpret_sandbox_result`, `test_gate.py:340-379`) route
  environment failures to `skipped`, never `failed`.
- Synthesis-off-by-default and mandatory network isolation for synthesized
  tests, confirmed in both the module docstring (`test_gate.py:16-23`) and the
  code (`require_isolation=synthesized` at the `run_in_sandbox` call,
  `:505-512`; `no_isolation` skip at `:353-354`).
- `discover_candidate_tests` excludes the patch's own touched files from being
  run as its self-test (`test_gate.py:434-440`).
- `POST /plans/{plan_id}/reject` accepts `RejectRequest.reason`
  (`improve.py:82,190-212`) and it's classified/TTL'd via
  `plans_repo._infer_rejection_type`/`_rejection_ttl_days`
  (`plans_repo.py:572-590`).
- The live portal call site never passes a reason:
  `improvePlansApi.rejectPlan(orgId, id)` at
  `app/(portal)/improve/page.tsx:300`, and the `rejectPlan` client signature
  accepts an optional third `reason` argument
  (`lib/api/resources.ts:2976`) that goes unused there. The Reject button
  (`improve-plan-view.tsx:108-117`) has no reason input.
- `plan-status-history.tsx`'s own top-of-file comment states the API has no
  plan event-history endpoint and the component derives a timeline from plan
  fields (`plan-status-history.tsx:1-10`).
- `plan-evidence-panel.tsx` reads `ev.auto_merge` only for `ci_status`/`status`
  (`:78-83`); a repo-wide grep for `blocked_by` across
  `clients/portal/src/**/*.{ts,tsx}` (excluding tests) returns no matches —
  `AutoMergeDecision.reasons`/`blocked_by` is not rendered anywhere in the
  portal.
- `plan-impact-preview.tsx` is wired live to
  `POST /orgs/{org}/change-impact/preview` (via `changeImpactApi.preview`,
  `:77-83`), gated by `change_impact_preview_v1`, and degrades to an
  explanatory placeholder on 403/404/503 (`isFeatureUnavailable`, `:41-48`).
- `AutonomyRoiBanner` renders the "would have fixed N reversible heals" copy
  only when self-heal is off and `would_have_healed_count > 0`, or when the
  budget is paused; fails soft on query error
  (`lab/autonomy-roi-banner.tsx:25,32-33`).
- `AutonomyAuditCard` surfaces a real allow/deny ledger plus
  `suppressed_count` (budget denials) via
  `api.getAutonomyAudit`/`api.getAutonomyBudget`
  (`lab/settings/autonomy-audit-card.tsx:31-43,84-90`).
- A grep for "nudge" (case-insensitive) across `clients/portal/src/**/*.tsx`
  returns zero matches outside `lib/api/resources.ts` type definitions —
  `nudges/`'s promote/demote/shadow-log lifecycle has no operator-facing
  portal surface at all, unlike `improvement/`'s Improve queue.
- Neither `features/15-artifacts-behavior-record.md` nor
  `features/16-issue-extraction-online-evals.md` mentions `improvement/`,
  `guardian.py`, `test_gate.py`, or `auto_merge.py` (grep, zero hits in both
  files) — the improvement/patch-merge-revert loop is absent from all three
  adjacent docs, not just this one.

## CUT (quote + reason)

- No text is proposed for outright deletion from the current doc body — the
  existing content (shadow-detector wiring plan, migration diff, Task 1/Task 2
  analysis) is accurate to what it covers and is Agent A's fact-check
  territory, not a UX/value redundancy issue. My CUT candidates are about
  *framing*, not content:
  > "This doc stays focused on eden's own feedback-loop mechanics..." (line 11)
  This line, as written, is only true if "feedback-loop mechanics" is read
  narrowly as "the shadow-detector loop." As the doc's own title
  ("Closing eden's production-data → detection feedback loop") and its
  position as the flagship F13 doc suggest a broader "continuous improvement
  loop" scope that KNOWN-SUBSYSTEMS.md explicitly says should include
  `improvement/`, this line should either be corrected to scope the doc
  honestly (e.g., "this doc covers eden's detection feedback loop; eden's
  separate autonomous patch/merge/revert loop, `improvement/`, is covered in
  [new section / new doc]") or the doc should be expanded per NEW FINDINGS #1.
  Leaving it as-is risks a synthesis pass concluding F13 is complete when a
  whole confirmed subsystem is unaddressed.
- No redundancy found worth cutting between this doc and 15/16 — both
  explicitly defer to F13 for the `record_shadow_feedback` wiring rather than
  re-deriving it (`15-artifacts-behavior-record.md:5`: *"This doc is
  downstream of `13-continuous-improvement-loop.md`, not a duplicate of it"*;
  `16-issue-extraction-online-evals.md:14-16`: *"does not duplicate...
  `13-continuous-improvement-loop.md` (which fully owns the
  `record_shadow_feedback` wiring plan — cited here, not re-derived)"*). This
  cross-referencing discipline is good and should be preserved, not flagged as
  filler.

## NEW FINDINGS

1. **The doc's scope does not match its evident intent, and this is the
   single most consequential finding of this pass.** `features/13-continuous-
   improvement-loop.md` — despite its title, its position as "the flagship
   finding of the entire strategic review" (line 3), and `KNOWN-SUBSYSTEMS.md`'s
   explicit instruction ("F13 needs to fold this in," `KNOWN-SUBSYSTEMS.md:39`)
   — contains no analysis of `improvement/` (`planner.py`, `auto_merge.py`,
   `guardian.py`, `test_gate.py`, `agent.py`, `issue_patch_trigger.py`,
   `replay_verify.py`, `approve.py`, `plans_repo.py`), which is the actual
   autonomous issue→patch→test→auto-merge→auto-revert loop and — per
   `KNOWN-SUBSYSTEMS.md:34` — "much bigger than the soft_issue_review.py
   shadow-detector loop covered in F13." Three passes have reverified and
   corrected the shadow-detector wiring plan in increasing detail without ever
   touching the larger, arguably more strategically important subsystem this
   doc's title and flagship status imply it owns. Neither `15-artifacts-
   behavior-record.md` nor `16-issue-extraction-online-evals.md` covers it
   either (grep, zero hits) — it is currently undocumented across the entire
   review. Recommend either a fourth section added to this doc covering
   `improvement/` end-to-end (fact-check + UX, mirroring what's in `## USER
   EXPERIENCE & VALUE` above and whatever Agent A independently verifies), or
   a new doc (e.g., `17-autonomous-patch-loop.md`) explicitly split out, with
   this doc's scope line (see CUT) corrected to say so honestly. This is a
   documentation-completeness gap, not a product gap — the product mechanism
   itself is real, mature, and (per the guardian/auto_merge design) unusually
   well thought through on the trust/safety axis.
2. **`auto_merge.py`'s per-gate rejection reasoning (`AutoMergeDecision.reasons`/
   `blocked_by`) is computed with real per-gate granularity but never rendered
   in the portal.** This is a small, concrete, high-leverage UX fix (see
   USER EXPERIENCE & VALUE §6 and Recommendation #2) that directly serves the
   "why didn't this happen autonomously" half of the trust question this
   feature poses.
3. **The live Reject flow silently discards the reason field the backend was
   built to consume**, collapsing all portal-originated rejections into the
   generic 30-day `"wontfix"` dedupe bucket and making the 90-day `"user_fixed"`
   bucket unreachable from the UI a human reviewer actually uses (see §4 and
   Recommendation #1). Confirmed via the live call site
   (`app/(portal)/improve/page.tsx:300`), not inferred.
4. **`nudges/`'s ArtifactAuthor.from_issue/from_nl shadow-log→promote/demote
   lifecycle has no portal surface at all** (zero UI matches for "nudge"),
   in contrast to `improvement/`'s reasonably built-out Improve queue +
   autonomy settings/audit surfaces. If `nudges/` and the shadow-detector loop
   this doc already covers are ever reconciled (per `KNOWN-SUBSYSTEMS.md:49-54`'s
   open question), the UX gap here is worth noting: eden has built more
   autonomous-improvement backend mechanisms than it has built review surfaces
   for.
5. **`plan-status-history.tsx`'s in-code admission that there is no per-plan
   event-history API** (`:1-10`) is itself worth citing as a finding, not just
   background — it's a case where the frontend team already flagged the exact
   gap a UX reviewer would flag, in a code comment nobody outside the frontend
   is likely to read. Promoting it into this doc turns a buried TODO into a
   prioritized, cross-team-visible item.
