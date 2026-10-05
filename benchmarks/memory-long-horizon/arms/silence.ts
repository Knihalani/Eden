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
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rate, type Rate } from "../harness/metrics";
import { loadPlugin } from "../harness/runner";
import { SimWorld } from "../harness/session";
import { generateWorldScenario, playScenario, type Scenario } from "../harness/world";
import { askCue, perCategory, type BenchCue } from "./cuebench";
import { EDEN_PLUGIN } from "./kit";
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
  const state = edenState(world);
  const saved = state.map((_, i) => join(options.runDir, "store-after-seeding", String(i)));
  state.forEach((dir, i) => copyOver(dir, saved[i]!));
  /** The ids of the cues that got a packet, each asked against the store as seeding left it. */
  const fired = async (cues: readonly BenchCue[]) => {
    const ids: string[] = [];
    for (const cue of cues) {
      state.forEach((dir, i) => copyOver(saved[i]!, dir));
      if ((await askCue(world, store.world, cue, [])).packet) ids.push(cue.id);
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

async function main(args: string[]): Promise<void> {
  const seed = Number(argument(args, "--seed") ?? 1);
  const pluginDir = resolve(argument(args, "--plugin") ?? EDEN_PLUGIN);
  const per = argument(args, "--per-category");
  const real = realNegatives();
  const sets = [...fixtureNegatives(), ...(real.status === "loaded" ? [real.set] : [])].map((set) =>
    per === undefined ? set : { ...set, cues: perCategory(set.cues, Number(per)) },
  );
  const runDir = mkdtempSync(join(tmpdir(), "eden-silence-"));
  const started = performance.now();
  try {
    const store = generateWorldScenario(seed);
    const { control, sources } = await replaySilence({
      pluginDir,
      store,
      controls: storeControls(store),
      sets,
      runDir,
    });
    const report = {
      plugin: pluginDir,
      seed,
      control,
      sources,
      real: real.status === "loaded" ? { path: real.path, sha256: real.sha256 } : PRIVATE_SET_ABSENT,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main(process.argv.slice(2));
