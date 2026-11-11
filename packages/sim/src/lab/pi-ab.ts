#!/usr/bin/env bun
/**
 * The live agent A/B on the Pi harness (CLAUDE.md's standard agent), with a timeline of every task.
 *
 * Same tasks, prompts, tools, grader and results file as `agent-ab.ts` (all from `ab-common.ts`), so
 * `agent-ab-report.ts` reads its results; the agent is Pi's loop instead of the in-house one: `Agent` from
 * @earendil-works/pi-agent-core streaming through @earendil-works/pi-ai's OpenAI-compatible API on OpenRouter.
 * Conditions:
 *
 * - none:  no tools, no Eden;
 * - tools: a read-only search tool per sim source (`search_<id>`, as agent-ab gives);
 * - eden:  Eden's packet injected before the user turn (and any queued later, before each model request), plus
 *          `ask_context` backed by the real `ContextPartner` with `--config`;
 * - both:  the search tools, with Eden's injected context (Eden sees the agent's tool results);
 * - both+ask: as both, plus `ask_context` (fix-s3b: the shape integrators ship, weak point 4);
 * - eden-judge, both-judge: as eden and both, with Eden's model judge on.
 *
 * A condition may end in `@w<ms>` ("both@w0"): how long the first observe waits for Eden's slow path before the agent's
 * first model request (agent-ab and the client's `withContext` default: 3000). What arrives later is injected before
 * the agent's next request, if it makes one. The report pairs each such condition with its base.
 *
 * Variants of the configuration run in one process, paired task by task (`pi-conditions.ts` has the grammar):
 * `--variant-config '{"ALL2":{"syncPollBehind":true}}' --conditions eden,eden~ALL2` gives each name the settings it
 * adds over `--config`, and `eden+askDedup` is shorthand for one flag on. `--act` is a mode of its own: every
 * condition gets stub action tools (`act.ts`) and a system prompt that lets the agent act, and each task records its
 * action calls (`act-report.ts` reads them). `-act-firewall` conditions (`tools-act-firewall`, `eden-act-firewall`)
 * also turn on the engine's `actionCheck` (D69) and send each action call to `checkAction` before it runs (Pi's
 * `beforeToolCall`): a finding holds the call and is the tool's result (`heldResult`), and the same call made again
 * runs. Beside tools, Eden runs only as that check: it observes the request but injects nothing and gives no tool.
 *
 * `--cards FILE` (alias `--cards-disk`) replays implication cards from a disk cache (`cards-disk.ts`, as the funnel
 * does) and makes only the missing ones live, so the conditions of a run, and later runs, do not each pay for the same
 * enrichment. FILE is only read; new cards go to `--cards-out` (default `<out>.cards.jsonl`), which later runs replay
 * too when they name it (its cards and, as `{h, c, r}`, the intent requests a live call made). Every stream shares
 * one copy of both. `--card-sort price` routes the live card maker to OpenRouter's cheapest compliant endpoint (D66);
 * a batch cut off at its output cap is sent again with default routing.
 *
 * `--intent` (D158): with `--cards` and intent on, the checked-in requests (`intent-v2.jsonl.gz`, INTENT_COVERS in
 * cards-disk.ts) are replayed by default when they cover the run's suites and seeds; `none` replays none, a list of
 * files those. The header prints `intent: replayed n of m items` (of the items the run's sources hold) and labels a
 * run with no covering file `[intent inert: no replay]`. Before 2026-11-06 nothing was replayed unless `--intent` was
 * given, so held-out 13 Pi figures from then had requests only for the items carded live (about a third).
 *
 * Every task records a timeline on one monotonic clock (`pi-timeline.ts`): task start; Eden's observe; its slow path,
 * search, probe queries, refresh and judge (the engine's spans, `spans.ts`), each of Eden's source calls, its cache
 * hits and decisions (its traces); each model request's start, first token and end with tokens and cost; each tool
 * call; grading; task end. One JSON line per task goes to `<timeline>/tasks.jsonl`, and the process's CPU and RSS every
 * second to `<timeline>/samples.jsonl`. `pi-ab-report.ts` reads both with the results file. Each task's line also
 * records the packets the agent's requests saw, the item ids they cited, the ids `ask_context` answers cited, and the
 * task's planted item id (hidden-context suites), so a report can tell delivery from uptake.
 *
 *   OPENROUTER_API_KEY=… bun packages/sim/src/lab/pi-ab.ts [--suite heldout] [--seeds 41]
 *     [--variants hidden,control[,neutral]]
 *     [--conditions none,tools,eden,both] [--config H|'{"probes":true}'] [--model z-ai/glm-5.3-flash]
 *     [--grader anthropic/claude-haiku-5.5] [--budget 0.6] [--out pi-ab.json] [--timeline dir] [--time-scale 1]
 *     [--tool-exec parallel|sequential] [--tasks 30] [--offworld 5] [--limit n] [--dry]
 *     [--variant-config '{"name":{...}}'] [--act] [--dress] [--cards FILE [--cards-out FILE]] [--card-sort price]
 *     [--allow-logging] [--rpm 18] [--max-requests N] [--intent default|none|FILE[,FILE]]
 *     [--replay DIR [--replay-timing] [--replay-only]] [--reuse-arms earlier.json]
 *     [--recap-notice push|signal] [--noise-sources N [--noise-items 20]]
 *
 * `--replay DIR` replays the reader's and the grader's calls from DIR and appends new ones; `--reuse-arms F` copies the
 * `none` and `tools` arms from a matching earlier run instead of running them (both at their definitions below).
 *
 * `--day K --late` (A9, pi-late.ts): each request's planted item arrives right after its answer; the agent's later
 * replies that day are graded against that request (`lateFacts`).
 *
 * `--connect-at 10,45` (O5, D753; docs/research/o4-new-user.md §6): new users, in real time, as the funnel's flag of
 * the same name. Each world runs once per task and arm as a user of its own (a replica): their first event comes at
 * second 0 with nothing synced, the sync ticks as the servers' timer does (`--connect-tick-s`, 30, then every 60 s),
 * nothing waits for the backfill or the cards, and the user makes one request at each checkpoint (replica r asks
 * task (r + j) mod T at checkpoint j, so every task is asked at every checkpoint once). Replicas start
 * `--connect-stagger-s` (2) apart, at most `--connect-users` (48) at once. A replayed card call takes `--cards-ms`
 * (2,700). After their last request a user is kept until their backfill is complete or `--connect-settle-s` (200)
 * since their first event, so both arms' connector calls a user are a whole backfill's. Results carry `connectS`,
 * `sinceConnectMs`, `replica`, `warmAtRequest` and `syncedAtRequest`, and the results file `connect.users` (each
 * user's connector calls). Not with `--days`, `--day`, `--late`, `--reuse-arms` or `--world-file`;
 * `../../lab/o5/new-user-pi.py` reads it.
 *
 * `--templates a,b` runs only those hidden-context templates. Free models go through `free.ts` (above).
 *
 * --budget is a hard cap on everything this run spends (agent, Eden's judge, grader): each call reserves its
 * worst case before it is sent and is refused when that could cross the cap. --time-scale (default 1) gives the sim
 * sources their profiles' assumed latency (sources.ts REALISTIC), so Eden's on-demand sync poll and every tools
 * condition's connector calls cost what they would at that assumed speed; the timeline then shows connector time.
 * Runs before 2026-11-03 used 0 (instant connectors), which hid the poll (91% of ALL3's critical path in the funnel at
 * --time 1). Pass `--time-scale 0` only for a quality-only rerun whose latency columns nobody will read, and say so in
 * the write-up: it is faster in wall time, but probe grace (`probes.grace`) and timeouts can still shift quality
 * between 0 and 1. The header, the summary line and the results file all record the scale.
 *
 * Free models (`<model>:free`, docs/research/edge-freelab.md): every OpenRouter request of the run (agent, Eden's
 * judge and cards, grader) goes through one `Pacer` (`free.ts`): `--rpm` (default 18 a minute with a free model),
 * `--max-requests` (retries count), and 429/5xx backoff honouring Retry-After. A free model needs `--allow-logging`
 * (its endpoints log prompts; lab only). A task starts only while the cap leaves room for a whole task and its grading
 * (`MAX_STEPS` + 1 requests); once it does not, the run stops starting tasks, grades what it has, and says it is
 * partial (`partial` and `requests` in the results file).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentEvent as PiEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Model as PiModel } from "@earendil-works/pi-ai";
import { heldResult } from "@eden/client";
import {
  CardEnricher,
  ContextPartner,
  DEFAULT_CONFIG,
  ItemCache,
  ModelCardMaker,
  AskReader,
  ModelReaderMaker,
  PushChecker,
  cardKey,
  sanitizeItem,
  type CardMaker,
} from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { anthropicCost, anthropicPrice, anthropicWorstCase, Budget, priceFor, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { QueryPlanner, type ListPage, type Source } from "@eden/sources";
import { simSources, type SimSource } from "../sources";
import { noiseSources } from "./noise-sources";
import type { World } from "../world";
import {
  applyNotifyShare,
  connectorHeader,
  connectorOptions,
  parseNotifyShare,
  pushNotifier,
  recapNotice,
  sourceFields,
} from "./connector-options";
import {
  armPromptsHash,
  ASK_DESCRIPTION,
  chatModel,
  emptyResult,
  grade,
  gradeWith,
  MAX_STEPS,
  OverBudget,
  render,
  reusableArms,
  searchToolSpec,
  systemPrompt,
  TENANT_GUIDE,
  TOOL_ITEMS,
  userPrompt,
  worldOf,
  type ArmSource,
  type Background,
  type Meter,
  type RunResult,
  type Task,
} from "./ab-common";
import { variantsFor } from "./neutral";
import { ACTIONS, actionParams, coerceArgs, executed, type ActionRecord } from "./act";
import { DiskCardMaker, harnessIntent, intentCoverage, intentLine, samePath } from "./cards-disk";
import {
  anthropicThinkingOff,
  isAnthropic,
  isCapError,
  labAccess,
  labModel,
  openRouterModels,
  piModelFor,
  piRegistry,
  providerPrefs,
} from "./free";
import { parseConditions, parseVariants, type Condition } from "./pi-conditions";
import { effective, PRESETS } from "./presets";
import { costAsMade, MISS_EXIT, overBudget, overBudgetLine, ReplayModel, type Budgeted } from "./reader-disk";
import { parseSuites } from "./suites";
import { readBundle, worldFromPilot } from "../pilot/world";
import { QUESTION_CHARS, UptakeLog } from "./uptake";
import { hitsPacket } from "./lexical-hits";
import { earlierPackets, userTurnBreakpoint } from "./packet-layout";
import {
  DayLog,
  dayId,
  isRecap,
  placePackets,
  poolDays,
  shiftClocks,
  shiftMeta,
  recapOf,
  withRecaps,
  type DaySummary,
} from "./pi-day";
import { parseDaySize, parseMix, planUser, suiteTemplates, userWorldOf, withDayRecaps } from "./pi-user";
import { sanitizeForStore } from "@eden/redact";
import { loadWidenHashTable, loadWidenTable, widenByHash, widenFor, widenKey, type WidenUse } from "./n2-widen";
import { piName, spanRouter, Timeline } from "./pi-timeline";
import { holdPlanted, laterText, release, type LateEntry } from "./pi-late";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const DRY = args.includes("--dry");
// Only needed when some role runs on OpenRouter: a run with every role on `claude-*` goes to Anthropic alone (D97), and
// is checked once the models are known (`openRouterModels`, below).
const KEY = process.env.OPENROUTER_API_KEY;
const SEEDS = opt("seeds", "41").split(",").map(Number);
const MODEL = opt("model", "z-ai/glm-5.3-flash");
const GRADER = opt("grader", "anthropic/claude-haiku-5.5");
const BUDGET = Number(opt("budget", "0.6"));
// `--world-file F` (F3, D489; ../pilot/): the world and tasks are a pilot bundle (one consenting account's redacted
// import and its owner's own requests) in place of a generated user. One world, one request a session; the arms,
// agent loop, connectors' profiles and accounting are the harness's own.
const WORLD_FILE = opt("world-file", "");
const SUITE = WORLD_FILE ? "pilot" : opt("suite", "heldout");
const LOOKUPS = SUITE === "lookups";
const SUITE_LIST = WORLD_FILE ? ["pilot"] : LOOKUPS ? ["lookups"] : parseSuites(SUITE);
// `--days D` (H16, pi-user.ts): one user per seed over D days of `--day-size` requests (12-20), each day mixing
// hidden, control and neutral requests in `--mix` proportion (1:1:8); the agent's transcript resets each day, Eden
// persists. Eden's clock moves `--gap-min` minutes a request and `--night-h` hours between days (the world's now is
// fixed). 0 (the default) keeps one world per suite and variant.
const USER_DAYS = Number(opt("days", "0"));
if (!Number.isInteger(USER_DAYS) || USER_DAYS < 0) throw new Error(`--days must be a whole number, not ${USER_DAYS}`);
const DAY_SIZE = parseDaySize(opt("day-size", "12-20"));
const MIX = parseMix(opt("mix", "1:1:8"));
const GAP_MS = Number(opt("gap-min", "10")) * 60_000;
const NIGHT_MS = Number(opt("night-h", "2")) * 3_600_000;
// `--recap-notice push|signal` (A8): how the day's recap announces its moved items. `push` (the default) follows
// `--push` (D272); `signal` sends a bare `sourceChanged` whatever `--push` says, as every run before D272 did.
const RECAP_NOTICE = opt("recap-notice", "push");
if (RECAP_NOTICE !== "push" && RECAP_NOTICE !== "signal") throw new Error("--recap-notice must be push or signal");
const RECAP_SIGNAL = RECAP_NOTICE === "signal";
if (WORLD_FILE) {
  for (const f of ["suite", "days", "day", "variants", "templates", "reuse-arms", "dress", "noise-sources", "act"]) {
    if (args.includes(`--${f}`)) throw new Error(`--world-file runs the bundle's own requests: it cannot take --${f}`);
  }
  if (SEEDS.length !== 1) throw new Error("--world-file is one user: name one seed");
}
if (USER_DAYS > 0) {
  for (const f of ["day", "variants", "templates", "reuse-arms"]) {
    if (args.includes(`--${f}`)) throw new Error(`--days plans the user's requests itself: it cannot take --${f}`);
  }
  if (!(GAP_MS > 0) || !(NIGHT_MS >= 0)) throw new Error("--gap-min must be > 0 and --night-h ≥ 0");
}
// `neutral` (neutral.ts) runs only on the suites that build it; the others run their hidden and control variants.
const VARIANTS = (USER_DAYS > 0 ? "hidden,control,neutral" : opt("variants", "hidden,control")).split(",") as (
  "hidden" | "control" | "neutral"
)[];
const ACT = args.includes("--act");
// `--dress` (A6, D287): one ordinary message per person or firm a request names that no item of its world names.
const DRESS = args.includes("--dress");
if (DRESS && (USER_DAYS > 0 || args.includes("--reuse-arms"))) {
  throw new Error("--dress dresses the per-suite worlds only: not with --days or --reuse-arms");
}
const CONDITION_NAMES = opt("conditions", ACT ? "tools,eden,eden-act-firewall" : "none,tools,eden,both").split(",");
const OUT = opt("out", "pi-ab.json");
const TIMELINE = opt("timeline", `${OUT.replace(/\.json$/, "")}.timeline`);
const TIME_SCALE = Number(opt("time-scale", "1"));
// `--source-profile`, `--push`, `--push-rates` (connector-options.ts).
const CONNECTORS = connectorOptions(opt);
const TOOL_EXEC = opt("tool-exec", "parallel") as "parallel" | "sequential";
const LIMITS = { maxTasks: Number(opt("tasks", "30")), maxOffworld: Number(opt("offworld", "5")) };
// The first N tasks of each world only: a plumbing check before a real run.
const LIMIT = Number(opt("limit", "0"));
// `--day K` (pi-day.ts): one agent session and one Eden session per K requests, the world changing between them, and
// a recap turn closing each day; 0 (the default) is one session per request.
const DAY = Number(opt("day", "0"));
if (!Number.isInteger(DAY) || DAY < 0) throw new Error(`--day must be a whole number of requests, not ${DAY}`);
// `--noise-sources N` (A21): N unrelated connectors beside the world's five in Eden's arms only (`noise-sources.ts`,
// `--noise-items` items each, default 20), as the funnel's flag (A1): a user with ~1,000 connected sources. The tools
// arm keeps the world's sources (its agent's tools); every connector call Eden makes, noise ones too, is counted.
const NOISE_SOURCES = Number(opt("noise-sources", "0"));
// `--notify-share P` (N1, `applyNotifyShare`): the share of connectors that send change notifications.
const NOTIFY_SHARE = parseNotifyShare(opt("notify-share", ""));
const NOISE_ITEMS = Number(opt("noise-items", "20"));
// `--noise-vocab N` (O1): each noise connector gets N words of its own, as the funnel's flag.
const NOISE_VOCAB = Number(opt("noise-vocab", "0"));
if (!Number.isInteger(NOISE_SOURCES) || NOISE_SOURCES < 0 || !Number.isInteger(NOISE_ITEMS) || NOISE_ITEMS < 1)
  throw new Error("--noise-sources and --noise-items take whole numbers (--noise-items at least 1)");
// `--connect-at` (O5): see the header.
const CONNECT_AT = opt("connect-at", "")
  .split(",")
  .filter((x) => x !== "")
  .map(Number);
if (CONNECT_AT.some((x) => !(x >= 0))) throw new Error("--connect-at takes seconds, each at least 0");
const CONNECT = CONNECT_AT.length > 0;
const CONNECT_TICK_S = Number(opt("connect-tick-s", "30"));
const CONNECT_STAGGER_S = Number(opt("connect-stagger-s", "2"));
const CONNECT_USERS = Number(opt("connect-users", "48"));
const CONNECT_SETTLE_S = Number(opt("connect-settle-s", "200"));
const CARDS_MS = Number(opt("cards-ms", CONNECT ? "2700" : "0"));
if (CONNECT && (DAY > 0 || USER_DAYS > 0 || WORLD_FILE || args.includes("--late") || opt("reuse-arms", ""))) {
  throw new Error("--connect-at runs new users: not with --days, --day, --late, --reuse-arms or --world-file");
}
/** `--connect-at`: each user's connector calls (every call Eden made for them) and what they held at the end. */
const connectUsers: {
  seed: number;
  suite: string;
  kind: string;
  condition: string;
  replica: number;
  sourceCalls: number;
  warmS: number | null;
}[] = [];
/** Either day mode: `--day K` (fixed days per suite and variant) or `--days D` (a user's mixed days). */
const DAYS_ON = DAY > 0 || USER_DAYS > 0;
// `--late` (A9, pi-late.ts): each request's planted item arrives right after the agent answers it; what the agent
// says later that day is graded against that request (`lateFacts`).
const LATE = args.includes("--late");
if (LATE && DAY === 0) throw new Error("--late needs --day K (fixed days per suite and variant)");
/** Each day's summary, with the recap turn's own cost (a probe: no task's cost includes it). */
const DAYS: (DaySummary & {
  seed: number;
  kind: string;
  partial?: boolean;
  recapUsd?: number;
  recapEdenUsd?: number;
})[] = [];
// `--templates a,b`: only the hidden-context tasks of these templates (both variants), for a small targeted smoke.
const TEMPLATES = opt("templates", "") ? new Set(opt("templates", "").split(",")) : null;

