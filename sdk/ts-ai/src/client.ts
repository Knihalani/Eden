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

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_REALM = "production";
const DEFAULT_PROJECT_ID = "default";
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_QUEUE_SIZE = 4096;
const DEFAULT_TIMEOUT_S = 5;
const DEFAULT_FLUSH_INTERVAL_MS = 250;


// ── Configuration ─────────────────────────────────────────────────

/**
 * Resolved configuration after env-var lookups and defaults.
 */
export interface ResolvedConfig {
  orgId: string | undefined;
  apiKey: string | undefined;
  projectId: string;
  baseUrl: string;
  /**
   * Explicit OpenAI-compatible gateway URL. When unset,
   * `resolvedGatewayUrl()` derives from `baseUrl + "/v1"`.
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
  /** Per-request timeout in seconds. Defaults to 5. Mirrors Python's ``timeout_s``. */
  timeoutS: number;
  /**
   * When true, the SDK buffers events but does NOT POST them to the
   * gateway. Useful for local dev or when an integration is in
   * shadow mode. Mirrors Python's ``disabled`` flag.
   */
  disabled: boolean;
  /**
   * If true (default), the SDK runs a small regex pass over every
   * outgoing payload to mask obvious emails, phone numbers, US SSNs,
   * and credit-card numbers. This is a *safety net* — the gateway
   * remains the authoritative redaction layer. Mirrors Python's
   * ``redact_on_client`` flag.
   */
  redactOnClient: boolean;
  debug: boolean;
  strict: boolean;
}

