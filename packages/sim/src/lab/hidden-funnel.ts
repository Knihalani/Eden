#!/usr/bin/env bun
/**
 * The free tier of the hidden-context benchmark (docs/research/probes.md): each task's request is played through
 * Eden alone, with no agent and no model, and the planted item is followed through the engine's funnel. Deterministic
 * and offline, so any change to retrieval or delivery can be checked in seconds before a live run.
 *
 * For each template, and in total:
 * - hidden tasks: was the planted item returned by a source, cached, delivered (higher is better);
 * - control tasks (the decoy planted instead): was the decoy delivered (noise: lower is better);
 * - source calls per task, and the engine's wall time per task.
 *
 *   bun packages/sim/src/lab/hidden-funnel.ts [--suite hidden|heldout|heldout-all|all|a,b] [--seeds 41,42,43,44]
 *     [--time 0]
 *     [--config '{"probes":true}'] [--json out.json] [--label probes] [--no-record] [--judge live [--model m]]
 *     [--sync] [--cards DIR/cards.jsonl] [--card-limits '{"batch":20}'] [--planted-age-days N] [--push]
 *     [--lead-in clause|half] [--time 0] [--typing-ms 1500] [--packets out.jsonl]
 *
 * `--judge live` gives Eden its judge (OpenRouter, `OPENROUTER_API_KEY`): the funnel then measures what the judge lets
 * through, hidden and decoy, and its calls, tokens and spend (about $0.03 for the 456 held-out tasks), a cheap screen
 * before an agent run. Seeds run concurrently.
 *
 * `--timeline out.jsonl` records every engine span, each task and the process's CPU% and RSS per second
 * (`timeline.ts`); `timeline-report.ts out.jsonl` says where the time went. Spans change no decision.
 * `--spans noop` turns spans on into a sink that drops them (the tracer's own cost, for overhead runs); `--serial`
 * plays the seeds one after another (same results; a task's wall time is then its own, not shared with other seeds).
 * With either, or `--timeline`, the process CPU of the suites' runs is printed to stderr.
 * `--config '{"sync":true,...}'` runs Eden's real background sync (`SyncManager`, D57) over the sim connectors: the
 * user's sources are backfilled through their list calls before the first task (the clock running), and the sync
 * ticks every five simulated minutes between tasks. Its listing calls are counted apart from request-time calls
 * (`sync:` line, and `sync` in the JSON): backfill, background polls and sweeps, and on-demand polls (which are
 * request-time calls too). `--sync` is the oracle instead: every item put in the cache at no call.
 * `--cards FILE` gives Eden implication cards (`cards.ts`, docs/research/moon-cards.md) replayed from a disk cache made
 * by `cards-enrich.ts` (no model call here; an item with no cached card is uncovered). They are made as items enter the
 * cache, and used from the next request on; with `--sync`, for every item before the first request. Turn them on with
 * `"cards": true` in `--config`.
 * `--card-limits` sets the enricher's `CardLimits` (one economy setting at a time; `"cardsEconomy": true` in
 * `--config` applies the whole preset, docs/research/econ-background.md); the run prints the enrichment's counters
 * (`cards use`: items sent to the model, calls, reused by sentence) summed over its users.
 * `--push` (with `"syncPush": true` in `--config`): once backfilled, every source declares a push watch
 * (`sourcePushes`). The worlds do not change while the tasks run, so no notice follows: the run measures the polls a
 * quiet pushed source no longer needs.
 * `--planted-age-days N` dates every planted item (hidden and decoy) N days before the present instead of one: a
 * stress test for rules that read an item by its age (docs/research/econ-background.md): every suite plants a
 * day-old item.
 * `--lead-in` gives each request a "user is typing" draft before it (`drafts.ts`: its first clause, or its first
 * half; a simulation assumption, since no suite carries one), sent as a draft user message (`anticipate` reads it, any
 * other configuration ignores it). With `--time 0` the request follows once the engine has settled (typing takes
 * seconds, a prefetch milliseconds of CPU); with `--time T` the connectors answer at their realistic latencies times T
 * and the request follows `--typing-ms` × T later. Each task then records when the planted item reached the agent
 * (`deliveryMs`, from the request), whether it came with the request's own reply (`immediate`), whether the session's
 * anticipation had prefetched it (`prefetched`), and the calls the lead-in made (`leadCalls`).
 *
 * `--suite` names any suite of `suites.ts`, or several: each gets its own table, then a TOTAL over all of them.
 * Each suite's run is recorded in the benchmark ledger (bench/, `ledger.ts`) unless `--no-record`.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { CardEnricher, cardKey, ContextPartner, cpuNow, ItemCache, type CandidateDump, type Trace } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, OpenRouterModel, type Model } from "@eden/llm";
import type { AgentEvent, Injection } from "@eden/protocol";
import { QueryPlanner } from "@eden/sources";
import { draftOf, type DraftMode } from "../drafts";
import { narrowQuestion } from "../narrow";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { DiskCardMaker } from "./cards-disk";
import { clearSlot, dress } from "./hidden-context";
import { record, tidy } from "./ledger";
import { Timeline } from "./timeline";
import { parseSuites, SUITES, type HiddenTask } from "./suites";
import { packetLine } from "./uptake";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const SUITE = opt("suite", "hidden");
const SUITE_LIST = parseSuites(SUITE);
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
/**
 * `--time 1`: the connectors answer at their profile's latency in real time (and rate-limit in real time), so `ms/task`
 * is the delivery latency a user would see; 0 (the default) answers at once.
 */
