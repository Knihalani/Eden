import { describe, expect, test } from "bun:test";
import {
  extractBedrockUsage,
  extractGeminiUsage,
} from "../src/instrumentations/providers";

describe("extractBedrockUsage", () => {
  test("Converse API top-level usage (camelCase)", () => {
    const out = extractBedrockUsage({
      output: { message: { role: "assistant", content: [] } },
      usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 },
      stopReason: "end_turn",
    });
    expect(out).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });

  test("Converse API cache read/write fields", () => {
    const out = extractBedrockUsage({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 200,
        cacheWriteInputTokens: 50,
      },
    });
    expect(out.cacheReadTokens).toBe(200);
    expect(out.cacheCreationTokens).toBe(50);
  });

  test("InvokeModel — Anthropic-on-Bedrock body shape", () => {
    const body = JSON.stringify({
      usage: { input_tokens: 30, output_tokens: 12 },
    });
    const out = extractBedrockUsage({
      body: new TextEncoder().encode(body),
      contentType: "application/json",
    });
    expect(out.inputTokens).toBe(30);
    expect(out.outputTokens).toBe(12);
  });

  test("InvokeModel — Titan body shape", () => {
    const out = extractBedrockUsage({
      body: {
        inputTextTokenCount: 88,
        results: [{ tokenCount: 33, outputText: "hi" }],
      },
    });
    expect(out.inputTokens).toBe(88);
    expect(out.outputTokens).toBe(33);
  });

  test("InvokeModel — Llama body shape", () => {
    const out = extractBedrockUsage({
      body: { prompt_token_count: 14, generation_token_count: 7 },
    });
    expect(out.inputTokens).toBe(14);
    expect(out.outputTokens).toBe(7);
  });

  test("InvokeModel — body as JSON string", () => {
    const out = extractBedrockUsage({
      body: JSON.stringify({ prompt_token_count: 5, generation_token_count: 2 }),
    });
    expect(out.inputTokens).toBe(5);
    expect(out.outputTokens).toBe(2);
  });

  test("missing/garbage response returns all-null", () => {
    expect(extractBedrockUsage(null)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(extractBedrockUsage({})).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(extractBedrockUsage({ body: "not json" })).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });
});

describe("extractGeminiUsage", () => {
  test("top-level usageMetadata (new @google/genai client shape)", () => {
    const out = extractGeminiUsage({
      candidates: [],
      usageMetadata: {
        promptTokenCount: 60,
        candidatesTokenCount: 25,
        totalTokenCount: 85,
      },
    });
    expect(out).toEqual({
      inputTokens: 60,
      outputTokens: 25,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });

  test("nested response.usageMetadata (legacy google-generativeai shape)", () => {
    const out = extractGeminiUsage({
      response: {
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 4,
        },
      },
    });
    expect(out.inputTokens).toBe(11);
    expect(out.outputTokens).toBe(4);
  });

  test("cachedContentTokenCount maps to cache-read tokens", () => {
    const out = extractGeminiUsage({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 40,
      },
    });
    expect(out.cacheReadTokens).toBe(40);
  });

  test("missing usageMetadata returns all-null", () => {
    expect(extractGeminiUsage({})).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(extractGeminiUsage(null)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });
});
