/**
 * M13: the shipped push gate (`pushStart` with the default's switches) over a JSONL of `{text, ...}` rows; writes each
 * row back with `rule` ("listed" | "opened" | "none"). The baseline every M13 gate is scored against.
 *
 *   bun packages/sim/lab/m13/rules.ts IN.jsonl OUT.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pushStart } from "@eden/engine";

const [inp, out] = process.argv.slice(2);
const rows = readFileSync(inp!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
writeFileSync(
  out!,
  rows.map((r) => JSON.stringify({ ...r, rule: pushStart(r.text, { open: true, indirect: true })?.how ?? "none" })).join("\n") + "\n",
);
