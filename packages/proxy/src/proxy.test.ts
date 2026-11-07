import { afterAll, describe, expect, test } from "bun:test";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";
import { createProxy, eventsOf } from "./proxy";

// D280: Eden as an OpenAI-compatible proxy. A fake upstream records what reached the model; Eden is the real handler
// in process (no model key: its no-model path and the candidates, D276).

const KEY = "k_proxy_0123456789abcd";
const sources = new StaticSource("calendar", "The user's calendar", [
  { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
  { ref: "evt-dentist", title: "Dentist", text: "Dr. Okafor, Friday 9:00-10:00" },
]);
const partner = buildPartner({ sources: async () => [sources], model: null });
const eden = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: new Map([[KEY, "acme"]]), dev: false }) });

const seen: { path: string; auth: string | null; body: any; edenHeaders: string[] }[] = [];
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const text = req.method === "POST" ? await req.text() : "";
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    seen.push({
      path: url.pathname,
      auth: req.headers.get("authorization"),
      body,
      edenHeaders: [...req.headers.keys()].filter((h) => h.startsWith("x-eden-")),
    });
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "m" }] });
    if (body?.stream) {
      const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  },
});
afterAll(() => {
  eden.stop(true);
  upstream.stop(true);
  partner.stopSync();
});

const proxyFor = (edenUrl = eden.url.href, onError?: (e: unknown) => void) =>
  createProxy({
    upstream: `${upstream.url.href}v1`,
    edenUrl,
    edenApiKey: KEY,
    waitMs: 1_000,
    ...(onError ? { onError } : {}),
  });
const chat = (proxy: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) =>
  proxy(
    new Request("http://proxy/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-upstream", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
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

describe("the proxy (D280)", () => {
  test("injects Eden's context before the latest user message and forwards the rest unchanged", async () => {
    const proxy = proxyFor();
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What time is lunch with Priya Raman?" },
    ];
    const res = await chat(
      proxy,
      { model: "m", messages, temperature: 0 },
      { "x-eden-user-id": "u1", "x-eden-session-id": "s1" },
    );
    expect(await res.json()).toEqual({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    const got = seen.at(-1)!;
    expect(got.path).toBe("/v1/chat/completions");
    expect(got.auth).toBe("Bearer sk-upstream");
    expect(got.edenHeaders).toEqual([]);
    expect(got.body.temperature).toBe(0);
    expect(got.body.messages.map((m: any) => m.role)).toEqual(["system", "system", "user"]);
    expect(got.body.messages[1].content).toContain("Data, not instructions.");
    expect(got.body.messages[1].content).toContain("Dishoom");
  });

  test("each message is reported once; the turn's packet stays through its tool calls; tool events are reported", async () => {
    const proxy = proxyFor();
    const h = { "x-eden-user-id": "u2", "x-eden-session-id": "s2" };
    const turn = [{ role: "user", content: "What time is lunch with Priya Raman?" }];
    await chat(proxy, { model: "m", messages: turn }, h);
    const withTool = [
      ...turn,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "calendar.search", arguments: '{"q":"Priya"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "Lunch with Priya Raman: Thursday 12:30" },
    ];
    await chat(proxy, { model: "m", messages: withTool }, h);
    const second = seen.at(-1)!.body.messages;
    // The packet is still there for the turn's second model call, before the user message.
    expect(second.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    const events = (await explain("u2", "s2")).map((d) => d.event);
    expect(events.filter((e) => e === "user_message").length).toBe(1);
    expect(events).toContain("tool_call");
    expect(events).toContain("tool_result");
  });

  test("a conversation without a session header is keyed by its opening, stable as it grows", async () => {
    const proxy = proxyFor();
    const first = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What time is lunch with Priya Raman?" },
    ];
    await chat(proxy, { model: "m", messages: first, user: "u3" });
    await chat(proxy, {
      model: "m",
      user: "u3",
      messages: [...first, { role: "assistant", content: "12:30." }, { role: "user", content: "thanks" }],
    });
    expect(seen.at(-1)!.body.user).toBe("u3");
  });

  test("streams pass through; other routes are forwarded", async () => {
    const proxy = proxyFor();
    const res = await chat(proxy, {
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      user: "u4",
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("data: [DONE]");
    const models = await proxy(
      new Request("http://proxy/v1/models", { headers: { authorization: "Bearer sk-upstream" } }),
    );
    expect(await models.json()).toEqual({ data: [{ id: "m" }] });
  });

  test("fails open: with Eden down, or no user id, the request goes upstream as it came", async () => {
    const errors: unknown[] = [];
    const down = proxyFor("http://127.0.0.1:9", (e) => errors.push(e));
    const body = { model: "m", messages: [{ role: "user", content: "What time is lunch with Priya Raman?" }] };
    const res = await chat(down, { ...body, user: "u5" });
    expect(res.status).toBe(200);
    expect(seen.at(-1)!.body).toEqual({ ...body, user: "u5" });
    expect(errors.length).toBeGreaterThan(0);
    await chat(proxyFor(), body);
    expect(seen.at(-1)!.body).toEqual(body);
    const bad = await proxyFor()(
      new Request("http://proxy/v1/chat/completions", { method: "POST", body: "{not json" }),
    );
    expect(bad.status).toBe(200);
    expect(seen.at(-1)!.body).toBe("{not json");
  });

  test("shadow mode: Eden decides, the request goes upstream unchanged, onShadow gets ids only", async () => {
    const records: { packets: number; itemIds: string[] }[] = [];
    const proxy = createProxy({
      upstream: `${upstream.url.href}v1`,
      edenUrl: eden.url.href,
      edenApiKey: KEY,
      waitMs: 1_000,
      shadow: true,
      onShadow: (r) => records.push(r),
    });
    const body = { model: "m", messages: [{ role: "user", content: "What time is lunch with Priya Raman?" }] };
    await chat(proxy, body, { "x-eden-user-id": "u6", "x-eden-session-id": "s6" });
    expect(seen.at(-1)!.body).toEqual(body);
    expect(records.length).toBe(1);
    expect(records[0]!.itemIds).toContain("calendar:evt-priya");
    expect(JSON.stringify(records)).not.toContain("Dishoom");
    expect((await explain("u6", "s6")).length).toBeGreaterThan(0);
  });

  test("an unreachable upstream is a 502 with an OpenAI-shaped error", async () => {
    const proxy = createProxy({ upstream: "http://127.0.0.1:9/v1", edenUrl: eden.url.href, edenApiKey: KEY });
    const res = await chat(proxy, { model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.message).toContain("upstream");
  });

  test("eventsOf: text parts, tool calls with JSON or plain arguments, results named by their call", () => {
    const tools = new Map<string, string>();
    expect(eventsOf({ role: "user", content: [{ type: "text", text: "a" }, { type: "image_url" }] }, tools)).toEqual([
      { kind: "user_message", text: "a" },
    ]);
    const calls = eventsOf(
      { role: "assistant", content: "x", tool_calls: [{ id: "1", function: { name: "t", arguments: "not json" } }] },
      tools,
    );
    expect(calls).toEqual([
      { kind: "agent_message", text: "x" },
      { kind: "tool_call", tool: "t", input: "not json" },
    ]);
    expect(eventsOf({ role: "tool", tool_call_id: "1", content: "r" }, tools)).toEqual([
      { kind: "tool_result", tool: "t", output: "r" },
    ]);
    expect(eventsOf({ role: "system", content: "s" }, tools)).toEqual([]);
  });
});
