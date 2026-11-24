import { describe, expect, test } from "bun:test";
import { LocalModel } from "./local";
import { ModelHeldError, RateHold } from "./pacing";
import type { ChatRequest } from "./types";

const REQ: ChatRequest = {
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ],
  maxTokens: 64,
};

function fakeFetch(
  handler: (
    body: Record<string, unknown>,
    init: RequestInit,
  ) => { status?: number; json?: unknown } | Response | Promise<Response>,
) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url: String(url), body, headers });
    const out = await handler(body, init ?? {});
    if (out instanceof Response) return out;
    return Response.json(out.json ?? {}, { status: out.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetch: f };
}

const ok = (text = "hello") => ({
  json: {
    model: "served/qwen",
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
});

describe("LocalModel", () => {
  test("Bun's own fetch timeout is off: the call's signal is its only deadline (D2120)", async () => {
    let init: RequestInit = {};
    const { fetch } = fakeFetch((_b, i) => {
      init = i;
      return ok();
    });
    await new LocalModel({ baseUrl: "http://localhost:11434/v1", model: "m", fetch }).chat(REQ);
    expect((init as { timeout?: unknown }).timeout).toBe(false);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("sends only the OpenAI-compatible fields a local server takes, with no bearer by default", async () => {
    const { calls, fetch } = fakeFetch(() => ok());
    const model = new LocalModel({ baseUrl: "http://localhost:11434/v1/", model: "qwen3:8b", fetch, freeCalls: true });
    const res = await model.chat({ ...REQ, temperature: 0.2, stop: ["END"], json: true });
    expect(res).toMatchObject({ text: "hello", model: "served/qwen", costUsd: 0, truncated: false });
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(calls.length).toBe(1);
    const { body, headers } = calls[0]!;
    expect(body).toEqual({
      model: "qwen3:8b",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 64,
      stop: ["END"],
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    // No OpenRouter-only fields, no auth header a keyless local server need not see.
    for (const field of ["provider", "session_id", "usage", "reasoning", "reasoning_effort"])
      expect(body[field]).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  test("sends a bearer when the endpoint wants one, and honors a server-reported cost", async () => {
    const { calls, fetch } = fakeFetch(() => ({
      json: { ...ok().json, usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } },
    }));
    const model = new LocalModel({
      baseUrl: "http://localhost:8080/v1",
      model: "m",
      apiKey: "local-key",
      fetch,
    });
    const res = await model.chat(REQ);
    expect(calls[0]!.headers.authorization).toBe("Bearer local-key");
    expect(res.costUsd).toBe(0.001);
  });

  test("a 400 to a response_format request is retried without it, and it is not sent again", async () => {
    let first = true;
    const { calls, fetch } = fakeFetch(() => (first ? ((first = false), { status: 400, json: { e: "x" } }) : ok()));
    const model = new LocalModel({ baseUrl: "http://x/v1", model: "m", fetch });
    const res = await model.chat({ ...REQ, json: true });
    expect(res.text).toBe("hello");
    expect(calls.length).toBe(2);
    expect(calls[0]!.body.response_format).toEqual({ type: "json_object" });
    expect(calls[1]!.body.response_format).toBeUndefined();
    // Refused for good: the next JSON call does not offer it again.
    await model.chat({ ...REQ, json: true });
    expect(calls[2]!.body.response_format).toBeUndefined();
  });

  test("a 400 for another reason is not retried; a provider error names the status", async () => {
    const { calls, fetch } = fakeFetch((body) => ({ status: body.stop ? 400 : 500, json: { error: "nope" } }));
    const model = new LocalModel({ baseUrl: "http://x/v1", model: "m", fetch });
    // No `json`: nothing to retry without, so one call only.
    await expect(model.chat({ ...REQ, stop: ["x"] })).rejects.toThrow("local-model 400");
    expect(calls.length).toBe(1);
    await expect(model.chat(REQ)).rejects.toThrow("local-model 500");
  });

  test("a gateway base URL's query is kept and the route is appended to the path", async () => {
    const { calls, fetch } = fakeFetch(() => ok());
    const model = new LocalModel({ baseUrl: "http://gw.example/v1?key=abc", model: "m", fetch });
    await model.chat(REQ);
    expect(calls[0]!.url).toBe("http://gw.example/v1/chat/completions?key=abc");
  });

  test("an endpoint that reports tokens but no cost is priced off this machine, $0 on it", async () => {
    const { fetch } = fakeFetch(() => ok());
    const remote = new LocalModel({ baseUrl: "http://gw.example/v1", model: "m", fetch });
    const local = new LocalModel({ baseUrl: "http://localhost:11434/v1", model: "m", fetch, freeCalls: true });
    // "m" is an unknown model, priced high on purpose (1/4 per Mtok): 10 in + 5 out -> 30e-6.
    expect((await remote.chat(REQ)).costUsd).toBeCloseTo(0.00003);
    expect((await local.chat(REQ)).costUsd).toBe(0);
  });

  test("a shared hold: a 429 holds every caller; a call while held sends nothing", async () => {
    const { calls, fetch } = fakeFetch(() => ({
      status: 429,
      json: {},
    }));
    const hold = new RateHold();
    const a = new LocalModel({ baseUrl: "http://x/v1", model: "m", fetch, rateHold: hold });
    const b = new LocalModel({ baseUrl: "http://x/v1", model: "m", fetch, rateHold: hold });
    await expect(a.chat(REQ)).rejects.toThrow("local-model 429");
    const sent = calls.length;
    await expect(b.chat(REQ)).rejects.toThrow(ModelHeldError);
    expect(calls.length).toBe(sent);
  });

  test("the caller's deadline binds the call", async () => {
    const { fetch } = fakeFetch((_body, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const model = new LocalModel({ baseUrl: "http://x/v1", model: "m", fetch, timeoutMs: 30 });
    await expect(model.chat(REQ)).rejects.toThrow();
  });
});
