/**
 * Tests for the OpenAI / Anthropic / Vercel AI / LangChain
 * auto-instrumentations.
 *
 * Each test stubs a fake SDK module that exposes the same
 * surface the wrapper expects, then asserts that calling
 * through the wrapper results in the right telemetry events
 * being emitted.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetDefaultClient, getDefaultClient } from "../src/client.js";
import { configure } from "../src/trace.js";
import { wrapOpenAI } from "../src/instrumentations/openai.js";
import { wrapAnthropic } from "../src/instrumentations/anthropic.js";
import { wrapVercelAI } from "../src/instrumentations/vercel-ai.js";
import { wrapLangChain } from "../src/instrumentations/langchain.js";
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
  globalThis.fetch = ((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown = init?.body;
    try {
      body = init?.body ? JSON.parse(init.body as string) : null;
    } catch {
      // keep raw
    }
    captured.push({ url, body });
    return new Response("{}", { status: 200 });
  }) as unknown) as typeof fetch;
  resetDefaultClient();
  configure({ orgId: "org_test", apiKey: "key_test" });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await getDefaultClient().dispose();
  resetDefaultClient();
});

// ── OpenAI ────────────────────────────────────────────────────────

describe("wrapOpenAI", () => {
  it("emits llm_completion for non-streaming calls", async () => {
    const fakeClient = _fakeOpenAIClient({
      completion: {
        id: "cmpl-1",
        model: "gpt-4o-mini",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    });
    const wrapped = wrapOpenAI(fakeClient);

    const result = await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.choices[0].message.content).toBe("hi");
    await getDefaultClient().flush();

    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("openai");
    expect(completion?.payload.provider).toBe("openai");
    expect(completion?.payload.model).toBe("gpt-4o-mini");
    expect(completion?.payload.status).toBe("success");
  });

  it("emits llm_completion_stream for streaming calls", async () => {
    async function* chunkGen() {
      yield { choices: [{ delta: { content: "Hello" } }], model: "gpt-4o-mini" };
      yield { choices: [{ delta: { content: " world" } }], model: "gpt-4o-mini" };
      yield {
        choices: [{ finish_reason: "stop", delta: {} }],
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      };
    }
    const fakeClient = _fakeOpenAIClient({ stream: chunkGen() });
    const wrapped = wrapOpenAI(fakeClient);

    const stream = await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const collected: unknown[] = [];
    for await (const chunk of stream) collected.push(chunk);
    expect(collected.length).toBe(3);

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion_stream");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("openai");
    expect(completion?.metrics?.output_tokens).toBe(2);
    expect(completion?.metrics?.ttft_ms).toBeGreaterThanOrEqual(0);
    expect(completion?.metrics?.completion_duration_ms).toBeGreaterThanOrEqual(0);
    expect(completion?.payload.chunk_count).toBe(3);
  });

  it("is idempotent: double-wrapping returns the same client shape", () => {
    const fake = _fakeOpenAIClient({ completion: { id: "x" } });
    const a = wrapOpenAI(fake);
    const b = wrapOpenAI(a);
    expect(a).toBe(b);
  });

  it("captures errors without breaking the call", async () => {
    const fakeClient = _fakeOpenAIClient({
      createError: new Error("upstream failed"),
    });
    const wrapped = wrapOpenAI(fakeClient);
    await expect(
      wrapped.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [],
      }),
    ).rejects.toThrow("upstream failed");
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.payload.status).toBe("error");
    expect(completion?.payload.error_type).toBe("Error");
  });
});

// ── Anthropic ─────────────────────────────────────────────────────

describe("wrapAnthropic", () => {
  it("emits llm_completion for non-streaming calls", async () => {
    const fakeClient = _fakeAnthropicClient({
      message: {
        id: "msg_1",
        model: "claude-3-5-sonnet-20241022",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    });
    const wrapped = wrapAnthropic(fakeClient);
    const result = await wrapped.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content[0].text).toBe("hi");
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.sourceFormat).toBe("anthropic");
    expect(completion?.payload.provider).toBe("anthropic");
  });
});

// ── Vercel AI ─────────────────────────────────────────────────────

describe("wrapVercelAI", () => {
  it("emits llm_completion for generateText", async () => {
    const fakeAi = {
      generateText: async (args: any) => ({ text: "ok", ...args }),
      streamText: async (_args: any) => ({ textStream: _emptyAsync() }),
    };
    const wrapped = wrapVercelAI(fakeAi);
    const out = await wrapped.generateText({ model: "openai:gpt-4o-mini", prompt: "hi" });
    expect(out.text).toBe("ok");
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.sourceFormat).toBe("vercel-ai");
  });

  it("emits llm_completion_stream for streamText", async () => {
    async function* stream() {
      yield { type: "text-delta", textDelta: "Hello" };
      yield { type: "text-delta", textDelta: " world" };
    }
    const fakeAi = {
      generateText: async () => ({}),
      streamText: async () => ({ fullStream: stream(), textStream: stream() }),
    };
    const wrapped = wrapVercelAI(fakeAi);
    const result = await wrapped.streamText({ model: "openai:gpt-4o-mini", prompt: "hi" });
    for await (const _chunk of result.textStream) {
      // drain
    }
    // Give the consumer a tick to settle.
    await new Promise((r) => setTimeout(r, 20));
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const stream_ = events.find((e) => e.eventType === "llm_completion_stream");
    expect(stream_?.sourceFormat).toBe("vercel-ai");
  });
});

// ── LangChain ─────────────────────────────────────────────────────

describe("wrapLangChain", () => {
  it("emits llm_completion for invoke", async () => {
    const fakeModel = {
      invoke: async (msgs: any[]) => ({ content: `echo:${msgs.length}` }),
    };
    const wrapped = wrapLangChain(fakeModel);
    const out = await wrapped.invoke([{ content: "hi" }]);
    expect(out.content).toBe("echo:1");
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.sourceFormat).toBe("langchain");
    expect(completion?.payload.method).toBe("invoke");
  });

  it("emits llm_completion_stream for stream", async () => {
    async function* stream() {
      yield { content: "Hello" };
      yield { content: " world" };
    }
    const fakeModel = { stream: async () => stream() };
    const wrapped = wrapLangChain(fakeModel);
    const s = await wrapped.stream("hi");
    const collected: unknown[] = [];
    for await (const chunk of s) collected.push(chunk);
    expect(collected.length).toBe(2);
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const stream_ = events.find((e) => e.eventType === "llm_completion_stream");
    expect(stream_?.sourceFormat).toBe("langchain");
    expect(stream_?.payload.method).toBe("stream");
    expect(stream_?.payload.chunk_count).toBe(2);
  });
});

// ── Helpers ───────────────────────────────────────────────────────

function _flattenEvents(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (const req of captured) {
    if (Array.isArray(req.body)) {
      events.push(...(req.body as TelemetryEvent[]));
    } else if (req.body && typeof req.body === "object") {
      const b = req.body as { chunks?: unknown };
      if (b.chunks) {
        // chunks endpoint, not events
        continue;
      }
    }
  }
  return events;
}

async function* _emptyAsync() {
  // no-op
}

function _fakeOpenAIClient(opts: {
  completion?: any;
  stream?: AsyncIterable<any>;
  createError?: Error;
}): any {
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

function _fakeAnthropicClient(opts: { message?: any }): any {
  return {
    messages: {
      create: async (..._args: any[]) => opts.message,
    },
  };
}
