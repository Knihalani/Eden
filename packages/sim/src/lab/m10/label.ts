#!/usr/bin/env bun
/**
 * M10 (lab only): cards for exported items, made by the shipped card call (`ModelCardMaker`, `cardMessages` with the
 * intent instructions as the default sends them) on Anthropic, through the spend ledger (D97). Items are read in
 * batches of `--batch` (20, the default's economy batch) drawn from one world at a time, shuffled with `--shuffle`
 * (a second labelling with another seed puts each item in other company: Haiku's self-agreement, as M7's
 * self-agree.ts). Only items the strict prefilter passes are sent: the enricher keeps no other card.
 *
 *   bun packages/sim/src/lab/m10/label.ts --items .local/m10/items.jsonl --out .local/m10/labels-a.jsonl \
 *     --spend-ledger .local/m10/ledger.jsonl --spend-cap 3 [--shuffle 1] [--only-carded] [--limit N] [--concurrency 6]
 *
 * Out: `{h, c, r}` lines (the cards-disk format), appended; items already in `--out` are skipped (pay once).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { AnthropicModel } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { ModelCardMaker } from "@eden/engine";
import { keyFor } from "../free";
import { SpendLedger } from "../spend";
import { Rng } from "../../rng";

const argv = process.argv.slice(2);
const opt = (n: string, d = "") => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1]! : d);
const has = (n: string) => argv.includes(`--${n}`);
const cap = Number(opt("spend-cap"));
if (!opt("spend-ledger") || !Number.isFinite(cap) || cap <= 0)
  throw new Error("m10 label: --spend-ledger FILE and --spend-cap USD (> 0) are required");
const out = opt("out");
if (!out) throw new Error("m10 label: --out FILE");

interface Row {
  h: string;
  suite: string;
  seed: number;
  variant: string;
  id: string;
  title: string;
  text: string;
  source: string;
  updatedAt: number | null;
  meta: Record<string, string> | null;
  now: string;
  strict: boolean;
  card?: unknown;
}
const done = new Set<string>();
if (existsSync(out))
  for (const l of readFileSync(out, "utf8").split("\n")) if (l.trim()) done.add((JSON.parse(l) as { h: string }).h);
const rows: Row[] = [];
const seen = new Set<string>();
for (const path of opt("items").split(",")) {
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as Row;
    if ((!r.strict && !has("all")) || done.has(r.h) || seen.has(r.h)) continue;
    if (/heldout/.test(r.suite)) throw new Error("held-out suites are never labelled");
    if (has("only-carded") && r.card === undefined) continue;
    seen.add(r.h);
    rows.push(r);
  }
}
const rng = new Rng(Number(opt("shuffle", "1")));
// Batches within one world (suite, seed, variant), as one user's enrichment reads them.
const byWorld = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.suite}:${r.seed}:${r.variant}`;
  (byWorld.get(k) ?? byWorld.set(k, []).get(k)!).push(r);
}
const size = Number(opt("batch", "20"));
let batches: Row[][] = [];
for (const list of byWorld.values()) {
  const shuffled = rng.sample(list, list.length);
  for (let i = 0; i < shuffled.length; i += size) batches.push(shuffled.slice(i, i + size));
}
const limit = Number(opt("limit", "0"));
if (limit > 0) {
  const kept: Row[][] = [];
  let n = 0;
  for (const b of batches) {
    if (n >= limit) break;
    kept.push(b);
    n += b.length;
  }
  batches = kept;
}
const model = opt("model", "claude-haiku-5-5");
const ledger = new SpendLedger(opt("spend-ledger"), cap, opt("run-label", "m10-label"), 0.1);
const chat = new AnthropicModel({
  apiKey: keyFor(model),
  model,
  meter: ledger.meter("eden.cards"),
  timeoutMs: 300_000,
});
const maker = new ModelCardMaker(chat);
const toItem = (r: Row): ContextItem => ({
  id: r.id,
  sourceId: r.source,
  ref: r.id,
  title: r.title,
  text: r.text,
  ...(r.updatedAt !== null ? { updatedAt: r.updatedAt } : {}),
  ...(r.meta ? { meta: r.meta } : {}),
});
let usd = 0;
let made = 0;
let failed = 0;
const one = async (b: Row[]) => {
  let got = await maker.make(b.map(toItem), b[0]!.now, AbortSignal.timeout(300_000), false, true);
  usd += got.costUsd;
  // A call cut off at the cap is sent again, as the enricher does.
  if (got.truncated) {
    got = await maker.make(b.map(toItem), b[0]!.now, AbortSignal.timeout(300_000), true, true);
    usd += got.costUsd;
  }
  const lines: string[] = [];
  b.forEach((r, i) => {
    const c = got.cards[i];
    if (c === null || c === undefined) return;
    lines.push(JSON.stringify({ h: r.h, c, ...(got.requests?.[i] ? { r: got.requests[i] } : {}) }));
  });
  made += lines.length;
  if (lines.length) appendFileSync(out, lines.join("\n") + "\n");
};
console.log(`m10 label: ${batches.reduce((n, b) => n + b.length, 0)} items in ${batches.length} calls, ${model}`);
const queue = [...batches];
await Promise.all(
  Array.from({ length: Number(opt("concurrency", "6")) }, async () => {
    for (let b = queue.shift(); b; b = queue.shift())
      await one(b).catch((e) => {
        failed++;
        console.log(`m10 label: a call failed: ${String(e).slice(0, 200)}`);
      });
  }),
);
const spent = usd.toFixed(4);
console.log(`m10 label: ${made} cards, ${failed} failed calls, USD ${spent}; ledger USD ${ledger.committedUsd.toFixed(4)}`);
