# Loop 1 / Loop 2 / EvidenceGate — relationship & precedence

**FEAT-154.** Concise architecture note extracted from
[`13-continuous-improvement-loop.md`](./13-continuous-improvement-loop.md),
verified against current code.

## Three complementary mechanisms

Eden has three structurally separate continuous-improvement shapes.
They share a *product* story ("detect → decide → improve") but **do not
share code paths**. Treat them as siblings, not layers of one pipeline.

| Mechanism | Code home | Job |
|---|---|---|
| **Loop 1** — shadow detectors | `src/eden/services/soft_issue_review.py` (`nl_signals`) | Learn *what counts as an issue* |
| **Loop 2** — autonomous patch pipeline | `src/eden/improvement/` (+ `closed_loop/`) | *Fix* confirmed issues (patch → test → merge → revert) |
| **EvidenceGate / PromotionLoop** | `src/eden/promotion/evidence_gate.py`, `src/eden/llmops/promotion.py` | Gate *behavior-record* promotions (nudges, prompt canaries, …) |

Narrative source: F13 §TL;DR + §Loop 1 / §Loop 2 / §A third related mechanism.

## Precedence (how they relate)

```
production traces
       │
       ▼
 ┌─────────────┐     confirm/dismiss / precision
 │   Loop 1    │ ──► promote/delete shadow detectors
 │ nl_signals  │     (what to detect next)
 └──────┬──────┘
        │ issues / stumbles (once detectors fire)
        ▼
 ┌─────────────┐     approve / autonomy ladder
 │   Loop 2    │ ──► code_patch plans → PR → merge → guardian revert
 │ improvement │     (how to fix the agent)
 └─────────────┘

        ┌──────────────────────────────────────┐
        │ EvidenceGate / PromotionLoop         │
        │ (parallel track — not Loop 1 or 2)   │
        │ nudge / prompt_version / … candidates│
        │ → statistical gate → promote/demote  │
        └──────────────────────────────────────┘
```

1. **Loop 1 precedes Loop 2 in the issue lifecycle, not in a call stack.**
   Loop 1 decides which failure patterns become issues. Loop 2 consumes
   issues (and related plans) and proposes code fixes. There are **no
   cross-imports** between `soft_issue_review.py` and `improvement/`
   (verified in F13). Wiring Loop 1 confirm/dismiss does not change
   Loop 2's autonomy ladder.

2. **EvidenceGate is a third, parallel track.** It gates promotions of
   *runtime behavior artifacts* (nudges injected into prompts, prompt
   canary versions, etc.), not shadow detectors and not code patches.
   `PromotionKind`s today: `pr_merge`, `prompt_version`, `guardrail`,
   `model_routing`, `kb_skill`, `nudge`
   (`evidence_gate.py` / F13 §third mechanism).

3. **No shared precedence lock.** An org can run Loop 2 auto-merge while
   Loop 1's weekly `promote_shadow_detectors` is inert, and vice versa.
   EvidenceGate promote/demote does not block or unblock Loop 2
   `approve_plan` / `auto_merge`.

## Who promotes what (current code truth)

| Path | Promotes | Live today? |
|---|---|---|
| Loop 1 `promote_shadow_detectors` | `nl_signals` shadow → enabled | **Structurally inert** until confirm/dismiss counters are written (F13 Task 1) |
| Loop 2 `auto_merge` / `approve_plan` | `code_patch` plans → PR/merge | **Live**, gated by autonomy ladder + evidence tier (defaults: reversible heal on, patch-merge off) |
| EvidenceGate `promote_if_passed` | `promotion_candidates` by kind | **`nudge` live**; `prompt_version` has outcome metrics (`_prompt_version_outcome_metrics`) but enqueue still uses a composite `"{agent}:{version}"` `ref_id` against a UUID column (F13 type-mismatch); other kinds return empty evidence by explicit branch (`_metrics_from_outcomes`, FEAT-31) |

`nudges/` (`ArtifactAuthor`, `NudgeEngine`, `ArtifactDemotionWorker`) is the
working EvidenceGate consumer — the template for finishing Loop 1 and
prompt-canary promotion, not a fourth loop.

## Autonomy / blast-radius ordering (Loop 2 only)

From `closed_loop/autonomy_policy.py` `_ACTION_TIERS` (F13 §Loop 2):

- **T0/T1** observe / triage — always allowed
- **T2** reversible runtime heal — default on
- **T3** prompt canaries / nudge promotion — EvidenceGate-adjacent
- **T4** code_patch merge — default off, highest blast radius

This ladder governs Loop 2 (and related promote actions). It does **not**
order Loop 1 detector promotion relative to EvidenceGate.

## Engineering rules of thumb

- Fixing Loop 1 confirm/dismiss ≠ touching `improvement/` or EvidenceGate.
- Fixing auto-merge eligibility ≠ enabling shadow-detector promote.
- Wiring EvidenceGate for `prompt_version` ≠ regenerating Book/Ledger
  (that is FEAT-145 on `PromptService.create_version` / `promote`).
- Portal surfaces differ: Loop 2 has `/improve`; Loop 1 and nudges are
  under-surfaced (F13 §UX).

## Source map

- Narrative: `features/13-continuous-improvement-loop.md`
- Loop 1: `src/eden/services/soft_issue_review.py`
- Loop 2: `src/eden/improvement/`, `src/eden/closed_loop/`
- EvidenceGate: `src/eden/promotion/evidence_gate.py`
- PromotionLoop: `src/eden/llmops/promotion.py`
- Working nudge path: `src/eden/nudges/`