const TIME = Number(opt("time", "0"));
const CONFIG = JSON.parse(opt("config", "{}")) as Record<string, unknown>;
const LIVE = opt("judge", "none") === "live";
const SYNC = args.includes("--sync");
/** `--ask`: each request is also asked of Eden (`ask`), recording whether the answer cites the planted item. */
const ASK = args.includes("--ask");
/**
 * `--ask-question narrow` (with `--ask`): the ask's question is the request narrowed as an agent would word it
 * (`narrow.ts`, "<name> <object> <action noun>?"; a simulation assumption) instead of the request's own text.
 */
const ASK_Q = opt("ask-question", "request");
if (ASK_Q !== "request" && ASK_Q !== "narrow") throw new Error("--ask-question must be request or narrow");
const SERIAL = args.includes("--serial");
const NOOP_SPANS = opt("spans", "") === "noop";
const REAL_SYNC = CONFIG.sync === true;
if (REAL_SYNC && SYNC) throw new Error("--sync (the oracle) and the real sync (config sync) are exclusive");
/** The real sync's listing calls over the whole run (every suite), and the lookups that answered locally. */
const syncUse = {
  backfill: 0,
  background: 0,
  demand: 0,
  // On-demand listing calls as the sync counts them: with `syncPollBehind` a lookup's trace carries none of its poll's.
  demandAll: 0,
  lookups: 0,
  localSources: 0,
  warmMs: 0,
  users: 0,
};
const CARDS = opt("cards", "");
/** One replaying maker for every seed and suite: the disk cache is read once. */
const cardMaker = CARDS ? new DiskCardMaker(CARDS) : null;
/**
 * `--card-log out.jsonl`: every item the enrichment sent for a card (its content hash, title, the head of its text
 * the prefilter reads, and the replayed card's kind: "none", or "uncovered" when not replayed), to study the
 * prefilter offline (docs/research/gen-tokens.md). Sim worlds only.
 */
const CARD_LOG = opt("card-log", "");
if (CARD_LOG && cardMaker) {
  writeFileSync(CARD_LOG, "");
  const make = cardMaker.make.bind(cardMaker);
  cardMaker.make = async (items, today, signal, retry) => {
    const got = await make(items, today, signal, retry);
    if (!retry) {
      const lines = items.map((it, k) => {
        const kind = got.cards[k]?.kind ?? (cardMaker.cards.has(cardKey(it)) ? "none" : "uncovered");
        return JSON.stringify({ h: cardKey(it), title: it.title, text: it.text.slice(0, 2_700), kind });
      });
      appendFileSync(CARD_LOG, lines.map((l) => `${l}\n`).join(""));
    }
    return got;
  };
}
/** Every lane's enrichment counters, summed (`CardStats`): items read by the model and calls, per simulated user. */
const cardUse: Record<string, number> = {};
const cardLanes: CardEnricher[] = [];
/** No cap on replayed cards: they cost nothing here (the enrichment's spend is `cards-enrich.ts`'s). */
const UNCAPPED = { callsPerSession: Infinity, usdPerSession: Infinity, usdPerUserDay: Infinity };
const CARD_LIMITS = JSON.parse(opt("card-limits", "{}")) as Record<string, unknown>;
const PLANTED_AGE_DAYS = Number(opt("planted-age-days", "0"));
const PUSH = args.includes("--push");
const LEAD = opt("lead-in", "") as DraftMode | "";
if (LEAD && LEAD !== "clause" && LEAD !== "half") throw new Error("--lead-in must be clause or half");
const TYPING_MS = Number(opt("typing-ms", "1500"));
const KEY = process.env.OPENROUTER_API_KEY;
if (LIVE && !KEY) throw new Error("--judge live needs OPENROUTER_API_KEY");
const MODEL = opt("model", "z-ai/glm-5.3-flash");
const TIMELINE = opt("timeline", "");
/**
 * `--packets out.jsonl`: each task's packets as the agent would read them (text, reason, cited item ids) and the
 * planted item's id, a JSON line per task, to study the packet's form (docs/research/econ-lab.md). Sim worlds only.
 */
