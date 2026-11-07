import { afterAll, describe, expect, test } from "bun:test";
import { createProxy } from "./proxy";

// Audit A11 on the proxy (D280): each test failed before its fix.

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

describe("audit A11: proxy (D280)", () => {
  test("an agent that hangs up before the model answers cancels the upstream call; one gone before it is sent, none", async () => {
    let started = 0;
    let aborted = 0;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        started++;
        req.signal.addEventListener("abort", () => aborted++);
        await Bun.sleep(1_000);
        return Response.json({ choices: [] });
      },
    });
    // Eden slow to answer: the agent gives up during the proxy's wait for its context.
    const eden = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(600);
        return Response.json({ injection: null, injections: [] });
      },
    });
    servers.push(upstream, eden);
    const proxy = Bun.serve({
      port: 0,
      fetch: createProxy({ upstream: `${upstream.url.href}v1`, edenUrl: eden.url.href, waitMs: 500 }),
    });
    servers.push(proxy);
    const call = async (hangUpAfterMs: number) => {
      const ac = new AbortController();
      const done = fetch(`${proxy.url.href}v1/chat/completions`, {
        method: "POST",
        headers: { "x-eden-user-id": "u1", "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: `hello ${hangUpAfterMs}` }] }),
        signal: ac.signal,
      }).catch(() => null);
      await Bun.sleep(hangUpAfterMs);
      ac.abort();
      await done;
    };
    // Gone while Eden is still deciding: the model is never called (it would be billed for an answer nobody reads).
    await call(200);
    await Bun.sleep(1_800);
    expect(started).toBe(0);
    // Gone while the model is answering: the upstream call is cancelled, not run to the end.
    await call(1_600);
    await Bun.sleep(300);
    expect(started).toBe(1);
    expect(aborted).toBe(1);
  }, 15_000);

  test("a tool result or message past Eden's 1,000,000-character cap is reported cut, not dropped", async () => {
    const events: { kind: string; length: number }[] = [];
    const eden = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/events") {
          const raw = await req.text();
          const e = JSON.parse(raw) as { kind: string; text?: string; output?: string; input?: unknown };
          if (e.kind === "tool_call" && JSON.stringify(e.input).length > 1_000_000) {
            return Response.json({ error: "too long" }, { status: 400 });
          }
          if ((e.text ?? e.output ?? "").length > 1_000_000)
            return Response.json({ error: "too long" }, { status: 400 });
          events.push({ kind: e.kind, length: (e.text ?? e.output ?? "").length });
        }
        return Response.json({ injection: null, injections: [] });
      },
    });
    const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [] }) });
    servers.push(eden, upstream);
    const proxy = createProxy({ upstream: `${upstream.url.href}v1`, edenUrl: eden.url.href, waitMs: 200 });
    const big = "x".repeat(1_200_000);
    await proxy(
      new Request("http://proxy/v1/chat/completions", {
        method: "POST",
        headers: { "x-eden-user-id": "u2", "x-eden-session-id": "s2" },
        body: JSON.stringify({
          messages: [
            { role: "user", content: `read the file ${big}` },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }],
            },
            { role: "tool", tool_call_id: "c1", content: big },
            // A write whose arguments are past the API's 1,000,000-character input cap (the review).
            {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "c2", function: { name: "write", arguments: JSON.stringify({ path: "a", text: `"\n${big}` }) } },
              ],
            },
          ],
        }),
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(["user_message", "tool_call", "tool_result", "tool_call"]);
    expect(events.every((e) => e.length <= 1_000_000)).toBe(true);
  }, 15_000);
});
