/**
 * Universal HTTP capture for OpenAI-compatible LLM API calls (fetch).
 */

import { getDefaultClient } from "./client.js";
import { randomId } from "./ids.js";
import type { TraceOptions } from "./types.js";

let _installed = false;
let _originalFetch: typeof fetch | undefined;

const LLM_HOST_SUFFIXES = [
  "api.openai.com",
  "api.anthropic.com",
  "openrouter.ai",
  "api.groq.com",
  "generativelanguage.googleapis.com",
  "api.cohere.com",
  "api.mistral.ai",
  "api.x.ai",
  "bedrock-runtime.amazonaws.com",
  "aiplatform.googleapis.com",
];

const LLM_PATH_FRAGMENTS = [
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/completions",
];

function detectSourceFormat(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (LLM_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix)) {
    if (host.includes("anthropic")) return "anthropic";
    if (host.includes("bedrock")) return "bedrock";
    if (host.includes("googleapis") || host.includes("aiplatform")) return "gemini";
    return "openai";
  }
  if (LLM_PATH_FRAGMENTS.some((fragment) => path.includes(fragment))) {
    return "openai";
  }
  return null;
}

async function parseJsonBody(body: BodyInit | null | undefined): Promise<Record<string, unknown> | null> {
  if (!body) return null;
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function emitHttpEvent(args: {
  sourceFormat: string;
  url: string;
  method: string;
  requestBody: Record<string, unknown> | null;
  statusCode: number;
  durationMs: number;
  error?: string;
}): void {
  const client = getDefaultClient();
  const config = client.getConfig();
  client.emit({
    eventId: `eden_http_${randomId()}`,
    tenantId: config.orgId ?? "default",
    projectId: config.projectId,
    traceId: randomId(),
    realm: config.realm,
    eventType: "llm_completion",
    timestamp: new Date().toISOString(),
    name: `http.${args.method.toLowerCase()}`,
    durationMs: args.durationMs,
    sourceFormat: args.sourceFormat,
    payload: {
      model: typeof args.requestBody?.model === "string" ? args.requestBody.model : undefined,
      http_url: args.url,
      http_method: args.method,
      http_status_code: args.statusCode,
      ...(args.error ? { error: args.error } : {}),
    },
    attributes: {
      "http.url": args.url,
      "http.method": args.method,
      "http.status_code": args.statusCode,
      "http.capture": true,
    },
    tags: ["http-capture", args.sourceFormat],
  });
}

export function installHttpCapture(_opts: TraceOptions = {}): void {
  if (_installed || typeof globalThis.fetch !== "function") return;
  _originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const sourceFormat = detectSourceFormat(url);
    if (!sourceFormat || !_originalFetch) {
      return _originalFetch!(input, init);
    }
    const method = init?.method ?? "GET";
    const requestBody = await parseJsonBody(init?.body ?? null);
    const start = Date.now();
    try {
      const response = await _originalFetch(input, init);
      emitHttpEvent({
        sourceFormat,
        url,
        method,
        requestBody,
        statusCode: response.status,
        durationMs: Date.now() - start,
      });
      return response;
    } catch (err) {
      emitHttpEvent({
        sourceFormat,
        url,
        method,
        requestBody,
        statusCode: 0,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }) as typeof fetch;
  _installed = true;
}

export function uninstallHttpCapture(): void {
  if (_originalFetch) {
    globalThis.fetch = _originalFetch;
  }
  _originalFetch = undefined;
  _installed = false;
}

export function isHttpCaptureInstalled(): boolean {
  return _installed;
}
