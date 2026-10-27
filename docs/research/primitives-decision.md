# Decision primitives: calibration, source selection, packing

What the decision half of `@eden/primitives` is built from, why, and what it measured. Every number below is copied
from a command run on 2026-10-27 in this change, as printed. Environment: Bun 1.4.4, 4 vCPU Intel Xeon @ 2.10 GHz,
shared cloud VM (expect ±30% run to run on timings, as in [primitives.md](primitives.md)). Reference values come from
scipy 1.18.1 and scikit-learn 1.9.1 (Python venv outside the repo). Simulations use fixed seeds and are deterministic:
rerunning prints the same quality numbers; only timings move.

The question each primitive answers, in Eden's terms ([fast-primitives.md](fast-primitives.md), "Silence is a
calibrated threshold"; notes: [proactive_decision_and_routing.md](fast-primitives-notes/proactive_decision_and_routing.md)):

| File | Answers | Main API |
|---|---|---|
| `calibrate.ts` | What is P(useful) for this raw score / feature vector, and above what score may Eden speak? | `Logistic`, `fitPlatt`, `Isotonic`, `selectCalibrator`, `logLoss`, `expectedCalibrationError`, `thresholdForFalseFireRate`, `thresholdForPrecision`, `fires` |
| `bandit.ts` | Which k of the user's sources to query for this cue? | `BetaBandit` (`select`, `update`, `decay`, `decayArm`, `inclusionPropensity`), `ipsValue` |
| `pack.ts` | Which candidates go into the size-limited packet? | `Packer` (`pack`, `packExact`), `jaccardMatrix` |
| `random.ts` | Seedable, replayable randomness and Beta draws | `Xoshiro128` |
| `stats.ts` | The special functions the three above need | `betaInc`, `betaIncInv`, `binomCdf`, `clopperPearsonUpper/Lower`, `minTrialsToCertify`, `logGamma`, `logBeta`, `sigmoid`, `log1pExp` |

All hot calls (`select`, `pack`, `predict*`, `fires`) take caller-owned typed arrays, have no default parameters and
allocate nothing per call. Fitting and threshold selection run offline and may allocate.

## Library choices

`bench/compare/decision.compare.ts` (libraries installed in a scratch directory, never in the repo):

```
── Clopper–Pearson bounds, binomial CDF: worst relative error vs scipy
  upper bound   own 2.3e-13  jstat 8.7e-10  @stdlib 4.3e-16
  lower bound   own 3.6e-15  jstat 3.2e-11  @stdlib 1.2e-15
  binomial cdf  own 7.7e-13  jstat 1.1e-7  simple-statistics 2.7e-13
CP upper (12 of 200, δ 0.1): own                mean    2.60 µs  p50    2.56 µs  p99    4.17 µs
CP upper (12 of 200, δ 0.1): jstat beta.inv     mean   872.1 ns  p50   650.9 ns  p99    7.12 µs
CP upper (12 of 200, δ 0.1): @stdlib quantile   mean    3.06 µs  p50    2.47 µs  p99   19.19 µs
binomial cdf (12, 200, 0.1): own                mean   331.6 ns  p50   312.6 ns  p99   503.6 ns
binomial cdf (12, 200, 0.1): jstat              mean   340.4 ns  p50   256.3 ns  p99   742.7 ns
binomial cdf (12, 200, 0.1): simple-statistics  mean    4.62 µs  p50    4.35 µs  p99    5.73 µs
── Logistic regression, unpenalized, vs scikit-learn coefficients
  own Newton:             max rel err 2.3e-12
  ml-logistic-regression: max rel err 1.7e-1
fit 12×2: own Newton                             mean    9.04 µs  p50    6.97 µs  p99  160.36 µs
fit 12×2: ml-logistic-regression (50k GD steps)  mean 194375.04 µs  p50 195174.72 µs  p99 218386.18 µs
── Seedable uniform generators (one double each)
own xoshiro128** uniform()             mean    15.2 ns  p50    13.4 ns  p99    35.6 ns
sfc32 (inline)                         mean     6.7 ns  p50     6.3 ns  p99    13.4 ns
pure-rand xoroshiro128+ next() / 2^32  mean     8.0 ns  p50     7.3 ns  p99    17.1 ns
seedrandom alea                        mean     8.9 ns  p50     8.3 ns  p99    18.7 ns
seedrandom xor4096                     mean     9.3 ns  p50     8.4 ns  p99    21.9 ns
Math.random (not seedable)             mean     8.6 ns  p50     8.1 ns  p99    18.2 ns
── Beta sampling: KS statistic, n = 20,000 (0.1% critical value 0.0138)
  own (Marsaglia–Tsang)      Beta(0.4,3.6) 0.0080  Beta(2.5,7.5) 0.0073  Beta(0.05,2) 0.0049  Beta(1000,2000) 0.0030
  @stdlib/random-base-beta   Beta(0.4,3.6) 0.0099  Beta(2.5,7.5) 0.0041  Beta(0.05,2) 0.0048  Beta(1000,2000) 0.0063
  jstat beta.sample          Beta(0.4,3.6) 0.0081  Beta(2.5,7.5) 0.0076  Beta(0.05,2) 0.0062  Beta(1000,2000) 0.0097
30 Beta draws (shapes 0.4–21, 3.6–41): own (Marsaglia–Tsang)     mean    2.37 µs  p50    2.27 µs  p99    5.10 µs
30 Beta draws (shapes 0.4–21, 3.6–41): @stdlib/random-base-beta  mean    6.72 µs  p50    6.65 µs  p99    9.56 µs
30 Beta draws (shapes 0.4–21, 3.6–41): jstat beta.sample         mean    2.83 µs  p50    2.81 µs  p99    4.10 µs
── MMR over 50 candidates, k = 3 (LangChain computes cosine itself; Packer takes precomputed sims)
@langchain/core maximalMarginalRelevance (64-d)  mean   22.60 µs  p50   17.09 µs  p99  119.91 µs
own Packer.pack (precomputed 50×50 sims)         mean    1.51 µs  p50    1.40 µs  p99    3.38 µs
```

