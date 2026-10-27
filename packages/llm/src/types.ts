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
