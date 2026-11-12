/**
 * G1 (D1400): what `ItemCache.dated` costs a request that names a day. One dev20 world's items (a corpus dump) in a
 * cache, the scan timed over 200 runs for a day with events and for a day with none.
 *   bun packages/sim/lab/g1/dated-bench.ts CORPUS.jsonl
 */
import { readFileSync } from "node:fs";
import { ItemCache } from "../../../engine/src/cache";

const line = readFileSync(process.argv[2]!, "utf8").split("\n")[0]!;
const world = JSON.parse(line) as { items: { id: string; title: string; text: string }[] };
const NOW = Date.UTC(2026, 9, 27, 9, 0);
const scope = { tenantId: "bench", userId: "u" };
for (const copies of [1, 10]) {
  const cache = new ItemCache();
  const items = [];
  for (let c = 0; c < copies; c++)
    for (const it of world.items) {
      const [sourceId, ref] = it.id.split(":") as [string, string];
      const id = c === 0 ? it.id : `${sourceId}:${ref}-c${c}`;
      items.push({
        id,
        sourceId,
        ref: id.slice(sourceId.length + 1),
        title: it.title,
        text: `${it.text} ${c}`,
        updatedAt: NOW - 86_400_000,
      });
    }
  cache.put(scope, items, NOW);
  for (const day of ["2026-10-30", "2027-03-03"]) {
    const days = new Set([day]);
    const times: number[] = [];
    let found = 0;
    for (let i = 0; i < 200 / copies; i++) {
      const t0 = performance.now();
      found = cache.dated(scope, days, () => false, NOW, 3, 0).length;
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    console.log(
      `${items.length} items, ${day}: p50 ${times[times.length >> 1]!.toFixed(2)} ms, p99 ${times[Math.floor(times.length * 0.99)]!.toFixed(2)} ms, found ${found}`,
    );
  }
}
