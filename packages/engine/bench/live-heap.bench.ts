/**
 * Where a live heavy user's memory goes: `users.bench.ts`'s setup (the shipped wiring, `--prose` items, N sources a
 * user), every user live (no freeze), then each user's state walked object by object and its bytes summed by part:
 * the cache's entries, items (their strings, meta and deflated text), vocabulary, index, sketcher and tallies, and
 * the sync's per-source state. Sizes are JSC's own (`estimateShallowMemoryUsageOf`) plus each Map, Set and array's
 * slots, which that call leaves out (8 bytes a slot, 24 a Map entry, 16 a Set entry, at the table's power-of-two
 * size); a typed array's buffer is counted once. The walk's total is set beside the measured heap and RSS a user, so
 * what it misses shows.
 *
 * Run: `bun packages/engine/bench/live-heap.bench.ts [users=12] [itemsPerUser=3000] [--sources=20] [--world]`
 * (`--prose` is the default here; `--world` takes the sim's own text). No model, no network.
 */
import { estimateShallowMemoryUsageOf as shallow } from "bun:jsc";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextItem, Scope } from "@eden/protocol";
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS } from "@eden/llm";
import type { ListPage, Source } from "@eden/sources";
import { ItemCache } from "../src/cache";
import { ContextPartner } from "../src/partner";
import { termIds } from "../src/text";
import { stubCards } from "./stub-cards";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const USERS = Number(args[0] ?? 12);
const PER_USER = Number(args[1] ?? 3_000);
const SOURCE_COUNT = Number(process.argv.find((a) => a.startsWith("--sources="))?.slice(10) ?? 20);
const SOURCES = Array.from({ length: SOURCE_COUNT }, (_, i) => ["mail", "calendar", "docs"][i] ?? `src${i}`);
const PROSE = !process.argv.includes("--world");
const MB = 1024 * 1024;

class ListSource implements Source {
  readonly kind = "bench";
  readonly description = "bench";
  constructor(
    readonly id: string,
    public items: ContextItem[],
  ) {}
  async search(): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
  }
}

const mem = async () => {
  let rss = Number.POSITIVE_INFINITY;
  for (let t = 0; t < 20; t++) {
    Bun.gc(true);
    const now = process.memoryUsage().rss;
    if (now > rss * 0.99) break;
    rss = now;
    await Bun.sleep(1_000);
  }
  Bun.gc(true);
  const m = process.memoryUsage();
  return { heap: m.heapUsed, rss: Math.min(rss, m.rss) };
};

function prosePieces(): string[] {
  const dir = new URL("../../../docs/", import.meta.url).pathname;
  const files = [...new Bun.Glob("**/*.md").scanSync(dir)].sort();
  const joined = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  return Array.from({ length: Math.floor(joined.length / 1_100) }, (_, i) => joined.slice(i * 1_100, (i + 1) * 1_100));
}

const { buildWorld } = await import("../../sim/src/world");
const all = buildWorld({ seed: 1, noiseScale: 5 }).items;
const prose = PROSE ? prosePieces() : [];
const base: ContextItem[] = Array.from({ length: PER_USER }, (_, i) => {
  const it = all[Math.floor((i * all.length) / PER_USER) % all.length]!;
  const text = PROSE ? prose[i % prose.length]! : it.text;
  const item: ContextItem = { id: it.id, sourceId: it.sourceId, ref: it.ref, title: it.title, text };
  return it.meta ? { ...item, meta: it.meta } : item;
});