const PACKETS = opt("packets", "");
if (PACKETS) writeFileSync(PACKETS, "");
/**
 * `--candidates out.jsonl`: every no-model decision's candidates with their facts (`decide.ts`), one line per task with
 * the planted item's id and variant, for the decision analysis (docs/research/econ-decide.md). Ids and numbers only.
 */
const CANDIDATES = opt("candidates", "");
if (CANDIDATES) writeFileSync(CANDIDATES, "");
/**
 * `--ask-diag out.jsonl` (with `--ask`): each task's ask candidates with their facts (`CandidateDump`, path "ask"),
 * the planted item's id and rank among them, and whether it was cached, one line per task (docs/research/gen-ask.md).
 */
const ASK_DIAG = opt("ask-diag", "");
if (ASK_DIAG) writeFileSync(ASK_DIAG, "");
const timeline = TIMELINE
  ? new Timeline(TIMELINE, { tool: "hidden-funnel", suites: SUITE_LIST, seeds: SEEDS, config: CONFIG, sync: SYNC })
  : null;
/** The live judge's use over the whole run (every suite): calls, tokens and OpenRouter's reported cost. */
const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
/**
 * Main-thread CPU spent inside the tasks' engine calls (`observe`, `takePending`), apart from building worlds and
 * connector indexes: the engine's own cost, and the in-process connectors' searches. Exact with `--serial`; with seeds
 * running concurrently a task's figure also holds what other seeds' tasks ran while it waited.
 */
let taskCpuUs = 0;
const metered = (inner: Model): Model => ({
  id: inner.id,
  chat: async (request) => {
    const res = await inner.chat(request);
    usage.calls++;
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.costUsd += res.costUsd;
    return res;
  },
});

interface Row {
  n: number;
  returned: number;
  cached: number;
  delivered: number;
  calls: number;
  ms: number;
}
type Rows = Map<string, { hidden: Row; control: Row }>;
const row = (): Row => ({ n: 0, returned: 0, cached: 0, delivered: 0, calls: 0, ms: 0 });

/** One suite through the funnel: per-template rows and one record per task. Each suite plants its own worlds. */
async function runSuite(suite: string): Promise<{ rows: Rows; perTask: Record<string, unknown>[]; wall: number }> {
  const rows: Rows = new Map();
  const perTask: Record<string, unknown>[] = [];
  const started = performance.now();
  for (const variant of ["hidden", "control"] as const) {
    const results: TaskRow[][] = [];
    if (SERIAL) for (const seed of SEEDS) results.push(await runSeed(suite, variant, seed));
    else results.push(...(await Promise.all(SEEDS.map((seed) => runSeed(suite, variant, seed)))));
    for (const r of results) {
      for (const t of r) {
        const both = rows.get(t.template) ?? { hidden: row(), control: row() };
        rows.set(t.template, both);
        const x = both[variant];
        x.n++;
        if (t.returned) x.returned++;
        if (t.cached) x.cached++;
        if (t.delivered) x.delivered++;
        x.calls += t.calls;
        x.ms += t.ms;
        perTask.push({ ...t });
      }
    }
  }
  return { rows, perTask, wall: (performance.now() - started) / 1000 };
}

