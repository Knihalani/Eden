/**
 * Calibration and thresholds for the inject-or-stay-silent gate: turn raw confidence features into probabilities
 * from small labelled sets, then choose a threshold whose error rate is certified with a finite-sample bound.
 *
 * - `Logistic`: L2-regularized logistic regression fitted by Newton's method (IRLS) with a backtracking line search.
 *   One raw score with Platt's smoothed targets is Platt scaling (`fitPlatt`); several features make a gate model.
 * - `Isotonic`: isotonic regression by pool-adjacent-violators, predicting like scikit-learn (linear interpolation
 *   between block ends, clipped outside the data).
 * - `selectCalibrator`: picks Platt or isotonic by cross-validated log loss, and reports ECE for both.
 * - `thresholdForFalseFireRate`: the Neyman–Pearson umbrella order statistic (Tong, Feng & Li 2018). Fire only above
 *   it and P(fire | should be silent) ≤ alpha holds with probability ≥ 1 − delta over the calibration sample. This is
 *   the eval's `falseFireRate` (false fires / silent turns).
 * - `thresholdForPrecision`: the lowest threshold on a fixed grid whose Clopper–Pearson bound on P(useless | fired)
 *   is ≤ alpha, Bonferroni-corrected over the grid so the guarantee survives choosing among thresholds.
 *
 * With too little data both threshold functions return +Infinity: the gate stays silent (D3). Neither guarantee
 * survives drift (they assume the calibration sample is exchangeable with future events): recalibrate per window.
 *
 * Non-finite features, scores or labels are skipped when fitting. Prediction is allocation-free; fitting allocates
 * only when the data outgrows its buffers (it runs offline, not per event).
 */
import { binomCdf, clopperPearsonUpper, log1pExp, sigmoid } from "./stats";

function grow(a: Float64Array<ArrayBuffer>, n: number): Float64Array<ArrayBuffer> {
  return a.length >= n ? a : new Float64Array(Math.max(n, a.length * 2));
}

/** Probability of class 1 under a logistic model; weights[dims] is the intercept. */
export class Logistic {
  readonly dims: number;
  /** dims coefficients, then the intercept. */
  readonly weights: Float64Array;
  /** Newton iterations taken by the last fit; -1 if it hit `maxIter` without converging. */
  iterations = 0;
  private readonly grad: Float64Array;
  private readonly hess: Float64Array;
  private readonly step: Float64Array;
  private readonly trial: Float64Array;
  private z: Float64Array<ArrayBuffer> = new Float64Array(0);

  constructor(dims: number) {
    this.dims = Math.max(1, dims | 0);
    const p = this.dims + 1;
    this.weights = new Float64Array(p);
    this.grad = new Float64Array(p);
    this.hess = new Float64Array(p * p);
    this.step = new Float64Array(p);
    this.trial = new Float64Array(p);
  }

  /** The linear score w·x + b for the row of `x` starting at `offset`. */
  logit(x: Float64Array, offset: number): number {
    const d = this.dims;
    const w = this.weights;
    let z = w[d]!;
    for (let j = 0; j < d; j++) z += w[j]! * x[offset + j]!;
    return z;
  }

  /** P(y = 1) for the row of `x` starting at `offset`. NaN features give NaN, which never clears a threshold. */
  predict(x: Float64Array, offset: number): number {
    return sigmoid(this.logit(x, offset));
  }

  /** P(y = 1) for a one-feature model (Platt scaling). */
  predict1(score: number): number {
    return sigmoid(this.weights[0]! * score + this.weights[1]!);
  }

