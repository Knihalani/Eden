/**
 * Framework detection helpers (shared by index + instrument).
 */

import type { TraceOptions } from "./types.js";

export interface AutoInstrumentResult {
  openai: boolean;
  anthropic: boolean;
  vercelAi: boolean;
  langchain: boolean;
  langgraph: boolean;
  mastra: boolean;
  bedrock: boolean;
  gemini: boolean;
  llamaIndex: boolean;
  groq: boolean;
  cohere: boolean;
  mistral: boolean;
}

/**
 * Best-effort `require()` that works whether the SDK is consumed as
 * CJS or ESM (falls back to a synthesized `createRequire` when a bare
 * `require` isn't in scope). Exported so `prototype-instrument.ts` can
 * reuse the exact same module-resolution strategy this file already
 * uses for framework *detection* to instead load the actual module
 * namespace object it needs to patch.
 */
export function _safeRequire(name: string): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-eval
    const fn = (eval("require")) as NodeJS.Require;
    return fn(name);
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = (globalThis as any).process;
      if (!proc) return null;
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
      const getBuiltin = (proc as any).getBuiltinModule as
        | ((name: string) => { createRequire?: (url: string) => (id: string) => unknown } | undefined)
        | undefined;
      const m = typeof getBuiltin === "function" ? getBuiltin("module") : null;
      if (m && typeof m.createRequire === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meta = (import.meta as any) ?? { url: `file://${proc.cwd()}/index.js` };
        return m.createRequire(meta.url)(name);
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Report which LLM SDK packages are importable in the current
 * process. Detection-only — does not install instrumentation; call
 * `instrument()` or the returned `wrap*` helpers to trace calls.
 */
export function detectInstalledFrameworks(
  _opts: TraceOptions = {},
): AutoInstrumentResult {
  const result: AutoInstrumentResult = {
    openai: false,
    anthropic: false,
    vercelAi: false,
    langchain: false,
    langgraph: false,
    mastra: false,
    bedrock: false,
    gemini: false,
    llamaIndex: false,
    groq: false,
    cohere: false,
    mistral: false,
  };
  try {
    if (_safeRequire("openai")) result.openai = true;
  } catch {
    // not installed
  }
  try {
    if (_safeRequire("@anthropic-ai/sdk")) result.anthropic = true;
  } catch {
    // not installed
  }
  try {
    if (_safeRequire("ai")) result.vercelAi = true;
  } catch {
    // not installed
  }
  try {
    if (_safeRequire("@langchain/core")) result.langchain = true;
  } catch {
    // not installed
  }
  try {
    if (_safeRequire("@langchain/langgraph")) result.langgraph = true;
  } catch {
    // not installed
  }
  try {
    if (_safeRequire("@mastra/core") || _safeRequire("mastra")) result.mastra = true;
  } catch {
    // not installed
  }
  try {
    // AWS SDK v3's Bedrock Runtime client. `wrapBedrock` proxies
    // `send`/`invokeModel`/`converse` on any client-like object, so
    // detection only needs to confirm the package is reachable —
    // mirrors the Python SDK's `boto3`/`botocore` import check in
    // `instrumentations/bedrock.py`.
    if (_safeRequire("@aws-sdk/client-bedrock-runtime")) result.bedrock = true;
  } catch {
    // not installed
  }
  try {
    // Both the legacy `@google/generative-ai` SDK and the newer
    // `@google/genai` client are accepted — `wrapGemini` proxies
    // either shape. Mirrors the Python SDK's dual
    // `google.generativeai` / `google.genai` check in
    // `instrumentations/gemini.py`.
    if (_safeRequire("@google/generative-ai") || _safeRequire("@google/genai")) {
      result.gemini = true;
    }
  } catch {
    // not installed
  }
  try {
    if (_safeRequire("llamaindex")) result.llamaIndex = true;
  } catch {
    // not installed
  }
  try {
    // Groq's TS SDK package is `groq-sdk`.
    if (_safeRequire("groq-sdk")) result.groq = true;
  } catch {
    // not installed
  }
  try {
    // Cohere's TS SDK package is `cohere-ai`.
    if (_safeRequire("cohere-ai")) result.cohere = true;
  } catch {
    // not installed
  }
  try {
    // Mistral's TS SDK package is `@mistralai/mistralai`.
    if (_safeRequire("@mistralai/mistralai")) result.mistral = true;
  } catch {
    // not installed
  }
  void _opts;
  return result;
}

/**
 * @deprecated Use {@link detectInstalledFrameworks} instead. This name
 * is misleading — it does **not** install instrumentation; it only
 * reports which LLM SDKs are importable (same as
 * `detectInstalledFrameworks()`).
 */
export function autoInstrument(opts: TraceOptions = {}): AutoInstrumentResult {
  return detectInstalledFrameworks(opts);
}
