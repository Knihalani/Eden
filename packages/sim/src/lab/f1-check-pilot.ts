/**
 * F1's subagent-simulated pilot of encoder candidates in the push check (lab only; docs/research/f1-intent-bridge.md).
 * Builds the push check's exact prompts (`checkMessages`, `readerItem`, `readerFocus`) for a sample of tasks: each
 * task's push pool as the funnel dumped it (its first 15, `pushCheckItems`) and, for the `ext` arm, up to `--extra` of
 * an encoder's top items (by content hash, `--extras F` from the lab's `extras.py`) not already in it. Worlds are
 * rebuilt as the funnel builds them (m11-export.ts's path), so items carry their own dates and senders.
 *
 *   bun packages/sim/src/lab/f1-check-pilot.ts --suite dev20 --seeds 41-44 --pools POOL.jsonl --extras E.json \
 *     --extra 5 --sample hidden:all-planted-added,control:all-planted-added,neutral:40 --out PROMPTS.json
 */
import { writeFileSync, readFileSync } from "node:fs";
import { cardKey, checkMessages, ItemCache, readerFocus, readerItem } from "@eden/engine";
import { sanitizeForStore } from "@eden/redact";
import type { ContextItem } from "@eden/protocol";
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
const EXTRA = Number(opt("extra", "5"));
const PUSH_ITEMS = 15;
const CHECK_CHARS = 200; // `pushCheckItemChars` in the default
const extras = JSON.parse(readFileSync(opt("extras"), "utf8")) as Record<string, { top: string[]; planted: string }>;
const pools = new Map<string, { pool: string[]; planted: string; request: string }>();
for (const l of readFileSync(opt("pools"), "utf8").split("\n")) {
  if (!l) continue;
  const r = JSON.parse(l) as {
    suite: string;
    seed: number;
    variant: string;
    template: string;
    request: string;
    planted: string;
    pool: { id: string }[];
  };
  pools.set(`${r.suite}|${r.seed}|${r.variant}|${r.template}`, {
    pool: r.pool.map((p) => p.id),
    planted: r.planted,
    request: r.request,
  });
}
// Sampling: "<variant>:added" takes every task whose encoder extras hold its planted item; "<variant>:N" N at random.
const sample = new Map(
  opt("sample")
    .split(",")
    .map((x) => x.split(":") as [string, string]),
);
let rng = 7;
const rand = () => (rng = (Math.imul(rng, 1103515245) + 12345) >>> 0) / 2 ** 32;

const out: {
  id: string;
  suite: string;
  seed: number;
  variant: string;
  template: string;
  arm: string;
  planted: string;
  ids: string[];
  user: string;
}[] = [];
let system = "";
for (const suite of suites) {
  for (const variant of variantsFor(suite, ["hidden", "control", "neutral"] as const)) {
    const want = sample.get(variant);
    if (!want) continue;
    for (const seed of seeds) {
      const world = buildWorld({ seed: seed * 1_000 });
      prepareWorld(suite, world, seed);
      const before = world.items.length;
      const tasks = SUITES[suite]!(world, seed, variant);
      const planted = world.items.slice(before);
      for (const it of planted) dress(world, it);
      const keep = new Set(planted.map((it) => it.id));
      for (const task of tasks) clearSlot(world, task.slotText ?? task.text, keep);
      const cache = new ItemCache({ maxItemsPerUser: 100_000 });
      const cached = cache.put(
        { tenantId: "t", userId: "u" },
        simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll()),
        0,
      );
      const byId = new Map<string, ContextItem>(cached.map((it) => [it.id, it]));
      const byHash = new Map<string, ContextItem>(cached.map((it) => [cardKey(it), it]));
      for (const t of tasks) {
        const key = `${suite}|${seed}|${variant}|${t.template}`;
        const p = pools.get(key);
        const e = extras[key];
        if (!p || !e) continue;
        const head = p.pool.slice(0, PUSH_ITEMS);
        const add = e.top
          .map((h) => byHash.get(h))
          .filter((it): it is ContextItem => !!it && !head.includes(it.id))
          .slice(0, EXTRA);
        const plantedHash = e.planted;
        const added = add.some((it) => cardKey(it) === plantedHash);
        if (want === "added" ? !added : rand() > Number(want) / 160) continue;
        const focus = readerFocus(t.text);
        const arms: [string, ContextItem[]][] = [
          ["ext", [...head.map((id) => byId.get(id)).filter((x): x is ContextItem => !!x), ...add]],
        ];
        if (variant === "neutral")
          arms.push(["base", head.map((id) => byId.get(id)).filter((x): x is ContextItem => !!x)]);
        for (const [arm, items] of arms) {
          const msgs = checkMessages({
            request: sanitizeForStore(t.text),
            items: items.map((it) => readerItem(it, focus, undefined, CHECK_CHARS)),
            today: new Date(NOW).toISOString().slice(0, 10),
          });
          system = msgs[0]!.content;
          out.push({
            id: `${out.length}`,
            suite,
            seed,
            variant,
            template: t.template,
            arm,
            planted: items.find((it) => cardKey(it) === plantedHash)?.id ?? "",
            ids: items.map((it) => it.id),
            user: msgs[1]!.content,
          });
        }
      }
    }
  }
}
writeFileSync(opt("out"), JSON.stringify({ system, prompts: out }));
const counts = new Map<string, number>();
for (const o of out) counts.set(`${o.variant}/${o.arm}`, (counts.get(`${o.variant}/${o.arm}`) ?? 0) + 1);
console.log(`${out.length} prompts -> ${opt("out")}`, [...counts].map(([k, n]) => `${k} ${n}`).join(", "));
