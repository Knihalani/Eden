import { describe, expect, test } from "bun:test";
import { attachChatUsage, parseCacheTokens, parseUsage, peekChatUsage, recordCompletion } from "./usage";
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
    const out = attachChatUsage(trace(), peekChatUsage({ run: emptyRun() }));
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
    const out = attachChatUsage(trace({ output: { pong: true } }), peekChatUsage({ run }));
    expect(out.llmCalls).toBe(1);
    expect(out.prompt_tokens).toBe(8);
    expect(out.completion_tokens).toBe(3);
    expect(out.output).toEqual({ pong: true });
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
});