  /**
   * Fits to n rows of `x` (row-major, `dims` per row) with targets in [0, 1] (labels, or Platt's smoothed targets),
   * minimizing Σ log-loss + ½·l2·|w|² (the intercept is not penalized, as in scikit-learn). With l2 = 0 and separable
   * data the optimum is at infinity: the fit stops at `maxIter` with iterations = -1 and large weights. Use l2 > 0
   * or Platt targets. Returns the final objective.
   */
  fit(x: Float64Array, targets: Float64Array, n: number, l2: number, maxIter: number): number {
    const d = this.dims;
    const p = d + 1;
    const w = this.weights;
    const g = this.grad;
    const h = this.hess;
    const step = this.step;
    const trial = this.trial;
    this.z = grow(this.z, n);
    // Rows with a non-finite feature or target are skipped: mark them with z = NaN once.
    const z = this.z;
    let rows = 0;
    for (let i = 0; i < n; i++) {
      let ok = targets[i]! >= 0 && targets[i]! <= 1;
      for (let j = 0; ok && j < d; j++) ok = Number.isFinite(x[i * d + j]!);
      z[i] = ok ? 0 : NaN;
      if (ok) rows++;
    }
    w.fill(0);
    if (rows === 0) {
      this.iterations = 0;
      return 0;
    }
    let obj = this.objective(x, targets, n, l2, w);
    this.iterations = -1;
    for (let it = 1; it <= maxIter; it++) {
      // Gradient and Hessian of the penalized negative log-likelihood.
      g.fill(0);
      h.fill(0);
      for (let i = 0; i < n; i++) {
        if (z[i] !== z[i]) continue;
        const off = i * d;
        let s = w[d]!;
        for (let j = 0; j < d; j++) s += w[j]! * x[off + j]!;
        const pr = sigmoid(s);
        const r = pr - targets[i]!;
        const wt = pr * (1 - pr);
        for (let j = 0; j < d; j++) {
          const xj = x[off + j]!;
          g[j]! += r * xj;
          for (let k = 0; k <= j; k++) h[j * p + k]! += wt * xj * x[off + k]!;
          h[d * p + j]! += wt * xj;
        }
        g[d]! += r;
        h[d * p + d]! += wt;
      }
      for (let j = 0; j < d; j++) {
        g[j]! += l2 * w[j]!;
        h[j * p + j]! += l2;
      }
      // Solve H·step = g by Cholesky on the lower triangle (row d holds the intercept). A relative jitter of 1e-10
      // on the diagonal keeps a semidefinite H (a constant feature, l2 = 0) solvable; it changes the step, not the
      // objective, so the optimum is unchanged.
      for (let j = 0; j < p; j++) h[j * p + j]! += 1e-10 * (1 + h[j * p + j]!);
      if (!choleskySolve(h, g, step, p)) {
        // Not positive definite even so (non-finite sums): fall back to a scaled gradient step, which the line
        // search keeps monotone.
        for (let j = 0; j < p; j++) step[j] = g[j]! / Math.max(rows, 1);
      }
      // Backtracking line search: Armijo condition on the Newton decrement.
      let dec = 0;
      for (let j = 0; j < p; j++) dec += g[j]! * step[j]!;
      let t = 1;
      let next = obj;
      for (let tries = 0; tries < 40; tries++) {
        for (let j = 0; j < p; j++) trial[j] = w[j]! - t * step[j]!;
        next = this.objective(x, targets, n, l2, trial);
        if (next <= obj - 1e-4 * t * dec) break;
        t *= 0.5;
      }
      if (!(next <= obj)) break; // No progress possible at machine precision.
      w.set(trial);
      const converged = 0.5 * dec <= 1e-14 * (1 + Math.abs(obj)) || obj - next <= 1e-15 * (1 + Math.abs(obj));
      obj = next;
      if (converged) {
        this.iterations = it;
        break;
      }
    }
    return obj;
  }

  private objective(x: Float64Array, targets: Float64Array, n: number, l2: number, w: Float64Array): number {
    const d = this.dims;
    const z = this.z;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (z[i] !== z[i]) continue;
      let s = w[d]!;
      for (let j = 0; j < d; j++) s += w[j]! * x[i * d + j]!;
      sum += log1pExp(s) - targets[i]! * s;
    }
    let pen = 0;
    for (let j = 0; j < d; j++) pen += w[j]! * w[j]!;
    return sum + 0.5 * l2 * pen;
  }
}