interface TaskRow {
  seed: number;
  variant: "hidden" | "control";
  template: string;
  returned: boolean;
  cached: boolean;
  delivered: boolean;
  why: string;
  injected: number;
  /** Bytes of every packet the task delivered (the agent's input), and how many packets. */
  packetBytes: number;
  packets: number;
  calls: number;
  ms: number;
  /** With `--ask`: whether the answer cites the planted item, its bytes and items, and the ask's wall time. */
  askCited?: boolean;
  askBytes?: number;
  askKept?: number;
  askItems?: number;
  askMs?: number;
  /** When the planted item reached the agent, from the request (ms of wall time); absent when it did not. */
  deliveryMs?: number;
  /** It came with the request's own reply (the observe call), not later. */
  immediate?: boolean;
  /** The session's anticipation had fetched or held it before the request (`Trace.prefetched`). */
  prefetched?: boolean;
  /** Source calls made between the lead-in and the request (the prefetch's). */
  leadCalls?: number;
  /**
   * Searches the connectors served for this task, counted at the connector: `calls` is what the engine's traces
   * report, and a lookup's trace counts only the probe calls sent within its grace (`probeGraceMs`), not those that
   * finish later; a prefetch counts all of its own.
   */
  served: number;
}

/** One suite's tasks in one seed's world, in order, as one user would bring them. */
async function runSeed(suite: string, variant: "hidden" | "control", seed: number): Promise<TaskRow[]> {
  const perTask: TaskRow[] = [];
  const world = buildWorld({ seed: seed * 1_000 });
  const before = world.items.length;
  const tasks: HiddenTask[] = SUITES[suite]!(world, seed, variant);
  const planted = world.items.slice(before);
  if (PLANTED_AGE_DAYS > 0) for (const it of planted) it.updatedAt = world.now - PLANTED_AGE_DAYS * 86_400_000;
  for (const it of planted) dress(world, it);
  // The slot each request asks for is otherwise free, so a clash is the planted one (clearSlot).
  const keep = new Set(planted.map((it) => it.id));
  for (const task of tasks) clearSlot(world, task.text, keep);
  const sources = simSources(world, REALISTIC, TIME, seed);
  const returned = new Set<string>();
  let served = 0;
  for (const s of sources) {
    const search = s.search.bind(s);
    s.search = async (q, signal) => {
      served++;
      const items = await search(q, signal);
      for (const i of items) returned.add(i.id);
      return items;
    };
  }
  let clock = world.now;
  const cache = new ItemCache();
  let calls = 0;
  const prefetched = new Set<string>();
  const lane = `${suite}/${variant}/${seed}`;
  const dumps = new Map<string, CandidateDump[]>();
  const askDumps = new Map<string, CandidateDump>();
  const onCandidates =
    CANDIDATES || ASK_DIAG
      ? (d: CandidateDump) => {
          if (d.path === "ask") {
            askDumps.set(d.sessionId, d);
            return;
          }
          if (!CANDIDATES) return;
          const list = dumps.get(d.sessionId) ?? [];
          dumps.set(d.sessionId, list);
          list.push(d);
        }
      : undefined;
  const countCalls = (t: Trace) => {
    // A prefetch's calls (`anticipate`) are the task's too.
    calls += t.sourceCalls + (t.anticipateCalls ?? 0);
    for (const id of t.prefetched ?? []) prefetched.add(id);
    if (t.localSources !== undefined) {
      syncUse.lookups++;
      syncUse.localSources += t.localSources;
      syncUse.demand += t.syncCalls ?? 0;
    }
  };
  const cards = cardMaker
    ? new CardEnricher({ maker: cardMaker, budget: new Budget(UNCAPPED), now: () => clock }, CARD_LIMITS)
    : null;
  if (cards) cardLanes.push(cards);
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed }),
    cache,
    budget: new Budget(),
    model: LIVE ? metered(new OpenRouterModel({ apiKey: KEY!, model: MODEL })) : null,
    planner: new QueryPlanner({ seed }),
    now: () => clock,
    config: TIME > 0 ? { sourceTimeoutMs: 1_500 * TIME, ...CONFIG } : CONFIG,
    onTrace: timeline ? timeline.traceSink(lane, countCalls) : countCalls,
    ...(timeline ? { onSpan: timeline.sink(lane) } : NOOP_SPANS ? { onSpan: () => {} } : {}),
    ...(cards ? { cards } : {}),
    ...(onCandidates ? { onCandidates } : {}),
  });
  // The harness may read the engine's session table (as `quality.ts` `settle` does; product code may not): whether a
  // session's lookup, prefetch or work its lookup left running (`behind`: `syncPollBehind`'s poll and follow-up,
  // `judgeBehind`'s judge) is still running.
  const table = (
    partner as unknown as {
      sessions: Map<string, { inflight: unknown; ant?: { running: unknown }; behind?: unknown }>;
    }
  ).sessions;
  const busy = (sessionId: string) => {
    const s = table.get(`${scope.tenantId}/${scope.userId}#${sessionId}`);
    return !!(s?.inflight || s?.ant?.running || s?.behind);
  };
  const scope = { tenantId: "funnel", userId: `w${seed}` };
  // The real sync: the backfill runs before the first task, from half an hour before it on the simulated clock (a
  // minute per tick), so the tasks see the same clock as without it.
  const sync = REAL_SYNC ? partner.sync! : null;
  if (sync) {
    clock = world.now - 30 * 60_000;
    sync.track(scope, clock);
    const t0 = performance.now();
    for (let i = 0; i < 120 && !sync.warm(scope); i++) {
      const n = await sync.tick(); // Read before adding: seeds run concurrently.
      syncUse.backfill += n;
      clock += 60_000;
    }
    syncUse.warmMs += performance.now() - t0;
    syncUse.users++;
    if (PUSH) {
      for (const s of sources) partner.sourcePushes(scope, s.id);
      // The watch's one poll (what changed before it, no notice names), as a tenant's sync would make it.
      syncUse.backfill += await sync.tick();
    }
    // Cards for the backfilled items, as a long-running sync would have them before the first request.
    if (cards) await cards.idle();
    clock = world.now;
  }
  // `--sync`: the experiment where Eden has already synced every item of the user's sources into its own index.
  if (SYNC) {
    const syncing = timeline?.task(lane, "sync", "sync");
    const synced = cache.put(
      scope,
      sources.flatMap((s) => s.listAll()),
      clock,
    );
    syncing?.end();
    // A sync's items are enriched as a sync would enrich them, before the first request.
    if (cards) {
      cards.enqueue(scope, synced);
      await cards.idle();
    }
  }
  for (const [i, task] of tasks.entries()) {
    if (sync) {
      // The hour between tasks, on the sync's timer: a tick every five simulated minutes.
      for (let m = 0; m < 12; m++) {
        clock += 5 * 60_000;
        const n = await sync.tick();
        syncUse.background += n;
      }
    } else clock += 3_600_000;
    const id = planted[i]!.id;
    const sessionId = task.id;
    returned.clear();
    prefetched.clear();
    const callsBefore = calls;
    const servedBefore = served;
    const c0 = cpuNow();
    const traced = timeline?.task(lane, sessionId, `${lane}/${task.template}`);
    const at = clock;
    await partner.observe({ ...scope, sessionId, at, kind: "session_start" } as AgentEvent);
    if (LEAD) {
      const text = draftOf(task.text, LEAD);
      await partner.observe({ ...scope, sessionId, at, kind: "user_message", text, draft: true } as AgentEvent);
      if (TIME > 0) await Bun.sleep(TYPING_MS * TIME);
      else for (let k = 0; k < 5_000 && busy(sessionId); k++) await Bun.sleep(1);
    }
    const leadCalls = calls - callsBefore;
    const t0 = performance.now();
    const r = await partner.observe(
      { ...scope, sessionId, at, kind: "user_message", text: task.text } as AgentEvent,
      // A live judge answers in seconds: the slow path is waited for, so what it lets through counts here.
      { waitMs: LIVE ? 30_000 : 3_000 * Math.max(1, TIME) },
    );
    const ms = performance.now() - t0;
    // What arrives after the reply (a lookup still running behind a delivery made from what was held), with when.
    const arrived: { ids: string[]; at: number }[] = [];
    const pendingSeen: Injection[] = [];
    if (r.injection) arrived.push({ ids: r.injection.citations.map((c) => c.itemId), at: ms });
    const deadline = performance.now() + (LIVE ? 30_000 : 3_000 * Math.max(1, TIME));
    for (;;) {
      for (const x of partner.takePending({ ...scope, sessionId })) {
        pendingSeen.push(x);
        arrived.push({ ids: x.citations.map((c) => c.itemId), at: performance.now() - t0 });
      }
      if (!busy(sessionId) || performance.now() > deadline) break;
      await Bun.sleep(1);
    }
    for (const x of partner.takePending({ ...scope, sessionId })) {
      pendingSeen.push(x);
      arrived.push({ ids: x.citations.map((c) => c.itemId), at: performance.now() - t0 });
    }
    taskCpuUs += cpuNow() - c0;
    // Enrichment of what this request brought in finishes before the next request (it lands one request later).
    if (cards) await cards.idle();
    const injections = [...(r.injection ? [r.injection] : [])];
    const got = arrived.flatMap((x) => x.ids);
    const question = ASK_Q === "narrow" ? narrowQuestion(task.text) : task.text;
    const a0 = performance.now();
    const answered = ASK ? await partner.ask({ ...scope, sessionId, question }) : null;
    const askMs = performance.now() - a0;
    const askCited = answered ? answered.citations.some((c) => c.itemId === id) : undefined;
    if (ASK_DIAG && answered) {
      const d = askDumps.get(sessionId);
      askDumps.delete(sessionId);
      const line = {
        suite,
        seed,
        variant,
        template: task.template,
        request: task.text,
        question,
        planted: id,
        cached: !!cache.get(scope, id, clock),
        delivered: got.includes(id),
        askCited,
        rank: d ? d.candidates.findIndex((c) => c.id === id) : -1,
        cited: answered.citations.map((c) => c.itemId),
        answer: answered.answer,
        detail: task.detail,
        candidates: d?.candidates ?? [],
      };
      appendFileSync(ASK_DIAG, `${JSON.stringify(line)}\n`);
    }
    // How the planted item was delivered (the injection reason's kind: sources, grounded-…, fallback, model).
    const why =
      [...injections, ...pendingSeen].find((x) => x.citations.some((c) => c.itemId === id))?.reason.split(":")[0] ?? "";
    const first = arrived.find((x) => x.ids.includes(id));
    traced?.end({ template: task.template, delivered: got.includes(id), why, injected: got.length });
    if (PACKETS) {
      const line = packetLine({ suite, seed, variant, template: task.template, request: task.text, planted: id }, [
        ...injections,
        ...pendingSeen,
      ]);
      // The ask's answer as the agent reads it, and the planted item's own words and the detail a good answer raises,
      // so a byte cut can be checked for the fact it keeps (docs/research/gen-tokens.md).
      const extra = {
        detail: task.detail,
        plantedText: `${planted[i]!.title} ${planted[i]!.text}`,
        ...(answered ? { answer: answered.answer, answerIds: answered.citations.map((c) => c.itemId) } : {}),
      };
      appendFileSync(PACKETS, JSON.stringify({ ...line, ...extra }) + "\n");
    }
    if (CANDIDATES) {
      const line = {
        suite,
        seed,
        variant,
        template: task.template,
        planted: id,
        delivered: got,
        dumps: dumps.get(sessionId),
      };
      appendFileSync(CANDIDATES, `${JSON.stringify(line)}\n`);
      dumps.delete(sessionId);
    }
    perTask.push({
      seed,
      variant,
      template: task.template,
      returned: returned.has(id),
      cached: !!cache.get(scope, id, clock),
      delivered: got.includes(id),
      ...(askCited === undefined
        ? {}
        : {
            askCited,
            askBytes: Buffer.byteLength(answered!.answer),
            ...(askCited ? { askKept: kept(task.detail, planted[i]!, answered!.answer) } : {}),
            askItems: answered!.citations.length,
            askMs: Number(askMs.toFixed(2)),
          }),
      why,
      injected: got.length,
      packetBytes: [...injections, ...pendingSeen].reduce((n, x) => n + Buffer.byteLength(x.text), 0),
      packets: injections.length + pendingSeen.length,
      calls: calls - callsBefore,
      served: served - servedBefore,
      ms: Number(ms.toFixed(2)),
      ...(first
        ? { deliveryMs: Number(first.at.toFixed(2)), immediate: r.injection?.citations.some((c) => c.itemId === id) }
        : {}),
      ...(prefetched.has(id) ? { prefetched: true } : {}),
      ...(LEAD ? { leadCalls } : {}),
    });
  }
  // The polls a lookup left running behind it finish before the count is read.
  if (sync) {
    for (let k = 0; k < 5_000 && [...table.values()].some((x) => x.inflight || x.behind); k++) await Bun.sleep(1);
    await Bun.sleep(TIME > 0 ? 2_000 * TIME : 5);
    syncUse.demandAll += sync.stats.demandCalls;
  }
  return perTask;
}

