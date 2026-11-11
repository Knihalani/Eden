#!/usr/bin/env bun
/**
 * M6 (D920–D929): trim.ts against the trainer. Reads a `trim-model.json` (cands.py's export), scores its 64 parity
 * parts with `PartTrimmer` and compares each score and keep decision with the trainer's (quantised weights both).
 *
 *   bun packages/sim/src/lab/m6/parity.ts MODEL.json
 */
import { readFileSync } from "node:fs";
import { PartTrimmer } from "@eden/engine";

const path = process.argv[2]!;
const m = JSON.parse(readFileSync(path, "utf8")) as {
  threshold: number;
  checks: { request: string; title: string; parts: [string, number][]; scores: number[] }[];
};
const t = PartTrimmer.load(path);
if (!t) throw new Error("model did not load");
let n = 0;
let same = 0;
let maxDiff = 0;
for (const c of m.checks) {
  const parts = c.parts.map(([text, f]) => ({ text, quoted: (f & 1) === 1, header: (f & 2) === 2 }));
  const got = t.score(c.request, c.title, parts);
  for (let k = 0; k < parts.length; k++) {
    n++;
    const want = c.scores[k]!;
    maxDiff = Math.max(maxDiff, Math.abs(got[k]! - want));
    if (got[k]! >= m.threshold === want >= m.threshold) same++;
    else console.log(`differs: ${JSON.stringify(parts[k]!.text).slice(0, 120)} ts ${got[k]} py ${want}`);
  }
}
console.log(`parity: ${same}/${n} keep decisions identical, max |score diff| ${maxDiff.toExponential(2)}`);
if (same !== n) process.exit(1);
