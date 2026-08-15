/**
 * Bounded capture for span `input`/`output` (and, for symmetry with
 * the Python SDK, request/response payload pairs).
 *
 * Mirrors `sdk/python/eden_sdk/capture.py`. Full-fidelity capture of
 * every prompt/completion is the highest-value signal the SDK ships,
 * but it is also the biggest cost driver — a single long-context call
 * can carry hundreds of KB of text, and most of that text is never
 * read again after the trace is a few days old. This module is the
 * one choke point `trace.ts`'s `setInput`/`setOutput` path calls
 * through to keep capture bounded without silently corrupting the
 * record: every truncation stamps `eden.truncated` + `eden.original_bytes`
 * onto the event's `attributes` so a shortened payload is never
 * indistinguishable from a short one.
 *
 * Auto-instrumentation (`wrapOpenAI`, `wrapAnthropic`, ...) does NOT
 * route through this module — those paths already ship metrics-only
 * (no request/response content at all), so there is nothing to
 * bound. `captureMode`/`captureMaxStringBytes` only affect content a
 * caller explicitly attaches via `setInput`/`setOutput`.
 *
 * Three capture modes (`CaptureMode`), selected via
 * `EdenSDKOptions.captureMode` / `EDEN_CAPTURE_MODE` — string values
 * intentionally match the Python SDK's so the portal renders
 * `eden.capture_mode` identically regardless of which SDK produced
 * the event:
 *
 *   - `"bounded"` (default) — head+tail truncate any string field
 *     longer than `maxStringBytes`. Errors and slow calls
 *     (`durationMs > slowThresholdMs`, 5s by default) bypass
 *     truncation entirely.
 *   - `"full"` — never truncate.
 *   - `"metrics_only"` — never capture content at all.
 *
 * Truncation is head+tail, not head-only — see `truncateText`'s
 * docstring for why.
 */

export type CaptureMode = "bounded" | "full" | "metrics_only";

const VALID_MODES: readonly CaptureMode[] = ["bounded", "full", "metrics_only"];

/** Per-string-field cap in UTF-8 bytes. Mirrors Python's default. */
export const DEFAULT_MAX_STRING_BYTES = 8 * 1024;
/**
 * Matches `sdk/ts-ai/src/sampling.ts`'s `ClientSampler.slowThresholdMs`
 * — a call slow enough to force-keep on the sampling side is also
 * slow enough to be worth capturing in full on the truncation side.
 */
export const DEFAULT_SLOW_THRESHOLD_MS = 5_000;
// Keep more of the head than the tail — see capture.py for the
// rationale (system prompt / task framing at the head is usually
// more load-bearing for debugging than an equal number of tail
// bytes, but the tail still carries the final answer/error).
const HEAD_KEEP_FRACTION = 0.7;

export const TRUNCATED_ATTR = "eden.truncated";
export const ORIGINAL_BYTES_ATTR = "eden.original_bytes";
export const CAPTURE_MODE_ATTR = "eden.capture_mode";

function readEnv(name: string): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    const v = process.env[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function envCaptureMode(fallback: CaptureMode = "bounded"): CaptureMode {
  const raw = (readEnv("EDEN_CAPTURE_MODE") ?? fallback).trim().toLowerCase();
  return (VALID_MODES as readonly string[]).includes(raw)
    ? (raw as CaptureMode)
    : fallback;
}

function envMaxStringBytes(fallback: number = DEFAULT_MAX_STRING_BYTES): number {
  const raw = readEnv("EDEN_CAPTURE_MAX_STRING_BYTES");
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envSlowThresholdMs(fallback: number = DEFAULT_SLOW_THRESHOLD_MS): number {
  const raw = readEnv("EDEN_CAPTURE_SLOW_THRESHOLD_MS");
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolved bounded-capture policy for one span/call. */
export interface CaptureLimits {
  mode: CaptureMode;
  maxStringBytes: number;
  slowThresholdMs: number;
}

/** Build {@link CaptureLimits} straight from the environment. */
export function captureLimitsFromEnv(): CaptureLimits {
  return {
    mode: envCaptureMode(),
    maxStringBytes: envMaxStringBytes(),
    slowThresholdMs: envSlowThresholdMs(),
  };
}

/**
 * Build {@link CaptureLimits} from a resolved SDK config (or a
 * partial/absent one — falls back to env defaults so callers never
 * throw on a partially-constructed config object).
 */
export function limitsFromConfig(
  cfg: { captureMode?: string; captureMaxStringBytes?: number } | undefined,
): CaptureLimits {
  if (!cfg) return captureLimitsFromEnv();
  const rawMode = cfg.captureMode;
  const mode: CaptureMode =
    typeof rawMode === "string" && (VALID_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as CaptureMode)
      : "bounded";
  const rawMax = cfg.captureMaxStringBytes;
  const maxStringBytes =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
      ? rawMax
      : DEFAULT_MAX_STRING_BYTES;
  return { mode, maxStringBytes, slowThresholdMs: DEFAULT_SLOW_THRESHOLD_MS };
}

/**
 * Head+tail truncate `s` to (approximately) `maxBytes` UTF-8 bytes.
 *
 * Truncation keeps both edges rather than just the head: prompts put
 * their most diagnostic content at both ends (system prompt /
 * instructions at the head, the actual question or a final
 * answer/error at the tail), so a pure head-truncate silently drops
 * the part a human goes looking for first.
 *
 * A `maxBytes` of 0 or less degrades to "drop everything" rather
 * than throwing — defensive against a misconfigured (non-positive)
 * cap reaching this far.
 */
export function truncateText(
  s: string,
  maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
  const raw = Buffer.from(s, "utf8");
  const n = raw.length;
  if (maxBytes <= 0) {
    return { text: "", truncated: n > 0, originalBytes: n };
  }
  if (n <= maxBytes) {
    return { text: s, truncated: false, originalBytes: n };
  }
  const marker = `…[eden:truncated ${n - maxBytes}b]…`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  const headBudget = Math.floor(budget * HEAD_KEEP_FRACTION);
  const tailBudget = budget - headBudget;
  // `Buffer.toString("utf8")` replaces a truncated trailing multibyte
  // sequence with U+FFFD rather than throwing — an acceptable cost
  // for a hard byte budget, same trade-off as Python's
  // `errors="ignore"` decode.
  const head = raw.subarray(0, headBudget).toString("utf8");
  const tail = tailBudget > 0 ? raw.subarray(n - tailBudget).toString("utf8") : "";
  return { text: `${head}${marker}${tail}`, truncated: true, originalBytes: n };
}

function truncateWalk(
  value: unknown,
  maxBytes: number,
): { value: unknown; truncatedAny: boolean; totalBytes: number } {
  let truncatedAny = false;
  let totalBytes = 0;

  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      const { text, truncated, originalBytes } = truncateText(v, maxBytes);
      totalBytes += originalBytes;
      if (truncated) truncatedAny = true;
      return text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(item);
      }
      return out;
    }
    return v;
  }

  return { value: walk(value), truncatedAny, totalBytes };
}

