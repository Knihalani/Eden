import { describe, expect, test } from "bun:test";
import type { StretchTrace } from "@eden/ir";
import { assertValid, inDistribution } from "@eden/ir";
import { findForkedGroups, assembleForkProgram } from "./fork";
import { compileTraces } from "./index";
import { registryFrom, runProgram } from "@eden/runtime";

/**
 * Fork mining (G2): detect where witnesses share a prefix then split into
 * two witnessed arms with a clean separating predicate.
 *
 * The assembly tests here EXECUTE the assembled program through runProgram —
 * an earlier version of this suite only checked that assembly returned
 * something, wrapped in `if (prog)`, so a program that deopted on every input
 * shipped "tested".
 */
describe("fork mining", () => {
  function ciTrace(id: string, ciState: string, tail: string[]): StretchTrace {
    return {
      id,
      events: [
        { name: "get_ci", args: { pr: 12 }, result: { state: ciState }, ok: true },
        ...tail.map((name) => ({ name, args: {}, result: { done: true }, ok: true })),
      ],
      input: { pr: 12 },
      output: { done: true },
      llmCalls: 4,
      duration_ms: 4000,
      cost_cents: 4,
      complete: true,
    };
  }

  // Varying pr per witness so `pr` binds as an input path and the envelope
  // has real witnessed values.
  function variedTrace(id: string, state: string, tail: string[], pr: number): StretchTrace {
    return {
      id,
      events: [
        { name: "get_ci", args: { pr }, result: { state, pr }, ok: true },
        ...tail.map((name) => ({ name, args: { pr }, result: { done: true, pr }, ok: true })),
      ],
      input: { pr },
      output: { done: true },
      llmCalls: 4,
      duration_ms: 4000,
      cost_cents: 4,
      complete: true,
    };
  }

  function failingFixture(): StretchTrace[] {
    return [
      variedTrace("t1", "failure", ["fix_build", "notify"], 101),
      variedTrace("t2", "failure", ["fix_build", "notify"], 102),
      variedTrace("t3", "failure", ["fix_build", "notify"], 103),
      variedTrace("t4", "success", ["notify"], 201),
      variedTrace("t5", "success", ["notify"], 202),
      variedTrace("t6", "success", ["notify"], 203),
    ];
  }

  test("detects a CI-gate fork: failure→fix vs success→notify", () => {
    const traces = [
      ciTrace("t1", "failure", ["fix_build", "notify"]),
      ciTrace("t2", "failure", ["fix_build", "notify"]),
      ciTrace("t3", "failure", ["fix_build", "notify"]),
      ciTrace("t4", "success", ["notify"]),
      ciTrace("t5", "success", ["notify"]),
      ciTrace("t6", "success", ["notify"]),
    ];
    const forks = findForkedGroups(traces, 3);
    expect(forks.length).toBe(1);
    const f = forks[0]!;
    expect(f.prefixNames).toEqual(["get_ci"]);
    expect(f.field).toBe("state");
    expect(f.thenValue).toBe("failure");
    expect(f.thenSuffix).toEqual(["fix_build", "notify"]);
    expect(f.elseTraces.length).toBe(3);
  });

  test("no fork when all traces share the same sequence", () => {
    const traces = [
      ciTrace("a", "open", ["act"]),
      ciTrace("b", "open", ["act"]),
      ciTrace("c", "open", ["act"]),
    ];
    expect(findForkedGroups(traces, 3)).toHaveLength(0);
  });

  test("insufficient witnesses refuse cleanly", () => {
    const traces = [
      ciTrace("solo_a", "failure", ["fix_build"]),
      ciTrace("solo_b", "success", ["notify"]),
    ];
    expect(findForkedGroups(traces, 3)).toHaveLength(0);
  });

  test("assembly passes validation and puts the envelope INSIDE the contract", () => {
    const forks = findForkedGroups(failingFixture(), 3);
    expect(forks.length).toBe(1);
    const prog = assembleForkProgram(forks[0]!, "test_branch_prog", "ci_gate");
    expect(prog).not.toBeNull();
    expect(prog!.steps.some((s) => s.kind === "branch")).toBe(true);
    // C1 regression: the envelope must live at contract.envelope. The old
    // top-level placement was invisible to inDistribution(), so every fork
    // program deopted on every input.
    const contract = prog!.contract as { envelope?: { inputs?: Record<string, unknown[]> } };
    expect(contract.envelope?.inputs?.pr).toBeDefined();
    expect(() => assertValid(prog!)).not.toThrow();
  });

  test("inDistribution accepts witnessed inputs and refuses unseen ones", () => {
    const forks = findForkedGroups(failingFixture(), 3);
    const prog = assembleForkProgram(forks[0]!, "t", "ci_gate")!;
    expect(inDistribution(prog, { pr: 103 })).toBe(true);
    expect(inDistribution(prog, { pr: 999999 })).toBe(false);
  });

  test("runProgram executes the THEN arm when the separator matches", async () => {
    const forks = findForkedGroups(failingFixture(), 3);
    const prog = assembleForkProgram(forks[0]!, "t", "ci_gate")!;
    const calls: string[] = [];
    const reg = registryFrom({
      get_ci: async () => ({ state: "failure" }),
      fix_build: async () => {
        calls.push("fix_build");
        return { fixed: true };
      },
      notify: async () => {
        calls.push("notify");
        return { notified: true };
      },
    });
    const res = await runProgram(prog, { pr: 103 }, { registry: reg });
    expect(calls).toContain("fix_build");
    expect(res.value).toEqual({ notified: true });
  });

  test("runProgram executes the ELSE arm and returns ITS value (C2 regression)", async () => {
    // The old then-preferred `returns` binding threw on every else-arm run:
    // the then steps never executed, so evaluating the return binding hit an
    // unknown step. Both arms must return their own last value.
    const forks = findForkedGroups(failingFixture(), 3);
    const prog = assembleForkProgram(forks[0]!, "t", "ci_gate")!;
    const calls: string[] = [];
    const reg = registryFrom({
      get_ci: async () => ({ state: "success" }),
      fix_build: async () => {
        calls.push("fix_build");
        return { fixed: true };
      },
      notify: async () => {
        calls.push("notify");
        return { notified: true };
      },
    });
    const res = await runProgram(prog, { pr: 201 }, { registry: reg });
    expect(calls).toEqual(["notify"]); // else arm only — no fix attempt
    expect(res.value).toEqual({ notified: true });
    expect(res.stats.deopt).toBe(false);
  });

  test("compileTraces emits ONE stable branched program across repeated compiles", () => {
    // Stable identity regression: the old positional fork_0/fork_1 ids changed
    // meaning whenever a different candidate set mined first.
    const mined1 = compileTraces(failingFixture());
    const mined2 = compileTraces(failingFixture());
    const branch1 = mined1.programs.filter((p) => p.steps?.some((s) => s.kind === "branch"));
    expect(branch1.length).toBe(1);
    const branch2 = mined2.programs.find((p) => p.id === branch1[0]!.id);
    expect(branch2).toBeDefined();
    expect(branch2!.version).toBe(branch1[0]!.version);
    expect(() => assertValid(branch1[0]!)).not.toThrow();
  });

  test("constant-output branched witnesses are refused, not compiled", () => {
    const traces = failingFixture().map((t) => ({ ...t, output: {} }));
    const mined = compileTraces(traces);
    const branches = mined.programs.filter((p) => p.steps?.some((s) => s.kind === "branch"));
    expect(branches).toHaveLength(0);
    expect(mined.refusals.some((r) => /empty or identical output/i.test(r.reason))).toBe(true);
  });
});
