#!/usr/bin/env bun
/**
 * Pools and pairs two sides' guard runs (`benchmarks/memory-long-horizon/harness/aa.ts --out`) for a slice report's
 * guard table (A5 §2). Each rate is pooled over the runs, with a Wilson 95% interval. `need_miss` and `false_rate`
 * are also paired run by run: base run r against new run r of the same seed, cue by cue, with an exact McNemar test,
 * which A5 §2 asks for when a tolerance is under the metric's A/A floor.
 *
 *   bun scripts/slice-guards.ts --base FILE[,FILE…] --new FILE[,FILE…] [--json]
 *
 * Several files per side are merged by seed, so the guard seeds that scripts/slice-measure.ts runs as separate
 * processes pool like one aa.ts run.
 */
import { readFileSync } from "node:fs";

export interface Rate {
  k: number;
  n: number;
}

export interface Cue {
  missed: boolean | null;
  bullets: number;
  false: number;
}

export interface Run {
  digest: string;
  failOpen?: { nonZeroExit?: number; timedOut?: number; withStderr?: number };
  metrics: {
    stale_rate: Rate;
    need_miss_rate: Rate;
    false_rate: Rate;
    redundant_rate: Rate;
    packet_rate: Rate;
    silence: { nonhuman: Rate; ack: Rate };
    secret_bytes: number;
    poison_hits: number;
    tokens_per_epoch: { p99: number };
    cues: Cue[];
  };
}

/** One side's runs by seed, as aa.ts writes them under `world`. */
export type Side = Record<string, Run[]>;

/** The seeds of several aa.ts outputs, merged: a seed in two files keeps the runs of both, in file order. */
export function mergeSides(files: readonly { world: Side }[]): Side {
  const side: Side = {};
  for (const file of files)
    for (const [seed, runs] of Object.entries(file.world)) side[seed] = [...(side[seed] ?? []), ...runs];
  return side;
}

function runsOf(side: Side): Run[] {
  return Object.keys(side)
    .sort()
    .flatMap((seed) => side[seed]!);
}

export type RateMetric = "stale_rate" | "need_miss_rate" | "false_rate" | "redundant_rate" | "packet_rate";

export function pooled(side: Side, metric: RateMetric): Rate {
  const runs = runsOf(side);
  return {
    k: runs.reduce((sum, run) => sum + run.metrics[metric].k, 0),
    n: runs.reduce((sum, run) => sum + run.metrics[metric].n, 0),
  };
}

/** The Wilson 95% interval of k of n. */
export function wilson({ k, n }: Rate): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - half) / denominator), Math.min(1, (centre + half) / denominator)];
}

function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - i + 1)) / i;
  return result;
}

/** The exact two-sided McNemar p of `b` and `c` discordant pairs. */
export function mcnemar(b: number, c: number): number {
  const d = b + c;
  if (!d) return 1;
  let tail = 0;
  for (let k = 0; k <= Math.min(b, c); k++) tail += choose(d, k);
  return Math.min(1, (2 * tail) / 2 ** d);
}

export interface Paired {
  baseOnly: number;
  newOnly: number;
  both: number;
  neither: number;
  p: number;
}

/**
 * Base run r against new run r of each seed, cue by cue. `hit` says whether a cue counts on one side; a pair is
 * left out when `hit` returns null on either side. Undefined when the sides' runs or cues do not line up.
 */
export function paired(base: Side, next: Side, hit: (cue: Cue) => boolean | null): Paired | undefined {
  const counts = { baseOnly: 0, newOnly: 0, both: 0, neither: 0 };
  for (const seed of Object.keys(base).sort()) {
    const baseRuns = base[seed]!;
    const newRuns = next[seed];
    if (!newRuns || newRuns.length !== baseRuns.length) return undefined;
    for (const [r, baseRun] of baseRuns.entries()) {
      const baseCues = baseRun.metrics.cues;
      const newCues = newRuns[r]!.metrics.cues;
      if (baseCues.length !== newCues.length) return undefined;
      for (const [i, cue] of baseCues.entries()) {
        const x = hit(cue);
        const y = hit(newCues[i]!);
        if (x === null || y === null) continue;
        if (x && y) counts.both++;
        else if (x) counts.baseOnly++;
        else if (y) counts.newOnly++;
        else counts.neither++;
      }
    }
  }
  return { ...counts, p: mcnemar(counts.baseOnly, counts.newOnly) };
}

/** need_miss pairs: a cue that needs items, missed. */
export const missed = (cue: Cue): boolean | null => cue.missed;
/** false_rate pairs: a cue whose packet stated an item it needs or allows. */
export const stated = (cue: Cue): boolean | null => (cue.bullets ? cue.bullets - cue.false > 0 : false);

/** Hook timeouts and non-zero exits over a side's runs: the only way machine load reaches these counts. */
export function failOpens(side: Side): { timedOut: number; nonZeroExit: number } {
  const runs = runsOf(side);
  return {
    timedOut: runs.reduce((sum, run) => sum + (run.failOpen?.timedOut ?? 0), 0),
    nonZeroExit: runs.reduce((sum, run) => sum + (run.failOpen?.nonZeroExit ?? 0), 0),
  };
}