| Need | Candidates | Decision | Why |
|---|---|---|---|
| Beta quantile, binomial CDF | jstat 1.9.6, `@stdlib/*` 0.2.x, simple-statistics 7.12.1 | **write our own** (`stats.ts`) | @stdlib is the most accurate (4.3e-16) but one quantile pulls in dozens of `@stdlib/*` packages, against D15's two-dependency rule; jstat's binomial CDF is off by 1.1e-7 relative and its quantile by 8.7e-10; simple-statistics has no quantile and builds a pmf array per CDF call (4.62 µs). Ours: ≤ 2.3e-13 relative here, and ≤ 1e-11 relative asserted in `stats.test.ts` on 44 scipy values; ~200 lines. Speed is irrelevant here: thresholds are set offline. |
| Logistic regression | ml-logistic-regression 2.0.0 | **write our own** (Newton/IRLS) | ml-logistic-regression is plain gradient descent with no intercept, no L2 and one-vs-all even for two classes: 17% coefficient error after 194 ms. Newton matched scikit-learn to 2.3e-12 in 9.04 µs. |
| Isotonic regression | none on npm (`isotonic-regression`, `ml-isotonic-regression` do not exist; `pava` is a test runner) | **write our own** (PAV) | Matches scikit-learn's thresholds and predictions exactly (`calibrate.test.ts`). |
| Seedable RNG | pure-rand 8.4.2 (xoroshiro128+), seedrandom 3.0.5 (alea, xor4096), sfc32 | **write our own xoshiro128\*\*** | All are fast enough (6.7–15.2 ns per double; a Beta draw takes roughly three uniforms, so a 30-arm decision takes ~100: an estimate from the algorithm, not counted). xoshiro128\*\* is the one with a published reference vector we can pin (`random.test.ts` reproduces rand_xoshiro's vector for state [1,2,3,4]) and an authors' quality analysis; xoroshiro128+ has weak low bits. Ours is ~2x slower per draw than sfc32 in this harness; at ~100 draws that is under 1 µs of a 2.5–2.8 µs decision. No dependency. |
| Beta sampler | @stdlib/random-base-beta, jstat | **write our own** (Marsaglia–Tsang, log-space for shapes < 1) | All three pass KS; ours is the fastest (2.37 µs per 30 draws vs 6.72 and 2.83) and seedable (jstat draws from `Math.random` unless monkey-patched globally). |
| MMR / packing | @langchain/core `maximalMarginalRelevance` | **write our own** | LangChain's takes embeddings, has no costs, budget, stop rule or exact check; 22.60 µs includes its cosine work, so the timing is not like for like. |

A note on testing samplers: all three fail a KS test at Beta(0.05, 0.05) (statistic ~0.08). That is a float artifact,
not a bug: about 8% of that distribution's mass lies within 1e-16 of 1, which doubles cannot represent, so draws pile
up at exactly 1. The tests use Beta(0.05, 2), whose small mass sits near 0 where doubles are dense.

## Calibration (`calibrate.ts`)

**Correctness.** Penalized logistic regression matches scikit-learn `LogisticRegression(solver="newton-cholesky",
tol=1e-12)` to 1e-8 relative (asserted; the gap is scikit-learn's tolerance) at L2 = 1 and 0.01; Platt scaling matches
a scipy BFGS minimization of Platt's objective to 1e-7 (scipy's BFGS stops at ~2e-8). Edge cases tested: n = 0, 1, 2;
all-same labels (Platt gives (n+1)/(n+2), never certainty); separable data (finite with L2 or Platt targets; flagged
`iterations = -1` without); a constant feature with L2 = 0 (a 1e-10 relative diagonal jitter keeps the Newton step
finite); NaN rows skipped; isotonic ties, single points, all-tied scores.

**Cost** (`bench/calibrate.bench.ts`):

```
fitPlatt, n = 200                               mean   71.22 µs  p50   74.52 µs  p99  113.53 µs
fitPlatt, n = 1000                              mean  254.60 µs  p50  227.91 µs  p99  501.77 µs
Logistic.fit, 8 features, n = 1000, l2 = 1      mean  521.10 µs  p50  461.41 µs  p99  799.26 µs
Isotonic.fit, n = 1000                          mean  212.84 µs  p50  208.78 µs  p99  335.90 µs
selectCalibrator, n = 1000, 5 folds             mean 2567.34 µs  p50 2312.05 µs  p99 3617.18 µs
Platt predict1                                  mean    18.6 ns  p50    16.4 ns  p99    50.0 ns
Logistic.predict, 8 features                    mean    24.0 ns  p50    19.2 ns  p99    48.9 ns
Isotonic.predict                                mean    19.6 ns  p50    19.6 ns  p99    41.6 ns
thresholdForFalseFireRate, n = 1000             mean   32.68 µs  p50   29.19 µs  p99   77.16 µs
thresholdForPrecision, n = 1000, 19-point grid  mean   28.20 µs  p50   28.51 µs  p99   55.50 µs
```

The per-event cost of the gate is a prediction: 19–24 ns. Refitting is a background job.

**Quality by training size.** Raw score s ~ Beta(2, 5); three P(useful | s) truths, none picked to favour a method;
20,000 test rows; mean of 20 seeds. Cells are test log loss / ECE (10 bins):

```
── logistic σ(8(s − 0.4)): test log loss / ECE (10 bins), mean of 20 seeds; "chosen" = selectCalibrator
   n      raw score         Platt             isotonic          chosen (isotonic picked)
   50     0.5180 / 0.0614   0.5239 / 0.0686   0.6922 / 0.0948   0.5283 / 0.0699 (1/20)
   200    0.5172 / 0.0621   0.5039 / 0.0357   0.5478 / 0.0536   0.5039 / 0.0357 (0/20)
   1000   0.5190 / 0.0623   0.4993 / 0.0153   0.5118 / 0.0265   0.4993 / 0.0153 (0/20)
   5000   0.5182 / 0.0619   0.4984 / 0.0094   0.5018 / 0.0147   0.4984 / 0.0094 (0/20)
── convex min(1, 3s⁴): test log loss / ECE (10 bins), mean of 20 seeds; "chosen" = selectCalibrator
   n      raw score         Platt             isotonic          chosen (isotonic picked)
   50     0.3534 / 0.2186   0.1882 / 0.0356   0.2868 / 0.0470   0.1882 / 0.0356 (0/20)
   200    0.3541 / 0.2183   0.1666 / 0.0156   0.1969 / 0.0242   0.1678 / 0.0159 (1/20)
   1000   0.3542 / 0.2175   0.1644 / 0.0101   0.1723 / 0.0129   0.1650 / 0.0105 (1/20)
   5000   0.3539 / 0.2182   0.1619 / 0.0060   0.1628 / 0.0057   0.1623 / 0.0060 (7/20)
── step 0.05 | 0.85 at 0.7: test log loss / ECE (10 bins), mean of 20 seeds; "chosen" = selectCalibrator
   n      raw score         Platt             isotonic          chosen (isotonic picked)
   50     0.4102 / 0.2291   0.2342 / 0.0273   0.2967 / 0.0360   0.2342 / 0.0273 (0/20)
   200    0.4105 / 0.2291   0.2235 / 0.0195   0.2319 / 0.0189   0.2245 / 0.0180 (7/20)
   1000   0.4124 / 0.2282   0.2222 / 0.0128   0.2138 / 0.0080   0.2151 / 0.0086 (18/20)
   5000   0.4112 / 0.2289   0.2187 / 0.0067   0.2034 / 0.0034   0.2034 / 0.0034 (20/20)
```

By log loss, Platt is better below ~1,000 labels on every truth; isotonic overtakes only on the step truth from 1,000
labels and comes within 0.0009 on the convex one at 5,000. That reproduces Niculescu-Mizil & Caruana's rule of thumb on this data.
`selectCalibrator` (5-fold log loss, isotonic must be strictly better) tracks the better of the two and never costs
more than 0.0044 log loss against the better of the two (0.5283 vs 0.5239, at 50 rows). **Decision: Platt by default;
`selectCalibrator` once a segment has ~1,000 labels.**

**Thresholds: false-fire rate.** The eval's `falseFireRate` is false fires / silent turns, i.e. P(fire | should be
silent). `thresholdForFalseFireRate` is the Neyman–Pearson umbrella order statistic (Tong, Feng & Li 2018): exact and
distribution-free, no multiple-testing correction needed, and it needs only negatives, which silent turns supply in
bulk. α = δ = 0.1; 2,000 calibration draws per row; negatives' scores ~ Beta(2, 5) so the true rate is known exactly:

