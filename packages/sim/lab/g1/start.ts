/**
 * G1 ($0): which dev20 requests start the push (the rule, the turn gate's verdict and score), by variant.
 *   bun packages/sim/lab/g1/start.ts CORPUS.jsonl [--list]
 */
import { readFileSync } from "node:fs";
import { pushStart } from "../../../engine/src/probes";
import { turnGate } from "../../../engine/src/turn-gate";

const gate = turnGate()!;
const seen = new Set<string>();
const c: Record<string, number> = {};
const list = process.argv.includes("--list");
for (const l of readFileSync(process.argv[2]!, "utf8").split("\n")) {
  if (!l) continue;
  const d = JSON.parse(l);
  if (d.seed !== 41) continue;
  for (const t of d.tasks as { template: string; request: string }[]) {
    const k = `${d.variant}|${d.suite}|${t.template}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ruled = pushStart(t.request, { open: true, indirect: true });
    const v = gate.read(t.request, { how: ruled?.how ?? "none", rest: ruled !== null && ruled.request !== t.request });
    const how = !v.needs ? (ruled ? "vetoed" : "no start") : ruled ? `rule ${ruled.how}` : "gate only";
    c[`${d.variant} ${how}`] = (c[`${d.variant} ${how}`] ?? 0) + 1;
    if (list && d.variant === "hidden" && !v.needs) console.log(JSON.stringify(v), ruled?.how ?? "-", t.request);
  }
}
for (const k of Object.keys(c).sort()) console.log(k.padEnd(28), c[k]);
