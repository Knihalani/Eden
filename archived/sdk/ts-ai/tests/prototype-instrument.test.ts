/**
 * FEAT-71 — real one-liner auto-instrumentation.
 *
 * Unlike `instrumentations.test.ts` (which exercises the per-instance
 * `wrap*()` Proxy factories against a hand-rolled fake client shape),
 * these tests exercise the CLASS-LEVEL patch against the ACTUAL
 * `openai` / `@anthropic-ai/sdk` npm packages: a real `OpenAI` /
 * `Anthropic` class, a freshly-constructed instance, and NO `wrap*()`
 * call anywhere at the call site. `instrument()` alone must be enough
 * for telemetry to show up — the real one-liner UX.
 *
 * `openai` and `@anthropic-ai/sdk` both ship a genuine dual CJS/ESM
 * package build: `require("openai")` and `(await import("openai"))
 * .default` are DIFFERENT class objects with DIFFERENT prototypes
 * (verified empirically under both Node and Bun). `instrument()`
 * therefore runs two independent patch passes — a synchronous one via
 * `require()` (`result.patched`) and an async one via dynamic
 * `import()` (`result.patchedAsync`) — and these tests exercise BOTH,
 * constructing one client from the CJS-required class and one from
 * the statically ESM-imported class.
 *
 * The only thing stubbed is the actual outbound HTTP call each SDK's
 * `Completions`/`Messages` resource class would otherwise make (so
 * the test suite doesn't need real API keys or network access) — we
 * replace `<Class>.prototype.create` with a canned implementation
 * BEFORE calling `instrument()`, so the patch captures OUR stub as
 * its "original" and calls through to it exactly like it would call
 * through to the real SDK's request logic. This is the class-level
 * equivalent of `instrumentations.test.ts`'s `_fakeOpenAIClient` /
 * `_fakeAnthropicClient` helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
// Static ESM import -- this is the module instance a real consuming
// app's `import OpenAI from "openai"` would resolve to.
import OpenAIESM from "openai";
import AnthropicESM from "@anthropic-ai/sdk";
import GroqESM from "groq-sdk";
import { parseFetchBody } from "./_parseBody.js";
import { wireToEvent } from "../src/wire.js";
import { resetDefaultClient, getDefaultClient } from "../src/client.js";
import { configure } from "../src/trace.js";
import { instrument } from "../src/instrument.js";
import {
  patchOpenAIPrototype,
  patchAnthropicPrototype,
  patchGroqPrototype,
  patchVercelAIPrototype,
  patchLangChainPrototype,
  patchGeminiPrototype,
  patchAllPrototypes,
  _unpatchAllForTests,
} from "../src/prototype-instrument.js";
import type { TelemetryEvent } from "../src/types.js";

const require = createRequire(import.meta.url);
// The CJS-required class -- a genuinely DIFFERENT object from
// `OpenAIESM` / `AnthropicESM` above (dual package build).
const OpenAICJSMod = require("openai") as { default?: unknown };
const OpenAICJS = (OpenAICJSMod.default ?? OpenAICJSMod) as any;
const AnthropicCJSMod = require("@anthropic-ai/sdk") as { default?: unknown };
const AnthropicCJS = (AnthropicCJSMod.default ?? AnthropicCJSMod) as any;
const GroqCJSMod = require("groq-sdk") as { default?: unknown };
const GroqCJS = (GroqCJSMod.default ?? GroqCJSMod) as any;
const GenerativeModelCJS = (require("@google/generative-ai") as { GenerativeModel: any })
  .GenerativeModel;
const BaseChatModelCJS = (
  require("@langchain/core/language_models/chat_models") as { BaseChatModel: any }
).BaseChatModel;

interface CapturedRequest {
  url: string;
  body: unknown;
}

let captured: CapturedRequest[];
let originalFetch: typeof fetch;
let originalOpenAICJSCreate: unknown;
let originalOpenAIESMCreate: unknown;
let originalAnthropicCJSCreate: unknown;
let originalAnthropicESMCreate: unknown;
let originalGroqCJSCreate: unknown;
let originalGroqESMCreate: unknown;
let originalGeminiCJSGenerateContent: unknown;
let originalLangChainCJSInvoke: unknown;

function _fakeOpenAICreate() {
  return async function (this: unknown, args: any) {
    if (args?.stream) {
      return (async function* () {
        yield { choices: [{ delta: { content: "Hello" } }], model: args.model };
        yield {
          choices: [{ finish_reason: "stop", delta: {} }],
          model: args.model,
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        };
      })();
    }
    return {
      id: "cmpl-proto-1",
      model: args?.model,
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    };
  };
}

function _fakeGroqCreate() {
  return async function (this: unknown, args: any) {
    return {
      id: "cmpl-groq-1",
      model: args?.model,
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "groq-hi" } },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
  };
}


function _fakeGeminiGenerateContent() {
  return async function (this: unknown, _args: any) {
    return {
      response: { text: () => "gemini-hi" },
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3 },
    };
  };
}

function _fakeLangChainInvoke() {
  return async function (this: unknown, _args: any) {
    return { content: "lc-hi", response_metadata: { model_name: "gpt-4o-mini" } };
  };
}

function _fakeAnthropicCreate() {
  return async function (this: unknown, args: any) {
    return {
      id: "msg_proto_1",
      model: args?.model,
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 2 },
    };
  };
}

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
  configure({ orgId: "org_test", apiKey: "key_test" });

  // Stub out the real HTTP-making method on EACH module instance's
  // resource class prototype (CJS AND ESM separately -- they're
  // different objects) BEFORE patching, so the eventual patched call
  // chain hits our canned response instead of a real network request.
  originalOpenAICJSCreate = OpenAICJS.Chat.Completions.prototype.create;
  OpenAICJS.Chat.Completions.prototype.create = _fakeOpenAICreate();
  originalOpenAIESMCreate = (OpenAIESM as any).Chat.Completions.prototype.create;
  (OpenAIESM as any).Chat.Completions.prototype.create = _fakeOpenAICreate();

  originalAnthropicCJSCreate = AnthropicCJS.Messages.prototype.create;
  AnthropicCJS.Messages.prototype.create = _fakeAnthropicCreate();
  originalAnthropicESMCreate = (AnthropicESM as any).Messages.prototype.create;
  (AnthropicESM as any).Messages.prototype.create = _fakeAnthropicCreate();

  originalGroqCJSCreate = GroqCJS.Chat.Completions.prototype.create;
  GroqCJS.Chat.Completions.prototype.create = _fakeGroqCreate();
  originalGroqESMCreate = (GroqESM as any).Chat.Completions.prototype.create;
  (GroqESM as any).Chat.Completions.prototype.create = _fakeGroqCreate();

  originalGeminiCJSGenerateContent = GenerativeModelCJS.prototype.generateContent;
  GenerativeModelCJS.prototype.generateContent = _fakeGeminiGenerateContent();

  originalLangChainCJSInvoke = BaseChatModelCJS.prototype.invoke;
  BaseChatModelCJS.prototype.invoke = _fakeLangChainInvoke();
});

afterEach(async () => {
  // Restore the real (or previously-patched) `create` implementations
  // and undo any class-level patch this test applied, so no
  // process-global mutation leaks into other test files.
  _unpatchAllForTests();
  OpenAICJS.Chat.Completions.prototype.create = originalOpenAICJSCreate;
  (OpenAIESM as any).Chat.Completions.prototype.create = originalOpenAIESMCreate;
  AnthropicCJS.Messages.prototype.create = originalAnthropicCJSCreate;
  (AnthropicESM as any).Messages.prototype.create = originalAnthropicESMCreate;
  GroqCJS.Chat.Completions.prototype.create = originalGroqCJSCreate;
  (GroqESM as any).Chat.Completions.prototype.create = originalGroqESMCreate;
  GenerativeModelCJS.prototype.generateContent = originalGeminiCJSGenerateContent;
  BaseChatModelCJS.prototype.invoke = originalLangChainCJSInvoke;
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

describe("instrument() prototype-level auto-instrumentation (FEAT-71)", () => {
  it("sanity: require('openai') and the static ESM import are genuinely different class objects (dual package)", () => {
    // This is the entire reason `instrument()` runs two patch passes.
    // If this ever stops being true (openai ships a unified build),
    // the sync pass alone would already cover both import styles --
    // but until then, both passes are load-bearing.
    expect(OpenAICJS).not.toBe(OpenAIESM);
    expect(OpenAICJS.Chat).not.toBe((OpenAIESM as any).Chat);
  });

  it("[CJS] auto-traces a freshly-constructed, non-wrapped require()'d OpenAI instance", async () => {
    const result = instrument();
    expect(result.patched.openai).toBe(true);

    // NOT wrapped with wrapOpenAI() -- a bare `new OpenAI()`.
    const client = new OpenAICJS({ apiKey: "test-key" });
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.choices[0].message.content).toBe("hi");

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("openai");
    expect(completion?.payload.provider).toBe("openai");
    expect(completion?.payload.model).toBe("gpt-4o-mini");
    expect(completion?.payload.status).toBe("success");
    const metrics = (completion?.metrics ?? {}) as Record<string, number>;
    expect(metrics.input_tokens).toBe(5);
    expect(metrics.output_tokens).toBe(1);
  });

  it("[CJS] auto-traces a freshly-constructed, non-wrapped OpenAI streaming call", async () => {
    instrument();
    const client = new OpenAICJS({ apiKey: "test-key" });
    const stream = await client.chat.completions.create({
      model: "gpt-4o-mini",
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
    expect(completion?.payload.chunk_count).toBe(2);
  });

  it("[CJS] tags a client pointed at api.x.ai as provider: xai (same OpenAI class, different baseURL)", async () => {
    instrument();
    const client = new OpenAICJS({ apiKey: "test-key", baseURL: "https://api.x.ai/v1" });
    await client.chat.completions.create({
      model: "grok-2-latest",
      messages: [{ role: "user", content: "hi" }],
    });
    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion?.payload.provider).toBe("xai");
  });

  it("[CJS] auto-traces a freshly-constructed, non-wrapped require()'d Anthropic instance", async () => {
    const result = instrument();
    expect(result.patched.anthropic).toBe(true);

    // NOT wrapped with wrapAnthropic() -- a bare `new Anthropic()`.
    const client = new AnthropicCJS({ apiKey: "test-key" });
    const response = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.content[0].text).toBe("hi");

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("anthropic");
    expect(completion?.payload.provider).toBe("anthropic");
    const metrics = (completion?.metrics ?? {}) as Record<string, number>;
    expect(metrics.input_tokens).toBe(7);
    expect(metrics.output_tokens).toBe(2);
  });

  it("[ESM] auto-traces a freshly-constructed, non-wrapped `import`ed OpenAI instance once patchedAsync resolves", async () => {
    const result = instrument();
    const asyncPatched = await result.patchedAsync;
    expect(asyncPatched.openai).toBe(true);

    // NOT wrapped with wrapOpenAI() -- a bare `new OpenAI()`, built
    // from the statically ESM-imported class (a different object
    // than `OpenAICJS` used in the [CJS] tests above).
    const client = new (OpenAIESM as any)({ apiKey: "test-key" });
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.choices[0].message.content).toBe("hi");

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    expect(completion?.payload.provider).toBe("openai");
  });

  it("[ESM] auto-traces a freshly-constructed, non-wrapped `import`ed Anthropic instance once patchedAsync resolves", async () => {
    const result = instrument();
    const asyncPatched = await result.patchedAsync;
    expect(asyncPatched.anthropic).toBe(true);

    const client = new (AnthropicESM as any)({ apiKey: "test-key" });
    const response = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.content[0].text).toBe("hi");

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    expect(completion?.payload.provider).toBe("anthropic");
  });

  it("calling instrument() twice is idempotent: no double-patch, no double-emit (CJS + ESM)", async () => {
    const first = instrument();
    const second = instrument();
    expect(first.patched.openai).toBe(true);
    expect(second.patched.openai).toBe(true);
    await Promise.all([first.patchedAsync, second.patchedAsync]);

    const cjsClient = new OpenAICJS({ apiKey: "test-key" });
    await cjsClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    const esmClient = new (OpenAIESM as any)({ apiKey: "test-key" });
    await esmClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completions = events.filter((e) => e.eventType === "llm_completion");
    // One event per real call (two calls above) -- if either class
    // had been wrapped twice this would be four, the same bug class
    // as the wrapOpenAI/wrapXai double-instrumentation regression
    // this suite guards against.
    expect(completions.length).toBe(2);
  });

  it("does not throw when a framework's shape doesn't match what's expected (defensive, same code path as 'not installed')", () => {
    // Simulate an SDK major-version reshuffle / a framework that
    // isn't actually installed: `patchOpenAIPrototype` must return
    // `false`, not throw, when the expected class shape isn't there.
    const savedChat = OpenAICJS.Chat;
    OpenAICJS.Chat = undefined;
    try {
      expect(() => patchOpenAIPrototype()).not.toThrow();
      expect(patchOpenAIPrototype()).toBe(false);
    } finally {
      OpenAICJS.Chat = savedChat;
    }

    const savedMessages = AnthropicCJS.Messages;
    AnthropicCJS.Messages = undefined;
    try {
      expect(() => patchAnthropicPrototype()).not.toThrow();
      expect(patchAnthropicPrototype()).toBe(false);
    } finally {
      AnthropicCJS.Messages = savedMessages;
    }

    // `patchAllPrototypes` (what `instrument()` actually calls) never
    // throws regardless of individual framework outcomes.
    expect(() => patchAllPrototypes()).not.toThrow();
  });

  it("instrument({ autoPatch: false }) opts out of class-level patching entirely", async () => {
    const result = instrument({ autoPatch: false });
    expect(result.patched.openai).toBe(false);
    expect(result.patched.anthropic).toBe(false);
    expect(result.patched.groq).toBe(false);
    expect(result.patched.vercelAi).toBe(false);
    expect(result.patched.langchain).toBe(false);
    expect(result.patched.gemini).toBe(false);
    expect(result.patched.mistral).toBe(false);
    const asyncPatched = await result.patchedAsync;
    expect(asyncPatched.openai).toBe(false);
    expect(asyncPatched.anthropic).toBe(false);
    // wrap* factories are still there -- additive, not a replacement.
    expect(result.wrapOpenAI).toBeFunction();
    expect(result.wrapAnthropic).toBeFunction();
  });

  it("[CJS] auto-traces a freshly-constructed, non-wrapped Groq instance", async () => {
    const result = instrument();
    expect(result.patched.groq).toBe(true);

    const client = new GroqCJS({ apiKey: "test-key" });
    const response = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.choices[0].message.content).toBe("groq-hi");

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("groq");
    expect(completion?.payload.provider).toBe("groq");
  });

  it("Vercel AI (`ai`) stays wrap-only: ESM namespace exports are not patchable", () => {
    expect(patchVercelAIPrototype()).toBe(false);
    const result = instrument();
    expect(result.patched.vercelAi).toBe(false);
    expect(result.wrapVercelAI).toBeFunction();
  });

  it("[CJS] auto-traces LangChain BaseChatModel.invoke via prototype patch", async () => {
    const result = instrument();
    expect(result.patched.langchain).toBe(true);

    class TestChatModel extends BaseChatModelCJS {
      _llmType() {
        return "test";
      }
    }
    const model = new TestChatModel({});
    const response = await model.invoke([{ role: "user", content: "hi" }]);
    expect(response.content).toBe("lc-hi");

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("langchain");
    expect(completion?.payload.provider).toBe("langchain");
  });

  it("[CJS] auto-traces Gemini GenerativeModel.generateContent via prototype patch", async () => {
    const result = instrument();
    expect(result.patched.gemini).toBe(true);

    const model = new GenerativeModelCJS("test-key", { model: "gemini-1.5-flash" });
    const response = await model.generateContent("hi");
    expect(response.response.text()).toBe("gemini-hi");

    await getDefaultClient().flush();
    const events = _flattenEvents();
    const completion = events.find((e) => e.eventType === "llm_completion");
    expect(completion).toBeDefined();
    expect(completion?.sourceFormat).toBe("gemini");
  });

  it("patchAllPrototypes reports all extended framework keys", () => {
    const patched = patchAllPrototypes();
    expect(patched).toHaveProperty("groq");
    expect(patched).toHaveProperty("vercelAi");
    expect(patched).toHaveProperty("langchain");
    expect(patched).toHaveProperty("gemini");
    expect(patched).toHaveProperty("mistral");
    expect(() => patchGroqPrototype()).not.toThrow();
    expect(() => patchVercelAIPrototype()).not.toThrow();
    expect(() => patchLangChainPrototype()).not.toThrow();
    expect(() => patchGeminiPrototype()).not.toThrow();
  });
});
