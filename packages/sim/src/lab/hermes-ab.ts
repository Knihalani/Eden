#!/usr/bin/env bun
/**
 * The live A/B on Hermes Agent (NousResearch/hermes-agent): Hermes alone against the same Hermes with Eden integrated
 * as a tenant would integrate it. Same worlds, tasks, prompts, source tools, grader, results file and timeline as
 * `pi-ab.ts`, so `pi-ab-report.ts` and `agent-ab-report.ts` read its output (`harness: "hermes"`).
 *
 * - hermes:      Hermes with one MCP server, `sources`: a read-only `search_<source>` tool per sim source (pi-ab's
 *                `tools`). Hermes' own toolsets (terminal, files, web, browser, code, memory, skills, delegation, cron)
 *                are all off: `enabled_toolsets` is the MCP toolsets only, so the agent is read-only.
 * - hermes-eden: Eden only (A16), Pi's `eden` shape: `ask_context` and the plugin, no `search_<source>` tools (the
 *                sources server runs, its toolset is not enabled). `~variant`, `+flag`, `@w<ms>` as for hermes+eden.
 * - hermes+eden: the same, plus Eden as two integration points, both Hermes' own extension surfaces:
 *                Eden's MCP server (`createMcpServer`: `ask_context` with the standard description), and the Eden
 *                plugin (packages/sim/lab/hermes/eden): `pre_llm_call` observes the turn and injects Eden's packet,
 *                `post_tool_call` reports each tool result, `transform_tool_result` appends packets queued since.
 *                `~variant`, `+flag` and `@w<ms>` as in pi-conditions.ts (hermes-conditions.ts).
 *
 * How it runs: this process hosts the sim sources and a `ContextPartner` per stream (a world under one condition),
 * exactly as pi-ab does, and serves them on localhost (hermes-host.ts). Each stream gets one Python worker
 * (packages/sim/lab/hermes/worker.py, Hermes' venv) with its own `HERMES_HOME`; the worker runs the stream's tasks in
 * order, a fresh `AIAgent` each (no memory, no context files, fresh session). Hermes' model endpoint is this
 * process (`base_url` → `/s/<stream>/v1`): every chat completion is forwarded to OpenRouter through the run's pacer
 * (free.ts: rate, `--max-requests`, 429 backoff), its cost reserved against `--budget`, its tokens, cost and timing
 * put on the task's timeline. The API key stays in this process. `--concurrency` streams run at once.
 *
 * The plugin observes the task's event with the task's own text (`task.event`, `task.text`), as pi-ab does: an
 * arriving message is an `external` event, not the user prompt that wraps it.
 *
 *   OPENROUTER_API_KEY=… bun packages/sim/src/lab/hermes-ab.ts --hermes-src DIR [--hermes-python PY]
 *     [--suite dev6a] [--seeds 41] [--variants hidden,control[,neutral]] [--conditions hermes,hermes+eden]
 *     [--config ALL3] [--variant-config '{"A5":{…}}'] [--model z-ai/glm-5.3-flash] [--grader …] [--budget 0.6]
 *     [--card-model m] [--cards FILE [--cards-out FILE]] [--intent default|none|FILE[,FILE]]
 *     [--allow-logging] [--rpm 18] [--max-requests N] [--limit n] [--templates a,b] [--concurrency 4]
 *     [--kinds hidden,control] [--project-from completed-results.json]
 *     [--max-iterations 6] [--out hermes-ab.json] [--timeline dir] [--time-scale 1] [--dump FILE] [--dry]
 *
 * `--time-scale` (default 1) gives the sim sources their profiles' assumed latency, as pi-ab does (its header says why,
 * and when 0, instant connectors, is still acceptable: a stated quality-only rerun). Runs before 2026-11-03 used 0.
 *
 * `--intent` as pi-ab takes it (D158): with `--cards` and intent on, the checked-in requests are replayed by default
 * where they cover the run, and the header prints `intent: replayed n of m items` or labels the run intent inert.
 *
 * `--hermes-src` is a hermes-agent checkout with its dependencies in `<src>/.venv` (`uv sync --frozen
 * --no-install-project`); the run records its commit.
 *
 * `--days D` (B19, D1044): pi-ab's user days on Hermes. One user per seed over D days of `--day-size` requests mixing
 * hidden, control and neutral in `--mix` proportion (pi-user.ts), each day closed by an ungraded recap turn
 * (pi-day.ts). A day's requests share one Hermes transcript (the runner holds it and sends it with each request, so a
 * worker restart loses nothing) and one Eden session; Eden persists across days. Before each recap the day's planted
 * items' clock times move and the change is announced as `--push` says (`--recap-notice`). Eden's clock moves
 * `--gap-min` minutes a request and `--night-h` hours a night. The results carry `days`, `daysPooled` and `user`, as
 * pi-ab's do, so the same reports read them.
 *
 * `--resume` (D813, D1044): each finished unit (a task; a whole day under `--days`) is appended to
 * `<out>.partial.jsonl` as pi-ab does (run-journal.ts), and a restart with `--resume` reuses those units at $0. Under
 * `--days` an Eden arm resumes only with `--resume-biased` (its Eden never saw the reused days), and says so.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CardEnricher,
  ContextPartner,
  DEFAULT_CONFIG,
  ItemCache,
  ModelCardMaker,
  AskReader,
  ModelReaderMaker,
  PushChecker,
  type CardMaker,
} from "@eden/engine";
import * as engineExports from "@eden/engine";
// B19 (D1047): read so an older engine without it loads (packages/sim/lab/b19/compat.py).
const CARD_FORM_REQUESTS = (engineExports as { CARD_FORM_REQUESTS?: number }).CARD_FORM_REQUESTS ?? 0;
// The default's card prompt form (`cardForm`: the requests form, plus `cardsState`'s flag); an older engine has none.
const DEFAULT_FORM =
  (engineExports as { cardForm?: (c: typeof DEFAULT_CONFIG) => number }).cardForm?.(DEFAULT_CONFIG) ??
  (DEFAULT_CONFIG.cardsRequestsFix ? CARD_FORM_REQUESTS : 0);
import { SourceMap } from "@eden/graph";
import { Budget, priceFor, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import { QueryPlanner, type ListPage, type Source } from "@eden/sources";
import { simSources, type SimSource } from "../sources";
import { connectorHeader, connectorOptions, pushNotifier, recapNotice, sourceFields } from "./connector-options";
import type { World } from "../world";
import {
  armPromptsHash,
  billingDead,
  BillingStopped,
  emptyResult,
  grade,
  gradeWith,
  MAX_STEPS,
  OverBudget,
  render,
  searchToolSpec,
  systemPrompt,
  TOOL_ITEMS,
  userPrompt,
  worldOf,
  type Meter,
  type Background,
  type RunResult,
  type Task,
} from "./ab-common";
import { variantsFor } from "./neutral";
import { kindSlots, parseKinds, selectionLine, taskSelection } from "./task-kinds";
import { projectTasks, type ProjectionSource } from "./task-projection";
import { observeToolResult } from "./observe-tool";
import { DayLog, isRecap, poolDays, recapOf, shiftClocks, shiftMeta, type DaySummary } from "./pi-day";
import { parseDaySize, parseMix, planUser, suiteTemplates, userWorldOf, withDayRecaps } from "./pi-user";
import {
  argvFields,
  argvFiles,
  codeVersion,
  envFields,
  hashOf,
  JournalRefused,
  partialPath,
  RunJournal,
} from "./run-journal";
import { DiskCardMaker, harnessCoverage, harnessIntent, intentCoverage, intentLine, samePath } from "./cards-disk";
import { isAnthropic, isCapError, keyFor, labAccess, labModel, providerPrefs } from "./free";
import { parseHermesConditions, type HermesCondition } from "./hermes-conditions";
import { edenMcpServer, labRouter, type StreamHost, type TaskBinding } from "./hermes-host";
import { modelProxy, type RequestRecord } from "./hermes-proxy";
import { Worker } from "./hermes-worker";
import { TRAFFIC_WEIGHTS, weightedLines, weightedRow, type WeightedRow } from "./pi-ab-weighted";
import { parseVariants } from "./pi-conditions";
import { piName, spanRouter, Timeline } from "./pi-timeline";
import { effective, PRESETS } from "./presets";
import { overBudget, overBudgetLine, type Budgeted } from "./reader-disk";
import { parseSuites } from "./suites";
import { QUESTION_CHARS, UptakeLog } from "./uptake";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const DRY = args.includes("--dry");
// The OpenRouter key, needed only when some model of the run is not `claude-*` (checked once the models are known).
const KEY = process.env.OPENROUTER_API_KEY;
const HERMES_SRC = resolve(opt("hermes-src", process.env.HERMES_SRC ?? ""));
if (!existsSync(join(HERMES_SRC, "run_agent.py"))) throw new Error(`--hermes-src ${HERMES_SRC}: not a hermes checkout`);
const HERMES_PY = opt("hermes-python", join(HERMES_SRC, ".venv/bin/python"));
if (!existsSync(HERMES_PY)) throw new Error(`--hermes-python ${HERMES_PY}: no such file (uv sync in the checkout)`);
const HERMES_COMMIT = spawnSync("git", ["-C", HERMES_SRC, "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
const LAB_DIR = resolve(dirname(new URL(import.meta.url).pathname), "../../lab/hermes");
const SEEDS = opt("seeds", "41").split(",").map(Number);
const KINDS = args.includes("--kinds") ? parseKinds(opt("kinds", "")) : null;
const MODEL = opt("model", "z-ai/glm-5.3-flash");
const GRADER = opt("grader", "anthropic/claude-haiku-5.5");
const BUDGET = Number(opt("budget", "0.6"));
const SUITE_LIST = parseSuites(opt("suite", "heldout"));
// `neutral` (neutral.ts) runs only on the suites that build it; the others run their hidden and control variants.
const VARIANTS = (args.includes("--days") ? "hidden,control,neutral" : opt("variants", "hidden,control")).split(
  ",",
) as ("hidden" | "control" | "neutral")[];
const CONDITION_NAMES = opt("conditions", "hermes,hermes+eden").split(",");
const OUT = opt("out", "hermes-ab.json");
const TIMELINE = opt("timeline", `${OUT.replace(/\.json$/, "")}.timeline`);
const HOMES = `${OUT.replace(/\.json$/, "")}.homes`;
const TIME_SCALE = Number(opt("time-scale", "1"));
// `--source-profile`, `--push`, `--push-rates` (connector-options.ts), as pi-ab takes them.
const CONNECTORS = connectorOptions(opt);
const LIMITS = { maxTasks: Number(opt("tasks", "30")), maxOffworld: Number(opt("offworld", "5")) };
const LIMIT = Number(opt("limit", "0"));
const TEMPLATES = opt("templates", "") ? new Set(opt("templates", "").split(",")) : null;
const CONCURRENCY = Math.max(1, Number(opt("concurrency", "4")));
// `--days D` (D1044): see the header. 0 (the default) keeps one world per suite and variant, one request a session.
const USER_DAYS = Number(opt("days", "0"));
if (!Number.isInteger(USER_DAYS) || USER_DAYS < 0) throw new Error(`--days must be a whole number, not ${USER_DAYS}`);
const DAYS_ON = USER_DAYS > 0;
const DAY_SIZE = parseDaySize(opt("day-size", "12-20"));
const MIX = parseMix(opt("mix", "1:1:8"));
const GAP_MS = Number(opt("gap-min", "10")) * 60_000;
const NIGHT_MS = Number(opt("night-h", "2")) * 3_600_000;
// `--recap-notice push|signal` (A8), as pi-ab: how the recap announces its moved items.
const RECAP_NOTICE = opt("recap-notice", "push");
if (RECAP_NOTICE !== "push" && RECAP_NOTICE !== "signal") throw new Error("--recap-notice must be push or signal");
if (DAYS_ON) {
  for (const f of ["variants", "templates"]) {
    if (args.includes(`--${f}`)) throw new Error(`--days plans the user's requests itself: it cannot take --${f}`);
  }
  if (!(GAP_MS > 0) || !(NIGHT_MS >= 0)) throw new Error("--gap-min must be > 0 and --night-h ≥ 0");
}
// pi-ab's cap is MAX_STEPS model calls a task; Hermes counts tool-calling iterations, the same unit.
const MAX_ITERATIONS = Number(opt("max-iterations", String(MAX_STEPS)));
const AGENT_MAX_TOKENS = 2_000;
// `--dump FILE`: every chat completion Hermes sends, as forwarded (sim data only; for checking the prompt and tools).
const DUMP = opt("dump", "");
const CONFIG_ARG = opt("config", "default");
const CONFIG = PRESETS[CONFIG_ARG] ?? (JSON.parse(CONFIG_ARG) as Record<string, unknown>);
const CARD_MODEL = opt("card-model", "z-ai/glm-5.3-flash");
const CONFIG_VARIANTS = parseVariants(opt("variant-config", "{}"));
const CONDITIONS: HermesCondition[] = parseHermesConditions(CONDITION_NAMES, {
  config: CONFIG,
  variants: CONFIG_VARIANTS,
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
});
const usesCards = CONDITIONS.some((c) => c.withPartner && effective(c.config).cards);
/** `askReader` (D95): the ask-time reader's model, `--reader-model` (default Haiku 5.5, on the spend ledger). */
const READER_MODEL = opt("reader-model", "claude-haiku-5-5");
const USES_READER = CONDITIONS.some((c) => c.withPartner && effective(c.config).askReader);
/**
 * `pushCheck` (D500, in the default since D828): the push check, on the reader's model as the servers wire it
 * (`buildPartner`), `--check-model` (default Haiku 5.5). Before B19 (D1042) hermes-ab wired no checker, so every
 * Hermes run left the default's `check` part inert.
 */
