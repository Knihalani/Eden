/**
 * M13: the TypeScript gate against PyTorch's own logits on export.py's 64 parity rows: the same decision and kind,
 * and the logit within 1e-4 (float32 weights, float64 sums in TS).
 *
 *   bun packages/sim/lab/m13/parity.ts GATE.bin PARITY.json
 */
import { readFileSync } from "node:fs";
import { TurnGate } from "./turn-gate.ts";

const [bin, par] = process.argv.slice(2);
const gate = new TurnGate(new Uint8Array(readFileSync(bin!)));
const rows: { text: string; rule: "listed" | "opened" | "none"; rest: boolean; logit: number; kind: number }[] =
  JSON.parse(readFileSync(par!, "utf8"));
const KINDS = ["act", "qact", "ask", "chatter", "statement"];
let same = 0;
let worst = 0;
for (const r of rows) {
  const v = gate.read(r.text, { how: r.rule, rest: r.rest });
  const d = Math.abs(v.logit - r.logit);
  worst = Math.max(worst, d);
  if (d < 1e-4 && v.kind === KINDS[r.kind]) same++;
  else console.log("DIFF", d.toExponential(2), v.kind, KINDS[r.kind], JSON.stringify(r.text.slice(0, 80)));
}
console.log(`parity ${same}/${rows.length}, worst logit difference ${worst.toExponential(2)}, weights ${gate.bytes} bytes`);
