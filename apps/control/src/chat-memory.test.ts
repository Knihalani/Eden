import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import * as edenMem from "../../../src/index";
import { Store } from "./store";
import { createHandler } from "./server";

/**
 * #89: memory and compiled tools belong to the operator of this wrap. A chat caller proves it is
 * the operator with the wrap key, with the model key wrap was started with (the two-line enable),
 * or with the wrap key in x-eden-api-key next to a model key of its own. Any other caller, even
 * one paying with a real key of its own, gets a plain proxy: no memory read or written, and none
 * of the operator's compiled tools.
 */
const OPERATOR_OPENAI = "sk-operator-openai-key-0089";
const OPERATOR_ANTHROPIC = "sk-ant-operator-anthropic-0089";
const WRAP_KEY = "eden_local_chatmemorytest";
const STRANGER = "sk-other-account-key-0089";
const FAKE = "sk-made-up-key-0089";

const ENV = ["EDEN_DEV", "EDEN_SURFACE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

type Seen = { path: string; key: string | null; tools: string[] };
const seen: Seen[] = [];
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const key = req.headers.get("x-api-key") ?? req.headers.get("authorization");
    const body = (await req.json()) as { tools?: Array<{ name?: string; function?: { name?: string } }> };
    seen.push({ path, key, tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name ?? "") });
    if (key?.includes(FAKE)) return Response.json({ error: { message: "invalid api key" } }, { status: 401 });
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

process.env.EDEN_DEV = "1";
// Every live program is offered, not only the JIT pick, so a leaked tool would show.
process.env.EDEN_SURFACE = "all";
process.env.OPENAI_API_KEY = OPERATOR_OPENAI;
process.env.ANTHROPIC_API_KEY = OPERATOR_ANTHROPIC;
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.port}`;

// Counts reads and writes of the process memory store; the real one still runs.
const memory = spyOn(edenMem, "processMemory");

afterAll(() => {
  memory.mockRestore();
  upstream.stop(true);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  seen.length = 0;
  memory.mockClear();
});

/** One of the operator's compiled tools, live in the store. */
function operatorTool(): StretchProgram {
  return {
    id: "p_operator",
    version: "1",
    name: "search_to_notify",
    description: "",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    sequence: ["search", "write", "notify"],
    steps: [],
    returns: { kind: "literal", value: null },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: true, envelope: { inputs: { q: ["test"] } } },
    manifest: {
      name: "search_to_notify",
      llmReduction: 5,
      latencyReduction: 5,
      costReduction: 5,
      skipRateBefore: 0.2,
      skipRateAfter: 0,
      nShadow: 6,
    },
  } as unknown as StretchProgram;
}

const store = new Store(":memory:");
store.livePrograms = () => [operatorTool()];

const handler = createHandler({
  store,
  token: WRAP_KEY,
  upstream: `http://127.0.0.1:${upstream.port}/v1`,
  upstreamKey: OPERATOR_OPENAI,
});

function chat(bearer: string, opts: { stream?: boolean; edenKey?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
  if (opts.edenKey) headers["x-eden-api-key"] = opts.edenKey;
  return handler(
    new Request("http://127.0.0.1:8788/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-4o",
        stream: Boolean(opts.stream),
        messages: [{ role: "user", content: "We use sqlite for the session store. Search for test." }],
        tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
      }),
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
        messages: [{ role: "user", content: "We use sqlite for the session store. Search for test." }],
        tools: [{ name: "search", input_schema: { type: "object" } }],
      }),
    }),
  );
}

describe("only the wrap's operator gets its memory and compiled tools (#89)", () => {
  test("a caller paying with its own key gets a plain proxy, plain and streaming", async () => {
    await (await chat(STRANGER)).text();
    await (await chat(STRANGER, { stream: true })).text();
    expect(memory).not.toHaveBeenCalled();
    expect(seen.map((s) => [s.key, s.tools])).toEqual([
      [`Bearer ${STRANGER}`, ["search"]],
      [`Bearer ${STRANGER}`, ["search"]],
    ]);
  });

  test("a made-up sk- key writes nothing before its upstream call fails", async () => {
    expect((await chat(FAKE)).status).toBe(401);
    expect(memory).not.toHaveBeenCalled();
  });

  test("/v1/messages: a caller paying with its own key gets a plain proxy", async () => {
    expect((await messages(STRANGER)).status).toBe(200);
    expect(memory).not.toHaveBeenCalled();
    expect(seen.map((s) => [s.key, s.tools])).toEqual([[STRANGER, ["search"]]]);
  });

  test("a caller paying with its own key leaves nothing in the operator's next trace", async () => {
    await (await chat(STRANGER)).text();
    await (await chat(STRANGER, { stream: true })).text();
    await (await messages(STRANGER)).text();
    // Wrap stamps the next trace the operator records with the chat output and usage it has seen.
    const trace = { id: "t-operator-89", events: [{ tool: "search", args: { q: "test" } }], llmCalls: 0 };
    const posted = await handler(
      new Request("http://127.0.0.1:8788/v1/traces", {
        method: "POST",
        headers: { authorization: `Bearer ${WRAP_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ traces: [trace] }),
      }),
    );
    expect(posted.status).toBe(200);
    const stored = store.traces().find((t) => t.id === trace.id);
    expect(stored).toBeDefined();
    expect([stored!.output, stored!.llmCalls, stored!.prompt_tokens]).toEqual([undefined, 0, undefined]);
  });

  test("a wrong x-eden-api-key proves nothing", async () => {
    await (await chat(STRANGER, { edenKey: "eden_local_guess" })).text();
    expect(memory).not.toHaveBeenCalled();
    expect(seen.map((s) => s.tools)).toEqual([["search"]]);
  });

  test("the wrap key is the operator: memory and the compiled tool, on wrap's model key", async () => {
    expect((await chat(WRAP_KEY)).status).toBe(200);
    expect(memory).toHaveBeenCalled();
    expect(seen.map((s) => [s.key, s.tools])).toEqual([[`Bearer ${OPERATOR_OPENAI}`, ["search_to_notify", "search"]]]);
  });

  test("the two-line enable is the operator: the agent's key is the one wrap was started with", async () => {
    expect((await chat(OPERATOR_OPENAI)).status).toBe(200);
    expect(memory).toHaveBeenCalled();
    expect(seen.map((s) => s.tools)).toEqual([["search_to_notify", "search"]]);
  });

  test("the wrap key in x-eden-api-key makes a caller with its own model key the operator", async () => {
    expect((await chat(STRANGER, { edenKey: WRAP_KEY })).status).toBe(200);
    expect(memory).toHaveBeenCalled();
    expect(seen.map((s) => [s.key, s.tools])).toEqual([[`Bearer ${STRANGER}`, ["search_to_notify", "search"]]]);
  });

  test("/v1/messages: the wrap key and the Anthropic key wrap was started with are the operator", async () => {
    expect((await messages(WRAP_KEY)).status).toBe(200);
    expect((await messages(OPERATOR_ANTHROPIC)).status).toBe(200);
    expect(memory).toHaveBeenCalledTimes(2);
    expect(seen.map((s) => s.tools)).toEqual([
      ["search_to_notify", "search"],
      ["search_to_notify", "search"],
    ]);
  });
});
