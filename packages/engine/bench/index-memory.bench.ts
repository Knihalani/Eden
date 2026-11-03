/**
 * The per-user search index's memory and speed: the packed `SparseIndex` (frozen CSR + scanned delta) against the
 * layout it replaced (`ReferenceSparseIndex`, kept in primitives as the oracle), on the same term ids.
 *
 * Corpus: a sim world (`buildWorld`, noiseScale 5: 6,892 mail, calendar, doc, CRM and chat items, ~1 KB of text
 * each), tokenized as the engine's cache does (title and text, two fields, weights 2 and 1). Reported:
 *
 * - heap per item and per user, each in a child process (heap after a full GC less the heap before, the vocabulary
 *   built first so only the index counts): one heavy user holding every item, and 500 light users of 20 items each;
 *   the packed index settled (no merge under way, D120), and as built (a merge may hold old and new arrays together);
 * - the whole `ItemCache` per item (`cache` mode: entries, sketches, tallies, vocabulary and index; not the item text,
 *   whose strings the world still holds), for the end-to-end share: run it on each tree for before/after;
 * - add p50/p99/max (the max is a freeze in the packed index), search p50/p99 for 4-term queries drawn from item
 *   titles, at 20 / 128 / 1,000 / 6,892 items;
 * - churn at the cap: 6,892 live, remove the oldest and add one, 5,000 times: p50/p99/max per step.
 *
 * Run: `bun packages/engine/bench/index-memory.bench.ts`. No model, no network. Numbers vary ±30% on a shared VM.
 */
import { SparseIndex, Vocab, tokenizeInto } from "@eden/primitives";
import { ReferenceSparseIndex } from "../../primitives/src/sparse-index.reference";
import { buildWorld } from "../../sim/src/world";
import { ItemCache } from "../src/cache";

type Impl = "packed" | "reference";
type Index = SparseIndex | ReferenceSparseIndex;

const world = buildWorld({ seed: 1, noiseScale: 5 });
const ITEMS = world.items;

function make(impl: Impl): Index {
  const options = { fields: 2, weights: [2, 1] };
  return impl === "packed" ? new SparseIndex(options) : new ReferenceSparseIndex(options);
}

interface Doc {
  title: Uint32Array;
  body: Uint32Array;
}

const buf = new Uint32Array(1 << 16);
function tokenize(vocab: Vocab, text: string): Uint32Array {
  return buf.slice(0, tokenizeInto(text, vocab, true, buf, null));
}

/** One user's items as term ids in the user's own vocabulary. */
function docsOf(items: typeof ITEMS, vocab: Vocab): Doc[] {
  return items.map((it) => ({ title: tokenize(vocab, it.title), body: tokenize(vocab, it.text) }));
}

function add(ix: Index, d: Doc): number {
  return ix.addFields([d.title, d.body], [d.title.length, d.body.length]);
}

function heapBytes(): number {
  for (let i = 0; i < 3; i++) {
    Bun.gc(true);
    Bun.sleepSync(20); // let the collector's sweeping finish: one GC left ~10 MB of tokenizer garbage counted
  }
  return process.memoryUsage().heapUsed;
}

/** One user's index. A function of its own, so no stack slot of the caller keeps it past the drop. */
function build(impl: Impl, docs: Doc[]): Index {
  const ix = make(impl);
  for (const d of docs) add(ix, d);
  return ix;
}

/**
 * The packed index's per-doc query scratch (score, coverage, matches, stamp, touched: 20 bytes per doc slot, slots a
 * power of two from 1,024) is one copy per process, sized by the largest index searched; the reference holds the same
 * per index, so its readings include it. Searching a measured index here made JSC keep it reachable after the drop
 * (a one-user reading came out as zero), so the packed rows add it by this count instead, for the largest user only.
 */
function sharedScratch(docs: number): number {
  let slots = 1_024;
  while (slots < docs) slots *= 2;
  return 20 * slots;
}

