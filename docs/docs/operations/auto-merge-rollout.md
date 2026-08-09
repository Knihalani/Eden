# Auto-merge rollout ladder (M15 / §9)

Eden can auto-merge its own fix PRs, but **auto-merge is off by default and
must stay that way until an org opts in.** This page documents the gate stack
and the deliberate rollout ladder. It is intentionally *not* a "flip one flag"
switch — sequencing is the safety mechanism.

## The gate stack (all must pass — `evaluate_auto_merge_eligibility`)

A fix PR is eligible to auto-merge only when **every** gate below passes
(`src/eden/improvement/auto_merge.py`):

1. **Feature kill** — a per-org kill switch can hard-stop auto-merge.
2. **N22 T4 policy** — `auto_code_patch_merge` (the highest autonomy tier)
   must be enabled for the org/agent. Default: **`False`**.
3. **Compliance profile** — orgs on `hipaa` or `soc2_strict` are blocked
   outright.
4. **Evidence tier** — the plan's evidence tier must be `replay` or `tested`
   (`_ELIGIBLE_TIERS`). "static-only" plans can never auto-merge. `replay`
   means the fix was verified by re-running the stored failing input against
   current behavior and observing the failure signature disappear
   (`regression_replay_v1`, N01 replay); `tested` means sandbox tests passed.
5. **Size cap** — diffs over the soft line cap are held for a human.
6. **KG revert history** — if any touched path has been reverted before
   (`reverted_count > 0`), the merge is blocked.
7. **Branch protection** — required checks must be green on the PR branch.

Guardian **auto-revert** is **not** unconditional: it still requires
`Settings.auto_revert_enabled`, N22 T4 `auto_code_patch_merge`, feature-kill,
and compliance gates — see `docs/specs/strategic-review-2026-08/features/auto-revert-tuning.md`.

## Rollout ladder (do these in order)

| Stage | Action | Exit criterion |
|---|---|---|
| 0 | Ship gates default-off (**done**). | 27 `test_auto_merge` gate tests green. |
| 1 | Enable for the **dogfood org only** (set `auto_code_patch_merge` via N22 policy for Eden's own org). | ≥ 2 weeks: merge-and-hold rate ≥ 80%, bad-PR rate ≤ 10%, zero unreverted guardian regressions. Snapshots in `docs/ops/autonomy-baseline/`. |
| 2 | Offer as **opt-in** to design-partner orgs; keep the per-org kill switch one click away. | Same metrics hold across partners; no compliance-profile escapes. |
| 3 | Consider default-on **only** for `standard` compliance orgs, with Settings opt-out. | Sign-off on the Stage-1/2 metrics. |

Do not skip stages. Auto-merge only earns trust by holding the success metrics
across a real window; the ladder is the mechanism that proves it before the
blast radius widens.

## Prerequisites (met)

- Phase 1 acceptance audit green (golden-path + chaos suites).
- N01 fails closed and can produce `replay`-tier evidence (§3.1).
- Loop-dead watchdog + `autonomy_baseline.py` strict gate in place, so a
  degraded loop is visible before it can auto-merge on stale signals.
