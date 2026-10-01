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
    expect(f.nestedArms).toBeUndefined();
  });

  test("no fork when all traces share the same sequence", () => {
    const traces = [ciTrace("a", "open", ["act"]), ciTrace("b", "open", ["act"]), ciTrace("c", "open", ["act"])];
    expect(findForkedGroups(traces, 3)).toHaveLength(0);
  });

  test("insufficient witnesses refuse cleanly", () => {
    const traces = [ciTrace("solo_a", "failure", ["fix_build"]), ciTrace("solo_b", "success", ["notify"])];
    expect(findForkedGroups(traces, 3)).toHaveLength(0);
  });

  test("assembly passes validation and puts the envelope INSIDE the contract", () => {
    const forks = findForkedGroups(failingFixture(), 3);
    expect(forks.length).toBe(1);
    const prog = assembleForkProgram(forks[0]!, "test_branch_prog", "ci_gate");
    expect(prog).not.toBeNull();
    expect(prog!.steps.some((s) => s.kind === "branch")).toBe(true);
    const br = prog!.steps.find((s) => s.kind === "branch");
    expect(br && br.kind === "branch" && br.cases).toBeUndefined();
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

  test("compileTraces prefers the fork over its linear arms", () => {
    const traces = [
      variedTrace("g0", "green", ["merge_pr", "notify"], 10),
      variedTrace("g1", "green", ["merge_pr", "notify"], 11),
      variedTrace("g2", "green", ["merge_pr", "notify"], 12),
      variedTrace("r0", "red", ["comment_pr", "notify"], 20),
      variedTrace("r1", "red", ["comment_pr", "notify"], 21),
      variedTrace("r2", "red", ["comment_pr", "notify"], 22),
    ];
    const mined = compileTraces(traces);
    const branches = mined.programs.filter((p) => p.steps?.some((s) => s.kind === "branch"));
    expect(branches).toHaveLength(1);
    expect(mined.programs).toHaveLength(1);
    expect(mined.programs[0]!.name).toMatch(/forked_state_gate/);
    const br = branches[0]!.steps.find((s) => s.kind === "branch");
    expect(br && br.kind === "branch" && br.cases).toBeUndefined();
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
    expect(mined.refusals.some((r) => r.code === "empty_output" || /empty or identical output/i.test(r.reason))).toBe(
      true,
    );
  });

  test("compileTraces does not mine a fork when an arm has fewer than 3 witnesses", () => {
    const traces = [
      variedTrace("t1", "failure", ["fix_build", "notify"], 101),
      variedTrace("t2", "failure", ["fix_build", "notify"], 102),
      variedTrace("t4", "success", ["notify"], 201),
      variedTrace("t5", "success", ["notify"], 202),
      variedTrace("t6", "success", ["notify"], 203),
    ];
    const mined = compileTraces(traces);
    const branches = mined.programs.filter((p) => p.steps?.some((s) => s.kind === "branch"));
    expect(branches).toHaveLength(0);
  });

  function unboundWriteArmTraces(): StretchTrace[] {
    return [
      ...[101, 102, 103].map((pr, i) => ({
        id: `fail-${i}`,
        events: [
          { name: "get_ci", args: { pr }, result: { state: "failure", pr }, ok: true },
          { name: "writeRecord", args: { id: `OTHER-${pr}` }, result: { wrote: true }, ok: true },
          { name: "notify", args: { pr }, result: { done: true, pr }, ok: true },
        ],
        input: { pr },
        output: { done: true },
        llmCalls: 4,
        duration_ms: 4000,
        cost_cents: 4,
        complete: true,
      })),
      ...[201, 202, 203].map((pr, i) => ({
        id: `ok-${i}`,
        events: [
          { name: "get_ci", args: { pr }, result: { state: "success", pr }, ok: true },
          { name: "merge_pr", args: { pr }, result: { done: true, pr }, ok: true },
          { name: "notify", args: { pr }, result: { done: true, pr }, ok: true },
        ],
        input: { pr },
        output: { done: true },
        llmCalls: 4,
        duration_ms: 4000,
        cost_cents: 4,
        complete: true,
      })),
    ];
  }

  test("mutating unbound arm refuses as underdetermined_write, not a guessed bind", () => {
    const traces = unboundWriteArmTraces();
    const forks = findForkedGroups(traces, 3);
    expect(forks.length).toBe(1);
    const prog = assembleForkProgram(forks[0]!, "t", "ci_gate");
    expect(prog).toBeNull();
    expect(forks[0]!.assembleRefuse?.code).toBe("underdetermined_write");
    expect(forks[0]!.assembleRefuse?.slot).toMatch(/writeRecord/);

    const mined = compileTraces(traces);
    const branches = mined.programs.filter((p) => p.steps?.some((s) => s.kind === "branch"));
    expect(branches).toHaveLength(0);
    const forkWrite = mined.refusals.find(
      (r) => r.code === "underdetermined_write" && r.sequence.some((s) => s.startsWith("branch_")),
    );
    expect(forkWrite).toBeDefined();
    expect(forkWrite!.reason.toLowerCase()).toMatch(/under-determined|mutating/);
    // No guessed literal bind of OTHER-* onto writeRecord.id.
    for (const p of mined.programs) {
      for (const s of p.steps) {
        if (s.kind !== "tool" || s.tool !== "writeRecord") continue;
        const idBind = s.args?.id;
        expect(idBind).not.toEqual({ kind: "literal", value: "OTHER-101" });
      }
    }
  });

  test("MAX_PROGRAMS=24: extras are max_programs refusals; a fork cannot sneak past the cap", () => {
    const traces: StretchTrace[] = [];
    for (let k = 0; k < 24; k++) {
      for (let i = 0; i < 3; i++) {
        const id = `C${k}-${i}`;
        traces.push({
          id: `lin-${k}-${i}`,
          events: [
            { name: `getCluster${k}`, args: { id }, result: { id, ok: true }, ok: true },
            { name: `writeCluster${k}`, args: { id }, result: { wrote: true, id }, ok: true },
            { name: `notifyCluster${k}`, args: { id }, result: { done: true, id }, ok: true },
          ],
          input: { id },
          output: { done: true, k, i },
          llmCalls: 3,
          duration_ms: 30,
          cost_cents: 3,
          complete: true,
        });
      }
    }
    traces.push(...failingFixture());
    const mined = compileTraces(traces);
    expect(mined.programs.length).toBeLessThanOrEqual(24);
    expect(mined.programs.length).toBe(24);
    expect(mined.refusals.some((r) => r.code === "max_programs")).toBe(true);
    const forkInPrograms = mined.programs.some((p) => p.steps?.some((s) => s.kind === "branch"));
    const forkCapped = mined.refusals.some(
      (r) => r.code === "max_programs" && r.sequence.some((s) => s.startsWith("branch_")),
    );
    expect(forkInPrograms || forkCapped).toBe(true);
    expect(
      mined.programs.length + mined.refusals.filter((r) => r.code === "max_programs").length,
    ).toBeGreaterThanOrEqual(25);
  });

  function alertTrace(id: string, sev: string, arm: [string, string], alertId: number): StretchTrace {
    const alert = `al-${alertId}`;
    return {
      id,
      events: [
        { name: "getAlert", args: { id: alertId }, result: { sev, alert }, ok: true },
        { name: arm[0], args: { alert }, result: { acked: true, alert }, ok: true },
        { name: arm[1], args: { alert }, result: { done: true, alert }, ok: true },
      ],
      input: { id: alertId },
      output: { done: true },
      llmCalls: 4,
      duration_ms: 40,
      cost_cents: 4,
      complete: true,
    };
  }

  function threeArmTraces(): StretchTrace[] {
    return [
      ...[10, 11, 12].map((id, i) => alertTrace(`p0-${i}`, "p0", ["createPage", "sendAckPage"], id)),
      ...[20, 21, 22].map((id, i) => alertTrace(`p1-${i}`, "p1", ["createTicket", "sendAckTicket"], id)),
      ...[30, 31, 32].map((id, i) => alertTrace(`p2-${i}`, "p2", ["writeLog", "sendAckLog"], id)),
    ];
  }

  test("3-way fork is one program with one n-way branch (then + 1 case + else)", async () => {
    const traces = threeArmTraces();
    const forks = findForkedGroups(traces, 3);
    expect(forks).toHaveLength(1);
    expect(forks[0]!.nestedArms?.length).toBe(2);
    const mined = compileTraces(traces);
    const branches = mined.programs.filter((p) => p.steps.some((s) => s.kind === "branch"));
    expect(branches).toHaveLength(1);
    expect(mined.programs).toHaveLength(1);
    const p = branches[0]!;
    const brs = p.steps.filter((s) => s.kind === "branch");
    expect(brs).toHaveLength(1);
    const br = brs[0]!;
    expect(br.kind).toBe("branch");
    if (br.kind === "branch") {
      expect(br.cases).toHaveLength(1);
      expect(br.then.length).toBeGreaterThan(0);
      expect((br.else ?? []).length).toBeGreaterThan(0);
    }
    const arms = {
      p0: ["createPage", "sendAckPage"],
      p1: ["createTicket", "sendAckTicket"],
      p2: ["writeLog", "sendAckLog"],
    };
    for (const [sev, tools] of Object.entries(arms)) {
      const calls: string[] = [];
      const reg = registryFrom({
        getAlert: async ({ id }) => ({ sev, alert: `al-${id}` }),
        createPage: async () => {
          calls.push("createPage");
          return { acked: true };
        },
        sendAckPage: async () => {
          calls.push("sendAckPage");
          return { done: true };
        },
        createTicket: async () => {
          calls.push("createTicket");
          return { acked: true };
        },
        sendAckTicket: async () => {
          calls.push("sendAckTicket");
          return { done: true };
        },
        writeLog: async () => {
          calls.push("writeLog");
          return { acked: true };
        },
        sendAckLog: async () => {
          calls.push("sendAckLog");
          return { done: true };
        },
      });
      await runProgram(p, { id: sev === "p0" ? 10 : sev === "p1" ? 20 : 30 }, { registry: reg });
      expect(calls).toEqual(tools);
    }
  });
});
