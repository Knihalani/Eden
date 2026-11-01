#!/usr/bin/env bun
/**
 * Offline check of the active-constraints digest's inputs (docs/research/edge-bridge.md): for each task, whether the
 * planted item (hidden) or decoy (control) has a card in the replay file, its kind, and whether that card is a
 * standing kind in force on the world's day (`DIGEST_KINDS`, `activeOn`), so would be digest-eligible; how many of
 * the user's items are eligible in all (the digest shows `digestLines` of them); and an eligible planted item's rank
 * by the digest's order among the world's own eligible items, the suite's other planted items left out (a suite plants
 * thirty facts into one world at once, where a user would have one or two new ones). No model.
 *
 *   bun packages/sim/src/lab/digest-reach.ts --cards FILE [--suite dev6a,dev6b] [--seeds 41,42,43,44]
 */
import { activeOn, cardKey, DIGEST_KINDS, ItemCache, personalSender } from "@eden/engine";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { loadCards } from "./cards-disk";
import { clearSlot, dress } from "./hidden-context";
import { parseSuites, SUITES } from "./suites";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const cards = loadCards(opt("cards", ""));
const SUITE_LIST = parseSuites(opt("suite", "dev6a,dev6b"));
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
const out: Record<string, number> = {};
const inc = (k: string, by = 1) => (out[k] = (out[k] ?? 0) + by);
for (const suite of SUITE_LIST) {
  for (const variant of ["hidden", "control"] as const) {
    for (const seed of SEEDS) {
      const world = buildWorld({ seed: seed * 1_000 });
      const before = world.items.length;
      const tasks = SUITES[suite]!(world, seed, variant);
      const planted = world.items.slice(before);
      for (const it of planted) dress(world, it);
      const keep = new Set(planted.map((it) => it.id));
      for (const task of tasks) clearSlot(world, task.text, keep);
      const scope = { tenantId: "t", userId: "u" };
      const cache = new ItemCache({ maxItemsPerUser: 100_000 });
      const all = cache.put(
        scope,
        simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll()),
        world.now,
      );
      const today = new Date(world.now).toISOString().slice(0, 10);
      let eligible = 0;
      for (const it of all) {
        const c = cards.get(cardKey(it));
        if (c && DIGEST_KINDS.has(c.kind) && activeOn(c, today)) eligible++;
      }
      inc(`${variant}.eligibleItems`, eligible);
      inc(`${variant}.worlds`);
      const byId = new Map(all.map((it) => [it.id, it]));
      const plantedIds = new Set(planted.map((p) => p.id));
      const key = (it: (typeof all)[number]) =>
        (it.updatedAt ?? 0) + (personalSender(it, (n) => cache.isPerson(scope, n)) ? 7 * 86_400_000 : 0);
      const own = all
        .filter((it) => !plantedIds.has(it.id))
        .filter((it) => {
          const c = cards.get(cardKey(it));
          return !!c && DIGEST_KINDS.has(c.kind) && activeOn(c, today);
        })
        .map(key);
      for (const [i] of tasks.entries()) {
        const it = byId.get(planted[i]!.id);
        if (!it) continue;
        const c = cards.get(cardKey(it));
        if (c === undefined) inc(`${variant}.uncovered`);
        else if (c === null || c.kind === "none") inc(`${variant}.none`);
        else {
          inc(`${variant}.kind.${c.kind}`);
          if (DIGEST_KINDS.has(c.kind) && activeOn(c, today)) {
            inc(`${variant}.eligible`);
            const above = own.filter((k) => k > key(it)).length;
            if (above < 12) inc(`${variant}.isolatedTop12`);
          }
        }
      }
    }
  }
}
console.log(JSON.stringify(out));
