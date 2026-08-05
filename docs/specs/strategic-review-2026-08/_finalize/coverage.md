# WAVE-PLAN.md — Coverage & Consistency Audit

Audit date: 2026-08-05. Scope: plan-level bookkeeping of
`docs/specs/strategic-review-2026-08/WAVE-PLAN.md` against the three RANKED backlogs,
`_pass4-notes/WAVE-ASSIGNMENT.json`, the `WAVE-META-*.json` metadata, and
`_pass4-notes/schedule_waves.py`. WAVE-PLAN.md was **not** modified.

## Verdict at a glance

| Check | Result |
|---|---|
| 1. Coverage of ranked ids | **Complete — nothing is actually excluded.** The "305 vs 284" gap is an accounting artifact (see below). |
| 2. Summary table (per-wave counts and splits) | **All cells correct** (under a consistent hybrid-severity rounding convention). |
| 3. `**Depends on:**` ordering | **No violations** (66 points with deps; all deps exist and are strictly earlier-wave). |
| 4. Wave 1/2 file disjointness | **5 violations** (3 in Wave 1, 2 in Wave 2). |
| 5. Structure | 3 stray `## High`/`## Medium`/`## Low` headings embedded *inside* point entries; 21 points with `Files touched: _(none listed)_`; header repeats a false "59 bugs" count. |

---

## 1. Coverage: where the "missing ~21 points" actually went

**The arithmetic in the plan's header is wrong on both sides, but no ranked point is missing.**

- The plan contains **284** `### <ID>` headings, **no duplicates**, and no id that fails to
  exist in a RANKED doc.
- Of those, **281 are single ids** and **3 are grouped range entries** that reproduce the RANKED-BUGS
  grouped headings verbatim:
  - `### BUG-36-50` (Wave 12, WAVE-PLAN.md:4718) — "Dead backend code: delete or re-wire 15 zero-caller functions" — covers BUG-36…BUG-50 (15 ids)
  - `### BUG-51-54` (Wave 13, WAVE-PLAN.md:5152) — "Dead portal (frontend) code: delete ~34 zero-importer exports across 4 groups" — covers BUG-51…BUG-54 (4 ids)
  - `### BUG-55-58` (Wave 13, WAVE-PLAN.md:5192) — "Stale tracking-doc claims across 5 `docs/specs/` documents" — covers BUG-55…BUG-58 (4 ids)
- The RANKED docs actually define: **BUG #1–#58 (58 ids** — despite RANKED-BUGS.md:20 claiming
  "**59 distinct points**"; no 59th point exists anywhere in the doc, including its appendix**)**,
  **OPT 1–61 (61)**, **FEAT #1–#185 (185, no gaps)**. True total: **304, not 305**.
- Coverage: 281 (single) + 23 (via the 3 grouped entries) = **304 of 304 ranked points covered**.
- So the apparent 21-point shortfall = 20 group-member ids folded into 3 grouped headings
  (23 ids rendered as 3 items) + 1 phantom bug point that RANKED-BUGS claims but never defines.
- `sdk-deletion.md` and INDEX.md name **no** ranked ids as dropped/obsoleted — the SDK deletion
  excluded nothing from this plan.

### WAVE-ASSIGNMENT.json cross-check

`_pass4-notes/WAVE-ASSIGNMENT.json` has exactly **284 entries**, its id set matches the plan's
heading set **exactly** (including the three range ids `BUG-36-50`, `BUG-51-54`, `BUG-55-58`),
and every entry's `wave` number matches the `## Wave N` section the point appears under in the
plan. Zero mismatches. (Note: a naive `grep -oE '^### (BUG|OPT|FEAT)-[0-9]+'` truncates the three
range headings to `BUG-36`/`BUG-51`/`BUG-55` and will falsely report a 20-id diff against the
assignment file.)

### Excluded from this plan (ready-to-paste)

