import { describe, expect, test } from "bun:test";
import { Xoshiro128 } from "./random";
import { SparseIndex } from "./sparse-index";
import { ReferenceSparseIndex } from "./sparse-index.reference";

/**
 * The packed index against the reference layout it replaced: the same operations on both must give the same doc
 * numbers, the same results bit for bit (docs in order, scores, coverage, matches), the same term sets and the same
 * freed terms in the same order, through freezes, purges, doc-number reuse, term frequencies past a byte and term ids
 * past 16 bits.
 */
interface Mirror {
  packed: SparseIndex;
  reference: ReferenceSparseIndex;
  freedPacked: number[];
  freedReference: number[];
}

function mirror(options: { fields: number; delta?: number }): Mirror {
  const m: Mirror = {} as Mirror;
  m.freedPacked = [];
  m.freedReference = [];
  const base = { fields: options.fields, weights: [2, 1, 0.5].slice(0, options.fields), delta: options.delta ?? 0 };
  m.packed = new SparseIndex({ ...base, onTermFreed: (t) => m.freedPacked.push(t) });
  m.reference = new ReferenceSparseIndex({ ...base, onTermFreed: (t) => m.freedReference.push(t) });
  return m;
}

function same(m: Mirror, query: Uint32Array, k: number): void {
  const a = m.packed.search(query, query.length, k);
  const b = m.reference.search(query, query.length, k);
  expect(a.count).toBe(b.count);
  expect([...a.docs]).toEqual([...b.docs]);
  expect([...a.scores]).toEqual([...b.scores]);
  expect([...a.coverage]).toEqual([...b.coverage]);
  expect([...a.matched]).toEqual([...b.matched]);
}

function run(seed: number, fields: number, steps: number, wide: boolean, delta = 0): void {
  const rnd = new Xoshiro128(seed);
  const m = mirror({ fields, delta });
  const live: number[] = [];
  const terms = wide ? 90_000 : 3_000;
  // Zipf-ish draws: a few common terms (ties in scores), many rare ones (one-posting keys).
  const draw = () => Math.floor(terms * rnd.uniform() ** 3);
  for (let step = 0; step < steps; step++) {
    const r = rnd.uniform();
    if (r < 0.55 || live.length < 5) {
      const arrays: Uint32Array[] = [];
      const counts: number[] = [];
      for (let f = 0; f < fields; f++) {
        const n = f === 0 ? Math.floor(rnd.uniform() * 8) : Math.floor(rnd.uniform() * 120);
        const a = new Uint32Array(n + 300);
        for (let i = 0; i < n; i++) a[i] = draw();
        let len = n;
        if (rnd.uniform() < 0.01) for (let i = 0; i < 300; i++) a[len++] = 7; // a frequency past one byte
        arrays.push(a);
        counts.push(len);
      }
      const d = m.packed.addFields(arrays, counts);
      expect(m.reference.addFields(arrays, counts)).toBe(d);
      live.push(d);
    } else if (r < 0.85) {
      const d = live.splice(Math.floor(rnd.uniform() * live.length), 1)[0]!;
      m.packed.remove(d);
      m.reference.remove(d);
    } else if (r < 0.86) {
      m.packed.flush();
      m.reference.flush();
    } else {
      const q = Uint32Array.from({ length: 1 + Math.floor(rnd.uniform() * 6) }, draw);
      if (rnd.uniform() < 0.3) q[0] = 7;
      same(m, q, 1 + Math.floor(rnd.uniform() * 30));
      const d = live[Math.floor(rnd.uniform() * live.length)]!;
      expect([...m.packed.termsOf(d)]).toEqual([...m.reference.termsOf(d)]);
      const own = m.reference.termsOf(d);
      const probe = own.length > 0 ? [own[Math.floor(rnd.uniform() * own.length)]!, draw()] : [draw()];
      expect(m.packed.containsAll(d, probe, probe.length)).toBe(m.reference.containsAll(d, probe, probe.length));
      expect(m.packed.containsAll(d, probe, 1)).toBe(m.reference.containsAll(d, probe, 1));
      expect(m.packed.idf(q[0]!)).toBe(m.reference.idf(q[0]!));
    }
    expect(m.packed.size).toBe(m.reference.size);
    expect(m.packed.termCount).toBe(m.reference.termCount);
  }
  expect(m.freedPacked).toEqual(m.freedReference);
  for (let d = 0; d < 4_000; d++) expect([...m.packed.termsOf(d)]).toEqual([...m.reference.termsOf(d)]);
}

