import { describe, expect, test } from "bun:test";
import { Xoshiro128 } from "./random";
import { betaInc } from "./stats";

/** Kolmogorov–Smirnov statistic of the sorted sample against a CDF. */
function ks(sorted: Float64Array, cdf: (x: number) => number): number {
  const n = sorted.length;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const f = cdf(sorted[i]!);
    d = Math.max(d, Math.abs(f - i / n), Math.abs((i + 1) / n - f));
  }
  return d;
}

describe("Xoshiro128 (xoshiro128** 1.1)", () => {
  test("matches the reference output for state [1, 2, 3, 4]", () => {
    // The vector published in Rust's rand_xoshiro tests, reproduced by a C transcription of the reference next().
    const rng = new Xoshiro128(0);
    rng.setState(1, 2, 3, 4);
    const got = Array.from({ length: 10 }, () => rng.nextU32());
    expect(got).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804,
    ]);
  });

  test("matches the C transcription after 1,000 steps from a mixed state", () => {
    const rng = new Xoshiro128(0);
    rng.setState(0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x01234567);
    for (let i = 0; i < 1000; i++) rng.nextU32();
    expect([rng.nextU32(), rng.nextU32()]).toEqual([4073468102, 4231708582]);
  });

  test("seeding is deterministic, distinct per seed, and never all-zero", () => {
    const a = new Xoshiro128(7);
    const b = new Xoshiro128(7);
    const c = new Xoshiro128(8);
    const sa = Array.from({ length: 5 }, () => a.nextU32());
    expect(Array.from({ length: 5 }, () => b.nextU32())).toEqual(sa);
    expect(Array.from({ length: 5 }, () => c.nextU32())).not.toEqual(sa);
    const zero = new Xoshiro128(0);
    const st = new Uint32Array(4);
    zero.getState(st);
    expect(st[0]! | st[1]! | st[2]! | st[3]!).not.toBe(0);
    const forced = new Xoshiro128(1);
    forced.setState(0, 0, 0, 0);
    expect(forced.nextU32() | forced.nextU32() | forced.nextU32()).not.toBe(0);
  });

  test("state round-trips: a saved stream resumes exactly", () => {
    const rng = new Xoshiro128(99);
    for (let i = 0; i < 17; i++) rng.nextU32();
    const st = new Uint32Array(4);
    rng.getState(st);
    const next = [rng.nextU32(), rng.nextU32()];
    const other = new Xoshiro128(0);
    other.setState(st[0]!, st[1]!, st[2]!, st[3]!);
    expect([other.nextU32(), other.nextU32()]).toEqual(next);
  });

  test("uniform is in (0, 1) with mean 1/2; below(n) covers [0, n) evenly", () => {
    const rng = new Xoshiro128(1);
    let sum = 0;
    const counts = new Uint32Array(7);
    for (let i = 0; i < 100_000; i++) {
      const u = rng.uniform();
      expect(u > 0 && u < 1).toBe(true);
      sum += u;
      counts[rng.below(7)]!++;
    }
    expect(Math.abs(sum / 100_000 - 0.5)).toBeLessThan(0.005);
    for (const c of counts) expect(Math.abs(c / 100_000 - 1 / 7)).toBeLessThan(0.005);
  });

  test("normal has mean 0, variance 1, and a normal-shaped tail", () => {
    const rng = new Xoshiro128(2);
    const n = 200_000;
    let s = 0;
    let s2 = 0;
    let beyond2 = 0;
    for (let i = 0; i < n; i++) {
      const x = rng.normal();
      s += x;
      s2 += x * x;
      if (Math.abs(x) > 2) beyond2++;
    }
    expect(Math.abs(s / n)).toBeLessThan(0.01);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.01);
    expect(Math.abs(beyond2 / n - 0.0455)).toBeLessThan(0.002); // P(|Z| > 2) = 0.0455
  });

  test("gamma has mean = variance = shape, including shapes below 1", () => {
    const rng = new Xoshiro128(3);
    for (const shape of [0.1, 0.5, 1, 2.5, 30]) {
      const n = 100_000;
      let s = 0;
      let s2 = 0;
      for (let i = 0; i < n; i++) {
        const x = rng.gamma(shape);
        expect(x >= 0).toBe(true);
        s += x;
        s2 += x * x;
      }
      const mean = s / n;
      const variance = s2 / n - mean * mean;
      expect(Math.abs(mean - shape) / shape).toBeLessThan(0.03);
      expect(Math.abs(variance - shape) / shape).toBeLessThan(0.08);
    }
  });

  test("beta passes a Kolmogorov–Smirnov test against the exact CDF, tiny shapes included", () => {
    const rng = new Xoshiro128(4);
    const n = 20_000;
    // Critical value at the 0.1% level: 1.95 / √n ≈ 0.0138.
    const critical = 1.95 / Math.sqrt(n);
    for (const [a, b] of [
      [1, 1],
      [0.3, 0.5],
      [0.05, 2],
      [2, 0.2],
      [4, 16],
      [50, 3],
      [1000, 2000],
    ] as const) {
      const xs = new Float64Array(n);
      for (let i = 0; i < n; i++) xs[i] = rng.beta(a, b);
      for (const x of xs) expect(x >= 0 && x <= 1).toBe(true);
      xs.sort();
      expect(ks(xs, (x) => betaInc(x, a, b))).toBeLessThan(critical);
    }
  });

  test("beta with both shapes tiny never returns NaN (log-space path)", () => {
    const rng = new Xoshiro128(5);
    for (let i = 0; i < 10_000; i++) {
      const x = rng.beta(0.001, 0.001);
      expect(x >= 0 && x <= 1).toBe(true);
    }
  });
});
