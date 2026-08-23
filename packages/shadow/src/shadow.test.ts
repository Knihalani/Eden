import { describe, expect, test } from "bun:test";
import { registryFrom } from "@eden/runtime";
import { canApprove, mutatingSteps, outputDerivesFromIsland, replayRegistry, shadowProgram, uncoveredTools } from "../src/index";
import { createTicketShip, ticketShipProgram, toNaiveTrace, WITNESS_IDS } from "../../runtime/src/ticketship";
import { compileTraces } from "../../compile/src/index";
import { runNaive } from "../../runtime/src/ticketship";
import type { StretchProgram, StretchTrace, ToolRegistry } from "@eden/ir";

async function traces(n: number, skip = 0.2): Promise<StretchTrace[]> {
  const out: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const world = createTicketShip({ llmMs: 0 });
    const id = WITNESS_IDS[i % 3]!;
      const run = await runNaive(world, id, { skipVerifyP: i % 5 === 0 ? 1 : skip, seed: 50 + i });
    out.push(toNaiveTrace(`s${i}`, id, run));
  }
  return out;
}

/** Real per-event durations: tools 100ms, the island draft 5_000ms; total = sum. */
function stampRealDurations(t: StretchTrace): StretchTrace {
  const events = t.events.map((e) => ({ ...e, duration_ms: e.name === "draftReply" ? 5000 : 100 }));
  return { ...t, duration_ms: events.reduce((a, e) => a + (e.duration_ms ?? 0), 0), events };
}

/**
 * Witnesses carrying measured time instead of the synthetic 200×llm fixture
 * clock. The ship gate now demands measured time or measured (non-extrapolated)
 * tokens, so the PASS-path fixtures must be able to show one honestly.
 */
async function measuredTraces(n: number): Promise<StretchTrace[]> {
  const out: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const world = createTicketShip({ llmMs: 0 });
    const id = WITNESS_IDS[i % 3]!;
    const run = await runNaive(world, id, { skipVerifyP: 0, seed: 50 + i });
    out.push(stampRealDurations(toNaiveTrace(`s${i}`, id, run)));
  }
  return out;
}