```
── false-fire rate ≤ 0.1 with δ = 0.1: 2000 calibration draws per row
   negatives  method                 violations  silent   mean true FFR
   21         NP order statistic     0.0000      1.000    0.0000
   21         naive 90% quantile     0.6650      0.000    0.1383
   22         NP order statistic     0.1040      0.000    0.0433
   22         naive 90% quantile     0.6210      0.000    0.1309
   50         NP order statistic     0.0360      0.000    0.0392
   50         naive 90% quantile     0.6195      0.000    0.1173
   200        NP order statistic     0.0875      0.000    0.0744
   200        naive 90% quantile     0.5450      0.000    0.1038
   1000       NP order statistic     0.0890      0.000    0.0877
   1000       naive 90% quantile     0.5230      0.000    0.1008
```

The guarantee holds at every size (22 negatives: 0.1040 against a designed 0.0985, within one standard error of
0.0067), and with 21 negatives it refuses and stays silent. Picking the empirical 90% quantile breaks the target in
52–67% of draws. `calibrate.test.ts` also pins that the simulated violation rate equals the exact achieved δ
(P(Bin(200, 0.1) ≤ 14) = 0.0929) within three standard errors: the bound is tight, not just valid.

**Thresholds: precision.** `thresholdForPrecision` tests a fixed grid with a binomial (Clopper–Pearson) p-value per
point, Bonferroni-corrected so choosing the lowest passing point keeps the guarantee. With P(useful | s) = σ(8(s − 0.4))
the oracle threshold (true precision ≥ 0.9) fires on 2.23% of events:

