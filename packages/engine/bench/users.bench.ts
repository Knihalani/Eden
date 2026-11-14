/**
 * Many users in one process (A14): what a synced user costs in memory, what an idle one costs frozen (D325), what a
 * thaw costs, and how long a cold-start storm takes (every user arriving at once).
 *
 * The shipped wiring as `ingest.bench.ts`'s `shipped` mode builds it (a `ContextPartner` on `DEFAULT_CONFIG`, no model,
 * a `SourceMap` file in a temp directory, as the servers keep one), each user with their own in-memory connectors
 * (mail, calendar, docs: the items split three ways, listed newest first, instantly), synced by the partner's own
 * `SyncManager`. Only capacity settings are
 * raised (`syncMaxItems`, users per tenant, calls per minute). The cache's timer is off; the bench runs its ticks.
 *
 * Phases:
 * 1. backfill: every user tracked at once and the sync ticked until every item is held (a cold-start storm with
 *    instant sources: the time is the CPU it takes), the sources' raw items then dropped (as a remote connector's
 *    are); heap (after a full GC) and RSS per user.
 * 2. freeze: enough expiry ticks with no use that every user freezes; heap and RSS per user again.
 * 3. thaw: each user's first read (a cache search) after the freeze, timed: p50, p99, max ms a user.
 * 4. events: one `observe` per user (a fresh session each) on the thawed caches, timed (the fast path, `waitMs` 0).
 *
 * Run: `bun packages/engine/bench/users.bench.ts [users=1000] [itemsPerUser=500] [--world] [--no-freeze] [--waves=K]
 * [--persist] [--sources=N] [--cards] [--config=<EngineConfig JSON>] [--cache=<CacheLimits JSON>]`.
 * `--persist`: frozen users are also written, encrypted, to a temp directory (D425). `--dated`: one day-naming scan
 * a user before the freeze, so the entries hold their date facts (D1721) and the first event after the thaw reads
 * them from the blob (D1888) rather than from every item's text.
 * Before D862 (no warm freeze, a 10-minute tick): `--cache='{"warmIdleMs":0,"expireEveryMs":600000}'`.
 * `--waves=K`: phase 1 brings the users in K waves, earlier ones frozen (unless `--no-freeze`) before the next: its
 * memory line is then a steady state with 1/K of the users active; RSS there is what sizes a machine.
 * `--world` takes item text from the sim world (as `ingest.bench.ts --world`); `--prose` the world's items with the
 * text of docs/ (`prosePieces`). No model, no network.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextItem, Scope } from "@eden/protocol";
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS } from "@eden/llm";
import type { ListPage, Source } from "@eden/sources";
import { ItemCache } from "../src/cache";
import type { EngineConfig } from "../src/config";
import { ContextPartner } from "../src/partner";
import { EncryptedFrozenDisk } from "../src/persist";
import { termIds } from "../src/text";
import { stubCards } from "./stub-cards";
import { buildWorkload } from "./workload";

const PROSE = process.argv.includes("--prose");
const WORLD = PROSE || process.argv.includes("--world");
const NO_FREEZE = process.argv.includes("--no-freeze");
const PERSIST = process.argv.includes("--persist");
/** `--config=<EngineConfig JSON>`: settings over the default (as `storm.bench.ts`), e.g. a switch's off arm. */
const CONFIG = JSON.parse(
  process.argv.find((a) => a.startsWith("--config="))?.slice(9) ?? "{}",
) as Partial<EngineConfig>;
/**
 * `--cache=<CacheLimits JSON>`: cache limits over the bench's own, e.g. `{"warmIdleMs":0,"expireEveryMs":600000}` (the
 * cache before D862).
 */
const CACHE = JSON.parse(process.argv.find((a) => a.startsWith("--cache="))?.slice(8) ?? "{}") as Record<
  string,
  unknown
>;
/**
 * `--warm-waves=J` (D862): users freeze warm after two idle ticks of a minute (`warmIdleMs` 2 min, `expireEveryMs` 1
 * min, the defaults) and compact once idle 2J+1 ticks: with `--waves=K` the steady state then holds the last wave
 * live, the J before it warm and the rest compact (each earlier wave idles two ticks per later wave).
 */
const WARM_WAVES = Number(process.argv.find((a) => a.startsWith("--warm-waves="))?.slice(13) ?? -1);
if (WARM_WAVES >= 0) {
  Object.assign(CACHE, {
    warmIdleMs: 120_000,
    expireEveryMs: 60_000,
    freezeIdleMs: (2 * WARM_WAVES + 1) * 60_000,
    ...CACHE,
  });
}
const WAVES = Number(process.argv.find((a) => a.startsWith("--waves="))?.slice(8) ?? 1);
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const USERS = Number(args[0] ?? 1_000);
const PER_USER = Number(args[1] ?? 500);
/**
 * `--sources=N`: the items split over N connectors instead of three (mail, calendar, docs, then `src3`...), for the
 * per-(user, source) state of a user with many (a heavy user: 20, docs/DEPLOY.md).
 */
