import { describe, expect, test } from "bun:test";
import { openaiIsland, islandUpstreamUrl, wrapIsland } from "../src/island";

describe("openaiIsland", () => {
  test("parses JSON content from a chat completion", async () => {
    const island = openaiIsland({
      apiKey: "k",
      fetch: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"hi"}' } }] }))) as unknown as typeof fetch,
    });
    const out = await island({ system: "draft", input: { n: 1 }, outputSchema: { type: "object" } });
    expect(out).toEqual({ text: "hi" });
  });

  test("wrap island does not loop back into local wrap", () => {
    expect(islandUpstreamUrl("http://127.0.0.1:8788/v1")).toBe("https://api.openai.com/v1");
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(wrapIsland({})).toBeUndefined();
    expect(wrapIsland({ apiKey: "k" })).toBeTypeOf("function");
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  });

  describe("transient-failure retries (waste audit: deopt-replay avoidance)", () => {
    function okResponse() {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    }

    test("a 429 is retried and then succeeds", async () => {
      let calls = 0;
      const island = openaiIsland({
        apiKey: "k",
        fetch: (async () => {
          calls++;
          return calls === 1 ? new Response("rate limited", { status: 429 }) : okResponse();
        }) as unknown as typeof fetch,
      });
      const out = await island({ system: "s", input: {}, outputSchema: {} });
      expect(out).toEqual({ ok: true });
      expect(calls).toBe(2);
    });

    test("a 500 blip burns one retry, not the program", async () => {
      let calls = 0;
      const island = openaiIsland({
        apiKey: "k",
        fetch: (async () => {
          calls++;
          return calls <= 2 ? new Response("boom", { status: 500 }) : okResponse();
        }) as unknown as typeof fetch,
      });
      expect(await island({ system: "s", input: {}, outputSchema: {} })).toEqual({ ok: true });
      expect(calls).toBe(3);
    });

    test("a schema rejection (400) fails immediately", async () => {
      let calls = 0;
      const island = openaiIsland({
        apiKey: "k",
        fetch: (async () => {
          calls++;
          return new Response("bad request", { status: 400 });
        }) as unknown as typeof fetch,
      });
      await expect(island({ system: "s", input: {}, outputSchema: {} })).rejects.toThrow("island llm 400");
      expect(calls).toBe(1);
    });

    test("a network-level failure is retried", async () => {
      let calls = 0;
      const island = openaiIsland({
        apiKey: "k",
        fetch: (async () => {
          calls++;
          if (calls === 1) throw new TypeError("fetch failed");
          return okResponse();
        }) as unknown as typeof fetch,
      });
      expect(await island({ system: "s", input: {}, outputSchema: {} })).toEqual({ ok: true });
      expect(calls).toBe(2);
    });

    test("exhausted retries throw the provider status", async () => {
      const island = openaiIsland({
        apiKey: "k",
        fetch: (async () => new Response("overloaded", { status: 503 })) as unknown as typeof fetch,
      });
      await expect(island({ system: "s", input: {}, outputSchema: {} })).rejects.toThrow("island llm 503");
    });
  });
});
