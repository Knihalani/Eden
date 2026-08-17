import { describe, expect, test } from "bun:test";
import { registryFrom } from "@eden/runtime";
import { canApprove, shadowProgram, uncoveredTools } from "../src/index";
import { createTicketShip, ticketShipProgram, WITNESS_IDS } from "../../runtime/src/ticketship";
import { compileTraces } from "../../compile/src/index";
import { runNaive } from "../../runtime/src/ticketship";
import type { StretchTrace } from "@eden/ir";

async function traces(n: number, skip = 0.2): Promise<StretchTrace[]> {
  const out: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const world = createTicketShip({ llmMs: 0 });
    const id = WITNESS_IDS[i % 3]!;
      const run = await runNaive(world, id, { skipVerifyP: i % 5 === 0 ? 1 : skip, seed: 50 + i });
    out.push({
      id: `s${i}`,
      events: run.events,
      input: { id },
      output: run.output,
      llmCalls: run.stats.llmCalls,
      duration_ms: 200 * run.stats.llmCalls,
      cost_cents: run.stats.cost_cents,
      skipped: run.stats.skipped,
      complete: run.stats.complete,
    });
  }
  return out;
}

describe("shadow", () => {
  test("handwritten TicketShip PASSes with 5x manifest", async () => {
    const held = await traces(6, 0);
    const world = createTicketShip({ llmMs: 0 });
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: registryFrom(world.tools),
      island: world.island,
    });
    expect(result.verdict).toBe("PASS");
    expect(result.manifest?.llmReduction).toBeGreaterThanOrEqual(5);
    expect(result.manifest?.latencyReduction).toBeGreaterThanOrEqual(5);
    expect(result.manifest?.costReduction).toBeGreaterThanOrEqual(5);
    expect(result.manifest?.skipRateAfter).toBe(0);
    expect(canApprove(result)).toBe(true);
  });

  test("INCONCLUSIVE does not approve", async () => {
    const held = await traces(2, 0);
    const world = createTicketShip({ llmMs: 0 });
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: registryFrom(world.tools),
      island: world.island,
      minN: 3,
    });
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(canApprove(result)).toBe(false);
  });

  test("compiled program from traces also PASSes", async () => {
    const all = await traces(10, 0.2);
    const { programs } = compileTraces(all);
    const p = programs[0]!;
    expect(p).toBeTruthy();
    const world = createTicketShip({ llmMs: 0 });
    const result = await shadowProgram(p, all, {
      registry: registryFrom(world.tools),
      island: world.island,
    });
    expect(result.verdict).toBe("PASS");
    expect(canApprove(result)).toBe(true);
  });

  test("isolated registries do not leak writes across traces", async () => {
    const held = await traces(6, 0);
    const island = createTicketShip({ llmMs: 0 }).island;
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: registryFrom(createTicketShip({ llmMs: 0 }).tools),
      island,
      registryFor: () => registryFrom(createTicketShip({ llmMs: 0 }).tools),
    });
    expect(result.verdict).toBe("PASS");
    expect(result.manifest?.skipRateAfter).toBe(0);
  });

  test("canApprove honors contract minLlmReduction", () => {
    expect(
      canApprove({
        verdict: "PASS",
        manifest: {
          llmReduction: 3,
          latencyReduction: 3,
          costReduction: 3,
          skipRateBefore: 0.2,
          skipRateAfter: 0,
          nShadow: 6,
        },
        reasons: [],
        n: 6,
        minLlmReduction: 3,
      }),
    ).toBe(true);
  });

  test("promotes at 2× LLM even when latency is only slightly better", () => {
    expect(
      canApprove({
        verdict: "PASS",
        manifest: {
          llmReduction: 2.1,
          latencyReduction: 1.15,
          costReduction: 2.1,
          skipRateBefore: 0.2,
          skipRateAfter: 0,
          nShadow: 4,
        },
        reasons: [],
        n: 4,
        minLlmReduction: 2,
      }),
    ).toBe(true);
    expect(
      canApprove({
        verdict: "PASS",
        manifest: {
          llmReduction: 1.4,
          latencyReduction: 8,
          costReduction: 8,
          skipRateBefore: 0,
          skipRateAfter: 0,
          nShadow: 4,
        },
        reasons: [],
        n: 4,
        minLlmReduction: 2,
      }),
    ).toBe(false);
  });

  test("uncoveredTools lists names the registry cannot run", () => {
    const program = {
      sequence: ["Read", "Grep", "Write"],
      steps: [],
    } as unknown as import("@eden/ir").StretchProgram;
    const registry = { has: (n: string) => n === "Read" || n === "Write", execute: async () => ({}) };
    expect(uncoveredTools(registry, program)).toEqual(["Grep"]);
    expect(uncoveredTools(undefined, program)).toEqual(["Read", "Grep", "Write"]);
  });
});
