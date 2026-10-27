/**
 * Noise-floor calibration: A/A jitter → MDE, stability, false-loss rates.
 *
 * Frozen definitions (do not silently retune):
 *
 *   relativeDelta_i = (b_i - a_i) / max(a_i, eps)
 *   relativeSd      = stdev(relativeDeltas)
 *   stability       = clamp(1 - relativeSd / 0.05, 0, 1)
 *                     // 1 = quieter than 5% CV on A/A relative deltas
 *
 *   mdeAbs(n)       = minDetectableEffect(stdev(a-b deltas), n)
 *   mdeRel(n)       = mdeAbs(n) / max(|mean(a)|, eps)
 *
 *   predictFalseLossRate: Monte Carlo P(sign of mean(relative deltas) disagrees
 *   with sign(trueRelativeOverhead)), deltas ~ N(trueRel, relativeSd).
 *   Huge jitter → ~0.5; tiny jitter → ~0. This is the "creative +0.1% wall flips"
 *   predictability: noise reversing the measured direction of a real tiny overhead.
 *
 *   predictLossVerdictRate: Monte Carlo P(decide-style LOSS at alpha) given the
 *   same generative model — mean>0, pairedPermutationP<=alpha, bootstrap CI
 *   excludes 0 (wall_ms, higherIsBetter=false).
 */
import { mean, minDetectableEffect, mulberry32, pairedBootstrapCI, pairedPermutationP, stdev } from "./stats";

const EPS = 1e-12;
const STABILITY_CV = 0.05; // frozen: 5% relative CV → stability 1

export type AaPair = { a: number; b: number };

export type MdeAtN = {
  n: number;
  /** Absolute MDE in the same units as the samples (e.g. wall_ms). */
  absolute: number;
  /** Absolute / |mean(a)|. */
  relative: number;
};

