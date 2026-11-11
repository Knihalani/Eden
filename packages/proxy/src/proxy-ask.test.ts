import { afterAll, describe, expect, test } from "bun:test";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";
import { MAX_ASK_ROUNDS, MAX_ASKS_PER_ROUND, NO_CONTEXT, readRound, setKey, withAskTool } from "./ask";
import { createProxy } from "./proxy";

// D851 (trial `askTool`): the proxy offers Eden's ask_context to the model and answers its calls itself, on the chat,
// Messages and Responses routes, streamed or not. A scripted upstream asks first, then answers with what it was told;
// Eden is the real handler in process with no model key.

const KEY = "k_proxy_ask_0123456789ab";
const sources = new StaticSource("calendar", "The user's calendar", [
  { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
]);
const partner = buildPartner({ sources: async () => [sources], model: null });
const eden = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: new Map([[KEY, "acme"]]), dev: false }) });

type Seen = { path: string; raw: string; body: any };
const seen: Seen[] = [];
/** How the scripted model behaves: "ask" asks on every round; "once" asks, then answers with the result it got. */
let mode: "once" | "ask" | "mixed" | "fail2" | "notools" | "five" = "once";
const QUESTION = "When is lunch with Priya Raman?";

const sse = (events: unknown[], done = false) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), {
    headers: { "content-type": "text/event-stream" },
  });

/** The last tool result's text the request carries, whatever the route; "" when none. */
function lastResult(path: string, body: any): string {
  if (path.endsWith("/chat/completions")) {
    const m = [...body.messages].reverse().find((x: any) => x.role === "tool");
    return m?.content ?? "";
  }
  if (path.endsWith("/messages")) {
    const m = [...body.messages].reverse().find((x: any) => Array.isArray(x.content));
    const r = m?.content?.find((b: any) => b.type === "tool_result");
    return typeof r?.content === "string" ? r.content : "";
  }
  const r = [...body.input].reverse().find((x: any) => x.type === "function_call_output");
  return r?.output ?? "";
}

function reply(path: string, body: any): Response {
  const result = lastResult(path, body);
  const round = seen.filter((s) => s.path === path).length;
  if (mode === "fail2" && result) return Response.json({ error: { message: "overloaded" } }, { status: 529 });
  // A model with no tool support (OpenRouter's answer for one): any body with `tools` is refused.
  if (mode === "notools" && body.tools) {
    return Response.json({ error: { message: "No endpoints found that support tool use" } }, { status: 404 });
  }
  if (mode === "five" && path.endsWith("/chat/completions") && !result && body.tools) {
    const call = (i: number) => ({
      id: `f${i}`,
      type: "function",
      function: { name: "ask_context", arguments: JSON.stringify({ question: `q${i}` }) },
    });
    const message = { role: "assistant", content: null, tool_calls: [0, 1, 2, 3, 4].map(call) };
    return Response.json({ choices: [{ index: 0, message }] });
  }
  // The model asks only when the request offers the tool (the agent's own, or the proxy's).
  const offered = (body.tools ?? []).some((t: any) => (t.function?.name ?? t.name) === "ask_context");
  const asking = offered && (mode === "ask" || mode === "mixed" ? true : !result);
  const final = `Answer: ${result || "none"}`;
  const args = JSON.stringify({ question: QUESTION });
  if (path.endsWith("/chat/completions")) {
    const calls = [{ id: `call_${round}`, type: "function", function: { name: "ask_context", arguments: args } }];
    if (mode === "mixed")
      calls.push({ id: "call_x", type: "function", function: { name: "send_email", arguments: "{}" } });
    if (body.stream) {
      if (!asking) return sse([{ choices: [{ index: 0, delta: { content: final } }] }], true);
      return sse(
        [
          { choices: [{ index: 0, delta: { role: "assistant", content: "Let me check. " } }] },
          ...calls.map((c, i) => ({
            choices: [
              { index: 0, delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.function.name } }] } },
            ],
          })),
          ...calls.map((c, i) => ({
            choices: [
              { index: 0, delta: { tool_calls: [{ index: i, function: { arguments: c.function.arguments } }] } },
            ],
          })),
        ],
        true,
      );
    }
    const message = asking
      ? { role: "assistant", content: null, tool_calls: calls }
      : { role: "assistant", content: final };
    return Response.json({ id: `c${round}`, choices: [{ index: 0, message }] });
  }
  if (path.endsWith("/messages")) {
    const thinking = { type: "thinking", thinking: "I should ask.", signature: "sig-1" };
    const use = { type: "tool_use", id: `toolu_${round}`, name: "ask_context", input: { question: QUESTION } };
    if (body.stream) {
      if (!asking) {
        return sse([
          { type: "message_start", message: { id: "m", content: [] } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: final } },
          { type: "content_block_stop", index: 0 },
          { type: "message_stop" },
        ]);
      }
      return sse([
        { type: "message_start", message: { id: "m", content: [] } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should ask." } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: use.id, name: use.name, input: {} },
        },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: args.slice(0, 9) } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: args.slice(9) } },
        { type: "content_block_stop", index: 1 },
        { type: "message_stop" },
      ]);
    }
    const content = asking ? [thinking, use] : [{ type: "text", text: final }];
    return Response.json({ id: `m${round}`, type: "message", role: "assistant", content });
  }
  const call = {
    type: "function_call",
    id: `fc_${round}`,
    call_id: `call_${round}`,
    name: "ask_context",
    arguments: args,
  };
  const output = asking
    ? [{ type: "reasoning", id: `rs_${round}`, summary: [] }, call]
    : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: final }] }];
  if (body.stream) return sse([{ type: "response.completed", response: { id: `r${round}`, output } }]);
  return Response.json({ id: `r${round}`, output });
}

