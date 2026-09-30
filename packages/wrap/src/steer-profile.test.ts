import { describe, expect, test } from "bun:test";
import { withVersion, type StretchProgram } from "@eden/ir";
import { createArmingStore, createState, wrapTools, type ToolDef } from "./index";

function prog(): StretchProgram {
  const sequence = ["lookup", "write"];
  return withVersion({
    id: "p_lat",
    name: "p_lat",
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

async function arm(w: number) {
  const p = prog();
  const t = {
    ping: { execute: async () => ({ pong: true }) },
    lookup: { execute: async (a) => ({ id: a.id }) },
    write: { execute: async (a) => ({ id: a.id }) },
  } satisfies Record<string, ToolDef>;
  const store = createArmingStore();
  const wraps = [];
  for (let i = 0; i < w; i++) {
    const wrapped = wrapTools(t, createState({ programs: [p], arming: store, sessionId: `s${i}` }));
    wraps.push(wrapped);
    await wrapped.lookup.execute({ id: `E-${i}`, text: "t" });
  }
  return wraps[0]!;
}

async function p50(fn: () => Promise<unknown> | unknown, n = 4000): Promise<number> {
  for (let i = 0; i < 400; i++) await fn();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    xs.push(performance.now() - t0);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length * 0.5)]!;
}

describe("steer latency pin (Wave 4.3)", () => {
  test("hosted W=100 p50 stays flat vs W=10; p50 << 1ms", async () => {
    const a = await arm(10);
    const b = await arm(100);
    const t10 = await p50(() => a.ping.execute({}));
    const t100 = await p50(() => b.ping.execute({}));
    expect(t100).toBeLessThan(1);
    expect(t100 / Math.max(t10, 1e-9)).toBeLessThan(2);
  });
});
