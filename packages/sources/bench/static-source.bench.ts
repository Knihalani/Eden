/**
 * StaticSource search cost at 400 / 4,000 / 40,000 documents (D175): the old search (every document re-tokenized per
 * call, copied here unchanged), lazy per-document term sets (the finding's stage 1), and the shipped inverted index
 * (stage 2). Prints construction ms, first-search ms (which builds the index), per-search ms (mean over the queries
 * after the first) and the heap the index adds per document. Checks that all three return the same refs on every
 * query.
 *
 *   bun packages/sources/bench/static-source.bench.ts [sizes=400,4000,40000] [queries=40]
 */
import { heapStats } from "bun:jsc";
import { Xoshiro128 } from "@eden/primitives";
import type { ContextItem } from "@eden/protocol";
import type { SearchQuery } from "../src/source";
import { StaticSource, type StaticDoc } from "../src/static-source";

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}]*(?:[._-]+[\p{L}\p{N}]+)*/gu) ?? [];

interface Variant {
  search(q: SearchQuery): Promise<ContextItem[]>;
}

/** Before D175: tokenizes every document on every search. */
class OldSearch implements Variant {
  constructor(private readonly items: ContextItem[]) {}
  async search(query: SearchQuery): Promise<ContextItem[]> {
    const terms = new Set([...words(query.text), ...query.entities.flatMap(words)]);
    const w = query.window;
    const inWindow = (item: ContextItem) => {
      const day = item.meta?.start?.slice(0, 10);
      return !!w && !!day && day >= w.start && day < w.end;
    };
    if (terms.size === 0 && !w) return [];
    return this.items
      .map((item) => {
        const hay = new Set(words(`${item.title} ${item.text}`));
        let hits = 0;
        for (const t of terms) if (hay.has(t)) hits++;
        return { item, hits, dated: inWindow(item) };
      })
      .filter((x) => x.hits > 0 || x.dated)
      .sort((a, b) => Number(b.dated) - Number(a.dated) || b.hits - a.hits)
      .slice(0, query.limit)
      .map((x) => x.item);
  }
}

/** Stage 1: each document's term set built on the first search, then the same scan over all documents. */
class TermSets implements Variant {
  private sets: Set<string>[] | undefined;
  constructor(private readonly items: ContextItem[]) {}
  async search(query: SearchQuery): Promise<ContextItem[]> {
    const terms = new Set([...words(query.text), ...query.entities.flatMap(words)]);
    const w = query.window;
    const inWindow = (item: ContextItem) => {
      const day = item.meta?.start?.slice(0, 10);
      return !!w && !!day && day >= w.start && day < w.end;
    };
    if (terms.size === 0 && !w) return [];
    const sets = (this.sets ??= this.items.map((i) => new Set(words(`${i.title} ${i.text}`))));
    return this.items
      .map((item, k) => {
        const hay = sets[k]!;
        let hits = 0;
        for (const t of terms) if (hay.has(t)) hits++;
        return { item, hits, dated: inWindow(item) };
      })
      .filter((x) => x.hits > 0 || x.dated)
      .sort((a, b) => Number(b.dated) - Number(a.dated) || b.hits - a.hits)
      .slice(0, query.limit)
      .map((x) => x.item);
  }
}

// About 400 characters per document (the verifier's measurement), Zipf-like over a 5,000-word vocabulary. Seeded
// per size, so a size's documents are the same in every process.
const VOCAB = Array.from({ length: 5_000 }, (_, i) => `w${i.toString(36)}${"abcdefgh"[i % 8]}`);
let r = new Xoshiro128(42);
const zipf = () => VOCAB[Math.min(VOCAB.length - 1, Math.floor(Math.exp(r.uniform() * Math.log(VOCAB.length))))]!;
const phrase = (n: number) => Array.from({ length: n }, zipf).join(" ");

function genDocs(n: number): StaticDoc[] {
  r = new Xoshiro128(n);
  return Array.from({ length: n }, (_, i) => {
    const d: StaticDoc = { ref: `r${i}`, title: phrase(5), text: phrase(60) };
    if (i % 10 === 0) d.meta = { start: `2026-11-0${1 + (i % 7)}` };
    return d;
  });
}

