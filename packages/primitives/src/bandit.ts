/**
 * Source selection as a Beta–Bernoulli semi-bandit: one arm per source, k arms queried per decision, and each queried
 * arm's own reward (was any of its items used?) observed later. Thompson sampling (Thompson 1933; Russo et al. 2018)
 * draws a plausible usefulness for every arm from its posterior and queries the k best draws, so a source is explored
 * in proportion to the chance it is actually among the best, and a source with lots of evidence is not re-explored.
 *
 * - Cold start: each arm's prior is Beta(s·μ, s·(1 − μ)) around a population mean μ with strength s pseudo-
 *   observations (e.g. s = 4), so a new user starts from what that kind of source usually does, not from 0.5.
 * - Non-stationarity: `decay(steps)` pulls every arm's evidence back toward its prior by γ^steps (discounted
 *   Thompson sampling; Raj & Kalyani 2017). The prior is the floor: evidence decays, the prior never does, so a source
 *   unqueried for a long time becomes uncertain again and gets re-explored. Effective memory ≈ 1 / (1 − γ) steps.
 *   `steps` may be fractional, so the caller can decay by elapsed time rather than by decision count. `decayArm`
 *   discounts only the arm being updated, so idle arms are not re-explored for being idle. In simulation (bench/
 *   bandit.bench.ts) per-decision `decay` at γ = 0.99 cost 6.6–6.8x the regret of no discounting on stable sources
 *   with 12–30 arms; `decayArm` at the same γ cost 1.5–1.6x there, and `decayArm` (γ 0.98–0.99) had the lowest
 *   regret under abrupt changes.
 * - Exploration floor: with probability ε the decision is a uniform random k-subset instead. This bounds every
 *   eligible arm's inclusion propensity below by ε·k / eligible, which keeps later inverse-propensity estimates finite.
 * - Propensities: `inclusionPropensity` estimates, by re-running the same randomized choice `draws` times on a
 *   separate RNG, the probability each arm is queried under the current state. Log it with the decision; that is
 *   what off-policy evaluation (IPS, `ipsValue`) needs. Monte Carlo standard error is √(π(1−π)/draws).
 *
 * Explore only in *which sources to query* (invisible to the user), never by injecting low-confidence items (D3).
 *
 * State is two Float64Arrays per (user, situation): the caller keys and persists it (D9: per tenant/user). `select`
 * allocates nothing: microseconds for 30 arms (bench/bandit.bench.ts).
 */
import type { Xoshiro128 } from "./random";

export class BetaBandit {
  readonly arms: number;
  /** Posterior parameters (prior included). Read-only for callers except through the methods; persist both. */
  readonly alpha: Float64Array;
  readonly beta: Float64Array;
  /** Prior parameters (the floor `decay` returns to). */
  readonly alpha0: Float64Array;
  readonly beta0: Float64Array;
  /** Per-step discount toward the prior; 1 disables discounting. */
  gamma: number;
  private readonly counts: Float64Array;
  private readonly chosen: Int32Array;
  private readonly topIds: Int32Array;
  private readonly topVals: Float64Array;
  private readonly pool: Int32Array;

  /**
   * `priorMean` per arm (population usefulness of that kind of source, clamped to [0.001, 0.999]) and one prior
   * strength for all arms. `maxK` bounds k in `select`.
   */
  constructor(arms: number, priorMean: Float64Array, priorStrength: number, gamma: number, maxK: number) {
    this.arms = Math.max(1, arms | 0);
    this.alpha = new Float64Array(this.arms);
    this.beta = new Float64Array(this.arms);
    this.alpha0 = new Float64Array(this.arms);
    this.beta0 = new Float64Array(this.arms);
    this.gamma = gamma;
    this.counts = new Float64Array(this.arms);
    const k = Math.max(1, Math.min(this.arms, maxK | 0));
    this.chosen = new Int32Array(k);
    this.topIds = new Int32Array(k);
    this.topVals = new Float64Array(k);
    this.pool = new Int32Array(this.arms);
    for (let i = 0; i < this.arms; i++) this.setPrior(i, priorMean[i]!, priorStrength);
  }

  /** Resets arm i to a prior with mean μ and strength s (pseudo-observations), discarding its evidence. */
  setPrior(arm: number, mean: number, strength: number): void {
    const mu = mean >= 0.001 ? (mean <= 0.999 ? mean : 0.999) : 0.001; // NaN lands here too: 0.001.
    const s = strength > 0 ? strength : 2;
    this.alpha0[arm] = this.alpha[arm] = s * mu;
    this.beta0[arm] = this.beta[arm] = s * (1 - mu);
  }

  /** Adds one observation for `arm`: reward in [0, 1] (1 = its items were used). Out-of-range rewards are ignored. */
  update(arm: number, reward: number): void {
    if (!(reward >= 0 && reward <= 1) || arm < 0 || arm >= this.arms) return;
    this.alpha[arm]! += reward;
    this.beta[arm]! += 1 - reward;
  }

  /** Discounts every arm's evidence (posterior minus prior) by γ^steps. */
  decay(steps: number): void {
    if (!(steps > 0) || this.gamma >= 1) return;
    const f = Math.pow(this.gamma, steps);
    const a = this.alpha;
    const b = this.beta;
    const a0 = this.alpha0;
    const b0 = this.beta0;
    for (let i = 0; i < this.arms; i++) {
      a[i] = a0[i]! + (a[i]! - a0[i]!) * f;
      b[i] = b0[i]! + (b[i]! - b0[i]!) * f;
    }
  }

