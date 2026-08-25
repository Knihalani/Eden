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
