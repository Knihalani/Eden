/**
 * Prototype-level (class-level) auto-instrumentation.
 *
 * The existing `wrap*()` helpers under `src/instrumentations/` are
 * per-instance: they return a `Proxy` around a client the CALLER
 * constructed, so every call site needs `const client =
 * wrapOpenAI(new OpenAI())`. Python's `eden.instrument()` instead
 * monkey-patches the framework's class *once*, at import/init time —
 * every instance created afterwards, anywhere in the app, is traced
 * automatically with zero further code changes.
 *
 * This module gives the TS SDK the same class-level behavior for the
 * frameworks it can safely reach. It `require()`s (or dynamically
 * `import()`s) the framework module once and replaces the relevant
 * prototype method or module export in place — with the *exact same*
 * instrumentation logic the per-instance `wrap*` Proxies use — so the
 * captured span/event shape is identical regardless of mechanism.
 *
 * ## Why not `import-in-the-middle`?
 *
 * We deliberately avoid loader hooks (`require-in-the-middle` /
 * `import-in-the-middle`). They add a runtime dependency, complicate
 * bundlers (Next.js, esbuild, Bun), and are unnecessary for the
 * frameworks we can reach via a one-time `require()` / dynamic
 * `import()` at `instrument()` call time — before the consuming app
 * constructs its first client. Prototype patching is lighter, works
 * in every Node 18+ runtime without loader registration, and matches
 * how the Python SDK patches class methods directly.
 *
 * A plain `require()` alone is NOT enough for dual-package SDKs:
 * `openai`, `@anthropic-ai/sdk`, and `groq-sdk` all ship separate
 * CJS and ESM builds that resolve to genuinely different class objects
 * (`require("openai") !== (await import("openai")).default`). This
 * module therefore runs two passes for those packages:
 *   - Sync pass via `require()` — CJS consumers and TS compiled to
 *     `"module": "commonjs"`.
 *   - Async pass via dynamic `import()` — native ESM consumers.
 *
 * `instrument()` runs the sync pass immediately (so `patched` is
 * available synchronously) and kicks off the async pass without
 * awaiting it (`patchedAsync`).
 *
 * ## Auto-patch coverage (FEAT-71)
 *
 * | Framework | Patch target | Notes |
 * |-----------|--------------|-------|
 * | OpenAI (+ xAI) | `Chat.Completions.prototype.create` | dual CJS/ESM |
 * | Anthropic | `Messages.prototype.create` | dual CJS/ESM |
 * | Groq | `Chat.Completions.prototype.create` | OpenAI-shaped |
 * | LangChain | `BaseChatModel.prototype` (`invoke`, …) | class-level wrapLangChain |
 * | Gemini (legacy) | `GenerativeModel.prototype.generateContent` | `@google/generative-ai` |
 * | Gemini (new) | `Models.prototype.generateContent` | `@google/genai` when present |
 * | Mistral | `Chat.prototype.complete` / `.stream` | `@mistralai/mistralai` |
 *
 * **Vercel AI (`ai`) is wrap-only:** its exports (`generateText`, …) live on
 * an ESM module namespace object whose bindings are non-configurable — they
 * cannot be reassigned or `defineProperty`-patched from outside the module
 * (`TypeError: Cannot replace module namespace object's binding's value`).
 * Use `wrapVercelAI(ai)` (or `result.wrapVercelAI` from `instrument()`).
 * Loader hooks (`import-in-the-middle`) could intercept at load time but add
 * a required `--import` startup flag for ESM apps — intentionally deferred.
 *
 * Still wrap-only (no stable global prototype to patch):
 * Cohere (dual client shapes), Bedrock (command `send` pattern),
 * Mastra, LlamaIndex.TS — use the returned `wrap*` factories.
 *
 * Every framework is loaded and patched inside its own try/catch —
 * missing packages or unexpected shapes are reported `false`, never
 * thrown from `instrument()`.
 */

