/**
 * M13: the TypeScript gate's time a turn (mean and p99 over the dev turns, after a warm-up) and its load time.
 *
 *   bun packages/sim/lab/m13/bench.ts GATE.bin .local/m13/sets/dev.jsonl
 */
import { readFileSync } from "node:fs";
import { TurnGate } from "@eden/engine";

const [bin, set] = process.argv.slice(2);
const t0 = performance.now();
const gate = new TurnGate(new Uint8Array(readFileSync(bin!)));
const load = performance.now() - t0;
const texts: string[] = readFileSync(set!, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l).text);
for (const t of texts.slice(0, 500)) gate.read(t, { how: "none", rest: false });
const times: number[] = [];
let n = 0;
for (let rep = 0; rep < 3; rep++)
  for (const t of texts) {
    const a = performance.now();
    if (gate.read(t, { how: "none", rest: false }).needs) n++;
    times.push(performance.now() - a);
  }
times.sort((a, b) => a - b);
const mean = times.reduce((a, b) => a + b, 0) / times.length;
console.log(
  `turns ${times.length}, mean ${(mean * 1000).toFixed(1)} µs, p50 ${(times[times.length >> 1]! * 1000).toFixed(1)} µs, ` +
    `p99 ${(times[Math.floor(times.length * 0.99)]! * 1000).toFixed(1)} µs, load ${load.toFixed(1)} ms, ${gate.bytes} bytes`,
);
