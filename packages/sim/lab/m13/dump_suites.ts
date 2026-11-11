/**
 * M13: the train suites' request texts (hidden variant; control and neutral share them) as JSONL `{text, src}`, for
 * the gate's training set. Every one is an acting request by construction.
 *
 *   bun packages/sim/lab/m13/dump_suites.ts OUT.jsonl
 */
import { writeFileSync } from "node:fs";
import { SUITES, preparedWorld } from "../../src/lab/suites.ts";

const names = Object.keys(SUITES).filter((s) => /^train\d(r|rw)?$/.test(s));
const seen = new Set<string>();
const rows: string[] = [];
for (const name of names)
  for (const seed of [41, 42, 43, 44]) {
    let tasks;
    try {
      tasks = SUITES[name]!(preparedWorld(name, seed), seed, "hidden");
    } catch (e) {
      console.error(name, seed, String(e).slice(0, 120));
      continue;
    }
    for (const t of tasks)
      if (!seen.has(t.text)) {
        seen.add(t.text);
        rows.push(JSON.stringify({ text: t.text, src: name }));
      }
  }
writeFileSync(process.argv[2]!, rows.join("\n") + "\n");
console.log(names.join(","), rows.length);
