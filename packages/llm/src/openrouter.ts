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
import { createHash } from "node:crypto";
import { costOf, priceFor } from "./pricing";
import { estimateTokens } from "./tokens";
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
  /** The wall clock for `anthropicCache`'s read watch (tests pass their own). */
  now?: () => number;
}

/**
 * Calls that should have read the cache (D1800, `watchReads`) after which a route that has served no cached token is
 * taken to never read, and the model stops sending breakpoints. A call counts only when a prefix it marked, long enough
 * to cache, was answered by this model within that prefix's TTL before the call was sent, so a cold start or low
 * traffic (no prefix repeated in time) counts nothing. A route that reads at all is caught long before: at a one in
 * ten chance of a read a counted call, 50 misses in a row come about once in 190 (0.9^50, 0.5%). Bounded cost: a route
 * that bills writes and never reads costs at most 50 such writes, under +1.0x of a 1,000-3,000 token prefix each,
 * under $0.015 at Haiku 5.5's $0.10 a million [EST].
 */
export const CACHE_TRIP_CALLS = 50;
/**
 * Anthropic's smallest cacheable prefix on Haiku 5.5, in tokens (D1196). Another model's is larger (up to 4,096): a
 * prefix between the two is then neither written nor read, so tripping on it costs nothing either way.
 */
export const MIN_CACHE_TOKENS = 512;
/** Prefixes the read watch remembers (the check's and card call's few fixed prefixes, and per-user sheets). */
const WATCHED_PREFIXES = 512;

/**
 * How much of D817's caching a model still sends: 2, every breakpoint with its asked TTL; 1, only the breakpoints that
 * ask for no hour (the system prefix), since an hour's TTL is the newer field, the likelier to be refused, and a
 * breakpoint that asked for an hour costs more than none at five minutes (D1197: a user's checks are often more than
 * five minutes apart, so most would write again); 0, none.
 */
type CacheLevel = 0 | 1 | 2;