/**
 * Cheap, non-recursive size estimate for the "keep full" paths —
 * used when we already know we won't truncate, so a JSON-stringify-
 * and-measure is far cheaper than walking + rebuilding the whole
 * structure just to report a size nobody will use to reconstruct it.
 */
function approxBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

/** Outcome of applying the capture policy to one value. */
export interface CaptureResult {
  value: unknown;
  truncated: boolean;
  originalBytes: number;
  mode: CaptureMode;
}

export interface CaptureOptions {
  hasError?: boolean;
  durationMs?: number;
  limits?: CaptureLimits;
}

/**
 * Apply the bounded-capture policy to a single value. `value` is
 * typically a span's `input`/`output`, but any JSON-ish structure
 * works.
 */
export function captureValue(value: unknown, opts: CaptureOptions = {}): CaptureResult {
  const active = opts.limits ?? captureLimitsFromEnv();
  if (value === null || value === undefined) {
    // Preserve `undefined` vs `null` identity — `undefined` fields
    // are dropped by `JSON.stringify` on the wire, matching the
    // pre-capture behaviour for a span that never called
    // `setInput`/`setOutput`; an explicit `null` stays `null`.
    return { value, truncated: false, originalBytes: 0, mode: active.mode };
  }
  if (active.mode === "metrics_only") {
    return { value: null, truncated: false, originalBytes: 0, mode: active.mode };
  }
  const hasError = opts.hasError ?? false;
  const durationMs = opts.durationMs ?? 0;
  const keepFull =
    active.mode === "full" || hasError || durationMs > active.slowThresholdMs;
  if (keepFull) {
    return { value, truncated: false, originalBytes: approxBytes(value), mode: active.mode };
  }
  const { value: newValue, truncatedAny, totalBytes } = truncateWalk(
    value,
    active.maxStringBytes,
  );
  return { value: newValue, truncated: truncatedAny, originalBytes: totalBytes, mode: active.mode };
}

/**
 * Merge truncation metadata from one or more {@link CaptureResult}
 * into `attributes` in place, and return it for chaining.
 *
 * Values are stamped as strings — mirrors the Python SDK, which
 * stamps strings because the wire-typed `attributes` field there is
 * `dict[str, str]`. The TS `attributes` field is typed looser
 * (`Record<string, unknown>`), but stamping strings here keeps the
 * two SDKs' wire output identical for the same event.
 */
export function stampCaptureAttributes(
  attributes: Record<string, unknown>,
  ...results: CaptureResult[]
): Record<string, unknown> {
  if (results.length === 0) return attributes;
  const truncatedAny = results.some((r) => r.truncated);
  const totalBytes = results.reduce((sum, r) => sum + r.originalBytes, 0);
  const modes = new Set(results.map((r) => r.mode));
  attributes[TRUNCATED_ATTR] = truncatedAny ? "true" : "false";
  attributes[ORIGINAL_BYTES_ATTR] = String(totalBytes);
  attributes[CAPTURE_MODE_ATTR] = modes.size === 1 ? [...modes][0] : "mixed";
  return attributes;
}

/**
 * Apply the capture policy to a request/response pair in one call.
 * Mirrors Python's `capture_request_response` for any TS
 * instrumentation that wants request/response-shaped bounded capture
 * in the future; not currently used by auto-instrumentation, which
 * stays metrics-only.
 */
export function captureRequestResponse(
  requestPayload: unknown,
  responsePayload: unknown,
  opts: { error?: string | null; durationMs?: number; limits?: CaptureLimits } = {},
): { requestPayload: unknown; responsePayload: unknown; captureAttrs: Record<string, string> } {
  const active = opts.limits ?? captureLimitsFromEnv();
  const hasError = opts.error != null;
  const durationMs = opts.durationMs ?? 0;
  const reqResult = captureValue(requestPayload, { hasError, durationMs, limits: active });
  const respResult = captureValue(responsePayload, { hasError, durationMs, limits: active });
  const attrs: Record<string, unknown> = {};
  stampCaptureAttributes(attrs, reqResult, respResult);
  return {
    requestPayload: reqResult.value,
    responsePayload: respResult.value,
    captureAttrs: attrs as Record<string, string>,
  };
}
