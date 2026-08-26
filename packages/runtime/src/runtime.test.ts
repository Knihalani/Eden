import { describe, expect, test } from "bun:test";
import { DeoptError, isDeopt, registryFrom, runProgram } from "../src/index";
import {
  LLM_MS,
  OOD_ID,
  SKIP_VERIFY_P,
  WITNESS_IDS,
  createTicketShip,
  runNaive,
  ticketShipProgram,
} from "../src/ticketship";

describe("runtime bind/deopt", () => {
  test("literal and from bindings", async () => {
    const registry = registryFrom({
      echo: ({ x }) => ({ x, y: 2 }),
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [
          { id: "e", kind: "tool", tool: "echo", args: { x: { kind: "literal", value: 1 } } },
        ],
        returns: { kind: "from", step: "e", path: "x" },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      {},
      { registry },
    );
    expect(result.value).toBe(1);
  });

  test("assert deopt", async () => {
    const registry = registryFrom({ ping: () => ({ ok: false }) });
    try {
      await runProgram(
        {
          id: "p",
          version: "v",
          name: "p",
          description: "p",
          inputSchema: { type: "object" },
          steps: [
            { id: "e", kind: "tool", tool: "ping", args: {} },
            { id: "a", kind: "assert", expr: "ok == true", onFail: "deopt" },
          ],
          returns: { kind: "from", step: "e", path: "" },
          contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
          manifest: null,
        },
        {},
        { registry },
      );
      throw new Error("expected deopt");
    } catch (err) {
      expect(isDeopt(err)).toBe(true);
      expect((err as DeoptError).reason).toContain("assert failed");
      expect((err as DeoptError).stepsRun).toBe(1);
      expect((err as DeoptError).ms).toBeGreaterThanOrEqual(0);
    }
  });

  test("loop over items", async () => {
    const seen: unknown[] = [];
    const registry = registryFrom({
      hit: ({ item }) => {
        seen.push(item);
        return item;
      },
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [
          {
            id: "each",
            kind: "loop",
            over: { kind: "input", path: "ids" },
            item: "item",
            body: ["hit"],
          },
          {
            id: "hit",
            kind: "tool",
            tool: "hit",
            args: { item: { kind: "from", step: "item", path: "" } },
          },
        ],
        returns: { kind: "from", step: "each", path: "" },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      { ids: [1, 2, 3] },
      { registry },
    );
    expect(seen).toEqual([1, 2, 3]);
    expect(result.value).toEqual([1, 2, 3]);
  });

  test("nested loop body runs the inner tool per inner item", async () => {
    const seen: Array<{ org: unknown; id: unknown }> = [];
    const registry = registryFrom({
      listItems: async (args) => ({ ids: [`${args.org}-1`, `${args.org}-2`] }),
      getItem: async (args) => {
        seen.push({ org: args.org, id: args.id });
        return args;
      },
    });
    const result = await runProgram(
      {
        id: "p",
        version: "v",
        name: "p",
        description: "p",
        inputSchema: { type: "object" },
        steps: [
          {
            id: "orgs",
            kind: "loop",
            over: { kind: "input", path: "orgs" },
            item: "org",
            body: ["list", "inner"],
          },
          {
            id: "list",
            kind: "tool",
            tool: "listItems",
            args: { org: { kind: "from", step: "org", path: "" } },
          },
          {
            id: "inner",
            kind: "loop",
            over: { kind: "from", step: "list", path: "ids" },
            item: "item",
            body: ["hit"],
          },
          {
            id: "hit",
            kind: "tool",
            tool: "getItem",
            args: {
              org: { kind: "from", step: "org", path: "" },
              id: { kind: "from", step: "item", path: "" },
            },
          },
        ],
        returns: { kind: "from", step: "orgs", path: "" },
        contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
        manifest: null,
      },
      { orgs: ["a", "b"] },
      { registry },
    );
    expect(seen).toEqual([
      { org: "a", id: "a-1" },
      { org: "a", id: "a-2" },
      { org: "b", id: "b-1" },
      { org: "b", id: "b-2" },
    ]);
    expect(Array.isArray(result.value)).toBe(true);
  });
});

describe("TicketShip handwritten program vs naive", () => {
  test("5x llm, latency, cost; verify never skipped; ood deopts without mutation", async () => {
    const program = ticketShipProgram();
    const naiveWorld = createTicketShip();
    const naive = await runNaive(naiveWorld, "T-100", { skipVerifyP: 0, seed: 1 });

    const compiledWorld = createTicketShip();
    const compiled = await runProgram(program, { id: "T-100" }, {
      registry: registryFrom(compiledWorld.tools),
      island: compiledWorld.island,
      llmCents: compiledWorld.llmCents,
    });

    expect(naive.stats.llmCalls).toBe(8);
    expect(compiled.stats.llmCalls).toBe(1);
    expect(compiled.stats.llmCalls).toBeLessThanOrEqual(naive.stats.llmCalls / 5);
    expect(compiled.stats.ms).toBeLessThanOrEqual(naive.stats.duration_ms / 5);
    expect(compiled.stats.cents).toBeLessThanOrEqual(naive.stats.cost_cents / 5);
    expect(compiled.stats.toolCalls.filter((t) => t === "verifyWrite")).toHaveLength(1);
    const writeAt = compiled.stats.toolCalls.indexOf("writeRecord");
    const verifyAt = compiled.stats.toolCalls.indexOf("verifyWrite");
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(verifyAt).toBeGreaterThan(writeAt);
    expect(compiledWorld.mutationsFor("T-100")).toEqual({ wrote: true, verified: true, notified: true });
    expect(compiled.value).toEqual({ notified: true, id: "T-100" });
    // duration_ms is performance.now(); flake-audit scales that clock (±30%).
    const clock = Number(process.env.EDEN_FLAKE_CLOCK_SCALE ?? "1");
    const scale = Number.isFinite(clock) && clock > 0 ? clock : 1;
    expect(naive.stats.duration_ms).toBeGreaterThan(LLM_MS * 7 * scale);
    expect(compiled.stats.ms).toBeGreaterThan(LLM_MS * 0.5 * scale);
  });

  test("verifyWrite skip rate 0 vs naive ~0.2", async () => {
    let naiveSkips = 0;
    const n = 40;
    for (let i = 0; i < n; i++) {
      const world = createTicketShip({ llmMs: 0 });
      const run = await runNaive(world, WITNESS_IDS[i % 3]!, { skipVerifyP: SKIP_VERIFY_P, seed: 100 + i });
      if (run.stats.skipped.includes("verifyWrite")) naiveSkips++;
    }
    expect(naiveSkips / n).toBeGreaterThanOrEqual(0.1);
    expect(naiveSkips / n).toBeLessThan(0.35);

    const program = ticketShipProgram();
    let compiledSkips = 0;
    for (let i = 0; i < n; i++) {
      const world = createTicketShip({ llmMs: 0 });
      const run = await runProgram(program, { id: WITNESS_IDS[i % 3]! }, {
        registry: registryFrom(world.tools),
        island: world.island,
      });
      if (!world.verified.has(WITNESS_IDS[i % 3]!)) compiledSkips++;
      expect(run.stats.toolCalls.filter((t) => t === "verifyWrite")).toHaveLength(1);
    }
    expect(compiledSkips).toBe(0);
  });

  test("unseen ticket deopts and does not mutate", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = ticketShipProgram();
    try {
      await runProgram(program, { id: OOD_ID }, {
        registry: registryFrom(world.tools),
        island: world.island,
        checkEnvelope: true,
      });
      throw new Error("expected deopt");
    } catch (err) {
      expect(isDeopt(err)).toBe(true);
    }
    expect(world.mutationsFor(OOD_ID)).toEqual({ wrote: false, verified: false, notified: false });
  });

  test("timeout deopts a hanging tool", async () => {
    let finished = false;
    const registry = registryFrom({
      hang: (_args, ctx) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            finished = true;
            resolve({ ok: true });
          }, 250);
          t.unref?.();
          ctx?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        }),
    });
    try {
      await runProgram(
        {
          id: "p",
          version: "v",
          name: "p",
          description: "p",
          inputSchema: { type: "object" },
          steps: [{ id: "h", kind: "tool", tool: "hang", args: {} }],
          returns: { kind: "from", step: "h", path: "" },
          contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
          manifest: null,
        },
        {},
        { registry, timeoutMs: 40, checkEnvelope: false },
      );
      throw new Error("expected timeout");
    } catch (err) {
      expect(isDeopt(err)).toBe(true);
      expect(String(err)).toMatch(/timeout/);
    }
    await Bun.sleep(80);
    expect(finished).toBe(false);
  });

  test("missing island caller deopts", async () => {
    try {
      await runProgram(
        {
          id: "p",
          version: "v",
          name: "p",
          description: "p",
          inputSchema: { type: "object" },
          steps: [{ id: "i", kind: "island", input: { kind: "literal", value: 1 }, system: "x", outputSchema: { type: "object" } }],
          returns: { kind: "from", step: "i", path: "" },
          contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
          manifest: null,
        },
        {},
        { registry: registryFrom({}), checkEnvelope: false },
      );
      throw new Error("expected deopt");
    } catch (err) {
      expect(isDeopt(err)).toBe(true);
    }
  });
});
