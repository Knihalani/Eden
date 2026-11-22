export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * The prompt up to and including this message is a stable prefix: a provider with prompt caching ends a cached
   * prefix here (Anthropic: a `cache_control` breakpoint). Others ignore it.
   */
  cache?: boolean;
  /**
   * With `cache`: keep this prefix an hour, not five minutes (Anthropic's 1-hour TTL: a write costs 2x input, not
   * 1.25x; a read 0.1x either way). For a block re-sent tens of minutes apart, such as a user's rule sheet (D1197).
   * Anthropic wants a longer TTL before a shorter one: `OpenRouterModel` sends every breakpoint up to the last one that
   * asks the hour at 1 hour and those after it at five minutes (D1800); the lab's `AnthropicModel` sends one TTL a
   * request, the hour when any marked message asks it. On a system message it asks the hour for that breakpoint.
   */
  cacheTtl?: "1h";
}

export type ProviderSort = "throughput" | "latency" | "price";

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** Ask for a JSON object back. The caller still validates it. */
  json?: boolean;
  signal?: AbortSignal;
  /**
   * A stable, opaque key for the caller (e.g. a hash of tenant/user): providers that support it route repeat calls
   * to the same endpoint so the prompt-cache prefix is reused. Never put content or raw ids in it.
   */
  cacheKey?: string;
  /**
   * How hard a reasoning model should think. Its reasoning tokens count against `maxTokens`, so a small cap with no
   * effort set can leave no room for the answer (D45). "off" disables reasoning rather than hiding its text.
   * Models that do not reason ignore it.
   */
  reasoning?: "off" | "low" | "medium" | "high";
  /** OpenRouter-only routing preference; other adapters ignore it. Privacy restrictions are not overridden. */
  provider?: { sort: ProviderSort };
  /**
   * Stop sequences: the model stops before writing any of them, and the reply's text leaves it out (Anthropic
   * `stop_sequences`, OpenRouter `stop`). The caller reads a reply cut there knowing where it was cut.
   */
  stop?: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when it reports them. */
  cachedInputTokens: number;
  /** Input tokens written to the prompt cache, when the provider bills them apart (Anthropic). */
  cacheWriteTokens?: number;
  /**
   * Output tokens spent on hidden reasoning (already counted in `outputTokens`), when the provider reports them
   * (OpenRouter: `completion_tokens_details.reasoning_tokens`). Absent means not reported, not zero.
   */
  reasoningTokens?: number;
}

export interface ChatResponse {
  text: string;
  usage: Usage;
  costUsd: number;
  model: string;
  /** The endpoint that served the call, when the router reports it (research and cost reporting only). */
  provider?: string;
  latencyMs: number;
  /** Time to the first answer token, ms, when the call was streamed. */
  ttftMs?: number;
  /** The model stopped at `maxTokens`: the text may be cut off (or empty, when reasoning used the cap). */
  truncated?: boolean;
  /**
   * Whether the reply ended on one of the request's `stop` sequences (true), ended any other way (false), or the
   * provider did not say (unset). A caller that closes a stopped reply checks this first: a reply cut short by a
   * dropped stream is not one the stop ended.
   */
  stopped?: boolean;
  /**
   * How many cache breakpoints the request that answered carried (`OpenRouterModel` under `anthropicCache`; unset
   * when none): the servers' `/metrics` count calls with breakpoints against the cached tokens they read (D1800).
   */
  cacheBreakpoints?: number;
}

/** The one interface the engine sees. Tests use `FakeModel`; production uses `OpenRouterModel`. */
export interface Model {
  readonly id: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