import { _safeRequire } from "./detect-installed.js";
import { _instrumentedCreate as openaiInstrumentedCreate } from "./instrumentations/openai.js";
import { _instrumentedCreate as anthropicInstrumentedCreate } from "./instrumentations/anthropic.js";
import { _instrumentedCreate as groqInstrumentedCreate } from "./instrumentations/groq.js";
import {
  LANGCHAIN_METHODS_TO_WRAP,
  _wrapLangChainMethod,
  type LangChainMethodName,
} from "./instrumentations/langchain.js";
import {
  _instrumentedComplete as mistralInstrumentedComplete,
  _instrumentedStream as mistralInstrumentedStream,
} from "./instrumentations/mistral.js";
import { _instrumentedProviderMethod } from "./instrumentations/providers.js";
import type { TraceOptions } from "./types.js";

/** Result of a single `instrument()` call's prototype-patch pass. */
export interface PrototypePatchResult {
  openai: boolean;
  anthropic: boolean;
  groq: boolean;
  vercelAi: boolean;
  langchain: boolean;
  gemini: boolean;
  mistral: boolean;
}

/** All-false patch result — used when `autoPatch: false`. */
export const EMPTY_PROTOTYPE_PATCH_RESULT: PrototypePatchResult = {
  openai: false,
  anthropic: false,
  groq: false,
  vercelAi: false,
  langchain: false,
  gemini: false,
  mistral: false,
};

const PATCH_MARKER = Symbol.for("@eden-ai/sdk.prototypePatched");

interface PatchRecord {
  target: Record<string, unknown>;
  prop: string;
  original: unknown;
}

const _patchRecords: PatchRecord[] = [];

function _isMarked(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    (fn as unknown as { [k: symbol]: unknown })[PATCH_MARKER] === true
  );
}

function _patchFunctionProperty(
  target: Record<string, unknown> | null | undefined,
  prop: string,
  patchedFn: (...args: unknown[]) => unknown,
): boolean {
  if (!target || typeof target[prop] !== "function") return false;
  if (_isMarked(target[prop])) return true;
  const original = target[prop] as (...args: unknown[]) => unknown;
  (patchedFn as unknown as { [k: symbol]: unknown })[PATCH_MARKER] = true;
  target[prop] = patchedFn;
  _patchRecords.push({ target, prop, original });
  return true;
}

function _resolveDefaultExport<T>(mod: { default?: T } | T | null | undefined): T | null {
  if (!mod) return null;
  // CJS/ESM interop: the `require()` result is often a function
  // (the default export) that ALSO carries sibling named exports on
  // itself — `groq-sdk` and `ai` both resolve this way under Bun/
  // Node. Check `.default` for both objects AND functions.
  if (
    (typeof mod === "object" || typeof mod === "function") &&
    "default" in (mod as object)
  ) {
    const d = (mod as { default?: T }).default;
    if (d !== undefined) return d;
  }
  return mod as T;
}

function _applyOpenAIPatch(
  OpenAICls: { Chat?: { Completions?: { prototype?: Record<string, unknown> } } } | null | undefined,
  opts: TraceOptions,
): boolean {
  const proto = OpenAICls?.Chat?.Completions?.prototype;
  if (!proto || typeof proto.create !== "function") return false;
  if (_isMarked(proto.create)) return true;

  const original = proto.create as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]): unknown {
    const client = (this as { _client?: { baseURL?: unknown } } | undefined)?._client;
    const baseURL = typeof client?.baseURL === "string" ? client.baseURL : "";
    const provider = baseURL.includes("x.ai") ? "xai" : "openai";
    const bound = original.bind(this);
    return openaiInstrumentedCreate(bound, this, args, opts, provider);
  };
  return _patchFunctionProperty(proto, "create", patched);
}

function _applyAnthropicPatch(
  AnthropicCls: { Messages?: { prototype?: Record<string, unknown> } } | null | undefined,
  opts: TraceOptions,
): boolean {
  const proto = AnthropicCls?.Messages?.prototype;
  if (!proto || typeof proto.create !== "function") return false;
  if (_isMarked(proto.create)) return true;

  const original = proto.create as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]): unknown {
    const bound = original.bind(this);
    return anthropicInstrumentedCreate(bound, this, args, opts);
  };
  return _patchFunctionProperty(proto, "create", patched);
}

