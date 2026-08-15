/**
 * Tests for the core SDK client: config resolution, batching,
 * and chunk flush.
 *
 * These tests do not require the gateway to be running; we
 * stub `global.fetch` to capture POSTs and assert on the
 * payload shape.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFetchBody } from "./_parseBody.js";
import { EdenSDK, getDefaultClient, resetDefaultClient, setDefaultClient } from "../src/client.js";
import { OfflineQueue } from "../src/offline-queue.js";
import { type TelemetryEvent } from "../src/types.js";
import { SDK_VERSION } from "../src/version.js";

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
      // Preserve caller casing (User-Agent, X-Org-Id). Headers.forEach lowercases.
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v;
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          headers[k] = String(v);
        }
      }
    }
    let body: unknown = init?.body;
    try {
      body = parseFetchBody(init);
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
    expect(cfg.baseUrl).toBe("https://api.edenobservability.com");
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

  it("exposes timeoutS / maxQueueSize / disabled in resolved config", () => {
    const sdk = new EdenSDK({ timeoutS: 12, maxQueueSize: 100, disabled: true });
    const cfg = sdk.getConfig();
    expect(cfg.timeoutS).toBe(12);
    expect(cfg.maxQueueSize).toBe(100);
    expect(cfg.disabled).toBe(true);
  });

  it("defaults timeoutS=5, maxQueueSize=4096, disabled=false", () => {
    const sdk = new EdenSDK();
    const cfg = sdk.getConfig();
    expect(cfg.timeoutS).toBe(5);
    expect(cfg.maxQueueSize).toBe(4096);
    expect(cfg.disabled).toBe(false);
  });

  it("defaults redactOnClient=false and respects an explicit true", () => {
    expect(new EdenSDK().getConfig().redactOnClient).toBe(false);
    expect(new EdenSDK({ redactOnClient: true }).getConfig().redactOnClient).toBe(true);
  });

  it("configure() merges new opts over existing config", () => {
    const sdk = new EdenSDK({ orgId: "original", apiKey: "k1" });
    expect(sdk.getConfig().orgId).toBe("original");
    sdk.configure({ orgId: "updated" });
    expect(sdk.getConfig().orgId).toBe("updated");
    // Untouched field preserved.
    expect(sdk.getConfig().apiKey).toBe("k1");
  });

  it("configure() can flip redactOnClient at runtime", () => {
    const sdk = new EdenSDK({ orgId: "o", apiKey: "k" });
    expect(sdk.getConfig().redactOnClient).toBe(false);
    sdk.configure({ redactOnClient: true });
    expect(sdk.getConfig().redactOnClient).toBe(true);
    sdk.configure({ redactOnClient: false });
    expect(sdk.getConfig().redactOnClient).toBe(false);
  });
});

describe("EdenSDK event batching", () => {
  it("emits a single batched POST to /ingest/openai", async () => {
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
    });
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
    // Wire envelopes via eventToWire — snake_case top-level fields
    // including event_type (Python TraceEvent.payload already embeds
    // these; TS TelemetryEvent needs the converter at the boundary).
    const first = (req.body as Record<string, unknown>[])[0];
    expect(first.event_id).toBe("evt_0");
    expect(first.event_type).toBe("llm_completion");
    expect(first.source_format).toBe("openai");
    expect(first.payload).toEqual({ i: 0, sourceFormat: "openai" });
  });

  it("groups events by source_format into separate POSTs", async () => {
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
    });
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

  it("re-arms the flush timer when events are emitted during in-flight flush", async () => {
    // Reproduces a real bug: a callback that emits events while a
    // flush is in-flight used to sit in the queue forever because
    // the timer had been cleared at the start of flush() and was
    // never re-armed afterwards.
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      flushIntervalMs: 20,
      maxBatchSize: 100,
    });
    sdk.emit(_makeEvent("openai", "llm_completion", 0));
    // Start a flush and immediately emit a second event. With the
    // bug, the second event would never reach the server.
    const p = sdk.flush();
    sdk.emit(_makeEvent("openai", "llm_completion", 1));
    await p;
    // Wait for the re-armed timer to fire.
    await new Promise((r) => setTimeout(r, 50));
    // Two POSTs should have been sent, one per event.
    expect(captured.length).toBeGreaterThanOrEqual(2);
  });
});

describe("EdenSDK chunk flush", () => {
  it("POSTs chunks to /ingest/chunks", async () => {
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
    });
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

  it("redacts PII in stream-chunk deltaText before POST", async () => {
    // The streaming path must not bypass the PII safety net:
    // model-echoed PII (an email the user put in the prompt that
    // the model then repeated) would otherwise leak via /ingest/chunks.
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      redactOnClient: true,
    });
    sdk.bufferChunk({
      eventId: "evt_pii",
      traceId: "trc_pii",
      chunkIndex: 0,
      deltaText: "ping alice@example.com",
      ttftMs: 10,
      itlMs: null,
      tpotMs: 10,
      receivedAtClientMs: Date.now(),
    });
    await sdk.flushChunks();
    expect(captured.length).toBe(1);
    const body = captured[0].body as { chunks: Array<{ delta_text?: string; deltaText?: string }> };
    const text = body.chunks[0].delta_text ?? body.chunks[0].deltaText ?? "";
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("alice@example.com");
  });

  it("chunk redaction is a no-op when redactOnClient is false", async () => {
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      redactOnClient: false,
    });
    sdk.bufferChunk({
      eventId: "evt_off",
      traceId: "trc_off",
      chunkIndex: 0,
      deltaText: "ping alice@example.com",
      ttftMs: 10,
      itlMs: null,
      tpotMs: 10,
      receivedAtClientMs: Date.now(),
    });
    await sdk.flushChunks();
    const body = captured[captured.length - 1].body as { chunks: Array<{ deltaText: string }> };
    // The email survives — the operator disabled the safety net.
    expect(body.chunks[0].delta_text as unknown as { deltaText: string } & { delta_text?: string }['delta_text']).toBe("ping alice@example.com");
  });

  it("splits chunk POSTs into ≤1000 batches (BE ingest cap)", async () => {
    // Python ``_send_chunks`` caps each POST at
    // ``_INGEST_CHUNKS_MAX_PER_REQUEST`` (1000). A full buffer
    // drain (≤4096) must not ship as one request.
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
      maxBatchSize: 5000,
      maxChunkBuffer: 5000,
      flushIntervalMs: 60_000,
    });
    const now = Date.now();
    for (let i = 0; i < 1001; i++) {
      sdk.bufferChunk({
        eventId: "evt_split",
        traceId: "trc_split",
        chunkIndex: i,
        deltaText: `c${i}`,
        ttftMs: 1,
        itlMs: null,
        tpotMs: 1,
        receivedAtClientMs: now,
      });
    }
    await sdk.flushChunks();
    expect(captured.length).toBe(2);
    const n0 = (captured[0].body as { chunks: unknown[] }).chunks.length;
    const n1 = (captured[1].body as { chunks: unknown[] }).chunks.length;
    expect(n0).toBe(1000);
    expect(n1).toBe(1);
  });

  it("bisects and retries chunk POST on 413", async () => {
    // Mirrors Python ``_post_chunk_batch``: 413 with len>1 splits
    // mid and retries rather than permanently dropping.
    const bodies: number[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      let n = 0;
      try {
        const parsed = parseFetchBody(init) as { chunks?: unknown[] };
        n = parsed.chunks?.length ?? 0;
      } catch {
        n = 0;
      }
      bodies.push(n);
      if (n > 2) {
        return new Response("payload too large", { status: 413 });
      }
      return new Response(JSON.stringify({ accepted: n }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
      maxBatchSize: 100,
      maxChunkBuffer: 100,
      flushIntervalMs: 60_000,
    });
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      sdk.bufferChunk({
        eventId: "evt_413",
        traceId: "trc_413",
        chunkIndex: i,
        deltaText: `c${i}`,
        ttftMs: 1,
        itlMs: null,
        tpotMs: 1,
        receivedAtClientMs: now,
      });
    }
    await sdk.flushChunks();
    // First POST of 4 → 413; then 2 + 2 succeed.
    expect(bodies).toEqual([4, 2, 2]);
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


// ── New: retry with exponential backoff ────────────────────────────

describe("EdenSDK postJson retry behaviour", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    // Hard reset the fetch mock so prior tests don't pollute the call count.
    originalFetch = globalThis.fetch;
    resetDefaultClient();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const client = (await import("../src/client.js")).getDefaultClient();
    try { await client.dispose(); } catch { /* ignore */ }
    resetDefaultClient();
  });

  it("retries 5xx then succeeds without throwing", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Only count requests originating from THIS test's SDK, identified
      // by the unique apiKey. Other tests' in-flight fetches may leak
      // through globalThis.fetch and must be ignored.
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      if (hdrs["X-Org-Api-Key"] !== "k_retry") return new Response("{}", { status: 200 });
      calls++;
      if (calls < 3) return new Response("overloaded", { status: 503 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const sdk = new EdenSDK({ orgId: "o", apiKey: "k_retry", flushIntervalMs: 60000 });
    sdk.emit({
      eventId: "e1", tenantId: "o", projectId: "default", traceId: "t1",
      realm: "production", eventType: "agent.run",
      timestamp: new Date().toISOString(), sourceFormat: "openai",
      payload: { x: 1 },
    });
    await sdk.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(3);
  });

  it("does NOT retry a 401", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      if (hdrs["X-Org-Api-Key"] !== "k_retry") return new Response("{}", { status: 200 });
      calls++;
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    const sdk = new EdenSDK({ orgId: "o", apiKey: "k_retry", flushIntervalMs: 60000 });
    sdk.emit({
      eventId: "e1", tenantId: "o", projectId: "default", traceId: "t1",
      realm: "production", eventType: "agent.run",
      timestamp: new Date().toISOString(), sourceFormat: "openai",
      payload: { x: 1 },
    });
    await sdk.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
  });

  it("honours Retry-After header on 429", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      if (hdrs["X-Org-Api-Key"] !== "k_retry") return new Response("{}", { status: 200 });
      calls++;
      if (calls === 1) {
        return new Response("slow down", {
          status: 429,
          headers: { "retry-after": "0.01" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const sdk = new EdenSDK({ orgId: "o", apiKey: "k_retry", flushIntervalMs: 60000 });
    sdk.emit({
      eventId: "e1", tenantId: "o", projectId: "default", traceId: "t1",
      realm: "production", eventType: "agent.run",
      timestamp: new Date().toISOString(), sourceFormat: "openai",
      payload: { x: 1 },
    });
    await sdk.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2);
  });
});

