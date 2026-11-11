#!/usr/bin/env bun
/**
 * M6 (D920–D929): the trimmer's speed on real packet items. Reads a `--packet-parts` dump, groups each packet's items,
 * and times `PartTrimmer.score` over every item of a packet (what one packet costs), after a warm-up.
 *
 *   bun packages/sim/src/lab/m6/bench.ts MODEL.json DUMP.jsonl [--packets 2000]
 */
import { readFileSync, statSync } from "node:fs";
import { PartTrimmer } from "@eden/engine";

const [modelPath, dump] = process.argv.slice(2) as [string, string];
const limit = Number(process.argv[process.argv.indexOf("--packets") + 1] ?? 2000) || 2000;
const t = PartTrimmer.load(modelPath);
if (!t) throw new Error("model did not load");
type Item = { title: string; parts: [string, number][] };
const packets: { request: string; items: Item[] }[] = [];
for (const line of readFileSync(dump, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const r = JSON.parse(line) as { request: string; parts?: Item[][] };
  for (const p of r.parts ?? []) if (p.length) packets.push({ request: r.request, items: p });
  if (packets.length >= limit) break;
}
const prepared = packets.map((p) => ({
  request: p.request,
  items: p.items.map((i) => ({
    title: i.title,
    parts: i.parts.map(([text, f]) => ({ text, quoted: (f & 1) === 1, header: (f & 2) === 2 })),
  })),
}));
const run = () => {
  for (const p of prepared) for (const i of p.items) t.score(p.request, i.title, i.parts);
};
run(); // warm-up
const times: number[] = [];
for (const p of prepared) {
  const a = performance.now();
  for (const i of p.items) t.score(p.request, i.title, i.parts);
  times.push(performance.now() - a);
}
times.sort((a, b) => a - b);
const q = (x: number) => times[Math.min(times.length - 1, Math.floor(x * times.length))]!.toFixed(3);
const items = prepared.reduce((n, p) => n + p.items.length, 0);
console.log(
  `${prepared.length} packets (${(items / prepared.length).toFixed(2)} items a packet): p50 ${q(0.5)} ms, p90 ${q(0.9)} ms, ` +
    `p99 ${q(0.99)} ms a packet; model file ${(statSync(modelPath).size / 1e6).toFixed(2)} MB`,
);
