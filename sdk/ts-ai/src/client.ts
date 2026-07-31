/**
 * Eden TypeScript runtime SDK — core HTTP client.
 *
 * Mirrors the Python SDK's `EdenConfig` + `TelemetryCollector`:
 *
 *   - Resolves configuration from options / env vars.
 *   - Owns a small fire-and-forget event queue.
 *   - Batches events (count + time caps) into a single POST.
 *   - Flushes chunks (streaming deltas) to a separate endpoint.
 *
 * Tracing must NEVER break the user's call — every emit path is
 * wrapped in a try/catch and any failure is logged to
 * `console.debug` (or swallowed in non-debug mode).
 */

import { SDK_USER_AGENT } from "./version.js";
import { eventToWire, chunkToWire } from "./wire.js";
import {
  type EdenSDKOptions,
  type StreamChunk,
  type TelemetryEvent,
} from "./types.js";
import { type FilterConfig, redactPayload, redactString } from "./filters.js";
import { optimizationOptOutHeaders } from "./gateway_optimizations.js";
import { ClientSampler, type SamplingProfile } from "./sampling.js";
import { OfflineQueue, type OfflineRow } from "./offline-queue.js";
import { resolveIngestPath } from "./ingest-format.js";
// NOTE: intentionally not importing from `./ids.js` here -- `ids.ts`
// now imports `currentTrace` from `./trace.js`, which itself imports
// `getDefaultClient` from this module. Importing `ids.js` from
// `client.ts` would complete a three-file circular import
// (client → ids → trace → client). `randomUUID` gives us the same
// "generate a fresh unique id" need for offline-replay envelope
// synthesis (see `_offlineRowToEvent`) without the cycle.
import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://api.edenobservability.com";
const DEFAULT_REALM = "production";
const DEFAULT_PROJECT_ID = "default";
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_QUEUE_SIZE = 4096;
const DEFAULT_TIMEOUT_S = 5;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_CHUNK_BUFFER = 4096;
/** Match BE ``settings.ingestion_chunks_max_per_request`` (default 1000). */
const INGEST_CHUNKS_MAX_PER_REQUEST = 1000;
/**
 * Reserved ``sourceFormat`` tag used when a failed chunk batch
 * spills to the offline queue (see `postChunkBatch`). Distinct from
 * any real ``sourceFormat`` (openai/anthropic/...) so a replay path
 * can tell a spilled chunk-batch record apart from an ordinary
 * spilled telemetry-event payload.
 */
const OFFLINE_CHUNKS_FORMAT = "chunks";

/**
 * Lazily-cached ``gzipSync`` so each ingest POST does not pay for
 * a fresh ``import("node:zlib")``. Dynamic import is kept (not a
 * static top-level import) so edge/bundler builds that tree-shake
 * unused Node builtins still resolve at runtime only when posting.
 * ``level: 1`` matches the Python SDK's ``compresslevel=1`` —
 * fastest deflate for telemetry payloads where wire size is already
 * dominated by JSON structure, not archive ratio.
 *
 * Deliberately still ``gzipSync``, not the threadpool-backed
 * ``zlib.gzip``. Measured on this payload shape at level 1: 0.4ms per
 * call for a 621KB body, scaling at roughly 0.5ms/MB. Switching to the
 * async form cost ~40% more wall-clock per call (11ms vs 8ms over 20
 * calls) for the threadpool round-trip, to hand back a fraction of a
 * millisecond of event loop. Since ``flush()`` now caps a batch at
 * ``maxBatchSize`` (default 50) rather than shipping the whole queue,
 * the realistic body is a few hundred KB and the sync call is the
 * cheaper choice. Revisit only if a caller raises ``maxBatchSize`` into
 * the thousands *and* carries large prompts — at ~20MB the stall
 * reaches ~10ms, which is where the trade flips.
 */
type GzipSync = typeof import("node:zlib").gzipSync;
let _gzipSync: GzipSync | null = null;

async function gzipJsonBody(body: unknown): Promise<Buffer> {
  if (_gzipSync === null) {
    const zlib = await import("node:zlib");
    _gzipSync = zlib.gzipSync;
  }
  return _gzipSync(Buffer.from(JSON.stringify(body), "utf8"), { level: 1 });
}

/**
 * `setTimeout`-backed sleep that `.unref()`s its timer when the
 * runtime supports it. Used by the retry-backoff delays in
 * `postJson()` -- without this, a short-lived script/serverless
 * invocation that hit a 429/503 (or a network error) would hang for
 * the full backoff (up to 30s if a `Retry-After` header is honoured)
 * even after all user work had already completed, exactly the
 * problem `flushTimer`/`chunkTimer` guard against elsewhere in this
 * file. Guarded for environments (e.g. browser `setTimeout`) whose
 * return value has no `.unref`.
 */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref?: () => void }).unref!();
    }
  });
}


// ── Configuration ─────────────────────────────────────────────────

/**
 * Resolved configuration after env-var lookups and defaults.
 */
export interface ResolvedConfig {
  orgId: string | undefined;
  apiKey: string | undefined;
  projectId: string;
  /** Stable agent identity; see `EdenSDKOptions.agentId`. */
  agentId: string | undefined;
  baseUrl: string;
  /**
   * Explicit OpenAI-compatible gateway URL. When unset,
   * `resolvedGatewayUrl()` derives from `baseUrl + "/gateway/v1"`.
   */
  gatewayUrl: string | undefined;
  /**
   * Per-filter configuration applied to every gateway call.
   * Mirrors `EdenConfig.filters` in the Python SDK.
   */
  filters: FilterConfig | undefined;
  realm: string;
  tags: string[];
  metadata: Record<string, unknown>;
  maxBatchSize: number;
  maxQueueSize: number;
  flushIntervalMs: number;
  /**
   * Upper bound on the streaming chunk buffer. A runaway
   * streaming response (millions of small chunks) would
   * OOM the process without this cap — the producer thread
   * can push faster than the worker thread can flush, and
   * the buffer would grow without bound. Mirrors the Python
   * SDK's ``_chunk_buffer_max`` (added in 0.2.13). On
   * overflow the oldest chunks are dropped and a debug log
   * is emitted (the user's model output is lossy in
   * extreme cases, but the aggregate event still ships
   * because the per-chunk TTFT/ITL/TPOT dashboards only
   * need a representative sample).
   */
  maxChunkBuffer: number;
  /** Per-request timeout in seconds. Defaults to 5. Mirrors Python's ``timeout_s``. */
  timeoutS: number;
  /**
   * When true, the SDK buffers events but does NOT POST them to the
   * gateway. Useful for local dev or when an integration is in
   * shadow mode. Mirrors Python's ``disabled`` flag.
   */
  disabled: boolean;
  /**
   * If true, the SDK runs a small regex pass over every
   * outgoing payload to mask obvious emails, phone numbers, US SSNs,
   * and credit-card numbers. Default is false — the gateway remains
   * the authoritative redaction layer. Set ``redactOnClient: true``
   * or ``EDEN_REDACT_ON_CLIENT=1`` to restore the pre-0.3.2 default.
   */
  redactOnClient: boolean;
  /**
   * When true, streaming chunk events include ``deltaText``.
   * Default false (metrics-only chunks).
   */
  captureChunkText: boolean;
  debug: boolean;
  strict: boolean;
  exactCache: boolean;
  coalesce: boolean;
  providerCacheLayout: boolean;
  responseRepair: boolean;
}

