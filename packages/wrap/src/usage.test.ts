import { describe, expect, test } from "bun:test";
import { attachChatUsage, cacheHitDenomFromUsage, consumeChatUsage, parseCacheTokens, parseUsage, peekChatUsage, recordCompletion, scrapeSseUsage } from "./usage";
import { emptyRun } from "./types";
import { providerCacheHitPct, type StretchTrace } from "@eden/ir";

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
    ).toEqual({ cached: 12, cacheWrite: 3, denom: 15 });
    expect(parseCacheTokens({ cached_tokens: 7 })).toEqual({ cached: 7 });
    expect(parseCacheTokens({ prompt_tokens: 10, completion_tokens: 2 })).toBeNull();
    expect(
      parseCacheTokens({
        prompt_tokens: 2006,
        prompt_tokens_details: { cached_tokens: 1920 },
      }),
    ).toEqual({ cached: 1920, denom: 2006 });
    expect(
      parseCacheTokens({
        input_tokens: 50,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      }),
    ).toEqual({ cached: 40, cacheWrite: 10, denom: 100 });
    expect(cacheHitDenomFromUsage({ prompt_tokens: 2006, prompt_tokens_details: { cached_tokens: 1920 } })).toBe(2006);
    expect(
      cacheHitDenomFromUsage({
        input_tokens: 50,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      }),
    ).toBe(100);
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

  test("recordCompletion parses cache onto cached_tokens, not prompt/completion", () => {
    const run = emptyRun();
    recordCompletion(run, {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    });
    expect(run.prompt_tokens).toBe(100);
    expect(run.completion_tokens).toBe(10);
    expect(run.cached_tokens).toBe(40);
    expect(run.cache_input_tokens).toBe(100);
    expect(run.measured).toBe(true);
    const peek = peekChatUsage({ run });
    expect(peek?.cached_tokens).toBe(40);
    expect(peek?.cache_input_tokens).toBe(100);
    const attached = attachChatUsage(trace(), peek);
    expect(attached.cached_tokens).toBe(40);
    expect(attached.prompt_tokens).toBe(100);
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

  test("SSE include_usage chunk lands OpenAI cached_tokens on the run", async () => {
    const run = emptyRun();
    const body = [
      `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2006,"completion_tokens":300,"total_tokens":2306,"prompt_tokens_details":{"cached_tokens":1920,"cache_write_tokens":0}}}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    await scrapeSseUsage(new Response(body).body!, run);
    expect(run.measured).toBe(true);
    expect(run.prompt_tokens).toBe(2006);
    expect(run.completion_tokens).toBe(300);
    expect(run.cached_tokens).toBe(1920);
    expect(run.cache_input_tokens).toBe(2006);
    expect(peekChatUsage({ run })?.cached_tokens).toBe(1920);
    expect(peekChatUsage({ run })?.cache_input_tokens).toBe(2006);
    expect(providerCacheHitPct(run.cached_tokens, run.prompt_tokens, null, run.cache_input_tokens)).toBe(1920 / 2006);
    expect(parseUsage({ prompt_tokens: 2006, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1920 } })).toEqual({
      prompt: 2006,
      completion: 300,
    });
  });

  test("SSE usage chunk lands Anthropic cache_read_input_tokens on the run", async () => {
    const run = emptyRun();
    const body = [
      `data: {"type":"message_delta","usage":{"input_tokens":50,"output_tokens":20,"cache_read_input_tokens":100000,"cache_creation_input_tokens":0}}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    await scrapeSseUsage(new Response(body).body!, run);
    expect(run.measured).toBe(true);
    expect(run.prompt_tokens).toBe(50);
    expect(run.completion_tokens).toBe(20);
    expect(run.cached_tokens).toBe(100000);
    expect(run.cache_write_tokens).toBe(0);
    expect(run.cache_input_tokens).toBe(100_050);
    expect(providerCacheHitPct(run.cached_tokens, run.prompt_tokens, run.cache_write_tokens, run.cache_input_tokens)).toBe(
      100_000 / 100_050,
    );
    expect(providerCacheHitPct(run.cached_tokens, run.prompt_tokens, run.cache_write_tokens)).not.toBe(100_000 / 50);
    expect(parseUsage({ input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 100000 })).toEqual({
      prompt: 50,
      completion: 20,
    });
  });

  test("SSE usage chunk without cache fields leaves cached_tokens at 0", async () => {
    const run = emptyRun();
    const body = [
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    await scrapeSseUsage(new Response(body).body!, run);
    expect(run.prompt_tokens).toBe(5);
    expect(run.completion_tokens).toBe(2);
    expect(run.cached_tokens).toBe(0);
    expect(peekChatUsage({ run })?.cached_tokens).toBeUndefined();
  });

  test("peekChatUsage does not hide write when cache_input_tokens is 0", () => {
    const run = emptyRun();
    run.measured = true;
    run.cached_tokens = 40;
    run.cache_write_tokens = 10;
    run.cache_input_tokens = 0;
    const peek = peekChatUsage({ run });
    expect(peek?.cached_tokens).toBe(40);
    expect(peek?.cache_write_tokens).toBe(10);
    expect(peek?.cache_input_tokens).toBeUndefined();
  });

  test("recordCompletion Anthropic dialect writes cached_tokens, not extra billed prompt", () => {
    const run = emptyRun();
    recordCompletion(run, {
      usage: {
        input_tokens: 50,
        output_tokens: 20,
        cache_read_input_tokens: 100000,
        cache_creation_input_tokens: 0,
      },
    });
    expect(run.prompt_tokens).toBe(50);
    expect(run.completion_tokens).toBe(20);
    expect(run.cached_tokens).toBe(100000);
    expect(run.cache_write_tokens).toBe(0);
    expect(run.cache_input_tokens).toBe(100_050);
    expect(providerCacheHitPct(run.cached_tokens, run.prompt_tokens, run.cache_write_tokens, run.cache_input_tokens)).toBe(
      100_000 / 100_050,
    );
  });

  test("SSE Anthropic cache_read ≤ input_tokens still uses read+write+input denom", async () => {
    const run = emptyRun();
    const body = [
      `data: {"type":"message_delta","usage":{"input_tokens":50,"output_tokens":8,"cache_read_input_tokens":40,"cache_creation_input_tokens":10}}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    await scrapeSseUsage(new Response(body).body!, run);
    expect(run.prompt_tokens).toBe(50);
    expect(run.cached_tokens).toBe(40);
    expect(run.cache_write_tokens).toBe(10);
    expect(run.cache_input_tokens).toBe(100);
    expect(providerCacheHitPct(run.cached_tokens, run.prompt_tokens, run.cache_write_tokens, run.cache_input_tokens)).toBe(0.4);
    expect(providerCacheHitPct(40, 50, 10)).toBe(0.4);
    expect(parseUsage({ input_tokens: 50, output_tokens: 8, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 })).toEqual({
      prompt: 50,
      completion: 8,
    });
  });
});
