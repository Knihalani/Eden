#!/usr/bin/env bun
/**
 * Replays R6-shaped sessions through a plugin's hooks, every hook in its own process, and prints a JSON
 * summary: events per point, exit codes, latency, contexts, transcript size, a digest of the event log that
 * two runs of the same script must share, and the A5 §2 metrics (metrics.ts).
 *
 *   bun benchmarks/memory-long-horizon/harness/replay.ts [--canonical | --seed N | --world N | --soak TURNS]
 *       [--plugin DIR] [--out DIR] [--flush lagging|eager]
 *
 * `--seed N` plays one generated session; `--world N` plays the world scenario of seed N (world.ts), several
 * sessions in one repo, with its oracle and annotated cues; `--soak TURNS` plays the latency soak (shape.ts).
 *
 * Defaults: the canonical session, `plugins/eden-memory` from this tree, a temporary run directory that is
 * removed afterwards. `--out` keeps it, with `scenario.json`, `events.jsonl` and the oracle files under
 * `oracle/` (`oracle.jsonl`, `cues.jsonl`, `deliveries.jsonl`).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeMetrics, latencyByPoint, listFiles, type Corpus, type Latency, type Metrics } from "./metrics";
import { projectSlug } from "./rng";
import { loadPlugin, type Invocation } from "./runner";
import { SimWorld, type EventRecord } from "./session";
import { canonicalSession, generateSession, shapeStats, soakSession } from "./shape";
import { generateWorldScenario, playScenario, sessionScenario, type Scenario } from "./world";

export interface ReplaySummary {
  seed: number;
  plugin: string;
  sessions: number;
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
  msByPoint: Record<string, Latency>;
  transcript: { files: number; lines: number; bytes: number };
  digest: string;
  metrics: Metrics;
}

export interface ReplayOptions {
  scenario: Scenario;
  pluginDir: string;
  runDir: string;
  flush?: "lagging" | "eager";
  env?: Record<string, string>;
}

export async function replay(options: ReplayOptions): Promise<{ summary: ReplaySummary; world: SimWorld }> {
  const plugin = loadPlugin(options.pluginDir);
  const { scenario } = options;
  const world = new SimWorld({
    runDir: options.runDir,
    plugin,
    seed: scenario.seed,
    flush: options.flush,
    env: options.env,
    projectFiles: scenario.world?.projectFiles,
    subjects: scenario.world?.subjects,
    initialTruth: scenario.world?.initialTruth,
  });
  const results = await playScenario(scenario, world);
  const skipped = results.reduce((n, result) => n + result.skipped, 0);
  return { summary: summarize(scenario, world, skipped), world };
}

/** A run without a world still has scopes to read packets by: the root. */
const NO_WORLD: Corpus = { scopes: [""], secrets: [], poison: [] };

function summarize(scenario: Scenario, world: SimWorld, skipped: number): ReplaySummary {
  const invocations = world.log.flatMap((record) => record.invocations);
  const transcripts = listFiles(join(world.home, ".claude", "projects")).filter((path) => path.endsWith(".jsonl"));
  const stats = scenario.sessions.map(shapeStats);
  const total = (field: "humanPrompts" | "nonHumanSubmits" | "subagentWindows" | "rewinds" | "compactions") =>
    stats.reduce((n, session) => n + session[field], 0);
  return {
    seed: scenario.seed,
    plugin: world.options.plugin.name,
    sessions: scenario.sessions.length,
    steps: scenario.sessions.reduce((n, session) => n + session.steps.length, 0),
    skippedSteps: skipped,
    shape: {
      humanPrompts: total("humanPrompts"),
      nonHumanSubmits: total("nonHumanSubmits"),
      subagentWindows: total("subagentWindows"),
      rewinds: total("rewinds"),
      compactions: total("compactions"),
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
    msByPoint: latencyByPoint(world),
    transcript: {
      files: transcripts.length,
      lines: transcripts.reduce((n, path) => n + readFileSync(path, "utf8").split("\n").filter(Boolean).length, 0),
      bytes: transcripts.reduce((n, path) => n + statSync(path).size, 0),
    },
    digest: digest(world.log, world.runDir),
    metrics: computeMetrics(world, scenario.world ?? NO_WORLD),
  };
}

/** The oracle files of a run (A5 §3): the truth timeline, the annotated cues, and what the model received. */
function writeOracleFiles(world: SimWorld, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const lines = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  world.oracle.write(join(dir, "oracle.jsonl"));
  writeFileSync(
    join(dir, "cues.jsonl"),
    lines(world.cues.map(({ seen: _seen, ...cue }, index) => ({ index, ...cue }))),
  );
  writeFileSync(join(dir, "deliveries.jsonl"), lines(world.deliveries.map(({ seen: _seen, ...delivery }) => delivery)));
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

function argument(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function scenarioOf(args: string[]): Scenario {
  const world = argument(args, "--world");
  if (world !== undefined) return generateWorldScenario(Number(world));
  const soak = argument(args, "--soak");
  if (soak !== undefined) return sessionScenario(soakSession(Number(soak)));
  const seed = argument(args, "--seed");
  return sessionScenario(seed === undefined ? canonicalSession() : generateSession(Number(seed)));
}

async function main(args: string[]): Promise<void> {
  const scenario = scenarioOf(args);
  const pluginDir = resolve(argument(args, "--plugin") ?? join(import.meta.dir, "../../../plugins/eden-memory"));
  const out = argument(args, "--out");
  const flush = argument(args, "--flush") === "eager" ? "eager" : "lagging";
  const runDir = out ? resolve(out) : mkdtempSync(join(tmpdir(), "eden-replay-"));
  mkdirSync(runDir, { recursive: true });
  try {
    const { summary, world } = await replay({ scenario, pluginDir, runDir, flush });
    if (out) {
      writeFileSync(join(runDir, "scenario.json"), JSON.stringify(scenario, null, 2));
      writeFileSync(join(runDir, "events.jsonl"), world.log.map((record) => JSON.stringify(record)).join("\n") + "\n");
      writeOracleFiles(world, join(runDir, "oracle"));
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (!out) rmSync(runDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main(process.argv.slice(2));
