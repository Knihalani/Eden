export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

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
   * effort set can leave no room for the answer (D45). Models that do not reason ignore it.
   */
  reasoning?: "low" | "medium" | "high";
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when it reports them. */
  cachedInputTokens: number;
  /** Input tokens written to the prompt cache, when the provider bills them apart (Anthropic). */
  cacheWriteTokens?: number;
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
}

/** The one interface the engine sees. Tests use `FakeModel`; production uses `OpenRouterModel`. */
export interface Model {
  readonly id: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
