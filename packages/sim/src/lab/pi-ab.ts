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
 * - eden-judge, both-judge: as eden and both, with Eden's model judge on.
 *
 * A condition may end in `@w<ms>` ("both@w0"): how long the first observe waits for Eden's slow path before the agent's
 * first model request (agent-ab and the client's `withContext` default: 3000). What arrives later is injected before
 * the agent's next request, if it makes one. The report pairs each such condition with its base.
 *
 * Variants of the configuration run in one process, paired task by task (`pi-conditions.ts` has the grammar):
 * `--variant-config '{"ALL2":{"syncPollBehind":true}}' --conditions eden,eden~ALL2` gives each name the settings it
 * adds over `--config`, and `eden+packetDates` is shorthand for one flag on. `--act` is a mode of its own: every
 * condition gets stub action tools (`act.ts`) and a system prompt that lets the agent act, and each task records its
 * action calls (`act-report.ts` reads them). `-act-firewall` conditions (`tools-act-firewall`, `eden-act-firewall`)
 * also turn on the engine's `actionCheck` (D69) and send each action call to `checkAction` before it runs (Pi's
 * `beforeToolCall`): a finding holds the call and is the tool's result (`heldResult`), and the same call made again
 * runs. Beside tools, Eden runs only as that check: it observes the request but injects nothing and gives no tool.
 *
 * `--cards FILE` (alias `--cards-disk`) replays implication cards from a disk cache (`cards-disk.ts`, as the funnel
 * does) and makes only the missing ones live, so the conditions of a run, and later runs, do not each pay for the same
 * enrichment. FILE is only read; new cards go to `--cards-out` (default `<out>.cards.jsonl`), which later runs replay
 * too when they name it. Every stream shares one copy of both. `--card-sort price` routes the live card maker to
 * OpenRouter's cheapest compliant endpoint (D66); a batch cut off at its output cap is sent again with default
 * routing.
 *
 * Every task records a timeline on one monotonic clock (`pi-timeline.ts`): task start; Eden's observe; its slow path,
 * search, probe queries, refresh and judge (the engine's spans, `spans.ts`), each of Eden's source calls, its cache
 * hits and decisions (its traces); each model request's start, first token and end with tokens and cost; each tool
 * call; grading; task end. One JSON line per task goes to `<timeline>/tasks.jsonl`, and the process's CPU and RSS every
 * second to `<timeline>/samples.jsonl`. `pi-ab-report.ts` reads both with the results file. Each task's line also
 * records the packets the agent's requests saw, the item ids they cited, the ids `ask_context` answers cited, and the
 * task's planted item id (hidden-context suites), so a report can tell delivery from uptake.
 *
 *   OPENROUTER_API_KEY=… bun packages/sim/src/lab/pi-ab.ts [--suite heldout] [--seeds 41] [--variants hidden,control]
 *     [--conditions none,tools,eden,both] [--config H|'{"probes":true}'] [--model z-ai/glm-5.3-flash]
 *     [--grader anthropic/claude-haiku-5.5] [--budget 0.6] [--out pi-ab.json] [--timeline dir] [--time-scale 0]
 *     [--tool-exec parallel|sequential] [--tasks 30] [--offworld 5] [--limit n] [--dry]
 *     [--variant-config '{"name":{...}}'] [--act] [--cards FILE [--cards-out FILE]] [--card-sort price]
 *     [--allow-logging] [--rpm 18] [--max-requests N] [--intent FILE] [--bridge FILE] [--bridge-model m]
 *
 * `--templates a,b` runs only those hidden-context templates; `--ask-description guided` gives the agent the MCP
 * server's guided description (`askGuard`, docs/research/edge-ask.md). Free models go through `free.ts` (above).
 *
 * --budget is a hard cap on everything this run spends (agent, Eden's judge, grader): each call reserves its
 * worst case before it is sent and is refused when that could cross the cap. --time-scale 1 gives the sim sources
 * their profiles' assumed latency (agent-ab runs them at 0, instant); the timeline then shows connector time.
 *
 * Free models (`<model>:free`, docs/research/edge-freelab.md): every OpenRouter request of the run (agent, Eden's
 * judge and cards, grader) goes through one `Pacer` (`free.ts`): `--rpm` (default 18 a minute with a free model),
 * `--max-requests` (retries count), and 429/5xx backoff honouring Retry-After. A free model needs `--allow-logging`
 * (its endpoints log prompts; lab only). A task starts only while the cap leaves room for a whole task and its grading
 * (`MAX_STEPS` + 1 requests); once it does not, the run stops starting tasks, grades what it has, and says it is
 * partial (`partial` and `requests` in the results file).
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Agent, type AgentEvent as PiEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Model as PiModel } from "@earendil-works/pi-ai";
import { heldResult } from "@eden/client";
import {
  CardEnricher,
  ContextPartner,
  DEFAULT_CONFIG,
  ItemCache,
  bridgeKey,
  ModelBridgeMaker,
  ModelCardMaker,
  QueryBridge,
  type BridgeMaker,
  type CardMaker,
} from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, priceFor, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { QueryPlanner, type ListPage, type Source } from "@eden/sources";
import { REALISTIC, simSources, type SimSource } from "../sources";
import type { World } from "../world";
import {
  ASK_DESCRIPTION,
  ASK_DESCRIPTION_GUIDED,
  emptyResult,
  grade,
  MAX_STEPS,
  OverBudget,
  render,
  searchToolSpec,
  systemPrompt,
  TOOL_ITEMS,
  userPrompt,
  worldOf,
  type Meter,
  type RunResult,
  type Task,
} from "./ab-common";
import { ACTIONS, actionParams, coerceArgs, executed, type ActionRecord } from "./act";
import { DiskBridgeMaker } from "./bridge-disk";
import { DiskCardMaker, samePath } from "./cards-disk";
import { isCapError, labAccess, labModel, piModelFor, piRegistry, providerPrefs } from "./free";
import { parseConditions, parseVariants, type Condition } from "./pi-conditions";
import { PRESETS } from "./presets";
import { parseSuites } from "./suites";
import { QUESTION_CHARS, UptakeLog } from "./uptake";
import { sanitizeForStore } from "@eden/redact";
import { piName, spanRouter, Timeline } from "./pi-timeline";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const DRY = args.includes("--dry");
/**
 * `--ask-description auto|guided|standard`: which `ask_context` description the agent gets. `auto` (the default) does
 * as the MCP server does: the guided one (`ASK_CONTEXT_GUIDED`) for a condition whose config has `askGuard`, else the
 * standard one. `guided` and `standard` force one for every condition.
 */
const ASK_DESC = opt("ask-description", "auto");
if (!["auto", "guided", "standard"].includes(ASK_DESC))
  throw new Error("--ask-description must be auto|guided|standard");
const ASK_GUIDED = ASK_DESC === "guided";
const guidedFor = (config: Record<string, unknown>) => ASK_GUIDED || (ASK_DESC === "auto" && config.askGuard === true);
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY && !DRY) throw new Error("needs OPENROUTER_API_KEY");
const SEEDS = opt("seeds", "41").split(",").map(Number);
const MODEL = opt("model", "z-ai/glm-5.3-flash");
const GRADER = opt("grader", "anthropic/claude-haiku-5.5");
const BUDGET = Number(opt("budget", "0.6"));
const SUITE = opt("suite", "heldout");
const LOOKUPS = SUITE === "lookups";
const SUITE_LIST = LOOKUPS ? ["lookups"] : parseSuites(SUITE);
const VARIANTS = opt("variants", "hidden,control").split(",") as ("hidden" | "control")[];
const ACT = args.includes("--act");
const CONDITION_NAMES = opt("conditions", ACT ? "tools,eden,eden-act-firewall" : "none,tools,eden,both").split(",");
const OUT = opt("out", "pi-ab.json");
const TIMELINE = opt("timeline", `${OUT.replace(/\.json$/, "")}.timeline`);
const TIME_SCALE = Number(opt("time-scale", "0"));
const TOOL_EXEC = opt("tool-exec", "parallel") as "parallel" | "sequential";
const LIMITS = { maxTasks: Number(opt("tasks", "30")), maxOffworld: Number(opt("offworld", "5")) };
// The first N tasks of each world only: a plumbing check before a real run.
const LIMIT = Number(opt("limit", "0"));
// `--templates a,b`: only the hidden-context tasks of these templates (both variants), for a small targeted smoke.
const TEMPLATES = opt("templates", "") ? new Set(opt("templates", "").split(",")) : null;

