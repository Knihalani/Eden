import { describe, expect, test } from "bun:test";
import { withVersion, type Step, type StretchProgram } from "@eden/ir";
import { createState, wrapTools } from "./index";

async function withClockAdvanced<T>(ms: number, fn: () => T | Promise<T>): Promise<T> {
  const real = performance.now.bind(performance);
  performance.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    performance.now = real;
  }
}

function controllableClock(): { advance: (ms: number) => void; restore: () => void } {
  const real = performance.now.bind(performance);
  let offset = 0;
  performance.now = () => real() + offset;
  return {
    advance: (ms) => {
      offset += ms;
    },
    restore: () => {
      performance.now = real;
    },
  };
}

type FakeTool = { execute: (a: Record<string, unknown>) => Promise<unknown> };
type Counter = { calls: string[]; tools: Record<string, FakeTool> };

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

function program(sequence: string[], steps: Step[], name = "stretch"): StretchProgram {
  return withVersion({
    id: `p_${name}`,
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

describe("wrap stops trusting an arming that has gone stale", () => {
  function armed(): { c: Counter; state: ReturnType<typeof createState>; tools: Record<string, { execute: (a: Record<string, unknown>) => unknown }> } {
    const c = counted(["lookupTicket", "notify", "ping"]);
    const p = program(
      ["lookupTicket", "notify"],
      [
        { id: "lookupTicket", kind: "tool", tool: "lookupTicket", args: idArg },
        { id: "notify", kind: "tool", tool: "notify", args: idArg },
      ],
    );
    const state = createState({ programs: [p] });
    return { c, state, tools: wrapTools(c.tools, state) };
  }

  test("an arming still suppresses the raw tail a few calls later", async () => {
    const { c, tools } = armed();
    await tools.lookupTicket!.execute({ id: "T-100" });
    const afterCompiled = c.calls.filter((n) => n === "notify").length;
    for (let i = 0; i < 5; i++) await tools.ping!.execute({ id: "T-100" });

    expect(await tools.notify!.execute({ id: "T-100" })).toEqual({ eden: "steered", skipped: "notify" });
    expect(c.calls.filter((n) => n === "notify")).toHaveLength(afterCompiled);
  });

  test("an arming stops suppressing once the agent has moved well past it", async () => {
    // Past ARM_MAX_CALLS intervening calls the agent is demonstrably no longer
    // in that stretch, so a raw notify is a new intent and must reach the tool.
    const { c, tools } = armed();
    await tools.lookupTicket!.execute({ id: "T-100" });
    const afterCompiled = c.calls.filter((n) => n === "notify").length;
    for (let i = 0; i < 33; i++) await tools.ping!.execute({ id: "T-100" });

    expect(await tools.notify!.execute({ id: "T-100" })).toEqual({ ran: "notify", id: "T-100" });
    expect(c.calls.filter((n) => n === "notify")).toHaveLength(afterCompiled + 1);
  });

  test("an arming stops suppressing once it is old, with no calls in between", async () => {
    const { c, tools } = armed();
    await tools.lookupTicket!.execute({ id: "T-100" });
    const afterCompiled = c.calls.filter((n) => n === "notify").length;
    // Armings are timed on the monotonic clock, not the wall clock, so this
    // advances performance.now rather than the system time. Wall-clock timing
    // meant an NTP step backwards made `now - armedAt` negative and the arming
    // immortal — it would go on swallowing genuinely new mutations — while a
    // step forwards disarmed one mid-stretch.
    expect(await withClockAdvanced(61_000, () => tools.notify!.execute({ id: "T-100" }))).toEqual({
      ran: "notify",
      id: "T-100",
    });
    expect(c.calls.filter((n) => n === "notify")).toHaveLength(afterCompiled + 1);
  });

  test("a compiled run slower than the TTL still suppresses its own tail", async () => {
    // armedAt was stamped before awaiting the compiled program, but
    // wrapTimeoutMs allows that program 300s — five times the TTL. A
    // legitimately slow run therefore returned to an arming that had already
    // expired, and every raw call in the tail went through to the real tool,
    // duplicating what the compiled leg had just done. The clock has to start
    // when the run finishes.
    const c = counted(["lookupTicket", "notify"]);
    const p = program(
      ["lookupTicket", "notify"],
      [
        { id: "lookupTicket", kind: "tool", tool: "lookupTicket", args: idArg },
        { id: "notify", kind: "tool", tool: "notify", args: idArg },
      ],
    );
    const clock = controllableClock();
    try {
      // The clock moves on *while the compiled program is running*, which is
      // the case the old stamping got wrong. Advancing it around the call
      // instead would stamp the arming at the later time too, and prove
      // nothing.
      const slow = { ...c.tools };
      const realLookup = slow.lookupTicket!.execute;
      slow.lookupTicket = {
        execute: async (a) => {
          clock.advance(61_000);
          return realLookup(a);
        },
      };
      const tools = wrapTools(slow, createState({ programs: [p] }));

      await tools.lookupTicket!.execute({ id: "T-100" });
      const afterCompiled = c.calls.filter((n) => n === "notify").length;

      expect(await tools.notify!.execute({ id: "T-100" })).toEqual({ eden: "steered", skipped: "notify" });
      expect(c.calls.filter((n) => n === "notify")).toHaveLength(afterCompiled);
    } finally {
      clock.restore();
    }
  });

  test("a tail longer than the call budget is suppressed to the end", async () => {
    // Every wrapped execute increments the call counter, including the
    // suppressed ones — so a flat budget was spent by the very calls it
    // existed to absorb. A program with a tail longer than the budget disarmed
    // partway through and executed the remainder for real: 40 compiled writes
    // followed by 8 raw ones. The budget has to be counted on top of the tail.
    const c = counted(["start", "write"]);
    const tail = Array.from({ length: 40 }, () => "write");
    const p = program(
      ["start", ...tail],
      [
        { id: "start", kind: "tool", tool: "start", args: idArg },
        ...tail.map((_, i) => ({ id: `write${i}`, kind: "tool" as const, tool: "write", args: idArg })),
      ],
    );
    const tools = wrapTools(c.tools, createState({ programs: [p] }));

    await tools.start!.execute({ id: "T-1" });
    const compiledWrites = c.calls.filter((n) => n === "write").length;

    // The agent now replays its own tail. Not one of them may reach the tool.
    for (let i = 0; i < tail.length; i++) {
      expect(await tools.write!.execute({ id: "T-1" })).toEqual({ eden: "steered", skipped: "write" });
    }
    expect(c.calls.filter((n) => n === "write")).toHaveLength(compiledWrites);
  });

  test("eviction under pressure drops expired armings before live ones", async () => {
    // Eviction was unconditionally oldest-first, so a burst of distinct inputs
    // pushed out armings whose tails had not run yet — and each of those tails
    // then executed for real against a tool the compiled program had already
    // called.
    //
    // The long-tailed arming taken first is deliberately the *oldest* entry
    // and still the most live one: its budget covers a hundred writes, while
    // the short-tailed armings taken after it run out of budget within the
    // same burst. Oldest-first eviction throws away exactly the wrong one.
    const c = counted(["start", "write", "lookupTicket", "notify"]);
    const tail = Array.from({ length: 100 }, () => "write");
    const long = program(
      ["start", ...tail],
      [
        { id: "start", kind: "tool", tool: "start", args: idArg },
        ...tail.map((_, i) => ({ id: `write${i}`, kind: "tool" as const, tool: "write", args: idArg })),
      ],
      "longFlow",
    );
    const short = program(
      ["lookupTicket", "notify"],
      [
        { id: "lookupTicket", kind: "tool", tool: "lookupTicket", args: idArg },
        { id: "notify", kind: "tool", tool: "notify", args: idArg },
      ],
      "shortFlow",
    );
    const tools = wrapTools(c.tools, createState({ programs: [long, short] }));

    await tools.start!.execute({ id: "T-first" });
    const afterFirst = c.calls.filter((n) => n === "write").length;
    // 70 short-tailed armings, taking the map past ARM_MAX_ENTRIES of 64.
    for (let i = 0; i < 70; i++) await tools.lookupTicket!.execute({ id: `T-${i}` });

    expect(await tools.write!.execute({ id: "T-first" })).toEqual({ eden: "steered", skipped: "write" });
    expect(c.calls.filter((n) => n === "write")).toHaveLength(afterFirst);
  });

  test("a host telemetry callback that throws does not fail the tool call", async () => {
    // onTrace, onWarning, and onReceipt are arbitrary host code. A throw in any
    // of them used to propagate out of a tool call that had already succeeded.
    const c = counted(["ping"]);
    const tools = wrapTools(
      c.tools,
      createState({
        programs: [],
        onTrace: () => {
          throw new Error("collector hook blew up");
        },
        onWarning: () => {
          throw new Error("warning hook blew up");
        },
      }),
    );
    for (let i = 0; i < 13; i++) {
      expect(await tools.ping!.execute({ id: "T-1" })).toEqual({ ran: "ping", id: "T-1" });
    }
  });

  test("onWarning throw does not swallow a tool failure", async () => {
    const tools = wrapTools(
      {
        boom: async () => {
          throw new Error("no");
        },
      },
      createState({
        programs: [],
        onWarning: () => {
          throw new Error("warning hook blew up");
        },
      }),
    );
    await expect(tools.boom.execute({})).rejects.toThrow("no");
    await expect(tools.boom.execute({})).rejects.toThrow("no");
  });
});

describe("wrap follows a program that has been rebuilt or pulled back", () => {
  test("a new build of the same id replaces the cached compiled tool", async () => {
    // compiledDef closes over the program it was built from, and the cache was
    // keyed by id alone — so the first build of an id was pinned for the life
    // of the process. After pullLive swapped in a corrected (or rolled back)
    // build, this process kept running the old steps, which is precisely what a
    // server-side rollback exists to stop.
    const c = counted(["lookupTicket", "repair"]);
    const state = createState({
      programs: [program(["lookupTicket"], [{ id: "lookupTicket", kind: "tool", tool: "lookupTicket", args: idArg }], "flow")],
    });
    const tools = wrapTools(c.tools, state);

    await tools.flow!.execute({ id: "T-1" });
    expect(c.calls).toEqual(["lookupTicket"]);

    // Same id, different steps — what pullLive installs after a rebuild.
    state.programs = [program(["repair"], [{ id: "repair", kind: "tool", tool: "repair", args: idArg }], "flow")];

    await tools.flow!.execute({ id: "T-1" });
    expect(c.calls).toEqual(["lookupTicket", "repair"]);
  });

  test("an unchanged program is not rebuilt on every lookup", async () => {
    const c = counted(["lookupTicket"]);
    const state = createState({
      programs: [program(["lookupTicket"], [{ id: "lookupTicket", kind: "tool", tool: "lookupTicket", args: idArg }], "flow")],
    });
    const tools = wrapTools(c.tools, state);
    expect(tools.flow).toBe(tools.flow);
  });
});
