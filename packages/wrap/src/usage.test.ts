import { describe, expect, test } from "bun:test";
import { attachChatUsage, consumeChatUsage, parseCacheTokens, parseUsage, peekChatUsage, recordCompletion, scrapeSseUsage } from "./usage";
import { emptyRun } from "./types";
import type { StretchTrace } from "@eden/ir";

function trace(over: Partial<StretchTrace> = {}): StretchTrace {
  return {
    id: "t",
    events: [{ name: "ping", args: {}, ok: true, result: { pong: true } }],
    llmCalls: 0,
    duration_ms: 1,
    cost_cents: 0,
    ...over,
  };
}

describe("provider usage scrape", () => {
  test("reads OpenAI prompt_tokens / completion_tokens", () => {
    expect(parseUsage({ prompt_tokens: 11, completion_tokens: 4 })).toEqual({ prompt: 11, completion: 4 });
    expect(parseUsage({ input_tokens: 3, output_tokens: 2 })).toEqual({ prompt: 3, completion: 2 });
    expect(parseUsage({})).toBeNull();
    expect(parseUsage(null)).toBeNull();
  });

  test("parseUsage does not fold cache fields into prompt/completion (Arc 1 catcher)", () => {
    // Billing stays prompt+completion until Arc 1 wires a ledger line.
    expect(
      parseUsage({
        prompt_tokens: 100,
        completion_tokens: 10,
        cached_tokens: 80,
        cache_read_input_tokens: 80,
        prompt_tokens_details: { cached_tokens: 80 },
      }),
    ).toEqual({ prompt: 100, completion: 10 });
  });

  test("parseCacheTokens reads OpenAI and Anthropic cache dialects", () => {
    expect(parseCacheTokens({ prompt_tokens_details: { cached_tokens: 40 } })).toEqual({ cached: 40 });
    expect(
      parseCacheTokens({ cache_read_input_tokens: 12, cache_creation_input_tokens: 3 }),
    ).toEqual({ cached: 12, cacheWrite: 3 });
    expect(parseCacheTokens({ cached_tokens: 7 })).toEqual({ cached: 7 });
    expect(parseCacheTokens({ prompt_tokens: 10, completion_tokens: 2 })).toBeNull();
  });

  test("recordCompletion counts a real LLM call and does not invent tokens", () => {
    const run = emptyRun();
    recordCompletion(run, { choices: [{ message: { content: "hi" } }] });
    expect(run.llmCalls).toBe(1);
    expect(run.measured).toBe(false);
    expect(run.output).toBe("hi");
    recordCompletion(run, {
      choices: [{ message: { content: "done" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    expect(run.llmCalls).toBe(2);
    expect(run.measured).toBe(true);
    expect(run.prompt_tokens).toBe(10);
    expect(run.completion_tokens).toBe(2);
    expect(run.output).toBe("done");
  });

  test("tools-only attach leaves a trace unmeasured", () => {
    const out = attachChatUsage(trace(), consumeChatUsage({ run: emptyRun() }));
    expect(out.llmCalls).toBe(0);
    expect(out.prompt_tokens).toBeUndefined();
    expect(out.completion_tokens).toBeUndefined();
  });

  test("attachChatUsage writes tokens and output onto a tools trace", () => {
    const run = emptyRun();
    recordCompletion(run, {
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
    });
    const out = attachChatUsage(trace({ output: { pong: true } }), consumeChatUsage({ run }));
    expect(out.llmCalls).toBe(1);
    expect(out.prompt_tokens).toBe(8);
    expect(out.completion_tokens).toBe(3);
    expect(out.output).toEqual({ pong: true });
    expect(consumeChatUsage({ run })).toBeNull();
  });

  test("attachChatUsage does not clobber a trace that already has tokens", () => {
    const run = emptyRun();
    recordCompletion(run, {
      usage: { prompt_tokens: 8, completion_tokens: 3 },
    });
    const before = trace({ prompt_tokens: 99, completion_tokens: 1, llmCalls: 2, output: "kept" });
    const out = attachChatUsage(before, peekChatUsage({ run }));
    expect(out).toBe(before);
    expect(out.prompt_tokens).toBe(99);
    expect(out.llmCalls).toBe(2);
    expect(peekChatUsage({ run })?.prompt_tokens).toBe(8);
  });

  test("SSE scrape reads include_usage chunks", async () => {
    const run = emptyRun();
    const body = [
      `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    await scrapeSseUsage(new Response(body).body!, run);
    expect(run.measured).toBe(true);
    expect(run.llmCalls).toBe(1);
    expect(run.prompt_tokens).toBe(5);
    expect(run.completion_tokens).toBe(2);
    expect(run.output).toBeUndefined();
  });

  test("SSE leftover buffer without a trailing blank line still yields usage", async () => {
    const run = emptyRun();
    const body = `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":1}}`;
    await scrapeSseUsage(new Response(body).body!, run);
    expect(run.measured).toBe(true);
    expect(run.llmCalls).toBe(1);
    expect(run.prompt_tokens).toBe(6);
    expect(run.completion_tokens).toBe(1);
  });
});