/** Child: heap of `users` indexes of `per` items each (bytes per item, per user). */
function heapChild(impl: Impl, users: number, per: number, settled: boolean): void {
  // Warm the shared scratch (one copy per process) so it counts in no build.
  const warm = make(impl);
  add(warm, { title: Uint32Array.of(1 << 17), body: Uint32Array.of(0) });
  warm.search(Uint32Array.of(1 << 17, 0), 2, 1);
  const corpora: Doc[][] = [];
  const vocabs: Vocab[] = []; // held to the end: only the indexes may differ between the two readings
  for (let u = 0; u < users; u++) {
    const start = (u * per) % Math.max(1, ITEMS.length - per);
    vocabs.push(new Vocab(256));
    corpora.push(docsOf(ITEMS.slice(start, start + per), vocabs[u]!));
  }
  // Measured as the heap the indexes hold when dropped (heap with them less heap after dropping them): a reading
  // taken before building them counted up to ~10 MB of tokenizer garbage JSC had not yet swept.
  const held: Index[] = [];
  for (const docs of corpora) held.push(build(impl, docs));
  // Settled: no merge under way (D120), the index at rest. As built, a merge may hold old and new arrays together.
  if (settled) for (const ix of held) if (ix instanceof SparseIndex) ix.settle();
  const withIndexes = heapBytes();
  const count = held.length;
  held.length = 0;
  const bytes = withIndexes - heapBytes();
  console.log(JSON.stringify({ perItem: bytes / (users * per), perUser: bytes / users, held: count + vocabs.length }));
}

/** Child: the whole ItemCache for one user holding every item, bytes per item (run on each tree for before/after). */
const caches: ItemCache[] = [];

/** Builds the cache into `caches` (a separate frame, so no register or stack slot of the caller keeps it alive). */
function buildCache(): void {
  const scope = { tenantId: "t", userId: "u" };
  const cache = new ItemCache({ maxItemsPerUser: 10_000, expireEveryMs: 0 } as never);
  for (let i = 0; i < ITEMS.length; i += 100) {
    const batch = ITEMS.slice(i, i + 100).map(({ id, sourceId, ref, title, text, updatedAt, url }) => ({
      ...{ id, sourceId, ref, title, text, updatedAt, url },
    }));
    cache.put(scope, batch, world.now);
  }
  caches.push(cache);
}

/** Heap before and after building (dropping the cache freed nothing measurable in JSC, so not that way round). */
function cacheChild(settled: boolean): void {
  const before = heapBytes();
  buildCache();
  // The expiry tick ends a merge left under way (D120); nothing expires at the world's own clock.
  if (settled) caches[0]!.expireIdle(world.now);
  console.log(JSON.stringify({ perItem: (heapBytes() - before) / ITEMS.length }));
}

