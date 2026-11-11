#!/usr/bin/env bun
/**
 * M10 (lab only): M3's 52 short constraints (`packages/sim/lab/m3r/short-constraints.jsonl`) and M10's field fixtures
 * (`packages/sim/lab/m10/field-fixtures.jsonl`) as export rows, read by the tagger's reader as an item would be.
 *
 *   bun packages/sim/src/lab/m10/fixtures.ts --out .local/m10/fixtures.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardKey, datedOf, ownText, worthCarding, worthCardingStrict } from "../../../../engine/src/cards";
import { readText } from "../../../../engine/src/micro-cards";
import type { ContextItem } from "@eden/protocol";

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : ".local/m10/fixtures.jsonl";
const LAB = join(import.meta.dir, "..", "..", "..", "lab");
const NOW = "2026-10-26";
// `--in FILE --set NAME`: any `{title, text, dated?, source?}` lines (M10's generated families) read the same way.
const given = process.argv.includes("--in") ? process.argv[process.argv.indexOf("--in") + 1]! : "";
const setName = process.argv.includes("--set") ? process.argv[process.argv.indexOf("--set") + 1]! : "gen";
const files: [string, string][] = given
  ? [[setName, given]]
  : [
      ["short", join(LAB, "m3r", "short-constraints.jsonl")],
      ["field", join(LAB, "m10", "field-fixtures.jsonl")],
    ];
const rows: string[] = [];
for (const [set, path] of files) {
  let n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const f = JSON.parse(line) as { title: string; text: string; dated?: string; source?: string; expect?: unknown; family?: string };
    const dated = f.dated ?? NOW;
    const it: ContextItem = {
      id: `${set}-${n++}`,
      sourceId: f.source ?? "mail",
      ref: `${set}-${n}`,
      title: f.title,
      text: f.text,
      updatedAt: Date.parse(`${dated}T09:00:00Z`),
    };
    const anchor = Date.parse(`${datedOf(it) || dated}T12:00:00Z`);
    const read = readText(it.title, ownText(it), anchor);
    rows.push(
      JSON.stringify({
        h: cardKey(it),
        suite: given ? set : `fixture-${set}`,
        ...(f.family !== undefined ? { family: f.family } : {}),
        seed: 0,
        variant: "fixture",
        planted: false,
        id: it.id,
        title: it.title,
        own: ownText(it),
        text: it.text,
        updatedAt: it.updatedAt,
        meta: null,
        dated: datedOf(it),
        now: NOW,
        source: it.sourceId,
        strict: worthCardingStrict(it),
        worth: worthCarding(it),
        toks: read.toks.map((t) => [t.w, t.s]),
        dates: read.dates,
        amounts: read.amounts,
        ...(f.expect !== undefined ? { expect: f.expect } : {}),
      }),
    );
  }
}
writeFileSync(out, rows.join("\n") + "\n");
console.error(`${rows.length} fixture rows`);