const CONFIG_ARG = opt("config", "{}");
const CONFIG = PRESETS[CONFIG_ARG] ?? (JSON.parse(CONFIG_ARG) as Record<string, unknown>);
// `cards` makes implication cards with a model in the background (D59), metered and charged to Eden's spend.
const CARD_MODEL = opt("card-model", "z-ai/glm-5.3-flash");
const CARD_SORT = opt("card-sort", "");
if (CARD_SORT && CARD_SORT !== "price") throw new Error("--card-sort must be price");
const CONFIG_VARIANTS = parseVariants(opt("variant-config", "{}"));
// Every condition is parsed before anything is spent: a typo fails here, not after the first stream has run.
const CONDITIONS: Condition[] = parseConditions(CONDITION_NAMES, {
  config: CONFIG,
  variants: CONFIG_VARIANTS,
  act: ACT,
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
});
// D336's layouts differ only where a session holds several requests; on one request they would rerun `eden`.
if (!DAYS_ON && CONDITIONS.some((c) => c.packets !== "kept")) {
  throw new Error("+ephemeral and +ephemeralBp change how earlier requests' packets are kept: use --days or --day");
}
/** `askReader` (D95): the ask-time reader's model, `--reader-model` (default Haiku 5.5, on the spend ledger). */
const READER_MODEL = opt("reader-model", "claude-haiku-5-5");
const USES_READER = CONDITIONS.some((c) => c.withPartner && !c.noKey && effective(c.config).askReader);
/** `pushCheck` (I3, D500): the push check's model, `--check-model` (default Haiku 5.5, on the spend ledger). */
const CHECK_MODEL = opt("check-model", "claude-haiku-5-5");
const USES_CHECK = CONDITIONS.some((c) => c.withPartner && !c.noKey && effective(c.config).pushCheck);
/**
 * `--widen-table FILE` (N2, D511): the `widen` dependency of an arm with `pushWiden` (`n2-widen.ts`), the embedding's
 * nearest items per (suite, seed, variant, request) of the funnel's worlds, which one-request-a-session worlds are
 * (`worldOf`). A `--days` user's world is not in it: there the embedding route finds nothing.
 */
const WIDEN_TABLE = opt("widen-table", "") ? loadWidenTable(opt("widen-table", "")) : null;
/** `--widen-hash FILE` (N5, D530): the same table keyed by item content, so a `--days` user's world is covered too. */
const WIDEN_HASH = opt("widen-hash", "") ? loadWidenHashTable(opt("widen-hash", "")) : null;
if (WIDEN_TABLE && WIDEN_HASH) throw new Error("--widen-table and --widen-hash are two forms of one table: pass one");
const widenUse: WidenUse = { asked: 0, found: 0, hashes: 0, held: 0 };
/** Every stream's push checker, for the run's CHECK line. */
const checkers: PushChecker[] = [];
// Every model a role of this run calls, once: the pacer and spend ledger are set up for them, and the key check below
// reads the same list, so a role added here cannot go unchecked.
const RUN_MODELS = [
  MODEL,
  GRADER,
  ...(CONDITIONS.some((c) => c.withPartner && !c.noKey && effective(c.config).cards) ? [CARD_MODEL] : []),
  ...(USES_READER ? [READER_MODEL] : []),
  ...(USES_CHECK ? [CHECK_MODEL] : []),
];
// A pilot bundle is a real person's data (D489): every role on Anthropic's API under the owner's key, never the lab's
// OpenRouter route (it does not pin D12's no-retention endpoints) and never a logging endpoint. `pilot run` passes
// claude-* ids for every role; this holds for a direct `pi-ab --world-file` too.
if (WORLD_FILE) {
  const routed = openRouterModels(RUN_MODELS);
  if (routed.length) throw new Error(`--world-file sends real data: claude-* models only, not ${routed.join(", ")}`);
  if (args.includes("--allow-logging")) throw new Error("--world-file sends real data: it cannot take --allow-logging");
}
// Every OpenRouter request of the run goes through one pacer: rate, cap, retries, and the logging choice (free.ts).
const ACCESS = labAccess(args, RUN_MODELS);
const PACER = ACCESS.pacer;
// A flag whose dependency this harness cannot give it would run a different configuration under the flag's name: a
// run that says R or ALL must be R or ALL (the review of moon/combined). Cards need a model, so a role on OpenRouter
// needs its key; one on Anthropic uses HAIKU_API_KEY (keyFor).
const OPENROUTER_ROLES = openRouterModels(RUN_MODELS);
if (OPENROUTER_ROLES.length && !KEY && !DRY)
  throw new Error(`${OPENROUTER_ROLES.join(", ")}: needs OPENROUTER_API_KEY`);
