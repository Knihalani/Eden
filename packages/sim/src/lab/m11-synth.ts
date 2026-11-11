/**
 * M11 (D970-D979): M2 v2 synthetic worlds as CopyGen training rows (lab only). Each task's fact, as the cache would
 * hold it (`sanitizeItem`), with its English requests stemmed as the engine stems them (`intentTerms`) as the target;
 * its all-clear decoy and its neutrals as the look-alikes it must outrank for those requests.
 *   bun packages/sim/src/lab/m11-synth.ts .local/m2/synth/worlds/train.jsonl .local/m11/synth-train.jsonl
 * Never point it at test (measurement only, D884).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { intentTerms, sanitizeItem } from "@eden/engine";

const [inp, out] = process.argv.slice(2);
if (!inp || !out || /test/.test(inp))
  throw new Error("usage: m11-synth.ts WORLDS.jsonl OUT.jsonl (never the test split)");
type Item = { id: string; source: string; title: string; text: string };
type Task = {
  fact: string;
  decoy: string;
  neutrals: string[];
  family: string;
  requests: { lang: string; text: string }[];
};
const rows: string[] = [];
const view = (w: string, it: Item) => {
  const s = sanitizeItem({ id: `${w}:${it.id}`, sourceId: it.source, ref: it.id, title: it.title, text: it.text });
  return {
    title: s.title,
    text: s.text,
    terms: intentTerms(`${s.title}\n${s.text}`),
    titleTerms: intentTerms(s.title),
  };
};
for (const line of readFileSync(inp, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const w = JSON.parse(line) as { id: string; items: Item[]; tasks: Task[] };
  const byId = new Map(w.items.map((i) => [i.id, i]));
  for (const t of w.tasks) {
    const fact = byId.get(t.fact);
    if (!fact) continue;
    const target = t.requests.filter((r) => r.lang === "en").map((r) => intentTerms(r.text));
    if (!target.length) continue;
    const neg = [t.decoy, ...t.neutrals].map((id) => byId.get(id)).filter((x): x is Item => !!x);
    rows.push(JSON.stringify({ family: t.family, ...view(w.id, fact), target, negs: neg.map((n) => view(w.id, n)) }));
  }
}
writeFileSync(out, rows.join("\n") + "\n");
console.log(`${rows.length} rows -> ${out}`);
