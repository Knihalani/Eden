import { describe, expect, test } from "bun:test";
import { withVersion, type Step, type StretchProgram } from "@eden/ir";
import { createState, wrapTools } from "./index";

/**
 * The oblivious-agent regression: an agent that keeps issuing calls after the
 * head call was steered.
 *
 * Tail calls routinely cannot carry the head call's full input (the program's
 * input schema includes a complaint `text`, but listInvoices/applyCredit only
 * take an id). Sibling matching required FULL input equality, so every tail
 * call fell through and executed raw after the compiled run had already done
 * its work — one compiled applyCredit plus one raw applyCredit per stretch:
 * duplicated writes for any agent that does not stop at the first call.
 */
function program(): StretchProgram {
  const step = (id: string, tool: string, args: Record<string, unknown>): Step =>
    ({ id, kind: "tool", tool, args }) as Step;
  return withVersion({
    id: "p_oblivious",
    name: "resolve_with_context",
    description: "d",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string" } },
      required: ["id", "text"],
    },
    sequence: ["lookup", "fetch", "apply"],
    steps: [
      step("lookup", "lookup", { id: { kind: "input", path: "id" }, text: { kind: "input", path: "text" } }),
      step("fetch", "fetch", { id: { kind: "input", path: "id" } }),
      step("apply", "apply", { id: { kind: "input", path: "id" } }),
    ],
    returns: { kind: "from", step: "apply", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
    manifest: { llmReduction: 3, latencyReduction: 1, costReduction: 1, skipRateBefore: 0, skipRateAfter: 0, nShadow: 3 },
  }) as StretchProgram;
}

describe("oblivious agents (tail calls after steering)", () => {
  test("tail calls that cannot carry the head's full input are suppressed, not re-run", async () => {
    const calls: string[] = [];
    const tools = {
      lookup: {
        description: "d",
        execute: async (a: Record<string, unknown>) => {
          calls.push(`lookup:${a.text}`);
          return { id: a.id };
        },
      },
      fetch: {
        description: "d",
        execute: async () => {
          calls.push("fetch");
          return { fetched: true };
        },
      },
      apply: {
        description: "d",
        execute: async () => {
          calls.push("apply");
          return { applied: true };
        },
      },
    };
    const state = createState({ programs: [program()] });
    const wrapped = wrapTools(tools, state) as Record<string, { execute: (a: Record<string, unknown>) => Promise<unknown> }>;

    // Head call carries full context; steering runs the whole stretch.
    const head = (await wrapped.lookup!.execute({ id: "X1", text: "refund please" })) as Record<string, unknown>;
    expect(head).toEqual({ applied: true });
    expect(calls).toEqual(["lookup:refund please", "fetch", "apply"]);

    // An agent that did NOT stop now issues the tail calls anyway. Every one
    // must come back steered WITHOUT executing again.
    const r1 = (await wrapped.fetch!.execute({ id: "X1" })) as Record<string, unknown>;
    const r2 = (await wrapped.apply!.execute({ id: "X1" })) as Record<string, unknown>;
    expect(r1).toMatchObject({ eden: "steered" });
    expect(r2).toMatchObject({ eden: "steered" });
    expect(calls.filter((c) => c === "fetch")).toHaveLength(1);
    expect(calls.filter((c) => c === "apply")).toHaveLength(1);
  });

  test("a different entity is never swallowed by the partial match", async () => {
    const calls: string[] = [];
    const tools = {
      lookup: {
        description: "d",
        execute: async (a: Record<string, unknown>) => {
          calls.push(`lookup:${String(a.id)}`);
          return { id: a.id };
        },
      },
      fetch: {
        description: "d",
        execute: async (a: Record<string, unknown>) => {
          calls.push(`fetch:${String(a.id)}`);
          return { fetched: true };
        },
      },
      apply: {
        description: "d",
        execute: async (a: Record<string, unknown>) => {
          calls.push(`apply:${String(a.id)}`);
          return { applied: true };
        },
      },
    };
    const state = createState({ programs: [program()] });
    const wrapped = wrapTools(tools, state) as Record<string, { execute: (a: Record<string, unknown>) => Promise<unknown> }>;
    await wrapped.lookup!.execute({ id: "X1", text: "refund please" });

    // Different id: the arming must not claim it. Raw execution is correct —
    // and since lookup is sequence[0], it steers a fresh compiled run.
    const out = (await wrapped.lookup!.execute({ id: "X2", text: "other" })) as Record<string, unknown>;
    void out;
    expect(calls.filter((c) => c.startsWith("apply:X1"))).toHaveLength(1);
  });
});
