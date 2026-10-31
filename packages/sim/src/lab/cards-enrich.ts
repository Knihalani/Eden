#!/usr/bin/env bun
/**
 * Precomputes implication cards (`cards.ts`) for the simulated worlds' items, once, into a disk cache keyed by content
 * hash (`cards-disk.ts`), so the funnel and the simulation replay them for free (docs/research/moon-cards.md).
 *
 *   bun packages/sim/src/lab/cards-enrich.ts --dir DIR [--funnel hidden,heldout] [--seeds 41,42,43,44]
 *     [--sim-seeds 41,42] [--sim-users 6] [--cap 2.80] [--rejected N] [--concurrency 4] [--dry]
 *
 * Items are those a sync would read (every source's `listAll`, as the realistic connectors return them), redacted as
 * the cache redacts them. Only items the no-model prefilter passes are sent, in batches of ten, unless `--rejected N`
 * also sends a random N of the rejected (to measure what the prefilter loses). Every call is metered: its OpenRouter
 * cost is appended to DIR/spend.jsonl, and no call starts once the total there (all runs) reaches `--cap`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { CARD_VERSION, cardKey, ItemCache, ModelCardMaker, worthCarding } from "@eden/engine";
import { OpenRouterModel, type Model } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { Rng } from "../rng";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { DiskCardMaker } from "./cards-disk";
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
const SPEND = `${DIR}/spend.jsonl`;

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
const passed = all.filter(([, it]) => worthCarding(it));
const rejected = all.filter(([, it]) => !worthCarding(it));
const rng = new Rng(7);
const sample = REJECTED > 0 ? rng.sample(rejected, REJECTED) : [];
const todo = [...passed, ...sample].filter(([h]) => !disk.cards.has(h));
const spent = () =>
  existsSync(SPEND)
    ? readFileSync(SPEND, "utf8")
        .split("\n")
        .filter(Boolean)
        .reduce((a, l) => a + (JSON.parse(l) as { usd: number }).usd, 0)
    : 0;
console.log(
  `items ${all.length} unique, prefilter passes ${passed.length} (${((100 * passed.length) / all.length).toFixed(1)}%),` +
    ` rejected sample ${sample.length}, cached ${all.length - todo.length - rejected.length + sample.length}, ` +
    `to enrich ${todo.length}; spent so far $${spent().toFixed(4)} of cap $${CAP}`,
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
const inner = new OpenRouterModel({ apiKey: key, model: MODEL, timeoutMs: 120_000 });
const metered: Model = {
  id: inner.id,
  chat: async (req) => {
    const res = await inner.chat(req);
    calls++;
    inTok += res.usage.inputTokens;
    outTok += res.usage.outputTokens;
    total += res.costUsd;
    const line = {
      at: new Date().toISOString(),
      usd: res.costUsd,
      in: res.usage.inputTokens,
      out: res.usage.outputTokens,
      truncated: !!res.truncated,
    };
    appendFileSync(SPEND, `${JSON.stringify(line)}\n`);
    return res;
  },
};
const maker = new ModelCardMaker(metered);
const batches: [string, ContextItem][][] = [];
for (let i = 0; i < todo.length; i += 10) batches.push(todo.slice(i, i + 10));
let next = 0;
let failed = 0;
let stopped = false;
const worker = async () => {
  while (next < batches.length) {
    if (total >= CAP) {
      stopped = true;
      return;
    }
    const batch = batches[next++]!;
    try {
      const got = await maker.make(
        batch.map(([, it]) => it),
        "2026-10-27",
        AbortSignal.timeout(150_000),
      );
      batch.forEach(([h], i) => {
        const c = got.cards[i];
        if (c) disk.put(h, c.kind === "none" ? null : c);
      });
    } catch (e) {
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
    failed,
    stopped,
    spentThisRun: Number((total - startSpend).toFixed(6)),
    spentTotal: Number(spent().toFixed(6)),
    inPerCall: Math.round(inTok / Math.max(1, calls)),
    outPerCall: Math.round(outTok / Math.max(1, calls)),
    covered,
    of: passed.length + sample.length,
  }),
);
