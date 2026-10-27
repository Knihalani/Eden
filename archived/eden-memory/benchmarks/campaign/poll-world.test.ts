/**
 * Wave 14.3 CI pin: polling-shaped traces mine a program that does not re-poll.
 * Unique-work still refuses. Not a retune of thrash-enforce.
 *
 *   bun test benchmarks/campaign/poll-world.test.ts
 */
import { describe, expect, test } from "bun:test";
import { compileTraces } from "@eden/compile";
import {
  EXPECT,
  JOB_IDS,
  POLL_TOOL,
  compiledPollCount,
  minePollWorld,
  pollWorldTraces,
  rawPollCount,
  runCompiledPollWorld,
  uniqueWorkTraces,
} from "./poll-world";

describe("rotation: poll-world negative-space (Wave 14.3)", () => {
  test("pre-registered expect is a polling world, not a retune of thrash-enforce", () => {
    console.log(`expect: ${EXPECT}`);
    expect(EXPECT).toContain("zero poll");
    expect(EXPECT.toLowerCase()).toContain("unique-work");
    expect(EXPECT.toLowerCase()).not.toMatch(/thrash-enforce|thrash_enforce|loop-breaker/);
  });

  test("mined sequence has zero poll tools; running it never calls get_status; unique-work refuses", async () => {
    const traces = pollWorldTraces();
    const raw = rawPollCount(traces);
    expect(raw).toBeGreaterThan(0);

    const program = minePollWorld();
    const compiled = compiledPollCount(program);
    expect(compiled).toBe(0);
    expect(program.sequence ?? []).not.toContain(POLL_TOOL);
    expect((program.sequence ?? []).some((n) => /status|poll/i.test(n))).toBe(false);
    expect(program.sequence).toEqual(["get_job", "merge", "notify"]);

    const { counts } = await runCompiledPollWorld(program, { id: JOB_IDS[0] });
    expect(counts.get_status).toBe(0);
    expect(counts.get_job).toBe(1);
    expect(counts.merge).toBe(1);
    expect(counts.notify).toBe(1);

    const unique = compileTraces(uniqueWorkTraces());
    expect(unique.programs.length).toBe(0);
    expect(unique.refusals).toEqual([]);

    console.log(
      `poll-world: raw_polls=${raw} compiled_polls=${compiled} seq=${(program.sequence ?? []).join("→")} ` +
        `unique_work_programs=${unique.programs.length} replay_get_status=${counts.get_status}`,
    );
  });
});