/** A task starts only while the cap leaves room for all of it: its model requests and its grading. */
const TASK_REQUESTS = MAX_STEPS + 1;
let capStopped = 0;
// Cards replayed from disk: the replay file is only read, new cards go to their own file (cards-disk.ts).
const CARDS_FILE = opt("cards", opt("cards-disk", ""));
/**
 * `--cards-calls N` (F2): each stream's enrichment gets N card calls; items past them stay uncovered. With
 * `cardsLanes` K (N4) a stream gets N × K: the calls K lanes have made when one lane has made N.
 */
const CARDS_CALLS = Number(opt("cards-calls", "-1"));
const CARDS_OUT = opt("cards-out", `${OUT.replace(/\.json$/, "")}.cards.jsonl`);
// Compared as files, not strings: `./a.cards.jsonl` or a symlink must not send new cards into the replay file.
if (CARDS_FILE && samePath(CARDS_OUT, CARDS_FILE)) {
  throw new Error(`--cards-out ${CARDS_OUT} is the replayed --cards file: give new cards their own file`);
}
// A mistyped replay path would otherwise make every card live, at the run's expense.
if (CARDS_FILE && !existsSync(CARDS_FILE)) throw new Error(`--cards ${CARDS_FILE}: no such file`);
/**
 * One copy of the disk cards for every stream: read once, each stream sees the cards the others made, and a card
 * another stream is making now is waited for rather than made twice.
 */
// The intent requests (D158): with cards replayed the card model writes requests only for the items it cards live,
// so the checked-in requests are replayed by default where they cover the run, as the funnel does (`--intent none`
// opts out; a list of files replays those). A run they do not cover is labelled intent inert in its header.
const INTENT_WANTED = CONDITIONS.some(
  (c) => c.withPartner && !c.noKey && effective(c.config).intent && effective(c.config).cards,
);
const INTENT = harnessIntent(opt("intent", "default"), {
  wanted: INTENT_WANTED,
  cardsReplayed: !!CARDS_FILE,
  suites: SUITE_LIST,
  seeds: SEEDS,
});
const INTENT_FILES = INTENT.files;
if (INTENT_FILES.length && !CARDS_FILE) throw new Error("--intent needs --cards");
for (const f of INTENT_FILES) if (!existsSync(f)) throw new Error(`--intent ${f}: no such file`);
const diskCards = CARDS_FILE
  ? new DiskCardMaker(CARDS_FILE, undefined, {
      out: CARDS_OUT,
      requests: INTENT_FILES,
      // No requests file: no replayed requests at all, not the `r` lines an earlier run left in --cards-out.
      cardRequests: INTENT_FILES.length > 0,
    })
  : null;

/** `--replay`'s counts per role, as the results file and the spend line give them. */
const replaySummary = () =>
  Object.fromEntries(
    (
      [
        ["reader", readerReplay],
        ["grader", graderReplay],
      ] as const
    )
      .filter(([, m]) => m)
      .map(([role, m]) => [role, { replayed: m!.replayed, live: m!.sent, missed: m!.missed, failed: m!.failed }]),
  );
const replayLine = () =>
  `replay ${Object.entries(replaySummary())
    .map(([role, c]) => `${role} ${c.replayed} replayed / ${c.live} live${c.missed ? ` / ${c.missed} MISSED` : ""}`)
    .join(", ")}`;
/** The Pi agent loop this harness runs: part of every replay key and of `--reuse-arms`'s match. */
const HARNESS_VERSION = "@earendil-works/pi-agent-core@1.3.0";
/**
 * `--replay DIR`: the reader's and the grader's calls are kept in `DIR/reader.jsonl` and `DIR/grader.jsonl`
 * (`ReplayModel`, reader-disk.ts) under a key of the exact prompt, the model id, the harness version, the provider
 * preferences and the role: a call made before is replayed at no cost, a new one is made live and appended. The agent
 * itself still runs live. `--replay-timing` sleeps each replayed call's recorded latency, so the critical path stands
 * for a live run's; without it replayed calls take no time. `--replay-only` makes nothing live: a call with no line is
 * a miss (the reader then fails open, the grade is left ungraded) and the run exits 3 after writing its results.
 * Replay freezes one sample per prompt: paired comparisons are sound (common random numbers), but a run-to-run
 * variance estimate needs `--replay` off.
 */
const REPLAY_DIR = opt("replay", "");
const REPLAY_TIMING = args.includes("--replay-timing");
const REPLAY_ONLY = args.includes("--replay-only");
if ((REPLAY_TIMING || REPLAY_ONLY) && !REPLAY_DIR) throw new Error("--replay-timing and --replay-only need --replay");
if (REPLAY_DIR) mkdirSync(REPLAY_DIR, { recursive: true });
const replaySalt = (role: string) => ({ role, harness: HARNESS_VERSION, provider: providerPrefs(ACCESS) });
const readerReplay =
  REPLAY_DIR && USES_READER
    ? new ReplayModel(
        join(REPLAY_DIR, "reader.jsonl"),
        REPLAY_ONLY
          ? null
          : labModel(ACCESS, { apiKey: KEY ?? "", model: READER_MODEL, timeoutMs: 60_000 }, "eden.reader"),
        READER_MODEL,
        { salt: replaySalt("eden.reader"), timing: REPLAY_TIMING },
      )
    : null;
const checkReplay =
  REPLAY_DIR && USES_CHECK
    ? new ReplayModel(
        join(REPLAY_DIR, "check.jsonl"),
        REPLAY_ONLY
          ? null
          : labModel(ACCESS, { apiKey: KEY ?? "", model: CHECK_MODEL, timeoutMs: 60_000 }, "eden.check"),
        CHECK_MODEL,
        { salt: replaySalt("eden.check"), timing: REPLAY_TIMING },
      )
    : null;
const graderReplay = REPLAY_DIR
  ? new ReplayModel(
      join(REPLAY_DIR, "grader.jsonl"),
      REPLAY_ONLY
        ? null
        : isAnthropic(GRADER)
          ? labModel(ACCESS, { apiKey: "", model: GRADER }, "grader")
          : chatModel(KEY ?? "", GRADER, { fetch: ACCESS.fetch, allowLogging: ACCESS.allowLogging }),
      GRADER,
      { salt: replaySalt("grader"), timing: REPLAY_TIMING },
    )
  : null;
/**
 * `--reuse-arms F`: the arms Eden takes no part in (`none`, `tools`: no partner, no `--act`) are copied from the
 * results file F (and its timeline's lines) instead of run again, when F's run matches this one (`reusableArms` in
 * ab-common.ts lists what must match, and refuses with the reason otherwise). Nothing is spent on them; the report
 * reads them as F recorded them.
 */
const REUSE_FILE = opt("reuse-arms", "");
if (REUSE_FILE && DAY > 0) throw new Error("--reuse-arms copies single-request arms: it cannot stand in for --day");
if (REUSE_FILE && !existsSync(REUSE_FILE)) throw new Error(`--reuse-arms ${REUSE_FILE}: no such file`);

// ---- Spend: one hard cap over every call, reserved before the call at its worst case and settled at its real cost.
let spent = 0;
let held = 0;
const spend = { agent: 0, eden: 0, grader: 0 };
/** Every lane's reader and cards, for the calls their `Budget()` refused (the summary's `overBudget:` line). */
const budgeted: Budgeted = { reader: [], cards: [] };
/** Each stream's background spend (cards), for the report's all-in cost columns. */
const background: Background[] = [];
/** Reserves `est` dollars, or throws `OverBudget` when that could take the run past `--budget`. */
function reserve(est: number): void {
  if (spent + held + est > BUDGET) throw new OverBudget(`budget $${BUDGET} reached (spent $${spent.toFixed(4)})`);
  held += est;
}
function settle(est: number, cost: number, who: keyof typeof spend): void {
  held = Math.max(0, held - est);
  spent += cost;
  spend[who] += cost;
}
/** A call's worst case: its input (≈4 characters a token) and its whole output allowance, at the list price. */
const worstCase = (model: string, inputChars: number, maxTokens: number) => {
  const p = priceFor(model);
  return (Math.ceil(inputChars / 4) * p.input + maxTokens * p.output) / 1_000_000;
};
const exhausted = () => spent + held >= BUDGET * 0.98;

// ---- Pi: the agent's model on OpenRouter, through pi-ai's OpenAI-compatible chat completions.
const AGENT_MAX_TOKENS = 2_000;
const piModel = piModelFor(MODEL, AGENT_MAX_TOKENS);
const models = piRegistry([piModel]);
/** A `claude-*` agent is Anthropic's API: each request is reserved in and booked to the campaign's spend ledger. */
const AGENT_ANTHROPIC = isAnthropic(MODEL);
const AGENT_METER = AGENT_ANTHROPIC ? ACCESS.ledger!.meter("agent") : null;
/** A `claude-*` grader goes through `AnthropicModel` on the ledger; any other through OpenRouter (`grade`). */
const GRADER_MODEL = isAnthropic(GRADER) ? labModel(ACCESS, { apiKey: "", model: GRADER }, "grader") : null;

// ---- Per-second process samples: CPU (of one core) and memory, with how many tasks and requests are in flight.
let activeTasks = 0;
let activeRequests = 0;
const runStart = performance.now();
const startSampling = (file: string) => {
  let last = process.cpuUsage();
  let lastAt = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage(last);
    last = process.cpuUsage();
    const m = process.memoryUsage();
    appendFileSync(
      file,
      `${JSON.stringify({
        t: Math.round(now - runStart),
        cpuPct: Math.round(((cpu.user + cpu.system) / 1_000 / (now - lastAt)) * 1_000) / 10,
        userMs: Math.round(cpu.user / 1_000),
        systemMs: Math.round(cpu.system / 1_000),
        rssMb: Math.round(m.rss / 1e5) / 10,
        heapMb: Math.round(m.heapUsed / 1e5) / 10,
        tasks: activeTasks,
        requests: activeRequests,
        spent: Number(spent.toFixed(5)),
      })}\n`,
    );
    lastAt = now;
  }, 1_000);
  timer.unref();
  return () => clearInterval(timer);
};

/** A source as Eden sees it: the same connector (state, rate limits, faults), each call timed onto `onCall`. */
function watched(
  source: SimSource,
  onCall: (sourceId: string, op: string, start: number, end: number, status: string, items: number) => void,
): Source {
  const timed = async <T>(op: string, run: () => Promise<T>, count: (x: T) => number): Promise<T> => {
    const start = performance.now();
    try {
      const out = await run();
      onCall(source.id, op, start, performance.now(), "ok", count(out));
      return out;
    } catch (e) {
      onCall(source.id, op, start, performance.now(), e instanceof Error ? e.name : "error", 0);
      throw e;
    }
  };
  return {
    ...sourceFields(source),
    search: (query, signal) =>
      timed(
        "search",
        () => source.search(query, signal),
        (items: ContextItem[]) => items.length,
      ),
    fetch: (ref, scope, signal) =>
      timed(
        "fetch",
        () => source.fetch(ref, scope, signal),
        (item: ContextItem | null) => (item ? 1 : 0),
      ),
    // The sync (D57) reads sources through their list tools: without this a `sync` run never warms.
    list: (scope, cursor, limit, signal) =>
      timed(
        "list",
        () => source.list(scope, cursor, limit, signal),
        (page: ListPage) => page.items.length,
      ),
  };
}

