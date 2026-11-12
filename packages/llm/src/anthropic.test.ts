import { describe, expect, test } from "bun:test";
import {
  AnthropicModel,
  anthropicBody,
  anthropicCost,
  anthropicPrice,
  requestTtl,
  type AnthropicCallRecord,
  type AnthropicMeter,
} from "./anthropic";

const sse = (events: object[]) =>
  events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** A fetch that answers one streamed message, split into small chunks to exercise the SSE reader's buffering. */
function streamFetch(events: object[], seen: { body?: Record<string, unknown>; headers?: Headers } = {}) {
  return (async (_url: unknown, init?: RequestInit) => {
    seen.body = JSON.parse(String(init?.body));
    seen.headers = new Headers(init?.headers);
    const text = sse(events);
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

const okEvents = (text: string) => [
  {
    type: "message_start",
    message: {
      usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 600, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 3) } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(3) } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
  { type: "message_stop" },
];

function recordingMeter() {
  const reserved: number[] = [];
  const booked: AnthropicCallRecord[] = [];
  const meter: AnthropicMeter = { reserve: (u) => void reserved.push(u), book: (r) => void booked.push(r) };
  return { meter, reserved, booked };
}

describe("AnthropicModel", () => {
  test("caches the system prefix, merges turns, never sends temperature", () => {
    const body = anthropicBody(
      { apiKey: "k" },
      {
        messages: [
          { role: "system", content: "fixed instructions" },
          { role: "user", content: "a" },
          { role: "user", content: "b" },
        ],
        maxTokens: 100,
        temperature: 0,
        json: true,
      },
      false,
    );
    expect(body.system?.length).toBe(2);
    expect(body.system?.[0]?.cache_control).toBeUndefined();
    expect(body.system?.[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages).toEqual([{ role: "user", content: "a\n\nb" }]);
    expect("temperature" in body).toBe(false);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  test("a message asking a 1-hour TTL sends every breakpoint of the request at 1 hour, and prices writes at 2x", () => {
    const request = {
      messages: [
        { role: "system" as const, content: "fixed instructions" },
        { role: "user" as const, content: "the user's rule sheet", cache: true, cacheTtl: "1h" as const },
        { role: "user" as const, content: "the request" },
      ],
      maxTokens: 100,
    };
    const body = anthropicBody({ apiKey: "k" }, request, false);
    const hour = { type: "ephemeral" as const, ttl: "1h" as const };
    // Anthropic wants a longer TTL before a shorter one: the system breakpoint goes at an hour too.
    expect(body.system?.[0]?.cache_control).toEqual(hour);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "the user's rule sheet", cache_control: hour },
          { type: "text", text: "the request" },
        ],
      },
    ]);
    expect(requestTtl({ apiKey: "k" }, request)).toBe("1h");
    // Without the ask, the 5-minute TTL as before; the model-wide option still wins.
    const plain = { ...request, messages: request.messages.map(({ cacheTtl: _, ...m }) => m) };
    expect(requestTtl({ apiKey: "k" }, plain)).toBe("5m");
    expect(anthropicBody({ apiKey: "k" }, plain, false).system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(requestTtl({ apiKey: "k", cacheTtl: "1h" }, plain)).toBe("1h");
    // An uncached message's ask is ignored: it ends no prefix.
    const loose = { ...request, messages: [{ role: "user" as const, content: "x", cacheTtl: "1h" as const }] };
    expect(requestTtl({ apiKey: "k" }, loose)).toBe("5m");
  });

  test("reports a reply its stop sequence ended; a stream cut with no stop reason is an error", async () => {
    const stopped = okEvents('{"a":1').map((e) =>
      e.type === "message_delta" ? { ...e, delta: { stop_reason: "stop_sequence" } } : e,
    );
    const req = { messages: [{ role: "user" as const, content: "q" }], maxTokens: 50, stop: ["X"] };
    expect((await new AnthropicModel({ apiKey: "k", fetch: streamFetch(stopped) }).chat(req)).stopped).toBe(true);
    const cut = okEvents('{"a":1').filter((e) => e.type !== "message_delta");
    // A cut stream's text could pass for a stopped reply (D240's closeStopped) and lose the entries after it.
    await expect(new AnthropicModel({ apiKey: "k", fetch: streamFetch(cut) }).chat(req)).rejects.toThrow(
      "without a stop reason",
    );
  });

  test("sends stop sequences only when asked", () => {
    const req = { messages: [{ role: "user" as const, content: "a" }], maxTokens: 10 };
    expect("stop_sequences" in anthropicBody({ apiKey: "k" }, req, false)).toBe(false);
    expect(anthropicBody({ apiKey: "k" }, { ...req, stop: ['"same":false'] }, false).stop_sequences).toEqual([
      '"same":false',
    ]);
  });

  test("Sonnet 5.5 turns thinking off with between_tools (disabled is a 400 there) and is priced as listed", () => {
    const req = { messages: [{ role: "user" as const, content: "a" }], maxTokens: 100 };
    const sonnet = anthropicBody({ apiKey: "k", model: "claude-sonnet-5-5" }, req, false);
    expect(sonnet.thinking).toEqual({ type: "between_tools" });
    expect(
      anthropicBody({ apiKey: "k", model: "claude-sonnet-5-5", thinking: "adaptive" }, req, false).thinking,
    ).toEqual({ type: "adaptive" });
    expect(anthropicBody({ apiKey: "k", model: "claude-haiku-5-5" }, req, false).thinking).toEqual({
      type: "disabled",
    });
    expect(anthropicPrice("claude-sonnet-5-5")).toMatchObject({ input: 2, output: 10 });
  });

  test("a user message marked cache ends a cached prefix at its own block", () => {
    const body = anthropicBody(
      { apiKey: "k" },
      {
        messages: [
          { role: "system", content: "fixed" },
          { role: "user", content: "standing list", cache: true },
          { role: "user", content: "the request" },
        ],
        maxTokens: 100,
      },
      false,
    );
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "standing list", cache_control: { type: "ephemeral" } },
          { type: "text", text: "the request" },
        ],
      },
    ]);
  });

  test("streams text, reports cache reads, ttft, and books the call", async () => {
    const seen: { body?: Record<string, unknown>; headers?: Headers } = {};
    const { meter, reserved, booked } = recordingMeter();
    const model = new AnthropicModel({
      apiKey: "secret",
      fetch: streamFetch(okEvents('```json\n{"a":1}\n```'), seen),
      meter,
    });
    const res = await model.chat({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
      ],
      maxTokens: 50,
      json: true,
    });
    expect(res.text).toBe('{"a":1}');
    expect(res.usage).toEqual({ inputTokens: 640, cachedInputTokens: 600, cacheWriteTokens: 0, outputTokens: 12 });
    expect(res.ttftMs).toBeGreaterThanOrEqual(0);
    expect(res.truncated).toBe(false);
    expect(res.stopped).toBe(false);
    expect(seen.headers?.get("x-api-key")).toBe("secret");
    expect(seen.body?.stream).toBe(true);
    expect(reserved.length).toBe(1);
    expect(booked.length).toBe(1);
    expect(booked[0]!.costUsd).toBeCloseTo(res.costUsd, 12);
    // 40 uncached at $0.10/M, 600 read at $0.01/M, 12 out at $0.50/M.
    expect(res.costUsd).toBeCloseTo((40 * 0.1 + 600 * 0.01 + 12 * 0.5) / 1e6, 12);
  });

  test("a request whose sheet asks a 1-hour TTL books and reports its cache writes at 2x input (D1197)", async () => {
    const writes = okEvents("ok");
    const start = writes[0] as { message: { usage: Record<string, number> } };
    writes[0] = {
      type: "message_start",
      message: { usage: { ...start.message.usage, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 } },
    };
    const run = async (cacheTtl?: "1h") => {
      const { meter, booked } = recordingMeter();
      const res = await new AnthropicModel({ apiKey: "k", fetch: streamFetch(writes), meter }).chat({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "the sheet", cache: true, ...(cacheTtl ? { cacheTtl } : {}) },
          { role: "user", content: "q" },
        ],
        maxTokens: 50,
      });
      return { res, booked };
    };
    const hour = await run("1h");
    const five = await run();
    const price = anthropicPrice("claude-haiku-5-5");
    // 40 uncached and 2,000 written at $0.10/M (written at 2x on the hour, 1.25x on five minutes), 12 out at $0.50/M.
    expect(hour.res.costUsd).toBeCloseTo((40 * 0.1 + 2000 * 0.2 + 12 * 0.5) / 1e6, 12);
    expect(hour.res.costUsd).toBeCloseTo(anthropicCost(hour.res.usage, price, "1h"), 12);
    expect(hour.booked[0]!.costUsd).toBeCloseTo(hour.res.costUsd, 12);
    expect(five.res.costUsd).toBeCloseTo((40 * 0.1 + 2000 * 0.125 + 12 * 0.5) / 1e6, 12);
    expect(five.booked[0]!.costUsd).toBeCloseTo(five.res.costUsd, 12);
  });

  test("a refused meter stops the call before anything is sent", async () => {
    let sent = 0;
    const fetchSpy = (async () => {
      sent++;
      return new Response("");
    }) as unknown as typeof fetch;
    const model = new AnthropicModel({
      apiKey: "k",
      fetch: fetchSpy,
      meter: {
        reserve: () => {
          throw new Error("cap");
        },
        book: () => {},
      },
    });
    await expect(model.chat({ messages: [{ role: "user", content: "q" }], maxTokens: 5 })).rejects.toThrow("cap");
    expect(sent).toBe(0);
  });

  test("an HTTP error and a network failure are both booked at $0", async () => {
    const { meter, booked } = recordingMeter();
    const failing = new AnthropicModel({
      apiKey: "k",
      meter,
      fetch: (async () => new Response('{"error":"overloaded"}', { status: 529 })) as unknown as typeof fetch,
    });
    await expect(failing.chat({ messages: [{ role: "user", content: "q" }], maxTokens: 5 })).rejects.toThrow("529");
    const broken = new AnthropicModel({
      apiKey: "k",
      meter,
      fetch: (async () => {
        throw new Error("reset");
      }) as unknown as typeof fetch,
    });
    await expect(broken.chat({ messages: [{ role: "user", content: "q" }], maxTokens: 5 })).rejects.toThrow("reset");
    expect(booked.map((b) => [b.status, b.costUsd])).toEqual([
      [529, 0],
      [0, 0],
    ]);
  });

  test("prices cache writes by TTL and switches rate card above 100K prompt tokens", () => {
    const p = anthropicPrice("claude-haiku-5-5");
    const u = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 1000, outputTokens: 0 };
    expect(anthropicCost(u, p, "5m")).toBeCloseTo((1000 * 0.125) / 1e6, 12);
    expect(anthropicCost(u, p, "1h")).toBeCloseTo((1000 * 0.2) / 1e6, 12);
    const long = { inputTokens: 200_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
    expect(anthropicCost(long, p)).toBeCloseTo((200_000 * 0.5 + 10 * 2.5) / 1e6, 12);
  });

  test("prices cache reads at the model's own share of input: 0.1x by default, 0.05x on Sonnet 5.5 and Opus 5.5", () => {
    const u = { inputTokens: 1000, cachedInputTokens: 1000, cacheWriteTokens: 0, outputTokens: 0 };
    expect(anthropicCost(u, anthropicPrice("claude-haiku-5-5"))).toBeCloseTo((1000 * 0.1 * 0.1) / 1e6, 12);
    expect(anthropicCost(u, anthropicPrice("claude-sonnet-5-5"))).toBeCloseTo((1000 * 2 * 0.05) / 1e6, 12);
    expect(anthropicCost(u, anthropicPrice("claude-opus-5-5"))).toBeCloseTo((1000 * 4 * 0.05) / 1e6, 12);
  });
});
