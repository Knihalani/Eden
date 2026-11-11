#!/usr/bin/env bun
/**
 * The free tier of the hidden-context benchmark (docs/research/probes.md): each task's request is played through
 * Eden alone, with no agent and no model, and the planted item is followed through the engine's funnel. Deterministic
 * and offline, so any change to retrieval or delivery can be checked in seconds before a live run.
 *
 * For each template, and in total:
 * - hidden tasks: was the planted item returned by a source, cached, delivered (higher is better);
 * - control tasks (the decoy planted instead): was the decoy delivered (noise: lower is better);
 * - source calls per task, and the engine's wall time per task. Calls are counted at the connector (`SimSource.stats`
 *   over the task's window: searches and on-demand listings; the background sync's ticks fall outside it), not from
 *   the engine's traces: those are printed beside them as a cross-check (audit 2026-11-03, finding 18).
 *
 *   bun packages/sim/src/lab/hidden-funnel.ts [--suite hidden|heldout|heldout-all|all|a,b] [--seeds 41,42,43,44]
 *     [--time 0]
 *     [--config '{"probes":true}'] [--json out.json] [--label probes] [--no-record] [--judge live [--model m]]
 *     [--sync] [--cards DIR/cards.jsonl] [--card-limits '{"batch":20}'] [--planted-age-days N] [--push]
 *     [--lead-in clause|half] [--time 0] [--typing-ms 1500] [--packets out.jsonl]
 *
 * `--judge live` gives Eden its judge (OpenRouter, `OPENROUTER_API_KEY`): the funnel then measures what the judge lets
 * through, hidden and decoy, and its calls, tokens and spend (about $0.03 for the 456 held-out tasks), a cheap screen
 * before an agent run. Seeds run concurrently. With a free judge (`--model <id>:free --allow-logging`, lab only;
 * `free.ts`) its calls are paced (`--rpm`, default 18) and capped (`--max-requests`); a judge call refused at the cap
 * takes the engine's no-model path, so such a run is reported as PARTIAL and not recorded in the ledger. A judge call
 * waits for its turn inside its own deadline (the engine's), so keep a free run small (`--serial`, one seed).
 *
 * `--timeline out.jsonl` records every engine span, each task and the process's CPU% and RSS per second
 * (`timeline.ts`); `timeline-report.ts out.jsonl` says where the time went. Spans change no decision.
 * `--spans noop` turns spans on into a sink that drops them (the tracer's own cost, for overhead runs); `--serial`
 * plays the seeds one after another (same results; a task's wall time is then its own, not shared with other seeds);
 * at `--time` > 0 the hidden and control variants also run at once unless `--serial`.
 * `--wait-ms N` sets the request's observe wait (default 3,000 × max(1, `--time`)) and the run prints how many
 * deliveries an agent collecting before its first model call would hold; `--overlap` sends another request just before
 * each one, so it arrives while a lookup is in flight (the slow path busy; not comparable scores).
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
 * `--planted-age-days N` dates every planted item (hidden and decoy) N days before the present instead of one: a
 * stress test for rules that read an item by its age (docs/research/econ-background.md): every suite plants a
 * day-old item.
 * `--lead-in` gives each request a "user is typing" draft before it (`drafts.ts`: its first clause, or its first
 * half; a simulation assumption, since no suite carries one), sent as a draft user message (which the engine
 * ignores). With `--time 0` the request follows once the engine has settled; with `--time T` the connectors answer at
 * their realistic latencies times T and the request follows `--typing-ms` × T later. Each task then records when the
 * planted item reached the agent (`deliveryMs`, from the request), whether it came with the request's own reply
 * (`immediate`), and the calls the lead-in made (`leadCalls`).
 *
 * `--reader live|replay` (with `"askReader": true` in `--config` and `--ask`) gives Eden its ask-time reader (D95,
 * `reader.ts`) on `--reader-model` (default z-ai/glm-5.3-flash; `--reader-sort price` for the cheapest compliant
 * endpoint; a `:free` model through `free.ts` with `--allow-logging --rpm --max-requests`). `--reader-cache FILE`
 * keeps every call under its prompt's hash (`reader-disk.ts`), so a rerun replays it at no cost; `replay` never
 * calls (a prompt not cached fails open). The run prints the reader's calls, tokens, spend and latency p50/p90 as
 * made, and each task records what the reader did (`reader*`). Replay misses are counted and gate the run: with any,
 * it is not recorded and exits 3 (`MISS_EXIT`) unless `--allow-misses` (docs/LAB.md). `--limit N` plays only the
 * first N tasks of each suite, variant and seed (a sample; run the baseline with the same N).
 *
 * `--suite` names any suite of `suites.ts`, or several: each gets its own table, then a TOTAL over all of them.
 * Each suite's run is recorded in the benchmark ledger (bench/, `ledger.ts`) unless `--no-record`.
 *
 * `--neutral` also runs the `neutral` variant of the suites that build it (neutral.ts: the same requests, nothing
 * planted) and prints a NEUTRAL line per suite (any packet delivered, items, bytes, ask items, calls, ms per task); its
 * rows go to the JSON's `neutral` block, never to `rows`, `total` or `perTask`.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import {
  AskReader,
  CardEnricher,
  cardKey,
  intentCut,
  intentReach,
  ModelReaderMaker,
  type ReaderReport,
  ContextPartner,
  cpuNow,
  ItemCache,
  type CandidateDump,
  type CardMaker,
  automated,
  type PushPoolReport,
  PushChecker,
  worthCarding,
  worthCardingStrict,
  ECONOMY_CARD_LIMITS,
  type Trace,
  readerMessages,
  sanitizeItem,
} from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, type Model } from "@eden/llm";
import type { AgentEvent, Injection } from "@eden/protocol";
import { QueryPlanner } from "@eden/sources";
import { sanitizeForStore } from "@eden/redact";
import { draftOf, type DraftMode } from "../drafts";
import { narrowQuestion } from "../narrow";
import { REALISTIC, simSources, type SimSource } from "../sources";
import { applyNotifyShare, connectorOptions, parseNotifyShare, pushNotifier } from "./connector-options";
import { noiseSources } from "./noise-sources";
import { buildWorld } from "../world";
import { DiskCardMaker } from "./cards-disk";
import { ENDPOINT_LABEL, cardsOnly, endpointCardMaker, endpointFromArgs } from "./cards-endpoint";
import {
  allMissedHint,
  cacheModels,
  costAsMade,
  DEFAULT_READER_MODEL,
  missGate,
  overBudgetLine,
  ReplayModel,
  SubsetReplay,
  systemHash,
} from "./reader-disk";
import { flags, labConfig, parseJson } from "./flags";
import { keyFor, labAccess, labModel } from "./free";
import { clearSlot, dress } from "./hidden-context";
import { record, tidy } from "./ledger";
import { Timeline } from "./timeline";
import { parseSuites, preparedWorld, prepareWorld, SUITES, type HiddenTask } from "./suites";
import {
  beforeModelLine,
  CountingReader,
  INTENT_INERT,
  intentState,
  OracleReaderMaker,
  parseOracle,
  screenLines,
  STUB_BANNER,
  type ScreenRow,
} from "./reader-stub";
import { packetLine } from "./uptake";
import {
  addNeutralRows,
  addNeutralTask,
  neutralLine,
  neutralRow,
  supportsNeutral,
  type NeutralOut,
  type NeutralRow,
} from "./neutral";
import { DistilledReaderMaker, loadModel, parseDistill } from "./distilled-reader";
import { effective } from "./presets";
import { loadTagger } from "./m3-tagger";
import {
  coverageLines,
  intentPlace,
  plantedCoverageLine,
  surfacedBy,
  surfacedLines,
  type AskCoverage,
  type SurfacedBy,
  type SurfacedRow,
} from "./ask-coverage";

const args = process.argv.slice(2);
const V = "value" as const;
const B = "bool" as const;
// Strict (flags.ts): an unknown flag exits 2 before any world is built; `--help` prints this and the header has the
// rest. The pacer's and spend ledger's flags are read by `labAccess` (free.ts) from the same arguments.
const cli = flags(
  "hidden-funnel",
  {
    ...Object.fromEntries(
      [
        "suite",
        "seeds",
        "time",
        "config",
        "judge",
        "model",
        "wait-ms",
        "ask-question",
        "spans",
        "cards",
        "cards-calls",
        "cards-rest",
        "cards-endpoint",
        "cards-endpoint-model",
        "intent",
        "card-log",
        "card-limits",
        "planted-age-days",
        "lead-in",
        "typing-ms",
        "reader",
        "packet-k",
        "reader-model",
        "reader-sort",
        "reader-cache",
        "reader-thinking",
        "limit",
        "reader-log",
        "reader-subset",
        "timeline",
        "packets",
        "candidates",
        "ask-diag",
        "pool-dump",
        "corpus-dump",
        "label",
        "json",
        "rpm",
        "max-requests",
        "spend-ledger",
        "spend-cap",
        "spend-headroom",
        "run-label",
        "distill",
        "noise-sources",
        "notify-share",
        "noise-items",
        "noise-vocab",
        "source-profile",
        "push",
        "push-rates",
        "fetch-gone",
        "check",
        "check-model",
        "check-cache",
        "check-log",
        "templates",
        "connect-at",
        "connect-tick-s",
        "connect-stagger-s",
        "cards-ms",
        "tagger",
      ].map((k) => [k, V]),
    ),
    ...Object.fromEntries(
      ["overlap", "sync", "ask", "serial", "allow-misses", "no-record", "cpu", "allow-logging", "neutral"]
        .concat("call-split")
        .map((k) => [k, B]),
    ),
  },
  `
bun packages/sim/src/lab/hidden-funnel.ts [--suite hidden|heldout|all|a,b] [--seeds 41,42,43,44] [--time 0]
  [--config '{"probes":true}'] [--json out.json] [--label L] [--no-record] [--ask] [--cards F] [--intent F]
  [--reader none|stub|oracle|replay|live] [--limit N] ... (every flag: the header of hidden-funnel.ts;
  the common screen with a preset is \`bun run funnel\`, docs/LAB.md)`,
);
if (cli.rest.length) {
  console.error(`hidden-funnel: unexpected arguments after --: ${cli.rest.join(" ")}; --help lists the flags`);
  process.exit(2);
}
const opt = cli.opt;
const SUITE = opt("suite", "hidden");
const SUITE_LIST = parseSuites(SUITE);
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
/**
 * `--time 1`: the connectors answer at their profile's latency in real time (and rate-limit in real time), so `ms/task`
 * is the delivery latency a user would see; 0 (the default) answers at once.
 */
const TIME = Number(opt("time", "0"));
/**
 * `--noise-sources N` (A1 scale audit): N unrelated connectors beside the world's five, `--noise-items` items each
 * (default 20; `noise-sources.ts`), so the screen runs a user with ~1,000 sources. 0 (the default): none.
 */
const NOISE_SOURCES = Number(opt("noise-sources", "0"));
/**
 * `--source-profile FILE|JSON`, `--push none|signals|payload`, `--push-rates` (A18, the live harnesses' connector
 * options, connector-options.ts): the market latency profiles and change notices pi-ab runs under, so the funnel at
 * `--time 1` times Eden's own path (observe, push, ask re-reads, search, poll) as the agent would wait on it, at $0.
 * `signals`: before each task each source notifies with chance 1 - exp(-rate); `payload` sends none (the world does
 * not change). Defaults (REALISTIC, no notices) leave every earlier run as it was.
 */
