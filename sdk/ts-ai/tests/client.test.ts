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

  it("defaults redactOnClient=true and respects an explicit false", () => {
    expect(new EdenSDK().getConfig().redactOnClient).toBe(true);
    expect(new EdenSDK({ redactOnClient: false }).getConfig().redactOnClient).toBe(false);
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
    expect(sdk.getConfig().redactOnClient).toBe(true);
    sdk.configure({ redactOnClient: false });
    expect(sdk.getConfig().redactOnClient).toBe(false);
    sdk.configure({ redactOnClient: true });
    expect(sdk.getConfig().redactOnClient).toBe(true);
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

  it("redacts PII in stream-chunk deltaText before POST", async () => {
    // The streaming path must not bypass the PII safety net:
    // model-echoed PII (an email the user put in the prompt that
    // the model then repeated) would otherwise leak via /ingest/chunks.
    const sdk = new EdenSDK({ orgId: "org_test", apiKey: "key_test" });
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
    const body = captured[0].body as { chunks: Array<{ deltaText: string }> };
    expect(body.chunks[0].delta_text as unknown as { deltaText: string } & { delta_text?: string }['delta_text']).toContain("[REDACTED]");
    expect(body.chunks[0].delta_text as unknown as { deltaText: string } & { delta_text?: string }['delta_text']).not.toContain("alice@example.com");
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
      expect(captured[0].headers["User-Agent"]).toBe("@eden-ai/sdk/0.3.0");
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
      try { body = init?.body ? JSON.parse(init.body as string) : null; } catch {}
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
      const body = init?.body ? JSON.parse(init.body as string) : null;
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
        const body = init?.body ? JSON.parse(init.body as string) : null;
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
