/**
 * The results cache's heap bound, run in a process of its own by `regressions.test.ts` ("50,000 empty pages …").
 *
 * Why a child process (docs/research/b2-deflake.md): `bun test --parallel` runs many files in one worker process, one
 * after another, each with a fresh global but one shared JSC heap. What earlier files left behind (pending timers,
 * servers, sockets, caches freed on their own schedule) was freed or allocated between this scenario's two heap
 * readings and moved the difference by megabytes: in a full `bun run check` the bound failed with 4.48 MB over it,
 * while the same scenario alone read 3.23 MB of growth every time, under four CPU burners too. Alone in a process, the
 * reading is this scenario's own.
 *
 * Prints one JSON line: `{ grew, heldByCache, bytes, size }` (bytes of heap; the cache's own byte count and entries).
 */
import { heapStats } from "bun:jsc";
import type { Source } from "./source";
import { SourceFanout } from "./guarded";

let now = 0;
const f = new SourceFanout({
  sanitize: (x) => x,
  cacheBytes: 4_000_000,
  ratePerSec: 1e9,
  burst: 1e9,
  now: () => now,
});
const empty: Source = { id: "mail-connector", kind: "t", description: "", search: async () => [] };
const users = Array.from({ length: 50 }, (_, i) => ({ tenantId: `tenant-${i}`, userId: `user-${i}-abcdefgh` }));
const q = (scope: { tenantId: string; userId: string }, text: string) => ({ scope, text, entities: [], limit: 5 });
const pad = "x".repeat(60);
// The heap once every search's 1 s deadline timer (`AbortSignal.timeout`, real time) has lapsed, the least of three
// collections: how many of the 50,000 timers were still pending decided the reading (audit A5). Under heavy load timers
// fire late (audit A11), so the reading is taken again, 250 ms apart, until it stops falling by more than 64 KB (at
// most 8 s), with no pending timer left to free.
const settled = async () => {
  await Bun.sleep(1_100);
  const least3 = () => {
    let least = Infinity;
    for (let k = 0; k < 3; k++) {
      Bun.gc(true);
      least = Math.min(least, heapStats().heapSize);
    }
    return least;
  };
  let least = least3();
  for (let k = 0; k < 32; k++) {
    await Bun.sleep(250);
    const next = least3();
    const fell = least - next;
    least = Math.min(least, next);
    if (fell < 64_000) break;
  }
  return least;
};
// Warm up (state per user, JIT) before the baseline.
for (const u of users) await f.search([empty], q(u, "warm"), { timeoutMs: 1_000 });
const before = await settled();
// One page every 30 simulated ms: 1,500 s, past the 600 s expiry for most pages, and far past the byte budget
// (every page held would be ~17 MB at the pre-fix ~345 B each).
for (let i = 0; i < 50_000; i++) {
  now += 30;
  const text = `quarterly invoice renewal ${i} ${pad}`;
  const [out] = await f.search([empty], q(users[i % 50]!, text), { timeoutMs: 1_000 });
  if (out!.status !== "ok") throw new Error(out!.status);
}
const grew = (await settled()) - before;
const inner = f as unknown as { results: { bytes: number; size: number } | null };
const { bytes, size } = inner.results!;
// The heap the cache holds: growth minus what is left once the cache itself is let go.
inner.results = null;
const heldByCache = grew - ((await settled()) - before);
console.log(JSON.stringify({ grew, heldByCache, bytes, size }));
