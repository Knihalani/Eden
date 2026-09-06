import { redact } from "@eden/ir";
import type { StretchTrace } from "@eden/ir";
import type { RunRecorder } from "./types";

const MAX_SSE_BUF = 256 * 1024;
const SSE_TAIL = 8 * 1024;

export type ChatUsage = {
  llmCalls: number;
  prompt_tokens: number;
  completion_tokens: number;
  measured: boolean;
  output?: unknown;
  cached_tokens?: number;
  cache_write_tokens?: number;
  cache_input_tokens?: number;
};

export function parseUsage(raw: unknown): { prompt: number; completion: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const prompt = coerceInt(u.prompt_tokens ?? u.input_tokens);
  const completion = coerceInt(u.completion_tokens ?? u.output_tokens);
  if (prompt == null && completion == null) return null;
  return { prompt: prompt ?? 0, completion: completion ?? 0 };
}

export type CacheTokenFields = {
  cached: number;
  cacheWrite?: number;
  denom?: number;
};

export function cacheHitDenomFromUsage(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  if ("cache_read_input_tokens" in u || "cache_creation_input_tokens" in u) {
    return (
      (coerceInt(u.cache_read_input_tokens) ?? 0) +
      (coerceInt(u.cache_creation_input_tokens) ?? 0) +
      (coerceInt(u.input_tokens) ?? 0)
    );
  }
  return coerceInt(u.prompt_tokens) ?? null;
}

export function parseCacheTokens(raw: unknown): CacheTokenFields | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const details =
    u.prompt_tokens_details && typeof u.prompt_tokens_details === "object"
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : null;
  const cached =
    coerceInt(u.cache_read_input_tokens) ??
    coerceInt(details?.cached_tokens) ??
    coerceInt(u.cached_tokens);
  const cacheWrite =
    coerceInt(u.cache_creation_input_tokens) ?? coerceInt(details?.cache_creation_tokens);
  if (cached == null && cacheWrite == null) return null;
  const denom = cacheHitDenomFromUsage(u);
  return {
    cached: cached ?? 0,
    ...(cacheWrite != null ? { cacheWrite } : {}),
    ...(denom != null ? { denom } : {}),
  };
}

export function extractOutput(json: Record<string, unknown>): unknown {
  const choices = json.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return undefined;
  const choice = choices[0] as Record<string, unknown>;
  const message = choice.message;
  if (message && typeof message === "object") {
    const text = contentText((message as Record<string, unknown>).content);
    if (text != null) return text;
  }
  const delta = choice.delta;
  if (delta && typeof delta === "object") {
    const text = contentText((delta as Record<string, unknown>).content);
    if (text != null) return text;
  }
  return undefined;
}

export function recordCompletion(run: RunRecorder, json: Record<string, unknown>): void {
  run.llmCalls += 1;
  const usage = parseUsage(json.usage);
  if (usage) {
    run.measured = true;
    run.prompt_tokens += usage.prompt;
    run.completion_tokens += usage.completion;
  }
  const cache = parseCacheTokens(json.usage);
  if (cache) {
    run.cached_tokens += cache.cached;
    if (cache.cacheWrite != null) run.cache_write_tokens += cache.cacheWrite;
    if (cache.denom != null) run.cache_input_tokens += cache.denom;
  }
  const out = extractOutput(json);
  if (out != null) run.output = redact(out);
}

export function resetUsage(run: RunRecorder): void {
  run.llmCalls = 0;
  run.prompt_tokens = 0;
  run.completion_tokens = 0;
  run.cached_tokens = 0;
  run.cache_write_tokens = 0;
  run.cache_input_tokens = 0;
  run.measured = false;
  run.output = undefined;
  run.cost = 0;
  run.island_prompt_tokens = 0;
  run.island_completion_tokens = 0;
  run.island_cached_tokens = 0;
  run.island_cache_write_tokens = 0;
  run.island_cache_input_tokens = 0;
  run.island_memoized = false;
  run.island_measured = false;
}

export function peekChatUsage(state: { run: RunRecorder }): ChatUsage | null {
  const run = state.run;
  if (!run.measured && run.llmCalls === 0 && run.output == null) return null;
  return {
    llmCalls: run.llmCalls,
    prompt_tokens: run.prompt_tokens,
    completion_tokens: run.completion_tokens,
    measured: run.measured,
    output: run.output,
    ...cacheHitSpread(run.cached_tokens, run.cache_write_tokens, run.cache_input_tokens),
  };
}

