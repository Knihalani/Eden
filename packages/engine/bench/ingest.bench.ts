/**
 * The background sync's ingest at scale (D57): memory held per synced user, and CPU per item on the two listings a
 * synced user costs — the backfill (every item new: redacted, tokenized, indexed) and a sweep that re-lists the whole
 * source unchanged (what every sweep and most of every poll is). An anchor for scale work: a change to the cache, the
 * index, redaction or the sync reports these numbers before and after.
 *
 * Each user gets their own copy of the workload's items (text tagged per user, so no string is shared between users and
 * the memory is each user's own), listed newest first by an instant in-memory connector, through the real path:
 * `SyncManager` → `SourceFanout.list` (redaction hook: `sanitizeItem`, as without a gate pool) → `ItemCache.put`.
 * Memory is the heap after a full GC, after the backfill minus before it (the sources' raw items are held throughout).
 *
 * Run: `bun packages/engine/bench/ingest.bench.ts [users=200] [itemsPerUser=500]`. No model, no network.
 */
import type { ContextItem, Scope } from "@eden/protocol";
import { SourceFanout, type ListPage, type Source } from "@eden/sources";
import { ItemCache, sanitizeItem } from "../src/cache";
import { SyncManager, type SyncOptions } from "../src/sync";
import { buildWorkload } from "./workload";

const USERS = Number(process.argv[2] ?? 200);
const PER_USER = Number(process.argv[3] ?? 500);
const PAGE = 100;
const HOUR = 3_600_000;

/** A connector that lists a fixed set of items newest first, instantly. */
class ListSource implements Source {
  readonly kind = "bench";
  readonly description = "bench";
  constructor(
    readonly id: string,
    readonly items: ContextItem[],
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

const w = buildWorkload({ itemsPerSource: Math.ceil(PER_USER / 4) + 50, events: 1, seed: 7 });
const pool = (
  await Promise.all(
    w.sources.map((s) => s.search({ scope: w.scope, text: "", entities: w.people.slice(0, 300), limit: 10_000 })),
  )
).flat();
if (pool.length < PER_USER) throw new Error(`the workload has ${pool.length} items, fewer than ${PER_USER}`);
const avg = Math.round(pool.slice(0, PER_USER).reduce((s, i) => s + i.text.length, 0) / PER_USER);

let clock = Date.UTC(2026, 10, 3, 9);
const T0 = clock;
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

const cache = new ItemCache({ maxSyncedPerUser: PER_USER, maxUsersPerTenant: USERS + 1, expireEveryMs: 0 });
const maxText = cache.maxTextChars;
const now = () => clock;
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
  pushSweepMs: 24 * HOUR,
  pushGapMs: 0,
};
const sync = new SyncManager({ sources: async (scope) => [byUser.get(scope.userId)!], fanout, cache, now }, options);

const heap = () => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
};

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

const before = heap();
for (const { scope } of users) sync.track(scope, clock);
const backfillMs = await listAll(USERS * PER_USER);
const after = heap();
let held = 0;
for (const { scope } of users) held += cache.syncedCount(scope);
if (held !== USERS * PER_USER) throw new Error(`synced ${held} items, expected ${USERS * PER_USER}`);

// A sweep per user: the whole listing again, nothing changed.
clock += HOUR + 1;
for (const { scope } of users) sync.track(scope, clock);
const sweepMs = await listAll(USERS * PER_USER);

const n = USERS * PER_USER;
const perUser = (after - before) / USERS;
console.log(`${USERS} users × ${PER_USER} synced items (avg text ${avg} chars), pages of ${PAGE}`);
console.log(`memory per user        ${(perUser / 1024).toFixed(0)} KB (${(perUser / PER_USER).toFixed(0)} B/item)`);
console.log(`backfill (new)         ${((backfillMs * 1000) / n).toFixed(1)} µs/item  (${backfillMs.toFixed(0)} ms)`);
console.log(`sweep (unchanged)      ${((sweepMs * 1000) / n).toFixed(1)} µs/item  (${sweepMs.toFixed(0)} ms)`);
