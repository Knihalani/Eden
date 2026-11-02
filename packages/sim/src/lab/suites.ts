/**
 * The hidden-context suites by name, so every lab tool (agent-ab.ts, hidden-funnel.ts, bench.ts) can run any of them
 * and several at once. Each planting function adds one item per template to the world, in template order, and
 * returns the matching tasks; their ids carry the suite name (`w41:heldout2:<template>`).
 */
import type { World } from "../world";
import { plantHidden, type HiddenTask } from "./hidden-context";
import { plantDev6a } from "./hidden-dev6a";
import { plantDev6b } from "./hidden-dev6b";
import { plantHeldout } from "./hidden-heldout";
import { plantHeldout2 } from "./hidden-heldout2";
import { plantHeldout3 } from "./hidden-heldout3";
import { plantHeldout4 } from "./hidden-heldout4";
import { plantHeldout5 } from "./hidden-heldout5";
import { plantHeldout6 } from "./hidden-heldout6";
import { plantHeldout7 } from "./hidden-heldout7";
import { plantHeldout8 } from "./hidden-heldout8";
import { plantHeldout9 } from "./hidden-heldout9";
import { plantHeldout10 } from "./hidden-heldout10";
import { plantHeldout11 } from "./hidden-heldout11";
import { plantHeldout12 } from "./hidden-heldout12";
import { plantTrain1 } from "./hidden-train1";
import { plantTrain2 } from "./hidden-train2";
import { plantTrain3 } from "./hidden-train3";
import { plantTrain4 } from "./hidden-train4";
import { plantTrain5 } from "./hidden-train5";
import { plantTrain6 } from "./hidden-train6";

export type { HiddenTask };
export type Variant = "hidden" | "control";
export type Plant = (world: World, seed: number, variant: Variant) => HiddenTask[];

export const SUITES: Record<string, Plant> = {
  hidden: plantHidden,
  heldout: plantHeldout,
  heldout2: plantHeldout2,
  heldout3: plantHeldout3,
  heldout4: plantHeldout4,
  // Written after D47, blind to the engine and to every other suite; never tuned on (docs/research/lean-probes.md).
  heldout5: plantHeldout5,
  // Written after D48 for the D49-D53 work, blind to the engine and to every other suite; measurement only.
  heldout6: plantHeldout6,
  // Written after D53, blind to the engine and to every other suite; measurement only.
  heldout7: plantHeldout7,
  // Written after D55, blind to the engine and to every other suite; measurement only.
  heldout8: plantHeldout8,
  // Written for the econ tracks, blind to the engine and to every other suite; registered unread, measurement
  // only: never run it while tuning.
  heldout9: plantHeldout9,
  // development suites, written after D72; tune on them.
  dev6a: plantDev6a,
  dev6b: plantDev6b,
  // Blind, written after D79 by an author who saw no other suite; measurement only.
  heldout10: plantHeldout10,
  // blind, written after D80; measurement only
  heldout11: plantHeldout11,
  // blind, written after D85; measurement only
  heldout12: plantHeldout12,
  // The broad tuning set: six suites written blind (each author saw only the world generator, the text helpers and
  // the HiddenTask interface), one life area each, so a change must generalise across authors to show up. Tune on them.
  train1: plantTrain1,
  train2: plantTrain2,
  train3: plantTrain3,
  train4: plantTrain4,
  train5: plantTrain5,
  train6: plantTrain6,
};
export const SUITE_NAMES = Object.keys(SUITES);
const HELDOUT_ALL = ["heldout", "heldout2", "heldout3", "heldout4"];
const TRAIN = ["train1", "train2", "train3", "train4", "train5", "train6"];
/**
 * Blind suites that have never been run: left out of `all`, so a tuning command with `--suite all` cannot spend them;
 * the blind run names them. A suite leaves this list once its blind run is recorded.
 */
export const UNRUN_BLIND = ["heldout9", "heldout10", "heldout11", "heldout12"];
const ALL = SUITE_NAMES.filter((n) => !UNRUN_BLIND.includes(n));

/**
 * A `--suite` value: a comma list of suite names, `all` (every suite but the unrun blind ones), `heldout-all`, or
 * `train` (the six broad tuning suites);
 * unknown names throw. Deduplicated.
 */
export function parseSuites(arg: string): string[] {
  const out: string[] = [];
  for (const raw of arg.split(",")) {
    const name = raw.trim();
    if (!name) continue;
    const names = name === "all" ? ALL : name === "heldout-all" ? HELDOUT_ALL : name === "train" ? TRAIN : [name];
    for (const n of names) {
      if (!(n in SUITES))
        throw new Error(`unknown suite "${n}" (known: ${SUITE_NAMES.join(", ")}, all, heldout-all, train)`);
      if (!out.includes(n)) out.push(n);
    }
  }
  if (!out.length) throw new Error("no suite given");
  return out;
}
