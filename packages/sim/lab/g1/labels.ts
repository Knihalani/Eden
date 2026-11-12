/** G1 ($0): dev20 pool misses by the suites' own labels. bun packages/sim/lab/g1/labels.ts POOL.jsonl */
import { readFileSync } from "node:fs";
import * as a from "../../src/lab/hidden-dev20a";
import * as b from "../../src/lab/hidden-dev20b";
import * as c from "../../src/lab/hidden-dev20c";
import * as d from "../../src/lab/hidden-dev20d";

const mods: Record<string, Record<string, unknown>> = { dev20a: a, dev20b: b, dev20c: c, dev20d: d };
const labels = ["ANCHORED", "RARE", "SILENT", "NON_ENGLISH", "INDIRECT", "QUESTION", "KNOWLEDGE", "NO_OVERLAP"];
const tally: Record<string, [number, number]> = {};
for (const l of readFileSync(process.argv[2]!, "utf8").split("\n")) {
  if (!l) continue;
  const r = JSON.parse(l);
  if (r.variant !== "hidden") continue;
  const m = mods[r.suite]!;
  const X = r.suite.toUpperCase();
  const mine = labels.filter((k) => [...(m[`${X}_${k}`] as Iterable<string>)].includes(r.template));
  for (const k of [...mine, "ALL", mine.length ? "" : "NONE"].filter(Boolean)) {
    const t = (tally[k] ??= [0, 0]);
    t[1]++;
    if (r.at < 0) t[0]++;
  }
  const src = `src:${r.planted.split(":")[0]}`;
  const t = (tally[src] ??= [0, 0]);
  t[1]++;
  if (r.at < 0) t[0]++;
}
for (const [k, [miss, n]] of Object.entries(tally).sort())
  console.log(k.padEnd(16), `miss ${miss}/${n}`, `${Math.round((100 * miss) / n)}%`);
