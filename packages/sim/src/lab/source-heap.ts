/**
 * O4 (docs/research/o4-per-source.md): where a many-source user's heap is, by taking parts away one at a time.
 * Users are backfilled and make some requests; then each part is cleared and the heap read again. Lab only: it
 * reaches into private fields.
 *   bun packages/sim/src/lab/source-heap.ts [noise=995] [users=3] [requests=10]
 * Heap a user is read best as the slope between two user counts (about 13 MB of the process is the lab's own).
 */
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { ContextPartner, ItemCache } from "@eden/engine";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner } from "@eden/sources";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { noiseSources } from "./noise-sources";
const [noise = 995, users = 3, requests = 10] = process.argv.slice(2).map(Number);
const seed = 41;
const world = buildWorld({ seed: seed * 1000 });
const sources = [...simSources(world, REALISTIC, 0, seed), ...(noise ? noiseSources(world, noise, 20, 0, seed) : [])];
const heap = () => {
  for (let i = 0; i < 4; i++) {
    Bun.gc(true);
    Bun.sleepSync(30);
  }
  return process.memoryUsage().heapUsed;
};
let clock = world.now;
const cache = new ItemCache();
const planner = new QueryPlanner({ seed });
const sourceMap = new SourceMap(":memory:", { seed });
const before = heap();
const partner = new ContextPartner({
  sources: async () => sources,
  sourceMap,
  cache,
  budget: new Budget(),
  model: null,
  planner,
  now: () => clock,
  config: {},
});
const sync = partner.sync as any;
const scopes = Array.from({ length: users }, (_, i) => ({ tenantId: "t", userId: `u${i}` }));
for (const sc of scopes) sync.track(sc, clock);
for (let i = 0; i < 3000 && !scopes.every((sc) => sync.warm(sc)); i++) {
  await sync.tick();
  clock += 60_000;
}
const afterBackfill = heap();
for (const sc of scopes) {
  for (let r = 0; r < requests; r++) {
    const who = world.people[(r * 7 + 3) % world.people.length]!.full;
    const sessionId = `s${r}`;
    await partner.observe({ ...sc, sessionId, at: clock, kind: "session_start" } as AgentEvent);
    await partner.observe(
      {
        ...sc,
        sessionId,
        at: clock,
        kind: "user_message",
        text: `Reply to ${who} about the budget review and book a room for Thursday`,
      } as AgentEvent,
      { waitMs: 3000 },
    );
    await partner.ask({ ...sc, sessionId, question: `What did ${who} say about the budget review?` });
    await partner.observe({ ...sc, sessionId, at: clock, kind: "session_end" } as AgentEvent);
    clock += 10 * 60_000;
    await sync.tick();
  }
}
await Bun.sleep(500);
let last = heap();
const mb = (x: number) => (x / 1048576 / users).toFixed(2).padStart(6);
console.log(`${sources.length} sources, ${users} users, ${cache.syncedCount(scopes[0]!)} items; MB of heap a user`);
console.log(`  after the backfill            ${mb(afterBackfill - before)}`);
console.log(`  after ${requests} requests each        ${mb(last - before)}`);
const p = partner as any;
const step = (name: string, f: () => void) => {
  f();
  const now = heap();
  console.log(`  - ${name.padEnd(46)} ${mb(last - now)}`);
  last = now;
};
const each = (f: (s: any) => void) => {
  for (const u of sync.users.values()) for (const s of u.sources.values()) f(s);
};
step("sync: per-source sketches", () => each((s) => (s.sketch = null)));
step("sync: per-source id sets", () => each((s) => (s.ids = null)));
step("sync: the rest of its per-source state", () => sync.users.clear());
step("sync: its call budget's keys", () => sync.budget.tat.clear());
step("fan-out: per-(user, source) guards", () => p.fanout.per.clear());
step("fan-out: parked limits (D754)", () => p.fanout.parked?.clear());
step("fan-out: rate limiters' keys", () => (p.fanout.rate.tat.clear(), p.fanout.shadowRate.tat.clear()));
step("fan-out: held search pages", () => p.fanout.results?.clear?.());
step("planner: per-connector state", () => (planner as any).states.clear());
step("source yield", () => p.yields?.users.clear());
step("sessions and other partner maps", () => {
  for (const k of ["sessions", "userSessions", "watching", "acting", "recorded", "unverifiable", "revisionSources"])
    p[k].clear();
});
step("source map (SQLite, mostly outside the heap)", () => sourceMap.close());
step("item cache: items, text, index", () => {
  for (const sc of scopes) cache.forget(sc);
});
console.log(`  left unaccounted               ${mb(last - before)}`);
process.exit(0);