```
── precision ≥ 0.9 with δ = 0.1, grid 0.05…0.95: oracle threshold 0.65 fires on 0.0223 of events; 1000 draws per row
   n      method                        violations  silent   mean fire rate
   200    Clopper–Pearson + Bonf.       0.000       1.000    0.0000
   200    fixed sequence (not shipped)  0.007       0.993    0.0008
   200    naive empirical ≥ 0.9         0.596       0.096    0.0471
   1000   Clopper–Pearson + Bonf.       0.000       1.000    0.0000
   1000   fixed sequence (not shipped)  0.030       0.931    0.0022
   1000   naive empirical ≥ 0.9         0.459       0.030    0.0306
   5000   Clopper–Pearson + Bonf.       0.001       0.964    0.0005
   5000   fixed sequence (not shipped)  0.015       0.704    0.0042
   5000   naive empirical ≥ 0.9         0.334       0.004    0.0256
   20000  Clopper–Pearson + Bonf.       0.001       0.618    0.0048
   20000  fixed sequence (not shipped)  0.002       0.559    0.0065
   20000  naive empirical ≥ 0.9         0.190       0.000    0.0248
```

Certifying precision needs fired examples, and at a 2% fire rate even 5,000 labelled events hold ~110 fires near the
oracle threshold. Both certified procedures stay almost always silent below 5,000 events; the naive one breaks the
target in 19–60% of draws. The fixed-sequence variant (Learn-then-Test style, skipping grid points with too few fires)
is less conservative, but skipping makes its starting point data-dependent, which the standard FWER argument does not
cover, so it is not shipped. **Decision: gate with `thresholdForFalseFireRate` (Eden's own metric, needs only
negatives); use `thresholdForPrecision` as a report or a second gate once fires accumulate. A naive empirical
threshold is never acceptable.** With too little data every threshold function returns +Infinity: silence.

Both guarantees assume the calibration sample is exchangeable with future events. Per-user drift breaks that; refit
per window (unmeasured how much slack drift needs). The threshold must be set on rows not used to fit the
calibrator.

## Source selection (`bandit.ts`)

**Correctness.** Beta draws pass KS against the exact CDF for shapes 0.05–2,000 (`random.test.ts`); the Monte Carlo
inclusion propensity for two arms matches P(θ₁ > θ₂) computed by quadrature within 4 standard errors; propensities sum
to k and are 0 for ineligible arms; with an ε floor every eligible arm has π ≥ ε·k/eligible; IPS over logged
propensities recovers the uniform policy's value within 15% after 4,000 decisions (`bandit.test.ts`).

**Cost** (`bench/bandit.bench.ts`):

```
select k=3 of 30 arms (TS, ε 0.05)       mean    2.82 µs  p50    2.83 µs  p99    5.07 µs
select k=3 of 30 arms, eligibility mask  mean    2.46 µs  p50    2.38 µs  p99    3.65 µs
select k=3 of 12 arms (TS, ε 0.05)       mean    1.05 µs  p50   992.4 ns  p99    2.19 µs
update 3 arms + decay(1), 30 arms        mean    95.6 ns  p50    65.7 ns  p99   330.9 ns
inclusionPropensity, 30 arms, 200 draws  mean  637.88 µs  p50  679.18 µs  p99  862.46 µs
```

A decision is microseconds. A 200-draw propensity estimate is ~0.6 ms: log it off the hot path or on a sample of
decisions, or lower `draws` (standard error √(π(1−π)/draws)).

