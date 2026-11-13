/**
 * The source map's disk writes on the pipeline workload (D1720, D1780): `pipeline.bench.ts`'s event stream through a
 * real ContextPartner whose SourceMap is a file, as the servers keep it, with the process's `write_bytes`
 * (`/proc/self/io`, Linux) read before the stream and after `close`, and the time spent in each SourceMap method.
 *
 *   env -u BUN_OPTIONS bun packages/engine/bench/source-map-writes.bench.ts [itemsPerSource=1500] [events=2000]
 *
 * D1780's figures are three interleaved runs of this on each tree (main before D1780: `git show
 * 766516f6d:packages/graph/src/source-map.ts`): 7.58-8.26 MB written for 5,506-5,962 mention upserts before, 2.21-2.29
 * MB for 6,197-6,437 after. The run's lookups vary with timing (Thompson draws, the slow path's progress at each
 * event), so compare bytes per upsert as well as totals.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { ContextPartner, ItemCache } from "../src/index";
import { buildWorkload } from "./workload";

const itemsPerSource = Number(process.argv[2] ?? 1_500);
const eventCount = Number(process.argv[3] ?? 2_000);
const written = () => Number(/write_bytes: (\d+)/.exec(readFileSync("/proc/self/io", "utf8"))![1]);
const w = buildWorkload({ itemsPerSource, events: eventCount, seed: 7 });
const dir = mkdtempSync(join(tmpdir(), "eden-map-writes-"));
const map = new SourceMap(join(dir, "map.db"));

// Time inside each public method (a call made from inside another is counted in both), and the upserts asked for.
const spent: Record<string, [calls: number, ms: number]> = {};
let upserts = 0;
const methods = ["route", "sourcesFor", "recordMentionsMany", "recordOutcome", "flush"] as const;
for (const m of methods) {
  const f = (map[m] as (...a: unknown[]) => unknown).bind(map);
  (map as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
    if (m === "recordMentionsMany")
      for (const r of a[1] as { entities: string[] }[]) upserts += new Set(r.entities).size;
    const s = performance.now();
    try {
      return f(...a);
    } finally {
      const e = (spent[m] ??= [0, 0]);
      e[0]++;
      e[1] += performance.now() - s;
    }
  };
}
const partner = new ContextPartner({
  sources: async () => w.sources,
  sourceMap: map,
  cache: new ItemCache(),
  budget: new Budget(),
  model: null,
});
const observeMs: number[] = [];
const before = written();
const t0 = performance.now();
for (const event of w.events) {
  const s = performance.now();
  await partner.observe(event, { waitMs: 0 });
  observeMs.push(performance.now() - s);
  // Let the slow path run (sources are instant), as pipeline.bench.ts does.
  await Bun.sleep(0);
}
const totalMs = performance.now() - t0;
partner.stopSync();
map.close();
const bytes = written() - before;
const p50 = [...observeMs.slice(20)].sort((a, b) => a - b)[Math.floor((observeMs.length - 20) / 2)]!;
console.log(
  JSON.stringify({
    writtenMB: +(bytes / 1e6).toFixed(3),
    upserts,
    bytesPerUpsert: Math.round(bytes / Math.max(1, upserts)),
    dbKB: Math.round(statSync(join(dir, "map.db")).size / 1024),
    totalMs: Math.round(totalMs),
    observeP50us: +(p50 * 1000).toFixed(1),
    spent: Object.fromEntries(
      Object.entries(spent).map(([k, [n, ms]]) => [
        k,
        { calls: n, ms: +ms.toFixed(1), usEach: +((ms / n) * 1000).toFixed(1) },
      ]),
    ),
  }),
);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
