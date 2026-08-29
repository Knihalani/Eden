import { describe, expect, test } from "bun:test";
import type { IslandCaller, StretchProgram } from "@eden/ir";
import { IslandReply } from "@eden/ir";
import { registryFrom, runProgram } from "./index";

function islands(steps: StretchProgram["steps"]): StretchProgram {
  return {
    id: "p",
    version: "1",
    name: "p",
    description: "p",
    inputSchema: { type: "object" },
    steps,
    returns: { kind: "from", step: steps[steps.length - 1]!.id, path: "" },
    contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
    manifest: null,
  };
}

describe("independent islands share a wave", () => {
  test("two independent islands run together with wait; cents are half of sync", async () => {
    const waits: Array<boolean | undefined> = [];
    let inflight = 0;
    let peak = 0;
    const island: IslandCaller = async (req) => {
      waits.push(req.wait);
      inflight++;
      peak = Math.max(peak, inflight);
      await Bun.sleep(15);
      inflight--;
      return new IslandReply(
        { v: req.input },
        {
          prompt_tokens: 10,
          completion_tokens: 2,
          ...(req.wait === true ? { batched: true as const } : {}),
        },
      );
    };
    const program = islands([
      { id: "a", kind: "island", input: { kind: "input", path: "x" }, system: "s", outputSchema: { type: "object" } },
      { id: "b", kind: "island", input: { kind: "input", path: "y" }, system: "s", outputSchema: { type: "object" } },
    ]);
    const out = await runProgram(program, { x: 1, y: 2 }, {
      registry: registryFrom({}),
      island,
      llmCents: 1,
      checkEnvelope: false,
    });
    expect(peak).toBe(2);
    expect(waits).toEqual([true, true]);
    expect(out.stats.llmCalls).toBe(2);
    expect(out.stats.cents).toBe(1);
    expect(out.stats.islandPromptTokens).toBe(20);
    expect(out.stats.islandCompletionTokens).toBe(4);
  });

  test("a lone island does not wait and pays full cents", async () => {
    const waits: Array<boolean | undefined> = [];
    const island: IslandCaller = async (req) => {
      waits.push(req.wait);
      return new IslandReply({ v: req.input }, { prompt_tokens: 10, completion_tokens: 2 });
    };
    const out = await runProgram(
      islands([{ id: "a", kind: "island", input: { kind: "literal", value: 1 }, system: "s", outputSchema: { type: "object" } }]),
      {},
      { registry: registryFrom({}), island, llmCents: 1, checkEnvelope: false },
    );
    expect(waits).toEqual([undefined]);
    expect(out.stats.cents).toBe(1);
  });

  test("an island that depends on another does not wait (sequential)", async () => {
    const order: string[] = [];
    let inflight = 0;
    let peak = 0;
    const island: IslandCaller = async (req) => {
      inflight++;
      peak = Math.max(peak, inflight);
      order.push(JSON.stringify(req.input));
      await Bun.sleep(10);
      inflight--;
      return new IslandReply(
        { next: req.input },
        { prompt_tokens: 3, completion_tokens: 1, ...(req.wait === true ? { batched: true as const } : {}) },
      );
    };
    const program = islands([
      { id: "a", kind: "island", input: { kind: "literal", value: "first" }, system: "s", outputSchema: { type: "object" } },
      { id: "b", kind: "island", input: { kind: "from", step: "a", path: "" }, system: "s", outputSchema: { type: "object" } },
    ]);
    const out = await runProgram(program, {}, {
      registry: registryFrom({}),
      island,
      llmCents: 1,
      checkEnvelope: false,
    });
    expect(peak).toBe(1);
    expect(order).toEqual(['"first"', '{"next":"first"}']);
    expect(out.stats.cents).toBe(2);
  });

  test("siblings that cannot batch still overlap: cheaper wall, full cents", async () => {
    let inflight = 0;
    let peak = 0;
    const island: IslandCaller = async (req) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await Bun.sleep(40);
      inflight--;
      return new IslandReply({ v: req.input }, { prompt_tokens: 4, completion_tokens: 1 });
    };
    const program = islands([
      { id: "a", kind: "island", input: { kind: "input", path: "x" }, system: "s", outputSchema: { type: "object" } },
      { id: "b", kind: "island", input: { kind: "input", path: "y" }, system: "s", outputSchema: { type: "object" } },
    ]);
    const t0 = performance.now();
    const out = await runProgram(program, { x: 1, y: 2 }, {
      registry: registryFrom({}),
      island,
      llmCents: 1,
      checkEnvelope: false,
    });
    const wall = performance.now() - t0;
    expect(peak).toBe(2);
    expect(out.stats.cents).toBe(2);
    expect(wall).toBeLessThan(70);
  });
});
