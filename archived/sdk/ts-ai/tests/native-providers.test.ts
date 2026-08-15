/**
 * Tests for the Groq / Cohere / Mistral native auto-instrumentations.
 *
 * Promoted from the generic host-sniffing HTTP-capture fallback to
 * dedicated wrappers (mirrors `instrumentations.test.ts`'s coverage
 * of `wrapOpenAI` / `wrapAnthropic`). Each test stubs a fake SDK
 * client exposing the same surface the real `groq-sdk` / `cohere-ai`
 * / `@mistralai/mistralai` clients expose, then asserts the emitted
 * telemetry.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseFetchBody } from "./_parseBody.js";
import { wireToEvent } from "../src/wire.js";
import { resetDefaultClient, getDefaultClient } from "../src/client.js";
import { configure } from "../src/trace.js";
import { wrapGroq } from "../src/instrumentations/groq.js";
import { wrapCohere, extractCohereUsage } from "../src/instrumentations/cohere.js";
import { wrapMistral } from "../src/instrumentations/mistral.js";
import type { TelemetryEvent } from "../src/types.js";

interface CapturedRequest {
  url: string;
  body: unknown;
}

let captured: CapturedRequest[];
let originalFetch: typeof fetch;

beforeEach(() => {
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((async (_input: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown = init?.body;
    try {
      body = parseFetchBody(init);
    } catch {
      // keep raw
    }
    captured.push({ url: String(_input), body });
    return new Response("{}", { status: 200 });
  }) as unknown) as typeof fetch;
  resetDefaultClient();
  configure({ orgId: "org_test", apiKey: "key_test", captureChunkText: true });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await getDefaultClient().dispose();
  resetDefaultClient();
});

function _flattenEvents(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (const req of captured) {
    if (Array.isArray(req.body)) {
      events.push(...(req.body as Record<string, unknown>[]).map((w) => wireToEvent(w) as unknown as TelemetryEvent));
    }
  }
  return events;
}

// ── Groq ──────────────────────────────────────────────────────────

function _fakeGroqClient(opts: { completion?: any; stream?: AsyncIterable<any>; createError?: Error }): any {
  return {
    chat: {
      completions: {
        create: async (..._args: any[]) => {
          if (opts.createError) throw opts.createError;
          if (opts.stream) return opts.stream;
          if (opts.completion) return opts.completion;
          return { id: "x", choices: [] };
        },
      },
    },
  };
}

describe("wrapGroq", () => {
  it("emits llm_completion with provider=groq and groq-shaped usage", async () => {
    const fakeClient = _fakeGroqClient({
      completion: {
        id: "chatcmpl-1",
        model: "llama-3.3-70b-versatile",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } },
        ],
        // Groq's `CompletionUsage` names match OpenAI's exactly.
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    });
    const wrapped = wrapGroq(fakeClient);
    const result = await wrapped.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.choices[0].message.content).toBe("hi");
    await getDefaultClient().flush();

    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("groq");
    expect(completion?.payload.provider).toBe("groq");
    expect(completion?.payload.model).toBe("llama-3.3-70b-versatile");
    const metrics = (completion?.metrics ?? {}) as Record<string, number>;
    expect(metrics.input_tokens).toBe(5);
    expect(metrics.output_tokens).toBe(1);
    expect(completion?.modelNormalized).toBe("llama-3.3-70b-versatile");
  });

  it("parses tool_calls on non-streaming responses", async () => {
    const fakeClient = _fakeGroqClient({
      completion: {
        id: "chatcmpl-2",
        model: "llama-3.3-70b-versatile",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      },
    });
    const wrapped = wrapGroq(fakeClient);
    await wrapped.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "weather?" }],
    });
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.payload.tool_call_count).toBe(1);
    expect(completion?.payload.tool_names).toEqual(["get_weather"]);
  });

  it("emits llm_completion_stream and accumulates streamed tool-call names", async () => {
    async function* chunkGen() {
      yield {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "get_weather" } }] } }],
        model: "llama-3.3-70b-versatile",
      };
      yield {
        choices: [{ finish_reason: "tool_calls", delta: {} }],
        model: "llama-3.3-70b-versatile",
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      };
    }
    const fakeClient = _fakeGroqClient({ stream: chunkGen() });
    const wrapped = wrapGroq(fakeClient);
    const stream = await wrapped.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    for await (const _ of stream) { /* drain */ }
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion_stream");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("groq");
    expect(completion?.payload.tool_call_count).toBe(1);
    expect(completion?.payload.tool_names).toEqual(["get_weather"]);
    expect(completion?.metrics?.input_tokens).toBe(8);
  });

  it("captures errors without breaking the call", async () => {
    const fakeClient = _fakeGroqClient({ createError: new Error("rate limited") });
    const wrapped = wrapGroq(fakeClient);
    await expect(
      wrapped.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [] }),
    ).rejects.toThrow("rate limited");
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.payload.status).toBe("error");
    expect(completion?.payload.error_message).toBe("rate limited");
  });

  it("is idempotent: double-wrapping returns the same client shape", () => {
    const fake = _fakeGroqClient({ completion: { id: "x" } });
    const a = wrapGroq(fake);
    const b = wrapGroq(a);
    expect(a).toBe(b);
  });
});

