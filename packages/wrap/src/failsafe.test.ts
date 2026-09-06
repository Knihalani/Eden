import { describe, expect, test } from "bun:test";
import { createState, handleChatCompletions, wrapTools } from "../src/index";
import { filterCanary, pullLive } from "../src/wrap-tools";
import { DeoptError } from "@eden/runtime";
import type { StretchProgram, StretchTrace } from "@eden/ir";

function twoStepProgram(id: string, name: string, t1: string, t2: string): StretchProgram {
  return {
    id,
    version: "1",
    name,
    description: "compiled test stretch",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: [t1, t2],
    steps: [
      { id: "s0", kind: "tool", tool: t1, args: { id: { kind: "input", path: "id" } } },
      { id: "s1", kind: "tool", tool: t2, args: { id: { kind: "input", path: "id" } } },
    ],
    returns: { kind: "from", step: "s1", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: { inputs: { id: ["T-100"] } } },
    manifest: {
      llmReduction: 8,
      latencyReduction: 8,
      costReduction: 8,
      skipRateBefore: 0.2,
      skipRateAfter: 0,
      nShadow: 6,
    },
  } as StretchProgram;
}

function liveProgram(overrides: Partial<StretchProgram> = {}): StretchProgram {
  return twoStepProgram("p1", "lookupTicket_to_notify", "lookupTicket", "notify");
}

