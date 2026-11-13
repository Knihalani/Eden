import { afterAll, describe, expect, test } from "bun:test";
import { createProxy } from "./proxy";

// `speculate` (F10, D1273, on by default; docs/research/f10-rule-index.md §9): the turn goes upstream during Eden's
// wait, and the held answer reaches the agent only when the request that would go after the wait is byte for byte the
// same.

const KEY = "k_proxy_spec_0123456789abc";
// A scripted Eden: a user message's text maps to the packet it returns (none if absent), after `EDEN_MS`.
const EDEN_MS = 300;
const UPSTREAM_MS = 300;
const script: Record<string, string> = {};
const eden = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as { kind?: string; text?: string };
    if (url.pathname === "/v1/pending") return Response.json({ injections: [] });
    if (url.pathname !== "/v1/events" || body.kind !== "user_message") return Response.json({ injection: null });
    await Bun.sleep(EDEN_MS);
    const packet = script[body.text ?? ""];
    return Response.json({ injection: packet ? { id: `i-${packet}`, text: packet } : null });
  },
});
/** Every upstream call's messages (the speculative call's abort is the proxy's; Bun's server does not report it). */
const calls: { messages: any[]; aborted: boolean }[] = [];
const failed = new Set<string>();
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    // A Responses body carries `input` where chat and Anthropic carry `messages`.
    const parsed = JSON.parse(await req.text()) as { messages?: any[]; input?: unknown };
    const call = { messages: (parsed.messages ?? [parsed.input]) as any[], aborted: false };
    calls.push(call);
    req.signal.addEventListener("abort", () => (call.aborted = true));
    await Bun.sleep(UPSTREAM_MS);
    // "overloaded" fails the first time it is seen (a 503), as a rate-limited or busy provider does.
    const asked = JSON.stringify(call.messages);
    if (asked.includes("overloaded") && !failed.has(asked)) {
      failed.add(asked);
      return new Response("busy", { status: 503 });
    }
    const text = JSON.stringify(call.messages);
    return Response.json({ choices: [{ message: { role: "assistant", content: `answer to ${text.length}` } }] });
  },
});
afterAll(() => {
  eden.stop(true);
  upstream.stop(true);
});

/** The proxy's own upstream fetches, and whether each was aborted by the proxy (Bun's server cannot tell). */
const fetched: { aborted: () => boolean }[] = [];
const proxyFor = (speculate: boolean) =>
  createProxy({
    upstream: `${upstream.url.href}v1`,
    edenUrl: eden.url.href,
    edenApiKey: KEY,
    waitMs: 1_000,
    speculate,
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      fetched.push({ aborted: () => !!signal?.aborted });
      return fetch(input, init);
    }) as typeof fetch,
  });
const chat = (proxy: (r: Request) => Promise<Response>, messages: unknown[], user: string) =>
  proxy(
    new Request("http://proxy/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-eden-user-id": user, "x-eden-session-id": `${user}-s` },
      body: JSON.stringify({ model: "m", messages }),
    }),
  );
const u = (content: string) => ({ role: "user", content });
const timed = async (f: () => Promise<Response>) => {
  const t0 = performance.now();
  const res = await f();
  const body = (await res.json()) as any;
  return { ms: performance.now() - t0, body };
};