/** Eden's judge as the engine sees it: reserved against the run's cap, timed and costed onto `onCall`. */
function meteredModel(
  inner: Model,
  onCall: (start: number, end: number, data: Record<string, unknown>) => void,
): Model {
  return {
    id: inner.id,
    async chat(request) {
      const chars = request.messages.reduce((n, m) => n + m.content.length, 0);
      const est = worstCase(inner.id, chars, request.maxTokens);
      reserve(est);
      const start = performance.now();
      let cost = 0;
      try {
        const res = await inner.chat(request);
        cost = res.costUsd;
        onCall(start, performance.now(), {
          in: res.usage.inputTokens,
          out: res.usage.outputTokens,
          cost: res.costUsd,
          truncated: !!res.truncated,
        });
        return res;
      } catch (e) {
        onCall(start, performance.now(), { error: e instanceof Error ? e.name : "error" });
        throw e;
      } finally {
        settle(est, cost, "eden");
      }
    },
  };
}

/** The tool parameter every search tool and `ask_context` takes: one string, as agent-ab declares it. */
const queryParams = Type.Object({ query: Type.String({ description: "What to search for" }) });
// What the Eden-free arms see and how they are graded, recorded with the results so `--reuse-arms` can check it.
/** `--tenant-prompt` (A3, D271): the tenant's house rules (`TENANT_GUIDE`) in every arm's system prompt. */
const TENANT_PROMPT = args.includes("--tenant-prompt");
const PROMPTS_HASH = armPromptsHash(
  TENANT_PROMPT ? { queryParams, tenant: TENANT_GUIDE } : { queryParams },
  VARIANTS.includes("neutral"),
);
const askParams = Type.Object({ question: Type.String() });

/**
 * A model whose calls are charged to the task that started them (`owner()` read when the call starts): a call that
 * outlives its ask's wait lands after that task ended, and must not be charged to the next one.
 */
function ownedModel(inner: Model, owner: () => RunResult | null): Model {
  return {
    id: inner.id,
    async chat(request) {
      const r = owner();
      const res = await inner.chat(request);
      if (r) {
        r.edenModelCalls++;
        // A replayed call is charged at its cost as made (the run spends nothing on it): a replayed run's per-task
        // cost reads as the live run's did.
        r.edenCostUsd += costAsMade(res);
      }
      return res;
    },
  };
}

/** What a task records beside its result: its timeline and the per-request detail. */
interface TaskRecord {
  task: string;
  condition: string;
  suite: string;
  kind: Task["kind"];
  seed: number;
  wallMs: number;
  /** The first model request's time to first token, ms (streamed). */
  firstTokenMs: number | null;
  requests: {
    startMs: number;
    firstTokenMs: number | null;
    endMs: number;
    in: number;
    out: number;
    cost: number;
    /** Of `in`, the tokens the endpoint read from its prompt cache (billed at its cache-read price). */
    cached?: number;
    /** Of `in`, the tokens written to the prompt cache (Anthropic: billed at 1.25x input). */
    cacheWrite?: number;
    /** A16: the reply's visible text (characters) and its tool calls, so a report can split a turn's output. */
    textChars?: number;
    calls?: number;
    /** A16: the text of a reply that called a tool (sim data, first `SAY_CHARS`): what the agent says before asking. */
    say?: string;
  }[];
  events: Timeline["events"];
  dropped: number;
  error?: string;
  /** The task's planted item (hidden-context suites): the hidden fact, or the control's decoy. */
  planted?: string;
  /** Eden's proactive packets as the agent's requests saw them, joined (cut at 6,000 characters). */
  packets?: string;
  /** The items those packets cited, and those `ask_context` answers cited: did the planted one reach the agent. */
  cited?: string[];
  askCited?: string[];
}

const textOf = (m: AgentMessage | undefined) =>
  m && m.role === "assistant"
    ? m.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("")
    : "";

/** A16: how much of a tool turn's text a timeline keeps (sim data). */
const SAY_CHARS = 400;

/** A16: a reply's shape for the timeline: its text's length, its tool calls and, when it called one, its text. */
function turnShape(m: AgentMessage): { textChars: number; calls: number; say?: string } {
  if (m.role !== "assistant") return { textChars: 0, calls: 0 };
  const text = textOf(m);
  const calls = m.content.filter((c) => c.type === "toolCall").length;
  return { textChars: text.length, calls, ...(calls && text ? { say: text.slice(0, SAY_CHARS) } : {}) };
}

