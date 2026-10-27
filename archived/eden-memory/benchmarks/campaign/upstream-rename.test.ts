/**
 * Wave 6.2 CI pin: forced-upstream-rename queues an approvable draft with
 * zero manual mining. Real compileTraces + shadowProgram — not stubs.
 *
 *   bun test benchmarks/campaign/upstream-rename.test.ts
 */
import { describe, expect, test } from "bun:test";
import { REFRESH_WAITING_COPY as canvasCopy } from "../../apps/web/app/canvas/fail";
import { REFRESH_WAITING_COPY as canaryCopy } from "../../apps/site/src/canary";
import {
  EXPECT,
  makeRenameTraces,
  makeShortTraces,
  makeUnmeasuredRenameTraces,
  RENAMED_FIELD,
  runRenameViaCanary,
  runRenameViaWorkspace,
} from "./upstream-rename";

const TIMEOUT = 30_000;

describe("rotation: forced-upstream-rename (Wave 6)", () => {
  test("pre-registered expect is a field rename, not a retune of Waves 1–5", () => {
    console.log(`expect: ${EXPECT}`);
    expect(EXPECT).toContain("field rename");
    expect(EXPECT).toContain(`${RENAMED_FIELD.from}→${RENAMED_FIELD.to}`);
    expect(EXPECT).toContain("zero manual mining");
    expect(EXPECT.toLowerCase()).not.toMatch(/silent-drop|session-crosstalk|partial-iteration/);
  });

  test("Home/canvas and the draft row use the same words", () => {
    expect(canaryCopy).toBe(canvasCopy);
    expect(canaryCopy).toBe(
      "The outside world renamed a field. A replacement is waiting. The live tool is unchanged until you Approve.",
    );
  });

  test(
    "v2 traces (conclusion) → workspace sweep queues draft+knock; live stays On",
    async () => {
      const traces = makeRenameTraces(2);
      expect(JSON.stringify(traces)).toContain(`"${RENAMED_FIELD.to}"`);
      expect(JSON.stringify(traces)).not.toMatch(/"state":/);

      const run = await runRenameViaWorkspace({ traces, tag: "v2" });
      expect(run.expect).toBe(EXPECT);
      expect(run.compileCalls).toBeGreaterThanOrEqual(1);
      expect(run.seenBlob).toContain(`"${RENAMED_FIELD.to}"`);
      expect(run.seenBlob).not.toMatch(/"state":/);
      expect(run.liveState).toBe("on");
      expect(run.draftState).toBe("draft");
      expect(run.whenToUse).toBe(canaryCopy);
      expect(run.knockOnLive).toBe(true);
      expect(Array.isArray(run.draftSteps)).toBe(true);
      const steps = run.draftSteps as Array<{ name: string; url?: string }>;
      expect(steps.map((s) => s.name)).toEqual(["get_pr", "get_files", "get_status"]);
      expect(steps.every((s) => typeof s.url === "string" && s.url.length > 0)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "unmeasured v2 traces: real shadow is INCONCLUSIVE and queues nothing",
    async () => {
      const run = await runRenameViaCanary({ traces: makeUnmeasuredRenameTraces(), tag: "thin" });
      expect(run.compileCalls).toBeGreaterThanOrEqual(1);
      expect(run.seenBlob).toContain(`"${RENAMED_FIELD.to}"`);
      expect(run.outcome).toMatchObject({ action: "skipped", verdict: "INCONCLUSIVE" });
      expect(run.liveState).toBe("on");
      expect(run.draftState).toBeNull();
      expect(run.knockOnLive).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "too-short traces: real compile refuses and queues nothing",
    async () => {
      const run = await runRenameViaCanary({ traces: makeShortTraces(), tag: "short" });
      expect(run.compileCalls).toBeGreaterThanOrEqual(1);
      expect(run.outcome.action).toBe("recompile-refused");
      expect(run.liveState).toBe("on");
      expect(run.draftState).toBeNull();
      expect(run.knockOnLive).toBe(false);
    },
    TIMEOUT,
  );
});
