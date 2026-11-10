/**
 * N2 (D510–D514, docs/research/n2-recall.md): the lab's "does this item change what the agent should do?" checker on
 * Haiku 5.5, behind the engine's `PairChecker` (the `pushCheck` trial). Lab only: nothing in a product package imports
 * this file, and it reaches Anthropic directly (D97), so its figures are lab figures.
 *
 * The prompt is I2's (`CHANGES_SYSTEM`, i2-label.ts): the request and the pool's items fenced as data, items in a
 * fixed shuffle by hash (so the pool's order says nothing), one confidence 0–100 per item; the engine reads it /100.
 *
 * Pay once: every answer is kept in `cache` (JSONL), keyed by the exact request and item set, so a re-run replays it
 * at $0; `replayOnly` answers a miss from the per-pair labels the cache holds (the same request and item in any set)
 * and counts what it could not, scoring those 0 — never a call. `calls`, `misses`, `usd` and `ms` are the run's line.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AnthropicModel } from "@eden/llm";
import type { CheckPair, PairChecker } from "@eden/engine";
import { CHANGES_SYSTEM } from "./i2-label";
import { keyFor } from "./free";
import type { SpendLedger } from "./spend";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const itemKey = (x: { title: string; text: string }) => sha(`${x.title}\n${x.text}`);

export interface CheckRow {
  set: string;
  req: string;
  scores: Record<string, number>;
  usd: number;
  ms: number;
}

export interface LabChecker extends PairChecker {
  calls: number;
  replayed: number;
  /** Pairs a replay-only run had no label for (scored 0). */
  misses: number;
  failures: number;
  usd: number;
  ms: number[];
  sizes: number[];
}

export interface LabCheckerOptions {
  cache: string;
  replayOnly?: boolean;
  model?: string;
  /** "off" (no thinking, as the shipped reader and cards send, D144/D149) or "low" (I2's labels). */
  thinking?: "off" | "low";
  ledger?: SpendLedger;
  timeoutMs?: number;
  /** For tests: a model in place of Anthropic. */
  chat?: (system: string, user: string) => Promise<{ text: string; costUsd: number }>;
}

/** The prompt as I2 built it (`labelPrompt`): request, then the items in a fixed shuffle, all fenced as data. */
export function checkPrompt(request: string, items: readonly { title: string; text: string }[]) {
  const fence = (s: string) => s.replace(/<\/?(request|item)\b[^>]*>/gi, "");
  const order = items
    .map((x, i) => ({ x, i, h: sha(request + itemKey(x)) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.i - b.i));
  const body = order.map((o, k) => `<item n="${k + 1}">\n${fence(o.x.title)}\n${fence(o.x.text)}\n</item>`);
  return {
    prompt: `<request>\n${fence(request)}\n</request>\n\nItems (${items.length}):\n\n${body.join("\n\n")}`,
    order: order.map((o) => o.i),
  };
}

/** One score per item in input order (0–1), from the reply; an item the reply leaves out scores 0. */
export function parseCheck(text: string, order: readonly number[]): number[] {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error("n2 check: no JSON in the reply");
  const parsed = JSON.parse(m[0]) as { labels?: { i: number; y: number }[] };
  const out = order.map(() => 0);
  for (const l of parsed.labels ?? []) {
    const at = order[Number(l.i) - 1];
    const y = Number(l.y);
    if (at === undefined || !Number.isFinite(y)) continue;
    out[at] = Math.max(0, Math.min(100, y)) / 100;
  }
  return out;
}

export function labChecker(o: LabCheckerOptions): LabChecker {
  const model = o.model ?? "claude-haiku-5-5";
  const bySet = new Map<string, Record<string, number>>();
  const byPair = new Map<string, number>();
  if (existsSync(o.cache)) {
    for (const line of readFileSync(o.cache, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as CheckRow;
      bySet.set(r.set, r.scores);
      for (const [k, v] of Object.entries(r.scores)) if (!byPair.has(`${r.req}|${k}`)) byPair.set(`${r.req}|${k}`, v);
    }
  }
  const meter = o.ledger?.meter("n2.check");
  const anth =
    o.chat || o.replayOnly
      ? null
      : new AnthropicModel({
          apiKey: keyFor(model),
          model,
          ...(o.thinking === "low" ? { thinking: "adaptive" as const } : {}),
          ...(meter ? { meter } : {}),
          timeoutMs: o.timeoutMs ?? 60_000,
        });
  const chat =
    o.chat ??
    (async (system: string, user: string) => {
      const r = await anth!.chat({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        maxTokens: 4_000,
        ...(o.thinking === "low" ? { reasoning: "low" as const } : {}),
      });
      return { text: r.text, costUsd: r.costUsd ?? 0 };
    });
  const c: LabChecker = {
    calls: 0,
    replayed: 0,
    misses: 0,
    failures: 0,
    usd: 0,
    ms: [],
    sizes: [],
    async score(_scope, request: string, items: readonly CheckPair[]) {
      const req = sha(request);
      const keys = items.map(itemKey);
      const set = sha(`${req}|${[...keys].sort().join(",")}`);
      const hit = bySet.get(set);
      if (hit) {
        c.replayed++;
        return keys.map((k) => hit[k] ?? 0);
      }
      if (o.replayOnly) {
        c.replayed++;
        return keys.map((k) => {
          const v = byPair.get(`${req}|${k}`);
          if (v === undefined) c.misses++;
          return v ?? 0;
        });
      }
      const t0 = performance.now();
      c.calls++;
      c.sizes.push(items.length);
      try {
        const { prompt, order } = checkPrompt(request, items);
        const r = await chat(CHANGES_SYSTEM, prompt);
        const got = parseCheck(r.text, order);
        const ms = performance.now() - t0;
        c.usd += r.costUsd;
        c.ms.push(ms);
        const scores = Object.fromEntries(keys.map((k, i) => [k, got[i]!]));
        bySet.set(set, scores);
        for (const [k, v] of Object.entries(scores)) if (!byPair.has(`${req}|${k}`)) byPair.set(`${req}|${k}`, v);
        const row: CheckRow = { set, req, scores, usd: r.costUsd, ms: Math.round(ms) };
        appendFileSync(o.cache, `${JSON.stringify(row)}\n`);
        return got;
      } catch (e) {
        c.failures++;
        throw e;
      }
    },
  };
  return c;
}

/** The run's checker line: calls made and replayed, misses, failures, dollars, round trip p50/p90, items a call. */
export function labCheckerLine(c: LabChecker): string {
  const ms = [...c.ms].sort((a, b) => a - b);
  const at = (q: number) => (ms.length ? ms[Math.floor(q * (ms.length - 1))]!.toFixed(0) : "-");
  const items = c.sizes.length ? (c.sizes.reduce((a, b) => a + b, 0) / c.sizes.length).toFixed(1) : "-";
  return (
    `CHECKER (N2, Haiku, lab): ${c.calls} calls, ${c.replayed} replayed, ${c.misses} pairs missed, ` +
    `${c.failures} failed, $${c.usd.toFixed(4)}, p50 ${at(0.5)} ms, p90 ${at(0.9)} ms, ${items} items a call`
  );
}
