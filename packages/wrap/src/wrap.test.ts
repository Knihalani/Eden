import { describe, expect, test } from "bun:test";
import { redact } from "@eden/ir";
import { eden, extractInput, injectTools, steerToolCalls, wrapTools, createState, handleChatCompletions, wrapTimeoutMs, pendingPosts, flushOutbox } from "../src/index";
import { createTicketShip, ticketShipProgram, OOD_ID, WITNESS_IDS } from "../../runtime/src/ticketship";

const liveManifest = {
  llmReduction: 8,
  latencyReduction: 8,
  costReduction: 8,
  skipRateBefore: 0.2,
  skipRateAfter: 0,
  nShadow: 6,
};

function liveProgram() {
  return { ...ticketShipProgram(), manifest: liveManifest };
}

describe("steer + inject", () => {
  test("steer utilization is 100% on the old first tool", () => {
    const program = liveProgram();
    let steered = 0;
    for (const id of WITNESS_IDS) {
      const out = steerToolCalls([{ function: { name: "lookupTicket", arguments: JSON.stringify({ id }) } }], [program]);
      if (out[0]?.function?.name === program.name) steered++;
    }
    expect(steered).toBe(WITNESS_IDS.length);
  });

  test("rewrites the old first tool into the compiled tool", () => {
    const p = liveProgram();
    const out = steerToolCalls(
      [{ id: "1", type: "function", function: { name: "lookupTicket", arguments: JSON.stringify({ id: "T-100" }) } }],
      [p],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.function?.name).toBe("resolve_ticket");
    expect(JSON.parse(out[0]!.function!.arguments)).toEqual({ id: "T-100" });
  });

  test("does not steer out-of-distribution ids", () => {
    const p = liveProgram();
    const out = steerToolCalls(
      [{ function: { name: "lookupTicket", arguments: JSON.stringify({ id: OOD_ID }) } }],
      [p],
    );
    expect(out[0]!.function?.name).toBe("lookupTicket");
  });

  test("prefers the longest matching sequence", () => {
    const short = { ...liveProgram(), id: "short", name: "short_ticket", sequence: ["lookupTicket", "notify"] };
    const long = liveProgram();
    const out = steerToolCalls(
      [{ function: { name: "lookupTicket", arguments: JSON.stringify({ id: "T-100" }) } }],
      [short, long],
    );
    expect(out[0]!.function?.name).toBe(long.name);
  });

  test("collapses a multi-call batch onto the compiled tool", () => {
    const p = liveProgram();
    const out = steerToolCalls(
      [
        { function: { name: "lookupTicket", arguments: JSON.stringify({ id: "T-100" }) } },
        { function: { name: "writeRecord", arguments: JSON.stringify({ id: "T-100" }) } },
      ],
      [p],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.function?.name).toBe("resolve_ticket");
  });

  test("extractInput accepts ticket_id alias", () => {
    const p = liveProgram();
    expect(extractInput(p, { ticket_id: "T-100" })).toEqual({ id: "T-100" });
  });

  test("injects compiled schema", () => {
    const p = liveProgram();
    const tools = injectTools([{ type: "function", function: { name: "lookupTicket", parameters: {} } }], [p]) as Array<{
      function: { name: string };
    }>;
    expect(tools[0]!.function.name).toBe("resolve_ticket");
    expect(tools.some((t) => t.function.name === "lookupTicket")).toBe(true);
  });
});

