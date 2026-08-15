/**
 * Gateway optimization opt-out headers for the TypeScript SDK.
 *
 * Mirrors `sdk/python/eden_sdk/gateway_optimizations.py`.
 */

export const HEADER_EXACT_CACHE = "X-Eden-Exact-Cache";
export const HEADER_COALESCE = "X-Eden-Coalesce";
export const HEADER_PROVIDER_CACHE_LAYOUT = "X-Eden-Provider-Cache-Layout";
export const HEADER_RESPONSE_REPAIR = "X-Eden-Response-Repair";

export interface OptimizationHeaderOptions {
  exactCache?: boolean;
  coalesce?: boolean;
  providerCacheLayout?: boolean;
  responseRepair?: boolean;
}

/** Emit headers only for disabled features (quiet default-on path). */
export function optimizationOptOutHeaders(
  opts: OptimizationHeaderOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.exactCache === false) {
    headers[HEADER_EXACT_CACHE] = "false";
  }
  if (opts.coalesce === false) {
    headers[HEADER_COALESCE] = "false";
  }
  if (opts.providerCacheLayout === false) {
    headers[HEADER_PROVIDER_CACHE_LAYOUT] = "false";
  }
  if (opts.responseRepair === false) {
    headers[HEADER_RESPONSE_REPAIR] = "false";
  }
  return headers;
}
