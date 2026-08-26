import type { IslandCaller } from "@eden/ir";

export function islandUpstreamUrl(upstream?: string | null): string {
  const raw = (upstream || process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  if (/127\.0\.0\.1:8788|localhost:8788/.test(raw)) return "https://api.openai.com/v1";
  return raw;
}

export function wrapIsland(opts: { apiKey?: string; upstream?: string; fetch?: typeof fetch } = {}): IslandCaller | undefined {
  const key = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!key) return undefined;
  return withWitnessMemo(openaiIsland({ apiKey: key, baseURL: islandUpstreamUrl(opts.upstream), fetch: opts.fetch }));
}

/**
 * Deterministic-first serving: compiled programs come from witnesses, and an
 * island whose identical input already produced the SAME output twice is not
 * a semantic question anymore — it is a lookup. Calling gpt-4o-mini to look
 * up an answer the recordings already contain is pure waste (latency + cost
 * + a nondeterminism surface). Unseen or disagreeing inputs fall through to
 * the live model, and its answer is recorded for next time.
 *
 * Keyed on (system, input, schema); temperature is pinned to 0 upstream, so
 * agreement between two past runs is meaningful evidence. Bounded; a burst
 * of unique inputs clears rather than grows without limit.
 */
const ISLAND_MEMO_CAP = 512;

export function createWitnessTable(): {
  lookup: (key: string) => unknown | undefined;
  observe: (key: string, out: unknown) => void;
} {
  const m = new Map<string, { out: unknown; seen: number }>();
  return {
    lookup(key) {
      const e = m.get(key);
      return e && e.seen >= 2 ? e.out : undefined;
    },
    observe(key, out) {
      const json = JSON.stringify(out);
      const e = m.get(key);
      if (!e) {
        if (m.size >= ISLAND_MEMO_CAP) m.clear();
        m.set(key, { out, seen: 1 });
        return;
      }
      if (JSON.stringify(e.out) === json) e.seen += 1;
      else {
        // Disagreement: prior evidence was noise. Restart counting at 1.
        e.out = out;
        e.seen = 1;
      }
    },
  };
}

export function islandMemoKey(req: { system: string; input: unknown; outputSchema: unknown }): string {
  return `${req.system}\u0000${JSON.stringify(req.input)}\u0000${JSON.stringify(req.outputSchema)}`;
}

export function withWitnessMemo(base: IslandCaller): IslandCaller {
  const table = createWitnessTable();
  return async (req) => {
    const key = islandMemoKey(req as never);
    const hit = table.lookup(key);
    if (hit !== undefined) return hit;
    const out = await base(req);
    table.observe(key, out);
    return out;
  };
}

/**
 * Which island failures are worth another attempt?
 *
 * An island that throws mid-program is a deopt the caller cannot always
 * replay safely — by then earlier steps may have written. A 429 or a provider
 * blip is not information about the program; paying one short backoff to
 * avoid tearing down a half-executed stretch is the cheapest failure
 * recovery available. Schema rejections (other 4xx) are not transient and
 * fail immediately.
 */
export function isTransientIslandFailure(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Island retry policy. Total attempts = 1 + ISLAND_RETRIES; linear backoff. */
export const ISLAND_RETRIES = 2;

function islandTimeoutMs(): number {
  const env = Number(process.env.EDEN_ISLAND_MS);
  return Number.isFinite(env) && env > 0 ? Math.min(600_000, env) : 30_000;
}
const ISLAND_BACKOFF_MS = 300;

/** Marks corruption-style replies (valid HTTP, unparseable body). */
class NonJsonReply extends Error {
  constructor() {
    super("island returned non-JSON");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the error came from the *caller's* signal — retries must stop. */
function callerAborted(err: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  // Match by name first: providers raise AbortError ("This operation was
  // aborted") with messages that do not contain the word "abort".
  if (err instanceof Error && err.name === "AbortError") return true;
  return err instanceof Error && /abort/i.test(err.message);
}

export function openaiIsland(opts: {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
} = {}): IslandCaller {
  return async ({ system, input, outputSchema, signal }) => {
    const base = (opts.baseURL || islandUpstreamUrl() || "https://api.openai.com/v1").replace(/\/$/, "");
    const key = opts.apiKey || process.env.OPENAI_API_KEY || "";
    const fn = opts.fetch ?? fetch;

    let lastErr: unknown = undefined;
    for (let attempt = 0; attempt <= ISLAND_RETRIES; attempt++) {
      if (signal?.aborted) throw lastErr ?? new Error("island aborted");
      if (attempt > 0) await sleep(ISLAND_BACKOFF_MS * attempt);
      try {
        const res = await fn(`${base}/chat/completions`, {
          method: "POST",
          headers: { authorization: key ? `Bearer ${key}` : "", "content-type": "application/json" },
          body: JSON.stringify({
            model: opts.model || "gpt-5.6-luna",
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: `${system}\nReturn JSON matching ${JSON.stringify(outputSchema)}.` },
              { role: "user", content: JSON.stringify(input) },
            ],
          }),
          // Per-attempt budget, not shared across attempts: one slow call
          // must not consume every retry's window. A non-numeric
          // EDEN_ISLAND_MS must fall back to the default, not hand NaN to
          // AbortSignal.timeout (which throws synchronously and used to be
          // retried as a "transient" failure forever).
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(islandTimeoutMs())])
            : AbortSignal.timeout(islandTimeoutMs()),
        });
        if (!res.ok) {
          if (attempt < ISLAND_RETRIES && isTransientIslandFailure(res.status)) {
            lastErr = new Error(`island llm ${res.status}`);
            continue;
          }
          throw new Error(`island llm ${res.status}`);
        }
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content || "{}";
        try {
          return JSON.parse(content);
        } catch {
          throw new NonJsonReply();
        }
      } catch (err) {
        lastErr = err;
        // The caller gave up; no amount of retrying honours an abort.
        if (callerAborted(err, signal)) throw err;
        // Network-level failures carry no status; truncation-style corruption
        // is often transient. Both are worth one more attempt.
        const transient =
          err instanceof NonJsonReply ||
          !(err instanceof Error && /^island llm \d+$/.test(err.message));
        if (attempt < ISLAND_RETRIES && transient) continue;
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("island failed");
  };
}