let clock = Date.UTC(2026, 10, 3, 9);
const T0 = clock;
const m0 = await mem();
const users: { scope: Scope; sources: ListSource[] }[] = [];
for (let u = 0; u < USERS; u++) {
  const per = SOURCES.map((id) => new ListSource(id, [] as ContextItem[]));
  base.forEach((it, i) => {
    const k = i % SOURCES.length;
    per[k]!.items.push({
      ...it,
      id: `${SOURCES[k]}:u${u}-${i}`,
      sourceId: SOURCES[k]!,
      ref: `u${u}-${i}`,
      text: `${it.text} (u${u})`,
      updatedAt: T0 - i * 60_000,
    });
  });
  users.push({ scope: { tenantId: "bench", userId: `u${u}` }, sources: per });
}
const byUser = new Map(users.map((x) => [x.scope.userId, x.sources]));
const cache = new ItemCache({ maxUsersPerTenant: USERS + 1, maxSyncedPerUser: Math.max(5_000, PER_USER) });
cache.close();
/** `--cards`: a $0 stub card maker (`stub-cards.ts`), so the card and intent state a user with a key holds counts. */
const CARDS = process.argv.includes("--cards");
const enricher = CARDS ? stubCards(() => clock) : undefined;
const partner = new ContextPartner({
  ...(enricher ? { cards: enricher } : {}),
  sources: async (scope) => byUser.get(scope.userId)!,
  sourceMap: new SourceMap(join(mkdtempSync(join(tmpdir(), "eden-live-heap-")), "source-map.db")),
  cache,
  budget: new Budget(DEFAULT_LIMITS),
  model: null,
  now: () => clock,
  config: { syncMaxItems: PER_USER, syncMaxUsersPerTenant: USERS + 1, syncCallsPerMin: 1e7 },
});
const sync = partner.sync!;
for (const { scope } of users) sync.track(scope, clock);
const target = USERS * PER_USER;
for (let i = 0; users.reduce((s, { scope }) => s + cache.syncedCount(scope), 0) < target; i++) {
  if (i > 100_000) throw new Error("the sync stopped");
  clock += 1_000;
  await sync.tick();
}
if (enricher) await enricher.idle();
for (const { sources } of users) for (const s of sources) s.items = [];
// `--thaw`: every user frozen by idle ticks and read once (a cache search), as `users.bench.ts`'s "after thaw" line:
// a live user as most are, rather than straight after a backfill.
if (process.argv.includes("--thaw")) {
  for (let t = 0; t < 8 && cache.frozenCount < USERS; t++) cache.expireIdle(clock);
  if (cache.frozenCount !== USERS) throw new Error(`froze ${cache.frozenCount} of ${USERS}`);
  for (const { scope } of users) {
    const vocab = cache.peekVocab(scope)!;
    const q = termIds("budget review", vocab, false);
    cache.search(scope, q.ids, q.n, 10, clock);
  }
}
const m1 = await mem();

// The walk. `seen` is shared by every part of every user, so a shared object (an interned string, a prototype's
// field) counts once, in the first part that reaches it: parts are walked in a fixed order.
const seen = new Set<unknown>();
const buffers = new Set<ArrayBufferLike>();
const slots = (n: number) => (n === 0 ? 0 : 2 ** Math.ceil(Math.log2(Math.max(8, n))));
function walk(root: unknown, stop?: (v: unknown) => boolean): number {
  let bytes = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === "string") {
      if (seen.has(v)) continue;
      seen.add(v);
      bytes += shallow(v);
      continue;
    }
    if (t !== "object") continue; // numbers are unboxed; functions are code, shared by every user
    if (seen.has(v) || stop?.(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      const buf = (v as Uint8Array).buffer;
      bytes += 64; // the view's own cell
      if (!buffers.has(buf)) {
        buffers.add(buf);
        bytes += buf.byteLength;
      }
      continue;
    }
    bytes += shallow(v);
    if (v instanceof Map) {
      bytes += slots(v.size) * 24;
      for (const [k, x] of v) stack.push(k, x);
    } else if (v instanceof Set) {
      bytes += slots(v.size) * 16;
      for (const x of v) stack.push(x);
    } else if (Array.isArray(v)) {
      bytes += v.length * 8;
      for (const x of v) stack.push(x);
    } else if (v instanceof Promise || v instanceof WeakMap) {
      continue;
    } else {
      for (const key of Reflect.ownKeys(v as object)) {
        const d = Object.getOwnPropertyDescriptor(v, key)!;
        if (d.get) continue; // a packed item's text getter: its bytes are under its symbol key
        stack.push(d.value);
      }
    }
  }
  return bytes;
}

