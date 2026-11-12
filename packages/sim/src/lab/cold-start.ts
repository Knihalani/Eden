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
 * `suite:seed:variant` takes the `control` or `neutral` world instead of the hidden one (the funnel's worlds, as
 * `worldOf` builds them).
 *
 * `--cards-out FILE` (P7, D872): append every card and intent request the shipped enricher made, one `{h, c, r}` line
 * per item it read (`h` the card key, `c` the card, `r` the requests; either left out where the call gave none), the
 * format `--cards` and `--intent` replay. Run over a suite's worlds this gives the shipped-coverage caches
 * (`cards-shipped.jsonl.gz`, cards-disk.ts): the cards and requests a deployment would hold for those users, not
 * `cards-enrich.ts --intent`'s every-item index (D714).
 *
 * `--clock world|wall` (F8, from F5's check): the partner's clock. `world` (the default) starts at the world's own
 * `now` (27 October 2026) and advances in real time, so lean carding's recent-days window (`cardsLean`) reads the
 * world as the funnel and pi-ab do. `wall` is the wall clock every recording before it used (the D872 caches): weeks
 * past the worlds' date, so the window skipped almost every past item (train1:41: 36 request-only reads against 179).
 *
 * `--set JSON`: engine settings over the default (e.g. `{"cardsLeanDays":30}`, CL3's comparison with D244). The
 * deleted trial `cardsBatch` (D242) added `--bulk` here: commit 4e072585.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { checkEngineConfig, type CardEnricher, type CardMaker } from "@eden/engine";
import type { Model } from "@eden/llm";
import { buildPartner } from "@eden/server";
import { REALISTIC, simSources } from "../sources";
import { worldOf } from "./ab-common";
import { formKey } from "./cards-disk";
import { parseJson } from "./flags";
import type { UserShape } from "./pi-cost";
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
    const [suite, seed, variant = "hidden"] = u.split(":");
    if (!suite || !Number.isInteger(Number(seed))) throw new Error(`--users takes suite:seed[:variant], not ${u}`);
    if (variant !== "hidden" && variant !== "control" && variant !== "neutral")
      throw new Error(`--users: unknown variant "${variant}" in ${u}`);
    return { suite, seed: Number(seed), variant: variant as "hidden" | "control" | "neutral" };
  });
const OUT = opt("out", "");
const CARDS_OUT = opt("cards-out", "");
// Checked as the servers check EDEN_ENGINE_CONFIG: an unknown key (a deleted trial's), a wrong type or an out-of-range
// value stops the run, rather than running the default under the setting's name. Cards are wired, the reader is not.
const SET = checkEngineConfig(parseJson(opt("set", "{}"), "--set"), { where: "--set", deps: { cards: true } });
/** `user:SEED`'s world, as `pi-ab --days` plans it. */
const USER_SHAPE: UserShape = {
  suites: parseSuites(opt("suite", "train")),
  days: Number(opt("days", "8")),
  daySize: parseDaySize(opt("day-size", "12-20")),
  mix: parseMix(opt("mix", "1:1:8")),
};
const userWorld = (seed: number) => {
  const { suites, days, daySize: size, mix } = USER_SHAPE;
  return userWorldOf(seed, planUser(seed, suiteTemplates(seed, suites), { days, size, mix })).world;
};
const ACCESS = labAccess(args, [MODEL]);
const CLOCK = opt("clock", "world");
if (CLOCK !== "world" && CLOCK !== "wall") throw new Error(`--clock takes world or wall, not ${CLOCK}`);

interface Row {
  user: string;
  itemsAtSources: number;
  cardCalls: number;
  usd: number;
  [k: string]: unknown;
}
const rows: Row[] = [];

/**
 * `--cards-out`: wrap the enricher's own maker (a lab peek, as above) so each item a call read is appended with what
 * the call gave it. Set before the first observe, so every call of the user's backfill is recorded.
 */
function record(enricher: CardEnricher, file: string): void {
  const deps = (enricher as unknown as { deps: { maker: CardMaker } }).deps;
  const inner = deps.maker;
  deps.maker = {
    make: async (items, today, signal, retry, intent, options) => {
      const got = await inner.make(items, today, signal, retry, intent, options);
      // A card the call could not read (null) stays uncovered: no `c`, as a requests-only line (cards-disk.ts).
      const lines = items.flatMap((it, i) => {
        const c = got.cards[i];
        const r = got.requests?.[i];
        if (!c && !r) return [];
        // A line made by another prompt form is keyed apart (`formKey`, D1060), so the forms never answer each other.
        return [JSON.stringify({ h: formKey(it, options?.form), ...(c ? { c } : {}), ...(r ? { r } : {}) })];
      });
      // A call cut off at the output cap is sent again (`retry`): the later lines win when the file is read.
      if (lines.length) appendFileSync(file, `${lines.join("\n")}\n`);
      return got;
    },
  };
}
for (const { suite, seed, variant } of USERS) {
  const world =
    suite === "user" ? userWorld(seed) : worldOf(seed, suite, variant, { maxTasks: 30, maxOffworld: 5 }).world;
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
  // The world's clock advances in real time from its own `now` (warmAll waits on ticks, so it must move).
  const start = Date.now();
  const now = CLOCK === "world" ? () => world.now + (Date.now() - start) : () => Date.now();
  const partner = buildPartner({
    now,
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
  // A lab peek at the enricher the server built (buildPartner keeps it private).
  const cards = (partner as unknown as { deps: { cards?: CardEnricher } }).deps.cards;
  if (!cards) throw new Error("no card enricher: is cards off in the default?");
  if (CARDS_OUT) record(cards, CARDS_OUT);
  const scope = { tenantId: "cold", userId: `${suite}-${seed}` };
  const t0 = performance.now();
  await partner.observe({ ...scope, sessionId: "s0", at: now(), kind: "session_start", agent: "cold-start" });
  const warm = await warmAll(partner.sync!, [scope], 2_000);
  const syncMs = performance.now() - t0;
  await cards.idle();
  const ms = performance.now() - t0;
  const synced = sources.reduce((n, s) => n + s.listAll().length, 0);
  const row = {
    user: `${suite}:${seed}${variant === "hidden" ? "" : `:${variant}`}`,
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
  await partner.observe({ ...scope, sessionId: "s0", at: now(), kind: "session_end" });
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
  // `pi-cost-report.ts --lifetime` books a cold start only against runs of the same user shape (pi-cost.ts).
  ...(USERS.some((u) => u.suite === "user") ? { userShape: USER_SHAPE } : {}),
};
console.log(JSON.stringify(out, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));
process.exit(0);
