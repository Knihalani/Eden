import type { ChatRequest, ChatResponse, Model } from "./types";

/** A scripted model for tests and offline evals: `reply` sees each request and returns the text. */
export class FakeModel implements Model {
  readonly id = "fake";
  readonly calls: ChatRequest[] = [];

  constructor(private readonly reply: (request: ChatRequest) => string) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    const inputTokens = Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    const text = this.reply(request);
    return {
      text,
      usage: { inputTokens, outputTokens: Math.ceil(text.length / 4), cachedInputTokens: 0 },
      costUsd: 0,
      model: this.id,
      latencyMs: 0,
    };
  }
}