const CONFIG_ARG = opt("config", "{}");
const CONFIG = PRESETS[CONFIG_ARG] ?? (JSON.parse(CONFIG_ARG) as Record<string, unknown>);
// `cards` makes implication cards with a model in the background (D59), metered and charged to Eden's spend.
const CARD_MODEL = opt("card-model", "z-ai/glm-5.3-flash");
const CARD_SORT = opt("card-sort", "");
const BRIDGE_MODEL = opt("bridge-model", CARD_MODEL);
if (CARD_SORT && CARD_SORT !== "price") throw new Error("--card-sort must be price");
const CONFIG_VARIANTS = parseVariants(opt("variant-config", "{}"));
// Every condition is parsed before anything is spent: a typo fails here, not after the first stream has run.
const CONDITIONS: Condition[] = parseConditions(CONDITION_NAMES, {
  config: CONFIG,
  variants: CONFIG_VARIANTS,
  act: ACT,
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
});
// A flag whose dependency this harness cannot give it would run a different configuration under the flag's name: a
// run that says R or ALL must be R or ALL (the review of moon/combined). Cards need a model; the sync, list tools.
if (CONDITIONS.some((c) => c.withPartner && c.config.cards === true) && !KEY && !DRY)
  throw new Error("config.cards needs OPENROUTER_API_KEY for its enrichment");