function readEnv(name: string): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    const v = process.env[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function envOptBool(name: string): boolean | undefined {
  const raw = readEnv(name);
  if (raw === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function resolveConfig(opts: EdenSDKOptions = {}): ResolvedConfig {
  const baseUrl = opts.baseUrl ?? readEnv("EDEN_BASE_URL") ?? DEFAULT_BASE_URL;
  const orgId = opts.orgId ?? readEnv("EDEN_ORG_ID") ?? readEnv("EDEN_DEFAULT_ORG");
  const apiKey =
    opts.apiKey ?? readEnv("EDEN_ORG_API_KEY") ?? readEnv("EDEN_API_KEY");
  const projectId = opts.projectId ?? readEnv("EDEN_PROJECT_ID") ?? DEFAULT_PROJECT_ID;
  const agentId = opts.agentId ?? readEnv("EDEN_AGENT_ID") ?? undefined;
  const realm = opts.realm ?? readEnv("EDEN_REALM") ?? DEFAULT_REALM;
  const debug = opts.debug ?? readEnv("EDEN_DEBUG") === "1";
  const strict = opts.strict ?? false;
  const maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const maxQueueSize = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  const maxChunkBuffer = opts.maxChunkBuffer ?? DEFAULT_MAX_CHUNK_BUFFER;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const timeoutS = opts.timeoutS ?? DEFAULT_TIMEOUT_S;
  const disabled = opts.disabled ?? false;
  const redactOnClient =
    opts.redactOnClient ?? envOptBool("EDEN_REDACT_ON_CLIENT") ?? false;
  const captureChunkText =
    opts.captureChunkText ?? envOptBool("EDEN_CAPTURE_CHUNK_TEXT") ?? false;
  const gatewayUrl = opts.gatewayUrl ?? readEnv("EDEN_GATEWAY_URL");
  const filters = opts.filters;
  const exactCache = opts.exactCache ?? envOptBool("EDEN_EXACT_CACHE") ?? true;
  const coalesce = opts.coalesce ?? envOptBool("EDEN_COALESCE") ?? true;
  const providerCacheLayout =
    opts.providerCacheLayout ?? envOptBool("EDEN_PROVIDER_CACHE_LAYOUT") ?? true;
  const responseRepair =
    opts.responseRepair ?? envOptBool("EDEN_RESPONSE_REPAIR") ?? true;

  if (strict && !orgId) {
    throw new Error(
      "[eden-ai] orgId is required when strict mode is enabled",
    );
  }

  if (!disabled && !orgId) {
    // Without an orgId, buildIngestUrl returns "" and EVERY event is
    // dropped — silently, with no warning at all, because the apiKey
    // warning below is itself gated on `orgId` being set. A developer
    // integrating for the first time saw a completely quiet SDK and no
    // data in the portal, with nothing to go on.
    //
    // Not thrown, because `strict` above owns that decision and
    // throwing here would break anyone relying on the no-op. The
    // Python SDK raises a clear ValueError in the same situation
    // (config.py), so this at least brings the two into earshot.
    console.warn(
      "[eden-ai] orgId is not set — every event will be discarded and " +
        "nothing will reach the portal. Set orgId (or EDEN_ORG_ID), or " +
        "pass disabled: true if that is intended.",
    );
  }

  if (!disabled && !debug && orgId && !apiKey) {
    // The gateway may accept other auth schemes (mTLS, signed URLs,
    // bearer tokens via ``gatewayUrl``), but the absence of an
    // ``apiKey`` is worth flagging at startup so the operator notices
    // before the first failed ingest.
    console.warn(
      "[eden-ai] apiKey is not set; ingestion will rely on extra auth headers or the gateway's own scheme.",
    );
  }

  // Hook reserved for future validation (queue size ceiling, batch-vs-flush sanity, baseUrl shape).

  return {
    orgId,
    apiKey,
    projectId,
    agentId,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    gatewayUrl,
    filters,
    realm,
    tags: [...(opts.tags ?? [])],
    metadata: { ...(opts.metadata ?? {}) },
    maxBatchSize,
    maxQueueSize,
    flushIntervalMs,
    maxChunkBuffer,
    timeoutS,
    disabled,
    redactOnClient,
    captureChunkText,
    debug,
    strict,
    exactCache,
    coalesce,
    providerCacheLayout,
    responseRepair,
  };
}

/**
 * Build the canonical gateway URL for OpenAI-compatible calls.
 * Falls back to `\${baseUrl}/gateway/v1` when `gatewayUrl` is unset.
 */
export function resolvedGatewayUrl(cfg: ResolvedConfig): string {
  if (cfg.gatewayUrl) return cfg.gatewayUrl;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/gateway/v1") || base.endsWith("/v1")) return base;
  return `${base}/gateway/v1`;
}


/**
 * Parse a ``Retry-After`` response header (RFC 7231).
 *
 * Accepts either the delta-seconds form (``"5"``) or an
 * HTTP-date (``"Wed, 21 Oct 2015 07:28:00 GMT"``). Returns
 * the milliseconds to wait, capped at 30s, falling back to
 * ``fallbackMs`` on any parse failure so a malformed header
 * never wedges the retry loop.
 *
 * Mirrors :meth:`EdenClient._parse_retry_after` in the Python
 * SDK -- the two SDKs must surface identical behaviour for
 * both header forms so a single gateway-side retry policy
 * drives both.
 */
export function parseRetryAfterMs(value: string, fallbackMs: number): number {
  // Fast path: integer / float seconds.
  const seconds = parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000);
  }
  // Slow path: HTTP-date. ``Date.parse`` accepts the RFC 1123 /
  // 7231 format used by every real gateway and returns NaN for
  // anything else.
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return fallbackMs;
  const delta = ts - Date.now();
  // Past HTTP-date means "retry now" -- clamp to 0 so we don't
  // accidentally back off further. A far-future date is capped
  // to keep the worker responsive.
  if (delta <= 0) return 0;
  return Math.min(delta, 30_000);
}
/**
 * Per-call overrides for {@link EdenSDK.gatewayHeaders}. Mirrors
 * the kwarg shape of `EdenConfig.gateway_headers()` in the Python SDK.
 */
export interface GatewayHeadersOptions {
  /** Override the upstream base URL for this call (e.g. OpenRouter, Anthropic). */
  upstreamBaseUrl?: string;
  /** Override the upstream API key for this call. Stripped before forwarding. */
  upstreamApiKey?: string;
  /** Optional provider hint for telemetry labelling (openai/openrouter/anthropic/...). */
  upstreamProvider?: string;
  /** Per-request PII bypass. Wins over the process-wide filter config. */
  piiBypass?: boolean;
  /** Per-call filter overrides. When unset, uses `config.filters`. */
  filters?: FilterConfig;
}

// ── Process-exit safety net ─────────────────────────────────────────

// Guard so the exit hooks are registered at most once per process,
// no matter how many `EdenSDK` instances get constructed. Mirrors
// the Python SDK's `_atexit_registered` module-level flag in
// `client.py`'s `get_default_client()` (its `atexit.register(...)`
// call is guarded the exact same way).
let _exitHooksRegistered = false;

// Every constructed `EdenSDK` instance, so the exit hooks can flush
// ALL live clients best-effort -- not just the default singleton
// (broader than Python, which only auto-flushes its one process-wide
// singleton, but strictly safer here: nothing keeping a direct
// `new EdenSDK()` reference around should lose data on an abrupt
// exit either). Entries are removed by `dispose()`.
const _liveClients = new Set<EdenSDK>();

/**
 * Best-effort flush/dispose of every live client. Never throws --
 * an exit hook that throws can abort the Node exit sequence with an
 * unhandled-rejection warning, which is worse than losing telemetry.
 */
function _bestEffortFlushAll(): void {
  for (const client of _liveClients) {
    try {
      void client.dispose();
    } catch {
      // Never let telemetry shutdown break process exit.
    }
  }
}

/**
 * Register a `beforeExit` hook (Node keeps draining the event loop
 * for any pending async work scheduled here, so the in-flight
 * flush/dispose POST gets a real chance to land) plus best-effort
 * `SIGTERM`/`SIGINT` handlers, so spans/events sitting in the queue
 * or chunk buffer are not silently lost on abrupt process exit --
 * previously nothing in this package ever called `process.on(...)`,
 * so only an explicit `dispose()`/`flush()` call by the user saved
 * unflushed telemetry. Mirrors the Python SDK's `atexit.register()`
 * safety net.
 *
 * Registering a signal listener suppresses Node's default
 * terminate-on-signal behaviour, so — unlike `beforeExit` — the
 * SIGTERM/SIGINT handlers must explicitly `process.exit()` once the
 * best-effort flush settles (or a bounded timeout elapses),
 * otherwise a SIGTERM-based graceful shutdown (Docker, systemd,
 * Kubernetes) would hang forever instead of terminating.
 */
function _registerProcessExitHooksOnce(): void {
  if (_exitHooksRegistered) return;
  if (typeof process === "undefined" || typeof process.once !== "function") {
    return;
  }
  _exitHooksRegistered = true;
  try {
    process.once("beforeExit", () => {
      _bestEffortFlushAll();
    });
  } catch {
    // Some hosts (e.g. certain edge/worker runtimes) may not
    // support `beforeExit`; best-effort only.
  }
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    try {
      process.once(sig, () => {
        const settle = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2_000);
          if (typeof (t as { unref?: () => void }).unref === "function") {
            (t as { unref?: () => void }).unref!();
          }
        });
        const flushed = (async () => {
          for (const client of _liveClients) {
            try {
              await client.dispose();
            } catch {
              // best-effort
            }
          }
        })();
        Promise.race([flushed, settle]).then(
          () => process.exit(sig === "SIGINT" ? 130 : 143),
          () => process.exit(sig === "SIGINT" ? 130 : 143),
        );
      });
    } catch {
      // Some environments may not support process signal
      // listeners (e.g. certain serverless runtimes); ignore.
    }
  }
}

