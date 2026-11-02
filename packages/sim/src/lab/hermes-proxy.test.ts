import { describe, expect, test } from "bun:test";
import { modelProxy, type ProxyOptions, type ProxyTask } from "./hermes-proxy";
import { Timeline } from "./pi-timeline";

const KEY = "sk-or-test-SECRET-123";

function task(): ProxyTask {
  return {
    tl: new Timeline(),
    record: { task: "t1", requests: [] },
    r: { modelCalls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 },
  };
}

/** A proxy over a fake upstream, with its budget calls recorded. */
function setup(upstream: (url: string, init: RequestInit) => Promise<Response>) {
  const ledger: string[] = [];
  const seen: { url: string; init: RequestInit }[] = [];
  const options: ProxyOptions = {
    key: KEY,
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return upstream(url, init);
    }) as unknown as typeof fetch,
    model: "m",
    maxTokens: 2_000,
    extraBody: { provider: { zdr: true } },
    reserve: (est) => ledger.push(`reserve ${est}`),
    settle: (est, cost) => ledger.push(`settle ${est} ${cost}`),
    price: () => 0.5,
  };
  return { proxy: modelProxy(options), ledger, seen };
}

const chat = (body: unknown = { messages: [{ role: "user", content: "hi" }], stream: true }) =>
  new Request("http://127.0.0.1/s/a/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer lab-proxy" },
    body: JSON.stringify(body),
  });

/** An SSE response whose chunks are sent one per pull. */
function sse(chunks: unknown[]): Response {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"];
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (i < lines.length) ctl.enqueue(new TextEncoder().encode(lines[i++]!));
      else ctl.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const delta = { choices: [{ delta: { content: "Hel" } }] };
const usage = { choices: [{ delta: {} }], usage: { prompt_tokens: 120, completion_tokens: 7, cost: 0.25 } };

describe("hermes-ab's model proxy", () => {
  test("a stream is booked from the usage on its last chunk, once, as one model call", async () => {
    const { proxy, ledger } = setup(async () => sse([delta, usage]));
    const t = task();
    const res = await proxy("chat/completions", chat(), () => t);
    expect(await res.text()).toContain("[DONE]");
    expect(ledger).toEqual(["reserve 0.5", "settle 0.5 0.25"]);
    expect(t.r).toEqual({ modelCalls: 1, promptTokens: 120, completionTokens: 7, costUsd: 0.25 });
    expect(t.record.requests).toHaveLength(1);
    expect(t.record.requests[0]).toMatchObject({ in: 120, out: 7, cost: 0.25 });
    expect(t.record.requests[0]!.firstTokenMs).not.toBeNull();
    expect(t.record.requests[0]!.error).toBeUndefined();
  });

  test("a stream Hermes stops reading is booked once, as cancelled", async () => {
    const { proxy, ledger } = setup(async () => sse([delta, delta, usage]));
    const t = task();
    const res = await proxy("chat/completions", chat(), () => t);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("done with it");
    await reader.cancel("again").catch(() => {});
    expect(ledger.filter((l) => l.startsWith("settle"))).toHaveLength(1);
    expect(t.record.requests).toHaveLength(1);
    expect(t.record.requests[0]!.cancelled).toBe(true);
    expect(t.r.modelCalls).toBe(1);
  });

  test("a failed request settles its reservation, stays in the record with an error, and is not a model call", async () => {
    for (const upstream of [
      async () => new Response("overloaded", { status: 503 }),
      async () => {
        throw new TypeError("connection reset");
      },
    ]) {
      const { proxy, ledger } = setup(upstream);
      const t = task();
      const res = await proxy("chat/completions", chat(), () => t);
      expect(res.status).toBe(503);
      expect(ledger).toEqual(["reserve 0.5", "settle 0.5 0"]);
      expect(t.r.modelCalls).toBe(0);
      expect(t.record.requests).toHaveLength(1);
      expect(t.record.requests[0]!.error).toMatch(/http 503|TypeError/);
    }
  });

  test("the key goes in the upstream header only: never in the forwarded body or in what Hermes gets back", async () => {
    const { proxy, seen } = setup(async () => new Response(`bad key ${KEY}`, { status: 401 }));
    const res = await proxy("chat/completions", chat({ messages: [], max_tokens: 9_999 }), () => task());
    const sent = seen[0]!.init;
    expect((sent.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(String(sent.body)).not.toContain(KEY);
    expect(JSON.parse(String(sent.body))).toMatchObject({ model: "m", max_tokens: 2_000, provider: { zdr: true } });
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).toContain("[redacted]");
    expect([...res.headers.values()].join(" ")).not.toContain(KEY);
  });

  test("a request outside any task is counted as an orphan and still settled", async () => {
    const { proxy, ledger } = setup(async () => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    let orphans = 0;
    const p2 = modelProxy({
      key: KEY,
      fetch: (async () => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } })) as never,
      model: "m",
      maxTokens: 10,
      reserve: () => {},
      settle: () => {},
      price: () => 0,
      onOrphan: () => orphans++,
    });
    await p2("chat/completions", chat({ messages: [] }), () => null);
    expect(orphans).toBe(1);
    await proxy("chat/completions", chat({ messages: [] }), () => null);
    expect(ledger.filter((l) => l.startsWith("settle"))).toHaveLength(1);
  });

  test("a budget refusal is a 402 that sends nothing", async () => {
    const seen: unknown[] = [];
    const p = modelProxy({
      key: KEY,
      fetch: (async (...a: unknown[]) => (seen.push(a), new Response("{}"))) as never,
      model: "m",
      maxTokens: 10,
      reserve: () => {
        throw new Error("budget $1 reached");
      },
      settle: () => {},
      price: () => 0,
    });
    const res = await p("chat/completions", chat(), () => task());
    expect(res.status).toBe(402);
    expect(seen).toHaveLength(0);
  });
});

