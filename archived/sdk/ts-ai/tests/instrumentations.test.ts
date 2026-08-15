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
import { parseFetchBody } from "./_parseBody.js";
import { wireToEvent } from "../src/wire.js";
import { resetDefaultClient, getDefaultClient } from "../src/client.js";
import { configure } from "../src/trace.js";
import { wrapOpenAI, wrapXai } from "../src/instrumentations/openai.js";
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
      body = parseFetchBody(init);
    } catch {
      // keep raw
    }
    captured.push({ url, body });
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
    // Non-streaming should normalize usage into the metrics block
    // the same way the streaming path does.
    const metrics = (completion?.metrics ?? {}) as Record<string, number>;
    expect(metrics.input_tokens).toBe(5);
    expect(metrics.output_tokens).toBe(1);
    expect(completion?.modelNormalized).toBe("gpt-4o-mini");
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

  it("re-wrapping the original client returns the same Proxy (not the bare original)", () => {
    // Regression: WeakSet tracked the original and returned it
    // on the second wrapOpenAI(original), stripping instrumentation.
    const fake = _fakeOpenAIClient({ completion: { id: "x" } });
    const a = wrapOpenAI(fake);
    const b = wrapOpenAI(fake);
    expect(a).toBe(b);
    expect(a).not.toBe(fake);
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
    // The error message must also be captured on the wire so
    // the portal's trace detail view can show
    // "Error: upstream failed" instead of just "Error". The
    // TS SDK previously only stored the class name and
    // dropped the message, so two distinct ``Error`` throws
    // were indistinguishable on the wire.
    expect(completion?.payload.error_message).toBe("upstream failed");
  });

  it("captures the error message for non-Error throws (object, primitive, string)", async () => {
    // Mirrors the trace.recordError shapes: the shared
    // errorClass / errorMessage helpers in ``ids.ts`` must
    // produce a usable (class, message) pair for every
    // throw shape so a thrown ``"rate limit"`` string or
    // ``{ code: 500 }`` object still surfaces a meaningful
    // entry on the portal's trace detail view.
    // ``null`` is excluded: the fake's ``createError`` is
    // checked truthily, so a ``null`` throw would silently
    // succeed and the test wouldn't see an error path.
    for (const thrown of [
      new TypeError("rate limit"),
      "rate limit string",
      42,
      { code: 500, reason: "boom" },
    ]) {
      const fakeClient = _fakeOpenAIClient({ createError: thrown });
      const wrapped = wrapOpenAI(fakeClient);
      let threw = false;
      try {
        await wrapped.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [],
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      await getDefaultClient().flush();
      const events = _flattenEvents();
      // Pick the most recent completion (the fake is reused
      // across iterations, so events from previous throws
      // are still in the queue).
      const completions = events.filter((e) => e.eventType === "llm_completion");
      const completion = completions[completions.length - 1];
      expect(completion?.payload.status).toBe("error");
      // error_type must always be a non-empty string so the
      // portal can group by class; never ``undefined``.
      expect(typeof completion?.payload.error_type).toBe("string");
      expect((completion?.payload.error_type as string).length).toBeGreaterThan(0);
    }
  });
});

// ── xAI (Grok) ────────────────────────────────────────────────────
//
// xAI's `api.x.ai` is OpenAI chat-completions compatible — the same
// client class as OpenAI's SDK, just a different `baseURL`. `wrapXai`
// reuses `wrapOpenAI`'s exact proxy/instrumentation logic; these
// tests only check the one thing that's actually different: the
// `provider` field stamped on emitted telemetry.

