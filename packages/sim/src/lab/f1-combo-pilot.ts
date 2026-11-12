/**
 * F1 × F2's combined check-pool pilot (lab only; docs/research/f1-intent-bridge.md §9). The push check's exact
 * prompts for three arms over the same tasks: `base` (the engine's first 15, `--base`), `a` (F2's quota pool, `--q3`,
 * the engine's own views; F2 withdrew it, so §9 passes the base views here) and `b` (`a` plus up to `--k` encoder
 * items above `--floor` not already in it, from `--extras`, the lab's `extras.py` with scores). Arms whose items are
 * the same share one prompt. Hidden and control tasks where `a` or `b` holds the planted item and `base` does not are
 * asked once; `--neutral N` neutral tasks where an arm differs from
 * `base` are asked `--repeat` times each (subagent answers vary; the rule reads the majority).
 *
 *   bun packages/sim/src/lab/f1-combo-pilot.ts --suite dev20 --seeds 41-44 --base B.jsonl --q3 Q.jsonl \
 *     --extras E.json --k 3 --floor 0.84 --neutral 60 --repeat 3 --out PROMPTS.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { cardKey, checkMessages, ItemCache, readerFocus, readerItem } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import { REALISTIC, simSources } from "../sources";
import { buildWorld, NOW } from "../world";
import { clearSlot, dress } from "./hidden-context";
import { variantsFor } from "./neutral";
import { parseSuites, prepareWorld, SUITES } from "./suites";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  if (i >= 0) return args[i + 1]!;
  if (d === undefined) throw new Error(`--${k} is required`);
  return d;
};
const suites = parseSuites(opt("suite"));
if (suites.some((s) => s.includes("heldout"))) throw new Error("held-out suites are never read here");
const [lo, hi] = opt("seeds", "41-44").split("-").map(Number);
const seeds = Array.from({ length: hi! - lo! + 1 }, (_, i) => lo! + i);
const K = Number(opt("k", "3"));
const FLOOR = Number(opt("floor", "0.84"));
const NEUTRAL = Number(opt("neutral", "60"));
const REPEAT = Number(opt("repeat", "3"));
const CHECK_CHARS = 200; // `pushCheckItemChars` in the default

const views = (file: string) => {
  const m = new Map<string, string[]>();
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l) continue;
    const r = JSON.parse(l) as { suite: string; seed: number; variant: string; template: string; view: string[] };
    m.set(`${r.suite}|${r.seed}|${r.variant}|${r.template}`, r.view.slice(0, 15));
  }
  return m;
};
const base = views(opt("base"));
const q3 = views(opt("q3"));
const extras = JSON.parse(readFileSync(opt("extras"), "utf8")) as Record<
  string,
  { top: string[]; score: number[]; planted: string }
>;
let rng = 11;
const rand = () => (rng = (Math.imul(rng, 1103515245) + 12345) >>> 0) / 2 ** 32;

type Row = { key: string; variant: string; arms: string[]; planted: string; ids: string[]; user: string; r: number };
const out: (Row & { id: string })[] = [];
const neutral: Row[][] = [];
let system = "";
for (const suite of suites) {
  for (const variant of variantsFor(suite, ["hidden", "control", "neutral"] as const)) {
    for (const seed of seeds) {
      const world = buildWorld({ seed: seed * 1_000 });
      prepareWorld(suite, world, seed);
      const before = world.items.length;
      const tasks = SUITES[suite]!(world, seed, variant);
      const plantedItems = world.items.slice(before);
      for (const it of plantedItems) dress(world, it);
      const keep = new Set(plantedItems.map((it) => it.id));
      for (const task of tasks) clearSlot(world, task.slotText ?? task.text, keep);
      const cached = new ItemCache({ maxItemsPerUser: 100_000 }).put(
        { tenantId: "t", userId: "u" },
        simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll()),
        0,
      );
      const byId = new Map<string, ContextItem>(cached.map((it) => [it.id, it]));
      const byHash = new Map<string, ContextItem>(cached.map((it) => [cardKey(it), it]));
      for (const t of tasks) {
        const key = `${suite}|${seed}|${variant}|${t.template}`;
        const b0 = base.get(key);
        const a0 = q3.get(key);
        const e = extras[key];
        if (!b0 || !a0 || !e) continue;
        const add = e.top
          .map((h, i) => ({ it: byHash.get(h), s: e.score[i]! }))
          .filter((x) => x.it && x.s >= FLOOR && !a0.includes(x.it.id))
          .slice(0, K)
          .map((x) => x.it!.id);
        const arms: Record<string, string[]> = { base: b0, a: a0, b: [...a0, ...add] };
        const plantedId = byHash.get(e.planted)?.id ?? "";
        if (variant !== "neutral") {
          if (b0.includes(plantedId) || !(arms.a!.includes(plantedId) || arms.b!.includes(plantedId))) continue;
        } else if (arms.a!.join() === b0.join() && arms.b!.join() === b0.join()) continue;
        // One prompt per distinct item list; the arms that read it share its answers.
        const lists = new Map<string, string[]>();
        for (const [arm, ids] of Object.entries(arms)) lists.set(ids.join(), [...(lists.get(ids.join()) ?? []), arm]);
        const focus = readerFocus(t.text);
        const rows: Row[] = [];
        for (const [joined, armsOf] of lists) {
          if (variant !== "neutral" && !joined.split(",").includes(plantedId)) continue; // base cannot name it
          const items = joined
            .split(",")
            .map((id) => byId.get(id))
            .filter((x): x is ContextItem => !!x);
          const msgs = checkMessages({
            request: sanitizeForStore(t.text),
            items: items.map((it) => readerItem(it, focus, undefined, CHECK_CHARS)),
            today: new Date(NOW).toISOString().slice(0, 10),
          });
          system = msgs[0]!.content;
          const reps = variant === "neutral" ? REPEAT : 1;
          for (let r = 0; r < reps; r++)
            rows.push({
              key,
              variant,
              arms: armsOf,
              planted: plantedId,
              ids: items.map((it) => it.id),
              user: msgs[1]!.content,
              r,
            });
        }
        if (variant === "neutral") neutral.push(rows);
        else for (const row of rows) out.push({ ...row, id: `${out.length}` });
      }
    }
  }
}
// The neutral sample: `--neutral` tasks at random from those an arm changes.
const picked = neutral
  .map((rows) => ({ rows, u: rand() }))
  .sort((x, y) => x.u - y.u)
  .slice(0, NEUTRAL);
for (const { rows } of picked) for (const row of rows) out.push({ ...row, id: `${out.length}` });
writeFileSync(opt("out"), JSON.stringify({ system, prompts: out }));
const counts = new Map<string, number>();
for (const o of out)
  counts.set(`${o.variant}/${o.arms.join("+")}`, (counts.get(`${o.variant}/${o.arms.join("+")}`) ?? 0) + 1);
console.log(
  `${out.length} prompts (${neutral.length} neutral tasks changed) -> ${opt("out")}`,
  [...counts].map(([k, n]) => `${k} ${n}`).join(", "),
);
