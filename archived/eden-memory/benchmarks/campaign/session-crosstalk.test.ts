/**
 * Wave 4 rotation: session-crosstalk — identical entity ids on two sessions of
 * a shared store must not claim each other's tails. Did not tune Waves 1–3.
 */
import { describe, expect, test } from "bun:test";
import { createArmingStore, createState, wrapTools, type ToolDef } from "@eden/wrap";
import { fireOblivious, linearProgram } from "./struggle-harness";

function toolsFor(tag: string, writes: Record<string, number>): Record<string, ToolDef> {
  return {
    lookup: {
      description: "lookup",
      execute: async (args) => ({ name: "lookup", id: args.id, tag }),
    },
    write: {
      description: "write",
      execute: async (args) => {
        writes[tag] = (writes[tag] ?? 0) + 1;
        return { name: "write", id: args.id, tag };
      },
    },
    audit: {
      description: "audit",
      execute: async (args) => ({ name: "audit", id: args.id, tag }),
    },
  };
}

describe("rotation: session-crosstalk", () => {
  test("same entity id on two sessions — each session writes once", async () => {
    const writes: Record<string, number> = {};
    const prog = linearProgram("p_x", ["lookup", "write", "audit"], { text: true });
    const arming = createArmingStore();
    const a = wrapTools(
      toolsFor("a", writes),
      createState({ programs: [prog], arming, sessionId: "sess-a" }),
    ) as Record<string, ToolDef>;
    const b = wrapTools(
      toolsFor("b", writes),
      createState({ programs: [prog], arming, sessionId: "sess-b" }),
    ) as Record<string, ToolDef>;

    await Promise.all([
      fireOblivious(a, [
        { tool: "lookup", args: { id: "E-1", text: "a" } },
        { tool: "write", args: { id: "E-1" } },
        { tool: "audit", args: { id: "E-1" } },
      ]),
      fireOblivious(b, [
        { tool: "lookup", args: { id: "E-1", text: "b" } },
        { tool: "write", args: { id: "E-1" } },
        { tool: "audit", args: { id: "E-1" } },
      ]),
    ]);

    expect(writes.a).toBe(1);
    expect(writes.b).toBe(1);
  });
});
