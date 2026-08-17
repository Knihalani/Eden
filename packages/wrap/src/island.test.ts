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
});
