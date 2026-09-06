import { describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import {
  anthropicMessageToSse,
  handleAnthropicMessages,
  steerAnthropicToolUses,
  applyCacheBreakpoints
} from "./anthropic";
import { createState } from "./wrap-tools";

function liveProgram(): StretchProgram {
  return {
    id: "p_test",
    version: "1",
    name: "search_to_notify",
    description: "",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    sequence: ["search", "write", "notify"],
    steps: [],
    returns: { kind: "literal", value: null },
    contract: {
      witnesses: 3,
      minLlmReduction: 2,
      allowExact: true,
      envelope: { inputs: { q: ["test", "other"] } },
    },
    manifest: { name: "search_to_notify", llmReduction: 5, latencyReduction: 5, costReduction: 5, skipRateBefore: 0.2, skipRateAfter: 0, nShadow: 6 },
  } as unknown as StretchProgram;
}

describe("anthropic steering (block-level)", () => {
  test("head block is replaced by the compiled tool; absorbed siblings are REMOVED", () => {
    const content = [
      { type: "text", text: "Working." },
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "test" } },
      { type: "tool_use", id: "tu_2", name: "write", input: {} },
      { type: "tool_use", id: "tu_3", name: "notify", input: {} },
    ];
    const out = steerAnthropicToolUses(content, [liveProgram()]);
    const tools = out.filter((b) => b.type === "tool_use");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.id).toBe("tu_1");
    expect(tools[0]!.name).toBe("search_to_notify");
  });

  test("unrelated siblings survive, and a removed sibling never shifts replacements (H1 regression)", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "test" } },
      { type: "tool_use", id: "tu_2", name: "write", input: {} },
      { type: "tool_use", id: "tu_9", name: "web_search", input: { query: "x" } },
    ];
    const out = steerAnthropicToolUses(content, [liveProgram()]);
    const byId = new Map(out.map((b) => [b.id ?? "", b]));
    expect(byId.get("tu_1")?.name).toBe("search_to_notify");
    expect(byId.has("tu_2")).toBe(false); // absorbed
    expect(byId.get("tu_9")?.name).toBe("web_search"); // unrelated work survives
    expect(byId.get("tu_9")?.input).toEqual({ query: "x" }); // untouched inputs
  });

  test("no match leaves every block untouched", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "out-of-envelope" } },
    ];
    const out = steerAnthropicToolUses(content, [liveProgram()]);
    expect(out[0]!.name).toBe("search");
  });
});

function sseResponseHandler(msg: unknown, status = 200) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    void init;
    return new Response(typeof msg === "string" ? msg : JSON.stringify(msg), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function toolUseMsg(): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4",
    content: [
      { type: "text", text: "Searching." },
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "test" } },
      { type: "tool_use", id: "tu_2", name: "write", input: {} },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 21, output_tokens: 7 },
  };
}

async function callHandler(body: object, fetchImpl?: typeof fetch, env?: Record<string, string>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await handleAnthropicMessages(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-test" },
        body: JSON.stringify(body),
      }),
      {
        state: createState({ programs: [liveProgram()], fetch: undefined }),
        getPrograms: () => [liveProgram()],
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      },
    );
  } finally {
    // no env mutation to undo — kept symmetric with callers that pass env
  }
}

