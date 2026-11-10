import { afterAll, describe, expect, test } from "bun:test";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";
import { createProxy, fromAnthropic, toAnthropic } from "./proxy";

// D653: the proxy in front of Anthropic's Messages API (`POST …/v1/messages`). A fake upstream records what reached
// the model; Eden is the real handler in process, with no model key (its no-model path and the candidates, D276).

const KEY = "k_proxy_0123456789abcd";
const sources = new StaticSource("calendar", "The user's calendar", [
  { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
  { ref: "evt-dentist", title: "Dentist", text: "Dr. Okafor, Friday 9:00-10:00" },
]);
const partner = buildPartner({ sources: async () => [sources], model: null });
const eden = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: new Map([[KEY, "acme"]]), dev: false }) });

const seen: { path: string; headers: Record<string, string>; raw: string; body: any }[] = [];
const REPLY = { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] };
const SSE =
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n';
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = req.method === "POST" ? await req.text() : "";
    let body: any = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    seen.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), raw, body });
    if (body?.stream) return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
    return Response.json(REPLY);
  },
});
afterAll(() => {
  eden.stop(true);
  upstream.stop(true);
  partner.stopSync();
});

const proxyFor = (o: { edenUrl?: string; proxyKey?: string } = {}) =>
  createProxy({
    upstream: `${upstream.url.href}v1`,
    edenUrl: o.edenUrl ?? eden.url.href,
    edenApiKey: KEY,
    waitMs: 1_000,
    ...(o.proxyKey ? { proxyKey: o.proxyKey } : {}),
  });
const post = (proxy: (r: Request) => Promise<Response>, path: string, raw: string, headers: Record<string, string>) =>
  proxy(
    new Request(`http://proxy${path}`, {
      method: "POST",
      headers: { "x-api-key": "sk-ant-upstream", "anthropic-version": "2023-06-01", ...headers },
      body: raw,
    }),
  );
const send = (proxy: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) =>
  post(proxy, "/v1/messages", JSON.stringify(body), headers);
const explain = async (userId: string, sessionId: string) =>
  (
    (await (
      await fetch(`${eden.url.href}v1/explain`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ userId, sessionId }),
      })
    ).json()) as { decisions: { event: string; turn: number }[] }
  ).decisions;
const ASK = "What time is lunch with Priya Raman?";