// ── Mistral ───────────────────────────────────────────────────────

function _fakeMistralClient(opts: { response?: any; stream?: AsyncIterable<any>; completeError?: Error }): any {
  return {
    chat: {
      complete: async (..._args: any[]) => {
        if (opts.completeError) throw opts.completeError;
        return opts.response;
      },
      stream: async (..._args: any[]) => opts.stream,
    },
  };
}

describe("wrapMistral", () => {
  it("emits llm_completion with camelCase usage fields normalized", async () => {
    const fakeClient = _fakeMistralClient({
      response: {
        id: "cmpl-1",
        object: "chat.completion",
        model: "mistral-large-latest",
        created: 1,
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } },
        ],
        // The TS SDK normalizes UsageInfo to camelCase (unlike the
        // Python SDK, which sees snake_case).
        usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
      },
    });
    const wrapped = wrapMistral(fakeClient);
    const result = await wrapped.chat.complete({
      model: "mistral-large-latest",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.choices[0].message.content).toBe("hi");
    await getDefaultClient().flush();

    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.sourceFormat).toBe("mistral");
    expect(completion?.payload.provider).toBe("mistral");
    expect(completion?.payload.model).toBe("mistral-large-latest");
    const metrics = (completion?.metrics ?? {}) as Record<string, number>;
    expect(metrics.input_tokens).toBe(7);
    expect(metrics.output_tokens).toBe(2);
    // normalizeModelName strips the trailing `-latest` alias so
    // pricing lookups roll up to a single row.
    expect(completion?.modelNormalized).toBe("mistral-large");
  });

  it("parses tool_calls from the assistant message", async () => {
    const fakeClient = _fakeMistralClient({
      response: {
        id: "cmpl-2",
        model: "mistral-large-latest",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [{ id: "1", function: { name: "lookup", arguments: "{}" } }],
            },
          },
        ],
        usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
      },
    });
    const wrapped = wrapMistral(fakeClient);
    await wrapped.chat.complete({ model: "mistral-large-latest", messages: [] });
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.payload.tool_call_count).toBe(1);
    expect(completion?.payload.tool_names).toEqual(["lookup"]);
  });

  it("emits llm_completion_stream, unwrapping the `.data` SSE envelope", async () => {
    async function* eventGen() {
      // Mistral's `chat.stream()` wraps each chunk in a `CompletionEvent`
      // with a `.data` field — unlike OpenAI/Groq, which yield the
      // chunk directly.
      yield { data: { id: "a", model: "mistral-large-latest", choices: [{ index: 0, delta: { content: "Hi" } }] } };
      yield {
        data: {
          id: "b",
          model: "mistral-large-latest",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        },
      };
    }
    const fakeClient = _fakeMistralClient({ stream: eventGen() });
    const wrapped = wrapMistral(fakeClient);
    const stream = await wrapped.chat.stream({
      model: "mistral-large-latest",
      messages: [{ role: "user", content: "hi" }],
    });
    const collected: unknown[] = [];
    for await (const chunk of stream) collected.push(chunk);
    expect(collected.length).toBe(2);
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion_stream");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("mistral");
    expect(completion?.payload.model).toBe("mistral-large-latest");
    expect(completion?.metrics?.input_tokens).toBe(3);
  });

  it("captures errors from chat.complete without breaking the call", async () => {
    const fakeClient = _fakeMistralClient({ completeError: new Error("bad request") });
    const wrapped = wrapMistral(fakeClient);
    await expect(
      wrapped.chat.complete({ model: "mistral-large-latest", messages: [] }),
    ).rejects.toThrow("bad request");
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.payload.status).toBe("error");
  });

  it("is idempotent: double-wrapping returns the same client shape", () => {
    const fake = _fakeMistralClient({ response: { id: "x", choices: [] } });
    const a = wrapMistral(fake);
    const b = wrapMistral(a);
    expect(a).toBe(b);
  });
});

// ── Cohere ────────────────────────────────────────────────────────

