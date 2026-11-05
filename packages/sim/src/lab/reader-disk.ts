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
 *
 * Per-call timings for `reader-latency-fit.ts`: a line keeps the call's usage (input, cached input and output tokens),
 * its total `latencyMs` and, when the provider streamed it, `ttftMs` (time to the first answer token). Counts and
 * timings only; the reply text is the sim's own.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { ChatRequest, ChatResponse, Model } from "@eden/llm";
import { readerMessages } from "@eden/engine";

interface Line {
  k: string;
  text: string;
  usage: ChatResponse["usage"];
  costUsd: number;
  latencyMs: number;
  /** Time to the first answer token (ms), when the call was streamed (`ChatResponse.ttftMs`). */
  ttftMs?: number;
  model: string;
  provider?: string;
  truncated?: boolean;
}

/** One call as made, counts and timings only (`ReplayModel.calls`). */
export interface ReplayCall {
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  latencyMs: number;
  ttftMs: number | null;
  live: boolean;
  truncated: boolean;
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
        reasoning: keyedReasoning(model, request),
        ...(salt ? { salt } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 40);
}

/** The reader's fixed instructions, as `ModelReaderMaker` sends them (its system message does not depend on input). */
const READER_SYSTEM = readerMessages({ request: "", items: [], today: "" })[0]!.content;

/**
 * The reasoning a key carries. A reader request (`READER_SYSTEM`) to a `claude-*` model with none keys as "low": until
 * D144 `ModelReaderMaker` sent "low" by default, and the lab's `AnthropicModel` ignores the field with thinking off
 * (anthropic.ts, `anthropicBody`), which every recorded `claude-*` reader line ran with. So a pre-D144 line and
 * today's request without reasoning are the same call, and the recorded caches keep replaying (train1-6 seeds 41-42
 * on `.local/mkt/reader-train-4142.jsonl`: 1,250 misses without this, 5 with it, as before D144). Other models and
 * roles key what they send: on OpenRouter "low" really reasons, so a line made with it does not answer "off".
 */
function keyedReasoning(model: string, request: ChatRequest): string | null {
  if (request.reasoning) return request.reasoning;
  return model.startsWith("claude-") && request.messages[0]?.content === READER_SYSTEM ? "low" : null;
}

/** What a `ReplayModel` keys on beyond the request, and how it replays. */
export interface ReplayOptions {
  /** Added to every key: what changes the reply but is not in the request (role, harness, provider routing). */
  salt?: Record<string, unknown>;
  /** Sleep each replayed call's recorded latency, so a replayed run's timings stand for a live one's. */
  timing?: boolean;
  /** `--reader-subset`: a prompt with no cached line is answered from a recorded superset pool, when one holds it. */
  subset?: SubsetReplay;
}

/** A hash of a reader request's instructions (the system message): a reply made under other instructions differs. */
export function systemHash(request: Pick<ChatRequest, "messages">): string {
  const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
  return createHash("sha256").update(sys).digest("hex").slice(0, 16);
}

/** A reader prompt's user turn split into what it asks (the day, request and question) and its item lines. */
function splitPrompt(prompt: string): { head: string; items: string[] } | null {
  const at = prompt.indexOf("<items>\n");
  if (at < 0 || prompt.includes("<standing>")) return null;
  const items = prompt
    .slice(at + 8)
    .replace(/\n?<\/items>$/, "")
    .split("\n")
    .filter((x) => x.length > 0)
    // The index is the item's place in this pool, not part of what the model read about it.
    .map((x) => x.replace(/^<item i="\d+"/, "<item"));
  return { head: prompt.slice(0, at), items };
}

/**
 * `--reader-subset LOG[,LOG]` (lab only, devloop-reader-replay-item-level-key, D117): an approximate, labelled reader
 * replay for $0 screens of changes that only take items out of the reader's pool (a smaller pool, a gate, a cut). A
 * prompt the cache misses is answered from a call recorded in a `--reader-log` file by the same model under the same
 * instructions, with the same day, request and question, whose pool held every item of this one, rendered exactly the
 * same, in the same order: its verdict on those items, renumbered. It assumes a verdict on an item does not depend on
 * the items left out, which the reader does not promise: measured on train (D117), restricting a 15-to-30-item
 * reading to its first 15 items matched the real 15-item reading exactly on 493 of 600 calls, against 97 of 110 for
 * the same prompt sent twice. Never for a change that adds items or renders them differently (no recorded call holds
 * the new pool), and every run that uses it says how many calls it answered.
 */
