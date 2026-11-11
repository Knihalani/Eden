/**
 * M11's training and screening export (lab only; docs/research/m11-intent.md). For each suite × seed × variant world,
 * as the funnel builds it (`syncItems` in cards-distill.ts), writes:
 *
 * - `items.jsonl`: every distinct cached item by card key (`h`, title, text, source kind) once, with the requests the
 *   checked-in Haiku caches hold for it (`full`: intent-v2, every item read; `shipped`: cards-shipped, what the shipped
 *   enricher read), when they do;
 * - `worlds.jsonl`: each world's item keys and its tasks (request text, template, planted keys).
 *
 * The fact of a hidden world and the look-alike of the control world of the same suite, seed and template are twins.
 * Usage: bun packages/sim/src/lab/m11-export.ts --suites train,reworded,longtail --seeds 41-44 --out .local/m11/x
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardKey, intentTerms, ItemCache } from "@eden/engine";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { INTENT_PATH, loadRequests, SHIPPED_PATH } from "./cards-disk";
import { clearSlot, dress } from "./hidden-context";
import { variantsFor } from "./neutral";
import { parseSuites, prepareWorld, SUITES } from "./suites";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const suites = parseSuites(opt("suites", "train"));
if (suites.some((s) => s.includes("heldout19"))) throw new Error("heldout19 is never read (M11's brief)");
const seedArg = opt("seeds", "41-44");
const seeds = seedArg.includes("-")
  ? (() => {
      const [a, b] = seedArg.split("-").map(Number);
      return Array.from({ length: b! - a! + 1 }, (_, i) => a! + i);
    })()
  : seedArg.split(",").map(Number);
const out = opt("out", ".local/m11/export");
mkdirSync(out, { recursive: true });

const full = loadRequests(INTENT_PATH);
const shipped = loadRequests(SHIPPED_PATH);
const items = new Map<string, { h: string; title: string; text: string; src: string }>();
const worlds: string[] = [];
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
      const cache = new ItemCache({ maxItemsPerUser: 100_000 });
      const raw = simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll());
      const keyOf = new Map<string, string>();
      const hashes: string[] = [];
      for (const it of cache.put({ tenantId: "t", userId: "u" }, raw, 0)) {
        const h = cardKey(it);
        keyOf.set(it.id, h);
        hashes.push(h);
        if (!items.has(h)) items.set(h, { h, title: it.title, text: it.text, src: it.sourceId });
      }
      // A task's planted items: the world's planted ids, in task order (one planted item per task in these suites).
      const plantedKeys = plantedItems.map((p) => keyOf.get(`${p.sourceId}:${p.id}`) ?? findKey(keyOf, p.id));
      worlds.push(
        JSON.stringify({
          suite,
          seed,
          variant,
          hashes,
          planted: plantedKeys.filter(Boolean),
          tasks: tasks.map((t, i) => ({
            template: t.template,
            request: t.text,
            terms: intentTerms(t.text),
            planted: plantedKeys[i] ?? null,
          })),
        }),
      );
    }
  }
}

function findKey(keyOf: Map<string, string>, id: string): string | undefined {
  for (const [k, h] of keyOf) if (k === id || k.endsWith(`:${id}`) || k.endsWith(id)) return h;
  return undefined;
}

writeFileSync(
  join(out, "items.jsonl"),
  [...items.values()]
    .map((it) =>
      JSON.stringify({
        ...it,
        terms: intentTerms(`${it.title}\n${it.text}`),
        titleTerms: intentTerms(it.title),
        full: full.get(it.h) ?? null,
        shipped: shipped.get(it.h) ?? null,
        fullTerms: full.get(it.h)?.map((r) => intentTerms(r)) ?? null,
        shippedTerms: shipped.get(it.h)?.map((r) => intentTerms(r)) ?? null,
      }),
    )
    .join("\n") + "\n",
);
writeFileSync(join(out, "worlds.jsonl"), worlds.join("\n") + "\n");
console.log(`${items.size} items, ${worlds.length} worlds -> ${out}`);
