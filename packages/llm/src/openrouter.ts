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
   * Send Anthropic `cache_control` breakpoints (content blocks) to an `anthropic/*` model (D817; the servers' default
   * since D1790, `modelRolesFromEnv`). Every other model ignores it. OpenRouter documents per-block breakpoints for
   * Anthropic models, but no live call from this repository has confirmed its ZDR route accepts them, so a refusal
   * never fails a call: a 400 to a request that carried breakpoints is sent again with less (`cacheLevel`), and the
   * model keeps the lower level for its life. Caching changes the price of a prefix, never the reply.
   */
  anthropicCache?: boolean;
}

/**
 * How much of D817's caching a model still sends: 2, every breakpoint with its asked TTL; 1, the breakpoints at the
 * provider's default 5-minute TTL (an hour's TTL is the newer field, the likelier to be refused); 0, none.
 */
type CacheLevel = 0 | 1 | 2;

export class OpenRouterModel implements Model {
  readonly id: string;
  /** Lowered for good by a refused request (D1790); read by tests and reported once on the log. */
  cacheLevel: CacheLevel;

  constructor(private readonly options: OpenRouterOptions) {
    this.id = options.model;
    this.cacheLevel = options.anthropicCache && options.model.startsWith("anthropic/") ? 2 : 0;
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
    const first = this.cacheLevel;
    let level = first;
    for (;;) {
      const res = await this.post(request, level, signal);
      if (res.ok) {
        // Kept for good only once a lower level has answered: a 400 for another reason (one that fails at every
        // level) leaves the caching as it was.
        if (level < first && level < this.cacheLevel) {
          console.warn(`eden: openrouter refused a cached request (400); cache level ${this.cacheLevel} -> ${level}`);
          this.cacheLevel = level;
        }
        return this.read(res, t0);
      }
      const text = (await res.text()).slice(0, 300);
      // A refusal of the cache fields must not cost the call: send again with less (at most twice a call).
      if (res.status === 400 && level > 0 && sentBreakpoint(request.messages)) {
        level = (level === 2 && asksHour(request.messages) ? 1 : 0) as CacheLevel;
        continue;
      }
      throw new Error(`openrouter ${res.status}: ${text}`);
    }
  }

  private post(request: ChatRequest, level: CacheLevel, signal: AbortSignal): Promise<Response> {
    const body = {
      model: this.options.model,
      messages:
        level > 0
          ? anthropicCacheMessages(request.messages, level === 2)
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
    return (this.options.fetch ?? fetch)(`${this.options.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async read(res: Response, t0: number): Promise<ChatResponse> {
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
      // "stop" for both). Anthropic's is exact; others (OpenAI's "stop", Google's "STOP") say either, so they leave it
      // unset, as an unreported reason does, and the reader may still close a cut reply (audit A5: `false` for them
      // lost every stopped reading on an `EDEN_MODEL` that is not Anthropic's).
      ...stoppedOf(data.choices?.[0]?.native_finish_reason),
    };
  }
}

/** Native finish reasons that are a natural end or a cap, never a stop sequence. */
const NOT_STOPPED = new Set(["end_turn", "max_tokens", "length", "MAX_TOKENS", "tool_use", "tool_calls"]);

function stoppedOf(native: unknown): { stopped?: boolean } {
  if (typeof native !== "string") return {};
  if (native === "stop_sequence") return { stopped: true };
  return NOT_STOPPED.has(native) ? { stopped: false } : {};
}

/** Anthropic rejects a request with more than this many `cache_control` breakpoints. */
const MAX_BREAKPOINTS = 4;

/**
 * Anthropic models cache only up to explicit `cache_control` breakpoints, which OpenRouter passes through on content
 * blocks. Mirrors anthropic.ts: a breakpoint on the last system message and on each message marked `cache`; every
 * other message keeps plain string content. Anthropic allows at most 4 breakpoints and rejects cache_control on empty
 * text, so the last non-empty system message comes first, then the latest marked messages up to the cap, and an empty
 * or blank message never gets one. Whether OpenRouter's ZDR Anthropic endpoints honour the breakpoint is unverified
 * (no live call was made), so the saving is an estimate; a refusal falls back to less (`chat`, D1790).
 */
function anthropicCacheMessages(messages: ChatMessage[], withTtl: boolean) {
  const marked = breakpoints(messages);
  // One TTL a request, as anthropic.ts (`requestTtl`): an hour when a marked message asks for it (D1197) and the
  // model still sends TTLs (D1790's level 2), else the provider's five minutes.
  const hour = withTtl && messages.some((m, i) => marked.has(i) && m.cacheTtl === "1h");
  const control = hour ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  return messages.map(({ role, content }, i) =>
    marked.has(i) ? { role, content: [{ type: "text", text: content, cache_control: control }] } : { role, content },
  );
}

/** Whether a request gets any breakpoint at all (a 400 to one with none is not about caching). */
function sentBreakpoint(messages: ChatMessage[]): boolean {
  return breakpoints(messages).size > 0;
}

/** Whether a breakpoint of the request asks for the hour's TTL. */
function asksHour(messages: ChatMessage[]): boolean {
  const marked = breakpoints(messages);
  return messages.some((m, i) => marked.has(i) && m.cacheTtl === "1h");
}

/** The messages that carry a breakpoint (`anthropicCacheMessages`' rules). */
function breakpoints(messages: ChatMessage[]): Set<number> {
  const filled = (m: ChatMessage) => m.content.trim() !== "";
  let lastSystem = -1;
  messages.forEach((m, i) => {
    if (m.role === "system" && filled(m)) lastSystem = i;
  });
  const marked = new Set<number>(lastSystem >= 0 ? [lastSystem] : []);
  for (let i = messages.length - 1; i >= 0 && marked.size < MAX_BREAKPOINTS; i--) {
    if (messages[i]!.cache && filled(messages[i]!)) marked.add(i);
  }
  return marked;
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
