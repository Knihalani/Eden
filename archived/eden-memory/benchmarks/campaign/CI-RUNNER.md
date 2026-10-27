# CI runner requirements — noise-floor / campaign benches

These rules keep `@eden/measure` verdicts trustworthy. They are operational,
not product behavior.

## Dedicated vs shared runners

| Setting | Requirement |
|---|---|
| **Preferred** | Dedicated GitHub Actions runner (or pinned self-hosted) for `benchmarks/campaign/*` |
| **Acceptable** | `ubuntu-latest` **only** if the job is exclusive (no matrix sibling sharing the VM) and load average stays low |
| **Forbidden** | Crowded shared hosts, contested CI caches that spike CPU mid-bench, laptops with thermal throttling as the sole gate |

Campaign benches measure **wall_ms**. An overloaded host invents jitter that
looks like treatment effects. Do not run gates on a machine you would not
trust for a latency SLO.

## Sample-size floors

| Metric / claim | Minimum paired blocks `n` | Notes |
|---|---|---|
| Any WIN / LOSS at α=0.05 | **n ≥ 6** | Sign-flip floor: `minAchievableP(5) > 0.05` |
| Negative-control parity | **n ≥ 8** (prefer 12) | Matches campaign defaults outside `--fast` |
| Publishing an MDE | Report MDE at **n=8, 12, 16** from the latest `NOISE-FLOOR.md` | Recalibrate after hardware change |

## Locked thresholds — 2026-08-26 full calibrate (`darwin-arm64`, n=8 pairs, `CAMPAIGN_THINK_MS=1`)

Source: `NOISE-FLOOR.md` (Mode: **full**, 22 measured scenarios, 0 MODELED). Re-lock after a runner-class change.

| Claim class | This machine |
|---|---|
| Negative-control 1% parity at n=8 | unique-work / creative / micro / chaos-observe relative MDE ≤ 0.98% — **in band** |
| fastdesk-live 1% wall parity | relative MDE 2.61% at n=8, 1.70% at n=16 → **n≥16** or quote turns |
| Stability stop-rule | **pagination-loop** stability = 0 (relSd 5.68%) → **do not gate `wall_ms`**. Gate compile-refusal + exactly-once. Use pagination-bindable for wall (stab 0.827, MDE@8 1.01%) |
| Preferred stability ≥ 0.5 | All other 21 scenarios ≥ 0.568 (fastdesk-live lowest among gated-wall rows) |
| +0.1% sign-flip predictability | Creative P(sign-flip)\|0.1% @8 = 36.38% from relSd 0.84% — expected, not a flake |

`--fast` is for local smoke only. CI merge gates must use the non-fast repeat
counts from `bench-campaign.ts` / `bench-negative.ts`.

## Max acceptable relative MDE

Before trusting a **parity** or **sub-percent overhead** claim on a runner:

1. Run `bun run benchmarks/campaign/calibrate.ts` (not `--fast`) on that runner class.
2. For every scenario that will gate merges, require:

| Claim class | Max relative MDE at the scenario’s planned `n` |
|---|---|
| Negative-control “no material LOSS” (≤1% band) | **relative MDE ≤ 2%** at planned `n` |
| Positive-campaign WIN on wall_ms | relative MDE should sit **below** the effect you intend to claim |
| Stability score | **stability ≥ 0.5** (A/A relative CV ≤ 2.5%) preferred; **&lt; 0.2** → stop and fix the runner |

If relative MDE at planned `n` exceeds the claim class, either increase `n`
(`requiredBlocks`) or move to a quieter runner — do not loosen α.

## When A/A is biased

`decide()` self-check statuses:

| Status | Meaning | Action |
|---|---|---|
| `clean` | CI inside ±tolerance (default 5%) | Proceed |
| `underpowered` | Interval too wide to prove equivalence | Increase A/A pairs; do not treat as proof of honesty |
| `biased` | CI entirely outside the tolerance band | **Fail the job.** Do not publish A/B verdicts from that session |

Biased A/A means the harness (or host) is measuring something other than the
treatment — clock skew, cgroup throttling, contaminated caches, etc. Fix the
environment; do not “average harder.”

## Overloaded hosts

Do **not** run campaign benches when:

- Load average (1m) ≳ number of CPUs
- Another heavy job shares the runner
- The machine is thermally throttling (common on laptop “CI”)

Symptom: A/A `relativeSd` spikes, stability collapses, creative-style
**+0.1% wall** rows start flipping to LOSS. That is predicted by
`predictFalseLossRate` / `predictLossVerdictRate` in `@eden/measure` — treat
it as an instrument failure, not a product regression.

## Re-calibration triggers

Re-run `bun run benchmarks/campaign/calibrate.ts` and commit an updated
`NOISE-FLOOR.md` when any of the following change:

- Runner OS image / `ubuntu-latest` generation
- CPU model or shared → dedicated (or the reverse)
- `CAMPAIGN_THINK_MS` default used in CI
- Scenario stretch shape that materially changes wall scale
- After three unexplained gate flakes in a week (see ROADMAP R6)

Label any row that reuses another scenario’s jitter as **MODELED** in
`NOISE-FLOOR.md`; never present modeled MDE as measured.

## Commands

```bash
# Unit math
bun test packages/measure

# Indicative local pass
CAMPAIGN_THINK_MS=1 bun run benchmarks/campaign/calibrate.ts --fast

# CI / publishable noise floor
CAMPAIGN_THINK_MS=1 bun run benchmarks/campaign/calibrate.ts
```