describe("hermes-ab's model proxy on Anthropic (claude-* agent, D97)", () => {
  const AKEY = "sk-ant-test-SECRET-456";
  /** A proxy over a fake Messages endpoint; its ledger reservations and bookings recorded. */
  function setupA(upstream: (init: RequestInit) => Promise<Response>, refuse = false) {
    const ledger: string[] = [];
    const booked: { usage: { outputTokens: number; cachedInputTokens: number }; costUsd: number }[] = [];
    const sent: unknown[] = [];
    const options: ProxyOptions = {
      key: "",
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return upstream(init);
      }) as unknown as typeof fetch,
      model: "claude-haiku-5-5",
      maxTokens: 2_000,
      reserve: (est) => ledger.push(`reserve ${est}`),
      settle: (est, cost) => ledger.push(`settle ${est} ${cost}`),
      price: () => 0.5,
      anthropic: {
        key: AKEY,
        url: "https://anthropic.test/v1/messages",
        reserveLedger: () => {
          if (refuse) throw new Error("spend cap $1 reached");
          ledger.push("ledger reserve");
        },
        releaseLedger: () => ledger.push("ledger release"),
        book: (r) => booked.push(r as never),
      },
    };
    return { proxy: modelProxy(options), ledger, booked, sent };
  }
  const events = [
    { type: "message_start", message: { id: "m", usage: { input_tokens: 10, cache_read_input_tokens: 90 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } },
    { type: "message_stop" },
  ];
  /** A Messages SSE stream, one event per pull, that stops (and says so) when its request is aborted. */
  function msse(init: RequestInit, list: unknown[], state: { reads: number; aborted: boolean }): Response {
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        await Bun.sleep(5);
        if (init.signal?.aborted) {
          state.aborted = true;
          ctl.error(new DOMException("aborted", "AbortError"));
          return;
        }
        if (i < list.length) {
          state.reads++;
          ctl.enqueue(new TextEncoder().encode(`event: x\ndata: ${JSON.stringify(list[i++])}\n\n`));
        } else ctl.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }

  test("a stream is translated, booked once from the reported usage, the key only in the header", async () => {
    const state = { reads: 0, aborted: false };
    let headers: Headers | null = null;
    const { proxy, ledger, booked, sent } = setupA(async (init) => {
      headers = new Headers(init.headers);
      return msse(init, events, state);
    });
    const t = task();
    const res = await proxy("chat/completions", chat(), () => t);
    const text = await res.text();
    await Bun.sleep(20);
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"cached_tokens":90');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(headers!.get("x-api-key")).toBe(AKEY);
    expect(JSON.stringify(sent)).not.toContain(AKEY);
    expect(booked.length).toBe(1);
    expect(booked[0]!.usage.outputTokens).toBe(500);
    expect(ledger.filter((l) => l.startsWith("settle")).length).toBe(1);
    expect(t.r.modelCalls).toBe(1);
    expect(t.record.requests[0]!.cached).toBe(90);
  });

  test("Hermes cancelling the stream aborts the upstream request, then books once", async () => {
    const state = { reads: 0, aborted: false };
    const long = [...events.slice(0, 3), ...Array.from({ length: 50 }, () => events[2]!), ...events.slice(3)];
    const { proxy, booked } = setupA(async (init) => msse(init, long, state));
    const res = await proxy("chat/completions", chat(), () => task());
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(60);
    expect(state.aborted).toBe(true);
    expect(state.reads).toBeLessThan(long.length);
    expect(booked.length).toBe(1);
    // The output's usage never arrived: what was passed on is the estimate, not zero.
    expect(booked[0]!.usage.outputTokens).toBeGreaterThan(0);
  });

  test("the spend ledger's refusal is a 402 and nothing is sent; an upstream error is redacted", async () => {
    const refused = setupA(async () => new Response("{}"), true);
    const r1 = await refused.proxy("chat/completions", chat(), () => task());
    expect(r1.status).toBe(402);
    expect(refused.sent.length).toBe(0);
    expect(refused.ledger).toEqual(["reserve 0.5", "settle 0.5 0"]);
    const failing = setupA(async () => new Response(`bad key ${AKEY}`, { status: 401 }));
    const r2 = await failing.proxy("chat/completions", chat(), () => task());
    expect(r2.status).toBe(401);
    expect(await r2.text()).not.toContain(AKEY);
    expect(failing.booked.length).toBe(1);
  });
});
