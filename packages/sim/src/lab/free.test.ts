import { describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/pi-ai";
import { RequestCapReached } from "@eden/llm";
import { chat, parseGrade, type Task } from "./ab-common";
import { isCapError, labAccess, labModel, piModelFor, piRegistry, providerPrefs } from "./free";

const FREE = "nvidia/nemotron-3.5-super-vl:free";
const task = {
  must: [
    { id: "a", detail: "x" },
    { id: "b", detail: "y" },
    { id: "c", detail: "z" },
  ],
} as Task;
const meter = { before: () => {}, after: () => {} };

describe("labAccess", () => {
  test("a free model needs --allow-logging, and gets the free rate limit by default", () => {
    expect(() => labAccess([], [FREE])).toThrow("--allow-logging");
    const free = labAccess(["--allow-logging"], [FREE, "z-ai/glm-5.3-flash"]);
    expect(free).toMatchObject({ allowLogging: true, free: true });
    expect(providerPrefs(free)).toEqual({ provider: { data_collection: "allow", zdr: false } });
    const paid = labAccess([], ["z-ai/glm-5.3-flash"]);
    expect(paid).toMatchObject({ allowLogging: false, free: false });
    expect(providerPrefs(paid)).toEqual({});
    expect(paid.pacer.remaining).toBe(Infinity);
  });

  test("reads --max-requests and --rpm, and refuses nonsense", () => {
    const a = labAccess(["--allow-logging", "--max-requests", "40", "--rpm", "10"], [FREE]);
    expect(a.pacer.remaining).toBe(40);
    expect(() => labAccess(["--max-requests", "-1"], [])).toThrow("--max-requests");
    expect(() => labAccess(["--rpm", "fast"], [])).toThrow("--rpm");
  });

  test("Eden's lab model goes through the pacer and lifts the no-logging routing only when told", async () => {
    const bodies: any[] = [];
    const access = labAccess(["--allow-logging", "--max-requests", "1"], [FREE]);
    // The pacer wraps the global fetch: swap it for a stub for the length of this test.
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { cost: 0 } });
    }) as unknown as typeof fetch;
    try {
      const m = labModel(access, { apiKey: "k", model: FREE });
      const out = await m.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 5 });
      expect(out.costUsd).toBe(0);
      expect(bodies[0].provider).toMatchObject({ data_collection: "allow", zdr: false });
      await expect(m.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 5 })).rejects.toBeInstanceOf(
        RequestCapReached,
      );
    } finally {
      globalThis.fetch = real;
    }
  });

  test("isCapError sees the cap through a library's wrapping", () => {
    const wrapped = new Error("Connection error.", { cause: new RequestCapReached("request cap of 4 reached") });
    expect(isCapError(wrapped)).toBe(true);
    expect(isCapError(new Error("request cap of 4 reached"))).toBe(true);
    expect(isCapError(new Error("openrouter 500"))).toBe(false);
  });
});

describe("Pi on a free model", () => {
  test("pi-ai streams a free model id through the lab's own definition and fetch", async () => {
    const seen: { model?: string; provider?: unknown } = {};
    const sse = [
      { id: "1", object: "chat.completion.chunk", model: FREE, choices: [{ index: 0, delta: { content: "hel" } }] },
      { id: "1", object: "chat.completion.chunk", model: FREE, choices: [{ index: 0, delta: { content: "lo" } }] },
      {
        id: "1",
        object: "chat.completion.chunk",
        model: FREE,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0 },
      },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("");
    const fakeFetch = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.model = body.model;
      seen.provider = body.provider;
      return new Response(`${sse}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const model = piModelFor(FREE, 100);
    expect(model.cost).toMatchObject({ input: 0, output: 0 });
    const models = piRegistry([model]);
    process.env.OPENROUTER_API_KEY = "k";
    const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
    const out = await models
      .streamSimple(model, context, {
        fetch: fakeFetch,
        maxRetries: 0,
        onPayload: (p) => ({ ...(p as object), provider: { data_collection: "allow" } }),
      })
      .result()
      .finally(() => delete process.env.OPENROUTER_API_KEY);
    expect(out.errorMessage).toBeUndefined();
    expect(seen.model).toBe(FREE);
    expect(seen.provider).toEqual({ data_collection: "allow" });
    expect(out.stopReason).toBe("stop");
    expect(out.content.map((c) => (c.type === "text" ? c.text : "")).join("")).toBe("hello");
  });
});

describe("grading on free models", () => {
  test("parseGrade reads JSON mode, fenced, prose-wrapped and thinking replies", () => {
    expect(parseGrade(task, '{"1": true, "2": false, "3": true}')).toEqual({ a: true, b: false, c: true });
    expect(parseGrade(task, '```json\n{"1": true, "2": "true", "3": false}\n```')).toEqual({
      a: true,
      b: true,
      c: false,
    });
    expect(
      parseGrade(
        task,
        '<think>Fact 1 {"1": false}? The answer says x.</think>\nVerdict: {"1": true, "2": false, "3": false}',
      ),
    ).toEqual({ a: true, b: false, c: false });
    // Reasoning that quotes an object before the verdict: the last object wins.
    expect(parseGrade(task, 'Draft {"1": false}. Final: {"1": true, "2": true, "3": true} done')).toEqual({
      a: true,
      b: true,
      c: true,
    });
    // No parseable object: the last `n: bool` pair per fact.
    expect(parseGrade(task, '1: false, 2: true\nOn reflection "1": true, 3 = false')).toEqual({
      a: true,
      b: true,
      c: false,
    });
    // Unreadable is false; "yes" is not true.
    expect(parseGrade(task, "I think all of them")).toEqual({ a: false, b: false, c: false });
    expect(parseGrade(task, '{"1": "yes"}')).toEqual({ a: false, b: false, c: false });
    expect(parseGrade(task, null)).toEqual({ a: false, b: false, c: false });
  });

  test("chat drops JSON mode for a model that refuses it, and does not retry what a paced fetch gave up on", async () => {
    const bodies: any[] = [];
    const replies = [
      new Response('{"error":{"message":"response_format is not supported by this model"}}', { status: 400 }),
      Response.json({ choices: [{ message: { role: "assistant", content: '{"1": true}' } }], usage: { cost: 0 } }),
    ];
    const fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return replies.shift()!;
    }) as unknown as typeof globalThis.fetch;
    const out = await chat("k", meter, FREE, [{ role: "user", content: "x" }], undefined, true, {
      fetch,
      allowLogging: true,
    });
    expect(out.msg.content).toBe('{"1": true}');
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect(bodies[1].response_format).toBeUndefined();
    expect(bodies[1].provider).toEqual({ data_collection: "allow", zdr: false });

    let calls = 0;
    const busy = (async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof globalThis.fetch;
    await expect(chat("k", meter, FREE, [], undefined, false, { fetch: busy })).rejects.toThrow("429");
    expect(calls).toBe(1);

    const capped = (async () => {
      throw new RequestCapReached("request cap of 1 reached");
    }) as unknown as typeof globalThis.fetch;
    await expect(chat("k", meter, FREE, [], undefined, false, { fetch: capped })).rejects.toBeInstanceOf(
      RequestCapReached,
    );
  });
});
