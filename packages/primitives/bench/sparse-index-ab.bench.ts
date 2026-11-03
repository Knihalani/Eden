/**
 * The packed `SparseIndex` against the layout it replaced (`ReferenceSparseIndex`), interleaved in one process: six
 * rounds, each timing the reference then the packed index on the same docs and queries; the median p50 of each is
 * printed. Separate processes differ by up to 2x for identical code (JIT tiering, README), so this is the comparison
 * to trust. The corpora are sparse-index.bench.ts's (zipf over 30,000 types; the dense email corpus), one field.
 *
 *   bun packages/primitives/bench/sparse-index-ab.bench.ts [docs=2000]
 */
import { SparseIndex } from "../src/sparse-index";
import { ReferenceSparseIndex } from "../src/sparse-index.reference";
import { tokenizeInto } from "../src/tokenize";
import { Vocab } from "../src/vocab";
import { bench, consume, corpus } from "./harness";

const N = Number(process.argv[2] ?? 2_000);
const buf = new Uint32Array(4_096);

function zipf(): { docs: Uint32Array[]; queries: Uint32Array[] } {
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
  return { docs, queries };
}

function dense(): { docs: Uint32Array[]; queries: Uint32Array[] } {
  const vocab = new Vocab();
  const docs: Uint32Array[] = [];
  for (let i = 0; i < N; i++) {
    docs.push(buf.slice(0, tokenizeInto(corpus(1_000, { seed: i + 1 }), vocab, true, buf, null)));
  }
  const queries = ["Dana Lee renewal pricing", "Globex contract deadline", "flight hotel booking thursday"].map((q) =>
    buf.slice(0, tokenizeInto(q, vocab, false, buf, null)),
  );
  return { docs, queries };
}

type Index = SparseIndex | ReferenceSparseIndex;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]! / 1_000;

for (const [label, { docs, queries }] of [
  ["zipf", zipf()],
  ["dense", dense()],
] as const) {
  const indexes: Index[] = [new ReferenceSparseIndex({}), new SparseIndex({})];
  const docNo = indexes.map(() => new Int32Array(N));
  indexes.forEach((ix, k) => docs.forEach((d, i) => (docNo[k]![i] = ix.add(d, d.length))));
  const search = [[], []] as number[][];
  const churn = [[], []] as number[][];
  let qi = 0;
  const at = [0, 0];
  for (let round = 0; round < 6; round++) {
    indexes.forEach((ix, k) => {
      search[k]!.push(
        bench("search", () => ix.search(queries[qi++ % queries.length]!, 4, 24).count, { batch: 20 }).p50Ns,
      );
      churn[k]!.push(
        bench(
          "churn",
          () => {
            const i = at[k]!++ % N;
            ix.remove(docNo[k]![i]!);
            return (docNo[k]![i] = ix.add(docs[i]!, docs[i]!.length));
          },
          { batch: 20, batches: 100 },
        ).p50Ns,
      );
    });
  }
  console.log(
    `${label.padEnd(5)} search p50 ${median(search[0]!).toFixed(2)} → ${median(search[1]!).toFixed(2)} µs, ` +
      `remove + add p50 ${median(churn[0]!).toFixed(2)} → ${median(churn[1]!).toFixed(2)} µs (reference → packed)`,
  );
  consume(indexes);
}
