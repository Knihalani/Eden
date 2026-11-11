#!/usr/bin/env bun
/**
 * P3's $0 screen of the `hits` arm (lexical-hits.ts): of each train task's planted item (the hidden fact, or on a
 * control task its decoy), whether the request's top-k BM25 hits hold it, beside `bun run funnel`'s candidates figure.
 *
 *   bun packages/sim/src/lab/hits-screen.ts [--seeds 41,42] [--k 5]
 *   bun packages/sim/src/lab/hits-screen.ts --cited RESULTS.json OUT.jsonl
 *
 * `--cited` writes, for a short pi-ab run made before the `hits` arm's packets were recorded in its timeline
 * (b-short-41 and -42), the ids each `hits` task's packet cited, as timeline lines (`task`, `condition`, `cited`): a
 * short run's worlds do not change, so the hits are recomputed exactly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { worldOf } from "./ab-common";
import { topHits } from "./lexical-hits";
import { parseSuites } from "./suites";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
const cited = arg("cited", "");
if (cited) {
  const run = JSON.parse(readFileSync(cited, "utf8")) as {
    seeds: number[];
    tasks: { id: string; suite: string; kind: string; text: string }[];
  };
  const seed = run.seeds[0]!;
  const lines: string[] = [];
  const worlds = new Map<string, ReturnType<typeof worldOf>>();
  for (const t of run.tasks) {
    const key = `${t.suite}|${t.kind}`;
    const base = t.suite.replace(/-(control|neutral)$/, "");
    if (!worlds.has(key)) worlds.set(key, worldOf(seed, base, t.kind as "hidden", { maxTasks: 1_000, maxOffworld: 0 }));
    const ids = topHits(worlds.get(key)!.world, t.text).map((i) => i.id);
    lines.push(JSON.stringify({ task: t.id, condition: "hits", cited: ids }));
  }
  writeFileSync(process.argv[process.argv.indexOf("--cited") + 2]!, lines.join("\n") + "\n");
  process.exit(0);
}
const seeds = arg("seeds", "41,42").split(",").map(Number);
const k = Number(arg("k", "5"));
const suites = parseSuites("train");
for (const variant of ["hidden", "control"] as const) {
  let n = 0;
  let held = 0;
  for (const suite of suites) {
    for (const seed of seeds) {
      const { world, tasks } = worldOf(seed, suite, variant, { maxTasks: 1_000, maxOffworld: 0 });
      for (const t of tasks) {
        if (!t.planted) continue;
        n++;
        if (topHits(world, t.text, k).some((i) => i.id === t.planted)) held++;
      }
    }
  }
  console.log(`${variant}: planted item among the top ${k} hits in ${held}/${n}`);
}
