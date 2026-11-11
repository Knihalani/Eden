/**
 * The hidden-context suites by name, so every lab tool (agent-ab.ts, hidden-funnel.ts, bench.ts) can run any of them
 * and several at once. Each planting function adds one item per template to the world, in template order, and
 * returns the matching tasks; their ids carry the suite name (`w41:heldout2:<template>`).
 */
import { addRareSources, RARE_SOURCE_IDS } from "../rare-sources";
import { buildWorld, type World } from "../world";
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
import { plantHeldout18 } from "./hidden-heldout18";
import { plantHeldout19 } from "./hidden-heldout19";
import { plantLongtail } from "./hidden-longtail";
import { REWORDED } from "./reworded";
import { plantTrain1 } from "./hidden-train1";
import { plantTrain2 } from "./hidden-train2";
import { plantTrain3 } from "./hidden-train3";
import { plantTrain4 } from "./hidden-train4";
import { plantTrain5 } from "./hidden-train5";
import { plantTrain6 } from "./hidden-train6";
import { formOf, rewordOf } from "./reword";
import { plantSynth, readWorlds, SAMPLE_PATH, synthPath } from "./synth/suite";

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

/**
 * Suites whose worlds need more than the base world before planting (P7): the rarely used connectors and their filler
 * items (rare-sources.ts). Every harness calls `prepareWorld` right after `buildWorld` and before it notes where the
 * planted items start (`world.items.slice(before)` lines planted items up with tasks), so the filler is part of the
 * base world, in every variant. `needsPrepared` makes a harness that forgot fail loudly instead of misaligning.
 */
const PREPARE: Record<string, (world: World, seed: number) => void> = {
  heldout19: (w, s) => void addRareSources(w, s),
  longtail: (w, s) => void addRareSources(w, s),
};

/** Make `world` what `suite` plants into (a no-op for most suites). Call before taking `world.items.length`. */
export function prepareWorld(suite: string, world: World, seed: number): void {
  PREPARE[suite]?.(world, seed);
}

/** A seed's base world (`buildWorld({ seed: seed * 1_000 })`, as every harness builds it), prepared for `suite`. */
export function preparedWorld(suite: string, seed: number): World {
  const world = buildWorld({ seed: seed * 1_000 });
  prepareWorld(suite, world, seed);
  return world;
}

const needsPrepared =
  (name: string, plant: Plant): Plant =>
  (world, seed, variant) => {
    if (!RARE_SOURCE_IDS.every((id) => id in world.sources))
      throw new Error(`${name}: call prepareWorld("${name}", world, seed) before planting (suites.ts)`);
    return plant(world, seed, variant);
  };

/**
 * A train suite with its requests reworded (P7, D871; B4 in docs/research/weak-points-1111.md): the same worlds, items
 * and decoys, each request's text rewritten as a need, a plan or a question, six of each suite's 32 in another
 * language (`REWORDED`, reworded.ts: a pattern over the original text whose captures carry the seed's names). Ids read
 * `<suite>r`, so a run can name both. The worlds are the original suite's, so its card and intent replays cover them.
 */
const reworded =
  (name: string, base: string): Plant =>
  (world, seed, variant) => {
    const table = REWORDED[base];
    if (!table) throw new Error(`${name}: no rewordings for ${base} (reworded.ts)`);
    return SUITES[base]!(world, seed, variant).map((t) => {
      const w = table[t.template];
      if (!w) throw new Error(`${name}: no rewording for ${t.template}`);
      const re = new RegExp(`^(?:${w.re})$`);
      if (!re.test(t.text)) throw new Error(`${name}: ${t.template}'s request no longer matches its rewording`);
      // `$n` is capture n; any other `$` (a "$40k" in the text) stays as written.
      const groups = re.exec(t.text)!;
      const text = w.to.replace(/\$(\d)/g, (all, d: string) => groups[Number(d)] ?? all);
      return { ...t, id: t.id.replace(`:${base}`, `:${name}`), text, slotText: t.text };
    });
  };

/**
 * P2 (Q6, `reword.ts`): a train suite with its requests reworded into indirect forms ("I need to pay …", "Should I
 * book …?"). The world and every draw are the original's; ids read `<suite>rw` so a run keeps them apart.
 */
