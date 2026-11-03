/**
 * A disk replay cache for the ask-time reader's model calls (lab only; D95, `reader.ts`). Each call is kept under a
 * hash of its prompt (the model id, the messages, the output cap and options), so a funnel rerun with the same prompt
 * and pools replays every verdict at no cost, and a changed prompt or pool calls again. The prompts are the simulated
 * worlds' items and requests, so nothing here is user data; the engine never writes a verdict to disk (D8).
 *
 * With no inner model (`--reader replay`), a prompt with no cached line fails, as a model error would: the ask then
 * answers as without the reader, and the run counts it as a miss.
 *
 * The live A/B (`pi-ab.ts --replay DIR`) keeps its reader's and its grader's calls here too, with a `salt` in the key
 * (the role, the harness version, the provider preferences) so a line made under one setup never answers another. A
 * line holds the reply, usage, cost and latency only: never a key or a request header.
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

/**
 * The cache key: the model id and everything in the request that shapes the reply. `salt` adds what the request does
 * not carry; without one the key is the one the funnel's reader caches were written under.
 */
export function promptKey(model: string, request: ChatRequest, salt?: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        json: request.json === true,
        reasoning: request.reasoning ?? null,
        ...(salt ? { salt } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 40);
}

/** What a `ReplayModel` keys on beyond the request, and how it replays. */
export interface ReplayOptions {
  /** Added to every key: what changes the reply but is not in the request (role, harness, provider routing). */
  salt?: Record<string, unknown>;
  /** Sleep each replayed call's recorded latency, so a replayed run's timings stand for a live one's. */
  timing?: boolean;
}

/**
 * A replayed reply's cost as it was made. A replay returns `costUsd: 0` (nothing was spent in this run), but a report's
 * per-task cost columns say what a condition costs, so they read the cost as made: the same in a live run and in its
 * replay.
 */
const madeCost = new WeakMap<ChatResponse, number>();
export const costAsMade = (res: ChatResponse): number => madeCost.get(res) ?? res.costUsd;

export class ReplayModel implements Model {
  readonly id: string;
  private readonly lines = new Map<string, Line>();
  /**
   * A prompt being made live now: the same prompt asked again meanwhile waits for it and replays its line, so a prompt
   * gets one reply in a run (as it will in the run that replays it) and is paid for once.
   */
  private readonly inFlight = new Map<string, Promise<Line>>();
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
    private readonly options: ReplayOptions = {},
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
    const k = promptKey(this.id, request, this.options.salt);
    const held = this.lines.get(k);
    if (held) return this.replay(held, request.signal);
    // Checked without an await first: the call that makes a prompt live registers it before it yields.
    const flying = this.inFlight.get(k);
    if (flying) {
      const shared = await flying.catch(() => undefined);
      if (shared) return this.replay(shared, request.signal);
    }
    if (!this.inner) {
      this.missed++;
      throw new Error("reader replay: no cached call for this prompt");
    }
    const made = this.inner.chat(request);
    const pending = made.then((res): Line => ({
      k,
      text: res.text,
      usage: res.usage,
      costUsd: res.costUsd,
      latencyMs: res.latencyMs,
      model: res.model,
      ...(res.provider ? { provider: res.provider } : {}),
      ...(res.truncated ? { truncated: true } : {}),
    }));
    this.inFlight.set(k, pending);
    let res: ChatResponse;
    try {
      res = await made;
    } catch (e) {
      this.failed++;
      throw e;
    } finally {
      this.inFlight.delete(k);
    }
    this.sent++;
    const line = await pending;
    this.lines.set(k, line);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    this.record(line, true);
    return res;
  }

  private async replay(held: Line, signal?: AbortSignal): Promise<ChatResponse> {
    this.replayed++;
    this.record(held, false);
    if (this.options.timing && held.latencyMs > 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, held.latencyMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    const { k: _key, ...reply } = held;
    const res: ChatResponse = { ...reply, costUsd: 0 };
    madeCost.set(res, held.costUsd);
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

/**
 * The miss gate (`--reader replay`): a prompt with no cached line fails open, so the ask answers as without the reader
 * and a NEW screen silently becomes part NEW, part ALL3. A run with misses is therefore not that configuration's
 * result: it exits non-zero unless `--allow-misses` says the caller knows (docs/LAB.md).
 */
export const MISS_EXIT = 3;
export function missGate(missed: number, allow: boolean): { code: number; message: string | null } {
  if (missed <= 0) return { code: 0, message: null };
  const message =
    `READER MISSES: ${missed} reader prompts had no cached line and were answered without the reader ` +
    `(fail open), so this run is part reader, part not`;
  return allow
    ? { code: 0, message: `${message} (--allow-misses)` }
    : { code: MISS_EXIT, message: `${message}; not a result of this configuration. Pass --allow-misses to accept` };
}

/** Calls each budgeted engine component refused at its `Budget` (`stats.overBudget`), summed over a run's lanes. */
export interface Budgeted {
  reader: { stats: { overBudget: number } }[];
  cards: { stats: { overBudget: number } }[];
  bridge: { stats: { overBudget: number } }[];
}
export function overBudget(b: Budgeted): { reader: number; cards: number; bridge: number } {
  const sum = (xs: { stats: { overBudget: number } }[]) => xs.reduce((n, x) => n + x.stats.overBudget, 0);
  return { reader: sum(b.reader), cards: sum(b.cards), bridge: sum(b.bridge) };
}
/**
 * The summary line. A read refused at the Budget answers as without the reader and reports outcome "budget" (not a
 * model failure's "none"); this count is the run-level summary of how often the session cap (20 calls by default)
 * cut reading.
 */
export function overBudgetLine(b: Budgeted): string {
  const o = overBudget(b);
  const parts = (["reader", "cards", "bridge"] as const)
    .filter((k) => b[k].length > 0)
    .map((k) => `${k} ${o[k]} (${b[k].length} lanes)`);
  const refused = o.reader + o.cards + o.bridge > 0;
  return (
    `overBudget: ${parts.length ? parts.join(", ") : "no budgeted reader, cards or bridge"}` +
    (refused ? "; REFUSED at the Budget: those calls were skipped and their asks ran without them" : "")
  );
}