// ── Client ────────────────────────────────────────────────────────

/**
 * The SDK client. Exposed as `EdenSDK`; the package also exposes
 * a singleton accessed via {@link getDefaultClient}.
 */
export class EdenSDK {
  private config: ResolvedConfig;
  private queue: TelemetryEvent[] = [];
  private chunkBuffer: StreamChunk[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private chunkTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  // Promise tracked for the current in-flight batch POST so
  // ``dispose()`` can wait for the in-flight HTTP to finish
  // BEFORE releasing ``this.inflight``. Without this,
  // ``dispose()`` released the flag while a real POST was
  // still in flight and its subsequent ``flush()`` call
  // grabbed the same slot and started a second concurrent
  // POST — racing the first one for the same batch.
  /**
   * The in-flight batch POST, resolving to whether that batch fully
   * succeeded (every group 2xx).
   *
   * This used to be a ``Promise<void>``, which quietly broke
   * ``flush()``'s contract. ``flush()`` accumulates into a *local*
   * ``allOk``, so when one caller merely waited on a batch started by
   * someone else — the common case, since ``emit()`` fires
   * ``void this.flush()`` on its own once the queue reaches
   * ``maxBatchSize`` — it awaited the promise, learned nothing, found
   * the queue empty and returned its untouched ``true``. Verified: 8
   * events against a gateway returning a permanent 400 reported
   * ``flush() === true`` while every event was discarded, so a caller
   * doing ``if (!(await sdk.flush())) alert()`` could never fire.
   * Carrying the outcome on the promise lets every waiter inherit it.
   */
  private inflightPromise: Promise<boolean> | null = null;
  // Separate inflight flag for the chunk flush path.
  // Concurrent `flushChunks()` calls would otherwise both grab
  // the same buffer and double-POST chunks.
  private chunkInflight = false;
  // Promise tracked for the current in-flight chunk POST so
  // concurrent ``flushChunks()`` callers can wait for it
  // instead of returning immediately (which previously left
  // pending chunks stranded in the buffer at ``await`` time).
  private chunkInflightPromise: Promise<void> | null = null;
  private disposed = false;
  private sampler: ClientSampler;
  sampledOut = 0;
  /**
   * Events evicted from the front of the queue because it hit
   * ``maxQueueSize`` before a flush could drain it.
   *
   * The eviction itself is the right call — the alternative is
   * unbounded memory growth in a long-lived process — but it was
   * completely unobservable: unlike ``bufferChunk``'s overflow it did
   * not even emit a debug log, so a process losing telemetry to
   * back-pressure looked identical to one emitting nothing. Mirrors the
   * Python SDK's ``_dropped_total``.
   */
  droppedTotal = 0;
  /**
   * Last HTTP status from an ingest POST. ``null`` until the first
   * attempt, or after a network failure with no response. Used by
   * ``runDoctor`` to surface bad-key (401/403) without throwing.
   */
  lastIngestHttpStatus: number | null = null;
  /**
   * Events the server accepted the REQUEST for but refused to store.
   *
   * A 2xx only means the batch was understood. The body carries the
   * per-row outcome as ``{accepted, rejected, deduplicated, total}``,
   * and a fully-rejected batch still returns 200 — so without this a
   * 100%-rejected stream is indistinguishable from a healthy one. That
   * is exactly how a broken ingest endpoint stayed invisible while
   * every SDK reported success.
   *
   * These are NOT retried: rows are rejected for being malformed, so
   * resending would loop forever. Visibility is the fix, not retry.
   *
   * Mirrors the Python SDK's ``rejected`` property.
   */
  rejectedTotal = 0;
  /** Events the server confirmed it stored. */
  acceptedTotal = 0;
  private offline: OfflineQueue | null = null;

  constructor(opts: EdenSDKOptions = {}) {
    this.config = resolveConfig(opts);
    this.sampler = new ClientSampler({
      profile: opts.samplingProfile ??
        ((process.env.EDEN_SAMPLING_PROFILE as SamplingProfile | undefined) ??
          "full"),
      keepErrors: opts.sampleKeepErrors ?? true,
    });
    if (opts.offlineQueuePath || process.env.EDEN_OFFLINE_QUEUE === "1") {
      try {
        this.offline = new OfflineQueue(opts.offlineQueuePath);
      } catch {
        this.offline = null;
      }
    }
    if (this.config.debug) {
      // eslint-disable-next-line no-console
      console.debug(
        "[eden-ai] initialised",
        { orgId: this.config.orgId, baseUrl: this.config.baseUrl },
      );
    }
    _liveClients.add(this);
    _registerProcessExitHooksOnce();
  }

  /** Update configuration after construction (e.g. once auth resolves). */
  configure(opts: EdenSDKOptions): void {
    this.config = resolveConfig({ ...this.config, ...opts });
  }

  /** Returns the resolved config (read-only snapshot). */
  getConfig(): Readonly<ResolvedConfig> {
    return this.config;
  }

  /**
   * Resolve the OpenAI-compatible gateway URL. Falls back to
   * `\${baseUrl}/gateway/v1` when `gatewayUrl` is unset. Mirrors
   * `EdenConfig.resolved_gateway_url()` in the Python SDK.
   */
  resolvedGatewayUrl(): string {
    return resolvedGatewayUrl(this.config);
  }

  /**
   * Build the headers for a single OpenAI-compatible gateway call.
   *
   * Includes standard Eden auth headers (X-Org-Id, X-Org-Api-Key,
   * X-Project-Id) plus any per-request upstream overrides and the
   * per-filter configuration. The gateway strips
   * X-Upstream-Api-Key + X-Org-Api-Key before forwarding to the
   * upstream so credentials never leak to a third-party provider.
   *
   * Mirrors `EdenConfig.gateway_headers()` in the Python SDK.
   */
  gatewayHeaders(
    opts: GatewayHeadersOptions = {},
  ): Record<string, string> {
    const headers: Record<string, string> = this.buildHeaders();
    if (opts.upstreamBaseUrl) {
      headers["X-Upstream-Base-Url"] = opts.upstreamBaseUrl;
    }
    if (opts.upstreamApiKey) {
      headers["X-Upstream-Api-Key"] = opts.upstreamApiKey;
    }
    if (opts.upstreamProvider) {
      headers["X-Upstream-Provider"] = opts.upstreamProvider;
    }
    if (opts.piiBypass !== undefined) {
      headers["X-PII-Bypass"] = opts.piiBypass ? "true" : "false";
    }
    const activeFilters = opts.filters ?? this.config.filters;
    if (activeFilters !== undefined) {
      Object.assign(headers, activeFilters.toHeaders());
    }
    Object.assign(
      headers,
      optimizationOptOutHeaders({
        exactCache: this.config.exactCache,
        coalesce: this.config.coalesce,
        providerCacheLayout: this.config.providerCacheLayout,
        responseRepair: this.config.responseRepair,
      }),
    );
    return headers;
  }

  /**
   * Enqueue a telemetry event. Returns immediately. The queue is
   * flushed on a timer, on overflow, and on {@link flush}.
   */
  emit(event: TelemetryEvent): void {
    if (this.disposed) return;
    if (this.config.disabled) return;
    // Stamp configured agentId when the emitter omitted it.
    if (this.config.agentId && !event.agentId) {
      event = { ...event, agentId: this.config.agentId };
    }
    const sampler = this.sampler;
    // Single payload read — avoid double cast / property walk on
    // the emit hot path (every instrumented LLM call).
    //
    // The flagship instrumentation paths do NOT all use the same
    // error-signalling key: `trace()`/`traceAgent()` (trace.ts's
    // `finishTrace`, backing every `agent.run` event), openai.ts,
    // anthropic.ts, and vercel-ai.ts all emit `status: "error"` +
    // `error_type` -- never a literal `error` or `outcome: "error"`
    // key. Only providers.ts (Bedrock/Gemini) and mastra.ts use a
    // literal `outcome` key. Checking only `error`/`outcome` meant
    // the sampler's error-sampling safety net (`sampleKeepErrors`,
    // default true) silently missed most real error traces under
    // `balanced`/`aggressive` profiles -- they were subject to the
    // same random keep-rate as any other event instead of being
    // force-kept. Check every shape so this works regardless of
    // which instrumentation produced the payload.
    const payload = event.payload as
      | {
          error?: unknown;
          outcome?: string;
          status?: string;
          error_type?: unknown;
        }
      | undefined;
    const hasError = Boolean(
      payload?.error ||
        payload?.outcome === "error" ||
        payload?.status === "error" ||
        payload?.error_type,
    );
    const durationMs = event.durationMs ?? 0;
    if (!sampler.shouldKeep({ hasError, durationMs })) {
      this.sampledOut += 1;
      return;
    }
    // Drop the oldest event when we exceed the queue ceiling. This
    // mirrors the Python SDK's behaviour and prevents unbounded
    // memory growth in long-lived processes.
    if (this.queue.length >= this.config.maxQueueSize) {
      this.queue.shift();
      this.droppedTotal += 1;
      if (this.config.debug) {
        // eslint-disable-next-line no-console
        console.debug(
          "[eden-ai] queue overflow, dropped oldest event (total:",
          this.droppedTotal,
          ")",
        );
      }
    }
    this.queue.push(event);
    if (this.queue.length >= this.config.maxBatchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Buffer a single streaming chunk. Buffered chunks are flushed
   * separately to `/ingest/chunks` (Python SDK: `ChunksIngestRequest`).
   */
  bufferChunk(chunk: StreamChunk): void {
    if (this.disposed) return;
    // Cap the chunk buffer at ``maxChunkBuffer`` entries.
    // Drop the oldest on overflow (a runaway streaming
    // response producing millions of small chunks would
    // OOM the process before this). Mirrors the Python
    // SDK's ``_chunk_buffer_max`` from 0.2.13. We use
    // ``shift`` (O(n)) rather than a deque because the
    // producer pace is throttled by the worker tick
    // (default 250ms) so total work per cycle stays
    // bounded.
    if (this.chunkBuffer.length >= this.config.maxChunkBuffer) {
      this.chunkBuffer.shift();
      if (this.config.debug) {
        // eslint-disable-next-line no-console
        console.debug(
          "[eden-ai] chunk buffer overflow, dropped oldest",
        );
      }
    }
    this.chunkBuffer.push(chunk);
    if (this.chunkBuffer.length >= this.config.maxBatchSize) {
      // Trigger an immediate flush. ``flushChunks()`` itself
      // claims the inflight slot atomically, so this is safe
      // even if a POST is already in flight (the new caller
      // will wait on ``chunkInflightPromise`` and pick up
      // remaining chunks on the next loop iteration).
      void this.flushChunks();
    } else if (this.chunkTimer === null) {
      this.chunkTimer = setTimeout(() => {
        this.chunkTimer = null;
        void this.flushChunks();
      }, this.config.flushIntervalMs);
      // ``.unref()`` lets the timer exit with the process.
      // Without this, a short-lived script that armed a
      // chunk timer (and then finished its work) would
      // hang for ``flushIntervalMs`` (default 250ms) after
      // the last user code ran -- a real problem in CLI
      // tools and short-lived scripts.
      if (typeof this.chunkTimer.unref === "function") {
        this.chunkTimer.unref();
      }
    }
  }

  /**
   * Flush queued events. Returns a promise that resolves when the
   * batch POST completes (or fails silently). Concurrent callers
   * wait for the in-flight POST, then drain any events that
   * arrived during it — same contract as {@link flushChunks}.
   */
  async flush(): Promise<boolean> {
    // Loop until the queue is fully drained. A concurrent
    // ``flush()`` used to return immediately while another POST
    // was in flight, so ``await flush()`` after emit-during-flush
    // could resolve before the newly queued events shipped.
    // Waiting on ``inflightPromise`` then draining again matches
    // the chunk-path contract.
    //
    // Returns ``true`` only when every batch POST completed with
    // HTTP 2xx (or the queue was already empty).
    let allOk = true;
    while (true) {
      if (this.inflight) {
        // Inherit the outcome of the batch we are waiting on, rather
        // than discarding it and reporting our own untouched ``true``.
        if ((await this.inflightPromise) === false) allOk = false;
        continue;
      }
      if (this.queue.length === 0) return allOk;
      // Atomically claim the in-flight slot so concurrent flush()
      // callers can't both grab the same batch (race that
      // previously produced >1 POST). The check + set must be
      // synchronous before the first await.
      this.inflight = true;
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      // Cap the batch at ``maxBatchSize``. This used to take the whole
      // queue (``const batch = this.queue; this.queue = []``), which made
      // ``maxBatchSize`` a flush *trigger* rather than a size limit: it
      // only bounds the depth at which ``emit`` decides to flush, and
      // events keep accumulating while a POST is in flight. Measured with
      // maxBatchSize=50 and one hung POST, the queue reached 910 events
      // that would then have gone out as a single request — up to
      // ``maxQueueSize`` (4096) in the limit.
      //
      // That matters beyond request size: one oversized POST is
      // all-or-nothing, so a single 413 or permanent 4xx took out
      // thousands of events at once instead of 50. The Python SDK has
      // always capped here (``self._drain(self.config.batch_size)``);
      // this is the parity fix. The loop below re-drains until empty, so
      // capping costs an extra iteration, not throughput.
      const batch = this.queue.splice(0, this.config.maxBatchSize);
      // Track the in-flight POST so ``dispose()`` can await it
      // before releasing ``this.inflight``. Without this the
      // ``dispose() → flush()`` chain could start a second
      // concurrent POST while the first was still in flight.
      // Held in a local as well as on the instance: the ``finally``
      // below nulls the field, so awaiting the field rather than the
      // local would be a race against our own cleanup.
      const inflight = (async (): Promise<boolean> => {
        try {
          return await this.postBatch(batch);
        } catch (err) {
          if (this.config.debug) {
            // eslint-disable-next-line no-console
            console.debug("[eden-ai] flush failed (swallowed)", err);
          }
          return false;
        } finally {
          this.inflight = false;
          this.inflightPromise = null;
          // Re-arm the timer if events accumulated while we were
          // in-flight and no waiter is draining the loop (e.g.
          // ``void this.flush()`` from ``emit`` overflow).
          this.scheduleFlush();
        }
      })();
      this.inflightPromise = inflight;
      if (!(await inflight)) allOk = false;
    }
  }

  /**
   * Arm a flush timer if one is not already armed and there are
   * events to flush. Safe to call from anywhere; the timer is
   * a no-op when the queue is empty.
   */
  private scheduleFlush(): void {
    if (this.disposed) return;
    if (this.queue.length === 0) return;
    if (this.inflight) return;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.config.flushIntervalMs);
    // ``.unref()`` so a short-lived script doesn't hang on
    // the last arm'd timer. See the matching comment in
    // ``bufferChunk`` for the full rationale.
    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  /**
   * Flush buffered streaming chunks to `/ingest/chunks`. Same
   * concurrency rules as {@link flush}.
   */
  async flushChunks(): Promise<void> {
    // Cancel any pending timer so we don't get a parallel flush
    // from the timer arming path while we're flushing directly.
    if (this.chunkTimer !== null) {
      clearTimeout(this.chunkTimer);
      this.chunkTimer = null;
    }
    // Loop until the buffer is fully drained. The first iteration
    // may race with an already-in-flight POST triggered by a
    // previous ``flushChunks()`` call (or by the timer); waiting
    // for the in-flight POST to resolve before draining again
    // keeps callers from observing a half-flushed buffer. The
    // concurrent-double-POST race from the pre-fix code is still
    // prevented because the in-flight claim is atomic (see
    // ``_drainChunksOnce``).
    while (true) {
      if (this.chunkInflight) {
        // Another flush is in flight; wait for it to settle, then
        // loop again to pick up any chunks that arrived during it.
        await this.chunkInflightPromise;
        continue;
      }
      if (this.chunkBuffer.length === 0) return;
      await this._drainChunksOnce();
    }
  }

  /**
   * Single-shot chunk buffer drain. POSTs whatever is currently in
   * ``chunkBuffer`` and waits for the POST to resolve. Safe under
   * concurrent calls because the inflight claim + drain happens
   * synchronously before the first ``await``, so a second caller
   * will see ``chunkInflight === true`` and wait on
   * ``chunkInflightPromise`` instead of grabbing the same buffer.
   */
  private async _drainChunksOnce(): Promise<void> {
    this.chunkInflight = true;
    const chunks = this.chunkBuffer;
    this.chunkBuffer = [];
    this.chunkInflightPromise = this._postChunksTracked(chunks).finally(() => {
      this.chunkInflight = false;
      this.chunkInflightPromise = null;
    });
    await this.chunkInflightPromise;
  }

  private async _postChunksTracked(chunks: StreamChunk[]): Promise<void> {
    try {
      await this.postChunks(chunks);
    } catch (err) {
      if (this.config.debug) {
        // eslint-disable-next-line no-console
        console.debug("[eden-ai] chunk flush failed (swallowed)", err);
      }
    }
    // Re-arm the timer if more chunks arrived during the POST so
    // they don't sit in the buffer indefinitely.
    if (this.chunkBuffer.length > 0 && this.chunkTimer === null && !this.disposed) {
      this.chunkTimer = setTimeout(() => {
        this.chunkTimer = null;
        void this.flushChunks();
      }, this.config.flushIntervalMs);
      if (typeof this.chunkTimer.unref === "function") {
        this.chunkTimer.unref();
      }
    }
  }

  /**
   * Flush all pending work and stop the timers. Safe to call from
   * process-exit hooks (`beforeExit`, `SIGTERM`) -- and, since the
   * constructor registers a best-effort process-exit safety net
   * (see `_registerProcessExitHooksOnce`), this now genuinely IS
   * called automatically on abrupt process exit, not just when a
   * caller remembers to invoke it manually.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    if (this.chunkTimer !== null) clearTimeout(this.chunkTimer);
    this.flushTimer = null;
    this.chunkTimer = null;
    // Wait for the in-flight batch POST (if any) to finish
    // BEFORE releasing the inflight slot. The previous code
    // released the slot here, then ``await this.flush()``
    // immediately grabbed it again — and a real POST was
    // still in flight on the first one. Awaiting the
    // tracked promise keeps the slot held until the in-flight
    // POST resolves, so the subsequent ``flush()`` call sees
    // an empty queue (the batch was already shipped) and
    // returns. Mirrors the chunk-path handling just below.
    if (this.inflightPromise) {
      await this.inflightPromise;
      this.inflightPromise = null;
    }
    // Wait for the in-flight chunk POST (if any) BEFORE
    // releasing the chunkInflight slot. Mirrors the batch
    // path above: the previous code set the flag to false
    // BEFORE awaiting the tracked promise, so a concurrent
    // ``flushChunks()`` call during the ``dispose()`` window
    // could see ``chunkInflight === false`` and grab the
    // (already-shipped) buffer -- producing a phantom POST
    // with an empty body. The order matters: await the POST
    // first, then release the slot.
    if (this.chunkInflightPromise) {
      await this.chunkInflightPromise;
      this.chunkInflightPromise = null;
    }
    this.chunkInflight = false;
    await Promise.allSettled([this.flush(), this.flushChunks()]);
    _liveClients.delete(this);
  }

  /**
   * Replay durable offline events (spilled to disk by `postBatch` /
   * `postChunkBatch` during an outage) back to the ingest server.
   * Mirrors the Python SDK's `flush_offline()`: there was previously
   * no public API to do this at all in the TS SDK, even though
   * `OfflineQueue.drain()` already existed -- outage recovery
   * required a manual read of the JSONL file.
   *
   * Rows are only acked (deleted from the offline queue) on
   * CONFIRMED delivery success, never merely "attempt completed" --
   * a timed-out send, a permanent failure, or an unreachable orgId
   * all leave the rows durably on disk for a later `flushOffline()`
   * call to retry, exactly like Python's `ack` step (which only
   * runs after `flush()` proves the queue and in-flight HTTP both
   * settled).
   *
   * Sampling is bypassed entirely for this path (mirrors Python's
   * `enqueue(..., skip_sampling=True)`): a row that already survived
   * the offline-queue spill filter (only transient failures spill,
   * see `postBatch`/`postChunkBatch`) must not then be silently
   * dropped by `ClientSampler` before being acked away.
   *
   * @param limit Maximum number of durable rows to replay this call.
   * @param timeoutMs Overall wall-clock budget for the replay to
   *   settle. If it has not fully resolved within this window,
   *   nothing is acked and the method returns 0 -- the rows remain
   *   on disk (a slow send that eventually succeeds in the
   *   background will simply be re-sent on the next replay; safe,
   *   because acking early on a mere "sent" rather than a confirmed
   *   settle is the exact bug this mirrors Python's fix for).
   * @returns The number of rows acked (confirmed delivered and removed).
   */
  async flushOffline(limit = 100, timeoutMs = 5_000): Promise<number> {
    const offline = this.offline;
    if (!offline) return 0;
    const rows = offline.peek(limit);
    if (rows.length === 0) return 0;

    const byFormat = new Map<string, OfflineRow[]>();
    for (const row of rows) {
      let list = byFormat.get(row.sourceFormat);
      if (list === undefined) {
        list = [];
        byFormat.set(row.sourceFormat, list);
      }
      list.push(row);
    }

    const send = (async (): Promise<OfflineRow[]> => {
      const acked: OfflineRow[] = [];
      await Promise.all(
        Array.from(byFormat.entries()).map(async ([format, formatRows]) => {
          if (format === OFFLINE_CHUNKS_FORMAT) {
            // Chunk-batch spills (see `postChunkBatch`) carry a
            // `{ chunks: [...] }` payload bound for the dedicated
            // chunks endpoint, not `/ingest/{format}`.
            const url = this.buildChunkUrl();
            if (!url) return;
            for (const row of formatRows) {
              const chunks = (row.payload as { chunks?: unknown } | undefined)
                ?.chunks;
              if (!Array.isArray(chunks)) continue;
              const outcome = await this.postJson(url, { chunks });
              if (outcome === "ok") acked.push(row);
            }
            return;
          }
          const pathFmt = resolveIngestPath(format);
          const url = this.buildIngestUrl(pathFmt);
          if (!url) return;
          const wired = formatRows.map((row) =>
            eventToWire(this._offlineRowToEvent(row)),
          );
          const outcome = await this.postJson(url, wired);
          if (outcome === "ok") {
            for (const row of formatRows) acked.push(row);
          }
          // Transient ("spill") and permanent ("drop") outcomes are
          // both left on disk untouched -- `flushOffline` only ever
          // acks rows it confirmed were delivered.
        }),
      );
      return acked;
    })();

    const TIMED_OUT = Symbol("flushOffline-timeout");
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      const t = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      if (typeof (t as { unref?: () => void }).unref === "function") {
        (t as { unref?: () => void }).unref!();
      }
    });

    const result = await Promise.race([send, timeout]);
    if (result === TIMED_OUT) {
      return 0;
    }
    const acked = result;
    if (acked.length > 0) offline.ack(acked);
    return acked.length;
  }

  /**
   * Reconstruct a wire-ready `TelemetryEvent` envelope for an
   * offline-queue row. The offline queue only durably stores
   * `{ sourceFormat, payload }` (see `postBatch`'s spill path) --
   * the original event's own `eventId`/`traceId`/`eventType` are
   * not part of that stored shape, so a replay synthesizes fresh
   * ones from the current config, preferring whatever the stored
   * payload itself already carries (e.g. an `event_id`/`trace_id`/
   * `event_type` field the original payload happened to include).
   */
  private _offlineRowToEvent(row: OfflineRow): TelemetryEvent {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const eventId =
      typeof payload.event_id === "string"
        ? payload.event_id
        : `offline_${randomUUID()}`;
    const traceId =
      typeof payload.trace_id === "string" ? payload.trace_id : randomUUID();
    const eventType =
      typeof payload.event_type === "string"
        ? payload.event_type
        : "offline_replay";
    return {
      eventId,
      tenantId: this.config.orgId ?? "default",
      projectId: this.config.projectId,
      traceId,
      realm: this.config.realm,
      eventType,
      timestamp: new Date().toISOString(),
      sourceFormat: row.sourceFormat,
      payload,
    };
  }

  // ── HTTP ───────────────────────────────────────────────────────

  private buildIngestUrl(sourceFormat: string): string {
    if (!this.config.orgId) return ""; // dev-mode: no-op
    return `${this.config.baseUrl}/orgs/${this.config.orgId}/ingest/${sourceFormat}`;
  }

  private buildChunkUrl(): string {
    if (!this.config.orgId) return "";
    return `${this.config.baseUrl}/orgs/${this.config.orgId}/ingest/chunks`;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": SDK_USER_AGENT,
      ...extra,
    };
    if (this.config.orgId) headers["X-Org-Id"] = this.config.orgId;
    if (this.config.apiKey) headers["X-Org-Api-Key"] = this.config.apiKey;
    if (this.config.projectId) headers["X-Project-Id"] = this.config.projectId;
    if (this.config.agentId) headers["X-Eden-Agent-Id"] = this.config.agentId;
    return headers;
  }

