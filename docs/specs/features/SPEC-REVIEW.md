# Feature Spec Cross-Review

> Review of all 48 feature-by-feature specs — July 9, 2026

## Verdict

Specs are **feature-granular** (not competitor-organized), **codebase-grounded** (file paths verified), and **implementation-ready** for Wave 0–1.

## Critical path

**F48 → F28 → F29 → F20 → F30 → F04 → F01 → F22 → F46**

## Blockers found in codebase

1. **F48 must ship first** — debugger/signals portal unusable today
2. **F03 before F01** — no checkpoints without ingest hook
3. **F28 before F29** — issues require stumbles
4. **Slack module missing** — F47/F31 need new `integrations/slack/` tree
5. **Three debug stacks** — unify on F01 + F03; don't add fourth

## Schema consolidation

Single migration `080_feature_gap_wave1.sql` should include tables for F01, F28, F29, F20 (minimum Wave 1).

## Hand-deepened specs

These five were expanded beyond generator output:

- F01 — Cached prefix live debugger
- F20 — Zero-config issue detection  
- F29 — Agent issues
- F39 — Runtime nudges
- F48 — Portal API fix

## Risk summary

| Risk | Features | Mitigation |
|---|---|---|
| Live rerun side effects | F01 | mock tools default |
| LLM COGS | F06, F30, F34 | SLM + rate limits |
| OSS maintenance | F32 | separate package |
| Wrong nudge promoted | F39 | F41 shadow gate mandatory |

## Sign-off

Pending product/engineering approval before Wave 1 code starts.
