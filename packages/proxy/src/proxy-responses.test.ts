import { afterAll, describe, expect, test } from "bun:test";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";
import { createProxy, fromResponses, toResponses } from "./proxy";

// D656: the proxy in front of OpenAI's Responses API (`POST …/v1/responses`). A fake upstream records what reached the
// model; Eden is the real handler in process, with no model key.

const KEY = "k_proxy_0123456789abcd";
const sources = new StaticSource("calendar", "The user's calendar", [
  { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
]);
const partner = buildPartner({ sources: async () => [sources], model: null });
const eden = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: new Map([[KEY, "acme"]]), dev: false }) });
const seen: { path: string; raw: string; body: any }[] = [];
const SSE = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n';
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text();
    let body: any = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    seen.push({ path: new URL(req.url).pathname, raw, body });
    if (body?.stream) return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
    return Response.json({ id: "resp_1", output: [] });
  },
});
afterAll(() => {
  eden.stop(true);
  upstream.stop(true);
  partner.stopSync();
});
const proxy = createProxy({
  upstream: `${upstream.url.href}v1`,
  edenUrl: eden.url.href,
  edenApiKey: KEY,
  waitMs: 1_000,
});
const post = (raw: string, headers: Record<string, string> = {}, path = "/v1/responses") =>
  proxy(
    new Request(`http://proxy${path}`, {
      method: "POST",
      headers: { authorization: "Bearer sk", ...headers },
      body: raw,
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
    ).json()) as { decisions: { event: string }[] }
  ).decisions.map((d) => d.event);
const ASK = "What time is lunch with Priya Raman?";

