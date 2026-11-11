/**
 * A restart with and without persisted frozen users (D425, docs/research/c3-persist-frozen.md). What it measures:
 * after a process restart, how long until every returning user is synced again, the CPU it takes, and the listing
 * calls their connectors receive; with persistence, also what the freeze wrote and what reading it back cost.
 *
 * The shipped wiring (a `ContextPartner` on `DEFAULT_CONFIG`, no model, one `SourceMap` file kept across the restart,
 * as a server keeps it), on the wall clock. Each user has three in-memory connectors (mail, calendar, docs) answering
 * a listing after 20-80 ms (`--latency=0` for instant), items the bench workload's text, as `storm.bench.ts`.
 *
 * 1. Before: every user synced (the backfill), then frozen to an `EncryptedFrozenDisk` in a temp directory.
 * 2. Restart without (D8, the default): a new process state (cache, partner); every user returns at once (one
 *    `user_message` each) and the sync runs until every user holds their items again.
 * 3. Restart with (D425): the same over a new cache that persists to the directory written in 1.
 *
 * Both restarts start from the same moment (`--downtime` minutes after the freeze, default 5): the restored copies
 * are polled as the sync's learned chance says they are stale. No model, no network.
 *
 * Run: `bun packages/engine/bench/restart.bench.ts [users=200] [itemsPerUser=1000] [--latency=1] [--downtime=5]
 * [--warm]`. `--warm`: users are frozen, written and read back in the warm form (D862).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS } from "@eden/llm";
import type { AgentEvent, ContextItem, Scope } from "@eden/protocol";
import type { ListPage, Source } from "@eden/sources";
import { ItemCache } from "../src/cache";
import { ContextPartner } from "../src/partner";
import { EncryptedFrozenDisk } from "../src/persist";
import { buildWorkload, rng } from "./workload";

const opt = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const USERS = Number(args[0] ?? 200);
const PER_USER = Number(args[1] ?? 1_000);
const LATENCY = opt("latency") !== "0";
const DOWNTIME_MS = Number(opt("downtime") ?? 5) * 60_000;
/** `--warm` (D862): every freeze is warm (`warmIdleMs`), so what is written, and read back, is the warm blob. */
const WARM = process.argv.includes("--warm");
const SOURCES = ["mail", "calendar", "docs"] as const;
const random = rng(11);

/** Listing calls and items listed, across every connector. */
const calls = { lists: 0, listed: 0 };

class SlowListSource implements Source {
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
    calls.lists++;
    if (LATENCY) await Bun.sleep(20 + random() * 60);
    const at = cursor ? Number(cursor) : 0;
    const items = this.items.slice(at, at + limit);
    calls.listed += items.length;
    return { items, next: at + limit < this.items.length ? String(at + limit) : null };
  }
}

const signal = new AbortController().signal;
const w = buildWorkload({ itemsPerSource: Math.ceil(PER_USER / 4) + 50, events: 1, seed: 7 });
const pool = (
  await Promise.all(
    w.sources.map((s) =>
      s.search({ scope: w.scope, text: "", entities: w.people.slice(0, 300), limit: 10_000 }, signal),
    ),
  )
).flat();
const T0 = Date.now();
const users = Array.from({ length: USERS }, (_, i) => `u${i}`);
const scope = (u: string): Scope => ({ tenantId: "bench", userId: u });
const byUser = new Map<string, Source[]>();
for (const u of users) {
  const per = SOURCES.map(() => [] as ContextItem[]);
  for (let i = 0; i < PER_USER; i++) {
    const it = pool[i % pool.length]!;
    const k = i % SOURCES.length;
    per[k]!.push({
      ...it,
      id: `${SOURCES[k]}:${u}-${i}`,
      sourceId: SOURCES[k]!,
      ref: `${u}-${i}`,
      text: `${it.text} (${u})`,
      updatedAt: T0 - i * 60_000,
    });
  }
  byUser.set(
    u,
    SOURCES.map((id, k) => new SlowListSource(id, per[k]!)),
  );
}

const dir = mkdtempSync(join(tmpdir(), "eden-restart-"));
const sourceMap = new SourceMap(join(dir, "source-map.db"));
const key = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
let clock = T0;
const disk = () =>
  new EncryptedFrozenDisk({
    dir: join(dir, "frozen"),
    key,
    maxBytes: 64 * 1024 ** 3,
    maxAgeMs: 7 * 24 * 3_600_000,
  });

function processState(persist: EncryptedFrozenDisk | null) {
  const freeze = WARM ? { warmIdleMs: 1, freezeIdleMs: 1_000_000 } : { freezeIdleMs: 1 };
  const cache = new ItemCache({ maxUsersPerTenant: USERS + 1, expireEveryMs: 1, ...freeze });
  cache.close(); // The bench runs its ticks.
  if (persist) cache.persist(persist);
  const partner = new ContextPartner({
    sources: async (s) => byUser.get(s.userId)!,
    sourceMap,
    cache,
    budget: new Budget(DEFAULT_LIMITS),
    model: null,
    now: () => clock,
    config: { syncMaxUsersPerTenant: USERS + 1, syncCallsPerMin: 1e7 },
  });
  return { cache, partner };
}