const CONNECTORS = connectorOptions(opt);
/** `--notify-share P` (N1, `applyNotifyShare`): the share of connectors that send change notifications. */
const NOTIFY_SHARE = parseNotifyShare(opt("notify-share", ""));
/** `--fetch-gone false`: the sources' fetch null proves nothing, as an MCP connector's (A18; default true). */
const FETCH_GONE = opt("fetch-gone", "true") !== "false";
const NOISE_ITEMS = Number(opt("noise-items", "20"));
/** `--noise-vocab N` (O1): each noise connector gets N words of its own (`noiseSources`); 0, the shared words only. */
const NOISE_VOCAB = Number(opt("noise-vocab", "0"));
/** `--config`: engine settings, checked whole (checkEngineConfig); a typo or a child whose parent is off exits 2. */
const CONFIG = ((): Record<string, unknown> => {
  try {
    return labConfig(parseJson(opt("config", "{}"), "--config"), "--config");
  } catch (error) {
    console.error(`hidden-funnel: ${(error as Error).message}`);
    process.exit(2);
  }
})();
/** What runs: `--config` over the default (D112). */
const RUN = effective(CONFIG);
const LIVE = opt("judge", "none") === "live";
/**
 * `--wait-ms N`: how long the request's observe waits for its lookup (the client's `waitMs`), default 30,000 with a
 * live judge, else 3,000 × max(1, `--time`). What the reply and the pending queue right after it carry is what an agent
 * that collects before its first model call gets: each delivered task records it (`beforeModel`) and the run prints
 * the count. Later arrivals are still collected (for up to the default window) and count as delivered, as before.
 */
const WAIT_DEFAULT = LIVE ? 30_000 : 3_000 * Math.max(1, TIME);
const WAIT_MS = Number(opt("wait-ms", String(WAIT_DEFAULT)));
if (!(WAIT_MS >= 0)) throw new Error("--wait-ms must be a number of at least 0");
/**
 * `--overlap`: before each request, another user message (the suite's next task's request) is sent in the same
 * session with no wait, so the request arrives while that lookup is in flight (the slow path busy), which no other
 * funnel task shape reaches. Changes the task shape: its scores are not comparable with a run without it.
 */
const OVERLAP = cli.has("overlap");
/** Traces of a request that arrived while its session's slow path was busy (`--overlap`). */
const busyTraces = { busy: 0 };
const SYNC = cli.has("sync");
/** `--ask`: each request is also asked of Eden (`ask`), recording whether the answer cites the planted item. */
const ASK = cli.has("ask");
/**
 * `--ask-question narrow` (with `--ask`): the ask's question is the request narrowed as an agent would word it
 * (`narrow.ts`, "<name> <object> <action noun>?"; a simulation assumption) instead of the request's own text.
 */
const ASK_Q = opt("ask-question", "request");
if (ASK_Q !== "request" && ASK_Q !== "narrow") throw new Error("--ask-question must be request or narrow");
const SERIAL = cli.has("serial");
/**
 * `--neutral`: also run each suite's `neutral` variant where the suite builds it (neutral.ts): the same requests with
 * nothing planted. Reported apart (the NEUTRAL lines and the JSON's `neutral` block); the hidden and control figures
 * are unchanged by it.
 */
const NEUTRAL = cli.has("neutral");
const NOOP_SPANS = opt("spans", "") === "noop";
const REAL_SYNC = RUN.sync;
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
  // On-demand listings the connectors received inside the tasks' windows (in calls/task).
  demandSeen: 0,
  // Items the sync's listings brought in (`SyncStats`): on demand, and in the background (backfill, polls, sweeps).
  // Summed per user before each lane's sync is discarded; D101's on-demand items figure is `demandItems`.
  demandItems: 0,
  backgroundItems: 0,
  users: 0,
};
/** Over the whole run: calls the connectors received in the tasks' windows (listings among them); the traces' sum. */
const callCheck = { received: 0, listed: 0, traced: 0 };
/**
 * `--call-split` (N1, a diagnostic print for one process): the calls in the tasks' windows by connector (the world's
 * own or a noise one; search or listing) and the traces' calls by what made them.
 */
const CALL_SPLIT = cli.has("call-split");
const callSplit = { worldSearch: 0, worldList: 0, noiseSearch: 0, noiseList: 0, tasks: 0, distinct: 0, repeats: 0 };
const callsByTrace = new Map<string, number>();
const CARDS = opt("cards", "");
/**
 * `--intent FILE[,FILE]` (with `"intent": true` in `--config`): the requests `cards-enrich.ts --intent` wrote, replayed
 * into the intent index (D87, docs/research/edge-intent.md). Cards still come from `--cards` alone.
 */
const INTENT_FILES = opt("intent", "").split(",").filter(Boolean);
/** One replaying maker for every seed and suite: the disk cache is read once. */
// With no --intent, no requests are replayed at all (not a card file's `r` lines), so `--ask-diag`'s replay figure
// (null with no --intent) says what the run replayed.
/**
 * `--cards-endpoint URL [--cards-endpoint-model NAME]` (M0, lab only, `cards-endpoint.ts`): cards `--cards` does not
 * hold are made live by an OpenAI-compatible endpoint (the distilled card model on Modal) and appended to `--cards`,
 * at $0 Anthropic. The run's label and JSON say so (`cardsTransport`): its cards are not the shipped model's.
 */
const CARDS_ENDPOINT = opt("cards-endpoint", "");
if (CARDS_ENDPOINT && !CARDS) throw new Error("--cards-endpoint needs --cards FILE (the endpoint's cards go there)");
const cardLive = CARDS_ENDPOINT
  ? endpointCardMaker(endpointFromArgs(CARDS_ENDPOINT, opt("cards-endpoint-model", "")))
  : undefined;
const cardMaker = CARDS
  ? new DiskCardMaker(CARDS, cardLive, { requests: INTENT_FILES, cardRequests: INTENT_FILES.length > 0 })
  : null;
if (INTENT_FILES.length && !cardMaker) throw new Error("--intent needs --cards");
if (CARDS_ENDPOINT) console.log(`cards: ${ENDPOINT_LABEL}, misses made live and appended to ${CARDS}`);
/**
 * `--card-log out.jsonl`: every item the enrichment sent for a card (its content hash, title, the head of its text
 * the prefilter reads, and the replayed card's kind: "none", or "uncovered" when not replayed), to study the
 * prefilter offline (docs/research/gen-tokens.md). Sim worlds only.
 */
/** `--cards-calls N` (F2): each world's enrichment gets N card calls; the items past them stay uncovered. */
const CARDS_CALLS = Number(opt("cards-calls", "-1"));
/**
 * `--cards-rest cards` (N4, with `--cards-calls N`): the calls past N are answered with their cards and no requests,
 * standing in for a cheap card-only model (M2's distilled one, whose cards match the teacher's and whose requests do
 * not) reading the rest of a new user's backfill while the card model proper has made N calls.
 */
const CARDS_REST = opt("cards-rest", "none");
if (CARDS_REST !== "none" && CARDS_REST !== "cards") throw new Error("--cards-rest is none or cards");
if (CARDS_REST === "cards" && CARDS_CALLS < 0) throw new Error("--cards-rest cards needs --cards-calls N");
/**
 * `--connect-at 0,15,45,…` (O4, docs/research/o4-new-user.md): a new user. Each world's user is tracked (as their
 * first event tracks them) with nothing synced, and each task is asked at one of these many seconds after that, in
 * real time: the sync ticks as the servers' timer does (first `--connect-tick-s` seconds after the connect, 30 by
 * default: the mean wait for a 60-second timer; then every 60), and nothing waits for the backfill or the cards.
 * A world runs once per task (a replica: a user of its own), and replica r asks task (r + j) mod T at checkpoint j:
 * a user makes one request a checkpoint, and every task is asked at every checkpoint once. Rows carry `connectS` (the
 * checkpoint), `sinceConnectMs` (when the request was sent) and `replica`. `--cards-ms L`: each card call takes L ms
 * (default 2,700 here, Haiku's p50, docs/COST-MODEL.md; the replayed maker otherwise answers at once).
 * `--connect-stagger-s S` (default 2): replicas start S seconds apart, so their backfills do not share the cores.
 * Use with `--time 1` (the connectors' latency is the backfill's time).
 */
const CONNECT_AT = opt("connect-at", "")
  .split(",")
  .filter((x) => x !== "")
  .map(Number);
