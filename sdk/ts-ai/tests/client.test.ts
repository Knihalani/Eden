/**
 * Tests for the core SDK client: config resolution, batching,
 * and chunk flush.
 *
 * These tests do not require the gateway to be running; we
 * stub `global.fetch` to capture POSTs and assert on the
 * payload shape.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EdenSDK, getDefaultClient, resetDefaultClient, setDefaultClient } from "../src/client.js";
import { type TelemetryEvent } from "../src/types.js";

interface CapturedRequest {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function makeFetchStub(capture: CapturedRequest[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
    let body: unknown = init?.body;
    try {
      body = init?.body ? JSON.parse(init.body as string) : null;
    } catch {
      // keep raw
    }
    capture.push({ url, body, headers });
    return new Response(JSON.stringify({ accepted: 1, rejected: 0, total: 1, source_format: "openai" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

let captured: CapturedRequest[];
let originalFetch: typeof fetch;

beforeEach(() => {
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchStub(captured) as typeof fetch;
  resetDefaultClient();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetDefaultClient();
});

describe("EdenSDK configuration", () => {
  it("resolves env-var fallbacks", () => {
    process.env.EDEN_ORG_ID = "org_env";
    process.env.EDEN_ORG_API_KEY = "key_env";
    const sdk = new EdenSDK();
    const cfg = sdk.getConfig();
    expect(cfg.orgId).toBe("org_env");
    expect(cfg.apiKey).toBe("key_env");
    expect(cfg.baseUrl).toBe("http://localhost:8000");
    delete process.env.EDEN_ORG_ID;
    delete process.env.EDEN_ORG_API_KEY;
  });

  it("applies explicit options over env vars", () => {
    process.env.EDEN_BASE_URL = "http://from-env";
    const sdk = new EdenSDK({ baseUrl: "http://from-opt" });
    expect(sdk.getConfig().baseUrl).toBe("http://from-opt");
    delete process.env.EDEN_BASE_URL;
  });

  it("throws in strict mode without orgId", () => {
    delete process.env.EDEN_ORG_ID;
    delete process.env.EDEN_ORG_API_KEY;
    expect(() => new EdenSDK({ strict: true })).toThrow(/orgId/);
  });

  it("strips trailing slashes from baseUrl", () => {
    const sdk = new EdenSDK({ baseUrl: "http://example.com///" });
    expect(sdk.getConfig().baseUrl).toBe("http://example.com");
  });
});

describe("EdenSDK event batching", () => {
  it("emits a single batched POST to /ingest/openai", async () => {
    const sdk = new EdenSDK({ orgId: "org_test", apiKey: "key_test" });
    for (let i = 0; i < 5; i++) {
      sdk.emit(_makeEvent("openai", "llm_completion", i));
    }
    await sdk.flush();
    expect(captured.length).toBe(1);
    const req = captured[0];
    expect(req.url).toBe("http://localhost:8000/orgs/org_test/ingest/openai");
    expect(req.headers["X-Org-Id"]).toBe("org_test");
    expect(req.headers["X-Org-Api-Key"]).toBe("key_test");
    expect(Array.isArray(req.body)).toBe(true);
    expect((req.body as unknown[]).length).toBe(5);
  });

  it("groups events by source_format into separate POSTs", async () => {
    const sdk = new EdenSDK({ orgId: "org_test", apiKey: "key_test" });
    sdk.emit(_makeEvent("openai", "llm_completion", 1));
    sdk.emit(_makeEvent("anthropic", "llm_completion", 2));
    sdk.emit(_makeEvent("anthropic", "llm_completion", 3));
    await sdk.flush();
    const urls = captured.map((c) => c.url).sort();
    expect(urls).toEqual([
      "http://localhost:8000/orgs/org_test/ingest/anthropic",
      "http://localhost:8000/orgs/org_test/ingest/openai",
    ]);
  });

  it("auto-flushes on overflow", async () => {
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      maxBatchSize: 3,
      flushIntervalMs: 60_000, // long; overflow path should win
    });
    for (let i = 0; i < 3; i++) {
      sdk.emit(_makeEvent("openai", "llm_completion", i));
    }
    // Yield once for the overflow path to schedule its async flush.
    await new Promise((r) => setTimeout(r, 5));
    expect(captured.length).toBeGreaterThanOrEqual(1);
  });

  it("drops events silently when orgId is unset (no error)", async () => {
    delete process.env.EDEN_ORG_ID;
    delete process.env.EDEN_ORG_API_KEY;
    const sdk = new EdenSDK();
    sdk.emit(_makeEvent("openai", "llm_completion", 1));
    await sdk.flush();
    expect(captured.length).toBe(0);
  });
});

describe("EdenSDK chunk flush", () => {
  it("POSTs chunks to /ingest/chunks", async () => {
    const sdk = new EdenSDK({ orgId: "org_test", apiKey: "key_test" });
    sdk.bufferChunk({
      eventId: "evt_1",
      traceId: "trc_1",
      chunkIndex: 0,
      deltaText: "hello",
      ttftMs: 10,
      itlMs: null,
      tpotMs: 10,
      receivedAtClientMs: Date.now(),
    });
    sdk.bufferChunk({
      eventId: "evt_1",
      traceId: "trc_1",
      chunkIndex: 1,
      deltaText: " world",
      ttftMs: 10,
      itlMs: 5,
      tpotMs: 7.5,
      receivedAtClientMs: Date.now(),
    });
    await sdk.flushChunks();
    expect(captured.length).toBe(1);
    const req = captured[0];
    expect(req.url).toBe("http://localhost:8000/orgs/org_test/ingest/chunks");
    const body = req.body as { chunks: unknown[] };
    expect(body.chunks.length).toBe(2);
  });
});

describe("getDefaultClient", () => {
  it("returns the same instance", () => {
    const a = getDefaultClient();
    const b = getDefaultClient();
    expect(a).toBe(b);
  });

  it("can be replaced via setDefaultClient", () => {
    const replacement = new EdenSDK({ orgId: "replacement" });
    setDefaultClient(replacement);
    expect(getDefaultClient()).toBe(replacement);
  });
});

function _makeEvent(
  sourceFormat: string,
  eventType: string,
  i: number,
): TelemetryEvent {
  return {
    eventId: `evt_${i}`,
    tenantId: "org_test",
    projectId: "default",
    traceId: `trc_${i}`,
    realm: "production",
    eventType,
    timestamp: new Date().toISOString(),
    sourceFormat,
    payload: { i, sourceFormat },
  };
}
