/**
 * A cold-start storm (A14): many users connect at once (a deploy, a restart, a morning) while users already warm keep
 * sending events. What it measures: how long until every new user is synced, and what the warm users' events wait
 * meanwhile (`observe` p50/p99/max with `waitMs` 0, the fast path an agent waits on) and the event loop's stalls.
 *
 * The shipped wiring (a `ContextPartner` on `DEFAULT_CONFIG`, no model, a `SourceMap` file), on the wall clock. Each
 * user has three in-memory connectors (mail, calendar, docs) that answer a listing after 20-80 ms (uniform, seeded),
 * as a remote connector does; items are the bench workload's text. First `--probe` users are synced; then `users`
 * storm users are tracked at once and the sync timer's work (`SyncManager.tick`, back to back) runs until all are
 * synced, while the probe users send one `user_message` due every `--every` ms (open loop: each one's latency runs
 * from when it was due, so a stalled loop's wait counts).
 *
 * Run: `bun packages/engine/bench/storm.bench.ts [users=300] [itemsPerUser=1000] [--probe=20] [--every=10]
 * [--config=<EngineConfig JSON>]`. No model, no network. Each storm user is kicked as their first event would
 * (`syncKick`, D751, D753, in the default since D755): the kicked steps run beside the back-to-back ticks.
 * `--config='{"syncKick":false}'` is the storm before it. `--tick-ms=N`
 * ticks every N ms as the servers' timer does (60,000 there) instead of back to back, the first after N ms (users
 * who arrive just after a tick; the probe users are still synced back to back).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget, DEFAULT_LIMITS } from "@eden/llm";
import type { ContextItem, Scope } from "@eden/protocol";
import type { ListPage, Source } from "@eden/sources";
import { ItemCache } from "../src/cache";
import type { EngineConfig } from "../src/config";
import { ContextPartner } from "../src/partner";
import { buildWorkload, rng } from "./workload";

const opt = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const USERS = Number(args[0] ?? 300);
const PER_USER = Number(args[1] ?? 1_000);
const PROBE = Number(opt("probe") ?? 20);
const EVERY = Number(opt("every") ?? 10);
const TICK_MS = Number(opt("tick-ms") ?? 0);
const CONFIG = JSON.parse(opt("config") ?? "{}") as Partial<EngineConfig>;
const SOURCES = ["mail", "calendar", "docs"] as const;
const random = rng(11);

/** A connector that lists a fixed set of items newest first after 20-80 ms. */
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
    await Bun.sleep(20 + random() * 60);
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
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

function userSources(u: string, n: number): Source[] {
  const per = SOURCES.map(() => [] as ContextItem[]);
  for (let i = 0; i < n; i++) {
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
  return SOURCES.map((id, k) => new SlowListSource(id, per[k]!));
}

const byUser = new Map<string, Source[]>();
const scope = (u: string): Scope => ({ tenantId: "bench", userId: u });
const probes = Array.from({ length: PROBE }, (_, i) => `p${i}`);
const storm = Array.from({ length: USERS }, (_, i) => `s${i}`);
for (const u of probes) byUser.set(u, userSources(u, 200));
for (const u of storm) byUser.set(u, userSources(u, PER_USER));

const cache = new ItemCache({ maxUsersPerTenant: USERS + PROBE + 1 });
const partner = new ContextPartner({
  sources: async (s) => byUser.get(s.userId)!,
  sourceMap: new SourceMap(join(mkdtempSync(join(tmpdir(), "eden-storm-")), "source-map.db")),
  cache,
  budget: new Budget(DEFAULT_LIMITS),
  model: null,
  config: { syncMaxUsersPerTenant: USERS + PROBE + 1, syncCallsPerMin: 1e7, ...CONFIG },
});
const sync = partner.sync!;
const synced = (us: string[]) => us.reduce((s, u) => s + cache.syncedCount(scope(u)), 0);
const syncAll = async (us: string[], target: number, tickMs = 0) => {
  for (let i = 0; synced(us) < target; i++) {
    if (i > 100_000) throw new Error(`the sync stopped at ${synced(us)} of ${target}`);
    // `--tick-ms`: the servers' timer; between its ticks only kicked steps read.
    if (tickMs > 0) {
      const until = performance.now() + tickMs;
      while (performance.now() < until && synced(us) < target) await Bun.sleep(20);
      if (synced(us) >= target) break;
    }
    await sync.tick();
  }
};

// The probe users, synced first.
for (const u of probes) sync.track(scope(u), Date.now());
await syncAll(probes, PROBE * 200);

// The storm, with the probe users' events throughout.
const lags: number[] = [];
let probing = true;
let last = performance.now();
const lagProbe = () => {
  const t = performance.now();
  lags.push(t - last - 1);
  last = t;
  if (probing) setTimeout(lagProbe, 1);
};
setTimeout(lagProbe, 1);
// Open loop: event k is due at start + k x every; its latency runs from when it was due, so time spent waiting for a
// turn of a stalled loop counts, as it does for an agent's request.
const observed: number[] = [];
const start = performance.now();
const sender = (async () => {
  for (let k = 0; probing; k++) {
    const due = start + k * EVERY;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    const u = probes[k % probes.length]!;
    await partner.observe(
      {
        ...scope(u),
        sessionId: `s-${u}`,
        kind: "user_message",
        text: "Check the budget review with the board",
        at: Date.now(),
      },
      { waitMs: 0 },
    );
    observed.push(performance.now() - due);
  }
})();
const cpu0 = process.cpuUsage();
const t0 = performance.now();
for (const u of storm) {
  sync.track(scope(u), Date.now());
  // `syncKick` (D751): a new user's first event kicks their backfill, as `observe` does.
  if (partner.config.syncKick) sync.kick(scope(u));
}
await syncAll(storm, USERS * PER_USER, TICK_MS);
const stormMs = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
probing = false;
await sender;

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const f = (x: number, d = 1) => x.toFixed(d);
console.log(
  `${USERS} storm users x ${PER_USER} items (3 connectors, 20-80 ms a listing), ${PROBE} warm users sending an event` +
    ` every ${EVERY} ms; config ${JSON.stringify(CONFIG)}${TICK_MS ? `; a tick every ${TICK_MS} ms` : ""}`,
);
console.log(
  `storm: ${f(stormMs / 1000)} s wall, ${f((cpu.user + cpu.system) / 1e6)} s CPU, ${f(USERS / (stormMs / 1000))} users/s`,
);
console.log(
  `warm users' observe during the storm (${observed.length} events): p50 ${f(pct(observed, 0.5), 2)} ms, p99 ` +
    `${f(pct(observed, 0.99))} ms, max ${f(Math.max(...observed))} ms; loop lag p99 ${f(pct(lags, 0.99))} ms, ` +
    `max ${f(Math.max(...lags))} ms`,
);
console.log(
  JSON.stringify({
    users: USERS,
    perUser: PER_USER,
    config: CONFIG,
    stormS: stormMs / 1000,
    cpuS: (cpu.user + cpu.system) / 1e6,
    observeP50: pct(observed, 0.5),
    observeP99: pct(observed, 0.99),
    observeMax: Math.max(...observed),
    lagP99: pct(lags, 0.99),
    lagMax: Math.max(...lags),
  }),
);
process.exit(0);
