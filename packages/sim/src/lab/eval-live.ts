#!/usr/bin/env bun
/**
 * `bun run eval --live` on Anthropic's API (claude-haiku-5-5, HAIKU_API_KEY), metered by the lab's spend ledger. LAB
 * ONLY (D97): the shipped reader runs on OpenRouter (`anthropic/claude-haiku-5.5`, D12's ZDR and no data collection,
 * D95's throughput sort, reasoning "low"), and this driver exists for sessions whose paid calls are limited to
 * Anthropic.
 *
 *   bun packages/sim/src/lab/eval-live.ts --spend-ledger .local/mkt/ledger.jsonl --spend-cap 17 \
 *     [--spend-headroom 0.3] [--run-label L] [--usd-cap 0.05] [--thinking off|adaptive] [--wait 2000] \
 *     [--no-planner] [--scenarios DIR]
 *
 * What it keeps from what ships: the eval's own `liveWiring` (D128) builds the reader through the servers'
 * `modelRolesFromEnv`, so the engine configuration (`DEFAULT_CONFIG`), the `AskReader` over `ModelReaderMaker`, the
 * budget limits and the no-judge shape are the servers'. Only the transport differs: `make` returns `labModel` (an
 * `AnthropicModel` booked in the ledger under `eden.reader`) in place of `OpenRouterModel`. `modelRolesFromEnv` gates
 * on OPENROUTER_API_KEY, so the env it is handed carries a placeholder in that slot: the real OpenRouter key never
 * reaches it, and `make` refuses any key but the placeholder.
 *
 * `--thinking off` (default) is how the lab's readers have run (thinking disabled, so the reader's "low" reasoning is
 * not sent). `--thinking adaptive` sends it as Anthropic's effort "low", nearer the shipped reasoning; neither is
 * bit-identical to OpenRouter's route. Two caps hold: `--usd-cap` on the run (the eval's `TenantSpend`, reserved
 * before each call) and the ledger's `--spend-cap` across every process of the campaign.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@eden/engine";
import { EVAL_TENANT, liveWiring, runScenarios, unwiredFlags, type Scenario } from "@eden/eval";
import { readerFailureLog } from "@eden/server";
import { flags } from "./flags";
import { keyFor, labAccess, labModel } from "./free";

const MODEL = "claude-haiku-5-5";
/** Fills OPENROUTER_API_KEY's slot so `modelRolesFromEnv` builds the roles; never sent anywhere. */
const PLACEHOLDER = "lab-placeholder-not-a-key";
export const PROVIDER = "anthropic-direct (lab, D97)";

const USAGE = `
bun packages/sim/src/lab/eval-live.ts --spend-ledger FILE --spend-cap USD [--spend-headroom USD] [--run-label L]
  [--usd-cap 0.05] [--thinking off|adaptive] [--wait 2000] [--no-planner] [--scenarios DIR] [--rpm N] [--max-requests N]
The eval's shipped live wiring (D128) with the reader on Anthropic's claude-haiku-5-5 (lab only, D97).`;

const argv = process.argv.slice(2);
const cli = flags(
  "eval-live",
  {
    "spend-ledger": "value",
    "spend-cap": "value",
    "spend-headroom": "value",
    "run-label": "value",
    rpm: "value",
    "max-requests": "value",
    "usd-cap": "value",
    thinking: "value",
    wait: "value",
    scenarios: "value",
    "no-planner": "bool",
  },
  USAGE,
  argv,
);
const fail = (message: string): never => {
  console.error(`eval-live: ${message}`);
  process.exit(2);
};

const usdCap = Number(cli.opt("usd-cap", "0.05"));
if (!(usdCap > 0) || !Number.isFinite(usdCap)) fail(`--usd-cap ${cli.opt("usd-cap", "")}: expected a positive USD`);
const thinking = cli.opt("thinking", "off");
if (thinking !== "off" && thinking !== "adaptive") fail(`--thinking ${thinking}: expected off or adaptive`);
const waitMs = Number(cli.opt("wait", "2000"));
if (!(waitMs >= 0) || !Number.isFinite(waitMs)) fail(`--wait ${cli.opt("wait", "")}: expected milliseconds ≥ 0`);
const planner = !cli.has("no-planner");
const dir = cli.opt("scenarios", join(import.meta.dir, "..", "..", "..", "eval", "scenarios"));

// Stops before any call without HAIKU_API_KEY (or ANTHROPIC_API_KEY), a ledger or a cap.
let access: ReturnType<typeof labAccess>;
let anthropicKey: string;
try {
  access = labAccess(argv, [MODEL]);
  anthropicKey = keyFor(MODEL);
} catch (error) {
  fail((error as Error).message);
}
const ledger = access!.ledger!;

const wiring = liveWiring({
  judge: false,
  usdCap,
  env: { ...process.env, OPENROUTER_API_KEY: PLACEHOLDER },
  make: (options) => {
    if (options.apiKey !== PLACEHOLDER) throw new Error("eval-live: a role was built with a real OpenRouter key");
    return labModel(access!, { ...options, model: MODEL }, "eden.reader", { thinking: thinking as "off" | "adaptive" });
  },
});
if (!wiring?.readerModel) fail("the shipped wiring built no reader");
// The placeholder is all `wiring.scrub` knows; the key actually sent is Anthropic's, so it is scrubbed too.
const scrub = (text: string) => wiring!.scrub(text).split(anthropicKey!).join("[key]");
let readerFailure: string | undefined;
const onReaderFailure = readerFailureLog((line) => {
  readerFailure = line;
  console.error(line);
}, scrub);

const scenarios = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario);
const inert = unwiredFlags(DEFAULT_CONFIG, { reader: true });
for (const flag of inert) console.error(`note: inert in the eval: ${flag}`);

const metrics = await runScenarios(scenarios, {
  model: null,
  waitMs,
  planner,
  config: {},
  spend: wiring!.spend,
  readerModel: wiring!.readerModel,
  onReaderFailure,
});
console.log(
  JSON.stringify(
    {
      live: true,
      wiring: "shipped (D128: no judge, the role reader) on a lab transport",
      provider: PROVIDER,
      transport: "Anthropic Messages API direct, not OpenRouter (what ships): same model family, not bit-identical",
      readerModel: wiring!.readerModel!.id,
      thinking,
      usdCap,
      spentUsd: wiring!.spend.spent(EVAL_TENANT),
      ledger: { run: ledger.run, role: "eden.reader", rows: ledger.calls, bookedUsd: ledger.bookedUsd },
      ...(readerFailure ? { readerFailure } : {}),
      waitMs,
      planner,
      ...(inert.length ? { inert } : {}),
      ...metrics,
    },
    null,
    2,
  ),
);