describe("the proxy on OpenAI's Responses API (D656)", () => {
  test("a string input becomes the context as a system item, then the user's message; the rest as it came", async () => {
    const raw = `{"model":"m","seed":18446744073709551615,"instructions":"Be brief.","input":${JSON.stringify(ASK)},"store":false}`;
    await post(raw, { "x-eden-user-id": "r1", "x-eden-session-id": "s1" });
    const got = seen.at(-1)!;
    expect(got.path).toBe("/v1/responses");
    expect(got.raw.startsWith('{"model":"m","seed":18446744073709551615,"instructions":"Be brief.","input":[')).toBe(
      true,
    );
    expect(got.raw.endsWith(',"store":false}')).toBe(true);
    expect(got.body.input.map((i: any) => i.role)).toEqual(["system", "user"]);
    expect(got.body.input[0].content).toContain("Dishoom");
    expect(got.body.input[1]).toEqual({ role: "user", content: ASK });
  });

  test("a tool turn: items stay the caller's own, the packet stays put, calls and outputs are reported once", async () => {
    const h = { "x-eden-user-id": "r2", "x-eden-session-id": "s2" };
    const user = { role: "user", content: [{ type: "input_text", text: ASK }] };
    await post(JSON.stringify({ model: "m", input: [user] }), h);
    const first = seen.at(-1)!.body.input;
    const input = [
      user,
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "function_call", call_id: "call_1", name: "calendar_search", arguments: '{"q":"Priya"}' },
      { type: "function_call_output", call_id: "call_1", output: "Thursday 12:30" },
    ];
    await post(JSON.stringify({ model: "m", input }), h);
    const sent = seen.at(-1)!.body.input;
    expect(sent.slice(0, 2)).toEqual(first);
    expect(sent.slice(2)).toEqual(input.slice(1));
    await post(JSON.stringify({ model: "m", input }), h);
    const events = await explain("r2", "s2");
    for (const kind of ["user_message", "tool_call", "tool_result"]) {
      expect(events.filter((e) => e === kind).length).toBe(1);
    }
  });

  test("the body's user names the user; `conversation` names the session when no header does", async () => {
    const body = { model: "m", user: "r3", conversation: { id: "conv_abc" }, input: ASK };
    await post(JSON.stringify(body));
    expect(JSON.stringify(seen.at(-1)!.body.input)).toContain("Dishoom");
    expect((await explain("r3", "conv_abc")).includes("user_message")).toBe(true);
  });

  test("history held by the provider: a packet goes upstream once, not again with each tool output", async () => {
    for (const [user, held] of [
      ["r6", { conversation: "conv_r6" }],
      ["r7", { previous_response_id: "resp_0" }],
    ] as const) {
      const h = { "x-eden-user-id": user, "x-eden-session-id": "held" };
      await post(JSON.stringify({ model: "m", ...held, input: ASK }), h);
      expect(JSON.stringify(seen.at(-1)!.body.input)).toContain("Dishoom");
      for (const id of ["c1", "c2"]) {
        const raw = JSON.stringify({
          model: "m",
          ...held,
          input: [{ type: "function_call_output", call_id: id, output: "ok" }],
        });
        await post(raw, h);
        expect(seen.at(-1)!.raw).toBe(raw);
      }
    }
  });

  test("history held by the provider: the same short reply after a different response is a new turn", async () => {
    // With `previous_response_id` the input is only the new message: "yes" twice reads like a retry unless the
    // response it follows is part of what counts as the same request (the review of D656).
    const h = { "x-eden-user-id": "r9", "x-eden-session-id": "s9" };
    for (const [prev, input] of [
      ["resp_a", ASK],
      ["resp_b", "yes"],
      ["resp_c", "yes"],
    ]) {
      await post(JSON.stringify({ model: "m", previous_response_id: prev, input }), h);
    }
    // A true retry (the same previous response, the same input) is still one turn.
    await post(JSON.stringify({ model: "m", previous_response_id: "resp_c", input: "yes" }), h);
    expect((await explain("r9", "s9")).filter((e) => e === "user_message").length).toBe(3);
  });

  test("a custom tool's call and output are reported as a function's are", async () => {
    const h = { "x-eden-user-id": "r8", "x-eden-session-id": "s8" };
    const input = [
      { role: "user", content: "run it" },
      { type: "custom_tool_call", call_id: "k1", name: "shell", input: "ls" },
      { type: "custom_tool_call_output", call_id: "k1", output: "a b" },
    ];
    await post(JSON.stringify({ model: "m", input }), h);
    const events = await explain("r8", "s8");
    expect(events.filter((e) => e === "tool_call").length).toBe(1);
    expect(events.filter((e) => e === "tool_result").length).toBe(1);
  });

  test("a stream comes back unchanged, with the context in the request", async () => {
    const res = await post(JSON.stringify({ model: "m", stream: true, input: ASK }), {
      "x-eden-user-id": "r10",
      "x-eden-session-id": "s10",
    });
    expect(JSON.stringify(seen.at(-1)!.body.input)).toContain("Dishoom");
    expect(seen.at(-1)!.body.stream).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(SSE);
  });

  test("fails open: no user, an input that is neither text nor a list, and a body that is not JSON go as they came", async () => {
    for (const raw of [JSON.stringify({ model: "m", input: ASK }), '{"model":"m","input":{"a":1}}', "not json"]) {
      await post(raw, raw.includes('"a"') || raw === "not json" ? { "x-eden-user-id": "r4" } : {});
      expect(seen.at(-1)!.raw).toBe(raw);
    }
  });

  test("another route ending in /responses is forwarded as bytes", async () => {
    const raw = JSON.stringify({ input: ASK });
    await post(raw, { "x-eden-user-id": "r5" }, "/v1/evals/e_1/responses");
    expect(seen.at(-1)!.raw).toBe(raw);
  });
});

describe("Responses input read as chat messages (D656)", () => {
  test("one message an item; unknown items keep their place and are no turn", () => {
    const input = [
      { type: "message", role: "developer", content: "rules" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "hi" },
          { type: "input_image", image_url: "x" },
        ],
      },
      { type: "item_reference", id: "x" },
      { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "c", output: "r" },
      null,
    ];
    const v = fromResponses(input)!;
    expect(v.messages.map((m) => m.role)).toEqual(["developer", "user", "item", "assistant", "tool", "item"]);
    expect(v.messages[1]!.content).toBe("hi");
    const context = { role: "system", content: "CTX" };
    const out = toResponses(v, [v.messages[0]!, context, ...v.messages.slice(1)]);
    expect(out).toEqual([input[0], context, ...input.slice(1)]);
    expect(fromResponses({ a: 1 })).toBeNull();
    expect(fromResponses(undefined)).toBeNull();
  });
});
