/**
 * WS6 SDK tests: instrument(), http capture, mastra, doctor.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { configure, getDefaultClient, instrument, resetDefaultClient } from "../src/index.js";
import { runDoctor } from "../src/doctor.js";
import {
  installHttpCapture,
  isHttpCaptureInstalled,
  uninstallHttpCapture,
} from "../src/http-capture.js";
import { wrapMastra } from "../src/instrumentations/mastra.js";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetDefaultClient();
  configure({ orgId: "org_test", apiKey: "key_test", baseUrl: "http://localhost:8000" });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  uninstallHttpCapture();
  await getDefaultClient().dispose();
  resetDefaultClient();
});

describe("instrument()", () => {
  it("returns wrap helpers and enables http capture by default", () => {
    const result = instrument();
    expect(result.wrapOpenAI).toBeFunction();
    expect(result.wrapMastra).toBeFunction();
    expect(result.detected).toHaveProperty("openai");
    expect(isHttpCaptureInstalled()).toBe(true);
  });
});

describe("installHttpCapture", () => {
  it("emits on OpenAI-compatible fetch calls", async () => {
    const captured: RequestInit[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/ingest/")) {
        captured.push(init ?? {});
        return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: "cmpl-1",
          model: "gpt-4o-mini",
          choices: [{ message: { content: "hi" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    installHttpCapture();
    await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await getDefaultClient().flush();
    expect(captured.length).toBeGreaterThan(0);
  });
});

describe("wrapMastra", () => {
  it("wraps getAgent and instruments generate", async () => {
    const fakeAgent = {
      async generate() {
        return { text: "hello" };
      },
    };
    const mastra = {
      getAgent() {
        return fakeAgent;
      },
    };
    const wrapped = wrapMastra(mastra);
    const agent = (wrapped as { getAgent: () => typeof fakeAgent }).getAgent();
    await agent.generate();
    await getDefaultClient().flush();
  });
});

describe("runDoctor", () => {
  it("reports missing orgId when unset", async () => {
    resetDefaultClient();
    configure({ apiKey: "key", baseUrl: "http://localhost:8000" });
    const report = await runDoctor({ emitTestEvent: false });
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.name === "orgId" && !c.ok)).toBe(true);
  });
});
