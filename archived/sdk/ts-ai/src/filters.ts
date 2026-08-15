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


// ── Client-side safety-net redactor ───────────────────────────────
//
// Mirrors the Python SDK's `redact_payload`. Conservative regex
// pass over outgoing payloads to mask obvious PII when the
// gateway is down, misconfigured, or absent (local dev). The
// gateway remains the authoritative redaction layer; this is a
// belt-and-suspenders safety net only.

const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
// US-style phone numbers: must look like a phone (parenthesised
// area code ``(415) 555-2671`` or separators between the 3-3-4
// groups).  Pure-digit 10-11 char runs are intentionally NOT
// matched here — they're far more likely to be numeric IDs,
// token counts, or Unix timestamps than phone numbers.
const PHONE_RE = new RegExp(
  "(?<!\\d)" +
  "(?:\\+?1[-.\\s]?)?" +
  "(?:" +
  "\\(\\d{3}\\)\\s*[-.]?\\s*\\d{3}[-.\\s]?\\d{4}" +
  "|\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}" +
  ")" +
  "(?!\\d)",
  "g",
);
const SSN_RE = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;
// Credit cards: 13-19 digits with optional spaces or hyphens.
// We also require the candidate to pass a Luhn checksum, which
// dramatically reduces false positives on long-numeric IDs.
const CC_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const MASK = "[REDACTED]";

function luhnOk(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let total = 0;
  const parity = digits.length % 2;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(i) - 48;
    if (i % 2 === parity) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

export function redactString(s: string): string {
  let out = s;
  out = out.replace(EMAIL_RE, MASK);
  out = out.replace(PHONE_RE, MASK);
  out = out.replace(SSN_RE, MASK);
  // CC pass: replace only when the matched run passes Luhn. We
  // walk matches manually because we need access to ``m[0]`` to
  // strip separators before validation.
  out = out.replace(CC_RE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    return luhnOk(digits) ? MASK : match;
  });
  return out;
}

/**
 * Recursively walk a JSON-ish value, redacting strings in place.
 * Returns a new structure; the original is not mutated.
 */
export function redactPayload(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value !== null && typeof value === "object") {
    // String keys are redacted too — some upstream LLM SDKs stash
    // identifiers in keys, and we want to be safe-by-default.
    //
    // Collision handling: when two distinct keys redact to the
    // same value (e.g. ``"a@example.com"`` and
    // ``"b@example.com"`` both become ``"[REDACTED]"``), the
    // naive object-comprehension silently overwrites the first
    // entry. That dropped one of the values on every payload
    // that carried multiple PII keys (e.g.
    // ``{"alice@...": 5, "bob@...": 3}`` would collapse to
    // ``{"[REDACTED]": 3}`` and lose Alice's value). We now
    // disambiguate by appending a numeric suffix on collision
    // (``[REDACTED]``, ``[REDACTED]_2``, ``[REDACTED]_3`` …).
    // The collision only happens when the user has legitimately
    // different keys that happen to redact to the same string,
    // so the disambiguator is rare in practice and the cost is
    // O(n) on the dict's key set.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const newKey = redactString(k);
      if (Object.prototype.hasOwnProperty.call(out, newKey)) {
        let i = 2;
        let suffixed = `${newKey}_${i}`;
        while (Object.prototype.hasOwnProperty.call(out, suffixed)) {
          i += 1;
          suffixed = `${newKey}_${i}`;
        }
        out[suffixed] = redactPayload(v);
      } else {
        out[newKey] = redactPayload(v);
      }
    }
    return out;
  }
  return value;
}