/**
 * A proxy for whether an answer says the hidden detail, not only cites its item: of the detail's key words (numbers,
 * and words of four letters or more) that the planted item holds, the share the answer's text holds too.
 */
function kept(detail: string, item: { title: string; text: string }, answer: string): number {
  const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const has = words(`${item.title} ${item.text}`);
  const shown = words(answer);
  const keys = [...words(detail)].filter((w) => (/\d/.test(w) || w.length >= 4) && has.has(w));
  if (keys.length === 0) return 1;
  return Number((keys.filter((w) => shown.has(w)).length / keys.length).toFixed(3));
}

const pct = (a: number, n: number) => `${a}/${n}`;
const line = (name: string, r: { hidden: Row; control: Row }) =>
  `${name.padEnd(24)} ${pct(r.hidden.returned, r.hidden.n).padStart(16)} ${pct(r.hidden.delivered, r.hidden.n).padStart(9)}` +
  `   ${pct(r.control.delivered, r.control.n).padStart(22)}` +
  `   ${(r.hidden.calls / Math.max(1, r.hidden.n)).toFixed(1).padStart(10)}` +
  ` ${(r.hidden.ms / Math.max(1, r.hidden.n)).toFixed(1).padStart(8)}`;
const add = (into: { hidden: Row; control: Row }, r: { hidden: Row; control: Row }) => {
  for (const v of ["hidden", "control"] as const) {
    for (const k of Object.keys(into[v]) as (keyof Row)[]) into[v][k] += r[v][k];
  }
};