const SOURCE_COUNT = Number(process.argv.find((a) => a.startsWith("--sources="))?.slice(10) ?? 3);
const SOURCES = Array.from({ length: SOURCE_COUNT }, (_, i) => ["mail", "calendar", "docs"][i] ?? `src${i}`);
const MB = 1024 * 1024;

/** A connector that lists a fixed set of items newest first, instantly. */
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

/**
 * Memory after a full GC: `heapUsed`, `external` and RSS, each on its own. On Bun 1.4 `heapUsed` already counts typed
 * arrays' and Buffers' stores (JSC's extra memory), and `external` counts them again: their sum, which A14 reported,
 * counts every typed array twice (D372). RSS is what sizes a machine.
 */
const mem = async () => {
  // RSS comes down some seconds after a storm's garbage is collected (the allocator returns pages lazily): read it
  // once it has stopped falling (under 1% a second), at most 20 s on.
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
  return { heap: m.heapUsed, ext: m.external, rss: Math.min(rss, m.rss) };
};

/**
 * `--prose`: every Markdown file under docs/ (sorted by path), cut into 1,100-character pieces, about the sim's
 * length an item (as `segment-screen.bench.ts text --prose`, over more files so 3,000 items do not repeat). One
 * author's prose and tables, not users' mail; but unlike the sim's templated text, items do not repeat each other,
 * which is what decides how much one zstd stream over a user gains over each item's own deflate (D860). The corpus
 * grows with the docs, so compare runs of one tree.
 */
function prosePieces(): string[] {
  const dir = new URL("../../../docs/", import.meta.url).pathname;
  const files = [...new Bun.Glob("**/*.md").scanSync(dir)].sort();
  const joined = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  return Array.from({ length: Math.floor(joined.length / 1_100) }, (_, i) => joined.slice(i * 1_100, (i + 1) * 1_100));
}

async function pool(): Promise<ContextItem[]> {
  if (WORLD) {
    const { buildWorld } = await import("../../sim/src/world");
    const all = buildWorld({ seed: 1, noiseScale: 5 }).items;
    const prose = PROSE ? prosePieces() : [];
    return Array.from({ length: PER_USER }, (_, i) => {
      const it = all[Math.floor((i * all.length) / PER_USER) % all.length]!;
      const text = PROSE ? prose[i % prose.length]! : it.text;
      const item: ContextItem = { id: it.id, sourceId: it.sourceId, ref: it.ref, title: it.title, text };
      return it.meta ? { ...item, meta: it.meta } : item;
    });
  }
  const signal = new AbortController().signal;
  const w = buildWorkload({ itemsPerSource: Math.ceil(PER_USER / 4) + 50, events: 1, seed: 7 });
  const all = (
    await Promise.all(
      w.sources.map((s) =>
        s.search({ scope: w.scope, text: "", entities: w.people.slice(0, 300), limit: 10_000 }, signal),
      ),
    )
  ).flat();
  return Array.from({ length: PER_USER }, (_, i) => all[i % all.length]!);
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};

const base = await pool();
const avgChars = Math.round(base.reduce((s, i) => s + i.text.length, 0) / base.length);
let clock = Date.UTC(2026, 10, 3, 9);
const T0 = clock;
const now = () => clock;
// Before any user: the baseline every per-user figure is taken from (as ingest.bench's "released").
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

const cache = new ItemCache({ maxUsersPerTenant: USERS + 1, maxSyncedPerUser: Math.max(5_000, PER_USER), ...CACHE });
cache.close(); // The bench runs the expiry ticks itself.
// `--persist`: frozen users are also written to a temp directory, encrypted (D425).
if (PERSIST) {
  const disk = new EncryptedFrozenDisk({
    dir: mkdtempSync(join(tmpdir(), "eden-users-frozen-")),
    key: new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff),
    maxBytes: 64 * 1024 ** 3,
    maxAgeMs: 7 * 24 * 3_600_000,
  });
  cache.persist(disk);
}
/** `--cards`: a $0 stub card maker (`stub-cards.ts`): the card and intent state of a user with a model key (D998). */
const enricher = process.argv.includes("--cards") ? stubCards(now) : undefined;
const partner = new ContextPartner({
  ...(enricher ? { cards: enricher } : {}),
  sources: async (scope) => byUser.get(scope.userId)!,
  // A file, as the servers open (in memory its pages would count in RSS as user state; a file's page cache is bounded).
  sourceMap: new SourceMap(join(mkdtempSync(join(tmpdir(), "eden-users-")), "source-map.db")),
  cache,
  budget: new Budget(DEFAULT_LIMITS),
  model: null,
  now,
  config: { ...CONFIG, syncMaxItems: PER_USER, syncMaxUsersPerTenant: USERS + 1, syncCallsPerMin: 1e7 },
});
const sync = partner.sync!;
const synced = () => users.reduce((s, { scope }) => s + cache.syncedCount(scope), 0);
const n = USERS * PER_USER;