export class OpenRouterModel implements Model {
  readonly id: string;
  /** Lowered for good by refused requests (D1790); read by tests and reported once on the log. */
  cacheLevel: CacheLevel;
  /** Calls in a row a lower level answered after a 400: two lower `cacheLevel`, so one stray 400 does not. */
  private refusals = 0;
  /**
   * The read watch (D1800, `CACHE_TRIP_CALLS`): when each marked prefix (by hash) was last answered and its TTL; the
   * calls that should have read one and did not; whether any call has read the cache (then the watch stops).
   */
  private readonly prefixes = new Map<string, { at: number; ttlMs: number }>();
  readsMissed = 0;
  readsSeen = false;

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
    const sentAt = (this.options.now ?? Date.now)();
    let level = first;
    for (;;) {
      const res = await this.post(request, level, signal);
      if (res.ok) {
        // Lowered for good only after two calls in a row that a lower level answered: a 400 for another reason (one
        // that fails at every level) leaves the caching as it was, and so does a single stray one.
        if (level < first) {
          this.refusals++;
          if (this.refusals >= 2 && level < this.cacheLevel) {
            console.warn(`eden: openrouter refused cached requests (400); cache level ${this.cacheLevel} -> ${level}`);
            this.cacheLevel = level;
            this.refusals = 0;
          }
        } else if (level > 0) {
          this.refusals = 0;
        }
        const out = await this.read(res, t0);
        const marks = breakpoints(request.messages, level);
        if (marks.size === 0) return out;
        this.watchReads(request.messages, marks, out.usage.cachedInputTokens, sentAt);
        return { ...out, cacheBreakpoints: marks.size };
      }
      const text = (await res.text()).slice(0, 300);
      // A refusal of the cache fields must not cost the call: send again with less (at most twice a call).
      if (res.status === 400 && breakpoints(request.messages, level).size > 0) {
        level = (
          level === 2 && breakpoints(request.messages, 1).size > 0 && asksHour(request.messages) ? 1 : 0
        ) as CacheLevel;
        continue;
      }
      throw new Error(`openrouter ${res.status}: ${text}`);
    }
  }

  /**
   * D1800: a route that bills cache writes and never serves a read costs more than no caching at all. Counts the calls
   * that should have read (`CACHE_TRIP_CALLS`) and, at that many with no cached token ever served, drops to level 0
   * for the model's life with one content-free line on the log. Any read ends the watch for good.
   */
  private watchReads(messages: ChatMessage[], marks: Set<number>, cached: number, sentAt: number): void {
    if (this.readsSeen || this.cacheLevel === 0) return;
    if (cached > 0) {
      this.readsSeen = true;
      this.prefixes.clear();
      return;
    }
    const doneAt = (this.options.now ?? Date.now)();
    // The request's one TTL (`anthropicCacheMessages`); a read is expected up to a minute short of it.
    const ttlMs = messages.some((m, i) => marks.has(i) && m.cacheTtl === "1h") ? 3_600_000 : 300_000;
    let expected = false;
    const hash = createHash("sha256");
    const text: string[] = [];
    for (let i = 0; i <= Math.max(...marks); i++) {
      const m = messages[i]!;
      hash.update(`${m.role}\n${m.content}\u0000`);
      text.push(m.content);
      if (!marks.has(i) || estimateTokens(text.join("")) < MIN_CACHE_TOKENS) continue;
      const key = hash.copy().digest("hex").slice(0, 32);
      const prev = this.prefixes.get(key);
      if (prev && sentAt >= prev.at && sentAt - prev.at <= prev.ttlMs - 60_000) expected = true;
      this.prefixes.delete(key);
      this.prefixes.set(key, { at: doneAt, ttlMs });
      while (this.prefixes.size > WATCHED_PREFIXES) this.prefixes.delete(this.prefixes.keys().next().value as string);
    }
    if (expected && ++this.readsMissed >= CACHE_TRIP_CALLS) {
      console.warn(
        `eden: openrouter served no cached tokens on ${this.readsMissed} calls that should have read the cache; ` +
          `cache level ${this.cacheLevel} -> 0`,
      );
      this.cacheLevel = 0;
      this.prefixes.clear();
    }
  }

  private post(request: ChatRequest, level: CacheLevel, signal: AbortSignal): Promise<Response> {
    const body = {
      model: this.options.model,
      messages:
        level > 0
          ? anthropicCacheMessages(request.messages, level)
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
    const cacheWrite = data.usage?.prompt_tokens_details?.cache_write_tokens;
    const usage: Usage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      // Written to the cache, when the route reports it (`OpenRouterResponse`); absent is not reported, not zero.
      ...(typeof cacheWrite === "number" ? { cacheWriteTokens: cacheWrite } : {}),
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
function anthropicCacheMessages(messages: ChatMessage[], level: CacheLevel) {
  const marked = breakpoints(messages, level);
  // One TTL a request, as anthropic.ts (`requestTtl`): an hour when a marked message asks for it (D1197); at level 1
  // no such message is marked, so the provider's five minutes.
  const hour = messages.some((m, i) => marked.has(i) && m.cacheTtl === "1h");
  const control = hour ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  return messages.map(({ role, content }, i) =>
    marked.has(i) ? { role, content: [{ type: "text", text: content, cache_control: control }] } : { role, content },
  );
}

/** Whether a breakpoint of the request asks for the hour's TTL. */
function asksHour(messages: ChatMessage[]): boolean {
  const marked = breakpoints(messages, 2);
  return messages.some((m, i) => marked.has(i) && m.cacheTtl === "1h");
}

/**
 * The messages that carry a breakpoint at a level (`anthropicCacheMessages`' rules; at level 1 none that asks for an
 * hour, at 0 none). A 400 to a request that had none is not about caching and is never retried.
 */
function breakpoints(messages: ChatMessage[], level: CacheLevel): Set<number> {
  if (level === 0) return new Set();
  const filled = (m: ChatMessage) => m.content.trim() !== "";
  let lastSystem = -1;
  messages.forEach((m, i) => {
    if (m.role === "system" && filled(m)) lastSystem = i;
  });
  const marked = new Set<number>(lastSystem >= 0 ? [lastSystem] : []);
  for (let i = messages.length - 1; i >= 0 && marked.size < MAX_BREAKPOINTS; i--) {
    if (messages[i]!.cache && filled(messages[i]!)) marked.add(i);
  }
  if (level === 1) for (const i of marked) if (messages[i]!.cacheTtl === "1h") marked.delete(i);
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
    /**
     * `cache_write_tokens`: named on OpenRouter's prompt-caching page as summarised in
     * docs/research/fast-primitives-notes/latency_and_prompt_caching.md; no live call has shown it, so it is read only
     * when it is a number.
     */
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/** The request's `reasoning` field (see `chat`): none for an Anthropic model asked for none; else excluded, "low". */
function reasoningField(model: string, effort: ChatRequest["reasoning"]) {
  if (effort) return { reasoning: { effort, exclude: true } };
  return model.startsWith("anthropic/") ? {} : { reasoning: { effort: "low" as const, exclude: true } };
}
