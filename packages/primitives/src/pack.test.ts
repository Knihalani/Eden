import { describe, expect, test } from "bun:test";
import { jaccardMatrix, Packer } from "./pack";
import { Xoshiro128 } from "./random";
import { tokenizeInto } from "./tokenize";
import { Vocab } from "./vocab";

/** f(S) written out directly, for checking. */
function objective(S: number[], rel: Float64Array, sim: Float64Array, n: number, beta: number): number {
  let v = 0;
  for (let a = 0; a < S.length; a++) {
    v += rel[S[a]!]!;
    for (let b = 0; b < a; b++) v -= beta * sim[S[a]! * n + S[b]!]! * Math.min(rel[S[a]!]!, rel[S[b]!]!);
  }
  return v;
}

/** Every subset by bitmask: an implementation independent of `packExact`'s DFS. */
function bruteForce(rel: Float64Array, cost: Float64Array, sim: Float64Array, n: number, budget: number, cap: number) {
  let best = 0;
  for (let mask = 1; mask < 1 << n; mask++) {
    const S: number[] = [];
    let c = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) (S.push(i), (c += cost[i]!));
    if (S.length > cap || c > budget || S.some((i) => !(rel[i]! > 0))) continue;
    best = Math.max(best, objective(S, rel, sim, n, 1));
  }
  return best;
}

/** A random instance shaped like a lookup's candidates: clustered items (near duplicates), varied sizes. */
function instance(rng: Xoshiro128, n: number) {
  const rel = new Float64Array(n);
  const cost = new Float64Array(n);
  const sim = new Float64Array(n * n);
  const cluster = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    rel[i] = rng.beta(1.2, 2.5);
    cost[i] = Math.round(Math.exp(5 + 1.1 * rng.normal())); // median ~150 bytes, long tail
    cluster[i] = rng.below(Math.max(2, n >> 2));
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const s = cluster[i] === cluster[j] ? 0.5 + 0.5 * rng.uniform() : 0.15 * rng.uniform();
      sim[i * n + j] = s;
      sim[j * n + i] = s;
    }
    sim[i * n + i] = 1;
  }
  return { rel, cost, sim };
}

describe("Packer", () => {
  test("nothing positive, nothing fits, n = 0, maxItems = 0: an empty packet", () => {
    const p = new Packer(8);
    const out = new Int32Array(8);
    const sim = new Float64Array(4);
    expect(p.pack(Float64Array.from([0, -1]), Float64Array.from([10, 10]), sim, 2, 100, 3, 1, 0.5, out)).toBe(0);
    expect(p.pack(Float64Array.from([0.9, 0.8]), Float64Array.from([500, 600]), sim, 2, 100, 3, 1, 0.5, out)).toBe(0);
    expect(p.pack(new Float64Array(0), new Float64Array(0), sim, 0, 100, 3, 1, 0.5, out)).toBe(0);
    expect(p.pack(Float64Array.from([0.9]), Float64Array.from([10]), sim, 1, 100, 0, 1, 0.5, out)).toBe(0);
    expect(p.pack(Float64Array.from([NaN, 0.5]), Float64Array.from([10, 10]), sim, 2, 100, 3, 1, 0, out)).toBe(1);
    expect(out[0]).toBe(1);
  });

  test("never pads: an exact duplicate (sim 1) adds nothing and is left out, whatever its relevance", () => {
    const rel = Float64Array.from([0.9, 0.85, 0.3]);
    const cost = Float64Array.from([100, 100, 100]);
    const sim = Float64Array.from([1, 1, 0, 1, 1, 0, 0, 0, 1]);
    const p = new Packer(3);
    const out = new Int32Array(3);
    expect(p.pack(rel, cost, sim, 3, 1000, 3, 1, 0, out)).toBe(2);
    expect([out[0], out[1]]).toEqual([0, 2]);
    expect(p.value).toBeCloseTo(0.9 + 0.3, 12);
    // β = 0.5 tolerates overlap: the duplicate now adds 0.85 − 0.5·0.85 > 0.
    expect(p.pack(rel, cost, sim, 3, 1000, 3, 0.5, 0, out)).toBe(3);
    // (The λ-MMR gain it replaces, λ·rel − (1 − λ)·sim, at λ = 0.7 admits this duplicate: 0.595 − 0.3 = 0.295 > 0.)
  });

  test("an item similar to two chosen items is charged for both and can be left out", () => {
    const rel = Float64Array.from([0.8, 0.8, 0.7]);
    const cost = Float64Array.from([100, 100, 100]);
    // 0 and 1 unrelated; 2 overlaps each by 0.6: gain 0.7 − 0.6·0.7 − 0.6·0.7 < 0.
    const sim = Float64Array.from([1, 0, 0.6, 0, 1, 0.6, 0.6, 0.6, 1]);
    const p = new Packer(3);
    const out = new Int32Array(3);
    expect(p.pack(rel, cost, sim, 3, 1000, 3, 1, 0, out)).toBe(2);
    expect(p.packExact(rel, cost, sim, 3, 1000, 3, 1, out)).toBe(2);
  });

  test("respects the budget and the item cap; skips an item that does not fit and keeps going (Lin–Bilmes)", () => {
    const rel = Float64Array.from([0.9, 0.8, 0.7, 0.6]);
    const cost = Float64Array.from([300, 900, 300, 300]);
    const sim = new Float64Array(16);
    const p = new Packer(4);
    const out = new Int32Array(4);
    const got = p.pack(rel, cost, sim, 4, 1000, 4, 1, 0, out);
    expect(Array.from(out.subarray(0, got))).toEqual([0, 2, 3]); // 1 was best next but no longer fit
    expect(p.pack(rel, cost, sim, 4, 1000, 2, 1, 0, out)).toBe(2);
  });

  test("keeps the better of the cost-scaled and the plain greedy (which starts with the best singleton)", () => {
    const rel = Float64Array.from([0.95, 0.2, 0.2, 0.2]);
    const cost = Float64Array.from([1000, 50, 50, 50]);
    const sim = new Float64Array(16);
    const p = new Packer(4);
    const out = new Int32Array(4);
    // r = 1: per byte the small items win (0.2/50 > 0.95/1000) and use up the item cap: worth 0.6. The plain
    // greedy takes the large item first: worth 0.95, so it is kept.
    expect(p.pack(rel, cost, sim, 4, 1000, 3, 1, 1, out)).toBe(1);
    expect(out[0]).toBe(0);
    expect(p.usedPlain).toBe(true);
    expect(p.value).toBe(0.95);
    // With room for everything, the cost-scaled packet (all four) is worth more and is kept.
    expect(p.pack(rel, cost, sim, 4, 1150, 4, 1, 1, out)).toBe(4);
    expect(p.usedPlain).toBe(false);
  });

  test("packExact equals a bitmask brute force; greedy is feasible and never above it", () => {
    const rng = new Xoshiro128(77);
    const p = new Packer(12);
    const out = new Int32Array(12);
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + rng.below(12);
      const { rel, cost, sim } = instance(rng, n);
      const budget = 300 + rng.below(900);
      const cap = 1 + rng.below(4);
      const want = bruteForce(rel, cost, sim, n, budget, cap);
      const got = p.packExact(rel, cost, sim, n, budget, cap, 1, out);
      expect(p.value).toBeCloseTo(want, 10);
      expect(objective(Array.from(out.subarray(0, got)), rel, sim, n, 1)).toBeCloseTo(want, 10);
      for (const r of [0, 0.5, 1]) {
        const g = p.pack(rel, cost, sim, n, budget, cap, 1, r, out);
        const S = Array.from(out.subarray(0, g));
        expect(g).toBeLessThanOrEqual(cap);
        expect(S.reduce((c, i) => c + cost[i]!, 0)).toBeLessThanOrEqual(budget);
        expect(new Set(S).size).toBe(g);
        expect(p.value).toBeCloseTo(objective(S, rel, sim, n, 1), 10);
        expect(p.value).toBeLessThanOrEqual(want + 1e-12);
      }
    }
  });
});