function _fakeCohereClient(opts: { response?: any; stream?: AsyncIterable<any>; chatError?: Error }): any {
  return {
    v2: {
      chat: async (..._args: any[]) => {
        if (opts.chatError) throw opts.chatError;
        return opts.response;
      },
      chatStream: async (..._args: any[]) => opts.stream,
    },
  };
}

/**
 * Shaped like the real `CohereClientV2` — Cohere's own documented
 * primary entry point — where `chat`/`chatStream` are direct
 * top-level properties with NO `.v2` nesting (verified against the
 * installed `cohere-ai` package's `ClientV2.d.ts`). Deliberately has
 * no `v2` property at all, matching the real class.
 */
function _fakeCohereClientV2(opts: { response?: any; stream?: AsyncIterable<any>; chatError?: Error }): any {
  return {
    chat: async (..._args: any[]) => {
      if (opts.chatError) throw opts.chatError;
      return opts.response;
    },
    chatStream: async (..._args: any[]) => opts.stream,
  };
}

describe("extractCohereUsage", () => {
  it("prefers billedUnits over the raw tokens count", () => {
    const out = extractCohereUsage({
      billedUnits: { inputTokens: 10, outputTokens: 4 },
      tokens: { inputTokens: 12, outputTokens: 5 },
      cachedTokens: 3,
    });
    expect(out.inputTokens).toBe(10);
    expect(out.outputTokens).toBe(4);
    expect(out.cacheReadTokens).toBe(3);
  });

  it("falls back to tokens when billedUnits is absent", () => {
    const out = extractCohereUsage({ tokens: { inputTokens: 12, outputTokens: 5 } });
    expect(out.inputTokens).toBe(12);
    expect(out.outputTokens).toBe(5);
  });

  it("returns all-null for missing/garbage usage", () => {
    expect(extractCohereUsage(null)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });
});

describe("wrapCohere", () => {
  it("emits llm_completion, reading model from the request (V2ChatResponse has no model field)", async () => {
    const fakeClient = _fakeCohereClient({
      response: {
        id: "resp-1",
        finishReason: "COMPLETE",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        usage: { billedUnits: { inputTokens: 6, outputTokens: 2 }, tokens: { inputTokens: 6, outputTokens: 2 } },
      },
    });
    const wrapped = wrapCohere(fakeClient);
    const result = await wrapped.v2.chat({
      model: "command-r-plus",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.message.content[0].text).toBe("hi");
    await getDefaultClient().flush();

    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("cohere");
    expect(completion?.payload.provider).toBe("cohere");
    // Model comes from the request, not the response.
    expect(completion?.payload.model).toBe("command-r-plus");
    const metrics = (completion?.metrics ?? {}) as Record<string, number>;
    expect(metrics.input_tokens).toBe(6);
    expect(metrics.output_tokens).toBe(2);
  });

  it("parses tool_calls from the assistant message", async () => {
    const fakeClient = _fakeCohereClient({
      response: {
        id: "resp-2",
        finishReason: "COMPLETE",
        message: {
          role: "assistant",
          toolCalls: [{ id: "1", type: "function", function: { name: "search", arguments: "{}" } }],
        },
        usage: { billedUnits: { inputTokens: 4, outputTokens: 1 } },
      },
    });
    const wrapped = wrapCohere(fakeClient);
    await wrapped.v2.chat({ model: "command-r-plus", messages: [] });
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.payload.tool_call_count).toBe(1);
    expect(completion?.payload.tool_names).toEqual(["search"]);
  });

  it("emits llm_completion_stream, reading content-delta / tool-call-start / message-end events", async () => {
    async function* eventGen() {
      yield { type: "message-start", id: "resp-3" };
      yield { type: "content-delta", index: 0, delta: { message: { content: { text: "Hi" } } } };
      yield {
        type: "tool-call-start",
        index: 0,
        delta: { message: { toolCalls: { function: { name: "search" } } } },
      };
      yield {
        type: "message-end",
        delta: {
          finishReason: "COMPLETE",
          usage: { billedUnits: { inputTokens: 9, outputTokens: 3 } },
        },
      };
    }
    const fakeClient = _fakeCohereClient({ stream: eventGen() });
    const wrapped = wrapCohere(fakeClient);
    const stream = await wrapped.v2.chatStream({
      model: "command-r-plus",
      messages: [{ role: "user", content: "hi" }],
    });
    const collected: unknown[] = [];
    for await (const event of stream) collected.push(event);
    expect(collected.length).toBe(4);
    await getDefaultClient().flush();

    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion_stream");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("cohere");
    expect(completion?.payload.model).toBe("command-r-plus");
    expect(completion?.payload.finish_reason).toBe("COMPLETE");
    expect(completion?.payload.tool_call_count).toBe(1);
    expect(completion?.payload.tool_names).toEqual(["search"]);
    expect(completion?.metrics?.input_tokens).toBe(9);
    expect(completion?.metrics?.output_tokens).toBe(3);
  });

  it("captures errors from v2.chat without breaking the call", async () => {
    const fakeClient = _fakeCohereClient({ chatError: new Error("unauthorized") });
    const wrapped = wrapCohere(fakeClient);
    await expect(wrapped.v2.chat({ model: "command-r-plus", messages: [] })).rejects.toThrow("unauthorized");
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.payload.status).toBe("error");
  });

  it("is idempotent: double-wrapping returns the same client shape", () => {
    const fake = _fakeCohereClient({ response: { id: "x", message: {} } });
    const a = wrapCohere(fake);
    const b = wrapCohere(a);
    expect(a).toBe(b);
  });

  // Regression test for the CohereClientV2 flat-shape gap: `wrapCohere`
  // used to only intercept `client.v2.chat`/`client.v2.chatStream`
  // (the legacy `CohereClient` shape) and silently no-op for
  // `CohereClientV2`, whose `chat`/`chatStream` are direct top-level
  // properties with no `.v2` nesting at all — Cohere's own documented
  // primary usage pattern (`new CohereClientV2({...}); cohere.chat({...})`).
  describe("flat CohereClientV2 shape (no .v2 nesting)", () => {
    it("intercepts a top-level chat() call and emits llm_completion", async () => {
      const fakeClient = _fakeCohereClientV2({
        response: {
          id: "resp-1",
          finishReason: "COMPLETE",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
          usage: { billedUnits: { inputTokens: 6, outputTokens: 2 } },
        },
      });
      const wrapped = wrapCohere(fakeClient);
      const result = await wrapped.chat({
        model: "command-r-plus",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.message.content[0].text).toBe("hi");
      await getDefaultClient().flush();

      const events = _flattenEvents();
      const completion = events.find((e) => e.eventType === "llm_completion");
      expect(completion).toBeDefined();
      expect(completion?.sourceFormat).toBe("cohere");
      expect(completion?.payload.provider).toBe("cohere");
      expect(completion?.payload.model).toBe("command-r-plus");
      const metrics = (completion?.metrics ?? {}) as Record<string, number>;
      expect(metrics.input_tokens).toBe(6);
      expect(metrics.output_tokens).toBe(2);
    });

    it("intercepts a top-level chatStream() call and emits llm_completion_stream", async () => {
      async function* eventGen() {
        yield { type: "message-start", id: "resp-3" };
        yield { type: "content-delta", index: 0, delta: { message: { content: { text: "Hi" } } } };
        yield {
          type: "message-end",
          delta: {
            finishReason: "COMPLETE",
            usage: { billedUnits: { inputTokens: 9, outputTokens: 3 } },
          },
        };
      }
      const fakeClient = _fakeCohereClientV2({ stream: eventGen() });
      const wrapped = wrapCohere(fakeClient);
      const stream = await wrapped.chatStream({
        model: "command-r-plus",
        messages: [{ role: "user", content: "hi" }],
      });
      const collected: unknown[] = [];
      for await (const event of stream) collected.push(event);
      expect(collected.length).toBe(3);
      await getDefaultClient().flush();

      const events = _flattenEvents();
      const completion = events.find((e) => e.eventType === "llm_completion_stream");
      expect(completion).toBeDefined();
      expect(completion?.sourceFormat).toBe("cohere");
      expect(completion?.payload.model).toBe("command-r-plus");
      expect(completion?.payload.finish_reason).toBe("COMPLETE");
      expect(completion?.metrics?.input_tokens).toBe(9);
      expect(completion?.metrics?.output_tokens).toBe(3);
    });

    it("captures errors from a top-level chat() call without breaking the call", async () => {
      const fakeClient = _fakeCohereClientV2({ chatError: new Error("unauthorized") });
      const wrapped = wrapCohere(fakeClient);
      await expect(wrapped.chat({ model: "command-r-plus", messages: [] })).rejects.toThrow("unauthorized");
      await getDefaultClient().flush();
      const events = _flattenEvents();
      const completion = events.find((e) => e.eventType === "llm_completion");
      expect(completion?.payload.status).toBe("error");
    });

    it("is idempotent: double-wrapping returns the same client shape", () => {
      const fake = _fakeCohereClientV2({ response: { id: "x", message: {} } });
      const a = wrapCohere(fake);
      const b = wrapCohere(a);
      expect(a).toBe(b);
    });
  });
});