const CHECK_MODEL = opt("check-model", "claude-haiku-5-5");
const USES_CHECK = CONDITIONS.some((c) => c.withPartner && effective(c.config).pushCheck);
const RUN_MODELS = [
  MODEL,
  GRADER,
  ...(usesCards ? [CARD_MODEL] : []),
  ...(USES_READER ? [READER_MODEL] : []),
  ...(USES_CHECK ? [CHECK_MODEL] : []),
];
const ACCESS = labAccess(args, RUN_MODELS);
// Every model on Anthropic (`claude-*`, D97): no OpenRouter key needed, and none is used.
if (!KEY && !DRY && RUN_MODELS.some((m) => !isAnthropic(m))) throw new Error("needs OPENROUTER_API_KEY");
const PACER = ACCESS.pacer;
/** A task starts only while the cap leaves room for all of it: its model requests (one spare) and its grading. */
const TASK_REQUESTS = MAX_ITERATIONS + 2;
let capStopped = 0;
let billingStopped = 0;
// `--coverage` (D878): shipped coverage by default where it covers the run, replayed as cards and intent; a run that
// names its own `--cards`/`--intent` pins `--coverage full`.
const COVERAGE = harnessCoverage({
  coverage: opt("coverage", ""),
  cards: opt("cards", ""),
  intent: opt("intent", "default"),
  suites: SUITE_LIST,
  seeds: SEEDS,
  // The default's card prompt form (D1062): shipped coverage covers only the shards that hold its lines (D1063).
  form: DEFAULT_FORM,
});
const CARDS_FILE = COVERAGE.cards;
const CARDS_OUT = opt("cards-out", `${OUT.replace(/\.json$/, "")}.cards.jsonl`);
if (CARDS_FILE && samePath(CARDS_OUT, CARDS_FILE)) throw new Error(`--cards-out ${CARDS_OUT} is the --cards file`);
if (CARDS_FILE && !existsSync(CARDS_FILE)) throw new Error(`--cards ${CARDS_FILE}: no such file`);
// The intent requests (D158), resolved as pi-ab does: the checked-in file by default where it covers the run, with
// cards replayed and intent on; `--intent none` opts out; a run it does not cover is labelled intent inert.
const INTENT_WANTED = CONDITIONS.some((c) => c.withPartner && effective(c.config).intent && effective(c.config).cards);
const INTENT = harnessIntent(COVERAGE.intent, {
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

// ---- Spend: one hard cap over every call, reserved before the call at its worst case and settled at its real cost.
let spent = 0;
let held = 0;
const spend = { agent: 0, eden: 0, grader: 0 };
/** Every lane's reader and cards, for the calls their `Budget()` refused (the summary's `overBudget:` line). */
const budgeted: Budgeted = { reader: [], cards: [] };
/** Each day's summary under `--days`, with the recap turn's own cost (a probe: no task's cost includes it). */
const DAYS: (DaySummary & { seed: number; kind: string; partial?: boolean; recapUsd?: number })[] = [];
/** One journal line's data (`--resume`, D813): a unit's results, timeline records, day summaries and spend. */
interface JournalUnit {
  results: RunResult[];
  records: TaskRecord[];
  days: typeof DAYS;
  spend: { agent: number; eden: number; grader: number };
}
/** A unit being run: complete once its task (or its day's recap) ends; `ok` false when a grading failed. */
interface OpenUnit {
  id: string;
  complete: boolean;
  ok: boolean;
  grades: Promise<void>[];
  data: JournalUnit;
}
/** What `--resume` took from the journal instead of running it (pi-ab's fields). */
const resumed = { units: 0, tasks: 0, unitsUsd: 0, spentBeforeUsd: 0, biased: false };
/** Opened once the worlds are known (below); null without a journal. */
let JOURNAL: RunJournal<JournalUnit> | null = null;
/** Every stream's push checker, for the run's CHECK line. */
const checkers: PushChecker[] = [];
/** Each stream's background spend (cards), for the report's all-in cost columns (ab-common.ts). */
const background: Background[] = [];
function reserve(est: number): void {
  if (spent + held + est > BUDGET) throw new OverBudget(`budget $${BUDGET} reached (spent $${spent.toFixed(4)})`);
  held += est;
}
function settle(est: number, cost: number, who: keyof typeof spend): void {
  held = Math.max(0, held - est);
  spent += cost;
  spend[who] += cost;
}
const worstCase = (model: string, inputChars: number, maxTokens: number) => {
  const p = priceFor(model);
  return (Math.ceil(inputChars / 4) * p.input + maxTokens * p.output) / 1_000_000;
};
const exhausted = () => spent + held >= BUDGET * 0.98;

/** A source as Eden sees it, each call timed onto `onCall` (as pi-ab's `watched`). */
function watched(source: SimSource, onCall: (op: string, start: number, end: number, status: string) => void): Source {
  const timed = async <T>(op: string, run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      const out = await run();
      onCall(op, start, performance.now(), "ok");
      return out;
    } catch (e) {
      onCall(op, start, performance.now(), e instanceof Error ? e.name : "error");
      throw e;
    }
  };
  return {
    ...sourceFields(source),
    search: (query, signal) => timed("search", () => source.search(query, signal)),
    fetch: (ref, scope, signal) => timed("fetch", () => source.fetch(ref, scope, signal)),
    list: (scope, cursor, limit, signal) => timed("list", () => source.list(scope, cursor, limit, signal)),
  };
}

/** Eden's model calls (cards) as the engine sees them: reserved against the cap, timed onto `onCall`. */
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
        r.edenCostUsd += res.costUsd;
      }
      return res;
    },
  };
}

