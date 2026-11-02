/**
 * Anthropic's Messages API over plain `fetch` (no SDK: the repo keeps dependencies few). LAB ONLY for now: nothing in
 * packages/server or packages/engine constructs it, and production model calls stay on OpenRouter's ZDR routing (D12).
 * Making Anthropic a production provider needs its own decision row and PRIVACY.md / COST-MODEL.md updates.
 *
 * - Prompt caching: every system message is sent as its own block and the last one carries `cache_control`, so the
 *   stable prefix (Eden's fixed instructions) is written once and read back at 0.1x after. Callers keep volatile text
 *   (the request, candidates) in user messages, after the breakpoint. Prefixes under the model's minimum (512 tokens
 *   on the current models) silently do not cache; the usage says so (`cacheWriteTokens` 0).
 * - Streaming, so the first token's time is measured (`ttftMs`).
 * - Cost is computed here from the reported usage, cache writes and reads priced apart (`ANTHROPIC_PRICES`).
 * - `meter`: an optional hook that sees a worst-case estimate before each call (and may throw to refuse it) and the
 *   real usage after. The lab's hard spend cap lives there (packages/sim/src/lab/spend.ts).
 * - Retries on 429/529/5xx come from the `fetch` passed in (a `Pacer`'s), not from here.
 */
import type { ChatRequest, ChatResponse, Model, Usage } from "./types";

/** USD per million tokens, at the short-prompt rate. Cache writes are 1.25x input (5 min) or 2x (1 h); reads 0.1x. */
export interface AnthropicPrice {
  input: number;
  output: number;
  /** Above this many prompt tokens every rate is multiplied by `longMultiplier`. */
  longAbove?: number;
  longMultiplier?: number;
}

/** From the Claude API reference bundled with Claude Code, 2026-10-06: Haiku 5.5 is $0.10 / $0.50 up to 100K. */
export const ANTHROPIC_PRICES: Record<string, AnthropicPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longAbove: 100_000, longMultiplier: 5 },
};

export interface AnthropicUsage extends Usage {
  /** Prompt tokens written to the cache this call (priced at 1.25x or 2x input). */
  cacheWriteTokens: number;
}

/** What the meter sees after a call. */
export interface AnthropicCallRecord {
  model: string;
  usage: AnthropicUsage;
  costUsd: number;
  latencyMs: number;
  ttftMs: number | null;
  stopReason: string | null;
  /** HTTP status when the call failed; the cost of a failed call is 0 (nothing was billed for a refused request). */
  status?: number;
}

export interface AnthropicMeter {
  /** Called before each request with its worst-case cost. Throw to refuse the call. */
  reserve(estimateUsd: number): void;
  /** Called after each request with what it really cost. */
  book(record: AnthropicCallRecord): void;
}

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** "5m" (default) or "1h". The lab's runs reuse a prefix within seconds, so 5 minutes is the cheap choice. */
  cacheTtl?: "5m" | "1h";
  /**
   * Thinking. Default "off": Eden's calls are short reads with a JSON answer, where latency matters more than depth
   * (the reader's problem on reasoning endpoints, D95). "adaptive" lets the model decide, at the request's effort.
   */
  thinking?: "off" | "adaptive";
  meter?: AnthropicMeter;
}

export function anthropicPrice(model: string): AnthropicPrice {
  // An unknown model is priced high so a budget stays conservative.
  return ANTHROPIC_PRICES[model] ?? { input: 5, output: 25 };
}

/** The cost of one call from its usage: uncached input, cache writes, cache reads and output each priced. */
export function anthropicCost(usage: AnthropicUsage, price: AnthropicPrice, ttl: "5m" | "1h" = "5m"): number {
  const promptTokens = usage.inputTokens;
  const long = price.longAbove !== undefined && promptTokens > price.longAbove ? (price.longMultiplier ?? 1) : 1;
  const input = price.input * long;
  const uncached = Math.max(0, promptTokens - usage.cachedInputTokens - usage.cacheWriteTokens);
  const usd =
    uncached * input +
    usage.cacheWriteTokens * input * (ttl === "1h" ? 2 : 1.25) +
    usage.cachedInputTokens * input * 0.1 +
    usage.outputTokens * price.output * long;
  return usd / 1_000_000;
}

/** Worst case for a call before it is sent: every prompt token written to the cache, every output token used. */
export function anthropicWorstCase(model: string, promptChars: number, maxTokens: number): number {
  const price = anthropicPrice(model);
  // ~4 chars a token; Haiku 5.5's tokenizer counts ~30% more, so pad by half.
  const prompt = Math.ceil((promptChars / 4) * 1.5);
  return anthropicCost(
    { inputTokens: prompt, cachedInputTokens: 0, cacheWriteTokens: prompt, outputTokens: maxTokens },
    price,
    "1h",
  );
}

interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
}

const JSON_INSTRUCTION = "Reply with one JSON object only: no prose, no code fence.";