function _applyGroqPatch(
  GroqCls: { Chat?: { Completions?: { prototype?: Record<string, unknown> } } } | null | undefined,
  opts: TraceOptions,
): boolean {
  const proto = GroqCls?.Chat?.Completions?.prototype;
  if (!proto || typeof proto.create !== "function") return false;
  if (_isMarked(proto.create)) return true;

  const original = proto.create as (...args: unknown[]) => unknown;
  const patched = function (this: unknown, ...args: unknown[]): unknown {
    const bound = original.bind(this);
    return groqInstrumentedCreate(bound, this, args, opts);
  };
  return _patchFunctionProperty(proto, "create", patched);
}

function _applyLangChainPatch(
  BaseChatModelCls: { prototype?: Record<string, unknown> } | null | undefined,
  opts: TraceOptions,
): boolean {
  const proto = BaseChatModelCls?.prototype;
  if (!proto) return false;
  let patchedAny = false;
  for (const method of LANGCHAIN_METHODS_TO_WRAP) {
    if (typeof proto[method] !== "function") continue;
    if (_isMarked(proto[method])) {
      patchedAny = true;
      continue;
    }
    const original = proto[method] as (...args: unknown[]) => unknown;
    const wrapped = _wrapLangChainMethod(
      original as (...a: any[]) => any,
      method as LangChainMethodName,
      opts,
    );
    if (_patchFunctionProperty(proto, method, wrapped as (...args: unknown[]) => unknown)) {
      patchedAny = true;
    }
  }
  return patchedAny;
}

function _applyGeminiLegacyPatch(
  GenerativeModelCls: { prototype?: Record<string, unknown> } | null | undefined,
  opts: TraceOptions,
): boolean {
  const proto = GenerativeModelCls?.prototype;
  if (!proto || typeof proto.generateContent !== "function") return false;
  if (_isMarked(proto.generateContent)) return true;

  const original = proto.generateContent as (...args: unknown[]) => unknown;
  const patched = _instrumentedProviderMethod(original, {
    provider: "gemini",
    name: "gemini.generateContent",
    modelKey: "model",
  }, opts);
  return _patchFunctionProperty(proto, "generateContent", patched);
}

function _applyGeminiNewPatch(
  ModelsCls: { prototype?: Record<string, unknown> } | null | undefined,
  opts: TraceOptions,
): boolean {
  const proto = ModelsCls?.prototype;
  if (!proto) return false;
  let patchedAny = false;
  for (const method of ["generateContent", "generateContentStream"] as const) {
    if (typeof proto[method] !== "function") continue;
    if (_isMarked(proto[method])) {
      patchedAny = true;
      continue;
    }
    const original = proto[method] as (...args: unknown[]) => unknown;
    const patched = _instrumentedProviderMethod(original, {
      provider: "gemini",
      name: `gemini.${method}`,
      modelKey: "model",
    }, opts);
    if (_patchFunctionProperty(proto, method, patched)) patchedAny = true;
  }
  return patchedAny;
}

function _applyMistralPatch(
  ChatCls: { prototype?: Record<string, unknown> } | null | undefined,
  opts: TraceOptions,
): boolean {
  const proto = ChatCls?.prototype;
  if (!proto) return false;
  let patchedAny = false;

  if (typeof proto.complete === "function" && !_isMarked(proto.complete)) {
    const original = proto.complete as (...args: unknown[]) => unknown;
    const patched = function (this: unknown, ...args: unknown[]): unknown {
      const bound = original.bind(this);
      return mistralInstrumentedComplete(bound as (...a: any[]) => any, this, args, opts);
    };
    if (_patchFunctionProperty(proto, "complete", patched)) patchedAny = true;
  } else if (_isMarked(proto.complete)) {
    patchedAny = true;
  }

  if (typeof proto.stream === "function" && !_isMarked(proto.stream)) {
    const original = proto.stream as (...args: unknown[]) => unknown;
    const patched = function (this: unknown, ...args: unknown[]): unknown {
      const bound = original.bind(this);
      return mistralInstrumentedStream(bound as (...a: any[]) => any, this, args, opts);
    };
    if (_patchFunctionProperty(proto, "stream", patched)) patchedAny = true;
  } else if (_isMarked(proto.stream)) {
    patchedAny = true;
  }

  return patchedAny;
}

