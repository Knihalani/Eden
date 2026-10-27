/** A seeded random stream with the helpers a world generator needs. Same seed, same world. */
import { Xoshiro128 } from "@eden/primitives";

export class Rng {
  private readonly x: Xoshiro128;

  constructor(seed: number) {
    this.x = new Xoshiro128(seed);
  }

  /** Uniform in (0, 1). */
  next(): number {
    return this.x.uniform();
  }

  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.x.uniform() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.x.uniform() < p;
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.x.uniform() * xs.length)]!;
  }

  /** `k` distinct elements, in random order. */
  sample<T>(xs: readonly T[], k: number): T[] {
    const copy = [...xs];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.x.uniform() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy.slice(0, k);
  }

  /** Log-normal with the given median and log-space sigma: latencies, document lengths. */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.x.normal());
  }

  /** A fresh stream derived from this one (so adding draws in one part of a generator does not shift another). */
  fork(): Rng {
    return new Rng(this.x.nextU32());
  }

  /** Random string over an alphabet (ids, booking refs, keys). */
  token(alphabet: string, n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(this.x.uniform() * alphabet.length)];
    return s;
  }
}
