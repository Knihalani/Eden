import { gunzipSync, gzipSync } from "node:zlib";

export type PackedEntry = { value: unknown; etag?: string };

/** Bodies larger than this (UTF-8 JSON bytes) are stored gzip+base64. */
export const COMPRESS_MIN_BYTES = 2048;

/**
 * Hard cap on gunzip output. A zip-bomb that would expand past this is a
 * miss, never a crash — the caller falls through to a live fetch.
 */
export const GUNZIP_MAX_BYTES = 8 * 1024 * 1024;

/** One envelope revision carries ETag and compression together. */
export const ENVELOPE_REV = 3;

/** Legacy ETag-only envelopes still unpack. */
export const LEGACY_ENVELOPE_REV = 2;

type EnvelopeV3 = {
  __eden_cache: typeof ENVELOPE_REV;
  etag?: string;
  /** gzip+base64 of JSON.stringify(value). Present iff the body was >2KB. */
  z?: string;
  /** Uncompressed value. Present iff the body was small (or gzip declined). */
  v?: unknown;
};

type EnvelopeV2 = { __eden_cache: typeof LEGACY_ENVELOPE_REV; etag?: string; v: unknown };

function asRecord(x: unknown): Record<string, unknown> | undefined {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return undefined;
  return x as Record<string, unknown>;
}

function gzipB64(json: string): string | undefined {
  try {
    return gzipSync(Buffer.from(json, "utf8"), { level: 4 }).toString("base64");
  } catch {
    return undefined;
  }
}

function gunzipB64(z: string): string | undefined {
  try {
    const buf = Buffer.from(z, "base64");
    if (buf.byteLength === 0) return undefined;
    return gunzipSync(buf, { maxOutputLength: GUNZIP_MAX_BYTES }).toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Pack a value for `result_cache.body`.
 *
 * - Small, no ETag: plain JSON (legacy-shaped; pre-envelope rows stay the
 *   common case for tiny public GETs).
 * - Otherwise: envelope rev 3, which can carry `etag` and/or `z` together.
 * - gzip+base64 only when the JSON is >2KB *and* the compressed envelope is
 *   actually smaller — incompressible payloads stay JSON so we never pay a
 *   size tax to look compressed.
 */
export function packCacheBody(value: unknown, etag?: string, opts?: { compress?: boolean }): string {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  const compress = opts?.compress ?? bytes > COMPRESS_MIN_BYTES;
  if (!compress && etag === undefined) return json;

  const env: EnvelopeV3 = { __eden_cache: ENVELOPE_REV };
  if (etag !== undefined) env.etag = etag;
  if (compress) {
    const z = gzipB64(json);
    // Envelope overhead + base64 expansion: only keep gzip when it still
    // beats the uncompressed JSON. JSON-ish bodies clear this easily; a
    // high-entropy blob would otherwise store *larger* and fail the size bar.
    if (z !== undefined && z.length < json.length) {
      env.z = z;
      return JSON.stringify(env);
    }
  }
  env.v = value;
  return JSON.stringify(env);
}

/**
 * Unpack any stored body: plain JSON, legacy v2 envelopes, or v3
 * (ETag + gzip). Corrupt / hostile / over-budget gunzip → `undefined`
 * (a miss). Never throws.
 */
export function unpackCacheBody(body: string): PackedEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const rec = asRecord(parsed);
    if (rec === undefined) return { value: parsed };

    const rev = rec.__eden_cache;
    if (rev === ENVELOPE_REV) {
      const etag = typeof rec.etag === "string" ? rec.etag : undefined;
      if (typeof rec.z === "string") {
        const inner = gunzipB64(rec.z);
        if (inner === undefined) return undefined;
        try {
          return { value: JSON.parse(inner), ...(etag !== undefined ? { etag } : {}) };
        } catch {
          return undefined;
        }
      }
      return { value: rec.v, ...(etag !== undefined ? { etag } : {}) };
    }
    if (rev === LEGACY_ENVELOPE_REV) {
      const env = rec as unknown as EnvelopeV2;
      return { value: env.v, ...(env.etag !== undefined ? { etag: env.etag } : {}) };
    }
    return { value: parsed };
  } catch {
    return undefined;
  }
}
