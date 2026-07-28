/**
 * Tests for the LlamaIndex.TS auto-instrumentation.
 *
 * Mirrors the structure used by `instrumentations.test.ts` for the
 * other wrap* helpers: stub `global.fetch`, drive a fake query /
 * chat engine through `wrapLlamaIndex`, and assert on the captured
 * telemetry payloads.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseFetchBody } from "./_parseBody.js";
import { wireToEvent } from "../src/wire.js";
import { resetDefaultClient, getDefaultClient } from "../src/client.js";
import { configure } from "../src/trace.js";
import { wrapLlamaIndex } from "../src/instrumentations/llamaindex.js";
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

function _flattenEvents(): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  for (const req of captured) {
    if (Array.isArray(req.body)) {
      events.push(
        ...(req.body as Record<string, unknown>[]).map(
          (w) => wireToEvent(w) as unknown as TelemetryEvent,
        ),
      );
    }
  }
  return events;
}

describe("wrapLlamaIndex", () => {
  it("emits agent.run for a non-streaming query()", async () => {
    const fakeQueryEngine = {
      query: async (args: { query: string }) => ({
        response: `answer to ${args.query}`,
        sourceNodes: [{ id: "n1" }, { id: "n2" }],
      }),
    };
    const wrapped = wrapLlamaIndex(fakeQueryEngine);
    const result = await wrapped.query({ query: "what is eden?" });
    expect(result.response).toBe("answer to what is eden?");

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "agent.run");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("llamaindex");
    expect(completion?.payload.method).toBe("query");
    expect(completion?.payload.outcome).toBe("success");
    expect(completion?.metrics?.source_node_count).toBe(2);
    expect(completion?.tags).toContain("llama_index");
  });

  it("emits agent.run for a non-streaming chat()", async () => {
    const fakeChatEngine = {
      chat: async (args: { message: string }) => ({
        response: `reply to ${args.message}`,
        sourceNodes: [{ id: "n1" }],
      }),
    };
    const wrapped = wrapLlamaIndex(fakeChatEngine);
    await wrapped.chat({ message: "hi" });
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "agent.run");
    expect(completion?.payload.method).toBe("chat");
    expect(completion?.metrics?.source_node_count).toBe(1);
  });

  it("emits agent.run for retrieve() with a plain node array result", async () => {
    const fakeRetriever = {
      retrieve: async (_query: string) => [{ id: "n1" }, { id: "n2" }, { id: "n3" }],
    };
    const wrapped = wrapLlamaIndex(fakeRetriever);
    const nodes = await wrapped.retrieve("hi");
    expect(nodes.length).toBe(3);
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "agent.run");
    expect(completion?.payload.method).toBe("retrieve");
    expect(completion?.metrics?.source_node_count).toBe(3);
  });

  it("captures errors without breaking the call", async () => {
    const fakeQueryEngine = {
      query: async (): Promise<never> => {
        throw new Error("index unavailable");
      },
    };
    const wrapped = wrapLlamaIndex(fakeQueryEngine);
    await expect(wrapped.query({ query: "x" })).rejects.toThrow("index unavailable");
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "agent.run");
    expect(completion?.payload.outcome).toBe("error");
    expect(completion?.payload.error_type).toBe("Error");
    expect(completion?.payload.error_message).toBe("index unavailable");
  });

  it("wraps a streaming query() and buffers per-chunk events to /ingest/chunks", async () => {
    async function* stream() {
      yield { response: "Hel", delta: "Hel" };
      yield { response: "Hello", delta: "lo" };
      yield { response: "Hello!", delta: "!", sourceNodes: [{ id: "n1" }] };
    }
    const fakeQueryEngine = {
      query: async (_args: { query: string; stream?: boolean }) => stream(),
    };
    const wrapped = wrapLlamaIndex(fakeQueryEngine);
    const s = await wrapped.query({ query: "hi", stream: true });
    const collected: unknown[] = [];
    for await (const chunk of s as AsyncIterable<unknown>) collected.push(chunk);
    expect(collected.length).toBe(3);

    await getDefaultClient().flush();
    await getDefaultClient().flushChunks();
    await new Promise((r) => setTimeout(r, 50));

    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "agent.run");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("llamaindex");
    expect(completion?.metrics?.chunk_count).toBe(3);
    expect(completion?.metrics?.source_node_count).toBe(1);

    const chunkPosts = captured.filter(
      (c) => c.url.includes("/ingest/chunks") && Array.isArray((c.body as any)?.chunks),
    );
    const allChunks = chunkPosts.flatMap((c) => (c.body as any).chunks);
    expect(allChunks.length).toBe(3);
    expect(allChunks.map((c: any) => c.delta_text)).toEqual(["Hel", "lo", "!"]);
    expect(allChunks.map((c: any) => c.chunk_index)).toEqual([0, 1, 2]);
  });

  it("re-wrapping the original engine returns the same Proxy (not the bare original)", () => {
    const fakeQueryEngine = { query: async () => ({ response: "x" }) };
    const a = wrapLlamaIndex(fakeQueryEngine);
    const b = wrapLlamaIndex(fakeQueryEngine);
    const c = wrapLlamaIndex(a);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).not.toBe(fakeQueryEngine);
  });
});