export class SubsetReplay {
  private readonly byHead = new Map<string, { items: string[]; reply: string }[]>();
  /** Prompts answered from a recorded superset pool. */
  answered = 0;

  constructor(files: readonly string[], model: string, sys: string) {
    for (const file of files) {
      for (const raw of readFileSync(file, "utf8").split("\n")) {
        if (!raw.trim()) continue;
        const l = JSON.parse(raw) as { prompt?: unknown; reply?: unknown; model?: unknown; sys?: unknown };
        if (l.model !== model || l.sys !== sys || typeof l.prompt !== "string" || typeof l.reply !== "string") continue;
        const p = splitPrompt(l.prompt);
        if (!p) continue;
        const list = this.byHead.get(p.head) ?? [];
        list.push({ items: p.items, reply: l.reply });
        this.byHead.set(p.head, list);
      }
    }
  }

  /** The reply for this prompt from the smallest recorded pool that holds its items in order, or null when none. */
  answer(prompt: string): string | null {
    const p = splitPrompt(prompt);
    if (!p || p.items.length === 0) return null;
    let best: { map: number[]; reply: string; size: number } | null = null;
    for (const c of this.byHead.get(p.head) ?? []) {
      // The recorded index of each of this prompt's items, increasing: an ordered subsequence of the recorded pool.
      const map: number[] = [];
      let j = 0;
      for (const it of p.items) {
        while (j < c.items.length && c.items[j] !== it) j++;
        if (j >= c.items.length) break;
        map.push(j++);
      }
      if (map.length < p.items.length) continue;
      if (!best || c.items.length < best.size) best = { map, reply: c.reply, size: c.items.length };
    }
    if (!best) return null;
    let parsed: { bears?: { i?: unknown }[] };
    try {
      parsed = JSON.parse(best.reply) as { bears?: { i?: unknown }[] };
    } catch {
      return null;
    }
    if (!Array.isArray(parsed.bears)) return null;
    const at = new Map(best.map.map((recorded, i) => [recorded, i]));
    const bears = parsed.bears.flatMap((b) => {
      const i = typeof b.i === "number" ? at.get(b.i) : undefined;
      return i === undefined ? [] : [{ ...b, i }];
    });
    this.answered++;
    return JSON.stringify({ ...parsed, bears });
  }
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
  /** `--reader-subset`: prompts the cache missed that a recorded superset pool answered (approximate). */
  subsetReplayed = 0;
  readonly latencies: number[] = [];
  readonly calls: ReplayCall[] = [];

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
    const prompt = request.messages.at(-1)?.content;
    const approx = !this.inner && typeof prompt === "string" ? (this.options.subset?.answer(prompt) ?? null) : null;
    if (approx !== null) {
      this.subsetReplayed++;
      const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      return { text: approx, usage, costUsd: 0, latencyMs: 0, model: this.id };
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
      ...(res.ttftMs !== undefined ? { ttftMs: res.ttftMs } : {}),
      model: res.model,
      ...(res.provider ? { provider: res.provider } : {}),
      ...(res.truncated ? { truncated: true } : {}),
    }));
    // Only a concurrent waiter awaits `pending`: with none, a failed live call would leave it rejected and unhandled
    // (an `unhandledRejection` that exits the run 1). The failure itself reaches the caller through `made`.
    pending.catch(() => {});
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
      cachedInputTokens: l.usage.cachedInputTokens ?? 0,
      outputTokens: l.usage.outputTokens,
      latencyMs: l.latencyMs,
      ttftMs: l.ttftMs ?? null,
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
}
export function overBudget(b: Budgeted): { reader: number; cards: number } {
  const sum = (xs: { stats: { overBudget: number } }[]) => xs.reduce((n, x) => n + x.stats.overBudget, 0);
  return { reader: sum(b.reader), cards: sum(b.cards) };
}
/**
 * The summary line. A read refused at the Budget answers as without the reader and reports outcome "budget" (not a
 * model failure's "none"); this count is the run-level summary of how often the session cap (20 calls by default)
 * cut reading.
 */
export function overBudgetLine(b: Budgeted): string {
  const o = overBudget(b);
  const parts = (["reader", "cards"] as const)
    .filter((k) => b[k].length > 0)
    .map((k) => `${k} ${o[k]} (${b[k].length} lanes)`);
  const refused = o.reader + o.cards > 0;
  return (
    `overBudget: ${parts.length ? parts.join(", ") : "no budgeted reader or cards"}` +
    (refused ? "; REFUSED at the Budget: those calls were skipped and their asks ran without them" : "")
  );
}
