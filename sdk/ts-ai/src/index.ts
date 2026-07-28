/**
 * @eden-ai/sdk — runtime observability for TypeScript agents.
 *
 * Slim main entry: configure / client / trace / filters / sessions.
 * Heavy surfaces live on subpath exports:
 *   - `@eden-ai/sdk/instrumentations/*`
 *   - `@eden-ai/sdk/model-advisor`
 * wrap* helpers remain re-exported for backwards compatibility.
 */

export { EdenSDK, getDefaultClient, setDefaultClient, resetDefaultClient, resolvedGatewayUrl, type ResolvedConfig, type GatewayHeadersOptions } from "./client.js";
export { trace, traceAgent, TraceController, type TraceContext } from "./trace.js";
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
  SOURCE_FORMATS,
  type EdenSDKOptions,
  type TelemetryEvent,
  type TraceOptions,
  type StreamingMetrics,
  type StreamChunk,
  type SourceFormat,
} from "./types.js";

export { SDK_NAME, SDK_VERSION, SDK_USER_AGENT } from "./version.js";
export { eventToWire, chunkToWire, wireToEvent, wireToChunk } from "./wire.js";
export { extractUsage, normalizeModelName, type NormalizedUsage } from "./tokens.js";

// Back-compat re-exports (tree-shakeable with sideEffects:false).
export { wrapOpenAI, wrapXai } from "./instrumentations/openai.js";
export { wrapAnthropic } from "./instrumentations/anthropic.js";
export { wrapVercelAI } from "./instrumentations/vercel-ai.js";
export { wrapLangChain } from "./instrumentations/langchain.js";
export { wrapMastra } from "./instrumentations/mastra.js";
export { wrapGroq } from "./instrumentations/groq.js";
export { wrapCohere, extractCohereUsage } from "./instrumentations/cohere.js";
export { wrapMistral } from "./instrumentations/mistral.js";
export { instrument, type InstrumentOptions, type InstrumentResult } from "./instrument.js";
export {
  installHttpCapture,
  uninstallHttpCapture,
  isHttpCaptureInstalled,
} from "./http-capture.js";
export { installLogging, uninstallLogging } from "./logging-forwarder.js";
export { configureOtelExporter, isOtelConfigured } from "./otel.js";
export { runDoctor, type DoctorCheck, type DoctorReport } from "./doctor.js";
export { resolveIngestPath, ALLOWED_INGEST_FORMATS } from "./ingest-format.js";
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
export { wrapLlamaIndex } from "./instrumentations/llamaindex.js";

// ModelAdvisor moved to `@eden-ai/sdk/model-advisor` — re-export for BC.
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
