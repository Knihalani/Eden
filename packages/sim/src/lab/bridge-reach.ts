#!/usr/bin/env bun
/**
 * Offline reach of bridging queries (docs/research/edge-bridge.md): for each task of the suites, the user's whole
 * world in an index (as a finished sync holds it), the request's cached queries (`bridge-enrich.ts`) run as the
 * engine runs them (`ContextPartner.bridgeFinds`: each query's best items holding two of its words), and where the
 * planted item (hidden) or the decoy (control) ranks. No model, no engine decision: what the queries can reach.
 *
 *   bun packages/sim/src/lab/bridge-reach.ts --bridge FILE [--suite dev6a,dev6b] [--seeds 41,42,43,44] [--k 3]
 */
import { bridgeKey, ItemCache, termIds } from "@eden/engine";
import { isStopword } from "../../../engine/src/text";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { loadBridge } from "./bridge-disk";
import { clearSlot, dress } from "./hidden-context";
import { parseSuites, SUITES } from "./suites";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const bridge = loadBridge(opt("bridge", ""));
const SUITE_LIST = parseSuites(opt("suite", "dev6a,dev6b"));
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
const K = Number(opt("k", "3"));
const DEPTH = 50;
/** `--base run.json` (a funnel `--json` with `--ask`): splits the counts by whether that run surfaced the item. */
const BASE = opt("base", "");
const surfaced = new Set<string>();
if (BASE) {
  const j = JSON.parse(await Bun.file(BASE).text()) as {
    perTask: {
      suite: string;
      seed: number;
      variant: string;
      template: string;
      delivered: boolean;
      askCited?: boolean;
    }[];
  };
  for (const t of j.perTask)
    if (t.delivered || t.askCited) surfaced.add(`${t.suite}/${t.seed}/${t.variant}/${t.template}`);
}

const out: Record<string, number> = {};
const inc = (k: string) => (out[k] = (out[k] ?? 0) + 1);
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
      const scope = { tenantId: "t", userId: `w${seed}` };
      const cache = new ItemCache({ maxItemsPerUser: 100_000 });
      cache.put(
        scope,
        simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll()),
        world.now,
      );
      const vocab = cache.peekVocab(scope)!;
      for (const [i, task] of tasks.entries()) {
        const id = planted[i]!.id;
        const qs = bridge.get(bridgeKey(task.text));
        if (!qs) {
          inc(`${variant}.unbridged`);
          continue;
        }
        inc(`${variant}.bridged`);
        let best = Infinity;
        let found = false;
        for (const q of qs) {
          const t = termIds(q, vocab, false);
          const terms: number[] = [];
          for (let j = 0; j < t.n; j++)
            if (!isStopword(vocab.term(t.ids[j]!)) && !terms.includes(t.ids[j]!)) terms.push(t.ids[j]!);
          if (terms.length === 0) continue;
          const need = Math.min(2, terms.length);
          const hits = cache.search(scope, terms, terms.length, DEPTH, world.now).filter((h) => h.matched >= need);
          const r = hits.findIndex((h) => h.item.id === id);
          if (r >= 0) best = Math.min(best, r);
          if (r >= 0 && r < K) found = true;
        }
        if (found) inc(`${variant}.foundTop${K}`);
        const was = surfaced.has(`${suite}/${seed}/${variant}/${task.template}`);
        if (BASE && found && !was) inc(`${variant}.foundTop${K}.newToBase`);
        if (best < 10) inc(`${variant}.top10`);
        if (best < DEPTH) inc(`${variant}.top${DEPTH}`);
        if (args.includes("--verbose") && variant === "hidden" && seed === SEEDS[0])
          console.log(`${found ? "+" : best < DEPTH ? `~${best}` : "-"} ${task.template}: ${qs.join(" | ")}`);
      }
    }
  }
}
console.log(JSON.stringify(out));