type Any = Record<string, unknown>;
const cacheUsers = (cache as unknown as { users: Map<string, Any> }).users;
const syncUsers = (sync as unknown as { users: Map<string, Any> }).users;
const parts = new Map<string, number>();
const add = (k: string, b: number) => parts.set(k, (parts.get(k) ?? 0) + b);
let itemsMeta = 0;
let itemsText = 0;
let itemsStrings = 0;
for (const [key, u] of cacheUsers) {
  if (!("index" in u)) throw new Error(`user ${key} is frozen`);
  const items = u.items as Map<string, Any>;
  add(
    "cache: items Map",
    walk(items, (v) => v !== items),
  );
  // The entry objects alone (their fields are numbers or other entries), then each item's own parts.
  for (const e of items.values()) {
    add(
      "cache: entry objects",
      walk(e, (v) => v !== e),
    );
    const it = e.item as Any;
    add(
      "cache: item objects",
      walk(it, (v) => v !== it),
    );
    for (const k of Reflect.ownKeys(it)) {
      const d = Object.getOwnPropertyDescriptor(it, k)!;
      if (d.get) continue;
      const b = walk(d.value);
      if (k === "meta") itemsMeta += b;
      else if (typeof k === "symbol") itemsText += b;
      else itemsStrings += b;
    }
    add("cache: entry sketches", walk(e.sketch));
  }
  add("cache: vocab", walk(u.vocab));
  add(
    "cache: index",
    walk(u.index, (v) => v === u.vocab),
  );
  add(
    "cache: sketcher",
    walk(u.sketcher, (v) => v === u.vocab),
  );
  add(
    "cache: byDoc",
    walk(u.byDoc, (v) => v !== u.byDoc),
  );
  for (const k of ["offsets", "probes", "parties", "personNames", "addresses"]) add(`cache: tally ${k}`, walk(u[k]));
  add("cache: rest of user", walk(u));
}
add("cache: item meta", itemsMeta);
add("cache: item text (deflated)", itemsText);
add("cache: item ids, ref, title, ...", itemsStrings);
for (const [, s] of syncUsers) {
  for (const src of (s.sources as Map<string, Any>).values()) {
    add("sync: source ids (IdSet)", walk(src.ids));
    add("sync: source sketch", walk(src.sketch));
    add("sync: source missed/pushed/sweep", walk(src.missed) + walk(src.pushed) + walk(src.sweep));
  }
  add("sync: rare terms", walk(s.rare));
  add("sync: rest of user", walk(s));
}
if (enricher) {
  const cardUsers = (enricher as unknown as { users: Map<string, Any> }).users;
  for (const u of cardUsers.values()) {
    for (const k of ["byHash", "byItem", "holders", "bySentence", "intent", "queue"]) {
      add(`cards: ${k}`, walk(u[k]));
    }
  }
  console.log(`cards: ${JSON.stringify(enricher.stats)}`);
}
add(
  "partner: everything else",
  walk(partner, (v) => v === cache || v === sync || v === enricher),
);

const total = [...parts.values()].reduce((a, b) => a + b, 0);
const out = [...parts].sort((a, b) => b[1] - a[1]);
console.log(
  `users ${USERS}, ${PER_USER} items each over ${SOURCE_COUNT} sources (${PROSE ? "prose" : "world"} text)\n` +
    `measured a user: heap ${((m1.heap - m0.heap) / USERS / MB).toFixed(2)} MB, RSS ${((m1.rss - m0.rss) / USERS / MB).toFixed(2)} MB; ` +
    `walked ${(total / USERS / MB).toFixed(2)} MB`,
);
for (const [k, b] of out) {
  if (b / USERS < 1_024) continue;
  console.log(
    `${k.padEnd(36)} ${(b / USERS / MB).toFixed(3).padStart(7)} MB  ${((100 * b) / total).toFixed(1).padStart(5)}%  ${(b / USERS / PER_USER).toFixed(0).padStart(5)} B/item`,
  );
}

