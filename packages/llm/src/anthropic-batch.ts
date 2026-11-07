/**
 * Anthropic's Message Batches API behind the `Model` interface (LAB ONLY, D97; the card maker's bulk transport, D242).
 * Calls made within `windowMs` of each other go out as one batch (`POST /v1/messages/batches`); the batch is polled
 * until it has ended, then its results (JSON lines, any order, keyed by `custom_id`) settle each caller's promise.
 *
 * - Price: every token at half the Messages API rate (the Batches API's 50% discount, which stacks with the prompt
 *   cache's multipliers). Cache hits inside a batch are best effort: requests in one batch may run concurrently, so
 *   the shared system prefix is not always read back.
 * - Latency: most batches end within an hour, at most 24 hours. Nothing a user waits on may go through this model: it
 *   is for background work whose no-model path serves meanwhile (D242).
 * - A caller's abort before submission drops its request; after submission it only rejects the caller's promise. The
 *   request still runs and is still booked on the meter when the batch ends (the tokens are billed).
 * - The request body is `anthropicBody`'s (no streaming), so the same system blocks, cache breakpoint and thinking
 *   setting as `AnthropicModel`.
 */
import { anthropicBody, anthropicCost, anthropicPrice, anthropicWorstCase, type AnthropicOptions } from "./anthropic";
import type { AnthropicUsage } from "./anthropic";
import type { ChatRequest, ChatResponse, Model } from "./types";

/** The Batches API's discount on every token (input, cache writes and reads, output). */
export const BATCH_DISCOUNT = 0.5;

export interface AnthropicBatchOptions extends AnthropicOptions {
  /** How long calls are gathered before a batch is sent (ms). */
  windowMs?: number;
  /** A batch is sent at once when this many calls wait (the API allows 100,000). */
  maxRequests?: number;
  /** How often an open batch is polled (ms). */
  pollMs?: number;
  /** A batch not ended after this long rejects its callers (ms; the API expires requests after 24 hours). */
  maxWaitMs?: number;
  /** Injected for tests: waits `ms`. */
  sleep?: (ms: number) => Promise<void>;
}

interface Waiting {
  id: string;
  request: ChatRequest;
  body: Record<string, unknown>;
  resolve: (r: ChatResponse) => void;
  reject: (e: unknown) => void;
  /** Worst case reserved on the meter, released when booked. */
  t0: number;
  settled: boolean;
}

/** What one batch did, for the lab's reports. */
export interface BatchRecord {
  id: string;
  requests: number;
  /** Submission to end, ms. */
  ms: number;
  succeeded: number;
  failed: number;
}

