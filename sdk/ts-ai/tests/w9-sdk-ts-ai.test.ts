/**
 * Wave 9 Agent 9.2 — instrument() export parity, TraceController export,
 * and bad-key (401) handling that must never throw into user code.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  configure,
  getDefaultClient,
  instrument,
  resetDefaultClient,
  TraceController,
  trace,
  wrapOpenAI,
} from "../src/index.js";
import { EdenSDK } from "../src/client.js";
import { runDoctor } from "../src/doctor.js";
import * as sdk from "../src/index.js";

/** Names used by docs FillInSnippet + portal INSTALL_BLOCKS TypeScript. */
const PORTAL_DOCS_EXPORTS = [
  "configure",
  "instrument",
  "trace",
  "getDefaultClient",
  "wrapOpenAI",
] as const;

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetDefaultClient();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await getDefaultClient().dispose();
  resetDefaultClient();
});

describe("instrument() export parity (FRONTEND_AUDIT P0-2)", () => {
  it("exports every symbol used by portal/docs install snippets", () => {
    for (const name of PORTAL_DOCS_EXPORTS) {
      expect(typeof (sdk as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("instrument() returns wrapOpenAI matching the FillInSnippet destructure", () => {
    const result = instrument();
    expect(result.wrapOpenAI).toBe(wrapOpenAI);
    expect(typeof result.wrapOpenAI).toBe("function");
    expect(result.detected).toHaveProperty("openai");
  });

  it("exports TraceController for imperative spans (docs/README)", () => {
    expect(typeof TraceController).toBe("function");
    const span = trace("w9-span");
    expect(span).toBeInstanceOf(TraceController);
    span.end();
  });
});

describe("bad-key handling", () => {
  it("flush on HTTP 401 does not throw and returns false", async () => {
    globalThis.fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    const client = new EdenSDK({
      orgId: "org_bad",
      apiKey: "sk_bad",
      baseUrl: "http://localhost:8000",
      flushIntervalMs: 60_000,
      timeoutS: 1,
    });
    client.emit({
      eventId: "e1",
      tenantId: "org_bad",
      projectId: "default",
      traceId: "t1",
      realm: "production",
      eventType: "agent.run",
      timestamp: new Date().toISOString(),
      sourceFormat: "openai",
      payload: { x: 1 },
    });
    let flushed: boolean | undefined;
    await expect(
      (async () => {
        flushed = await client.flush();
      })(),
    ).resolves.toBeUndefined();
    expect(flushed).toBe(false);
    expect(client.lastIngestHttpStatus).toBe(401);
    await client.dispose();
  });

  it("runDoctor surfaces HTTP 401 on testEvent without throwing", async () => {
    configure({
      orgId: "org_bad",
      apiKey: "sk_bad",
      baseUrl: "http://localhost:8000",
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;

    const report = await runDoctor({ emitTestEvent: true, timeoutMs: 2000 });
    const te = report.checks.find((c) => c.name === "testEvent");
    expect(te?.ok).toBe(false);
    expect(te?.message).toContain("HTTP 401");
    expect(te?.detail?.statusCode).toBe(401);
    expect(report.ok).toBe(false);
  });
});
