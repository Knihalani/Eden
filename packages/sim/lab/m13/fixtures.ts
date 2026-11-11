/**
 * M13: the hard-gate fixtures (fixtures.json, fixtures-2.json) through the engine's shipped gate with the rule's
 * reading, the guard included: the rows it gets wrong.
 *
 *   bun packages/sim/lab/m13/fixtures.ts
 */
import { readFileSync } from "node:fs";
import { pushStart, turnGate } from "@eden/engine";

const gate = turnGate()!;
let wrong = 0;
let n = 0;
for (const f of ["fixtures.json", "fixtures-2.json"]) {
  const rows: { text: string; needs: boolean }[] = JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
  for (const r of rows) {
    const s = pushStart(r.text, { open: true, indirect: true });
    const v = gate.read(r.text, { how: s?.how ?? "none", rest: s !== null && s.request !== r.text });
    n++;
    if (v.needs !== r.needs) {
      wrong++;
      console.log(`wrong (want ${r.needs}): ${JSON.stringify(r.text)}`);
    }
  }
}
console.log(`${wrong} of ${n} wrong`);
