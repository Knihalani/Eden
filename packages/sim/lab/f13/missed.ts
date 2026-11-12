/**
 * F13 (retrieval): why hidden facts never reach the agent ($0; LAB ONLY, sim data).
 *
 *   bun packages/sim/lab/f13/missed.ts FUNNEL.json CORPUS.jsonl [--sample N]
 *
 * FUNNEL.json is a `bun run funnel --json` run; CORPUS.jsonl its `--corpus-dump` (the same suites and seeds). A hidden
 * task is never retrieved when its planted item is not in the push's pool, no ask cited it and nothing delivered it.
 * Each is classed by: whether the item was cached (the sync's coverage); whether a push started for the request
 * (`pushPoolAt` present); and whether request and item share a content term as the engine reads them (`contentTerms`
 * over the request with its glossary English, `glossOf`, against the item's title and text head).
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Vocab } from "@eden/primitives";
import { glossOf } from "../../../engine/src/gloss";
import { contentTerms } from "../../../engine/src/text";

type Row = {
  suite: string;
  seed: number;
  variant: string;
  template: string;
  cached: boolean;
  delivered: boolean;
  askCited?: boolean;
  pushPoolAt?: number | null;
};
const [funnelPath, corpusPath] = process.argv.slice(2);
const sample = process.argv.includes("--sample") ? Number(process.argv[process.argv.indexOf("--sample") + 1]) : 0;
const rows: Row[] = JSON.parse(readFileSync(funnelPath!, "utf8")).perTask;
const worlds = new Map<
  string,
  {
    tasks: { template: string; request: string; planted: string }[];
    items: Map<string, { title: string; text: string }>;
  }
>();
for (const l of readFileSync(corpusPath!, "utf8").split("\n")) {
  if (!l) continue;
  const d = JSON.parse(l);
  if (d.variant !== "hidden") continue;
  worlds.set(`${d.suite}|${d.seed}`, {
    tasks: d.tasks,
    items: new Map(d.items.map((i: { id: string; h: string; title: string; text: string }) => [i.id, i])),
  });
}
const vocab = new Vocab();
// The shipped card replay (D872, D1102): an item's card and its anticipated requests (`r`), form 3 first.
const cards = new Map<string, { kind: string; r: string[] }>();
const cardsPath = process.argv.includes("--cards") ? process.argv[process.argv.indexOf("--cards") + 1] : "";
if (cardsPath)
  for (const l of gunzipSync(readFileSync(cardsPath)).toString("utf8").split("\n")) {
    if (!l) continue;
    const d = JSON.parse(l);
    const base = d.h.split(":")[0];
    if (d.h.endsWith(":f3") || !cards.has(base)) cards.set(base, { kind: d.c.kind, r: d.r ?? [] });
  }
const group = (s: string) => (s.startsWith("dev20") ? "dev20" : "train");
const counts = new Map<string, Map<string, number>>();
const examples: string[] = [];
for (const r of rows) {
  if (r.variant !== "hidden") continue;
  const inPool = typeof r.pushPoolAt === "number" && r.pushPoolAt >= 0;
  if (inPool || r.askCited || r.delivered) continue;
  const w = worlds.get(`${r.suite}|${r.seed}`);
  const t = w?.tasks.find((x) => x.template === r.template);
  const item = t && w!.items.get(t.planted);
  let cls: string;
  let shared: string[] = [];
  if (!item || !r.cached) cls = "a: not cached";
  else {
    const req = new Set(contentTerms(`${t!.request} ${glossOf(t!.request)}`, vocab));
    shared = [...new Set(contentTerms(`${item.title} ${item.text}`, vocab))].filter((x) => req.has(x));
    const pushed = r.pushPoolAt !== undefined;
    cls = `${pushed ? "pushed" : "no push"}, ${shared.length ? "shares terms" : "disjoint"}`;
    if (cardsPath && !shared.length) {
      const card = cards.get((item as unknown as { h: string }).h);
      const viaReq = card ? card.r.some((q) => contentTerms(q, vocab).some((x) => req.has(x))) : false;
      cls += !card
        ? " / no card"
        : card.r.length === 0
          ? ` / card ${card.kind}, no requests`
          : viaReq
            ? " / card requests share terms"
            : " / card requests disjoint";
    }
  }
  const g = counts.get(group(r.suite)) ?? new Map();
  counts.set(group(r.suite), g);
  g.set(cls, (g.get(cls) ?? 0) + 1);
  if (sample && examples.length < sample && t && item)
    examples.push(
      `[${r.suite} ${r.template}] ${cls}\n  REQ: ${t.request}\n  ITEM: ${item.title} | ${item.text.slice(0, 160).replace(/\s+/g, " ")}\n  SHARED: ${shared.join(", ")}`,
    );
}
for (const [g, m] of counts) {
  const n = [...m.values()].reduce((a, b) => a + b, 0);
  console.log(`${g}: ${n} never retrieved`);
  for (const [c, k] of [...m].sort((a, b) => b[1] - a[1]))
    console.log(`  ${c.padEnd(28)} ${k} (${((100 * k) / n).toFixed(0)}%)`);
}
if (examples.length) console.log(examples.join("\n"));