function readEnv(name: string): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    const v = process.env[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function resolveConfig(opts: EdenSDKOptions = {}): ResolvedConfig {
  const baseUrl = opts.baseUrl ?? readEnv("EDEN_BASE_URL") ?? DEFAULT_BASE_URL;
  const orgId = opts.orgId ?? readEnv("EDEN_ORG_ID") ?? readEnv("EDEN_DEFAULT_ORG");
  const apiKey =
    opts.apiKey ?? readEnv("EDEN_ORG_API_KEY") ?? readEnv("EDEN_API_KEY");
  const projectId = opts.projectId ?? readEnv("EDEN_PROJECT_ID") ?? DEFAULT_PROJECT_ID;
  const realm = opts.realm ?? readEnv("EDEN_REALM") ?? DEFAULT_REALM;
  const debug = opts.debug ?? readEnv("EDEN_DEBUG") === "1";
  const strict = opts.strict ?? false;
  const maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const maxQueueSize = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const timeoutS = opts.timeoutS ?? DEFAULT_TIMEOUT_S;
  const disabled = opts.disabled ?? false;
  const redactOnClient = opts.redactOnClient ?? true;
  const gatewayUrl = opts.gatewayUrl ?? readEnv("EDEN_GATEWAY_URL");
  const filters = opts.filters;

  if (strict && !orgId) {
    throw new Error(
      "[eden-ai] orgId is required when strict mode is enabled",
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
    baseUrl: baseUrl.replace(/\/+$/, ""),
    gatewayUrl,
    filters,
    realm,
    tags: [...(opts.tags ?? [])],
    metadata: { ...(opts.metadata ?? {}) },
    maxBatchSize,
    maxQueueSize,
    flushIntervalMs,
    timeoutS,
    disabled,
    redactOnClient,
    debug,
    strict,
  };
}

/**
 * Build the canonical gateway URL for OpenAI-compatible calls.
 * Falls back to `\${baseUrl}/v1` when `gatewayUrl` is unset.
 */
export function resolvedGatewayUrl(cfg: ResolvedConfig): string {
  if (cfg.gatewayUrl) return cfg.gatewayUrl;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1")) return base;
  return `${base}/v1`;
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
  private inflightPromise: Promise<void> | null = null;
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

  constructor(opts: EdenSDKOptions = {}) {
    this.config = resolveConfig(opts);
    if (this.config.debug) {
      // eslint-disable-next-line no-console
      console.debug(
        "[eden-ai] initialised",
        { orgId: this.config.orgId, baseUrl: this.config.baseUrl },
      );
    }
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
   * `\${baseUrl}/v1` when `gatewayUrl` is unset. Mirrors
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
    return headers;
  }

  /**
   * Enqueue a telemetry event. Returns immediately. The queue is
   * flushed on a timer, on overflow, and on {@link flush}.
   */
  emit(event: TelemetryEvent): void {
    if (this.disposed) return;
    if (this.config.disabled) return;
    // Drop the oldest event when we exceed the queue ceiling. This
    // mirrors the Python SDK's behaviour and prevents unbounded
    // memory growth in long-lived processes.
    if (this.queue.length >= this.config.maxQueueSize) {
      this.queue.shift();
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
    }
  }

  /**
   * Flush queued events. Returns a promise that resolves when the
   * batch POST completes (or fails silently). Always safe to call
   * concurrently; later calls become no-ops while a flush is
   * in-flight.
   */
  async flush(): Promise<void> {
    // Atomically claim the in-flight slot so concurrent flush()
    // calls can''t both pass the inflight check and grab the
    // batch (race that previously produced >1 POST). The check +
    // set has to be a single statement — anything in between lets
    // a second caller slip through.
    if (this.inflight) return;
    this.inflight = true;
    if (this.queue.length === 0) {
      this.inflight = false;
      return;
    }
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.queue;
    this.queue = [];
    // Track the in-flight POST so ``dispose()`` can await it
    // before releasing ``this.inflight``. Without this the
    // ``dispose() → flush()`` chain could start a second
    // concurrent POST while the first was still in flight.
    this.inflightPromise = (async () => {
      try {
        await this.postBatch(batch);
      } catch (err) {
        if (this.config.debug) {
          // eslint-disable-next-line no-console
          console.debug("[eden-ai] flush failed (swallowed)", err);
        }
      } finally {
        this.inflight = false;
        this.inflightPromise = null;
        // Re-arm the timer if events accumulated while we were
        // in-flight; otherwise a callback that runs synchronously
        // after a flush would sit in the queue forever.
        this.scheduleFlush();
      }
    })();
    await this.inflightPromise;
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
    }
  }

  /**
   * Flush all pending work and stop the timers. Safe to call from
   * process-exit hooks (`beforeExit`, `SIGTERM`).
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

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": SDK_USER_AGENT,
    };
    if (this.config.orgId) headers["X-Org-Id"] = this.config.orgId;
    if (this.config.apiKey) headers["X-Org-Api-Key"] = this.config.apiKey;
    if (this.config.projectId) headers["X-Project-Id"] = this.config.projectId;
    return headers;
  }

  private async postBatch(events: TelemetryEvent[]): Promise<void> {
    // Group by source_format — the gateway expects one POST per
    // format. The Python SDK serialises via `source_format`
    // column; we keep one network round-trip per format instead.
    const byFormat = new Map<string, TelemetryEvent[]>();
    for (const ev of events) {
      const list = byFormat.get(ev.sourceFormat) ?? [];
      list.push(ev);
      byFormat.set(ev.sourceFormat, list);
    }

    for (const [format, items] of byFormat) {
      const url = this.buildIngestUrl(format);
      if (!url) {
        if (this.config.debug) {
          // eslint-disable-next-line no-console
          console.debug("[eden-ai] no orgId; dropping", items.length, "events");
        }
        continue;
      }
      // Apply the client-side safety-net PII redactor to every
      // payload before it leaves the process. Mirrors the Python
      // SDK's `redact_on_client` path; the gateway remains the
      // source of truth for tenant redaction policy.
      const redacted = this.config.redactOnClient
        ? items.map((e) => ({ ...e, payload: redactPayload(e.payload) as never }))
        : items;
      // Translate the TS SDK's camelCase types to the server's
      // snake_case ingestion schema at the wire boundary. Without
      // this the gateway falls back to event_type:
      // ingest.event and every TS trace misses the
      // agent.run / llm_completion SQL filters.
      const wired = redacted.map(eventToWire);
      await this.postJson(url, wired);
    }
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
    const body = { chunks: prepared.map(chunkToWire) };
    await this.postJson(url, body);
  }

  private async postJson(url: string, body: unknown): Promise<void> {
    if (typeof fetch === "undefined") {
      throw new Error(
        "[eden-ai] global fetch is not available; " +
          "use Node 18+ or a fetch polyfill (e.g. undici).",
      );
    }
    // Retry transient failures with exponential backoff. 4xx other
    // than 408/429 are treated as permanent and not retried. Honours
    // the ``Retry-After`` response header up to 30s.
    const MAX_ATTEMPTS = 3;
    const BASE_DELAY_MS = 200;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timeoutMs = Math.max(1, Math.round(this.config.timeoutS * 1000));
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.ok) return; // success
        const status = res.status;
        const retryable = status === 429 || status === 408 || status >= 500;
        if (!retryable || attempt >= MAX_ATTEMPTS) {
          if (this.config.debug) {
            // eslint-disable-next-line no-console
            console.debug("[eden-ai] non-2xx from gateway", status, url);
          }
          return;
        }
        // Honour Retry-After if present. RFC 7231 allows either a
        // delta-seconds integer ("5") or an HTTP-date
        // ("Wed, 21 Oct 2015 07:28:00 GMT"); the previous code only
        // handled the former (parseFloat on the HTTP-date form
        // returned NaN, Number.isFinite(NaN) was false, so the
        // retry skipped the wait entirely -- hammering the
        // server instead of backing off). Delegate to the shared
        // helper so the TS and Python SDKs surface identical
        // behaviour for both header forms.
        const ra = res.headers.get("retry-after");
        const fallbackMs = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 5_000);
        const delayMs = ra ? parseRetryAfterMs(ra, fallbackMs) : fallbackMs;
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) {
          if (this.config.debug) {
            // eslint-disable-next-line no-console
            console.debug("[eden-ai] fetch failed", err);
          }
          return;
        }
        const delayMs = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 5_000);
        await new Promise((r) => setTimeout(r, delayMs));
      } finally {
        clearTimeout(timeout);
      }
    }
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
  _default = undefined;
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