/** In-place Cholesky of the p×p SPD matrix `a` and solve a·out = b. False if `a` is not positive definite. */
function choleskySolve(a: Float64Array, b: Float64Array, out: Float64Array, p: number): boolean {
  for (let j = 0; j < p; j++) {
    let s = a[j * p + j]!;
    for (let k = 0; k < j; k++) s -= a[j * p + k]! * a[j * p + k]!;
    if (!(s > 1e-300)) return false;
    const l = Math.sqrt(s);
    a[j * p + j] = l;
    for (let i = j + 1; i < p; i++) {
      let t = a[i * p + j]!;
      for (let k = 0; k < j; k++) t -= a[i * p + k]! * a[j * p + k]!;
      a[i * p + j] = t / l;
    }
  }
  for (let i = 0; i < p; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= a[i * p + k]! * out[k]!;
    out[i] = s / a[i * p + i]!;
  }
  for (let i = p - 1; i >= 0; i--) {
    let s = out[i]!;
    for (let k = i + 1; k < p; k++) s -= a[k * p + i]! * out[k]!;
    out[i] = s / a[i * p + i]!;
  }
  return true;
}

/**
 * Platt scaling (Platt 1999): fits P(y | score) = σ(a·score + b) with smoothed targets (N₊+1)/(N₊+2) and
 * 1/(N₋+2), which keep the fit finite on separable data and on all-same labels (p → (n+1)/(n+2), not 1).
 * `targets` is scratch of length ≥ n. With no usable rows the model is a = b = 0 (p = 0.5).
 */
export function fitPlatt(
  model: Logistic,
  scores: Float64Array,
  labels: Uint8Array,
  n: number,
  targets: Float64Array,
  maxIter: number,
): void {
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(scores[i]!)) continue;
    if (labels[i] === 1) pos++;
    else neg++;
  }
  const hi = (pos + 1) / (pos + 2);
  const lo = 1 / (neg + 2);
  for (let i = 0; i < n; i++) targets[i] = labels[i] === 1 ? hi : lo;
  model.fit(scores, targets, n, 0, maxIter);
}

/**
 * Isotonic (monotone non-decreasing) calibration map. Fitting sorts, merges tied scores, and pools adjacent
 * violators; prediction interpolates linearly between block ends and clips outside the fitted range, as
 * scikit-learn's IsotonicRegression(out_of_bounds="clip") does. Outputs are clamped to [eps, 1 − eps]: a raw
 * isotonic fit says 0 or 1 at the extremes from as little as one example, which no small sample supports.
 */
export class Isotonic {
  /** Block-end scores (ascending) and their fitted values; the first `size` are valid. */
  xs = new Float64Array(0);
  ys = new Float64Array(0);
  size = 0;
  private eps = 0;

