/**
 * Times the shipped reader's call (`ModelReaderMaker`, D95/D96) on real reader pools, two arms interleaved: reasoning
 * "off" (the default since D144) and "low" (the default before it). LAB ONLY, paid: the calls go to Anthropic through
 * `labModel` (D97), metered by the spend ledger.
 *
 * - off: `new ModelReaderMaker(model)`, the shipped request (no reasoning field), on `AnthropicModel`, thinking off.
 * - low: `new ModelReaderMaker(atLowEffort(model))`: the maker has no reasoning option (D155), so the arm wraps its
 *   model to add `reasoning: "low"` to the maker's request, as eval-live.ts's adaptive arm does. The model is
 *   `AnthropicModel` with adaptive thinking, so the request's effort reaches it (`output_config.effort`); thinking
 *   that is not adaptive returns HTTP 400 on Haiku 5.5 (the `lat-audit-reasoning` enabled-1024 ledger rows).
 *
 * The pools are the engine's own, made at $0: a funnel run with the stub reader logs each prompt the reader would
 * read (`--reader-log`), at the default's `askReaderPool` and `askReaderItemChars` unless the run overrode them. Each
 * logged prompt is parsed back into a `ReaderInput` and kept only if `readerMessages` rebuilds it byte for byte, so a
 * timed call sends exactly what the engine would have sent. Each pool is read once per arm, the arms alternating
 * which goes first. Both arms keep the lab's prompt cache on the system block (anthropic.ts): figures here are
 * "Anthropic-direct, cached", not the OpenRouter path the servers ship (D145).
 *
 * Usage (from the repo root):
 *   bun run funnel --jobs 4 -- --reader-log .local/s1/pools.jsonl          # $0: the train pools (default config)
 *   bun packages/sim/src/lab/reader-time.ts --pools .local/s1/pools.jsonl --calls 60 \
 *     --spend-ledger .local/mkt/ledger.jsonl --spend-cap 17 --spend-headroom 0.3 --run-label s1-reader-time \
 *     [--model claude-haiku-5-5] [--seed 1] [--json out.json] [--dry-run]
 *
 * `--dry-run` parses and samples the pools and prints their sizes, with no call. Percentiles are nearest-rank.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG, ModelReaderMaker, readerMessages, type ReaderInput, type ReaderItem } from "@eden/engine";
import type { ChatRequest, ChatResponse, Model } from "@eden/llm";
import { labAccess, labModel, keyFor } from "./free";
import { draw } from "./reader-stub";

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

/** One reader call as timed: the model's own latency and first-token time, the usage, whether it thought. */
export interface TimedCall {
  arm: Arm;
  pool: number;
  latencyMs: number;
  ttftMs: number | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  thought: boolean;
  /** The reply parsed (a cut-off or malformed reply reads as null, as the engine would). */
  parsed: boolean;
  /** The items the verdict flagged as bearing, by index. */
  flagged: number[];
  error?: string;
}

export type Arm = "off" | "low";