// ── Offline spill policy (Python 0.3.2 parity) ─────────────────────

describe("EdenSDK offline spill policy", () => {
  let originalFetch: typeof fetch;
  let tmpDir: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetDefaultClient();
    tmpDir = mkdtempSync(join(tmpdir(), "eden-spill-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetDefaultClient();
  });

  it("does not spill permanent 4xx into the offline queue", async () => {
    globalThis.fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    const qpath = join(tmpDir, "offline.jsonl");
    const sdk = new EdenSDK({
      orgId: "o",
      apiKey: "k_spill4xx",
      baseUrl: "http://localhost:8000",
      flushIntervalMs: 60_000,
      offlineQueuePath: qpath,
      timeoutS: 1,
    });
    sdk.emit({
      eventId: "e1",
      tenantId: "o",
      projectId: "default",
      traceId: "t1",
      realm: "production",
      eventType: "agent.run",
      timestamp: new Date().toISOString(),
      sourceFormat: "openai",
      payload: { event_id: "bad" },
    });
    await sdk.flush();
    const q = new OfflineQueue(qpath);
    expect(q.size()).toBe(0);
  });

  it("spills after exhausting retryable 5xx", async () => {
    globalThis.fetch = (async () =>
      new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

    const qpath = join(tmpDir, "offline.jsonl");
    const sdk = new EdenSDK({
      orgId: "o",
      apiKey: "k_spill5xx",
      baseUrl: "http://localhost:8000",
      flushIntervalMs: 60_000,
      offlineQueuePath: qpath,
      timeoutS: 1,
    });
    sdk.emit({
      eventId: "e1",
      tenantId: "o",
      projectId: "default",
      traceId: "t1",
      realm: "production",
      eventType: "agent.run",
      timestamp: new Date().toISOString(),
      sourceFormat: "openai",
      payload: { event_id: "tmp" },
      metrics: { latency_ms: 42 },
      durationMs: 42,
    });
    await sdk.flush();
    const q = new OfflineQueue(qpath);
    expect(q.size()).toBeGreaterThanOrEqual(1);
    const drained = q.drain(10);
    // Full wire envelope — not just the nested payload.
    expect(drained[0]?.payload?.event_id).toBe("e1");
    expect(drained[0]?.payload?.trace_id).toBe("t1");
    expect(drained[0]?.payload?.event_type).toBe("agent.run");
    expect(drained[0]?.payload?.duration_ms).toBe(42);
    expect(drained[0]?.payload?.metrics).toEqual({ latency_ms: 42 });
    expect(drained[0]?.payload?.payload).toEqual({ event_id: "tmp" });
  });

  it("re-queues transient failures when offline queue is disabled", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;

    const sdk = new EdenSDK({
      orgId: "o",
      apiKey: "k_requeue",
      baseUrl: "http://localhost:8000",
      flushIntervalMs: 60_000,
      maxQueueSize: 100,
      timeoutS: 1,
      // no offlineQueuePath — memory re-queue path
    });
    sdk.emit({
      eventId: "e_requeue",
      tenantId: "o",
      projectId: "default",
      traceId: "t_requeue",
      realm: "production",
      eventType: "agent.run",
      timestamp: new Date().toISOString(),
      sourceFormat: "openai",
      payload: { keep: true },
    });
    const ok = await sdk.flush();
    expect(ok).toBe(false);
    // postJson retries 3x per flush attempt; events must still be in memory.
    expect(attempts).toBeGreaterThanOrEqual(3);
    // Second flush should see the same event again (re-queued).
    const attemptsBefore = attempts;
    await sdk.flush();
    expect(attempts).toBeGreaterThan(attemptsBefore);
    // Don't dispose against a 503 stub (would re-retry and hang the suite).
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accepted: 1 }), { status: 200 })) as unknown as typeof fetch;
    await sdk.dispose();
  });

  it("still drops permanent 4xx when offline queue is disabled", async () => {
    globalThis.fetch = (async () =>
      new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const sdk = new EdenSDK({
      orgId: "o",
      apiKey: "k_drop4xx",
      baseUrl: "http://localhost:8000",
      flushIntervalMs: 60_000,
      timeoutS: 1,
    });
    sdk.emit({
      eventId: "e_drop",
      tenantId: "o",
      projectId: "default",
      traceId: "t_drop",
      realm: "production",
      eventType: "agent.run",
      timestamp: new Date().toISOString(),
      sourceFormat: "openai",
      payload: { bad: true },
    });
    const ok = await sdk.flush();
    expect(ok).toBe(false);
    // Permanent failure must not re-queue (would poison forever).
    let secondAttempts = 0;
    globalThis.fetch = (async () => {
      secondAttempts += 1;
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    await sdk.flush();
    expect(secondAttempts).toBe(0);
    await sdk.dispose();
  });
});


describe("EdenSDK chunk flush concurrency", () => {
  it("two concurrent flushChunks() calls don't double-POST the same buffer", async () => {
    // Regression: ``flushChunks()`` had no atomic inflight claim
    // (unlike ``flush()``), so two concurrent calls could both
    // grab ``chunkBuffer`` and POST the same chunks twice. Mirror
    // the existing ``flush()`` inflight test pattern by stubbing
    // fetch with a deferred response.
    let release: (() => void) | null = null;
    const inflight = new Promise<void>((resolve) => { release = resolve; });
    let postCount = 0;
    globalThis.fetch = (async () => {
      postCount += 1;
      await inflight;
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const sdk = new EdenSDK({ orgId: "org_test", apiKey: "key_test" });
    sdk.bufferChunk({
      eventId: "evt_concur",
      traceId: "trc_concur",
      chunkIndex: 0,
      deltaText: "a",
      ttftMs: 1,
      itlMs: null,
      tpotMs: 1,
      receivedAtClientMs: Date.now(),
    });

    const p1 = sdk.flushChunks();
    const p2 = sdk.flushChunks();
    // Both promises are pending; release the in-flight fetch.
    release!();
    await Promise.all([p1, p2]);
    expect(postCount).toBe(1);
  });
});


describe("EdenSDK User-Agent header", () => {
  it("ships the current package.json version, not a stale literal", () => {
    // Regression: the header was hardcoded to ``@eden-ai/sdk/0.1.0``
    // and silently drifted across many patch releases, misleading
    // gateway operators triaging production traffic. The constant
    // is now pulled from ``package.json`` at build time.
    const sdk = new EdenSDK({ orgId: "org_test", apiKey: "key_test" });
    sdk.emit({
      eventId: "evt_ua",
      traceId: "trc_ua",
      sourceFormat: "openai",
      eventType: "llm_completion",
      timestamp: new Date().toISOString(),
      payload: { model: "gpt-4o" },
      metrics: {},
    });
    return sdk.flush().then(() => {
      expect(captured.length).toBe(1);
      expect(captured[0].headers["User-Agent"]).toBe(`@eden-ai/sdk/${SDK_VERSION}`);
    });
  });
});


describe("EdenSDK flushChunks waits for in-flight POST", () => {
  it("await flushChunks() drains every chunk buffered up to that point", async () => {
    // Regression: a previous fix added an atomic inflight claim
    // to flushChunks but made it return early when an in-flight
    // POST was running. The caller then observed only the
    // already-shipped chunks and asserted on them before the
    // re-arm timer could POST the rest. flushChunks now loops
    // until the buffer is empty and the in-flight POST has
    // settled, so callers can rely on ``await`` semantics.
    //
    // We use a custom captured counter (not the shared
    // ``captured`` from beforeEach) and a fetch that awaits a
    // gate promise — the gate is held until release() so the
    // first POST is observably in-flight when we buffer more
    // chunks and call flushChunks again.
    const localCaptured: { url: string; body: unknown }[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let postsInFlight = 0;
    let postsResolved = 0;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      postsInFlight += 1;
      await gate;
      postsResolved += 1;
      let body: unknown = undefined;
      try { body = parseFetchBody(init); } catch {}
      localCaptured.push({ url: String(url), body });
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const sdk = new EdenSDK({ orgId: "org_test", apiKey: "key_test" });
    // Buffer 1 chunk; maxBatchSize default (50) means the
    // timer will arm, NOT an immediate flush. We control the
    // timing by calling flushChunks explicitly below.
    sdk.bufferChunk({
      eventId: "evt_seq",
      traceId: "trc_seq",
      chunkIndex: 0,
      deltaText: "first",
      ttftMs: 1,
      itlMs: null,
      tpotMs: 1,
      receivedAtClientMs: Date.now(),
    });

    // Kick off a flush — POST starts, awaits the gate.
    const first = sdk.flushChunks();
    // While the first POST is in-flight (gated), buffer 2 more
    // chunks. With the bug, the second flushChunks returned
    // immediately, the second timer arm posted them later, and
    // ``await first`` then returned before the late POST. With
    // the fix, the second flushChunks must WAIT for the in-
    // flight POST to settle and drain the freshly buffered
    // chunks in a second POST.
    sdk.bufferChunk({
      eventId: "evt_seq",
      traceId: "trc_seq",
      chunkIndex: 1,
      deltaText: "second",
      ttftMs: 1,
      itlMs: null,
      tpotMs: 1,
      receivedAtClientMs: Date.now(),
    });
    sdk.bufferChunk({
      eventId: "evt_seq",
      traceId: "trc_seq",
      chunkIndex: 2,
      deltaText: "third",
      ttftMs: 1,
      itlMs: null,
      tpotMs: 1,
      receivedAtClientMs: Date.now(),
    });
    const second = sdk.flushChunks();

    // Release the gate: both the first POST and the queued
    // second POST can now complete.
    release!();
    await Promise.all([first, second]);

    // After both awaits resolve, ALL 3 chunks must have been
    // POSTed. With the bug, the first await resolved after the
    // first POST but the second POST hadn't run yet (it was on
    // a re-arm timer), so only 1 chunk would have shipped.
    expect(postsInFlight).toBe(2);
    expect(postsResolved).toBe(2);
    const totalChunks = localCaptured.reduce((acc, r) => {
      const b = r.body as { chunks?: unknown[] };
      return acc + (b.chunks?.length ?? 0);
    }, 0);
    expect(totalChunks).toBe(3);
  });
});


// ── New: dispose() must await in-flight POST ────────────────────────

describe("EdenSDK dispose() inflight race", () => {
  it("dispose() awaits the in-flight batch POST before its final flush", async () => {
    // Regression: the previous ``dispose()`` released the
    // ``inflight`` flag unconditionally and then called
    // ``flush()`` immediately. If a real flush was in flight at
    // that moment, the second ``flush()`` grabbed the same slot
    // and started a SECOND concurrent POST — racing the first
    // one for the same batch. The fix tracks the in-flight POST
    // promise (mirroring the chunk-path handling) and awaits it
    // before releasing the inflight slot. This test pins that
    // behaviour: a dispose() that returns before the in-flight
    // POST resolves would let a second POST start, which would
    // push ``postCount`` above 1 for the same single emit.
    let release: (() => void) | null = null;
    const inflight = new Promise<void>((resolve) => { release = resolve; });
    let postCount = 0;
    let lastBodyLen = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      postCount += 1;
      const body = parseFetchBody(init);
      lastBodyLen = Array.isArray(body) ? body.length : 0;
      await inflight;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const { EdenSDK, resetDefaultClient } = await import("../src/client.js");
      resetDefaultClient();
      const sdk = new EdenSDK({ orgId: "o", apiKey: "k", flushIntervalMs: 60000 });
      sdk.emit({
        eventId: "e1",
        tenantId: "o",
        projectId: "default",
        traceId: "t1",
        realm: "production",
        eventType: "agent.run",
        timestamp: new Date().toISOString(),
        sourceFormat: "openai",
        payload: { x: 1 },
      });

      // Kick off a flush. The POST is now in flight and
      // blocked on the gate.
      const first = sdk.flush();
      // Yield so the fetch is actually called.
      await new Promise((r) => setTimeout(r, 5));
      expect(postCount).toBe(1);
      // Now call dispose(). With the bug, dispose() would
      // release the inflight slot and the final flush() it
      // triggers would see a non-empty queue and start a
      // SECOND POST. With the fix, dispose() awaits the
      // in-flight POST before releasing the slot, so the
      // final flush() returns immediately.
      const disposeP = sdk.dispose();
      // Yield to let dispose() get past the early awaits.
      await new Promise((r) => setTimeout(r, 5));
      // At this point dispose() is still waiting on the
      // in-flight POST (which is still gated). The count
      // must still be 1.
      expect(postCount).toBe(1);
      // Release the gate. The first POST resolves; dispose()
      // unblocks; the final flush() sees an empty queue and
      // returns without a second POST.
      release!();
      await disposeP;
      await first;
      expect(postCount).toBe(1);
      expect(lastBodyLen).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


// ── Retry-After helper ──────────────────────────────────────────────

import { parseRetryAfterMs } from "../src/client.js";

describe("parseRetryAfterMs", () => {
  it("accepts integer delta-seconds", () => {
    expect(parseRetryAfterMs("5", 1)).toBe(5_000);
    expect(parseRetryAfterMs("0.25", 1)).toBe(250);
  });

  it("caps delta-seconds at 30s", () => {
    expect(parseRetryAfterMs("9999", 1)).toBe(30_000);
  });

  it("accepts a future HTTP-date", () => {
    // 10 seconds in the future.
    const future = new Date(Date.now() + 10_000).toUTCString();
    const delay = parseRetryAfterMs(future, 99_999);
    // Allow generous slack for clock + parse skew.
    expect(delay).toBeGreaterThanOrEqual(8_000);
    expect(delay).toBeLessThanOrEqual(12_000);
  });

  it("clamps a past HTTP-date to 0 (retry now)", () => {
    const past = new Date(Date.now() - 5 * 60_000).toUTCString();
    expect(parseRetryAfterMs(past, 99_999)).toBe(0);
  });

  it("falls back to the provided delay on garbage input", () => {
    expect(parseRetryAfterMs("not a date", 2_500)).toBe(2_500);
    expect(parseRetryAfterMs("", 2_500)).toBe(2_500);
    expect(parseRetryAfterMs("garbage", 99_999)).toBe(99_999);
  });
});


describe("EdenSDK postJson HTTP-date Retry-After", () => {
  it(
    "honours HTTP-date Retry-After on 503 (regression: NaN previously skipped the wait)",
    async () => {
      // Regression: parseFloat("Wed, 21 Oct 2015 07:28:00 GMT") is
      // NaN, Number.isFinite(NaN) is false, so the original
      // retry-after block skipped the backoff entirely -- the
      // SDK retried immediately and hammered the server. The
      // shared helper now parses the HTTP-date form and the
      // wait is observable as a >0ms delay.
      // 1500ms in the future, constructed inside the handler
      // so the header reflects the request time, not the test
      // setup time. Date.now() advances between the header
      // construction and the parseRetryAfterMs call, so a
      // generous offset (500ms would have been tight on a
      // slow CI box) keeps the assertion stable.
      const future = new Date(Date.now() + 1500).toUTCString();
      let calls = 0;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        if (hdrs["X-Org-Api-Key"] !== "k_http_date") {
          return new Response("{}", { status: 200 });
        }
        calls++;
        if (calls === 1) {
          return new Response("slow down", {
            status: 503,
            headers: { "retry-after": future },
          });
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k_http_date",
        flushIntervalMs: 60000,
      });
      sdk.emit({
        eventId: "e1", tenantId: "o", projectId: "default", traceId: "t1",
        realm: "production", eventType: "agent.run",
        timestamp: new Date().toISOString(), sourceFormat: "openai",
        payload: { x: 1 },
      });
      const start = Date.now();
      await sdk.flush();
      // The HTTP-date Retry-After set a ~1500ms backoff. After
      // waiting we should have made exactly 2 POSTs (the 503
      // then the 200) -- proving the HTTP-date was parsed AND
      // that the wait actually happened (if it hadn't, the
      // test would still pass on calls but the elapsed time
      // assertion would catch the regression).
      const elapsed = Date.now() - start;
      expect(calls).toBe(2);
      // The header is captured at test setup time; by the time
      // parseRetryAfterMs parses it (after the fetch round-trip
      // and JS event-loop scheduling), Date.now() has advanced
      // ~500ms. The effective delta is therefore ~1000ms instead
      // of the full 1500ms. The assertion is loose enough to
      // tolerate that skew but still proves the wait happened
      // (a regression where the wait is skipped would land at
      // elapsed ~= 0).
      expect(elapsed).toBeGreaterThanOrEqual(500);
    },
  );
});


describe("EdenSDK dispose() chunk-path inflight race", () => {
  it(
    "dispose() awaits the in-flight chunk POST before its final flushChunks()",
    async () => {
      // Mirror the batch-path dispose() regression test for
      // the chunk path: ``dispose()`` used to set
      // ``chunkInflight = false`` BEFORE awaiting the tracked
      // chunk POST, so a concurrent ``flushChunks()`` call
      // during the dispose() window could see the slot as
      // free and grab an empty buffer -- producing a phantom
      // POST with an empty body. Pin that this no longer
      // happens.
      let release: (() => void) | null = null;
      const inflight = new Promise<void>((resolve) => {
        release = resolve;
      });
      let postCount = 0;
      let lastBodyLen = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        postCount += 1;
        const body = parseFetchBody(init);
        lastBodyLen = Array.isArray(body?.chunks)
          ? body.chunks.length
          : 0;
        await inflight;
        return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
      }) as unknown as typeof fetch;

      try {
        const { EdenSDK, resetDefaultClient } = await import(
          "../src/client.js"
        );
        resetDefaultClient();
        const sdk = new EdenSDK({
          orgId: "o",
          apiKey: "k",
          flushIntervalMs: 60000,
        });
        sdk.bufferChunk({
          eventId: "e1",
          traceId: "t1",
          chunkIndex: 0,
          deltaText: "hello",
          ttftMs: 1,
          itlMs: null,
          tpotMs: null,
          receivedAtClientMs: 0,
        });

        // Kick off a chunk flush. The POST is now in flight
        // and blocked on the gate.
        const first = sdk.flushChunks();
        await new Promise((r) => setTimeout(r, 5));
        expect(postCount).toBe(1);
        // Call dispose(). With the bug, dispose() would
        // release the chunkInflight slot before awaiting the
        // in-flight POST, and the final flushChunks() it
        // triggers could produce a SECOND POST.
        const disposeP = sdk.dispose();
        await new Promise((r) => setTimeout(r, 5));
        // Still gated: count must still be 1.
        expect(postCount).toBe(1);
        release!();
        await disposeP;
        await first;
        expect(postCount).toBe(1);
        expect(lastBodyLen).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});


describe("EdenSDK chunk buffer cap", () => {
  it(
    "drops oldest chunks when maxChunkBuffer is exceeded",
    async () => {
      // Regression: TS ``bufferChunk`` had no upper bound
      // (parallel to the Python bug fixed in 0.2.13). A
      // runaway streaming producer could OOM the process
      // before this. With a tiny cap and 50 chunks pushed
      // via ``bufferChunk``, the buffer should hold only
      // the tail (8 entries) and the oldest 42 must have
      // been evicted.
      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k",
        flushIntervalMs: 60_000,
        maxChunkBuffer: 8,
        disabled: true, // don't actually POST; we only care about the buffer state.
      });
      for (let i = 0; i < 50; i++) {
        sdk.bufferChunk({
          eventId: `e${i}`,
          traceId: "t1",
          chunkIndex: i,
          deltaText: `chunk-${i}`,
          ttftMs: 1,
          itlMs: null,
          tpotMs: null,
          receivedAtClientMs: 0,
        });
      }
      // Access the private field via bracket for a unit
      // test — TS doesn't enforce runtime visibility.
      const buf = (sdk as unknown as { chunkBuffer: { chunkIndex: number }[] }).chunkBuffer;
      expect(buf.length).toBe(8);
      expect(buf[0].chunkIndex).toBe(42);
      expect(buf[buf.length - 1].chunkIndex).toBe(49);
    },
  );
});


describe("EdenSDK timer unref", () => {
  it(
    "arm'd flush timers call .unref() so a short-lived process can exit",
    () => {
      // Regression: the flush timer used to keep the
      // Node event loop alive. A short-lived CLI script
      // (``bun run script.ts``) that armed a flush timer
      // and finished its user-visible work would hang
      // for ``flushIntervalMs`` (default 250ms) before
      // the process could exit. Pin that the timer is
      // armed with ``.unref()`` so the loop can drain.
      //
      // Use a stub fetch so the SDK arms the timer
      // (``disabled: true`` short-circuits the emit path
      // before the timer is arm'd).
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch;
      try {
        const sdk = new EdenSDK({
          orgId: "o",
          apiKey: "k",
          flushIntervalMs: 60_000,
          disabled: false,
        });
        // Push an event so ``emit`` arms the flush timer.
        sdk.emit({
          eventId: "e1",
          tenantId: "o",
          projectId: "default",
          traceId: "t1",
          realm: "production",
          eventType: "agent.run",
          timestamp: new Date().toISOString(),
          sourceFormat: "openai",
          payload: { x: 1 },
        });
        const timer = (sdk as unknown as {
          flushTimer: { unref?: () => void } | null;
        }).flushTimer;
        expect(timer).not.toBeNull();
        expect(typeof timer?.unref).toBe("function");
        // Drain so the test doesn't leak timers across
        // cases (the next describe starts with
        // ``resetDefaultClient``).
        void sdk.flush();
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  it(
    "arm'd chunk timers call .unref() so a streaming producer doesn't pin the process",
    () => {
      // Same regression for the streaming chunk path --
      // without ``.unref()``, a producer that buffered
      // chunks and then exited would hold the process
      // open for ``flushIntervalMs`` after the user code
      // finished. Pin that the chunk timer is unref'd.
      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k",
        flushIntervalMs: 60_000,
        disabled: true,
      });
      sdk.bufferChunk({
        eventId: "e1",
        traceId: "t1",
        chunkIndex: 0,
        deltaText: "x",
        ttftMs: 1,
        itlMs: null,
        tpotMs: null,
        receivedAtClientMs: 0,
      });
      const timer = (sdk as unknown as {
        chunkTimer: { unref?: () => void } | null;
      }).chunkTimer;
      expect(timer).not.toBeNull();
      expect(typeof timer?.unref).toBe("function");
      sdk.flushChunks();
    },
  );
});


// ── New: error-sampling safety net covers status/error_type shapes ──

describe("EdenSDK error-sampling safety net (hasError broadening)", () => {
  it(
    "force-keeps `status: \"error\"` + `error_type` payloads (openai/anthropic/trace()/vercel-ai shape) under aggressive sampling",
    async () => {
      // Regression: `emit()`'s `hasError` check previously only
      // looked at a literal `error` field or `outcome === "error"`.
      // But `trace()`/`traceAgent()` (every `agent.run` event),
      // openai.ts, anthropic.ts, and vercel-ai.ts all signal errors
      // via `status: "error"` + `error_type` instead -- so under
      // `balanced`/`aggressive` sampling profiles, real error
      // traces from those paths were subject to the same random
      // keep-rate as any other event instead of being force-kept,
      // defeating `sampleKeepErrors: true` (the default).
      const sdk = new EdenSDK({
        orgId: "org_test",
        apiKey: "key_test",
        samplingProfile: "aggressive",
        sampleKeepErrors: true,
        flushIntervalMs: 60_000,
        maxBatchSize: 1000,
      });
      const N = 40;
      for (let i = 0; i < N; i++) {
        sdk.emit({
          eventId: `err${i}`,
          tenantId: "org_test",
          projectId: "default",
          traceId: `t${i}`,
          realm: "production",
          eventType: "llm_completion",
          timestamp: new Date().toISOString(),
          sourceFormat: "openai",
          payload: {
            status: "error",
            error_type: "Error",
            error_message: "boom",
          },
        });
      }
      await sdk.flush();
      // Aggressive sampling keeps ~5% by chance -- with 40 events,
      // it is vanishingly unlikely (< 1e-30) that all 40 survive
      // WITHOUT a force-keep. With the fix every one ships.
      expect(sdk.sampledOut).toBe(0);
      const body = captured[0]?.body as Record<string, unknown>[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(N);
    },
  );

  it(
    "force-keeps an `outcome: \"error\"` payload (providers.ts/mastra.ts shape) under aggressive sampling",
    async () => {
      const sdk = new EdenSDK({
        orgId: "org_test",
        apiKey: "key_test",
        samplingProfile: "aggressive",
        sampleKeepErrors: true,
        flushIntervalMs: 60_000,
        maxBatchSize: 1000,
      });
      sdk.emit({
        eventId: "outcome-err",
        tenantId: "org_test",
        projectId: "default",
        traceId: "t1",
        realm: "production",
        eventType: "llm_completion",
        timestamp: new Date().toISOString(),
        sourceFormat: "bedrock",
        payload: { outcome: "error" },
      });
      await sdk.flush();
      expect(sdk.sampledOut).toBe(0);
      expect(captured.length).toBe(1);
    },
  );

  it(
    "still samples non-error `status: \"success\"` payloads under aggressive sampling (no over-broadening)",
    async () => {
      const sdk = new EdenSDK({
        orgId: "org_test",
        apiKey: "key_test",
        samplingProfile: "aggressive",
        sampleKeepErrors: true,
        // Opt into client-side probabilistic dropping for this
        // assertion -- the SDK x server compounding guard makes this
        // `false` by default (see `sampling.ts`), under which a
        // non-"full" profile alone no longer probabilistically drops
        // anything on the client (only error/slow/force force-keeps
        // apply; the probabilistic decision is left to the server).
        clientProbabilisticSampling: true,
        flushIntervalMs: 60_000,
        maxBatchSize: 1000,
      });
      const N = 300;
      for (let i = 0; i < N; i++) {
        sdk.emit({
          eventId: `ok${i}`,
          tenantId: "org_test",
          projectId: "default",
          traceId: `t${i}`,
          realm: "production",
          eventType: "llm_completion",
          timestamp: new Date().toISOString(),
          sourceFormat: "openai",
          payload: { status: "success", error_type: undefined },
        });
      }
      await sdk.flush();
      // Sanity check the fix doesn't accidentally force-keep
      // everything: aggressive sampling (5% keep rate) over 300
      // successes should drop the vast majority.
      expect(sdk.sampledOut).toBeGreaterThan(0);
    },
  );
});


// ── New: postChunkBatch spill-to-offline-queue path ─────────────────

describe("EdenSDK postChunkBatch offline spill", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eden-chunk-spill-"));
  });

  it(
    "spills a failed chunk batch to the offline queue on transient (5xx) failure",
    async () => {
      // Regression: `postChunkBatch` only ever inspected the
      // `"too_large"` outcome from `postJson()` -- `"spill"` and
      // `"drop"` were never checked, so a chunk batch that failed
      // permanently (or after exhausting retries) was silently
      // dropped from memory with no offline-queue fallback, unlike
      // `postBatch()` which explicitly spills on `"spill"`.
      globalThis.fetch = (async () =>
        new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

      const qpath = join(tmpDir, "chunks-offline.jsonl");
      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k_chunkspill",
        baseUrl: "http://localhost:8000",
        flushIntervalMs: 60_000,
        offlineQueuePath: qpath,
        timeoutS: 1,
      });
      sdk.bufferChunk({
        eventId: "e1",
        traceId: "t1",
        chunkIndex: 0,
        deltaText: "x",
        ttftMs: 1,
        itlMs: null,
        tpotMs: null,
        receivedAtClientMs: 0,
      });
      await sdk.flushChunks();

      const q = new OfflineQueue(qpath);
      expect(q.size()).toBeGreaterThanOrEqual(1);
      const rows = q.peek(10);
      const chunkRow = rows.find((r) => r.sourceFormat === "chunks");
      expect(chunkRow).toBeDefined();
      const chunks = (chunkRow?.payload as { chunks?: unknown[] } | undefined)
        ?.chunks;
      expect(Array.isArray(chunks)).toBe(true);
      expect((chunks?.[0] as Record<string, unknown>)?.event_id).toBe("e1");
    },
  );

  it(
    "does not spill a chunk batch to the offline queue on permanent (4xx) failure",
    async () => {
      globalThis.fetch = (async () =>
        new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

      const qpath = join(tmpDir, "chunks-offline-4xx.jsonl");
      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k_chunkspill4xx",
        baseUrl: "http://localhost:8000",
        flushIntervalMs: 60_000,
        offlineQueuePath: qpath,
        timeoutS: 1,
      });
      sdk.bufferChunk({
        eventId: "e2",
        traceId: "t2",
        chunkIndex: 0,
        deltaText: "x",
        ttftMs: 1,
        itlMs: null,
        tpotMs: null,
        receivedAtClientMs: 0,
      });
      await sdk.flushChunks();

      const q = new OfflineQueue(qpath);
      expect(q.size()).toBe(0);
    },
  );
});


// ── New: flushOffline() -- ack-after-flush / timeout / sampling-bypass ──

describe("EdenSDK flushOffline()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eden-flush-offline-"));
  });

  it("returns 0 immediately when no offline queue is configured", async () => {
    const sdk = new EdenSDK({ orgId: "o", apiKey: "k" });
    const n = await sdk.flushOffline();
    expect(n).toBe(0);
  });

  it("returns 0 immediately when the offline queue is empty", async () => {
    const qpath = join(tmpDir, "empty.jsonl");
    const sdk = new EdenSDK({ orgId: "o", apiKey: "k", offlineQueuePath: qpath });
    const n = await sdk.flushOffline();
    expect(n).toBe(0);
  });

  it(
    "acks (deletes) durable rows only after a confirmed successful send",
    async () => {
      // Mirrors Python's `test_flush_offline_acks_after_flush`.
      const qpath = join(tmpDir, "flush-ack.jsonl");
      const q = new OfflineQueue(qpath);
      q.enqueue("openai", { event_id: "replay-1" });
      expect(q.size()).toBe(1);

      const posts: unknown[] = [];
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        posts.push(parseFetchBody(init));
        return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
      }) as unknown as typeof fetch;

      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k",
        baseUrl: "http://localhost:8000",
        offlineQueuePath: qpath,
        flushIntervalMs: 60_000,
      });
      const n = await sdk.flushOffline(10);
      expect(n).toBe(1);
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const freshQ = new OfflineQueue(qpath);
      expect(freshQ.size()).toBe(0);
    },
  );

  it(
    "replays a full wire envelope preserving eventId / traceId / eventType / metrics",
    async () => {
      const qpath = join(tmpDir, "flush-wire.jsonl");
      const q = new OfflineQueue(qpath);
      q.enqueue("openai", {
        event_id: "evt_wire_1",
        tenant_id: "o",
        project_id: "default",
        trace_id: "trc_wire_1",
        realm: "production",
        event_type: "llm_completion",
        timestamp: "2026-01-15T12:00:00.000Z",
        source_format: "openai",
        payload: { model: "gpt-4o" },
        metrics: { tokens: 12 },
        duration_ms: 88,
        name: "chat.completions",
      });

      let posted: unknown[] = [];
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        posted = parseFetchBody(init) as unknown[];
        return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
      }) as unknown as typeof fetch;

      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k",
        baseUrl: "http://localhost:8000",
        offlineQueuePath: qpath,
        flushIntervalMs: 60_000,
      });
      const n = await sdk.flushOffline(10);
      expect(n).toBe(1);
      expect(Array.isArray(posted)).toBe(true);
      const ev = posted[0] as Record<string, unknown>;
      expect(ev.event_id).toBe("evt_wire_1");
      expect(ev.trace_id).toBe("trc_wire_1");
      expect(ev.event_type).toBe("llm_completion");
      expect(ev.duration_ms).toBe(88);
      expect(ev.metrics).toEqual({ tokens: 12 });
      expect(ev.name).toBe("chat.completions");
      expect(ev.payload).toEqual({ model: "gpt-4o" });
    },
  );

  it(
    "does NOT ack when the send has not settled within the timeout budget",
    async () => {
      // Mirrors Python's `test_flush_offline_skips_ack_on_timeout`:
      // a slow (but eventually successful) send must not be acked
      // if `flushOffline()`'s timeout elapses first -- the row
      // stays durable so a later replay can retry it. Acking on
      // mere "attempt completed" (rather than confirmed settle)
      // is exactly the bug this guards against.
      const qpath = join(tmpDir, "flush-timeout.jsonl");
      const q = new OfflineQueue(qpath);
      q.enqueue("openai", { event_id: "replay-slow" });
      expect(q.size()).toBe(1);

      globalThis.fetch = (async () => {
        await new Promise((r) => setTimeout(r, 300));
        return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
      }) as unknown as typeof fetch;

      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k",
        baseUrl: "http://localhost:8000",
        offlineQueuePath: qpath,
        flushIntervalMs: 60_000,
        timeoutS: 5,
      });
      const n = await sdk.flushOffline(10, 50);
      expect(n).toBe(0);
      const freshQ = new OfflineQueue(qpath);
      expect(freshQ.size()).toBe(1);
    },
  );

  it(
    "bypasses ClientSampler entirely -- no sampledOut increment even under aggressive sampling",
    async () => {
      // Mirrors Python's `test_flush_offline_bypasses_sampling`:
      // durable offline replay must never be dropped by
      // `ClientSampler` -- a row that already survived the
      // offline-queue spill filter (only transient failures spill)
      // must not then be silently sampled away before being acked.
      const qpath = join(tmpDir, "flush-sampling.jsonl");
      const q = new OfflineQueue(qpath);
      q.enqueue("openai", { event_id: "replay-sampled" });

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ accepted: 1 }), {
          status: 200,
        })) as unknown as typeof fetch;

      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k",
        baseUrl: "http://localhost:8000",
        offlineQueuePath: qpath,
        flushIntervalMs: 60_000,
        samplingProfile: "aggressive",
        sampleKeepErrors: true,
      });
      const n = await sdk.flushOffline(10);
      expect(n).toBe(1);
      expect(sdk.sampledOut).toBe(0);
      const freshQ = new OfflineQueue(qpath);
      expect(freshQ.size()).toBe(0);
    },
  );

  it(
    "leaves a permanently-failing (4xx) row un-acked on disk",
    async () => {
      const qpath = join(tmpDir, "flush-4xx.jsonl");
      const q = new OfflineQueue(qpath);
      q.enqueue("openai", { event_id: "replay-bad" });

      globalThis.fetch = (async () =>
        new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

      const sdk = new EdenSDK({
        orgId: "o",
        apiKey: "k",
        baseUrl: "http://localhost:8000",
        offlineQueuePath: qpath,
        flushIntervalMs: 60_000,
        timeoutS: 1,
      });
      const n = await sdk.flushOffline(10);
      expect(n).toBe(0);
      const freshQ = new OfflineQueue(qpath);
      expect(freshQ.size()).toBe(1);
    },
  );
});


