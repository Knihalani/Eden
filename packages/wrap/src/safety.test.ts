import { describe, expect, test } from "bun:test";
import { withVersion, type Step, type StretchProgram } from "@eden/ir";
import { createState, wrapTools } from "./index";

/**
 * The wrap runs a compiled program in place of the agent's raw calls, so every
 * bug here is a bug that either performs a mutation twice or drops one the
 * agent needed. These are the cases that did.
 */

type FakeTool = { execute: (a: Record<string, unknown>) => Promise<unknown> };
type Counter = { calls: string[]; tools: Record<string, FakeTool> };

/** Tool set that records every call, so a duplicate is visible. */
function counted(names: string[], opts: { delayMs?: number } = {}): Counter {
  const calls: string[] = [];
  const tools: Counter["tools"] = {};
  for (const name of names) {
    tools[name] = {
      execute: async (args: Record<string, unknown>) => {
        calls.push(name);
        if (opts.delayMs) await Bun.sleep(opts.delayMs);
        return { ran: name, id: args.id };
      },
    };
  }
  return { calls, tools };
}

/** allowExact with no envelope keeps every input in distribution. */
function program(sequence: string[], steps: Step[], name = "stretch"): StretchProgram {
  return withVersion({
    id: "p_test",
    name,
    description: "d",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence,
    steps,
    returns: { kind: "from", step: steps[steps.length - 1]!.id, path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true },
    manifest: { llmReduction: 3, latencyReduction: 1, costReduction: 1, skipRateBefore: 0, skipRateAfter: 0, nShadow: 3 },
  }) as StretchProgram;
}

const idArg = { id: { kind: "input" as const, path: "id" } };