function child(args: string[]): unknown {
  const out = Bun.spawnSync([process.execPath, import.meta.path, ...args], { stderr: "inherit" });
  return JSON.parse(out.stdout.toString().trim());
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

const us = (ms: number) => `${(ms * 1e3).toFixed(1)} µs`;

/** Add and search timings for one user of `n` items. */
function speed(impl: Impl, n: number): string {
  const vocab = new Vocab(256);
  const docs = docsOf(ITEMS.slice(0, n), vocab);
  const queries = docs.slice(0, 200).map((d, i) => {
    const pool = [...d.title, ...docs[(i * 7) % docs.length]!.body.subarray(0, 20)];
    return Uint32Array.from({ length: 4 }, (_, j) => pool[(i + j * 5) % pool.length]!);
  });
  const adds: number[] = [];
  const searches: number[] = [];
  // Several rounds (fresh indexes) so a small user's few adds give stable percentiles; first round is warmup.
  const rounds = Math.max(3, Math.ceil(3_000 / n));
  let sink = 0;
  for (let r = 0; r < rounds; r++) {
    const ix = make(impl);
    for (const d of docs) {
      const t0 = performance.now();
      add(ix, d);
      if (r > 0) adds.push(performance.now() - t0);
    }
    for (let rep = 0; rep < 3; rep++) {
      for (const q of queries) {
        const t0 = performance.now();
        sink += ix.search(q, q.length, 20).count;
        if (r > 0) searches.push(performance.now() - t0);
      }
    }
  }
  void sink;
  return (
    `${String(n).padStart(5)} items  add p50 ${us(pct(adds, 0.5)).padStart(9)} p99 ${us(pct(adds, 0.99)).padStart(9)}` +
    ` max ${us(Math.max(...adds)).padStart(10)}   search p50 ${us(pct(searches, 0.5)).padStart(9)}` +
    ` p99 ${us(pct(searches, 0.99)).padStart(9)}`
  );
}

/** A full user turning over: remove the oldest, add one, at the cap. */
function churn(impl: Impl): string {
  const vocab = new Vocab(256);
  const docs = docsOf(ITEMS, vocab);
  const ix = make(impl);
  const order: number[] = [];
  for (const d of docs) order.push(add(ix, d));
  const steps: number[] = [];
  for (let i = 0; i < 5_000; i++) {
    const t0 = performance.now();
    ix.remove(order.shift()!);
    order.push(add(ix, docs[i % docs.length]!));
    steps.push(performance.now() - t0);
  }
  const pauses = steps.filter((ms) => ms > 1);
  return (
    `churn at ${docs.length}: step p50 ${us(pct(steps, 0.5))} p99 ${us(pct(steps, 0.99))} max ` +
    `${us(Math.max(...steps))}; pauses over 1 ms: ${pauses.length}, median ${us(pauses.length ? pct(pauses, 0.5) : 0)}`
  );
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "heap") heapChild(rest[0] as Impl, Number(rest[1]), Number(rest[2]), rest[3] !== "built");
else if (mode === "cache") cacheChild(rest[0] !== "built");
else {
  console.log(
    `corpus: ${ITEMS.length} sim items, ${(ITEMS.reduce((s, i) => s + i.text.length, 0) / ITEMS.length) | 0} chars of text each\n`,
  );
  console.log("heap (index only)               reference            packed     ratio");
  for (const [label, users, per] of [
    ["1 user × 6,892 items", 1, ITEMS.length],
    ["1 user × 2,000 items", 1, 2_000],
    ["500 users × 20 items", 500, 20],
    ["100 users × 200 items", 100, 200],
  ] as const) {
    const a = child(["heap", "reference", String(users), String(per)]) as { perItem: number; perUser: number };
    const b = child(["heap", "packed", String(users), String(per)]) as { perItem: number; perUser: number };
    const built = child(["heap", "packed", String(users), String(per), "built"]) as { perItem: number };
    b.perUser += sharedScratch(per) / users; // the process's one copy, shared by its users
    b.perItem += sharedScratch(per) / (users * per);
    built.perItem += sharedScratch(per) / (users * per);
    console.log(
      `${label.padEnd(24)} ${`${a.perItem.toFixed(0)} B/item`.padStart(16)} ${`${b.perItem.toFixed(0)} B/item`.padStart(16)}` +
        `  ${(a.perItem / b.perItem).toFixed(2)}x   (per user ${(a.perUser / 1024).toFixed(1)} → ${(b.perUser / 1024).toFixed(1)} KB;` +
        ` as built, a merge maybe under way: ${built.perItem.toFixed(0)} B/item)`,
    );
  }
  const c = child(["cache"]) as { perItem: number };
  const cBuilt = child(["cache", "built"]) as { perItem: number };
  console.log(
    `\nItemCache, 1 user × ${ITEMS.length} items (this tree's index; the packed index's shared query scratch, ` +
      `${(sharedScratch(ITEMS.length) / ITEMS.length).toFixed(0)} B/item, not included): ${c.perItem.toFixed(0)} B/item` +
      ` after an expiry tick, ${cBuilt.perItem.toFixed(0)} B/item as built\n`,
  );
  for (const impl of ["reference", "packed"] as const) {
    console.log(impl);
    for (const n of [20, 128, 1_000, ITEMS.length]) console.log(`  ${speed(impl, n)}`);
    console.log(`  ${churn(impl)}`);
  }
}
