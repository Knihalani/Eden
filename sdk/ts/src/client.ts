/**
 * Eden TypeScript SDK — HTTP client.
 */

import { EdenConfig, EdenConfigOptions } from "./config";
import { raiseForStatus, EdenError } from "./errors";
import { type APIEnvelope } from "./models";
import { JobsResource } from "./resources/jobs";
import { EnvironmentsResource } from "./resources/environments";
import { BenchmarksResource } from "./resources/benchmarks";

const DEFAULT_RETRYABLE = [408, 429, 500, 502, 503, 504];

export interface RequestOptions {
  json?: Record<string, unknown>;
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

export class EdenClient {
  config: EdenConfig;
  private requestId: string | undefined;

  constructor(options?: EdenConfigOptions) {
    this.config = new EdenConfig(options);
  }

  // ── Low-level HTTP ─────────────────────────────────────────────────

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    const url = path.startsWith("/v1") ? `${this.config.baseUrl}${path}` : `${this.config.baseUrl}/v1${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "eden-ts/0.1.0",
      ...this.config.getHeaders(),
      ...options.headers,
    };

    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    if (this.config.debug) {
      headers["X-Debug"] = "true";
    }

    this.requestId = crypto.randomUUID().slice(0, 12);
    headers["X-Request-ID"] = this.requestId;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };

        if (options.json) {
          fetchOptions.body = JSON.stringify(options.json);
        }

        if (this.config.debug) {
          console.debug(`[req ${this.requestId}] ${method} ${url} (attempt ${attempt + 1}/${this.config.maxRetries + 1})`);
        }

        const response = await fetch(url + this.buildQueryString(options.params), fetchOptions);

        // Handle binary responses
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.startsWith("application/zip")) {
          clearTimeout(timeoutId);
          return {
            _binary: true,
            content: new Uint8Array(await response.arrayBuffer()),
            statusCode: response.status,
          };
        }

        const bodyText = await response.text();
        const body = bodyText ? JSON.parse(bodyText) : {};

        if (this.config.debug) {
          console.debug(`[req ${this.requestId}] ${response.status} ${bodyText.length} bytes`);
        }

        // Unwrap envelope
        let data: Record<string, unknown>;
        let meta: Record<string, unknown> = {};

        if (body.data !== undefined && body.meta !== undefined) {
          data = body.data as Record<string, unknown>;
          meta = body.meta as Record<string, unknown>;
        } else {
          data = body;
        }

        const reqId = (meta.request_id as string) ?? this.requestId;

        if (response.status >= 400) {
          // Phase 5.3.3: retry on transient HTTP statuses (5xx, 408, 429)
          // before giving up. raiseForStatus throws an EdenError which we
          // catch below and re-attempt with backoff.
          if (attempt < this.config.maxRetries &&
              DEFAULT_RETRYABLE.includes(response.status)) {
            const wait = Math.min(2 ** attempt * 1000, 60000);
            if (this.config.debug) {
              console.debug(
                `[req ${this.requestId}] HTTP ${response.status}, ` +
                `retrying in ${wait}ms`
              );
            }
            await sleep(wait);
            continue;
          }
          raiseForStatus(response.status, { detail: (data.detail as string) ?? "Unknown error", meta, ...data }, reqId);
        }

        clearTimeout(timeoutId);
        return { _data: data, _meta: meta, _status: response.status };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (err instanceof EdenError) {
          clearTimeout(timeoutId);
          throw err;
        }

        if (attempt < this.config.maxRetries) {
          const wait = Math.min(2 ** attempt * 1000, 60000);
          if (this.config.debug) {
            console.debug(`[req ${this.requestId}] retrying in ${wait}ms`);
          }
          await sleep(wait);
          continue;
        }
      }
    }

    clearTimeout(timeoutId);
    throw new EdenError(
      `Request failed after ${this.config.maxRetries + 1} attempts: ${lastError?.message ?? "unknown"}`,
      { requestId: this.requestId }
    );
  }

  async get(path: string, options?: RequestOptions): Promise<unknown> {
    const result = await this.request("GET", path, options);
    return result._data as unknown;
  }

  async post(path: string, options?: RequestOptions): Promise<unknown> {
    const result = await this.request("POST", path, options);
    return result._data as unknown;
  }

  // ── Resource accessors ─────────────────────────────────────────────

  get jobs(): JobsResource {
    return new JobsResource(this);
  }

  get environments(): EnvironmentsResource {
    return new EnvironmentsResource(this);
  }

  get benchmarks(): BenchmarksResource {
    return new BenchmarksResource(this);
  }

  private buildQueryString(params?: Record<string, string | number | boolean | undefined>): string {
    if (!params) return "";
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        qs.append(key, String(value));
      }
    }
    const str = qs.toString();
    return str ? `?${str}` : "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
