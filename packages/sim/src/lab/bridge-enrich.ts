#!/usr/bin/env bun
/**
 * Precomputes bridging queries (`bridge.ts`, `bridgeQuery`) for the simulated suites' requests, once, into a disk cache
 * keyed by request (`bridge-disk.ts`), so the funnel replays them for free (docs/research/edge-bridge.md).
 *
 *   bun packages/sim/src/lab/bridge-enrich.ts --out FILE --suite dev6a,dev6b [--seeds 41,42,43,44] [--batch 12]
 *     [--model m] [--allow-logging] [--rpm 18] [--max-requests N] [--all] [--dry]
 *
 * Only requests the engine would ask about are sent (`bridgeWants`, with `conflictVocab`'s verbs), unless `--all`.
 * Production sends one request per call; the lab sends `--batch` at once under the same instructions (each answered
 * on its own), to stay inside the free tier's request limits. A `:free` model needs `--allow-logging` (lab only,
 * simulated text only; D12 stands for the engine). Requests go through the lab's pacer (`free.ts`): paced (`--rpm`),
 * retried on 429 and 5xx, and capped at `--max-requests` (retries included); an unreadable batch is sent again.
 */
import { appendFileSync } from "node:fs";
import { bridgeKey, bridgeWants, ModelBridgeMaker } from "@eden/engine";
import { buildWorld } from "../world";
import { loadBridge, type BridgeLine } from "./bridge-disk";
import { isCapError, labAccess, labModel } from "./free";
import { parseSuites, SUITES } from "./suites";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const OUT = opt("out", "");
if (!OUT) throw new Error("--out is required");
const SUITE_LIST = parseSuites(opt("suite", "dev6a,dev6b"));
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
const BATCH = Number(opt("batch", "12"));
const MODEL = opt("model", "nvidia/nemotron-3.5-super-vl:free");
const ACCESS = labAccess(args, [MODEL]);
const DRY = args.includes("--dry");

const requests = new Map<string, string>();
let seen = 0;
for (const suite of SUITE_LIST) {
  for (const variant of ["hidden", "control"] as const) {
    for (const seed of SEEDS) {
      const world = buildWorld({ seed: seed * 1_000 });
      for (const task of SUITES[suite]!(world, seed, variant)) {
        seen++;
        if (!args.includes("--all") && !bridgeWants(task.text, false, true)) continue;
        requests.set(bridgeKey(task.text), task.text);
      }
    }
  }
}
const done = loadBridge(OUT);
const todo = [...requests].filter(([h]) => !done.has(h));
console.log(`${seen} tasks, ${requests.size} distinct requests the bridge asks about, ${todo.length} to do`);
if (DRY) {
  for (const [, r] of todo) console.log(`  ${r}`);
  process.exit(0);
}
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("needs OPENROUTER_API_KEY");
const model = labModel(ACCESS, { apiKey: key, model: MODEL, timeoutMs: 120_000 });
// The last reply's end and head, printed when a batch is unreadable.
let last = "";
const maker = new ModelBridgeMaker({
  id: model.id,
  chat: async (request) => {
    const res = await model.chat(request);
    last = `${res.truncated ? "truncated, " : ""}${res.usage.outputTokens} out: ${res.text.slice(0, 160)}`;
    return res;
  },
});
let cost = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  let got: Awaited<ReturnType<ModelBridgeMaker["make"]>> | null = null;
  for (let attempt = 0; attempt < 3 && !got; attempt++) {
    try {
      const res = await maker.make(
        batch.map(([, r]) => r),
        AbortSignal.timeout(120_000),
      );
      // Unreadable or cut off: the whole batch again (a cut batch is unreadable past the cut).
      if (res.truncated || res.queries.every((q) => q === null)) throw new Error("unreadable");
      got = res;
    } catch (e) {
      if (isCapError(e)) {
        console.log(`request cap reached: ${JSON.stringify(ACCESS.pacer.summary())}`);
        process.exit(1);
      }
      // The pacer already retried 429 and 5xx; this is an unreadable reply or a network failure.
      const wait = /429/.test(String(e)) ? 15_000 * (attempt + 1) : 3_000 * (attempt + 1);
      console.log(`  retry in ${wait / 1000}s: ${String(e).slice(0, 160)} (${last})`);
      await Bun.sleep(wait);
    }
  }
  // A batch that fails three times stops the run: the free tier's requests are metered, not to be spent blindly.
  if (!got) {
    console.log("batch failed three times; stopping");
    process.exit(1);
  }
  cost += got.costUsd;
  const lines = batch.map(([h, r], k): BridgeLine => ({ h, r, q: got!.queries[k] ?? null }));
  appendFileSync(OUT, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  console.log(`${Math.min(i + BATCH, todo.length)}/${todo.length} ($${cost.toFixed(5)}, ${ACCESS.pacer.sent} requests)`);
}
