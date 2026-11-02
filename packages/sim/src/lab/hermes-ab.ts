#!/usr/bin/env bun
/**
 * The live A/B on Hermes Agent (NousResearch/hermes-agent): Hermes alone against the same Hermes with Eden integrated
 * as a tenant would integrate it. Same worlds, tasks, prompts, source tools, grader, results file and timeline as
 * `pi-ab.ts`, so `pi-ab-report.ts` and `agent-ab-report.ts` read its output (`harness: "hermes"`).
 *
 * - hermes:      Hermes with one MCP server, `sources`: a read-only `search_<source>` tool per sim source (pi-ab's
 *                `tools`). Hermes' own toolsets (terminal, files, web, browser, code, memory, skills, delegation, cron)
 *                are all off: `enabled_toolsets` is the MCP toolsets only, so the agent is read-only.
 * - hermes+eden: the same, plus Eden as two integration points, both Hermes' own extension surfaces:
 *                Eden's MCP server (`createMcpServer`: `ask_context` with the standard description; the guided one only
 *                when the config has `askGuard`, as ALL5 does and ALL3 does not), and the Eden plugin
 *                (packages/sim/lab/hermes/eden): `pre_llm_call` observes the turn and injects Eden's packet,
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
 *     [--suite dev6a] [--seeds 41] [--variants hidden,control] [--conditions hermes,hermes+eden]
 *     [--config ALL3] [--variant-config '{"A5":{…}}'] [--model z-ai/glm-5.3-flash] [--grader …] [--budget 0.6]
 *     [--card-model m] [--cards FILE [--cards-out FILE]] [--intent FILE] [--bridge FILE] [--bridge-model m]
 *     [--allow-logging] [--rpm 18] [--max-requests N] [--limit n] [--templates a,b] [--concurrency 4]
 *     [--max-iterations 6] [--out hermes-ab.json] [--timeline dir] [--time-scale 0] [--dump FILE] [--dry]
 *
 * `--hermes-src` is a hermes-agent checkout with its dependencies in `<src>/.venv` (`uv sync --frozen
 * --no-install-project`); the run records its commit.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
import { sanitizeForStore } from "@eden/redact";
import { QueryPlanner, type ListPage, type Source } from "@eden/sources";
import { REALISTIC, simSources, type SimSource } from "../sources";
import type { World } from "../world";
import {
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
import { DiskBridgeMaker } from "./bridge-disk";
import { DiskCardMaker, samePath } from "./cards-disk";
import { isCapError, labAccess, labModel, providerPrefs } from "./free";
import { parseHermesConditions, type HermesCondition } from "./hermes-conditions";
import { edenMcpServer, labRouter, type StreamHost, type TaskBinding } from "./hermes-host";
import { modelProxy, type RequestRecord } from "./hermes-proxy";
import { Worker } from "./hermes-worker";
import { parseVariants } from "./pi-conditions";
import { piName, spanRouter, Timeline } from "./pi-timeline";
import { PRESETS } from "./presets";
import { parseSuites } from "./suites";
import { QUESTION_CHARS, UptakeLog } from "./uptake";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const DRY = args.includes("--dry");
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY && !DRY) throw new Error("needs OPENROUTER_API_KEY");
const HERMES_SRC = resolve(opt("hermes-src", process.env.HERMES_SRC ?? ""));
if (!existsSync(join(HERMES_SRC, "run_agent.py"))) throw new Error(`--hermes-src ${HERMES_SRC}: not a hermes checkout`);
const HERMES_PY = opt("hermes-python", join(HERMES_SRC, ".venv/bin/python"));
if (!existsSync(HERMES_PY)) throw new Error(`--hermes-python ${HERMES_PY}: no such file (uv sync in the checkout)`);
const HERMES_COMMIT = spawnSync("git", ["-C", HERMES_SRC, "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
const LAB_DIR = resolve(dirname(new URL(import.meta.url).pathname), "../../lab/hermes");
const SEEDS = opt("seeds", "41").split(",").map(Number);
const MODEL = opt("model", "z-ai/glm-5.3-flash");
const GRADER = opt("grader", "anthropic/claude-haiku-5.5");
const BUDGET = Number(opt("budget", "0.6"));
const SUITE_LIST = parseSuites(opt("suite", "heldout"));
const VARIANTS = opt("variants", "hidden,control").split(",") as ("hidden" | "control")[];
const CONDITION_NAMES = opt("conditions", "hermes,hermes+eden").split(",");
const OUT = opt("out", "hermes-ab.json");
const TIMELINE = opt("timeline", `${OUT.replace(/\.json$/, "")}.timeline`);
const HOMES = `${OUT.replace(/\.json$/, "")}.homes`;
const TIME_SCALE = Number(opt("time-scale", "0"));
const LIMITS = { maxTasks: Number(opt("tasks", "30")), maxOffworld: Number(opt("offworld", "5")) };
const LIMIT = Number(opt("limit", "0"));
const TEMPLATES = opt("templates", "") ? new Set(opt("templates", "").split(",")) : null;
const CONCURRENCY = Math.max(1, Number(opt("concurrency", "4")));
// pi-ab's cap is MAX_STEPS model calls a task; Hermes counts tool-calling iterations, the same unit.
const MAX_ITERATIONS = Number(opt("max-iterations", String(MAX_STEPS)));
const AGENT_MAX_TOKENS = 2_000;
// `--dump FILE`: every chat completion Hermes sends, as forwarded (sim data only; for checking the prompt and tools).
const DUMP = opt("dump", "");
const CONFIG_ARG = opt("config", "ALL3");
const CONFIG = PRESETS[CONFIG_ARG] ?? (JSON.parse(CONFIG_ARG) as Record<string, unknown>);
const CARD_MODEL = opt("card-model", "z-ai/glm-5.3-flash");
const BRIDGE_MODEL = opt("bridge-model", CARD_MODEL);
const CONFIG_VARIANTS = parseVariants(opt("variant-config", "{}"));
const CONDITIONS: HermesCondition[] = parseHermesConditions(CONDITION_NAMES, {
  config: CONFIG,
  variants: CONFIG_VARIANTS,
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
});
const usesCards = CONDITIONS.some((c) => c.withPartner && c.config.cards === true);
const usesBridge = CONDITIONS.some((c) => c.withPartner && c.config.bridgeQuery === true);
const ACCESS = labAccess(args, [
  MODEL,
  GRADER,
  ...(usesCards ? [CARD_MODEL] : []),
  ...(usesBridge ? [BRIDGE_MODEL] : []),
]);
const PACER = ACCESS.pacer;
/** A task starts only while the cap leaves room for all of it: its model requests (one spare) and its grading. */
const TASK_REQUESTS = MAX_ITERATIONS + 2;
let capStopped = 0;
const CARDS_FILE = opt("cards", "");
const CARDS_OUT = opt("cards-out", `${OUT.replace(/\.json$/, "")}.cards.jsonl`);
if (CARDS_FILE && samePath(CARDS_OUT, CARDS_FILE)) throw new Error(`--cards-out ${CARDS_OUT} is the --cards file`);
if (CARDS_FILE && !existsSync(CARDS_FILE)) throw new Error(`--cards ${CARDS_FILE}: no such file`);
const INTENT_FILES = opt("intent", "").split(",").filter(Boolean);
if (INTENT_FILES.length && !CARDS_FILE) throw new Error("--intent needs --cards");
for (const f of INTENT_FILES) if (!existsSync(f)) throw new Error(`--intent ${f}: no such file`);
const diskCards = CARDS_FILE
  ? new DiskCardMaker(CARDS_FILE, undefined, { out: CARDS_OUT, requests: INTENT_FILES })
  : null;
