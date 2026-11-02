import { describe, expect, test } from "bun:test";
import {
  AnthropicModel,
  anthropicBody,
  anthropicCost,
  anthropicPrice,
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
    expect(seen.headers?.get("x-api-key")).toBe("secret");
    expect(seen.body?.stream).toBe(true);
    expect(reserved.length).toBe(1);
    expect(booked.length).toBe(1);
    expect(booked[0]!.costUsd).toBeCloseTo(res.costUsd, 12);
    // 40 uncached at $0.10/M, 600 read at $0.01/M, 12 out at $0.50/M.
    expect(res.costUsd).toBeCloseTo((40 * 0.1 + 600 * 0.01 + 12 * 0.5) / 1e6, 12);
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
});