const rewordedForms =
  (name: string, plant: Plant): Plant =>
  (world, seed, variant) =>
    plant(world, seed, variant).map((t) => ({
      ...t,
      id: t.id.replace(`:${name}`, `:${name}rw`),
      text: rewordOf(t.text, formOf(t.template)) ?? t.text,
    }));

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
  // M6's blind suite (D465, docs/research/m6-heldout18.md), written by an author who saw only a scaffold of the format
  // (helpers and planting function, one example template), two train suites, the HiddenTask interface and the sim world
  // API; with `neutral`, eight late-arrival templates (`HELDOUT18_LATE`) and at least twelve short requests that name a
  // person, thing or date the planted item words differently (`HELDOUT18_ANCHORED`, for the askNudge question,
  // D455-D457). Unread: do not run it (funnel or agent) except as the blind read it was made for; never tune on it.
  heldout18: plantHeldout18,
  // P7's blind suite for the end-of-wave confirmation (docs/research/p7-benchmarks.md, D870), written by an isolated
  // author who saw only a format scaffold (helpers and planting function, one invented example), the HiddenTask
  // interface, the sim world API and rare-sources.ts; with `neutral`; indirect, question and non-English requests,
  // anchored requests, facts in rarely used connectors and silent edits (HELDOUT19_* lists). Its worlds hold the eight
  // rare connectors (`prepareWorld`). Unread: nobody runs it (funnel or agent) before the parent's end-of-wave call;
  // never tune on it.
  heldout19: needsPrepared("heldout19", plantHeldout19),
  // The broad tuning set: six suites written blind (each author saw only the world generator, the text helpers and
  // the HiddenTask interface), one life area each, so a change must generalise across authors to show up. Tune on them.
  train1: withNeutral("train1", plantTrain1),
  train2: withNeutral("train2", plantTrain2),
  train3: withNeutral("train3", plantTrain3),
  train4: withNeutral("train4", plantTrain4),
  train5: withNeutral("train5", plantTrain5),
  train6: withNeutral("train6", plantTrain6),
  // The long-tail suite (P7, D873): every fact in a rarely used connector (rare-sources.ts), for pricing sweeps and
  // dormancy over days (`days-calls.ts --arrive-days`). Written by P7, not blind: tune on it.
  longtail: needsPrepared("longtail", plantLongtail),
  // P2's reworded train (Q6): the same tasks, indirect wording. Tune on them as on train; not in `all`.
  ...Object.fromEntries(
    [plantTrain1, plantTrain2, plantTrain3, plantTrain4, plantTrain5, plantTrain6].map((p, i) => {
      const name = `train${i + 1}`;
      return [`${name}rw`, rewordedForms(name, withNeutral(name, p))];
    }),
  ),
  // M2's generated worlds (D884): a committed sample of the validation split, one synth world a seed. The full
  // splits (`synth-train`, `synth-val`, `synth-test`) and any `synth:<file>` register when a command names them,
  // since their data lives on the Modal volume, not in git (parseSuites).
  "synth-sample": plantSynth("synth-sample", () => readWorlds(SAMPLE_PATH)),
};
for (const n of [1, 2, 3, 4, 5, 6]) SUITES[`train${n}r`] = reworded(`train${n}r`, `train${n}`);
export const SUITE_NAMES = Object.keys(SUITES);
const HELDOUT_ALL = ["heldout", "heldout2", "heldout3", "heldout4"];
const TRAIN = ["train1", "train2", "train3", "train4", "train5", "train6"];
/** The train suites reworded (D871): `--suite reworded`. */
const REWORDED_TRAIN = TRAIN.map((n) => `${n}r`);
/** P2's reworded train (`train-rw`, `reword.ts`). */
const TRAIN_RW = TRAIN.map((n) => `${n}rw`);
/**
 * Held-out suites kept out of `all` so a tuning command cannot spend them; held-out 9-13 have been read (D72, D80,
 * D85, D98, D112) and a blind round needs a new suite. Held-out 14 is RealUse-1's blind suite (run once for it);
 * held-out 15 was RealUse-2's (run once); held-out 16 was the CL wave's final check (RealUse-3); held-out 17 was the
 * end-of-day confirmation's (A29, run once). Held-out 18 was M6's (read by B18, D802); held-out 19 is P7's, unread
 * (D870). A run names them to measure on them (with `--blind`).
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
  "heldout18",
  "heldout19",
];
/** The UNRUN_BLIND suites nobody has read yet: the funnel's "read before" warning skips them (D350). Held-out 17 was
 * read by A29 (D399) and held-out 18 (M6, D465) by B18 (D802). Held-out 19 (P7, D870) is unread, for the end-of-wave
 * confirmation only. */
