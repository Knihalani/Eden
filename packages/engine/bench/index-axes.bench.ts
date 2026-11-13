/**
 * The per-user search index on every axis a specialisation could move (D1730, docs/research/index-axes.md), for users
 * of 1,000 to 100,000 items: the sim world's items (noiseScale 5, 6,892 items), tiled past that with a few words of
 * each copy's own so a big user's vocabulary grows. Title and text as two fields, weights 2 and 1, as the cache.
 *
 * Index mode (default), per size: build time (adds, then `compact`) incremental as shipped and with merges deferred
 * to one at the end (`deltaCap` set past the build, a private field: what a bulk build could gain at most); the
 * compacted index's bytes an item as held and as computed for compressed layouts (varint or Elias-Fano doc gaps, tf
 * nibbles, varint forward arena); `snapshot`/`restore` time; search p50/p99 for 4-term (`index-memory.bench.ts`'s)
 * and 12-term queries at k 24 (the cache's `search`, an ask's 12 × 2) and 400 (`searchIn`'s depth); churn at the size
 * (remove the oldest and add one) p50/p99/max.
 *
 * `--thaw`: one `ItemCache` user of each size (synced, `put` in pages of 100), its compact and warm blobs, and the
 * compact thaw split into its parts (zstd and `JSON.parse`, deflating each text again, tokenizing, indexing), medians
 * of 9; `--prose` takes the docs' prose as item text. Reads the cache's private `freezeSteps`/`thawSteps`.
 *
 * Run: `bun packages/engine/bench/index-axes.bench.ts [sizes=1000,3000,7000,20000,100000] [--thaw] [--prose]`
 * (100,000 takes about a minute). No model, no network. Machine noise is ±10-15%: compare runs made back to back.
 */
import { readFileSync } from "node:fs";
import type { ContextItem } from "@eden/protocol";
import { SparseIndex, Vocab, tokenizeInto } from "@eden/primitives";
import { buildWorld } from "../../sim/src/world";
import { ItemCache } from "../src/cache";
import { packItem } from "../src/packed-text";
import { termIds } from "../src/text";

const args = process.argv.slice(2);
const SIZES = (args.find((a) => !a.startsWith("--")) ?? "1000,3000,7000,20000,100000").split(",").map(Number);
const PROSE = args.includes("--prose");
const W = buildWorld({ seed: 1, noiseScale: 5 }).items;
const OPTIONS = { fields: 2, weights: [2, 1] };

function prosePieces(): string[] {
  const dir = new URL("../../../docs/", import.meta.url).pathname;
  const files = [...new Bun.Glob("**/*.md").scanSync(dir)].sort();
  const joined = files.map((f) => readFileSync(dir + f, "utf8")).join("\n");
  return Array.from({ length: Math.floor(joined.length / 1_100) }, (_, i) => joined.slice(i * 1_100, (i + 1) * 1_100));
}
const prose = PROSE ? prosePieces() : [];

/** Item `i` of a user: the world's, then copies with words of their own (a name, a reference, a number). */
function textOf(i: number): { title: string; text: string } {
  const it = W[i % W.length]!;
  const c = Math.floor(i / W.length);
  const text = PROSE ? prose[i % prose.length]! : it.text;
  return c === 0
    ? { title: it.title, text }
    : { title: `${it.title} c${c}`, text: `${text} copy${c} ref${i} n${i % 9973}` };
}

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const med = (xs: number[]) => pct(xs, 0.5);
const r1 = (x: number) => Math.round(x * 10) / 10;
const varint = (x: number) => (x < 128 ? 1 : x < 16_384 ? 2 : x < 2_097_152 ? 3 : 4);
const buf = new Uint32Array(1 << 16);