  private async postBatch(events: TelemetryEvent[]): Promise<boolean> {
    // Group by remapped ingest path — gateway allow-list is narrow;
    // resolveIngestPath collapses custom/framework aliases to webhook.
    const byFormat = new Map<string, TelemetryEvent[]>();
    for (const ev of events) {
      const pathFmt = resolveIngestPath(ev.sourceFormat);
      let list = byFormat.get(pathFmt);
      if (list === undefined) {
        list = [];
        byFormat.set(pathFmt, list);
      }
      list.push(ev);
    }

    let allOk = true;
    const tasks: Promise<void>[] = [];
    for (const [format, items] of byFormat) {
      // Apply the client-side safety-net PII redactor to every nested
      // payload before it leaves the process. Mirrors the Python SDK's
      // ``redact_on_client`` path; the gateway remains the source of
      // truth for tenant redaction policy.
      //
      // Note on Python "parity": Python ``TraceEvent.payload`` *is* the
      // wire body (often already containing ``event_type``). The TS SDK
      // keeps a camelCase ``TelemetryEvent`` with a nested ``payload``,
      // so the wire body must be produced by ``eventToWire`` — posting
      // ``e.payload`` alone drops ``event_type`` / ``trace_id`` and
      // breaks gateway SQL filters.
      //
      // Redaction happens here rather than inside ``postFormat`` so a
      // 413 bisect does not re-redact each half.
      const redacted = this.config.redactOnClient
        ? items.map((e) => ({
            ...e,
            payload: redactPayload(e.payload ?? {}) as never,
          }))
        : items;
      tasks.push(
        this.postFormat(format, redacted).then((ok) => {
          if (!ok) allOk = false;
        }),
      );
    }
    await Promise.all(tasks);
    return allOk;
  }

