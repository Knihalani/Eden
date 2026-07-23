import { describe, expect, test } from "bun:test";
import { extractUsage, normalizeModelName } from "../src/tokens";

describe("extractUsage", () => {
  test("anthropic flat dict", () => {
    const out = extractUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 0,
    });
    expect(out).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheCreationTokens: 0,
    });
  });

  test("openAI camelCase aliases", () => {
    const out = extractUsage({ promptTokens: 11, completionTokens: 22 });
    expect(out.inputTokens).toBe(11);
    expect(out.outputTokens).toBe(22);
  });

  test("openAI pydantic-style with nested cached_tokens", () => {
    const usage = {
      prompt_tokens: 42,
      completion_tokens: 99,
      prompt_tokens_details: { cached_tokens: 77 },
    };
    const out = extractUsage(usage);
    expect(out).toEqual({
      inputTokens: 42,
      outputTokens: 99,
      cacheReadTokens: 77,
      cacheCreationTokens: null,
    });
  });

  test("null returns all-null", () => {
    expect(extractUsage(null)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });

  test("partial dict reports missing fields as null (not 0)", () => {
    const out = extractUsage({ completion_tokens: 5 });
    expect(out.inputTokens).toBeNull();
    expect(out.outputTokens).toBe(5);
  });

  test("booleans are ignored", () => {
    const out = extractUsage({ prompt_tokens: true, completion_tokens: false });
    expect(out.inputTokens).toBeNull();
    expect(out.outputTokens).toBeNull();
  });

  test("string counts are coerced", () => {
    const out = extractUsage({
      prompt_tokens: "100",
      completion_tokens: "20",
    });
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(20);
  });

  test("unknown shape returns all-null", () => {
    expect(extractUsage({})).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });

  test("whole-number floats round-trip as integers", () => {
    // ``1.0`` is the typical JSON-decoded whole-number float;
    // the previous implementation returned ``1`` (the float),
    // which still serialised as ``1`` on the wire, but
    // keeping the value as an integer here matches the
    // Python SDK and downstream billing math.
    const out = extractUsage({
      prompt_tokens: 1.0,
      completion_tokens: 20.0,
    });
    expect(out.inputTokens).toBe(1);
    expect(out.outputTokens).toBe(20);
  });

  test("fractional floats are dropped (not silently truncated)", () => {
    // A token count of ``0.7`` would silently bill a call
    // for a fractional token if accepted. The SDK now
    // returns ``null`` for any non-integer number, matching
    // the Python SDK's behaviour since 0.2.9.
    const out = extractUsage({
      prompt_tokens: 0.7,
      completion_tokens: 1.5,
    });
    expect(out.inputTokens).toBeNull();
    expect(out.outputTokens).toBeNull();
  });

  test("fractional strings are dropped", () => {
    // Some providers serialise floats as strings; a
    // fractional string (``"0.7"``) must not be coerced
    // into ``0`` (which would under-bill) or kept as ``0.7``
    // (which would bill a fractional token). Return ``null``.
    const out = extractUsage({
      prompt_tokens: "0.7",
      completion_tokens: "20.0",
    });
    expect(out.inputTokens).toBeNull();
    expect(out.outputTokens).toBe(20);
  });

  test("NaN and infinities are rejected", () => {
    const out = extractUsage({
      prompt_tokens: NaN,
      completion_tokens: Infinity,
    });
    expect(out.inputTokens).toBeNull();
    expect(out.outputTokens).toBeNull();
  });

  test("Bedrock Converse API camelCase shape", () => {
    const out = extractUsage({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 200,
      cacheWriteInputTokens: 50,
    });
    expect(out.inputTokens).toBe(10);
    expect(out.outputTokens).toBe(5);
    expect(out.cacheReadTokens).toBe(200);
    expect(out.cacheCreationTokens).toBe(50);
  });

  test("Gemini usageMetadata shape", () => {
    const out = extractUsage({
      promptTokenCount: 60,
      candidatesTokenCount: 25,
      cachedContentTokenCount: 40,
    });
    expect(out.inputTokens).toBe(60);
    expect(out.outputTokens).toBe(25);
    expect(out.cacheReadTokens).toBe(40);
  });
});

describe("normalizeModelName", () => {
  test("strips dash-date suffix", () => {
    expect(normalizeModelName("gpt-4o-2024-08-06")).toBe("gpt-4o");
  });
  test("strips compact date suffix", () => {
    expect(normalizeModelName("claude-3-5-sonnet-20241022")).toBe(
      "claude-3-5-sonnet",
    );
  });
  test("strips -latest alias", () => {
    expect(normalizeModelName("claude-3-5-sonnet-latest")).toBe(
      "claude-3-5-sonnet",
    );
  });
  test("keeps alias only", () => {
    expect(normalizeModelName("gpt-4o")).toBe("gpt-4o");
    expect(normalizeModelName("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
  test("handles null/undefined/empty", () => {
    expect(normalizeModelName(null)).toBeNull();
    expect(normalizeModelName(undefined)).toBeUndefined();
    expect(normalizeModelName("")).toBe("");
  });
});

describe("normalizeModelName (date + -latest compound cases)", () => {
  // Regression for: stripping the date suffix BEFORE `-latest`
  // left the date stamp behind when `-latest` followed the date.
  // The compound `-DATE-latest` regex now matches both suffixes
  // in one pass so we get the bare base name out the other side.
  test("strips compact date + -latest compound suffix", () => {
    expect(normalizeModelName("claude-sonnet-4-5-20250929-latest")).toBe(
      "claude-sonnet-4-5",
    );
  });
  test("strips dashed date + -latest compound suffix", () => {
    expect(normalizeModelName("gpt-4-turbo-2024-04-09-latest")).toBe(
      "gpt-4-turbo",
    );
  });
  test("compact date suffix still strips when -latest is absent", () => {
    expect(normalizeModelName("claude-3-5-sonnet-20241022")).toBe(
      "claude-3-5-sonnet",
    );
  });
  test("dashed date suffix still strips when -latest is absent", () => {
    expect(normalizeModelName("gpt-4o-2024-08-06")).toBe("gpt-4o");
  });
  test("bare -latest still strips when no date is present", () => {
    expect(normalizeModelName("claude-3-5-sonnet-latest")).toBe(
      "claude-3-5-sonnet",
    );
  });
});