describe("jaccardMatrix", () => {
  test("hand example with duplicates and an empty set", () => {
    // {1,2,3}, {2,3,4,4}, {}, {3,2,1,1}
    const terms = Uint32Array.from([3, 1, 2, 4, 2, 3, 4, 3, 2, 1, 1]);
    const offsets = Uint32Array.from([0, 3, 7, 7, 11]);
    const lengths = new Uint32Array(4);
    const out = new Float64Array(16);
    jaccardMatrix(terms, offsets, 4, lengths, out);
    expect(Array.from(lengths)).toEqual([3, 3, 0, 3]);
    expect(out[0 * 4 + 1]).toBe(2 / 4);
    expect(out[0 * 4 + 3]).toBe(1);
    expect(out[0 * 4 + 2]).toBe(0);
    expect(out[2 * 4 + 2]).toBe(1);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) expect(out[i * 4 + j]).toBe(out[j * 4 + i]!);
  });

  test("over tokenizeInto ids: long items take the sort path and agree with Set arithmetic", () => {
    const v = new Vocab();
    const texts = [
      "Dana Lee asked about the renewal call on Thursday and the pricing sheet for Globex",
      "Re: renewal call Thursday — Dana Lee will send the Globex pricing sheet and the contract draft today",
      "Flight booking for the offsite: hotel near the venue, budget approved by Priya Raman last quarter",
      "the the the renewal renewal",
    ];
    const ids = new Uint32Array(1000);
    const offsets = new Uint32Array(texts.length + 1);
    let at = 0;
    const sets: Set<number>[] = [];
    for (let i = 0; i < texts.length; i++) {
      const got = tokenizeInto(texts[i]!, v, true, ids.subarray(at), null);
      sets.push(new Set(ids.subarray(at, at + got)));
      at += got;
      offsets[i + 1] = at;
    }
    const out = new Float64Array(16);
    jaccardMatrix(ids, offsets, 4, new Uint32Array(4), out);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        const inter = [...sets[i]!].filter((x) => sets[j]!.has(x)).length;
        expect(out[i * 4 + j]).toBeCloseTo(inter / (sets[i]!.size + sets[j]!.size - inter), 15);
      }
    }
    expect(out[0 * 4 + 1]!).toBeGreaterThan(out[0 * 4 + 2]!);
  });
});
