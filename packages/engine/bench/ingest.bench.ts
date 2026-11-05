/**
 * The background sync's ingest at scale (D57): memory held per synced user, and CPU per item on the two listings a
 * synced user costs — the backfill (every item new: redacted, tokenized, indexed) and a sweep that re-lists the whole
 * source unchanged (what every sweep and most of every poll is). An anchor for scale work: a change to the cache, the
 * index, the graph, redaction or the sync reports these numbers before and after.
 *
 * Each user gets their own copy of the workload's items (text tagged per user, so no string is shared between users and
 * the memory is each user's own), listed newest first by an instant in-memory connector. Three modes, each run in its
 * own process so one's heap never shows in another's:
 * - `core`: the line this bench printed before (comparable with earlier reports): `SyncManager` → `SourceFanout.list`
 *   (redaction hook: `sanitizeItem`, as without a gate pool) → `ItemCache.put`, with no graph and no `onStored` hook.
 * - `graph`: `core` with the cache's knowledge graph on (`ItemCache.enableGraph`, what `config.graph` does).
 * - `shipped`: what the servers run on this path (D112): a `ContextPartner` with `DEFAULT_CONFIG` and no model deps
 *   (graph on; `onStored` records each item's mentions in an in-memory `SourceMap`; no card maker, so cards queue
 *   nothing), with its own sync and fan-out. Only capacity settings are raised for the bench (`syncMaxItems`, users
 *   per tenant, calls per minute); the sweep comes after the default's `syncSweepMs`, so its due polls run too.
 * Per stage: the difference between modes, the graph's add (`graph` − `core`) and the partner's `onStored` work,
 * mostly mentions (`shipped` − `graph`).
 *
 * Memory is the heap after a full GC. "raw held" is after the backfill minus before it, with the sources' raw items
 * held throughout (the number earlier reports quote). "raw released" is after the sweep with every source's raw items
 * dropped, minus the heap before the users were built: the text the cache keeps is counted. The source map's SQLite
 * pages live outside the JS heap and are not counted.
 *
 * Run: `bun packages/engine/bench/ingest.bench.ts [users=200] [itemsPerUser=500] [mode=all|core|graph|shipped]`.
 * No model, no network.
 */
import type { ContextItem, Scope } from "@eden/protocol";
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS } from "@eden/llm";
import { SourceFanout, type ListPage, type Source } from "@eden/sources";
import { ItemCache, sanitizeItem } from "../src/cache";
import { DEFAULT_CONFIG } from "../src/config";
import { ContextPartner } from "../src/partner";
import { SyncManager, type SyncOptions } from "../src/sync";
import { buildWorkload } from "./workload";

const USERS = Number(process.argv[2] ?? 200);
const PER_USER = Number(process.argv[3] ?? 500);
const MODE = process.argv[4] ?? "all";
const MODES = ["core", "graph", "shipped"] as const;
type Mode = (typeof MODES)[number];
const PAGE = 100;
const HOUR = 3_600_000;

interface Result {
  mode: string;
  avgChars: number;
  backfillUs: number;
  sweepUs: number;
  heldB: number;
  releasedB: number;
  backfillMs: number;
  sweepMs: number;
}

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

const heap = () => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
};

