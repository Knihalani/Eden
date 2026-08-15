/**
 * Edge-case tests for the @eden-ai/sdk.
 *
 * Covers the bits of the public surface that don't have a clear
 * happy path: empty config, dispose without enqueue, dispose
 * twice, etc.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EdenSDK, resetDefaultClient } from "../src/client.js";

describe("EdenSDK edge cases", () => {
  beforeEach(() => {
    resetDefaultClient();
  });

  afterEach(() => {
    resetDefaultClient();
  });

  it("dispose is a no-op on a never-started client", async () => {
    const sdk = new EdenSDK({ orgId: "x" });
    await sdk.dispose();
  });

  it("dispose is idempotent (twice in a row is safe)", async () => {
    const sdk = new EdenSDK({ orgId: "x" });
    await sdk.dispose();
    await sdk.dispose();
  });

  it("emit after dispose is a no-op", async () => {
    const sdk = new EdenSDK({ orgId: "x" });
    await sdk.dispose();
    sdk.emit({
      eventId: "evt_1",
      tenantId: "x",
      projectId: "default",
      traceId: "trc_1",
      realm: "production",
      eventType: "agent_call",
      timestamp: new Date().toISOString(),
      sourceFormat: "openai",
      payload: {},
    });
    await sdk.flush();
  });

  it("flush() on empty queue is a no-op (does not POST)", async () => {
    const captured: { url: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      captured.push({ url: typeof input === "string" ? input : input.toString() });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const sdk = new EdenSDK({ orgId: "x", apiKey: "k" });
      await sdk.flush();
      expect(captured.length).toBe(0);
      await sdk.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("concurrent flush() calls share a single in-flight request", async () => {
    // ``flushIntervalMs: 0`` is intentional: this test asserts
    // the in-flight claim, not auto-flush timer behavior. A
    // non-zero interval would race with the manual flush and
    // produce flaky results.
    let postCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      postCount++;
      await new Promise((r) => setTimeout(r, 50));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const sdk = new EdenSDK({ orgId: "x", apiKey: "k", flushIntervalMs: 0 });
      for (let i = 0; i < 5; i++) {
        sdk.emit({
          eventId: `evt_${i}`,
          tenantId: "x",
          projectId: "default",
          traceId: `trc_${i}`,
          realm: "production",
          eventType: "agent_call",
          timestamp: new Date().toISOString(),
          sourceFormat: "openai",
          payload: {},
        });
      }
      await Promise.all([sdk.flush(), sdk.flush()]);
      expect(postCount).toBeLessThanOrEqual(1);
      await sdk.dispose();
    } finally