describe("anthropic handler", () => {
  test("steers tool_use, removes absorbed siblings, records provider usage", async () => {
    const state = createState({ programs: [liveProgram()] });
    const res = await handleAnthropicMessages(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k" },
        body: JSON.stringify({ model: "m", max_tokens: 10, messages: [], tools: [{ name: "search", input_schema: {} }] }),
      }),
      {
        state,
        getPrograms: () => [liveProgram()],
        fetch: sseResponseHandler(toolUseMsg()),
      },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: Array<{ type: string; name?: string }> };
    const tools = json.content.filter((b) => b.type === "tool_use");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("search_to_notify");
    expect(state.run.llmCalls).toBe(1);
    expect(state.run.measured).toBe(true);
    expect(state.run.prompt_tokens).toBe(21);
  });

  test("streaming client with tools receives valid Anthropic SSE with steered blocks", async () => {
    const res = await callHandler(
      { model: "m", max_tokens: 10, stream: true, messages: [], tools: [{ name: "search", input_schema: {} }] },
      sseResponseHandler(toolUseMsg()),
    );
    expect(res.headers.get("content-type") || "").toContain("text/event-stream");
    const text = await res.text();
    for (const event of ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]) {
      expect(text).toContain(`event: ${event}`);
    }
    expect(text).toContain('"stop_reason":"tool_use"');
    // The steered compiled name appears; the absorbed raw sibling does not.
    expect(text).toContain("search_to_notify");
    expect(text).not.toContain("tu_2");
  });

  test("upstream error bodies pass through VERBATIM with their status", async () => {
    const html = "<html>502 from provider</html>";
    const res = await callHandler(
      { model: "m", max_tokens: 10, messages: [] },
      sseResponseHandler(html, 502),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(html);
  });

  test("non-JSON success bodies pass through verbatim", async () => {
    const weird = "not-json-but-upstream-said-so";
    const res = await callHandler({ model: "m", max_tokens: 10, messages: [] }, sseResponseHandler(weird, 200));
    expect(await res.text()).toBe(weird);
  });

  test("tripped kill switch degrades to unsteered passthrough, never a 409", async () => {
    const state = createState({ programs: [liveProgram()], killAfterWarning: true });
    state.run.firstWarningAt = 1;
    const res = await handleAnthropicMessages(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k" },
        body: JSON.stringify({ model: "m", max_tokens: 10, messages: [], tools: [{ name: "search", input_schema: {} }] }),
      }),
      { state, getPrograms: () => [liveProgram()], fetch: sseResponseHandler(toolUseMsg()) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: Array<{ type: string; name?: string }> };
    const tools = json.content.filter((b) => b.type === "tool_use");
    // Unsteered: the model's original tool choices go to the client untouched.
    expect(tools.map((t) => t.name)).toEqual(["search", "write"]);
  });

  test("SSE re-framing carries the full message shape for text-only replies", async () => {
    const msg = {
      id: "msg_x",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "text", text: "Hello." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 },
    };
    const sse = anthropicMessageToSse(msg);
    expect(sse).toContain("event: message_start");
    expect(sse).toContain('"text":"Hello."');
    expect(sse).toContain('"stop_reason":"end_turn"');
    expect(sse.trim().endsWith("data: {\"type\":\"message_stop\"}")).toBe(true);
  });
});

describe("prompt-cache breakpoints (W20)", () => {
  test("string system converts to a cached block; last tool and last message get breakpoints", () => {
    const body: any = {
      model: "claude",
      system: "be brief",
      tools: [{ name: "a", input_schema: {} }, { name: "b", input_schema: {} }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    };
    applyCacheBreakpoints(body);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toBeUndefined();
    const lastMsg = body.messages[1];
    expect(lastMsg.content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("array system marks only the final block; string message content is upgraded safely", () => {
    const body: any = {
      system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      messages: [{ role: "user", content: "one line" }],
    };
    applyCacheBreakpoints(body);
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.system[1].cache_control).toBeDefined();
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    expect(body.messages[0].content[0].text).toBe("one line");
    expect(body.messages[0].content[0].cache_control).toBeDefined();
  });

  test("opt-out env disables everything", () => {
    process.env.EDEN_PROMPT_CACHE = "0";
    const body: any = { system: "s", tools: [{ name: "t", input_schema: {} }], messages: [] };
    applyCacheBreakpoints(body);
    expect(typeof body.system).toBe("string");
    delete process.env.EDEN_PROMPT_CACHE;
  });

  test("cache-guard moves a timestamp block after stable and breakpoints the stable prefix", () => {
    process.env.EDEN_CACHE_GUARD = "1";
    const body: any = {
      system: [
        { type: "text", text: "session 2026-08-27T11:00:00Z" },
        { type: "text", text: "You are a coding assistant." },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    applyCacheBreakpoints(body);
    expect(body.system[0].text).toBe("You are a coding assistant.");
    expect(body.system[1].text).toMatch(/2026-08-27T11:00:00Z/);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[1].cache_control).toBeUndefined();
    delete process.env.EDEN_CACHE_GUARD;
  });

  test("cache-guard is a no-op when EDEN_PROMPT_CACHE=0", () => {
    process.env.EDEN_CACHE_GUARD = "1";
    process.env.EDEN_PROMPT_CACHE = "0";
    const body: any = {
      system: [
        { type: "text", text: "session 2026-08-27T11:00:00Z" },
        { type: "text", text: "stable" },
      ],
    };
    applyCacheBreakpoints(body);
    expect(body.system[0].text).toMatch(/2026-08-27T11:00:00Z/);
    expect(body.system[0].cache_control).toBeUndefined();
    delete process.env.EDEN_CACHE_GUARD;
    delete process.env.EDEN_PROMPT_CACHE;
  });
});
