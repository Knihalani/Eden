import { IslandReply, unwrapIsland, type IslandCaller } from "@eden/ir";
import { withIslandBatch } from "./island-batch";
import { parseCacheTokens, parseUsage } from "./usage";

export { withIslandBatch } from "./island-batch";

export function wrapIsland(opts: { apiKey?: string; upstream?: string; fetch?: typeof fetch } = {}): IslandCaller | undefined {
  const key = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!key) return undefined;
  const raw = (opts.upstream || process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const baseURL = /127\.0\.0\.1:8788|localhost:8788/.test(raw) ? "https://api.openai.com/v1" : raw;
  const sync = openaiIsland({ apiKey: key, baseURL, fetch: opts.fetch });
  return withWitnessMemo(withIslandBatch(sync, { apiKey: key, baseURL, fetch: opts.fetch }));
}

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
        e.out = out;
        e.seen = 1;
      }
    },
  };
}

export function islandMemoKey(req: { system: string; input: unknown; outputSchema: unknown }): string {
  return `${req.system}\u0000${JSON.stringify(req.input)}\u0000${JSON.stringify(req.outputSchema)}`;
}

export function withWitnessMemo(
  base: IslandCaller,
  table: ReturnType<typeof createWitnessTable> = createWitnessTable(),
): IslandCaller {
  return async (req) => {
    const key = islandMemoKey(req as never);
    const hit = table.lookup(key);
    if (hit !== undefined) return new IslandReply(hit, { prompt_tokens: 0, completion_tokens: 0, memoized: true });
    if (req.pinned === true) throw new Error("pinned island miss");
    const out = await base(req);
    const { value } = unwrapIsland(out);
    table.observe(key, value);
    return out;
  };
}

const ISLAND_BACKOFF_MS = 300;

class NonJsonReply extends Error { constructor() { super("island returned non-JSON"); } }

export function openaiIsland(opts: {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
} = {}): IslandCaller {
  return async ({ system, input, outputSchema, signal }) => {
    const fallback = (process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const island = /127\.0\.0\.1:8788|localhost:8788/.test(fallback) ? "https://api.openai.com/v1" : fallback;
    const base = (opts.baseURL || island || "https://api.openai.com/v1").replace(/\/$/, "");
    const key = opts.apiKey || process.env.OPENAI_API_KEY || "";
    const fn = opts.fetch ?? fetch;

    let lastErr: unknown = undefined;
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (signal?.aborted) throw lastErr ?? new Error("island aborted");
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, ISLAND_BACKOFF_MS * attempt));
      try {
        const env = Number(process.env.EDEN_ISLAND_MS);
        const timeoutMs = Number.isFinite(env) && env > 0 ? Math.min(600_000, env) : 30_000;
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
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
            lastErr = new Error(`island llm ${res.status}`);
            continue;
          }
          throw new Error(`island llm ${res.status}`);
        }
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: unknown;
        };
        const content = json.choices?.[0]?.message?.content || "{}";
        try {
          const parsed = JSON.parse(content);
          const u = parseUsage(json.usage);
          const cache = parseCacheTokens(json.usage);
          const usage = u
            ? {
                prompt_tokens: u.prompt,
                completion_tokens: u.completion,
                ...(cache
                  ? {
                      cached_tokens: cache.cached,
                      ...(cache.cacheWrite != null ? { cache_write_tokens: cache.cacheWrite } : {}),
                      ...(cache.denom != null ? { cache_input_tokens: cache.denom } : {}),
                    }
                  : {}),
              }
            : undefined;
          return new IslandReply(parsed, usage);
        } catch {
          throw new NonJsonReply();
        }
      } catch (err) {
        lastErr = err;
        if (signal?.aborted && err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) throw err;
        const transient =
          err instanceof NonJsonReply ||
          !(err instanceof Error && /^island llm \d+$/.test(err.message));
        if (attempt < 2 && transient) continue;
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("island failed");
  };
}