console.log(`suite ${SUITE_LIST.join(",")}, seeds ${SEEDS.join(",")}, config ${JSON.stringify(CONFIG)}`);
const header = "template                 hidden: returned delivered   control: decoy delivered   calls/task  ms/task";
const grand = { hidden: row(), control: row() };
const runs: { suite: string; rows: Rows; perTask: Record<string, unknown>[]; wall: number; total: typeof grand }[] = [];
const cpu0 = process.cpuUsage();
for (const suite of SUITE_LIST) {
  const { rows, perTask, wall } = await runSuite(suite);
  const total = { hidden: row(), control: row() };
  if (SUITE_LIST.length > 1) console.log(`\n== ${suite}`);
  console.log(header);
  for (const [name, r] of rows) {
    add(total, r);
    console.log(line(name, r));
  }
  console.log(line(SUITE_LIST.length > 1 ? `total ${suite}` : "TOTAL", total));
  add(grand, total);
  runs.push({ suite, rows, perTask, wall, total });
}
// Several suites: the TOTAL over all of them, as the last table line (bench.ts reads the line before `recorded`).
if (SUITE_LIST.length > 1) {
  console.log(`\n${header}`);
  for (const r of runs) console.log(line(r.suite, r.total));
  console.log(line("TOTAL", grand));
}
if (REAL_SYNC) {
  const tasks = Math.max(1, grand.hidden.n + grand.control.n);
  const requestCalls = grand.hidden.calls + grand.control.calls;
  console.log(
    `sync: backfill ${syncUse.backfill} calls (${(syncUse.backfill / Math.max(1, syncUse.users)).toFixed(1)}/user, ` +
      `${(syncUse.warmMs / Math.max(1, syncUse.users)).toFixed(0)} ms/user), background ${syncUse.background} ` +
      `(${(syncUse.background / tasks).toFixed(2)}/task), on-demand ${syncUse.demand} ` +
      `(${(syncUse.demand / tasks).toFixed(2)}/task, in calls/task; ${syncUse.demandAll} by the sync's count); ` +
      `request ${(requestCalls / tasks).toFixed(2)}/task; amortised total ` +
      `${((requestCalls + syncUse.demandAll - syncUse.demand + syncUse.background + syncUse.backfill) / tasks).toFixed(2)}` +
      `/task; ` +
      `local sources ${(syncUse.localSources / Math.max(1, syncUse.lookups)).toFixed(2)}/lookup`,
  );
}
if (cardMaker) {
  for (const c of cardLanes) for (const [k, v] of Object.entries(c.stats)) cardUse[k] = (cardUse[k] ?? 0) + v;
  cardUse.users = cardLanes.length;
  console.log(`cards: ${cardMaker.hits} replayed, ${cardMaker.misses} uncovered (no cached card)`);
  console.log(`cards use: ${JSON.stringify(cardUse)}`);
}
if (LIVE) {
  const tasks = Math.max(1, grand.hidden.n + grand.control.n);
  console.log(
    `judge ${MODEL}: ${usage.calls} calls (${(usage.calls / tasks).toFixed(2)}/task), ` +
      `${(usage.inputTokens / Math.max(1, usage.calls)).toFixed(0)} in / ` +
      `${(usage.outputTokens / Math.max(1, usage.calls)).toFixed(0)} out tokens per call, ` +
      `$${usage.costUsd.toFixed(4)} ($${((1000 * usage.costUsd) / tasks).toFixed(4)} per 1k tasks)`,
  );
}
if (!args.includes("--no-record")) {
  for (const { suite, rows, perTask, wall, total: t } of runs) {
    const n = (k: keyof Row, v: "hidden" | "control") => t[v][k] / Math.max(1, t[v].n);
    const metrics: Record<string, number> = {
      hiddenReturned: n("returned", "hidden"),
      hiddenCached: n("cached", "hidden"),
      hiddenDelivered: n("delivered", "hidden"),
      decoyDelivered: n("delivered", "control"),
      callsPerTask: (t.hidden.calls + t.control.calls) / Math.max(1, t.hidden.n + t.control.n),
      msPerTask: (t.hidden.ms + t.control.ms) / Math.max(1, t.hidden.n + t.control.n),
      tasks: t.hidden.n + t.control.n,
      ...(LIVE && suite === runs[0]!.suite
        ? {
            judgeCallsPerTask: usage.calls / Math.max(1, grand.hidden.n + grand.control.n),
            judgeInputTokens: usage.inputTokens / Math.max(1, usage.calls),
            judgeOutputTokens: usage.outputTokens / Math.max(1, usage.calls),
            judgeUsdPer1kTasks: (1000 * usage.costUsd) / Math.max(1, grand.hidden.n + grand.control.n),
          }
        : {}),
    };
    for (const [name, r] of rows) {
      metrics[`delivered.${name}`] = r.hidden.delivered / Math.max(1, r.hidden.n);
      metrics[`decoy.${name}`] = r.control.delivered / Math.max(1, r.control.n);
    }
    const e = record(
      {
        tier: "funnel",
        suite,
        label: opt("label", Object.keys(CONFIG).length ? "custom" : "baseline"),
        config: CONFIG,
        seeds: SEEDS,
        // The judge's spend is the whole run's (all suites), booked on the first suite's record.
        costUsd: suite === runs[0]!.suite ? Number(usage.costUsd.toFixed(6)) : 0,
        wallSeconds: Number(wall.toFixed(1)),
        metrics: tidy(metrics),
      },
      perTask,
    );
    console.log(`recorded ${e.id}`);
  }
}
if (TIMELINE || NOOP_SPANS || SERIAL || args.includes("--cpu")) {
  const c = process.cpuUsage(cpu0);
  console.error(`cpu suites ${((c.user + c.system) / 1e6).toFixed(3)} s, tasks ${(taskCpuUs / 1e6).toFixed(3)} s`);
}
await timeline?.close();
const out = opt("json", "");
if (out) {
  // One suite keeps the original shape; several add `suites`, and `rows`/`total` are over all of them.
  const rows = Object.fromEntries(
    runs.flatMap((r) => [...r.rows].map(([k, v]) => [SUITE_LIST.length > 1 ? `${r.suite}/${k}` : k, v])),
  );
  const suites = Object.fromEntries(runs.map((r) => [r.suite, { rows: Object.fromEntries(r.rows), total: r.total }]));
  writeFileSync(
    out,
    JSON.stringify(
      {
        suite: SUITE_LIST.join(","),
        seeds: SEEDS,
        config: CONFIG,
        rows,
        total: grand,
        ...(REAL_SYNC ? { sync: syncUse } : {}),
        ...(cardMaker ? { cards: cardUse } : {}),
        ...(SUITE_LIST.length > 1 ? { suites } : {}),
        // Per task, with the suite: how each planted item was delivered (`why`), for breakdowns by path.
        perTask: runs.flatMap((r) => r.perTask.map((t) => ({ suite: r.suite, ...t }))),
      },
      null,
      2,
    ),
  );
}
