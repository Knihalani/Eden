/**
 * `ItemCache.timed`/`dated` cost at cache sizes past the defaults (4,000 and 20,000 items), for the per-day index:
 * a query that names a day looked matches up instead of scanning the user's items. `bun day-index.bench.ts [n ...]`.
 */
import type { ContextItem } from "@eden/protocol";
import { bench, consume, report } from "../../primitives/bench/harness";
import { ItemCache } from "../src/cache";
import { rng } from "./workload";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 9);
const scope = { tenantId: "bench", userId: "u1" };
const days = new Set(["2026-10-30", "2026-10-31", "2026-11-01"]);

/** A mixed user: ~15% events with a `meta.start` (own zone, UTC or bare), mails naming days, spans and ordinals. */
function items(n: number, seed: number): ContextItem[] {
  const r = rng(seed);
  const out: ContextItem[] = [];
  for (let i = 0; i < n; i++) {
    const x = r();
    const day = NOW - Math.floor(r() * 90) * DAY + Math.floor(r() * 14) * 3_600_000;
    const iso = new Date(day).toISOString();
    if (x < 0.15) {
      const start = r() < 0.4 ? iso : r() < 0.5 ? iso.slice(0, 19) : iso.replace("Z", "+01:00");
      out.push({
        id: `e${i}`,
        sourceId: "calendar",
        ref: String(i),
        title: `Meeting ${i}`,
        text: `Weekly sync on the ${pickTopic(r)}.`,
        updatedAt: NOW - 10 * DAY,
        meta: { start },
      });
    } else if (x < 0.25) {
      out.push(mail(i, `see you ${1 + Math.floor(r() * 28)} Oct`, r));
    } else if (x < 0.27) {
      out.push(mail(i, `Lift out of service 26 Oct – 6 Nov, ref ${i}`, r));
    } else if (x < 0.29) {
      out.push(mail(i, `works for the ${1 + Math.floor(r() * 28)}th`, r));
    } else {
      out.push(mail(i, `the ${pickTopic(r)} notes, ref ${i}`, r));
    }
  }
  return out;
}

const TOPICS = "renewal pricing invoice roadmap launch hiring flight dentist subscription migration audit".split(" ");
const pickTopic = (r: () => number) => TOPICS[Math.floor(r() * TOPICS.length)]!;
function mail(i: number, line: string, r: () => number): ContextItem {
  return {
    id: `m${i}`,
    sourceId: "gmail",
    ref: String(i),
    title: `Re: ${pickTopic(r)} ${i}`,
    text: `${line}: ${body(r)}`,
    updatedAt: NOW - Math.floor(r() * 20) * DAY,
  };
}
function body(r: () => number): string {
  const n = 8 + Math.floor(r() * 30);
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(pickTopic(r), "please let me know", `ref${Math.floor(r() * 900)}`);
  return w.join(" ");
}

let putI = 0;
const rng0 = rng(99);

const sizes = process.argv.slice(2).map(Number);
for (const n of sizes.length ? sizes : [4_000, 20_000]) {
  const all = items(n, 7);
  const fresh = () => {
    const c = new ItemCache({
      maxItemsPerUser: n * 2,
      maxSyncedPerUser: n * 2,
      maxUsersPerTenant: 10,
      ttlMs: 365 * DAY,
      maxTextChars: 8_000,
      syncTtlMs: 365 * DAY,
      expireEveryMs: 0,
      releaseTerms: true,
      packText: true,
      freezeIdleMs: 0,
      warmIdleMs: 0,
      idleCompact: false,
    });
    c.close();
    c.put(scope, all, NOW);
    return c;
  };
  const cache = fresh();
  // First `dated` call: the lazy read of every item's date facts (the decompression burst the index avoids later).
  let t0 = performance.now();
  consume(cache.dated(scope, days, () => false, NOW, 3, 0));
  const firstMs = performance.now() - t0;
  t0 = performance.now();
  consume(cache.dated(scope, days, () => false, NOW, 3, 0));
  const secondMs = performance.now() - t0;
  console.log(`${n} items: first dated ${firstMs.toFixed(2)} ms, second ${secondMs.toFixed(2)} ms`);
  report([
    bench(`timed, ${n} items`, () => cache.timed(scope, days, NOW, 30, 0).length, { batch: 100 }),
    bench(`dated, ${n} items`, () => cache.dated(scope, days, () => false, NOW, 3, 0).length, { batch: 100 }),
    bench(
      `put one item, ${n} held`,
      () => {
        consume(cache.put(scope, [mail(-putI++, `the ${pickTopic(rng0)}`, rng0)], NOW).length);
        return putI;
      },
      { batch: 50 },
    ),
  ]);
}
