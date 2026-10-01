import { describe, expect, test } from "bun:test";
import { composedRegistry } from "./compose";
import { runProgram, registryFrom } from "./index";
import type { StretchProgram, ToolRegistry } from "@eden/ir";

/**
 * Phase 3 engine fixes:
 *   M1 — branch arms no longer double-count toolCallsIssued
 *   M2 — composition honors sub.registry, forwards parent cancellation,
 *        and no longer hard-truncates sub-programs at 30s
 */

function linearProgram(steps: Array<{ id: string; tool: string }>): StretchProgram {
  return {
    id: "p_sub",
    version: "1",
    name: "sub_stretch",
    description: "test sub",
    inputSchema: { type: "object", properties: {}, required: [] },
    sequence: steps.map((s) => s.tool),
    steps: steps.map((s) => ({ id: s.id, kind: "tool", tool: s.tool, args: {} })),
    returns: { kind: "from", step: steps.at(-1)!.id, path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
    manifest: null,
  } as unknown as StretchProgram;
}

describe("M1: branch stepsRun accounting", () => {
  test("a branched run counts each arm tool exactly once", async () => {
    const prog: StretchProgram = {
      id: "p_br",
      version: "1",
      name: "branch_acc",
      description: "test branch",
      inputSchema: { type: "object", properties: {}, required: [] },
      sequence: ["check", "act_a", "act_b"],
      steps: [
        { id: "c0", kind: "tool", tool: "check", args: {} },
        { id: "br", kind: "branch", expr: "go == true", then: ["a1", "a2"], else: [] },
        { id: "a1", kind: "tool", tool: "act_a", args: {} },
        { id: "a2", kind: "tool", tool: "act_b", args: {} },
      ],
      // Branch result carries forward as the return value.
      returns: { kind: "literal", value: null },
      contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
      manifest: null,
    } as unknown as StretchProgram;
    let calls = 0;
    const reg = registryFrom({
      check: async () => ({ go: true }),
      act_a: async () => {
        calls++;
        return 1;
      },
      act_b: async () => {
        calls++;
        return 2;
      },
    });
    const res = await runProgram(prog, {}, { registry: reg });
    expect(calls).toBe(2);
    // check + two arm tools = 3 executions. The old double-count reported 4.
    expect(res.stats.stepsRun).toBe(3);
    // stats.toolCalls lists arm tools only for the branch step; check is the
    // linear prefix and appears via its own execution.
    expect(res.stats.toolCalls).toContain("act_a");
    expect(res.stats.toolCalls).toContain("act_b");
  });
});

describe("M2: composedRegistry", () => {
  function subProgram(): StretchProgram {
    return linearProgram([{ id: "s0", tool: "inner_only" }]);
  }

  test("honors a dedicated sub.registry instead of silently sharing base tools", async () => {
    const innerCalls: string[] = [];
    const dedicated: ToolRegistry = {
      has: (n) => n === "inner_only",
      execute: async (n) => {
        innerCalls.push(n);
        return "from-dedicated";
      },
    };
    const reg = composedRegistry(
      { outer: async () => "base" },
      { sub: { program: subProgram(), registry: dedicated } },
    );
    const out = await reg.execute("sub", {});
    expect(out).toBe("from-dedicated");
    expect(innerCalls).toEqual(["inner_only"]);
  });

  test("parent cancellation aborts the running sub-program", async () => {
    const ac = new AbortController();
    const reg = composedRegistry(
      {},
      {
        sub: {
          program: subProgram(),
          registry: {
            has: () => true,
            execute: async (_n, _a, c) => {
              // The forwarded signal must already read aborted here.
              if (c?.signal?.aborted) throw new Error("child saw abort");
              return "x";
            },
          },
        },
      },
    );
    ac.abort();
    await expect(reg.execute("sub", {}, { signal: ac.signal })).rejects.toThrow();
  });

  test("EDEN_SUB_TIMEOUT_MS bounds a hanging sub-program (was a hard 30s)", async () => {
    process.env.EDEN_SUB_TIMEOUT_MS = "120";
    try {
      const reg = composedRegistry(
        {},
        {
          sub: {
            program: subProgram(),
            registry: {
              has: () => true,
              execute: () => new Promise(() => undefined), // never settles
            },
          },
        },
      );
      const t0 = Date.now();
      await expect(reg.execute("sub", {})).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally {
      delete process.env.EDEN_SUB_TIMEOUT_MS;
    }
  });
});
