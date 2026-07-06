/**
 * Per-filter configuration for the Eden gateway (TypeScript).
 *
 * Mirrors `sdk/python/eden_sdk/filters.py`. Each filter exposes a
 * small `toHeaders()` method that renders the configuration as the
 * wire headers the gateway's per-request override layer expects.
 *
 * The gateway runs a chain of filters on every request before it
 * leaves the platform: PII redaction today, secret-redaction and
 * prompt-injection detection in upcoming releases. Each filter can
 * be enabled, disabled, or partially configured from the SDK.
 *
 * Adding a new server-side filter:
 *   1. Define a `XxxConfig` class below with a `toHeaders()` method.
 *   2. Add it as an optional field on `FilterConfig`.
 *   3. Append the filter name to `FILTER_NAMES`.
 *
 * Example:
 * ```ts
 * import { FilterConfig, PIIConfig } from "@eden-ai/sdk";
 *
 * const cfg: FilterConfig = {
 *   pii: new PIIConfig({ mode: "fail_closed" }),
 * };
 * client.gatewayHeaders({ filters: cfg });
 * // → emits X-PII-Mode: fail_closed
 * ```
 */

/**
 * Source-of-truth list of filter names exposed on the wire. Keep in
 * sync with `sdk/python/eden_sdk/filters.py::FILTER_NAMES` and the
 * gateway's `FilterRegistry.names()` in `src/eden/llmops/filters/base.py`.
 */
export const FILTER_NAMES = ["pii"] as const;
export type FilterName = (typeof FILTER_NAMES)[number];

/**
 * Valid PII redaction modes. Matches the server's `PIIPolicy.mode`.
 *
 *  * `"off"` — never mask (system designed to use the PII).
 *  * `"redact"` (default) — mask per the active category set.
 *  * `"fail_closed"` — redact + raise 422 on credential detection.
 */
export type PIIMode = "off" | "redact" | "fail_closed";

const VALID_PII_MODES: readonly PIIMode[] = ["off", "redact", "fail_closed"];

/**
 * Configuration for the PII redaction filter.
 *
 * `disabledCategories` lets the caller opt out of specific
 * categories (e.g. `["api_key", "url_with_creds"]`) without
 * disabling the filter entirely. Categories are matched by name
 * against `eden.data_platform.pii._DEFAULT_CATEGORIES`.
 *
 * `bypass` is the per-request opt-out — equivalent to setting
 * `X-PII-Bypass: true`. Use when the system is designed to use the
 * raw PII values for this specific call.
 */
export class PIIConfig {
  public readonly mode: PIIMode;
  public readonly disabledCategories: readonly string[];
  public readonly bypass: boolean;

  constructor(opts: Partial<PIIConfigOptions> = {}) {
    const mode: PIIMode = opts.mode ?? "redact";
    if (!VALID_PII_MODES.includes(mode)) {
      throw new Error(
        `PIIConfig.mode must be 'off', 'redact', or 'fail_closed'; got '${mode}'`,
      );
    }
    this.mode = mode;
    this.disabledCategories = Object.freeze([...(opts.disabledCategories ?? [])]);
    this.bypass = opts.bypass ?? false;
  }

  /**
   * Render as request headers. Always emits `X-PII-Mode` so the
   * gateway's per-request override is unambiguous (even when the
   * tenant policy already matches). Only emits
   * `X-PII-Disabled-Categories` when the list is non-empty, to
   * keep headers minimal in the common case.
   */
  toHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "X-PII-Mode": this.mode };
    if (this.disabledCategories.length > 0) {
      headers["X-PII-Disabled-Categories"] = this.disabledCategories.join(",");
    }
    if (this.bypass) {
      headers["X-PII-Bypass"] = "true";
    }
    return headers;
  }
}

export interface PIIConfigOptions {
  mode?: PIIMode;
  disabledCategories?: readonly string[];
  bypass?: boolean;
}

/**
 * Top-level filter configuration. Each field is the configuration
 * for one filter; unset filters use the platform default (the tenant
 * policy from `org_pii_policies`, with the platform fallback when
 * no row exists).
 *
 * Adding a new filter:
 *   1. Define a `XxxConfig` class above.
 *   2. Add an optional field of that type here.
 *   3. Extend `toHeaders()` to dispatch to it.
 */
export class FilterConfig {
  public readonly pii?: PIIConfig;

  constructor(opts: Partial<FilterConfigOptions> = {}) {
    if (opts.pii !== undefined) this.pii = opts.pii;
  }

  /**
   * Render every configured filter as request headers. Filters
   * with no configuration are skipped — the gateway falls back to
   * the tenant policy.
   */
  toHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.pii !== undefined) Object.assign(headers, this.pii.toHeaders());
    return headers;
  }
}

export interface FilterConfigOptions {
  pii?: PIIConfig;
}
