import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolveIngestPath } from "../src/ingest-format.js";
import { EdenSDK } from "../src/client.js";
import { runDoctor } from "../src/doctor.js";
import { configure, resetDefaultClient } from "../src/index.js";

describe("resolveIngestPath", () => {
  it.each([
    ["openai", "openai"],
    ["framework", "framework"],
    ["webhook", "webhook"],
    ["custom", "webhook"],
    ["eden-sdk-doctor", "webhook"],
    ["vercel-ai", "webhook"],
    ["langchain", "webhook"],
    ["mastra", "webhook"],
    ["pydantic-ai", "webhook"],
    ["", "webhook"],
  ] as const)("%s → %s", (raw, expected) => {
    expect(resolveIngestPath(raw)).toBe(expected);
  });
});

describe("ingest remap smoke (no 415)", () => {
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    urls.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (url.includes("/ingest/")) {
        const pathFmt = url.split("/ingest/")[1]?.split("?")[0] ?? "";
        if (
          ["custom", "vercel-ai", "langchain", "mastra", "eden-sdk-doctor", "pydantic-ai"].includes(
            pathFmt,
          )
        ) {
          return new Response(JSON.stringify({ detail: "unsupported" }), { status: 415 });
        }
        if (pathFmt === "webhook") {
          return new Response(
            JSON.stringify({ accepted: 1, rejected: 0, total: 1, source_format: "webhook" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts remapped formats to /ingest/webhook", async () => {
    const sdk = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
      flushIntervalMs: 60_000,
    });
    for (const sourceFormat of ["custom", "vercel-ai", "langchain", "mastra", "eden-sdk-doctor"]) {
      sdk.emit({
        eventId: `e_${sourceFormat}`,
        tenantId: "org_test",
        eventType: "agent.run",
        timestamp: new Date().toISOString(),
        sourceFormat,
        payload: { source_format: sourceFormat },
      });
    }
    const ok = await sdk.flush();
    expect(ok).toBe(true);
    const ingestUrls = urls.filter((u) => u.includes("/ingest/"));
    expect(ingestUrls.length).toBeGreaterThan(0);
    expect(ingestUrls.every((u) => u.includes("/ingest/webhook"))).toBe(true);
    expect(ingestUrls.some((u) => u.includes("/ingest/custom"))).toBe(false);
    await sdk.dispose();
  });

  it("doctor testEvent fails when ingest returns non-2xx", async () => {
    resetDefaultClient();
    configure({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
    });
    // Override: webhook returns 415 to simulate honesty check
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: "nope" }), { status: 415 });
    }) as typeof fetch;
    const report = await runDoctor({ emitTestEvent: true, timeoutMs: 3000 });
    const te = report.checks.find((c) => c.name === "testEvent");
    expect(te?.ok).toBe(false);
    expect(te?.message).toContain("2xx");
  });

  it("doctor testEvent ok on HTTP 2xx", async () => {
    resetDefaultClient();
    configure({
      orgId: "org_test",
      apiKey: "key_test",
      baseUrl: "http://localhost:8000",
    });
    const report = await runDoctor({ emitTestEvent: true, timeoutMs: 3000 });
    const te = report.checks.find((c) => c.name === "testEvent");
    expect(te?.ok).toBe(true);
    expect(te?.message).toContain("HTTP 2xx");
  });
});
