#!/usr/bin/env bun
/**
 * A census of what card enrichment reads (docs/research/econ-background.md): for each simulated user of the funnel
 * (suite × variant × seed, as hidden-funnel builds them), every item a sync would list, redacted as the cache redacts
 * it, with its age, whether the no-model prefilter passes it, the eager rule (`cardEager`) and the card the disk cache
 * replays for it (constraint, none, or uncovered). No model call.
 *
 *   bun packages/sim/src/lab/cards-census.ts --cards packages/sim/lab/cards/cards-v2.jsonl
 *     [--suite hidden,heldout,heldout2,heldout3,heldout4] [--seeds 41,42,43,44] [--json out.json]
 *     [--dump items.jsonl]
 *
 * `--dump` writes one line per prefilter-passing item (its hash, source, age, title, own text's head, planted or not,
 * the replayed card's kind and actions): lab worlds only, never user data.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { cardKey, ItemCache, worthCarding, worthCardingStrict } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
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
const cards = loadCards(opt("cards", "packages/sim/lab/cards/cards-v2.jsonl"));
const SUITE_LIST = parseSuites(opt("suite", "hidden,heldout,heldout2,heldout3,heldout4"));
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
const DAY = 86_400_000;
const DUMP = opt("dump", "");
if (DUMP) writeFileSync(DUMP, "");

interface Tally {
  users: number;
  items: number;
  passed: number;
  eager: number;
  constraint: number;
  constraintEager: number;
  planted: number;
  plantedPassed: number;
  plantedEager: number;
  plantedConstraint: number;
  plantedConstraintEager: number;
  ageBuckets: Record<string, number>;
  constraintAge: Record<string, number>;
}
const t: Tally = {
  users: 0,
  items: 0,
  passed: 0,
  eager: 0,
  constraint: 0,
  constraintEager: 0,
  planted: 0,
  plantedPassed: 0,
  plantedEager: 0,
  plantedConstraint: 0,
  plantedConstraintEager: 0,
  ageBuckets: {},
  constraintAge: {},
};
const bucket = (ageDays: number) =>
  ageDays < 0 ? "future" : ageDays <= 7 ? "0-7" : ageDays <= 30 ? "8-30" : ageDays <= 90 ? "31-90" : ">90";

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
      const cache = new ItemCache({ maxItemsPerUser: 100_000 });
      const raw = simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll());
      const items: ContextItem[] = cache.put({ tenantId: "t", userId: "u" }, raw, world.now);
      t.users++;
      for (const it of items) {
        const isPlanted = keep.has(it.id);
        const pass = worthCarding(it);
        const eager = pass && worthCardingStrict(it);
        const c = cards.get(cardKey(it));
        const constraint = !!c && c.kind !== "none";
        const age = bucket((world.now - (it.updatedAt ?? world.now)) / DAY);
        t.items++;
        t.ageBuckets[age] = (t.ageBuckets[age] ?? 0) + 1;
        if (pass) t.passed++;
        if (eager) t.eager++;
        if (constraint) {
          t.constraint++;
          t.constraintAge[age] = (t.constraintAge[age] ?? 0) + 1;
          if (eager) t.constraintEager++;
        }
        if (DUMP && pass) {
          const line = {
            h: cardKey(it),
            suite,
            variant,
            seed,
            source: it.sourceId,
            ageDays: Number(((world.now - (it.updatedAt ?? world.now)) / DAY).toFixed(1)),
            planted: isPlanted,
            eager,
            title: it.title.slice(0, 120),
            text: it.text.slice(0, 600),
            kind: c === undefined ? "uncovered" : c === null ? "none" : c.kind,
            actions: c ? c.actions : [],
          };
          appendFileSync(DUMP, `${JSON.stringify(line)}\n`);
        }
        if (isPlanted && variant === "hidden") {
          t.planted++;
          if (pass) t.plantedPassed++;
          if (eager) t.plantedEager++;
          if (constraint) t.plantedConstraint++;
          if (constraint && eager) t.plantedConstraintEager++;
        }
      }
    }
  }
}
const per = (k: number) => Number((k / t.users).toFixed(1));
const out = {
  ...t,
  perUser: {
    items: per(t.items),
    passed: per(t.passed),
    eager: per(t.eager),
    constraint: per(t.constraint),
    constraintEager: per(t.constraintEager),
  },
};
console.log(JSON.stringify(out, null, 2));
const json = opt("json", "");
if (json) writeFileSync(json, JSON.stringify(out, null, 2));
