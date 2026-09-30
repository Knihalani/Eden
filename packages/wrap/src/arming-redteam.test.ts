import { describe, expect, test } from "bun:test";
import { createArmingStore, createState, wrapTools, type ToolDef } from "./index";
import { withVersion, type StretchProgram } from "@eden/ir";

function prog(): StretchProgram {
  const sequence = ["lookup", "write"];
  return withVersion({
    id: "p_rt",
    name: "p_rt",
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

describe("red-team: arming store", () => {
  test("hostile session keys stay isolated (__proto__, '', long)", async () => {
    const writes: Record<string, number> = {};
    const tools = (tag: string) => ({
      lookup: { execute: async (a) => ({ id: a.id }) },
      write: {
        execute: async (a) => {
          writes[tag] = (writes[tag] ?? 0) + 1;
          return { id: a.id };
        },
      },
    }) satisfies Record<string, ToolDef>;
    const p = prog();
    const store = createArmingStore();
    const keys = ["__proto__", "", "x".repeat(400)];
    await Promise.all(
      keys.map(async (sessionId, i) => {
        const w = wrapTools(tools(String(i)), createState({ programs: [p], arming: store, sessionId }));
        await w.lookup.execute({ id: "E-1", text: "t" });
        await w.write.execute({ id: "E-1" });
      }),
    );
    expect(writes["0"]).toBe(1);
    expect(writes["1"]).toBe(1);
    expect(writes["2"]).toBe(1);
  });

  test("global bound starving a new session fail-opens — zero duplicate writes", async () => {
    const writes: Record<string, number> = {};
    const p = prog();
    const store = createArmingStore({ perSessionMax: 4, globalMax: 2 });
    const mk = (tag: string) => ({
      lookup: { execute: async (a) => ({ id: a.id }) },
      write: {
        execute: async (a) => {
          writes[tag] = (writes[tag] ?? 0) + 1;
          return { id: a.id };
        },
      },
    }) satisfies Record<string, ToolDef>;
    const a = wrapTools(mk("a"), createState({ programs: [p], arming: store, sessionId: "a" }));
    const b = wrapTools(mk("b"), createState({ programs: [p], arming: store, sessionId: "b" }));
    const c = wrapTools(mk("c"), createState({ programs: [p], arming: store, sessionId: "c" }));
    await Promise.all([
      a.lookup.execute({ id: "A", text: "t" }),
      b.lookup.execute({ id: "B", text: "t" }),
    ]);
    await c.lookup.execute({ id: "C", text: "t" });
    await Promise.all([
      a.write.execute({ id: "A" }),
      b.write.execute({ id: "B" }),
      c.write.execute({ id: "C" }),
    ]);
    expect(writes.a).toBe(1);
    expect(writes.b).toBe(1);
    expect(writes.c).toBe(1);
  });

  test("name not in rest does not claim a different tool's write", async () => {
    const writes: string[] = [];
    const tools = {
      lookup: { execute: async (a) => ({ id: a.id }) },
      write: {
        execute: async (a) => {
          writes.push(String(a.id));
          return { id: a.id };
        },
      },
      ping: { execute: async () => ({ pong: true }) },
    } satisfies Record<string, ToolDef>;
    const w = wrapTools(tools, createState({ programs: [prog()] }));
    await w.lookup.execute({ id: "E-1", text: "t" });
    const ping = await w.ping.execute({});
    expect(ping).toEqual({ pong: true });
    await w.write.execute({ id: "E-1" });
    expect(writes).toEqual(["E-1"]);
  });

  test("capacity miss is counted and warned; writes stay exactly-once", async () => {
    const details: string[] = [];
    const writes: Record<string, number> = {};
    const p = prog();
    const toolsFor = (tag: string) => ({
      lookup: { execute: async (a) => ({ id: a.id }) },
      write: {
        execute: async (a) => {
          writes[tag] = (writes[tag] ?? 0) + 1;
          return { id: a.id };
        },
      },
    }) satisfies Record<string, ToolDef>;
    const store = createArmingStore({ perSessionMax: 1 });
    const state = createState({
      programs: [p],
      arming: store,
      sessionId: "one",
      onWarning: (w) => details.push(w.detail),
    });
    const w = wrapTools(toolsFor("shared"), state);
    await Promise.all([
      (async () => {
        await w.lookup.execute({ id: "A", text: "t" });
        await w.write.execute({ id: "A" });
      })(),
      (async () => {
        await w.lookup.execute({ id: "B", text: "t" });
        await w.write.execute({ id: "B" });
      })(),
    ]);
    expect(writes.shared).toBe(2);
    expect(state.capacityMisses).toBeGreaterThanOrEqual(1);
    expect(details.some((d) => /capacity: session full/.test(d))).toBe(true);
    const cap = state.receipts.find((r) => r.outcome === "degraded" && /capacity: session full/.test(r.reason ?? ""));
    expect(cap).toBeTruthy();
    expect(cap!.ok).toBe(true);
  });

  test("hostile fleet keys stay Map keys — no prototype pollution", async () => {
    const store = createArmingStore();
    const keys = ["__proto__", "", "f".repeat(400)];
    for (const fleetId of keys) {
      const armed = {
        rest: new Map([["fetchComments", 1]]),
        input: { id: "E-1" },
        programId: "p",
        armedAt: performance.now(),
        armedAtCall: 0,
        budgetCalls: 8,
        matchedCalls: 0,
        settled: Promise.resolve(true),
        resolveSettled: () => {},
        closed: false,
        hintId: "E-1",
        readOnly: true as const,
        fleetId,
      };
      expect(store.insert(fleetId, "k", armed)).toBe(true);
    }
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "k")).toBe(false);
    expect(({} as { k?: unknown }).k).toBeUndefined();
    expect(store.scanFleet("", "fetchComments", { id: "E-1" }, performance.now())).toEqual([]);
    expect(store.scanFleet("__proto__", "fetchComments", { id: "E-1" }, performance.now()).length).toBe(1);
  });

  test("mutating program with a shared fleetId still writes once per session", async () => {
    const writes: Record<string, number> = {};
    const tools = (tag: string) => ({
      lookup: { execute: async (a) => ({ id: a.id }) },
      write: {
        execute: async (a) => {
          writes[tag] = (writes[tag] ?? 0) + 1;
          return { id: a.id };
        },
      },
    }) satisfies Record<string, ToolDef>;
    const p = prog();
    const store = createArmingStore();
    const a = wrapTools(tools("a"), createState({ programs: [p], arming: store, sessionId: "sess-a", fleetId: "f1" }));
    const b = wrapTools(tools("b"), createState({ programs: [p], arming: store, sessionId: "sess-b", fleetId: "f1" }));
    await Promise.all([
      (async () => {
        await a.lookup.execute({ id: "E-1", text: "t" });
        await a.write.execute({ id: "E-1" });
      })(),
      (async () => {
        await b.lookup.execute({ id: "E-1", text: "t" });
        await b.write.execute({ id: "E-1" });
      })(),
    ]);
    expect(writes.a).toBe(1);
    expect(writes.b).toBe(1);
  });
});