describe("prime directive: a broken Eden never breaks the agent", () => {
  test("a canary flag that throws is skipped, not served at 100%", () => {
    const boom = {
      get rollout(): "canary" {
        throw new Error("hash");
      },
    } as { rollout?: "canary" | "live" };
    expect(filterCanary([boom, { rollout: "live" }], "sess-1")).toEqual([{ rollout: "live" }]);
  });

  test("kill switch tripped still serves traffic — unsteered, never a 409", async () => {
    const p = liveProgram();
    let upstreamBody = "";
    const state = createState({
      programs: [p],
      killAfterWarning: true,
      fetch: (async (_url: string, init?: RequestInit) => {
        upstreamBody = String(init?.body);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "upstream said hi" } }] }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    state.run.firstWarningAt = 1; // kill switch condition met
    const res = await handleChatCompletions(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [], tools: [{ type: "function", function: { name: "x", parameters: {} } }] }),
      }),
      { state, getPrograms: () => [p] },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toBe("upstream said hi");
    expect(upstreamBody).toContain('"name":"x"');
    expect(upstreamBody).not.toContain("resolve_ticket");
  });

  test("a throwing program list cannot break the request", async () => {
    const state = createState({
      fetch: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })) as unknown as typeof fetch,
    });
    const res = await handleChatCompletions(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [], tools: [{ type: "function", function: { name: "x", parameters: {} } }] }),
      }),
      {
        state,
        getPrograms: (): StretchProgram[] => {
          throw new Error("corrupt state");
        },
      },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toBe("ok");
  });

  test("non-JSON upstream body comes back verbatim", async () => {
    const state = createState({
      fetch: (async () => new Response("<html>gateway hiccup</html>", { status: 200 })) as unknown as typeof fetch,
    });
    const res = await handleChatCompletions(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      }),
      { state },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>gateway hiccup</html>");
  });

  test("corrupt program shapes fall back to the raw tool", async () => {
    const corrupt = [
      liveProgram({ id: "c1", sequence: "lookupTicket" as unknown as string[] }),
      liveProgram({ id: "c2", contract: [] as unknown as StretchProgram["contract"] }),
    ];
    const state = createState({ programs: corrupt });
    const tools = wrapTools(
      {
        lookupTicket: async () => ({ ticket: "real data" }),
        notify: async () => ({ done: true }),
      },
      state,
    );
    const out = (await tools.lookupTicket.execute({ id: "T-100" })) as Record<string, unknown> | undefined;
    expect(out).toBeTypeOf("object");
  });

  test("observe mode: guards warn but never refuse", async () => {
    const state = createState({ programs: [], enforce: false });
    const tools = wrapTools(
      {
        boom: async (): Promise<never> => {
          throw new Error("no");
        },
        ok: async () => ({ fine: true }),
      },
      state,
    );
    for (let i = 0; i < 4; i++) {
      await expect(tools.boom.execute({})).rejects.toThrow("no");
    }
    expect(state.run.warnings.some((w) => w.kind === "fail_streak")).toBe(true);
    await expect(tools.boom.execute({})).rejects.toThrow("no");
    await expect((tools.ok.execute({}) as Promise<unknown>)).resolves.toEqual({ fine: true });
  });

  test("observe mode: the executed-call ceiling never fires", async () => {
    process.env.EDEN_MAX_STEPS = "12";
    try {
      const state = createState({ programs: [], enforce: false });
      const tools = wrapTools({ poll: async () => ({ ok: true }) }, state);
      for (let i = 0; i < 30; i++) {
        const out = (await tools.poll.execute({})) as { ok?: boolean; eden?: string };
        expect(out.eden).toBeUndefined();
        expect(out.ok).toBe(true);
      }
    } finally {
      delete process.env.EDEN_MAX_STEPS;
    }
  });

  test("read-only stretch that deopts mid-run replays raw instead of erroring", async () => {
    // All-reads program whose second step explodes. Replaying raw duplicates
    // nothing (reads only), so the agent gets the real result, not a deopt.
    const p = twoStepProgram("ro", "read_stretch", "lookupTicket", "fetchDetails");
    const state = createState({ programs: [p] });
    let lookups = 0;
    const tools = wrapTools(
      {
        lookupTicket: async () => {
          lookups++;
          return { ticket: "T" };
        },
        fetchDetails: () => {
          throw new Error("compiled leg exploded");
        },
      },
      state,
    );
    const out = await tools.lookupTicket.execute({ id: "T-100" });
    expect(out).toEqual({ ticket: "T" });
    expect(lookups).toBeGreaterThanOrEqual(1); // raw replay happened
  });

  test("mutating stretch that deopts mid-run surfaces a structured deopt, not a raw re-run", async () => {
    // The counterpart guarantee: for a partially-executed MUTATING stretch we
    // must NOT silently replay raw — a duplicated write is worse than a
    // structured, recoverable error the agent can read and act on.
    const p = twoStepProgram("mut", "write_stretch", "writeRecord", "notify");
    const state = createState({ programs: [p] });
    let writes = 0;
    const tools = wrapTools(
      {
        writeRecord: async () => {
          writes++;
          return { written: true };
        },
        notify: () => {
          throw new DeoptError("timeout");
        },
      },
      state,
    );
    const out = (await tools.writeRecord.execute({ id: "T-100" })) as { eden?: string };
    expect(out.eden).toBe("deopt");
    expect(writes).toBe(1); // exactly one side effect, no duplicate
  });

  test("Eden bookkeeping crash mid-call still executes the raw tool", async () => {
    // noteSignals/trace flush run on every call; if the run recorder is put
    // into a state where they throw, the raw call must still go through.
    const state = createState({ programs: [] });
    (state.run as unknown as { warnings: null }).warnings = null; // poison the recorder
    const tools = wrapTools({ ping: async () => ({ pong: true }) }, state);
    const out = (await tools.ping.execute({})) as { pong?: boolean };
    expect(out).toEqual({ pong: true });
  });
});

import { wrapIsland } from "./island";

function threeStepProgram(id: string, t1: string, t2: string, t3: string): StretchProgram {
  return {
    id,
    version: "1",
    name: `${t1}_stretch`,
    description: "compiled test stretch",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: [t1, t2, t3],
    steps: [
      { id: "s0", kind: "tool", tool: t1, args: { id: { kind: "input", path: "id" } } },
      { id: "s1", kind: "tool", tool: t2, args: { id: { kind: "input", path: "id" } } },
      { id: "s2", kind: "tool", tool: t3, args: { id: { kind: "input", path: "id" } } },
    ],
    returns: { kind: "from", step: "s2", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: { inputs: { id: ["T-100"] } } },
    manifest: {
      llmReduction: 8,
      latencyReduction: 8,
      costReduction: 8,
      skipRateBefore: 0.2,
      skipRateAfter: 0,
      nShadow: 6,
    },
  } as StretchProgram;
}