/** One world under one condition: a fresh Eden (if any) sees the world's tasks in order, as in agent-ab. */
async function runWorld(
  shared: World,
  seed: number,
  baseTasks: Task[],
  cond: Condition,
  records: TaskRecord[],
  grading: Promise<void>[],
  /** `--days`: the user's requests per day, in order. */
  daySizes?: readonly number[],
  /** `--connect-at`: which of the world's users this stream is, of how many, and when they connect (`now()`'s ms). */
  connect?: { replica: number; replicas: number; startAt: number },
): Promise<RunResult[]> {
  if (connect) await Bun.sleep(Math.max(0, connect.startAt - performance.now()));
  // `--day` changes items during the run: each stream gets its own copy of them, since every condition's stream reads
  // the same world concurrently.
  const world: World = DAYS_ON ? { ...shared, items: shared.items.map((i) => ({ ...i })) } : shared;
  // `--late`: the planted items are not at their sources until their requests are answered.
  const lateHeld = LATE ? holdPlanted(world, baseTasks) : null;
  let dayLate: { entry: LateEntry; r: RunResult }[] = [];
  const userPrefix = `w${seed}:user`;
  const tasks = connect
    ? CONNECT_AT.map((_, j) => baseTasks[(connect.replica + j) % baseTasks.length]!)
    : daySizes
      ? withDayRecaps(baseTasks, daySizes, (t, d) => recapOf(t, `${userPrefix}:day${d}:recap`))
      : DAY > 0
        ? withRecaps(baseTasks, DAY)
        : baseTasks;
  const sources = simSources(world, CONNECTORS.profiles, TIME_SCALE, seed);
  const notify = pushNotifier(sources, CONNECTORS, seed, world.now);
  const {
    name: condition,
    waitMs,
    useEden,
    withPartner,
    useTools,
    askTool,
    judge,
    act,
    firewall,
    config,
    noKey,
    packets: layout,
    hits,
  } = cond;
  const scope = { tenantId: "ab", userId: connect ? `w${seed}r${connect.replica}` : `w${seed}` };
  let clock = world.now;
  // The task now running in this stream: Eden's source and model calls carry no session, so they go to its timeline.
  let current: Timeline | null = null;
  const bySession = new Map<string, { r: RunResult; tl: Timeline }>();
  // Every connector call Eden makes in this stream, in a task's window or not (the backfill, the sync's ticks between
  // tasks): `Background.sourceCalls`, priced per connector plan by pi-cost-report.ts.
  let edenCalls = 0;
  const noise =
    NOISE_SOURCES > 0 && cond.withPartner
      ? noiseSources(world, NOISE_SOURCES, NOISE_ITEMS, TIME_SCALE, seed, NOISE_VOCAB)
      : [];
  // `--notify-share P` (N1): only that share of the connectors notify; the rest are polled and swept.
  applyNotifyShare([...sources, ...noise], NOTIFY_SHARE, seed);
  const edenSources = [...sources, ...noise].map((s) =>
    watched(s, (id, op, start, end, status, items) => {
      edenCalls++;
      bg.sourceCalls = edenCalls;
      current?.span("eden.source", "eden", "bg", start, end, { source: id, op, status, items });
    }),
  );
  // What this stream's background calls (cards) cost: booked to Eden's total, charged to no task (Background).
  // Recorded in the results as the calls happen (below), so a stream that stops early (OverBudget, the request cap)
  // still reports what its cards spent. `bridgeUsd` stays 0: the format earlier runs' results share.
  const bg: Background = {
    seed,
    suite: tasks[0]?.suite ?? "",
    condition,
    tasks: [],
    cardsUsd: 0,
    bridgeUsd: 0,
    calls: 0,
  };
  const onBg = (what: "cardsUsd", data: Record<string, unknown>) => {
    bg.calls++;
    bg[what] += typeof data.cost === "number" ? data.cost : 0;
  };
  // `cards`: the enrichment model, metered against the run's cap and booked to Eden's spend like its judge.
  const cardModel = (sort: "" | "price") =>
    meteredModel(
      labModel(ACCESS, { apiKey: KEY!, model: CARD_MODEL, ...(sort ? { sort } : {}) }, "eden.cards"),
      (start, end, data) => {
        onBg("cardsUsd", data);
        current?.span("eden.cards", "eden", "bg", start, end, data);
      },
    );
  // `--card-sort price` (D66): a batch cut off at the cap is sent again with default routing.
  const liveCards = (): CardMaker =>
    CARD_SORT ? new ModelCardMaker(cardModel("price"), { retry: cardModel("") }) : new ModelCardMaker(cardModel(""));
  // With `--cards`, cards on disk are replayed and only the rest made live (their spend booked to Eden as usual).
  const cardMaker = (): CardMaker =>
    diskCards ? new DiskCardMaker(CARDS_FILE, liveCards(), { out: CARDS_OUT, shared: diskCards }) : liveCards();
  // `--cards-calls N` (F2, D483): each stream's card model answers its first N calls and leaves the rest uncovered
  // (no call, no spend), as a new user's first requests meet a backfill the enrichment has only begun.
  const cappedMaker = (): CardMaker => {
    const maker = cardMaker();
    if (CARDS_CALLS < 0) return maker;
    // N4 (`cardsLanes`, D521): the cap stands for a moment in a new user's backfill, so a stream whose enricher
    // has K lanes has made K times the calls by then.
    const cap = CARDS_CALLS * Math.max(1, effective(config).cardsLanes);
    let calls = 0;
    return {
      make: (items, today, signal, retry, intent) =>
        calls++ < cap
          ? maker.make(items, today, signal, retry, intent)
          : Promise.resolve({ cards: items.map(() => null), costUsd: 0 }),
    };
  };
  // `--cards-ms`: a card call takes this long, as a model's does (a replayed card otherwise answers at once, and a
  // new user's cards would be in before their first request).
  const timedMaker = (): CardMaker => {
    const maker = cappedMaker();
    if (CARDS_MS <= 0) return maker;
    return {
      make: (items, today, signal, retry, intent) =>
        Bun.sleep(CARDS_MS).then(() => maker.make(items, today, signal, retry, intent)),
    };
  };
  const cards =
    // `+nokey` (D291): a server with no model key builds no card enricher and no reader (models.ts NO_MODELS).
    withPartner && !noKey && effective(config).cards
      ? new CardEnricher({ maker: timedMaker(), budget: new Budget(), now: () => clock })
      : undefined;
  if (cards) budgeted.cards.push(cards);
  // A stream with Eden but no cards (`+nokey`, D291) is booked too, for its connector calls (the backfill, ticks); it
  // has no model spend, and `noModels` keeps it out of the card backfill each seed's model reports spread.
  if (cards) background.push(bg);
  else if (withPartner) {
    bg.noModels = true;
    background.push(bg);
  }
  // `askReader`: one budgeted call per ask about an action, on the running task's timeline and charged to it (D95).
  let readerTask: RunResult | null = null;
  const reader =
    withPartner && !noKey && effective(config).askReader
      ? new AskReader({
          maker: new ModelReaderMaker(
            meteredModel(
              ownedModel(
                // `--replay`: one replay cache for every stream (a prompt made by one is replayed by the others).
                readerReplay ??
                  labModel(ACCESS, { apiKey: KEY ?? "", model: READER_MODEL, timeoutMs: 60_000 }, "eden.reader"),
                () => readerTask,
              ),
              (start, end, data) => current?.span("eden.reader", "eden", "path", start, end, data),
            ),
          ),
          budget: new Budget(),
          now: () => clock,
        })
      : undefined;
  if (reader) budgeted.reader.push(reader);
  // `pushCheck` (I3, D500): one budgeted call per push whose pool is constraint-like, charged to the running task.
  const checker =
    withPartner && !noKey && effective(config).pushCheck
      ? new PushChecker({
          model: meteredModel(
            ownedModel(
              checkReplay ??
                labModel(ACCESS, { apiKey: KEY ?? "", model: CHECK_MODEL, timeoutMs: 60_000 }, "eden.check"),
              () => readerTask,
            ),
            (start, end, data) => current?.span("eden.check", "eden", "path", start, end, data),
          ),
          budget: new Budget(),
        })
      : undefined;
  if (checker) checkers.push(checker);
  // `--widen-hash` (N5): the world's items as the cache holds them, by content (the card key's head).
  let held: ReturnType<typeof sanitizeItem>[] | null = null;
  const worldItems = () => (held ??= sources.flatMap((src) => src.listAll()).map((raw) => sanitizeItem(raw)));
  let byHash: Map<string, string> | null = null;
  const idOf = (hash: string) =>
    (byHash ??= new Map(worldItems().map((it) => [cardKey(it).slice(0, 20), it.id] as const))).get(hash);
  const variantOf = new Map(baseTasks.map((t) => [widenKey(sanitizeForStore(t.text)), t.kind as string]));
  const itemCache = new ItemCache();
  const sourceMap = new SourceMap(":memory:", { seed });
  const partner = withPartner
    ? new ContextPartner({
        sources: async () => edenSources,
        sourceMap,
        cache: itemCache,
        budget: new Budget(),
        model: judge
          ? meteredModel(labModel(ACCESS, { apiKey: KEY!, model: MODEL }, "eden.judge"), (start, end, data) =>
              current?.span("eden.model", "eden", "bg", start, end, data),
            )
          : null,
        planner: new QueryPlanner({ seed }),
        now: () => clock,
        config,
        ...(cards ? { cards } : {}),
        ...(reader ? { reader } : {}),
        ...(checker ? { checker } : {}),
        ...(WIDEN_TABLE && baseTasks[0]
          ? { widen: widenFor(WIDEN_TABLE, baseTasks[0].suite, seed, baseTasks[0].kind) }
          : WIDEN_HASH
            ? { widen: widenByHash(WIDEN_HASH, seed, idOf, (request) => variantOf.get(request), widenUse) }
            : {}),
        // Charged to the task whose session the trace is from: a slow-path verdict can land after it ended.
        onTrace: (t) => {
          const owner = bySession.get(t.sessionId);
          if (!owner) return;
          // The reader's part is charged by `ownedModel` (a late call too), so it is not counted again here.
          // So is the push check's (D500).
          owner.r.edenModelCalls += t.modelCalls - (t.readerCalls ?? 0) - (t.checkCalls ?? 0);
          owner.r.edenCostUsd += t.costUsd - (t.readerCostUsd ?? 0) - (t.checkCostUsd ?? 0);
          owner.tl.point(t.decision === "fast" ? "eden.cache-hit" : "eden.decision", {
            decision: t.decision,
            event: t.event,
            sourceCalls: t.sourceCalls,
            modelCalls: t.modelCalls,
            latencyMs: t.latencyMs,
            items: t.itemIds.length,
          });
        },
        onSpan: spanRouter((session, sp) => {
          const name = piName(sp);
          if (!name) return;
          // The engine stamps spans as `performance.timeOrigin + performance.now()`; the timeline reads `now()`.
          const start = sp.startMs - performance.timeOrigin;
          const end = sp.endMs - performance.timeOrigin;
          const calls = sp.attrs?.calls;
          const data = calls === undefined ? undefined : { calls };
          bySession.get(session)?.tl.span(`eden.${name}`, "eden", "bg", start, end, data);
        }),
      })
    : null;
  // `sync`: the user's sources are backfilled before the first task, as a long-running sync would have them, and the
  // sync ticks once per task (an hour of the world's clock). Cards for what it stored are made before tasks start.
  const sync = partner?.sync ?? null;
  // `--connect-at`: the user's first event is now; the clock runs with the wall from here and the sync ticks as the
  // servers' timer does. Nothing is waited for.
  const connectedAt = performance.now();
  const timers: ReturnType<typeof setInterval>[] = [];
  let warmS: number | null = null;
  if (connect) {
    const start = clock;
    const wall = () => (clock = start + (performance.now() - connectedAt));
    timers.push(
      setInterval(() => {
        wall();
        if (warmS === null && sync?.warm(scope)) warmS = (performance.now() - connectedAt) / 1_000;
      }, 100),
    );
    if (partner) {
      await partner.observe({ ...scope, sessionId: "connect", at: clock, kind: "session_start" } as AgentEvent);
    }
    if (sync) {
      const tick = () => {
        wall();
        void sync.tick();
      };
      timers.push(
        setTimeout(() => {
          tick();
          timers.push(setInterval(tick, 60_000));
        }, CONNECT_TICK_S * 1_000),
      );
    }
  } else if (sync) {
    // As the simulation does: the backfill runs from half an hour before the first task, a minute per tick (the
    // sync's own per-source budget paces it), and the tasks then start on the same clock as without it.
    const start = clock;
    clock -= 30 * 60_000;
    sync.track(scope, clock);
    for (let i = 0; i < 120 && !sync.warm(scope); i++) {
      await sync.tick();
      clock += 60_000;
    }
    clock = start;
    if (!sync.warm(scope))
      throw new Error(`sync never warmed for ${scope.userId}: a run without it is not this config`);
  }
  if (cards && !connect) await cards.idle();
  // What the backfill's enrichment cost before the first request (one-time per user, H16): the rest of the stream's
  // background spend is made while the user works (new and changed items).
  bg.setupUsd = bg.cardsUsd;
  bg.setupCalls = bg.calls;
  bg.setupSourceCalls = edenCalls;
  bg.sourceCalls = edenCalls;
  const out: RunResult[] = [];
  let previous: { sessionId: string; r: RunResult } | null = null;
  const closePrevious = async () => {
    if (!partner || !previous) return;
    const who = { ...scope, sessionId: previous.sessionId };
    // Late items reach the agent only where Eden delivers; beside tools-act-firewall they are drained, not counted.
    const late = partner.takePending(who).reduce((n, i) => n + i.citations.length, 0);
    previous.r.lateItems = useEden ? late : 0;
    await partner.observe({ ...who, at: clock, kind: "session_end" });
    previous = null;
  };
  // `--day`: the day's log, the agent's transcript so far, and each earlier turn's packets; a new day starts after a
  // recap (and at the first task).
  let day: DayLog | null = null;
  let dayNo = -1;
  let newDay = true;
  let daySession = "";
  /** Grades `answer` against `task`'s facts beside the next task, on `tl` (after its end); `set` gets the verdicts. */
  const gradeInto = (task: Task, answer: string, tl: Timeline, set: (facts: Record<string, boolean>) => void) => {
    grading.push(
      (async () => {
        const g = tl.begin("grading", "grading", "bg");
        const est = worstCase(GRADER, 4_000 + answer.length + task.text.length, 2_000);
        let reserved = false;
        let cost = 0;
        let failure = "";
        try {
          if (task.must.length > 0 && answer.trim()) {
            reserve(est);
            reserved = true;
          }
          const meter: Meter = { before: () => {}, after: (c) => (cost = c) };
          const via = { fetch: ACCESS.fetch, allowLogging: ACCESS.allowLogging };
          // `--replay`: the same prompt through the replay cache (a replayed grade costs nothing).
          const model = graderReplay ?? GRADER_MODEL;
          set(
            model
              ? await gradeWith(model, task, answer, (c) => (cost = c))
              : (await grade(KEY!, meter, GRADER, task, answer, via)).facts,
          );
        } catch (e) {
          // A failed grading call leaves the result ungraded (reported), never scored as a miss. The status line
          // only: an error body can quote the request.
          failure = isCapError(e) ? "request cap reached" : e instanceof Error ? e.message.slice(0, 60) : "error";
        } finally {
          if (reserved) settle(est, cost, "grader");
          tl.end(g, { cost, ...(failure ? { error: failure } : {}) });
        }
      })(),
    );
  };
  // A set: two requests planting one item must not move it twice.
  const dayPlanted = new Set<string>();
  let dayKind = "";
  let dayMessages: AgentMessage[] = [];
  const dayPackets: string[][] = [];
  let asked = -1;
  for (const task of tasks) {
    asked++;
    if (exhausted()) break;
    if (PACER.remaining < TASK_REQUESTS) {
      capStopped++;
      break;
    }
    if (connect) {
      // The checkpoint, in real time since the user's first event; the session before it is closed first.
      await closePrevious();
      const wait = connectedAt + CONNECT_AT[asked]! * 1_000 - performance.now();
      if (wait > 0) await Bun.sleep(wait);
    }
    // An hour between tasks: Eden's clock, for its caches and planner. `--days`: `--gap-min` between requests and
    // `--night-h` before each day after the first (the recap closed the day before).
    if (!connect) clock += daySizes ? (newDay && dayNo >= 0 ? NIGHT_MS : GAP_MS) : 3_600_000;
    // Between tasks no task's timeline is current: the sync's tick, the notices and a recap's notice are background,
    // counted in the stream's `sourceCalls` and not in the previous task's window (A3 review; before it they were).
    current = null;
    if (sync && !connect) await sync.tick();
    if (!connect) notify(partner, scope);
    if (DAYS_ON && newDay) {
      dayNo++;
      // One Eden session per day, named once: a suite whose ids do not share a prefix keeps it too.
      daySession = daySizes ? `${userPrefix}:day${dayNo}` : dayId(task.id, dayNo);
      day = new DayLog(daySession, condition);
      dayMessages = [];
      dayPackets.length = 0;
      dayPlanted.clear();
      dayLate = [];
      dayKind = task.kind;
    }
    const startsDay = newDay;
    newDay = DAYS_ON && isRecap(task);
    day?.turn();
    const sessionId = DAYS_ON ? daySession : task.id;
    if (DAYS_ON && day && isRecap(task)) {
      // The world changes before the recap: the times of the day's planted items move, the sources serve the new
      // text, and a notifying source says so (`--push`), as plans moved during the day would. Only before the recap,
      // which is never graded: a moved item could otherwise land in a later request's slot and change its grade.
      const touched = new Set<string>();
      const movedIds = new Set<string>();
      for (const id of dayPlanted) {
        const it = world.items.find((x) => x.id === id);
        if (!it) continue;
        const moved = shiftClocks(it.text);
        if (!moved.moves.length) continue;
        it.text = moved.text;
        if (it.meta) it.meta = shiftMeta(it.meta, moved.moves);
        it.updatedAt = clock;
        touched.add(it.sourceId);
        movedIds.add(it.id);
        day.changed(it.id, moved.moves);
      }
      for (const src of sources) if (touched.has(src.id)) src.reindex();
      if (partner && CONNECTORS.push !== "none") {
        // `payload`: the notice carries the moved items, as the client sends one (`sourceChanged` with items calls
        // only `sourceItems`): no signal, so no other copy of the source is put in doubt. Before A3 (D272) this sent
        // a bare signal in every mode, so from each day's first recap on every push re-read its candidates from that
        // source on the agent's critical path (about 650 ms a task in CL5-CL8's long payload runs).
        // A3's first fix moved items without naming them, and its notice went out empty: refuse that.
        if (touched.size > 0 && movedIds.size === 0) throw new Error("recap moved items but named none");
        // `--recap-notice signal` (A8): the bare signals every run sent before D272, to reproduce its re-reads.
        if (RECAP_SIGNAL) for (const id of touched) partner.sourceChanged(scope, id);
        else await recapNotice(partner, scope, sources, movedIds, CONNECTORS.push);
        // The change lands two hours before the recap: what the notice started in the background (`revisionNotice`'s
        // poll; nothing when that trial is off) has settled by then. Bounded, so a hung poll cannot stall the stream.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([partner.revisionsSettled(scope), new Promise((r) => (timer = setTimeout(r, 10_000)))]);
        clearTimeout(timer);
      }
    }
    const ev = (e: Record<string, unknown>) => ({ ...scope, sessionId, at: clock, ...e }) as AgentEvent;
    const r: RunResult = emptyResult(task.id, condition);
    if (connect) {
      r.connectS = CONNECT_AT[asked]!;
      r.sinceConnectMs = Math.round(performance.now() - connectedAt);
      r.replica = connect.replica;
      r.warmAtRequest = sync?.warm(scope) ?? false;
      r.syncedAtRequest = partner ? itemCache.syncedCount(scope) : 0;
    }
    if (startsDay) await closePrevious();
    const tl = new Timeline();
    current = tl;
    bySession.set(sessionId, { r, tl });
    readerTask = r;
    const record: TaskRecord = {
      task: task.id,
      condition,
      suite: task.suite,
      kind: task.kind,
      seed,
      wallMs: 0,
      firstTokenMs: null,
      requests: [],
      events: tl.events,
      dropped: 0,
      ...(task.planted ? { planted: task.planted } : {}),
    };
    activeTasks++;
    tl.point("task.start", { condition, kind: task.kind });
    // Eden's packets for this task, oldest first: each a system message before the user turn, as agent-ab places them.
    // With the ids each packet and `ask_context` answer cited, so the line tells delivery from uptake (uptake.ts).
    const uptake = new UptakeLog();
    const packets = uptake.packets;
    const takeEden = () => {
      // `tools-act-firewall`: Eden only checks actions; what it would have delivered never reaches the agent.
      if (!partner || !useEden) return;
      for (const i of partner.takePending({ ...scope, sessionId })) {
        r.injectedItems += i.citations.length;
        r.injectedChars += i.text.length;
        uptake.packet(i);
        day?.packet(
          i.citations.map((c) => c.itemId),
          i.text,
        );
        tl.point("eden.inject", { items: i.citations.length, chars: i.text.length, mode: i.mode });
      }
    };
    try {
      if (partner) {
        if (startsDay) {
          const o = tl.begin("eden.observe", "eden", "path", { event: "session_start" });
          await partner.observe(ev({ kind: "session_start", agent: "pi-ab" }));
          tl.end(o);
        }
        const arriving = task.event === "external" ? { source: "gmail" } : {};
        const o2 = tl.begin("eden.observe", "eden", "path", { event: task.event });
        const first = await partner.observe(ev({ kind: task.event, text: task.text, ...arriving }), { waitMs });
        tl.end(o2, { injected: first.injection?.citations.length ?? 0, pending: first.pending });
        if (first.injection && useEden) {
          r.injectedItems += first.injection.citations.length;
          r.injectedChars += first.injection.text.length;
          uptake.packet(first.injection);
          day?.packet(
            first.injection.citations.map((c) => c.itemId),
            first.injection.text,
          );
          tl.point("eden.inject", { items: first.injection.citations.length, chars: first.injection.text.length });
        }
      }
      // `hits` (P3, lexical-hits.ts): no Eden; the request's top BM25 hits over the world as it is now, every request.
      if (hits) {
        const h = hitsPacket(world, task.text);
        if (h) {
          r.injectedItems += h.citations.length;
          r.injectedChars += h.text.length;
          uptake.packet(h);
          day?.packet(
            h.citations.map((c) => c.itemId),
            h.text,
          );
          tl.point("eden.inject", { items: h.citations.length, chars: h.text.length, mode: "hits" });
        }
      }
      const tools: AgentTool<any>[] = [];
      if (useTools) {
        for (const source of sources) {
          tools.push({
            ...searchToolSpec(source),
            label: source.id,
            parameters: queryParams,
            // agent-ab reads `query`, or `question` when a model sends that instead.
            prepareArguments: (a) => {
              const x = (a ?? {}) as { query?: unknown; question?: unknown };
              return { query: String(x.query ?? x.question ?? "") };
            },
            execute: async (_id, raw) => {
              const params = raw as { query: string };
              // A connector failure (the realistic profiles fail some calls) goes back to the agent as a tool error,
              // as a tool runtime would return it.
              const items = await source
                .search({ scope, text: params.query, entities: [], limit: TOOL_ITEMS }, AbortSignal.timeout(10_000))
                .catch((e: unknown) => `Error: ${e instanceof Error ? e.message : String(e)}`);
              const result = typeof items === "string" ? items : render(items);
              // Eden sees what the agent fetched, so it does not deliver it again.
              if (partner) {
                const o = tl.begin("eden.observe", "eden", "path", { event: "tool_result" });
                await partner.observe(ev({ kind: "tool_result", tool: `search_${source.id}`, output: result }));
                tl.end(o);
              }
              return { content: [{ type: "text", text: result }], details: {} };
            },
          });
        }
      }
      // `eden`, and `both+ask` (the shape integrators ship: own tools, Eden's context and its ask).
      if (askTool && partner) {
        tools.push({
          name: "ask_context",
          description: ASK_DESCRIPTION,
          label: "ask_context",
          parameters: askParams,
          prepareArguments: (a) => {
            const x = (a ?? {}) as { query?: unknown; question?: unknown };
            return { question: String(x.question ?? x.query ?? "") };
          },
          execute: async (_id, raw) => {
            const params = raw as { question: string };
            const a = await partner.ask({ ...scope, sessionId, question: params.question });
            // The agent's question is recorded with the answer (sim data is fake), for replays of real questions.
            const question = sanitizeForStore(params.question);
            uptake.answer(a, question);
            day?.answer(
              a.citations.map((c) => c.itemId),
              a.answer,
            );
            tl.point("eden.ask", { question: question.slice(0, QUESTION_CHARS), items: a.citations.length });
            return { content: [{ type: "text", text: a.answer || "Nothing found." }], details: {} };
          },
        });
      }
      // `--act`: the stub action tools; each call is recorded and runs. With the firewall, Eden checks each call
      // first (`beforeToolCall` below) and the check's record waits here for the call to run; without it, `off`.
      const actions: ActionRecord[] = [];
      const checkedCalls = new Map<string, ActionRecord>();
      if (act) {
        r.actions = actions;
        for (const spec of ACTIONS) {
          tools.push({
            name: spec.name,
            description: spec.description,
            label: spec.name,
            parameters: actionParams(spec),
            prepareArguments: (a) => coerceArgs(spec, a),
            execute: async (id, raw) => {
              const args = raw as Record<string, string | string[]>;
              const rec = checkedCalls.get(id) ?? {
                tool: spec.name,
                args,
                verdict: "off",
                executed: false,
                checkMs: 0,
              };
              checkedCalls.delete(id);
              rec.executed = true;
              actions.push(rec);
              return { content: [{ type: "text", text: executed(spec.name, actions.length) }], details: {} };
            },
          });
        }
      }
      let turns = 0;
      let request: {
        id: number;
        at: number;
        first: number | null;
        in: number;
        out: number;
        cost: number;
        /** OpenRouter reported a cost (a free model's is 0, which stands). */
        costed: boolean;
        cached: number;
        cacheWrite: number;
      } | null = null;
      let est = 0;
      let ledgerEst = 0;
      const agent = new Agent({
        initialState: {
          systemPrompt: systemPrompt(world, {
            lookups: LOOKUPS,
            data: useTools || useEden,
            // `hits` (P3): its items come only in the packet; the prompt names no tool it does not have.
            pushed: hits,
            act,
            tenant: TENANT_PROMPT,
          }),
          // `--day`: the day's transcript so far (its earlier requests, tool calls and answers).
          ...(DAYS_ON && !startsDay ? { messages: dayMessages } : {}),
          model: piModel,
          thinkingLevel: "off",
          tools,
        },
        toolExecution: TOOL_EXEC,
        // Before every model request: Eden's packets queued since the last one join those already placed, all before
        // the user turn (agent-ab's `withContext` placement), never stored in the agent's own transcript.
        transformContext: async (messages) => {
          takeEden();
          // `--day`: the packets of the day's earlier turns stay where the agent saw them, before their requests.
          if (DAYS_ON && dayPackets.some((p) => p.length)) {
            const asSystem = (text: string) =>
              ({ role: "system", content: text, timestamp: Date.now() }) as unknown as AgentMessage;
            // `+ephemeral`, `+ephemeralBp` (D336): earlier requests' packets gone, as `withContext` and the proxy send.
            return placePackets(messages, earlierPackets(layout, dayPackets), packets, asSystem);
          }
          if (!packets.length) return messages;
          const at = messages.map((m) => m.role).lastIndexOf("user");
          const sys = packets.map((text) => ({ role: "system" as const, content: text, timestamp: Date.now() }));
          return [...messages.slice(0, at), ...sys, ...messages.slice(at)];
        },
        streamFn: (model, context, options) => {
          const chars = JSON.stringify(context.messages).length;
          est = worstCase(MODEL, chars, AGENT_MAX_TOKENS);
          reserve(est);
          if (AGENT_METER) {
            ledgerEst = anthropicWorstCase(MODEL, chars, AGENT_MAX_TOKENS);
            try {
              AGENT_METER.reserve(ledgerEst);
            } catch (e) {
              settle(est, 0, "agent");
              throw e;
            }
          }
          const at = performance.now();
          request = {
            id: tl.begin("model.request", "model", "path", { turn: turns + 1 }),
            at,
            first: null,
            in: 0,
            out: 0,
            cost: 0,
            costed: false,
            cached: 0,
            cacheWrite: 0,
          };
          activeRequests++;
          const mine = request;
          if (AGENT_ANTHROPIC) {
            // Anthropic's events: the first content block's start is the first token; usage comes on message_end.
            return models.streamSimple(model, context, {
              ...options,
              maxTokens: AGENT_MAX_TOKENS,
              fetch: ACCESS.fetch,
              maxRetries: 0,
              timeoutMs: 90_000,
              cacheRetention: "short",
              onPayload: (payload) => {
                const p = anthropicThinkingOff(MODEL, payload);
                // `+ephemeralBp` (D336): the request's user turn gets a breakpoint, so its entry outlives the packet.
                if (layout === "ephemeralBp") userTurnBreakpoint(p as { messages?: unknown });
                return p;
              },
              onProviderStreamEvent: (event) => {
                const e = event as { type?: string };
                if (mine.first === null && (e.type === "content_block_start" || e.type === "content_block_delta")) {
                  mine.first = performance.now();
                  tl.point("model.first-token", { turn: turns + 1 }, mine.first);
                }
              },
            });
          }
          return models.streamSimple(model, context, {
            ...options,
            temperature: 0,
            maxTokens: AGENT_MAX_TOKENS,
            // The pacer retries 429 and 5xx (honouring Retry-After) and counts each attempt against the cap.
            fetch: ACCESS.fetch,
            maxRetries: 0,
            timeoutMs: 90_000,
            // OpenRouter's own cost on the final chunk: what agent-ab books, not pi-ai's catalog estimate.
            onPayload: (payload) => ({ ...(payload as object), usage: { include: true }, ...providerPrefs(ACCESS) }),
            onProviderStreamEvent: (chunk) => {
              const c = chunk as {
                choices?: { delta?: { content?: string; tool_calls?: unknown[]; reasoning?: string } }[];
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  cost?: number;
                  prompt_tokens_details?: { cached_tokens?: number };
                };
              };
              const d = c.choices?.[0]?.delta;
              if (mine.first === null && d && (d.content || d.tool_calls?.length || d.reasoning)) {
                mine.first = performance.now();
                tl.point("model.first-token", { turn: turns + 1 }, mine.first);
              }
              if (c.usage) {
                mine.in = c.usage.prompt_tokens ?? 0;
                mine.out = c.usage.completion_tokens ?? 0;
                mine.cost = c.usage.cost ?? 0;
                mine.costed = c.usage.cost !== undefined;
                // Billed at the endpoint's cache-read price: re-pricing needs them (reprice.ts).
                mine.cached = c.usage.prompt_tokens_details?.cached_tokens ?? 0;
              }
            },
          });
        },
        // The firewall: an action call goes to Eden before it runs; a finding holds it and is the tool's result.
        ...(firewall && partner
          ? {
              beforeToolCall: async (ctx: { toolCall: { id: string; name: string }; args: unknown }) => {
                if (!ACTIONS.some((a) => a.name === ctx.toolCall.name)) return undefined;
                const o = tl.begin("eden.check", "eden", "path", { tool: ctx.toolCall.name });
                const check = await partner.checkAction(
                  ev({ kind: "tool_call", tool: ctx.toolCall.name, input: ctx.args }),
                );
                tl.end(o, { verdict: check.verdict, reason: check.reason });
                const rec: ActionRecord = {
                  tool: ctx.toolCall.name,
                  args: ctx.args as ActionRecord["args"],
                  verdict: check.verdict,
                  executed: false,
                  checkMs: check.latencyMs,
                  reason: check.reason,
                  ...(check.finding ? { cited: check.finding.citations.map((c) => c.itemId) } : {}),
                };
                if (check.verdict === "proceed" || !check.finding) {
                  checkedCalls.set(ctx.toolCall.id, rec);
                  return undefined;
                }
                actions.push(rec);
                r.injectedItems += check.finding.citations.length;
                r.injectedChars += check.finding.text.length;
                uptake.finding(check.finding);
                return { block: true, reason: heldResult(ctx.toolCall.name, check.finding) };
              },
            }
          : {}),
        finishTurn: async () => {
          turns++;
          // agent-ab's cap: six model calls, the last one's text the answer even if it asked for more tools.
          return turns >= MAX_STEPS ? { action: "end" } : undefined;
        },
      });
      const toolSpans = new Map<string, number>();
      agent.subscribe((e: PiEvent) => {
        if (e.type === "message_end" && e.message.role === "assistant" && request) {
          const q = request;
          request = null;
          activeRequests--;
          const end = performance.now();
          if (AGENT_METER) {
            // pi-ai's usage splits the prompt: uncached input, cache reads, cache writes.
            const u = e.message.usage;
            q.in = u.input + u.cacheRead + u.cacheWrite;
            q.out = u.output;
            q.cached = u.cacheRead;
            q.cacheWrite = u.cacheWrite;
            const usage = {
              inputTokens: q.in,
              cachedInputTokens: q.cached,
              cacheWriteTokens: q.cacheWrite,
              outputTokens: q.out,
            };
            q.cost = anthropicCost(usage, anthropicPrice(MODEL));
            q.costed = true;
            AGENT_METER.release(ledgerEst);
            ACCESS.ledger!.write("agent", {
              model: MODEL,
              usage,
              costUsd: q.cost,
              latencyMs: Math.round(end - q.at),
              ttftMs: q.first === null ? null : Math.round(q.first - q.at),
              stopReason: e.message.stopReason ?? null,
            });
          }
          // A usage chunk with no cost (it should not happen on OpenRouter) is priced at the list price; a reported
          // cost stands, a free model's $0 included.
          const cost = q.costed ? q.cost : q.in || q.out ? worstCase(MODEL, q.in * 4, q.out) : 0;
          settle(est, cost, "agent");
          r.modelCalls++;
          r.promptTokens += q.in;
          r.completionTokens += q.out;
          r.costUsd += cost;
          tl.end(q.id, { in: q.in, out: q.out, cost, stop: e.message.stopReason });
          record.requests.push({
            startMs: tl.at(q.at),
            firstTokenMs: q.first === null ? null : Math.round(q.first - q.at),
            endMs: tl.at(end),
            in: q.in,
            out: q.out,
            cost,
            ...(q.cached ? { cached: q.cached } : {}),
            ...(q.cacheWrite ? { cacheWrite: q.cacheWrite } : {}),
            ...turnShape(e.message),
          });
        } else if (e.type === "tool_execution_start") {
          r.toolCalls++;
          const id = tl.begin(`tool.${e.toolName}`, e.toolName === "ask_context" ? "eden" : "tool", "path", {
            tool: e.toolName,
          });
          toolSpans.set(e.toolCallId, id);
        } else if (e.type === "tool_execution_end") {
          const id = toolSpans.get(e.toolCallId);
          if (id !== undefined) tl.end(id, { error: e.isError });
        }
      });
      await agent.prompt(userPrompt(task));
      if (DAYS_ON) {
        dayMessages = [...agent.state.messages];
        dayPackets.push([...packets]);
      }
      // A request that never reached its end (refused by the cap, or thrown) gives back its reservation.
      if (request) {
        const q = request as { id: number };
        tl.end(q.id, { error: true });
        settle(est, 0, "agent");
        AGENT_METER?.release(ledgerEst);
        activeRequests--;
        request = null;
      }
      const last = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
      if (last && last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
        r.error = last.errorMessage ?? last.stopReason;
      } else r.answer = textOf(last);
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
    }
    // A task cut off by the request cap (pi-ai reports it as a connection error): said so, not as a model failure.
    if (r.error && PACER.exhausted) r.error = `request cap reached: ${r.error.slice(0, 120)}`;
    r.wallMs = performance.now() - tl.origin;
    r.leaked = task.secrets.some((s) => r.answer.includes(s));
    tl.point("task.end", { error: !!r.error });
    activeTasks--;
    record.wallMs = Math.round(r.wallMs);
    record.firstTokenMs = record.requests[0]?.firstTokenMs ?? null;
    if (r.error) record.error = r.error.slice(0, 200);
    // `hits` (P3) has no partner, but its packets are cited the same way.
    if (partner || hits) Object.assign(record, uptake.fields());
    // `--late`: every answer after a planted item arrived is one of its later replies; the recap closes the day and
    // grades them against the planted request.
    for (const l of dayLate) l.entry.after.push(r.error ? "" : r.answer);
    if (LATE && isRecap(task)) {
      for (const l of dayLate) {
        l.r.lateTurns = l.entry.after.length;
        // Kept with the verdicts, so a regrade (or a reader) sees what was graded.
        l.r.lateText = laterText(l.entry);
        gradeInto(l.entry.task, l.r.lateText, tl, (f) => (l.r.lateFacts = f));
      }
      dayLate = [];
    }
    if (DAYS_ON && day) {
      // `--late` moves no clock before the recap: the late arrival is the day's only change.
      if (!LATE && !isRecap(task) && task.planted) dayPlanted.add(task.planted);
      if (isRecap(task)) {
        // The recap is measured, never graded or reported as a task; its cost is kept with the day.
        day.recap(r.error ? "" : r.answer);
        DAYS.push({ ...day.summary(), seed, kind: task.kind, recapUsd: r.costUsd, recapEdenUsd: r.edenCostUsd });
        day = null;
        previous = { sessionId, r };
        continue;
      }
    }
    out.push(r);
    bg.tasks.push(r.task);
    records.push(record);
    // Grading runs beside the next task, on this task's timeline (after its end): the agent never waits for it.
    if (!r.error) gradeInto(task, r.answer, tl, (f) => (r.facts = f));
    // `--late`: the planted item arrives now, after the answer, and is new at its source; the notice carries it.
    const arrived = lateHeld && task.planted ? release(world, lateHeld, task.planted, clock) : null;
    if (arrived) {
      const src = sources.find((x) => x.id === arrived.sourceId);
      src?.reindex();
      if (partner && src && CONNECTORS.push === "payload") {
        await partner.sourceItems(
          scope,
          src.id,
          src.listAll().filter((i) => i.id === arrived.id),
        );
      } else if (partner && src && CONNECTORS.push === "signals") partner.sourceChanged(scope, src.id);
      // The next request comes ten minutes later: the item's card (made as it was stored) is in by then. Bounded, so a
      // hung enrichment cannot stall the stream.
      if (cards) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([cards.idle(), new Promise((r) => (timer = setTimeout(r, 10_000)))]);
        clearTimeout(timer);
      }
      dayLate.push({ entry: { task, after: [] }, r });
    }
    previous = { sessionId, r };
  }
  // A day cut short (budget, request cap) is still reported, marked partial.
  if (day) DAYS.push({ ...day.summary(), seed, kind: dayKind, partial: true });
  await closePrevious();
  current = null;
  if (connect) {
    // The user is kept until their backfill is complete (bounded), so an arm that reads it later is not counted
    // short; what a lookup left reading behind it is counted too. Then the user is let go.
    while (sync && !sync.warm(scope) && performance.now() - connectedAt < CONNECT_SETTLE_S * 1_000) {
      await Bun.sleep(250);
    }
    await Bun.sleep(2_000);
    for (const t of timers) clearInterval(t);
    partner?.stopSync();
    // The user is done: the run's lists keep only what its last lines read. An enricher or a reader left in them
    // holds this stream's sources, cache and partner through its closures (about 11 MB a user: two seeds at once
    // were on their way past 16 GB a third of the way in, the first attempt of o4-new-user.md 6a).
    const done = <T extends { stats: { overBudget: number } }>(list: T[], x: T | undefined) => {
      const i = x ? list.indexOf(x) : -1;
      if (i >= 0) list[i] = { stats: { overBudget: x!.stats.overBudget } } as T;
    };
    done(budgeted.cards, cards);
    done(budgeted.reader, reader);
    itemCache.forget(scope);
    sourceMap.close();
    connectUsers.push({
      seed,
      suite: tasks[0]?.suite ?? "",
      kind: tasks[0]?.kind ?? "",
      condition,
      replica: connect.replica,
      sourceCalls: edenCalls,
      warmS,
    });
  }
  return out;
}