export class AnthropicBatchModel implements Model {
  readonly id: string;
  private waiting: Waiting[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  /** Batches sent and ended (most recent last). */
  readonly batches: BatchRecord[] = [];
  /** Batches in flight. */
  private open = new Set<Promise<void>>();

  constructor(private readonly options: AnthropicBatchOptions) {
    this.id = options.model ?? "claude-haiku-5-5";
  }

  chat(request: ChatRequest): Promise<ChatResponse> {
    const body = anthropicBody(this.options, request, false) as Record<string, unknown>;
    const promptChars = request.messages.reduce((n, m) => n + m.content.length, 0);
    // Refusal by the meter (the lab's cap) is a refusal of this call, before anything is queued.
    this.options.meter?.reserve(anthropicWorstCase(this.id, promptChars, request.maxTokens) * BATCH_DISCOUNT);
    return new Promise<ChatResponse>((resolve, reject) => {
      const w: Waiting = {
        id: `r${++this.seq}`,
        request,
        body,
        resolve,
        reject,
        t0: performance.now(),
        settled: false,
      };
      if (request.signal?.aborted) {
        this.release(w);
        reject(request.signal.reason ?? new Error("aborted"));
        return;
      }
      request.signal?.addEventListener(
        "abort",
        () => {
          const i = this.waiting.indexOf(w);
          // Not sent yet: dropped, nothing billed.
          if (i >= 0) {
            this.waiting.splice(i, 1);
            this.release(w);
          }
          if (!w.settled) {
            w.settled = true;
            reject(request.signal!.reason ?? new Error("aborted"));
          }
        },
        { once: true },
      );
      this.waiting.push(w);
      if (this.waiting.length >= (this.options.maxRequests ?? 10_000)) this.flush();
      else this.timer ??= setTimeout(() => this.flush(), this.options.windowMs ?? 2_000);
    });
  }

  /** Sends what waits now, as one batch. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.waiting;
    this.waiting = [];
    if (batch.length === 0) return;
    const p = this.run(batch).finally(() => this.open.delete(p));
    this.open.add(p);
  }

  /** Waits for every batch in flight (the lab, before it reports). */
  async idle(): Promise<void> {
    while (this.open.size > 0 || this.waiting.length > 0) {
      if (this.waiting.length > 0) this.flush();
      await Promise.all([...this.open]);
    }
  }

  private headers() {
    return {
      "x-api-key": this.options.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
  }

  private async run(batch: Waiting[]): Promise<void> {
    const base = this.options.baseUrl ?? "https://api.anthropic.com";
    const f = this.options.fetch ?? fetch;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const t0 = performance.now();
    const fail = (e: unknown) => {
      for (const w of batch) {
        this.release(w);
        if (!w.settled) {
          w.settled = true;
          w.reject(e);
        }
      }
    };
    let id: string;
    try {
      const res = await f(`${base}/v1/messages/batches`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ requests: batch.map((w) => ({ custom_id: w.id, params: w.body })) }),
      });
      if (!res.ok)
        throw new Error(`anthropic batch ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      id = ((await res.json()) as { id: string }).id;
    } catch (e) {
      fail(e);
      return;
    }
    let resultsUrl: string | null = null;
    const deadline = t0 + (this.options.maxWaitMs ?? 24 * 3_600_000);
    try {
      for (;;) {
        const res = await f(`${base}/v1/messages/batches/${id}`, { headers: this.headers() });
        if (res.ok) {
          const b = (await res.json()) as { processing_status?: string; results_url?: string | null };
          if (b.processing_status === "ended") {
            resultsUrl = b.results_url ?? `${base}/v1/messages/batches/${id}/results`;
            break;
          }
        }
        if (performance.now() > deadline) throw new Error(`anthropic batch ${id} not ended in time`);
        await sleep(this.options.pollMs ?? 15_000);
      }
      const res = await f(resultsUrl, { headers: this.headers() });
      if (!res.ok) throw new Error(`anthropic batch results ${res.status}`);
      const text = await res.text();
      const byId = new Map(batch.map((w) => [w.id, w]));
      let succeeded = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as BatchResultLine;
        const w = byId.get(r.custom_id);
        if (!w) continue;
        byId.delete(r.custom_id);
        if (r.result?.type === "succeeded" && r.result.message) {
          succeeded++;
          this.settle(w, r.result.message, performance.now() - t0);
        } else {
          this.release(w);
          if (!w.settled) {
            w.settled = true;
            w.reject(new Error(`anthropic batch request ${r.result?.type ?? "missing"}`));
          }
        }
      }
      // A request with no result line: lost, rejected (nothing to book).
      for (const w of byId.values()) {
        this.release(w);
        if (!w.settled) {
          w.settled = true;
          w.reject(new Error("anthropic batch request missing from results"));
        }
      }
      this.batches.push({
        id,
        requests: batch.length,
        ms: Math.round(performance.now() - t0),
        succeeded,
        failed: batch.length - succeeded,
      });
    } catch (e) {
      fail(e);
    }
  }

  private settle(w: Waiting, message: BatchMessage, ms: number): void {
    const u = message.usage ?? {};
    const usage: AnthropicUsage = {
      inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      cachedInputTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
    };
    const costUsd = batchCost(usage, this.id, this.options.cacheTtl);
    const text = (message.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const stopReason = message.stop_reason ?? null;
    this.options.meter?.book({
      model: this.id,
      usage,
      costUsd,
      latencyMs: Math.round(ms),
      ttftMs: null,
      stopReason,
    });
    if (w.settled) return;
    w.settled = true;
    w.resolve({
      text: w.request.json ? unfence(text) : text,
      usage,
      costUsd,
      model: this.id,
      provider: "anthropic-batch",
      latencyMs: Math.round(ms),
      truncated: stopReason === "max_tokens",
    });
  }

  /** Releases a reservation with nothing billed (booked at $0, as `AnthropicModel` does for a refused call). */
  private release(w: Waiting): void {
    this.options.meter?.book({
      model: this.id,
      usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: Math.round(performance.now() - w.t0),
      ttftMs: null,
      stopReason: null,
      status: 0,
    });
  }
}

/** A batch request's cost: the Messages API's, at the Batches API's discount. */
export function batchCost(usage: AnthropicUsage, model: string, ttl: "5m" | "1h" = "5m"): number {
  return anthropicCost(usage, anthropicPrice(model), ttl) * BATCH_DISCOUNT;
}

interface BatchMessage {
  content?: { type: string; text?: string }[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface BatchResultLine {
  custom_id: string;
  result?: { type: string; message?: BatchMessage };
}

/** Strips a code fence a model wraps JSON in despite being asked not to (as `AnthropicModel` does). */
function unfence(text: string): string {
  const m = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1]! : text;
}