function indexAxes(N: number): void {
  const vocab = new Vocab(256);
  const docs = Array.from({ length: N }, (_, i) => {
    const x = textOf(i);
    const title = buf.slice(0, tokenizeInto(x.title, vocab, true, buf, null));
    return [title, buf.slice(0, tokenizeInto(x.text, vocab, true, buf, null))] as const;
  });
  const build = (deferred: boolean): SparseIndex => {
    const ix = new SparseIndex(OPTIONS);
    if (deferred) (ix as unknown as { deltaCap: number }).deltaCap = Number.POSITIVE_INFINITY;
    for (const [a, b] of docs) ix.addFields([a, b], [a.length, b.length]);
    ix.compact();
    return ix;
  };
  const inc: number[] = [];
  const def: number[] = [];
  let ix = build(false);
  for (let r = 0; r < (N > 20_000 ? 1 : 3); r++) {
    let t = performance.now();
    ix = build(false);
    inc.push(performance.now() - t);
    t = performance.now();
    build(true);
    def.push(performance.now() - t);
  }
  const s = ix.snapshot();
  const held = { postings: s.fDocs.byteLength + s.fTfs.byteLength + s.keyStart.byteLength, fwd: s.fFwd.byteLength };
  const perDoc = s.lens.byteLength + s.where.byteLength + s.fwdStart.byteLength + s.fwdLen.byteLength;
  const fixed = perDoc + s.nPost.byteLength + s.df.byteLength;
  let vDocs = 0;
  let efBits = 0;
  let tfs = 0;
  let keys = 0;
  for (let k = 0; k < s.keys; k++) {
    const a = s.keyStart[k]!;
    const e = s.keyStart[k + 1]!;
    if (e === a) continue;
    keys++;
    for (let i = a, prev = -1; i < e; prev = s.fDocs[i]!, i++) {
      vDocs += varint(s.fDocs[i]! - prev);
      tfs += s.fTfs[i]! >= 15 ? 1.5 : 0.5;
    }
    efBits += (e - a) * (2 + Math.max(0, Math.ceil(Math.log2(N / (e - a)))));
  }
  let vFwd = 0;
  for (let d = 0; d < s.docs; d++) {
    for (let i = s.fwdStart[d]!, prev = -1; i < s.fwdStart[d]! + s.fwdLen[d]!; prev = s.fFwd[i]!, i++) {
      vFwd += varint(s.fFwd[i]! - prev);
    }
  }
  const restores: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    SparseIndex.restore(ix.snapshot(), OPTIONS);
    restores.push(performance.now() - t);
  }
  const queries = (len: number, from: number, step: number) =>
    docs.slice(0, 300).map(([a], i) => {
      const pool = [...a, ...docs[(i * step) % N]![1].subarray(0, from)];
      return Uint32Array.from({ length: len }, (_, j) => pool[(i + j * (len === 4 ? 5 : 3)) % pool.length]!);
    });
  const timed = (qs: Uint32Array[], k: number) => {
    const xs: number[] = [];
    for (let rep = 0; rep < 4; rep++) {
      for (const q of qs) {
        const t = performance.now();
        ix.search(q, q.length, k);
        if (rep > 0) xs.push((performance.now() - t) * 1e3);
      }
    }
    return `${r1(med(xs))} / ${r1(pct(xs, 0.99))} µs`;
  };
  const q4 = queries(4, 20, 7);
  const q12 = queries(12, 40, 13);
  const order: number[] = [];
  const churn = new SparseIndex(OPTIONS);
  for (const [a, b] of docs) order.push(churn.addFields([a, b], [a.length, b.length]));
  churn.settle();
  const steps: number[] = [];
  for (let i = 0; i < Math.min(5_000, N); i++) {
    const t = performance.now();
    churn.remove(order.shift()!);
    const [a, b] = docs[i]!;
    order.push(churn.addFields([a, b], [a.length, b.length]));
    steps.push((performance.now() - t) * 1e3);
  }
  const per = (x: number) => Math.round(x / N);
  console.log(
    JSON.stringify({
      items: N,
      terms: vocab.size,
      postings: s.fDocs.length,
      buildMs: { incremental: r1(med(inc)), mergesDeferred: r1(med(def)) },
      heldBytesAnItem: { postings: per(held.postings), forward: per(held.fwd), rest: per(fixed) },
      heldTotal: per(held.postings + held.fwd + fixed),
      computedBytesAnItem: {
        varint: per(vDocs + tfs + keys * 4 + vFwd + fixed),
        eliasFano: per(efBits / 8 + tfs + keys * 4 + vFwd + fixed),
      },
      restoreMs: Math.round(med(restores) * 100) / 100,
      searchP50P99: { q4k24: timed(q4, 24), q12k24: timed(q12, 24), q12k400: timed(q12, 400) },
      churnUs: { p50: r1(med(steps)), p99: r1(pct(steps, 0.99)), max: r1(Math.max(...steps)) },
    }),
  );
}