// 1. Backfill: every user at once, or (`--waves=K`) K waves one after another, each earlier wave left idle (and,
// with freezing, frozen by two expiry ticks) before the next arrives: a steady state where 1/K of the users are active.
const cpu0 = process.cpuUsage();
const t0 = performance.now();
for (let w = 0; w < WAVES; w++) {
  // Every earlier wave frozen before the next arrives: as many expiry ticks as the idle bound takes (three at the
  // defaults). Two were run here until O2 (D651), which left the wave before the last live: "1/K active" was 2/K.
  const before = Math.floor((w * USERS) / WAVES);
  if (w > 0 && !NO_FREEZE) {
    for (let t = 0; t < 8 && cache.frozenCount < before; t++) cache.expireIdle(clock);
    if (cache.frozenCount !== before) throw new Error(`froze ${cache.frozenCount} of ${before} before wave ${w}`);
  }
  const wave = users.slice(before, Math.floor(((w + 1) * USERS) / WAVES));
  for (const { scope } of wave) sync.track(scope, clock);
  const target = Math.floor(((w + 1) * USERS) / WAVES) * PER_USER;
  for (let i = 0; synced() < target; i++) {
    if (i > 100_000) throw new Error(`the sync stopped at ${synced()} of ${target}`);
    clock += 1_000; // The sync's per-source budget refills on the clock (a burst of a few pages, then 1e7 a minute).
    await sync.tick();
  }
}
if (enricher) await enricher.idle();
const stormMs = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
for (const { sources } of users) for (const s of sources) s.items = [];
const frozenAtSteady = cache.frozenCount;
const warmAtSteady = cache.warmCount;
const m2 = await mem();
type Mem = { heap: number; ext: number; rss: number };
const perUser = (a: Mem, b: Mem) => ({
  heapMB: (a.heap - b.heap) / USERS / MB,
  extMB: (a.ext - b.ext) / USERS / MB,
  rssMB: (a.rss - b.rss) / USERS / MB,
});
const live = perUser(m2, m0);

// `--dated`: one day-naming scan a user before the freeze (`ItemCache.dated`), so every entry holds its date facts
// (D1721) as a user's do once they asked about a day: what a freeze carries to the thaw since D1888.
if (process.argv.includes("--dated")) {
  for (const { scope } of users) cache.dated(scope, new Set(["2026-11-05"]), () => false, clock, 3, 0);
}

// 2. Freeze: ticks with no use.
let frozen = { heapMB: Number.NaN, extMB: Number.NaN, rssMB: Number.NaN };
let freezeMs = 0;
let blobBytes = 0;
if (!NO_FREEZE) {
  const f0 = performance.now();
  for (let t = 0; t < 4 && cache.frozenCount < USERS; t++) cache.expireIdle(clock);
  freezeMs = performance.now() - f0;
  if (cache.frozenCount !== USERS) throw new Error(`froze ${cache.frozenCount} of ${USERS}`);
  frozen = perUser(await mem(), m0);
  blobBytes = cache.frozenBytes;
}

// 3. Thaw: each user's first read.
const thaws: number[] = [];
for (const { scope } of users) {
  const a = performance.now();
  const vocab = cache.peekVocab(scope)!;
  const q = termIds("budget review", vocab, false);
  cache.search(scope, q.ids, q.n, 10, clock);
  thaws.push(performance.now() - a);
}
const m4 = await mem();

/** Event-loop lag while `work` runs: a 1 ms timer chain, each delay past 1 ms recorded. */
async function lagDuring(work: () => Promise<void>): Promise<{ ms: number; lagMax: number; lagP99: number }> {
  const lags: number[] = [];
  let on = true;
  let last = performance.now();
  const probe = () => {
    const t = performance.now();
    lags.push(t - last - 1);
    last = t;
    if (on) setTimeout(probe, 1);
  };
  setTimeout(probe, 1);
  const a = performance.now();
  await work();
  const ms = performance.now() - a;
  on = false;
  return { ms, lagMax: Math.max(0, ...lags), lagP99: pct(lags, 0.99) };
}

// 3b. Sliced: every user frozen again by the timer's sliced path, then all returning at once (`ready`, as the
// partner's entry points await it), with the event loop's lag measured throughout.
let sliced: { freeze: Awaited<ReturnType<typeof lagDuring>>; thaw: Awaited<ReturnType<typeof lagDuring>> } | null =
  null;
