import type { IslandCaller } from "@eden/ir";

export function islandUpstreamUrl(upstream?: string | null): string {
  const raw = (upstream || process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  if (/127\.0\.0\.1:8788|localhost:8788/.test(raw)) return "https://api.openai.com/v1";
  return raw;
}

export function wrapIsland(opts: { apiKey?: string; upstream?: string; fetch?: typeof fetch } = {}): IslandCaller | undefined {
  const key = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!key) return undefined;
  return openaiIsland({ apiKey: key, baseURL: islandUpstreamUrl(opts.upstream), fetch: opts.fetch });
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
    const res = await fn(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: key ? `Bearer ${key}` : "", "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${system}\nReturn JSON matching ${JSON.stringify(outputSchema)}.` },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
      signal: signal ?? AbortSignal.timeout(Number(process.env.EDEN_ISLAND_MS || 30_000)),
    });
    if (!res.ok) throw new Error(`island llm ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content || "{}";
    try {
      return JSON.parse(content);
    } catch {
      throw new Error("island returned non-JSON");
    }
  };
}