// Every OpenRouter request of the run goes through one pacer: rate, cap, retries, and the logging choice (free.ts).
const ACCESS = labAccess(args, [
  MODEL,
  GRADER,
  ...(CONDITIONS.some((c) => c.withPartner && c.config.cards === true) ? [CARD_MODEL] : []),
]);
const PACER = ACCESS.pacer;
/** A task starts only while the cap leaves room for all of it: its model requests and its grading. */
const TASK_REQUESTS = MAX_STEPS + 1;
let capStopped = 0;
// Cards replayed from disk: the replay file is only read, new cards go to their own file (cards-disk.ts).
const CARDS_FILE = opt("cards", opt("cards-disk", ""));
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
const INTENT_FILES = opt("intent", "").split(",").filter(Boolean);
if (INTENT_FILES.length && !CARDS_FILE) throw new Error("--intent needs --cards");
for (const f of INTENT_FILES) if (!existsSync(f)) throw new Error(`--intent ${f}: no such file`);
const diskCards = CARDS_FILE
  ? new DiskCardMaker(CARDS_FILE, undefined, { out: CARDS_OUT, requests: INTENT_FILES })
  : null;
/**
 * `--bridge FILE` (with `"bridgeQuery": true`; docs/research/edge-bridge.md): bridging queries replayed from
 * `bridge-enrich.ts`'s cache; a request with no line is sent live to `--bridge-model` (default `--card-model`),
 * metered and paced like Eden's other calls. Without `--bridge`, `bridgeQuery` makes every call live.
 */
const BRIDGE_FILE = opt("bridge", "");
if (BRIDGE_FILE && !existsSync(BRIDGE_FILE)) throw new Error(`--bridge ${BRIDGE_FILE}: no such file`);
const diskBridge = BRIDGE_FILE ? new DiskBridgeMaker(BRIDGE_FILE) : null;