**Regret on drifting sources.** k = 3 queried per decision, T = 5,000, 20 seeds; usefulness p ~ Beta(1, 3) (mean
0.25); stationary, abrupt (every 1,000 decisions each source redraws with probability 0.3) and drift (logit random
walk, sd 0.05 per decision). Columns: regret per decision (sd across seeds), the same over the first 200 decisions,
and mean |posterior mean − p| (how well the estimates track the truth). "Greedy mean, Beta(1,1)" ranks by the
posterior mean alone, the learned-utility part of today's `source-map.ts` ranking (without its entity-hit term).
The prior 0.25×4 uses the simulation's true population mean, so it is the best case for a population prior.

```
── stationary, 12 sources, k = 3, T = 5000, 20 seeds: regret/decision (sd), first 200, |mean − p|
  uniform random                               0.7306 (0.1683)   0.7266   0.0164
  greedy mean, Beta(1,1) (today's ranking)     0.0534 (0.0736)   0.1181   0.0991
  TS, Beta(1,1), γ 1                           0.0220 (0.0076)   0.1903   0.0348
  TS, prior 0.25×4, γ 1                        0.0214 (0.0113)   0.1915   0.0371
  TS, prior 0.25×4, γ 0.995                    0.0982 (0.0126)   0.2033   0.0521
  TS, prior 0.25×4, γ 0.99                     0.1404 (0.0167)   0.2249   0.0623
  TS, prior 0.25×4, γ 0.98                     0.1989 (0.0271)   0.2545   0.0746
  TS, prior 0.25×4, γ 0.99 per arm             0.0348 (0.0097)   0.1969   0.0413
  TS, prior 0.25×4, γ 0.98 per arm             0.0483 (0.0118)   0.1949   0.0428
  TS, prior 0.25×4, γ 0.99, ε 0.05             0.1633 (0.0158)   0.2446   0.0606
── abrupt, 12 sources, k = 3, T = 5000, 20 seeds: regret/decision (sd), first 200, |mean − p|
  uniform random                               0.7084 (0.1368)   0.7266   0.0712
  greedy mean, Beta(1,1) (today's ranking)     0.2974 (0.1108)   0.1181   0.1255
  TS, Beta(1,1), γ 1                           0.2167 (0.0768)   0.1903   0.0897
  TS, prior 0.25×4, γ 1                        0.2327 (0.0844)   0.1915   0.0909
  TS, prior 0.25×4, γ 0.995                    0.1184 (0.0130)   0.2033   0.0587
  TS, prior 0.25×4, γ 0.99                     0.1513 (0.0163)   0.2249   0.0631
  TS, prior 0.25×4, γ 0.98                     0.2060 (0.0233)   0.2545   0.0738
  TS, prior 0.25×4, γ 0.99 per arm             0.1056 (0.0415)   0.1969   0.0669
  TS, prior 0.25×4, γ 0.98 per arm             0.0911 (0.0384)   0.1949   0.0666
  TS, prior 0.25×4, γ 0.99, ε 0.05             0.1724 (0.0137)   0.2446   0.0620
── drift, 12 sources, k = 3, T = 5000, 20 seeds: regret/decision (sd), first 200, |mean − p|
  uniform random                               1.2662 (0.1904)   0.8320   0.1331
  greedy mean, Beta(1,1) (today's ranking)     0.5388 (0.2494)   0.1782   0.2123
  TS, Beta(1,1), γ 1                           0.2811 (0.1284)   0.2142   0.1733
  TS, prior 0.25×4, γ 1                        0.2812 (0.1518)   0.1962   0.1703
  TS, prior 0.25×4, γ 0.995                    0.1003 (0.0290)   0.2126   0.1202
  TS, prior 0.25×4, γ 0.99                     0.1127 (0.0310)   0.2273   0.1198
  TS, prior 0.25×4, γ 0.98                     0.1448 (0.0385)   0.2721   0.1262
  TS, prior 0.25×4, γ 0.99 per arm             0.1331 (0.0874)   0.1885   0.1385
  TS, prior 0.25×4, γ 0.98 per arm             0.1192 (0.0596)   0.2048   0.1297
  TS, prior 0.25×4, γ 0.99, ε 0.05             0.1583 (0.0213)   0.2708   0.1081
── stationary, 30 sources, k = 3, T = 5000, 20 seeds: regret/decision (sd), first 200, |mean − p|
  uniform random                               1.0801 (0.1762)   1.0751   0.0245
  greedy mean, Beta(1,1) (today's ranking)     0.1538 (0.1434)   0.2703   0.1503
  TS, Beta(1,1), γ 1                           0.0533 (0.0107)   0.4547   0.0579
  TS, prior 0.25×4, γ 1                        0.0467 (0.0123)   0.3748   0.0592
  TS, prior 0.25×4, γ 0.995                    0.2272 (0.0260)   0.4184   0.0770
  TS, prior 0.25×4, γ 0.99                     0.3161 (0.0312)   0.4582   0.0871
  TS, prior 0.25×4, γ 0.98                     0.4343 (0.0405)   0.5321   0.1001
  TS, prior 0.25×4, γ 0.99 per arm             0.0708 (0.0189)   0.3697   0.0599
  TS, prior 0.25×4, γ 0.98 per arm             0.0900 (0.0169)   0.3922   0.0633
  TS, prior 0.25×4, γ 0.99, ε 0.05             0.3422 (0.0243)   0.5143   0.0853
── abrupt, 30 sources, k = 3, T = 5000, 20 seeds: regret/decision (sd), first 200, |mean − p|
  uniform random                               1.1293 (0.1816)   1.0751   0.0785
  greedy mean, Beta(1,1) (today's ranking)     0.5171 (0.2234)   0.2703   0.1651
  TS, Beta(1,1), γ 1                           0.2744 (0.1246)   0.4547   0.1126
  TS, prior 0.25×4, γ 1                        0.2745 (0.1378)   0.3748   0.1111
  TS, prior 0.25×4, γ 0.995                    0.2480 (0.0281)   0.4184   0.0833
  TS, prior 0.25×4, γ 0.99                     0.3264 (0.0391)   0.4582   0.0904
  TS, prior 0.25×4, γ 0.98                     0.4379 (0.0476)   0.5321   0.1024
  TS, prior 0.25×4, γ 0.99 per arm             0.1607 (0.0670)   0.3697   0.0948
  TS, prior 0.25×4, γ 0.98 per arm             0.1688 (0.0656)   0.3922   0.0928
  TS, prior 0.25×4, γ 0.99, ε 0.05             0.3578 (0.0320)   0.5143   0.0893
── drift, 30 sources, k = 3, T = 5000, 20 seeds: regret/decision (sd), first 200, |mean − p|
  uniform random                               1.7306 (0.1204)   1.2074   0.1292
  greedy mean, Beta(1,1) (today's ranking)     0.6714 (0.3344)   0.2991   0.2634
  TS, Beta(1,1), γ 1                           0.3260 (0.1451)   0.4626   0.2002
  TS, prior 0.25×4, γ 1                        0.3570 (0.1368)   0.4066   0.2098
  TS, prior 0.25×4, γ 0.995                    0.1293 (0.0236)   0.4347   0.1855
  TS, prior 0.25×4, γ 0.99                     0.1489 (0.0337)   0.4748   0.1919
  TS, prior 0.25×4, γ 0.98                     0.1943 (0.0457)   0.5340   0.1985
  TS, prior 0.25×4, γ 0.99 per arm             0.1749 (0.0716)   0.3980   0.1911
  TS, prior 0.25×4, γ 0.98 per arm             0.1545 (0.0473)   0.4079   0.1862
  TS, prior 0.25×4, γ 0.99, ε 0.05             0.2175 (0.0264)   0.5300   0.1751
```

