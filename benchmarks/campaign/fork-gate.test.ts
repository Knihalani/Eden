/**
 * Wave 14.4 CI pin: forked CI-gate still mines one branched program and
 * refuses dishonest arms. Overflow past 24 is a named max_programs row.
 *
 *   bun test benchmarks/campaign/fork-gate.test.ts
 *
 * Pre-registered expect: `EXPECT` in fork-gate.ts.
 * Do not retune thrash-enforce against this world.
 */
import { describe, expect, test } from "bun:test";
import { compileTraces } from "@eden/compile";
import {
  EXPECT,
  MAX_PROGRAMS,
  branchedPrograms,
  ciGateTraces,
  compileCiGate,
  emptyOutputTraces,
  forkInSoup,
  overflowSoup,
  shortArmTraces,
  unboundWriteArmTraces,
} from "./fork-gate";

describe("rotation: fork-gate (Wave 14.4)", () => {
  test("pre-registered expect is CI-gate honesty, not a retune of thrash-enforce", () => {
    console.log(`expect: ${EXPECT}`);
    expect(EXPECT).toContain("CI-gate");
    expect(EXPECT).toContain("max_programs");
    expect(EXPECT).toContain("underdetermined_write");
    expect(EXPECT.toLowerCase()).not.toMatch(/thrash-enforce|thrash enforce/);
  });

  test("CI-gate traces mine one branched program; both arms stay witnessed", () => {
    const mined = compileCiGate();
    const branches = branchedPrograms(mined);
    expect(branches).toHaveLength(1);
    expect(mined.programs).toHaveLength(1);
    expect(branches[0]!.name).toMatch(/forked_state_gate/);
    expect(branches[0]!.steps.some((s) => s.kind === "branch")).toBe(true);
    console.log(
      `fork-gate: programs=${mined.programs.length} branches=1 refusals=${mined.refusals.length}`,
    );
  });

  test("min-3 per arm: two failing witnesses do not mine a fork", () => {
    const mined = compileTraces(shortArmTraces());
    expect(branchedPrograms(mined)).toHaveLength(0);
  });

  test("empty output refuses with empty_output, not a compiled branch", () => {
    const mined = compileTraces(emptyOutputTraces());
    expect(branchedPrograms(mined)).toHaveLength(0);
    expect(mined.refusals.some((r) => r.code === "empty_output")).toBe(true);
  });

  test("unbound mutating arm refuses underdetermined_write, not a guessed bind", () => {
    const mined = compileTraces(unboundWriteArmTraces());
    expect(branchedPrograms(mined)).toHaveLength(0);
    const row = mined.refusals.find(
      (r) => r.code === "underdetermined_write" && r.sequence.some((s) => s.startsWith("branch_")),
    );
    expect(row).toBeDefined();
    expect(row!.reason.toLowerCase()).toMatch(/under-determined|mutating/);
    for (const p of mined.programs) {
      for (const s of p.steps) {
        if (s.kind !== "tool" || s.tool !== "writeRecord") continue;
        expect(s.args?.id).not.toEqual({ kind: "literal", value: "OTHER-101" });
      }
    }
  });

  test("MAX_PROGRAMS overflow is a named refusal; a fork cannot sneak past 24", () => {
    const mined = compileTraces(overflowSoup());
    expect(mined.programs.length).toBeLessThanOrEqual(MAX_PROGRAMS);
    expect(mined.programs.length).toBe(MAX_PROGRAMS);
    expect(mined.refusals.some((r) => r.code === "max_programs")).toBe(true);
    expect(forkInSoup(mined)).toBe(true);
    const extras = mined.refusals.filter((r) => r.code === "max_programs");
    expect(mined.programs.length + extras.length).toBeGreaterThanOrEqual(25);
    console.log(
      `fork-cap: programs=${mined.programs.length} max_programs=${extras.length} fork_in_soup=true`,
    );
  });

  test("happy-path fixture still detects the CI-gate shape", () => {
    expect(ciGateTraces()).toHaveLength(6);
  });
});