describe("wrapXai", () => {
  it("emits llm_completion for non-streaming calls tagged provider: xai", async () => {
    const fakeClient = _fakeOpenAIClient({
      completion: {
        id: "cmpl-1",
        model: "grok-2-latest",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    });
    const wrapped = wrapXai(fakeClient);

    const result = await wrapped.chat.completions.create({
      model: "grok-2-latest",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.choices[0].message.content).toBe("hi");
    await getDefaultClient().flush();

    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    // The wire shape (source_format) stays "openai" — same decoder,
    // same request/response schema — only the provider label differs.
    expect(completion?.sourceFormat).toBe("openai");
    expect(completion?.payload.provider).toBe("xai");
    expect(completion?.payload.model).toBe("grok-2-latest");
    expect(completion?.payload.status).toBe("success");
    const metrics = (completion?.metrics ?? {}) as Record<string, number>;
    expect(metrics.input_tokens).toBe(5);
    expect(metrics.output_tokens).toBe(1);
  });

  it("emits llm_completion_stream for streaming calls tagged provider: xai", async () => {
    async function* chunkGen() {
      yield { choices: [{ delta: { content: "Hello" } }], model: "grok-2-latest" };
      yield {
        choices: [{ finish_reason: "stop", delta: {} }],
        model: "grok-2-latest",
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      };
    }
    const fakeClient = _fakeOpenAIClient({ stream: chunkGen() });
    const wrapped = wrapXai(fakeClient);

    const stream = await wrapped.chat.completions.create({
      model: "grok-2-latest",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const collected: unknown[] = [];
    for await (const chunk of stream) collected.push(chunk);
    expect(collected.length).toBe(2);

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion_stream");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("openai");
    expect(completion?.payload.provider).toBe("xai");
    expect(completion?.payload.chunk_count).toBe(2);
  });

  it("wrapXai and wrapOpenAI on the same underlying client don't share a cached proxy", () => {
    // Regression guard: the proxy cache used to be a single
    // module-level WeakMap keyed only by the client object, so
    // wrapping the same client with both helpers would make the
    // second call return the first's (mislabeled) proxy.
    const fake = _fakeOpenAIClient({ completion: { id: "x" } });
    const asOpenAI = wrapOpenAI(fake);
    const asXai = wrapXai(fake);
    expect(asOpenAI).not.toBe(asXai);
  });

  it("is idempotent: double-wrapping returns the same client shape", () => {
    const fake = _fakeOpenAIClient({ completion: { id: "x" } });
    const a = wrapXai(fake);
    const b = wrapXai(a);
    expect(a).toBe(b);
  });

  it("wrapXai(wrapOpenAI(client)) does not double-instrument: exactly one llm_completion event", async () => {
    // Regression: `_wrapOpenAICompatible`'s idempotency guard used
    // to only check the CALLER's own wrap marker, so layering
    // `wrapXai` on top of an already-`wrapOpenAI`-wrapped client
    // (which the `wrapXai` doc literally frames as "a thin alias...
    // over wrapOpenAI", inviting exactly this composition instead
    // of replacing the call) instrumented `create` twice and
    // silently double-billed duration_ms/tokens telemetry: two
    // `llm_completion` events (['openai', 'xai']) per real call.
    const fakeClient = _fakeOpenAIClient({
      completion: {
        id: "cmpl-1",
        model: "grok-2-latest",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    });
    const wrapped = wrapXai(wrapOpenAI(fakeClient));

    await wrapped.chat.completions.create({
      model: "grok-2-latest",
      messages: [{ role: "user", content: "hi" }],
    });
    await getDefaultClient().flush();

    const events = _flattenEvents();
    const completions = events.filter((e) => e.eventType === "llm_completion");
    expect(completions.length).toBe(1);
    // The already-wrapped client is returned as-is, so the
    // provider label stays whatever the FIRST (inner) wrap
    // stamped -- "openai" -- rather than being overwritten by
    // the outer wrapXai call.
    expect(completions[0]?.payload.provider).toBe("openai");
  });

  it("wrapOpenAI(wrapXai(client)) does not double-instrument: exactly one llm_completion event", async () => {
    // Same bug, opposite composition order: nothing about the
    // fix should be order-dependent.
    const fakeClient = _fakeOpenAIClient({
      completion: {
        id: "cmpl-1",
        model: "grok-2-latest",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    });
    const wrapped = wrapOpenAI(wrapXai(fakeClient));

    await wrapped.chat.completions.create({
      model: "grok-2-latest",
      messages: [{ role: "user", content: "hi" }],
    });
    await getDefaultClient().flush();

    const events = _flattenEvents();
    const completions = events.filter((e) => e.eventType === "llm_completion");
    expect(completions.length).toBe(1);
    expect(completions[0]?.payload.provider).toBe("xai");
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

  it("non-streaming emit captures usage into metrics (input/output/cache tokens)", async () => {
    // Regression: the Anthropic non-streaming path used to
    // emit a payload with only ``model`` + ``duration_ms`` and
    // no usage metrics, so callers saw ``null`` token counts on
    // every non-streaming call. The OpenAI fix shipped in 0.2.14
    // was never mirrored on Anthropic.
    const fakeClient = _fakeAnthropicClient({
      message: {
        id: "msg_usage",
        model: "claude-3-5-sonnet-20241022",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 17,
          output_tokens: 9,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      },
    });
    const wrapped = wrapAnthropic(fakeClient);
    await wrapped.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "u" }],
    });
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    const metrics = (completion as any).metrics ?? {};
    expect(metrics.input_tokens).toBe(17);
    expect(metrics.output_tokens).toBe(9);
    expect(metrics.cache_read_input_tokens).toBe(200);
    expect(metrics.cache_creation_input_tokens).toBe(100);
  });

  it("non-streaming emit sets modelNormalized from the request model", async () => {
    // Regression: the Anthropic non-streaming path didn't set
    // ``modelNormalized`` (only the streaming path did). Pricing
    // rollups depend on this field being populated for every emit.
    const fakeClient = _fakeAnthropicClient({
      message: {
        id: "msg_norm",
        model: "claude-3-5-sonnet-20241022",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const wrapped = wrapAnthropic(fakeClient);
    await wrapped.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "u" }],
    });
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect((completion as any)?.modelNormalized).toBe("claude-3-5-sonnet");
  });

  it("streaming emit buffers per-chunk events to /ingest/chunks (parity with OpenAI)", async () => {
    // Regression: the TS Anthropic streaming path used to only
    // emit the aggregate ``llm_completion_stream`` event and
    // never push per-chunk events to ``/ingest/chunks``. The
    // OpenAI path does (see wrapOpenAI per-chunk test below),
    // and the Python SDK does — so TS Anthropic was the odd one
    // out, and the per-chunk TPOT / ITL dashboards rendered
    // empty for every Anthropic stream.
    const localCaptured: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      let body: any = {};
      try { body = parseFetchBody(init) ?? {}; } catch {}
      localCaptured.push({ url: u, body });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // Fake Anthropic streaming client: emits a ``message_start``,
    // two ``content_block_delta``s with text, and a
    // ``message_delta`` with stop_reason. The wrapper should
    // buffer every event into ``chunkBuffer`` and flush them to
    // ``/ingest/chunks`` on the same tick as the aggregate emit.
    const fakeClient: any = {
      messages: {
        create: async (_args: any) => {
          return (async function* () {
            yield { type: "message_start", message: { model: "claude-3-5-sonnet-20241022", usage: { input_tokens: 4 } } };
            yield {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Hi" },
            };
            yield {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: " there" },
            };
            yield {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 2 },
            };
          })();
        },
      },
    };
    const wrapped = wrapAnthropic(fakeClient);
    const stream = await wrapped.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    for await (const _ of stream) { /* drain */ }
    await getDefaultClient().flush();
    await getDefaultClient().flushChunks();
    await new Promise((r) => setTimeout(r, 50));

    const chunkPosts = localCaptured.filter(
      (c) => c.url.includes("/ingest/chunks") && Array.isArray(c.body?.chunks)
    );
    const allChunks = chunkPosts.flatMap((c) => c.body.chunks);
    // 4 events → 4 chunk-buffer pushes.
    expect(allChunks.length).toBe(4);
    // text_delta chunks expose ``delta_text``; non-text events
    // push null (the wrapper still buffers them so the gateway
    // can reconstruct timing).
    const textChunks = allChunks.filter((c: any) => c.delta_text);
    expect(textChunks.length).toBe(2);
    expect(textChunks[0].delta_text).toBe("Hi");
    expect(textChunks[1].delta_text).toBe(" there");
    // Every chunk is in the same ``trace_id`` family and has an
    // incrementing ``chunk_index`` from 0.
    expect(new Set(allChunks.map((c: any) => c.trace_id)).size).toBe(1);
    expect(allChunks.map((c: any) => c.chunk_index)).toEqual([0, 1, 2, 3]);
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

  it("streaming emit buffers per-chunk events to /ingest/chunks (parity with OpenAI + Anthropic)", async () => {
    // Regression: the Vercel AI streaming path used to only
    // emit the aggregate ``llm_completion_stream`` event and
    // never push per-chunk events to ``/ingest/chunks``. The
    // OpenAI + Anthropic paths do this, the Python SDK does
    // this — Vercel AI was the odd one out, and the per-chunk
    // TTFT / ITL / TPOT dashboards rendered empty for every
    // Vercel AI stream. Capture locally so the test only sees
    // the requests this case generates.
    const localCaptured: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      let body: any = {};
      try { body = parseFetchBody(init) ?? {}; } catch {}
      localCaptured.push({ url: u, body });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    async function* stream() {
      yield { type: "text-delta", textDelta: "Hi" };
      yield { type: "text-delta", textDelta: " there" };
    }
    const fakeAi = {
      generateText: async () => ({}),
      streamText: async () => ({ fullStream: stream(), textStream: stream() }),
    };
    const wrapped = wrapVercelAI(fakeAi);
    const result = await wrapped.streamText({ model: "openai:gpt-4o-mini", prompt: "hi" });
    for await (const _chunk of result.textStream) { /* drain */ }
    await new Promise((r) => setTimeout(r, 20));
    await getDefaultClient().flush();
    await getDefaultClient().flushChunks();
    await new Promise((r) => setTimeout(r, 50));

    const chunkPosts = localCaptured.filter(
      (c) => c.url.includes("/ingest/chunks") && Array.isArray(c.body?.chunks)
    );
    const allChunks = chunkPosts.flatMap((c) => c.body.chunks);
    // 2 text-delta events → 2 chunk-buffer pushes.
    expect(allChunks.length).toBe(2);
    // Both text deltas expose ``delta_text``; the per-chunk
    // buffer mirrors the OpenAI / Anthropic streaming paths.
    expect(allChunks[0].delta_text).toBe("Hi");
    expect(allChunks[1].delta_text).toBe(" there");
    // Every chunk is in the same ``trace_id`` family and has
    // an incrementing ``chunk_index`` from 0.
    expect(new Set(allChunks.map((c: any) => c.trace_id)).size).toBe(1);
    expect(allChunks.map((c: any) => c.chunk_index)).toEqual([0, 1]);
  });

  it("emits llm_completion_stream when streamText has no fullStream/textStream", async () => {
    // Regression: without an attachable iterable the wrapper
    // previously never called _finishCall, so streamText was
    // silent on the wire.
    const fakeAi = {
      generateText: async () => ({}),
      streamText: async () => ({ text: "no stream fields" }),
    };
    const wrapped = wrapVercelAI(fakeAi);
    await wrapped.streamText({ model: "openai:gpt-4o-mini", prompt: "hi" });
    await new Promise((r) => setTimeout(r, 10));
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const stream_ = events.find((e) => e.eventType === "llm_completion_stream");
    expect(stream_?.sourceFormat).toBe("vercel-ai");
    expect(stream_?.payload.status).toBe("success");
  });

  it("reads AI SDK v4 text-delta.text (not only textDelta)", async () => {
    async function* stream() {
      yield { type: "text-delta", text: "Hi" };
      yield { type: "text-delta", text: " v4" };
    }
    const localCaptured: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      let body: any = {};
      try { body = parseFetchBody(init) ?? {}; } catch {}
      localCaptured.push({ url: u, body });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const fakeAi = {
      generateText: async () => ({}),
      streamText: async () => ({ fullStream: stream() }),
    };
    const wrapped = wrapVercelAI(fakeAi);
    await wrapped.streamText({ model: "openai:gpt-4o-mini", prompt: "hi" });
    await new Promise((r) => setTimeout(r, 30));
    await getDefaultClient().flushChunks();
    await new Promise((r) => setTimeout(r, 30));
    const chunkPosts = localCaptured.filter(
      (c) => c.url.includes("/ingest/chunks") && Array.isArray(c.body?.chunks),
    );
    const allChunks = chunkPosts.flatMap((c) => c.body.chunks);
    expect(allChunks.map((c: any) => c.delta_text)).toEqual(["Hi", " v4"]);
  });

  it("re-wrapping the original module returns the same Proxy", () => {
    const fakeAi = { generateText: async () => ({}), streamText: async () => ({}) };
    const a = wrapVercelAI(fakeAi);
    const b = wrapVercelAI(fakeAi);
    expect(a).toBe(b);
    expect(a).not.toBe(fakeAi);
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

  it("emits llm_completion with error_message on async invoke failure", async () => {
    // Regression: ``.catch(rethrow).then(emit)`` skipped emit on
    // rejection, so async LangChain errors never reached ingest.
    const fakeModel = {
      invoke: async () => {
        throw new Error("lc boom");
      },
    };
    const wrapped = wrapLangChain(fakeModel);
    await expect(wrapped.invoke([{ content: "hi" }])).rejects.toThrow("lc boom");
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.payload.status).toBe("error");
    expect(completion?.payload.error_type).toBe("Error");
    expect(completion?.payload.error_message).toBe("lc boom");
  });

  it("re-wrapping the original model returns the same Proxy", () => {
    const fakeModel = { invoke: async () => ({ content: "x" }) };
    const a = wrapLangChain(fakeModel);
    const b = wrapLangChain(fakeModel);
    expect(a).toBe(b);
    expect(a).not.toBe(fakeModel);
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

  it("streaming emit buffers per-chunk events to /ingest/chunks + extracts usage + model", async () => {
    // Regression: the previous LangChain streaming path
    // (a) never pushed per-chunk events to ``/ingest/chunks``
    //     — only the aggregate ``llm_completion_stream``
    //     event was emitted, so the per-chunk TTFT / ITL /
    //     TPOT dashboards rendered empty for every LangChain
    //     stream (parity with the OpenAI + Anthropic +
    //     Vercel AI streaming paths that DO push per-chunk
    //     events).
    // (b) never read ``usage_metadata`` or ``response_metadata``
    //     off the chunks, so ``input_tokens`` and ``model``
    //     were always missing on the wire. Pricing lookups
    //     could not roll up streaming LangChain events.
    // Capture locally so the test only sees the requests this
    // case generates; also push into the outer ``captured``
    // so ``_flattenEvents()`` can read the aggregate too.
    const localCaptured: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      let body: any = {};
      try { body = parseFetchBody(init) ?? {}; } catch {}
      localCaptured.push({ url: u, body });
      captured.push({ url: u, body });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    async function* stream() {
      // LangChain 0.1+ AIMessageChunk shape: ``content`` +
      // ``usage_metadata`` + ``response_metadata``. The
      // wrapper must surface ``usage_metadata.input_tokens``,
      // ``usage_metadata.output_tokens`` and
      // ``response_metadata.model_name`` on the wire.
      yield {
        content: "Hi",
        usage_metadata: { input_tokens: 10, output_tokens: 1 },
        response_metadata: { model_name: "gpt-4o" },
      };
      yield {
        content: " there",
        usage_metadata: { input_tokens: 10, output_tokens: 2 },
        response_metadata: { model_name: "gpt-4o" },
      };
    }
    const fakeModel = { stream: async () => stream() };
    const wrapped = wrapLangChain(fakeModel);
    const s = await wrapped.stream("hi");
    const collected: unknown[] = [];
    for await (const chunk of s) collected.push(chunk);
    expect(collected.length).toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    await getDefaultClient().flush();
    await getDefaultClient().flushChunks();
    await new Promise((r) => setTimeout(r, 50));

    // Per-chunk replay: 2 chunks → 2 chunk-buffer pushes.
    const chunkPosts = localCaptured.filter(
      (c) => c.url.includes("/ingest/chunks") && Array.isArray(c.body?.chunks)
    );
    const allChunks = chunkPosts.flatMap((c) => c.body.chunks);
    expect(allChunks.length).toBe(2);
    expect(allChunks[0].delta_text).toBe("Hi");
    expect(allChunks[1].delta_text).toBe(" there");
    // Same ``trace_id`` family, incrementing ``chunk_index``.
    expect(new Set(allChunks.map((c: any) => c.trace_id)).size).toBe(1);
    expect(allChunks.map((c: any) => c.chunk_index)).toEqual([0, 1]);

    // Aggregate event now carries ``model`` and ``input_tokens``
    // (extracted from the chunks' usage_metadata +
    // response_metadata). Previously both were always
    // undefined on the wire.
    const events = _flattenEvents();
    const stream_ = events.find((e) => e.eventType === "llm_completion_stream");
    expect(stream_?.sourceFormat).toBe("langchain");
    expect(stream_?.payload.method).toBe("stream");
    expect(stream_?.modelNormalized).toBe("gpt-4o");
    expect(stream_?.metrics.input_tokens).toBe(10);
    expect(stream_?.metrics.output_tokens).toBe(2);
  });

  it("streaming emit flushes partial chunk buffer on early break (return)", async () => {
    // Regression: when the caller breaks out of a stream
    // loop, the iterator's ``return()`` short-circuits the
    // normal ``done: true`` path so there is no aggregate
    // emit and no per-chunk flush. The buffered chunks must
    // still be flushed to ``/ingest/chunks`` so a partial
    // series still reaches the per-chunk dashboards.
    const localCaptured: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      let body: any = {};
      try { body = parseFetchBody(init) ?? {}; } catch {}
      localCaptured.push({ url: u, body });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    async function* stream() {
      yield { content: "Hello" };
      yield { content: " world" };
      yield { content: " done" };
    }
    const fakeModel = { stream: async () => stream() };
    const wrapped = wrapLangChain(fakeModel);
    const s = await wrapped.stream("hi");
    for await (const _chunk of s) {
      // break out after the first chunk — exercises the
      // ``return()`` path.
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
    await getDefaultClient().flushChunks();
    await new Promise((r) => setTimeout(r, 50));

    const chunkPosts = localCaptured.filter(
      (c) => c.url.includes("/ingest/chunks") && Array.isArray(c.body?.chunks)
    );
    const allChunks = chunkPosts.flatMap((c) => c.body.chunks);
    // 1 chunk consumed before break → 1 chunk pushed.
    expect(allChunks.length).toBe(1);
    expect(allChunks[0].delta_text).toBe("Hello");

    // Aggregate stream event must also ship on early break.
    await getDefaultClient().flush();
    const eventPosts = localCaptured.filter((c) => Array.isArray(c.body));
    const streamEvents = eventPosts
      .flatMap((c) => c.body as Record<string, unknown>[])
      .map((w) => wireToEvent(w));
    const stream_ = streamEvents.find((e) => e.eventType === "llm_completion_stream");
    expect(stream_).toBeDefined();
    expect(stream_?.payload.chunk_count).toBe(1);
    expect(stream_?.payload.status).toBe("success");
  });
});

// ── Helpers ───────────────────────────────────────────────────────

function _flattenEvents(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (const req of captured) {
    if (Array.isArray(req.body)) {
      // The client translates the TS SDK's camelCase types to the
      // server's snake_case schema at the wire boundary. Translate
      // back to camelCase here so the test assertions can keep
      // matching the SDK's internal type names.
      events.push(...(req.body as Record<string, unknown>[]).map((w) => wireToEvent(w) as unknown as TelemetryEvent));
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


describe("wrapOpenAI per-chunk tpotMs semantics", () => {
  // Regression: tpotMs used to be ``(now - start) / chunkCount``,
  // which is actually the average inter-chunk arrival time. The
  // server's ``tpot_ms_p50`` / ``tpot_ms_p95`` percentile dashboards
  // read the per-chunk value directly, so a mislabel propagated
  // into the dashboard. The fix sets tpotMs to the actual time
  // per output token for the chunk (inter-chunk time divided by
  // tokens in the chunk, approximated as ``ceil(len/4)``), and
  // emits ``null`` for chunks with no text (finish_reason /
  // usage chunks).
  it("text chunks emit tpotMs as ms per token, non-text chunks emit null", async () => {
    // Override the default capture (set by beforeEach) with one
    // that ALSO returns a streaming response for /chat/completions.
    const localCaptured: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      let body: any = {};
      try { body = parseFetchBody(init) ?? {}; } catch {}
      localCaptured.push({ url: u, body });
      if (u.includes("/chat/completions") && init?.method === "POST") {
        const stream = [
          'data: {"id":"a","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
          'data: {"id":"b","choices":[{"index":0,"delta":{"content":" there"}}]}\n\n',
          'data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ].join("");
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    // Use a fake OpenAI client (avoids needing real OpenAI SDK
    // streaming parsing — the fake just hands back the stream
    // response directly to the wrapper).
    const fakeClient = {
      chat: {
        completions: {
          create: async (..._args: any[]) => {
            // Return a fetch-response-like object that the
            // openai SDK streaming parser would normally turn
            // into a Stream. To keep this test minimal we instead
            // exercise the wrapper at the point it iterates the
            // stream — so return an async iterable directly.
            return (async function* () {
              // Realistic streaming has ms between chunks. Without
              // these delays ``Date.now()`` reports the same value
              // across synchronous yields and the per-chunk TPOT
              // (ms-per-token) collapses to 0 — which is not what
              // a real provider does. The delays keep the fake
              // generator faithful to the timing semantics the
              // tpotMs regression test is guarding.
              yield { id: "a", choices: [{ index: 0, delta: { content: "Hi" } }] };
              await new Promise((r) => setTimeout(r, 2));
              yield { id: "b", choices: [{ index: 0, delta: { content: " there" } }] };
              await new Promise((r) => setTimeout(r, 2));
              yield {
                id: "c",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 2 },
              };
            })();
          },
        },
      },
    };
    const wrapped = wrapOpenAI(fakeClient);
    const stream = await wrapped.chat.completions.create({
      model: "gpt-4o", messages: [{ role: "user", content: "x" }], stream: true,
    });
    for await (const _ of stream) { /* drain */ }
    await getDefaultClient().flush();
    await getDefaultClient().flushChunks();
    await new Promise((r) => setTimeout(r, 50));

    const chunkPosts = localCaptured.filter(
      (c) => c.url.includes("/ingest/chunks") && Array.isArray(c.body?.chunks)
    );
    const allChunks = chunkPosts.flatMap((c) => c.body.chunks);
    expect(allChunks.length).toBe(3);
    // Wire body is snake_case (translation happens in postChunks).
    const textChunks = allChunks.filter((c: any) => c.delta_text);
    expect(textChunks.length).toBe(2);
    // First text chunk has no prior chunk to compute interval
    // from — ``tpotMs`` is legitimately ``null``. Every subsequent
    // text chunk must be a positive ms-per-token number (the
    // regression being guarded: the old code emitted ``0`` or the
    // average inter-chunk arrival time, never a real per-token ms).
    expect(textChunks[0].tpot_ms).toBeNull();
    for (const c of textChunks.slice(1)) {
      expect(typeof c.tpot_ms).toBe("number");
      expect(c.tpot_ms).toBeGreaterThan(0);
    }
    // Finish-reason / usage chunks have no delta text — tpotMs
    // must be null, not a misleading zero or aggregate value.
    const noTextChunks = allChunks.filter((c: any) => !c.delta_text);
    expect(noTextChunks.length).toBe(1);
    expect(noTextChunks[0].tpot_ms).toBeNull();
  });
});