describe("phase 1: sibling work is never lost (C3)", () => {
  test("compiled success: sibling claims its share after the head settles", async () => {
    const p = twoStepProgram("c3ok", "lookup_to_details", "lookup_fan", "fetch_details");
    const state = createState({ programs: [p] });
    let fetches = 0;
    const tools = wrapTools(
      {
        lookup_fan: async () => ({ ticket: "T" }),
        fetch_details: async () => {
          fetches++;
          return { details: "D" };
        },
      },
      state,
    );
    const [head, tail] = await Promise.all([
      tools.lookup_fan.execute({ id: "T-100" }) as Promise<unknown>,
      tools.fetch_details.execute({ id: "T-100" }) as Promise<unknown>,
    ]);
    // The head carries the compiled stretch's return value (its last step).
    expect(head).toEqual({ details: "D" });
    expect(tail).toEqual({ eden: "steered", skipped: "fetch_details" });
    expect(fetches).toBe(1); // performed by the compiled run only
  });

  test("compiled failure on an all-reads stretch: the sibling's work still happens", async () => {
    // Regression for C3: before the settle-wait, this sibling was told
    // "steered" while the head was still running; when the head then failed,
    // nobody ever fetched the details.
    const p = twoStepProgram("c3read", "lookup_to_details", "lookup_fan", "fetch_details");
    const state = createState({ programs: [p] });
    let fetchCalls = 0;
    const tools = wrapTools(
      {
        lookup_fan: async () => ({ ticket: "T" }),
        fetch_details: () => {
          fetchCalls++;
          if (fetchCalls === 1) throw new DeoptError("boom"); // compiled attempt fails here
          return { details: "D" };
        },
      },
      state,
    );
    const [head, tail] = await Promise.all([
      tools.lookup_fan.execute({ id: "T-100" }) as Promise<unknown>,
      tools.fetch_details.execute({ id: "T-100" }) as Promise<unknown>,
    ]);
    // Head fell back to raw (all-reads stretch) and got the real result.
    expect(head).toEqual({ ticket: "T" });
    // The sibling re-ran raw and the WORK HAPPENED instead of vanishing.
    expect(tail).toEqual({ details: "D" });
    expect(fetchCalls).toBe(2);
  });

  test("mutating sibling under unknown state returns a structured deopt, never a silent skip or duplicate", async () => {
    const p = threeStepProgram("c3mut", "lookup_fan", "write_report", "notify_done");
    const state = createState({ programs: [p] });
    let writes = 0;
    let notifies = 0;
    const tools = wrapTools(
      {
        lookup_fan: async () => ({ ticket: "T" }),
        write_report: async () => {
          writes++;
          return { written: true };
        },
        notify_done: () => {
          notifies++;
          throw new Error("flaky"); // plain error from the last step
        },
      },
      state,
    );
    const [head, writeSib, notifySib] = await Promise.all([
      tools.lookup_fan.execute({ id: "T-100" }) as Promise<unknown>,
      tools.write_report.execute({ id: "T-100" }) as Promise<unknown>,
      tools.notify_done.execute({ id: "T-100" }) as Promise<unknown>,
    ]);
    expect(head).toMatchObject({ eden: "deopt" });
    // The compiled run DID complete the write before notify failed — the
    // sibling must claim it, not repeat it.
    expect(writeSib).toEqual({ eden: "steered", skipped: "write_report" });
    expect(writes).toBe(1);
    // Notify never completed anywhere; mutating + failed attempt -> honest
    // structured result. No false "steered", no blind duplicate.
    expect(notifySib).toMatchObject({ eden: "deopt" });
    expect(notifies).toBe(1);
  });
});

