/**
 * SparseIndex against the obvious alternative: BM25 over a Map of term → Map(doc → tf), scored per query into a Map
 * and sorted. Sizes are one user's item cache (the engine holds at most 2,000 items per user; ~1 KB each).
 * Library engines (MiniSearch, Orama) are in compare/sparse-index.compare.ts.
 *
 *   bun packages/primitives/bench/sparse-index.bench.ts [docs=2000]
 */
import { SparseIndex } from "../src/sparse-index";
import { tokenizeInto } from "../src/tokenize";
import { Vocab } from "../src/vocab";
import { bench, consume, corpus, report } from "./harness";

const N = Number(process.argv[2] ?? 2_000);
const buf = new Uint32Array(4_096);

/**
 * Two corpora. "zipf": words drawn from 30,000 types with Zipf exponent 1.07 (the shape of natural text), queries of
 * mid-frequency words. "dense": the harness's email corpus, 186 distinct terms, so every posting list is long: a
 * worst case for term-at-a-time scoring.
 */
function zipfCorpus(): { docs: Uint32Array[]; queries: Uint32Array[]; terms: number } {
  const types = 30_000;
  const cdf = new Float64Array(types);
  let sum = 0;
  for (let r = 0; r < types; r++) cdf[r] = sum += 1 / Math.pow(r + 1, 1.07);
  let x = 9;
  const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296;
  const draw = () => {
    const u = rnd() * sum;
    let lo = 0;
    let hi = types - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const docs = Array.from({ length: N }, () => Uint32Array.from({ length: 100 + Math.floor(rnd() * 100) }, draw));
  const queries = Array.from({ length: 4 }, (_, i) =>
    Uint32Array.from([50 + i, 300 + i * 7, 1_200 + i * 13, 5_000 + i]),
  );
  return { docs, queries, terms: types };
}

function denseCorpus(): { docs: Uint32Array[]; queries: Uint32Array[]; terms: number } {
  const vocab = new Vocab();
  const docs: Uint32Array[] = [];
  for (let i = 0; i < N; i++)
    docs.push(buf.slice(0, tokenizeInto(corpus(1_000, { seed: i + 1 }), vocab, true, buf, null)));
  const queries = [
    "Dana Lee renewal pricing",
    "Globex contract deadline",
    "flight hotel booking thursday",
    "OPS-142 invoice",
  ].map((q) => buf.slice(0, tokenizeInto(q, vocab, false, buf, null)));
  return { docs, queries, terms: vocab.size };
}

class MapBm25 {
  private readonly postings = new Map<number, Map<number, number>>();
  private readonly lens = new Map<number, number>();
  private total = 0;
  add(doc: number, terms: Uint32Array): void {
    this.lens.set(doc, terms.length);
    this.total += terms.length;
    for (const t of terms) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Map()));
      p.set(doc, (p.get(doc) ?? 0) + 1);
    }
  }
  remove(doc: number, terms: Uint32Array): void {
    this.total -= this.lens.get(doc) ?? 0;
    this.lens.delete(doc);
    for (const t of terms) this.postings.get(t)?.delete(doc);
  }
  search(q: Uint32Array, k: number): [number, number][] {
    const n = this.lens.size;
    const avg = this.total / Math.max(1, n);
    const acc = new Map<number, number>();
    for (const t of new Set(q)) {
      const p = this.postings.get(t);
      if (!p || p.size === 0) continue;
      const idf = Math.log(1 + (n - p.size + 0.5) / (p.size + 0.5));
      for (const [doc, tf] of p) {
        const norm = tf + 1.2 * (1 - 0.75 + (0.75 * this.lens.get(doc)!) / avg);
        acc.set(doc, (acc.get(doc) ?? 0) + (idf * (tf * 2.2)) / norm);
      }
    }
    return [...acc].sort((a, b) => b[1] - a[1]).slice(0, k);
  }
}

for (const [label, { docs, queries, terms }] of [
  ["zipf", zipfCorpus()],
  ["dense", denseCorpus()],
] as const) {
  const sparse = new SparseIndex({});
  const map = new MapBm25();
  const docNo = new Int32Array(N); // Position → the doc number SparseIndex gave it (re-adding gives a new one).
  for (let i = 0; i < N; i++) {
    docNo[i] = sparse.add(docs[i]!, docs[i]!.length);
    map.add(i, docs[i]!);
  }
  // Same top score for every query, or the comparison is meaningless.
  for (const q of queries) {
    const a = sparse.search(q, q.length, 10);
    const b = map.search(q, 10);
    if (a.count > 0 && Math.abs(a.scores[0]! - b[0]![1]) > 1e-6 * Math.abs(b[0]![1])) {
      throw new Error(`top scores differ: ${a.scores[0]} vs ${b[0]![1]}`);
    }
  }
  let qi = 0;
  let churn = 0;
  const avg = Math.round(docs.reduce((s, d) => s + d.length, 0) / N);
  console.log(`\n${label}: ${N} docs, ${terms} term types, avg ${avg} terms/doc`);
  report([
    bench(
      "SparseIndex.search, top 24",
      () => {
        const q = queries[qi++ & 3]!;
        return sparse.search(q, q.length, 24).count;
      },
      { batch: 20 },
    ),
    bench("Map BM25 search + sort, top 24", () => map.search(queries[qi++ & 3]!, 24).length, { batch: 5 }),
    bench(
      "SparseIndex remove + add (churn)",
      () => {
        const i = churn++ % N;
        sparse.remove(docNo[i]!);
        return (docNo[i] = sparse.add(docs[i]!, docs[i]!.length));
      },
      { batch: 20 },
    ),
    bench(
      "Map BM25 remove + add (churn)",
      () => {
        const i = churn++ % N;
        map.remove(i, docs[i]!);
        map.add(i, docs[i]!);
      },
      { batch: 20 },
    ),
  ]);
  consume(sparse);
}
