/**
 * M49.2: wrap still streams. Inject is in-process — not an `eden` CLI subprocess
 * in front of the model.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createState, handleChatCompletions } from "./index";

const INJECT_SOURCES = ["proxy.ts", "know-inject.ts", "tool-observe.ts"] as const;

function src(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

function assertNoCli(text: string, file: string): void {
  expect(text, file).not.toMatch(/\bfrom\s+["']node:child_process["']/);
  expect(text, file).not.toMatch(/\bspawn(?:Sync)?\s*\(/);
  expect(text, file).not.toMatch(/\bexecFile(?:Sync)?\s*\(/);
  expect(text, file).not.toMatch(/Bun\.spawn/);
  expect(text, file).not.toMatch(/\beden\s+memory\b/);
  expect(text, file).not.toMatch(/\beden\s+hook\b/);
}

describe("M49.2 wrap streams; inject is in-process", () => {
  test("stream: true still returns text/event-stream", async () => {
    const sse = [
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    let calls = 0;
    const state = createState({
      fetch: (async (_url: string, init?: RequestInit) => {
        calls += 1;
        const raw = typeof init?.body === "string" ? init.body : "";
        const body = JSON.parse(raw) as { stream?: boolean; messages?: unknown[] };
        expect(body.stream).toBe(true);
        expect(Array.isArray(body.messages)).toBe(true);
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch,
    });
    const res = await handleChatCompletions(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o",
          stream: true,
          messages: [{ role: "user", content: "Where does operator op0042 live?" }],
        }),
      }),
      { state },
    );
    expect(calls).toBe(1);
    expect(res.headers.get("content-type") || "").toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
    expect(state.run.measured).toBe(true);
    expect(state.run.llmCalls).toBe(1);
  });

  test("proxy and know-inject call inject in-process", () => {
    const proxy = src("proxy.ts");
    const know = src("know-inject.ts");
    const observe = src("tool-observe.ts");
    expect(proxy).toMatch(/injectBodyThenObserveTools\(processMemory\(\),\s*body\)/);
    expect(proxy).toMatch(/injectBodyThenObserveTools\(processMemory\(\)/);
    expect(proxy).toMatch(/tapSseUsage/);
    expect(proxy).toMatch(/text\/event-stream/);
    expect(know).toMatch(/injectBodyThenObserveTools\(processMemory\(\),\s*body\)/);
    expect(know).toMatch(/mem\.inject\(/);
    expect(observe).toMatch(/mem\.injectBody\(body\)/);
    for (const file of INJECT_SOURCES) assertNoCli(src(file), file);
  });
});