  /**
   * POST one already-redacted, single-format group, bisecting on 413.
   *
   * ``postJson`` reports 413 as ``"too_large"``, but this path only ever
   * spilled on ``"spill"`` — so a 413 set ``allOk = false`` and then
   * dropped the batch on the floor: not retried, not split, not written
   * to the offline queue. Verified before the fix: 8 events into a
   * gateway that 413s anything over 2 produced 0 delivered and 0
   * spilled. They simply vanished.
   *
   * 413 says nothing about the events themselves — it is a statement
   * about *this batch's size*, and the same events split in two
   * succeed. ``postChunkBatch`` has bisected on it since it was
   * written; the main event path never got the same treatment (the
   * identical gap existed in the Python SDK's ``_send_format``).
   *
   * Recursing keeps per-group bookkeeping exact and drives a genuinely
   * oversized single event down to a batch of one, where the permanent
   * -failure verdict is finally the correct one.
   */
  private async postFormat(
    format: string,
    redacted: TelemetryEvent[],
  ): Promise<boolean> {
    if (redacted.length === 0) return true;
    const url = this.buildIngestUrl(format);
    if (!url) {
      if (this.config.debug) {
        // eslint-disable-next-line no-console
        console.debug("[eden-ai] no orgId; dropping", redacted.length, "events");
      }
      return false;
    }
    const wired = redacted.map(eventToWire);
    const outcome = await this.postJson(url, wired);
    if (outcome === "ok") return true;
    if (outcome === "too_large" && redacted.length > 1) {
      const mid = Math.floor(redacted.length / 2);
      if (this.config.debug) {
        // eslint-disable-next-line no-console
        console.debug(
          "[eden-ai] 413 from gateway; splitting",
          redacted.length,
          "->",
          mid,
          "+",
          redacted.length - mid,
        );
      }
      const first = await this.postFormat(format, redacted.slice(0, mid));
      const second = await this.postFormat(format, redacted.slice(mid));
      return first && second;
    }
    // Only spill transient failures. Permanent 4xx would poison the
    // offline queue with payloads that can never succeed. A lone event
    // that still 413s is genuinely unsendable, so it lands here too.
    if (outcome === "spill" && this.offline) {
      for (const item of redacted) {
        try {
          this.offline.enqueue(
            format,
            (item.payload ?? {}) as Record<string, unknown>,
          );
        } catch {
          // ignore spill errors
        }
      }
    }
    return false;
  }

