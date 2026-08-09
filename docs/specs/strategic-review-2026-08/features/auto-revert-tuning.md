# Auto-revert trigger validation (FEAT-165)

Date: 2026-08-07 (desk validation — production soak still required)
Related: `docs/docs/operations/auto-merge-rollout.md`,
`src/eden/improvement/auto_merge.py`, `src/eden/improvement/guardian.py`.

## Desk validation verdict (2026-08-07)

**Defaults remain conservative enough for Stage 0 / Stage 1.** Auto-merge
and auto-revert are **default-off**. Dogfood Stage 1 still requires an
explicit N22 T4 opt-in (`auto_code_patch_merge=True`) plus
`Settings.auto_revert_enabled=True` before guardian can auto-execute a
canary revert. Code audit on 2026-08-07 found no mis-tuned trigger
predicates vs the rollout doc; `auto-merge-rollout.md` guardian
overstatement was corrected to match `auto_revert_permitted`. Production
merge-and-hold ≥80% / bad-PR ≤10% metrics are **not yet measured** —
validated desk-side only until Stage-1 dogfood snapshots land in
`docs/ops/autonomy-baseline/`.

| Gate target (rollout ladder) | Desk read vs current code |
|---|---|
| ≥ 80% merge-and-hold | Not yet empirically measured (Stage 0). Defaults block merge entirely → hold rate trivially protected. |
| ≤ 10% bad-PR | Same — no customer auto-merge until opt-in. Soft cap (200 lines), weekly cap (2), KG zero-revert, and `replay`/`tested` tiers further bound blast radius once enabled. |
| Stage 0 default-off | **PASS** — see predicates below. |

## Exact auto-merge eligibility predicates

From `evaluate_auto_merge_eligibility` (`auto_merge.py`):

1. **Force canary-revert bypass** — if
   `plan.evidence.auto_merge.force_canary_revert` is truthy →
   `eligible=True` immediately (`reasons=["canary_auto_revert"]`).
   Used only for guardian-stamped **revert** plans of a prior canary
   merge (not a general escape hatch for forward merges).
2. Else **feature kill** `auto_merge` must allow the org.
3. Else **compliance** ∉ `{hipaa, soc2_strict}`.
4. Else **`policy.auto_code_patch_merge`** must be `True`
   (N22 T4; dataclass / org default **`False`**).
5. Else **`evidence_tier` ∈ `{replay, tested}`** (`_ELIGIBLE_TIERS`).
6. Else **diff lines ≤ soft cap** (`patch_max_diff_lines_soft`, default
   **200** via `_soft_cap()`).
7. Else **KG revert history** on touched paths must be empty
   (`reverted_count` / history check).
8. Else **weekly volume** `used < weekly_cap`
   (default **2** via `auto_merge_max_per_week`).
9. Else **branch protection** allows App merge (unless
   `skip_branch_protection`).

## Exact auto-revert trigger predicates

Guardian path: `_maybe_auto_execute_revert` (`guardian.py`) then
`approve_plan` with stamped `force_canary_revert`.

| # | Predicate | Code | Default |
|---|---|---|---|
| A | Parent was a **canary auto-merge** | `parent_is_canary_auto_merged`: `evidence.auto_merge.merged` and `canary is True` (missing `canary` ≠ True) | N/A (data-dependent) |
| B | `auto_revert_permitted(org, agent)` | See below | **False** |
| C | Revert plan has an id | `revert_plan["id"]` | — |
| D | Stamp + `approve_plan(..., approved_by="eden:guardian_auto_revert")` | stamps `force_canary_revert` so eligibility bypasses the forward ladder | — |

`auto_revert_permitted` (`auto_merge.py`) requires **all** of:

1. `get_settings().auto_revert_enabled` is **True** (Settings default
   **`False`** — Cat 23 second-stage opt-in).
2. Feature kill allows auto-merge class for the org.
3. Compliance ∉ `{hipaa, soc2_strict}`.
4. `policy.auto_code_patch_merge` is **True** (same T4 flag as merge;
   **not** `auto_runtime_heal`).

## Mapping to rollout stages

| Stage | Required flags | Auto-revert live? |
|---|---|---|
| **0** (shipped) | All defaults | **No** — `auto_code_patch_merge=False`, `auto_revert_enabled=False` |
| **1** dogfood | Org/agent T4 on + (for revert) Settings `auto_revert_enabled` | Only for canary-class parents after regression |
| **2+** | Same metrics gates as rollout doc | Still explicit opt-in until Stage 3 debate |

## Doc / code mismatches found

1. **Rollout doc overstatement (fixed 2026-08-06):** the line claiming
   guardian auto-revert is "always allowed for the same file class"
   was stronger than the code. Revert still requires
   `auto_revert_enabled` + T4 + kill/compliance. The doc now matches
   the predicates above.
2. **Hardcoded thresholds:** `_ELIGIBLE_TIERS`, `_BLOCKED_COMPLIANCE`,
   soft-cap / weekly-cap defaults — comments in `auto_merge.py` now
   link to the rollout doc.

## Optional follow-ups

* Wire Stage-1 telemetry snapshots into this file once dogfood runs.
* Consider requiring `auto_revert_enabled` to be settable per-org in
  autonomy policy (today it is process-wide Settings).