> **Excluded from this plan.** No ranked point is unscheduled, but 21 ids from
> `RANKED-BUGS.md`'s claimed 59 do not appear as standalone entries:
>
> - BUG-37 — dead `run_investigator_llm_batch` (`signals/investigator.py:158`) — folded into grouped entry `BUG-36-50` (Wave 12)
> - BUG-38 — dead `list_plan_tiers` (`services/plan_tiers.py:281`) — folded into `BUG-36-50` (Wave 12)
> - BUG-39 — dead `get_feature_list` (`services/plan_tiers.py:286`) — folded into `BUG-36-50` (Wave 12)
> - BUG-40 — dead `fingerprint_from_detail` (`issues/fingerprint.py:92`) — folded into `BUG-36-50` (Wave 12)
> - BUG-41 — dead `playbook_label` (`closed_loop/playbooks.py:53`) — folded into `BUG-36-50` (Wave 12)
> - BUG-42 — dead `is_verify_worker_running` (`closed_loop/verify.py:810`) — folded into `BUG-36-50` (Wave 12)
> - BUG-43 — dead `get_usage_service` (`services/usage_service.py:538`) — folded into `BUG-36-50` (Wave 12)
> - BUG-44 — dead `is_consumer_running` (`closed_loop/event_bus.py:486`) — folded into `BUG-36-50` (Wave 12)
> - BUG-45 — dead `_from_issues` (`improvement/agent.py:573`) — folded into `BUG-36-50` (Wave 12)
> - BUG-46 — dead `_get_async_client_for_legacy_tests` (`api/routes/gateway.py:1022`) — folded into `BUG-36-50` (Wave 12)
> - BUG-47 — dead `_not_implemented_envelope` (`metric_studio/_common.py:81`) — folded into `BUG-36-50` (Wave 12)
> - BUG-48 — dead `register_intelligence_judges` (`llmops/judges/builtin_v9.py:17`) — folded into `BUG-36-50` (Wave 12)
> - BUG-49 — dead `leader_session` (`workers/leader.py:25`) — folded into `BUG-36-50` (Wave 12)
> - BUG-50 — dead `register_providers_from_env` (`llmops/ai_gateway.py:1579`) — folded into `BUG-36-50` (Wave 12)
> - BUG-52 — 8 dead custom hooks (`useOnline`, `useListKeyboardNav`, `useQueryTab`, …) — folded into `BUG-51-54` (Wave 13)
> - BUG-53 — 13 dead exported constants in `lib/portal-polish.ts` — folded into `BUG-51-54` (Wave 13)
> - BUG-54 — 8 more dead exports (`AbStatusChip`, `GuardrailsTabNav`, `GuardrailsTestView`, …) — folded into `BUG-51-54` (Wave 13)
> - BUG-56 — stale `wNN-portal.test.ts` evidence-suite citations in `SOTA-WAVE-TRACKER.md` — folded into `BUG-55-58` (Wave 13)
> - BUG-57 — `OPTIMIZATION-ID-CHECKLIST.md:32-33` marks deleted Go/Rust SDK work "DONE" — folded into `BUG-55-58` (Wave 13)
> - BUG-58 — `sdk/go`/`sdk/rust` deletion staged but not committed — folded into `BUG-55-58` (Wave 13)
> - BUG-59 — **does not exist**: `RANKED-BUGS.md` claims "59 distinct points" but its ranked list defines only #1–#58; the true backlog total is 58 + 61 + 185 = **304**, all covered.
>
> All 20 real ids above are severity **Low** (per their grouped RANKED-BUGS entries) and remain
> fully in scope — they are scheduled via their grouped plan entries, just not as separate headings.
> (BUG-36, BUG-51, BUG-55 are the range-heading anchors, not separately scheduled points.)

## 2. Summary table (WAVE-PLAN.md:48-69) — verified correct

Recounted from the actual `###` headings per `## Wave N` section:

- **Points, Bugs, Opts, Feats columns:** every cell matches. Wave sizes are
  20×13, 18, 3, 3 = 284; splits 38/61/185 confirmed ("38 bugs" counts each grouped range entry
  as one).
- **Critical/High/Medium/Low columns:** every cell matches **provided hybrid severities round up
  to the higher tier**, which the table applies consistently:
  - `Critical/High` → Critical: OPT-3 (W1)
  - `Medium-High` → High: OPT-14 (W3), OPT-15 (W4)
  - `Low-Medium` / `Low/Medium` → Medium: OPT-34, OPT-35 (W7); OPT-37, OPT-38 (W8); OPT-33, OPT-39 (W10); OPT-36 (W13)
  - Column totals 33 / 83 / 110 / 58 all reconcile.
- No summary-table errors found.

## 3. Dependency ordering — no violations

66 points carry a `**Depends on:**` line. Every referenced id exists in the plan and is scheduled
in a **strictly earlier** wave. No dependency references a group-member id (e.g. `BUG-40`) or a
nonexistent id. One caveat: FEAT-165's `**Depends on:** FEAT-30` line (WAVE-PLAN.md:4580) sits
*after* the stray `## Low` heading (see §5), so `##`-scoped parsers will mis-attribute it.