  private async postChunks(chunks: StreamChunk[]): Promise<void> {
    const url = this.buildChunkUrl();
    if (!url) return;
    // Apply the client-side PII safety net to every chunk's
    // ``deltaText`` before it leaves the process. Streaming
    // responses often contain model-echoed PII (an email
    // address the user put in the prompt that the model then
    // repeated in its reply) — without this, that PII would
    // bypass the batched redaction in ``postBatch``.
    const prepared = this.config.redactOnClient
      ? chunks.map((c) => ({
          ...c,
          // ``deltaText`` is optional in the wire type — fall
          // back to empty string so the redactor always gets
          // a string. The redaction result is then written
          // back into the same nullable shape so the wire
          // contract is unchanged.
          deltaText: redactString(c.deltaText ?? ""),
        }))
      : chunks;
    // Translate the TS SDK's camelCase chunk fields to the
    // server's snake_case ``ChunksIngestRequest`` schema at the
    // wire boundary. Without this the gateway would store
    // ``deltaText``/``tpotMs`` as NULL and the per-chunk
    // dashboards would always render empty.
    // Cap each POST at ``INGEST_CHUNKS_MAX_PER_REQUEST`` (BE
    // default 1000). A full ``maxChunkBuffer`` drain (≤4096)
    // must not ship as one request — Python ``_send_chunks``
    // does the same split.
    const wire = prepared.map(chunkToWire);
    for (let i = 0; i < wire.length; i += INGEST_CHUNKS_MAX_PER_REQUEST) {
      await this.postChunkBatch(
        url,
        wire.slice(i, i + INGEST_CHUNKS_MAX_PER_REQUEST),
      );
    }
  }