  /**
   * Fits to n (score, label) pairs; a label is 0/1 or a target in [0, 1]. Returns the number of blocks. Allocates
   * O(n) scratch per fit (fitting is offline); `predict` allocates nothing.
   */
  fit(scores: Float64Array, labels: Uint8Array | Float64Array, n: number, eps: number): number {
    this.eps = eps;
    const order: number[] = [];
    for (let i = 0; i < n; i++) {
      const y = labels[i]!;
      if (Number.isFinite(scores[i]!) && y >= 0 && y <= 1) order.push(i);
    }
    order.sort((a, b) => scores[a]! - scores[b]! || a - b);
    const m = order.length;
    // PAV over a stack of blocks. Tied scores enter as one point (their mean), as scikit-learn merges them first.
    const first = new Float64Array(m); // first score of the block
    const last = new Float64Array(m); // last score of the block
    const weight = new Float64Array(m);
    const sum = new Float64Array(m);
    let top = 0;
    for (let r = 0; r < m;) {
      // A run of tied scores enters as one point before any pooling, so the fit does not depend on their order.
      const x = scores[order[r]!]!;
      let w = 0;
      let y = 0;
      for (; r < m && scores[order[r]!]! === x; r++) {
        w++;
        y += labels[order[r]!]!;
      }
      first[top] = x;
      last[top] = x;
      weight[top] = w;
      sum[top] = y;
      top++;
      // Pool while the previous block's mean is ≥ this one's (equal means merge too, so block values strictly rise).
      while (top > 1 && sum[top - 2]! * weight[top - 1]! >= sum[top - 1]! * weight[top - 2]!) {
        weight[top - 2]! += weight[top - 1]!;
        sum[top - 2]! += sum[top - 1]!;
        last[top - 2] = last[top - 1]!;
        top--;
      }
    }
    // Keep the first and last score of each block (once when they coincide): interpolation needs only those.
    this.xs = new Float64Array(2 * top);
    this.ys = new Float64Array(2 * top);
    let s = 0;
    for (let b = 0; b < top; b++) {
      const v = sum[b]! / weight[b]!;
      this.xs[s] = first[b]!;
      this.ys[s++] = v;
      if (last[b] !== first[b]) {
        this.xs[s] = last[b]!;
        this.ys[s++] = v;
      }
    }
    this.size = s;
    return top;
  }

  /** The calibrated probability for `score`; NaN for NaN, 0.5 with no fit. */
  predict(score: number): number {
    const n = this.size;
    if (score !== score) return NaN;
    if (n === 0) return 0.5;
    const xs = this.xs;
    const ys = this.ys;
    let p: number;
    if (score <= xs[0]!) p = ys[0]!;
    else if (score >= xs[n - 1]!) p = ys[n - 1]!;
    else {
      // Largest i with xs[i] ≤ score.
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid]! <= score) lo = mid;
        else hi = mid;
      }
      const x0 = xs[lo]!;
      const x1 = xs[hi]!;
      p = x1 === x0 ? ys[hi]! : ys[lo]! + ((score - x0) / (x1 - x0)) * (ys[hi]! - ys[lo]!);
    }
    const e = this.eps;
    return p < e ? e : p > 1 - e ? 1 - e : p;
  }
}

/** Mean log loss of probabilities p against 0/1 labels, with p clamped to [eps, 1 − eps]; NaN rows skipped. */
export function logLoss(p: Float64Array, labels: Uint8Array, n: number, eps: number): number {
  let sum = 0;
  let m = 0;
  for (let i = 0; i < n; i++) {
    let q = p[i]!;
    if (q !== q) continue;
    q = q < eps ? eps : q > 1 - eps ? 1 - eps : q;
    sum -= labels[i] === 1 ? Math.log(q) : Math.log1p(-q);
    m++;
  }
  return m ? sum / m : 0;
}

/**
 * Expected calibration error over `bins` equal-width bins: Σ (n_b / n)·|mean p − mean y| (Naeini et al. 2015, as
 * commonly reported). Allocates its bins: ECE is a report, not a gate.
 */
export function expectedCalibrationError(p: Float64Array, labels: Uint8Array, n: number, bins: number): number {
  const cnt = new Float64Array(bins);
  const sp = new Float64Array(bins);
  const sy = new Float64Array(bins);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const q = p[i]!;
    if (!(q >= 0 && q <= 1)) continue;
    const b = Math.min(bins - 1, Math.floor(q * bins));
    cnt[b]! += 1;
    sp[b]! += q;
    sy[b]! += labels[i] === 1 ? 1 : 0;
    m++;
  }
  if (m === 0) return 0;
  let ece = 0;
  for (let b = 0; b < bins; b++) if (cnt[b]! > 0) ece += Math.abs(sp[b]! - sy[b]!) / m;
  return ece;
}

export const PLATT = 0;
export const ISOTONIC = 1;

