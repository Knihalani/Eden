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
});
