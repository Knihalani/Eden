import { describe, expect, test } from "bun:test";
import { SparseIndex } from "./sparse-index";

/** The obvious BM25: every doc, every query term, Maps. The reference SparseIndex must agree with. */
class NaiveBm25 {
  docs = new Map<number, Map<number, number>>();
  lens = new Map<number, number>();
  add(id: number, terms: number[]) {
    const tf = new Map<number, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(id, tf);
    this.lens.set(id, terms.length);
  }
  remove(id: number) {
    this.docs.delete(id);
    this.lens.delete(id);
  }
  search(query: number[]) {
    const n = this.docs.size;
    const avg = [...this.lens.values()].reduce((a, b) => a + b, 0) / n || 1;
    const df = (t: number) => [...this.docs.values()].filter((d) => d.has(t)).length;
    const q = [...new Set(query)].filter((t) => df(t) > 0);
    const idf = (t: number) => Math.log(1 + (n - df(t) + 0.5) / (df(t) + 0.5));
    const total = q.reduce((s, t) => s + idf(t), 0);
    const out: { id: number; score: number; coverage: number; matched: number }[] = [];
    for (const [id, tf] of this.docs) {
      let score = 0;
      let cov = 0;
      let matched = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        score += (idf(t) * f * 2.2) / (f + 1.2 * (1 - 0.75 + (0.75 * this.lens.get(id)!) / avg));
        cov += idf(t);
        matched++;
      }
      if (matched > 0) out.push({ id, score, coverage: total ? cov / total : 0, matched });
    }
    return out.sort((a, b) => b.score - a.score);
  }
}

describe("SparseIndex", () => {
  test("agrees with a naive BM25 through adds, removes, compaction and doc-number reuse", () => {
    let x = 9;
    const rnd = (n: number) => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) % n;
    const idx = new SparseIndex();
    const ref = new NaiveBm25();
    const ext = new Map<number, number>(); // external id -> doc number
    let nextId = 0;
    for (let step = 0; step < 3_000; step++) {
      if (ext.size > 20 && rnd(3) === 0) {
        const ids = [...ext.keys()];
        const id = ids[rnd(ids.length)]!;
        idx.remove(ext.get(id)!);
        ref.remove(id);
        ext.delete(id);
      } else {
        const terms = Array.from({ length: 1 + rnd(30) }, () => (rnd(4) === 0 ? rnd(5) : rnd(300)));
        const id = nextId++;
        ext.set(id, idx.add(Uint32Array.from(terms), terms.length));
        ref.add(id, terms);
      }
      if (step % 50 === 0) {
        const query = Array.from({ length: 1 + rnd(8) }, () => rnd(320));
        const got = idx.search(Uint32Array.from(query), query.length, 10);
        const all = ref.search(query);
        const want = all.slice(0, 10);
        const byDoc = new Map([...ext].map(([id, doc]) => [doc, id]));
        expect(got.count).toBe(want.length);
        // The k-th score must agree; docs tied at the cutoff may be swapped for each other.
        if (got.count > 0) expect(got.scores[got.count - 1]!).toBeCloseTo(want[want.length - 1]!.score, 3);
        for (let j = 0; j < got.count; j++) {
          // Scores agree to float32 accumulation precision; compare each returned doc with its reference row.
          const w = all.find((r) => r.id === byDoc.get(got.docs[j]!))!;
          expect(w).toBeDefined();
          expect(got.scores[j]!).toBeCloseTo(w.score, 3);
          expect(got.coverage[j]!).toBeCloseTo(w.coverage, 4);
          expect(got.matched[j]).toBe(w.matched);
        }
      }
    }
    expect(idx.size).toBe(ext.size);
  });

  test("containsAll and termsOf answer from the stored term set", () => {
    const idx = new SparseIndex();
    const d = idx.add(Uint32Array.from([5, 3, 5, 9]), 4);
    expect([...idx.termsOf(d)]).toEqual([3, 5, 9]);
    expect(idx.containsAll(d, [9, 3], 2)).toBe(true);
    expect(idx.containsAll(d, [9, 4], 2)).toBe(false);
    idx.remove(d);
    expect(idx.containsAll(d, [9], 1)).toBe(false);
  });

  test("term ids far past the scratch size, mid-document, keep exact counts", () => {
    const idx = new SparseIndex();
    const terms = Uint32Array.from([3, 3, 50_000, 3, 1_000_000, 50_000]);
    const d = idx.add(terms, terms.length);
    expect([...idx.termsOf(d)]).toEqual([3, 50_000, 1_000_000]);
    const res = idx.search([3, 50_000, 1_000_000], 3, 1);
    expect(res.matched[0]).toBe(3);
    const ref = new SparseIndex();
    const other = ref.add(Uint32Array.from([0, 0, 1, 0, 2, 1]), 6);
    expect(res.scores[0]!).toBeCloseTo(ref.search([0, 1, 2], 3, 1).scores[0]!, 5);
    void other;
  });

  test("empty index, empty query and unknown terms return nothing", () => {
    const idx = new SparseIndex();
    expect(idx.search([1], 1, 5).count).toBe(0);
    idx.add(Uint32Array.from([1, 2]), 2);
    expect(idx.search([], 0, 5).count).toBe(0);
    expect(idx.search([77], 1, 5).count).toBe(0);
  });
});

