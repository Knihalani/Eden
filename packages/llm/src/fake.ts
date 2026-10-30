import type { ChatRequest, ChatResponse, Model } from "./types";

/**
 * A scripted model for tests and offline evals: `reply` sees each request and returns the text, or the text and
 * whether it was cut off at the token cap.
 */
export class FakeModel implements Model {
  readonly id = "fake";
  readonly calls: ChatRequest[] = [];

  constructor(private readonly reply: (request: ChatRequest) => string | { text: string; truncated: boolean }) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    const inputTokens = Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    const out = this.reply(request);
    const { text, truncated } = typeof out === "string" ? { text: out, truncated: false } : out;
    return {
      text,
      usage: { inputTokens, outputTokens: Math.ceil(text.length / 4), cachedInputTokens: 0 },
      costUsd: 0,
      model: this.id,
      latencyMs: 0,
      truncated,
    };
  }
}