export interface CalibratorChoice {
  /** PLATT or ISOTONIC. */
  kind: number;
  /** Cross-validated mean log loss and ECE of each (NaN when not evaluated). */
  plattLogLoss: number;
  isotonicLogLoss: number;
  plattEce: number;
  isotonicEce: number;
  /** True when there were too few rows or labels of one class to cross-validate: Platt was chosen by default. */
  insufficient: boolean;
}

/**
 * Chooses between Platt and isotonic calibration of one raw score by K-fold cross-validated log loss (folds by
 * index mod K, so time-ordered data is interleaved rather than split into eras). Isotonic wins only if strictly
 * better: Platt has two parameters and degrades gracefully, isotonic has one per block and overfits small data
 * (Niculescu-Mizil & Caruana 2005). Needs ≥ 2 rows of each class per fold; otherwise Platt, marked insufficient.
 * `eps` clamps isotonic outputs and the log loss (e.g. 1e-3).
 */
export function selectCalibrator(
  scores: Float64Array,
  labels: Uint8Array,
  n: number,
  folds: number,
  eps: number,
): CalibratorChoice {
  let pos = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(scores[i]!)) continue;
    total++;
    if (labels[i] === 1) pos++;
  }
  const k = Math.max(2, folds | 0);
  if (Math.min(pos, total - pos) < 2 * k) {
    return {
      kind: PLATT,
      plattLogLoss: NaN,
      isotonicLogLoss: NaN,
      plattEce: NaN,
      isotonicEce: NaN,
      insufficient: true,
    };
  }
  const trainS = new Float64Array(n);
  const trainY = new Uint8Array(n);
  const targets = new Float64Array(n);
  const pPlatt = new Float64Array(n).fill(NaN);
  const pIso = new Float64Array(n).fill(NaN);
  const platt = new Logistic(1);
  const iso = new Isotonic();
  for (let f = 0; f < k; f++) {
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (i % k === f || !Number.isFinite(scores[i]!)) continue;
      trainS[m] = scores[i]!;
      trainY[m++] = labels[i]!;
    }
    fitPlatt(platt, trainS, trainY, m, targets, 100);
    iso.fit(trainS, trainY, m, eps);
    for (let i = f; i < n; i += k) {
      if (!Number.isFinite(scores[i]!)) continue;
      pPlatt[i] = platt.predict1(scores[i]!);
      pIso[i] = iso.predict(scores[i]!);
    }
  }
  const plattLogLoss = logLoss(pPlatt, labels, n, eps);
  const isotonicLogLoss = logLoss(pIso, labels, n, eps);
  return {
    kind: isotonicLogLoss < plattLogLoss ? ISOTONIC : PLATT,
    plattLogLoss,
    isotonicLogLoss,
    plattEce: expectedCalibrationError(pPlatt, labels, n, 10),
    isotonicEce: expectedCalibrationError(pIso, labels, n, 10),
    insufficient: false,
  };
}

export interface Threshold {
  /** The threshold; +Infinity when there is not enough evidence for any: stay silent. Use `fires` to apply it. */
  threshold: number;
  /** True: fire only when score > threshold (the false-fire order statistic); false: when score ≥ threshold. */
  strict: boolean;
  /** The certified bound on the controlled rate at this threshold (≤ alpha), or 1 when silent. */
  bound: number;
  /** The probability the guarantee fails, as achieved (≤ delta); 1 when silent. */
  achievedDelta: number;
  /** Calibration rows the bound rests on (negatives for the false-fire rate, fired rows for precision). */
  support: number;
  /** Of those, how many were errors (negatives above the threshold / useless fired rows). */
  errors: number;
}

/** Whether `score` clears `t`, honouring `t.strict`. NaN never fires, and nothing clears a silent threshold. */
export function fires(t: Threshold, score: number): boolean {
  return t.strict ? score > t.threshold : score >= t.threshold && t.threshold < Infinity;
}

