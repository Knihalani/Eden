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

import {
  type EdenSDKOptions,
  type StreamChunk,
  type TelemetryEvent,
} from "./types.js";
import { type FilterConfig } from "./filters.js";

const DEFAULT_BASE_URL = "http://localhost:8000";
const DEFAULT_REALM = "production";
const DEFAULT_PROJECT_ID = "default";
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const INGEST_TIMEOUT_MS = 5_000;

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
  flushIntervalMs: number;
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
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const gatewayUrl = opts.gatewayUrl ?? readEnv("EDEN_GATEWAY_URL");
  const filters = opts.filters;

  if (strict && !orgId) {
    throw new Error(
      "[eden-ai] orgId is required when strict mode is enabled",
    );
  }

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
    flushIntervalMs,
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
    this.queue.push(event);
    if (this.queue.length >= this.config.maxBatchSize) {
      void this.flush();
    } else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.config.flushIntervalMs);
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
    if (this.inflight) return;
    if (this.queue.length === 0) return;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.queue;
    this.queue = [];
    this.inflight = true;
    try {
      await this.postBatch(batch);
    } catch (err) {
      if (this.config.debug) {
        // eslint-disable-next-line no-console
        console.debug("[eden-ai] flush failed (swallowed)", err);
      }
    } finally {
      this.inflight = false;
    }
  }

  /**
   * Flush buffered streaming chunks to `/ingest/chunks`. Same
   * concurrency rules as {@link flush}.
   */
  async flushChunks(): Promise<void> {
    if (this.chunkBuffer.length === 0) return;
    if (this.chunkTimer !== null) {
      clearTimeout(this.chunkTimer);
      this.chunkTimer = null;
    }
    const chunks = this.chunkBuffer;
    this.chunkBuffer = [];
    try {
      await this.postChunks(chunks);
    } catch (err) {
      if (this.config.debug) {
        // eslint-disable-next-line no-console
        console.debug("[eden-ai] chunk flush failed (swallowed)", err);
      }
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
      "User-Agent": "@eden-ai/sdk/0.1.0",
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
      await this.postJson(url, items);
    }
  }

  private async postChunks(chunks: StreamChunk[]): Promise<void> {
    const url = this.buildChunkUrl();
    if (!url) return;
    await this.postJson(url, { chunks });
  }

  private async postJson(url: string, body: unknown): Promise<void> {
    if (typeof fetch === "undefined") {
      throw new Error(
        "[eden-ai] global fetch is not available; " +
          "use Node 18+ or a fetch polyfill (e.g. undici).",
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      INGEST_TIMEOUT_MS,
    );
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok && this.config.debug) {
        // eslint-disable-next-line no-console
        console.debug("[eden-ai] non-2xx from gateway", res.status, url);
      }
    } finally {
      clearTimeout(timeout);
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
