import { describe, expect, test } from "bun:test";
import { Xoshiro128 } from "./random";
import { SparseIndex } from "./sparse-index";
import { Vocab } from "./vocab";

/**
 * `compact` and `snapshot`/`restore` (D860). Three indexes take the same operations: `plain` is never compacted
 * except at a checkpoint (after its results were compared with the others'), `kept` is compacted at each checkpoint,
 * and `thawed` is replaced at each checkpoint by `SparseIndex.restore(kept.snapshot())`. Every query must give the
 * same docs, scores, coverage and matches on all three, and the three must free the same terms in the same order.
 */
function results(x: SparseIndex, q: Uint32Array, k: number) {
  const r = x.search(q, q.length, k);
  return {
    docs: [...r.docs.subarray(0, r.count)],
    scores: [...r.scores.subarray(0, r.count)],
    coverage: [...r.coverage.subarray(0, r.count)],
    matched: [...r.matched.subarray(0, r.count)],
  };
}

function run(seed: number, fields: number, steps: number, wide: boolean): void {
  const rnd = new Xoshiro128(seed);
  const freed: number[][] = [[], [], []];
  const opts = (i: number) => ({
    fields,
    weights: [2, 1, 0.5].slice(0, fields),
    onTermFreed: (t: number) => freed[i]!.push(t),
  });
  const plain = new SparseIndex(opts(0));
  const kept = new SparseIndex(opts(1));
  let thawed = new SparseIndex(opts(2));
  const live: number[] = [];
  const terms = wide ? 90_000 : 3_000;
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
      const d = plain.addFields(arrays, counts);
      expect(kept.addFields(arrays, counts)).toBe(d);
      expect(thawed.addFields(arrays, counts)).toBe(d);
      live.push(d);
    } else if (r < 0.85) {
      const d = live.splice(Math.floor(rnd.uniform() * live.length), 1)[0]!;
      plain.remove(d);
      kept.remove(d);
      thawed.remove(d);
    } else if (r < 0.87) {
      // A checkpoint: compare as they stand, then compact (and thaw) all three into one state again.
      const q = Uint32Array.from({ length: 4 }, draw);
      const before = results(plain, q, 20);
      kept.compact();
      expect(results(kept, q, 20)).toEqual(before);
      plain.compact();
      thawed = SparseIndex.restore(thawed.snapshot(), opts(2));
      expect(results(thawed, q, 20)).toEqual(before);
    } else {
      const q = Uint32Array.from({ length: 1 + Math.floor(rnd.uniform() * 6) }, draw);
      if (rnd.uniform() < 0.3) q[0] = 7;
      const k = 1 + Math.floor(rnd.uniform() * 30);
      const want = results(plain, q, k);
      expect(results(kept, q, k)).toEqual(want);
      expect(results(thawed, q, k)).toEqual(want);
      const d = live[Math.floor(rnd.uniform() * live.length)]!;
      expect([...thawed.termsOf(d)]).toEqual([...plain.termsOf(d)]);
      expect(thawed.containsAll(d, q, 1)).toBe(plain.containsAll(d, q, 1));
      expect(thawed.idf(q[0]!)).toBe(plain.idf(q[0]!));
    }
    expect(thawed.size).toBe(plain.size);
    expect(thawed.termCount).toBe(plain.termCount);
  }
  expect(freed[1]).toEqual(freed[0]!);
  expect(freed[2]).toEqual(freed[0]!);
}

describe("SparseIndex compact and snapshot (D860)", () => {
  test("one field, light and heavy", () => {
    run(1, 1, 3_000, false);
    run(2, 1, 6_000, false);
  });
  test("two fields, term ids past 16 bits", () => {
    run(3, 2, 6_000, true);
    run(4, 2, 4_000, false);
  });
  test("three fields", () => run(5, 3, 3_000, false));

  test("compact lets go of the delta's spare room and keeps results", () => {
    const x = new SparseIndex({ fields: 2 });
    const rnd = new Xoshiro128(9);
    for (let d = 0; d < 1_500; d++) {
      const a = Uint32Array.from({ length: 40 }, () => Math.floor(2_000 * rnd.uniform() ** 2));
      x.addFields([a.subarray(0, 4), a], [4, 40]);
    }
    const q = Uint32Array.of(1, 2, 3, 50);
    const before = results(x, q, 20);
    const bytes = (s: ReturnType<SparseIndex["snapshot"]>) =>
      s.fDocs.byteLength + s.fFwd.byteLength + s.fTfs.byteLength + s.keyStart.byteLength;
    x.compact();
    expect(results(x, q, 20)).toEqual(before);
    const s = x.snapshot();
    expect(bytes(s)).toBeGreaterThan(0);
    const y = SparseIndex.restore(s, { fields: 2 });
    expect(results(y, q, 20)).toEqual(before);
    expect(() => SparseIndex.restore(s, { fields: 1 })).toThrow();
  });
});

describe("SparseIndex snapshot past 16 bits of doc numbers (D860)", () => {
  test("Uint32 postings and forward arena survive a restore", () => {
    const x = new SparseIndex({ fields: 1 });
    const rnd = new Xoshiro128(31);
    for (let d = 0; d < 70_000; d++) {
      const a = Uint32Array.of(d % 1_000, 70_000 + Math.floor(rnd.uniform() * 200_000), 7);
      x.add(a, 3);
    }
    for (let d = 0; d < 70_000; d += 13) x.remove(d);
    const s = x.snapshot();
    expect(s.fDocs).toBeInstanceOf(Uint32Array);
    expect(s.fFwd).toBeInstanceOf(Uint32Array);
    const y = SparseIndex.restore(s, { fields: 1 });
    for (const q of [Uint32Array.of(7), Uint32Array.of(999, 7), Uint32Array.of(70_123)]) {
      expect(results(y, q, 30)).toEqual(results(x, q, 30));
    }
    expect([...y.termsOf(69_999)]).toEqual([...x.termsOf(69_999)]);
  });
});

describe("Vocab snapshot (D860)", () => {
  for (const hashes of [true, false]) {
    test(`the same ids, the same free list, released ids stay released${hashes ? "" : " (fingerprints hashed again)"}`, () => {
      const v = new Vocab(16);
      const words = Array.from({ length: 500 }, (_, i) => `w${i}`);
      for (const w of words) v.intern(w);
      for (let id = 0; id < 500; id += 7) v.release(id);
      const { h1: _1, h2: _2, lens: _3, ...bare } = v.snapshot();
      const r = Vocab.restore(hashes ? v.snapshot() : bare);
      expect(r.size).toBe(v.size);
      expect(r.live).toBe(v.live);
      for (let id = 0; id < 500; id++) {
        expect(r.term(id)).toBe(v.term(id));
        expect(r.lookup(words[id]!)).toBe(v.lookup(words[id]!));
      }
      // New terms take released ids in the same order.
      for (let i = 0; i < 80; i++) expect(r.intern(`new${i}`)).toBe(v.intern(`new${i}`));
      expect(r.lookup("Zoë")).toBe(-1);
    });
  }

  test("terms that fold, without fingerprints", () => {
    const v = new Vocab(16);
    const words = ["Zoë", "Café", "ﬁnal", "STRASSE", "Ångström", "naïve", "日本語", "x"];
    for (const w of words) v.intern(w);
    v.release(v.lookup("x"));
    const { h1: _1, h2: _2, lens: _3, ...bare } = v.snapshot();
    const r = Vocab.restore(bare);
    for (const w of words) expect(r.lookup(w)).toBe(v.lookup(w));
    expect(r.intern("new")).toBe(v.intern("new"));
  });
});