const ITEM = /^<item i="(\d+)" source="([^"]*)" date="([^"]*)"(?: from="([\s\S]*?)")?>([\s\S]*)<\/item>$/;
const CARD = " | card: ";

/**
 * A logged reader prompt (`readerMessages(input)[1].content`, no standing items) back to the input that makes it, or
 * null when it does not rebuild exactly. The text is already inert (`<` escaped), and `inert` leaves inert text as it
 * is, so the rebuilt prompt is byte-identical; where a title holds ": " the split is arbitrary but rebuilds the same.
 */
export function parsePrompt(prompt: string): ReaderInput | null {
  const m =
    /^<today>([^<]*)<\/today>\n<request>([^<]*)<\/request>(?:\n<question>([^<]*)<\/question>)?\n<items>\n([\s\S]*)\n<\/items>$/.exec(
      prompt,
    );
  if (!m) return null;
  const [, today, request, question, body] = m;
  const items: ReaderItem[] = [];
  for (const line of body!.split(/(?<=<\/item>)\n(?=<item )/)) {
    const it = ITEM.exec(line);
    if (!it || Number(it[1]) !== items.length) return null;
    let rest = it[5]!;
    const c = rest.lastIndexOf(CARD);
    const card = c >= 0 ? rest.slice(c + CARD.length) : undefined;
    if (c >= 0) rest = rest.slice(0, c);
    const t = rest.indexOf(": ");
    if (t < 0) return null;
    items.push({
      id: `pool-item-${items.length}`,
      source: it[2]!,
      date: it[3]!,
      from: it[4] ?? "",
      title: rest.slice(0, t),
      text: rest.slice(t + 2),
      ...(card !== undefined ? { card } : {}),
      hash: String(items.length),
    });
  }
  const input: ReaderInput = { request: request!, items, today: today!, ...(question ? { question } : {}) };
  return readerMessages(input)[1]?.content === prompt ? input : null;
}

/** Distinct parsable pools from a `--reader-log` file, in a fixed order drawn from `seed`. */
export function loadPools(file: string, seed: string): ReaderInput[] {
  const seen = new Set<string>();
  const pools: { key: number; input: ReaderInput }[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    const prompt = (JSON.parse(raw) as { prompt?: string }).prompt;
    if (typeof prompt !== "string" || seen.has(prompt)) continue;
    seen.add(prompt);
    const input = parsePrompt(prompt);
    if (input && input.items.length > 0) pools.push({ key: draw(`${seed}\t${prompt}`), input });
  }
  return pools.sort((a, b) => a.key - b.key).map((p) => p.input);
}

/** Nearest-rank percentile of `xs` (p in (0, 1]). */
export function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** The per-arm summary the report prints and COST-MODEL.md records. */
export function summarize(calls: TimedCall[], waitMs: number) {
  const ok = calls.filter((c) => !c.error);
  const lat = ok.map((c) => c.latencyMs);
  const ttft = ok.flatMap((c) => (c.ttftMs === null ? [] : [c.ttftMs]));
  return {
    calls: calls.length,
    failed: calls.length - ok.length,
    p50Ms: pct(lat, 0.5),
    p90Ms: pct(lat, 0.9),
    ttftP50Ms: pct(ttft, 0.5),
    overWait: ok.filter((c) => c.latencyMs > waitMs).length,
    thought: ok.filter((c) => c.thought).length,
    meanInputTokens: Math.round(mean(ok.map((c) => c.inputTokens))),
    meanCachedTokens: Math.round(mean(ok.map((c) => c.cachedInputTokens))),
    meanOutputTokens: Math.round(mean(ok.map((c) => c.outputTokens))),
    meanCostUsd: mean(ok.map((c) => c.costUsd)),
    totalCostUsd: ok.reduce((a, c) => a + c.costUsd, 0),
    parsed: ok.filter((c) => c.parsed).length,
    flaggedItems: ok.reduce((a, c) => a + c.flagged.length, 0),
  };
}

/**
 * A fetch that reports whether a streamed Messages reply held a thinking block: the body is teed, one branch goes to
 * the client unchanged and the other is scanned. Calls run one at a time, so one flag per call is enough.
 */
function thinkingProbe(inner: typeof fetch): { fetch: typeof fetch; take(): Promise<boolean> } {
  let pending: Promise<boolean> = Promise.resolve(false);
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await inner(input, init);
    if (!res.body) {
      pending = Promise.resolve(false);
      return res;
    }
    const [mine, theirs] = res.body.tee();
    pending = new Response(mine)
      .text()
      .then((t) => /"type":\s*"(?:redacted_)?thinking"/.test(t))
      .catch(() => false);
    return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
  return { fetch: wrapped, take: () => pending };
}

/**
 * The low arm's model: every request at effort "low". The reader maker sends no reasoning (D144, D155), so the effort
 * D144 timed is added here, under the maker; the prompt is unchanged. The off arm is never wrapped.
 */
export function atLowEffort(model: Model): Model {
  return { id: model.id, chat: (request) => model.chat({ ...request, reasoning: "low" }) };
}

/** Keeps the last response a model returned, so the timing is the model's own (latency, TTFT). */
function recording(model: Model): Model & { last: ChatResponse | null } {
  const rec = {
    id: model.id,
    last: null as ChatResponse | null,
    async chat(request: ChatRequest) {
      rec.last = null;
      const res = await model.chat(request);
      rec.last = res;
      return res;
    },
  };
  return rec;
}

async function main() {
  const poolsFile = opt("pools");
  if (!poolsFile) throw new Error("--pools FILE (a funnel --reader-log of the stub reader) is required");
  const n = Number(opt("calls", "60"));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--calls must be a whole number > 0`);
  const model = opt("model", "claude-haiku-5-5")!;
  if (!model.startsWith("claude-")) throw new Error("reader-time.ts times Anthropic models only (claude-*)");
  const pools = loadPools(poolsFile, opt("seed", "1")!).slice(0, n);
  if (pools.length < n) throw new Error(`only ${pools.length} distinct parsable pools in ${poolsFile}, need ${n}`);
  const waitMs = DEFAULT_CONFIG.askReaderWaitMs;
  const sizes = pools.map((p) => p.items.length);
  const chars = pools.map((p) => readerMessages(p).reduce((a, m) => a + m.content.length, 0));
  console.log(
    `pools: ${pools.length} from ${poolsFile}, items mean ${mean(sizes).toFixed(1)} (max ${Math.max(...sizes)}, ` +
      `askReaderPool ${DEFAULT_CONFIG.askReaderPool}), prompt chars mean ${Math.round(mean(chars))}; ` +
      `askReaderWaitMs ${waitMs}`,
  );
  if (args.includes("--dry-run")) return;

  const access = labAccess(args, [model]);
  const probe = thinkingProbe(access.fetch);
  const routed = { ...access, fetch: probe.fetch };
  const base = { apiKey: keyFor(model), model, timeoutMs: 60_000 };
  const offModel = recording(labModel(routed, base, "eden.reader.time.off"));
  const lowModel = recording(labModel(routed, base, "eden.reader.time.low", { thinking: "adaptive" }));
  const makers: Record<Arm, { maker: ModelReaderMaker; model: ReturnType<typeof recording> }> = {
    off: { maker: new ModelReaderMaker(offModel), model: offModel },
    low: { maker: new ModelReaderMaker(atLowEffort(lowModel)), model: lowModel },
  };

  const calls: TimedCall[] = [];
  for (const [i, input] of pools.entries()) {
    const order: Arm[] = i % 2 === 0 ? ["off", "low"] : ["low", "off"];
    for (const arm of order) {
      const { maker, model: m } = makers[arm];
      try {
        const got = await maker.read(input, AbortSignal.timeout(60_000));
        const res = m.last!;
        calls.push({
          arm,
          pool: i,
          latencyMs: res.latencyMs,
          ttftMs: res.ttftMs ?? null,
          inputTokens: res.usage.inputTokens,
          cachedInputTokens: res.usage.cachedInputTokens,
          outputTokens: res.usage.outputTokens,
          costUsd: res.costUsd,
          thought: await probe.take(),
          parsed: got.bears !== null,
          flagged: (got.bears ?? []).map((b) => b.i).sort((a, b) => a - b),
        });
      } catch (e) {
        const error = e instanceof Error ? e.message.slice(0, 200) : String(e);
        calls.push({
          arm,
          pool: i,
          latencyMs: 0,
          ttftMs: null,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          thought: false,
          parsed: false,
          flagged: [],
          error,
        });
        console.error(`pool ${i} ${arm}: ${error}`);
        if (/spend cap/i.test(error)) break;
      }
    }
    if ((i + 1) % 10 === 0) console.error(`${i + 1}/${pools.length} pools`);
  }

  const off = summarize(
    calls.filter((c) => c.arm === "off"),
    waitMs,
  );
  const low = summarize(
    calls.filter((c) => c.arm === "low"),
    waitMs,
  );
  // Do the arms flag the same items on a pool? A screen of agreement, not quality: the pools have no labels here.
  let same = 0;
  let both = 0;
  for (let i = 0; i < pools.length; i++) {
    const a = calls.find((c) => c.arm === "off" && c.pool === i && c.parsed);
    const b = calls.find((c) => c.arm === "low" && c.pool === i && c.parsed);
    if (!a || !b) continue;
    both++;
    if (a.flagged.join() === b.flagged.join()) same++;
  }
  const report = { model, pools: pools.length, waitMs, off, low, agreement: { both, same } };
  const usd = (x: number) => `$${x.toFixed(6)}`;
  for (const [arm, s] of [
    ["off", off],
    ["low", low],
  ] as const) {
    console.log(
      `${arm.padEnd(4)} ${s.calls} calls (${s.failed} failed): p50 ${s.p50Ms} ms, p90 ${s.p90Ms} ms, TTFT p50 ` +
        `${s.ttftP50Ms} ms, over ${waitMs} ms ${s.overWait}/${s.calls - s.failed}, thought ` +
        `${s.thought}/${s.calls - s.failed}, in ${s.meanInputTokens} (cached ${s.meanCachedTokens}) out ` +
        `${s.meanOutputTokens}, ${usd(s.meanCostUsd)}/call, ${usd(s.totalCostUsd)} total, parsed ${s.parsed}, ` +
        `flagged ${s.flaggedItems}`,
    );
  }
  console.log(
    `ratios low/off: p50 ${(low.p50Ms / off.p50Ms).toFixed(2)}x, p90 ${(low.p90Ms / off.p90Ms).toFixed(2)}x, ` +
      `$/call ${(low.meanCostUsd / off.meanCostUsd).toFixed(2)}x; same flagged items on ${same}/${both} pools`,
  );
  const out = opt("json");
  if (out) writeFileSync(out, `${JSON.stringify({ ...report, calls }, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
