// A6 (docs/research/a6-moonshots.md): how many of a request's named entities no item of its world names, per train
// task kind. $0, no engine. bun packages/sim/lab/a6/census.ts [--dress] (D287's dressed worlds)
import { extractTypedEntities } from "@eden/engine";
import { worldOf } from "../../src/lab/ab-common";

/** The entity as a census would name it: a leading imperative verb and a possessive taken off. */
const named = (t: string, e: string) => {
  let w = e.replace(/['’]s$/, "").split(/\s+/);
  if (w.length > 1 && t.trimStart().startsWith(w[0]!)) w = w.slice(1);
  return w.join(" ");
};

const DRESS = process.argv.includes("--dress");
const suites = ["train1", "train2", "train3", "train4", "train5", "train6"];
const out: Record<string, { tasks: number; withAbsent: number; ents: number; absent: number }> = {};
for (const seed of [41, 42])
  for (const suite of suites)
    for (const variant of ["hidden", "control", "neutral"] as const) {
      const { world, tasks } = worldOf(seed, suite, variant, { maxTasks: 1e9, maxOffworld: 0 }, { dress: DRESS });
      const texts = world.items.map((i) => `${i.title}\n${i.text}`.toLowerCase());
      const o = (out[variant] ??= { tasks: 0, withAbsent: 0, ents: 0, absent: 0 });
      for (const t of tasks) {
        const ents = extractTypedEntities(t.text)
          .filter((e) => e.kind !== "url")
          .map((e) => ({ ...e, text: named(t.text, e.text) }));
        const miss = ents.filter((e) => !texts.some((x) => x.includes(e.text.toLowerCase())));
        o.tasks++;
        o.ents += ents.length;
        o.absent += miss.length;
        if (miss.length > 0) o.withAbsent++;
      }
    }
console.log(JSON.stringify(out, null, 1));
if (process.argv[2] === "--show") {
  const { world, tasks } = worldOf(41, process.argv[3] ?? "train4", "hidden", { maxTasks: 1e9, maxOffworld: 0 });
  const texts = world.items.map((i) => `${i.title}\n${i.text}`.toLowerCase());
  for (const t of tasks.slice(0, 8)) {
    const ents = extractTypedEntities(t.text)
      .filter((e) => e.kind !== "url")
      .map((e) => ({ ...e, text: named(t.text, e.text) }));
    console.log(
      t.text,
      "\n   ",
      ents.map((e) => `${e.text}:${texts.filter((x) => x.includes(e.text.toLowerCase())).length}`),
    );
  }
}