describe("wrapTools", () => {
  test("compiled tool returns only the final result and never skips verify", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = liveProgram();
    const state = createState({ programs: [program], island: world.island, llmCents: 1 });
    const tools = wrapTools(world.tools, state);
    const result = await tools[program.name]!.execute({ id: "T-100" });
    expect(result).toEqual({ notified: true, id: "T-100" });
    expect(world.mutationsFor("T-100")).toEqual({ wrote: true, verified: true, notified: true });
    expect(state.receipts[0]?.llmCalls).toBe(1);
    expect(state.receipts[0]?.ok).toBe(true);
    expect(state.receipts[0]?.tokensSaved).toBeUndefined();
  });

  test("a live receipt confirms time against the tape, not the shadow estimate", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = {
      ...liveProgram(),
      budget: { llmCalls: 8, ms: 80, cents: 8 },
      manifest: { ...liveManifest, timeMeasured: true, timeSavedMs: 999, tokensMeasured: true, tokensSaved: 400 },
    };
    const state = createState({ programs: [program], island: world.island, llmCents: 1 });
    const tools = wrapTools(world.tools, state);
    await tools[program.name]!.execute({ id: "T-100" });
    const rec = state.receipts[0]!;
    expect(rec.ok).toBe(true);
    expect(rec.tokensSaved).toBeUndefined();
    expect(rec.timeSavedMs).toBe(80 - rec.ms);
    expect(rec.timeSavedMs).not.toBe(999);
  });

  test("an out-of-envelope deopt receipt keeps the elapsed ms", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = { ...liveProgram(), manifest: { ...liveManifest, tokensMeasured: true, tokensSaved: 400 } };
    const state = createState({ programs: [program], island: world.island, failOpen: true });
    const tools = wrapTools(world.tools, state);
    await tools[program.name]!.execute({ id: OOD_ID });
    const rec = state.receipts.find((r) => !r.ok);
    expect(rec).toBeTruthy();
    expect(rec!.ms).toBeGreaterThanOrEqual(0);
    expect(rec!.tokensSaved).toBeUndefined();
    expect(rec!.early).toBe(true);
    expect(rec!.outcome).toBe("deopt");
  });

  test("steer: first old tool collapses to the compiled program", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = liveProgram();
    const state = createState({ programs: [program], island: world.island });
    const tools = wrapTools(world.tools, state);
    const result = await tools.lookupTicket.execute({ id: "T-101" });
    expect(result).toEqual({ notified: true, id: "T-101" });
    const second = await tools.fetchDetails.execute({ id: "T-101" });
    expect(second).toEqual({ eden: "steered", skipped: "fetchDetails" });
    expect(world.verified.has("T-101")).toBe(true);
  });

  test("two sequential tickets both compile (skip rest is per stretch)", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = liveProgram();
    const state = createState({ programs: [program], island: world.island });
    const tools = wrapTools(world.tools, state);
    await tools.lookupTicket.execute({ id: "T-100" });
    await tools.lookupTicket.execute({ id: "T-101" });
    expect(world.verified.has("T-100")).toBe(true);
    expect(world.verified.has("T-101")).toBe(true);
    expect(state.receipts.length).toBe(2);
  });

  test("ood after a compiled ticket does not skip verifyWrite", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = liveProgram();
    const state = createState({ programs: [program], island: world.island, failOpen: true });
    const tools = wrapTools(world.tools, state);
    await tools.lookupTicket.execute({ id: "T-100" });
    expect(world.verified.has("T-100")).toBe(true);
    await tools.lookupTicket.execute({ id: OOD_ID });
    const v = await tools.verifyWrite.execute({ id: OOD_ID });
    expect(v).not.toEqual({ eden: "steered", skipped: "verifyWrite" });
  });

  test("skipRest does not skip a different ticket's verifyWrite", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = liveProgram();
    const state = createState({ programs: [program], island: world.island, failOpen: true });
    const tools = wrapTools(world.tools, state);
    await tools.lookupTicket.execute({ id: "T-100" });
    expect(world.verified.has("T-100")).toBe(true);
    const v = await tools.verifyWrite.execute({ id: OOD_ID });
    expect(v).not.toEqual({ eden: "steered", skipped: "verifyWrite" });
  });

  test("ood deopts to the original tool and does not mutate", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = liveProgram();
    const state = createState({ programs: [program], island: world.island, failOpen: true });
    const tools = wrapTools(world.tools, state);
    const result = await tools.lookupTicket.execute({ id: OOD_ID });
    expect((result as { ok: boolean }).ok).toBe(true);
    expect(world.mutationsFor(OOD_ID)).toEqual({ wrote: false, verified: false, notified: false });
  });

  test("compiled-name deopt fail-opens to the first original tool", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = liveProgram();
    const state = createState({ programs: [program], island: world.island });
    const tools = wrapTools(world.tools, state);
    const compiled = (tools as Record<string, { execute: (a: Record<string, unknown>) => Promise<unknown> }>)[program.name];
    const out = await compiled!.execute({ id: OOD_ID });
    expect(out).toBeTruthy();
    expect(world.verified.has(OOD_ID)).toBe(false);
  });

  test("fail-open: uncompiled execute still works", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const state = createState({ failOpen: true });
    const tools = wrapTools(world.tools, state);
    const result = await tools.lookupTicket.execute({ id: "T-100" });
    expect((result as { id: string }).id).toBe("T-100");
  });

  test("uncompiled wrap overhead p50 < 5ms p95 < 20ms", async () => {
    const state = createState();
    const tools = wrapTools({ ping: { execute: (_args: Record<string, unknown>) => 1 } }, state);
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t0 = performance.now();
      await tools.ping.execute({});
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length * 0.5)]!).toBeLessThan(5);
    expect(samples[Math.floor(samples.length * 0.95)]!).toBeLessThan(20);
  });

  test("naive notify flushes a redacted trace", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const state = createState();
    const tools = wrapTools(world.tools, state);
    await tools.lookupTicket.execute({ id: "T-100", api_key: "sk-secret" });
    await tools.notify.execute({ id: "T-100" });
    expect(state.traces.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(state.traces)).not.toContain("sk-secret");
    const t = state.traces[0]!;
    expect(t.llmCalls).toBe(0);
    expect(t.prompt_tokens).toBeUndefined();
    expect(t.completion_tokens).toBeUndefined();
    expect(t.output).toBeDefined();
  });

  test("redaction keeps secrets out of traces", () => {
    const red = redact({
      api_key: "sk-secret",
      password: "hunter2",
      authorization: "Bearer abc.def",
      note: "Bearer tok_live_1",
    });
    expect(JSON.stringify(red)).not.toContain("sk-secret");
    expect(JSON.stringify(red)).not.toContain("hunter2");
    expect(JSON.stringify(red)).not.toMatch(/Bearer\s+[A-Za-z]/);
  });
});