  /**
   * POST one chunk batch (≤1000). On 413, bisect and retry —
   * mirrors Python ``TelemetryCollector._post_chunk_batch``.
   */
  private async postChunkBatch(
    url: string,
    batch: ReturnType<typeof chunkToWire>[],
  ): Promise<void> {
    if (batch.length === 0) return;
    const outcome = await this.postJson(url, { chunks: batch });
    if (outcome === "too_large" && batch.length > 1) {
      const mid = Math.floor(batch.length / 2);
      if (this.config.debug) {
        // eslint-disable-next-line no-console
        console.debug(
          "[eden-ai] ingest chunks returned 413; splitting",
          batch.length,
          "->",
          mid,
          "+",
          batch.length - mid,
        );
      }
      await this.postChunkBatch(url, batch.slice(0, mid));
      await this.postChunkBatch(url, batch.slice(mid));
      return;
    }
    // Only transient failures (408/429/5xx/network) spill -- a
    // permanent 4xx ("drop") would poison the offline queue with a
    // batch that can never succeed, same rule `postBatch` follows.
    // Previously this outcome was never inspected at all, so a
    // chunk batch that failed permanently (or exhausted retries)
    // was silently dropped from memory with no offline-queue
    // fallback, unlike the regular event batch path. Chunks are
    // tagged with the reserved ``"chunks"`` source format (distinct
    // from any real ``sourceFormat``) so a future replay can tell
    // chunk records apart from ordinary telemetry events.
    if (outcome === "spill" && this.offline) {
      try {
        this.offline.enqueue(OFFLINE_CHUNKS_FORMAT, { chunks: batch });
      } catch {
        // ignore spill errors
      }
    }
  }

