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
  it("returns wrap helpers and leaves http capture off by default", () => {
    const result = instrument();
    expect(result.wrapOpenAI).toBeFunction();
    expect(result.wrapMastra).toBeFunction();
    expect(result.detected).toHaveProperty("openai");
    expect(isHttpCaptureInstalled()).toBe(false);
  });

  it("wires Bedrock, Gemini, and LlamaIndex into wrap helpers + detection (previously missing)", () => {
    // Regression: providers.ts shipped full wrapBedrock/wrapGemini
    // implementations that were never surfaced through instrument()'s
    // detection or return value — a caller had to already know to
    // import wrapBedrock/wrapGemini directly. Same gap for the new
    // native wrapLlamaIndex instrumentor.
    const result = instrument();
    expect(result.wrapBedrock).toBeFunction();
    expect(result.wrapGemini).toBeFunction();
    expect(result.wrapLlamaIndex).toBeFunction();
    expect(result.detected).toHaveProperty("bedrock");
    expect(result.detected).toHaveProperty("gemini");
    expect(result.detected).toHaveProperty("llamaIndex");
  });

  it("enables http capture when httpCapture: true", () => {
    instrument({ httpCapture: true });
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

  it("emits on xAI (api.x.ai) fetch calls to a non-standard path — the host-suffix entry, not the generic path fallback, is what catches this", async () => {
    // `detectSourceFormat` has two independent ways to recognize an
    // LLM call: a host-suffix list (`LLM_HOST_SUFFIXES`) and a
    // path-fragment fallback (`LLM_PATH_FRAGMENTS`, e.g.
    // `/v1/chat/completions`) that matches regardless of host.
    // xAI's `api.x.ai` speaks the standard OpenAI
    // `/v1/chat/completions` shape, so that path was ALREADY caught
    // by the generic path-fragment fallback even before `api.x.ai`
    // was added to `LLM_HOST_SUFFIXES` -- adding the host-suffix
    // entry didn't close a blind spot for that case, it's
    // defense-in-depth for a hypothetical xAI endpoint that doesn't
    // follow the standard OpenAI path shape (e.g. an
    // OpenAI-`/v1/responses`-style endpoint, used here as a stand-in).
    // This test exercises exactly that: a path absent from
    // `LLM_PATH_FRAGMENTS`, so only the host-suffix entry can catch
    // it -- without the `api.x.ai` host-suffix, this call would NOT
    // have been captured.
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
          model: "grok-2-latest",
          choices: [{ message: { content: "hi" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    installHttpCapture();
    await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "grok-2-latest",
        input: [{ role: "user", content: "hi" }],
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