describe("openai proxy", () => {
  test("steers an upstream tool call", async () => {
    const p = liveProgram();
    const state = createState({
      programs: [p],
      fetch: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [{ id: "c1", type: "function", function: { name: "lookupTicket", arguments: "{\"id\":\"T-100\"}" } }],
                },
              },
            ],
          }),
        )) as unknown as typeof fetch,
    });
    const res = await handleChatCompletions(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [], tools: [] }),
      }),
      { state, getPrograms: () => [p] },
    );
    const json = (await res.json()) as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }> };
    expect(json.choices[0]!.message.tool_calls[0]!.function.name).toBe("resolve_ticket");
  });

  test("records provider usage onto the current run", async () => {
    const state = createState({
      fetch: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok", tool_calls: [] } }],
            usage: { prompt_tokens: 21, completion_tokens: 7 },
          }),
        )) as unknown as typeof fetch,
    });
    const res = await handleChatCompletions(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
      }),
      { state },
    );
    expect(res.ok).toBe(true);
    expect(state.run.measured).toBe(true);
    expect(state.run.llmCalls).toBe(1);
    expect(state.run.prompt_tokens).toBe(21);
    expect(state.run.completion_tokens).toBe(7);
    expect(state.run.output).toBe("ok");
  });

  test("stream passthrough scrapes usage without inventing calls", async () => {
    const sse = [
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const state = createState({
      fetch: (async () => new Response(sse, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
    });
    const res = await handleChatCompletions(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
      }),
      { state },
    );
    expect(res.headers.get("content-type") || "").toContain("text/event-stream");
    await res.text();
    expect(state.run.measured).toBe(true);
    expect(state.run.llmCalls).toBe(1);
    expect(state.run.prompt_tokens).toBe(4);
    expect(state.run.completion_tokens).toBe(1);
  });

  test("failed upstream stream does not invent an LLM call", async () => {
    const state = createState({
      fetch: (async () => new Response("nope", { status: 502, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch,
    });
    const res = await handleChatCompletions(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true }),
      }),
      { state },
    );
    expect(res.status).toBe(502);
    await res.text();
    expect(state.run.llmCalls).toBe(0);
    expect(state.run.measured).toBe(false);
  });

  test("stream=true with live tools returns SSE", async () => {
    const p = liveProgram();
    const state = createState({
      programs: [p],
      fetch: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok", tool_calls: [] } }],
          }),
        )) as unknown as typeof fetch,
    });
    const res = await handleChatCompletions(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true, tools: [{ type: "function", function: { name: "lookupTicket" } }] }),
      }),
      { state, getPrograms: () => [p] },
    );
    expect(res.headers.get("content-type") || "").toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: ");
    expect(text).toContain("[DONE]");
  });
});

describe("eden() fail-open helper", () => {
  test("openai handle points at the local wrap", () => {
    const e = eden({ apiKey: "k" });
    const m = e.openai("gpt-4o");
    expect(m.model).toBe("gpt-4o");
    expect(m.baseURL).toContain("/v1");
  });
});