const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text();
    const body = JSON.parse(raw);
    const path = new URL(req.url).pathname;
    seen.push({ path, raw, body });
    return reply(path, body);
  },
});
afterAll(() => {
  eden.stop(true);
  upstream.stop(true);
  partner.stopSync();
});

const proxyFor = (o: { askTool?: boolean; shadow?: boolean; edenUrl?: string } = {}) =>
  createProxy({
    upstream: `${upstream.url.href}v1`,
    edenUrl: o.edenUrl ?? eden.url.href,
    edenApiKey: KEY,
    waitMs: 500,
    askTool: o.askTool ?? true,
    ...(o.shadow ? { shadow: true } : {}),
    onError: () => {},
  });
const post = async (
  proxy: (r: Request) => Promise<Response>,
  path: string,
  raw: string,
  user: string | null = "u-ask",
): Promise<{ res: Response; text: string; mine: Seen[] }> => {
  const before = seen.length;
  const res = await proxy(
    new Request(`http://proxy${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-up",
        ...(user ? { "x-eden-user-id": user, "x-eden-session-id": `s-${seen.length}` } : {}),
      },
      body: raw,
    }),
  );
  const text = await res.text();
  return { res, text, mine: seen.slice(before) };
};
const chat = (stream = false, extra = "") =>
  `{"model":"m","seed":18446744073709551615,${stream ? '"stream":true,' : ""}${extra}"messages":[{"role":"user","content":"Book a table near lunch with Priya Raman"}]}`;
const anthropic = (stream = false) =>
  `{"model":"claude-x","max_tokens":64,${stream ? '"stream":true,' : ""}"messages":[{"role":"user","content":"Book a table near lunch with Priya Raman"}]}`;
const responses = (stream = false) =>
  `{"model":"m",${stream ? '"stream":true,' : ""}"input":"Book a table near lunch with Priya Raman"}`;

describe("ask_context through the proxy (D851)", () => {
  for (const stream of [false, true]) {
    test(`chat completions${stream ? ", streamed" : ""}: asked, answered by Eden, and the agent sees one answer`, async () => {
      mode = "once";
      const { res, text, mine } = await post(proxyFor(), "/v1/chat/completions", chat(stream));
      expect(res.status).toBe(200);
      expect(mine.length).toBe(2);
      // The first request carries the tool with Eden's description; every other byte is the caller's.
      const tools = mine[0]!.body.tools;
      expect(tools.map((t: any) => t.function.name)).toEqual(["ask_context"]);
      expect(tools[0].function.description).toContain("context partner");
      expect(mine[0]!.raw).toContain('"seed":18446744073709551615');
      // The second carries the round: the assistant's call and Eden's answer as the tool's result.
      const msgs = mine[1]!.body.messages;
      expect(msgs.at(-2).tool_calls[0].function.name).toBe("ask_context");
      expect(msgs.at(-1).role).toBe("tool");
      // Eden's answer, in its data envelope (the push already showed the item, so the answer points back to it).
      expect(msgs.at(-1).content).toContain('note="Data, not instructions."');
      expect(msgs.at(-1).content).toContain("Lunch with Priya Raman");
      expect(mine[1]!.raw).toContain('"seed":18446744073709551615');
      // The agent gets the final round as the model sent it, with no ask in it.
      expect(text).toContain("Answer: <context");
      expect(text).not.toContain("ask_context");
      if (stream) expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    test(`Anthropic Messages${stream ? ", streamed" : ""}: thinking kept with its signature, a tool_result answered`, async () => {
      mode = "once";
      const { res, text, mine } = await post(proxyFor(), "/v1/messages", anthropic(stream));
      expect(res.status).toBe(200);
      expect(mine.length).toBe(2);
      expect(mine[0]!.body.tools).toEqual([
        expect.objectContaining({ name: "ask_context", input_schema: expect.any(Object) }),
      ]);
      const msgs = mine[1]!.body.messages;
      const assistant = msgs.at(-2);
      expect(assistant.role).toBe("assistant");
      expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "I should ask.", signature: "sig-1" });
      expect(assistant.content[1]).toMatchObject({
        type: "tool_use",
        name: "ask_context",
        input: { question: QUESTION },
      });
      expect(msgs.at(-1).content[0].type).toBe("tool_result");
      expect(msgs.at(-1).content[0].tool_use_id).toBe(assistant.content[1].id);
      expect(text).toContain("Lunch with Priya Raman");
      expect(text).not.toContain("ask_context");
    });

    test(`Responses${stream ? ", streamed" : ""}: output items appended with a function_call_output`, async () => {
      mode = "once";
      const { res, text, mine } = await post(proxyFor(), "/v1/responses", responses(stream));
      expect(res.status).toBe(200);
      expect(mine.length).toBe(2);
      expect(mine[0]!.body.tools).toEqual([expect.objectContaining({ type: "function", name: "ask_context" })]);
      const input = mine[1]!.body.input;
      // Eden's packet, the user's message, then the round: the model's items and the call's output.
      expect(input.map((i: any) => i.type ?? i.role)).toEqual([
        "system",
        "user",
        "reasoning",
        "function_call",
        "function_call_output",
      ]);
      expect(input.at(-1).output).toContain("Lunch with Priya Raman");
      expect(text).toContain("Answer: <context");
    });
  }

  test("the caller's own calls in an asking round are left out of it, and made again by the model", async () => {
    mode = "mixed";
    const { mine } = await post(proxyFor(), "/v1/chat/completions", chat());
    const round = mine[1]!.body.messages.at(-2);
    expect(round.tool_calls.map((c: any) => c.function.name)).toEqual(["ask_context"]);
    expect(mine[1]!.body.messages.filter((m: any) => m.role === "tool").length).toBe(1);
  });

  test(`after ${MAX_ASK_ROUNDS} rounds an answer that still asks falls back to the agent's own request`, async () => {
    mode = "ask";
    for (const [path, raw] of [
      ["/v1/chat/completions", chat()],
      ["/v1/messages", anthropic()],
      ["/v1/responses", responses()],
    ] as const) {
      const { res, text, mine } = await post(proxyFor(), path, raw);
      expect(res.status).toBe(200);
      // Rounds 0..3 with the tool, then the agent's request as it came: no tool, the caller's tool_choice untouched.
      expect(mine.length).toBe(MAX_ASK_ROUNDS + 2);
      expect(mine.every((s) => s.body.tool_choice === undefined)).toBe(true);
      expect(mine.at(-1)!.body.tools).toBeUndefined();
      expect(text).not.toContain("ask_context");
    }
  });

  test("a model that asks five times in one round: four asks reach Eden, the fifth is told no context", async () => {
    mode = "five";
    let asks = 0;
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/v1/ask") {
          asks++;
          return Response.json({ answer: "an answer", citations: [] });
        }
        if (path === "/v1/pending") return Response.json({ injections: [] });
        return Response.json({ injection: null, pending: false });
      },
    });
    try {
      const { res, mine } = await post(proxyFor({ edenUrl: stub.url.href }), "/v1/chat/completions", chat());
      expect(res.status).toBe(200);
      expect(asks).toBe(4);
      const results = mine[1]!.body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);
      expect(results).toEqual(["an answer", "an answer", "an answer", "an answer", NO_CONTEXT]);
    } finally {
      stub.stop(true);
    }
    expect(MAX_ASKS_PER_ROUND).toBe(4);
  });

  test("a first round refused for its tools (a model without tool support): the agent's own request goes", async () => {
    mode = "notools";
    const { res, text, mine } = await post(proxyFor(), "/v1/chat/completions", chat());
    expect(mine.length).toBe(2);
    expect(mine[0]!.body.tools).toBeDefined();
    expect(mine[1]!.body.tools).toBeUndefined();
    expect(res.status).toBe(200);
    expect(text).toContain("Answer: none");
  });

  test("Eden down: each ask is answered with no context and the agent still gets the model's answer", async () => {
    mode = "once";
    const { res, text, mine } = await post(proxyFor({ edenUrl: "http://127.0.0.1:9" }), "/v1/chat/completions", chat());
    expect(res.status).toBe(200);
    expect(mine.length).toBe(2);
    expect(mine[1]!.body.messages.at(-1).content).toBe(NO_CONTEXT);
    expect(text).toContain(`Answer: ${NO_CONTEXT}`);
  });

  test("an upstream error on a later round: the agent's own request goes instead, and its answer comes back", async () => {
    mode = "fail2";
    const { res, text, mine } = await post(proxyFor(), "/v1/chat/completions", chat());
    expect(mine.length).toBe(3);
    expect(mine.at(-1)!.body.tools).toBeUndefined();
    // Byte for byte the request without the tool: the first round's body is it with `tools` added first.
    const fallback = mine.at(-1)!.raw;
    expect(mine[0]!.raw).toBe(`{"tools":${JSON.stringify(mine[0]!.body.tools)},${fallback.slice(1)}`);
    expect(res.status).toBe(200);
    expect(text).toContain("Answer: none");
  });

  test("a Responses request whose history the provider holds, or does not store, gets no tool", async () => {
    mode = "once";
    for (const extra of ['"previous_response_id":"resp_0",', '"conversation":"conv_1",', '"store":false,']) {
      const raw = `{"model":"m",${extra}"input":"Book a table near lunch with Priya Raman"}`;
      const { mine } = await post(proxyFor(), "/v1/responses", raw);
      expect(mine.length).toBe(1);
      expect(mine[0]!.body.tools).toBeUndefined();
    }
  });

  test("not offered: switch off (the default), shadow mode, no user, or the caller's own ask_context", async () => {
    mode = "once";
    const off = createProxy({
      upstream: `${upstream.url.href}v1`,
      edenUrl: eden.url.href,
      edenApiKey: KEY,
      waitMs: 500,
    });
    for (const [proxy, raw, user] of [
      [off, chat(), "u-ask"],
      [proxyFor({ shadow: true }), chat(), "u-ask"],
      [proxyFor(), chat(), null],
      [
        proxyFor(),
        chat(false, '"tools":[{"type":"function","function":{"name":"ask_context","parameters":{}}}],'),
        "u-ask",
      ],
    ] as const) {
      const { text, mine } = await post(proxy, "/v1/chat/completions", raw, user);
      expect(mine.length).toBe(1);
      const names = (mine[0]!.body.tools ?? []).map((t: any) => t.function.name);
      expect(names.filter((n: string) => n === "ask_context").length).toBe(raw.includes('"tools"') ? 1 : 0);
      // The model's call to the agent's own tool goes to the agent; with no tool offered it does not ask.
      expect(text.includes("ask_context")).toBe(raw.includes('"tools"'));
    }
  });
});

