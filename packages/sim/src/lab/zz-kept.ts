import { readFileSync } from "node:fs";
import { worldOf } from "./ab-common";
const details = new Map<string, string>();
const stop = new Set(
  "the a an and or of to in on for is are was were be by at with from as it this that has have had so not no only would could their they them its your you".split(
    " ",
  ),
);
const words = (s: string) =>
  new Set((s.toLowerCase().match(/[a-z0-9£$€]+(?:[.,][0-9]+)?/g) ?? []).filter((w) => w.length > 1 && !stop.has(w)));
function kept(file: string) {
  let sum = 0,
    n = 0;
  const per = new Map<string, number>();
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const d = JSON.parse(line);
    if (d.variant !== "hidden") continue;
    const key = `${d.suite}:${d.seed}`;
    if (!details.has(`${key}:${d.template}`)) {
      const { tasks } = worldOf(d.seed, d.suite, "hidden", { maxTasks: 30, maxOffworld: 0 });
      for (const t of tasks) details.set(`${key}:${t.type}`, t.must[0]!.detail);
    }
    const det = words(details.get(`${key}:${d.template}`)!);
    const txt = words(d.packets.map((p: any) => p.text).join(" "));
    const k = [...det].filter((w) => txt.has(w)).length / det.size;
    per.set(`${key}:${d.template}`, k);
    sum += k;
    n++;
  }
  return { mean: sum / n, n, per };
}
const a = kept(process.argv[2]!),
  b = kept(process.argv[3]!);
let down = 0,
  up = 0;
for (const [k, v] of a.per) {
  const w = b.per.get(k)!;
  if (w < v - 1e-9) down++;
  else if (w > v + 1e-9) up++;
}
console.log({ a: a.mean.toFixed(4), b: b.mean.toFixed(4), n: a.n, tasksDown: down, tasksUp: up });
