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
export { wrapMastra } from "./instrumentations/mastra.js";
export { instrument, type InstrumentOptions, type InstrumentResult } from "./instrument.js";
export {
  installHttpCapture,
  uninstallHttpCapture,
  isHttpCaptureInstalled,
} from "./http-capture.js";
export { installLogging, uninstallLogging } from "./logging-forwarder.js";
export { configureOtelExporter, isOtelConfigured } from "./otel.js";
export { runDoctor, type DoctorCheck, type DoctorReport } from "./doctor.js";
export {
  begin,
  completeSession,
  currentSession,
  identify,
  AgentSession,
  type AgentSessionOptions,
} from "./session.js";
export { recordStumble } from "./stumbles.js";
export { autoInstrument, detectInstalledFrameworks, type AutoInstrumentResult } from "./detect-installed.js";
export {
  wrapBedrock,
  wrapGemini,
} from "./instrumentations/providers.js";