describe("SparseIndex (packed) matches the reference layout exactly", () => {
  test("one field, small vocabulary: freezes, purges, doc-number reuse", () => run(1, 1, 3_000, false));
  test("two fields (title × 2, body), BM25+", () => run(2, 2, 3_000, false, 0.25));
  test("three fields, term ids past 16 bits", () => run(3, 3, 2_000, true));
  for (const seed of [11, 12, 13]) test(`two fields, seed ${seed}, long run`, () => run(seed, 2, 6_000, seed === 13));

  test("a light index (never frozen) and one past many freezes answer alike", () => {
    const m = mirror({ fields: 2 });
    for (let i = 0; i < 1_000; i++) {
      const body = Uint32Array.from({ length: 40 }, (_, j) => (i * 7 + j * 13) % 500);
      expect(m.packed.addFields([Uint32Array.of(i % 9), body], [1, 40])).toBe(
        m.reference.addFields([Uint32Array.of(i % 9), body], [1, 40]),
      );
      if (i % 50 === 0) same(m, Uint32Array.of(3, 77, 4, 499), 20);
    }
  });

  test("a heavy index (over 1,024 docs: chained delta) and back down to a scanned one", () => {
    const m = mirror({ fields: 2 });
    const rnd = new Xoshiro128(5);
    const docs: number[] = [];
    const doc = () => Uint32Array.from({ length: 30 }, () => Math.floor(4_000 * rnd.uniform() ** 2));
    const q = () => Uint32Array.from({ length: 4 }, () => Math.floor(4_000 * rnd.uniform() ** 2));
    for (let i = 0; i < 3_000; i++) {
      const body = doc();
      const d = m.packed.addFields([Uint32Array.of(i % 7), body], [1, body.length]);
      expect(m.reference.addFields([Uint32Array.of(i % 7), body], [1, body.length])).toBe(d);
      docs.push(d);
      if (i % 25 === 0) same(m, q(), 25);
    }
    const chained = () => (m.packed as unknown as { dHead: Int32Array | null }).dHead !== null;
    expect(chained()).toBe(true);
    // Shrink to a few hundred docs: purges, then freezes that return the delta to a scan, adds in between.
    for (let i = 0; i < 2_800; i++) {
      const d = docs.splice(Math.floor(rnd.uniform() * docs.length), 1)[0]!;
      m.packed.remove(d);
      m.reference.remove(d);
      if (i % 4 === 0) {
        const body = doc();
        docs.push(m.packed.addFields([Uint32Array.of(3), body], [1, body.length]));
        m.reference.addFields([Uint32Array.of(3), body], [1, body.length]);
      }
      if (i % 25 === 0) same(m, q(), 25);
    }
    expect(chained()).toBe(false);
    expect(m.freedPacked).toEqual(m.freedReference);
  });

  test("a term view stays valid after the index freezes and purges", () => {
    const ix = new SparseIndex();
    const d = ix.add(Uint32Array.of(5, 3, 9), 3);
    const view = ix.termsOf(d);
    for (let i = 0; i < 400; i++) ix.add(Uint32Array.of(100 + i, 5), 2);
    for (let i = 1; i < 300; i++) ix.remove(i);
    ix.flush();
    expect([...view]).toEqual([3, 5, 9]);
    expect([...ix.termsOf(d)]).toEqual([3, 5, 9]);
  });

  test("indexes share scratch without mixing: interleaved users answer as if alone", () => {
    const a = mirror({ fields: 2 });
    const b = mirror({ fields: 2 });
    for (let i = 0; i < 600; i++) {
      for (const [m, off] of [
        [a, 0],
        [b, 1_000],
      ] as const) {
        const body = Uint32Array.from({ length: 30 }, (_, j) => off + ((i * 11 + j * 17) % 400));
        m.packed.addFields([Uint32Array.of(off + (i % 5)), body], [1, 30]);
        m.reference.addFields([Uint32Array.of(off + (i % 5)), body], [1, 30]);
        if (i % 3 === 0) {
          m.packed.remove(i >> 1);
          m.reference.remove(i >> 1);
        }
      }
      if (i % 40 === 0) {
        same(a, Uint32Array.of(1, 50, 1_050), 15);
        same(b, Uint32Array.of(1_001, 1_050, 50), 15);
        // Neither index holds the other's terms.
        expect(a.packed.search(Uint32Array.of(1_050), 1, 5).count).toBe(0);
        expect(b.packed.search(Uint32Array.of(50), 1, 5).count).toBe(0);
      }
    }
  });
});