const held = (c: ItemCache) => users.reduce((n, u) => n + c.syncedCount(scope(u)), 0);
const allWarm = (p: ContextPartner) => users.every((u) => p.sync!.warm(scope(u)));
/** Synced items held once every user's backfill is done (the sync's cap may hold fewer than the sources list). */
let target = 0;
/** The partner's clock when every user froze. */
let frozenAt = T0;

// 1. Before the restart: every user synced, then frozen to disk.
{
  const store = disk();
  const { cache, partner } = processState(store);
  for (const u of users) partner.sync!.track(scope(u), clock);
  for (let i = 0; !allWarm(partner); i++) {
    if (i > 100_000) throw new Error("the backfill stopped");
    await partner.sync!.tick();
    clock += 1_000; // The fan-out's rate limits refill on the partner's clock.
  }
  target = held(cache);
  const t = performance.now();
  for (let i = 0; i < 3; i++) cache.expireIdle(clock);
  const freezeMs = performance.now() - t;
  frozenAt = clock;
  console.log(
    `before: ${USERS} users x ${PER_USER} items listed, ${target} synced and frozen; on disk ${store.count} blobs, ` +
      `${(store.size / 1_048_576).toFixed(1)} MB (${Math.round(store.size / target)} B an item); ` +
      `freeze + write ${freezeMs.toFixed(0)} ms for all, of which the writes (encrypt, write, rename) ` +
      `${store.stats.writeMs.toFixed(0)} ms (${(store.stats.writeMs / Math.max(1, store.stats.written)).toFixed(2)} ms a user)`,
  );
  partner.stopSync();
}

/** Every user returns at once; the sync runs until every user holds their items and nothing is in flight. */
async function restart(label: string, persist: boolean) {
  clock = frozenAt + DOWNTIME_MS;
  calls.lists = 0;
  calls.listed = 0;
  Bun.gc(true);
  const { cache, partner } = processState(persist ? disk() : null);
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await Promise.all(
    users.map((u) =>
      partner.observe(
        {
          ...scope(u),
          sessionId: `s-${u}`,
          kind: "user_message",
          text: "Check the budget review with the board",
          at: clock,
        } as AgentEvent,
        { waitMs: 0 },
      ),
    ),
  );
  const firstMs = performance.now() - t0;
  for (let i = 0; held(cache) < target || !allWarm(partner); i++) {
    if (i > 100_000) throw new Error(`${label}: the sync stopped at ${held(cache)}`);
    await partner.sync!.tick();
    clock += 1_000;
  }
  const ms = performance.now() - t0;
  // The returning users' lookups (on-demand polls, in the background) settle too: their calls count. Done when no
  // call came for 300 ms; that wait is not in the time above.
  for (let last = -1; last !== calls.lists;) {
    last = calls.lists;
    await Bun.sleep(300);
  }
  const cpu = process.cpuUsage(cpu0);
  const out = {
    label,
    resyncS: ms / 1000,
    firstEventsS: firstMs / 1000,
    cpuS: (cpu.user + cpu.system) / 1e6,
    listCalls: calls.lists,
    itemsListed: calls.listed,
    loaded: cache.freezes.loaded,
    loadMsPerUser: cache.freezes.loaded ? cache.freezes.loadMs / cache.freezes.loaded : 0,
    thawMsPerUser: cache.freezes.thawed ? cache.freezes.thawMs / cache.freezes.thawed : 0,
  };
  console.log(
    `${label}: every user synced again in ${out.resyncS.toFixed(2)} s wall (${out.cpuS.toFixed(2)} s CPU); ` +
      `${out.listCalls} listing calls, ${out.itemsListed} items listed` +
      (persist
        ? `; ${out.loaded} users read from disk (${out.loadMsPerUser.toFixed(2)} ms a read + decrypt, ` +
          `${out.thawMsPerUser.toFixed(1)} ms a thaw)`
        : ""),
  );
  partner.stopSync();
  return out;
}

console.log(
  `${USERS} users x ${PER_USER} items, 3 connectors (${LATENCY ? "20-80 ms" : "instant"} a listing), ` +
    `restart ${DOWNTIME_MS / 60_000} min after the freeze`,
);
const without = await restart("restart without (D8)", false);
const withPersist = await restart("restart with (D425)", true);
console.log(JSON.stringify({ users: USERS, perUser: PER_USER, latency: LATENCY, without, with: withPersist }));
rmSync(dir, { recursive: true, force: true });
process.exit(0);
