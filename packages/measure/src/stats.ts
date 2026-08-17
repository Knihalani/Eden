/**
 * The statistics an A/B claim needs in order to mean anything.
 *
 * Every function here is deterministic: the resampling routines take a seed and
 * use an explicit PRNG rather than Math.random, so a verdict can be recomputed
 * from its inputs and reviewed. A benchmark result you cannot reproduce is a
 * benchmark result you cannot argue with.
 */

export type Interval = { point: number; lo: number; hi: number };

export function mean(xs: readonly number[]): number {
  if (!xs.length) return 0;
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

/** Sample standard deviation (Bessel-corrected). Zero for n < 2. */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let sum = 0;
  for (const x of xs) sum += (x - m) ** 2;
  return Math.sqrt(sum / (xs.length - 1));
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Small, fast, fully deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation).
 * Accurate to ~1.15e-9 across the open interval, which is far beyond what any
 * power calculation on a handful of benchmark runs needs.
 */
export function probit(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`probit expects 0 < p < 1, received ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - plow) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/**
 * Percentile bootstrap confidence interval for the mean of paired deltas.
 *
 * Paired, because the unit of replication is a *block* (one task measured under
 * both arms back to back). Comparing pooled arm totals instead — which is what
 * summing wall-clock over a run does — throws away the pairing and lets
 * between-task variance swamp the within-task effect.
 */
export function pairedBootstrapCI(
  deltas: readonly number[],
  opts: { iters?: number; alpha?: number; seed?: number } = {},
): Interval {
  const n = deltas.length;
  const point = mean(deltas);
  if (n < 2) return { point, lo: Number.NEGATIVE_INFINITY, hi: Number.POSITIVE_INFINITY };
  const iters = opts.iters ?? 10_000;
  const alpha = opts.alpha ?? 0.05;
  const rand = mulberry32(opts.seed ?? 0x5eed);
  const means = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    let total = 0;
    for (let j = 0; j < n; j++) total += deltas[(rand() * n) | 0]!;
    means[i] = total / n;
  }
  const sorted = Float64Array.prototype.slice.call(means).sort();
  const at = (q: number) => sorted[Math.min(iters - 1, Math.max(0, Math.round(q * (iters - 1))))]!;
  return { point, lo: at(alpha / 2), hi: at(1 - alpha / 2) };
}

/**
 * Two-sided paired permutation test by sign flipping.
 *
 * Under the null the arm labels within a block are exchangeable, so negating a
 * block's delta is an equally likely outcome. Enumerates all 2^n sign patterns
 * when n is small enough for that to be exact, and samples otherwise.
 */
export function pairedPermutationP(
  deltas: readonly number[],
  opts: { iters?: number; seed?: number } = {},
): number {
  const n = deltas.length;
  if (n === 0) return 1;
  const observed = Math.abs(mean(deltas));
  if (n <= 20) {
    let atLeast = 0;
    const total = 2 ** n;
    for (let mask = 0; mask < total; mask++) {
      let sum = 0;
      for (let j = 0; j < n; j++) sum += (mask >> j) & 1 ? -deltas[j]! : deltas[j]!;
      // >= with a tolerance: the observed assignment is itself one of the
      // permutations, so an exact test can never report p = 0.
      if (Math.abs(sum / n) >= observed - 1e-12) atLeast++;
    }
    return atLeast / total;
  }
  const iters = opts.iters ?? 20_000;
  const rand = mulberry32(opts.seed ?? 0x5eed);
  let atLeast = 1; // count the observed assignment
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += rand() < 0.5 ? -deltas[j]! : deltas[j]!;
    if (Math.abs(sum / n) >= observed - 1e-12) atLeast++;
  }
  return atLeast / (iters + 1);
}

/**
 * The smallest true effect this design could reliably detect, in the units of
 * the deltas.
 *
 * This is the number a benchmark should print next to every null result. "No
 * significant difference" from a design whose minimum detectable effect is 40%
 * of baseline is not evidence of no difference — it is evidence of no
 * measurement.
 */
export function minDetectableEffect(
  sdOfDeltas: number,
  blocks: number,
  opts: { alpha?: number; power?: number } = {},
): number {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  if (blocks < 2 || sdOfDeltas <= 0) return Number.POSITIVE_INFINITY;
  return (probit(1 - alpha / 2) + probit(power)) * (sdOfDeltas / Math.sqrt(blocks));
}

/**
 * The smallest p-value a paired sign-flip test can produce at `blocks` blocks.
 *
 * The test has only 2^n possible sign assignments, and the two-sided extreme
 * (all deltas as observed, and its mirror) accounts for 2 of them. So with 3
 * blocks the floor is 0.25 — no arrangement of three tasks, however lopsided
 * the result, can clear a 0.05 threshold. This is a property of the design, not
 * of the data, which makes it worth stating before a run rather than after.
 */
export function minAchievableP(blocks: number): number {
  if (blocks < 1) return 1;
  return Math.min(1, 2 / 2 ** blocks);
}

/** Fewest paired blocks at which significance at `alpha` is even reachable. */
export function blocksForResolution(alpha = 0.05): number {
  return Math.max(2, Math.ceil(Math.log2(2 / alpha)));
}

/** How many paired blocks are needed before `effect` becomes detectable. */
export function requiredBlocks(
  sdOfDeltas: number,
  effect: number,
  opts: { alpha?: number; power?: number } = {},
): number {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  if (!(effect > 0)) return Number.POSITIVE_INFINITY;
  if (sdOfDeltas <= 0) return 2;
  const z = probit(1 - alpha / 2) + probit(power);
  return Math.max(2, Math.ceil((z * sdOfDeltas / effect) ** 2));
}