type Steps<T> = Generator<undefined, T>;
interface CacheInternals {
  users: Map<string, unknown>;
  freezeSteps(u: unknown, warm: boolean): Steps<{ blob: Uint8Array }>;
  thawSteps(f: unknown): Steps<unknown>;
}
const run = <T>(g: Steps<T>): T => {
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
};

function thawParts(N: number): void {
  const items: ContextItem[] = Array.from({ length: N }, (_, i) => {
    const it = W[i % W.length]!;
    const x = textOf(i);
    const item: ContextItem = { id: `${it.sourceId}:${i}`, sourceId: it.sourceId, ref: `r${i}`, ...x };
    return it.meta ? { ...item, meta: it.meta } : item;
  });
  const cache = new ItemCache({ maxSyncedPerUser: N + 10, maxItemsPerUser: N + 10 });
  cache.close();
  const scope = { tenantId: "t", userId: "u" };
  for (let i = 0; i < N; i += 100) cache.put(scope, items.slice(i, i + 100), Date.UTC(2026, 10, 3, 9), false, true);
  const c = cache as unknown as CacheInternals;
  const u = [...c.users.values()][0];
  const compact = run(c.freezeSteps(u, false));
  const warm = run(c.freezeSteps(u, true));
  const T: Record<string, number[]> = {
    compactThaw: [],
    warmThaw: [],
    zstdJson: [],
    deflate: [],
    tokenize: [],
    index: [],
  };
  for (let r = 0; r < 9; r++) {
    let t = performance.now();
    run(c.thawSteps(compact));
    T.compactThaw!.push(performance.now() - t);
    t = performance.now();
    run(c.thawSteps(warm));
    T.warmThaw!.push(performance.now() - t);
    t = performance.now();
    const body = JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(compact.blob))) as {
      entries: { i: ContextItem }[];
    };
    T.zstdJson!.push(performance.now() - t);
    const plain = body.entries.map((e) => e.i);
    t = performance.now();
    for (const it of plain) packItem(it);
    T.deflate!.push(performance.now() - t);
    const v0 = new Vocab(256);
    t = performance.now();
    for (const it of plain) {
      termIds(it.title, v0, true);
      termIds(it.text, v0, true);
    }
    T.tokenize!.push(performance.now() - t);
    const v = new Vocab(256);
    const ix = new SparseIndex(OPTIONS);
    t = performance.now();
    for (const it of plain) {
      const a = termIds(it.title, v, true);
      const title = a.ids.slice(0, a.n);
      const b = termIds(it.text, v, true);
      ix.addFields([title, b.ids], [title.length, b.n]);
    }
    ix.settle();
    T.index!.push(performance.now() - t); // tokenizing included
  }
  const ms = Object.fromEntries(Object.entries(T).map(([k, xs]) => [k, r1(med(xs))]));
  console.log(
    JSON.stringify({
      items: N,
      text: PROSE ? "prose" : "world",
      compactBlob: compact.blob.byteLength,
      warmBlob: warm.blob.byteLength,
      ms,
    }),
  );
}

for (const n of SIZES) (args.includes("--thaw") ? thawParts : indexAxes)(n);
