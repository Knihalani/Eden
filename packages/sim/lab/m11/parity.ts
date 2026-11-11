/**
 * M11: the engine's MicroExpander against export.py's numpy reference (64 held-out items): expansions equal, copy
 * and generation logits within 1e-4; then the time an item and the model's size.
 *   bun packages/sim/lab/m11/parity.ts MODEL.bin CHECKS.json
 */
import { readFileSync, statSync } from "node:fs";
import { MicroExpander } from "../../../engine/src/micro";

const [bin, checksFile] = process.argv.slice(2);
const e = new MicroExpander(readFileSync(bin!));
const checks = JSON.parse(readFileSync(checksFile!, "utf8")) as {
  title: string;
  text: string;
  expansion: Record<string, number>;
  copy: [string, number][];
  gen: number[] | null;
}[];
let same = 0;
let maxErr = 0;
for (const c of checks) {
  const w = Object.fromEntries(e.weights(c.title, c.text));
  const ok = JSON.stringify(Object.entries(w).sort()) === JSON.stringify(Object.entries(c.expansion).sort());
  if (ok) same++;
  else console.log("MISMATCH", c.title, w, c.expansion);
  const f = e.forward(c.title, c.text);
  c.copy.forEach(([t, z], i) => {
    if (f.copy[i]![0] !== t) console.log("TERM ORDER", t, f.copy[i]![0]);
    maxErr = Math.max(maxErr, Math.abs(f.copy[i]![1] - z));
  });
  c.gen?.forEach((z, i) => (maxErr = Math.max(maxErr, Math.abs(f.gen![i]! - z))));
}
const t0 = performance.now();
let n = 0;
for (let r = 0; r < 5; r++) for (const c of checks) (e.expand(c.title, c.text), n++);
const ms = (performance.now() - t0) / n;
console.log(
  `parity ${same}/${checks.length}, max logit error ${maxErr.toExponential(2)}; ${ms.toFixed(3)} ms an item; ${(statSync(bin!).size / 1e6).toFixed(2)} MB`,
);