describe("shadow", () => {
  test("handwritten TicketShip PASSes with 5x manifest", async () => {
    // Updated for honest numbers: this fixture used to PASS on island tokens
    // extrapolated from remaining LLM calls against the synthetic 200×llm
    // clock. Extrapolation is now flagged and does not satisfy the gate, so
    // the traces carry real per-event durations and pass on measured time.
    const held = await measuredTraces(6);
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
    expect(result.manifest?.tokensMeasured).toBe(true);
    // Island scaling is named as an estimate even when time carries the gate.
    expect(result.manifest?.tokensEstimated).toBe(true);
    expect(result.tokensEstimated).toBe(true);
    expect(result.manifest?.tokensSaved ?? 0).toBeGreaterThan(0);
    expect(result.manifest?.timeMeasured).toBe(true);
    expect(canApprove(result)).toBe(true);
  });

  test("extrapolated island tokens no longer PASS on the synthetic clock", async () => {
    // The old behavior this test pins out: with only the synthetic fixture
    // clock available, an island program used to PASS on tokens that were
    // naive × remaining-LLM-calls — an estimate. The gate now returns
    // INCONCLUSIVE and says so.
    const held = await traces(6, 0);
    const world = createTicketShip({ llmMs: 0 });
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: registryFrom(world.tools),
      registryFor: () => registryFrom(createTicketShip({ llmMs: 0 }).tools),
      island: world.island,
      allowSideEffects: true,
    });
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.manifest?.tokensEstimated).toBe(true);
    expect(result.manifest?.timeMeasured).toBe(false);
    expect(canApprove(result)).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/extrapolated/);
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
    // Measured-time fixtures, for the same reason as the handwritten test
    // above: extrapolated island tokens no longer satisfy the ship gate.
    const all = await measuredTraces(10);
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
    const held = await measuredTraces(6);
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

  test("canApprove ships on measured tokens, not × LLM", () => {
    expect(
      canApprove({
        verdict: "PASS",
        manifest: {
          llmReduction: 1.1,
          latencyReduction: 1,
          costReduction: 1,
          skipRateBefore: 0,
          skipRateAfter: 0,
          nShadow: 6,
          tokensMeasured: true,
          timeMeasured: false,
          tokensSaved: 80,
          timeSavedMs: null,
        },
        reasons: [],
        n: 6,
      }),
    ).toBe(true);
  });

  test("canApprove refuses extrapolated island tokens without measured time", () => {
    // Same manifest as above except the token delta is flagged as the island
    // extrapolation it is. Estimated numbers do not ship.
    expect(
      canApprove({
        verdict: "PASS",
        manifest: {
          llmReduction: 8,
          latencyReduction: 8,
          costReduction: 8,
          skipRateBefore: 0,
          skipRateAfter: 0,
          nShadow: 6,
          tokensMeasured: true,
          tokensEstimated: true,
          timeMeasured: false,
          tokensSaved: 80,
          timeSavedMs: null,
        },
        reasons: [],
        n: 6,
      }),
    ).toBe(false);
  });

  test("canApprove refuses vacuous PASS without tokens or time", () => {
    expect(
      canApprove({
        verdict: "PASS",
        manifest: {
          llmReduction: 8,
          latencyReduction: 8,
          costReduction: 8,
          skipRateBefore: 0,
          skipRateAfter: 0,
          nShadow: 4,
          tokensMeasured: false,
          timeMeasured: false,
          tokensSaved: null,
          timeSavedMs: null,
        },
        reasons: [],
        n: 4,
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
    // Updated for the inverted refusal: this used to be a denylist — a tool
    // was trusted unless isMutating's verb list recognised it — so
    // parseFields, validate and verifyWrite came back safe because no verb on
    // that list happened to match. It is now an allowlist following
    // stepIsParallelSafe in runtime/execute.ts: a tool step is flagged unless
    // the program marked it readOnly or its name positively matches read
    // vocabulary, so every tool here except lookupTicket and fetchDetails is
    // named.
    expect(mutatingSteps(ticketShipProgram()).sort()).toEqual([
      "notify",
      "parseFields",
      "validate",
      "verifyWrite",
      "writeRecord",
    ]);
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

describe("a program that checks more than the agent did is credited, not failed", () => {
  /**
   * TicketShip's fixture is built around an agent that skips verifyWrite a
   * fifth of the time, and skipRateBefore/skipRateAfter exist to reward a
   * compiled program for not skipping it. But a call the recording never made
   * was counted into extraMisses, which is an outright FAIL — so the gate
   * failed programs for the single improvement the product is sold on.
   *
   * It is absence of evidence, not evidence of a fault: that trace cannot
   * validate the program, so it is set aside and reported.
   */
  const sandboxed = async (n: number) => {
    // Real per-event durations: the replay sandbox validates 4 of these 6
    // traces (i=0 and i=5 skipped verifyWrite, so the recording cannot answer
    // it), and without measured time the run would be INCONCLUSIVE on
    // extrapolated island tokens alone.
    const held = (await traces(n, 0)).map(stampRealDurations);
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
    const reg = registryFrom(counting);
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: reg,
      registryFor: (t) => replayRegistry(reg, t),
      island: world.island,
      allowSideEffects: true,
    });
    return { result, realWrites };
  };

  test("the replay sandbox lets a write-performing program ship, having written nothing", async () => {
    const { result, realWrites } = await sandboxed(6);
    expect(result.verdict).toBe("PASS");
    // The whole point: validating a program that writes cost zero writes.
    expect(realWrites).toBe(0);
    expect(result.manifest!.llmReduction).toBeGreaterThanOrEqual(2);
  });

  test("the traces it could not validate are named, not silently dropped", async () => {
    const { result } = await sandboxed(6);
    expect(result.reasons.some((r) => /never recorded/.test(r))).toBe(true);
  });

  test("a program no trace could validate is INCONCLUSIVE, not PASS", async () => {
    // Set aside is not the same as ignored: if the recording answers nothing,
    // the honest verdict is that we do not know.
    const held = await traces(6, 0);
    const world = createTicketShip({ llmMs: 0 });
    const empty = held.map((t) => ({ ...t, events: [] }));
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: registryFrom(world.tools),
      registryFor: (t) => replayRegistry(registryFrom(world.tools), empty.find((e) => e.id === t.id) ?? { ...t, events: [] }),
      island: world.island,
      allowSideEffects: true,
    });
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.reasons.join(" ")).toMatch(/could validate this program/);
  });
});