describe("pullLive", () => {
  test("fail-open when control is down", async () => {
    const { pullLive, createState } = await import("../src/wrap-tools");
    const state = createState({
      apiKey: "eden_dev",
      baseUrl: "http://127.0.0.1:9",
      fetch: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    await pullLive(state);
    expect(state.programs).toEqual([]);
  });

  test("drops paused tools that were still local", async () => {
    const { pullLive, createState } = await import("../src/wrap-tools");
    const paused = liveProgram();
    const state = createState({
      programs: [paused],
      apiKey: "eden_dev",
      baseUrl: "http://x",
      fetch: (async () =>
        new Response(JSON.stringify({ tools: [{ program: paused, state: "paused" }] }), { status: 200 })) as unknown as typeof fetch,
    });
    await pullLive(state);
    expect(state.programs).toEqual([]);
  });
});

describe("wrapTimeoutMs", () => {
  test("reads EDEN_TIMEOUT_MS and caps at 300s", () => {
    const prev = process.env.EDEN_TIMEOUT_MS;
    delete process.env.EDEN_TIMEOUT_MS;
    expect(wrapTimeoutMs()).toBe(60_000);
    expect(wrapTimeoutMs(12_000)).toBe(12_000);
    expect(wrapTimeoutMs(999_999)).toBe(300_000);
    process.env.EDEN_TIMEOUT_MS = "999999";
    expect(wrapTimeoutMs()).toBe(300_000);
    process.env.EDEN_TIMEOUT_MS = "5000";
    expect(wrapTimeoutMs()).toBe(5000);
    if (prev === undefined) delete process.env.EDEN_TIMEOUT_MS;
    else process.env.EDEN_TIMEOUT_MS = prev;
  });
});

describe("control outbox", () => {
  test("failed posts retry on flush", async () => {
    let n = 0;
    const state = createState({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "k",
      fetch: (async () => {
        n++;
        if (n === 1) throw new Error("down");
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const world = createTicketShip({ llmMs: 0 });
    const tools = wrapTools(world.tools, state);
    await tools.notify.execute({ id: "T-100" });
    for (let i = 0; i < 40 && n < 2; i++) {
      if (pendingPosts(state) > 0) await flushOutbox(state);
      else await Bun.sleep(10);
    }
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe("the proxy speaks the protocol its clients read", () => {
  const streamed = async (upstream: Record<string, unknown>, tools: unknown) => {
    const p = liveProgram();
    const state = createState({
      programs: [p],
      fetch: (async () => new Response(JSON.stringify(upstream))) as unknown as typeof fetch,
    });
    const res = await handleChatCompletions(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4o", messages: [], stream: true, tools }),
      }),
      { state, getPrograms: () => [p] },
    );
    const text = await res.text();
    const chunks = text
      .split("\n\n")
      .map((l) => l.replace(/^data: /, "").trim())
      .filter((l) => l && l !== "[DONE]")
      .map((l) => JSON.parse(l) as { object: string; choices: Array<{ delta?: Record<string, unknown>; finish_reason: string | null }> });
    return { text, chunks };
  };

  test("a streamed reply carries delta, not message", async () => {
    // The request is forced non-streaming upstream so tool calls can be
    // steered, and the completion was then wrapped in a single `data:` line
    // unchanged. A streaming client reads choices[].delta, so `delta` was
    // undefined and both content and tool calls came back empty — every
    // OpenAI-SDK client using stream:true with a tool list got nothing.
    const { text, chunks } = await streamed(
      { id: "x", model: "gpt-4o", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
      [{ type: "function", function: { name: "lookupTicket" } }],
    );
    expect(text).toContain("[DONE]");
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true);
    expect(chunks[0]!.choices[0]!.delta!.content).toBe("ok");
    expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe("stop");
    expect(text).not.toContain('"message"');
  });

  test("streamed tool calls are steered and carry an index", async () => {
    const { chunks } = await streamed(
      {
        id: "x",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              tool_calls: [{ id: "c1", type: "function", function: { name: "lookupTicket", arguments: '{"id":"T-100"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      [{ type: "function", function: { name: "lookupTicket" } }],
    );
    const calls = chunks[0]!.choices[0]!.delta!.tool_calls as Array<{ index: number; function: { name: string } }>;
    expect(calls[0]!.index).toBe(0);
    expect(calls[0]!.function.name).toBe("resolve_ticket");
  });

  test("a client that asked for no tools is not given any", async () => {
    // injectTools returned the compiled tools whenever `tools` was not an
    // array, so a plain completion came back with tools attached and its reply
    // steered into a tool_calls response the caller had no handler for.
    const p = liveProgram();
    expect(injectTools(undefined, [p])).toBeUndefined();
    // An empty array is different: the client opted into function calling and
    // simply has none of its own, which is who compiled tools are for.
    expect(Array.isArray(injectTools([], [p]))).toBe(true);
    expect((injectTools([], [p]) as unknown[]).length).toBe(1);
  });
});

describe("online signal bus", () => {
  test("a failing run emits cheap warnings while it is still running", async () => {
    const fired: string[] = [];
    const state = createState({
      programs: [],
      onWarning: (w) => fired.push(w.kind),
    });
    const tools = wrapTools(
      {
        boom: async () => {
          throw new Error("no");
        },
      },
      state,
    );
    await expect(tools.boom.execute({})).rejects.toThrow("no");
    expect(fired).toEqual([]);
    expect(state.run.events).toHaveLength(1);

    await expect(tools.boom.execute({})).rejects.toThrow("no");
    expect(fired).toEqual(["fail_streak", "budget"]);
    expect(state.run.events).toHaveLength(2);
    expect(state.run.events.every((e) => !e.ok)).toBe(true);
    expect(state.run.warnings.some((w) => w.kind === "fail_streak")).toBe(true);
    expect(state.run.warnings.some((w) => w.kind === "budget")).toBe(true);
    expect(state.run.warnings[0]).not.toHaveProperty("prompt_tokens");
    expect(state.traces).toHaveLength(0);
  });

  test("a repeating tool n-gram is on the flushed trace", async () => {
    const fired: string[] = [];
    const state = createState({
      programs: [],
      onWarning: (w) => fired.push(w.kind),
    });
    const tools = wrapTools(
      {
        search: async () => ({ hit: 1 }),
        write: async () => ({ ok: true }),
        notify: async () => ({ done: true }),
      },
      state,
    );
    await tools.search.execute({});
    await tools.write.execute({});
    await tools.search.execute({});
    await tools.write.execute({});
    expect(fired).toEqual(["repeat_ngram", "budget"]);
    await tools.notify.execute({});
    expect(state.traces[0]?.warnings?.map((w) => w.kind)).toEqual(["repeat_ngram", "budget"]);
    expect(state.traces[0]?.warnings?.[0]?.ngram).toEqual(["search", "write"]);
  });

  test("a third consecutive fail is halted by the circuit breaker", async () => {
    const state = createState({ programs: [] });
    const tools = wrapTools(
      {
        boom: async () => {
          throw new Error("no");
        },
      },
      state,
    );
    await expect(tools.boom.execute({})).rejects.toThrow("no");
    await expect(tools.boom.execute({})).rejects.toThrow("no");
    expect(state.run.firstWarningAt).toBe(0);
    expect(await tools.boom.execute({})).toEqual({ eden: "halted", reason: "fail_streak" });
  });

  test("killAfterWarning stops spend after the first fail", async () => {
    const state = createState({ programs: [], killAfterWarning: true });
    const tools = wrapTools(
      {
        boom: async () => {
          throw new Error("no");
        },
      },
      state,
    );
    await expect(tools.boom.execute({})).rejects.toThrow("no");
    expect(await tools.boom.execute({})).toEqual({ eden: "halted", reason: "warning" });
  });

  test("a repeating n-gram hard-stops the next cycle when nothing is compiled", async () => {
    const state = createState({ programs: [] });
    const tools = wrapTools(
      {
        search: async () => ({ hit: 1 }),
        write: async () => ({ ok: true }),
      },
      state,
    );
    await tools.search.execute({});
    await tools.write.execute({});
    await tools.search.execute({});
    await tools.write.execute({});
    expect(await tools.search.execute({})).toEqual({ eden: "halted", reason: "loop" });
  });

  test("finalize without a required check is blocked", async () => {
    const program = {
      ...liveProgram(),
      sequence: ["writeRecord", "verifyWrite", "notify"],
    };
    const state = createState({ programs: [program] });
    const tools = wrapTools(
      {
        writeRecord: async () => ({ written: true }),
        notify: async () => ({ done: true }),
      },
      state,
    );
    await tools.writeRecord.execute({ id: "T-1" });
    const out = (await tools.notify.execute({ id: "T-1" })) as { eden?: string; reason?: string };
    expect(out.reason).toBe("missing_evidence");
    expect(out.eden === "blocked" || out.eden === "halted").toBe(true);
  });

  test("steered skips are recorded on the trace", async () => {
    const world = createTicketShip({ llmMs: 0 });
    const program = liveProgram();
    const state = createState({ programs: [program], island: world.island });
    const tools = wrapTools(world.tools, state);
    await tools.lookupTicket.execute({ id: "T-102" });
    const second = await tools.fetchDetails.execute({ id: "T-102" });
    expect(second).toEqual({ eden: "steered", skipped: "fetchDetails" });
    expect(state.run.events.some((e) => e.name === "fetchDetails" && e.skipped)).toBe(true);
  });
});