export const UNREAD_BLIND: string[] = ["heldout19"];
/**
 * P7's suites (D871, D873) and P2's `train-rw` stay out of `all`, so `--suite all` measures what it measured before
 * them.
 */
const NOT_IN_ALL = ["longtail", ...REWORDED_TRAIN, ...TRAIN_RW];
// Generated suites (D884) stay out of `all` too: their splits are not in git, and `all` means the hand-written suites.
const ALL = SUITE_NAMES.filter((n) => !UNRUN_BLIND.includes(n) && !NOT_IN_ALL.includes(n) && !n.startsWith("synth"));
const SYNTH_SPLITS = ["synth-train", "synth-val", "synth-test"];

/** The generated test split (D884), with any `+stale` or `@K`: held out, named only on its own and only blind. */
export const isSynthTest = (name: string) => /^synth-test(\+stale)?(@\d+)?$/.test(name);

/**
 * Registers a generated suite on first use (D884): `synth-train|val|test` read `synthPath(<split>)`, `synth:<file>`
 * reads that worlds file, and `@K` after any of them (or `synth-sample`) plants K worlds a seed. `synth` names the
 * train and validation splits; `synth-test` is the generated test split M1 and M3 measure on, so it is only ever
 * named on its own.
 */
function registerSynth(name: string): boolean {
  if (name in SUITES) return true;
  // `@K`: K synth worlds a seed (a `--days` user needs 12-20 requests a day; one world has 6-8).
  const at = name.lastIndexOf("@");
  const [base, k] =
    at > 0 && /^\d+$/.test(name.slice(at + 1)) ? [name.slice(0, at), name.slice(at + 1)] : [name, undefined];
  const perSeed = k === undefined ? 1 : Number(k);
  if (!Number.isInteger(perSeed) || perSeed < 1) return false;
  // `+stale` (M3, D908's rule 1): a silent change's earlier revision also stays, beside the fact (hidden variant only).
  const stale = base.endsWith("+stale");
  const bare = stale ? base.slice(0, -"+stale".length) : base;
  const split = SYNTH_SPLITS.includes(bare) ? bare.slice("synth-".length) : undefined;
  const file = bare.startsWith("synth:") ? bare.slice("synth:".length) : undefined;
  if (!split && !file && bare !== "synth-sample") return false;
  const load = () => readWorlds(file ?? (split ? synthPath(split) : SAMPLE_PATH));
  SUITES[name] = plantSynth(name, load, perSeed, stale);
  return true;
}

/**
 * A `--suite` value: a comma list of suite names, `all` (every hand-written suite but those in UNRUN_BLIND and P7's),
 * `heldout-all`, `train` (the six broad tuning suites), `reworded` (P7's reworded train), `train-rw` (P2's,
 * `reword.ts`) or `synth` (the generated train and validation splits);
 * unknown names throw. Deduplicated.
 */
export function parseSuites(arg: string): string[] {
  const out: string[] = [];
  for (const raw of arg.split(",")) {
    const name = raw.trim();
    if (!name) continue;
    const names =
      name === "all"
        ? ALL
        : name === "heldout-all"
          ? HELDOUT_ALL
          : name === "train"
            ? TRAIN
            : name === "reworded"
              ? REWORDED_TRAIN
              : name === "synth"
                ? ["synth-train", "synth-val"]
                : name === "train-rw"
                  ? TRAIN_RW
                  : [name];
    for (const n of names) {
      if (!registerSynth(n) && !(n in SUITES))
        throw new Error(
          `unknown suite "${n}" (known: ${SUITE_NAMES.join(", ")}, all, heldout-all, train, reworded, train-rw, synth, ` +
            "synth-train, synth-val, synth-test, synth:<file>)",
        );
      if (!out.includes(n)) out.push(n);
    }
  }
  if (!out.length) throw new Error("no suite given");
  if (out.length > 1 && out.some(isSynthTest))
    throw new Error("synth-test is the generated test split (D884): name it on its own");
  return out;
}
