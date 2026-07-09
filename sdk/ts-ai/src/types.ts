/**
 * Eden TypeScript runtime SDK — public type definitions.
 *
 * These types describe the configuration surface, telemetry payloads,
 * and provider-specific shapes that auto-instrumentation emits. They
 * are intentionally framework-agnostic so that the OpenAI, Anthropic,
 * Vercel AI, and LangChain instrumentations can share a single
 * payload shape sent to the Eden gateway.
 */

// ── Configuration ─────────────────────────────────────────────────

/**
 * Options accepted by {@link configure} / {@link EdenSDK}.
 *
 * Mirrors the Python SDK's `EdenConfig` plus the runtime-tracing
 * fields required for fire-and-forget ingest.
 */
export interface EdenSDKOptions {
  /**
   * Organization identifier used in the URL path
   * (`/orgs/{orgId}/ingest/...`) and the `X-Org-Id` header.
   *
   * Falls back to `EDEN_ORG_ID` env var when omitted.
   */
  orgId?: string;

  /**
   * API key sent as `X-Org-Api-Key` for programmatic auth. Falls
   * back to `EDEN_ORG_API_KEY` env var when omitted. The Python
   * SDK allows unauthenticated ingest in dev; we keep that
   * behaviour but warn in strict mode.
   */
  apiKey?: string;

  /**
   * Optional project ID sent as `X-Project-Id`. Defaults to
   * `"default"` to match the gateway's expectation.
   */
  projectId?: string;

  /**
   * Gateway base URL. Defaults to `EDEN_BASE_URL` env var or
   * `http://localhost:8000`. The SDK POSTs to
   * `${baseUrl}/orgs/${orgId}/ingest/...` for telemetry and
   * `${baseUrl}/orgs/${orgId}/ingest/chunks` for streaming chunks.
   */
  baseUrl?: string;

  /**
   * Optional realm. Defaults to `"production"`. The Python SDK
   * uses an enum (`Realm.PRODUCTION`); for TS we accept the raw
   * string and validate on the server.
   */
  realm?: string;

  /**
   * Tags appended to every event emitted by the SDK. The
   * Python SDK accepts a list of strings; we mirror that.
   */
  tags?: string[];

  /**
   * Free-form metadata merged into every payload under
   * `payload.metadata`.
   */
  metadata?: Record<string, unknown>;

  /**
   * Maximum number of events to buffer before flushing
   * synchronously. Defaults to 50. The Python SDK uses
   * 50 chunks / 250 ms; we keep the count cap and add a
   * wall-clock cap (`flushIntervalMs`).
   */
  maxBatchSize?: number;

  /**
   * Hard ceiling on the in-memory queue. The oldest event is
   * dropped when the queue exceeds this. Defaults to 4096 to
   * match the Python SDK and prevent unbounded growth in
   * long-lived processes.
   */
  maxQueueSize?: number;

  /**
   * Per-request timeout in seconds. Defaults to 5. Mirrors
   * Python's ``timeout_s``.
   */
  timeoutS?: number;

  /**
   * When true, the SDK buffers events but does NOT POST them.
   * Mirrors Python's ``disabled`` flag. Useful for local dev
   * and shadow mode.
   */
  disabled?: boolean;

  /**
   * If true (default), the SDK runs a small regex pass over every
   * outgoing payload to mask obvious PII before posting. Mirrors
   * Python's ``redact_on_client`` flag.
   */
  redactOnClient?: boolean;

  /**
   * Maximum time (ms) to wait before flushing a partial batch.
   * Defaults to 250.
   */
  flushIntervalMs?: number;

  /**
   * When `true`, emit a console.debug line for every batch flush.
   * Defaults to `false`.
   */
  debug?: boolean;

  /**
   * When `true`, throw on misconfiguration (missing orgId,
   * unreachable gateway). Defaults to `false` — tracing must
   * never break the user's call.
   */
  strict?: boolean;

  /**
   * Explicit OpenAI-compatible gateway URL. When unset,
   * `resolvedGatewayUrl()` derives from `baseUrl + "/v1"`.
   * Mirrors `EdenConfig.gateway_url` in the Python SDK.
   */
  gatewayUrl?: string;

