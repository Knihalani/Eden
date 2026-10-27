/**
 * A deterministic, seedable random source for decisions that must be replayable (bandit draws, exploration coin
 * flips, simulations): xoshiro128** 1.1 (Blackman & Vigna 2018, public domain), seeded through a 32-bit SplitMix
 * finalizer so nearby seeds give unrelated streams. 32-bit arithmetic only (Math.imul, >>> 0): no BigInt, no
 * allocation per draw. Output for state [1, 2, 3, 4] matches the published reference vector (random.test.ts).
 *
 * Samplers: uniform in (0, 1), standard normal (Marsaglia polar, one spare cached), Gamma(shape, 1) (Marsaglia &
 * Tsang 2000, with the U^(1/a) boost for shape < 1), and Beta(a, b) as a ratio of Gammas, done in log space when a
 * shape is below 1 so tiny shapes cannot produce 0/0.
 *
 * Not cryptographic. Math.random is not used anywhere: it cannot be seeded, so decisions could not be replayed.
 */

const TWO_NEG_32 = 2.3283064365386963e-10;

export class Xoshiro128 {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  private spare = 0;
  private hasSpare = false;

  constructor(seed: number) {
    this.seed(seed);
  }

  /** Re-seeds from any number (its low 32 bits). Every seed, 0 included, yields a valid non-zero state. */
  seed(seed: number): void {
    let x = seed >>> 0;
    const next = () => {
      // SplitMix-style: a Weyl step, then the murmur3 fmix32 finalizer.
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.setState(next(), next(), next(), next());
  }

  /** Sets the raw state (for reference vectors and for restoring a saved stream). Must not be all zero. */
  setState(a: number, b: number, c: number, d: number): void {
    this.s0 = a | 0;
    this.s1 = b | 0;
    this.s2 = c | 0;
    this.s3 = d | 0;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
    this.hasSpare = false;
  }

  /** Writes the raw state into `out` (4 words) so a stream can be saved and resumed exactly. */
  getState(out: Uint32Array): void {
    out[0] = this.s0;
    out[1] = this.s1;
    out[2] = this.s2;
    out[3] = this.s3;
  }

  /** The next 32-bit output as an unsigned integer. */
  nextU32(): number {
    // State read into locals and written once: ~30% faster on JavaScriptCore than updating fields in place.
    const s0 = this.s0;
    const s1 = this.s1;
    const m = Math.imul(s1, 5);
    const result = Math.imul((m << 7) | (m >>> 25), 9) >>> 0;
    const s2 = this.s2 ^ s0;
    const s3 = this.s3 ^ s1;
    this.s1 = s1 ^ s2;
    this.s0 = s0 ^ s3;
    this.s2 = s2 ^ (s1 << 9);
    this.s3 = (s3 << 11) | (s3 >>> 21);
    return result;
  }

  /** Uniform in the open interval (0, 1), resolution 2^-32: safe to take the log of. */
  uniform(): number {
    return (this.nextU32() + 0.5) * TWO_NEG_32;
  }

  /** Uniform integer in [0, n) for 0 < n ≤ 2^32 (multiply-shift; bias below 2^-32 · n, irrelevant at n ≤ 64). */
  below(n: number): number {
    return Math.floor(this.nextU32() * TWO_NEG_32 * n);
  }

  /** Standard normal (Marsaglia polar method). */
  normal(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    let u: number;
    let v: number;
    let s: number;
    do {
      u = 2 * this.uniform() - 1;
      v = 2 * this.uniform() - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * f;
    this.hasSpare = true;
    return u * f;
  }

  /** Gamma(shape, 1) for shape ≥ 1 (Marsaglia & Tsang). Callers with shape < 1 use `logGamma`. */
  private gammaAtLeastOne(shape: number): number {
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.uniform();
      const x2 = x * x;
      // The squeeze accepts ~98% without a log.
      if (u < 1 - 0.0331 * x2 * x2) return d * v;
      if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  /** Gamma(shape, 1), shape > 0. Shapes below 1 underflow to 0 for tiny shapes; use `logGamma` there. */
  gamma(shape: number): number {
    if (shape >= 1) return this.gammaAtLeastOne(shape);
    return this.gammaAtLeastOne(shape + 1) * Math.pow(this.uniform(), 1 / shape);
  }

  /** log of a Gamma(shape, 1) draw; finite for any shape > 0 (no underflow). */
  logGamma(shape: number): number {
    if (shape >= 1) return Math.log(this.gammaAtLeastOne(shape));
    return Math.log(this.gammaAtLeastOne(shape + 1)) + Math.log(this.uniform()) / shape;
  }

  /** Beta(a, b), a, b > 0. */
  beta(a: number, b: number): number {
    if (a >= 1 && b >= 1) {
      const x = this.gammaAtLeastOne(a);
      return x / (x + this.gammaAtLeastOne(b));
    }
    // In log space: X / (X + Y) = 1 / (1 + e^(log Y − log X)), exact even when both draws underflow.
    const lx = this.logGamma(a);
    const ly = this.logGamma(b);
    return 1 / (1 + Math.exp(ly - lx));
  }
}