export function patchOpenAIPrototype(opts: TraceOptions = {}): boolean {
  try {
    const mod = _safeRequire("openai") as { default?: unknown } | null | undefined;
    if (!mod) return false;
    const OpenAICls = _resolveDefaultExport(mod) as {
      Chat?: { Completions?: { prototype?: Record<string, unknown> } };
    };
    return _applyOpenAIPatch(OpenAICls, opts);
  } catch {
    return false;
  }
}

export async function patchOpenAIPrototypeESM(opts: TraceOptions = {}): Promise<boolean> {
  try {
    const mod = (await import("openai")) as { default?: unknown };
    const OpenAICls = _resolveDefaultExport(mod) as {
      Chat?: { Completions?: { prototype?: Record<string, unknown> } };
    };
    return _applyOpenAIPatch(OpenAICls, opts);
  } catch {
    return false;
  }
}

export function patchAnthropicPrototype(opts: TraceOptions = {}): boolean {
  try {
    const mod = _safeRequire("@anthropic-ai/sdk") as
      | { default?: unknown; Anthropic?: unknown }
      | null
      | undefined;
    if (!mod) return false;
    const AnthropicCls = (mod.default ?? mod.Anthropic ?? mod) as {
      Messages?: { prototype?: Record<string, unknown> };
    };
    return _applyAnthropicPatch(AnthropicCls, opts);
  } catch {
    return false;
  }
}

export async function patchAnthropicPrototypeESM(opts: TraceOptions = {}): Promise<boolean> {
  try {
    const mod = (await import("@anthropic-ai/sdk")) as {
      default?: unknown;
      Anthropic?: unknown;
    };
    const AnthropicCls = (mod.default ?? mod.Anthropic ?? mod) as {
      Messages?: { prototype?: Record<string, unknown> };
    };
    return _applyAnthropicPatch(AnthropicCls, opts);
  } catch {
    return false;
  }
}

export function patchGroqPrototype(opts: TraceOptions = {}): boolean {
  try {
    const mod = _safeRequire("groq-sdk") as { default?: unknown } | null | undefined;
    if (!mod) return false;
    const GroqCls = _resolveDefaultExport(mod) as {
      Chat?: { Completions?: { prototype?: Record<string, unknown> } };
    };
    return _applyGroqPatch(GroqCls, opts);
  } catch {
    return false;
  }
}

export async function patchGroqPrototypeESM(opts: TraceOptions = {}): Promise<boolean> {
  try {
    const mod = (await import("groq-sdk")) as { default?: unknown };
    const GroqCls = _resolveDefaultExport(mod) as {
      Chat?: { Completions?: { prototype?: Record<string, unknown> } };
    };
    return _applyGroqPatch(GroqCls, opts);
  } catch {
    return false;
  }
}

export function patchVercelAIPrototype(_opts: TraceOptions = {}): boolean {
  // ESM module namespace exports are non-configurable — see module doc.
  void _opts;
  return false;
}

export async function patchVercelAIPrototypeESM(_opts: TraceOptions = {}): Promise<boolean> {
  void _opts;
  return false;
}

export function patchLangChainPrototype(opts: TraceOptions = {}): boolean {
  try {
    const mod = _safeRequire("@langchain/core/language_models/chat_models") as
      | { BaseChatModel?: { prototype?: Record<string, unknown> } }
      | null
      | undefined;
    if (!mod?.BaseChatModel) return false;
    return _applyLangChainPatch(mod.BaseChatModel, opts);
  } catch {
    return false;
  }
}

export async function patchLangChainPrototypeESM(opts: TraceOptions = {}): Promise<boolean> {
  try {
    const mod = (await import("@langchain/core/language_models/chat_models")) as unknown as {
      BaseChatModel?: { prototype?: Record<string, unknown> };
    };
    if (!mod.BaseChatModel) return false;
    return _applyLangChainPatch(mod.BaseChatModel, opts);
  } catch {
    return false;
  }
}