if (!NO_FREEZE) {
  const freeze = await lagDuring(async () => {
    for (let t = 0; t < 4 && cache.frozenCount < USERS; t++) {
      cache.expireIdle(clock, true);
      while (cache.slicedPending > 0) await new Promise((r) => setTimeout(r, 2));
    }
  });
  if (cache.frozenCount !== USERS) throw new Error(`sliced: froze ${cache.frozenCount} of ${USERS}`);
  const thaw = await lagDuring(async () => {
    await Promise.all(users.map(({ scope }) => cache.ready(scope)));
  });
  if (cache.frozenCount !== 0) throw new Error(`sliced: ${cache.frozenCount} still frozen`);
  sliced = { freeze, thaw };
}

// 4. One event per user, a fresh session each.
clock += 60_000;
const events: number[] = [];
for (const { scope } of users) {
  const a = performance.now();
  await partner.observe(
    {
      ...scope,
      sessionId: `s-${scope.userId}`,
      kind: "user_message",
      text: "Can you check the budget review with the board before Friday?",
      at: clock,
    },
    { waitMs: 0 },
  );
  events.push(performance.now() - a);
}

const f = (x: number, d = 2) => x.toFixed(d);
console.log(
  `${USERS} users x ${PER_USER} synced items over ${SOURCES.length} sources (${PROSE ? "docs prose" : WORLD ? "sim world" : "workload"} text, ` +
    `avg ${avgChars} chars), shipped wiring, no model`,
);
console.log(
  `backfill storm: ${f(stormMs / 1000, 1)} s wall, ${f((cpu.user + cpu.system) / 1e6, 1)} s CPU, ` +
    `${f((cpu.user + cpu.system) / n, 1)} µs CPU/item, ${f(USERS / (stormMs / 1000), 1)} users/s`,
);
console.log(
  `${WAVES > 1 ? `after ${WAVES} waves (${NO_FREEZE ? "none frozen" : `${frozenAtSteady} of ${USERS} users frozen, ${warmAtSteady} warm`})` : "synced, live"}: ` +
    `${f(live.heapMB)} MB heapUsed/user (${f((live.heapMB * MB) / PER_USER, 0)} B/item), ` +
    `${f(live.extMB)} MB external/user (counted in heapUsed too), ${f(live.rssMB)} MB RSS/user`,
);
if (!NO_FREEZE) {
  console.log(
    `frozen: ${f(frozen.heapMB)} MB heapUsed/user (${f((frozen.heapMB * MB) / PER_USER, 0)} B/item), ` +
      `${f(frozen.extMB)} MB external/user, ${f(frozen.rssMB)} MB RSS/user; ${f(live.heapMB / frozen.heapMB)}x smaller heap; ` +
      `freeze ${f(freezeMs / USERS, 2)} ms/user; blobs ${f(blobBytes / n, 0)} B/item, the rest ` +
      `${f((frozen.heapMB * MB - blobBytes / USERS) / 1024, 1)} KB/user`,
  );
}
console.log(
  `first read after freeze: p50 ${f(pct(thaws, 0.5))} ms, p99 ${f(pct(thaws, 0.99))} ms, max ${f(Math.max(...thaws))} ms` +
    ` (${f((pct(thaws, 0.5) * 1000) / PER_USER, 1)} µs/item at p50); heap after thaw ${f(perUser(m4, m0).heapMB)} MB/user, RSS ${f(perUser(m4, m0).rssMB)} MB/user`,
);
if (sliced) {
  console.log(
    `sliced freeze of all: ${f(sliced.freeze.ms / 1000, 1)} s, loop lag max ${f(sliced.freeze.lagMax, 1)} ms, ` +
      `p99 ${f(sliced.freeze.lagP99, 1)} ms; sliced thaw of all at once: ${f(sliced.thaw.ms / 1000, 1)} s, ` +
      `lag max ${f(sliced.thaw.lagMax, 1)} ms, p99 ${f(sliced.thaw.lagP99, 1)} ms`,
  );
}
console.log(`first event per user (fast path): p50 ${f(pct(events, 0.5))} ms, p99 ${f(pct(events, 0.99))} ms`);
console.log(
  JSON.stringify({
    users: USERS,
    waves: WAVES,
    perUser: PER_USER,
    world: WORLD,
    prose: PROSE,
    warmWaves: WARM_WAVES,
    frozenAtSteady,
    warmAtSteady,
    stormS: stormMs / 1000,
    cpuUsPerItem: (cpu.user + cpu.system) / n,
    live,
    frozen,
    thawP50: pct(thaws, 0.5),
    thawP99: pct(thaws, 0.99),
    eventP50: pct(events, 0.5),
    eventP99: pct(events, 0.99),
    sliced,
    baseRssMB: m0.rss / MB,
  }),
);
process.exit(0);
