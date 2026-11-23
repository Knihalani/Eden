/**
 * A plain OpenAI-compatible chat endpoint (`POST <baseUrl>/chat/completions`): Ollama (`:11434/v1`),
 * LM Studio (`:1234/v1`), vLLM (`:8000/v1`), llama.cpp (`:8080/v1`), or any server speaking the same
 * shape — including a self-hosted front a custom app already runs its agent's local models on.
 *
 * The body is the least a compatible server must take: model, messages, max_tokens, temperature, and
 * stop. OpenRouter's own fields are never sent (`provider` routing, `session_id`, `usage.include`,
 * `reasoning`): a strict server would 400 on them, and a local one has no routing to do. `reasoning`
 * requests are likewise not forwarded — the field's spelling differs per server (Ollama's `think`,
 * vLLM's `chat_template_kwargs`), and a reasoning local model's hidden tokens count against
 * `maxTokens` there exactly as they did on OpenRouter (D45), which the caller's caps already cover.
 * `response_format` goes only when the caller asks for JSON, and a 400 to a request that carried it
 * is sent once more without (some local servers reject the field; the prompts still ask for JSON and
 * the engine still validates the reply), matching the cache-fallback rule in `openrouter.ts`.
 *
 * Nothing here costs money by default: `costUsd` is the server's own `usage.cost` when it reports
 * one, else 0 — a local endpoint bills nothing, and the per-tenant daily cap stays a safety net for a
 * `EDEN_MODEL_BASE_URL` that is not in fact free rather than a thing a local run must size.
 *
 * Auth is optional: `apiKey` sends `Authorization: Bearer` (llama.cpp's `--api-key`, vLLM's
 * `--api-key`); unset, no header is sent, which is what Ollama and LM Studio expect.
 */
import { ModelHeldError, type RateHold } from "./pacing";
import type { ChatRequest, ChatResponse, Model, Usage } from "./types";

export interface LocalModelOptions {
  /** The endpoint's base URL including its version path (`http://localhost:11434/v1`). */
  baseUrl: string;
  /** The model name the endpoint serves (`qwen3:8b`, `llama3.1`, …). */
  model: string;
  /** Sent as `Authorization: Bearer` when set; local servers that take no key need none. */
  apiKey?: string;
  /**
   * A call's own deadline, default 120,000 ms: local inference on a small box is far slower than a
   * hosted route, and the engine's own deadlines bound the request-path roles long before this.
   */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Shared with the process's other model roles (D2046): a local server can answer 429 too. */
  rateHold?: RateHold;
}

/** The default call deadline (see `LocalModelOptions.timeoutMs`). */
export const LOCAL_TIMEOUT_MS = 120_000;

export class LocalModel implements Model {
  readonly id: string;
  /** Set for the model's life once a 400 to a `response_format` request came back: it is not sent again. */
  private jsonRefused = false;

  constructor(private readonly options: LocalModelOptions) {
    this.id = options.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const t0 = performance.now();
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? LOCAL_TIMEOUT_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const hold = this.options.rateHold;
    if (hold?.held()) {
      hold.skipped++;
      throw new ModelHeldError(`local-model: rate limit hold, ${this.options.model} call refused without sending`);
    }
    let res = await this.post(request, !this.jsonRefused, signal);
    if (res.status === 400 && request.json && !this.jsonRefused) {
      // The server refused `response_format`; it is dropped for good, not retried per call.
      await res.text();
      this.jsonRefused = true;
      if (hold?.held()) {
        hold.skipped++;
        throw new ModelHeldError(
          `local-model: rate limit hold, ${this.options.model} json-fallback refused without sending`,
        );
      }
      res = await this.post(request, false, signal);
    }
    if (res.status === 429) hold?.note(res);
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`local-model ${res.status}: ${text}`);
    }
    hold?.ok();
    return this.read(res, t0);
  }

  private post(request: ChatRequest, json: boolean, signal: AbortSignal): Promise<Response> {
    const body = {
      model: this.options.model,
      messages: request.messages.map(({ role, content }) => ({ role, content })),
      max_tokens: request.maxTokens,
      ...(request.stop?.length ? { stop: request.stop } : {}),
      temperature: request.temperature ?? 0,
      ...(request.json && json ? { response_format: { type: "json_object" } } : {}),
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    const base = this.options.baseUrl.replace(/\/$/, "");
    return (this.options.fetch ?? fetch)(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }

  private async read(res: Response, t0: number): Promise<ChatResponse> {
    const data = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const usage: Usage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cachedInputTokens: 0,
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      usage,
      costUsd: data.usage?.cost ?? 0,
      model: data.model ?? this.options.model,
      latencyMs: Math.round(performance.now() - t0),
      truncated: data.choices?.[0]?.finish_reason === "length",
      // A plain OpenAI `finish_reason` says "stop" for a natural end and a stop sequence alike, so
      // `stopped` is left unset, as `OpenRouterModel` does for a provider without a native reason.
    };
  }
}
