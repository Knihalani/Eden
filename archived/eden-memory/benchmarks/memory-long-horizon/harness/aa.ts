#!/usr/bin/env bun
/**
 * The harness A/A (EXECUTION X6, A5 §2): a plugin against itself, every run in a fresh process, to measure
 * each metric's noise floor. No tolerance may be tighter than its floor.
 *
 *   bun benchmarks/memory-long-horizon/harness/aa.ts [--plugin DIR] [--seeds 1,2,3] [--runs 3]
 *       [--soak-turns 1000] [--soak-runs 3] [--out FILE]
 *
 * Each seed's world scenario (world.ts) is replayed `--runs` times, and the latency soak (shape.ts)
 * `--soak-runs` times. A metric's noise floor is the largest spread (max − min) between the runs of one seed.
 * For `need_miss` it is also the largest number of cues whose outcome differs between two runs of one seed:
 * the discordant pairs a McNemar test counts. p99 per point comes from the soak, the one run with ≥ 1,000
 * samples per point.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Latency, Metrics, Rate } from "./metrics";
import type { ReplaySummary } from "./replay";

const REPLAY = join(import.meta.dir, "replay.ts");

/** One replay in a fresh process. */
interface Run {
  seconds: number;
  digest: string;
  failOpen: ReplaySummary["failOpen"];
  metrics: Metrics;
}

/** The metrics a run is compared on, each reduced to one number (a rate's point estimate). */
const SCALARS: Record<string, (metrics: Metrics) => number | null> = {
  stale_rate: (m) => m.stale_rate.rate,
  redundant_rate: (m) => m.redundant_rate.rate,
  need_miss_rate: (m) => m.need_miss_rate.rate,
  false_rate: (m) => m.false_rate.rate,
  "silence.nonhuman": (m) => m.silence.nonhuman.rate,
  "silence.ack": (m) => m.silence.ack.rate,
  packet_rate: (m) => m.packet_rate.rate,
  "tokens_per_epoch.p99": (m) => m.tokens_per_epoch.p99,
  guard_precision: (m) => m.guard_precision.rate,
  guard_recall: (m) => m.guard_recall.rate,
  secret_bytes: (m) => m.secret_bytes,
  poison_hits: (m) => m.poison_hits,
};

export interface AAResult {
  plugin: string;
  seeds: number[];
  world: Record<string, Run[]>;
  soak: Run[];
  /** Per metric: the values of every run, by seed, and the noise floor. */
  floors: Record<string, { values: (number | null)[][]; floor: number | null }>;
  /** The most cues whose need_miss outcome differs between two runs of one seed. */
  needMissDiscordantCues: number;
  /** Whether every run of a seed had the same event digest (it must: hook output never changes events). */
  digestsAgree: boolean;
  p99: Record<string, { n: number[]; values: number[]; floor: number }>;
}

export function replayOnce(args: string[]): Run {
  const started = performance.now();
  const run = Bun.spawnSync(["bun", REPLAY, ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`replay ${args.join(" ")} exited ${run.exitCode}: ${run.stderr}`);
  const summary = JSON.parse(run.stdout.toString()) as ReplaySummary;
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  return { seconds, digest: summary.digest, failOpen: summary.failOpen, metrics: summary.metrics };
}

export function noiseFloors(world: Record<string, Run[]>, soak: Run[]): Omit<AAResult, "plugin" | "seeds"> {
  const seeds = Object.values(world);
  const floors = Object.fromEntries(
    Object.entries(SCALARS).map(([name, value]) => {
      const values = seeds.map((runs) => runs.map((run) => value(run.metrics)));
      return [name, { values, floor: largestSpread(values) }];
    }),
  );
  const points = [...new Set(soak.flatMap((run) => Object.keys(run.metrics.p99_hook_ms)))];
  const p99 = Object.fromEntries(
    points.map((point) => {
      const latencies = soak.map((run) => run.metrics.p99_hook_ms[point]).filter((l): l is Latency => !!l);
      const values = latencies.map((latency) => latency.p99);
      return [point, { n: latencies.map((latency) => latency.n), values, floor: spread(values) ?? 0 }];
    }),
  );
  return {
    world,
    soak,
    floors,
    needMissDiscordantCues: Math.max(0, ...seeds.map(discordantCues)),
    digestsAgree: seeds.every((runs) => runs.every((run) => run.digest === runs[0]!.digest)),
    p99,
  };
}

/** The largest number of cues whose need outcome differs between two runs of one seed. */
function discordantCues(runs: readonly Run[]): number {
  let most = 0;
  for (const [i, a] of runs.entries()) {
    for (const b of runs.slice(i + 1)) {
      const differing = a.metrics.cues.filter((cue, at) => cue.missed !== b.metrics.cues[at]?.missed).length;
      most = Math.max(most, differing + Math.abs(a.metrics.cues.length - b.metrics.cues.length));
    }
  }
  return most;
}

/** max − min of the known values, to 6 decimals; null when none is known (a rate with n = 0). */
function spread(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.round((Math.max(...known) - Math.min(...known)) * 1e6) / 1e6 : null;
}

function largestSpread(bySeed: readonly (number | null)[][]): number | null {
  const spreads = bySeed.map(spread).filter((value): value is number => value !== null);
  return spreads.length ? Math.max(...spreads) : null;
}

function argument(args: string[], name: string, fallback: string): string {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1]! : fallback;
}

const percent = (rate: Rate) => (rate.rate === null ? "n/a" : `${(rate.rate * 100).toFixed(1)}%`);

async function main(args: string[]): Promise<void> {
  const plugin = resolve(argument(args, "--plugin", join(import.meta.dir, "../../../plugins/eden-memory")));
  const seeds = argument(args, "--seeds", "1,2,3").split(",").map(Number);
  const runs = Number(argument(args, "--runs", "3"));
  const soakTurns = argument(args, "--soak-turns", "1000");
  const soakRuns = Number(argument(args, "--soak-runs", "3"));
  const world: Record<string, Run[]> = {};
  for (const seed of seeds) {
    world[seed] = [];
    for (let i = 0; i < runs; i++) {
      const run = replayOnce(["--world", String(seed), "--plugin", plugin]);
      world[seed].push(run);
      const { stale_rate: stale, need_miss_rate: needMiss } = run.metrics;
      console.error(
        `world ${seed} run ${i + 1}: ${run.seconds}s stale ${percent(stale)} need_miss ${percent(needMiss)}`,
      );
    }
  }
  const soak: Run[] = [];
  for (let i = 0; i < soakRuns; i++) {
    soak.push(replayOnce(["--soak", soakTurns, "--plugin", plugin]));
    console.error(`soak run ${i + 1}: ${soak.at(-1)!.seconds}s`);
  }
  const result: AAResult = { plugin, seeds, ...noiseFloors(world, soak) };
  const out = argument(args, "--out", "");
  if (out) writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, world: undefined, soak: undefined }, null, 2));
}

if (import.meta.main) await main(process.argv.slice(2));
