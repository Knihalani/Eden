/**
 * M11: adds `target` (each request stemmed as the engine's `intentTerms`) to m11-enrich.ts's lines; drops items with
 * no requests unless --keep-empty. bun packages/sim/lab/m11/stem.ts IN.jsonl OUT.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs";
import { intentTerms } from "../../../engine/src/intent";

const [inp, out] = process.argv.slice(2);
const keep = process.argv.includes("--keep-empty");
const rows: string[] = [];
for (const l of readFileSync(inp!, "utf8").split("\n")) {
  if (!l.trim()) continue;
  const x = JSON.parse(l) as { r: string[] } & Record<string, unknown>;
  const target = (x.r ?? []).map((r) => intentTerms(r)).filter((t) => t.length > 0);
  if (!target.length && !keep) continue;
  rows.push(JSON.stringify({ ...x, target }));
}
writeFileSync(out!, rows.join("\n") + "\n");
console.log(`${rows.length} rows -> ${out}`);
