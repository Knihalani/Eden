import { describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import { runProgram, registryFrom } from "./index";

/**
 * Witnessed branch execution (G2).
 *
 * The IR now expresses `branch` steps whose predicate selects between two
 * pre-compiled arms. The compiler is expected to only ship branches where
 * BOTH arms have taped witnesses — but the runtime must execute whichever
 * arm the predicate selects, deterministically, without touching the other.
 */
function branchProgram(): StretchProgram {
  return {
    id: "p_branch",
    version: "1",
    name: "ci_gate",
    description: "Check CI then fix or notify.",
    inputSchema: { type: "object", properties: { pr: { type: "number" } }, required: ["pr"] },
    sequence: ["get_status", "branch_ci", "fix_build", "notify_done"],
    steps: [
      {
        id: "get_status",
        kind: "tool",
        tool: "inspect",
        args: { pr: { kind: "input", path: "pr" } },
      },
      {
        id: "branch_ci",
        kind: "branch",
        expr: 'state == "failure"',
        then: ["fix_build"],
        else: ["notify_done"],
      },
      { id: "fix_build", kind: "tool", tool: "fix", args: { pr: { kind: "input", path: "pr" } } },
      { id: "notify_done", kind: "tool", tool: "notify", args: {} },
    ],
    returns: { kind: "from", step: "branch_ci", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: false },
    manifest: null,
  } as unknown as StretchProgram;
}

describe("branch step execution (G2)", () => {
  function makeWorld(state: string) {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const registry = registryFrom({
      inspect: async (args) => { calls.push({ tool: "inspect", args }); return { state }; },
      fix: async (args) => { calls.push({ tool: "fix", args }); return { fixed: true }; },
      notify: async () => { calls.push({ tool: "notify", args: {} }); return { notified: true }; },
    });
    return { registry, calls };
  }

  test("failure state routes to fix arm", async () => {
    const { registry, calls } = makeWorld("failure");
    const out = await runProgram(branchProgram(), { pr: 12 }, { registry, checkEnvelope: false });
    expect(out.stats.llmCalls).toBe(0);
    expect(calls.map((c) => c.tool)).toEqual(["inspect", "fix"]);
    expect(out.value).toEqual({ fixed: true });
  });

  test("success state skips to notify arm", async () => {
    const { registry, calls } = makeWorld("success");
    const out = await runProgram(branchProgram(), { pr: 7 }, { registry, checkEnvelope: false });
    expect(calls.map((c) => c.tool)).toEqual(["inspect", "notify"]);
    expect(out.value).toEqual({ notified: true });
  });

  test("only the selected arm's tools fire — the skipped arm never touches the world", async () => {
    const world = makeWorld("success");
    await runProgram(branchProgram(), { pr: 1 }, { registry: world.registry, checkEnvelope: false });
    expect(world.calls.some((c) => c.tool === "fix")).toBe(false);
  });
});

function naryProgram(): StretchProgram {
  return {
    id: "p_nary",
    version: "1",
    name: "sev_gate",
    description: "Three witnessed arms on one branch.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    sequence: ["get_alert", "branch_sev"],
    steps: [
      {
        id: "get_alert",
        kind: "tool",
        tool: "inspect",
        args: { id: { kind: "input", path: "id" } },
      },
      {
        id: "branch_sev",
        kind: "branch",
        expr: 'sev == "p0"',
        then: ["page"],
        cases: [{ expr: 'sev == "p1"', steps: ["ticket"] }],
        else: ["log"],
      },
      { id: "page", kind: "tool", tool: "page", args: {} },
      { id: "ticket", kind: "tool", tool: "ticket", args: {} },
      { id: "log", kind: "tool", tool: "log", args: {} },
    ],
    returns: { kind: "from", step: "branch_sev", path: "" },
    contract: { witnesses: 9, minLlmReduction: 2, allowExact: false },
    manifest: null,
  } as unknown as StretchProgram;
}

function nestedElseProgram(): StretchProgram {
  return {
    id: "p_nested",
    version: "1",
    name: "nested_else",
    description: "Old binary else-of-else still executes.",
    inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    sequence: ["get_alert", "branch_outer"],
    steps: [
      {
        id: "get_alert",
        kind: "tool",
        tool: "inspect",
        args: { id: { kind: "input", path: "id" } },
      },
      {
        id: "branch_outer",
        kind: "branch",
        expr: 'sev == "p0"',
        then: ["page"],
        else: ["branch_inner"],
      },
      {
        id: "branch_inner",
        kind: "branch",
        expr: 'sev == "p1"',
        then: ["ticket"],
        else: ["log"],
      },
      { id: "page", kind: "tool", tool: "page", args: {} },
      { id: "ticket", kind: "tool", tool: "ticket", args: {} },
      { id: "log", kind: "tool", tool: "log", args: {} },
    ],
    returns: { kind: "from", step: "branch_outer", path: "" },
    contract: { witnesses: 9, minLlmReduction: 2, allowExact: false },
    manifest: null,
  } as unknown as StretchProgram;
}

describe("n-way branch cases", () => {
  function sevRegistry(sev: string, calls: string[]) {
    return registryFrom({
      inspect: async () => ({ sev }),
      page: async () => {
        calls.push("page");
        return { paged: true };
      },
      ticket: async () => {
        calls.push("ticket");
        return { ticketed: true };
      },
      log: async () => {
        calls.push("log");
        return { logged: true };
      },
    });
  }

  test("3-way cases fire exactly one arm", async () => {
    const expected: Array<{ sev: string; tool: string; value: Record<string, boolean> }> = [
      { sev: "p0", tool: "page", value: { paged: true } },
      { sev: "p1", tool: "ticket", value: { ticketed: true } },
      { sev: "p2", tool: "log", value: { logged: true } },
    ];
    for (const arm of expected) {
      const calls: string[] = [];
      const out = await runProgram(naryProgram(), { id: 1 }, { registry: sevRegistry(arm.sev, calls), checkEnvelope: false });
      expect(calls).toEqual([arm.tool]);
      expect(out.value).toEqual(arm.value);
    }
  });

  test("nested branch-in-else still selects the matching inner arm", async () => {
    for (const arm of [
      { sev: "p0", tool: "page" },
      { sev: "p1", tool: "ticket" },
      { sev: "p2", tool: "log" },
    ]) {
      const calls: string[] = [];
      await runProgram(nestedElseProgram(), { id: 1 }, { registry: sevRegistry(arm.sev, calls), checkEnvelope: false });
      expect(calls).toEqual([arm.tool]);
    }
  });
});