const BRIDGE_FILE = opt("bridge", "");
if (BRIDGE_FILE && !existsSync(BRIDGE_FILE)) throw new Error(`--bridge ${BRIDGE_FILE}: no such file`);
const diskBridge = BRIDGE_FILE ? new DiskBridgeMaker(BRIDGE_FILE) : null;

// ---- Spend: one hard cap over every call, reserved before the call at its worst case and settled at its real cost.
let spent = 0;
let held = 0;
const spend = { agent: 0, eden: 0, grader: 0 };
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
    id: source.id,
    kind: source.kind,
    description: source.description,
    listsByTime: source.listsByTime,
    search: (query, signal) => timed("search", () => source.search(query, signal)),
    fetch: (ref, scope, signal) => timed("fetch", () => source.fetch(ref, scope, signal)),
    list: (scope, cursor, limit, signal) => timed("list", () => source.list(scope, cursor, limit, signal)),
  };
}

/** Eden's model calls (cards, bridge) as the engine sees them: reserved against the cap, timed onto `onCall`. */
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
  world: World,
  seed: number,
  tasks: Task[],
  cond: HermesCondition,
  records: TaskRecord[],
  grading: Promise<void>[],
): Promise<RunResult[]> {
  const sources = simSources(world, REALISTIC, TIME_SCALE, seed);
  const { name: condition, waitMs, withPartner, config, eden } = cond;
  const scope = { tenantId: "ab", userId: `w${seed}` };
  let clock = world.now;
  let current: Timeline | null = null;
  const bySession = new Map<string, { r: RunResult; tl: Timeline }>();
  const edenSources = sources.map((s) =>
    watched(s, (op, start, end, status) =>
      current?.span("eden.source", "eden", "bg", start, end, { source: s.id, op, status }),
    ),
  );
  const cardModel = () =>
    meteredModel(labModel(ACCESS, { apiKey: KEY!, model: CARD_MODEL }), (start, end, data) =>
      current?.span("eden.cards", "eden", "bg", start, end, data),
    );
  const cardMaker = (): CardMaker =>
    diskCards
      ? new DiskCardMaker(CARDS_FILE, new ModelCardMaker(cardModel()), { out: CARDS_OUT, shared: diskCards })
      : new ModelCardMaker(cardModel());
  const cards =
    withPartner && config.cards === true
      ? new CardEnricher({ maker: cardMaker(), budget: new Budget(), now: () => clock })
      : undefined;
  const liveBridge = () =>
    new ModelBridgeMaker(
      meteredModel(labModel(ACCESS, { apiKey: KEY!, model: BRIDGE_MODEL }), (start, end, data) =>
        current?.span("eden.bridge", "eden", "bg", start, end, data),
      ),
    );
  const bridgeMaker = (): BridgeMaker => {
    if (!diskBridge) return liveBridge();
    const live = liveBridge();
    return {
      async make(requests: string[], signal: AbortSignal) {
        const replayed = await diskBridge.make(requests);
        const missing = requests.filter((r) => !diskBridge.queries.has(bridgeKey(r)));
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
        model: null,
        planner: new QueryPlanner({ seed }),
        now: () => clock,
        config,
        ...(cards ? { cards } : {}),
        ...(bridge ? { bridge } : {}),
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
  const toolsets = ["mcp-sources", ...(eden ? ["mcp-eden"] : [])];

  const out: RunResult[] = [];
  let previous: { sessionId: string; r: RunResult } | null = null;
  const closePrevious = async () => {
    if (!partner || !previous) return;
    const who = { ...scope, sessionId: previous.sessionId };
    previous.r.lateItems = partner.takePending(who).reduce((n, i) => n + i.citations.length, 0);
    await partner.observe({ ...who, at: clock, kind: "session_end" });
    previous = null;
  };
  let worker: Worker | null = null;
  let respawns = 0;
  try {
    worker = await readyWorker(id, home, eden);
    const queue = [...tasks];
    while (queue.length > 0) {
      const t = queue.shift()!;
      if (exhausted()) break;
      if (PACER.remaining < TASK_REQUESTS) {
        capStopped++;
        break;
      }
      // A worker that died (a crash, or a timeout that killed it) is started again before the next task is bound.
      if (!worker.alive) {
        if (respawns++ >= RESPAWNS) throw new Error(`the Hermes worker died ${respawns} times`);
        console.error(`stream ${id} (${condition}): the Hermes worker died; starting it again`);
        worker.close();
        worker = await readyWorker(id, home, eden);
      }
      clock += 3_600_000;
      if (sync) await sync.tick();
      await closePrevious();
      const sessionId = t.id;
      const r = emptyResult(t.id, condition);
      const tl = new Timeline();
      current = tl;
      bySession.set(sessionId, { r, tl });
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
      const deliver = (items: { text: string; citations: unknown[]; mode?: string }[]) => {
        for (const i of items) {
          r.injectedItems += i.citations.length;
          r.injectedChars += i.text.length;
          uptake.packet(i as Parameters<UptakeLog["packet"]>[0]);
          tl.point("eden.inject", { items: i.citations.length, chars: i.text.length });
        }
        return items.map((i) => i.text).join("\n\n");
      };
      let observed = false;
      const binding: TaskBinding = {
        token: crypto.randomUUID(),
        async observe() {
          if (!partner) return "";
          if (observed) return deliver(partner.takePending({ ...scope, sessionId }));
          observed = true;
          const o = tl.begin("eden.observe", "eden", "path", { event: "session_start" });
          await partner.observe(ev({ kind: "session_start", agent: "hermes" }));
          tl.end(o);
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
          await partner.observe(ev({ kind: "tool_result", tool, output }));
          tl.end(o);
        },
        pending() {
          return partner ? deliver(partner.takePending({ ...scope, sessionId })) : "";
        },
      };
      task = { binding, tl, record, r, sessionId, uptake };
      tl.point("task.start", { condition, kind: t.kind });
      const sent = await worker.run(
        {
          op: "run",
          task: t.id,
          token: binding.token,
          system: systemPrompt(world, { lookups: false, data: true }),
          prompt: userPrompt(t),
          nowMs: clock,
          model: MODEL,
          maxIterations: MAX_ITERATIONS,
          maxTokens: AGENT_MAX_TOKENS,
          toolsets,
        },
        TASK_TIMEOUT_MS,
      );
      task = null;
      // Never sent (the worker died between its last task and this one): not a task, not an error. Its timeline is
      // dropped and the loop tries again on a fresh worker.
      if (!sent.ran) {
        if (respawns++ >= RESPAWNS) throw new Error(`the Hermes worker died ${respawns} times`);
        console.error(`stream ${id} (${condition}): ${t.id} was not sent (worker dead); starting it again`);
        worker.close();
        worker = await readyWorker(id, home, eden);
        bySession.delete(sessionId);
        clock -= 3_600_000; // its hour is given back: the retry takes it
        queue.unshift(t);
        continue;
      }
      const reply = sent.msg;
      const error = typeof reply.error === "string" && reply.error ? reply.error : undefined;
      if (error) r.error = PACER.exhausted ? `request cap reached: ${error.slice(0, 120)}` : error;
      r.answer = typeof reply.answer === "string" ? reply.answer : "";
      if (!r.error && !r.answer.trim()) r.error = "empty answer";
      const toolCalls = Array.isArray(reply.toolCalls) ? reply.toolCalls : [];
      r.toolCalls = toolCalls.length;
      r.wallMs = performance.now() - tl.origin;
      r.leaked = t.secrets.some((s) => r.answer.includes(s));
      tl.point("task.end", { error: !!r.error });
      record.wallMs = Math.round(r.wallMs);
      record.firstTokenMs = record.requests[0]?.firstTokenMs ?? null;
      if (typeof reply.systemChars === "number") record.systemChars = reply.systemChars;
      if (Array.isArray(reply.toolNames)) record.toolNames = reply.toolNames as string[];
      if (typeof reply.apiCalls === "number") record.apiCalls = reply.apiCalls;
      if (r.error) record.error = r.error.slice(0, 200);
      if (partner) Object.assign(record, uptake.fields());
      out.push(r);
      records.push(record);
      if (!r.error) grading.push(gradeTask(t, r, tl));
      previous = { sessionId, r };
    }
    await closePrevious();
  } catch (e) {
    // A stopped stream keeps what it ran: its results stand, the run is marked partial and says why.
    stoppedStreams++;
    console.error(
      `stream ${id} (${condition}) stopped after ${out.length} tasks: ${e instanceof Error ? e.message : e}`,
    );
  } finally {
    current = null;
    task = null;
    worker?.close();
    streams.delete(id);
  }
  return out;
}

/** Grading runs beside the next task, on this task's timeline: the agent never waits for it (as pi-ab). */
async function gradeTask(t: Task, r: RunResult, tl: Timeline): Promise<void> {
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
    r.facts = (
      await grade(KEY!, meter, GRADER, t, r.answer, { fetch: ACCESS.fetch, allowLogging: ACCESS.allowLogging })
    ).facts;
  } catch (e) {
    failure = isCapError(e) ? "request cap reached" : e instanceof Error ? e.message.slice(0, 60) : "error";
  } finally {
    if (reserved) settle(est, cost, "grader");
    tl.end(g, { cost, ...(failure ? { error: failure } : {}) });
  }
}

let orphanRequests = 0;
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
});