/** What a task records beside its result: pi-ab's `TaskRecord`, plus Hermes' own counts. */
interface TaskRecord {
  task: string;
  condition: string;
  suite: string;
  kind: Task["kind"];
  seed: number;
  wallMs: number;
  firstTokenMs: number | null;
  requests: RequestRecord[];
  events: Timeline["events"];
  dropped: number;
  error?: string;
  planted?: string;
  packets?: string;
  cited?: string[];
  askCited?: string[];
  /** Hermes' system prompt, in characters, and the tools it sent: the fixed cost of every request. */
  systemChars?: number;
  toolNames?: string[];
  /** Hermes' own count of its API calls for the task, beside the requests the proxy booked (`requests`). */
  apiCalls?: number;
}

const TASK_TIMEOUT_MS = 10 * 60_000;
/** A worker that died is started again this many times in a stream before the stream stops. */
const RESPAWNS = 2;
let stoppedStreams = 0;

/** A Hermes worker for one stream, with its own HERMES_HOME and the stream's local routes. */
function startWorker(id: string, home: string): Worker {
  const base = `http://127.0.0.1:${port}/s/${id}`;
  return new Worker(
    [HERMES_PY, "-I", join(LAB_DIR, "worker.py")],
    {
      PATH: process.env.PATH ?? "",
      HOME: home,
      HERMES_HOME: home,
      HERMES_SRC,
      HERMES_TIMEZONE: "UTC",
      HERMES_LAB_BASE_URL: `${base}/v1`,
      EDEN_LAB_URL: `${base}/eden`,
      // Hermes' own TLS/proxy settings, if the machine needs them for anything it fetches on its own; the runner's
      // routes are local and must not go through a proxy.
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
    },
    // Beside the home, not in it: Hermes tidies its home on start.
    `${home}.log`,
  );
}

/**
 * Starts a stream's worker and waits for it to be ready, before any task's timeline starts (its Python start and MCP
 * connection are the stream's cost, not the first task's). In an Eden condition the worker must have Eden's
 * `ask_context`: a stream without it would run the Eden arm without Eden's tool.
 */
async function readyWorker(id: string, home: string, eden: boolean): Promise<Worker> {
  const worker = startWorker(id, home);
  const ready = await worker.started();
  if (!ready.ok) throw new Error(`stream ${id}: the Hermes worker did not start: ${ready.error}`);
  if (eden && !ready.mcpTools.some((t) => t.endsWith("ask_context"))) {
    worker.close();
    throw new Error(`stream ${id}: Hermes has no ask_context (MCP tools: ${ready.mcpTools.join(", ") || "none"})`);
  }
  return worker;
}
const streams = new Map<string, StreamHost>();
let port = 0;

/** The config.yaml of one stream's HERMES_HOME: its MCP servers, and the Eden plugin in Eden conditions. */
function hermesConfig(id: string, eden: boolean): string {
  const base = `http://127.0.0.1:${port}/s/${id}/mcp`;
  return (
    "mcp_servers:\n" +
    `  sources:\n    url: "${base}/sources"\n    timeout: 60\n` +
    (eden ? `  eden:\n    url: "${base}/eden"\n    timeout: 60\n` : "") +
    (eden ? "plugins:\n  enabled:\n    - eden\n" : "") +
    // Every tool eager, as pi-ab gives them: Hermes' default would hide MCP tools behind its tool_search meta-tools.
    "tools:\n  tool_search:\n    enabled: off\n" +
    // Hermes would otherwise probe the endpoint for the model's context length on every new agent.
    "model:\n  context_length: 128000\n"
  );
}

