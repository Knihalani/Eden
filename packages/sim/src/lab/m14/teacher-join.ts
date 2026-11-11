/**
 * M1's 8B teacher scores over M2 v2's pair groups, joined to the texts M14's LOGO rows carry (M14, D1023: the
 * distillation recipe). LAB ONLY. A pair group is `family/world/task/request` with item ids and scores
 * (log P(yes) − log P(no)); the output has one line a scored pair, `{request, title, text, p}`, with the item's title
 * and text cleaned exactly as `logo-export.ts` cleans them, so `hashnet.py --teacher` finds them by text.
 *
 *   bun packages/sim/src/lab/m14/teacher-join.ts WORLDS.jsonl GROUPS.t8b.jsonl [...] --out OUT
 */
import { readFileSync, writeFileSync } from "node:fs";
import { readWorlds } from "../synth/suite";
import { cleanItem } from "./logo-export";

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const o = argv.indexOf("--out");
  if (o < 0) throw new Error("--out FILE");
  const out = argv[o + 1]!;
  const files = argv.filter((_, i) => i !== o && i !== o + 1);
  const worlds = new Map(readWorlds(files[0]!).map((w) => [w.id, w]));
  const lines: string[] = [];
  let groups = 0;
  let missing = 0;
  for (const f of files.slice(1))
    for (const l of readFileSync(f, "utf8").split("\n")) {
      if (!l.trim()) continue;
      const g = JSON.parse(l) as { group: string; keys: string[]; s: number[] };
      const [, wid, tid, rid] = g.group.split("/");
      const w = worlds.get(wid!);
      const req = w?.tasks.find((t) => t.id === tid)?.requests.find((r) => r.id === rid);
      if (!w || !req) {
        missing++;
        continue;
      }
      groups++;
      const items = new Map(w.items.map((i) => [i.id, i]));
      g.keys.forEach((k, j) => {
        const it = items.get(k);
        if (!it) return;
        const c = cleanItem(it.source, it.title, it.text);
        lines.push(
          JSON.stringify({ request: req.text, title: c.title, text: c.text, p: 1 / (1 + Math.exp(-g.s[j]!)) }),
        );
      });
    }
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`${lines.length} scored pairs from ${groups} groups (${missing} groups not in the worlds) → ${out}`);
}
