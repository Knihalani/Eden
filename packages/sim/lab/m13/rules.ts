/**
 * M13: the shipped push gate (`pushStart` with the default's switches) over a JSONL of `{text, ...}` rows; writes each
 * row back with `rule` ("listed" | "opened" | "none") and `rest` (the push's request is not the whole message: an
 * indirect lead-in or a second clause was read). The baseline every M13 gate is scored against, and gate H7's input.
 *
 *   bun packages/sim/lab/m13/rules.ts IN.jsonl OUT.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pushStart } from "@eden/engine";

const [inp, out] = process.argv.slice(2);
const rows = readFileSync(inp!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const lines = rows.map((r) => {
  const s = pushStart(r.text, { open: true, indirect: true });
  return JSON.stringify({ ...r, rule: s?.how ?? "none", rest: s ? s.request !== r.text : false });
});
writeFileSync(out!, lines.join("\n") + "\n");
