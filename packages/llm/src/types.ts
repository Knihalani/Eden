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
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when it reports them. */
  cachedInputTokens: number;
}

export interface ChatResponse {
  text: string;
  usage: Usage;
  costUsd: number;
  model: string;
  latencyMs: number;
}

/** The one interface the engine sees. Tests use `FakeModel`; production uses `OpenRouterModel`. */
export interface Model {
  readonly id: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