describe("speculate (F10)", () => {
  test("off: Eden's wait, then the model (the two in a row)", async () => {
    const before = calls.length;
    const { ms } = await timed(() => chat(proxyFor(false), [u("plain question one")], "s-off"));
    expect(ms).toBeGreaterThanOrEqual(EDEN_MS + UPSTREAM_MS - 20);
    expect(calls.length - before).toBe(1);
  });

  test("Eden adds nothing: one upstream call, sent during the wait, and its answer is the agent's", async () => {
    const before = calls.length;
    const off = await timed(() => chat(proxyFor(false), [u("plain question two")], "s-a"));
    const on = await timed(() => chat(proxyFor(true), [u("plain question two")], "s-b"));
    expect(calls.length - before).toBe(2);
    expect(on.body).toEqual(off.body);
    expect(on.ms).toBeLessThan(EDEN_MS + UPSTREAM_MS - 100);
  });

  test("Eden adds a packet: the speculative call is aborted and the request goes with the packet", async () => {
    script["book the venue"] = "PKT-VENUE";
    const before = calls.length;
    const { body } = await timed(() => chat(proxyFor(true), [u("book the venue")], "s-c"));
    const mine = calls.slice(before);
    expect(mine.length).toBe(2);
    expect(fetched.at(-2)!.aborted()).toBe(true);
    expect(fetched.at(-1)!.aborted()).toBe(false);
    expect(JSON.stringify(mine[0]!.messages)).not.toContain("PKT-VENUE");
    expect(JSON.stringify(mine[1]!.messages)).toContain("PKT-VENUE");
    // The agent's answer is the packet request's.
    expect(body.choices[0].message.content).toBe(`answer to ${JSON.stringify(mine[1]!.messages).length}`);
  });

  test("not in shadow mode or with askTool: no speculative call", async () => {
    for (const extra of [{ shadow: true }, { askTool: true }]) {
      const proxy = createProxy({
        upstream: `${upstream.url.href}v1`,
        edenUrl: eden.url.href,
        edenApiKey: KEY,
        waitMs: 1_000,
        speculate: true,
        ...extra,
      });
      const { ms } = await timed(() => chat(proxy, [u("plain question three")], `s-x-${Object.keys(extra)[0]}`));
      expect(ms).toBeGreaterThanOrEqual(EDEN_MS + UPSTREAM_MS - 20);
    }
  });

  test("an early 503 is not passed on: the request goes again and the agent gets that answer (review)", async () => {
    const before = calls.length;
    const res = await chat(proxyFor(true), [u("overloaded right now")], "s-503");
    expect(res.status).toBe(200);
    expect(calls.length - before).toBe(2);
  });

  test("a second turn with an earlier turn's packet kept: one call, the same bytes as off (review)", async () => {
    script["first turn with a packet"] = "PKT-FIRST";
    const run = async (speculate: boolean, user: string) => {
      const p = proxyFor(speculate);
      await chat(p, [u("first turn with a packet")], user);
      const before = calls.length;
      await chat(
        p,
        [u("first turn with a packet"), { role: "assistant", content: "ok" }, u("a plain follow-up")],
        user,
      );
      return calls.slice(before);
    };
    const off = await run(false, "s-k-off");
    const on = await run(true, "s-k-on");
    expect(on.length).toBe(1);
    expect(on[0]!.messages).toEqual(off[0]!.messages);
    expect(JSON.stringify(on[0]!.messages)).toContain("PKT-FIRST");
  });

  test("Anthropic Messages: nothing new, one call during the wait (review)", async () => {
    const before = calls.length;
    const t0 = performance.now();
    const res = await proxyFor(true)(
      new Request("http://proxy/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-eden-user-id": "s-anth", "x-eden-session-id": "s-anth-s" },
        body: JSON.stringify({ model: "m", max_tokens: 10, messages: [u("plain anthropic question")] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls.length - before).toBe(1);
    expect(performance.now() - t0).toBeLessThan(EDEN_MS + UPSTREAM_MS - 100);
  });

  test("never early when the provider runs tools itself, with `store: true`, or on the Responses route (review)", async () => {
    // A packet turn: speculating would send two upstream calls (the early one, aborted, and the packet's). The turns
    // run at once (each waits on Eden and the upstream, about 0.6 s; one after another they took 6.5 s): each counts
    // the upstream calls that carry its own user's message.
    const packetCalls = async (path: string, body: Record<string, unknown>, user: string) => {
      script[`provider tools ${user}`] = `PKT-${user}`;
      const mine = () => calls.filter((c) => JSON.stringify(c.messages).includes(`"provider tools ${user}"`)).length;
      const asked = path.endsWith("/responses")
        ? { input: `provider tools ${user}` }
        : { max_tokens: 10, messages: [u(`provider tools ${user}`)] };
      const res = await proxyFor(true)(
        new Request(`http://proxy${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-eden-user-id": user, "x-eden-session-id": `${user}-s` },
          body: JSON.stringify({ model: "m", ...body, ...asked }),
        }),
      );
      await res.text();
      await Bun.sleep(50);
      return mine();
    };
    const fn = { type: "function", function: { name: "f", parameters: {} } };
    const counts = await Promise.all([
      // The control: a plain packet turn speculates, so two calls.
      packetCalls("/v1/chat/completions", {}, "pt-plain"),
      packetCalls("/v1/messages", { mcp_servers: [{ type: "url", url: "https://mcp.example", name: "x" }] }, "pt-mcp"),
      packetCalls("/v1/messages", { tools: [{ type: "web_search_20250305", name: "web_search" }] }, "pt-ws"),
      packetCalls("/v1/messages", { container: "c-1" }, "pt-container"),
      packetCalls("/v1/chat/completions", { web_search_options: {} }, "pt-chatws"),
      packetCalls("/v1/chat/completions", { store: true }, "pt-store"),
      packetCalls("/v1/responses", {}, "pt-resp"),
      // Client tools still speculate: chat `function`, Anthropic untyped and `custom`.
      packetCalls("/v1/chat/completions", { tools: [fn] }, "pt-fn"),
      packetCalls("/v1/messages", { tools: [{ name: "f", input_schema: {} }] }, "pt-anth-fn"),
      packetCalls("/v1/messages", { tools: [{ type: "custom", name: "f", input_schema: {} }] }, "pt-custom"),
    ]);
    expect(counts).toEqual([2, 1, 1, 1, 1, 1, 1, 2, 2, 2]);
  }, 30_000);
});