describe("wrap never applies a mutation twice", () => {
  test("a write before an island is not replayed when the island cannot run", async () => {
    // The default configuration: no island caller unless OPENAI_API_KEY is set.
    // An island sits wherever it sat in the observed trace, so it is routinely
    // *after* a write. The old fall-through decided replay safety by matching
    // the deopt reason, and "needs an island caller" was on the safe list — so
    // the compiled leg wrote the record, bailed, and the raw write ran again.
    const c = counted(["writeRecord", "notify"]);
    const p = program(
      ["writeRecord", "draftReply", "notify"],
      [
        { id: "writeRecord", kind: "tool", tool: "writeRecord", args: idArg },
        { id: "draftReply", kind: "island", input: { kind: "input", path: "" }, system: "s", outputSchema: {} },
        { id: "notify", kind: "tool", tool: "notify", args: idArg },
      ],
    );
    const state = createState({ programs: [p] }); // no island caller
    const tools = wrapTools(c.tools, state);
    // execute() may return a bare value (sync tools are allowed), so resolve first.
    await Promise.resolve(tools.writeRecord!.execute({ id: "T-100" })).catch(() => undefined);
    expect(c.calls.filter((n) => n === "writeRecord")).toHaveLength(1);
  });

  test("a parallel sibling call does not race the arming window", async () => {
    // Hosts issue a turn's tool calls in parallel. The tail used to be armed
    // only after the compiled run resolved, so a sibling naming a later step
    // arrived while the map was still empty and executed for real.
    const c = counted(["lookupTicket", "writeRecord", "notify"], { delayMs: 20 });
    const p = program(
      ["lookupTicket", "writeRecord", "notify"],
      [
        { id: "lookupTicket", kind: "tool", tool: "lookupTicket", args: idArg },
        { id: "writeRecord", kind: "tool", tool: "writeRecord", args: idArg },
        { id: "notify", kind: "tool", tool: "notify", args: idArg },
      ],
    );
    const state = createState({ programs: [p] });
    const tools = wrapTools(c.tools, state);
    await Promise.all([
      tools.lookupTicket!.execute({ id: "T-100" }),
      tools.writeRecord!.execute({ id: "T-100" }),
    ]);
    expect(c.calls.filter((n) => n === "writeRecord")).toHaveLength(1);
  });

  test("a failed run for one input does not disarm another input's tail", async () => {
    // The disarm loop deleted every arming for the program, not this
    // invocation's, so a later failure re-opened an earlier success's tail and
    // the agent's remaining raw calls executed against already-written state.
    let failNext = false;
    const calls: string[] = [];
    const tools = {
      lookupTicket: {
        execute: async (a: Record<string, unknown>) => {
          calls.push("lookupTicket");
          if (failNext && a.id === "T-200") throw new Error("upstream down");
          return { ran: "lookupTicket", id: a.id };
        },
      },
      notify: {
        execute: async (a: Record<string, unknown>) => {
          calls.push("notify");
          return { ran: "notify", id: a.id };
        },
      },
    };
    const p = program(
      ["lookupTicket", "notify"],
      [
        { id: "lookupTicket", kind: "tool", tool: "lookupTicket", args: idArg },
        { id: "notify", kind: "tool", tool: "notify", args: idArg },
      ],
    );
    const state = createState({ programs: [p] });
    const w = wrapTools(tools, state);

    await w.lookupTicket!.execute({ id: "T-100" }); // succeeds, arms T-100's tail
    failNext = true;
    await Promise.resolve(w.lookupTicket!.execute({ id: "T-200" })).catch(() => undefined); // fails
    const notifyBefore = calls.filter((n) => n === "notify").length;
    await w.notify!.execute({ id: "T-100" }); // T-100's tail must still be armed
    expect(calls.filter((n) => n === "notify")).toHaveLength(notifyBefore);
  });

  test("a tool repeated in the sequence suppresses both raw repeats", async () => {
    // `rest` was a Set, so only the first raw repeat was swallowed and the
    // second executed again on top of what the compiled run had already done.
    const c = counted(["lookupTicket", "notify"]);
    const p = program(
      ["lookupTicket", "notify", "notify"],
      [
        { id: "lookupTicket", kind: "tool", tool: "lookupTicket", args: idArg },
        { id: "notify", kind: "tool", tool: "notify", args: idArg },
        { id: "notify_2", kind: "tool", tool: "notify", args: idArg },
      ],
    );
    const state = createState({ programs: [p] });
    const tools = wrapTools(c.tools, state);
    await tools.lookupTicket!.execute({ id: "T-100" });
    const afterCompiled = c.calls.filter((n) => n === "notify").length;
    expect(afterCompiled).toBe(2); // the compiled run made both

    const first = await tools.notify!.execute({ id: "T-100" });
    const second = await tools.notify!.execute({ id: "T-100" });
    expect(first).toEqual({ eden: "steered", skipped: "notify" });
    expect(second).toEqual({ eden: "steered", skipped: "notify" });
    expect(c.calls.filter((n) => n === "notify")).toHaveLength(afterCompiled);
  });

  test("an out-of-distribution input still falls through cleanly", async () => {
    // The envelope check runs before any step, so nothing has happened and
    // replaying the raw tool is safe. This is the fall-through that must keep
    // working after tightening the replay rule.
    const c = counted(["lookupTicket"]);
    const p = withVersion({
      id: "p_env",
      name: "narrow",
      description: "d",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sequence: ["lookupTicket"],
      steps: [{ id: "lookupTicket", kind: "tool", tool: "lookupTicket", args: idArg }],
      returns: { kind: "from", step: "lookupTicket", path: "" },
      contract: {
        witnesses: 3,
        minLlmReduction: 2,
        allowExact: false,
        envelope: { inputs: { id: ["T-100"] } },
      },
      manifest: { llmReduction: 3, latencyReduction: 1, costReduction: 1, skipRateBefore: 0, skipRateAfter: 0, nShadow: 3 },
    }) as StretchProgram;
    const state = createState({ programs: [p] });
    const tools = wrapTools(c.tools, state);
    const out = await tools.lookupTicket!.execute({ id: "T-999" });
    expect(out).toEqual({ ran: "lookupTicket", id: "T-999" });
    expect(c.calls).toEqual(["lookupTicket"]);
  });
});