  /**
   * POST gzip JSON to an ingest URL.
   * @returns ``"ok"`` on 2xx; ``"spill"`` after exhausting retryable
   * failures (408/429/5xx/network) for offline queue; ``"drop"`` on
   * permanent 4xx (auth/validation) — do not spill; ``"too_large"``
   * on 413 so chunk ingest can bisect and retry.
   */
  /**
   * Record the per-row outcome carried by a 2xx ingest response.
   *
   * The gateway answers ``{accepted, rejected, deduplicated, total}``.
   * Reading only ``res.ok`` treated a fully-rejected batch as a clean
   * flush, which is precisely how a broken ingest endpoint went
   * unnoticed. Counters are left untouched when the body is not that
   * shape, so an older or differently-shaped gateway can never make
   * the SDK report something it did not observe.
   */
  private async recordIngestOutcome(res: Response): Promise<void> {
    let parsed: unknown;
    try {
      parsed = await res.clone().json();
    } catch {
      return; // Not JSON — nothing reliable to record.
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const body = parsed as Record<string, unknown>;
    if (!("accepted" in body) && !("rejected" in body)) return;

    const accepted = Number(body.accepted ?? 0);
    const rejected = Number(body.rejected ?? 0);
    if (Number.isFinite(accepted) && accepted > 0) {
      this.acceptedTotal += accepted;
    }
    if (Number.isFinite(rejected) && rejected > 0) {
      this.rejectedTotal += rejected;
      const total = Number(body.total ?? accepted + rejected);
      // Always warn — not gated on `debug`. A customer whose events are
      // being silently discarded needs to hear about it by default.
      console.warn(
        `[eden-ai] server rejected ${rejected}/${total} event(s) as ` +
          `malformed; they will NOT be retried`,
      );
    }
  }

  private async postJson(
    url: string,
    body: unknown,
  ): Promise<"ok" | "spill" | "drop" | "too_large"> {
    if (typeof fetch === "undefined") {
      throw new Error(
        "[eden-ai] global fetch is not available; " +
          "use Node 18+ or a fetch polyfill (e.g. undici).",
      );
    }
    // Gzip once per call (not per retry). Cached zlib + level 1
    // matches Python SDK ingest; body Buffer is reused across
    // attempts so a 429/5xx retry does not re-serialize.
    const compressed = await gzipJsonBody(body);
    const headers = this.buildHeaders({ "Content-Encoding": "gzip" });
    // Retry transient failures with exponential backoff. 4xx other
    // than 408/429 are treated as permanent and not retried. Honours
    // the ``Retry-After`` response header up to 30s. 413 is returned
    // as ``"too_large"`` (not retried here) so ``postChunkBatch`` can
    // bisect — matching Python ``_post_chunk_batch``.
    const MAX_ATTEMPTS = 3;
    const BASE_DELAY_MS = 200;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timeoutMs = Math.max(1, Math.round(this.config.timeoutS * 1000));
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Node's global `fetch` (undici) keeps HTTP/1.1 connections alive
        // and pools them per-origin automatically — there's no httpx-style
        // `Client(limits=...)` connection-pool knob to configure here.
        const res = await fetch(url, {
          method: "POST",
          headers,
          // Buffer is a Uint8Array subclass — cast for DOM BodyInit typings.
          body: compressed as BodyInit,
          signal: controller.signal,
        });
        this.lastIngestHttpStatus = res.status;
        if (res.ok) {
          await this.recordIngestOutcome(res);
          return "ok";
        }
        const status = res.status;
        if (status === 413) return "too_large";
        const retryable = status === 429 || status === 408 || status >= 500;
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          if (this.config.debug) {
            // eslint-disable-next-line no-console
            console.debug("[eden-ai] non-2xx from gateway", status, url);
          }
          return retryable ? "spill" : "drop";
        }
        const ra = res.headers.get("retry-after");
        const fallbackMs = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 5_000);
        const delayMs = ra ? parseRetryAfterMs(ra, fallbackMs) : fallbackMs;
        if (delayMs > 0) {
          await sleepUnref(delayMs);
        }
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) {
          if (this.config.debug) {
            // eslint-disable-next-line no-console
            console.debug("[eden-ai] fetch failed", err);
          }
          return "spill";
        }
        const delayMs = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 5_000);
        await sleepUnref(delayMs);
      } finally {
        clearTimeout(timeout);
      }
    }
    return "spill";
  }
}

// ── Default singleton ─────────────────────────────────────────────

let _default: EdenSDK | undefined;

export function getDefaultClient(): EdenSDK {
  if (!_default) _default = new EdenSDK();
  return _default;
}

export function setDefaultClient(client: EdenSDK): void {
  _default = client;
}

export function resetDefaultClient(): void {
  const prev = _default;
  _default = undefined;
  // Disarm timers / mark disposed so an abandoned singleton cannot
  // POST into a later test's fetch stub (or a live process after
  // reconfigure). ``dispose`` is async; fire-and-forget is fine —
  // timer clear + ``disposed`` flag run synchronously at the start.
  if (prev) void prev.dispose();
}


/**
 * Free-function configuration helper, mirroring the Python SDK's
 * `eden.configure(...)`. Calls `.configure()` on the default client.
 *
 * ```ts
 * import { configure, wrapOpenAI } from "@eden-ai/sdk";
 * configure({ orgId: "org_abc", apiKey: "sk_..." });
 * ```
 */
export function configure(opts: EdenSDKOptions): void {
  getDefaultClient().configure(opts);
}