/** `--limit` on a user: the first N requests, the day sizes cut to match. */
const cutDays = (sizes: number[], n: number) =>
  sizes.map((k, d) => Math.max(0, Math.min(k, n - sizes.slice(0, d).reduce((a, b) => a + b, 0)))).filter((k) => k > 0);
const worlds: { seed: number; world: World; tasks: Task[]; daySizes?: number[]; clashes?: number }[] = WORLD_FILE
  ? [worldFromPilot(readBundle(readFileSync(WORLD_FILE, "utf8")), SEEDS[0]!)].map((w) =>
      LIMIT > 0 ? { ...w, tasks: w.tasks.slice(0, LIMIT) } : w,
    )
  : USER_DAYS > 0
    ? SEEDS.map((seed) => {
        if (LOOKUPS) throw new Error("--days needs hidden-context suites, not lookups");
        const plan = planUser(seed, suiteTemplates(seed, SUITE_LIST), { days: USER_DAYS, size: DAY_SIZE, mix: MIX });
        const u = userWorldOf(seed, plan);
        return LIMIT > 0 ? { ...u, tasks: u.tasks.slice(0, LIMIT), daySizes: cutDays(u.daySizes, LIMIT) } : u;
      })
    : SEEDS.flatMap((seed) =>
        SUITE_LIST.flatMap((suite) =>
          (LOOKUPS ? ["hidden" as const] : variantsFor(suite, VARIANTS)).map((variant) => {
            const w = worldOf(seed, suite, variant, LIMITS, { dress: DRESS });
            const picked = TEMPLATES ? { ...w, tasks: w.tasks.filter((t) => TEMPLATES.has(t.type)) } : w;
            return LIMIT > 0 ? { ...picked, tasks: picked.tasks.slice(0, LIMIT) } : picked;
          }),
        ),
      );
