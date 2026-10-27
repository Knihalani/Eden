/**
 * The few special functions the decision primitives need (calibrate.ts, bandit.ts, pack.ts): log-gamma, the
 * regularized incomplete beta function and its inverse, the binomial CDF, Clopper–Pearson bounds, and numerically
 * stable logistic helpers. Written here rather than imported: the candidates (jstat, @stdlib) were measured in
 * docs/research/primitives-decision.md; this file is ~200 lines with no dependency and matches scipy to ~1e-12.
 *
 * Accuracy is tested against scipy 1.18.1 reference values in stats.test.ts. None of these run on a per-event hot
 * path: they set thresholds offline and sample nothing.
 */

const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
// Lanczos approximation, g = 7, n = 9 (Godfrey's coefficients, as widely published): ~15 significant digits.
const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** log Γ(x) for x > 0 (reflection below 0.5). NaN for x ≤ 0 or NaN. */
export function logGamma(x: number): number {
  if (!(x > 0)) return NaN;
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0]!;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (z + i);
  const t = z + LANCZOS_G + 0.5;
  return LOG_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** log B(a, b). */
export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

const TINY = 1e-300;
const EPS = 1e-16;
const MAX_CF_ITER = 10_000;

/**
 * Continued fraction for the incomplete beta function (Abramowitz & Stegun 26.5.8), evaluated with the modified
 * Lentz method. Converges fast for x < (a + 1) / (a + b + 2); the caller uses the symmetry relation otherwise.
 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_CF_ITER; m++) {
    const m2 = 2 * m;
    // Even step.
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    // Odd step.
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b) = P(X ≤ x) for X ~ Beta(a, b); a, b > 0. */
export function betaInc(x: number, a: number, b: number): number {
  if (x !== x || !(a > 0) || !(b > 0)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logFront = a * Math.log(x) + b * Math.log1p(-x) - logBeta(a, b);
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(logFront) * betaContinuedFraction(a, b, x)) / a;
  return 1 - (Math.exp(logFront) * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * The inverse of `betaInc` in x: the p-quantile of Beta(a, b). Newton steps on the CDF, safeguarded by bisection
 * (the CDF is monotone, so the bracket [lo, hi] always holds the root). Relative accuracy ~1e-13 or better.
 */
export function betaIncInv(p: number, a: number, b: number): number {
  if (p !== p || !(a > 0) || !(b > 0)) return NaN;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const lb = logBeta(a, b);
  let lo = 0;
  let hi = 1;
  let x = a / (a + b);
  for (let it = 0; it < 300; it++) {
    const f = betaInc(x, a, b) - p;
    if (f === 0) return x;
    if (f < 0) lo = x;
    else hi = x;
    const logPdf = (a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - lb;
    let next = x - f / Math.exp(logPdf);
    // Outside the bracket (or not finite): bisect instead, geometrically, so tiny quantiles (e.g. 4e-6) are reached
    // in a few dozen steps rather than the ~60 a midpoint would take; with no lower bound yet, step down by 16x.
    if (!(next > lo && next < hi)) next = lo > 0 ? Math.sqrt(lo * hi) : hi / 16;
    if (Math.abs(next - x) <= 1e-15 * next || hi - lo <= 1e-15 * hi) return next;
    x = next;
  }
  return x;
}

/** P(X ≤ k) for X ~ Binomial(n, p). Exact through the incomplete beta identity. */
export function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const kk = Math.floor(k);
  return betaInc(1 - p, n - kk, kk + 1);
}

/**
 * One-sided Clopper–Pearson (exact binomial) upper confidence bound on a rate from k events in n trials: the rate is
 * at most this with probability ≥ 1 − delta. n = 0 (no evidence) gives 1.
 */
export function clopperPearsonUpper(k: number, n: number, delta: number): number {
  if (n <= 0 || k >= n) return 1;
  return betaIncInv(1 - delta, k + 1, n - k);
}

/** One-sided Clopper–Pearson lower bound: the rate is at least this with probability ≥ 1 − delta. */
export function clopperPearsonLower(k: number, n: number, delta: number): number {
  if (n <= 0 || k <= 0) return 0;
  return betaIncInv(delta, k, n - k + 1);
}

/**
 * The fewest trials, all of them clean (k = 0), that certify a rate ≤ alpha at confidence 1 − delta: below this no
 * threshold can be certified and the gate stays silent. ceil(ln δ / ln(1 − α)); e.g. 22 for α = δ = 0.1.
 */
export function minTrialsToCertify(alpha: number, delta: number): number {
  if (!(alpha > 0) || !(delta > 0)) return Infinity;
  if (alpha >= 1 || delta >= 1) return 0;
  return Math.ceil(Math.log(delta) / Math.log1p(-alpha) - 1e-12);
}

/** 1 / (1 + e^-z) without overflow. */
export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** log(1 + e^z) without overflow or loss of precision at either end. */
export function log1pExp(z: number): number {
  if (z > 35) return z;
  if (z < -35) return Math.exp(z);
  return z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z));
}
