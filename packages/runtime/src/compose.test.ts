import { describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import type { ToolRegistry } from "@eden/ir";
import { runProgram } from "./execute";
import { composedRegistry } from "./compose";

/**
 * Tool composition (G6): a compiled tool becomes callable AS a tool by
 * other programs — Voyager's skill layering, but with admission gates.
 * The composed registry resolves sub-program names so a parent program's
 * steps can target them transparently.
 */
describe("composed registries", () => {
  const detailProgram: StretchProgram = {
    id: "sub_detail",
    version: "1",
    name: "fetch_detail",
    description: "Fetch ticket detail.",
    inputSchema: { type: "object", properties: { ticket_id: { type: "string" } }, required: ["ticket_id"] },
    sequence: ["fetchDetail"],
    steps: [
      { id: "fd", kind: "tool", tool: "fetchDetail", args: { ticket_id: { kind: "input", path: "ticket_id" } } },
    ],
    returns: { kind: "from", step: "fd", path: "" },
    contract: { witnesses: 2, minLlmReduction: 2, allowExact: false },
    manifest: null,
  } as unknown as StretchProgram;

  function makeBase(): { reg: ToolRegistry; calls: Array<{ tool: string; args: Record<string, unknown> }> } {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const base = {
      fetchDetail: async (args: Record<string, unknown>) => {
        calls.push({ tool: "fetchDetail", args });
        return { id: args.ticket_id, priority: "high" };
      },
      notify: async () => ({ notified: true }),
    };
    const reg = composedRegistry(base, {
      fetch_detail: { program: detailProgram },
    });
    return { reg, calls };
  }

  test("sub-program is addressable through the composed registry", async () => {
    const { reg, calls } = makeBase();
    expect(reg.has?.("fetch_detail")).toBe(true);
    expect(reg.has?.("fetchDetail")).toBe(true);
    const result = await reg.execute!("fetch_detail", { ticket_id: "T-1" });
    expect(result).toEqual({ id: "T-1", priority: "high" });
    expect(calls.some((c) => c.tool === "fetchDetail" && c.args.ticket_id === "T-1")).toBe(true);
  });

  test("a parent program calls the sub-program by name in a loop", async () => {
    const parent: StretchProgram = {
      id: "p_batch",
      version: "1",
      name: "batch_lookup",
      description: "Fetch ticket detail.",
      inputSchema: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" } } },
        required: ["ids"],
      },
      sequence: ["loop_ids"],
      steps: [
        {
          id: "loop_ids",
          kind: "loop",
          over: { kind: "input", path: "ids" },
          item: "id",
          body: ["call_detail"],
          parallel: true,
        },
        {
          id: "call_detail",
          kind: "tool",
          tool: "fetch_detail",
          args: { ticket_id: { kind: "from", step: "id", path: "" } },
        },
      ],
      returns: { kind: "from", step: "loop_ids", path: "" },
      contract: { witnesses: 2, minLlmReduction: 2, allowExact: false },
      manifest: null,
    } as unknown as StretchProgram;

    const { reg, calls } = makeBase();
    const out = await runProgram(parent, { ids: ["A", "B", "C"] }, {
      registry: reg,
      checkEnvelope: false,
    });
    expect(calls.filter((c) => c.tool === "fetchDetail").length).toBe(3);
    const results = out.value as Array<{ id: string; priority: string }>;
    expect(results.map((r) => r.id)).toEqual(["A", "B", "C"]);
  });

  test("base tools remain accessible alongside sub-programs", async () => {
    const { reg } = makeBase();
    expect(reg.has?.("fetchDetail")).toBe(true);
    expect(reg.has?.("notify")).toBe(true);
    expect(reg.has?.("fetch_detail")).toBe(true);
    const result = await reg.execute!("notify", {});
    expect(result).toEqual({ notified: true });
  });
});