  /**
   * Per-filter configuration applied to every gateway call via
   * `EdenSDK.gatewayHeaders()`. Mirrors `EdenConfig.filters` in
   * the Python SDK.
   */
  filters?: import("./filters.js").FilterConfig;
}

// ── Telemetry events ──────────────────────────────────────────────

/**
 * A single telemetry event ready to be POSTed to the gateway.
 *
 * Mirrors the Python `TelemetryEvent` Pydantic model and the
 * `telemetry_events` table schema (migration `009_telemetry_events`):
 *
 *   - `eventId`  → `event_id` (PK, VARCHAR(128))
 *   - `traceId`  → `trace_id` (VARCHAR(128))
 *   - `tenantId` → `tenant_id`  (VARCHAR(128))   // == orgId
 *   - `projectId`→ `project_id` (VARCHAR(128))
 *   - `realm`    → `realm`      (VARCHAR(32))
 *   - `eventType`→ `event_type` (VARCHAR(64))
 *   - `timestamp`→ `timestamp`  (TIMESTAMPTZ, ISO-8601)
 *   - `sourceFormat` → `source_format` (indexed)
 *
 * The exact column list lives in
 * `src/eden/db_migrations/versions/009_telemetry_events.py`.
 */
export interface TelemetryEvent {
  eventId: string;
  tenantId: string;
  projectId: string;
  traceId: string;
  realm: string;
  eventType: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  sourceFormat: string;
  payload: Record<string, unknown>;
  metrics?: Record<string, number>;
  tags?: string[];
  attributes?: Record<string, unknown>;
  /** Set by the gateway, not the SDK. */
  agentId?: string;
  agentVersion?: string;
  environmentId?: string;
  parentSpanId?: string;
  spanId?: string;
  name?: string;
  durationMs?: number;
  /**
   * Provider model alias stripped of dated suffixes / -latest
   * suffix. e.g. ``gpt-4o-2024-08-06`` → ``gpt-4o``. Used by the
   * server-side pricing lookup so different aliases of the same
   * model roll up to a single rate.
   */
  modelNormalized?: string;
}

// ── Trace context ─────────────────────────────────────────────────

/**
 * The trace context returned by `trace()` / `traceAgent()`.
 *
 * Mirrors the Python SDK's `TraceContext` dataclass.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  startMs: number;
}

export interface TraceOptions {
  /** Logical environment/agent id. Mirrors `environment_id` in Python. */
  environmentId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ── Provider metadata ────────────────────────────────────────────

/**
 * Discriminator used by the gateway's `source_format` column.
 *
 * The Python SDK uses strings like `"eden-auto-instrument"`; we
 * add explicit per-provider values for downstream filtering in
 * the portal's "framework" filter.
 */
export const SOURCE_FORMATS = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  VERCEL_AI: "vercel-ai",
  LANGCHAIN: "langchain",
  TRACE_AGENT: "eden-trace-agent-ts",
  AUTO_INSTRUMENT: "eden-auto-instrument-ts",
} as const;

export type SourceFormat = (typeof SOURCE_FORMATS)[keyof typeof SOURCE_FORMATS];

// ── Streaming metrics ─────────────────────────────────────────────

/**
 * Mirrors the Python SDK's `llm_completion_stream` metrics:
 *
 *   - ttft_ms               : time-to-first-token
 *   - itl_ms_avg            : inter-token latency average
 *   - tpot_ms               : time-per-output-token
 *   - completion_duration_ms: total wall-clock time
 *   - output_tokens         : rough token estimate (chunk-based)
 */
export interface StreamingMetrics {
  ttftMs: number;
  itlMsAvg: number;
  tpotMs: number;
  completionDurationMs: number;
  outputTokens: number;
  inputTokens?: number;
}

/**
 * A single buffered streaming chunk. Mirrors the Python SDK's
 * `ChunksIngestRequest.chunks` payload so the gateway can apply
 * the same PII pre-mask and write to `telemetry_stream_chunks`.
 */
export interface StreamChunk {
  eventId: string;
  traceId: string;
  chunkIndex: number;
  deltaText?: string | null;
  reasoningDelta?: string | null;
  toolCallDelta?: Record<string, unknown> | null;
  ttftMs?: number | null;
  itlMs?: number | null;
  tpotMs?: number | null;
  receivedAtClientMs: number;
}