describe("20b ship gate is tokens, time, and quality", () => {
  test("missing usage is not measured and does not PASS", async () => {
    const held = (await traces(6, 0)).map(({ prompt_tokens, completion_tokens, ...t }) => t);
    const world = createTicketShip({ llmMs: 0 });
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: registryFrom(world.tools),
      registryFor: () => registryFrom(createTicketShip({ llmMs: 0 }).tools),
      island: world.island,
      allowSideEffects: true,
    });
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.manifest?.tokensMeasured).toBe(false);
    expect(result.manifest?.timeMeasured).toBe(false);
    expect(canApprove(result)).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/not measured/);
  });

  test("vacuous output is a miss, not a pass", async () => {
    const held = (await traces(6, 0)).map((t) => ({ ...t, output: undefined }));
    const world = createTicketShip({ llmMs: 0 });
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: registryFrom(world.tools),
      registryFor: () => registryFrom(createTicketShip({ llmMs: 0 }).tools),
      island: world.island,
      allowSideEffects: true,
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.join(" ")).toMatch(/no recorded output/);
  });

  test("time from event duration_ms, not tape-lookup wall clock", async () => {
    const held = (await traces(10, 0))
      .filter((t) => t.events.some((e) => e.name === "verifyWrite"))
      .slice(0, 6)
      .map((t) => ({
        ...t,
        duration_ms: 50_000,
        events: t.events.map((e, i) => ({ ...e, duration_ms: 100 + i })),
      }));
    expect(held).toHaveLength(6);
    const world = createTicketShip({ llmMs: 0 });
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: registryFrom(world.tools),
      registryFor: () => registryFrom(createTicketShip({ llmMs: 0 }).tools),
      island: world.island,
      allowSideEffects: true,
    });
    expect(result.manifest?.timeMeasured).toBe(true);
    expect(result.manifest?.timeSavedMs).not.toBeNull();
    expect(Math.abs(result.manifest?.timeSavedMs ?? 0)).toBeLessThan(10_000);
  });
});

describe("skip rates share one denominator", () => {
  test("only traces that reach validation success count, on both sides", async () => {
    const held = await traces(6, 0);
    // Traces 1 and 3 cannot answer the candidate at all: handed the replay
    // sandbox they make a call the recording never made (fetchDetails was
    // struck from those recordings), so they validate nothing and may appear
    // in neither numerator nor denominator.
    const stripped = new Set(["s1", "s3"]);
    const world = createTicketShip({ llmMs: 0 });
    const reg = registryFrom(world.tools);
    const heldStripped = held.map((t) =>
      stripped.has(t.id) ? { ...t, events: t.events.filter((e) => e.name !== "fetchDetails") } : t,
    );
    const result = await shadowProgram(ticketShipProgram(), heldStripped, {
      registry: reg,
      registryFor: (t) =>
        stripped.has(t.id) ? replayRegistry(registryFrom(world.tools), t) : registryFrom(createTicketShip({ llmMs: 0 }).tools),
      island: world.island,
      allowSideEffects: true,
    });
    expect(result.manifest!.nShadow).toBe(6);
    // Validated: traces 0, 2, 4, 5 → four. Of those, 0 and 5 skipped
    // verifyWrite, so the honest before-rate is exactly 2/4. Accumulating over
    // all six held traces while dividing by the validated count — the old
    // behavior — would have mixed denominators and inflated the improvement.
    expect(result.manifest!.skipRateBefore).toBe(2 / 4);
    expect(result.manifest!.skipRateAfter).toBe(0);
    expect(result.reasons.some((r) => /never recorded/.test(r))).toBe(true);
  });

  test("a rate with nothing validatable stays zero, not NaN", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const empty = (await traces(3, 0)).map((t) => ({ ...t, events: [] }));
    const result = await shadowProgram(ticketShipProgram(), empty, {
      registry: registryFrom(world.tools),
      registryFor: (t) => replayRegistry(registryFrom(world.tools), t),
      island: world.island,
      allowSideEffects: true,
    });
    // Nothing validated → INCONCLUSIVE long before rates are computed.
    expect(result.verdict).toBe("INCONCLUSIVE");
  });

  test("unvalidatable traces are excluded from BOTH sides of every ratio", async () => {
    // The naive llm/ms/cents used to be pushed for every held trace while the
    // compiled counterparts were pushed only on successful replay, so
    // llmReduction/costReduction compared means over DIFFERENT sample sets —
    // PASS verdicts coexisting with unvalidatable traces carried biased
    // headline numbers. Now the pushes are paired: a trace that cannot answer
    // contributes to neither side, so changing its numbers changes nothing.
    const stripped = new Set(["s1", "s3"]);
    const world = createTicketShip({ llmMs: 0 });
    const reg = registryFrom(world.tools);
    const shadowWith = async (inflateUnvalidatable: boolean) => {
      const held = (await traces(6, 0)).map((t) =>
        stripped.has(t.id)
          ? {
              ...t,
              events: t.events.filter((e) => e.name !== "fetchDetails"),
              ...(inflateUnvalidatable ? { llmCalls: 10_000, cost_cents: 999_999 } : {}),
            }
          : t,
      );
      return shadowProgram(ticketShipProgram(), held, {
        registry: reg,
        registryFor: (t) =>
          stripped.has(t.id) ? replayRegistry(registryFrom(world.tools), t) : registryFrom(createTicketShip({ llmMs: 0 }).tools),
        island: world.island,
        allowSideEffects: true,
      });
    };
    const baseline = await shadowWith(false);
    const inflated = await shadowWith(true);
    // Identical arithmetic over identical paired samples → exactly equal,
    // not approximately: the unvalidatable traces' numbers appear nowhere.
    expect(inflated.manifest!.llmReduction).toBe(baseline.manifest!.llmReduction);
    expect(inflated.manifest!.costReduction).toBe(baseline.manifest!.costReduction);
  });

  test("latencyReduction is absent when time was not measured", async () => {
    // The fallback used to compute a reduction from naive wall clock vs
    // compiled replay wall clock — the synthetic fixture clock wearing
    // measurement's clothes. Honest numbers or absent: null, like timeSavedMs.
    const held = await traces(6, 0);
    const world = createTicketShip({ llmMs: 0 });
    const result = await shadowProgram(ticketShipProgram(), held, {
      registry: registryFrom(world.tools),
      registryFor: () => registryFrom(createTicketShip({ llmMs: 0 }).tools),
      island: world.island,
      allowSideEffects: true,
    });
    expect(result.manifest?.timeMeasured).toBe(false);
    expect(result.manifest?.timeSavedMs).toBeNull();
    expect(result.manifest?.latencyReduction).toBeNull();
  });
});