// ── New: process-exit safety net (registered once, best-effort) ─────

describe("EdenSDK process-exit safety net", () => {
  it(
    "registers beforeExit/SIGTERM/SIGINT hooks at most once no matter how many clients are constructed",
    () => {
      // Regression: `dispose()`'s doc comment claimed it was safe
      // to call from process-exit hooks, but nothing in the
      // package ever registered one -- spans/events sitting in the
      // queue/chunkBuffer were silently lost on abrupt process exit
      // unless the user manually called dispose()/flush(). The fix
      // registers a best-effort `beforeExit` + `SIGTERM`/`SIGINT`
      // safety net, guarded so it only registers once per process
      // (mirrors the Python SDK's `_atexit_registered` flag).
      const beforeExitBefore = process.listenerCount("beforeExit");
      const sigtermBefore = process.listenerCount("SIGTERM");
      const sigintBefore = process.listenerCount("SIGINT");

      // Construct several clients -- if registration weren't
      // guarded by a module-level flag, each constructor call
      // would add its own listener and these counts would grow
      // without bound.
      const clients = [
        new EdenSDK({ orgId: "hook-a" }),
        new EdenSDK({ orgId: "hook-b" }),
        new EdenSDK({ orgId: "hook-c" }),
      ];

      const beforeExitAfter = process.listenerCount("beforeExit");
      const sigtermAfter = process.listenerCount("SIGTERM");
      const sigintAfter = process.listenerCount("SIGINT");

      // Either the hooks were already registered by an earlier
      // test in this process (delta 0) or this is the first
      // `EdenSDK` ever constructed (delta 1) -- never more than 1
      // regardless of how many clients we just made.
      expect(beforeExitAfter - beforeExitBefore).toBeLessThanOrEqual(1);
      expect(beforeExitAfter - beforeExitBefore).toBeGreaterThanOrEqual(0);
      expect(sigtermAfter - sigtermBefore).toBeLessThanOrEqual(1);
      expect(sigintAfter - sigintBefore).toBeLessThanOrEqual(1);
      // At least one registration must have happened by now (this
      // test or an earlier one).
      expect(beforeExitAfter).toBeGreaterThanOrEqual(1);

      for (const c of clients) void c.dispose();
    },
  );

  it(
    "the registered beforeExit hook flushes/disposes every live client (best-effort, never throws)",
    async () => {
      const disposedMarkers = new Set<string>();
      const originalDispose = EdenSDK.prototype.dispose;
      EdenSDK.prototype.dispose = function (this: EdenSDK) {
        const marker = this.getConfig().orgId;
        if (marker) disposedMarkers.add(marker);
        return originalDispose.call(this);
      };
      const marker = `exit-hook-probe-${Date.now()}`;
      try {
        // Constructing the client both registers the hooks (if not
        // already registered by an earlier test) AND adds this
        // instance to the live-client set the hook iterates.
        const client = new EdenSDK({ orgId: marker, disabled: true });
        expect(() => {
          process.emit("beforeExit", 0 as unknown as number);
        }).not.toThrow();
        // The hook kicks off `dispose()` (async); function calls in
        // JS run synchronously up to their first `await`, so the
        // patched `dispose()` should already have been invoked by
        // the time `process.emit` returns -- but yield a tick for
        // extra safety across engines/versions.
        await new Promise((r) => setTimeout(r, 10));
        expect(disposedMarkers.has(marker)).toBe(true);
        await client.dispose();
      } finally {
        EdenSDK.prototype.dispose = originalDispose;
      }
    },
  );
});

