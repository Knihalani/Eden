/**
 * M11: the card keys of export items the card prefilter (`worthCarding`) passes.
 *   bun prefilter.ts ITEMS.jsonl... > OUT
 */
import { readFileSync } from "node:fs";
import { worthCarding } from "../../../engine/src/cards";

const out: string[] = [];
for (const f of process.argv.slice(2))
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const x = JSON.parse(l) as { h: string; title: string; text: string; src: string };
    if (worthCarding({ id: x.h, sourceId: x.src, ref: x.h, title: x.title, text: x.text })) out.push(x.h);
  }
console.log(JSON.stringify(out));
