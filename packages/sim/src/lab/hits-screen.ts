#!/usr/bin/env bun
/**
 * P3's $0 screen of the `hits` arm (lexical-hits.ts): of each train task's planted item (the hidden fact, or on a
 * control task its decoy), whether the request's top-k BM25 hits hold it, beside `bun run funnel`'s candidates figure.
 *
 *   bun packages/sim/src/lab/hits-screen.ts [--seeds 41,42] [--k 5]
 */
import { worldOf } from "./ab-common";
import { topHits } from "./lexical-hits";
import { parseSuites } from "./suites";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};
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
