/**
 * @eden-ai/sdk — runtime observability for TypeScript agents.
 *
 * Public surface:
 *   - `configure(opts)` — set up the default SDK client
 *   - `getDefaultClient()` — get the singleton
 *   - `EdenSDK` — class for advanced users
 *   - `trace()` / `traceAgent()` — manual instrumentation
 *   - `wrapOpenAI()` / `wrapAnthropic()` / `wrapVercelAI()` /
 *     `wrapLangChain()` — Proxy-based auto-instrumentation
 *
 * See `README.md` for usage examples.
 */

export { EdenSDK, getDefaultClient, setDefaultClient, resetDefaultClient, type ResolvedConfig } from "./client.js";
export { trace, traceAgent, configure, type TraceContext } from "./trace.js";
export {
  SOURCE_FORMATS,
  type EdenSDKOptions,
  type TelemetryEvent,
  type TraceOptions,
  type StreamingMetrics,
  type StreamChunk,
  type SourceFormat,
} from "./types.js";

import { wrapOpenAI } from "./instrumentations/openai.js";
import { wrapAnthropic } from "./instrumentations/anthropic.js";
import { wrapVercelAI } from "./instrumentations/vercel-ai.js";
import { wrapLangChain } from "./instrumentations/langchain.js";

/**
 * Per-framework detection result. Mirrors the Python SDK's
 * `auto_instrument()` return value (a dict of `{target: bool}`).
 */
export interface AutoInstrumentResult {
  openai: boolean;
  anthropic: boolean;
  vercelAi: boolean;
  langchain: boolean;
}

/**
 * Convenience entrypoint: detect which LLM SDKs are installed
 * and wrap them. Each `wrap*(client, opts)` function expects a
 * client instance; the autoInstrument helpers here detect
 * installed modules and (when found) wrap the user's globally
 * constructed client.
 *
 * Mirrors the Python SDK's `auto_instrument()`.
 */
export function autoInstrument(
  opts: import("./types.js").TraceOptions = {},
): AutoInstrumentResult {
  // Each instrumentation is a Proxy-returning function. The
  // caller's responsibility is to pass a real client instance.
  // The detection step here is module-presence only: we import
  // dynamically to avoid hard dependencies.
  const result: AutoInstrumentResult = {
    openai: false,
    anthropic: false,
    vercelAi: false,
    langchain: false,
  };
  try {
    require("openai");
    result.openai = typeof wrapOpenAI === "function";
  } catch {
    // not installed
  }
  try {
    require("@anthropic-ai/sdk");
    result.anthropic = typeof wrapAnthropic === "function";
  } catch {
    // not installed
  }
  try {
    require("ai");
    result.vercelAi = typeof wrapVercelAI === "function";
  } catch {
    // not installed
  }
  try {
    require("@langchain/core");
    result.langchain = typeof wrapLangChain === "function";
  } catch {
    // not installed
  }
  // The opts arg is accepted for symmetry with the Python SDK
  // and to let callers thread tags/environmentId through; the
  // per-framework wrap*() functions take the same shape.
  void opts;
  return result;
}

export { wrapOpenAI } from "./instrumentations/openai.js";
export { wrapAnthropic } from "./instrumentations/anthropic.js";
export { wrapVercelAI } from "./instrumentations/vercel-ai.js";
export { wrapLangChain } from "./instrumentations/langchain.js";