export function consumeChatUsage(state: { run: RunRecorder }): ChatUsage | null {
  const taken = peekChatUsage(state);
  if (taken) resetUsage(state.run);
  return taken;
}

export function cacheHitSpread(
  cached: number,
  write: number,
  denom: number,
): {
  cached_tokens?: number;
  cache_write_tokens?: number;
  cache_input_tokens?: number;
} {
  return {
    ...(cached > 0 ? { cached_tokens: cached } : {}),
    ...(denom > 0 ? { cache_input_tokens: denom } : {}),
    ...(write > 0 || denom > 0 ? { cache_write_tokens: write } : {}),
  };
}

export function attachChatUsage(trace: StretchTrace, usage: ChatUsage | null): StretchTrace {
  if (!usage) return trace;
  if (trace.prompt_tokens != null) return trace;
  const llmCalls = usage.llmCalls > 0 && !trace.llmCalls ? usage.llmCalls : trace.llmCalls;
  const output = trace.output ?? usage.output;
  if (llmCalls === trace.llmCalls && output === trace.output && !usage.measured) return trace;
  return {
    ...trace,
    llmCalls,
    output,
    ...(usage.measured
      ? {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          ...cacheHitSpread(
            usage.cached_tokens ?? 0,
            usage.cache_write_tokens ?? 0,
            usage.cache_input_tokens ?? 0,
          ),
        }
      : {}),
  };
}

export function usageWasApplied(before: StretchTrace, after: StretchTrace): boolean {
  return before !== after;
}

export function withStreamUsage(body: Record<string, unknown>): Record<string, unknown> {
  const prev = body.stream_options;
  const opts = prev && typeof prev === "object" && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {};
  return { ...body, stream_options: { ...opts, include_usage: true } };
}

export class SseUsageParser {
  private buf = "";
  private usage: Record<string, unknown> | null = null;
  private finished = false;
  private committed = false;
  private readonly dec = new TextDecoder();

  pushBytes(chunk: Uint8Array): void {
    this.pushText(this.dec.decode(chunk, { stream: true }));
  }

  end(): void {
    this.pushText(this.dec.decode());
    if (this.buf) {
      this.eatBlock(this.buf);
      this.buf = "";
    }
  }

  commit(run: RunRecorder): void {
    if (this.committed) return;
    if (!this.finished && !this.usage) return;
    this.committed = true;
    const json: Record<string, unknown> = this.usage ? { usage: this.usage } : {};
    recordCompletion(run, json);
  }

  private pushText(text: string): void {
    if (!text) return;
    this.buf += text;
    if (this.buf.length > MAX_SSE_BUF) this.buf = this.buf.slice(-SSE_TAIL);
    const parts = this.buf.split("\n\n");
    this.buf = parts.pop() ?? "";
    for (const part of parts) this.eatBlock(part);
  }

  private eatBlock(part: string): void {
    const line = part.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    const data = line.replace(/^data:\s?/, "").trim();
    if (!data) return;
    if (data === "[DONE]") {
      this.finished = true;
      return;
    }
    if (!data.includes("usage") && !data.includes("finish_reason")) return;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const raw = json.usage;
    const parsed = parseUsage(raw);
    const cache = parseCacheTokens(raw);
    if (parsed || cache) {
      const next = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      this.usage = { ...(this.usage ?? {}), ...next };
    }
    const choices = json.choices;
    if (Array.isArray(choices) && choices.some((c) => c && typeof c === "object" && (c as { finish_reason?: unknown }).finish_reason)) {
      this.finished = true;
    }
  }
}

export function tapSseUsage(stream: ReadableStream<Uint8Array>, run: RunRecorder): ReadableStream<Uint8Array> {
  const parser = new SseUsageParser();
  const reader = stream.getReader();
  const finish = () => {
    parser.end();
    parser.commit(run);
  };
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          ctl.close();
          return;
        }
        parser.pushBytes(value);
        ctl.enqueue(value);
      } catch (err) {
        finish();
        ctl.error(err);
      }
    },
    async cancel() {
      finish();
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    },
  });
}

export async function scrapeSseUsage(stream: ReadableStream<Uint8Array>, run: RunRecorder): Promise<void> {
  const reader = tapSseUsage(stream, run).getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
    .join("");
  return parts || undefined;
}

function coerceInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return undefined;
}