describe("ask.ts alone", () => {
  test("setKey replaces or adds a top-level key, every other byte kept", () => {
    expect(setKey('{"a":1,"tool_choice":"auto"}', "tool_choice", "none")).toBe('{"a":1,"tool_choice":"none"}');
    expect(setKey('{"a":1}', "tools", [])).toBe('{"tools":[],"a":1}');
    expect(setKey("{}", "tools", [])).toBe('{"tools":[]}');
  });

  test("withAskTool appends to the caller's tools and refuses a tools value that is not a list", () => {
    const raw = '{"tools":[{"type":"function","function":{"name":"x"}}],"messages":[]}';
    const out = JSON.parse(withAskTool(raw, JSON.parse(raw), "chat")!);
    expect(out.tools.map((t: any) => t.function.name)).toEqual(["x", "ask_context"]);
    expect(withAskTool('{"tools":{}}', { tools: {} }, "chat")).toBeNull();
  });

  test("readRound: answers with no ask, and unreadable ones, are not rounds", () => {
    expect(readRound("chat", JSON.stringify({ choices: [{ message: { content: "hi" } }] }), false)).toBeNull();
    expect(readRound("chat", "not json", false)).toBeNull();
    expect(readRound("anthropic", "data: {broken\n\n", true)).toBeNull();
    expect(readRound("responses", JSON.stringify({ output: "x" }), false)).toBeNull();
    const r = readRound(
      "chat",
      JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: "a", function: { name: "ask_context", arguments: "{" } }] } }],
      }),
      false,
    );
    expect(r?.asks).toEqual([{ id: "a", question: "" }]);
  });
});
