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

export { EdenSDK, getDefaultClient, setDefaultClient, resetDefaultClient, resolvedGatewayUrl, type ResolvedConfig, type GatewayHeadersOptions } from "./client.js";
export { trace, traceAgent, type TraceContext } from "./trace.js";
export { configure } from "./client.js";
export {
  FilterConfig,
  PIIConfig,
  FILTER_NAMES,
  redactPayload,
  redactString,
  type FilterName,
  type PIIMode,
  type PIIConfigOptions,
  type FilterConfigOptions,
} from "./filters.js";
export { openaiClient, chatCompletion, type OpenAIClientOptions } from "./gateway_session.js";
export {
  ModelAdvisor,
  ModelAdvisorError,
  type ModelAdvisorOptions,
  type ModelComparison,
  type ModelRef,
  type ModelSpec,
  type ProjectOptions,
  type Recommendation,
  type RecommendOptions,
  type RunnerUp,
  type SwitchProjection,
} from "./model_advisor.js";
export {
  SOURCE_FORMATS,
  type EdenSDKOptions,
  type TelemetryEvent,
  type TraceOptions,
  type StreamingMetrics,
  type StreamChunk,
  type SourceFormat,
} from "./types.js";

// Note: we no longer import the per-framework wrap* functions here —
// autoInstrument only detects whether the packages are installed
// (via require()), it does NOT auto-wrap them (the TS SDK wraps
// client instances, not modules, because monkey-patching the
// default export is fragile across bundlers and ESM/CJS interop).
// Callers should still use the wrap* exports below manually.

/**
 * Result of {@link detectInstalledFrameworks}.
 *
 * Each key is the *npm package name* (or its alias) of a
 * supported framework; the value is ``true`` when the
 * module is loadable via ``require()`` from the current
 * process. The map is intentionally flat so callers can
 * spread it into log lines or dashboard metadata.
 */
export interface AutoInstrumentResult {
  openai: boolean;
  anthropic: boolean;
  vercelAi: boolean;
  langchain: boolean;
}

/**
 * Detect which LLM SDKs are installed in the current process.
 *
 * This is the **detection** half of what ``autoInstrument()``
 * used to claim. The TS SDK wraps *client instances* (not
 * modules, because monkey-patching a third-party module is
 * fragile across bundlers and ESM/CJS interop), so the
 * instrumentation step still requires the caller to construct
 * their client and pass it through the appropriate
 * ``wrap*(client, opts)`` helper. The detection result here
 * tells you which ``wrap*`` helpers are worth calling.
 *
 * Kept under the name ``autoInstrument`` for backwards
 * compatibility with v0.1 callers — the return shape matches
 * the previous function. New code should call
 * {@link detectInstalledFrameworks} for clarity.
 *
 * Example
 * -------
 * ```ts
 * import { autoInstrument, wrapOpenAI, wrapAnthropic } from "@eden-ai/sdk";
 *
 * const installed = autoInstrument();
 * if (installed.openai) {
 *   const { OpenAI } = await import("openai");
 *   const client = wrapOpenAI(new OpenAI());
 * }
 * ```
 */
export function autoInstrument(
  opts: import("./types.js").TraceOptions = {},
): AutoInstrumentResult {
  return detectInstalledFrameworks(opts);
}

/**
 * Detect which LLM SDKs are installed. See {@link autoInstrument}
 * for the full rationale — this is the same function under a
 * more accurate name.
 */
/**
 * Resolve a CommonJS-style ``require`` function regardless of how
 * the consumer imports the SDK. Bundlers (tsup, esbuild, webpack)
 * inline ``require`` as a synthetic reference; pure-ESM consumers
 * (``"type": "module"`` or ``.mjs`` files) have no ``require`` at
 * all and need ``createRequire``.
 *
 * Without this, ESM consumers see every framework as "not installed"
 * because ``require`` is undefined and the try/catch swallows the
 * ReferenceError silently.
 */
/**
 * Resolve a CommonJS-style ``require`` that works in any module
 * format. Both branches are wrapped because:
 *
 *   - In CJS bundled output (``tsup --format cjs``) ``require`` is
 *     the CommonJS require and ``import.meta.url`` is not defined.
 *   - In ESM bundled output (``tsup --format esm``) ``require`` is
 *     not defined at all, but ``import.meta.url`` is. We resolve
 *     ``createRequire`` lazily via ``globalThis.process`` so we
 *     don't have to import "module" at the top of an ESM file
 *     (which tsup would inline into the bundle as a CJS-only
 *     reference).
 *
 * Without this, ESM consumers see every framework as "not
 * installed" because the try/catch silently swallows the
 * ReferenceError.
 */
function _safeRequire(name: string): unknown {
  // Branch 1: CommonJS / bundled CJS — ``require`` exists.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-eval
    const fn = (eval("require")) as NodeJS.Require;
    return fn(name);
  } catch {
    // Branch 2: pure ESM — synthesize a require via the SDK file's
    // own URL. We use ``globalThis.process`` (always present in
    // Node) plus a dynamic ``import("node:module")``-style fallback
    // so the bundle stays portable across CJS/ESM consumers.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = (globalThis as any).process;
      if (!proc) return null;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const m = (proc as NodeJS.Process).getBuiltinModule
        ? (proc as NodeJS.Process).getBuiltinModule("module")
        : null;
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

export function detectInstalledFrameworks(
  _opts: import("./types.js").TraceOptions = {},
): AutoInstrumentResult {
  const result: AutoInstrumentResult = {
    openai: false,
    anthropic: false,
    vercelAi: false,
    langchain: false,
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
  // The opts arg is accepted for parity with the per-framework
  // wrap*(client, opts) helpers — kept on the signature so
  // a future "auto wrap the default-constructed client" can
  // thread it through without a breaking change.
  void _opts;
  return result;
}

export { SDK_NAME, SDK_VERSION, SDK_USER_AGENT } from "./version.js";
// Wire-format helpers (TS camelCase ↔ server snake_case at the POST
// boundary). Re-exported here so the bundle includes them; the
// internal postBatch / postChunks paths apply them
// automatically — expose them so advanced callers can transform
// arbitrary TelemetryEvent records (e.g. when constructing
// events from a queue before passing to emit()).
export { eventToWire, chunkToWire, wireToEvent, wireToChunk } from "./wire.js";
export { extractUsage, normalizeModelName, type NormalizedUsage } from "./tokens.js";
export { wrapOpenAI } from "./instrumentations/openai.js";
export { wrapAnthropic } from "./instrumentations/anthropic.js";
export { wrapVercelAI } from "./instrumentations/vercel-ai.js";
export { wrapLangChain } from "./instrumentations/langchain.js";