const SILENT: Threshold = { threshold: Infinity, strict: true, bound: 1, achievedDelta: 1, support: 0, errors: 0 };

/**
 * Lowest threshold t such that P(score > t | label 0) ≤ alpha with probability ≥ 1 − delta (Neyman–Pearson umbrella
 * algorithm, Tong, Feng & Li, Science Advances 2018). t is an order statistic of the negatives' scores: with n₀
 * negatives, allowing j of them above t fails with probability P(Binomial(n₀, alpha) ≤ j); the largest j with that
 * ≤ delta is used. Distribution-free and exact for one threshold chosen this way, ties included (firing is strict).
 * Needs n₀ ≥ ln δ / ln(1 − α) negatives (22 for α = δ = 0.1); fewer, and it returns +Infinity (silent).
 * `scratch` must hold n entries. Positives are ignored: this bounds false fires, not missed fires.
 */
export function thresholdForFalseFireRate(
  scores: Float64Array,
  labels: Uint8Array,
  n: number,
  alpha: number,
  delta: number,
  scratch: Float64Array,
): Threshold {
  let n0 = 0;
  for (let i = 0; i < n; i++) if (labels[i] !== 1 && scores[i] === scores[i]) scratch[n0++] = scores[i]!;
  if (n0 === 0 || !(alpha > 0) || !(delta > 0)) return SILENT;
  const neg = scratch.subarray(0, n0).sort(); // ascending
  // Largest j with P(Bin(n0, alpha) ≤ j) ≤ delta. The CDF rises with j, so scan up from 0.
  let j = -1;
  while (j + 1 < n0 && binomCdf(j + 1, n0, alpha) <= delta) j++;
  if (j < 0) return SILENT;
  const t = neg[n0 - 1 - j]!;
  let above = 0;
  for (let i = 0; i < n0; i++) if (neg[i]! > t) above++;
  return {
    threshold: t,
    strict: true,
    bound: alpha,
    achievedDelta: binomCdf(j, n0, alpha),
    support: n0,
    errors: above,
  };
}

/**
 * Lowest threshold t from `grid` (fixed before seeing the data, e.g. 0.05, 0.10, …, 0.95 for calibrated
 * probabilities) such that the one-sided Clopper–Pearson bound on P(label 0 | score ≥ t) is ≤ alpha, each grid point
 * tested at delta / grid size (Bonferroni), so the chosen t keeps precision ≥ 1 − alpha with probability ≥ 1 − delta
 * even though it was chosen as the lowest that passed. A grid point needs ≥ ln(δ/G) / ln(1 − α) fired rows (51 for
 * α = δ = 0.1, G = 20) to pass at all; with none passing it returns +Infinity (silent). O(grid · n), offline.
 */
export function thresholdForPrecision(
  scores: Float64Array,
  labels: Uint8Array,
  n: number,
  grid: Float64Array,
  alpha: number,
  delta: number,
): Threshold {
  const g = grid.length;
  if (g === 0 || !(alpha > 0) || !(delta > 0)) return SILENT;
  const level = delta / g;
  let best = SILENT;
  for (let q = 0; q < g; q++) {
    const t = grid[q]!;
    if (t !== t || t >= best.threshold) continue;
    let fired = 0;
    let bad = 0;
    for (let i = 0; i < n; i++) {
      if (scores[i]! >= t) {
        fired++;
        if (labels[i] !== 1) bad++;
      }
    }
    // H0: P(useless | fired) > alpha. p-value P(Bin(fired, alpha) ≤ bad); reject (certify) when ≤ level.
    if (fired === 0) continue;
    const pValue = binomCdf(bad, fired, alpha);
    if (pValue > level) continue;
    best = {
      threshold: t,
      strict: false,
      bound: clopperPearsonUpper(bad, fired, level),
      achievedDelta: pValue * g,
      support: fired,
      errors: bad,
    };
  }
  return best;
}
