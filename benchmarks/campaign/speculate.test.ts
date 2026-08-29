/**
 * Wave 13.2 CI pin: turn-boundary speculation on a read-only production shape.
 *
 *   bun test benchmarks/campaign/speculate.test.ts
 *
 * Pre-registered expect lives in speculate.ts (`EXPECT`) — before the run.
 * Not fastdesk. unique-work / creative are imported, not retuned.
 */
import { describe, expect, test } from "bun:test";
import {
  EXPECT,
  ISSUE_MS,
  THINK_MS,
  githubReviewProgram,
  runGithubCampaign,
  runParity,
} from "./speculate";

const TIMEOUT = 90_000;

describe("rotation: turn-boundary speculation (Wave 13.2)", () => {
  test("pre-registered expect is read-only wall WIN, not fastdesk / PASTE 48.5%", () => {
    console.log(`expect: ${EXPECT}`);
    expect(EXPECT).toContain("WIN on wall");
    expect(EXPECT).toContain("getIssue");
    expect(EXPECT).toContain("getComments");
    expect(EXPECT).toContain("getChecks");
    expect(EXPECT).toContain("THINK_MS=120");
    expect(EXPECT).toMatch(/unique-work\/creative parity/);
    expect(EXPECT.toLowerCase()).not.toMatch(/fastdesk-live|createFastDesk/);
    expect(EXPECT).toMatch(/Not fastdesk/);
    expect(EXPECT).not.toMatch(/48\.5%/);
    expect(THINK_MS).toBe(120);
    expect(ISSUE_MS).toBeGreaterThan(0);
    const seq = githubReviewProgram().sequence ?? [];
    expect(seq).toEqual(["getIssue", "getComments", "getChecks"]);
  });

  test(
    "GitHub-like read-only speculation WINs on wall by overlapping think-time",
    async () => {
      const out = await runGithubCampaign();
      console.log(
        `github-review wall: verdict=${out.verdict} ctrl=${out.controlMean.toFixed(1)} trt=${out.treatmentMean.toFixed(1)} rel=${(out.relative * 100).toFixed(1)}% p=${out.p.toFixed(4)} n=${out.blocks}`,
      );
      expect(out.blocks).toBeGreaterThanOrEqual(6);
      expect(out.verdict).toBe("WIN");
      expect(out.treatmentMean).toBeLessThan(out.controlMean);
    },
    TIMEOUT,
  );

  test(
    "unique-work: speculation no-ops, parity ±1%",
    async () => {
      const out = await runParity("unique-work");
      console.log(
        `unique-work parity: rel=${(out.relative * 100).toFixed(2)}% ctrl=${out.controlMean.toFixed(1)} trt=${out.treatmentMean.toFixed(1)} execEqual=${out.execEqual}`,
      );
      expect(out.execEqual).toBe(true);
      expect(out.withinBand).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "creative: speculation no-ops, parity ±1%",
    async () => {
      const out = await runParity("creative");
      console.log(
        `creative parity: rel=${(out.relative * 100).toFixed(2)}% ctrl=${out.controlMean.toFixed(1)} trt=${out.treatmentMean.toFixed(1)} execEqual=${out.execEqual}`,
      );
      expect(out.execEqual).toBe(true);
      expect(out.withinBand).toBe(true);
    },
    TIMEOUT,
  );
});
