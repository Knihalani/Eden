/**
 * Many users in one process (A14): what a synced user costs in memory, what an idle one costs frozen (D325), what a
 * thaw costs, and how long a cold-start storm takes (every user arriving at once).
 *
 * The shipped wiring as `ingest.bench.ts`'s `shipped` mode builds it (a `ContextPartner` on `DEFAULT_CONFIG`, no model,
 * a `SourceMap` file in a temp directory, as the servers keep one), each user with their own in-memory connectors (mail, calendar, docs: the items split
 * three ways, listed newest first, instantly), synced by the partner's own `SyncManager`. Only capacity settings are
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
 * Run: `bun packages/engine/bench/users.bench.ts [users=1000] [itemsPerUser=500] [--world] [--no-freeze] [--waves=K]`.
 * `--waves=K`: phase 1 brings the users in K waves, earlier ones frozen (unless `--no-freeze`) before the next: its
 * memory line is then a steady state with 1/K of the users active; RSS there is what sizes a machine.
 * `--world` takes item text from the sim world (as `ingest.bench.ts --world`). No model, no network.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextItem, Scope } from "@eden/protocol";
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS } from "@eden/llm";
import type { ListPage, Source } from "@eden/sources";
import { ItemCache } from "../src/cache";
import { ContextPartner } from "../src/partner";
import { termIds } from "../src/text";
import { buildWorkload } from "./workload";

const WORLD = process.argv.includes("--world");
const NO_FREEZE = process.argv.includes("--no-freeze");
const WAVES = Number(process.argv.find((a) => a.startsWith("--waves="))?.slice(8) ?? 1);
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const USERS = Number(args[0] ?? 1_000);
const PER_USER = Number(args[1] ?? 500);
const SOURCES = ["mail", "calendar", "docs"] as const;
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
 * Memory after a full GC: the JS heap plus what it holds outside itself (`external`: typed arrays' stores, which are
 * most of an index and every packed text, and which `heapUsed` leaves out), and RSS.
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
  return { heap: m.heapUsed + m.external, rss: Math.min(rss, m.rss) };
};

async function pool(): Promise<ContextItem[]> {
  if (WORLD) {
    const { buildWorld } = await import("../../sim/src/world");
    const all = buildWorld({ seed: 1, noiseScale: 5 }).items;
    return Array.from({ length: PER_USER }, (_, i) => {
      const it = all[Math.floor((i * all.length) / PER_USER) % all.length]!;
      const item: ContextItem = { id: it.id, sourceId: it.sourceId, ref: it.ref, title: it.title, text: it.text };
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
const m0 = await mem(); // Before any user: the baseline every per-user figure is taken from (as ingest.bench's "released").

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
cache.close(); // The bench runs the expiry ticks itself.
const partner = new ContextPartner({
  sources: async (scope) => byUser.get(scope.userId)!,
  // A file, as the servers open (in memory, its pages would count in RSS as user state; a file's page cache is bounded).
  sourceMap: new SourceMap(join(mkdtempSync(join(tmpdir(), "eden-users-")), "source-map.db")),
  cache,
  budget: new Budget(DEFAULT_LIMITS),
  model: null,
  now,
  config: { syncMaxItems: PER_USER, syncMaxUsersPerTenant: USERS + 1, syncCallsPerMin: 1e7 },
});
const sync = partner.sync!;
const synced = () => users.reduce((s, { scope }) => s + cache.syncedCount(scope), 0);
const n = USERS * PER_USER;

// 1. Backfill: every user at once, or (`--waves=K`) K waves one after another, each earlier wave left idle (and,
// with freezing, frozen by two expiry ticks) before the next arrives: a steady state where 1/K of the users are active.
const cpu0 = process.cpuUsage();
const t0 = performance.now();
for (let w = 0; w < WAVES; w++) {
  if (w > 0 && !NO_FREEZE) for (let t = 0; t < 2; t++) cache.expireIdle(clock);
  const wave = users.slice(Math.floor((w * USERS) / WAVES), Math.floor(((w + 1) * USERS) / WAVES));
  for (const { scope } of wave) sync.track(scope, clock);
  const target = Math.floor(((w + 1) * USERS) / WAVES) * PER_USER;
  for (let i = 0; synced() < target; i++) {
    if (i > 100_000) throw new Error(`the sync stopped at ${synced()} of ${target}`);
    clock += 1_000; // The sync's per-source budget refills on the clock (a burst of a few pages, then 1e7 a minute).
    await sync.tick();
  }
}
const stormMs = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
for (const { sources } of users) for (const s of sources) s.items = [];
const m2 = await mem();
type Mem = { heap: number; rss: number };
const perUser = (a: Mem, b: Mem) => ({
  heapMB: (a.heap - b.heap) / USERS / MB,
  rssMB: (a.rss - b.rss) / USERS / MB,
});
const live = perUser(m2, m0);

// 2. Freeze: ticks with no use.
let frozen = { heapMB: Number.NaN, rssMB: Number.NaN };
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
  `${USERS} users x ${PER_USER} synced items over ${SOURCES.length} sources (${WORLD ? "sim world" : "workload"} text, ` +
    `avg ${avgChars} chars), shipped wiring, no model`,
);
console.log(
  `backfill storm: ${f(stormMs / 1000, 1)} s wall, ${f((cpu.user + cpu.system) / 1e6, 1)} s CPU, ` +
    `${f((cpu.user + cpu.system) / n, 1)} µs CPU/item, ${f(USERS / (stormMs / 1000), 1)} users/s`,
);
console.log(
  `${WAVES > 1 ? `after ${WAVES} waves (${NO_FREEZE ? "none frozen" : "earlier waves frozen"})` : "synced, live"}: ` +
    `${f(live.heapMB)} MB heap/user (${f((live.heapMB * MB) / PER_USER, 0)} B/item), ` +
    `${f(live.rssMB)} MB RSS/user`,
);
if (!NO_FREEZE) {
  console.log(
    `frozen: ${f(frozen.heapMB)} MB heap/user (${f((frozen.heapMB * MB) / PER_USER, 0)} B/item), ` +
      `${f(frozen.rssMB)} MB RSS/user; ${f(live.heapMB / frozen.heapMB)}x smaller heap; ` +
      `freeze ${f(freezeMs / USERS, 2)} ms/user; blobs ${f(blobBytes / n, 0)} B/item, the rest ` +
      `${f((frozen.heapMB * MB - blobBytes / USERS) / 1024, 1)} KB/user`,
  );
}
console.log(
  `first read after freeze: p50 ${f(pct(thaws, 0.5))} ms, p99 ${f(pct(thaws, 0.99))} ms, max ${f(Math.max(...thaws))} ms` +
    ` (${f((pct(thaws, 0.5) * 1000) / PER_USER, 1)} µs/item at p50); heap after thaw ${f(perUser(m4, m0).heapMB)} MB/user`,
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
