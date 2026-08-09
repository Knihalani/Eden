# BACKLOG — FEAT-172: Same-day causal spend-anomaly detection

**Status:** Deferred / backlog — not scheduled into any wave. This is a
future differentiation capability, not next-sprint work.

**Source:** `docs/specs/strategic-review-2026-08/features/06-cost-governance.md`,
§3 Verdict item 4; tracked as `FEAT-172` in `WAVE-PLAN.md`.

## What

Same-day, causally-explained spend-anomaly detection: not just "you crossed
80% of budget," but "your spend spiked today, and it was caused by
`{team|workload|agent}`." This requires a baseline/expected-spend model
(what should we have spent, given historical pattern) and an attribution
step (which dimension explains the deviation), not just a static threshold
comparator.

## Why (competitive differentiation)

CloudZero's 2026 positioning explicitly frames same-day, causally-explained
anomaly detection as materially different from — and more valuable than —
threshold alerting. As of the 2026-08 strategic review, **no LLM-native
observability competitor** (Portkey, Helicone, LiteLLM, OpenRouter) ships
this either, and eden's own cost-governance surfaces (customer-facing budget
system, internal cost ledger) do nothing beyond static 50/80/100% threshold
crossings today. This is a real, named, currently-open competitive gap — but
one the review's own authors explicitly deprioritized relative to
correctness/UI fixes elsewhere in cost governance, hence backlog rather than
scheduled work.

## Prerequisites

Do not start this before both of the following land (both are separate,
already-tracked items — this entry does not duplicate or supersede them):

1. **A baseline/expected-spend model.** Nothing in eden today computes an
   "expected" spend for a given org/day — a prerequisite for anomaly
   detection, not an incidental nice-to-have. This is net-new work, not
   currently scoped anywhere else in the review.
2. **FEAT-20 budget-path fixes.** The review's cost-governance findings
   (`features/06-cost-governance.md` — `budget_consumption` never accruing
   for pure gateway-proxy orgs, `QuotaEnforcementMiddleware` reading the
   wrong table) mean the underlying spend data this feature would alert on
   is not reliably tracked yet. Building anomaly detection on top of a
   broken spend-tracking pipeline would produce false or missing alerts —
   fix the pipeline first.

## Building blocks (reuse, don't rebuild)

- `src/eden/predictive/cusum.py` — a pure-Python CUSUM (cumulative-sum)
  change-point detector, currently used by
  `eden.predictive.quality.QualityPredictor` to detect shifts in **daily
  judge-score series**. Nothing today feeds it spend data, but the
  detector itself (`cusum_detect`, `cusum_classify_trend`,
  `annotate_change_points`) is generic over any 1-D numeric series ordered
  by day — adapting it to a daily-spend series is plausible reuse rather
  than a new detector, though it would still need a real
  baseline/expected-spend model (see Prerequisites) feeding it, and the
  causal-attribution ("which team/workload caused this") half of the ask
  is out of CUSUM's scope entirely and would need separate design.

## Effort / confidence

**Effort:** Large. **Confidence:** High (well-sourced competitive claim,
clear current-state gap). **Severity:** Low (a differentiation opportunity,
not a correctness or safety issue).

## Non-goals for this backlog entry

This document does not scope an implementation plan, data model, or API —
that work should happen if/when this is pulled off the backlog into an
active wave, after the two prerequisites above are confirmed complete.