export type Calibration = {
  nPairs: number;
  meanA: number;
  meanB: number;
  /** Sample sd of (b − a). */
  deltaSd: number;
  /** Sample sd of (b − a) / max(a, eps). */
  relativeSd: number;
  /** Frozen: clamp(1 - relativeSd / 0.05, 0, 1). */
  stability: number;
  mde: MdeAtN[];
  /** P(sign flip | trueRel) at each n, default trueRel = 0.001. */
  falseLoss: Array<{ n: number; rate: number; trueRelativeOverhead: number }>;
  /** P(LOSS verdict @ alpha | trueRel) at each n. */
  lossVerdict: Array<{ n: number; rate: number; trueRelativeOverhead: number; alpha: number }>;
};

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Box–Muller using a seeded PRNG — never Math.random. */
export function normalFrom(rand: () => number): number {
  let u = 0;
  let v = 0;
  // Avoid log(0).
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Frozen stability score: 1 when A/A relative CV ≤ 5%, 0 when CV ≥ 5%.
 * `relativeSd` is stdev of (b−a)/max(a,eps) over A/A pairs.
 */
export function stabilityScore(relativeSd: number): number {
  if (!Number.isFinite(relativeSd) || relativeSd < 0) return 0;
  return clamp01(1 - relativeSd / STABILITY_CV);
}

export function relativeDeltas(pairs: readonly AaPair[], eps = EPS): number[] {
  return pairs.map(({ a, b }) => (b - a) / Math.max(a, eps));
}

export function absoluteDeltas(pairs: readonly AaPair[]): number[] {
  return pairs.map(({ a, b }) => b - a);
}

/**
 * P(sign(mean) disagrees with sign(trueRelativeOverhead)) under
 * relativeDeltas ~ iid N(trueRelativeOverhead, relativeSd), n blocks.
 */
export function predictFalseLossRate(
  relativeSd: number,
  trueRelativeOverhead: number,
  n: number,
  opts: { trials?: number; seed?: number } = {},
): number {
  if (n < 1) return 0;
  if (!(relativeSd >= 0) || !Number.isFinite(relativeSd)) return 0;
  if (trueRelativeOverhead === 0) {
    // Under a true zero, "wrong sign" is undefined; treat as coin-flip on nonzero means.
    return 0.5;
  }
  const trials = opts.trials ?? 4000;
  const rand = mulberry32(opts.seed ?? 0xc41b);
  const wantPositive = trueRelativeOverhead > 0;
  let flips = 0;
  for (let t = 0; t < trials; t++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += trueRelativeOverhead + relativeSd * normalFrom(rand);
    const m = sum / n;
    if (wantPositive ? m < 0 : m > 0) flips++;
  }
  return flips / trials;
}

/**
 * P(decide-style LOSS at `alpha`) for wall-style metrics (higher is worse):
 * mean delta > 0, permutation p ≤ alpha, bootstrap CI excludes 0.
 * Relative deltas ~ N(trueRelativeOverhead, relativeSd).
 */
export function predictLossVerdictRate(
  relativeSd: number,
  trueRelativeOverhead: number,
  n: number,
  opts: { trials?: number; seed?: number; alpha?: number } = {},
): number {
  if (n < 2) return 0;
  if (!(relativeSd >= 0) || !Number.isFinite(relativeSd)) return 0;
  const trials = opts.trials ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rand = mulberry32(opts.seed ?? 0xa11c);
  let losses = 0;
  for (let t = 0; t < trials; t++) {
    const deltas = new Array<number>(n);
    for (let i = 0; i < n; i++) deltas[i] = trueRelativeOverhead + relativeSd * normalFrom(rand);
    const m = mean(deltas);
    if (!(m > 0)) continue;
    const p = pairedPermutationP(deltas, { seed: (opts.seed ?? 0xa11c) + t + 1 });
    if (p > alpha) continue;
    const ci = pairedBootstrapCI(deltas, { alpha, seed: (opts.seed ?? 0xa11c) + t + 2, iters: 800 });
    if (ci.lo > 0) losses++;
  }
  return losses / trials;
}

const DEFAULT_NS = [8, 12, 16] as const;
const DEFAULT_TRUE_REL = 0.001; // +0.1%

/**
 * Full calibration from paired A/A wall (or other) samples.
 * `pairs` are same-arm duplicates: a and b are two independent raw runs.
 */
export function calibrate(
  pairs: readonly AaPair[],
  opts: {
    ns?: readonly number[];
    trueRelativeOverhead?: number;
    alpha?: number;
    falseLossTrials?: number;
    lossVerdictTrials?: number;
    seed?: number;
  } = {},
): Calibration {
  const ns = opts.ns ?? DEFAULT_NS;
  const trueRel = opts.trueRelativeOverhead ?? DEFAULT_TRUE_REL;
  const alpha = opts.alpha ?? 0.05;
  const seed = opts.seed ?? 0x5eed;

  const as = pairs.map((p) => p.a);
  const meanA = mean(as);
  const meanB = mean(pairs.map((p) => p.b));
  const absD = absoluteDeltas(pairs);
  const relD = relativeDeltas(pairs);
  const deltaSd = stdev(absD);
  const relSd = stdev(relD);
  const base = Math.max(Math.abs(meanA), EPS);

  const mde: MdeAtN[] = ns.map((n) => {
    const absolute = minDetectableEffect(deltaSd, n, { alpha });
    return { n, absolute, relative: absolute / base };
  });

  const falseLoss = ns.map((n) => ({
    n,
    trueRelativeOverhead: trueRel,
    rate: predictFalseLossRate(relSd, trueRel, n, {
      trials: opts.falseLossTrials ?? 4000,
      seed: seed ^ (n * 0x9e3779b9),
    }),
  }));

  const lossVerdict = ns.map((n) => ({
    n,
    trueRelativeOverhead: trueRel,
    alpha,
    rate: predictLossVerdictRate(relSd, trueRel, n, {
      trials: opts.lossVerdictTrials ?? 1500,
      seed: seed ^ (n * 0x85ebca6b),
      alpha,
    }),
  }));

  return {
    nPairs: pairs.length,
    meanA,
    meanB,
    deltaSd,
    relativeSd: relSd,
    stability: stabilityScore(relSd),
    mde,
    falseLoss,
    lossVerdict,
  };
}