/** Builds the Messages API body: system blocks (last one cached), then the turns, merged by role. */
export function anthropicBody(options: AnthropicOptions, request: ChatRequest, stream: boolean) {
  const systemTexts = request.messages.filter((m) => m.role === "system").map((m) => m.content);
  if (request.json) systemTexts.push(JSON_INSTRUCTION);
  const system: SystemBlock[] = systemTexts.map((text) => ({ type: "text", text }));
  const last = system.at(-1);
  if (last) last.cache_control = options.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  // The API wants alternating turns starting with a user turn: consecutive same-role messages are joined.
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of request.messages) {
    if (m.role === "system") continue;
    const prev = messages.at(-1);
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else messages.push({ role: m.role, content: m.content });
  }
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: "(begin)" });
  const thinking = options.thinking ?? "off";
  return {
    model: options.model ?? "claude-haiku-5-5",
    max_tokens: request.maxTokens,
    ...(system.length ? { system } : {}),
    messages,
    // Haiku 5.5 rejects non-default sampling parameters, so temperature is never sent.
    thinking: thinking === "off" ? { type: "disabled" } : { type: "adaptive" },
    ...(thinking === "adaptive" && request.reasoning ? { output_config: { effort: request.reasoning } } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

/** Strips a code fence a model wraps JSON in despite being asked not to. */
function unfence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1]! : text;
}

interface StreamState {
  text: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  stopReason: string | null;
  firstTokenAt: number | null;
}

/** Applies one server-sent event of a Messages stream. */
export function applyStreamEvent(state: StreamState, event: Record<string, unknown>, now: number): void {
  const type = event.type;
  if (type === "message_start") {
    const usage = ((event.message as Record<string, unknown>)?.usage ?? {}) as Record<string, number>;
    state.input = usage.input_tokens ?? 0;
    state.cacheRead = usage.cache_read_input_tokens ?? 0;
    state.cacheWrite = usage.cache_creation_input_tokens ?? 0;
    state.output = usage.output_tokens ?? 0;
  } else if (type === "content_block_delta") {
    const delta = event.delta as { type?: string; text?: string };
    if (delta?.type === "text_delta" && delta.text) {
      state.firstTokenAt ??= now;
      state.text += delta.text;
    }
  } else if (type === "message_delta") {
    const delta = event.delta as { stop_reason?: string };
    const usage = (event.usage ?? {}) as Record<string, number>;
    if (delta?.stop_reason) state.stopReason = delta.stop_reason;
    if (usage.output_tokens != null) state.output = usage.output_tokens;
    // Later usage, when reported, replaces message_start's.
    if (usage.input_tokens != null) state.input = usage.input_tokens;
    if (usage.cache_read_input_tokens != null) state.cacheRead = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens != null) state.cacheWrite = usage.cache_creation_input_tokens;
  } else if (type === "error") {
    const err = event.error as { type?: string; message?: string };
    throw new Error(`anthropic stream error ${err?.type ?? ""}: ${(err?.message ?? "").slice(0, 300)}`);
  }
}

export class AnthropicModel implements Model {
  readonly id: string;

  constructor(private readonly options: AnthropicOptions) {
    this.id = options.model ?? "claude-haiku-5-5";
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const t0 = performance.now();
    const body = anthropicBody(this.options, request, true);
    const promptChars = request.messages.reduce((n, m) => n + m.content.length, 0);
    this.options.meter?.reserve(anthropicWorstCase(this.id, promptChars, request.maxTokens));
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const state: StreamState = {
      text: "",
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      stopReason: null,
      firstTokenAt: null,
    };
    const url = `${this.options.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(url, {
        method: "POST",
        headers: {
          "x-api-key": this.options.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      // Nothing was billed, but the reservation is released by booking the call at $0.
      this.book(state, t0, 0);
      throw e;
    }
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      this.book(state, t0, res.status);
      throw new Error(`anthropic ${res.status}: ${detail}`);
    }
    try {
      await readSse(res.body, (event) => applyStreamEvent(state, event, performance.now()));
    } finally {
      // Whatever arrived is booked, a stream cut short included: the tokens were billed.
      this.book(state, t0);
    }
    const usage = usageOf(state);
    return {
      text: request.json ? unfence(state.text) : state.text,
      usage,
      costUsd: anthropicCost(usage, anthropicPrice(this.id), this.options.cacheTtl),
      model: this.id,
      provider: "anthropic",
      latencyMs: Math.round(performance.now() - t0),
      ttftMs: state.firstTokenAt === null ? undefined : Math.round(state.firstTokenAt - t0),
      truncated: state.stopReason === "max_tokens",
    };
  }

  private book(state: StreamState, t0: number, status?: number): void {
    const usage = usageOf(state);
    this.options.meter?.book({
      model: this.id,
      usage,
      costUsd: anthropicCost(usage, anthropicPrice(this.id), this.options.cacheTtl),
      latencyMs: Math.round(performance.now() - t0),
      ttftMs: state.firstTokenAt === null ? null : Math.round(state.firstTokenAt - t0),
      stopReason: state.stopReason,
      ...(status !== undefined ? { status } : {}),
    });
  }
}

/** `inputTokens` is the whole prompt (uncached + written + read), as `Usage` means it elsewhere. */
function usageOf(s: StreamState): AnthropicUsage {
  return {
    inputTokens: s.input + s.cacheRead + s.cacheWrite,
    cachedInputTokens: s.cacheRead,
    cacheWriteTokens: s.cacheWrite,
    outputTokens: s.output,
  };
}

/** Reads a server-sent-event stream and hands each event's JSON data to `onEvent`. */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (e: Record<string, unknown>) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      onEvent(JSON.parse(data) as Record<string, unknown>);
    }
  };
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      flush(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
}
