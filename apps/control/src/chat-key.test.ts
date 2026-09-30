import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "./store";
import { createHandler } from "./server";

/**
 * #84: on an unmanaged host the chat routes accept any `Bearer sk-…` (the two-line enable). The
 * reply must then be paid for with the caller's own key. Wrap's configured OPENAI_API_KEY and
 * ANTHROPIC_API_KEY belong to the operator, and another local account must not be able to spend
 * them by sending a made-up `sk-` string.
 */
const OPERATOR_OPENAI = "sk-operator-openai-key-0001";
const OPERATOR_ANTHROPIC = "sk-ant-operator-anthropic-0001";
const WRAP_KEY = "eden_local_chatkeytest";

const ENV = ["EDEN_DEV", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

type Seen = { path: string; authorization: string | null; apiKey: string | null };
const seen: Seen[] = [];
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = new URL(req.url).pathname;
    seen.push({ path, authorization: req.headers.get("authorization"), apiKey: req.headers.get("x-api-key") });
    if (path === "/v1/messages") {
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    return Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    });
  },
});

// A DATABASE_URL in .env would make this a managed install; EDEN_DEV=1 keeps the provider-key
// path open on both kinds of host (same pin as cors.test.ts).
process.env.EDEN_DEV = "1";
// What `eden wrap` sees when the operator started it with their own model keys.
process.env.OPENAI_API_KEY = OPERATOR_OPENAI;
process.env.ANTHROPIC_API_KEY = OPERATOR_ANTHROPIC;
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.port}`;

afterAll(() => {
  upstream.stop(true);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  seen.length = 0;
});

const handler = createHandler({
  store: new Store(":memory:"),
  token: WRAP_KEY,
  upstream: `http://127.0.0.1:${upstream.port}/v1`,
  upstreamKey: OPERATOR_OPENAI,
});

function chat(bearer: string): Promise<Response> {
  return handler(
    new Request("http://127.0.0.1:8788/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Reply with pong." }] }),
    }),
  );
}

function messages(bearer: string): Promise<Response> {
  return handler(
    new Request("http://127.0.0.1:8788/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with pong." }],
      }),
    }),
  );
}

function billedToOperator(): boolean {
  return seen.some((s) => [s.authorization, s.apiKey].some((v) => v?.includes("operator")));
}

describe("chat routes never spend the operator's model key for another caller (#84)", () => {
  test("/v1/chat/completions forwards an arbitrary sk- bearer as the caller's own key", async () => {
    const res = await chat("sk-other-account-key");
    await res.text();
    expect(seen).toEqual([
      { path: "/v1/chat/completions", authorization: "Bearer sk-other-account-key", apiKey: null },
    ]);
    expect(billedToOperator()).toBe(false);
  });

  test("/v1/messages forwards an arbitrary sk- bearer as the caller's own key", async () => {
    const res = await messages("sk-other-account-key");
    await res.text();
    expect(seen.map((s) => [s.path, s.apiKey])).toEqual([["/v1/messages", "sk-other-account-key"]]);
    expect(billedToOperator()).toBe(false);
  });

  test("the two-line enable still works: the agent keeps OPENAI_API_KEY and gets the reply", async () => {
    const res = await chat(OPERATOR_OPENAI);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(body.choices?.[0]?.message?.content).toBe("pong");
    expect(seen.map((s) => s.authorization)).toEqual([`Bearer ${OPERATOR_OPENAI}`]);
  });

  test("the wrap key still pays with wrap's own model keys", async () => {
    expect((await chat(WRAP_KEY)).status).toBe(200);
    expect((await messages(WRAP_KEY)).status).toBe(200);
    expect(seen.map((s) => [s.path, s.authorization ?? s.apiKey])).toEqual([
      ["/v1/chat/completions", `Bearer ${OPERATOR_OPENAI}`],
      ["/v1/messages", OPERATOR_ANTHROPIC],
    ]);
  });

  test("a bearer that is neither the wrap key nor a provider key reaches no upstream", async () => {
    expect((await chat("eden_dev")).status).toBe(401);
    expect((await messages("not-a-model-key")).status).toBe(401);
    expect(seen).toEqual([]);
  });
});