describe("SparseIndex fields", () => {
  test("two fields: weighted per-field BM25 sum (+delta) agrees with a naive reference", () => {
    let x = 21;
    const rnd = (n: number) => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) % n;
    const W = [2, 1];
    const Bs = [0.75, 0.5];
    const delta = 0.5;
    const idx = new SparseIndex({ fields: 2, weights: W, b: Bs, delta });
    const docs: number[][][] = [];
    const nos: number[] = [];
    for (let i = 0; i < 300; i++) {
      const title = Array.from({ length: 1 + rnd(5) }, () => rnd(60));
      const body = Array.from({ length: rnd(40) }, () => rnd(200));
      docs.push([title, body]);
      nos.push(idx.addFields([Uint32Array.from(title), Uint32Array.from(body)], [title.length, body.length]));
    }
    for (let i = 0; i < 300; i += 7) idx.remove(nos[i]!);
    const live = docs.map((d, i) => ({ d, i })).filter(({ i }) => i % 7 !== 0);
    const N = live.length;
    const avg = [0, 1].map((f) => live.reduce((s, { d }) => s + d[f]!.length, 0) / N);
    for (let round = 0; round < 40; round++) {
      const q = [...new Set(Array.from({ length: 1 + rnd(4) }, () => rnd(80)))];
      const df = (t: number) => live.filter(({ d }) => d[0]!.includes(t) || d[1]!.includes(t)).length;
      const ref = live
        .map(({ d, i }) => {
          let s = 0;
          for (const t of q) {
            const n = df(t);
            if (n === 0) continue;
            const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
            for (const f of [0, 1]) {
              const tf = d[f]!.filter((y) => y === t).length;
              if (tf === 0) continue;
              s += W[f]! * idf * ((tf * 2.2) / (tf + 1.2 * (1 - Bs[f]! + (Bs[f]! * d[f]!.length) / avg[f]!)) + delta);
            }
          }
          return { no: nos[i]!, s };
        })
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s);
      const got = idx.search(Uint32Array.from(q), q.length, 5);
      expect(got.count).toBe(Math.min(5, ref.length));
      if (got.count > 0) expect(got.scores[0]!).toBeCloseTo(ref[0]!.s, 3);
      for (let j = 0; j < got.count; j++) {
        expect(got.scores[j]!).toBeCloseTo(ref.find((r) => r.no === got.docs[j])!.s, 3);
      }
    }
  });
});