export function patchGeminiPrototype(opts: TraceOptions = {}): boolean {
  let patched = false;
  try {
    const legacy = _safeRequire("@google/generative-ai") as
      | { GenerativeModel?: { prototype?: Record<string, unknown> } }
      | null
      | undefined;
    if (legacy?.GenerativeModel && _applyGeminiLegacyPatch(legacy.GenerativeModel, opts)) {
      patched = true;
    }
  } catch {
    // not installed
  }
  try {
    const genai = _safeRequire("@google/genai") as
      | { Models?: { prototype?: Record<string, unknown> } }
      | null
      | undefined;
    if (genai?.Models && _applyGeminiNewPatch(genai.Models, opts)) {
      patched = true;
    }
  } catch {
    // not installed
  }
  return patched;
}

export async function patchGeminiPrototypeESM(opts: TraceOptions = {}): Promise<boolean> {
  let patched = false;
  try {
    const legacy = (await import("@google/generative-ai")) as unknown as {
      GenerativeModel?: { prototype?: Record<string, unknown> };
    };
    if (legacy.GenerativeModel && _applyGeminiLegacyPatch(legacy.GenerativeModel, opts)) {
      patched = true;
    }
  } catch {
    // not installed
  }
  try {
    const genai = (await import("@google/genai")) as unknown as {
      Models?: { prototype?: Record<string, unknown> };
    };
    if (genai.Models && _applyGeminiNewPatch(genai.Models, opts)) {
      patched = true;
    }
  } catch {
    // not installed
  }
  return patched;
}

export function patchMistralPrototype(opts: TraceOptions = {}): boolean {
  try {
    const mod = _safeRequire("@mistralai/mistralai") as
      | { Chat?: { prototype?: Record<string, unknown> }; default?: { Chat?: unknown } }
      | null
      | undefined;
    if (!mod) return false;
    const ChatCls = (mod.Chat ??
      (mod.default as { Chat?: { prototype?: Record<string, unknown> } } | undefined)?.Chat) as
      | { prototype?: Record<string, unknown> }
      | undefined;
    return _applyMistralPatch(ChatCls, opts);
  } catch {
    return false;
  }
}

export async function patchMistralPrototypeESM(opts: TraceOptions = {}): Promise<boolean> {
  try {
    // Optional peer — dynamic import keeps typecheck clean when absent.
    const mod = (await import(
      "@mistralai/mistralai" as string
    )) as unknown as {
      Chat?: { prototype?: Record<string, unknown> };
    };
    return _applyMistralPatch(mod.Chat, opts);
  } catch {
    return false;
  }
}

export function patchAllPrototypes(opts: TraceOptions = {}): PrototypePatchResult {
  return {
    openai: patchOpenAIPrototype(opts),
    anthropic: patchAnthropicPrototype(opts),
    groq: patchGroqPrototype(opts),
    vercelAi: patchVercelAIPrototype(opts),
    langchain: patchLangChainPrototype(opts),
    gemini: patchGeminiPrototype(opts),
    mistral: patchMistralPrototype(opts),
  };
}

export async function patchAllPrototypesAsync(
  opts: TraceOptions = {},
): Promise<PrototypePatchResult> {
  const [openai, anthropic, groq, vercelAi, langchain, gemini, mistral] = await Promise.all([
    patchOpenAIPrototypeESM(opts),
    patchAnthropicPrototypeESM(opts),
    patchGroqPrototypeESM(opts),
    patchVercelAIPrototypeESM(opts),
    patchLangChainPrototypeESM(opts),
    patchGeminiPrototypeESM(opts),
    patchMistralPrototypeESM(opts),
  ]);
  return { openai, anthropic, groq, vercelAi, langchain, gemini, mistral };
}

export function _unpatchAllForTests(): void {
  while (_patchRecords.length > 0) {
    const rec = _patchRecords.pop();
    if (!rec) continue;
    rec.target[rec.prop] = rec.original;
  }
}
