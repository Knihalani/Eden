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
import { plantHeldout13 } from "./hidden-heldout13";
import { plantHeldout14 } from "./hidden-heldout14";
import { plantHeldout15 } from "./hidden-heldout15";
import { plantHeldout16 } from "./hidden-heldout16";
import { plantHeldout17 } from "./hidden-heldout17";
import { plantTrain1 } from "./hidden-train1";
import { plantTrain2 } from "./hidden-train2";
import { plantTrain3 } from "./hidden-train3";
import { plantTrain4 } from "./hidden-train4";
import { plantTrain5 } from "./hidden-train5";
import { plantTrain6 } from "./hidden-train6";

export type { HiddenTask };
/** `neutral` (RealUse-1): the same requests, nothing planted; only suites in NEUTRAL_SUITES build it (neutral.ts). */
export type Variant = "hidden" | "control" | "neutral";
export type Plant = (world: World, seed: number, variant: Variant) => HiddenTask[];

/** A suite written before `neutral`: asking it for one throws (it would read any variant but hidden as the control). */
const twoVariant =
  (name: string, plant: (world: World, seed: number, variant: "hidden" | "control") => HiddenTask[]): Plant =>
  (world, seed, variant) => {
    if (variant === "neutral") throw new Error(`${name} builds no neutral variant (neutral.ts NEUTRAL_SUITES)`);
    return plant(world, seed, variant);
  };

/**
 * A two-variant suite given the `neutral` variant without touching its file (CL5, docs/research/cl-cl5.md): the
 * control is planted and its item taken out again, so the request text and every RNG draw are the control's (and the
 * hidden's: both are built every time), the world is the base world, and the ids read `<suite>-neutral`. Valid only
 * for a planting function that adds items at the end of `world.items` and touches nothing else (the train suites do;
 * suites.test.ts checks that the neutral world equals the unplanted one).
 */
const withNeutral =
  (name: string, plant: (world: World, seed: number, variant: "hidden" | "control") => HiddenTask[]): Plant =>
  (world, seed, variant) => {
    if (variant !== "neutral") return plant(world, seed, variant);
    const before = world.items.length;
    const tasks = plant(world, seed, "control");
    world.items.length = before;
    const from = `:${name}-control:`;
    return tasks.map((t) => {
      if (!t.id.includes(from)) throw new Error(`${name}: control id ${t.id} lacks ${from}`);
      return { ...t, id: t.id.replace(from, `:${name}-neutral:`) };
    });
  };

export const SUITES: Record<string, Plant> = {
  hidden: twoVariant("hidden", plantHidden),
  heldout: twoVariant("heldout", plantHeldout),
  heldout2: twoVariant("heldout2", plantHeldout2),
  heldout3: twoVariant("heldout3", plantHeldout3),
  heldout4: twoVariant("heldout4", plantHeldout4),
  // Written after D47, blind to the engine and to every other suite; never tuned on (docs/research/lean-probes.md).
  heldout5: twoVariant("heldout5", plantHeldout5),
  // Written after D48 for the D49-D53 work, blind to the engine and to every other suite; measurement only.
  heldout6: twoVariant("heldout6", plantHeldout6),
  // Written after D53, blind to the engine and to every other suite; measurement only.
  heldout7: twoVariant("heldout7", plantHeldout7),
  // Written after D55, blind to the engine and to every other suite; measurement only.
  heldout8: twoVariant("heldout8", plantHeldout8),
  // Written for the econ tracks, blind to the engine and to every other suite; registered unread, measurement
  // only: never run it while tuning.
  heldout9: twoVariant("heldout9", plantHeldout9),
  // development suites, written after D72; tune on them.
  dev6a: twoVariant("dev6a", plantDev6a),
  dev6b: twoVariant("dev6b", plantDev6b),
  // Blind, written after D79 by an author who saw no other suite; measurement only.
  heldout10: twoVariant("heldout10", plantHeldout10),
  // blind, written after D80; measurement only
  heldout11: twoVariant("heldout11", plantHeldout11),
  // blind, written after D85; measurement only
  heldout12: twoVariant("heldout12", plantHeldout12),
  // blind, written for the Haiku phase 3 by an author who saw only the world generator, the text helpers and the
  // HiddenTask interface; registered unread, measurement only: run once, at the end of phase 3
  heldout13: twoVariant("heldout13", plantHeldout13),
  // RealUse-1's blind suite, written by an author who saw only heldout13's format, this registry, the sim world API
  // and the benchmark's design (docs/research/benchmark-realuse-1.md); the first suite with a `neutral` variant.
  // Measurement only: run once for RealUse-1, never tune on it.
  heldout14: plantHeldout14,
  // The weak-points plan's blind suite (docs/research/realuse-1-weak-points.md, issue 12), written by an author who saw
  // only heldout14's format, the HiddenTask interface, the sim world API and RealUse-1's design; with `neutral`.
  // Reserved for wave 2's final blind confirmation: do not run it (funnel or agent) before then, never tune on it.
  heldout15: plantHeldout15,
  // The CL wave's blind suite (H17, docs/research/cl-cl5.md), written by an author who saw only heldout15's format,
  // the HiddenTask interface, the sim world API and the CL goal; with `neutral`. Reserved for the CL combination's
  // final blind check: do not run it (funnel or agent) before then, never tune on it.
  heldout16: plantHeldout16,
  // The end-of-day confirmation's blind suite (D350, docs/research/a19-heldout17.md), written by an author who saw only
  // heldout16's format, the HiddenTask interface, the sim world API and a short brief; with `neutral`, and eight
  // templates whose fact reads as arriving later that day (`HELDOUT17_LATE`, for `pi-ab --late`). Reserved for the
  // end-of-day confirmation: do not run it (funnel or agent) before then, never tune on it.
  heldout17: plantHeldout17,
  // The broad tuning set: six suites written blind (each author saw only the world generator, the text helpers and
  // the HiddenTask interface), one life area each, so a change must generalise across authors to show up. Tune on them.
  train1: withNeutral("train1", plantTrain1),
  train2: withNeutral("train2", plantTrain2),
  train3: withNeutral("train3", plantTrain3),
  train4: withNeutral("train4", plantTrain4),
  train5: withNeutral("train5", plantTrain5),
  train6: withNeutral("train6", plantTrain6),
};
export const SUITE_NAMES = Object.keys(SUITES);
const HELDOUT_ALL = ["heldout", "heldout2", "heldout3", "heldout4"];
const TRAIN = ["train1", "train2", "train3", "train4", "train5", "train6"];
/**
 * Held-out suites kept out of `all` so a tuning command cannot spend them; held-out 9-13 have been read (D72, D80,
 * D85, D98, D112) and a blind round needs a new suite. Held-out 14 is RealUse-1's blind suite (run once for it);
 * held-out 15 was RealUse-2's (run once); held-out 16 was the CL wave's final check (RealUse-3); held-out 17 is
 * unrun, reserved for the end-of-day confirmation. A run names them to measure on them (with `--blind`).
 */
export const UNRUN_BLIND = [
  "heldout9",
  "heldout10",
  "heldout11",
  "heldout12",
  "heldout13",
  "heldout14",
  "heldout15",
  "heldout16",
  "heldout17",
];
const ALL = SUITE_NAMES.filter((n) => !UNRUN_BLIND.includes(n));

/**
 * A `--suite` value: a comma list of suite names, `all` (every suite but those in UNRUN_BLIND), `heldout-all`, or
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
