/**
 * P0.0a target 5, the gate: the canonical R6-shaped session replayed through `plugins/eden-memory` from
 * this tree, every hook in its own process. Run twice, each time in a fresh process and from run
 * directories of different lengths; then once more through the deterministic probe plugin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles, replay, type ReplaySummary } from "./replay";
import { projectSlug } from "./rng";
import { canonicalSession } from "./shape";
import { PROBE_PLUGIN, removeTempDirs, tempDir } from "./testkit";

afterAll(removeTempDirs);

const REPLAY = join(import.meta.dir, "replay.ts");

function runReplay(...args: string[]): ReplaySummary {
  const run = Bun.spawnSync(["bun", REPLAY, ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`replay exited ${run.exitCode}: ${run.stderr.toString()}`);
  return JSON.parse(run.stdout.toString()) as ReplaySummary;
}

describe("the canonical session through plugins/eden-memory", () => {
  let first: ReplaySummary;
  let second: ReplaySummary;
  beforeAll(() => {
    first = runReplay();
    second = runReplay("--out", join(tempDir("eden-replay-from-a-run-directory-with-a-longer-name"), "run"));
  }, 120_000);

  test("it has every feature and R6's proportions", () => {
    expect(first.plugin).toBe("eden-memory");
    expect(first.shape).toEqual({
      humanPrompts: 6,
      nonHumanSubmits: 10,
      subagentWindows: 8,
      rewinds: 1,
      compactions: 1,
    });
    expect(first.skippedSteps).toBe(0);
  });

  test("every event the plugin registers ran, each invocation in its own process", () => {
    expect(first.invocations).toBeGreaterThan(50);
    expect(first.processes).toBe(first.invocations);
    for (const point of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SubagentStop", "PreCompact"]) {
      expect(first.msByPoint[point]).toBeDefined();
    }
  });

  test("100% of invocations exit 0 with output Claude Code accepts, and print nothing on stderr", () => {
    expect(first.exitCodes).toEqual({ "0": first.invocations });
    expect(first.failOpen).toEqual({ nonZeroExit: 0, timedOut: 0, withStderr: 0, rejectedOutput: 0 });
    expect(first.blocked).toBe(0);
  });

  test("two fresh runs from different run directories give the identical events, payloads and exit codes", () => {
    expect(second.digest).toBe(first.digest);
    expect(second.eventsByPoint).toEqual(first.eventsByPoint);
    expect(second.exitCodes).toEqual(first.exitCodes);
  });

  test("an eager transcript changes nothing the plugin's contract cares about", () => {
    const eager = runReplay("--flush", "eager");
    expect(eager.eventsByPoint).toEqual(first.eventsByPoint);
    expect(eager.failOpen).toEqual(first.failOpen);
  }, 60_000);
});

describe("with a deterministic plugin, a run is reproducible to the byte", () => {
  /** The probe in context mode through the canonical session; transcripts with the run directory taken out. */
  async function probeRun(prefix: string) {
    const runDir = tempDir(prefix);
    const out = join(runDir, "probe-out");
    mkdirSync(out);
    const env = { PROBE_OUT: out, PROBE_MODE: "context" };
    const { summary, world } = await replay({ script: canonicalSession(), pluginDir: PROBE_PLUGIN, runDir, env });
    const portable = (text: string) =>
      text.replaceAll(world.runDir, "<run>").replaceAll(projectSlug(world.projectDir), "<slug>");
    const transcripts = listFiles(join(world.home, ".claude", "projects"))
      .filter((path) => path.endsWith(".jsonl"))
      .map((path) => ({ path: portable(path), text: portable(readFileSync(path, "utf8")) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { summary, transcripts };
  }

  test("two runs from run directories of different lengths: same digest, contexts and transcripts", async () => {
    const short = await probeRun("p");
    const long = await probeRun("eden-probe-run-from-a-much-longer-run-directory-name");
    expect(long.summary.digest).toBe(short.summary.digest);
    expect(long.summary.contexts).toBe(short.summary.contexts);
    expect(short.summary.contexts).toBeGreaterThan(0);
    expect(long.transcripts.length).toBe(9);
    expect(long.transcripts).toEqual(short.transcripts);
  }, 60_000);
});
