import { describe, expect, test } from "bun:test";
import { inheritWidth } from "@eden/compile";
import { withVersion, type StretchProgram } from "@eden/ir";
import { inheritLiveTool } from "./inherit-live";
import { Store } from "./store";

const program = (): StretchProgram =>
  withVersion({
    id: "orders",
    name: "orders",
    description: "orders",
    inputSchema: { type: "object" },
    steps: [{ id: "a", kind: "tool", tool: "findOrder", args: { orderId: { kind: "input", path: "orderId" } } }],
    returns: { kind: "from", step: "a", path: "" },
    sequence: ["findOrder", "getItem", "getItem", "getItem", "writeNote"],
    contract: {
      witnesses: 3,
      minLlmReduction: 2,
      allowExact: false,
      envelope: { inputs: { orderId: ["O-10-0", "O-10-1"] } },
    },
    manifest: null,
  });

describe("inheritLiveTool", () => {
  test("two sibling receipts stay OOD; third inherits", () => {
    const store = new Store(":memory:");
    const p = program();
    store.putTool({
      id: p.id,
      name: p.name,
      version: p.version,
      program: p,
      state: "live",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const seq7 = ["findOrder", "getItem", "getItem", "writeNote"];
    for (let i = 0; i < 2; i++) {
      store.putReceipt({
        tool_id: p.id,
        version: p.version,
        ms: 1,
        llm_calls: 0,
        cents: 0,
        ok: 1,
        payload: JSON.stringify({
          input: { orderId: `O-7-${i}` },
          events: seq7.map((name) => ({ name, ok: true })),
        }),
      });
    }
    inheritLiveTool(store, p.id);
    expect(inheritWidth(store.tool(p.id)!.program, []).contract.envelope?.inputs.orderId).toEqual(["O-10-0", "O-10-1"]);
    store.putReceipt({
      tool_id: p.id,
      version: p.version,
      ms: 1,
      llm_calls: 0,
      cents: 0,
      ok: 1,
      payload: JSON.stringify({
        input: { orderId: "O-7-2" },
        events: seq7.map((name) => ({ name, ok: true })),
      }),
    });
    inheritLiveTool(store, p.id);
    const ids = store.tool(p.id)!.program.contract.envelope?.inputs.orderId ?? [];
    expect(ids).toContain("O-7-0");
    expect(ids).toContain("O-7-1");
    expect(ids).toContain("O-7-2");
  });

  test("in-distribution receipts do not bump version", () => {
    const store = new Store(":memory:");
    const p = program();
    store.putTool({
      id: p.id,
      name: p.name,
      version: p.version,
      program: p,
      state: "live",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    store.putReceipt({
      tool_id: p.id,
      version: p.version,
      ms: 1,
      llm_calls: 0,
      cents: 0,
      ok: 1,
      payload: JSON.stringify({ input: { orderId: "O-10-0" } }),
    });
    inheritLiveTool(store, p.id);
    expect(store.tool(p.id)!.version).toBe(p.version);
  });
});
