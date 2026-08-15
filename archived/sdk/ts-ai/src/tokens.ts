/**
 * Shared token/usage extraction and model-name normalization helpers.
 *
 * Mirrors `eden_sdk/_tokens.py`. All instrumentations (OpenAI,
 * Anthropic, LangChain, Vercel AI) route through this module so
 * the server-side normalizer sees the same field names regardless
 * of which SDK emitted the event.
 *
 * Field shapes produced here are deliberately a superset of what
 * each provider natively returns. Missing values are `null` (never
 * zero) so billing math doesn't accidentally bill free input.
 */

const USAGE_KEYS_INPUT = [
  "input_tokens",
  "prompt_tokens",
  "promptTokens",
  // Bedrock Converse API top-level `usage` shape.
  "inputTokens",
  // Gemini `usageMetadata` shape (and the legacy Python SDK's
  // snake_case attribute name, included here too for parity).
  "promptTokenCount",
  "prompt_token_count",
];
const USAGE_KEYS_OUTPUT = [
  "output_tokens",
  "completion_tokens",
  "completionTokens",
  // Bedrock Converse API top-level `usage` shape.
  "outputTokens",
  // Gemini `usageMetadata` shape (and its snake_case alias).
  "candidatesTokenCount",
  "candidates_token_count",
];
const USAGE_KEYS_CACHE_READ = [
  "cache_read_input_tokens",
  "cacheReadInputTokens",
  "cached_tokens",
  "cachedTokens",
  "prompt_tokens_details.cached_tokens",
  "promptTokensDetails.cached_tokens",
  // Gemini `usageMetadata` shape (and its snake_case alias).
  "cachedContentTokenCount",
  "cached_content_token_count",
];
const USAGE_KEYS_CACHE_WRITE = [
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  // Bedrock Converse API top-level `usage` shape.
  "cacheWriteInputTokens",
];

function getPath(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null) return null;
    if (typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return null;
    }
  }
  return cur;
}

function coerceInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    // Reject NaN / infinity. Whole-number floats (the typical
    // JSON-decoded ``1.0``) round-trip cleanly; fractional
    // floats (``0.7``) are dropped rather than silently
    // rounded down to ``0`` and under-billed. The previous
    // code returned any finite number, which let
    // ``coerceInt(0.7) === 0.7`` propagate through to
    // ``input_tokens`` and bill a call for a fractional token.
    // Mirrors the Python SDK's ``_coerce_int`` (which has
    // been strict since the 0.2.9 release); the two SDKs
    // now agree on what counts as a valid token count.
    if (!Number.isFinite(value)) return null;
    if (value !== Math.trunc(value)) return null;
    return value;
  }
  if (typeof value === "string") {
    // Some providers serialise floats as strings
    // (``"1.0"``); accept those but reject fractional
    // strings (``"0.7"``) and the empty string.
    if (value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n !== Math.trunc(n)) return null;
    return n;
  }
  return null;
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

export function extractUsage(usage: unknown): NormalizedUsage {
  if (usage == null) {
    return {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    };
  }
  let inputTokens: number | null = null;
  for (const key of USAGE_KEYS_INPUT) {
    const v = coerceInt(getPath(usage, ...key.split(".")));
    if (isNumber(v)) {
      inputTokens = v;
      break;
    }
  }
  let outputTokens: number | null = null;
  for (const key of USAGE_KEYS_OUTPUT) {
    const v = coerceInt(getPath(usage, ...key.split(".")));
    if (isNumber(v)) {
      outputTokens = v;
      break;
    }
  }
  let cacheRead: number | null = null;
  for (const dotted of USAGE_KEYS_CACHE_READ) {
    const parts = dotted.split(".");
    let v: unknown;
    if (parts.length === 1) {
      v = coerceInt(getPath(usage, parts[0]));
    } else {
      const inner = getPath(usage, parts[0]);
      v = coerceInt(getPath(inner, parts[1]));
    }
    if (isNumber(v)) {
      cacheRead = v;
      break;
    }
  }
  let cacheCreation: number | null = null;
  for (const key of USAGE_KEYS_CACHE_WRITE) {
    const v = coerceInt(getPath(usage, ...key.split(".")));
    if (isNumber(v)) {
      cacheCreation = v;
      break;
    }
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
}

// Optional trailing ``-latest`` that may follow either date format
// (e.g. ``claude-sonnet-4-5-20250929-latest``). Matched as part of
// the suffix regex so a trailing ``-latest`` doesn't leave the
// date stamp stranded in the normalized output.
const DATE_SUFFIX_RE_WITH_LATEST = /-\d{4}-\d{2}-\d{2}(?:-latest)?$/;
const DATE_LIKE_RE_WITH_LATEST = /-\d{8}(?:-latest)?$/;
const LATEST_TAIL_RE = /-latest$/;

/**
 * Strip dated suffixes and `-latest` aliases so pricing lookups
 * hit a single row regardless of which alias the caller used.
 *
 *   normalizeModelName("gpt-4o-2024-08-06") === "gpt-4o"
 *   normalizeModelName("claude-3-5-sonnet-20241022") === "claude-3-5-sonnet"
 *   normalizeModelName("claude-3-5-sonnet-latest") === "claude-3-5-sonnet"
 *   normalizeModelName("claude-sonnet-4-5-20250929-latest") === "claude-sonnet-4-5"
 */
export function normalizeModelName(
  model: string | null | undefined,
): string | null | undefined {
  if (!model || typeof model !== "string") return model;
  // Strip a date-then-latest tail first (matches both
  // ``-YYYY-MM-DD-latest`` and ``-YYYYMMDD-latest``), then the
  // bare date suffix, then a bare ``-latest`` if it remains.
  // Doing them in this order keeps
  // ``claude-sonnet-4-5-20250929-latest`` from leaving the date
  // stamp in the output (the prior order stripped ``-latest``
  // AFTER the date regexes, so the date regexes never saw
  // ``-latest`` and bailed out, leaving the date stamp behind).
  let out = model.replace(DATE_SUFFIX_RE_WITH_LATEST, "");
  out = out.replace(DATE_LIKE_RE_WITH_LATEST, "");
  out = out.replace(LATEST_TAIL_RE, "");
  return out;
}