// What the intent index will have: the requests replayed for the items the run's sources hold (`intent: replayed n of
// m items`), counted before anything is spent so `--dry` shows it.
const intentCount =
  INTENT_WANTED && diskCards
    ? intentCoverage(
        worlds.map((w) => simSources(w.world, CONNECTORS.profiles, 0, w.seed).flatMap((s) => s.listAll())),
        diskCards.requests,
      )
    : { found: 0, of: 0 };
const INTENT_LINE = intentLine({ wanted: INTENT_WANTED, cardsReplayed: !!CARDS_FILE, ...INTENT, ...intentCount });
console.error(
  `pi-ab: ${worlds.reduce((n, w) => n + w.tasks.length, 0)} tasks × ${CONDITIONS.length} conditions ` +
    `(${CONDITIONS.map((c) => c.name).join(",")}), model ${MODEL}, grader ${GRADER}, cap $${BUDGET}, suites ` +
    `${SUITE_LIST.join(",")}, time-scale ${TIME_SCALE}${TIME_SCALE === 0 ? " (connectors at 0 ms)" : ""}, ` +
    `config ${JSON.stringify(CONFIG)}` +
    (Object.keys(CONFIG_VARIANTS).length ? `, variants ${JSON.stringify(CONFIG_VARIANTS)}` : "") +
    (CARDS_FILE ? `, cards ${CARDS_FILE} (${diskCards!.cards.size} replayed; new → ${CARDS_OUT})` : "") +
    (ACCESS.allowLogging ? ", ALLOW-LOGGING (lab only)" : "") +
    `, requests ≤${PACER.remaining === Infinity ? "∞" : PACER.remaining}` +
    (REPLAY_DIR ? `, replay ${REPLAY_DIR}${REPLAY_ONLY ? " (only)" : ""}${REPLAY_TIMING ? " (timed)" : ""}` : ""),
);
console.error(`pi-ab: ${INTENT_LINE}`);
if (USER_DAYS > 0) {
  for (const w of worlds) {
    const kinds = ["hidden", "control", "neutral"].map((k) => w.tasks.filter((t) => t.kind === k).length);
    console.error(
      `pi-ab: user w${w.seed}: ${w.daySizes!.length} days (${w.daySizes!.join(",")} requests), hidden/control/neutral ` +
        `${kinds.join("/")}, ${w.clashes} slot clashes; agent transcript reset per day, Eden kept; clock +` +
        `${GAP_MS / 60_000} min a request, +${NIGHT_MS / 3_600_000} h a night`,
    );
  }
}
/** The arms `--reuse-arms` copies (checked before anything is spent, `--dry` included), with their timeline lines. */
const reused: { conditions: string[]; results: RunResult[]; records: TaskRecord[] } = {
  conditions: [],
  results: [],
  records: [],
};
if (REUSE_FILE) {
  const prior = JSON.parse(readFileSync(REUSE_FILE, "utf8")) as ArmSource & { timeline?: string };
  reused.conditions = CONDITIONS.filter((c) => !c.withPartner && !c.act).map((c) => c.name);
  if (!reused.conditions.length) throw new Error("--reuse-arms: no condition here runs without Eden (none, tools)");
  reused.results = reusableArms(
    prior,
    {
      model: MODEL,
      grader: GRADER,
      harness: "pi",
      harnessVersion: HARNESS_VERSION,
      promptsHash: PROMPTS_HASH,
      seeds: SEEDS,
      suites: SUITE_LIST,
      timeScale: TIME_SCALE,
      toolExecution: TOOL_EXEC,
      act: ACT,
      tasks: worlds.flatMap((w) => w.tasks),
    },
    reused.conditions,
  );
  const wanted = new Set(reused.results.map((r) => `${r.task}\u0000${r.condition}`));
  const lines = prior.timeline && existsSync(`${prior.timeline}/tasks.jsonl`) ? `${prior.timeline}/tasks.jsonl` : "";
  for (const line of lines ? readFileSync(lines, "utf8").split("\n") : []) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as TaskRecord;
    if (wanted.has(`${rec.task}\u0000${rec.condition}`)) reused.records.push(rec);
  }
  console.error(
    `reusing ${reused.results.length} results of ${reused.conditions.join(",")} from ${REUSE_FILE}` +
      ` (${reused.records.length} timeline lines${lines ? "" : ": no timeline found, timing sections omit them"})`,
  );
}
if (DRY) process.exit(0);