function genQueries(n: number): SearchQuery[] {
  return Array.from({ length: n }, (_, i) => ({
    scope: { tenantId: "t", userId: "u" },
    text: phrase(4),
    entities: [zipf()],
    limit: 10,
    ...(i % 5 === 0 ? { window: { start: "2026-11-03", end: "2026-11-05" } } : {}),
  }));
}

const copy = (docs: StaticDoc[]): ContextItem[] => docs.map((d) => ({ ...d, id: `docs:${d.ref}`, sourceId: "docs" }));
const VARIANTS: Record<string, (docs: StaticDoc[]) => Variant> = {
  old: (docs) => new OldSearch(copy(docs)),
  "term-sets": (docs) => new TermSets(copy(docs)),
  shipped: (docs) => new StaticSource("docs", "bench", docs),
};

function heap(): number {
  Bun.gc(true);
  return heapStats().heapSize;
}

const argv = process.argv.slice(2);

// Child mode: the heap one variant's first search adds per document, alone in a fresh process (in one process the
// previous variant's garbage, kept or freed by the conservative stack scan, swamps the difference).
if (argv[0] === "--heap") {
  const docs = genDocs(Number(argv[2]));
  const query = genQueries(1)[0]!;
  const v = VARIANTS[argv[1]!]!(docs);
  const h1 = heap();
  await v.search(query);
  const h2 = heap();
  console.log(Math.round((h2 - h1) / docs.length));
  // Keeps the instance (and its index) reachable past the second reading.
  if (Object.keys(v).length < 0) console.log(v);
  process.exit(0);
}

function heapPerDoc(name: string, n: number): string {
  if (name === "old") return "0";
  const out = Bun.spawnSync([process.execPath, import.meta.path, "--heap", name, String(n)]);
  return out.stdout.toString().trim() || "?";
}

const sizes = (argv[0] ?? "400,4000,40000").split(",").map(Number);
const queryCount = Number(argv[1] ?? 40);

console.log("variant      docs   construct ms  first search ms  per search ms  index heap B/doc");
const perSearch = new Map<string, number>();
for (const n of sizes) {
  const docs = genDocs(n);
  // The old search at 40k docs takes ~0.4 s a call: fewer queries keep the run short.
  const queries = genQueries(n >= 40_000 ? Math.min(queryCount, 10) : queryCount);
  const results: Record<string, string> = {};
  for (const [name, make] of Object.entries(VARIANTS)) {
    // Construction includes the items copy (the bench's own for old and term sets, StaticSource's for shipped).
    let t = performance.now();
    const v = make(docs);
    const construct = performance.now() - t;
    t = performance.now();
    const got = [(await v.search(queries[0]!)).map((i) => i.ref)];
    const firstMs = performance.now() - t;
    t = performance.now();
    for (let q = 1; q < queries.length; q++) got.push((await v.search(queries[q]!)).map((i) => i.ref));
    const per = (performance.now() - t) / (queries.length - 1);
    results[name] = JSON.stringify(got);
    perSearch.set(`${name}@${n}`, per);
    const row = [
      name.padEnd(10),
      String(n).padStart(6),
      construct.toFixed(2).padStart(13),
      firstMs.toFixed(2).padStart(16),
      per.toFixed(3).padStart(14),
      heapPerDoc(name, n).padStart(17),
    ];
    console.log(row.join(" "));
  }
  if (results["term-sets"] !== results.old || results.shipped !== results.old) {
    throw new Error(`results differ at ${n} docs`);
  }
}
console.log("refs identical across variants on every query");
for (const n of sizes) {
  const old = perSearch.get(`old@${n}`)!;
  const sets = perSearch.get(`term-sets@${n}`)!;
  const shipped = perSearch.get(`shipped@${n}`)!;
  console.log(
    `${n} docs: shipped ${(old / shipped).toFixed(1)}x faster than old, ` +
      `${(sets / shipped).toFixed(1)}x faster than term sets`,
  );
}