## 4. Same-wave file-disjointness — 5 violations in Waves 1-2

The wave headers claim "All points in this wave touch disjoint file sets." False for both audited waves:

| Wave | Points | Shared file (real repo path) | As listed in the plan |
|---|---|---|---|
| 1 | FEAT-8 / FEAT-10 | `src/eden/services/soft_issue_review.py` | `soft_issue_review.py` vs `soft_issue_review.py (record_shadow_feedback)` |
| 1 | FEAT-12 / FEAT-13 | `src/eden/playground/scorers.py` (only `scorers.py` in repo) | `playground/scorers.py (run_scorers)` vs `scorers.py` |
| 1 | FEAT-14 / FEAT-15 | `realtime/alert_stream.py` | `realtime/alert_stream.py (AlertStreamProcessor.process_event, process_batch)` vs `realtime/alert_stream.py (rule_sandbox_escape rule)` |
| 2 | BUG-4 / FEAT-18 | `clients/portal/src/lib/api/resources.ts` | exact path vs `...resources.ts (nl-alert-rules wrappers)` |
| 2 | BUG-4 / OPT-9 | `clients/portal/src/app/(portal)/issues/issues-client.tsx` (only `issues-client.tsx` in repo) | correct path vs nonexistent `clients/portal/src/issues-client.tsx` |

**Root cause:** `_pass4-notes/schedule_waves.py:236` checks `claimed.isdisjoint(files)` over the
**raw strings** in the WAVE-META `files` arrays. Parenthetical function annotations
(`file.py (func)`), path-prefix inconsistencies (`scorers.py` vs `playground/scorers.py`), and one
wrong path (OPT-9) make identical files compare as distinct, so the scheduler's no-conflict
guarantee is defeated by its own metadata's inconsistent file-naming. Waves 3-16 were not audited
for this and should be assumed suspect for the same reason.

## 5. Other structural findings

1. **Stray `## High` / `## Medium` / `## Low` headings inside point entries.** At
   WAVE-PLAN.md:987 (inside FEAT-26, last point of Wave 2), :2564 (inside FEAT-92, last point of
   Wave 6), and :4577 (inside FEAT-165, last point of Wave 11). Each sits between the point's
   Confidence/Quick-win lines and its `**Files touched:**` (and, for FEAT-165, `**Depends on:**`)
   lines — i.e. they split a point's metadata block. They look like leftover tier-divider markers;
   there is no `## Critical` counterpart before Wave 1. Even read as tier dividers they are wrong:
   Waves 3-4 each contain a Critical point after `## High`; Waves 7-8 contain High points after
   `## Medium`; Wave 11 contains 4 Low points *before* `## Low`; Waves 12-14 contain Medium points
   after it. They should be deleted (and FEAT-26/FEAT-92/FEAT-165's trailing metadata rejoined).
2. **21 FEAT points have `**Files touched:** _(none listed)_`** (matching `files: null` in
   `WAVE-META-features-2.json`): FEAT-125, 126, 129 (W9); FEAT-147, 153, 154, 155 (W10);
   FEAT-158, 159, 163, 164, 165 (W11); FEAT-150 (W12); FEAT-172, 177, 178, 181, 182, 183, 184,
   185 (W14). The scheduler treats an empty file list as conflict-free with everything
   (`not files or ...`, schedule_waves.py:236), so the disjointness guarantee is vacuous for them.
3. **Header repeats the phantom bug count.** WAVE-PLAN.md:7 says "RANKED-BUGS.md (59 points)";
   the doc defines 58. Consequently "all 284 action items" is 304 distinct points, 284 plan
   entries — the header never explains the grouped-entry accounting.
4. **Wave sizes and within-wave ordering check out.** Sizes exactly match the claimed
   20×13, 18, 3, 3. The stated ordering (bugs, then opts, then feats; each ascending by source
   rank) holds in all 16 waves.
5. **Severity-line format is inconsistent**: BUG/FEAT entries use `**Severity:** X`, OPT entries
   use bulleted `- **Severity:** X` with prose qualifiers and hybrid tiers (`Critical/High`,
   `Medium-High`, `Low-Medium`, `Low/Medium`) — harmless, but any downstream tooling must handle
   both.