// ---- Spend: one hard cap over every call, reserved before the call at its worst case and settled at its real cost.
let spent = 0;
let held = 0;
const spend = { agent: 0, eden: 0, grader: 0 };
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
const piModel: PiModel<"openai-completions"> = piModelFor(MODEL, AGENT_MAX_TOKENS);
const models = piRegistry([piModel]);

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
    id: source.id,
    kind: source.kind,
    description: source.description,
    listsByTime: source.listsByTime,
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
const askParams = Type.Object({ question: Type.String() });

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

/** One world under one condition: a fresh Eden (if any) sees the world's tasks in order, as in agent-ab. */
async function runWorld(
  world: World,
  seed: number,
  tasks: Task[],
  cond: Condition,
  records: TaskRecord[],
  grading: Promise<void>[],
): Promise<RunResult[]> {
  const sources = simSources(world, REALISTIC, TIME_SCALE, seed);
  const { name: condition, waitMs, useEden, withPartner, useTools, judge, act, firewall, config } = cond;
  const scope = { tenantId: "ab", userId: `w${seed}` };
  let clock = world.now;
  // The task now running in this stream: Eden's source and model calls carry no session, so they go to its timeline.
  let current: Timeline | null = null;
  const bySession = new Map<string, { r: RunResult; tl: Timeline }>();
  const edenSources = sources.map((s) =>
    watched(s, (id, op, start, end, status, items) =>
      current?.span("eden.source", "eden", "bg", start, end, { source: id, op, status, items }),
    ),
  );
  // `cards`: the enrichment model, metered against the run's cap and booked to Eden's spend like its judge.
  const cardModel = (sort: "" | "price") =>
    meteredModel(
      labModel(ACCESS, { apiKey: KEY!, model: CARD_MODEL, ...(sort ? { sort } : {}) }, "eden.cards"),
      (start, end, data) => current?.span("eden.cards", "eden", "bg", start, end, data),
    );
  // `--card-sort price` (D66): a batch cut off at the cap is sent again with default routing.
  const liveCards = (): CardMaker =>
    CARD_SORT ? new ModelCardMaker(cardModel("price"), { retry: cardModel("") }) : new ModelCardMaker(cardModel(""));
  // With `--cards`, cards on disk are replayed and only the rest made live (their spend booked to Eden as usual).
  const cardMaker = (): CardMaker =>
    diskCards ? new DiskCardMaker(CARDS_FILE, liveCards(), { out: CARDS_OUT, shared: diskCards }) : liveCards();
  const cards =
    withPartner && config.cards === true
      ? new CardEnricher({ maker: cardMaker(), budget: new Budget(), now: () => clock })
      : undefined;
  // `bridgeQuery`: replayed queries first, the rest made live (booked to Eden like its judge).
  const liveBridge = () =>
    new ModelBridgeMaker(
      meteredModel(labModel(ACCESS, { apiKey: KEY!, model: BRIDGE_MODEL }, "eden.bridge"), (start, end, data) =>
        current?.span("eden.bridge", "eden", "bg", start, end, data),
      ),
    );
  const bridgeMaker = (): BridgeMaker => {
    if (!diskBridge) return liveBridge();
    const live = liveBridge();
    return {
      async make(requests: string[], signal: AbortSignal) {
        const replayed = await diskBridge.make(requests);
        const missing = requests.filter((_, i) => !diskBridge.queries.has(bridgeKey(requests[i]!)));
        if (missing.length === 0) return replayed;
        const got = await live.make(missing, signal);
        let k = 0;
        const queries = requests.map((r, i) =>
          diskBridge.queries.has(bridgeKey(r)) ? replayed.queries[i]! : (got.queries[k++] ?? null),
        );
        return { ...got, queries };
      },
    };
  };
  const bridge =
    withPartner && config.bridgeQuery === true
      ? new QueryBridge({ maker: bridgeMaker(), budget: new Budget(), now: () => clock })
      : undefined;
  const partner = withPartner
    ? new ContextPartner({
        sources: async () => edenSources,
        sourceMap: new SourceMap(":memory:", { seed }),
        cache: new ItemCache(),
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
        ...(bridge ? { bridge } : {}),
        // Charged to the task whose session the trace is from: a slow-path verdict can land after it ended.
        onTrace: (t) => {
          const owner = bySession.get(t.sessionId);
          if (!owner) return;
          owner.r.edenModelCalls += t.modelCalls;
          owner.r.edenCostUsd += t.costUsd;
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
  if (sync) {
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
  if (cards) await cards.idle();
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
  for (const task of tasks) {
    if (exhausted()) break;
    if (PACER.remaining < TASK_REQUESTS) {
      capStopped++;
      break;
    }
    clock += 3_600_000; // an hour between tasks: Eden's clock, for its caches and planner
    if (sync) await sync.tick();
    const sessionId = task.id;
    const ev = (e: Record<string, unknown>) => ({ ...scope, sessionId, at: clock, ...e }) as AgentEvent;
    const r: RunResult = emptyResult(task.id, condition);
    await closePrevious();
    const tl = new Timeline();
    current = tl;
    bySession.set(sessionId, { r, tl });
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
        tl.point("eden.inject", { items: i.citations.length, chars: i.text.length, mode: i.mode });
      }
    };
    try {
      if (partner) {
        const o = tl.begin("eden.observe", "eden", "path", { event: "session_start" });
        await partner.observe(ev({ kind: "session_start", agent: "pi-ab" }));
        tl.end(o);
        const arriving = task.event === "external" ? { source: "gmail" } : {};
        const o2 = tl.begin("eden.observe", "eden", "path", { event: task.event });
        const first = await partner.observe(ev({ kind: task.event, text: task.text, ...arriving }), { waitMs });
        tl.end(o2, { injected: first.injection?.citations.length ?? 0, pending: first.pending });
        if (first.injection && useEden) {
          r.injectedItems += first.injection.citations.length;
          r.injectedChars += first.injection.text.length;
          uptake.packet(first.injection);
          tl.point("eden.inject", { items: first.injection.citations.length, chars: first.injection.text.length });
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
      if (useEden && !useTools && partner) {
        tools.push({
          name: "ask_context",
          description: guidedFor(config) ? ASK_DESCRIPTION_GUIDED : ASK_DESCRIPTION,
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
      } | null = null;
      let est = 0;
      const agent = new Agent({
        initialState: {
          systemPrompt: systemPrompt(world, { lookups: LOOKUPS, data: useTools || useEden, act }),
          model: piModel,
          thinkingLevel: "off",
          tools,
        },
        toolExecution: TOOL_EXEC,
        // Before every model request: Eden's packets queued since the last one join those already placed, all before
        // the user turn (agent-ab's `withContext` placement), never stored in the agent's own transcript.
        transformContext: async (messages) => {
          takeEden();
          if (!packets.length) return messages;
          const at = messages.map((m) => m.role).lastIndexOf("user");
          const sys = packets.map((text) => ({ role: "system" as const, content: text, timestamp: Date.now() }));
          return [...messages.slice(0, at), ...sys, ...messages.slice(at)];
        },
        streamFn: (model, context, options) => {
          const chars = JSON.stringify(context.messages).length;
          est = worstCase(MODEL, chars, AGENT_MAX_TOKENS);
          reserve(est);
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
          };
          activeRequests++;
          const mine = request;
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
      // A request that never reached its end (refused by the cap, or thrown) gives back its reservation.
      if (request) {
        const q = request as { id: number };
        tl.end(q.id, { error: true });
        settle(est, 0, "agent");
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
    if (partner) Object.assign(record, uptake.fields());
    out.push(r);
    records.push(record);
    // Grading runs beside the next task, on this task's timeline (after its end): the agent never waits for it.
    if (!r.error) {
      grading.push(
        (async () => {
          const g = tl.begin("grading", "grading", "bg");
          const est = worstCase(GRADER, 4_000 + r.answer.length + task.text.length, 2_000);
          let reserved = false;
          let cost = 0;
          let failure = "";
          try {
            if (task.must.length > 0 && r.answer.trim()) {
              reserve(est);
              reserved = true;
            }
            const meter: Meter = { before: () => {}, after: (c) => (cost = c) };
            const via = { fetch: ACCESS.fetch, allowLogging: ACCESS.allowLogging };
            r.facts = (await grade(KEY!, meter, GRADER, task, r.answer, via)).facts;
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
    }
    previous = { sessionId, r };
  }
  await closePrevious();
  current = null;
  return out;
}

const worlds = SEEDS.flatMap((seed) =>
  SUITE_LIST.flatMap((suite) =>
    (LOOKUPS ? ["hidden" as const] : VARIANTS).map((variant) => {
      const w = worldOf(seed, suite, variant, LIMITS);
      const picked = TEMPLATES ? { ...w, tasks: w.tasks.filter((t) => TEMPLATES.has(t.type)) } : w;
      return LIMIT > 0 ? { ...picked, tasks: picked.tasks.slice(0, LIMIT) } : picked;
    }),
  ),
);
console.error(
  `pi-ab: ${worlds.reduce((n, w) => n + w.tasks.length, 0)} tasks × ${CONDITIONS.length} conditions ` +
    `(${CONDITIONS.map((c) => c.name).join(",")}), model ${MODEL}, grader ${GRADER}, cap $${BUDGET}, suites ` +
    `${SUITE_LIST.join(",")}, config ${JSON.stringify(CONFIG)}` +
    (Object.keys(CONFIG_VARIANTS).length ? `, variants ${JSON.stringify(CONFIG_VARIANTS)}` : "") +
    (CARDS_FILE ? `, cards ${CARDS_FILE} (${diskCards!.cards.size} replayed; new → ${CARDS_OUT})` : "") +
    (ACCESS.allowLogging ? ", ALLOW-LOGGING (lab only)" : "") +
    `, requests ≤${PACER.remaining === Infinity ? "∞" : PACER.remaining}`,
);
if (DRY) process.exit(0);

mkdirSync(TIMELINE, { recursive: true });
writeFileSync(`${TIMELINE}/tasks.jsonl`, "");
writeFileSync(`${TIMELINE}/samples.jsonl`, "");
const stopSampling = startSampling(`${TIMELINE}/samples.jsonl`);
const records: TaskRecord[] = [];
const grading: Promise<void>[] = [];
const results: RunResult[] = [];
const t0 = performance.now();
const streams = worlds.flatMap((w) => CONDITIONS.map((c) => runWorld(w.world, w.seed, w.tasks, c, records, grading)));
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
      harnessVersion: "@earendil-works/pi-agent-core@1.3.0",
      config: CONFIG,
      ...(Object.keys(CONFIG_VARIANTS).length ? { variantConfig: CONFIG_VARIANTS } : {}),
      ...(ACT ? { act: true } : {}),
      ...(CARDS_FILE ? { cards: { replay: CARDS_FILE, out: CARDS_OUT } } : {}),
      timeScale: TIME_SCALE,
      ...(ACCESS.allowLogging ? { allowLogging: true } : {}),
      // Every HTTP request the run sent (retries included), and whether the cap cut it short.
      requests: PACER.summary(),
      partial: capStopped > 0 || PACER.refused > 0,
      toolExecution: TOOL_EXEC,
      askDescription: ASK_DESC,
      spend,
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
    `$${spend.grader.toFixed(4)}); ${results.length} runs, ${ungraded} ungraded → ${OUT}, timeline ${TIMELINE}; ` +
    `${PACER.sent} requests (${PACER.retried} retried, ${JSON.stringify(PACER.statuses)})` +
    (capStopped || PACER.refused ? `; PARTIAL: request cap reached (${capStopped} streams stopped early)` : ""),
);
