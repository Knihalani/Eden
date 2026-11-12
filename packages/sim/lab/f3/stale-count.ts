/**
 * F3 (D1127): how each handed silent fact went out, current or stale, from a funnel `--packets` dump of dev20. A line
 * is current when it holds a word only the edited version has, stale when it holds a word only the earlier one has.
 * Sim data only.
 *
 *   bun packages/sim/lab/f3/stale-count.ts dump.packets.jsonl
 */
import { readFileSync } from "node:fs";
import { buildWorld } from "../../src/world";
import { dev20aBefore } from "../../src/lab/hidden-dev20a";
import { dev20bBefore } from "../../src/lab/hidden-dev20b";
import { dev20cBefore } from "../../src/lab/hidden-dev20c";
import { dev20dBefore } from "../../src/lab/hidden-dev20d";
import { prepareWorld } from "../../src/lab/suites";

const befores = { dev20a: dev20aBefore, dev20b: dev20bBefore, dev20c: dev20cBefore, dev20d: dev20dBefore } as const;
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}£$€.:]+/u)
      .filter((w) => w.length > 1),
  );
const cache = new Map<string, Map<string, string>>();
const beforeOf = (suite: keyof typeof befores, seed: number, template: string) => {
  const key = `${suite}:${seed}`;
  if (!cache.has(key)) {
    const w = buildWorld({ seed: seed * 1_000 });
    prepareWorld(suite, w, seed);
    cache.set(key, new Map(befores[suite](w, seed).map((b) => [b.template, `${b.before.title}\n${b.before.text}`])));
  }
  return cache.get(key)!.get(template);
};
const counts: Record<string, number> = {};
for (const line of readFileSync(process.argv[2]!, "utf8").trim().split("\n")) {
  const x = JSON.parse(line);
  if (x.variant !== "hidden") continue;
  const before = beforeOf(x.suite, x.seed, x.template);
  if (!before) continue;
  const b = words(before);
  const a = words(x.plantedText);
  const onlyNew = [...a].filter((w) => !b.has(w));
  const onlyOld = [...b].filter((w) => !a.has(w));
  let state = "not handed";
  for (const p of x.packets) {
    const lines = p.text.split("\n").filter((l: string) => l.startsWith("- ["));
    p.ids.forEach((id: string, i: number) => {
      if (id !== x.planted) return;
      const l = words(lines[i] ?? "");
      const n = onlyNew.some((w) => l.has(w));
      const o = onlyOld.some((w) => l.has(w));
      state = n && !o ? "current" : o && !n ? "stale" : "unclear";
    });
  }
  counts[state] = (counts[state] ?? 0) + 1;
}
console.log(JSON.stringify(counts));