describe("island-derived output comparison", () => {
  /**
   * An island's prose is fresh every run, so strict byte equality failed every
   * program whose final output was that prose — unrelated to quality. When the
   * output provably chains back to an island step, comparison relaxes to
   * structural: keys present, non-string scalars equal after redaction, strings
   * free to differ. Unknown references break the chain and fail closed.
   */
  const proseProgram = (): StretchProgram =>
    ({
      id: "prose",
      name: "draft_prose",
      version: "1",
      description: "draft",
      inputSchema: {},
      steps: [
        {
          id: "draft",
          kind: "island",
          input: { kind: "input", path: "topic" },
          system: "Write one line.",
          outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      ],
      returns: { kind: "from", step: "draft", path: "" },
      contract: {
        witnesses: 3,
        minLlmReduction: 2,
        allowExact: false,
        envelope: { inputs: { topic: ["alpha", "beta", "gamma"] } },
      },
      manifest: null,
    }) as unknown as StretchProgram;

  const proseTraces = (output: unknown): StretchTrace[] =>
    ["alpha", "beta", "gamma"].map((topic, i) => ({
      id: `p${i}`,
      events: [{ name: "draftReply", args: { topic }, ok: true, result: { text: "recorded prose" }, duration_ms: 5000 }],
      input: { topic },
      output,
      llmCalls: 1,
      duration_ms: 5000,
      cost_cents: 1,
      complete: true,
      prompt_tokens: 100,
      completion_tokens: 20,
    }));

  const shadowProse = async (traceOutput: unknown) => {
    let n = 0;
    return shadowProgram(proseProgram(), proseTraces(traceOutput), {
      registry: { has: () => true, execute: async () => ({}) } as ToolRegistry,
      island: async () => {
        n++;
        return { text: `fresh prose ${n}-${Math.random()}` };
      },
    });
  };

  test("nondeterministic island prose passes structurally, marked prose-divergent", async () => {
    expect(outputDerivesFromIsland(proseProgram())).toBe(true);
    const result = await shadowProse({ text: "recorded prose" });
    expect(result.verdict).toBe("PASS");
    expect(result.reasons.some((r) => r.includes("prose-divergent"))).toBe(true);
  });

  test("shape drift still fails under the structural relaxation", async () => {
    const result = await shadowProse({ text: "recorded prose", urgency: "high" });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons.some((r) => /output differs/.test(r))).toBe(true);
  });

  test("non-island outputs keep byte equality, and broken chains fail closed", async () => {
    // TicketShip returns what `notify` returned, and notify's arguments come
    // from the input alone — no island anywhere up the chain.
    expect(outputDerivesFromIsland(ticketShipProgram())).toBe(false);
    // One hop through a tool whose argument carries the island's draft.
    const throughTool = { ...ticketShipProgram(), returns: { kind: "from", step: "write", path: "" } } as unknown as StretchProgram;
    expect(outputDerivesFromIsland(throughTool)).toBe(true);
    // A reference to a step that does not exist proves nothing.
    const ghost = { ...ticketShipProgram(), returns: { kind: "from", step: "ghost", path: "" } } as unknown as StretchProgram;
    expect(outputDerivesFromIsland(ghost)).toBe(false);
  });
});
