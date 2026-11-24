/**
 * A lab card transport (M0; lab only, like D97's Anthropic provider): the card model behind any OpenAI-compatible
 * `/chat/completions` endpoint, such as the distilled card model `packages/sim/modal/cards_distill.py serve` puts on
 * Modal with vLLM. `bun run funnel --cards-endpoint URL` makes every card live through it (no replay), so the funnel
 * can screen hidden facts and decoys on a distilled model's cards at $0 Anthropic. Results made this way are labelled
 * `cards: endpoint (lab, M0)` and are never the shipped card model's figures.
 *
 * No product package imports this file. Prompts are Eden's own (`ModelCardMaker` builds them); the endpoint sees only
 * simulated items. The bearer key, when the server wants one, is read from `EDEN_LAB_CARDS_KEY` and never printed.
 */
import { ModelCardMaker, type CardBatch, type CardMaker } from "@eden/engine";
import type { ChatRequest, ChatResponse, Model } from "@eden/llm";

/** What `--cards-endpoint` reports in the run's header and JSON. */
export const ENDPOINT_LABEL = "endpoint (lab, M0)";

export interface EndpointOptions {
  /** The server's base URL, up to `/v1` (`https://…modal.run/v1`). */
  baseUrl: string;
  /** The served model's name (vLLM's `--served-model-name`). */
  model: string;
  /** A bearer key, when the server checks one (vLLM `--api-key`). */
  apiKey?: string;
  /** Per-call timeout, ms. */
  timeoutMs?: number;
  /** Ask the server for a JSON object (`response_format`); vLLM supports it with guided decoding. */
  json?: boolean;
  fetch?: typeof fetch;
}

interface CompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The base URL as given, without a trailing slash, with `/v1` added when it is missing. */
export function endpointBase(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`--cards-endpoint must be http(s): ${url}`);
  const base = url.replace(/\/+$/, "");
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

/** An OpenAI-compatible model at $0: the lab's GPU time is not booked per call. */
export class EndpointModel implements Model {
  readonly id: string;

  constructor(private readonly o: EndpointOptions) {
    this.id = `endpoint:${o.model}`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const t0 = performance.now();
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 120_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const body = {
      model: this.o.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0,
      ...(request.json && this.o.json !== false ? { response_format: { type: "json_object" } } : {}),
      ...(request.stop?.length ? { stop: request.stop } : {}),
    };
    const res = await (this.o.fetch ?? fetch)(`${endpointBase(this.o.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    // The status and the head of the body only: the request (and its headers) never go into an error.
    if (!res.ok) throw new Error(`cards endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as CompletionResponse;
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cachedInputTokens: 0,
      },
      costUsd: 0,
      model: data.model ?? this.o.model,
      provider: ENDPOINT_LABEL,
      latencyMs: Math.round(performance.now() - t0),
      truncated: choice?.finish_reason === "length",
    };
  }
}

/**
 * A batch with its cards kept and its requests dropped (N4's `--cards-rest`): what a card-only model gives. An item
 * read for its requests only is then uncovered, as the enricher reads a null.
 */
export function cardsOnly(batch: CardBatch, count: number): CardBatch {
  return { ...batch, requests: Array.from({ length: count }, () => null) };
}

/** The card maker over an endpoint: Eden's own `ModelCardMaker` (same prompt, caps and parser) on the lab transport. */
export function endpointCardMaker(o: EndpointOptions): CardMaker {
  return new ModelCardMaker(new EndpointModel(o));
}

/** `--cards-endpoint URL [--cards-endpoint-model NAME]`, with the key from the environment (never a flag). */
export function endpointFromArgs(url: string, model: string, env: Record<string, string | undefined> = process.env) {
  return {
    baseUrl: endpointBase(url),
    model: model || "eden-cards",
    ...(env.EDEN_LAB_CARDS_KEY ? { apiKey: env.EDEN_LAB_CARDS_KEY } : {}),
    // A CPU-served model (llama.cpp, several slots sharing four cores) can take minutes per batch; a timed-out batch
    // is uncovered, not retried, so the lab raises the cap rather than lose cards.
    ...(Number(env.EDEN_LAB_CARDS_TIMEOUT_MS) > 0 ? { timeoutMs: Number(env.EDEN_LAB_CARDS_TIMEOUT_MS) } : {}),
  } satisfies EndpointOptions;
}
