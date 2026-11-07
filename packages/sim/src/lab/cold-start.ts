#!/usr/bin/env bun
/**
 * Cold-start enrichment cost per user, measured (fix-s3b, docs/research/realuse-1-weak-points.md issue 12): a new
 * user's sources are backfilled by the sync from nothing, and the background card and intent enrichment runs on what
 * it stored until it is idle, with no replay cache, through the servers' own wiring (`buildPartner`: the default
 * configuration, the role budgets `DEFAULT_LIMITS` and the tenant cap). Only the transport differs: the card role is
 * `claude-haiku-5-5` on Anthropic's API through the lab provider (D97) instead of OpenRouter (D12), so the figures are
 * Anthropic-direct lab figures.
 *
 *   env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users train1:41,train3:42,train5:43
 *     --spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3 --run-label cold [--out cold.json]
 *
 * Each user is a hidden-variant world of a train suite (`worldOf`, as pi-ab builds it), its connectors the realistic
 * profile at time scale 0. One user at a time, so each user's calls and dollars are its own. `user:SEED` is instead
 * the long-horizon user `pi-ab --days` builds for that seed (pi-user.ts, over `--suite`, default train, with `--days`,
 * `--day-size` and `--mix` as pi-ab takes them): the one-time backfill `pi-cost-report.ts --lifetime` books for it.
 *
 * `--set JSON`: engine settings over the default (e.g. `{"cardsLeanDays":30}`, CL3's comparison with D244). The
 * deleted trial `cardsBatch` (D242) added `--bulk` here: commit 4e072585.
 */
import { writeFileSync } from "node:fs";
import { checkEngineConfig, type CardEnricher } from "@eden/engine";
import type { Model } from "@eden/llm";
import { buildPartner } from "@eden/server";
import { REALISTIC, simSources } from "../sources";
import { worldOf } from "./ab-common";
import { parseJson } from "./flags";
import { parseDaySize, parseMix, planUser, suiteTemplates, userWorldOf } from "./pi-user";
import { parseSuites } from "./suites";
import { labAccess, labModel } from "./free";
import { warmAll } from "../server";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const MODEL = opt("model", "claude-haiku-5-5");
const USERS = opt("users", "train1:41")
  .split(",")
  .map((u) => {
    const [suite, seed] = u.split(":");
    if (!suite || !Number.isInteger(Number(seed))) throw new Error(`--users takes suite:seed pairs, not ${u}`);
    return { suite, seed: Number(seed) };
  });
const OUT = opt("out", "");
// Checked as the servers check EDEN_ENGINE_CONFIG: an unknown key (a deleted trial's), a wrong type or an out-of-range
// value stops the run, rather than running the default under the setting's name. Cards are wired, the reader is not.
const SET = checkEngineConfig(parseJson(opt("set", "{}"), "--set"), { where: "--set", deps: { cards: true } });
/** `user:SEED`'s world, as `pi-ab --days` plans it. */
const userWorld = (seed: number) => {
  const suites = parseSuites(opt("suite", "train"));
  const plan = planUser(seed, suiteTemplates(seed, suites), {
    days: Number(opt("days", "8")),
    size: parseDaySize(opt("day-size", "12-20")),
    mix: parseMix(opt("mix", "1:1:8")),
  });
  return userWorldOf(seed, plan).world;
};
const ACCESS = labAccess(args, [MODEL]);

interface Row {
  user: string;
  itemsAtSources: number;
  cardCalls: number;
  usd: number;
  [k: string]: unknown;
}
const rows: Row[] = [];
for (const { suite, seed } of USERS) {
  const world =
    suite === "user" ? userWorld(seed) : worldOf(seed, suite, "hidden", { maxTasks: 30, maxOffworld: 5 }).world;
  const sources = simSources(world, REALISTIC, 0, seed);
  let calls = 0;
  let usd = 0;
  let inTok = 0;
  let outTok = 0;
  let cachedTok = 0;
  const model = labModel(ACCESS, { apiKey: "", model: MODEL }, "eden.cards");
  // Counted here as well as on the ledger, so each user's row is its own.
  const count = (m: Model): Model => ({
    id: m.id,
    chat: async (req) => {
      const res = await m.chat(req);
      calls++;
      usd += res.costUsd ?? 0;
      inTok += res.usage.inputTokens;
      outTok += res.usage.outputTokens;
      cachedTok += res.usage.cachedInputTokens;
      return res;
    },
  });
  const counted = count(model);
  const partner = buildPartner({
    sources: async () => sources,
    sourceMapPath: ":memory:",
    queryPlanner: "off",
    models: {
      reader: null,
      cards: counted,
      cardsRetry: null,
      usdPerTenantDay: 25,
    },
    engine: SET,
  });
  // The harness ticks the sync itself (until the user is warm), not the server's minute timer.
  partner.stopSync();
  const scope = { tenantId: "cold", userId: `${suite}-${seed}` };
  const t0 = performance.now();
  await partner.observe({ ...scope, sessionId: "s0", at: Date.now(), kind: "session_start", agent: "cold-start" });
  const warm = await warmAll(partner.sync!, [scope], 2_000);
  const syncMs = performance.now() - t0;
  // A lab peek at the enricher the server built (buildPartner keeps it private).
  const cards = (partner as unknown as { deps: { cards?: CardEnricher } }).deps.cards;
  if (!cards) throw new Error("no card enricher: is cards off in the default?");
  await cards.idle();
  const ms = performance.now() - t0;
  const synced = sources.reduce((n, s) => n + s.listAll().length, 0);
  const row = {
    user: `${suite}:${seed}`,
    seed,
    itemsAtSources: synced,
    syncTicks: warm.ticks,
    syncCalls: warm.calls,
    warm: warm.cold === 0,
    syncMs: Math.round(syncMs),
    enrichMs: Math.round(ms - syncMs),
    cardCalls: calls,
    inputTokens: inTok,
    cachedTokens: cachedTok,
    outputTokens: outTok,
    outPerCall: Math.round(outTok / Math.max(1, calls)),
    usd: Math.round(usd * 1e6) / 1e6,
    stats: { ...cards.stats },
  };
  console.error(JSON.stringify(row));
  rows.push(row);
  await partner.observe({ ...scope, sessionId: "s0", at: Date.now(), kind: "session_end" });
}
const mean = (k: "usd" | "cardCalls" | "itemsAtSources") => rows.reduce((n, r) => n + r[k], 0) / rows.length;
const out = {
  provider: "anthropic-direct (lab, D97)",
  model: MODEL,
  wiring: "buildPartner (DEFAULT_CONFIG, DEFAULT_LIMITS, tenant cap $25/day)",
  set: SET,
  users: rows,
  meanUsd: Math.round(mean("usd") * 1e6) / 1e6,
  meanCalls: mean("cardCalls"),
  meanItems: mean("itemsAtSources"),
};
console.log(JSON.stringify(out, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));
process.exit(0);
