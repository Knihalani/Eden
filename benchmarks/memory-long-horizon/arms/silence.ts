#!/usr/bin/env bun
/**
 * Silence on the silence set (A5 §2 `silence` (c)): each negative is asked through a plugin's hooks in a fresh
 * session, in a repo whose store a world scenario built first, and a packet on it is a false fire. Each source
 * gets its false-inject rate with a Wilson 95% interval (X6) and the ids of the negatives that fired, never text.
 *
 *   bun benchmarks/memory-long-horizon/arms/silence.ts [--seed N] [--plugin DIR] [--per-category N]
 *
 * - The store: the world scenario of seed N (world.ts; default 1, the A/A workload), played once. Every negative
 *   then meets the store as those sessions left it: Eden's files are restored before each one, so no negative is
 *   answered from an earlier one, and the samples are independent, as the interval assumes.
 * - The control: the store's own annotated prompts that need an item, asked the same way. They should get packets;
 *   a plugin that answers none of them is silent everywhere, and its false-inject rates say nothing.
 * - The sets: R1's and R8's negatives, and the private set when `EDEN_EVAL_NEGATIVES` names one. Without it, the
 *   report's `real` says `skipped: private set absent`.
 * - `--per-category N` asks only the first N negatives of each category (a quick look); by default, all of them.
 * - `--store cuebench` asks them against the CueBench store instead (P4.3, the gate's own store): the R1 fixture's live
 *   memories planted with `eden memory remember` (`cuebench.ts`), with six of R1's dev `lex` cues as the control.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rate, type Rate } from "../harness/metrics";
import { loadPlugin } from "../harness/runner";
import { SimWorld } from "../harness/session";
import { generateWorldScenario, playScenario, type Scenario, type WorldSpec } from "../harness/world";
import { askCue, benchWorld, memoryRows, perCategory, plant, r1Cues, type BenchCue } from "./cuebench";
import { ArmRun, EDEN_CLI, EDEN_PLUGIN } from "./kit";
import {
  askable,
  fixtureNegatives,
  PRIVATE_SET_ABSENT,
  realNegatives,
  type NegativeSet,
  type SilenceSource,
} from "./negatives";

export interface SourceSilence {
  source: SilenceSource;
  fir: Rate;
  /** The ids of the negatives that got a packet. */
  falseFires: string[];
}

export interface SilenceReport {
  /** Control prompts that got a packet. */
  control: Rate;
  sources: SourceSilence[];
}

export interface SilenceOptions {
  pluginDir: string;
  /** The sessions that build the store before any negative is asked. */
  store: Required<Scenario>;
  controls: readonly BenchCue[];
  sets: readonly NegativeSet[];
  runDir: string;
  env?: Record<string, string>;
}

/** Plays the store's sessions, then asks every control and every negative against that same store. */
export async function replaySilence(options: SilenceOptions): Promise<SilenceReport> {
  const { store } = options;
  const world = new SimWorld({
    runDir: options.runDir,
    plugin: loadPlugin(options.pluginDir),
    seed: store.seed,
    clockEnv: true,
    env: options.env,
    projectFiles: store.world.projectFiles,
    subjects: store.world.subjects,
    initialTruth: store.world.initialTruth,
  });
  await playScenario(store, world);
  return askAgainst(world, store.world, options);
}

/**
 * Asks every control and every negative against a world's store as it stands, Eden's files restored before each, so
 * no negative is answered from an earlier one.
 */
async function askAgainst(
  world: SimWorld,
  spec: WorldSpec,
  options: Pick<SilenceOptions, "controls" | "sets" | "runDir">,
): Promise<SilenceReport> {
  const state = edenState(world);
  const saved = state.map((_, i) => join(options.runDir, "store-after-seeding", String(i)));
  state.forEach((dir, i) => copyOver(dir, saved[i]!));
  /** The ids of the cues that got a packet, each asked against the store as seeding left it. */
  const fired = async (cues: readonly BenchCue[]) => {
    const ids: string[] = [];
    for (const cue of cues) {
      state.forEach((dir, i) => copyOver(saved[i]!, dir));
      if ((await askCue(world, spec, cue, [])).packet) ids.push(cue.id);
    }
    return ids;
  };
  const control = await fired(options.controls);
  const sources: SourceSilence[] = [];
  for (const set of options.sets) {
    const falseFires = await fired(set.cues);
    sources.push({ source: set.source, fir: rate(falseFires.length, set.cues.length), falseFires });
  }
  return { control: rate(control.length, options.controls.length), sources };
}