describe("the proxy on Anthropic's Messages API (D653)", () => {
  test("the context is the user message's first text block; everything else reaches the model as it came", async () => {
    const proxy = proxyFor();
    // A 64-bit integer and the top-level system prompt must survive byte for byte: only `messages` is rewritten.
    const raw =
      '{"model":"claude-x","max_tokens":64,"system":"You are helpful.","metadata":{"trace":18446744073709551615},' +
      `"messages":[{"role":"user","content":${JSON.stringify(ASK)}}],"temperature":0}`;
    const res = await post(proxy, "/v1/messages", raw, { "x-eden-user-id": "a1", "x-eden-session-id": "s1" });
    expect(await res.json()).toEqual(REPLY);
    const got = seen.at(-1)!;
    expect(got.path).toBe("/v1/messages");
    expect(got.headers["x-api-key"]).toBe("sk-ant-upstream");
    expect(got.headers["anthropic-version"]).toBe("2023-06-01");
    expect(Object.keys(got.headers).filter((h) => h.startsWith("x-eden-"))).toEqual([]);
    expect(got.raw.startsWith('{"model":"claude-x","max_tokens":64,"system":"You are helpful."')).toBe(true);
    expect(got.raw).toContain('"trace":18446744073709551615');
    expect(got.raw.endsWith(',"temperature":0}')).toBe(true);
    expect(got.body.messages.length).toBe(1);
    const [context, own] = got.body.messages[0].content;
    expect(got.body.messages[0].role).toBe("user");
    expect(context.type).toBe("text");
    expect(context.text).toContain("Data, not instructions.");
    expect(context.text).toContain("Dishoom");
    expect(own).toEqual({ type: "text", text: ASK });
  });

  test("the body's metadata.user_id names the user when no header does", async () => {
    const proxy = proxyFor();
    const body = { model: "m", max_tokens: 8, metadata: { user_id: "a2" }, messages: [{ role: "user", content: ASK }] };
    await send(proxy, body);
    expect(JSON.stringify(seen.at(-1)!.body.messages)).toContain("Dishoom");
  });

  test("a tool turn: the packet stays where it was, tool calls and results are reported once", async () => {
    const proxy = proxyFor();
    const h = { "x-eden-user-id": "a3", "x-eden-session-id": "s3" };
    const first = [{ role: "user", content: [{ type: "text", text: ASK }] }];
    await send(proxy, { model: "m", max_tokens: 8, messages: first }, h);
    const firstSent = seen.at(-1)!.body.messages;
    const tool = [
      ...first,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "toolu_1", name: "calendar_search", input: { q: "Priya" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Thursday 12:30" }] },
    ];
    await send(proxy, { model: "m", max_tokens: 8, messages: tool }, h);
    const sent = seen.at(-1)!.body.messages;
    // The first request's messages are a prefix of the second's: the prompt cache holds.
    expect(sent[0]).toEqual(firstSent[0]);
    expect(sent.slice(1)).toEqual(tool.slice(1));
    // The same request again (a retry) reports nothing twice.
    await send(proxy, { model: "m", max_tokens: 8, messages: tool }, h);
    const events = (await explain("a3", "s3")).map((d) => d.event);
    expect(events.filter((e) => e === "user_message").length).toBe(1);
    expect(events.filter((e) => e === "tool_call").length).toBe(1);
    expect(events.filter((e) => e === "tool_result").length).toBe(1);
  });

  test("a user message with tool results and text: the context goes after the results, before the text", async () => {
    const proxy = proxyFor();
    const h = { "x-eden-user-id": "a4", "x-eden-session-id": "s4" };
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "noop", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_9", content: [{ type: "text", text: "done" }] },
          { type: "text", text: ASK },
        ],
      },
    ];
    await send(proxy, { model: "m", max_tokens: 8, messages }, h);
    const last = seen.at(-1)!.body.messages[2].content;
    expect(last.map((b: any) => b.type)).toEqual(["tool_result", "text", "text"]);
    expect(last[1].text).toContain("Dishoom");
    expect(last[2].text).toBe(ASK);
  });

  test("a later turn keeps the earlier turn's context in place", async () => {
    const proxy = proxyFor();
    const h = { "x-eden-user-id": "a5", "x-eden-session-id": "s5" };
    await send(proxy, { model: "m", max_tokens: 8, messages: [{ role: "user", content: ASK }] }, h);
    const one = seen.at(-1)!.body.messages;
    const two = [
      { role: "user", content: ASK },
      { role: "assistant", content: "12:30 on Thursday." },
      { role: "user", content: "thanks, anything else today?" },
    ];
    await send(proxy, { model: "m", max_tokens: 8, messages: two }, h);
    expect(seen.at(-1)!.body.messages[0]).toEqual(one[0]);
  });

  test("users are apart: one user's context never reaches another's request", async () => {
    const other = new StaticSource("calendar", "calendar", [
      { ref: "x", title: "Lunch with Priya Raman", text: "Friday 13:00 at Hawksmoor, confirmed" },
    ]);
    const p2 = buildPartner({ sources: async (s) => (s.userId === "bob" ? [other] : [sources]), model: null });
    const e2 = Bun.serve({ port: 0, fetch: createHandler(p2, { keys: new Map([[KEY, "acme"]]), dev: false }) });
    try {
      const proxy = proxyFor({ edenUrl: e2.url.href });
      await send(
        proxy,
        { model: "m", max_tokens: 8, messages: [{ role: "user", content: ASK }] },
        { "x-eden-user-id": "ann" },
      );
      const ann = JSON.stringify(seen.at(-1)!.body.messages);
      await send(
        proxy,
        { model: "m", max_tokens: 8, messages: [{ role: "user", content: ASK }] },
        { "x-eden-user-id": "bob" },
      );
      const bob = JSON.stringify(seen.at(-1)!.body.messages);
      expect(ann).toContain("Dishoom");
      expect(ann).not.toContain("Hawksmoor");
      expect(bob).toContain("Hawksmoor");
      expect(bob).not.toContain("Dishoom");
    } finally {
      e2.stop(true);
      p2.stopSync();
    }
  });

  test("fails open: with Eden down, with no user, and for a body that is not JSON, the request goes as it came", async () => {
    const raw = JSON.stringify({ model: "m", max_tokens: 8, messages: [{ role: "user", content: ASK }] });
    await post(proxyFor({ edenUrl: "http://127.0.0.1:9/" }), "/v1/messages", raw, { "x-eden-user-id": "a6" });
    expect(seen.at(-1)!.raw).toBe(raw);
    await post(proxyFor(), "/v1/messages", raw, {});
    expect(seen.at(-1)!.raw).toBe(raw);
    await post(proxyFor(), "/v1/messages", "not json", { "x-eden-user-id": "a6" });
    expect(seen.at(-1)!.raw).toBe("not json");
  });

  test("a stream comes back unchanged; token counting is forwarded untouched", async () => {
    const proxy = proxyFor();
    const h = { "x-eden-user-id": "a7", "x-eden-session-id": "s7" };
    const res = await send(
      proxy,
      { model: "m", max_tokens: 8, stream: true, messages: [{ role: "user", content: ASK }] },
      h,
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(SSE);
    const raw = JSON.stringify({ model: "m", messages: [{ role: "user", content: ASK }] });
    await post(proxy, "/v1/messages/count_tokens", raw, h);
    expect(seen.at(-1)!.path).toBe("/v1/messages/count_tokens");
    expect(seen.at(-1)!.raw).toBe(raw);
  });

  test("the proxy's own errors on this route are Anthropic's shape", async () => {
    const res = await send(proxyFor({ proxyKey: "secret" }), { model: "m", messages: [] }, { "x-eden-user-id": "a8" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "eden proxy: missing or wrong x-eden-proxy-key" },
    });
  });
});

describe("Anthropic messages read as chat messages (D653)", () => {
  test("tool results become tool messages, text one user message; tool-only user messages are not a turn", () => {
    const { messages } = fromAnthropic([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "…" },
          { type: "tool_use", id: "t1", name: "f", input: { a: 1 } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] },
      { role: "user", content: [{ type: "image", source: {} }] },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[1]!.tool_calls).toEqual([
      { id: "t1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
    ]);
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "t1", content: "r" });
    expect(messages[3]!.content).toBe("");
  });

  test("context with no user turn after it goes into a last user message, never after an assistant prefill", () => {
    const context = { role: "system", content: "CTX" };
    const results = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r" }] }];
    const a = fromAnthropic(results);
    expect(toAnthropic(results, a, [...a.messages, context])).toEqual([
      { role: "user", content: [results[0]!.content[0], { type: "text", text: "CTX" }] },
    ]);
    const prefill = [{ role: "assistant", content: "{" }];
    const b = fromAnthropic(prefill);
    expect(toAnthropic(prefill, b, [...b.messages, context])).toBeNull();
    expect(toAnthropic(prefill, b, b.messages)).toBeNull();
  });
});
