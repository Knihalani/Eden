import { describe, expect, test } from "bun:test";
import type { AnthropicCallRecord, AnthropicMeter } from "./anthropic";
import { AnthropicBatchModel, batchCost } from "./anthropic-batch";
import { anthropicCost, anthropicPrice } from "./anthropic";

interface Sent {
  url: string;
  method: string;
  body?: { requests: { custom_id: string; params: Record<string, unknown> }[] };
  headers: Headers;
}

/**
 * A fake Batches API: a create returns an id, the first `pollsBeforeEnd` polls say "in_progress", then "ended"; the
 * results answer every request with `reply(params)` (or the result type it returns), in reverse order to check that
 * results are matched by `custom_id`.
 */
function fakeApi(opts: { pollsBeforeEnd?: number; reply?: (p: Record<string, unknown>) => string | { type: string } }) {
  const sent: Sent[] = [];
  let polls = 0;
  let last: Sent["body"];
  const f = (async (url: string, init?: RequestInit) => {
    const s: Sent = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers) };
    if (init?.body) s.body = JSON.parse(String(init.body));
    sent.push(s);
    if (s.method === "POST") {
      last = s.body;
      polls = 0;
      return Response.json({ id: "msgbatch_1", processing_status: "in_progress" });
    }
    if (url.endsWith("/results")) {
      const lines = [...(last?.requests ?? [])].reverse().map((r) => {
        const out = opts.reply?.(r.params) ?? "{}";
        if (typeof out !== "string") return JSON.stringify({ custom_id: r.custom_id, result: out });
        return JSON.stringify({
          custom_id: r.custom_id,
          result: {
            type: "succeeded",
            message: {
              content: [{ type: "text", text: out }],
              stop_reason: "end_turn",
              usage: {
                input_tokens: 100,
                cache_read_input_tokens: 900,
                cache_creation_input_tokens: 0,
                output_tokens: 50,
              },
            },
          },
        });
      });
      return new Response(lines.join("\n"));
    }
    polls++;
    const ended = polls > (opts.pollsBeforeEnd ?? 0);
    return Response.json({
      id: "msgbatch_1",
      processing_status: ended ? "ended" : "in_progress",
      results_url: ended ? "https://api.test/v1/messages/batches/msgbatch_1/results" : null,
    });
  }) as unknown as typeof fetch;
  return { f, sent };
}

function meter() {
  const reserved: number[] = [];
  const booked: AnthropicCallRecord[] = [];
  const m: AnthropicMeter = { reserve: (u) => void reserved.push(u), book: (r) => void booked.push(r) };
  return { m, reserved, booked };
}

const req = (text: string) => ({
  messages: [
    { role: "system" as const, content: "fixed" },
    { role: "user" as const, content: text },
  ],
  maxTokens: 100,
  json: true,
});

describe("AnthropicBatchModel", () => {
  test("gathers calls into one batch, matches results by custom_id, prices at half", async () => {
    const api = fakeApi({ pollsBeforeEnd: 2, reply: (p) => `{"echo":${JSON.stringify(JSON.stringify(p.messages))}}` });
    const { m, reserved, booked } = meter();
    const model = new AnthropicBatchModel({
      apiKey: "k",
      baseUrl: "https://api.test",
      fetch: api.f,
      meter: m,
      windowMs: 5,
      sleep: async () => {},
    });
    const [a, b] = await Promise.all([model.chat(req("first")), model.chat(req("second"))]);
    // One create, polls until ended, one results read.
    const posts = api.sent.filter((s) => s.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://api.test/v1/messages/batches");
    expect(posts[0]!.body!.requests).toHaveLength(2);
    // Not streamed, the system prefix cached as in AnthropicModel.
    const params = posts[0]!.body!.requests[0]!.params as { stream?: boolean; system: { cache_control?: object }[] };
    expect(params.stream).toBeUndefined();
    expect(params.system.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(posts[0]!.headers.get("x-api-key")).toBe("k");
    // Results came back in reverse order: each caller still gets its own.
    expect(a.text).toContain("first");
    expect(b.text).toContain("second");
    const usage = { inputTokens: 1000, cachedInputTokens: 900, cacheWriteTokens: 0, outputTokens: 50 };
    expect(a.usage).toEqual(usage);
    const full = anthropicCost(usage, anthropicPrice("claude-haiku-5-5"));
    expect(a.costUsd).toBeCloseTo(full / 2, 12);
    expect(batchCost(usage, "claude-haiku-5-5")).toBeCloseTo(full / 2, 12);
    expect(a.provider).toBe("anthropic-batch");
    expect(reserved).toHaveLength(2);
    expect(booked.map((r) => r.costUsd).reduce((x, y) => x + y)).toBeCloseTo(full, 12);
    expect(model.batches).toEqual([
      expect.objectContaining({ id: "msgbatch_1", requests: 2, succeeded: 2, failed: 0 }),
    ]);
  });

  test("a failed request rejects only its caller; an abort before sending drops it unbilled", async () => {
    const api = fakeApi({ reply: (p) => (JSON.stringify(p.messages).includes("bad") ? { type: "errored" } : "{}") });
    const { m, booked } = meter();
    const model = new AnthropicBatchModel({
      apiKey: "k",
      baseUrl: "https://api.test",
      fetch: api.f,
      meter: m,
      windowMs: 5,
      sleep: async () => {},
    });
    const ac = new AbortController();
    const dropped = model.chat({ ...req("dropped"), signal: ac.signal });
    ac.abort();
    const good = model.chat(req("good"));
    const bad = model.chat(req("bad"));
    await expect(dropped).rejects.toBeDefined();
    expect((await good).text).toBe("{}");
    await expect(bad).rejects.toThrow("errored");
    const sentIds = api.sent.find((s) => s.method === "POST")!.body!.requests;
    expect(sentIds).toHaveLength(2);
    // Every reservation is booked once: the dropped and the errored at $0, the good at its cost.
    expect(booked).toHaveLength(3);
    expect(booked.filter((r) => r.costUsd > 0)).toHaveLength(1);
  });

  test("a refused create rejects every caller of the batch", async () => {
    const f = (async () => new Response("overloaded", { status: 529 })) as unknown as typeof fetch;
    const model = new AnthropicBatchModel({ apiKey: "k", baseUrl: "https://api.test", fetch: f, windowMs: 1 });
    const out = await Promise.allSettled([model.chat(req("a")), model.chat(req("b"))]);
    expect(out.map((o) => o.status)).toEqual(["rejected", "rejected"]);
    // The error names the status, never the key.
    expect(String((out[0] as PromiseRejectedResult).reason)).toContain("529");
    expect(String((out[0] as PromiseRejectedResult).reason)).not.toContain('k"');
  });

  test("the meter can refuse a call before it is queued", async () => {
    const api = fakeApi({});
    const refusing: AnthropicMeter = {
      reserve: () => {
        throw new Error("cap");
      },
      book: () => {},
    };
    const model = new AnthropicBatchModel({ apiKey: "k", fetch: api.f, meter: refusing, windowMs: 1 });
    expect(() => model.chat(req("x"))).toThrow("cap");
    await model.idle();
    expect(api.sent).toHaveLength(0);
  });
});