/** The CueBench store (`--store cuebench`): the R1 fixture planted, then every set asked against it. */
async function replayBenchSilence(options: Omit<SilenceOptions, "store" | "controls">): Promise<SilenceReport> {
  const run = new ArmRun(
    { pluginDir: options.pluginDir, cli: EDEN_CLI, scale: "full", flags: "on", env: options.env },
    options.runDir,
  );
  const spec = benchWorld();
  const world = run.world(spec);
  const planted = plant(run, world, memoryRows(world));
  if (!planted || planted.remembered !== planted.rows) throw new Error("the CueBench store could not be planted");
  const controls = perCategory(
    r1Cues().filter((cue) => cue.split === "dev" && cue.cat === "lex"),
    6,
  );
  return askAgainst(world, spec, { ...options, controls });
}

/** The store's prompts that need an item (A5 §3.6 `needs`), once each, as controls. */
export function storeControls(store: Scenario): BenchCue[] {
  const scopes = new Map<string, string>();
  for (const step of store.sessions.flatMap((script) => script.steps)) {
    const said = step.kind === "prompt" || step.kind === "rewind" || step.kind === "queued-prompt";
    if (said && step.cue.needs.length && !scopes.has(step.text)) scopes.set(step.text, step.cue.scope);
  }
  return [...scopes].map(([text, scope], i) => askable(`control-${i + 1}`, "control", text, scope));
}

/** Where a plugin keeps state: Eden's home and the plugin's data directory. */
function edenState(world: SimWorld): string[] {
  return [join(world.home, ".eden"), join(world.home, ".claude", "plugins", "data", world.options.plugin.name)];
}

/** Makes `to` a copy of `from`, or removes it when `from` does not exist. */
function copyOver(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  if (existsSync(from)) cpSync(from, to, { recursive: true });
}

function argument(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export interface SilenceRun extends SilenceReport {
  plugin: string;
  /** The store the negatives met: a world scenario's (of `seed`), or the CueBench store. */
  store: "world" | "cuebench";
  seed: number;
  /** The private set's file and sha256, or why it was skipped. */
  real: { path: string; sha256: string; looks: number } | typeof PRIVATE_SET_ABSENT;
  seconds: number;
}

/**
 * One measurement as the command runs it: R1, R8 and (when `env` names one) the private set, against the world
 * scenario of `seed` unless a `store` is given, in a run directory removed afterwards.
 */
export async function measureSilence(options: {
  pluginDir: string;
  seed?: number;
  store?: Required<Scenario> | "cuebench";
  perCategory?: number;
  env?: Record<string, string | undefined>;
  hookEnv?: Record<string, string>;
}): Promise<SilenceRun> {
  const seed = options.seed ?? 1;
  const real = realNegatives(options.env);
  const per = options.perCategory;
  const sets = [...fixtureNegatives(), ...(real.status === "loaded" ? [real.set] : [])].map((set) =>
    per === undefined ? set : { ...set, cues: perCategory(set.cues, per) },
  );
  const runDir = mkdtempSync(join(tmpdir(), "eden-silence-"));
  const started = performance.now();
  try {
    const common = { pluginDir: options.pluginDir, sets, runDir, env: options.hookEnv };
    const scenario = options.store === "cuebench" ? undefined : (options.store ?? generateWorldScenario(seed));
    const { control, sources } = scenario
      ? await replaySilence({ ...common, store: scenario, controls: storeControls(scenario) })
      : await replayBenchSilence(common);
    return {
      plugin: options.pluginDir,
      store: scenario ? "world" : "cuebench",
      seed,
      control,
      sources,
      real: real.status === "loaded" ? { path: real.path, sha256: real.sha256, looks: real.looks } : PRIVATE_SET_ABSENT,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

async function main(args: string[]): Promise<void> {
  const per = argument(args, "--per-category");
  const run = await measureSilence({
    pluginDir: resolve(argument(args, "--plugin") ?? EDEN_PLUGIN),
    seed: Number(argument(args, "--seed") ?? 1),
    ...(argument(args, "--store") === "cuebench" ? { store: "cuebench" as const } : {}),
    perCategory: per === undefined ? undefined : Number(per),
    env: process.env,
  });
  console.log(JSON.stringify(run, null, 2));
}

if (import.meta.main) await main(process.argv.slice(2));