if (process.argv.includes("--fields")) {
  // The index's and vocabulary's own fields, summed over users (a fresh `seen`).
  const fields = new Map<string, number>();
  for (const u of cacheUsers.values()) {
    for (const [name, obj] of [
      ["index", u.index],
      ["vocab", u.vocab],
    ] as const) {
      for (const k of Reflect.ownKeys(obj as object)) {
        seen.clear();
        buffers.clear();
        const b = walk((obj as Any)[k as string], (v) => v === u.vocab);
        fields.set(`${name}.${String(k)}`, (fields.get(`${name}.${String(k)}`) ?? 0) + b);
      }
    }
  }
  for (const [k, b] of [...fields].sort((a, b) => b[1] - a[1]))
    if (b / USERS >= 1_024) console.log(`${k.padEnd(36)} ${(b / USERS / MB).toFixed(3).padStart(7)} MB`);
  const u0 = [...cacheUsers.values()][0]!;
  console.log("vocab size", (u0.vocab as { size: number }).size, "docs", (u0.items as Map<string, unknown>).size);
}

if (process.argv.includes("--types")) {
  // JSC's object counts by type, per user, against the same process before any user (`--types`).
  const { heapStats } = await import("bun:jsc");
  Bun.gc(true);
  const counts = heapStats().objectTypeCounts as Record<string, number>;
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
  for (const [k, n] of top) console.log(`${k.padEnd(28)} ${(n / USERS).toFixed(0).padStart(8)} a user`);
}

if (enricher && process.argv.includes("--forget-cards")) {
  // Subtractive: every user's cards forgotten (`CardEnricher.forget`), then the heap and RSS a user again.
  const before = await mem();
  for (const { scope } of users) enricher.forget(scope);
  const after = await mem();
  console.log(
    `forgetting every user's cards freed heap ${((before.heap - after.heap) / USERS / MB).toFixed(2)} MB, ` +
      `RSS ${((before.rss - after.rss) / USERS / MB).toFixed(2)} MB a user`,
  );
}

if (process.argv.includes("--snapshot")) {
  // JSC's heap snapshot: every cell's size summed by class (typed arrays' stores included as their cell's size).
  Bun.gc(true);
  const snap = Bun.generateHeapSnapshot() as unknown as { nodes: number[]; nodeClassNames: string[] };
  const by = new Map<string, [number, number]>();
  // JSC's snapshot rows: id, size, classNameIndex, flags (four numbers a node).
  for (let i = 0; i < snap.nodes.length; i += 4) {
    const name = snap.nodeClassNames[snap.nodes[i + 2]!]!;
    const row = by.get(name) ?? [0, 0];
    row[0] += snap.nodes[i + 1]!;
    row[1]++;
    by.set(name, row);
  }
  const sizes = new Map<number, number>();
  for (let i = 0; i < snap.nodes.length; i += 4) {
    if (snap.nodeClassNames[snap.nodes[i + 2]!] !== "Cell Butterfly") continue;
    const sz = 2 ** Math.ceil(Math.log2(Math.max(1, snap.nodes[i + 1]!)));
    sizes.set(sz, (sizes.get(sz) ?? 0) + 1);
  }
  console.log(
    "butterflies by size (rounded up to a power of two):",
    JSON.stringify([...sizes].sort((a, b) => a[0] - b[0])),
  );
  for (const [k, [b, n]] of [...by].sort((a, b) => b[1][0] - a[1][0]).slice(0, 20))
    console.log(
      `${k.padEnd(28)} ${(b / USERS / MB).toFixed(3).padStart(7)} MB ${(n / USERS).toFixed(0).padStart(7)} cells a user`,
    );
}