mkdirSync(TIMELINE, { recursive: true });
writeFileSync(`${TIMELINE}/tasks.jsonl`, "");
writeFileSync(`${TIMELINE}/samples.jsonl`, "");
const stopSampling = startSampling(`${TIMELINE}/samples.jsonl`);
const records: TaskRecord[] = [...reused.records];
const grading: Promise<void>[] = [];
const results: RunResult[] = [...reused.results];
const t0 = performance.now();
/** `--connect-at`: users running at once, so a process holds `--connect-users` users' sources and caches at most. */
let connectSlots = CONNECT_USERS;
const connectWaiters: (() => void)[] = [];
async function connected<T>(run: () => Promise<T>): Promise<T> {
  if (connectSlots > 0) connectSlots--;
  else await new Promise<void>((r) => connectWaiters.push(r));
  try {
    return await run();
  } finally {
    const next = connectWaiters.shift();
    if (next) next();
    else connectSlots++;
  }
}
let connectSlot = 0;
const live = CONDITIONS.filter((c) => !reused.conditions.includes(c.name));
const streams = worlds.flatMap((w) =>
  CONNECT
    ? // One user a task and arm, each in a slot of their own, a task's arms side by side.
      w.tasks.flatMap((_, replica) =>
        live.map((c) => {
          const startAt = t0 + connectSlot++ * CONNECT_STAGGER_S * 1_000;
          const who = { replica, replicas: w.tasks.length, startAt };
          return connected(() => runWorld(w.world, w.seed, w.tasks, c, records, grading, undefined, who));
        }),
      )
    : live.map((c) => runWorld(w.world, w.seed, w.tasks, c, records, grading, w.daySizes)),
);
for (const settled of await Promise.allSettled(streams)) {
  if (settled.status === "fulfilled") results.push(...settled.value);
  else console.error(`stream stopped: ${settled.reason instanceof Error ? settled.reason.message : settled.reason}`);
}
await Promise.all(grading);
stopSampling();
for (const rec of records) appendFileSync(`${TIMELINE}/tasks.jsonl`, `${JSON.stringify(rec)}\n`);
const tasks = worlds.flatMap((w) => w.tasks);
writeFileSync(
  OUT,
  JSON.stringify(
    {
      model: MODEL,
      grader: GRADER,
      seeds: SEEDS,
      suites: SUITE_LIST,
      spent,
      harness: "pi",
      harnessVersion: HARNESS_VERSION,
      promptsHash: PROMPTS_HASH,
      config: CONFIG,
      ...(Object.keys(CONFIG_VARIANTS).length ? { variantConfig: CONFIG_VARIANTS } : {}),
      ...(ACT ? { act: true } : {}),
      ...(DRESS ? { dress: true } : {}),
      ...(CARDS_FILE ? { cards: { replay: CARDS_FILE, out: CARDS_OUT } } : {}),
      ...(INTENT_WANTED ? { intent: { line: INTENT_LINE, files: INTENT_FILES, ...intentCount } } : {}),
      timeScale: TIME_SCALE,
      ...connectorHeader(CONNECTORS),
      ...(ACCESS.allowLogging ? { allowLogging: true } : {}),
      // Every HTTP request the run sent (retries included), and whether the cap cut it short.
      requests: PACER.summary(),
      partial: capStopped > 0 || PACER.refused > 0,
      toolExecution: TOOL_EXEC,
      spend,
      // Eden's spend no task is charged for, per stream: the report's backfill and all-in columns (ab-common.ts).
      background,
      ...(REPLAY_DIR ? { replay: replaySummary() } : {}),
      ...(REUSE_FILE ? { reusedArms: { from: REUSE_FILE, conditions: reused.conditions } } : {}),
      ...(LATE ? { late: true } : {}),
      ...(CONNECT
        ? {
            connect: {
              at: CONNECT_AT,
              tickS: CONNECT_TICK_S,
              staggerS: CONNECT_STAGGER_S,
              settleS: CONNECT_SETTLE_S,
              cardsMs: CARDS_MS,
              users: connectUsers,
            },
          }
        : {}),
      ...(DAYS_ON
        ? { ...(DAY > 0 ? { day: DAY } : {}), days: DAYS, daysPooled: poolDays(DAYS), recapNotice: RECAP_NOTICE }
        : {}),
      ...(USER_DAYS > 0
        ? {
            user: {
              days: USER_DAYS,
              daySize: DAY_SIZE,
              mix: MIX,
              gapMin: GAP_MS / 60_000,
              nightH: NIGHT_MS / 3_600_000,
              transcript: "reset per day (not compacted)",
              worlds: worlds.map((w) => ({ seed: w.seed, daySizes: w.daySizes, clashes: w.clashes })),
            },
          }
        : {}),
      overBudget: overBudget(budgeted),
      timeline: TIMELINE,
      wallSeconds: Math.round((performance.now() - t0) / 100) / 10,
      tasks,
      results,
    },
    null,
    2,
  ),
);
const ungraded = results.filter((r) => !r.error && !r.facts && tasks.find((t) => t.id === r.task)!.must.length).length;
console.error(
  `spent $${spent.toFixed(4)} (agent $${spend.agent.toFixed(4)}, eden $${spend.eden.toFixed(4)}, grader ` +
    `$${spend.grader.toFixed(4)}); ${results.length} runs, ${ungraded} ungraded → ${OUT}, timeline ${TIMELINE}, ` +
    `time-scale ${TIME_SCALE}; ${PACER.sent} requests (${PACER.retried} retried, ${JSON.stringify(PACER.statuses)})` +
    (capStopped || PACER.refused ? `; PARTIAL: request cap reached (${capStopped} streams stopped early)` : "") +
    (REPLAY_DIR ? `; ${replayLine()}` : "") +
    (REUSE_FILE ? `; reused ${reused.results.length} runs (${reused.conditions.join(",")}) at $0` : "") +
    (INTENT_WANTED ? `; ${INTENT_LINE}` : ""),
);
console.error(overBudgetLine(budgeted));
if (checkers.length) {
  const sum = (k: keyof PushChecker["stats"]) => checkers.reduce((n, c) => n + c.stats[k], 0);
  const calls = sum("calls");
  console.error(
    `CHECK (I3, ${CHECK_MODEL}): ${calls} calls of ${sum("asked")} asked, ${sum("failures")} failed, ` +
      `${sum("overBudget")} over budget; $${sum("costUsd").toFixed(4)}; ` +
      `${calls ? (sum("inputTokens") / calls).toFixed(0) : 0} in (${calls ? (sum("cachedInputTokens") / calls).toFixed(0) : 0} ` +
      `cached) / ${calls ? (sum("outputTokens") / calls).toFixed(0) : 0} out a call`,
  );
}
if (WIDEN_HASH && widenUse.asked) {
  console.error(
    `WIDEN (N5, by content): ${widenUse.found} of ${widenUse.asked} requests in the table; ` +
      `${widenUse.held} of ${widenUse.hashes} of their items held by the world`,
  );
}
const replayMisses = (readerReplay?.missed ?? 0) + (graderReplay?.missed ?? 0);
if (REPLAY_ONLY && replayMisses > 0) {
  console.error(
    `REPLAY MISSES: ${replayMisses} calls had no line in ${REPLAY_DIR} (--replay-only): the reader answered without ` +
      "them and those grades are missing, so this run is not a replay of the configuration",
  );
  process.exit(MISS_EXIT);
}