describe("EdenSDK sent/failed counters", () => {
  it("increments sent on successful event ingest", async () => {
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
    });
    sdk.emit(_makeEvent("openai", "llm_completion", 1));
    expect(sdk.sent).toBe(0);
    await sdk.flush();
    expect(sdk.sent).toBe(1);
    expect(sdk.failed).toBe(0);
    await sdk.dispose();
  });

  it("credits sent from the server's accepted count on 2xx", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ accepted: 0, rejected: 1, total: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
    });
    sdk.emit(_makeEvent("openai", "llm_completion", 1));
    await sdk.flush();
    expect(sdk.sent).toBe(0);
    expect(sdk.failed).toBe(0);
    await sdk.dispose();
  });

  it("increments failed on permanent ingest failure", async () => {
    globalThis.fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as typeof fetch;
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
    });
    sdk.emit(_makeEvent("openai", "llm_completion", 1));
    expect(sdk.failed).toBe(0);
    await sdk.flush();
    expect(sdk.sent).toBe(0);
    expect(sdk.failed).toBe(1);
    await sdk.dispose();
  });

  it("increments sent for successful chunk ingest", async () => {
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
    });
    sdk.bufferChunk({
      eventId: "evt_1",
      traceId: "trc_1",
      chunkIndex: 0,
      deltaText: "hi",
      ttftMs: 1,
      itlMs: null,
      tpotMs: 1,
      receivedAtClientMs: Date.now(),
    });
    await sdk.flushChunks();
    expect(sdk.sent).toBe(1);
    expect(sdk.failed).toBe(0);
    await sdk.dispose();
  });
});
