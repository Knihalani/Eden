#!/usr/bin/env bun
/**
 * Precomputes implication cards (`cards.ts`) for the simulated worlds' items, once, into a disk cache keyed by content
 * hash (`cards-disk.ts`), so the funnel and the simulation replay them for free (docs/research/moon-cards.md).
 *
 *   bun packages/sim/src/lab/cards-enrich.ts --dir DIR [--funnel hidden,heldout] [--seeds 41,42,43,44]
 *     [--sim-seeds 41,42] [--sim-users 6] [--cap 2.80] [--rejected N] [--concurrency 4] [--dry]
 *     [--model m] [--sort price] [--batch 10] [--spend FILE] [--only N] [--strict]
 *
 * Items are those a sync would read (every source's `listAll`, as the realistic connectors return them), redacted as
 * the cache redacts them. Only items the no-model prefilter passes are sent, in batches of ten, unless `--rejected N`
 * also sends a random N of the rejected (to measure what the prefilter loses). Every call is metered: its OpenRouter
 * cost is appended to DIR/spend.jsonl (or `--spend FILE`, shared by several runs), and no call starts once the total
 * there (all runs) reaches `--cap`.
 *
 * The cheaper shapes of docs/research/econ-background.md: `--strict` (only what `cardsEconomy`'s prefilter passes),
 * `--sort price` (OpenRouter's cheapest compliant endpoint first; a batch cut off at the output cap is sent once more
 * with default routing, as the enricher does), `--batch` items per call, `--model`. `--only N` enriches only the
 * first N items to do (a sample; the order is the items' sorted content hashes).
 *
 * Free models (`--model <id>:free --allow-logging`, lab only; `free.ts`): calls are paced (`--rpm`, default 18) and
 * retried on 429/5xx, and `--max-requests N` caps the run's HTTP requests; at the cap the workers stop and the run
 * ends with the cards it made (`stopped`, `requests` in its summary line).
 *
 * `--intent` (D86, docs/research/edge-intent.md): the intent index's enrichment. Every item is sent, the prefilter's
 * rejects too, with the prompt that also asks for the requests each item would change; each item's requests, the
 * model's card and whether the prefilter passed it go to DIR/intent-v<N>.jsonl (`{h, r, c, p}`), which the funnel
 * replays with `--intent` (its cards still come from `--cards`). Items already in that file are skipped.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import {
  CARD_VERSION,
  cardKey,
  INTENT_VERSION,
  ItemCache,
  ModelCardMaker,
  worthCarding,
  worthCardingStrict,
  type CardBatch,
} from "@eden/engine";
import { type Model } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { Rng } from "../rng";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { DiskCardMaker, loadRequests } from "./cards-disk";
import { isCapError, labAccess, labModel } from "./free";
import { clearSlot, dress } from "./hidden-context";
import { parseSuites, SUITES } from "./suites";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const DIR = opt("dir", "");
if (!DIR) throw new Error("--dir is required");
mkdirSync(DIR, { recursive: true });
const FUNNEL = opt("funnel", "");
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
const SIM_SEEDS = opt("sim-seeds", "").split(",").filter(Boolean).map(Number);
const SIM_USERS = Number(opt("sim-users", "6"));
const CAP = Number(opt("cap", "2.80"));
const REJECTED = Number(opt("rejected", "0"));
const CONCURRENCY = Number(opt("concurrency", "4"));
const DRY = args.includes("--dry");
const MODEL = opt("model", "z-ai/glm-5.3-flash");
const SPEND = opt("spend", `${DIR}/spend.jsonl`);
const SORT = opt("sort", "") as "" | "price";
const BATCH = Number(opt("batch", "10"));
const ONLY = Number(opt("only", "0"));
const ACCESS = labAccess(args, [MODEL]);
/** `--strict`: only the items the strict prefilter (`cardsEconomy`) passes. */
const pass = args.includes("--strict") ? worthCardingStrict : worthCarding;
const INTENT = args.includes("--intent");
const FREE = ACCESS.free;
const INTENT_FILE = `${DIR}/intent-v${INTENT_VERSION}.jsonl`;

/** Items a sync would read, redacted as the cache redacts them, deduplicated by content hash. */
const items = new Map<string, ContextItem>();
const take = (raw: ContextItem[]) => {
  const cache = new ItemCache({ maxItemsPerUser: 100_000 });
  for (const it of cache.put({ tenantId: "t", userId: "u" }, raw, 0)) items.set(cardKey(it), it);
};
if (FUNNEL) {
  for (const suite of parseSuites(FUNNEL)) {
    for (const variant of ["hidden", "control"] as const) {
      for (const seed of SEEDS) {
        // As hidden-funnel.ts builds each world.
        const world = buildWorld({ seed: seed * 1_000 });
        const before = world.items.length;
        const tasks = SUITES[suite]!(world, seed, variant);
        const planted = world.items.slice(before);
        for (const it of planted) dress(world, it);
        const keep = new Set(planted.map((it) => it.id));
        for (const task of tasks) clearSlot(world, task.text, keep);
        take(simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll()));
      }
    }
  }
}
for (const seed of SIM_SEEDS) {
  // As quality.ts builds each user's world (noise scale 1).
  for (let u = 0; u < SIM_USERS; u++) {
    const world = buildWorld({ seed: seed * 1_000 + u });
    take(simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll()));
  }
}

