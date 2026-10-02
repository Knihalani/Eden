/**
 * P0.0a target 5, the gate: the canonical R6-shaped session replayed through `plugins/eden-memory` from
 * this tree, every hook in its own process. Run twice, each time in a fresh process.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ReplaySummary } from "./replay";

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
    second = runReplay();
  }, 120_000);

  test("it has every feature and R6's proportions", () => {
    expect(first.plugin).toBe("eden-memory");
    expect(first.shape).toEqual({
      humanPrompts: 6,
      nonHumanSubmits: 8,
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

  test("two fresh runs give the identical event sequence, payloads and answers", () => {
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
