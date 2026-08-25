export type Original = (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;

export type WrapResponse = { action: "play"; facts?: unknown; text?: string } | { action: "original" };

/** Wire-protocol version; must match the server's X-Eden-Version gate. */
export const EDEN_PROTOCOL_VERSION = 1;

export type Opts = { baseUrl?: string; apiKey?: string; runId?: string };

function cfg(opts?: Opts) {
  return {
    // The wrap plane (`eden wrap`) defaults to 8788. 8787 is the dashboard —
    // pointing here sent SDK traffic at a UI server.
    base: opts?.baseUrl || process.env.EDEN_BASE_URL || "http://127.0.0.1:8788",
    key: opts?.apiKey || process.env.EDEN_API_KEY || "eden_dev",
  };
}

const seqByRun = new Map<string, number>();

/**
 * Minimal credential scrubber for values this SDK posts. The server re-runs
 * its full redactor at ingest — this exists so secrets do not even transit:
 * a key that never leaves the machine cannot be logged in transit by anything
 * between here and there.
 *
 * Deliberately narrower than @eden/ir's redact (which is 460 lines of
 * cross-checked matchers). Covers the high-frequency families: secret-named
 * keys and bearer/api-key shaped values.
 */
const SECRET_KEY =
  /(pass(word|wd|phrase)?|secret|api[-_]?key|access[-_]?key|token|auth(orization)?|credential|cookie|jwt|bearer|private[-_]?key|session)/i;
const SECRET_VALUE =
  /(\bsk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{8,}|\bAKIA[0-9A-Z]{12,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,})/g;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return value; // bounded: hostile graphs cannot recurse forever
  if (typeof value === "string") {
    // Always run the value-pattern replace (never .test() a /g/ regex — its
    // lastIndex state makes matches alternate), then key=value text.
    const scrubbed = value.replace(SECRET_VALUE, "[redacted]");
    return scrubbed.includes("=") || scrubbed.includes(":")
      ? scrubbed.replace(
          /([\w.-]*(?:password|passwd|secret|api[_-]?key|token|authorization|credential)[\w.-]*)\s*[:=]\s*("?)[^\s",]+/gi,
          (_m, k) => `${k}: [redacted]`,
        )
      : scrubbed;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  original: Original,
  opts?: Opts & { stretchEnd?: boolean },
): Promise<unknown> {
  const { base, key } = cfg(opts);
  const runId = opts?.runId || `sdk-${Date.now()}`;
  const headers = {
    Authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-eden-version": String(EDEN_PROTOCOL_VERSION),
  };

  const wrapRes = await fetch(`${base}/v1/wrap`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, args, run_id: runId }),
  }).catch(() => undefined);
  if (wrapRes?.ok) {
    const wrap = (await wrapRes.json()) as WrapResponse;
    if (wrap.action === "play") return wrap.facts ?? wrap.text;
  }

  const result = await original(name, args);
  const seq = (seqByRun.get(runId) || 0) + 1;
  seqByRun.set(runId, seq);
  await fetch(`${base}/v1/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent_id: "sdk_ts",
      run_id: runId,
      stretch_end: Boolean(opts?.stretchEnd),
      events: [
        {
          event_id: crypto.randomUUID(),
          seq,
          name,
          args: scrub(args) as Record<string, unknown>,
          ok: true,
        },
      ],
    }),
  }).catch(() => undefined);
  return result;
}

export async function endStretch(runId: string, opts?: Opts): Promise<void> {
  const { base, key } = cfg(opts);
  await fetch(`${base}/v1/ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ agent_id: "sdk_ts", run_id: runId, stretch_end: true, events: [] }),
  }).catch(() => undefined);
}

export class Eden {
  constructor(private opts: Opts = {}) {
    this.opts.runId = this.opts.runId || `sdk-${Date.now()}`;
  }
  runTool(name: string, args: Record<string, unknown>, original: Original) {
    return runTool(name, args, original, this.opts);
  }
  end() {
    return endStretch(this.opts.runId!, this.opts);
  }
}