  /**
   * Discounts one arm's evidence by γ^steps (e.g. before each `update` of it): the arm forgets its own old outcomes,
   * but an arm that is not queried keeps its estimate, so it is not re-explored just for being idle. Cheaper in
   * regret than `decay` with many arms and stable usefulness; slower to notice an idle source that got better
   * (bench/bandit.bench.ts compares both).
   */
  decayArm(arm: number, steps: number): void {
    if (!(steps > 0) || this.gamma >= 1 || arm < 0 || arm >= this.arms) return;
    const f = Math.pow(this.gamma, steps);
    this.alpha[arm] = this.alpha0[arm]! + (this.alpha[arm]! - this.alpha0[arm]!) * f;
    this.beta[arm] = this.beta0[arm]! + (this.beta[arm]! - this.beta0[arm]!) * f;
  }

  /** Posterior mean usefulness of `arm`. */
  mean(arm: number): number {
    return this.alpha[arm]! / (this.alpha[arm]! + this.beta[arm]!);
  }

  /**
   * Chooses up to k arms: Thompson draws (each multiplied by `scale[i]` when given, e.g. a cue-match probability),
   * best first, ties to the lower index; with probability `epsilon` a uniform random subset instead. Only arms with
   * `eligible[i] !== 0` (all when null) are considered. Writes arm ids to `out`, returns how many.
   */
  select(
    rng: Xoshiro128,
    k: number,
    eligible: Uint8Array | null,
    scale: Float64Array | null,
    epsilon: number,
    out: Int32Array,
  ): number {
    const kk = Math.min(k, this.topIds.length, out.length);
    if (kk <= 0) return 0;
    if (epsilon > 0 && rng.uniform() < epsilon) return this.selectUniform(rng, kk, eligible, out);
    const ids = this.topIds;
    const vals = this.topVals;
    const a = this.alpha;
    const b = this.beta;
    let held = 0;
    for (let i = 0; i < this.arms; i++) {
      if (eligible !== null && eligible[i] === 0) continue;
      let v = rng.beta(a[i]!, b[i]!);
      if (scale !== null) v *= scale[i]!;
      if (!(v >= 0)) v = 0; // NaN scale: never preferred, but still a valid arm.
      if (held === kk && v <= vals[kk - 1]!) continue;
      // Insert into the sorted top-k (k is small: a linear shift beats a heap).
      let j = held < kk ? held++ : kk - 1;
      while (j > 0 && vals[j - 1]! < v) {
        vals[j] = vals[j - 1]!;
        ids[j] = ids[j - 1]!;
        j--;
      }
      vals[j] = v;
      ids[j] = i;
    }
    for (let j = 0; j < held; j++) out[j] = ids[j]!;
    return held;
  }

  private selectUniform(rng: Xoshiro128, k: number, eligible: Uint8Array | null, out: Int32Array): number {
    const pool = this.pool;
    let m = 0;
    for (let i = 0; i < this.arms; i++) if (eligible === null || eligible[i] !== 0) pool[m++] = i;
    const take = Math.min(k, m);
    // Partial Fisher–Yates: the first `take` slots become a uniform random subset.
    for (let j = 0; j < take; j++) {
      const r = j + rng.below(m - j);
      const t = pool[j]!;
      pool[j] = pool[r]!;
      pool[r] = t;
      out[j] = pool[j]!;
    }
    return take;
  }

  /**
   * Estimates each arm's probability of being chosen by `select` with the same arguments, from `draws` simulated
   * decisions on `rng` (use a different stream from the one deciding, so logging does not perturb decisions).
   * Writes π̂(i) to `out` (0 for ineligible arms). Cost ≈ draws × one `select`.
   */
  inclusionPropensity(
    rng: Xoshiro128,
    k: number,
    eligible: Uint8Array | null,
    scale: Float64Array | null,
    epsilon: number,
    draws: number,
    out: Float64Array,
  ): void {
    const counts = this.counts;
    const chosen = this.chosen;
    const total = Math.max(1, draws | 0);
    counts.fill(0);
    for (let d = 0; d < total; d++) {
      const got = this.select(rng, k, eligible, scale, 0, chosen);
      for (let j = 0; j < got; j++) counts[chosen[j]!]! += 1;
    }
    let m = 0;
    for (let i = 0; i < this.arms; i++) if (eligible === null || eligible[i] !== 0) m++;
    const uniform = m > 0 ? Math.min(k, m) / m : 0;
    for (let i = 0; i < this.arms; i++) {
      const isEligible = eligible === null || eligible[i] !== 0;
      out[i] = isEligible ? (1 - epsilon) * (counts[i]! / total) + epsilon * uniform : 0;
    }
  }
}

/**
 * Inverse-propensity estimate of a target policy's mean per-decision reward from logged semi-bandit decisions: for
 * each logged (decision t, arm i) that was queried, reward r and logging propensity π(i), add r·π'(i)/π(i), where
 * π'(i) is the target policy's probability of querying i in that decision; divide by the number of decisions.
 * Unbiased when every π(i) > 0 wherever π'(i) > 0 (the ε floor guarantees that). Entries: one per (decision, queried
 * arm), with `decisions` the number of logged decisions.
 */
export function ipsValue(
  rewards: Float64Array,
  loggingPropensity: Float64Array,
  targetPropensity: Float64Array,
  entries: number,
  decisions: number,
): number {
  if (decisions <= 0) return NaN;
  let sum = 0;
  for (let e = 0; e < entries; e++) {
    const p = loggingPropensity[e]!;
    if (p > 0) sum += (rewards[e]! * targetPropensity[e]!) / p;
  }
  return sum / decisions;
}