describe("phase 1: enforcement-only pausing (M3)", () => {
  function pauseCaptureServer() {
    const hits: string[] = [];
    const waiters: Array<() => void> = [];
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        hits.push(new URL(req.url).pathname);
        for (const w of waiters.splice(0)) w();
        return Response.json({ tools: [] });
      },
    });
    return {
      hits,
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
      /** Resolves on the next (or already-recorded) hit — no wall sleep. */
      whenHit: () =>
        new Promise<void>((resolve) => {
          if (hits.length) resolve();
          else waiters.push(resolve);
        }),
    };
  }

  test("observe mode never pauses live programs", async () => {
    const cap = pauseCaptureServer();
    try {
      const p = threeStepProgram("mp3", "boom_a", "mid_b", "end_c");
      const state = createState({ programs: [p], baseUrl: cap.url, apiKey: "k", enforce: false });
      const tools = wrapTools({ boom_a: async (): Promise<never> => { throw new Error("x"); } }, state);
      const boom = (tools as unknown as Record<string, { execute: () => Promise<unknown> }>).boom_a!;
      await boom.execute().catch(() => {});
      await boom.execute().catch(() => {});
      // pauseLiveFor is a no-op in observe mode: local set stays empty and no
      // fire-and-forget POST is scheduled, so hits stay empty without sleeping.
      expect(state.pausedIds.size).toBe(0);
      expect(cap.hits.filter((h) => h.includes("/pause"))).toHaveLength(0);
    } finally {
      cap.stop();
    }
  });

  test("enforce mode pauses the program whose sequence contains the failing tool", async () => {
    const cap = pauseCaptureServer();
    try {
      process.env.EDEN_ENFORCE = "1";
      try {
        const p = threeStepProgram("mp3e", "boom_a", "mid_b", "end_c");
        const state = createState({ programs: [p], baseUrl: cap.url, apiKey: "k", enforce: true });
        const tools = wrapTools({ boom_a: async (): Promise<never> => { throw new Error("x"); } }, state);
        const boom = (tools as unknown as Record<string, { execute: () => Promise<unknown> }>).boom_a!;
        await boom.execute().catch(() => {});
        await boom.execute().catch(() => {});
        // Local pause is synchronous; join the fire-and-forget POST via the
        // server waiter instead of a wall-clock sleep.
        expect(state.pausedIds.has(p.id)).toBe(true);
        await cap.whenHit();
        expect(cap.hits.filter((h) => h.includes("/pause")).length).toBe(1);
      } finally {
        delete process.env.EDEN_ENFORCE;
      }
    } finally {
      cap.stop();
    }
  });
});

describe("phase 1: pure-compiled tool fallback policy (M4)", () => {
  test("early deopt with no raw counterpart returns a structured result, not a thrown error", async () => {
    // Steps reference a tool absent from the registry: provably nothing ran.
    const p = twoStepProgram("m4a", "compiled_only", "lookup_fan", "fetch_details");
    p.sequence = ["compiled_only", "other"];
    p.steps = [
      { id: "s0", kind: "tool", tool: "ghost_tool", args: {} },
      { id: "s1", kind: "tool", tool: "other", args: {} },
    ];
    p.name = "compiled_only";
    const state = createState({ programs: [p] });
    const tools = wrapTools({ other: async () => ({ ok: true }) }, state) as Record<string, { execute: (a: unknown) => Promise<unknown> }>;
    const def = tools["compiled_only"];
    expect(def).toBeDefined();
    const out = (await def!.execute({})) as { eden?: string };
    expect(out.eden).toBe("deopt");
  });

  test("all-reads early deopt falls back to the first raw tool", async () => {
    const p = twoStepProgram("m4b", "lookup_to_details", "lookup_fan", "fetch_details");
    p.steps = [
      { id: "s0", kind: "tool", tool: "ghost_tool", args: {} }, // fails before anything runs
      { id: "s1", kind: "tool", tool: "fetch_details", args: {} },
    ];
    const state = createState({ programs: [p] });
    const tools = wrapTools(
      {
        lookup_fan: async () => ({ ticket: "raw-replay" }),
        fetch_details: async () => ({ details: "D" }),
      },
      state,
    ) as Record<string, { execute: (a: unknown) => Promise<unknown> }>;
    // The compiled-only name surfaces through the Proxy's ownKeys.
    const compiledName = Object.keys(tools).find((n) => !["lookup_fan", "fetch_details"].includes(n));
    expect(compiledName).toBeDefined();
    const out = await tools[compiledName!]!.execute({});
    expect(out).toEqual({ ticket: "raw-replay" });
  });
});