const worlds = SEEDS.flatMap((seed) =>
  SUITE_LIST.flatMap((suite) =>
    VARIANTS.map((variant) => {
      const w = worldOf(seed, suite, variant, LIMITS);
      const picked = TEMPLATES ? { ...w, tasks: w.tasks.filter((t) => TEMPLATES.has(t.type)) } : w;
      return { ...(LIMIT > 0 ? { ...picked, tasks: picked.tasks.slice(0, LIMIT) } : picked), suite, variant };
    }),
  ),
);
console.error(
  `hermes-ab: ${worlds.reduce((n, w) => n + w.tasks.length, 0)} tasks × ${CONDITIONS.length} conditions ` +
    `(${CONDITIONS.map((c) => c.name).join(",")}), hermes ${HERMES_COMMIT}, model ${MODEL}, grader ${GRADER}, ` +
    `cap $${BUDGET}, suites ${SUITE_LIST.join(",")}, config ${CONFIG_ARG in PRESETS ? CONFIG_ARG : "custom"}` +
    (Object.keys(CONFIG_VARIANTS).length ? `, variants ${JSON.stringify(CONFIG_VARIANTS)}` : "") +
    (CARDS_FILE ? `, cards ${CARDS_FILE} (${diskCards!.cards.size} replayed; new → ${CARDS_OUT})` : "") +
    (ACCESS.allowLogging ? ", ALLOW-LOGGING (lab only)" : "") +
    `, concurrency ${CONCURRENCY}, requests ≤${PACER.remaining === Infinity ? "∞" : PACER.remaining}`,
);
if (DRY) process.exit(0);

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: labRouter(streams), idleTimeout: 255 });
port = server.port!;
mkdirSync(TIMELINE, { recursive: true });
writeFileSync(`${TIMELINE}/tasks.jsonl`, "");
const records: TaskRecord[] = [];
const grading: Promise<void>[] = [];
const results: RunResult[] = [];
const t0 = performance.now();
// Streams, `--concurrency` at a time: one Hermes worker each.
const jobs = worlds.flatMap((w) => CONDITIONS.map((c, k) => ({ id: `${w.seed}-${w.suite}-${w.variant}-${k}`, w, c })));
let next = 0;
const lanes = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++]!;
    try {
      results.push(...(await runWorld(job.id, job.w.world, job.w.seed, job.w.tasks, job.c, records, grading)));
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
      harnessVersion: `hermes-agent@${HERMES_COMMIT}`,
      config: CONFIG,
      ...(Object.keys(CONFIG_VARIANTS).length ? { variantConfig: CONFIG_VARIANTS } : {}),
      ...(CARDS_FILE ? { cards: { replay: CARDS_FILE, out: CARDS_OUT } } : {}),
      timeScale: TIME_SCALE,
      ...(ACCESS.allowLogging ? { allowLogging: true } : {}),
      requests: PACER.summary(),
      orphanRequests,
      partial: capStopped > 0 || PACER.refused > 0 || stoppedStreams > 0,
      stoppedStreams,
      maxIterations: MAX_ITERATIONS,
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
    `${PACER.sent} requests (${PACER.retried} retried, ${JSON.stringify(PACER.statuses)}), ${orphanRequests} orphan` +
    (capStopped || PACER.refused ? `; PARTIAL: request cap reached (${capStopped} streams stopped early)` : "") +
    (stoppedStreams ? `; PARTIAL: ${stoppedStreams} streams stopped on a failure (logged above)` : ""),
);
