# Noise floor — A/A calibration

Generated: 2026-08-26T13:19:18.664Z
Host: `darwin-arm64`
Mode: full (modest stretch counts)
Design: 8 A/A pairs × 4 stretches/session (scenario-specific; see runner), `CAMPAIGN_THINK_MS=1`.

## Frozen formulas

```
relativeDelta_i = (b_i - a_i) / max(a_i, eps)
relativeSd      = stdev(relativeDeltas)
stability       = clamp(1 - relativeSd / 0.05, 0, 1)   # 1 = quieter than 5% CV
mdeAbs(n)       = minDetectableEffect(stdev(b-a), n)  # alpha=0.05, power=0.8
mdeRel(n)       = mdeAbs(n) / max(|mean(a)|, eps)
falseLoss(n)    = P(sign(mean) flips | trueRel=+0.1%, relSd)  # mulberry32 MC
lossVerdict(n)  = P(LOSS @ α=0.05 | trueRel=+0.1%, relSd)     # perm+bootstrap
```

## Per-scenario MDE (wall_ms)

| scenario | kind | n pairs | stability | relSd | MDE@8 abs / rel | MDE@12 abs / rel | MDE@16 abs / rel | P(sign-flip)\|0.1% @8 | P(LOSS)\|0.1% @8 |
|---|---|---:|---:|---:|---|---|---|---:|---:|
| short-support | measured | 8 | 0.919 | 0.41% | 2.26 / 0.46% | 1.74 / 0.35% | 1.47 / 0.30% | 24.02% | 7.53% |
| short-overhead | measured | 8 | 0.953 | 0.23% | 3.17 / 0.27% | 2.44 / 0.21% | 2.06 / 0.18% | 11.88% | 16.40% |
| long-desk | measured | 8 | 0.986 | 0.07% | 1.64 / 0.08% | 1.26 / 0.06% | 1.06 / 0.05% | 0.00% | 90.73% |
| long-orders | measured | 8 | 0.967 | 0.17% | 7.28 / 0.19% | 5.61 / 0.15% | 4.73 / 0.12% | 4.78% | 29.67% |
| long-etl | measured | 8 | 0.973 | 0.13% | 12.90 / 0.16% | 9.93 / 0.12% | 8.38 / 0.10% | 1.85% | 43.40% |
| long-incident | measured | 8 | 0.959 | 0.21% | 5.44 / 0.24% | 4.19 / 0.18% | 3.54 / 0.15% | 7.90% | 21.60% |
| ood-long | measured | 8 | 0.829 | 0.85% | 21.04 / 0.99% | 16.21 / 0.76% | 13.68 / 0.64% | 37.52% | 4.53% |
| oblivious-long | measured | 8 | 0.961 | 0.19% | 4.46 / 0.22% | 3.44 / 0.17% | 2.90 / 0.15% | 6.48% | 22.87% |
| thrash-enforce | measured | 8 | 0.670 | 1.65% | 12.26 / 1.99% | 9.44 / 1.54% | 7.97 / 1.30% | 42.65% | 3.47% |
| unique-work | measured | 8 | 0.942 | 0.29% | 1.93 / 0.33% | 1.48 / 0.26% | 1.25 / 0.22% | 16.83% | 12.67% |
| creative | measured | 8 | 0.832 | 0.84% | 5.94 / 0.98% | 4.58 / 0.76% | 3.86 / 0.64% | 36.38% | 4.07% |
| micro | measured | 8 | 0.912 | 0.44% | 2.27 / 0.51% | 1.75 / 0.39% | 1.47 / 0.33% | 26.77% | 7.07% |
| fastdesk-live | measured | 8 | 0.568 | 2.16% | 0.5827 / 2.61% | 0.4489 / 2.01% | 0.3788 / 1.70% | 44.80% | 2.87% |
| drift | measured | 8 | 0.789 | 1.05% | 24.22 / 1.22% | 18.66 / 0.94% | 15.75 / 0.79% | 40.40% | 3.60% |
| chaos-observe | measured | 8 | 0.907 | 0.46% | 2.73 / 0.54% | 2.10 / 0.41% | 1.78 / 0.35% | 25.92% | 8.07% |
| concurrent | measured | 8 | 0.964 | 0.18% | 3.11 / 0.21% | 2.39 / 0.16% | 2.02 / 0.14% | 5.73% | 25.00% |
| chaos-enforce | measured | 8 | 0.638 | 1.81% | 10.59 / 2.09% | 8.16 / 1.61% | 6.88 / 1.36% | 44.05% | 3.40% |
| slow-tool-timeout | measured | 8 | 0.643 | 1.79% | 1.78 / 2.07% | 1.37 / 1.60% | 1.16 / 1.35% | 42.58% | 2.87% |
| very-long-session | measured | 8 | 0.665 | 1.68% | 3.82 / 1.97% | 2.94 / 1.52% | 2.48 / 1.28% | 43.03% | 3.20% |
| high-card-ids | measured | 8 | 0.769 | 1.16% | 2.38 / 1.33% | 1.83 / 1.02% | 1.54 / 0.86% | 40.75% | 4.07% |
| pagination-loop | measured | 8 | 0.000 | 5.68% | 19.90 / 6.56% | 15.33 / 5.05% | 12.94 / 4.27% | 47.73% | 2.53% |
| pagination-bindable | measured | 8 | 0.827 | 0.87% | 2.55 / 1.01% | 1.97 / 0.77% | 1.66 / 0.65% | 37.33% | 4.00% |

## How to read this

- **stability** near 1 → machine quieter than 5% A/A CV; near 0 → too noisy for sub-percent claims.
- **P(sign-flip)|0.1%** predicts creative-style direction flips of a true +0.1% wall overhead.
- **P(LOSS)|0.1%** predicts how often `decide()` would call LOSS at α=0.05 for that tiny true overhead.
- Re-run after hardware / runner image changes. See `CI-RUNNER.md`.

## CI implications (locked from this full run)

Rows with **stability &lt; 0.2** must not gate merges on `wall_ms`:

| scenario | why | what gates instead |
|---|---|---|
| pagination-loop | cursor walk is 16 sequential sleeps; A/A relative CV 5.68% (stability 0) | compile refusal (`listPage` without bindable foreach) + `check()` exactly-once; quieter sibling is **pagination-bindable** (stability 0.827) |

`fastdesk-live` relative MDE at n=8 is 2.61% — above the 2% band for 1% parity claims. Use **n≥16** for wall_ms parity, or quote **turns** (arithmetic, not sampled).

Sign-test false-loss at +0.1% is predicted from `relativeSd` (see `P(sign-flip)|0.1% @8`). Creative at 0.84% relSd → ~36% sign-flips of a true +0.1% overhead: that is instrument noise, not a product LOSS.