/** One world under one condition: a fresh Eden (if any) and a fresh Hermes worker see the world's tasks in order. */
async function runWorld(
  id: string,
  shared: World,
  seed: number,
  baseTasks: Task[],
  cond: HermesCondition,
  records: TaskRecord[],
  grading: Promise<void>[],
  /** `--days`: the user's requests per day, in order. */
  daySizes: readonly number[] | undefined,
  /** The world's index in `worlds`: part of each journal unit's id (`--resume`). */
  wi: number,
): Promise<RunResult[]> {
  // `--days` changes items before each recap: each stream gets its own copy, since every arm reads the same world.
  const world: World = DAYS_ON ? { ...shared, items: shared.items.map((i) => ({ ...i })) } : shared;
  const userPrefix = `w${seed}:user`;
  const tasks = daySizes
    ? withDayRecaps(baseTasks, daySizes, (t, d) => recapOf(t, `${userPrefix}:day${d}:recap`))
    : baseTasks;
  const sources = simSources(world, CONNECTORS.profiles, TIME_SCALE, seed);
  const notify = pushNotifier(sources, CONNECTORS, seed, world.now);
  const { name: condition, waitMs, withPartner, config, eden, useTools } = cond;
  const scope = { tenantId: "ab", userId: `w${seed}` };
  let clock = world.now;
  let current: Timeline | null = null;
  const bySession = new Map<string, { r: RunResult; tl: Timeline }>();
  // Every connector call Eden makes in this stream, in a task's window or not (the backfill, the sync's ticks between
  // tasks): `Background.sourceCalls`, priced per connector plan by pi-cost-report.ts, as pi-ab records it (A27).
  let edenCalls = 0;
  const edenSources = sources.map((s) =>
    watched(s, (op, start, end, status) => {
      edenCalls++;
      bg.sourceCalls = edenCalls;
      current?.span("eden.source", "eden", "bg", start, end, { source: s.id, op, status });
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
  const cardModel = () =>
    meteredModel(labModel(ACCESS, { apiKey: KEY!, model: CARD_MODEL }, "eden.cards"), (start, end, data) => {
      onBg("cardsUsd", data);
      current?.span("eden.cards", "eden", "bg", start, end, data);
    });
  const cardMaker = (): CardMaker =>
    diskCards
      ? new DiskCardMaker(CARDS_FILE, new ModelCardMaker(cardModel()), { out: CARDS_OUT, shared: diskCards })
      : new ModelCardMaker(cardModel());
  const cards =
    withPartner && effective(config).cards
      ? new CardEnricher({ maker: cardMaker(), budget: new Budget(), now: () => clock })
      : undefined;
  if (cards) budgeted.cards.push(cards);
  if (cards) background.push(bg);
  else if (withPartner) {
    // An Eden stream with cards off still makes connector calls: booked for those only, and `noModels` keeps it out of
    // the card backfill each seed's model reports spread (as pi-ab books it, A27).
    bg.noModels = true;
    background.push(bg);
  }
  // `askReader`: one budgeted call per ask about an action, on the running task's timeline and charged to it (D95).
  let readerTask: RunResult | null = null;
  const reader =
    withPartner && effective(config).askReader
      ? new AskReader({
          maker: new ModelReaderMaker(
            meteredModel(
              ownedModel(
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
  // `pushCheck` (D500, D828): one budgeted call per push whose pool is constraint-like, charged to the running task.
  const checker =
    withPartner && effective(config).pushCheck
      ? new PushChecker({
          model: meteredModel(
            ownedModel(
              labModel(ACCESS, { apiKey: KEY ?? "", model: CHECK_MODEL, timeoutMs: 60_000 }, "eden.check"),
              () => readerTask,
            ),
            (start, end, data) => current?.span("eden.check", "eden", "path", start, end, data),
          ),
          budget: new Budget(),
        })
      : undefined;
  if (checker) checkers.push(checker);
  const partner = withPartner
    ? new ContextPartner({
        sources: async () => edenSources,
        sourceMap: new SourceMap(":memory:", { seed }),
        cache: new ItemCache(),
        budget: new Budget(),
        model: null,
        planner: new QueryPlanner({ seed }),
        now: () => clock,
        config,
        ...(cards ? { cards } : {}),
        ...(reader ? { reader } : {}),
        ...(checker ? { checker } : {}),
        onTrace: (t) => {
          const owner = bySession.get(t.sessionId);
          if (!owner) return;
          // The reader's and the check's parts are charged by `ownedModel` (a late call too): not counted again here.
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
          const start = sp.startMs - performance.timeOrigin;
          const end = sp.endMs - performance.timeOrigin;
          const calls = sp.attrs?.calls;
          bySession
            .get(session)
            ?.tl.span(`eden.${name}`, "eden", "bg", start, end, calls === undefined ? undefined : { calls });
        }),
      })
    : null;
  const sync = partner?.sync ?? null;
  if (sync) {
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
  if (cards) await cards.idle();
  // What the backfill (the sync's warm-up and its cards) cost before the first request: the user's one-time spend
  // (H16), split from what the cards spend while the user works, as pi-ab does. Before A27 Hermes results lacked it,
  // so the report put the whole backfill in the in-run background column.
  bg.setupUsd = bg.cardsUsd;
  bg.setupCalls = bg.calls;
  bg.setupSourceCalls = edenCalls;
  bg.sourceCalls = edenCalls;

  // The stream's state the routes read: the running task's binding, timeline, record and result.
  let task: {
    binding: TaskBinding;
    tl: Timeline;
    record: TaskRecord;
    r: RunResult;
    sessionId: string;
    uptake: UptakeLog;
  } | null = null;
  const host: StreamHost = {
    get current() {
      return task?.binding ?? null;
    },
    sourcesServer() {
      const server = new McpServer({ name: "sources", version: "0.0.0" });
      for (const source of sources) {
        const spec = searchToolSpec(source);
        server.registerTool(
          spec.name,
          {
            description: spec.description,
            inputSchema: { query: z.string().describe("What to search for") },
            annotations: { readOnlyHint: true },
          },
          async ({ query }) => {
            const t = task;
            const span = t?.tl.begin(`tool.${spec.name}`, "tool", "path", { tool: spec.name });
            const items = await source
              .search({ scope, text: query, entities: [], limit: TOOL_ITEMS }, AbortSignal.timeout(10_000))
              .catch((e: unknown) => `Error: ${e instanceof Error ? e.message : String(e)}`);
            if (t && span !== undefined) t.tl.end(span, { error: typeof items === "string" });
            return { content: [{ type: "text" as const, text: typeof items === "string" ? items : render(items) }] };
          },
        );
      }
      return server;
    },
    edenServer() {
      if (!eden || !partner) return null;
      // Eden's own MCP server; each answer is recorded on the task that asked (uptake), and refused between tasks.
      return edenMcpServer(partner, scope, () => {
        const t = task;
        if (!t) return null;
        return {
          sessionId: t.sessionId,
          answered(a, q, startedAt) {
            const question = sanitizeForStore(q);
            t.uptake.answer(a, question);
            day?.answer(
              a.citations.map((c) => c.itemId),
              a.answer,
            );
            t.tl.span("tool.ask_context", "eden", "path", startedAt, performance.now(), { items: a.citations.length });
            t.tl.point("eden.ask", { question: question.slice(0, QUESTION_CHARS), items: a.citations.length });
          },
        };
      });
    },
    model: (path, req) => proxy(path, req, () => task),
  };
  streams.set(id, host);

  const home = resolve(HOMES, id);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), hermesConfig(id, eden));
  if (eden) cpSync(join(LAB_DIR, "eden"), join(home, "plugins/eden"), { recursive: true });
  // `hermes-eden` (A16): Eden in place of the per-source search tools, as Pi's `eden` arm.
  const toolsets = [...(useTools ? ["mcp-sources"] : []), ...(eden ? ["mcp-eden"] : [])];

  const out: RunResult[] = [];
  let previous: { sessionId: string; r: RunResult } | null = null;
  const closePrevious = async () => {
    if (!partner || !previous) return;
    const who = { ...scope, sessionId: previous.sessionId };
    previous.r.lateItems = partner.takePending(who).reduce((n, i) => n + i.citations.length, 0);
    await partner.observe({ ...who, at: clock, kind: "session_end" });
    previous = null;
  };
  /**
   * `--resume` (D813): the open journal unit (a task, or with `--days` a whole day through its recap). It is written
   * once complete, graded and error-free (`flush`); a unit found in the journal is not run: its results are taken as
   * they were (`adopt`), and only what changes the world or Eden's clock is replayed.
   */
  let unit: OpenUnit | null = null;
  const unitId = (t: Task, d: number) => `${wi}|${condition}|${DAYS_ON ? `day${d}` : t.id}`;
  const flush = () => {
    const u = unit;
    unit = null;
    if (!u || !JOURNAL || !u.complete) return;
    const journal = JOURNAL;
    grading.push(
      Promise.all(u.grades).then(() => {
        if (!u.ok || u.data.results.some((x) => x.error)) return;
        try {
          journal.write(u.id, u.data);
          journal.noteSpent(spent);
        } catch (e) {
          console.error(`hermes-ab: ${e instanceof Error ? e.message : e}`);
        }
      }),
    );
  };
  const adopt = (u: JournalUnit) => {
    out.push(...u.results);
    records.push(...u.records);
    DAYS.push(...u.days);
    bg.tasks.push(...u.results.map((x) => x.task));
    // `spent` already holds every earlier attempt's spend (`spentBeforeUsd`); the buckets get what these tasks cost.
    for (const k of ["agent", "eden", "grader"] as const) spend[k] += u.spend[k];
    resumed.units++;
    resumed.tasks += u.results.length;
    resumed.unitsUsd += u.spend.agent + u.spend.eden + u.spend.grader;
  };
  // `--days`: the day's log, Eden session, Hermes transcript (held here, sent with each request) and planted items.
  let day: DayLog | null = null;
  let dayNo = -1;
  let newDay = true;
  let daySession = "";
  let dayStartMs = 0;
  let dayKind = "";
  let dayMessages: unknown[] = [];
  const dayPlanted = new Set<string>();
  let worker: Worker | null = null;
  let respawns = 0;
  let lagTimer: ReturnType<typeof setInterval> | undefined;
  const respawn = async (why: string) => {
    if (respawns++ >= RESPAWNS) throw new Error(`the Hermes worker died ${respawns} times`);
    console.error(`stream ${id} (${condition}): ${why}; starting it again`);
    worker?.close();
    worker = await readyWorker(id, home, eden);
  };
  try {
    worker = await readyWorker(id, home, eden);
    for (const { task: t, run } of kindSlots(tasks, KINDS)) {
      if (unit?.complete) flush();
      const fromJournal = JOURNAL?.done.get(unitId(t, DAYS_ON && newDay ? dayNo + 1 : dayNo));
      if (!fromJournal && exhausted()) break;
      // A dead key fails every model call the same way: stop scheduling units, keep what ran (PARTIAL below).
      if (!fromJournal && billingDead()) {
        billingStopped++;
        break;
      }
      if (!fromJournal && PACER.remaining < TASK_REQUESTS) {
        capStopped++;
        break;
      }
      // An hour between tasks: Eden's clock, for its caches and planner. `--days`: `--gap-min` between requests and
      // `--night-h` before each day after the first (the recap closed the day before).
      clock += daySizes ? (newDay && dayNo >= 0 ? NIGHT_MS : GAP_MS) : 3_600_000;
      // Between tasks no task's timeline is current: the sync's tick and the notices are background.
      current = null;
      if (sync) await sync.tick();
      notify(partner, scope);
      if (DAYS_ON && newDay) {
        dayNo++;
        daySession = `${userPrefix}:day${dayNo}`;
        day = new DayLog(daySession, condition);
        dayMessages = [];
        dayPlanted.clear();
        dayKind = t.kind;
        dayStartMs = clock;
      }
      const startsDay = !DAYS_ON || newDay;
      newDay = DAYS_ON && isRecap(t);
      day?.turn();
      if (DAYS_ON && !isRecap(t) && t.planted) dayPlanted.add(t.planted);
      if (DAYS_ON && day && isRecap(t)) {
        // pi-ab's recap: the day's planted items' clock times move, the sources serve the new text, and the change is
        // announced as `--push` says; only before the recap, which is never graded.
        const touched = new Set<string>();
        const movedIds = new Set<string>();
        for (const pid of dayPlanted) {
          const it = world.items.find((x) => x.id === pid);
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
          if (touched.size > 0 && movedIds.size === 0) throw new Error("recap moved items but named none");
          if (RECAP_NOTICE === "signal") for (const sid of touched) partner.sourceChanged(scope, sid);
          else await recapNotice(partner, scope, sources, movedIds, CONNECTORS.push);
          // The change lands two hours before the recap: what the notice started has settled by then (bounded).
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            partner.revisionsSettled(scope),
            new Promise((res) => (timer = setTimeout(res, 10_000))),
          ]);
          clearTimeout(timer);
        }
      }
      if (fromJournal) {
        // A unit an earlier attempt finished: no agent, no grader, no observe. The clock, the sync's tick and the
        // recap's moves (above) still happen, so the later units see the world they saw.
        if (startsDay) await closePrevious();
        if (DAYS_ON) {
          if (!isRecap(t) && t.planted) dayPlanted.add(t.planted);
          if (isRecap(t)) {
            day = null;
            adopt(fromJournal);
          }
        } else adopt(fromJournal);
        continue;
      }
      if (!run) {
        if (startsDay) await closePrevious();
        continue;
      }
      if (JOURNAL && !unit) {
        unit = {
          id: unitId(t, dayNo),
          complete: false,
          ok: true,
          grades: [],
          data: { results: [], records: [], days: [], spend: { agent: 0, eden: 0, grader: 0 } },
        };
      }
      // A worker that died (a crash, or a timeout that killed it) is started again before the next task is bound.
      if (!worker.alive) await respawn("the Hermes worker died");
      if (startsDay) await closePrevious();
      const sessionId = DAYS_ON ? daySession : t.id;
      const r = emptyResult(t.id, condition);
      const tl = new Timeline();
      // Loop-lag probe (D2086): lh10's ~280 s tool spans looked like connector stalls but could be the host's loop
      // starved by uninstrumented work; the largest sampled drift decides. Stream-scoped so a task that throws
      // before its cleanup (a respawn that gives up, a dead worker) still clears it.
      let lastTick = performance.now();
      let maxLoopLag = 0;
      lagTimer = setInterval(() => {
        const now = performance.now();
        maxLoopLag = Math.max(maxLoopLag, now - lastTick - 100);
        lastTick = now;
      }, 100);
      lagTimer.unref();
      current = tl;
      bySession.set(sessionId, { r, tl });
      readerTask = r;
      const record: TaskRecord = {
        task: t.id,
        condition,
        suite: t.suite,
        kind: t.kind,
        seed,
        wallMs: 0,
        firstTokenMs: null,
        requests: [],
        events: tl.events,
        dropped: 0,
        ...(t.planted ? { planted: t.planted } : {}),
      };
      const uptake = new UptakeLog();
      const ev = (e: Record<string, unknown>) => ({ ...scope, sessionId, at: clock, ...e }) as AgentEvent;
      const deliver = (items: { text: string; citations: { itemId: string }[]; mode?: string }[]) => {
        for (const i of items) {
          r.injectedItems += i.citations.length;
          r.injectedChars += i.text.length;
          uptake.packet(i as unknown as Parameters<UptakeLog["packet"]>[0]);
          day?.packet(
            i.citations.map((c) => c.itemId),
            i.text,
          );
          tl.point("eden.inject", {
            items: i.citations.length,
            chars: i.text.length,
            ids: i.citations.map((c) => c.itemId),
          });
        }
        return items.map((i) => i.text).join("\n\n");
      };
      let observed = false;
      /** Packets a tool result's observe handed out, placed at the next `pending` (`transform_tool_result`). */
      const handed: Parameters<typeof deliver>[0] = [];
      const binding: TaskBinding = {
        token: crypto.randomUUID(),
        async observe() {
          if (!partner) return "";
          if (observed) return deliver(partner.takePending({ ...scope, sessionId }));
          observed = true;
          // One Eden session a day under `--days`: it starts with the day's first request.
          if (startsDay) {
            const o = tl.begin("eden.observe", "eden", "path", { event: "session_start" });
            await partner.observe(ev({ kind: "session_start", agent: "hermes" }));
            tl.end(o);
          }
          const arriving = t.event === "external" ? { source: "gmail" } : {};
          const o2 = tl.begin("eden.observe", "eden", "path", { event: t.event });
          const first = await partner.observe(ev({ kind: t.event, text: t.text, ...arriving }), { waitMs });
          tl.end(o2, { injected: first.injection?.citations.length ?? 0, pending: first.pending });
          return deliver([
            ...(first.injection ? [first.injection] : []),
            ...partner.takePending({ ...scope, sessionId }),
          ]);
        },
        async tool(tool, output) {
          if (!partner) return;
          const o = tl.begin("eden.observe", "eden", "path", { event: "tool_result" });
          // A packet the observe hands out is kept for the next `pending`, which places it (`observe-tool.ts`).
          const injected = await observeToolResult(partner, ev({ kind: "tool_result", tool, output }), (i) =>
            handed.push(i),
          );
          tl.end(o, { injected });
        },
        pending() {
          return partner ? deliver([...handed.splice(0), ...partner.takePending({ ...scope, sessionId })]) : "";
        },
      };
      task = { binding, tl, record, r, sessionId, uptake };
      tl.point("task.start", { condition, kind: t.kind });
      const request = {
        op: "run",
        task: t.id,
        token: binding.token,
        system: systemPrompt(world, { lookups: false, data: true, edenGuide: cond.edenGuide }),
        prompt: userPrompt(t),
        nowMs: clock,
        model: MODEL,
        maxIterations: MAX_ITERATIONS,
        maxTokens: AGENT_MAX_TOKENS,
        toolsets,
        // `--days`: the day's transcript so far, one session id a day, and the transcript back for the next request.
        ...(DAYS_ON ? { history: dayMessages, sessionMs: dayStartMs, session: daySession, keep: true } : {}),
      };
      let sent = await worker.run(request, TASK_TIMEOUT_MS);
      // Never sent (the worker died between its last task and this one): not a task, not an error; the same request
      // goes to a fresh worker (under `--days` with the same transcript, which this process holds).
      while (!sent.ran) {
        await respawn(`${t.id} was not sent (worker dead)`);
        sent = await worker.run(request, TASK_TIMEOUT_MS);
      }
      task = null;
      const reply = sent.msg;
      const error = typeof reply.error === "string" && reply.error ? reply.error : undefined;
      if (error)
        r.error = PACER.exhausted
          ? `request cap reached: ${error.slice(0, 120)}`
          : billingDead()
            ? `billing stopped: ${error.slice(0, 120)}`
            : error;
      r.answer = typeof reply.answer === "string" ? reply.answer : "";
      if (!r.error && !r.answer.trim()) r.error = "empty answer";
      if (DAYS_ON && Array.isArray(reply.messages)) dayMessages = reply.messages;
      const toolCalls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
      r.toolCalls = toolCalls.length;
      r.wallMs = performance.now() - tl.origin;
      clearInterval(lagTimer);
      lagTimer = undefined;
      r.maxLoopLagMs = Math.max(0, Math.round(maxLoopLag));
      if (r.maxLoopLagMs > 5_000) tl.point("lab.looplag", { ms: r.maxLoopLagMs });
      r.leaked = t.secrets.some((x) => r.answer.includes(x));
      tl.point("task.end", { error: !!r.error });
      record.wallMs = Math.round(r.wallMs);
      record.firstTokenMs = record.requests[0]?.firstTokenMs ?? null;
      if (typeof reply.systemChars === "number") record.systemChars = reply.systemChars;
      if (Array.isArray(reply.toolNames)) record.toolNames = reply.toolNames as string[];
      if (typeof reply.apiCalls === "number") record.apiCalls = reply.apiCalls;
      if (r.error) record.error = r.error.slice(0, 200);
      if (partner) Object.assign(record, uptake.fields());
      if (DAYS_ON && day) {
        if (!isRecap(t) && t.planted) dayPlanted.add(t.planted);
        if (isRecap(t)) {
          // The recap is measured, never graded or reported as a task; its cost is kept with the day.
          day.recap(r.error ? "" : r.answer);
          const summary = { ...day.summary(), seed, kind: t.kind, recapUsd: r.costUsd, recapEdenUsd: r.edenCostUsd };
          DAYS.push(summary);
          if (unit) {
            unit.data.days.push(summary);
            unit.data.spend.agent += r.costUsd;
            unit.data.spend.eden += r.edenCostUsd;
            // A recap that failed is part of the day: the day runs again.
            if (r.error) unit.ok = false;
            unit.complete = true;
          }
          day = null;
          previous = { sessionId, r };
          continue;
        }
      }
      out.push(r);
      bg.tasks.push(r.task);
      records.push(record);
      if (unit) {
        unit.data.results.push(r);
        unit.data.records.push(record);
        unit.data.spend.agent += r.costUsd;
        unit.data.spend.eden += r.edenCostUsd;
        if (!DAYS_ON) unit.complete = true;
      }
      if (!r.error) {
        const graded = gradeTask(t, r, tl, unit);
        grading.push(graded);
        unit?.grades.push(graded);
      }
      previous = { sessionId, r };
    }
    // A day cut short (budget, request cap) is still reported, marked partial; it is not complete, so not journalled.
    if (day) DAYS.push({ ...day.summary(), seed, kind: dayKind, partial: true });
    await closePrevious();
    flush();
  } catch (e) {
    // A stopped stream keeps what it ran: its results stand, the run is marked partial and says why.
    stoppedStreams++;
    console.error(
      `stream ${id} (${condition}) stopped after ${out.length} tasks: ${e instanceof Error ? e.message : e}`,
    );
  } finally {
    if (lagTimer !== undefined) clearInterval(lagTimer);
    current = null;
    task = null;
    worker?.close();
    streams.delete(id);
  }
  return out;
}

/** Grading runs beside the next task, on this task's timeline: the agent never waits for it (as pi-ab). */
async function gradeTask(t: Task, r: RunResult, tl: Timeline, unit: OpenUnit | null): Promise<void> {
  const g = tl.begin("grading", "grading", "bg");
  const est = worstCase(GRADER, 4_000 + r.answer.length + t.text.length, 2_000);
  let reserved = false;
  let cost = 0;
  let failure = "";
  try {
    if (t.must.length > 0 && r.answer.trim()) {
      reserve(est);
      reserved = true;
    }
    const meter: Meter = { before: () => {}, after: (c) => (cost = c) };
    r.facts = GRADER_MODEL
      ? await gradeWith(GRADER_MODEL, t, r.answer, (c) => (cost = c))
      : (await grade(KEY!, meter, GRADER, t, r.answer, { fetch: ACCESS.fetch, allowLogging: ACCESS.allowLogging }))
          .facts;
  } catch (e) {
    failure =
      e instanceof BillingStopped
        ? "billing stopped"
        : isCapError(e)
          ? "request cap reached"
          : e instanceof Error
            ? e.message.slice(0, 60)
            : "error";
  } finally {
    if (reserved) settle(est, cost, "grader");
    tl.end(g, { cost, ...(failure ? { error: failure } : {}) });
    // The open journal unit books the grade's cost and is not written if it failed.
    if (unit) {
      unit.data.spend.grader += cost;
      if (failure) unit.ok = false;
    }
  }
}

let orphanRequests = 0;
/** A `claude-*` grader goes through `AnthropicModel` on the spend ledger; any other through OpenRouter (`grade`). */
const GRADER_MODEL = isAnthropic(GRADER) ? labModel(ACCESS, { apiKey: "", model: GRADER }, "grader") : null;
const AGENT_METER = isAnthropic(MODEL) ? ACCESS.ledger!.meter("agent") : null;
/** Hermes' model endpoint (hermes-proxy.ts): the pacer, the run's budget, and the key kept in this process. */
const proxy = modelProxy({
  key: KEY ?? "",
  fetch: ACCESS.fetch,
  model: MODEL,
  maxTokens: AGENT_MAX_TOKENS,
  extraBody: providerPrefs(ACCESS),
  reserve,
  settle: (est, cost) => settle(est, cost, "agent"),
  price: (chars, out) => worstCase(MODEL, chars, out),
  isCapError,
  ...(DUMP ? { dump: (line: unknown) => appendFileSync(DUMP, `${JSON.stringify(line)}\n`) } : {}),
  onOrphan: () => orphanRequests++,
  ...(AGENT_METER
    ? {
        anthropic: {
          key: keyFor(MODEL),
          reserveLedger: (est: number) => AGENT_METER.reserve(est),
          releaseLedger: (est: number) => AGENT_METER.release(est),
          book: (record) => ACCESS.ledger!.write("agent", record),
        },
      }
    : {}),
});

/** `--limit` on a user: the first N requests, the day sizes cut to match (pi-ab's). */
const cutDays = (sizes: number[], n: number) =>
  sizes.map((k, d) => Math.max(0, Math.min(k, n - sizes.slice(0, d).reduce((a, b) => a + b, 0)))).filter((k) => k > 0);
const worlds: {
  seed: number;
  world: World;
  tasks: Task[];
  suite: string;
  variant: string;
  daySizes?: number[];
  clashes?: number;
}[] = DAYS_ON
  ? SEEDS.map((seed) => {
      const plan = planUser(seed, suiteTemplates(seed, SUITE_LIST), { days: USER_DAYS, size: DAY_SIZE, mix: MIX });
      const u = userWorldOf(seed, plan);
      const cut = LIMIT > 0 ? { ...u, tasks: u.tasks.slice(0, LIMIT), daySizes: cutDays(u.daySizes, LIMIT) } : u;
      return { ...cut, suite: "user", variant: "days" };
    })
  : SEEDS.flatMap((seed) =>
      SUITE_LIST.flatMap((suite) =>
        variantsFor(suite, VARIANTS).map((variant) => {
          const w = worldOf(seed, suite, variant, LIMITS);
          const picked = TEMPLATES ? { ...w, tasks: w.tasks.filter((t) => TEMPLATES.has(t.type)) } : w;
          return { ...(LIMIT > 0 ? { ...picked, tasks: picked.tasks.slice(0, LIMIT) } : picked), suite, variant };
        }),
      ),
    );
// The requests replayed for the items the run's sources hold, counted before anything is spent (`--dry` shows it).
const SELECTION = taskSelection(
  KINDS,
  worlds.flatMap((w) => w.tasks),
);
const selectedCount = (tasks: Task[]) => tasks.filter((t) => !KINDS || KINDS.includes(t.kind)).length;
console.error(selectionLine(SELECTION));
if (opt("project-from", "")) {
  const reference = JSON.parse(readFileSync(opt("project-from", ""), "utf8")) as ProjectionSource;
  const p = projectTasks(
    reference,
    worlds.flatMap((w) => w.tasks),
    CONDITIONS.map((c) => c.name),
    SELECTION,
    { model: MODEL, grader: GRADER },
  );
  console.error(
    `PROJECTED COST: $${p.projectedUsd.toFixed(4)}; ${p.tasks} graded tasks; ` +
      `$${p.fixedUsd.toFixed(4)} recap/background fixed; historical kind means incl. grader, not a cap`,
  );
} else if (DRY) console.error("PROJECTED COST: unavailable (pass --project-from completed-results.json)");
if (KINDS && !worlds.some((w) => selectedCount(w.tasks))) throw new Error("--kinds selects no tasks");
const intentCount =
  INTENT_WANTED && diskCards
    ? intentCoverage(
        worlds.map((w) => simSources(w.world, CONNECTORS.profiles, 0, w.seed).flatMap((s) => s.listAll())),
        diskCards.requests,
        // Under the default's card prompt form (D1062, D1063), as the run's enrichment reads them.
        (it) => diskCards.requestKey(it, DEFAULT_FORM),
      )
    : { found: 0, of: 0 };
const INTENT_LINE = intentLine({ wanted: INTENT_WANTED, cardsReplayed: !!CARDS_FILE, ...INTENT, ...intentCount });
console.error(
  `hermes-ab: ${KINDS ? `${worlds.reduce((n, w) => n + selectedCount(w.tasks), 0)} selected of ` : ""}` +
    `${worlds.reduce((n, w) => n + w.tasks.length, 0)} ${KINDS ? "planned " : ""}tasks × ${CONDITIONS.length} conditions ` +
    `(${CONDITIONS.map((c) => c.name).join(",")}), hermes ${HERMES_COMMIT}, model ${MODEL}, grader ${GRADER}, ` +
    `cap $${BUDGET}, suites ${SUITE_LIST.join(",")}, ` +
    `time-scale ${TIME_SCALE}${TIME_SCALE === 0 ? " (connectors at 0 ms)" : ""}, ` +
    `config ${CONFIG_ARG in PRESETS ? CONFIG_ARG : "custom"}` +
    (Object.keys(CONFIG_VARIANTS).length ? `, variants ${JSON.stringify(CONFIG_VARIANTS)}` : "") +
    (CARDS_FILE ? `, cards ${CARDS_FILE} (${diskCards!.cards.size} replayed; new → ${CARDS_OUT})` : "") +
    (ACCESS.allowLogging ? ", ALLOW-LOGGING (lab only)" : "") +
    `, concurrency ${CONCURRENCY}, requests ≤${PACER.remaining === Infinity ? "∞" : PACER.remaining}`,
);
console.error(`hermes-ab: ${INTENT_LINE}`);
console.error(`hermes-ab: ${COVERAGE.note}`);
if (DAYS_ON) {
  for (const w of worlds) {
    const kinds = ["hidden", "control", "neutral"].map((k) => w.tasks.filter((t) => t.kind === k).length);
    console.error(
      `hermes-ab: user w${w.seed}: ${w.daySizes!.length} days (${w.daySizes!.join(",")} requests), ` +
        `hidden/control/neutral ${kinds.join("/")}, ${w.clashes} slot clashes; Hermes transcript reset per day, Eden ` +
        `kept; clock +${GAP_MS / 60_000} min a request, +${NIGHT_MS / 3_600_000} h a night`,
    );
  }
}
if (DRY) process.exit(0);

/**
 * `--resume` (D813, D1044): pi-ab's journal. The key is everything that decides a unit: the flags (less those that
 * only name outputs or caps), the files they name, the tasks, the harness (Hermes' commit) and the prompts' hash, the
 * env that changes results, and the code (`run-journal.ts`).
 */
{
  const drop = [
    ...["--out", "--timeline", "--cards-out", "--resume", "--budget", "--spend-ledger", "--spend-cap"],
    ...["--spend-headroom", "--run-label", "--max-requests", "--rpm", "--resume-biased", "--concurrency", "--dump"],
  ];
  try {
    JOURNAL = RunJournal.open<JournalUnit>(
      partialPath(OUT),
      {
        harness: "hermes-ab",
        harnessVersion: `hermes-agent@${HERMES_COMMIT}`,
        promptsHash: armPromptsHash(null, VARIANTS.includes("neutral")),
        argv: argvFields(args, drop),
        files: argvFiles(args, drop),
        tasks: hashOf(worlds.map((w) => ({ seed: w.seed, daySizes: w.daySizes, tasks: w.tasks }))),
        env: envFields(),
        code: codeVersion(),
      },
      args.includes("--resume"),
    );
  } catch (e) {
    if (!(e instanceof JournalRefused)) throw e;
    console.error(`hermes-ab: ${e.message}`);
    process.exit(2);
  }
}
// Under `--days` a reused day never reached Eden: the days after it run against an Eden that did not see it. The
// Eden-free arm resumes exactly; an Eden arm only when asked to, and its results say so.
const edenArms = CONDITIONS.filter((c) => c.withPartner).map((c) => c.name);
if (JOURNAL!.done.size && DAYS_ON && edenArms.length) {
  if (!args.includes("--resume-biased")) {
    console.error(
      `hermes-ab: --resume under --days would run ${edenArms.join(",")} against an Eden that never saw the reused ` +
        "days; pass --resume-biased to accept that (the results file and reports then say so), or start over",
    );
    process.exit(2);
  }
  resumed.biased = true;
}
{
  const unitsUsd = [...JOURNAL!.done.values()].reduce((n, u) => n + u.spend.agent + u.spend.eden + u.spend.grader, 0);
  resumed.spentBeforeUsd = Math.max(JOURNAL!.spentBefore, unitsUsd);
  spent += resumed.spentBeforeUsd;
  if (JOURNAL!.done.size || JOURNAL!.torn) {
    console.error(
      `hermes-ab: resuming from ${JOURNAL!.path}: ${JOURNAL!.done.size} finished units reused at $0, ` +
        `$${resumed.spentBeforeUsd.toFixed(4)} spent by earlier attempts counted against --budget` +
        (JOURNAL!.torn ? `, ${JOURNAL!.torn} torn lines run again` : "") +
        (resumed.biased ? " (BIASED: --resume-biased)" : ""),
    );
  }
}
// What has been spent, noted in the journal as it moves, so a kill loses at most a second's.
let noted = spent;
const noteTimer = setInterval(() => {
  if (spent === noted) return;
  noted = spent;
  try {
    JOURNAL!.noteSpent(spent);
  } catch {
    // A note that fails is retried at the next tick; the units themselves are written on their own.
  }
}, 1_000);

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: labRouter(streams), idleTimeout: 255 });
port = server.port!;
mkdirSync(TIMELINE, { recursive: true });
writeFileSync(`${TIMELINE}/tasks.jsonl`, "");
const records: TaskRecord[] = [];
const grading: Promise<void>[] = [];
const results: RunResult[] = [];
const t0 = performance.now();
// Streams, `--concurrency` at a time: one Hermes worker each.
const jobs = worlds.flatMap((w, wi) =>
  CONDITIONS.map((c, k) => ({ id: `${w.seed}-${w.suite}-${w.variant}-${k}`, w, wi, c })),
);
let next = 0;
const lanes = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    try {
      results.push(
        ...(await runWorld(
          job.id,
          job.w.world,
          job.w.seed,
          job.w.tasks,
          job.c,
          records,
          grading,
          job.w.daySizes,
          job.wi,
        )),
      );
    } catch (e) {
      // Before its first task (its Eden could not be set up): stopped with nothing run.
      stoppedStreams++;
      console.error(`stream ${job.id} (${job.c.name}) stopped: ${e instanceof Error ? e.message : e}`);
    }
  }
});
await Promise.all(lanes);
await Promise.all(grading);
server.stop(true);
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
      harness: "hermes",
      taskSelection: SELECTION,
      harnessVersion: `hermes-agent@${HERMES_COMMIT}`,
      config: CONFIG,
      ...(Object.keys(CONFIG_VARIANTS).length ? { variantConfig: CONFIG_VARIANTS } : {}),
      ...(CARDS_FILE ? { cards: { replay: CARDS_FILE, out: CARDS_OUT } } : {}),
      ...(INTENT_WANTED ? { intent: { line: INTENT_LINE, files: INTENT_FILES, ...intentCount } } : {}),
      coverage: COVERAGE.coverage,
      timeScale: TIME_SCALE,
      ...connectorHeader(CONNECTORS),
      ...(ACCESS.allowLogging ? { allowLogging: true } : {}),
      requests: PACER.summary(),
      orphanRequests,
      partial: capStopped > 0 || billingStopped > 0 || PACER.refused > 0 || stoppedStreams > 0,
      stoppedStreams,
      maxIterations: MAX_ITERATIONS,
      spend,
      ...(resumed.units ? { resumed: { journal: JOURNAL!.path, ...resumed } } : {}),
      ...(DAYS_ON
        ? {
            days: DAYS,
            daysPooled: poolDays(DAYS),
            recapNotice: RECAP_NOTICE,
            user: {
              days: USER_DAYS,
              daySize: DAY_SIZE,
              mix: MIX,
              gapMin: GAP_MS / 60_000,
              nightH: NIGHT_MS / 3_600_000,
              transcript: "reset per day (Hermes' own handling within the day)",
              worlds: worlds.map((w) => ({ seed: w.seed, daySizes: w.daySizes, clashes: w.clashes })),
            },
          }
        : {}),
      // Eden's spend no task is charged for, per stream: the report's backfill and all-in columns (ab-common.ts).
      background,
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
{
  // Every stream's units, journalled now or by an earlier attempt: then the results file holds them all.
  const units = worlds.reduce(
    (n, w) => n + CONDITIONS.length * (w.daySizes ? w.daySizes.filter((k) => k > 0).length : selectedCount(w.tasks)),
    0,
  );
  const have = JOURNAL!.done.size + JOURNAL!.written;
  clearInterval(noteTimer);
  if (have < units) JOURNAL!.noteSpent(spent);
  JOURNAL!.finish(have >= units);
  if (have < units) {
    console.error(
      `hermes-ab: ${have} of ${units} units finished; ${JOURNAL!.path} kept: rerun with --resume to finish`,
    );
  }
}
console.error(
  `spent $${spent.toFixed(4)} (agent $${spend.agent.toFixed(4)}, eden $${spend.eden.toFixed(4)}, grader ` +
    `$${spend.grader.toFixed(4)}); ${results.length} runs, ${ungraded} ungraded → ${OUT}, timeline ${TIMELINE}, ` +
    `time-scale ${TIME_SCALE}; ${PACER.sent} requests (${PACER.retried} retried, ${JSON.stringify(PACER.statuses)}), ` +
    `${orphanRequests} orphan` +
    (capStopped || PACER.refused ? `; PARTIAL: request cap reached (${capStopped} streams stopped early)` : "") +
    (billingStopped ? `; PARTIAL: billing stopped (${billingStopped} streams stopped on a dead key)` : "") +
    (stoppedStreams ? `; PARTIAL: ${stoppedStreams} streams stopped on a failure (logged above)` : "") +
    (INTENT_WANTED ? `; ${INTENT_LINE}` : ""),
);
console.error(overBudgetLine(budgeted));
if (checkers.length) {
  const sum = (k: keyof PushChecker["stats"]) => checkers.reduce((n, c) => n + c.stats[k], 0);
  console.error(
    `CHECK (${CHECK_MODEL}): ${sum("calls")} calls of ${sum("asked")} asked, ${sum("failures")} failed, ` +
      `${sum("overBudget")} over budget; $${sum("costUsd").toFixed(4)}`,
  );
}
// Traffic-weighted rows (pi-ab-weighted.ts): most traffic is silent, so the hidden-only cost columns understate. The
// full report (pi-ab-report.ts on OUT) prints the same rows beside the outcome tables.
{
  const kindOf = new Map(tasks.map((t) => [t.id, t.kind]));
  const samplesOf = (c: string, kind: Task["kind"]) =>
    results
      .filter((r) => !r.error && r.condition === c && kindOf.get(r.task) === kind)
      .map((r) => ({ usd: r.costUsd, edenUsd: r.edenCostUsd, tools: r.toolCalls, wallS: r.wallMs / 1_000 }));
  const rows = TRAFFIC_WEIGHTS.flatMap((w) =>
    CONDITIONS.map((c) => weightedRow(c.name, samplesOf(c.name, "hidden"), samplesOf(c.name, "control"), w)),
  ).filter((r): r is WeightedRow => r !== null);
  for (const line of weightedLines(rows)) console.error(line);
}
