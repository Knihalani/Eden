import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildPartner, createHandler } from "@eden/server";
import { StaticSource } from "@eden/sources";

// Path (b) of the onboarding smoke tests (D365): a Python agent with only the standard library calls its model through
// `bun run proxy` (started as a process, as the README says), with an x-eden-user-id header. A fake OpenAI-compatible
// upstream records what reached the model: Eden's packet before the user's message. No network, no keys.

const python = Bun.which("python3");
const proxyMain = resolve(import.meta.dir, "../../packages/proxy/src/main.ts");

const cleanEnv = (extra: Record<string, string>) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("EDEN_") && !k.startsWith("OPENROUTER_") && !k.startsWith("PROXY_")) {
      env[k] = v;
    }
  }
  return { ...env, ...extra };
};

/** Collects a stream's text in the background; `until` waits for `match` to find something in it. */
function lines(stream: ReadableStream<Uint8Array>) {
  let text = "";
  let ended = false;
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    ended = true;
  })();
  return {
    async until<T>(match: (all: string) => T | null, ms = 10_000): Promise<T> {
      const end = Date.now() + ms;
      for (;;) {
        const got = match(text);
        if (got !== null) return got;
        if (ended || Date.now() > end) throw new Error(`not found; output so far:\n${text}`);
        await Bun.sleep(20);
      }
    },
    text: () => text,
  };
}

describe.skipIf(!python)("Python behind the proxy", () => {
  test("urllib through `bun run proxy`: the model gets Eden's packet; a missing user id is said once", async () => {
    const partner = buildPartner({
      sources: async () => [
        new StaticSource("calendar", "The user's calendar", [
          { ref: "evt-priya", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom, confirmed" },
        ]),
      ],
      model: null,
    });
    const eden = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: new Map(), dev: true }) });
    const seen: { path: string; messages: { role: string; content: string }[] }[] = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { messages: { role: string; content: string }[] };
        seen.push({ path: new URL(req.url).pathname, messages: body.messages });
        return Response.json({
          id: "c1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        });
      },
    });
    const proxy = Bun.spawn(["bun", proxyMain], {
      env: cleanEnv({
        EDEN_PROXY_UPSTREAM: `${upstream.url.href}v1`,
        EDEN_URL: eden.url.href.replace(/\/$/, ""),
        PROXY_PORT: "0",
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = lines(proxy.stdout);
    const err = lines(proxy.stderr);
    try {
      const url = await out.until((t) => /eden proxy on (http:\/\/\S+\/v1)/.exec(t)?.[1] ?? null);
      // The startup probe says Eden is reachable, once.
      await err.until((t) => (t.includes("accepted a key-less request (dev)") ? true : null));
      const health = await fetch(new URL("/healthz", url));
      expect(await health.json()).toEqual({ ok: true });

      const script = `
import json, sys, urllib.request
def chat(text, headers):
    req = urllib.request.Request(sys.argv[1] + "/chat/completions", method="POST",
        data=json.dumps({"model": "m", "messages": [{"role": "user", "content": text}]}).encode(),
        headers={"content-type": "application/json", "authorization": "Bearer sk-upstream", **headers})
    return json.load(urllib.request.urlopen(req))["choices"][0]["message"]["content"]
print(json.dumps([chat("When is lunch with Priya Raman?", {"x-eden-user-id": "alice@example.com"}),
                  chat("hello", {}), chat("hello again", {})]))`;
      const py = Bun.spawn([python!, "-I", "-c", script, url], { stdout: "pipe", stderr: "pipe" });
      const [pout, perr, code] = await Promise.all([
        new Response(py.stdout).text(),
        new Response(py.stderr).text(),
        py.exited,
      ]);
      expect(perr).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(pout)).toEqual(["ok", "ok", "ok"]);

      // Speculate is on by default (D1273): the first turn also went upstream during Eden's wait, as it would with no
      // packet, and was aborted when Eden's packet came. The agent got the packet's answer; the user-id-less turns
      // have no Eden wait and go once each.
      expect(seen.every((s) => s.path === "/v1/chat/completions")).toBe(true);
      const packeted = seen.filter((s) => s.messages[0]!.role === "system");
      expect(packeted.length).toBe(1);
      expect(packeted[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(packeted[0]!.messages[0]!.content).toContain("Dishoom");
      const plain = seen.filter((s) => s.messages[0]!.role === "user").map((s) => s.messages[0]!.content);
      expect(plain.filter((c) => c === "hello" || c === "hello again").sort()).toEqual(["hello", "hello again"]);
      expect(plain.length).toBeLessThanOrEqual(3);
      // Two requests with no user id: one line saying so, naming the header, never the message.
      await err.until((t) => (t.includes("named no user") ? true : null));
      expect(err.text().match(/named no user/g)!.length).toBe(1);
      expect(err.text()).not.toContain("hello");
    } finally {
      proxy.kill("SIGTERM");
      await proxy.exited;
      upstream.stop(true);
      eden.stop(true);
      partner.stopSync();
    }
  }, 60_000);

  test("an upstream with no version path is warned about at startup", async () => {
    const proxy = Bun.spawn(["bun", proxyMain], {
      env: cleanEnv({
        EDEN_PROXY_UPSTREAM: "https://api.example.com",
        EDEN_URL: "http://127.0.0.1:9",
        PROXY_PORT: "0",
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = lines(proxy.stderr);
    try {
      await err.until((t) => (t.includes("has no path") ? true : null));
      // Eden down at startup: said once, with where it looked.
      await err.until((t) =>
        t.includes("Eden not usable yet (eden /v1/whoami: cannot reach http://127.0.0.1:9") ? true : null,
      );
    } finally {
      proxy.kill("SIGTERM");
      await proxy.exited;
    }
  }, 30_000);
});