const disk = new DiskCardMaker(`${DIR}/cards-v${CARD_VERSION}.jsonl`);
const all = [...items.entries()];
const passed = all.filter(([, it]) => pass(it));
const rejected = all.filter(([, it]) => !pass(it));
const rng = new Rng(7);
const sample = REJECTED > 0 ? rng.sample(rejected, REJECTED) : [];
// With `--intent`, every item not yet in the intent file (the prefilter's rejects are read for their requests).
const asked = INTENT ? loadRequests(INTENT_FILE) : new Map<string, string[]>();
const pending = INTENT
  ? all.filter(([h]) => !asked.has(h))
  : [...passed, ...sample].filter(([h]) => !disk.cards.has(h));
const todo = ONLY > 0 ? pending.sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, ONLY) : pending;
const spent = () =>
  existsSync(SPEND)
    ? readFileSync(SPEND, "utf8")
        .split("\n")
        .filter(Boolean)
        .reduce((a, l) => a + (JSON.parse(l) as { usd: number }).usd, 0)
    : 0;
console.log(
  `items ${all.length} unique, prefilter passes ${passed.length} (${((100 * passed.length) / all.length).toFixed(1)}%),` +
    (INTENT
      ? ` with requests already ${asked.size}, `
      : ` rejected sample ${sample.length}, cached ${all.length - todo.length - rejected.length + sample.length}, `) +
    `to enrich ${todo.length} (${Math.ceil(todo.length / BATCH)} calls); spent so far $${spent().toFixed(4)} of cap $${CAP}`,
);
if (DRY || todo.length === 0) process.exit(0);
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is not set");
// Metered: every call's reported cost goes to the spend ledger before its cards are kept.
let total = spent();
const startSpend = total;
let calls = 0;
let inTok = 0;
let outTok = 0;
let cachedTok = 0;
let retries = 0;
const metered = (inner: Model, sort: string): Model => ({
  id: inner.id,
  chat: async (req) => {
    const res = await inner.chat(req);
    calls++;
    inTok += res.usage.inputTokens;
    outTok += res.usage.outputTokens;
    cachedTok += res.usage.cachedInputTokens;
    total += res.costUsd;
    const line = {
      at: new Date().toISOString(),
      usd: res.costUsd,
      in: res.usage.inputTokens,
      out: res.usage.outputTokens,
      truncated: !!res.truncated,
      cached: res.usage.cachedInputTokens,
      provider: res.provider ?? "",
      model: MODEL,
      sort,
      batch: BATCH,
      ...(INTENT ? { intent: INTENT_VERSION } : {}),
    };
    appendFileSync(SPEND, `${JSON.stringify(line)}\n`);
    return res;
  },
});
const routed = (sort: "" | "price") =>
  metered(labModel(ACCESS, { apiKey: key, model: MODEL, timeoutMs: 120_000, ...(sort ? { sort } : {}) }), sort);
// A cut batch's retry goes to default routing (`CardMakerOptions.retry`), as `CardEnricher` sends it.
const MAX_TOKENS = Number(opt("max-tokens", FREE ? "8000" : "0"));
const maker = new ModelCardMaker(routed(SORT), {
  retry: routed(""),
  ...(MAX_TOKENS > 0 ? { maxTokens: MAX_TOKENS } : {}),
});
const batches: [string, ContextItem][][] = [];
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
let next = 0;
let failed = 0;
let intentDone = 0;
let stopped = false;
const worker = async () => {
  while (next < batches.length) {
    if (total >= CAP || ACCESS.pacer.exhausted) {
      stopped = true;
      return;
    }
    const batch = batches[next++]!;
    try {
      const items = batch.map(([, it]) => it);
      // Long enough for a free model's backoff and retries (the pacer, `free.ts`).
      const signal = () => AbortSignal.timeout(FREE ? 600_000 : 150_000);
      let got: CardBatch = await maker.make(items, "2026-10-27", signal(), false, INTENT);
      if (got.truncated && total < CAP) {
        retries++;
        const again = await maker.make(items, "2026-10-27", signal(), true, INTENT);
        got = {
          ...again,
          cards: got.cards.map((c, i) => c ?? again.cards[i] ?? null),
          ...(INTENT ? { requests: items.map((_, i) => got.requests?.[i] ?? again.requests?.[i] ?? null) } : {}),
        };
      }
      batch.forEach(([h, it], i) => {
        const c = got.cards[i];
        if (!INTENT) {
          if (c) disk.put(h, c.kind === "none" ? null : c);
          return;
        }
        // Unread requests: left out, so the next run asks again.
        const r = got.requests?.[i];
        if (!r) return;
        const line = { h, r, c: c ? (c.kind === "none" ? null : c) : undefined, p: pass(it) };
        appendFileSync(INTENT_FILE, `${JSON.stringify(line)}\n`);
        intentDone++;
      });
    } catch (e) {
      if (isCapError(e)) {
        stopped = true;
        return;
      }
      failed++;
      console.error(`batch failed: ${String(e).slice(0, 200)}`);
    }
    if (calls % 20 === 0) console.log(`  ${calls} calls, $${total.toFixed(4)}`);
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const covered = [...passed, ...sample].filter(([h]) => disk.cards.has(h)).length;
console.log(
  JSON.stringify({
    calls,
    retries,
    failed,
    stopped,
    spentThisRun: Number((total - startSpend).toFixed(6)),
    spentTotal: Number(spent().toFixed(6)),
    inPerCall: Math.round(inTok / Math.max(1, calls)),
    outPerCall: Math.round(outTok / Math.max(1, calls)),
    cachedPerCall: Math.round(cachedTok / Math.max(1, calls)),
    usdPerCall: Number(((total - startSpend) / Math.max(1, calls)).toFixed(7)),
    usdPerItem: Number(((total - startSpend) / Math.max(1, todo.length)).toFixed(8)),
    covered,
    ...(INTENT ? { intentItems: intentDone } : {}),
    of: passed.length + sample.length,
    requests: ACCESS.pacer.summary(),
  }),
);