if (CONNECT_AT.some((x) => !(x >= 0))) throw new Error("--connect-at takes seconds, each at least 0");
const CONNECT = CONNECT_AT.length > 0;
// Without the sync a "new user" is every user: the checkpoints would measure nothing.
if (CONNECT && !REAL_SYNC) throw new Error("--connect-at needs the real sync (the default's, or --config sync)");
const CONNECT_TICK_S = Number(opt("connect-tick-s", "30"));
const CONNECT_STAGGER_S = Number(opt("connect-stagger-s", "2"));
const CARDS_MS = Number(opt("cards-ms", CONNECT ? "2700" : "0"));
const CARD_LOG = opt("card-log", "");
if (CARD_LOG && cardMaker) {
  writeFileSync(CARD_LOG, "");
  const make = cardMaker.make.bind(cardMaker);
  cardMaker.make = async (items, today, signal, retry, intent) => {
    const got = await make(items, today, signal, retry, intent);
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
/**
 * Items the intent index asked the replay about, and those it found requests for: with intent on and none found the
 * index is inert (no `--intent F`, or a file for other items), and every TOTAL and pool line and the JSON say so.
 */
const intentUse = { asked: 0, found: 0 };
if (cardMaker && RUN.intent) {
  const make = cardMaker.make.bind(cardMaker);
  cardMaker.make = async (items, today, signal, retry, intent) => {
    const got = await make(items, today, signal, retry, intent);
    if (intent && !retry) {
      const requests = "requests" in got ? got.requests : [];
      intentUse.asked += items.length;
      intentUse.found += requests.filter((r) => r !== null && r.length > 0).length;
    }
    return got;
  };
}
const intentNow = () => intentState(RUN, intentUse);
/**
 * Whether the loaded intent replay has a line for an item's content (`cardKey`); null with no replay loaded. A
 * planted item without one runs with no requests in every intent screen (D173: printed as planted coverage). Read on
 * the cached item, whose content is what the card model would be sent.
 */
const inReplay = (item: Parameters<typeof cardKey>[0]): boolean | null =>
  INTENT_FILES.length && cardMaker ? cardMaker.requests.has(cardKey(item)) : null;
/** The inert mark for a line, read when the line is printed (the replay's hits so far). */
const inertTag = () => (intentNow() === "inert" ? `  ${INTENT_INERT}` : "");
/** Every lane's enrichment counters, summed (`CardStats`): items read by the model and calls, per simulated user. */
const cardUse: Record<string, number> = {};
const cardLanes: CardEnricher[] = [];
/** No cap on replayed cards: they cost nothing here (the enrichment's spend is `cards-enrich.ts`'s). */
const UNCAPPED = { callsPerSession: Infinity, usdPerSession: Infinity, usdPerUserDay: Infinity };
const CARD_LIMITS = JSON.parse(opt("card-limits", "{}")) as Record<string, unknown>;
const PLANTED_AGE_DAYS = Number(opt("planted-age-days", "0"));
const LEAD = opt("lead-in", "") as DraftMode | "";
if (LEAD && LEAD !== "clause" && LEAD !== "half") throw new Error("--lead-in must be clause or half");
if (LEAD && OVERLAP) throw new Error("--lead-in and --overlap are exclusive (each is a different lead-in)");
const TYPING_MS = Number(opt("typing-ms", "1500"));
const MODEL = opt("model", "z-ai/glm-5.3-flash");
const KEY = LIVE ? keyFor(MODEL) : undefined;
/**
 * `--reader live|replay|stub|oracle[:p_hit,p_false]`: the ask-time reader (D95); its model, routing and disk replay
 * cache. `stub` and `oracle` make no model call (`reader-stub.ts`): stub says nothing binds and the run reports the
 * reader's pool (hidden and decoy in pool); oracle flags the planted hidden item and rejects the decoy, flipped at the
 * given rates, a proxy.
 */
const READER = opt("reader", "none");
const ORACLE = READER.startsWith("oracle") ? parseOracle(READER) : null;
if (!["none", "live", "replay", "stub"].includes(READER) && !ORACLE) {
  throw new Error("--reader must be live, replay, stub or oracle[:p_hit,p_false]");
}
/** No model behind the reader: its pool is measured, its verdict is a stub's or the oracle proxy's. */
const NO_MODEL_READER = READER === "stub" || ORACLE !== null;
/** Every line that reports a delivery under the oracle says it is a proxy. */
const TAG = ORACLE ? `  [oracle proxy ${ORACLE.pHit},${ORACLE.pFalse}]` : "";
/**
 * `--packet-k K[,K]` (with `--ask`): for each K, whether the planted item ranks in the ask's top K candidates (the
 * packet an agent would read if Eden handed it the top K with no reader), the packet's bytes at `askItemBytes` per item
 * and the item's position. A diagnostic, not a delivery: docs/LAB.md.
 */
const PACKET_K = opt("packet-k", "").split(",").filter(Boolean).map(Number);
if (PACKET_K.some((k) => !Number.isInteger(k) || k < 1))
  throw new Error("--packet-k takes whole numbers of at least 1");
if (PACKET_K.length && !ASK) throw new Error("--packet-k needs --ask");
const READER_MODEL = opt("reader-model", DEFAULT_READER_MODEL);
const READER_SORT = opt("reader-sort", "") as "" | "price" | "throughput" | "latency";
const READER_CACHE = opt("reader-cache", "");
// The cache is plain JSONL, read whole and appended to by a live reader: a checked-in `.gz` (docs/LAB.md) is unpacked
// under `.local/` first, or every line would fail to parse.
if (READER_CACHE.endsWith(".gz")) {
  throw new Error(`--reader-cache ${READER_CACHE} is compressed: gunzip -c it into .local/ and name that file`);
}
/** `--reader-thinking adaptive`: a `claude-*` reader thinks (at the reader's low effort); default off. */
const READER_THINKING = opt("reader-thinking", "off") as "off" | "adaptive";
const READER_KEY = READER === "live" ? keyFor(READER_MODEL) : undefined;
if (READER !== "none" && !ASK && !RUN.readerPush) throw new Error("--reader needs --ask (or readerPush)");
const LIMIT = Number(opt("limit", "0"));
/**
 * `--templates a,b` (N2): only these templates' tasks run (every template's planted item stays in the world, so the
 * kept tasks see the world a full run gives them).
 */
const TEMPLATES = opt("templates", "") ? new Set(opt("templates", "").split(",")) : null;
if (TEMPLATES) {
  // A typo would run no tasks and print totals of zero: every name must be a template of a suite in the run.
  const known = new Set(
    SUITE_LIST.flatMap((suite) => SUITES[suite]!(preparedWorld(suite, SEEDS[0]!), SEEDS[0]!, "hidden")).map(
      (t) => t.template,
    ),
  );
  const unknown = [...TEMPLATES].filter((t) => !known.has(t));
  if (unknown.length) {
    console.error(`hidden-funnel: --templates names no template of the run's suites: ${unknown.join(", ")}`);
    process.exit(2);
  }
}
/** `--reader-log out.jsonl`: each reader call's prompt (the items as the model read them) and reply, sim data only. */
const READER_LOG = opt("reader-log", "");
// An approximated verdict logged beside recorded ones would be read back later as a real reading (checked before the
// log is created).
if (opt("reader-subset", "") && READER_LOG) {
  throw new Error("--reader-subset and --reader-log cannot be used together");
}
if (READER_LOG) writeFileSync(READER_LOG, "");
/** The hash of the reader's instructions, on each `--reader-log` line, so `--reader-subset` matches like with like. */
const READER_SYS = systemHash({ messages: readerMessages({ request: "", items: [], today: "" }) });
/**
 * `--reader-subset LOG[,LOG]` (with `--reader replay`): a prompt the cache misses is answered from a `--reader-log`
 * call of the same model whose pool held its items in order (`SubsetReplay`, approximate; every run says how many).
 */
const READER_SUBSET = opt("reader-subset", "");
if (READER_SUBSET && READER !== "replay") throw new Error("--reader-subset needs --reader replay");
/**
 * `--check live|replay` (I3, D500): the `pushCheck` trial's model (`--check-model`, default Haiku 5.5), through a
 * replay cache (`--check-cache F`, appended to by a live run: pay once). Wiring it changes nothing unless the run's
 * configuration turns `pushCheck` on. `live` keeps the funnel to one process (one cache file, one ledger stream).
 */
const CHECK = opt("check", "none");
if (!["none", "live", "replay"].includes(CHECK)) throw new Error("--check must be live or replay");
const CHECK_MODEL = opt("check-model", "claude-haiku-5-5");
const CHECK_CACHE = opt("check-cache", "");
if (CHECK !== "none" && !CHECK_CACHE) throw new Error("--check needs --check-cache FILE");
if (CHECK !== "none" && !RUN.pushCheck)
  throw new Error("--check is inert unless pushCheck is on (--set pushCheck=true)");
/**
 * `--tagger DIR` (M3, D908): the `constraintTag` trial's item tagger, an exported binnet `tags` network. Inert unless
 * the run's configuration sets `constraintTag` above 0.
 */
const TAGGER_DIR = opt("tagger", "");
if (TAGGER_DIR && !(RUN.constraintTag > 0)) throw new Error("--tagger is inert unless constraintTag > 0 (--set)");
const tagger = TAGGER_DIR ? loadTagger(TAGGER_DIR) : null;
if (tagger) process.on("exit", () => console.error(`TAGGER ${JSON.stringify(tagger.stats())}`));
/** The judge's, the reader's and the check's requests: paced, capped and retried, with the run's logging choice. */
const ACCESS = labAccess(args, [
  ...(LIVE ? [MODEL] : []),
  ...(READER === "live" ? [READER_MODEL] : []),
  ...(CHECK === "live" ? [CHECK_MODEL] : []),
]);
/** One replaying check model for every lane; each lane's `PushChecker` keeps its own stats. */
const checkModel =
  CHECK === "none"
    ? null
    : new ReplayModel(
        CHECK_CACHE,
        CHECK === "live"
          ? labModel(ACCESS, { apiKey: keyFor(CHECK_MODEL)!, model: CHECK_MODEL, timeoutMs: 60_000 }, "eden.check")
          : null,
        CHECK_MODEL,
      );
/** `--check-log FILE` (N5): each check call's prompt (request and items as read) and reply, sim data only. */
const CHECK_LOG = opt("check-log", "");
if (CHECK_LOG) writeFileSync(CHECK_LOG, "");
const loggedCheck = (tag: Record<string, unknown>): Model | null =>
  checkModel && CHECK_LOG
    ? {
        id: checkModel.id,
        chat: async (request) => {
          const res = await checkModel.chat(request);
          const prompt = request.messages.find((m) => m.role === "user")?.content ?? "";
          appendFileSync(CHECK_LOG, `${JSON.stringify({ ...tag, prompt, reply: res.text })}\n`);
          return res;
        },
      }
    : checkModel;
const checkLanes: PushChecker[] = [];
/** One replaying reader model for every seed and suite (each lane keeps its own verdict cache, `AskReader`). */
const readerModel =
  READER === "none" || NO_MODEL_READER
    ? null
    : new ReplayModel(
        READER_CACHE,
        READER === "live"
          ? labModel(
              ACCESS,
              {
                apiKey: READER_KEY!,
                model: READER_MODEL,
                timeoutMs: 60_000,
                ...(READER_SORT ? { sort: READER_SORT } : {}),
              },
              "eden.reader",
            )
          : null,
        READER_MODEL,
        READER_SUBSET ? { subset: new SubsetReplay(READER_SUBSET.split(","), READER_MODEL, READER_SYS) } : {},
      );
const readerLanes: AskReader[] = [];
/** `--distill record|labels|cascade:FILE` (distilled-reader.ts): record reader verdicts, replay labels, or cascade. */
const DISTILL = opt("distill", "") ? parseDistill(opt("distill", "")) : null;
const DISTILL_MODEL = DISTILL?.mode === "cascade" ? loadModel(DISTILL.file) : null;
const distillLanes: DistilledReaderMaker[] = [];
/** `--allow-misses`: accept a replay run some of whose reader prompts were not cached (they fail open). */
const ALLOW_MISSES = cli.has("allow-misses");
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
/** partner.ts's `INTENT_QUERY_CHARS` (not exported): `--ask-diag` searches the intent index with as much. */
const INTENT_QUERY_CHARS = 400;
/**
 * `--ask-diag out.jsonl` (with `--ask`): each task's ask candidates with their facts (`CandidateDump`, path "ask"),
 * the planted item's id and rank among them, and whether it was cached, one line per task (docs/research/gen-ask.md).
 * Each line's `coverage` (`ask-coverage.ts`, with cards and intent on) says whether the intent index could reach the
 * planted item: requests in the replay and held at the ask, sent to the card model or not, and its hit for the
 * question; the run splits the rank -1 items into not sent (prefilter rejects), not in replay,
 * no intent requests, and no match (D173).
 */
const ASK_DIAG = opt("ask-diag", "");
/**
 * `--pool-dump FILE` (a diagnostic, docs/research/a2-quality.md): per task, the push's candidate pool (`onPushPool`,
 * its last pass: a `readerPushBehind` second pass replaces the first's packet) in order, each item's title, text, card
 * and flags (handed, automated sender, `readerGate`'s constraint test), and the planted item's (decoy's) place in it.
 */
const POOL_DUMP = opt("pool-dump", "");
/**
 * `--corpus-dump FILE` (a diagnostic, docs/research/a2-quality.md): per suite world, its items (title, text head) and
 * its tasks with their planted ids, for offline retrieval screens. Since A15 (docs/research/a15-retrieval.md) each
 * item is as its source lists it and the cache holds it (redacted), with `h`, its card key, which joins it to the
 * replayed cards and intent requests (`packages/sim/lab/a15/run_screen.py`).
 */
const CORPUS_DUMP = opt("corpus-dump", "");
if (ASK_DIAG) writeFileSync(ASK_DIAG, "");
/**
 * Each `--ask-diag` row's variant, rank, cached flag and coverage facts (`ask-coverage.ts`), for the run's split of
 * the rank -1 items: not sent (prefilter rejects), not in replay, no intent requests, requests but no match.
 */
const askDiagRows: { variant: string; rank: number; cached: boolean; coverage: AskCoverage | null }[] = [];
/** Expired cards the diagnostic's own intent search dropped (`intentFinds` drops what it passes); printed when any. */
let diagDropped = 0;
/** The enricher's prefilter as configured (`cardsEconomy` is strict unless `--card-limits` says otherwise). */
const STRICT_PREFILTER =
  typeof CARD_LIMITS.strict === "boolean" ? CARD_LIMITS.strict : RUN.cardsEconomy && !!ECONOMY_CARD_LIMITS.strict;
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
  const variants = ["hidden", "control"] as const;
  const runVariant = (variant: (typeof variants)[number]) => runSeeds(suite, variant);
  // At `--time` > 0 a task's wall time is mostly connector sleeps, so the two variants (each in its own worlds) run
  // at once, as seeds do; `--serial` keeps them one after the other. The rows are folded in the same order either way.
  const byVariant =
    TIME > 0 && !SERIAL
      ? await Promise.all(variants.map(runVariant))
      : [await runVariant("hidden"), await runVariant("control")];
  for (const [v, results] of byVariant.entries()) {
    const variant = variants[v]!;
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

/** `--connect-at`: the noise connectors of each world, shared by its replicas. */
const sharedNoise = new Map<string, SimSource[]>();

/** One suite and variant over every seed: one after the other with `--serial`, else at once. */
async function runSeeds(suite: string, variant: "hidden" | "control" | "neutral"): Promise<TaskRow[][]> {
  const results: TaskRow[][] = [];
  if (CONNECT) {
    // `--connect-at`: one replica (a user) a task, every seed's at once (each starts at its own stagger).
    const runs = SEEDS.flatMap((seed) => {
      const all = SUITES[suite]!(preparedWorld(suite, seed), seed, variant);
      const kept = all.filter((t) => !TEMPLATES || TEMPLATES.has(t.template)).length;
      const users = LIMIT > 0 ? Math.min(LIMIT, kept) : kept;
      return Array.from({ length: users }, (_, replica) => runSeed(suite, variant, seed, replica, users));
    });
    results.push(...(await Promise.all(runs)));
  } else if (SERIAL) for (const seed of SEEDS) results.push(await runSeed(suite, variant, seed));
  else results.push(...(await Promise.all(SEEDS.map((seed) => runSeed(suite, variant, seed)))));
  return results;
}

interface TaskRow {
  seed: number;
  variant: "hidden" | "control" | "neutral";
  template: string;
  returned: boolean;
  cached: boolean;
  delivered: boolean;
  /** When surfaced (delivered or ask-cited): reader-flagged, rule path or listed only (D173, ask-coverage.ts). */
  surfacedBy?: SurfacedBy;
  /** With an intent replay loaded and the item cached: whether the replay has a line for its content (D173). */
  inReplay?: boolean;
  why: string;
  injected: number;
  /** Bytes of every packet the task delivered (the agent's input), and how many packets. */
  packetBytes: number;
  packets: number;
  /**
   * Calls the connectors received in the task's window (`SimSource.stats.calls`: searches and on-demand sync listings;
   * the background sync's ticks run outside the window, as `quality.ts` leaves them out): ground truth for calls per
   * task.
   */
  calls: number;
  /** The engine's traces' sum for the task (`sourceCalls`): a cross-check, fetches included. */
  traced: number;
  /** The on-demand sync listings among `calls`. */
  listed: number;
  ms: number;
  /** With `--ask`: whether the answer cites the planted item, its bytes and items, and the ask's wall time. */
  askCited?: boolean;
  askBytes?: number;
  askKept?: number;
  askItems?: number;
  askMs?: number;
  /** `askBehind` (D430): the planted item came in the ask's follow-up packet, this many ms after the ask began. */
  askLateMs?: number;
  /** When the planted item reached the agent, from the request (ms of wall time); absent when it did not. */
  deliveryMs?: number;
  /** It came with the request's own reply (the observe call), not later. */
  immediate?: boolean;
  /** Source calls made between the lead-in and the request. */
  leadCalls?: number;
  /**
   * When delivered: the planted item came with the observe's reply or was pending right after it (within `--wait-ms`),
   * so an agent that collects before its first model call has it.
   */
  beforeModel?: boolean;
  /**
   * Searches the connectors served for this task, counted by a wrapper on `search` (`calls` less `listed`).
   */
  served: number;
  /** With a model reader (live or replayed): its calls in the task's window and their cost as made (H18). */
  readerCalls?: number;
  readerUsd?: number;
  /** `--connect-at`: the task's checkpoint (s after the connect), when its request was sent, and its replica. */
  connectS?: number;
  sinceConnectMs?: number;
  replica?: number;
  /** `--connect-at`: whether every source had finished its backfill when the request was sent, and items held. */
  warmAtRequest?: boolean;
  syncedAtRequest?: number;
}

/** One suite's tasks in one seed's world, in order, as one user would bring them. */
async function runSeed(
  suite: string,
  variant: "hidden" | "control" | "neutral",
  seed: number,
  replica = 0,
  replicas = 1,
): Promise<TaskRow[]> {
  const perTask: TaskRow[] = [];
  const world = buildWorld({ seed: seed * 1_000 });
  prepareWorld(suite, world, seed);
  const before = world.items.length;
  const all: HiddenTask[] = SUITES[suite]!(world, seed, variant);
  // Planted items line up with `all` (one a template, in order); `--templates` keeps the pairs together.
  const plantedAll = world.items.slice(before);
  const chosen = all.map((_, i) => i).filter((i) => !TEMPLATES || TEMPLATES.has(all[i]!.template));
  const tasksIn = (LIMIT > 0 ? chosen.slice(0, LIMIT) : chosen).map((i) => all[i]!);
  const plantedIn = TEMPLATES && plantedAll.length === all.length ? chosen.map((i) => plantedAll[i]!) : plantedAll;
  // `--connect-at`: this replica's user asks task (replica + j) mod T at checkpoint j, and no other task.
  const order = CONNECT
    ? CONNECT_AT.slice(0, tasksIn.length).map((_, j) => (replica + j) % tasksIn.length)
    : tasksIn.map((_, i) => i);
  const tasks = order.map((i) => tasksIn[i]!);
  const planted = CONNECT ? order.map((i) => plantedIn[i]!) : plantedIn;
  const checkpoints = CONNECT_AT;
  // The world is made whole whatever `--templates` keeps: every planted item aged and dressed, every slot cleared
  // (with `--limit`, as before, only the kept tasks' slots).
  if (PLANTED_AGE_DAYS > 0) for (const it of plantedAll) it.updatedAt = world.now - PLANTED_AGE_DAYS * 86_400_000;
  for (const it of plantedAll) dress(world, it);
  // The slot each request asks for is otherwise free, so a clash is the planted one (clearSlot).
  const keep = new Set(plantedAll.map((it) => it.id));
  for (const task of LIMIT > 0 ? tasks : all) clearSlot(world, task.slotText ?? task.text, keep);
  if (CORPUS_DUMP) {
    // `--corpus-dump` (A2): the world's items as its sources hold them, with the tasks and their planted ids.
    // Each item as its source lists it (a separate, unmetered set of sources), and `h`: the card key of the copy the
    // cache holds (redacted), to join an item to its replayed cards and requests.
    const rows = simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll());
    const items = rows.map((raw) => {
      const it = sanitizeItem(raw);
      return { id: raw.id, h: cardKey(it), title: it.title, text: it.text.slice(0, 1_200) };
    });
    const asks = tasks.map((t, i) => ({ template: t.template, request: t.text, planted: planted[i]?.id ?? "" }));
    appendFileSync(CORPUS_DUMP, `${JSON.stringify({ suite, seed, variant, tasks: asks, items })}\n`);
  }
  const own = simSources(world, CONNECTORS.profiles, TIME, seed);
  const notify = pushNotifier(own, CONNECTORS, seed, world.now);
  if (!FETCH_GONE) for (const s of own) s.fetchReportsGone = false;
  // `--connect-at`: a world's replicas share its noise connectors (995 of them hold 550 MB; their content depends
  // on the world's seed alone), so their call counters and rate limits are shared too: calls a task mean nothing there.
  const noiseKey = `${suite}/${variant}/${seed}`;
  const noise =
    NOISE_SOURCES === 0
      ? []
      : CONNECT
        ? (sharedNoise.get(noiseKey) ??
          sharedNoise
            .set(noiseKey, noiseSources(world, NOISE_SOURCES, NOISE_ITEMS, TIME, seed, NOISE_VOCAB))
            .get(noiseKey)!)
        : noiseSources(world, NOISE_SOURCES, NOISE_ITEMS, TIME, seed, NOISE_VOCAB);
  const sources = [...own, ...noise];
  // `--notify-share P` (N1): only that share of the connectors notify; the rest are polled and swept.
  applyNotifyShare(sources, NOTIFY_SHARE, seed);
  const returned = new Set<string>();
  // `--call-split`: the sources searched in the current task's window, and every (source, query text) of this user.
  const searchedNow = new Map<string, number>();
  const everAsked = new Set<string>();
  let served = 0;
  for (const s of sources) {
    const search = s.search.bind(s);
    s.search = async (q, signal) => {
      served++;
      if (CALL_SPLIT) {
        searchedNow.set(s.id, (searchedNow.get(s.id) ?? 0) + 1);
        const key = `${s.id}|${q.text}`;
        callSplit.repeats += everAsked.has(key) ? 1 : 0;
        everAsked.add(key);
      }
      const items = await search(q, signal);
      for (const i of items) returned.add(i.id);
      return items;
    };
  }
  let clock = world.now;
  const cache = new ItemCache();
  let calls = 0;
  const lane = `${suite}/${variant}/${seed}`;
  const dumps = new Map<string, CandidateDump[]>();
  const askDumps = new Map<string, CandidateDump>();
  const onCandidates =
    CANDIDATES || ASK_DIAG || PACKET_K.length
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
  // What the connectors received (`stats.calls` counts searches and listings), read around each task: the ground truth
  // for calls per task, as `quality.ts` reads it.
  const received = () => sources.reduce((n, s) => n + s.stats.calls, 0);
  const listed = () => sources.reduce((n, s) => n + s.stats.lists, 0);
  const ownIds = new Set(own.map((x) => x.id));
  const splitNow = () => {
    const at = { worldSearch: 0, worldList: 0, noiseSearch: 0, noiseList: 0 };
    for (const x of sources) {
      const searches = x.stats.calls - x.stats.lists;
      if (ownIds.has(x.id)) ((at.worldSearch += searches), (at.worldList += x.stats.lists));
      else ((at.noiseSearch += searches), (at.noiseList += x.stats.lists));
    }
    return at;
  };
  const countCalls = (t: Trace) => {
    // The traces' count, a cross-check only.
    calls += t.sourceCalls;
    if (CALL_SPLIT && t.sourceCalls > 0) {
      const why = /^(cut search behind|sync poll behind|ask behind)/.exec(t.reason)?.[1] ?? "lookup";
      const key = `${t.event}/${why}`;
      callsByTrace.set(key, (callsByTrace.get(key) ?? 0) + t.sourceCalls);
    }
    if (t.reason.startsWith("slow path busy")) busyTraces.busy++;
    if (t.localSources !== undefined) {
      syncUse.lookups++;
      syncUse.localSources += t.localSources;
      syncUse.demand += t.syncCalls ?? 0;
    }
  };
  // With `--ask-diag`, the lane's own record of the contents its card model was sent (by `cardKey`): the shared maker
  // serves every lane, and hidden and control worlds of one seed share most items' content.
  const sentToCards = new Set<string>();
  const laneMaker: CardMaker | null =
    cardMaker && ASK_DIAG
      ? {
          // Not `async`: the maker's own promise, so the drain batches as without `--ask-diag` (an async wrapper's
          // microtask hops cut the cards-use calls from 822 to 766 and moved when requests were held).
          make: (items, today, signal, retry, intent) => {
            for (const it of items) sentToCards.add(cardKey(it));
            return cardMaker.make(items, today, signal, retry, intent);
          },
        }
      : cardMaker;
  // `--cards-calls N` (F2, D483): the lane's card model answers its first N calls and leaves the rest uncovered, as
  // a new user's first request meets a backfill the enrichment has only begun. Not `async`, as above.
  let cardCalls = 0;
  const cappedMaker: CardMaker | null =
    laneMaker && CARDS_CALLS >= 0
      ? {
          make: (items, today, signal, retry, intent) =>
            cardCalls++ < CARDS_CALLS
              ? laneMaker.make(items, today, signal, retry, intent)
              : CARDS_REST === "cards"
                ? laneMaker.make(items, today, signal, retry, intent).then((b) => cardsOnly(b, items.length))
                : Promise.resolve({ cards: items.map(() => null), costUsd: 0 }),
        }
      : laneMaker;
  // `--cards-ms`: a card call takes this long, as a model's does (the replayed maker answers at once).
  const timedMaker: CardMaker | null =
    cappedMaker && CARDS_MS > 0
      ? {
          make: (items, today, signal, retry, intent) =>
            Bun.sleep(CARDS_MS).then(() => cappedMaker.make(items, today, signal, retry, intent)),
        }
      : cappedMaker;
  const cards = timedMaker
    ? new CardEnricher({ maker: timedMaker, budget: new Budget(UNCAPPED), now: () => clock }, CARD_LIMITS)
    : null;
  if (cards) cardLanes.push(cards);
  // The lane's asks run one at a time: the model's latency for this task's call (as made, when replayed) is kept so a
  // run can say what a wait of `askReaderWaitMs` would have cut.
  let readerMs: number | undefined;
  let readerTask = "";
  // The lane's model reader calls and their cost as made (a replayed call at what it cost when recorded): read around
  // each task for its `readerCalls` and `readerUsd` (H18's cost screen, cost-screen.ts).
  let laneReaderCalls = 0;
  let laneReaderUsd = 0;
  const laneModel: Model | null = readerModel && {
    id: readerModel.id,
    chat: async (request) => {
      const log = (reply: string | null, ms?: number) => {
        if (!READER_LOG) return;
        const line = {
          task: readerTask,
          prompt: request.messages[1]?.content,
          reply,
          ms,
          model: readerModel.id,
          sys: systemHash(request),
        };
        appendFileSync(READER_LOG, `${JSON.stringify(line)}\n`);
      };
      let res: Awaited<ReturnType<Model["chat"]>>;
      try {
        res = await readerModel.chat(request);
      } catch (e) {
        log(null);
        throw e;
      }
      readerMs = res.latencyMs;
      laneReaderCalls++;
      laneReaderUsd += costAsMade(res);
      log(res.text, res.latencyMs);
      return res;
    },
  };
  // `--reader stub|oracle`: the lane's own no-model maker, so its calls and prompt sizes are this lane's tasks'.
  // Not with `--distill`: its maker answers every read, so a stub here would count nothing and report zeros.
  const stub = DISTILL
    ? null
    : ORACLE
      ? new OracleReaderMaker(ORACLE.pHit, ORACLE.pFalse)
      : NO_MODEL_READER
        ? new CountingReader()
        : null;
  // `--reader-log` with a no-model reader: the prompt a model would have read and the stub's or oracle's verdict.
  if (stub && READER_LOG) {
    stub.log = ({ prompt, reply }) =>
      appendFileSync(READER_LOG, `${JSON.stringify({ task: readerTask, reader: READER, prompt, reply })}\n`);
  }
  const modelMaker = laneModel ? new ModelReaderMaker(laneModel) : null;
  const distill = DISTILL
    ? new DistilledReaderMaker(DISTILL.mode, modelMaker, DISTILL.file, DISTILL_MODEL, DISTILL.out)
    : null;
  if (distill) distillLanes.push(distill);
  const maker = distill ?? stub ?? modelMaker;
  const reader = maker ? new AskReader({ maker, budget: new Budget(UNCAPPED), now: () => clock }) : null;
  if (reader) readerLanes.push(reader);
  // Every report per session, in order: a request can be read twice (`readerPush`'s ask, then the funnel's own).
  const readerReports = new Map<string, ReaderReport[]>();
  const laneCheck = loggedCheck({ suite, seed, variant });
  const checker = laneCheck ? new PushChecker({ model: laneCheck, budget: new Budget(UNCAPPED) }) : null;
  if (checker) checkLanes.push(checker);
  const pushPools = new Map<string, PushPoolReport[]>();
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed }),
    cache,
    budget: new Budget(),
    model: LIVE ? metered(labModel(ACCESS, { apiKey: KEY!, model: MODEL }, "eden.judge")) : null,
    planner: new QueryPlanner({ seed }),
    now: () => clock,
    config: TIME > 0 ? { sourceTimeoutMs: 1_500 * TIME, ...CONFIG } : CONFIG,
    onTrace: timeline ? timeline.traceSink(lane, countCalls) : countCalls,
    ...(timeline ? { onSpan: timeline.sink(lane) } : NOOP_SPANS ? { onSpan: () => {} } : {}),
    ...(cards ? { cards } : {}),
    ...(checker ? { checker } : {}),
    ...(tagger ? { constraintTag: { read: tagger.tag } } : {}),
    ...(reader
      ? {
          reader,
          onReader: (r: ReaderReport) => {
            const list = readerReports.get(r.sessionId) ?? [];
            readerReports.set(r.sessionId, list);
            list.push(r);
          },
        }
      : {}),
    ...(onCandidates ? { onCandidates } : {}),
    // `pushCandidates`' pool per pass (`--pool-dump`, and `pushPoolAt` in each task's row).
    onPushPool: (r: PushPoolReport) => {
      const list = pushPools.get(r.sessionId) ?? [];
      pushPools.set(r.sessionId, list);
      list.push(r);
    },
  });
  // The harness may read the engine's session table (as `quality.ts` `settle` does; product code may not): whether a
  // session's lookup or work its lookup left running (`behind`: `syncPollBehind`'s poll and follow-up, the
  // reader push's second reading) is still running.
  const table = (
    partner as unknown as {
      sessions: Map<string, { inflight: unknown; behind?: unknown }>;
    }
  ).sessions;
  const busy = (sessionId: string) => {
    const s = table.get(`${scope.tenantId}/${scope.userId}#${sessionId}`);
    return !!(s?.inflight || s?.behind);
  };
  const scope = { tenantId: "funnel", userId: `w${seed}` };
  /**
   * `--ask-diag`: whether the intent index could reach a planted item at its ask (`ask-coverage.ts`). Read after the
   * ask, at no call: the replay's requests for its content, the requests the engine held, whether the card model was
   * sent it and whether the prefilter rejects it, and its hit for the question (`intentPlace`) as the engine
   * searches it (redacted, its first `INTENT_QUERY_CHARS`, requests made before `askAt`, the ask's arrival), against
   * the thresholds. Null with cards or intent off.
   */
  const coverageOf = (item: ReturnType<ItemCache["get"]>, question: string, askAt: number): AskCoverage | null => {
    if (!cards || !RUN.cards || !RUN.intent || !item) return null;
    const hash = cardKey(item);
    const cardRead = sentToCards.has(hash);
    const prefilter = STRICT_PREFILTER ? worthCardingStrict(item) : worthCarding(item);
    const replay = inReplay(item);
    const held = cards.requestsOf(scope, item.id, askAt).length;
    let intent: AskCoverage["intent"] = null;
    // The card's kind is read inside the counted block (its read drops an expired card too); with no requests held,
    // read here after it.
    let cardKind: string | undefined;
    if (held > 0) {
      // The engine's calls (partner.ts intentFinds: k = `intentHits`, and with `intentByKind` k = `intentReach` for
      // the carded pass; before the ask's arrival, thresholds after), and an unbounded one (every hash the user
      // holds) so a passing hit past the engine's cut is still known. Each call drops the expired cards it passes
      // (counted, a side effect read after the ask).
      const text = sanitizeForStore(question).slice(0, INTENT_QUERY_CHARS);
      const accept = (x: string) => cache.get(scope, x, clock) !== null;
      const size0 = cards.intentSize(scope);
      const rule = intentCut(RUN);
      const cut = cards.intentFinds(scope, text, askAt, rule.hits, accept);
      const reach = intentReach(rule);
      const deep = reach > 0 ? cards.intentFinds(scope, text, askAt, reach, accept) : cut;
      const all = cards.intentFinds(scope, text, askAt, cards.intentSize(scope), accept);
      const kind = cards.cardsOf(scope, [item.id], askAt).get(item.id)?.kind ?? "none";
      diagDropped += size0 - cards.intentSize(scope);
      intent = intentPlace(cut, all, item.id, rule.minMatched, rule.minCoverage, rule.hits, rule.byKind, deep);
      cardKind = kind;
    }
    return {
      cardRead,
      // Not `cardsLean` itself: an item still queued at the ask is here too (ask-coverage.ts says why).
      notSentPrefilterRejects: !cardRead && !prefilter,
      // -1: the replay has no line for its content ("not in replay", told apart from a line with no requests).
      replayRequests: replay === null ? null : replay ? (cardMaker!.requests.get(hash)?.length ?? 0) : -1,
      heldRequests: held,
      cardKind: cardKind ?? cards.cardsOf(scope, [item.id], askAt).get(item.id)?.kind ?? "none",
      intent,
    };
  };
  // The real sync: the backfill runs before the first task, from half an hour before it on the simulated clock (a
  // minute per tick), so the tasks see the same clock as without it.
  const sync = REAL_SYNC ? partner.sync! : null;
  // `--connect-at`: the user is tracked now, as their first event would, and the clock runs with the wall from here.
  let connectedAt = 0;
  const timers: ReturnType<typeof setInterval>[] = [];
  if (sync && CONNECT) {
    // A slot of its own for each replica of each variant and seed (the neutral variant runs in its own phase).
    const slot = replica + (variant === "control" ? replicas : 0) + 2 * replicas * SEEDS.indexOf(seed);
    await Bun.sleep(slot * CONNECT_STAGGER_S * 1_000);
    connectedAt = performance.now();
    // Their first event (as a tenant's "user connected" would be): it tracks them, and with `syncKick` starts the
    // backfill.
    await partner.observe({ ...scope, sessionId: "connect", at: clock, kind: "session_start" } as AgentEvent);
    const tick = () => {
      clock = world.now + (performance.now() - connectedAt);
      // The calls are read from the sync's own count at the end: a kicked backfill's are in no tick's return.
      void sync.tick();
    };
    timers.push(setInterval(() => (clock = world.now + (performance.now() - connectedAt)), 100));
    timers.push(
      setTimeout(() => {
        tick();
        timers.push(setInterval(tick, 60_000));
      }, CONNECT_TICK_S * 1_000),
    );
    syncUse.users++;
  } else if (sync) {
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
    let sinceConnectMs = 0;
    let warmAtRequest = false;
    let syncedAtRequest = 0;
    if (sync && CONNECT) {
      // The task's checkpoint, on the wall; a task whose turn comes late (the ones before it ran long) goes at once.
      const wait = connectedAt + checkpoints[i]! * 1_000 - performance.now();
      if (wait > 0) await Bun.sleep(wait);
      clock = world.now + (performance.now() - connectedAt);
      sinceConnectMs = performance.now() - connectedAt;
      warmAtRequest = sync.warm(scope);
      syncedAtRequest = cache.syncedCount(scope);
    } else if (sync) {
      // The hour between tasks, on the sync's timer: a tick every five simulated minutes.
      for (let m = 0; m < 12; m++) {
        clock += 5 * 60_000;
        const n = await sync.tick();
        syncUse.background += n;
      }
    } else clock += 3_600_000;
    // `--push signals`: the hour's change notices, as pi-ab sends them before each task.
    notify(partner, scope);
    // A neutral task plants nothing: no item has the empty id, so every planted-item field reads false.
    const id = variant === "neutral" ? "" : planted[i]!.id;
    const sessionId = task.id;
    returned.clear();
    const callsBefore = calls;
    const receivedBefore = received();
    const splitBefore = CALL_SPLIT ? splitNow() : null;
    searchedNow.clear();
    const listedBefore = listed();
    const servedBefore = served;
    const c0 = cpuNow();
    const readerCalls0 = laneReaderCalls;
    const readerUsd0 = laneReaderUsd;
    // Named before the first observe: `readerPush` reads the request inside it.
    readerTask = `${suite}/${variant}/${seed}/${task.template}/${id}`;
    if (stub instanceof OracleReaderMaker) {
      stub.task = readerTask;
      stub.planted = new Map([[id, variant === "hidden" ? "hidden" : "decoy"]]);
    }
    if (distill) {
      distill.task = readerTask;
      distill.planted = { id, role: variant === "hidden" ? "hidden" : "decoy" };
    }
    // The request's own reader calls start here (after the draft's, below).
    let stubBefore = stub?.sizes.length ?? 0;
    const traced = timeline?.task(lane, sessionId, `${lane}/${task.template}`);
    const at = clock;
    await partner.observe({ ...scope, sessionId, at, kind: "session_start" } as AgentEvent);
    let draftPool: string[] | undefined;
    if (LEAD) {
      const text = draftOf(task.text, LEAD);
      await partner.observe({ ...scope, sessionId, at, kind: "user_message", text, draft: true } as AgentEvent);
      if (TIME > 0) await Bun.sleep(TYPING_MS * TIME);
      else for (let k = 0; k < 5_000 && busy(sessionId); k++) await Bun.sleep(1);
      // With a no-model reader, the pool a speculative read of the draft would get (lat-draft-speculative-read, stage
      // 1): the draft asked as `readerPush` asks, in a session of its own so the request's session is untouched. Its
      // lookup is a real one (its calls are in `leadCalls`, and it caches what it finds for the request).
      if (NO_MODEL_READER) {
        const draftSession = `${sessionId}~draft`;
        await partner.ask({ ...scope, sessionId: draftSession, question: text, maxItems: 5 });
        draftPool = [...new Set((readerReports.get(draftSession) ?? []).flatMap((x) => x.pool))];
        readerReports.delete(draftSession);
        askDumps.delete(draftSession);
        stubBefore = stub?.sizes.length ?? 0;
        await partner.observe({ ...scope, sessionId: draftSession, at, kind: "session_end" } as AgentEvent);
      }
    }
    if (OVERLAP && tasks.length > 1) {
      // Another request just before this one, not waited for: its lookup is in flight when this one arrives.
      const other = tasks[(i + 1) % tasks.length]!.text;
      await partner.observe({ ...scope, sessionId, at, kind: "user_message", text: other } as AgentEvent);
    }
    const leadCalls = received() - receivedBefore;
    const t0 = performance.now();
    const r = await partner.observe(
      { ...scope, sessionId, at, kind: "user_message", text: task.text } as AgentEvent,
      // A live judge answers in seconds: the slow path is waited for, so what it lets through counts here.
      { waitMs: WAIT_MS },
    );
    const ms = performance.now() - t0;
    // What arrives after the reply (a lookup still running behind a delivery made from what was held), with when.
    const arrived: { ids: string[]; at: number }[] = [];
    const pendingSeen: Injection[] = [];
    // What an agent collecting right after the observe (before its first model call) holds: the reply's packet and
    // the pending queue at that moment (the first drain below).
    const beforeModel = new Set<string>();
    if (r.injection) arrived.push({ ids: r.injection.citations.map((c) => c.itemId), at: ms });
    for (const c of r.injection?.citations ?? []) beforeModel.add(c.itemId);
    const deadline = performance.now() + Math.max(WAIT_MS, WAIT_DEFAULT);
    for (let firstDrain = true; ; firstDrain = false) {
      for (const x of partner.takePending({ ...scope, sessionId })) {
        pendingSeen.push(x);
        arrived.push({ ids: x.citations.map((c) => c.itemId), at: performance.now() - t0 });
        if (firstDrain) for (const c of x.citations) beforeModel.add(c.itemId);
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
    // `--connect-at`: nothing is waited for; the cards land when their calls return.
    if (cards && !CONNECT) await cards.idle();
    const injections = [...(r.injection ? [r.injection] : [])];
    const got = arrived.flatMap((x) => x.ids);
    const question = ASK_Q === "narrow" ? narrowQuestion(task.text) : task.text;
    readerMs = undefined;
    const a0 = performance.now();
    // The ask's arrival, as its cue reads it (`cue.arrived`): the engine's intent search counts requests before it.
    const askAt = clock;
    const answered = ASK ? await partner.ask({ ...scope, sessionId, question }) : null;
    const askMs = performance.now() - a0;
    const askCited = answered ? answered.citations.some((c) => c.itemId === id) : undefined;
    // `askBehind` (D430): what an ask that answered before its sources were read queues after it, taken once nothing
    // is left running (bounded as the request's own wait). Nothing is queued when the trial is off.
    let askLate: number | undefined;
    if (ASK) {
      const until = performance.now() + Math.max(WAIT_MS, WAIT_DEFAULT);
      while (busy(sessionId) && performance.now() < until) await Bun.sleep(1);
      for (const x of partner.takePending({ ...scope, sessionId })) {
        if (!x.reason.startsWith("ask-behind:")) continue;
        if (askLate === undefined && x.citations.some((c) => c.itemId === id)) askLate = performance.now() - a0;
      }
    }
    const reports = readerReports.get(sessionId) ?? [];
    readerReports.delete(sessionId);
    const rr = reports.at(-1);
    // The reader's pool over the request's reads (the push's and the ask's), and the first read's: what a read of the
    // sent request is given, compared with the draft's.
    const pool = new Set(reports.flatMap((x) => x.pool));
    const finalPool = reports[0]?.pool ?? [];
    const stubCalls = stub ? stub.sizes.slice(stubBefore) : [];
    let packet: Record<string, unknown> = {};
    if (PACKET_K.length && answered) {
      const d = askDumps.get(sessionId);
      const ids = d?.candidates.map((c) => c.id) ?? [];
      const cap = Number(CONFIG.askItemBytes ?? 320);
      const bytesOf = (itemId: string) => {
        const it = cache.get(scope, itemId, clock);
        return it ? Math.min(Buffer.byteLength(`${it.title} ${it.text}`), cap) : 0;
      };
      packet = {
        askRank: ids.indexOf(id),
        packetKBytes: Object.fromEntries(PACKET_K.map((k) => [k, ids.slice(0, k).reduce((n, x) => n + bytesOf(x), 0)])),
      };
      if (!ASK_DIAG) askDumps.delete(sessionId);
    }
    if (ASK_DIAG && answered) {
      const d = askDumps.get(sessionId);
      askDumps.delete(sessionId);
      const cachedItem = cache.get(scope, id, clock);
      const rank = d ? d.candidates.findIndex((c) => c.id === id) : -1;
      const coverage = coverageOf(cachedItem, question, askAt);
      askDiagRows.push({ variant, rank, cached: !!cachedItem, coverage });
      const line = {
        suite,
        seed,
        variant,
        template: task.template,
        request: task.text,
        question,
        planted: id,
        cached: !!cachedItem,
        delivered: got.includes(id),
        askCited,
        rank,
        coverage,
        cited: answered.citations.map((c) => c.itemId),
        answer: answered.answer,
        detail: task.detail,
        candidates: d?.candidates ?? [],
        pool: d?.pool ?? [],
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
        plantedText: planted[i] ? `${planted[i]!.title} ${planted[i]!.text}` : "",
        ...(answered ? { answer: answered.answer, answerIds: answered.citations.map((c) => c.itemId) } : {}),
      };
      appendFileSync(PACKETS, JSON.stringify({ ...line, ...extra }) + "\n");
    }
    const push = pushPools.get(sessionId)?.at(-1);
    // `pushCheck`: whether any pass of this task made the check's call (N5's call rate by variant).
    const checkCalled = (pushPools.get(sessionId) ?? []).some((r) => r.checkCalled);
    pushPools.delete(sessionId);
    if (POOL_DUMP) {
      const ids = push?.pool ?? [];
      const items = ids.map((x, k) => {
        const it = cache.get(scope, x, askAt);
        const card = cards?.cardsOf(scope, [x], askAt).get(x);
        return {
          id: x,
          handed: push!.handed.includes(x),
          auto: it ? automated(it) : false,
          cl: push!.constraintLike[k] === true,
          ...(push!.anchored ? { anchored: push!.anchored[k] === true } : {}),
          title: it?.title ?? "",
          text: it?.text ?? "",
          ...(card ? { card: card.kind, statement: card.statement } : {}),
        };
      });
      const line = { suite, seed, variant, template: task.template, request: task.text, detail: task.detail };
      const extra = {
        planted: id,
        at: ids.indexOf(id),
        ...(push?.unsettled !== undefined ? { unsettled: push.unsettled } : {}),
        ...(push?.anchorKinds ? { anchorKinds: push.anchorKinds } : {}),
        pool: items,
      };
      appendFileSync(POOL_DUMP, `${JSON.stringify({ ...line, ...extra })}\n`);
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
    // The task's window closes here: the reply, everything it left running (the slow path, the push, probes past
    // their grace: `busy`) and the ask have finished.
    const taskListed = listed() - listedBefore;
    const taskCalls = received() - receivedBefore;
    if (splitBefore) {
      const at = splitNow();
      callSplit.tasks++;
      callSplit.distinct += searchedNow.size;
      searchedNow.clear();
      for (const k of ["worldSearch", "worldList", "noiseSearch", "noiseList"] as const) {
        callSplit[k] += at[k] - splitBefore[k];
      }
    }
    syncUse.demandSeen += taskListed;
    callCheck.received += taskCalls;
    callCheck.listed += taskListed;
    callCheck.traced += calls - callsBefore;
    const cachedNow = cache.get(scope, id, clock);
    const replayLine = cachedNow ? inReplay(cachedNow) : null;
    const flagged = rr ? rr.flagged.some((f) => f.id === id) : undefined;
    // D173's split, reporting only: reader-flagged, rule path (delivered unflagged) or listed only (ask-cited only).
    const by = surfacedBy({ variant, delivered: got.includes(id), askCited, readerFlagged: flagged });
    perTask.push({
      seed,
      variant,
      template: task.template,
      returned: returned.has(id),
      cached: !!cachedNow,
      delivered: got.includes(id),
      ...(by ? { surfacedBy: by } : {}),
      ...(replayLine !== null ? { inReplay: replayLine } : {}),
      ...(askCited === undefined
        ? {}
        : {
            askCited,
            askBytes: Buffer.byteLength(answered!.answer),
            ...(askCited ? { askKept: kept(task.detail, planted[i]!, answered!.answer) } : {}),
            askItems: answered!.citations.length,
            askMs: Number(askMs.toFixed(2)),
            ...(askLate !== undefined ? { askLateMs: Number(askLate.toFixed(2)) } : {}),
          }),
      // `pushCandidates`' last pass: the planted item's place in its pool (-1: not in it), and whether it was handed.
      ...(push ? { pushPoolAt: push.pool.indexOf(id), pushHanded: push.handed.includes(id) } : {}),
      // How many candidates that pass handed (0: no candidates packet; I1's compare.py counts neutral tasks given one).
      ...(push ? { pushHandedN: push.handed.length } : {}),
      // `+stale` synth suites (D908 rule 1): the stale version's place in that pool, and whether it was handed.
      ...(push && task.stale
        ? { stalePoolAt: push.pool.indexOf(task.stale), staleHanded: push.handed.includes(task.stale) }
        : {}),
      ...(checkCalled ? { pushCheckCalled: true } : {}),
      // `askNudge` (D316): whether that pass's candidates left the request unsettled (the packet nudged an ask).
      ...(push?.unsettled !== undefined ? { pushUnsettled: push.unsettled } : {}),
      ...(rr
        ? {
            readerOutcome: rr.outcome,
            readerChecked: rr.checked,
            readerInPool: rr.pool.includes(id),
            readerAt: rr.pool.indexOf(id),
            readerFlags: rr.flagged.length,
            readerFlagged: rr.flagged.some((f) => f.id === id),
            ...(rr.flagged.some((f) => f.id === id) ? { readerKind: rr.flagged.find((f) => f.id === id)!.kind } : {}),
            readerWaitMs: rr.waitedMs,
            ...(readerMs !== undefined ? { readerModelMs: readerMs } : {}),
          }
        : READER !== "none" && answered
          ? { readerOutcome: "skipped" }
          : {}),
      ...(reader
        ? {
            poolHas: pool.has(id),
            poolItems: pool.size,
            ...(stub
              ? {
                  stubCalls: stubCalls.length,
                  promptChars: stubCalls.reduce((n, c) => n + c.promptChars, 0),
                  prefixChars: stubCalls.reduce((n, c) => n + c.prefixChars, 0),
                }
              : {}),
          }
        : {}),
      ...(draftPool
        ? {
            draftPool,
            finalPool,
            draftHas: draftPool.includes(id),
            ...(draftPool.length && finalPool.length
              ? {
                  draftJaccard: Number(jaccard(draftPool, finalPool).toFixed(4)),
                  draftSubset: finalPool.every((x) => draftPool.includes(x)),
                }
              : {}),
          }
        : {}),
      ...packet,
      why,
      injected: got.length,
      packetBytes: [...injections, ...pendingSeen].reduce((n, x) => n + Buffer.byteLength(x.text), 0),
      packets: injections.length + pendingSeen.length,
      calls: taskCalls,
      traced: calls - callsBefore,
      listed: taskListed,
      served: served - servedBefore,
      ...(laneModel
        ? { readerCalls: laneReaderCalls - readerCalls0, readerUsd: Number((laneReaderUsd - readerUsd0).toFixed(7)) }
        : {}),
      ms: Number(ms.toFixed(2)),
      ...(got.includes(id) ? { beforeModel: beforeModel.has(id) } : {}),
      ...(first
        ? { deliveryMs: Number(first.at.toFixed(2)), immediate: r.injection?.citations.some((c) => c.itemId === id) }
        : {}),
      ...(LEAD ? { leadCalls } : {}),
      ...(CONNECT
        ? {
            connectS: checkpoints[i]!,
            sinceConnectMs: Math.round(sinceConnectMs),
            replica,
            warmAtRequest,
            syncedAtRequest,
          }
        : {}),
    });
  }
  for (const t of timers) clearInterval(t);
  // The polls a lookup left running behind it finish before the count is read.
  if (sync) {
    for (let k = 0; k < 5_000 && [...table.values()].some((x) => x.inflight || x.behind); k++) await Bun.sleep(1);
    await Bun.sleep(TIME > 0 ? 2_000 * TIME : 5);
    syncUse.demandAll += sync.stats.demandCalls;
    syncUse.demandItems += sync.stats.demandItems;
    syncUse.backgroundItems += sync.stats.backgroundItems;
    // `--connect-at`: everything the user's sync listed in the background is their backfill (ticks and kicks).
    if (CONNECT) syncUse.backfill += sync.stats.backgroundCalls;
  }
  return perTask;
}

/** |a ∩ b| / |a ∪ b| over two id lists. */
function jaccard(a: string[], b: string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  const both = [...x].filter((v) => y.has(v)).length;
  return both / Math.max(1, x.size + y.size - both);
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
  ` ${(r.hidden.ms / Math.max(1, r.hidden.n)).toFixed(1).padStart(8)}` +
  TAG;
const add = (into: { hidden: Row; control: Row }, r: { hidden: Row; control: Row }) => {
  for (const v of ["hidden", "control"] as const) {
    for (const k of Object.keys(into[v]) as (keyof Row)[]) into[v][k] += r[v][k];
  }
};

console.log(`suite ${SUITE_LIST.join(",")}, seeds ${SEEDS.join(",")}, config ${JSON.stringify(CONFIG)}`);
if (READER === "stub" && DISTILL?.mode !== "labels") console.log(STUB_BANNER);
if (ORACLE) {
  console.log(
    `--reader oracle: a proxy, not a reader: it flags the planted hidden item (p_hit ${ORACLE.pHit}) and the decoy ` +
      `(p_false ${ORACLE.pFalse}); its deltas speak for pool-composition changes only, until a paid screen confirms`,
  );
}
const header = "template                 hidden: returned delivered   control: decoy delivered   calls/task  ms/task";
const grand = { hidden: row(), control: row() };
const runs: { suite: string; rows: Rows; perTask: Record<string, unknown>[]; wall: number; total: typeof grand }[] = [];
const neutralOut: NeutralOut = { total: neutralRow(), suites: {}, perTask: [] };
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
  console.log(line(SUITE_LIST.length > 1 ? `total ${suite}` : "TOTAL", total) + inertTag());
  for (const l of screenLines(suite, perTask as unknown as ScreenRow[], PACKET_K)) console.log(l + TAG + inertTag());
  // D173: surfaced split into reader-flagged, rule path and listed only (reporting only; the gates are unchanged).
  for (const l of surfacedLines(suite, perTask as unknown as SurfacedRow[])) console.log(l + TAG + inertTag());
  add(grand, total);
  runs.push({ suite, rows, perTask, wall, total });
}
// Several suites: the TOTAL over all of them, as the last table line (bench.ts reads the line before `recorded`).
if (SUITE_LIST.length > 1) {
  console.log(`\n${header}`);
  for (const r of runs) console.log(line(r.suite, r.total));
  console.log(line("TOTAL", grand) + inertTag());
  const all = runs.flatMap((r) => r.perTask) as unknown as ScreenRow[];
  for (const l of screenLines("TOTAL", all, PACKET_K)) console.log(l + TAG + inertTag());
  for (const l of surfacedLines("TOTAL", all as unknown as SurfacedRow[])) console.log(l + TAG + inertTag());
}
/**
 * `--neutral`: its own phase, after every suite's hidden and control tasks (and so never beside them at `--time` > 0).
 * The run-wide counters (connector calls, sync, intent, cards, reader and judge use, the miss gate) are snapshotted
 * before it and restored after, so every hidden/control figure and gate is the run's without it; the phase's own
 * deltas go to the `neutral` block.
 */
if (NEUTRAL) {
  const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  const counters = () => ({
    sync: copy(syncUse),
    calls: copy(callCheck),
    intent: copy(intentUse),
    judge: copy(usage),
    busy: copy(busyTraces),
    reader: readerModel
      ? {
          replayed: readerModel.replayed,
          sent: readerModel.sent,
          missed: readerModel.missed,
          failed: readerModel.failed,
          subsetReplayed: readerModel.subsetReplayed,
        }
      : null,
  });
  const before = counters();
  const lanes = { cards: cardLanes.length, reader: readerLanes.length, distill: distillLanes.length };
  const askRows = askDiagRows.length;
  const cpuBefore = taskCpuUs;
  for (const suite of SUITE_LIST.filter(supportsNeutral)) {
    const n = neutralRow();
    for (const t of (await runSeeds(suite, "neutral")).flat()) {
      addNeutralTask(n, t);
      const { variant: _v, ...rest } = t;
      neutralOut.perTask.push({ suite, ...rest });
    }
    neutralOut.suites[suite] = n;
    addNeutralRows(neutralOut.total, n);
    console.log(neutralLine(suite, n) + TAG + inertTag());
  }
  const after = counters();
  const delta = (a: Record<string, number>, b: Record<string, number>) =>
    Object.fromEntries(Object.keys(a).map((k) => [k, Number(((a[k] ?? 0) - (b[k] ?? 0)).toFixed(3))]));
  const sum = (xs: { stats: object }[]) => {
    const out: Record<string, number> = {};
    for (const x of xs)
      for (const [k, v] of Object.entries(x.stats)) if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
    return out;
  };
  neutralOut.use = {
    calls: delta(after.calls, before.calls),
    intent: delta(after.intent, before.intent),
    ...(REAL_SYNC ? { sync: delta(after.sync, before.sync) } : {}),
    ...(after.reader && before.reader ? { reader: delta(after.reader, before.reader) } : {}),
    ...(cardLanes.length > lanes.cards ? { cards: sum(cardLanes.slice(lanes.cards)) } : {}),
    ...(LIVE ? { judge: delta(after.judge, before.judge) } : {}),
  };
  // Restore: the neutral phase leaves no trace in the hidden/control figures, the ledger record or the miss gate.
  Object.assign(syncUse, before.sync);
  Object.assign(callCheck, before.calls);
  Object.assign(intentUse, before.intent);
  Object.assign(usage, before.judge);
  Object.assign(busyTraces, before.busy);
  if (readerModel && before.reader) Object.assign(readerModel, before.reader);
  cardLanes.length = lanes.cards;
  readerLanes.length = lanes.reader;
  distillLanes.length = lanes.distill;
  askDiagRows.length = askRows;
  taskCpuUs = cpuBefore;
  if (neutralOut.use.reader?.missed) {
    console.log(`NEUTRAL reader misses: ${neutralOut.use.reader.missed} (not in the miss gate; neutral rows only)`);
  }
  const skipped = SUITE_LIST.filter((s) => !supportsNeutral(s));
  if (skipped.length) console.log(`--neutral: ${skipped.join(", ")} build no neutral variant (neutral.ts)`);
  if (Object.keys(neutralOut.suites).length > 1) console.log(neutralLine("TOTAL", neutralOut.total) + TAG + inertTag());
}
// What an agent that collects before its first model call would hold (`beforeModel`), against the wait it gave.
{
  const all = runs.flatMap((r) => r.perTask) as unknown as ScreenRow[];
  console.log(beforeModelLine(all, WAIT_MS));
}
if (OVERLAP) {
  console.log(
    `overlap: slow path busy ${busyTraces.busy} times; the task shape ` +
      "differs, so these scores are not comparable with a run without --overlap",
  );
}
if (RUN.intent && RUN.cards) {
  console.log(
    `intent: ${intentNow()} (replayed requests for ${intentUse.found} of ${intentUse.asked} items asked)` + inertTag(),
  );
  // Planted items are a few percent of the items asked but can be most of the replay's holes (D173).
  const planted = plantedCoverageLine(runs.flatMap((r) => r.perTask) as unknown as SurfacedRow[]);
  if (planted) console.log(`intent: ${planted}`);
}
// `--ask-diag`: why the ask left planted items out of its candidates (rank -1), by intent coverage (ask-coverage.ts).
if (ASK_DIAG) {
  for (const l of coverageLines(askDiagRows)) console.log(l + inertTag());
  if (diagDropped) console.log(`ask-diag: its intent searches dropped ${diagDropped} expired cards (a side effect)`);
}
// calls/task above are what the connectors received; the traces' sum is printed to catch accounting drift in the
// engine. It also counts fetches (which `SimSource` counts apart), and a call still running when a task's window
// closes lands in the next task's.
console.log(
  `calls: connectors received ${callCheck.received} in the tasks' windows (${callCheck.listed} of them on-demand ` +
    `listings); traces summed ${callCheck.traced} (cross-check, fetches included)`,
);
if (CALL_SPLIT) {
  const per = (n: number) => (n / Math.max(1, callSplit.tasks)).toFixed(2);
  console.log(
    `call split (a task): world searches ${per(callSplit.worldSearch)}, world listings ${per(callSplit.worldList)}, ` +
      `noise searches ${per(callSplit.noiseSearch)}, noise listings ${per(callSplit.noiseList)}; distinct sources ` +
      `searched ${per(callSplit.distinct)}; searches repeating a (source, text) this user sent before ` +
      `${per(callSplit.repeats)}; by trace: ` +
      [...callsByTrace].map(([k, n]) => `${k} ${per(n)}`).join(", "),
  );
}
// The traces should carry every call the connectors received (audit 2026-11-03b, corr-poll-behind-calls-untraced):
// a gap means per-trace `sourceCalls`, and every cost or rate-limit view built from traces, is off.
if (callCheck.traced !== callCheck.received) {
  console.log(
    `CALLS UNTRACED: traces summed ${callCheck.traced} of the ${callCheck.received} calls the connectors received ` +
      "(per-trace sourceCalls are off; the connectors' count is the one calls/task uses" +
      (CONFIG.syncPollBehind === true ? "; syncPollBehind's polls reach no trace)" : ")"),
  );
}
if (REAL_SYNC) {
  const tasks = Math.max(1, grand.hidden.n + grand.control.n);
  const requestCalls = grand.hidden.calls + grand.control.calls;
  // The on-demand listings counted in the tasks' windows are in `requestCalls`; the sync's count covers them all.
  const amortised = requestCalls - syncUse.demandSeen + syncUse.demandAll + syncUse.background + syncUse.backfill;
  console.log(
    `sync: backfill ${syncUse.backfill} calls (${(syncUse.backfill / Math.max(1, syncUse.users)).toFixed(1)}/user, ` +
      `${(syncUse.warmMs / Math.max(1, syncUse.users)).toFixed(0)} ms/user), background ${syncUse.background} ` +
      `(${(syncUse.background / tasks).toFixed(2)}/task), on-demand ${syncUse.demand} ` +
      `(${(syncUse.demand / tasks).toFixed(2)}/task in lookups' traces; ${syncUse.demandSeen} at the connectors in the ` +
      `tasks' windows, in calls/task; ${syncUse.demandAll} by the sync's count); request ` +
      `${(requestCalls / tasks).toFixed(2)}/task; amortised total ` +
      `${(amortised / tasks).toFixed(2)}/task; ` +
      `local sources ${(syncUse.localSources / Math.max(1, syncUse.lookups)).toFixed(2)}/lookup; ` +
      `demand items ${syncUse.demandItems}, background items ${syncUse.backgroundItems}`,
  );
}
if (cardMaker) {
  for (const c of cardLanes) for (const [k, v] of Object.entries(c.stats)) cardUse[k] = (cardUse[k] ?? 0) + v;
  cardUse.users = cardLanes.length;
  console.log(
    CARDS_ENDPOINT
      ? `cards: ${cardMaker.hits} replayed, ${cardMaker.misses} made by the endpoint (${ENDPOINT_LABEL})`
      : `cards: ${cardMaker.hits} replayed, ${cardMaker.misses} uncovered (no cached card)`,
  );
  console.log(`cards use: ${JSON.stringify(cardUse)}`);
}
if (readerModel) {
  const use: Record<string, number> = {};
  for (const r of readerLanes) for (const [k, v] of Object.entries(r.stats)) use[k] = (use[k] ?? 0) + v;
  const m = readerModel;
  const n = Math.max(1, m.calls.length);
  const sum = (f: (c: (typeof m.calls)[number]) => number) => m.calls.reduce((a, c) => a + f(c), 0);
  const { p50, p90 } = m.quantiles();
  const made = sum((c) => c.costUsd);
  const approxNote = READER_SUBSET ? `; ${m.subsetReplayed} more approximated, not in these figures` : "";
  console.log(
    `reader ${READER_MODEL}: ${m.calls.length} calls answered (${m.sent} sent now, ${m.replayed} replayed, ` +
      `${m.missed} not cached, ${m.failed} failed${approxNote}), ${(sum((c) => c.inputTokens) / n).toFixed(0)} in / ` +
      `${(sum((c) => c.outputTokens) / n).toFixed(0)} out tokens per call, ${sum((c) => (c.truncated ? 1 : 0))} cut off; ` +
      `$${made.toFixed(5)} as made ($${(made / n).toFixed(6)} per call), $${sum((c) => (c.live ? c.costUsd : 0)).toFixed(5)} ` +
      `spent this run; latency as made p50 ${p50} ms, p90 ${p90} ms, ` +
      `${m.latencies.filter((x) => x > 2_500).length} over 2.5 s`,
  );
  console.log(`reader use: ${JSON.stringify(use)}`);
  const r = ACCESS.pacer.summary();
  console.log(`reader requests: ${r.sent} sent, ${r.retried} retried, ${r.refused} refused at the cap`);
}
if (readerModel || cardMaker) {
  console.log(overBudgetLine({ reader: readerLanes, cards: cardLanes }));
}
if (distillLanes.length) {
  const sum = (f: (d: DistilledReaderMaker) => number) => distillLanes.reduce((a, d) => a + f(d), 0);
  console.log(
    `distill ${DISTILL!.mode}: local silent ${sum((d) => d.stats.silent)}, local bind ${sum((d) => d.stats.bind)}, ` +
      `escalated ${sum((d) => d.stats.escalated)}, label misses ${sum((d) => d.missed)}`,
  );
  // A label not found is a read with no answer (the engine fails open, as ALL3): the replay is then partial.
  if (sum((d) => d.missed) > 0) console.log(`LABEL MISSES: ${sum((d) => d.missed)} reads had no label (failed open)`);
}
// A label miss under `--distill labels` is a partial replay like a reader-cache miss, so it fails the run the same way.
const distillMissed = distillLanes.reduce((a, d) => a + d.missed, 0);
const misses = missGate((readerModel?.missed ?? 0) + distillMissed, ALLOW_MISSES);
if (misses.message) console.log(`\n${misses.message}\n`);
const missHint = readerModel
  ? allMissedHint(
      { ...readerModel, subset: readerModel.subsetReplayed },
      cli.has("reader-model"),
      cacheModels(READER_CACHE),
    )
  : null;
if (missHint) console.log(`${missHint}\n`);
if (readerModel && readerModel.stopSimulated > 0) {
  console.log(
    `READER STOP-SIMULATED: ${readerModel.stopSimulated} reader replies were recorded without the stop sequence and ` +
      "cut where it would have ended them: tokens, cost and latency scaled by characters kept (approximate)",
  );
}
if (READER_SUBSET && readerModel) {
  console.log(
    `READER SUBSET-REPLAYED: ${readerModel.subsetReplayed} reader prompts were answered from a recorded superset pool ` +
      "(--reader-subset): approximate, a verdict on fewer items read off a reading of more",
  );
}
/** `--check` (I3, D500): the push check's calls over the whole run, every phase (neutral included). */
const checkUse = checkModel
  ? (() => {
      const sum = (k: keyof PushChecker["stats"]) => checkLanes.reduce((n, c) => n + c.stats[k], 0);
      const lat = checkModel.quantiles();
      return {
        asked: sum("asked"),
        calls: sum("calls"),
        failures: sum("failures"),
        costUsdAsMade: Number(checkModel.calls.reduce((n, c) => n + c.costUsd, 0).toFixed(6)),
        inputTokens: checkModel.calls.reduce((n, c) => n + c.inputTokens, 0),
        cachedInputTokens: checkModel.calls.reduce((n, c) => n + c.cachedInputTokens, 0),
        outputTokens: checkModel.calls.reduce((n, c) => n + c.outputTokens, 0),
        replayed: checkModel.replayed,
        sent: checkModel.sent,
        missed: checkModel.missed,
        p50Ms: lat.p50,
        p90Ms: lat.p90,
      };
    })()
  : null;
if (checkUse) {
  const per = (x: number) => (checkUse.calls ? x / checkUse.calls : 0);
  console.log(
    `CHECK (I3, ${CHECK_MODEL}, ${CHECK}): ${checkUse.calls} calls of ${checkUse.asked} asked, ` +
      `${checkUse.failures} failed, ${checkUse.missed} replay misses; $${checkUse.costUsdAsMade.toFixed(4)} as made ` +
      `($${per(checkUse.costUsdAsMade).toFixed(6)} a call); ${per(checkUse.inputTokens).toFixed(0)} in ` +
      `(${per(checkUse.cachedInputTokens).toFixed(0)} cached) / ${per(checkUse.outputTokens).toFixed(0)} out a call; ` +
      `as made p50 ${checkUse.p50Ms.toFixed(0)} ms, p90 ${checkUse.p90Ms.toFixed(0)} ms`,
  );
}
if (LIVE) {
  const tasks = Math.max(1, grand.hidden.n + grand.control.n);
  console.log(
    `judge ${MODEL}: ${usage.calls} calls (${(usage.calls / tasks).toFixed(2)}/task), ` +
      `${(usage.inputTokens / Math.max(1, usage.calls)).toFixed(0)} in / ` +
      `${(usage.outputTokens / Math.max(1, usage.calls)).toFixed(0)} out tokens per call, ` +
      `$${usage.costUsd.toFixed(4)} ($${((1000 * usage.costUsd) / tasks).toFixed(4)} per 1k tasks)`,
  );
  const r = ACCESS.pacer.summary();
  console.log(`judge requests: ${r.sent} sent, ${r.retried} retried, ${r.refused} refused at the cap`);
  if (r.refused) console.log("PARTIAL: the request cap refused judge calls; those tasks ran with no judge");
}
// A run the cap cut short, or one with reader misses not accepted, is not this configuration's result: it stays out
// of the ledger.
if (!cli.has("no-record") && ACCESS.pacer.refused === 0 && misses.code === 0) {
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
if (TIMELINE || NOOP_SPANS || SERIAL || cli.has("cpu")) {
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
        // The run's label, stamped when intent was on but inert, so a number copied out of the file keeps the caveat.
        label: (opt("label", "") + inertTag() + (CARDS_ENDPOINT ? `  [cards: ${ENDPOINT_LABEL}]` : "")).trim(),
        ...(CARDS_ENDPOINT ? { cardsTransport: ENDPOINT_LABEL } : {}),
        intent: { state: intentNow(), ...intentUse },
        rows,
        total: grand,
        ...(REAL_SYNC ? { sync: syncUse } : {}),
        // The connectors' and the traces' call counts, for funnel.ts's merged check.
        calls: callCheck,
        ...(cardMaker ? { cards: cardUse } : {}),
        // The replay's misses (answered without the reader) and failures, for funnel.ts's gate.
        ...(readerModel
          ? {
              reader: {
                replayed: readerModel.replayed,
                sent: readerModel.sent,
                missed: readerModel.missed,
                failed: readerModel.failed,
                ...(READER_SUBSET ? { subset: readerModel.subsetReplayed } : {}),
                ...(readerModel.stopSimulated > 0 ? { stopSimulated: readerModel.stopSimulated } : {}),
              },
            }
          : {}),
        ...(checkUse ? { check: checkUse } : {}),
        ...(SUITE_LIST.length > 1 ? { suites } : {}),
        // Per task, with the suite: how each planted item was delivered (`why`), for breakdowns by path.
        perTask: runs.flatMap((r) => r.perTask.map((t) => ({ suite: r.suite, ...t }))),
        // `--neutral`: the neutral variant's rows, apart from the planted tasks' (neutral.ts).
        ...(NEUTRAL ? { neutral: neutralOut } : {}),
      },
      null,
      2,
    ),
  );
}
if (misses.code) process.exit(misses.code);