async function run(mode: Mode): Promise<Result> {
  const signal = new AbortController().signal;
  const w = buildWorkload({ itemsPerSource: Math.ceil(PER_USER / 4) + 50, events: 1, seed: 7 });
  const pool = (
    await Promise.all(
      w.sources.map((s) =>
        s.search({ scope: w.scope, text: "", entities: w.people.slice(0, 300), limit: 10_000 }, signal),
      ),
    )
  ).flat();
  if (pool.length < PER_USER) throw new Error(`the workload has ${pool.length} items, fewer than ${PER_USER}`);
  const avgChars = Math.round(pool.slice(0, PER_USER).reduce((s, i) => s + i.text.length, 0) / PER_USER);

  let clock = Date.UTC(2026, 10, 3, 9);
  const T0 = clock;
  const now = () => clock;
  const base = heap();
  const users: { scope: Scope; source: ListSource }[] = [];
  for (let u = 0; u < USERS; u++) {
    const items = pool.slice(0, PER_USER).map((it, i) => ({
      ...it,
      id: `mail:u${u}-${i}`,
      sourceId: "mail",
      ref: `u${u}-${i}`,
      text: `${it.text} (u${u})`,
      updatedAt: T0 - i * 60_000,
    }));
    users.push({ scope: { tenantId: "bench", userId: `u${u}` }, source: new ListSource("mail", items) });
  }
  const byUser = new Map(users.map((x) => [x.scope.userId, x.source]));
  const sources = async (scope: Scope) => [byUser.get(scope.userId)!];

  const cache = new ItemCache({ maxSyncedPerUser: PER_USER, maxUsersPerTenant: USERS + 1, expireEveryMs: 0 });
  let sync: SyncManager;
  let sweepAfter: number;
  if (mode === "shipped") {
    const partner = new ContextPartner({
      sources,
      sourceMap: new SourceMap(),
      cache,
      budget: new Budget(DEFAULT_LIMITS),
      model: null,
      now,
      config: { syncMaxItems: PER_USER, syncMaxUsersPerTenant: USERS + 1, syncCallsPerMin: 1e7 },
    });
    if (!partner.sync) throw new Error("the default has no sync");
    sync = partner.sync;
    sweepAfter = DEFAULT_CONFIG.syncSweepMs;
  } else {
    if (mode === "graph") cache.enableGraph();
    const maxText = cache.maxTextChars;
    const fanout = new SourceFanout({
      sanitize: (items) => items.map((i) => sanitizeItem(i, maxText)),
      ratePerSec: 1e6,
      burst: 1e6,
      now,
    });
    const options: SyncOptions = {
      maxItems: PER_USER,
      pageSize: PAGE,
      staleChance: 0.5,
      maxStaleMs: 24 * HOUR,
      activeMs: 24 * HOUR,
      sweepMs: HOUR,
      dropMs: 30 * 24 * HOUR,
      callsPerMin: 1e7,
      catchupPages: 1,
      maxUsersPerTenant: USERS + 1,
      timeoutMs: 60_000,
      push: false,
      pushMaxStaleMs: 24 * HOUR,
    };
    sync = new SyncManager({ sources, fanout, cache, now }, options);
    sweepAfter = HOUR;
  }

  /** Ticks until the sync has listed `items` more items in the background; returns the wall time (ms). */
  async function listAll(items: number): Promise<number> {
    const target = sync.stats.backgroundItems + items;
    const t0 = performance.now();
    for (let i = 0; sync.stats.backgroundItems < target; i++) {
      if (i > 10_000) throw new Error("the sync stopped listing");
      await sync.tick();
    }
    return performance.now() - t0;
  }

  const n = USERS * PER_USER;
  const synced = () => users.reduce((s, { scope }) => s + cache.syncedCount(scope), 0);
  const before = heap();
  for (const { scope } of users) sync.track(scope, clock);
  const backfillMs = await listAll(n);
  const after = heap();
  if (synced() !== n) throw new Error(`synced ${synced()} items, expected ${n}`);

  // A sweep per user: the whole listing again, nothing changed.
  clock += sweepAfter + 1;
  for (const { scope } of users) sync.track(scope, clock);
  const sweepMs = await listAll(n);

  // The sources' raw items dropped: what is left is the cache's own (its copies of the text included).
  for (const { source } of users) source.items = [];
  const released = heap();
  if (synced() !== n) throw new Error(`synced ${synced()} items after the sweep, expected ${n}`);

  return {
    mode,
    avgChars,
    backfillUs: (backfillMs * 1000) / n,
    sweepUs: (sweepMs * 1000) / n,
    heldB: (after - before) / n,
    releasedB: (released - base) / n,
    backfillMs,
    sweepMs,
  };
}

const line = (label: string, r: Result) =>
  `${label.padEnd(10)}${r.backfillUs.toFixed(1).padStart(7)} µs/item${r.sweepUs.toFixed(1).padStart(8)} µs/item` +
  `${r.heldB.toFixed(0).padStart(8)} B/item${r.releasedB.toFixed(0).padStart(8)} B/item` +
  `   (${r.backfillMs.toFixed(0)} + ${r.sweepMs.toFixed(0)} ms)`;

const minus = (a: Result, b: Result, label: string): Result => ({
  mode: label,
  avgChars: a.avgChars,
  backfillUs: a.backfillUs - b.backfillUs,
  sweepUs: a.sweepUs - b.sweepUs,
  heldB: a.heldB - b.heldB,
  releasedB: a.releasedB - b.releasedB,
  backfillMs: a.backfillMs - b.backfillMs,
  sweepMs: a.sweepMs - b.sweepMs,
});

if (MODE !== "all") {
  if (!(MODES as readonly string[]).includes(MODE)) throw new Error(`mode ${MODE}: one of all, ${MODES.join(", ")}`);
  // One mode in its own process (a child of the "all" run): its result as JSON on the last line of stdout.
  console.log(JSON.stringify(await run(MODE as Mode)));
} else {
  const results: Result[] = [];
  for (const mode of MODES) {
    const child = Bun.spawnSync([process.execPath, import.meta.path, String(USERS), String(PER_USER), mode], {
      stderr: "inherit",
    });
    if (child.exitCode !== 0) throw new Error(`mode ${mode} failed (exit ${child.exitCode})`);
    results.push(JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!) as Result);
  }
  const [core, graph, shipped] = results as [Result, Result, Result];
  console.log(`${USERS} users × ${PER_USER} synced items (avg text ${core.avgChars} chars), pages of ${PAGE}`);
  console.log(`mode      backfill (new)  sweep (unchanged)  memory: raw held  raw released`);
  for (const r of results) console.log(line(r.mode, r));
  console.log(`per stage (the difference between modes):`);
  console.log(line("+graph", minus(graph, core, "+graph")));
  console.log(line("+onStored", minus(shipped, graph, "+onStored")));
  const ratio = (a: number, b: number) => (a / b).toFixed(2);
  console.log(
    `shipped / core: backfill ${ratio(shipped.backfillUs, core.backfillUs)}x, memory ` +
      `${ratio(shipped.heldB, core.heldB)}x raw held, ${ratio(shipped.releasedB, core.releasedB)}x released`,
  );
}
