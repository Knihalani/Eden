#!/usr/bin/env bun
/**
 * Replays one R6-shaped session through a plugin's hooks, every hook in its own process, and prints a JSON
 * summary: events per point, exit codes, latency, contexts, transcript size, and a digest of the event log
 * that two runs of the same script must share.
 *
 *   bun benchmarks/memory-long-horizon/harness/replay.ts [--canonical | --seed N] [--plugin DIR] [--out DIR]
 *       [--flush lagging|eager]
 *
 * Defaults: the canonical session, `plugins/eden-memory` from this tree, a temporary run directory that is
 * removed afterwards (`--out` keeps it, with `script.json` and `events.jsonl`).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { projectSlug } from "./rng";
import { loadPlugin, type Invocation } from "./runner";
import { SimWorld, type EventRecord } from "./session";
import { canonicalSession, generateSession, play, shapeStats, type SessionScript } from "./shape";

export interface ReplaySummary {
  seed: number;
  plugin: string;
  steps: number;
  skippedSteps: number;
  shape: {
    humanPrompts: number;
    nonHumanSubmits: number;
    subagentWindows: number;
    rewinds: number;
    compactions: number;
  };
  events: number;
  eventsByPoint: Record<string, number>;
  invocations: number;
  /** Distinct process ids over all invocations: one process per invocation means this equals `invocations`. */
  processes: number;
  exitCodes: Record<string, number>;
  /** Invocations that broke the fail-open contract or that Claude Code would flag. */
  failOpen: { nonZeroExit: number; timedOut: number; withStderr: number; rejectedOutput: number };
  contexts: number;
  blocked: number;
  msByPoint: Record<string, { p50: number; p99: number; max: number }>;
  transcript: { files: number; lines: number; bytes: number };
  digest: string;
}

export interface ReplayOptions {
  script: SessionScript;
  pluginDir: string;
  runDir: string;
  flush?: "lagging" | "eager";
  env?: Record<string, string>;
}

export async function replay(options: ReplayOptions): Promise<{ summary: ReplaySummary; world: SimWorld }> {
  const plugin = loadPlugin(options.pluginDir);
  const world = new SimWorld({
    runDir: options.runDir,
    plugin,
    seed: options.script.seed,
    flush: options.flush,
    env: options.env,
  });
  const result = await play(options.script, world);
  return { summary: summarize(options, world, result.skipped), world };
}

function summarize(options: ReplayOptions, world: SimWorld, skipped: number): ReplaySummary {
  const invocations = world.log.flatMap((record) => record.invocations);
  const byPoint = new Map<string, number[]>();
  for (const record of world.log) {
    for (const invocation of record.invocations) {
      const list = byPoint.get(record.event) ?? [];
      list.push(invocation.endedAt - invocation.startedAt);
      byPoint.set(record.event, list);
    }
  }
  const transcripts = listFiles(join(world.home, ".claude", "projects")).filter((path) => path.endsWith(".jsonl"));
  const stats = shapeStats(options.script);
  return {
    seed: options.script.seed,
    plugin: world.options.plugin.name,
    steps: options.script.steps.length,
    skippedSteps: skipped,
    shape: {
      humanPrompts: stats.humanPrompts,
      nonHumanSubmits: stats.nonHumanSubmits,
      subagentWindows: stats.subagentWindows,
      rewinds: stats.rewinds,
      compactions: stats.compactions,
    },
    events: world.log.length,
    eventsByPoint: countBy(world.log.map((record) => record.event)),
    invocations: invocations.length,
    processes: new Set(invocations.map((invocation) => invocation.pid)).size,
    exitCodes: countBy(invocations.map((invocation) => String(invocation.exitCode))),
    failOpen: {
      nonZeroExit: invocations.filter((invocation) => invocation.exitCode !== 0).length,
      timedOut: invocations.filter((invocation) => invocation.timedOut).length,
      withStderr: invocations.filter((invocation) => invocation.stderr.length > 0).length,
      rejectedOutput: invocations.filter((invocation) => invocation.outcome.error !== undefined).length,
    },
    contexts: invocations.filter((invocation) => invocation.outcome.additionalContext !== undefined).length,
    blocked: invocations.filter((invocation) => invocation.outcome.blocked).length,
    msByPoint: Object.fromEntries([...byPoint].map(([point, ms]) => [point, percentiles(ms)])),
    transcript: {
      files: transcripts.length,
      lines: transcripts.reduce((n, path) => n + readFileSync(path, "utf8").split("\n").filter(Boolean).length, 0),
      bytes: transcripts.reduce((n, path) => n + statSync(path).size, 0),
    },
    digest: digest(world.log, world.runDir),
  };
}

/**
 * A digest of the event sequence in dispatch order, each payload with the run directory taken out of every
 * path, and each invocation's exit code. Two runs of one script in fresh processes, from any run directory,
 * must give the same digest. What hooks print is left out: it may vary with the plugin under test (the
 * summary counts contexts separately), and it reaches the digest only through what it changes, such as a
 * blocked prompt.
 */
export function digest(log: readonly EventRecord[], runDir: string): string {
  const hash = createHash("sha256");
  for (const record of log) {
    const exitCodes = record.invocations.map((invocation: Invocation) => invocation.exitCode);
    // The run directory appears as itself and, inside `transcript_path`, as part of the project slug.
    const payload = JSON.stringify(record.payload)
      .replaceAll(runDir, "<run>")
      .replaceAll(projectSlug(runDir), "<run-slug>");
    hash.update(`${record.event}\t${record.window}\t${payload}\t${JSON.stringify(exitCodes)}\n`);
  }
  return hash.digest("hex");
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function percentiles(values: number[]): { p50: number; p99: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
  const round = (ms: number) => Math.round(ms * 10) / 10;
  return { p50: round(at(0.5)), p99: round(at(0.99)), max: round(sorted.at(-1)!) };
}

/** Every file under `dir`, recursively; none when it does not exist. */
export function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  } catch {
    return [];
  }
}

function argument(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
  const seed = argument(args, "--seed");
  const script = seed === undefined ? canonicalSession() : generateSession(Number(seed));
  const pluginDir = resolve(argument(args, "--plugin") ?? join(import.meta.dir, "../../../plugins/eden-memory"));
  const out = argument(args, "--out");
  const flush = argument(args, "--flush") === "eager" ? "eager" : "lagging";
  const runDir = out ? resolve(out) : mkdtempSync(join(tmpdir(), "eden-replay-"));
  mkdirSync(runDir, { recursive: true });
  try {
    const { summary, world } = await replay({ script, pluginDir, runDir, flush });
    if (out) {
      writeFileSync(join(runDir, "script.json"), JSON.stringify(script, null, 2));
      writeFileSync(join(runDir, "events.jsonl"), world.log.map((record) => JSON.stringify(record)).join("\n") + "\n");
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (!out) rmSync(runDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main(process.argv.slice(2));
