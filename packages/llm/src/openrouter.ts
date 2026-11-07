/**
 * OpenRouter's OpenAI-compatible chat endpoint.
 *
 * Data handling: every request asks OpenRouter to route only to providers that do not collect data
 * (`provider.data_collection: "deny"`) and, by default, only to zero-data-retention endpoints (`provider.zdr`).
 * Both narrow which providers may serve the call; a call no compliant provider can serve fails rather than falling
 * back to one that retains data. Verify both fields against OpenRouter's current provider-routing docs before
 * launch: this file was written without a live check (see docs/PRIVACY.md).
 *
 * `allowLogging` lifts both, for the lab's runs on free models only (free endpoints log prompts and none is ZDR;
 * docs/research/edge-freelab.md). Nothing reads it from the environment: `fromEnv`, and so the server, never sets it.
 */
import { costOf, priceFor } from "./pricing";
import type { ChatMessage, ChatRequest, ChatResponse, Model, Usage } from "./types";

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Route only to zero-data-retention endpoints. Default true. */
  zdr?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Provider order (OpenRouter's `provider.sort`). Unset: OpenRouter's default balancing (price weighted against
   * throughput and latency). "price" tries the cheapest compliant endpoint first: for background work no user waits
   * on (card enrichment; docs/research/econ-background.md). It still honours `zdr` and `data_collection`.
   */
  sort?: "price" | "throughput" | "latency";
  /**
   * LAB ONLY: route to endpoints that may log or retain prompts (`data_collection: "allow"`, no ZDR), which free
   * models need. Never set it where real user data flows; the server has no way to.
   */
  allowLogging?: boolean;
  /**
   * Send Anthropic `cache_control` breakpoints (content blocks) to an `anthropic/*` model. Default off: whether
   * OpenRouter's ZDR Anthropic endpoints accept and honour them is unverified, so a live probe must confirm it before
   * this is enabled in production. The lab may turn it on; every other model ignores it.
   */
  anthropicCache?: boolean;
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
      messages:
        this.options.anthropicCache && this.options.model.startsWith("anthropic/")
          ? anthropicCacheMessages(request.messages)
          : request.messages.map(({ role, content }) => ({ role, content })),
      max_tokens: request.maxTokens,
      ...(request.stop?.length ? { stop: request.stop } : {}),
      temperature: request.temperature ?? 0,
      ...(request.json ? { response_format: { type: "json_object" } } : {}),
      // The reasoning itself is never read: excluding it keeps it off the wire (it is still billed as output). With no
      // effort asked, an Anthropic model gets no reasoning field, so it does not think (D144, D149: thinking was slower
      // and dearer for no gain). Another model (an `EDEN_MODEL` override) may reason by default at its provider's
      // effort, and those tokens count against `maxTokens` (D45's truncation): it gets "low", excluded, as the roles
      // asked before D155.
      ...reasoningField(this.options.model, request.reasoning),
      provider: {
        data_collection: this.options.allowLogging ? "allow" : "deny",
        zdr: this.options.allowLogging ? false : (this.options.zdr ?? true),
        allow_fallbacks: true,
        ...(this.options.sort ? { sort: this.options.sort } : {}),
      },
      usage: { include: true },
      // Sticky routing: OpenRouter keeps a session_id on one provider endpoint (10 min idle), so a stable prompt
      // prefix is served from that endpoint's cache
      // (docs/research/fast-primitives-notes/latency_and_prompt_caching.md).
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
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
    const usage: Usage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      // The reasoning is excluded from the reply but billed as output: its share is only visible here.
      ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      usage,
      costUsd: data.usage?.cost ?? costOf(usage, priceFor(this.options.model)),
      model: data.model ?? this.options.model,
      ...(data.provider ? { provider: data.provider } : {}),
      latencyMs: Math.round(performance.now() - t0),
      truncated: data.choices?.[0]?.finish_reason === "length",
      // Only the provider's own reason tells a stop sequence from a natural end (OpenRouter's finish_reason says
      // "stop" for both); unset when it is not reported.
      ...(typeof data.choices?.[0]?.native_finish_reason === "string"
        ? { stopped: data.choices[0].native_finish_reason === "stop_sequence" }
        : {}),
    };
  }
}

/** Anthropic rejects a request with more than this many `cache_control` breakpoints. */
const MAX_BREAKPOINTS = 4;

/**
 * Anthropic models cache only up to explicit `cache_control` breakpoints, which OpenRouter passes through on content
 * blocks. Mirrors anthropic.ts: a breakpoint on the last system message and on each message marked `cache`; every
 * other message keeps plain string content. Anthropic allows at most 4 breakpoints and rejects cache_control on empty
 * text, so the last non-empty system message comes first, then the latest marked messages up to the cap, and an empty
 * or blank message never gets one. Whether OpenRouter's ZDR Anthropic endpoints honour the breakpoint is unverified
 * (no live call was made), so no saving is claimed for it.
 */
function anthropicCacheMessages(messages: ChatMessage[]) {
  const filled = (m: ChatMessage) => m.content.trim() !== "";
  let lastSystem = -1;
  messages.forEach((m, i) => {
    if (m.role === "system" && filled(m)) lastSystem = i;
  });
  const marked = new Set<number>(lastSystem >= 0 ? [lastSystem] : []);
  for (let i = messages.length - 1; i >= 0 && marked.size < MAX_BREAKPOINTS; i--) {
    if (messages[i]!.cache && filled(messages[i]!)) marked.add(i);
  }
  return messages.map(({ role, content }, i) =>
    marked.has(i)
      ? { role, content: [{ type: "text", text: content, cache_control: { type: "ephemeral" } }] }
      : { role, content },
  );
}

interface OpenRouterResponse {
  model?: string;
  provider?: string;
  choices?: { message?: { content?: string }; finish_reason?: string; native_finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/** The request's `reasoning` field (see `chat`): none for an Anthropic model asked for none; else excluded, "low". */
function reasoningField(model: string, effort: ChatRequest["reasoning"]) {
  if (effort) return { reasoning: { effort, exclude: true } };
  return model.startsWith("anthropic/") ? {} : { reasoning: { effort: "low" as const, exclude: true } };
}
