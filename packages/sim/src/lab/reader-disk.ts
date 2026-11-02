/**
 * A disk replay cache for the ask-time reader's model calls (lab only; D95, `reader.ts`). Each call is kept under a
 * hash of its prompt (the model id, the messages, the output cap and options), so a funnel rerun with the same prompt
 * and pools replays every verdict at no cost, and a changed prompt or pool calls again. The prompts are the simulated
 * worlds' items and requests, so nothing here is user data; the engine never writes a verdict to disk (D8).
 *
 * With no inner model (`--reader replay`), a prompt with no cached line fails, as a model error would: the ask then
 * answers as without the reader, and the run counts it as a miss.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { ChatRequest, ChatResponse, Model } from "@eden/llm";

interface Line {
  k: string;
  text: string;
  usage: ChatResponse["usage"];
  costUsd: number;
  latencyMs: number;
  model: string;
  provider?: string;
  truncated?: boolean;
}

export function promptKey(model: string, request: ChatRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        json: request.json === true,
        reasoning: request.reasoning ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 40);
}

export class ReplayModel implements Model {
  readonly id: string;
  private readonly lines = new Map<string, Line>();
  /** Calls replayed and sent; live and replayed latencies and costs, as OpenRouter reported them when made. */
  replayed = 0;
  sent = 0;
  missed = 0;
  failed = 0;
  readonly latencies: number[] = [];
  readonly calls: { costUsd: number; inputTokens: number; outputTokens: number; live: boolean; truncated: boolean }[] =
    [];

  constructor(
    private readonly file: string,
    private readonly inner: Model | null,
    id?: string,
  ) {
    this.id = id ?? inner?.id ?? "replay";
    if (file && existsSync(file)) {
      for (const raw of readFileSync(file, "utf8").split("\n")) {
        if (!raw.trim()) continue;
        const l = JSON.parse(raw) as Line;
        this.lines.set(l.k, l);
      }
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const k = promptKey(this.id, request);
    const held = this.lines.get(k);
    if (held) {
      this.replayed++;
      this.record(held, false);
      return { ...held, costUsd: 0 };
    }
    if (!this.inner) {
      this.missed++;
      throw new Error("reader replay: no cached call for this prompt");
    }
    let res: ChatResponse;
    try {
      res = await this.inner.chat(request);
    } catch (e) {
      this.failed++;
      throw e;
    }
    this.sent++;
    const line: Line = {
      k,
      text: res.text,
      usage: res.usage,
      costUsd: res.costUsd,
      latencyMs: res.latencyMs,
      model: res.model,
      ...(res.provider ? { provider: res.provider } : {}),
      ...(res.truncated ? { truncated: true } : {}),
    };
    this.lines.set(k, line);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    this.record(line, true);
    return res;
  }

  private record(l: Line, live: boolean): void {
    this.latencies.push(l.latencyMs);
    this.calls.push({
      costUsd: l.costUsd,
      inputTokens: l.usage.inputTokens,
      outputTokens: l.usage.outputTokens,
      live,
      truncated: l.truncated === true,
    });
  }

  /** p50 and p90 of the calls' latencies as made (ms). */
  quantiles(): { p50: number; p90: number } {
    const xs = [...this.latencies].sort((a, b) => a - b);
    const q = (p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : 0);
    return { p50: q(0.5), p90: q(0.9) };
  }
}