What it says:

- **Thompson sampling without global discounting beats ranking by posterior mean in all six scenarios** over 5,000
  decisions (stationary, 30 sources: 0.0467 vs 0.1538 regret per decision), and its seed-to-seed spread is far smaller (sd 0.0123 vs 0.1434):
  greedy ranking sometimes locks onto the wrong sources for good. Greedy has lower regret in the first 200 decisions
  (0.2703 vs 0.3748): exploration is paid up front.
- **Discounting every arm per decision (the research notes' γ = 0.99) is the wrong default.** It pulls every idle
  source back to a weak prior, so idle sources keep out-drawing the best ones: 6.8x the
  stationary regret of no discounting (0.3161 vs 0.0467) and worse than no discounting even under abrupt change with
  30 sources (0.3264 vs 0.2745). It wins only under continuous drift. **Per-arm discounting** (`decayArm` before each
  update: a source forgets its own old outcomes, an idle source keeps its estimate) was never the worst TS variant:
  1.5–1.6x the stationary regret of no discounting, the lowest regret under abrupt change (0.0911 at 12, 0.1607 at
  30 sources), and within 0.02–0.05 of the best under drift. Not tuned: γ ∈ {0.98, 0.99} are the notes' range, and
  per-arm vs global is a structural choice made on worst-case behaviour across all six scenarios.
- **The population prior helps cold start with many sources** (first 200 decisions, 30 sources: 0.3748 vs 0.4547
  with Beta(1,1)) and changes little later. This is with the true population mean; a wrong prior was not measured.
- **The ε = 0.05 floor costs 0.021–0.069 regret per decision** against the same policy without it (0.1633 vs 0.1404
  stationary at 12 sources; 0.2175 vs 0.1489 under drift at 30). That is the
  price of bounded IPS weights; the notes' 1–5% holdout is the same trade.

**Decision: TS with per-arm discounting (`decayArm`, γ 0.99) and a population prior of strength 4 as the default;
ε 0.05 only where decisions are logged for off-policy evaluation.** Explore only in which sources to query, never by
injecting (D3). Rewards (any item from the source used) arrive late: update when they do; Thompson sampling tolerates
delay (Chapelle & Li 2011, not re-verified).

## Packing (`pack.ts`)

**Objective.** f(S) = Σ rel_i − β·Σ_pairs sim(i, j)·min(rel_i, rel_j): relevance covered, with the second-order
inclusion–exclusion correction for what two items share. Submodular (pair weights ≥ 0), not monotone. With β = 1 an
exact duplicate adds exactly nothing. The λ-MMR it replaces (λ·rel − (1−λ)·max sim, λ = 0.7 in fast-primitives.md)
charges redundancy in similarity units: an exact duplicate of a chosen item with rel > 0.43 still has positive gain
and is packed (`pack.test.ts` shows the case).

**Algorithm.** Lin & Bilmes (2010) budgeted greedy on gain / cost^r, skipping items that no longer fit; stop at the
first non-positive gain (never pads). `pack` also runs the plain (r = 0) greedy and keeps the better packet; its first
pick is the best single item that fits, which subsumes Lin–Bilmes' singleton comparison. `packExact` enumerates
subsets for a measured optimum. Correctness: `packExact` equals an independent bitmask brute force on 300 random
instances; the greedy is always feasible and never above it.

```
pack, 20 candidates, r = 0.5                        mean   913.8 ns  p50   778.5 ns  p99    2.05 µs
pack, 50 candidates, r = 0.5                        mean    2.57 µs  p50    2.09 µs  p99    4.96 µs
pack, 50 candidates, r = 0 (one greedy pass)        mean    1.24 µs  p50    1.22 µs  p99    1.75 µs
packExact, 20 candidates, ≤ 3 items                 mean   14.72 µs  p50   15.02 µs  p99   18.12 µs
packExact, 50 candidates, ≤ 3 items                 mean  203.40 µs  p50  210.97 µs  p99  276.32 µs
jaccardMatrix, 50 items, harness corpus (2249 ids)  mean  224.97 µs  p50  211.00 µs  p99  399.29 µs
jaccardMatrix, 50 items, Zipf, 5k words (2250 ids)  mean  264.05 µs  p50  258.26 µs  p99  354.28 µs
── greedy / exact optimum, "eden" (50 candidates, ≤ 3 items, 1,200 bytes), 2000 instances
   r = 0.0  mean 0.9987  min 0.9374  optimal 88.2%  plain greedy kept 0  (cost-scaled pass alone: mean 0.9987, min 0.9374)
   r = 0.5  mean 0.9987  min 0.9374  optimal 88.4%  plain greedy kept 1916  (cost-scaled pass alone: mean 0.8660, min 0.5699)
   r = 1.0  mean 0.9987  min 0.9374  optimal 88.3%  plain greedy kept 1976  (cost-scaled pass alone: mean 0.7903, min 0.4046)
── greedy / exact optimum, "tight" (20 candidates, ≤ 6 items, 1,200 bytes), 2000 instances
   r = 0.0  mean 0.9558  min 0.2656  optimal 60.9%  plain greedy kept 0  (cost-scaled pass alone: mean 0.9558, min 0.2656)
   r = 0.5  mean 0.9930  min 0.8495  optimal 70.2%  plain greedy kept 1225  (cost-scaled pass alone: mean 0.9700, min 0.8185)
   r = 1.0  mean 0.9852  min 0.7679  optimal 64.2%  plain greedy kept 1594  (cost-scaled pass alone: mean 0.9234, min 0.6494)
── packets with a pair of similarity ≥ 0.8, "eden" class, 2000 instances
   Packer β = 1, r = 0.5    near-duplicate packets 0.0%  items/packet 3.00  Σ rel/packet 2.294
   λ-MMR λ = 0.7, r = 0.5   near-duplicate packets 0.1%  items/packet 3.00  Σ rel/packet 2.004
   λ-MMR λ = 0.5, r = 0.5   near-duplicate packets 0.0%  items/packet 3.00  Σ rel/packet 2.015
```

What it says:

- **Cost scaling alone is a trap for Eden's shape.** With items pre-truncated to 25% of the budget and at most 3 per
  packet, the item cap binds and the byte budget never does, so dividing by cost^r only steers toward small items:
  the cost-scaled pass alone reached 0.8660 (r = 0.5) and 0.7903 (r = 1) of the optimum on average. When bytes do
  bind ("tight"), the plain pass alone has a 0.2656 worst case. Running both and keeping the better gave 0.9987 and
  0.9930 mean, 0.9374 and 0.8495 worst, for ~1 µs more.
- **`packExact` is affordable at Eden's size** (~0.2 ms for 50 candidates, ≤ 3 items) but buys 0.13% on average over
  the greedy here; the greedy is the default, the exact search the reference.
- **Near-duplicates were rare for every objective on these instances** (≤ 0.1% of packets): with 50 candidates there
  is usually something non-redundant left. The objective change matters when few candidates remain, and it packs more
  relevance (2.294 vs 2.004 per packet) because it does not trade relevance for similarity units. Deduplicate exact
  and near copies before packing anyway (fast-primitives.md step 1).
- **`jaccardMatrix` is the most expensive step here** (~0.22–0.26 ms for 50 items, 1,225 pairs). A branch-free merge
  made it 1.7x faster than if/else merging (a scratch micro-benchmark measured 374 → 225 µs in one run on dense
  synthetic sets; not kept as a repo benchmark). Fewer candidates cut it quadratically (190 pairs at 20). Computing only the rows of
  picked items would cut the pairs ~4x (≤ 6 rows of 49 instead of 1,225 pairs; arithmetic, not measured); not done.

**Decision: `pack` with β = 1, r = 0.5, Eden's maxItems and byte budget; `rel` must be the calibrated probability.**

## Proposed defaults and exports

Defaults for the integrator (each traced to a table above, none tuned on Eden data, which does not exist yet):

| Setting | Default | Change when |
|---|---|---|
| Calibrator | Platt (`fitPlatt`) | ≥ ~1,000 labels in a segment: `selectCalibrator` |
| Gate threshold | `thresholdForFalseFireRate`, α 0.1, δ 0.1 | Precision certificate needs thousands of fires |
| Silence | +Infinity threshold below 22 negatives | Never fire on an uncertified threshold |
| Bandit | TS, prior strength 4 at the source kind's population mean, `decayArm` γ 0.99 | Continuous drift dominates: global `decay` γ 0.995 |
| Exploration floor | ε 0.05 on logged decisions only | Off-policy evaluation not needed: 0 |
| Packer | β 1, r 0.5 | — |

Proposed additions to `src/index.ts`:

```ts
export { betaInc, betaIncInv, binomCdf, clopperPearsonLower, clopperPearsonUpper, log1pExp, logBeta, logGamma,
  minTrialsToCertify, sigmoid } from "./stats";
export { Xoshiro128 } from "./random";
export { expectedCalibrationError, fires, fitPlatt, ISOTONIC, Isotonic, Logistic, logLoss, PLATT, selectCalibrator,
  thresholdForFalseFireRate, thresholdForPrecision, type CalibratorChoice, type Threshold } from "./calibrate";
export { BetaBandit, ipsValue } from "./bandit";
export { jaccardMatrix, Packer } from "./pack";
```

And five rows in `packages/primitives/README.md`'s module table (not edited here, per the brief).

## Not measured, and limits

- **No Eden data.** Every quality number is from simulation. The truths, drift models and instance shapes are guesses
  at Eden's shape, not measurements of it; the eval harness has no labelled calibration set yet.
- **The fixed-sequence precision procedure's validity** with a data-dependent start: not proven, so not shipped. Its
  simulated violation rate stayed ≤ 0.030 at δ = 0.1, which is evidence, not a guarantee.
- **Drift and exchangeability.** How much the NP and Clopper–Pearson guarantees degrade under per-user drift, and how
  long a recalibration window must be: not measured.
- **A wrong population prior** for the bandit (prior mean far from the truth): not measured. Delayed and batched
  rewards, position bias in "used" signals, and the implicit-use proxy's agreement with explicit labels: not measured.
- **IPS variance** beyond one stationary setting (15% relative error at 4,000 decisions); doubly robust or
  self-normalized estimators: not implemented.
- **Contextual bandits** (LinTS/LinUCB) and the cue-match `scale` input to `select`: implemented as an input, not
  evaluated.
- **Packing with real similarity.** Instances use synthetic clustered similarities; Jaccard over real snippets and
  embedding cosine were not compared for packet quality.
- **Node.js** timings, and the RNG's statistical quality beyond KS and moment tests (no PractRand/TestU01 run; we
  rely on the authors' published analysis for xoshiro128\*\*).
- `jstat`'s and `@stdlib`'s other distributions, `mnemonist`, and any MMR library besides LangChain's: not compared.

## Reproduce

```bash
bun packages/primitives/bench/calibrate.bench.ts
bun packages/primitives/bench/bandit.bench.ts
bun packages/primitives/bench/pack.bench.ts
# Libraries: install them in a scratch directory and link its node_modules (see the file's header), then
bun packages/primitives/bench/compare/decision.compare.ts
```

Reference values were printed by a Python script outside the repo calling `scipy.special.betainc`, `betaincinv`,
`gammaln`, `scipy.stats.beta.ppf` (Clopper–Pearson bounds as `beta.ppf(1 − δ, k + 1, n − k)` and
`beta.ppf(δ, k, n − k + 1)`), `scipy.stats.binom.cdf`, scikit-learn's `LogisticRegression(C = 1/l2,
solver="newton-cholesky", tol=1e-12)` (and `penalty=None`), `IsotonicRegression(out_of_bounds="clip")`, and
`scipy.optimize.minimize(method="BFGS", gtol=1e-12)` on Platt's objective; the values are inlined in the tests with
their inputs. The xoshiro128\*\* vector for state [1, 2, 3, 4] is the one published in Rust's `rand_xoshiro` tests;
a C transcription of the reference `next()` reproduced it and printed the second vector used in `random.test.ts`.
