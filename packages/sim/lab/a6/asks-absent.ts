// A6 (docs/research/a6-moonshots.md): of a Pi run's `ask_context` questions, how many name an entity no item of the
// task's world names (the agent hunting for what the simulated user's sources do not hold). $0.
// bun packages/sim/lab/a6/asks-absent.ts RUN.tl/tasks.jsonl [condition]
import { readFileSync } from "node:fs";
import { extractTypedEntities } from "@eden/engine";
import { worldOf } from "../../src/lab/ab-common";

const rows = readFileSync(process.argv[2]!, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const want = process.argv[3] ?? "eden";
const worlds = new Map<string, string[]>();
const textsOf = (seed: number, suite: string, variant: "hidden" | "control" | "neutral") => {
  const k = `${seed}:${suite}:${variant}`;
  if (!worlds.has(k)) {
    const { world } = worldOf(seed, suite, variant, { maxTasks: 1e9, maxOffworld: 0 });
    worlds.set(
      k,
      world.items.map((i) => `${i.title}\n${i.text}`.toLowerCase()),
    );
  }
  return worlds.get(k)!;
};
// A sentence-initial verb and a possessive are not part of the name ("Find Ellie", "Mum's").
const named = (q: string, e: string) => {
  let w = e.replace(/['’]s$/, "").split(/\s+/);
  if (w.length > 1 && /^(Find|Who|What|When|Where|Is|Are|Any|Does|Do|Check|Search|Look|Get|Show|List)$/.test(w[0]!))
    w = w.slice(1);
  return w.join(" ");
};
const by: Record<string, { asks: number; absent: number; tasks: number; asking: number }> = {};
for (const r of rows) {
  if (r.condition !== want) continue;
  const o = (by[r.kind] ??= { asks: 0, absent: 0, tasks: 0, asking: 0 });
  o.tasks++;
  const qs = r.events.filter((e: any) => e.ev === "eden.ask" && e.ph === "I").map((e: any) => e.data.question);
  if (qs.length) o.asking++;
  const suite = r.task.split(":")[1].replace(/-(control|neutral)$/, "");
  const texts = textsOf(r.seed, suite, r.kind);
  for (const q of qs) {
    o.asks++;
    const ents = extractTypedEntities(q)
      .filter((e) => e.kind !== "url")
      .map((e) => named(q, e.text))
      .filter((e) => e.length > 2);
    if (ents.some((e) => !texts.some((x) => x.includes(e.toLowerCase())))) o.absent++;
  }
}
console.log(JSON.stringify(by));