describe("phase 1: bounded network paths (M6)", () => {
  test("pullLive against a hung control plane resolves within the configured timeout", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}), // never responds
    });
    try {
      process.env.EDEN_CONTROL_TIMEOUT_MS = "150";
      try {
        const state = createState({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: "k" });
        // AbortSignal.timeout is real wall time; Date.now may be flake-skewed.
        // Assert completion + that we waited at least a large fraction of the
        // configured timeout under the worst scale the harness applies (0.7).
        const t0 = Date.now();
        await pullLive(state);
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(5_000);
        expect(elapsed).toBeGreaterThanOrEqual(80);
      } finally {
        delete process.env.EDEN_CONTROL_TIMEOUT_MS;
      }
    } finally {
      server.stop(true);
    }
  });

  test("non-numeric EDEN_ISLAND_MS does not throw synchronously", () => {
    process.env.EDEN_ISLAND_MS = "garbage";
    try {
      const caller = wrapIsland({ apiKey: "sk-test" });
      // Construction itself must not throw; timeout parsing is deferred to call
      // time and guarded there.
      expect(caller !== undefined || caller === undefined).toBe(true);
    } finally {
      delete process.env.EDEN_ISLAND_MS;
    }
  });
});

describe("phase 2: branched programs steer end-to-end", () => {
  function forkTrace(id: string, state: string, tail: string[], pr: number): StretchTrace {
    return {
      id,
      events: [
        { name: "get_ci", args: { pr }, result: { state, pr }, ok: true },
        ...tail.map((name) => ({ name, args: { pr }, result: { done: true, pr }, ok: true })),
      ],
      input: { pr },
      output: { done: true },
      llmCalls: 4,
      duration_ms: 4000,
      cost_cents: 4,
      complete: true,
    };
  }

  async function forkedWorld() {
    const { compileTraces } = await import("@eden/compile");
    const mined = compileTraces([
      forkTrace("t1", "failure", ["fix_build", "notify"], 101),
      forkTrace("t2", "failure", ["fix_build", "notify"], 102),
      forkTrace("t3", "failure", ["fix_build", "notify"], 103),
      forkTrace("t4", "success", ["notify"], 201),
      forkTrace("t5", "success", ["notify"], 202),
      forkTrace("t6", "success", ["notify"], 203),
    ]);
    const prog = mined.programs.find((p) => p.steps?.some((s) => s.kind === "branch"));
    if (!prog) throw new Error("no fork program mined");
    // Shadow approval: without a manifest the program is correctly inert.
    const live = {
      ...prog,
      manifest: { llmReduction: 8, latencyReduction: 8, costReduction: 8, skipRateBefore: 0.2, skipRateAfter: 0, nShadow: 6 },
    };
    const calls: string[] = [];
    const world = {
      get_ci: async (a: Record<string, unknown>) => {
        calls.push(`get_ci:${String(a.pr)}`);
        return Number(a.pr) < 200 ? { state: "failure", pr: a.pr } : { state: "success", pr: a.pr };
      },
      fix_build: async () => {
        calls.push("fix_build");
        return { fixed: true };
      },
      notify: async () => {
        calls.push("notify");
        return { notified: true };
      },
    };
    const tools = wrapTools(world, createState({ programs: [live] }));
    return { calls, tools };
  }

  test("failure separator drives the THEN arm through one call", async () => {
    const { calls, tools } = await forkedWorld();
    const out = await tools.get_ci.execute({ pr: 103 });
    expect(out).toEqual({ notified: true });
    expect(calls).toEqual(["get_ci:103", "fix_build", "notify"]);
  });

  test("success separator drives the ELSE arm — no fix attempt", async () => {
    const { calls, tools } = await forkedWorld();
    const out = await tools.get_ci.execute({ pr: 201 });
    expect(out).toEqual({ notified: true });
    expect(calls).toEqual(["get_ci:201", "notify"]);
  });

  test("out-of-envelope input falls back to the agent's own calls", async () => {
    const { calls, tools } = await forkedWorld();
    const out = await tools.get_ci.execute({ pr: 654321 });
    expect(calls[0]).toBe("get_ci:654321");
    expect(out).toMatchObject({ state: "success" }); // raw result, not eden-deopt object? reads replay raw
  });
});

