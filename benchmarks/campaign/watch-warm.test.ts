/**
 * Wave 14.1 CI pin: watch-time warming of the next compiled read-only
 * program's first-wave reads.
 *
 *   bun test benchmarks/campaign/watch-warm.test.ts
 *
 * Pre-registered expect lives in watch-warm.ts (`EXPECT`) — before the run.
 * Not turnBoundary. Not warmWorkspaceBundle. unique-work is not retuned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { firstWaveReads } from "@eden/wrap";
import {
  CURRENT_MS,
  EXPECT,
  ISSUE_IDS,
  NEXT_MS,
  currentProgram,
  nextProgram,
  runWatchWarmCampaign,
  writeProgram,
} from "./watch-warm";

const TIMEOUT = 90_000;

afterEach(() => {
  delete process.env.EDEN_WATCH_WARM;
  delete process.env.EDEN_SPECULATE;
});

describe("rotation: watch-time warming (Wave 14.1)", () => {
  test("pre-registered expect is hit-rate delta, not turnBoundary / warmWorkspaceBundle", () => {
    console.log(`expect: ${EXPECT}`);
    expect(EXPECT).toContain("hit-rate");
    expect(EXPECT).toContain("EDEN_WATCH_WARM=0");
    expect(EXPECT).toContain("mutating execute count 0");
    expect(EXPECT).toContain("Not turnBoundary");
    expect(EXPECT).toContain("not warmWorkspaceBundle");
    expect(CURRENT_MS).toBeGreaterThan(0);
    expect(NEXT_MS).toBeGreaterThan(0);
    expect(ISSUE_IDS.length).toBeGreaterThanOrEqual(6);
    const wave = firstWaveReads(nextProgram(), { id: ISSUE_IDS[0] });
    expect(wave.map((w) => w.tool).sort()).toEqual(["getAssignees", "getLabels"]);
    expect(currentProgram().sequence).toEqual(["getIssue", "getComments"]);
    expect(writeProgram().sequence).toContain("writeRecord");
  });

  test(
    "treatment first-wave hit-rate > control; mutating execute count stays 0",
    async () => {
      const out = await runWatchWarmCampaign();
      console.log(
        `watch-warm hit-rate: ctrl=${out.controlHits}/${out.controlLookups} (${(out.controlRate * 100).toFixed(1)}%) trt=${out.treatmentHits}/${out.treatmentLookups} (${(out.treatmentRate * 100).toFixed(1)}%) Δhits=${out.treatmentHits - out.controlHits} n=${out.n} mutatingWrites=${out.mutatingWrites} mutatingExecutes=${out.mutatingExecutes}`,
      );
      expect(out.n).toBe(ISSUE_IDS.length);
      expect(out.controlLookups).toBeGreaterThan(0);
      expect(out.treatmentLookups).toBeGreaterThan(0);
      expect(out.treatmentHits).toBeGreaterThan(out.controlHits);
      expect(out.treatmentRate).toBeGreaterThan(out.controlRate);
      expect(out.mutatingWrites).toBe(0);
      expect(out.mutatingExecutes).toBe(0);
    },
    TIMEOUT,
  );
});
