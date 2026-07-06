/**
 * High-level convenience helpers for talking to the Eden gateway.
 *
 * Mirrors `sdk/python/eden_sdk/gateway_session.py`. Most customers
 * want a configured OpenAI client in one call, with the right auth
 * + per-filter headers pre-baked. `openaiClient()` wraps the OpenAI
 * SDK constructor with that wiring so callers can go straight from
 * a configured `EdenSDK` to a working chat completion.
 *
 * The OpenAI package is a peer dependency; this module imports it
 * lazily so the SDK still works for users that only need the
 * non-OpenAI surface (the tracer, the auto-instrumentations for
 * Anthropic / LangChain, etc.).
 *
 * Example:
 * ```ts
 * import { EdenSDK, FilterConfig, PIIConfig, openaiClient } from "@eden-ai/sdk";
 *
 * const sdk = new EdenSDK({ orgId: "o", apiKey: "k" });
 * const client = await openaiClient(sdk, {
 *   filters: new FilterConfig({ pii: new PIIConfig({ mode: "fail_closed" }) }),
 * });
 * const resp = await client.chat.completions.create({
 *   model: "gpt-5",
 *   messages: [{ role: "user", content: "hi" }],
 * });
 * ```
 */

import type { EdenSDK } from "./client.js";
import type { FilterConfig } from "./filters.js";

export interface OpenAIClientOptions {
  /** Per-call filter overrides. When unset, uses `sdk.config.filters`. */
  filters?: FilterConfig;
  /** Per-request upstream base URL. */
  upstreamBaseUrl?: string;
  /** Per-request upstream API key. */
  upstreamApiKey?: string;
  /** Per-request upstream provider hint. */
  upstreamProvider?: string;
  /** Per-request PII bypass. */
  piiBypass?: boolean;
}

/**
 * Build a configured OpenAI client pointed at the Eden gateway.
 *
 * The returned client carries the right `defaultHeaders` so every
 * chat completion goes through the configured filter chain and
 * any per-request upstream routing the caller asked for.
 *
 * The OpenAI SDK is a peer dependency; this helper imports it
 * lazily. Callers that haven't installed it get a clear `Error`
 * with install instructions.
 */
export async function openaiClient(
  sdk: EdenSDK,
  opts: OpenAIClientOptions = {},
): Promise<any> {
  let OpenAI: any;
  try {
    const mod: any = await import("openai");
    OpenAI = mod.OpenAI ?? mod.default?.OpenAI ?? mod.default;
  } catch {
    throw new Error(
      "openaiClient() requires the openai package; install it with `npm install openai`.",
    );
  }

  const headers = sdk.gatewayHeaders({
    upstreamBaseUrl: opts.upstreamBaseUrl,
    upstreamApiKey: opts.upstreamApiKey,
    upstreamProvider: opts.upstreamProvider,
    piiBypass: opts.piiBypass,
    filters: opts.filters,
  });

  return new OpenAI({
    apiKey: sdk.getConfig().apiKey ?? "sk-no-key",
    baseURL: sdk.resolvedGatewayUrl(),
    defaultHeaders: headers,
  });
}
