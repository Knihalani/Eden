import { describe, expect, test } from "bun:test";
import { registryFrom } from "@eden/runtime";
import { canApprove, mutatingSteps, replayRegistry, shadowProgram, uncoveredTools } from "../src/index";
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
      // Each trace replays against its own throwaway world, so the writes in
      // this program land nowhere anyone can see. That is what lets shadowing
      // run a candidate that mutates at all.
      registryFor: () => registryFrom(createTicketShip({ llmMs: 0 }).tools),
      island: world.island,
      allowSideEffects: true,
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
      // Each trace replays against its own throwaway world, so the writes in
      // this program land nowhere anyone can see. That is what lets shadowing
      // run a candidate that mutates at all.
      registryFor: () => registryFrom(createTicketShip({ llmMs: 0 }).tools),
      island: world.island,
      allowSideEffects: true,
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
      allowSideEffects: true,
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

describe("shadowing must not be the thing that does the damage", () => {
  test("a candidate that writes is refused when there is nowhere safe to write", async () => {
    // Shadowing replays the candidate once per held-out trace. Handed the live
    // registry — which is what apps/control passed — validating a stretch that
    // writes a record and notifies performed n real writes and n real
    // notifications, in order to decide whether the program should be allowed
    // to perform them.
    const held = await traces(6, 0);
    const world = createTicketShip({ llmMs: 0 });
    let realWrites = 0;
    const counting = {
      ...world.tools,
      writeRecord: {
        execute: async (a: Record<string, unknown>) => {
          realWrites++;
          return world.tools.writeRecord!.execute(a);
        },
      },
    };
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: registryFrom(counting),
      island: world.island,
    });
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.reasons[0]).toMatch(/would perform .*writeRecord/);
    // Refused before running anything, so nothing was written.
    expect(realWrites).toBe(0);
  });

  test("mutatingSteps names the steps that make it unsafe", () => {
    expect(mutatingSteps(ticketShipProgram()).sort()).toEqual(["notify", "writeRecord"]);
  });

  test("a program that returns the wrong answer does not pass", async () => {
    // Nothing here ever read t.output: whether the compiled program produced
    // the *right value* was not among the things shadow checked. A program
    // whose `returns` binding points at the wrong step runs cleanly, returns
    // something else entirely, and used to be recorded as complete purely for
    // not throwing.
    const held = await traces(6, 0);
    const good = ticketShipProgram();
    const wrong = {
      ...good,
      returns: { kind: "literal", value: { not: "what the agent produced" } },
    } as typeof good;
    const result = await shadowProgram(wrong, held, {
      registry: registryFrom(createTicketShip({ llmMs: 0 }).tools),
      registryFor: () => registryFrom(createTicketShip({ llmMs: 0 }).tools),
      island: createTicketShip({ llmMs: 0 }).island,
      allowSideEffects: true,
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.some((r) => /output differs/.test(r))).toBe(true);
  });
});

describe("replayRegistry", () => {
  test("serves recorded results in order and calls nothing for real", async () => {
    const held = await traces(3, 0);
    const t = held[0]!;
    const world = createTicketShip({ llmMs: 0 });
    let realWrites = 0;
    const counting = {
      ...world.tools,
      writeRecord: {
        execute: async (a: Record<string, unknown>) => {
          realWrites++;
          return world.tools.writeRecord!.execute(a);
        },
      },
    };
    const reg = replayRegistry(registryFrom(counting), t);

    const first = t.events.find((e) => e.name === "writeRecord")!;
    expect(await reg.execute("writeRecord", first.args)).toEqual(first.result);
    expect(realWrites).toBe(0);
    expect(reg.misses).toEqual([]);
  });

  test("a call the trace never made is reported, not invented and not performed", async () => {
    const held = await traces(3, 0);
    const world = createTicketShip({ llmMs: 0 });
    const reg = replayRegistry(registryFrom(world.tools), held[0]!);
    await expect(reg.execute("notify", { id: "T-100" })).resolves.toBeDefined();
    await expect(reg.execute("notify", { id: "T-100" })).rejects.toThrow(/cannot be replayed/);
    expect(reg.misses.some((m) => m.reason === "unrecorded" && m.tool === "notify")).toBe(true);
  });

  test("different arguments are recorded but do not fail the call", async () => {
    // Any step downstream of an island takes the model's fresh output as an
    // argument, so it differs from the recording every run. Failing on that
    // would refuse every program with an island in it.
    const held = await traces(3, 0);
    const reg = replayRegistry(undefined, held[0]!);
    const rec = held[0]!.events.find((e) => e.name === "writeRecord")!;
    await expect(reg.execute("writeRecord", { ...rec.args, extra: "drifted" })).resolves.toEqual(rec.result);
    expect(reg.misses.some((m) => m.reason === "different-args")).toBe(true);
  });
});
