/**
 * OpenRouter's OpenAI-compatible chat endpoint.
 *
 * Data handling: every request asks OpenRouter to route only to providers that do not collect data
 * (`provider.data_collection: "deny"`) and, by default, only to zero-data-retention endpoints (`provider.zdr`).
 * Both narrow which providers may serve the call; a call no compliant provider can serve fails rather than falling
 * back to one that retains data. Verify both fields against OpenRouter's current provider-routing docs before
 * launch: this file was written without a live check (see docs/PRIVACY.md).
 */
import { costOf, priceFor } from "./pricing";
import type { ChatRequest, ChatResponse, Model } from "./types";

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Route only to zero-data-retention endpoints. Default true. */
  zdr?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OpenRouterModel implements Model {
  readonly id: string;

  constructor(private readonly options: OpenRouterOptions) {
    this.id = options.model;
  }

  static fromEnv(env = process.env): OpenRouterModel | null {
    if (!env.OPENROUTER_API_KEY) return null;
    return new OpenRouterModel({
      apiKey: env.OPENROUTER_API_KEY,
      model: env.EDEN_MODEL || "z-ai/glm-5.3-flash",
      baseUrl: env.OPENROUTER_BASE_URL,
      zdr: env.EDEN_MODEL_ZDR !== "off",
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const t0 = performance.now();
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const body = {
      model: this.options.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0,
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
      provider: { data_collection: "deny", zdr: this.options.zdr ?? true, allow_fallbacks: true },
      usage: { include: true },
      // Sticky routing: OpenRouter keeps a session_id on one provider endpoint (10 min idle), so a stable prompt
      // prefix is served from that endpoint's cache (docs/research/fast-primitives-notes/latency_and_prompt_caching.md).
      ...(request.cacheKey ? { session_id: request.cacheKey.slice(0, 256) } : {}),
    };
    const res = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as OpenRouterResponse;
    const usage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      usage,
      costUsd: data.usage?.cost ?? costOf(usage, priceFor(this.options.model)),
      model: data.model ?? this.options.model,
      latencyMs: Math.round(performance.now() - t0),
    };
  }
}

interface OpenRouterResponse {
  model?: string;
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}