function percent(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function rateCell(rate: Rate): string {
  const [low, high] = wilson(rate);
  const point = rate.n ? rate.k / rate.n : 0;
  return `${rate.k}/${rate.n} = ${percent(point)} (${percent(low).slice(0, -1)}–${percent(high)})`;
}

function delta(base: Rate, next: Rate): string {
  const pp = ((next.n ? next.k / next.n : 0) - (base.n ? base.k / base.n : 0)) * 100;
  return `${pp >= 0 ? "+" : "−"}${Math.abs(pp).toFixed(2)} pp`;
}

function pairedCell(pairs: Paired | undefined): string {
  if (!pairs) return "unpaired: the sides' runs or cues do not line up";
  return `base-only ${pairs.baseOnly}, new-only ${pairs.newOnly}, both ${pairs.both}, neither ${pairs.neither}; McNemar p = ${pairs.p.toFixed(4)}`;
}

function perRun(side: Side, value: (run: Run) => number | string): string {
  return Object.keys(side)
    .sort()
    .map((seed) => side[seed]!.map(value).join(", "))
    .join(" · ");
}

function digestsAgree(side: Side): boolean {
  return Object.values(side).every((runs) => runs.every((run) => run.digest === runs[0]?.digest));
}

/** The guard table and its paired lines, as markdown. */
export function guardReport(base: Side, next: Side): string {
  const rows = (["stale_rate", "need_miss_rate", "false_rate", "redundant_rate", "packet_rate"] as const).map(
    (metric) => {
      const b = pooled(base, metric);
      const n = pooled(next, metric);
      return `| \`${metric}\` | ${rateCell(b)} | ${rateCell(n)} | ${delta(b, n)} |`;
    },
  );
  const silence = (["nonhuman", "ack"] as const).map((kind) => {
    const count = (side: Side) =>
      runsOf(side).reduce(
        (sum, run) => ({ k: sum.k + run.metrics.silence[kind].k, n: sum.n + run.metrics.silence[kind].n }),
        { k: 0, n: 0 },
      );
    const b = count(base);
    const n = count(next);
    return `| \`silence.${kind}\` | ${b.k}/${b.n} | ${n.k}/${n.n} | |`;
  });
  const tokens = (side: Side) => Math.max(...runsOf(side).map((run) => run.metrics.tokens_per_epoch.p99));
  const lines = [
    "| Metric | Base | New | Δ |",
    "|---|---|---|---|",
    ...rows,
    ...silence,
    `| \`tokens_per_epoch\` p99 (max over runs) | ${tokens(base)} | ${tokens(next)} | |`,
    "",
    `- need_miss, paired per cue-run: ${pairedCell(paired(base, next, missed))}`,
    `- false_rate, paired per cue-run (a packet stating a wanted item): ${pairedCell(paired(base, next, stated))}`,
    `- per run (seed 1 · 2 · 3), stale bullets: base ${perRun(base, (run) => run.metrics.stale_rate.k)}; new ${perRun(next, (run) => run.metrics.stale_rate.k)}`,
    `- per run, need_miss: base ${perRun(base, (run) => run.metrics.need_miss_rate.k)}; new ${perRun(next, (run) => run.metrics.need_miss_rate.k)}`,
    `- secret_bytes: base ${perRun(base, (run) => run.metrics.secret_bytes)}; new ${perRun(next, (run) => run.metrics.secret_bytes)}`,
    `- poison_hits: base ${perRun(base, (run) => run.metrics.poison_hits)}; new ${perRun(next, (run) => run.metrics.poison_hits)}`,
    `- one event sequence per seed: base ${digestsAgree(base)}; new ${digestsAgree(next)}`,
    `- hook timeouts / non-zero exits: base ${JSON.stringify(failOpens(base))}; new ${JSON.stringify(failOpens(next))}`,
  ];
  return lines.join("\n");
}

function argument(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export function readSide(list: string): Side {
  return mergeSides(list.split(",").map((path) => JSON.parse(readFileSync(path, "utf8")) as { world: Side }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const baseList = argument(args, "--base");
  const newList = argument(args, "--new");
  if (!baseList || !newList) {
    console.error("usage: bun scripts/slice-guards.ts --base FILE[,FILE…] --new FILE[,FILE…] [--json]");
    process.exit(2);
  }
  const base = readSide(baseList);
  const next = readSide(newList);
  if (args.includes("--json")) {
    const metrics = ["stale_rate", "need_miss_rate", "false_rate", "redundant_rate", "packet_rate"] as const;
    const pooledSides = Object.fromEntries(
      metrics.map((metric) => [metric, { base: pooled(base, metric), new: pooled(next, metric) }]),
    );
    const pairs = { need_miss: paired(base, next, missed), false_rate: paired(base, next, stated) };
    console.log(JSON.stringify({ pooled: pooledSides, paired: pairs, failOpen: failOpens(next) }, null, 2));
  } else console.log(guardReport(base, next));
}
