import { describe, expect, test } from "bun:test";
import { withVersion, type StretchProgram } from "@eden/ir";
import { createState, wrapTools } from "./index";

function prog(): StretchProgram {
  const sequence = ["lookup", "fetch", "write"];
  return withVersion({
    id: "p_idle",
    name: "p_idle",
    description: "d",
    inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
    sequence,
    steps: sequence.map((tool, i) => ({
      id: tool,
      kind: "tool" as const,
      tool,
      args: { id: { kind: "input" as const, path: "id" }, ...(i === 0 ? { text: { kind: "input" as const, path: "text" } } : {}) },
    })),
    returns: { kind: "from", step: "write", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
    manifest: { llmReduction: 2, latencyReduction: 1, costReduction: 2, skipRateBefore: 0, skipRateAfter: 0, nShadow: 3 },
  }) as StretchProgram;
}

async function usPerCall(fn: () => Promise<unknown>, n = 8_000): Promise<number> {
  for (let i = 0; i < 800; i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fn();
  return ((performance.now() - t0) * 1000) / n;
}

describe("idle-64 pin (Wave 4.3)", () => {
  test("64 live armings does not 10× the ping path", async () => {
    const ping = async () => ({ pong: true });
    const empty = wrapTools({ ping }, createState({ programs: [] }));
    const us0 = await usPerCall(() => empty.ping.execute({}));

    const p = prog();
    const tools = {
      ping,
      lookup: async (a: Record<string, unknown>) => ({ id: a.id }),
      fetch: async (a: Record<string, unknown>) => ({ id: a.id }),
      write: async (a: Record<string, unknown>) => ({ id: a.id }),
    };
    const state = createState({ programs: [p] });
    const wrapped = wrapTools(tools, state);
    await Promise.all(Array.from({ length: 64 }, (_, i) => wrapped.lookup.execute({ id: `E-${i}`, text: "t" })));
    expect(state.arming.sessionSize(state.sessionId)).toBe(64);
    const us64 = await usPerCall(() => wrapped.ping.execute({}));
    expect(us64).toBeLessThan(50);
    expect(us64 / Math.max(us0, 0.01)).toBeLessThan(8);
  });
});