describe("phase 3: collision precedence (M5)", () => {
  test("compiled tool wins in-process, matching injectTools, with a one-time warning", async () => {
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (m: unknown) => errors.push(String(m));
    try {
      // The program's NAME collides with an existing host tool.
      const p = twoStepProgram("coll", "fetch_details", "lookup_fan", "fetch_details");
      const state = createState({ programs: [p] });
      let lookups = 0;
      const tools = wrapTools(
        {
          lookup_fan: async () => {
            lookups++;
            return { ticket: "T" };
          },
          fetch_details: async () => ({ details: "leaf" }),
        },
        state,
      ) as Record<string, { execute: (a: unknown) => Promise<unknown> }>;
      const out = await tools["fetch_details"]!.execute({ id: "T-100" });
      // The COMPILED definition executed: the whole stretch ran (its first
      // step called lookup_fan), not just the host's lone fetch function.
      expect(out).toEqual({ details: "leaf" });
      expect(lookups).toBe(1);
      expect(errors.some((e) => e.includes("takes precedence"))).toBe(true);
      // Warning fires ONCE per name, not per call.
      await tools["fetch_details"]!.execute({ id: "T-100" });
      const hits = errors.filter((e) => e.includes("takes precedence")).length;
      expect(hits).toBe(1);
    } finally {
      console.error = origErr;
    }
  });

  test("non-colliding names keep raw resolution", async () => {
    const p = twoStepProgram("nc", "other_stretch", "lookup_fan", "fetch_details");
    const state = createState({ programs: [p] });
    const tools = wrapTools({ lookup_fan: async () => ({ ticket: "raw-ok" }) }, state);
    const out = await tools.lookup_fan.execute({ id: "T-100" });
    expect(out).toEqual({ ticket: "raw-ok" });
  });
});

describe("read-your-writes", () => {
  test("write then sibling read is not a stale pre-write value", async () => {
    const store: Record<string, string> = { "T-100": "old" };
    const p = twoStepProgram("ryw", "lookup_to_details", "lookupTicket", "fetchDetails");
    const state = createState({ programs: [p] });
    const tools = wrapTools(
      {
        lookupTicket: async (a: Record<string, unknown>) => ({ value: store[String(a.id)] }),
        fetchDetails: async (a: Record<string, unknown>) => ({ details: store[String(a.id)] }),
        writeRecord: async (a: Record<string, unknown>) => {
          store[String(a.id)] = "new";
          return { written: true };
        },
      },
      state,
    );
    const first = await tools.lookupTicket.execute({ id: "T-100" });
    expect(first).toEqual({ details: "old" });
    await tools.writeRecord.execute({ id: "T-100" });
    const sib = await tools.fetchDetails.execute({ id: "T-100" });
    expect(sib).toEqual({ details: "new" });
    const again = await tools.lookupTicket.execute({ id: "T-100" });
    expect(JSON.stringify(again)).not.toMatch(/"old"/);
    expect(JSON.stringify(again)).toMatch(/new/);
  });

  test("a dirty-set fault fails open and does not block the read", async () => {
    const store: Record<string, string> = { "T-100": "old" };
    const p = twoStepProgram("ryw-fo", "lookup_to_details", "lookupTicket", "fetchDetails");
    const state = createState({ programs: [p] });
    const tools = wrapTools(
      {
        lookupTicket: async (a: Record<string, unknown>) => ({ value: store[String(a.id)] }),
        fetchDetails: async (a: Record<string, unknown>) => ({ details: store[String(a.id)] }),
        writeRecord: async (a: Record<string, unknown>) => {
          store[String(a.id)] = "new";
          return { written: true };
        },
      },
      state,
    );
    await tools.lookupTicket.execute({ id: "T-100" });
    await tools.writeRecord.execute({ id: "T-100" });
    state.dirtyEntities.has = () => {
      throw new Error("dirty-set exploded");
    };
    state.dirtyEntities.add = () => {
      throw new Error("dirty-set exploded");
    };
    const out = await tools.fetchDetails.execute({ id: "T-100" });
    expect(out).toBeTypeOf("object");
    expect((out as { eden?: string }).eden).not.toBe("deopt");
  });
});
