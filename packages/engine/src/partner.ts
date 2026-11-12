/**
 * The context partner. It runs beside an agent and does two things:
 *
 * - observe: sees each session event and, when the agent likely needs context it does not have, delivers it
 *   unasked (proactive injection). Most events end in silence.
 * - ask: answers the agent's explicit question from the user's sources.
 *
 * Two speeds. The fast path (cue → item cache → score) runs on every event, makes no network call and no model
 * call, and delivers only when it is confident. The slow path (route → live source search → maybe one model call)
 * runs in the background; what it finds is queued and delivered at the next event, or returned directly if the
 * caller is willing to wait (`waitMs`). The model is the last resort, rationed by `Budget`, and its default verdict
 * is silence.
 *
 * Lifecycle. Each session owns an AbortController. Ending, evicting or forgetting a session aborts its in-flight
 * work, and every step after an await checks the session is still live, so nothing is cached, learned, charged or
 * queued for a session (or a user) that is gone.
 */
import { createHash } from "node:crypto";
import type { SourceMap, UserRows } from "@eden/graph";
import type { Budget, Model, Reservation } from "@eden/llm";
import {
  type Citation,
  itemId,
  MAX_QUESTION_CHARS,
  newId,
  scopeKey,
  type ActionCheck,
  type AgentEvent,
  type AskRequest,
  type AskResponse,
  type ContextItem,
  type Feedback,
  type Injection,
  type InjectionMode,
  type ObserveResult,
  type Scope,
  type SourceChangedResult,
} from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import { hashString, Vocab, type WorkerPool } from "@eden/primitives";
import {
  PlanError,
  PlannedSource,
  SourceFanout,
  type CountedPlanCalls,
  type FanoutOutcome,
  reachedSource,
  sharedKey,
  type SharedCalls,
  type QueryPlanner,
  type SearchQuery,
  type Source,
  type SourceResolver,
} from "@eden/sources";
import { nearDuplicate, sanitizedId, sanitizeItem, type CacheHit, type ItemCache, type Sketch } from "./cache";
import { SyncManager } from "./sync";
import { pooledSanitizer } from "./gate";
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import {
  arrangedVisit,
  assess,
  mayConstrain,
  frameOf,
  namesRef,
  unmeasuredLimit,
  type Frame,
  type Verdict,
} from "./conflict";
import { cardKey, cardVerdict, requestActions, STANDING_KINDS, type Card, type CardEnricher } from "./cards";
import { intentCut, intentReach, intentTerms, keepIntents, stemWord } from "./intent";
import {
  READER_MAX_ITEMS,
  readerFocus,
  readerItem,
  readerNote,
  type AskReader,
  type ReaderInput,
  type ReaderRead,
  type ReaderKind,
  type ReaderVerdict,
} from "./reader";
import { CHECK_MAX_ITEMS, checkKey, itemMark, type PushCheckRead, type PushChecker } from "./push-check";
import { actionClass, classTies, matchesClass, type ActionClass } from "./consequence";
import { SourceYield, type Evidence } from "./source-yield";
import { ProbeEconomy, type ProbeKind } from "./economy";
import { judgeMessages, parseJudge } from "./judge";
import {
  namesParticipant,
  participantWords,
  startDay,
  startMs,
  timeWindow,
  titleNames,
  type TimeWindow,
} from "./grounding";
import {
  absenceSpan,
  cleanEntities,
  daysNamed,
  isAction,
  isImperative,
  pushStart,
  MORE_VERBS,
  LEADING,
  isScheduling,
  isSubject,
  mentions,
  orgsOf,
  overlaps,
  requestedSpan,
  rolesOf,
  settled,
  startMinutes,
  topicOf,
} from "./probes";
import { type TurnGate, turnGate } from "./turn-gate";
import { foldEchoes } from "./fold";
import type { Facts } from "./decide";
import { Ledger, type LedgerEntry } from "./ledger";
import {
  ASK_LATE_LEAD,
  ASK_NUDGE,
  CANDIDATES_LEAD,
  citationsOf,
  PLAN_LEAD,
  renderAnswer,
  renderPacket,
  shownText,
} from "./render";
import {
  callParties,
  MAX_CHECKED,
  MAX_PACKET_PARTIES,
  namesParty,
  partiesIn,
  partyFindingText,
  partyKey,
  type Party,
} from "./parties";
import { safeLine } from "./line";
import { anchored, anchorsOf, hasDay, settledCut, settles, type Anchors } from "./settle";
import { classifySituation } from "./situation";
import {
  contentTermsOf,
  distinctTermIds,
  extractEntities,
  extractTypedEntities,
  head,
  isChatterTerms,
  isStopword,
  PERSISTABLE_KINDS,
  termIds,
} from "./text";
import { sketchTerms, termHashes } from "./sketch";
import { SpanStats, Tracer, type SpanSink, type SpanStat } from "./spans";
import type { ShadowRecord, ShadowSink, Trace, TraceSink, UsageRecord, UsageSink } from "./trace";
import { distinctiveTokens, showsUse, type Outstanding } from "./usage";

export interface PartnerDeps {
  sources: SourceResolver;
  sourceMap: SourceMap;
  cache: ItemCache;
  budget: Budget;
  /** Null runs the engine with no model at all: fast and source paths only. */
  model: Model | null;
  config?: Partial<EngineConfig>;
  /**
   * The turn gate for `pushGate` (D1014): omitted, the shipped weights (`turnGate()`, read once a process); null, no
   * gate, so `pushStart` decides alone (what a missing or unreadable weights file gives).
   */
  turnGate?: TurnGate | null;
  onTrace?: TraceSink;
  /** Whether the agent used each injection, once known (D293): content-free, for an integrator's digest. */
  onUsage?: UsageSink;
  now?: () => number;
  /**
   * A timer on `now`'s clock (`SyncDeps.after`), for `syncKick`'s waits. Absent: `setTimeout`, right when `now` is
   * the wall clock; pass one with any other `now`.
   */
  after?: (ms: number, fn: () => void) => () => void;
  /**
   * A worker pool (`WorkerPool` started on `GATE_MODULE`) that redacts lookup results off the event loop (D26). The
   * partner builds its source fan-out itself, so redaction before anything is held can never be swapped out.
   */
  gatePool?: Pick<WorkerPool, "runOrInline">;
  /**
   * Decides what each lookup sends to each connector, learned per (tenant, user, connector)
   * (docs/plans/query-planner.md). Absent: every connector gets the cue's terms and entities as before.
   */
  planner?: QueryPlanner;
  /** Receives the planner's shadow lookups when `planner.mode` is "shadow". */
  onShadow?: ShadowSink;
  /**
   * Receives each finished span (`spans.ts`): every phase of every event, with wall and CPU time, content-free. With
   * neither this nor `config.spans`, no span is made: each phase costs one null check.
   */
  onSpan?: SpanSink;
  /**
   * Implication cards (`cards.ts`, `config.cards`): made in the background from items entering the cache, matched at
   * request time with no model. Absent, or the flag off: no card is made or read.
   */
  cards?: CardEnricher;
  /**
   * The ask-time model reader (`reader.ts`, `config.askReader`): its own model, budget and per-user, per-session cache
   * of verdicts. Absent, or the flag off: no call is made.
   */
  reader?: AskReader;
  /**
   * A lab hook (`hidden-funnel.ts`): what the reader did for each ask, content-free (item ids, kinds, counts, timing).
   */
  onReader?: ReaderSink;
  /**
   * A debug hook for the lab (docs/research/econ-decide.md): each no-model decision's candidates with their facts
   * (`decide.ts`) and what was delivered. Ids and numbers only, no content. Absent: no facts are computed for it.
   */
  onCandidates?: CandidateSink;
  /**
   * A lab hook (`hidden-funnel.ts --pool-dump`, D269): each `pushCandidates` pass's pool and what it handed, ids and
   * flags only. Apart from `onReader`, whose consumers count reader readings.
   */
  onPushPool?: PushPoolSink;
  /**
   * The push check's model call (`push-check.ts`, `pushCheck`, D500, in the default since D828), with its own budget.
   * Absent (no model key), or the flag off: no call is made and the default's candidates go.
   */
  checker?: PushChecker;
}

/** One `pushCandidates` pass (`PartnerDeps.onPushPool`): no content, no model call. */
export interface PushPoolReport {
  sessionId: string;
  /** The push's pool in order (the ids the reader would have read). */
  pool: string[];
  /** Per pool item, `readerGate`'s constraint test (cards included). */
  constraintLike: boolean[];
  /** The candidates handed (none when no pooled item is constraint-like). */
  handed: string[];
  /** `askNudge` (D316): whether the handed candidates leave the request unsettled (the packet then nudges an ask). */
  unsettled?: boolean;
  /**
   * When the request's anchors were read (`askNudge` or `pushCandidatesSettled`), per pool item whether it holds one
   * of them (`anchored`), and what kinds the request names: flags only, for the lab's trigger screens (M5).
   */
  anchored?: boolean[];
  anchorKinds?: { entities: number; day: boolean };
  /**
   * `pushCheck` (D500): what the pass's check did ("yes": it answered; "none": no call, the gate found nothing
   * constraint-like; "late", "failed": the default's candidates went) and, when it answered, per pool item whether it
   * said the item changes the action (all false: the push sent no packet).
   */
  check?: "yes" | "none" | "late" | "failed";
  checked?: boolean[];
  /**
   * This pass made the check's model call and had its answer within the wait: not a pass that read a kept answer,
   * or whose call ran past `pushCheckWaitMs` (traced "check-late" when it lands).
   */
  checkCalled?: boolean;
}
export type PushPoolSink = (report: PushPoolReport) => void;

/** One no-model decision's candidates, for `PartnerDeps.onCandidates`. */
export interface CandidateDump {
  sessionId: string;
  turn: number;
  /** Where the decision was made: the fast path or the lookup. */
  path: "fast" | "lookup" | "served" | "ask";
  candidates: { id: string; facts: Facts }[];
  delivered: string[];
  /**
   * How the rule paths decided (`sure`, `grounded-<how>`, `fallback`, `corrected`, or empty for silence).
   */
  how: string;
  /** The ask's pool before its cut to the item limit: what the rule paths would cite, in their order (path "ask"). */
  pool?: string[];
}
export type CandidateSink = (dump: CandidateDump) => void;

/** What the reader did for one ask (`PartnerDeps.onReader`): ids, kinds and counts, no content. */
export interface ReaderReport {
  sessionId: string;
  /** Items it was given, the items it said bear (with their kind), and whether it answered in time. */
  checked: number;
  /** The ids it was given, in order. */
  pool: string[];
  flagged: { id: string; kind: ReaderKind }[];
  /**
   * "read" (a verdict, from a call or the cache), "late" (the wait ran out), "budget" (the reader's `Budget` refused
   * the call: a session or day cap), "none" (no pool, a failed or unreadable call), "gated" (`readerGate`).
   */
  outcome: "read" | "late" | "budget" | "none" | "gated";
  waitedMs: number;
}
export type ReaderSink = (report: ReaderReport) => void;

/** An outcome already written to the source map, kept so explicit feedback can correct it. */
interface Recorded {
  sourceIds: string[];
  situation: string;
  used: boolean;
  /** The session the injection was delivered in: a later correction's usage record names it (D293). */
  sessionId: string;
}

interface Session {
  scope: Scope;
  id: string;
  /** Tenant, user and session: the only key a session's state is ever looked up by. */
  key: string;
  turn: number;
  /** `sourceYield` (D505): the sources a live read was booked against in turn `turn` (once a source a turn). */
  liveReads?: { turn: number; ids: Set<string> };
  /**
   * The user messages (not drafts) observed so far. A `readerPush` reading is queued only while its request is still
   * the latest: the agent's own events move `turn` within one request, a new user message moves this.
   */
  requests: number;
  /** The session's last `EXPLAIN_TRACES` traces, oldest first (`explain`, D277). */
  traces: Trace[];
  lastActive: number;
  window: string[];
  /**
   * What recent events show the agent has: the terms and adjacent term pairs (session vocabulary) of tool results it
   * fetched and its own messages (bounded like the window), for `alreadyHas`. A user naming something is no sign the
   * agent has its content.
   */
  agentHas: Held[];
  /**
   * The session's own vocabulary: all of its term ids (seen, usage, cues) are in it. Rebuilt past
   * `maxSessionTerms`; the cache's per-user vocabulary holds item terms only.
   */
  vocab: Vocab;
  /** Term ids the session has seen (bounded, least recently seen first). */
  seen: Set<number>;
  ledger: Ledger;
  /** Sketches of items delivered in this session (bounded): a near-duplicate of one is not delivered again. */
  delivered: Sketch[];
  /** Injections handed to the agent and not yet judged used or unused. */
  outstanding: Map<string, Outstanding>;
  pending: Injection[];
  cues: Map<string, number>;
  situation: string;
  inflight: Promise<Injection | null> | null;
  abort: AbortController;
  closed: boolean;
  /** The planner's shadow lookup in flight, if any (shadow mode). */
  shadowing?: Promise<void>;
  /** Work lookups left running behind their answers: a poll and its follow-up (`afterPoll`), a judge (`judgeLater`). */
  behind?: Promise<void> | null;
  /**
   * With `partyCheck`: the tools and parties a finding named (`partyFinding`, bounded by `MAX_CHECKED`, oldest
   * first). The same parties added again to the same tool are the agent's informed choice, and proceed.
   */
  checked?: Set<string>;
  /**
   * With `partyCheck` (D375): digests (`partyKey`) of the email addresses and account details this session's packets
   * and answers showed the agent, each with the id of the item that held it ("" when none of the cited items did),
   * at most `MAX_PACKET_PARTIES` (oldest dropped first). The identifiers themselves are not kept.
   */
  packetParties?: Map<string, string>;
  /**
   * `verifyDelivery`: re-reads under way or just made, by item id (`check`): started ahead, beside the reader's call,
   * and taken by the delivery that follows. Bounded (`MAX_CHECKS`); dropped with the session.
   */
  checks?: Map<string, { at: number; mark: number; outcome: Promise<CheckOutcome>; settled?: CheckOutcome }>;
  /**
   * With `askDedup`: the words each item's line showed the agent in this session's packets and answers (lowercase),
   * by item id and version (`shownKey`: an item changed at its source under the same id counts as not shown), at
   * most `MAX_SHOWN` items (oldest dropped first), so an answer does not repeat them.
   */
  shown?: Map<string, Set<string>>;
  /**
   * `askNudge` (D316, D317): the request a nudged candidates packet was queued for (`requests` then), its anchors,
   * and the ids of the push pool's items past those handed, for the ask's deeper look in that request.
   */
  nudged?: { request: number; anchors: Anchors; deeper: string[] };
  /**
   * With `askReader`: the cue of the session's latest user request (its redacted words, names and days), so an ask
   * about it is read against what the user asked.
   */
  request?: Cue;
  /**
   * `readerReuse` (D193): the latest push's reading: the request it read (`requests` then), its pool's items
   * with their content hashes, and its verdict (null when it gave none).
   */
  pushRead?: { request: number; main: string; hashes: Map<string, string>; verdict: Promise<ReaderVerdict | null> };
  /**
   * `pushCheck` (D500): the session's push checks by input (`checkKey`), at most `CHECK_KEPT`, oldest first: a late
   * check still answers a second pass over the same pool, and a settled one answers, with no call, a pass whose items
   * it read every one of (same request, same day, same content). Dropped with the session (a forget closes it).
   */
  pushChecks?: Map<string, KeptCheck>;
  /** `planConflict` (D301): the session's last `PLAN_REQUESTS` acting requests (the push's cues), oldest first. */
  acted?: Cue[];
  /** `planConflict` (D301): ids the sync stored since the last take, at most `PLAN_WAITING`, oldest first. */
  planNew?: Set<string>;
  /** `planConflict` (D301): ids a plan packet has sent, at most `PLAN_SENT`: each is said once per session. */
  planSent?: Set<string>;
}

/** Items whose shown words a session keeps (`askDedup`). */
const MAX_SHOWN = 64;

interface Cue {
  text: string;
  entities: string[];
  key: string;
  /** A content-free id for the cue, for traces and injection reasons. */
  id: string;
  /** The days the request names, resolved against the event's clock (D44); null when it names no time. */
  time: TimeWindow | null;
  /** When the triggering event happened (ms): "the next one" is the first at or after this. */
  at: number;
  /**
   * When the request reached the engine, on the engine's own clock (`now`): what was made in the background before it
   * (a card) counts, whatever the caller's clock says (`at` is the caller's, and may be behind, ahead or replayed).
   */
  arrived?: number;
  /** The request's own (redacted) text, for questions about the calendar itself. */
  raw: string;
  /** The user's UTC offset (minutes) the days were resolved at. */
  offset: number;
  /** The request arrived from outside the conversation (a new email), not from the user's own turn. */
  external?: boolean;
  /** With spans on, the span this lookup's phases are children of (`spans.ts`). */
  span?: number;
  /**
   * `syncPollBehind`: the on-demand poll this lookup did not wait for; true once it is done if it stored anything (an
   * item new or changed since the index answered the lookup).
   */
  polled?: Promise<boolean>;
  /**
   * `syncPollBehind`: the lookup made again after the poll (`afterPoll`). It decides as a lookup behind a delivery
   * with no model (what is sure or grounded, and corrections), so it never calls the judge.
   */
  followUp?: true;
  /**
   * `askBehind` (D430): set by an explicit ask that runs behind; `searchCutBehind` then searches source by source and
   * records each cut copy's outcome here as it settles, so the ask can tell which sources answered in time.
   */
  cutStatus?: Map<string, string>;
}

/**
 * Output caps for the two model calls. Reasoning models (the default GLM among them) spend part of the cap thinking
 * before they answer; at 60 tokens the judge's verdict was cut off most of the time (D45). The caps bound spend, which
 * is billed on tokens used: a verdict is a few tokens plus low-effort reasoning.
 */
const JUDGE_MAX_TOKENS = 512;
/** Probes a user's cache remembers (`ItemCache.rememberProbe`): enough for the people and days of their week. */
const PROBE_MEMO = 256;
/** Consequence-probe finds a lookup ranks (`consequenceProbe`): its own and its class's earlier ones still cached. */
const MAX_CONSEQUENCE = 8;

/** What a lookup's probes found: the calls they made, their finds, and the consequence probe's (`consequence`). */
interface ProbeOut {
  calls: number;
  kept: string[];
  consequence?: { cls: ActionClass; ids: string[] };
}

/** One probe query (`Partner.probe`'s `send`): its kind, sources, words or day, and what to do with live answers. */
type ProbeSend = (
  kind: ProbeKind,
  sources: Source[],
  text: string,
  window?: SearchQuery["window"],
  keep?: boolean,
  onAnswer?: (sourceId: string, page: ContextItem[]) => void,
) => Promise<ContextItem[]>;
/** How a probe run differs from a lookup's own (`Partner.probe`). */
interface ProbeOpts {
  /** Source calls it may make (default `probeCalls`). */
  budget?: number;
  /** Synced sources whose copy is current (`sync`, D57): they answer from the local index, at no call. */
  local?: ReadonlySet<string> | null;
  /** The lookup's deadline (`performance.now()` time, D140); absent: `sourceTimeoutMs` from when the probes start. */
  deadlineAt?: number;
  /** `routeLocalHits` (D265): the lookup's local evidence per source, for the probes' routing. */
  boost?: ReadonlyMap<string, number>;
}
/** `intent`'s reciprocal-rank constant: rank 0 scores 1/k (the usual 60 flattens a five-item list to a tie). */
const ASK_FUSE_K = 2;
/** `densePacket`: a word on fewer than this share of the user's items is rare; an item adding one is no echo. */
const RARE_SHARE = 0.03;

/** Each cue's frame (`conflict.ts`), read once and dropped with the cue. */
const FRAMES = new WeakMap<Cue, Frame>();

/** Requests that act on someone, where an item they take part in is context (D44). */
const ACTING = new Set<string>(["scheduling", "communication", "task", "travel"]);
/**
 * A request about meeting someone (moving plans, running late, "still on for lunch?"): only an event with them is the
 * item it is about, never another thread they are on (D44).
 */
const ABOUT_MEETING =
  /\b(meet(ing)?|plans?|push|reschedul\w*|postpone|cancel|still on|running late|late|lunch|coffee|dinner|drinks|call|catch(ing)? up|slot|1:1)\b/i;
/** Words of a request that only say when or ask about the calendar: with nothing else, it is a listing (D44). */
const TIME_WORD =
  /^(|calendar|schedule|diary|agenda|plans?|busy|free|happening|booked|today|tonight|tomorrow|yesterday|week|weekend|next|coming|upcoming|morning|afternoon|evening|(mon|tues|wednes|thurs|fri|satur|sun)day|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|\d{1,2}(st|nd|rd|th)?)$/;
/**
 * Words that make a request act on someone, for grounding alone (D44): the situation labels (`situation.ts`) stay as
 * they were, since the source map learns per label.
 */
const ACTS_ON = /\b(write|note|thank|chase|ping|tell|intro(duce)?)\b/i;
/** A question about the calendar itself: then every event on the day it names is the answer (D44). */
const ASKS_SCHEDULE = /\b(calendar|schedule|diary|agenda|plans?|busy|free|on for|happening|booked)\b/i;

interface Scored {
  item: ContextItem;
  score: number;
  matched: number;
  sketch: Sketch | null;
  /**
   * With `quietNameOnly`, for a request that names someone: how many of its words the item holds beyond their names
   * and words that only say when (`rank`). Undefined otherwise.
   */
  beyond?: number;
  /** The item's document in the user's cache index, when ranked from it (for whole-term checks, `judgeTied`). */
  doc?: number;
  /** A whole cue entity is in the item (`rank`'s entity bonus). */
  entity?: true;
  /**
   * `syncPollBehind`: delivered earlier this session and changed since (`Ledger.revised`), so the agent holds a
   * superseded copy; a follow-up delivers the corrected one (D65).
   */
  revised?: true;
}

/** What an injection was built from, kept until it is handed out and usage tracking starts. */
/**
 * What a push packet's delivery marked (`readerPushBehind`): per item it marked, the ledger entry before and after,
 * and the sketch it added to the session's near-duplicate memory.
 */
type Undo = Map<string, { was: LedgerEntry | undefined; set: LedgerEntry; sketch: Sketch | null }>;

/** How one source an ask chose fared (D127; `AskResponse.sources`). */
type SourceStatus = NonNullable<AskResponse["sources"]>[number];

/** The statuses of a source that answered (D127): the connector, the fan-out's held result, or the synced index. */
const ANSWERED = new Set(["ok", "cached", "stale", "local"]);
/** `askBehind` (D430): the reason prefix of an ask's follow-up packet, withdrawn untaken at the next request. */
const ASK_BEHIND = "ask-behind:";
/** `askBehind` (D430): a source whose poll or live search was still running when the ask answered. */
const SEARCHING = "searching";
/**
 * `sourceYield` (D505, D603): a cut copy an ask did not search: its source's run of unused live reads is spent, or
 * nothing of the source has ever been used, and the request has no name or rare word for it.
 */
const UNSEARCHED = "unsearched";

/** How the answer names a status that did not answer (`unreached`). */
const STATUS_WORDS: Record<string, string> = {
  error: "failed",
  timeout: "timed out",
  open: "failing, skipped",
  busy: "busy",
  limited: "rate-limited",
  // The connector's own 429 (D212): the same words as our own limit's skip; to the agent both mean "try later".
  throttled: "rate-limited",
};

interface Built {
  sourceIds: string[];
  /** The delivered items, for the planner's delivery credit when the injection is handed out (D39). */
  items: { sourceId: string; id: string }[];
  text: string;
  /**
   * With `askDedup`: the items and the text the agent is shown, noted as shown (`noteShown`) when the injection is
   * handed out, not when it is built: a queued packet the agent has not taken was shown nothing, and an ask before
   * the agent takes it says its items in full (deep audit 2026-11-05 `ask-shown-before-handed-out`). Cleared once
   * noted.
   */
  shown?: { items: readonly ContextItem[]; text: string };
  /** With `revisionNotice`: each item's version the agent holds once this is handed out (`noteShown`). */
  copies?: { id: string; sourceId: string; version: number }[];
}

/**
 * Outcomes kept per user for later correction, and users kept per tenant (so one tenant's traffic cannot push out
 * another's, as with sessions and the cache, D17). Outlives sessions: feedback often comes at the end.
 */
const MAX_RECORDED = 200;
const MAX_RECORDED_USERS = 10_000;
/**
 * Injections awaiting a usage verdict per session; past this the oldest is dropped with no verdict. An ask-only session
 * (an MCP client) sends no events, so nothing it was given can ever show use: counting those as unused would teach the
 * source map that the sources answering its asks are useless.
 */
const MAX_OUTSTANDING = 64;

export class ContextPartner {
  readonly config: EngineConfig;
  /** The turn gate (`pushGate`, D1014), or null: the rule alone. */
  private readonly gate: TurnGate | null;
  private readonly sessions = new Map<string, Session>();
  /** By user scope key, that user's live sessions (no larger than `sessions`); a session leaves on close. */
  private readonly userSessions = new Map<string, Set<Session>>();
  private readonly perTenant = new Map<string, number>();
  private readonly built = new WeakMap<Injection, Built>();
  /**
   * `revisionNotice`: by user scope key, the live sessions handed at least one item (`Ledger.noteShown`), so a store
   * looks at those sessions alone; a session leaves on close. And the polls a change notice started for them
   * (`revisionsSettled`).
   */
  private readonly watching = new Map<string, Set<Session>>();
  /** `planConflict` (D301): by user scope key, the live sessions with acting requests; a session leaves on close. */
  private readonly acting = new Map<string, Set<Session>>();
  private readonly revisionPolls = new Map<string, Promise<void>>();
  /** By user and source: the notice poll's state (`pollRevised`), at most `MAX_REVISION_SOURCES`, idle ones dropped. */
  private readonly revisionSources = new Map<string, RevisionSource>();
  /** `stopSync` was called (and no `startSync` since): notices start no revision poll. */
  private revisionsStopped = false;
  /**
   * `sourceRefs` (D347): by user and item, the re-read a ref notice started and has not finished. The item is in doubt
   * until it lands (`doubted`), and a delivery's re-read waits on it rather than make a second call (`check`).
   */
  private readonly refreshing = new Map<string, { mark: number; outcome: Promise<CheckOutcome> }>();
  /**
   * `readerPushBehind`: what a push packet's delivery changed in its own session, so a second reading that withdraws
   * the packet untaken can undo it (`withdraw`). Keyed by the packet, so it goes with it.
   */
  private readonly undoable = new WeakMap<Injection, Undo>();
  /** Tenant → user scope key → injection id → outcome; both inner maps least recently recorded first. */
  private readonly recorded = new Map<string, Map<string, Map<string, Recorded>>>();
  private readonly now: () => number;
  private readonly fanout: SourceFanout;
  /**
   * `verifyDelivery`'s outcomes since start: items checked, confirmed, changed, gone, unverifiable, calls made; and
   * gone-holds the cache's caps dropped while still live (`ItemCache.holdsEvicted`), which reopen D126's race.
   */
  readonly freshness = {
    checked: 0,
    confirmed: 0,
    changed: 0,
    gone: 0,
    failed: 0,
    calls: 0,
    holdsEvicted: 0,
    /** `sourceRefs` (D347): refs read, and notices that fell back to the plain signal. */
    refsRead: 0,
    refsFallback: 0,
  };
  /**
   * Re-reads that came back "unverifiable" because the source's null proves nothing (an MCP fetch, `fetchReportsGone`
   * false, whose reply lacked the record), by user, then item id: the read mark the re-read began under and when. The
   * item is delivered and cited as held either way (D126, D211), so until the source signals again, and for at most
   * `UNVERIFIABLE_HOLD_MS`, a fetch would most likely say the same: `doubted` is false for it. Without this every later
   * delivery past `CHECK_REUSE_MS`, and every other session of the user, fetched it again (A5's lead, A8, D298). An
   * error result (`FetchErrorResult`, "error-result") is never held: it may pass, and a changed copy behind it must
   * be read at the next delivery. Least recently noted first; `MAX_UNVERIFIABLE` per user, `MAX_UNVERIFIABLE_USERS`.
   */
  private readonly unverifiable = new Map<string, Map<string, { mark: number; at: number }>>();
  /** The secret gate every item passes before it is held (D10): the fanout's, and `sourceItems`'. */
  private readonly redact: (items: ContextItem[]) => ContextItem[] | Promise<ContextItem[]>;
  /** What each user's probes bring back (`probeFresh`, `probeYield`). */
  private readonly economy = new ProbeEconomy();
  /** `sourceYield` (D505): each source's run of live reads with nothing used; null when off. */
  private readonly yields: SourceYield | null;
  /** Span tracing (`spans.ts`): null when off, so each phase's call site is one null check. */
  private readonly spans: Tracer | null;
  private readonly stats: SpanStats | null;
  /**
   * The background sync (`sync`, D57), or null when off. Its `tick` does the background work: a server runs it on a
   * timer (`startSync`), a simulation calls it on its own clock.
   */
  readonly sync: SyncManager | null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PartnerDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    // The turn gate's weights are read here, once a process, not on a user's first message (D1014).
    this.gate = this.config.pushGate ? (deps.turnGate === undefined ? turnGate() : deps.turnGate) : null;
    this.now = deps.now ?? Date.now;
    const maxText = deps.cache.maxTextChars;
    const stats = this.config.spans ? new SpanStats() : null;
    const sink = deps.onSpan;
    this.stats = stats;
    this.spans =
      stats || sink
        ? new Tracer((x) => {
            stats?.record(x);
            sink?.(x);
          })
        : null;
    const gate = deps.gatePool
      ? pooledSanitizer(deps.gatePool, maxText)
      : (items: ContextItem[]) => items.map((i) => sanitizeItem(i, maxText));
    this.redact = gate;
    const spans = this.spans;
    // The card enrichment (`cards`) reports its background calls into the same spans.
    if (spans && deps.cards && this.config.cards) deps.cards.tracer = spans;
    // A card is held no longer than its item: an item leaving the cache (or the whole user) takes its card along.
    if (deps.cards && this.config.cards) {
      const cards = deps.cards;
      deps.cache.onDropped((scope, ids) => (ids ? cards.forgetItems(scope, ids) : cards.forget(scope)));
      // Dates in an item resolve against the user's day, as the request's do (D44).
      cards.offsetOf = (scope) => deps.cache.offsetOf(scope);
      if (this.config.cardsEconomy) cards.economize();
      // `intent`: the same calls write each item's requests, and what the prefilter rejects is read for them.
      if (this.config.intent) cards.intend();
      // `cardsLean`: what the prefilter rejects is read for requests only when a person wrote it recently.
      if (this.config.intent && this.config.cardsLean) cards.lean(this.config.cardsLeanDays);
      // `cardsOrder` (D482, D483): a user's waiting items are read best first (worded, ahead, correspondents, recent).
      if (this.config.cardsOrder) cards.order();
      // `cardsLanes` (N4, D521, D522): a new user's backfill read by several calls at once.
      if (this.config.cardsLanes > 1) cards.lanes(this.config.cardsLanes);
      // `cardsRequestsFix` (D1060): the requests list shown in the prompt's first example; a dropped list asked again.
      if (this.config.intent && this.config.cardsRequestsFix) cards.showRequests();
    }
    this.yields = this.config.sourceYield ? new SourceYield(this.config.sourceYieldHalfLifeMs) : null;
    this.fanout = new SourceFanout({
      // With spans on, the gate's span is a child of the source call whose page it redacts (`Tracer.page`).
      sanitize: spans
        ? (items, signal) => {
            // An empty page is no work: no span (the gate's spans are the most numerous, half of them empty).
            if (items.length === 0) return gate(items, signal);
            const sp = spans.open("sanitize", spans.pageOf(items), { items: items.length });
            const out = gate(items, signal);
            if (!(out instanceof Promise)) {
              spans.close(sp);
              return out;
            }
            return out.finally(() => spans.close(sp, { async: true }));
          }
        : gate,
      // One clock for the whole engine: rate limits, result freshness and breakers run on the same time as the
      // cache and sessions (an injected clock that skipped the fan-out made simulated time hit real-time limits).
      now: this.now,
    });
    const c = this.config;
    this.sync = c.sync
      ? new SyncManager(
          {
            sources: deps.sources,
            fanout: this.fanout,
            cache: deps.cache,
            now: this.now,
            // Synced items name people as looked-up ones do: the source map learns which sources mention whom.
            onListed: (scope, ids) => {
              if (this.config.cards) this.deps.cards?.touch(scope, ids);
            },
            onStored: (scope, items) => {
              const mentions = mentionsOf(items);
              this.enqueueCards(scope, items, this.cardDefer(scope, items, mentions));
              this.recordMentions(scope, items, 0, mentions);
              this.queueRevised(scope, items);
              this.queuePlanConflicts(scope, items);
            },
            tracer: spans,
            after: deps.after,
          },
          {
            maxItems: c.syncMaxItems,
            pageSize: c.syncPageSize,
            backfillLanes: c.syncBackfillLanes,
            kickLanes: c.syncKick ? c.syncKickLanes : 0,
            kickRetryMs: c.syncKick ? c.syncKickRetryMs : 0,
            pollPageSize: c.syncPollPageSize,
            staleChance: c.syncStaleChance,
            maxStaleMs: c.syncMaxStaleMs,
            activeMs: c.syncActiveMs,
            sweepMs: c.syncSweepMs,
            dropMs: c.syncDropMs,
            callsPerMin: c.syncCallsPerMin,
            catchupPages: c.syncCatchupPages,
            maxUsersPerTenant: c.syncMaxUsersPerTenant,
            timeoutMs: Math.max(c.sourceTimeoutMs, 5_000),
            demandTimeoutMs: c.sourceTimeoutMs,
            push: c.syncPush,
            ingestTurns: c.syncIngestTurns,
            pushMaxStaleMs: c.syncPushMaxStaleMs,
            keepCut: c.syncKeepCut,
            sketch: c.routeSketch,
            rareTerms: c.sourceYield && c.sourceYieldEarn && c.sourceYieldRare > 0,
            engagedDeep: c.syncEngagedDeep,
            // Only with `verifyDelivery`: the longer sweep is safe only because deliveries re-read its old copies.
            unusedSweepMs: c.verifyDelivery ? c.syncUnusedSweepMs : 0,
          },
        )
      : null;
    // D370: with `syncIngestTurns`, the card drain gathers what waits for its turn, so its batches follow the items.
    const sync = this.sync;
    if (sync && c.syncIngestTurns && c.cards && deps.cards) deps.cards.gather = () => sync.pending();
    // D425 (opt-in): a user frozen to disk carries the sync's state for them; one read back by a later process takes
    // it again (so the restart polls, not backfills) and has its items carded again, as a re-sync would (cards are
    // not persisted). Set only when the embedder made the cache persist.
    if (deps.cache.persisting) {
      deps.cache.persistHooks = {
        // D992: the user's source-map rows (routing and planner learning) go with them, so a user moved to another
        // process or machine keeps what was learned; they are replaced, not merged, where they land.
        save: (scope) => ({ sync: sync?.snapshot(scope) ?? null, rows: this.deps.sourceMap.exportUser(scope) }),
        restored: (scope, items, extra) => {
          const carried = extra as { sync?: unknown; rows?: UserRows } | null | undefined;
          const saved = carried?.sync;
          if (sync && saved) sync.restore(scope, saved);
          if (carried?.rows && typeof carried.rows === "object") {
            try {
              this.deps.sourceMap.importUser(scope, carried.rows);
            } catch {
              // Fails open: the user keeps whatever this process's file holds for them (or learns again).
            }
          }
          // A source removed while the user was on disk: its synced items go before the first event is served (the
          // returning event's `ready` waits on this, bounded by the source timeout).
          const checked = sync ? sync.reconcile(scope, this.config.sourceTimeoutMs) : Promise.resolve(0);
          return checked.then(() => {
            if (items.length > 0 && this.config.cards && this.deps.cards) {
              const kept = items.filter((it) => this.deps.cache.get(scope, it.id, this.now()) !== null);
              if (kept.length > 0) this.enqueueCards(scope, kept, this.cardDefer(scope, kept, mentionsOf(kept)));
            }
          });
        },
      };
    }
  }

  /**
   * Runs the background sync's `tick` every `everyMs` (`sync` on; a no-op otherwise). The timer does not keep the
   * process alive, and a tick never overlaps another.
   */
  startSync(everyMs = 60_000): void {
    this.revisionsStopped = false;
    if (!this.sync || this.syncTimer) return;
    const sync = this.sync;
    sync.startKicks();
    this.syncTimer = setInterval(() => void sync.tick(), everyMs);
    this.syncTimer.unref?.();
  }

  stopSync(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    // `syncKick`: a kicked backfill's resume timers would list sources after the stop, as the revision polls below.
    this.sync?.stopKicks();
    // A revision poll held back by its gap would still list a source after the stop (wave-1 review). Its entry stays:
    // its `at` keeps the gap for a later notice, and the map is bounded (`MAX_REVISION_SOURCES`).
    // A poll still running starts no trailing one, and notices after the stop start none, until `startSync`.
    this.revisionsStopped = true;
    for (const st of this.revisionSources.values()) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      st.again = false;
    }
  }

  /**
   * `shadow` (an integration trying Eden without injecting: the proxy's shadow mode, D280): what is returned is not
   * handed out to an agent, so nothing is noted as shown and no usage outcome is learned from it (audit A5: a shadow
   * trial taught the source map that every source it would have cited went unused).
   */
  async observe(event: AgentEvent, options: { waitMs?: number; shadow?: boolean } = {}): Promise<ObserveResult> {
    // A user frozen while idle (D325) is thawed in slices first, so other users' events do not wait behind it. A
    // session's end and a draft read no item (`observeEvent` returns before any): they start no thaw, but wait on one
    // an earlier event of theirs waits on, or they would run before it (A24 and its review).
    const reads = event.kind !== "session_end" && !(event.kind === "user_message" && event.draft === true);
    const thawing = reads ? this.deps.cache.ready(event) : this.deps.cache.pendingThaw(event);
    if (thawing) await thawing;
    // `readerPush`: a request that acts is also read by the ask-time reader, as an ask of the engine's own; what it
    // flags is queued as a packet. The observe waits for it within its own wait, so an agent that never calls
    // `ask_context` gets the reading before its first model request when it is ready in time. The push's own read is
    // not cut at `askReaderWaitMs` (that bounds an explicit ask): a reading that lands later is still queued, while its
    // session is open and its request is the session's latest (`internal.request`, set once `observeEvent` counts it).
    const internal: { push: true; request?: number; turn?: number; open?: boolean } = { push: true };
    // `pushOpen` (O3, D702): the candidates' push also starts for a request whose verb is on no list; with
    // `pushCheck` its pool is checked as a listed request's (D823, D828).
    // `pushIndirect` (D820): an indirect lead-in ("I need to pay …", "Should I book …?") is read as its imperative,
    // and the push's lookup is given that imperative; the open shape then refuses log lines and chatter.
    const ruled =
      event.kind === "user_message"
        ? pushStart(event.text, {
            open: this.config.pushOpen && this.config.pushCandidates > 0,
            indirect: this.config.pushIndirect,
          })
        : null;
    // `pushGate` (M13, D1014): the turn gate keeps a rule start unless it vetoes it, and adds a start the rule has
    // none for, as an opened one, only where the open shape could start one (`pushOpen` with the candidates: the
    // reader's own push never pays for a gate-only start). The rule's request text (a lead-in's imperative) is kept.
    // No gate, or one that fails, and the rule decides alone (fail open).
    const said = event.kind === "user_message" ? event.text : "";
    let verdict: { needs: boolean } | null = null;
    if (this.gate && event.kind === "user_message")
      try {
        verdict = this.gate.read(said, { how: ruled?.how ?? "none", rest: ruled !== null && ruled.request !== said });
      } catch {
        verdict = null;
      }
    const adds = this.config.pushOpen && this.config.pushCandidates > 0;
    const start = !verdict
      ? ruled
      : !verdict.needs
        ? null
        : (ruled ?? (adds ? { how: "opened" as const, request: said } : null));
    const listed = start?.how === "listed";
    const opened = start?.how === "opened";
    // An indirect start (D820) is kept out of plan alerts as an opened one is: "We should get together sometime" can
    // read as listed, and D301 measured only listed-verb requests (the review of D820).
    if (opened || (start && event.kind === "user_message" && start.request !== event.text)) internal.open = true;
    const push =
      this.config.readerPush &&
      this.config.askReader &&
      // The candidates (D237) make no reader call, so they run without a reader too: a server with no model key
      // delivers them (D276). Only the reader's own push needs the dependency.
      (this.deps.reader || this.config.pushCandidates > 0) &&
      event.kind === "user_message" &&
      event.draft !== true &&
      (listed || opened)
        ? // The question as an ask may carry it (`checkAsk`'s cap): the event's own cap is 100 times that, and the
          // ask redacts and tokenizes it before its first await, on the observe's critical path.
          this.ask({ ...event, question: head(start!.request, MAX_QUESTION_CHARS), maxItems: 5 }, internal).catch(
            () => null,
          )
        : null;
    const t0 = performance.now();
    const observing = this.observeEvent(event, options);
    // `observeEvent` counts the request before its first await, so the session's count now names this request.
    // Its turn too: the push's trace names its request's turn, as a lookup's does, not the one current when it settles.
    if (push) {
      const s = this.sessions.get(sessionKey(event));
      internal.request = s?.requests;
      internal.turn = s?.turn;
    }
    const result = await observing;
    if (!push) {
      // `planConflict` (D301): what arrived since the last take, checked now, so `pending` says a packet waits.
      const live = this.config.planConflict ? this.sessions.get(sessionKey(event)) : undefined;
      if (live) this.checkPlans(live);
      return live && live.pending.length > 0 && !result.pending ? { ...result, pending: true } : result;
    }
    let settled = false;
    void push.then(() => (settled = true));
    const left = Math.min(options.waitMs ?? 0, this.config.readerPushWaitMs) - (performance.now() - t0);
    if (left > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([push, new Promise((r) => (timer = setTimeout(r, left)))]);
      clearTimeout(timer);
    }
    // A push still running, or one that queued its packet, is pending work the integration should poll for.
    const live = this.sessions.get(sessionKey(event));
    if (live) this.checkPlans(live);
    const queued = (live?.pending.length ?? 0) > 0;
    return { ...result, pending: result.pending || !settled || queued };
  }

  private async observeEvent(
    event: AgentEvent,
    options: { waitMs?: number; shadow?: boolean } = {},
  ): Promise<ObserveResult> {
    const t0 = performance.now();
    const spans = this.spans;
    const root = spans?.open("observe", 0, { kind: event.kind });
    if (event.kind === "session_end") {
      const ended = this.sessions.get(sessionKey(event));
      if (ended) this.close(ended, true);
      if (root) spans!.close(root);
      return { injection: null, pending: false };
    }
    // A draft the user is still typing is never a request, and moves no turn: it is ignored (no session is even
    // opened for it).
    if (event.kind === "user_message" && event.draft === true) {
      if (root) spans!.close(root, { decision: "draft" });
      return { injection: null, pending: false };
    }
    const s = this.session(event);
    // The user is active: their sources are synced (and polled) while they are (D57). O(1), no I/O.
    const fresh = this.sync?.track(s.scope, this.now());
    // `syncKick` (D751): a new user's backfill starts with their first event, not at the sync's next tick.
    if (fresh && this.config.syncKick) this.sync!.kick(s.scope);
    s.turn++;
    if (event.kind === "user_message") {
      s.requests++;
      // `askBehind` (D430): a follow-up packet still queued answered the last request's ask, not this request.
      this.dropAskBehind(s);
    }
    const prep = spans?.open("observe.prep", root!.id);
    if (s.vocab.size > this.config.maxSessionTerms) rebuildVocab(s, this.config.maxSessionTerms);
    const text = sanitizeForStore(head(eventText(event), this.config.maxEventChars));
    const terms = text ? distinctTermIds(text, s.vocab) : NO_TERMS;
    this.checkUsage(s, event, terms);
    this.remember(s, event, text, terms);
    if (prep) spans!.close(prep, { terms: terms.length });
    // The decision this event's trace records, for the root span (a fixed word, no content).
    let decided = "";
    let waited = false;

    const trace = (decision: Trace["decision"], reason: string, extra: Partial<Trace> = {}) => {
      decided = decision;
      this.trace(s, {
        sessionId: s.id,
        turn: s.turn,
        event: event.kind,
        decision,
        reason,
        latencyMs: Math.round(performance.now() - t0),
        sourceCalls: 0,
        modelCalls: 0,
        costUsd: 0,
        itemIds: [],
        ...extra,
      });
    };
    const reply = (injection: Injection | null): ObserveResult => {
      if (injection && !options.shadow) this.handOut(s, injection);
      if (root) {
        spans!.close(root, {
          session: s.id,
          turn: s.turn,
          decision: decided || "lookup",
          delivered: injection !== null,
          ...(waited ? { async: true } : {}),
        });
      }
      return { injection, pending: pendingOf(s) };
    };

    this.dropRemovedPending(s);
    const queued = s.pending.shift() ?? null;
    const lookup = wantsLookup(event, text, terms, s.vocab);
    if (!lookup) {
      trace("skipped", event.kind);
      return reply(queued);
    }
    if (event.kind === "user_message") s.situation = classifySituation(text);
    const cue = buildCue(text, terms, s.vocab, event.at, this.deps.cache.offsetOf(s.scope), this.config.probes);
    if (event.kind === "external") cue.external = true;
    cue.arrived = this.now();
    if (root) cue.span = root.id;
    // `askReader`: the request's own cue, kept so an ask reads what its frame already holds.
    if (event.kind === "user_message" && this.config.askReader) {
      s.request = cue;
    }
    const last = s.cues.get(cue.key);
    const repeat = last !== undefined && s.turn - last < this.config.cueCooldownTurns;

    const ranking = spans?.open("fast.rank", cue.span);
    const ranked = this.rank(s, cue);
    if (ranking) spans!.close(ranking, { candidates: ranked.length });
    const sure = spans?.open("fast.confident", cue.span);
    const fast = this.confident(ranked, cue);
    if (sure) spans!.close(sure, { sure: fast.length });
    // A stale cached copy is not delivered from here: the slow path re-reads it first (D40). A cue in cooldown is not
    // looked up again, but the cache may hold something new for it (another question about the same person).
    const answers = fast.length > 0 && !this.stale(s, fast);
    if (this.deps.onCandidates && !this.deps.model) {
      this.dump(s, "fast", this.factsOf(s, cue, ranked, event.kind), answers ? fast : [], answers ? "sure" : "");
    }
    if (answers) {
      this.markCue(s, cue);
      const injection = this.deliver(s, fast, "proactive", `cache:${cue.id}`, cue);
      trace("fast", cue.id, { itemIds: fast.map((x) => x.item.id) });
      if (queued) s.pending.unshift(queued);
      return reply(injection);
    }
    if (repeat) {
      trace("repeat", cue.id);
      return reply(queued);
    }
    if (s.inflight) {
      // The cue is not put in cooldown: it was not looked up, so the next event may look it up.
      trace("silent", "slow path busy");
      return reply(queued);
    }

    this.markCue(s, cue);
    const slow = this.slowPath(s, cue, t0, event.kind).finally(() => {
      s.inflight = null;
    });
    s.inflight = slow;
    if (this.config.syncPollBehind && this.sync && this.config.syncOnDemand) {
      this.afterPoll(s, cue, t0, event.kind, slow);
    }
    const queueLater = () => void slow.then((inj) => inj && !s.closed && s.pending.push(inj));
    const waitMs = options.waitMs ?? 0;
    if (queued || waitMs <= 0) {
      queueLater();
      return reply(queued);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), waitMs)));
    waited = true;
    const result = await Promise.race([slow, late]);
    clearTimeout(timer);
    if (result === "late") {
      queueLater();
      return reply(null);
    }
    return reply(s.closed ? null : result);
  }

  /**
   * `syncPollBehind`: once a lookup that answered from the index as it stood is done, and the poll it left running
   * stored something, the lookup is made again on the fresh index and what it delivers is queued. After a delivery,
   * or with a model, it adds only what is sure or grounded (`served`), plus the corrected copy of anything delivered
   * that the poll changed (`revised`); after silence with no model it decides as the lookup would have had it waited.
   * Follow-ups run one at a time after any lookup in flight, so each request made while the poll was out gets one.
   * Never throws.
   */
  private afterPoll(s: Session, cue: Cue, t0: number, eventKind: string, first: Promise<Injection | null>): void {
    const chain = first
      .then(async (injection) => {
        // `cue.polled` is set while the first lookup runs (its search), so it is read once the lookup is done.
        const fresh = cue.polled ? await cue.polled : false;
        if (!fresh || s.closed) return;
        // With a model the follow-up is decided as one behind a delivery, so it never makes the event's second judge
        // call: what is sure or grounded, and corrections.
        const served = injection !== null || this.deps.model !== null;
        // Another lookup still running (a later request, or another request's follow-up) may have read the index
        // before this poll stored anything, so this cue is not covered by it: wait, then look again. The ledger keeps
        // what an earlier lookup delivered from being sent twice. Nothing awaits between the last check and taking
        // `s.inflight` below, so two follow-ups woken in one tick still run one at a time.
        while (s.inflight && !s.closed) await s.inflight.catch(() => null);
        if (s.closed) return;
        const { polled: _, ...again0 } = cue;
        const again = this.slowPath(s, { ...again0, followUp: true }, t0, eventKind, served);
        const tracked = again.finally(() => {
          if (s.inflight === tracked) s.inflight = null;
        });
        s.inflight = tracked;
        const later = await tracked;
        if (later && !s.closed) s.pending.push(later);
      })
      .catch(() => {});
    this.addBehind(s, chain);
  }

  /** Work a lookup left running behind its answer (`syncPollBehind`), for harnesses to wait on. */
  /**
   * `readerPushBehind`: once the poll the push did not wait for is done, and only if it stored something, the push is
   * ranked again on the refreshed index and read once more (`again`: no second search, no further re-read). A pool the
   * poll left as it was reads as the same reader input, a cache hit with no call. Nothing runs for a closed session or
   * for a request the user has since followed with another. Never throws.
   */
  private pushAgain(
    s: Session,
    request: AskRequest,
    internal: AskInternal,
    polled: Promise<boolean>,
    searched: SearchedLive,
    prev: Injection | null,
  ): void {
    const work = polled
      .then(async (fresh) => {
        if (!fresh || s.closed || this.sessions.get(s.key) !== s) return;
        if (internal.request !== undefined && internal.request !== s.requests) return;
        // The calls were the first reading's; the second makes none (nor any plan) of its own.
        const { plans: _plans, ...rest } = searched;
        const again = { ...rest, calls: 0, ...(rest.syncCalls !== undefined ? { syncCalls: 0 } : {}) };
        await this.ask(request, {
          push: true,
          request: internal.request,
          turn: internal.turn,
          again: { searched: again, prev },
        });
      })
      .catch(() => {});
    this.addBehind(s, work);
  }

  /**
   * `askBehind` (D430): once the work an explicit ask stopped waiting for is done, and only if it stored something,
   * the ask is ranked again on the refreshed index (`internal.late`: no second search) and what it would now cite that
   * its answer did not is queued for the agent's next take. Nothing runs for a closed session or once the user has
   * sent another request. Never throws.
   */
  private askLater(
    s: Session,
    request: AskRequest,
    polled: Promise<boolean>,
    searched: SearchedLive,
    cited: readonly string[],
  ): void {
    const asked = s.requests;
    const work = polled
      .then(async (fresh) => {
        if (!fresh || s.closed || this.sessions.get(s.key) !== s || s.requests !== asked) return;
        // The calls were the answer's; the follow-up makes none (nor any plan) of its own.
        const { plans: _plans, ...rest } = searched;
        const again = { ...rest, calls: 0, ...(rest.syncCalls !== undefined ? { syncCalls: 0 } : {}) };
        await this.ask(request, { late: { searched: again, cited: new Set(cited), request: asked } });
      })
      .catch(() => {});
    this.addBehind(s, work);
  }

  /**
   * `askBehind` (D430): each chosen source's status once the ask stops waiting. A copy answered here that was cut or
   * not current gives its live search's outcome once that has settled (D127: a timeout or error is named), "local"
   * once its poll made it current, "error" when the work behind is done and its poll did not make it current
   * ("timeout" for a cut copy that was not searched), and "searching" (not answered: the answer says so, never an
   * all-clear) while that work runs.
   */
  private behindStatuses(
    s: Session,
    searched: SearchedLive,
    cut: ReadonlyMap<string, string>,
    settled: boolean,
  ): SourceStatus[] {
    const pending = new Set(searched.behindLocal ?? []);
    const now = this.now();
    return (searched.sources ?? []).map((x) => {
      if (!pending.has(x.sourceId)) return x;
      const done = cut.get(x.sourceId);
      if (done !== undefined) return { sourceId: x.sourceId, status: done };
      const whole = this.sync!.complete(s.scope, x.sourceId);
      if (whole && this.sync!.current(s.scope, x.sourceId, now)) return x;
      if (!settled) return { sourceId: x.sourceId, status: SEARCHING };
      // The work is done and the copy is still not current: its poll failed or was skipped after failures (the
      // 2026-11-05 audit's false all-clear: never "local" or "stale"), or a cut copy got no live search (too little of
      // the deadline left, D148) and answered nothing older than its cut.
      return { sourceId: x.sourceId, status: whole ? "error" : "timeout" };
    });
  }

  /**
   * `readerPushBehind`: records what `injection`'s delivery marked in `s` (`was`: each item's ledger entry before it),
   * so `withdraw` can undo it. An item the delivery left unmarked has nothing to undo.
   */
  private keepUndo(
    s: Session,
    injection: Injection,
    scored: Scored[],
    was: Map<string, LedgerEntry | undefined>,
  ): void {
    const undo: Undo = new Map();
    for (const x of scored) {
      const set = s.ledger.entry(x.item.id);
      const before = was.get(x.item.id);
      if (!set || sameEntry(set, before)) continue;
      undo.set(x.item.id, { was: before, set, sketch: x.sketch });
    }
    if (undo.size > 0) this.undoable.set(injection, undo);
  }

  /**
   * A push packet withdrawn before the agent took it (`readerPushBehind`'s second reading): its items go back to what
   * the session's ledger held before it (an earlier delivery and its version stand; an item never delivered is fresh
   * again), and their sketches leave the near-duplicate memory, so what the second reading does not deliver again
   * stays deliverable. An entry marked since by another delivery that recorded something else is left as it is.
   */
  private withdraw(s: Session, prev: Injection): void {
    const undo = this.undoable.get(prev);
    if (!undo) return;
    this.undoable.delete(prev);
    for (const [id, u] of undo) {
      if (!sameEntry(u.set, s.ledger.entry(id))) continue;
      s.ledger.restore(id, u.was);
      if (!u.sketch) continue;
      const at = s.delivered.lastIndexOf(u.sketch);
      if (at >= 0) s.delivered.splice(at, 1);
    }
  }

  private addBehind(s: Session, work: Promise<void>): void {
    const all = s.behind ? Promise.all([s.behind, work]).then(() => {}) : work;
    const tracked: Promise<void> = all.finally(() => {
      if (s.behind === tracked) s.behind = null;
    });
    s.behind = tracked;
  }

  /**
   * The session's last decisions (at most `EXPLAIN_TRACES`, oldest first), the traces `onTrace` receives: why Eden
   * spoke or stayed silent, with no content (D56, D277). Reads only; a session that ended or was forgotten has none.
   * Copies: changing one changes nothing held.
   */
  explain(ref: Scope & { sessionId: string }): Trace[] {
    return (this.sessions.get(sessionKey(ref))?.traces ?? []).map((t) => ({
      ...t,
      itemIds: [...t.itemIds],
      // A plan's shapes are an array of their own: a shallow copy shared them with the held trace (audit A11).
      ...(t.plans ? { plans: t.plans.map((p) => ({ ...p, shapes: [...p.shapes] })) } : {}),
    }));
  }

  /**
   * Injections the slow path queued for a session, oldest first. Integrations that poll call this. `shadow`: taken but
   * not handed to an agent (see `observe`).
   */
  takePending(ref: Scope & { sessionId: string }, options: { shadow?: boolean } = {}): Injection[] {
    const s = this.sessions.get(sessionKey(ref));
    if (!s) return [];
    this.checkPlans(s);
    // What the agent reads last about an item is its current copy (D232): a packet with a copy the cache has since
    // replaced goes before the packets that render current copies, and an update made stale by a packet of the batch
    // that renders the current copy is dropped. Queue order holds otherwise.
    this.dropRemovedPending(s);
    const out = this.currentLast(s, this.withoutCoveredUpdates(s.pending.splice(0)));
    if (!options.shadow) for (const injection of out) this.handOut(s, injection);
    return out;
  }

  /**
   * `askBehind` (D430): at the user's next request, an ask's follow-up packets the agent has not taken are withdrawn
   * (what their delivery marked undone): they answer the last request's question, and their lead says so.
   */
  private dropAskBehind(s: Session): void {
    for (let k = s.pending.length - 1; k >= 0; k--) {
      const packet = s.pending[k]!;
      if (!packet.reason.startsWith(ASK_BEHIND)) continue;
      s.pending.splice(k, 1);
      this.withdraw(s, packet);
    }
  }

  /**
   * A queued packet that cites an item since removed at its source (`sourceRemoved`, D126) is not handed out: the agent
   * would read a deleted item as current. Found by the engine fuzz harness (`fuzz.test.ts`, audit A5): the removal
   * cleared the cache, the sync's records and held pages, but not packets already queued. The packet goes whole (its
   * text cannot lose one item safely: folding and framing span items); what its delivery marked is undone where an undo
   * was kept, as for a withdrawn packet, and otherwise its other items stay marked (silence over a repeat).
   */
  private dropRemovedPending(s: Session): void {
    if (s.pending.length === 0) return;
    const now = this.now();
    for (let k = s.pending.length - 1; k >= 0; k--) {
      const packet = s.pending[k]!;
      if (!packet.citations.some((c) => this.deps.cache.isHeldGone(s.scope, c.itemId, now))) continue;
      s.pending.splice(k, 1);
      this.withdraw(s, packet);
    }
  }

  // ── revisionNotice (D205) ──

  /**
   * Resolves once the polls change notices started for this user's handed copies (`pollRevised`) have settled, with
   * whatever "updated:" packets they queued. A poll held back by `REVISION_POLL_GAP_MS` is not waited for. For
   * harnesses that stand in for the time between a change and the next request; an integration need not call it (the
   * packet waits in the queue).
   */
  async revisionsSettled(scope: Scope): Promise<void> {
    await this.revisionPolls.get(scopeKey(scope));
  }

  /** The agent now holds these versions: noted in the session's ledger, and the session watched for revisions. */
  private watchCopies(s: Session, copies: readonly Copy[]): void {
    if (s.closed || copies.length === 0) return;
    for (const c of copies) s.ledger.noteShown(c.id, c.version, c.sourceId, c.times);
    // An update still queued whose every copy this hand-out rendered in the same version says nothing new.
    const held = new Map(copies.map((c) => [c.id, c.version]));
    for (let k = s.pending.length - 1; k >= 0; k--) {
      const queued = this.built.get(s.pending[k]!);
      if (s.pending[k]!.reason.startsWith(UPDATED) && queued?.copies?.every((c) => held.get(c.id) === c.version)) {
        s.pending.splice(k, 1);
      }
    }
    // A copy the cache has since replaced with other words (a revision stored while this packet waited in the queue)
    // is announced now, behind it: the store found no session holding it yet (wave-1 review). Withdrawn packets are
    // never handed, so nothing is announced for them; an update already queued for that version is the next take's.
    if (this.config.revisionNotice) {
      const now = this.now();
      const queued = new Set<string>();
      for (const p of s.pending) {
        if (!p.reason.startsWith(UPDATED)) continue;
        for (const c of this.built.get(p)?.copies ?? []) queued.add(`${c.id}\u0000${c.version}`);
      }
      const newer = copies.flatMap((c) => {
        const cur = this.deps.cache.get(s.scope, c.id, now);
        if (!cur) return [];
        const v = versionOf(cur);
        return v !== c.version && !queued.has(`${c.id}\u0000${v}`) ? [cur] : [];
      });
      this.queueUpdates(s, newer);
    }
    const key = scopeKey(s.scope);
    let set = this.watching.get(key);
    if (!set) this.watching.set(key, (set = new Set()));
    set.add(s);
  }

  /**
   * A batch about to be handed out, less each "updated:" packet whose every copy another packet of the batch renders in
   * the same version (a re-read's update queued beside the delivery that re-read it).
   */
  private withoutCoveredUpdates(batch: Injection[]): Injection[] {
    if (!this.config.revisionNotice || batch.length < 2) return batch;
    const held = new Map<string, number>();
    for (const i of batch) {
      if (i.reason.startsWith(UPDATED)) continue;
      for (const c of this.built.get(i)?.copies ?? []) held.set(c.id, c.version);
    }
    if (held.size === 0) return batch;
    return batch.filter(
      (i) => !i.reason.startsWith(UPDATED) || !this.built.get(i)?.copies?.every((c) => held.get(c.id) === c.version),
    );
  }

  /** `takePending`'s batch, packets with a replaced copy first and stale updates a current packet covers dropped. */
  private currentLast(s: Session, batch: Injection[]): Injection[] {
    if (!this.config.revisionNotice || batch.length < 2) return batch;
    const now = this.now();
    const current = new Map<string, number | null>();
    const versionNow = (id: string) => {
      let v = current.get(id);
      if (v === undefined) {
        const cur = this.deps.cache.get(s.scope, id, now);
        current.set(id, (v = cur ? versionOf(cur) : null));
      }
      return v;
    };
    const stale = (i: Injection) =>
      (this.built.get(i)?.copies ?? []).some((c) => {
        const v = versionNow(c.id);
        return v !== null && v !== c.version;
      });
    // Items some non-update packet of the batch renders in their current version.
    const renderedNow = new Set<string>();
    for (const i of batch) {
      if (i.reason.startsWith(UPDATED)) continue;
      for (const c of this.built.get(i)?.copies ?? []) if (versionNow(c.id) === c.version) renderedNow.add(c.id);
    }
    const kept = batch.filter(
      (i) =>
        !i.reason.startsWith(UPDATED) ||
        !(this.built.get(i)?.copies ?? []).every((c) => versionNow(c.id) !== c.version && renderedNow.has(c.id)),
    );
    // Within the rest, updates last: with no cached copy to compare (evicted, expired) an update is still the newest
    // word the batch has on its items; a non-update packet that renders another version of a cached item is stale and
    // already went first.
    const isUpdate = (i: Injection) => i.reason.startsWith(UPDATED);
    const fresh = kept.filter((i) => !stale(i));
    return [...kept.filter(stale), ...fresh.filter((i) => !isUpdate(i)), ...fresh.filter(isUpdate)];
  }

  private unwatch(s: Session): void {
    const key = scopeKey(s.scope);
    const set = this.watching.get(key);
    if (!set) return;
    set.delete(s);
    if (set.size === 0) this.watching.delete(key);
  }

  /**
   * Items just stored with new or changed words (a sync poll or backfill page, a notice's items, a re-read): every
   * live session of the user that was handed another version of one gets "updated:" packets with the stored copies,
   * queued for its next take. The ledger then holds the new version, so each revision is sent once per session; an
   * earlier update still queued for the same items is replaced. Only real words count (`versionOf`: title and text,
   * not metadata). A copy stored under a later signal is sent all the same: it is newer than what the agent holds, and
   * a newer one still is sent when stored. A re-read for a session's own delivery queues one there too: the delivery
   * may not render the item (a size cut, a fold, a reader that does not pick it); one that does drops the update when
   * it is handed out (`watchCopies`, `withoutCoveredUpdates`).
   */
  private queueRevised(scope: Scope, items: readonly ContextItem[]): void {
    if (!this.config.revisionNotice || items.length === 0) return;
    const sessions = this.watching.get(scopeKey(scope));
    if (!sessions) return;
    for (const s of sessions) {
      if (s.closed) continue;
      const changed = items.filter((it) => s.ledger.superseded(it.id, versionOf(it)));
      this.queueUpdates(s, changed);
    }
  }

  /**
   * Queues "updated:" packets for these stored copies in one session: as many as the size cut needs, an earlier
   * update still queued for the same items replaced, each copy noted as promised.
   */
  private queueUpdates(s: Session, changed: readonly ContextItem[]): void {
    if (changed.length === 0) return;
    const ids = new Set(changed.map((it) => it.id));
    for (let k = s.pending.length - 1; k >= 0; k--) {
      const p = s.pending[k]!;
      if (p.reason.startsWith(UPDATED) && p.citations.every((c) => ids.has(c.itemId))) s.pending.splice(k, 1);
    }
    // As many packets as the size cut needs: an item cut from one is said in the next, never promised unsaid.
    for (let rest = changed; rest.length > 0;) {
      const { injection, items: said } = this.buildUpdate(s, rest);
      rest = rest.slice(said.length);
      // Promised now: a second store of the same version, before the agent takes this, queues nothing more.
      // Its times are noted when it is handed out (`watchCopies`): one superseded in the queue was never shown.
      for (const it of said) s.ledger.noteShown(it.id, versionOf(it), it.sourceId);
      s.pending.push(injection);
      this.trace(s, {
        sessionId: s.id,
        turn: s.turn,
        event: "source_change",
        decision: "sources",
        reason: injection.reason,
        latencyMs: 0,
        sourceCalls: 0,
        modelCalls: 0,
        costUsd: 0,
        itemIds: said.map((it) => it.id),
      });
    }
  }

  /**
   * One "updated:" packet: changed items under their titles, prefixed so the agent reads each as a newer version of
   * something it was shown, in the same data envelope as any packet (D11, D19). Only the items the size cut left in
   * are cited, marked delivered in the ledger (the normal paths do not send them again within the cooldown) and
   * returned; at least the first always is. Registered for usage tracking like any packet, with its own copies, so
   * handing out an older packet queued before it cannot leave the ledger at the older version.
   */
  private buildUpdate(s: Session, items: readonly ContextItem[]): { injection: Injection; items: ContextItem[] } {
    const tagged = items.map((it) => ({ ...it, title: `${UPDATED_TAG}${it.title}${this.updatedNote(s, it)}` }));
    let text = renderPacket(tagged, { maxBytes: this.config.maxInjectionBytes });
    let n = renderedCount(items, text);
    if (n === 0) {
      // Not even the first line fits a tiny `maxInjectionBytes`: it is said alone, under a cap that holds its line.
      text = renderPacket(tagged.slice(0, 1), {
        maxBytes: Math.max(this.config.maxInjectionBytes, 512),
      });
      n = 1;
    }
    const said = items.slice(0, n);
    const id = newId("inj", this.now());
    const injection: Injection = {
      ...s.scope,
      id,
      sessionId: s.id,
      mode: "proactive",
      text,
      citations: this.cited(said),
      reason: `${UPDATED}${id}`,
      score: 1,
      createdAt: this.now(),
    };
    s.ledger.mark(
      said.map((it) => it.id),
      s.turn,
      said.map((it) => versionOf(it)),
    );
    this.built.set(injection, {
      sourceIds: [...new Set(said.map((i) => i.sourceId))],
      items: said.map((i) => ({ sourceId: i.sourceId, id: i.id })),
      text: shownText(text),
      ...(this.config.askDedup ? { shown: { items: said, text } } : {}),
      copies: copiesOf(said, this.config.revisionDiff),
    });
    return { injection, items: said };
  }

  /**
   * How an update's title ends: `UPDATED_NOTE`, and with `revisionDiff` (D342) the times and dates the agent was shown
   * for the item that this version no longer has ("no longer: 09:30"), read before the ledger notes the new copy.
   */
  private updatedNote(s: Session, item: ContextItem): string {
    if (!this.config.revisionDiff) return UPDATED_NOTE;
    const now = new Set(timesOf(item));
    const gone = s.ledger.seenTimes(item.id).filter((t) => !now.has(t));
    return gone.length ? `${UPDATED_NOTE.slice(0, -1)}; no longer: ${gone.join(", ")})` : UPDATED_NOTE;
  }

  /**
   * A change notice for a source some live session of the user was handed a copy from: that source is polled in the
   * background (no caller waits on it), so the "updated:" packet is queued before the next request rather than found
   * by the lookup that request makes. The poll is the one the next lookup would make (`syncOnDemand`); it leaves the
   * copy current, so that lookup makes no call of its own. A burst of notices costs at most one poll at a time per
   * user and source, starts at least `REVISION_POLL_GAP_MS` apart (a notice during a poll, or too soon after one, gets
   * one trailing poll), each bounded by its timeout as a whole. Never throws.
   */
  private pollRevised(scope: Scope, sourceId: string): void {
    if (!this.config.revisionNotice || !this.sync || this.revisionsStopped) return;
    const user = scopeKey(scope);
    if (!this.holdsCopyFrom(user, sourceId)) return;
    const key = `${user}\u0000${sourceId}`;
    let st = this.revisionSources.get(key);
    if (!st) {
      st = { running: false, again: false, at: -Infinity, timer: null };
      this.revisionSources.set(key, st);
      for (const [k, v] of this.revisionSources) {
        if (this.revisionSources.size <= MAX_REVISION_SOURCES) break;
        if (!v.running && !v.timer) this.revisionSources.delete(k);
      }
    }
    if (st.running) {
      st.again = true;
      return;
    }
    // An engine clock that stepped back (a replayed harness clock, an NTP step) waits at most one gap.
    if (this.now() < st.at) st.at = this.now() - REVISION_POLL_GAP_MS;
    const wait = Math.min(REVISION_POLL_GAP_MS, st.at + REVISION_POLL_GAP_MS - this.now());
    if (st.timer) {
      if (wait > 0) return;
      // The engine's clock has passed the gap before the timer (a harness clock runs ahead of real time).
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (wait > 0) {
      const held = st;
      held.timer = setTimeout(() => {
        held.timer = null;
        this.startRevisionPoll(scope, sourceId, held);
      }, wait);
      (held.timer as { unref?: () => void }).unref?.();
      return;
    }
    this.startRevisionPoll(scope, sourceId, st);
  }

  private startRevisionPoll(scope: Scope, sourceId: string, st: RevisionSource): void {
    const sync = this.sync;
    const user = scopeKey(scope);
    if (!sync || this.revisionsStopped || !this.holdsCopyFrom(user, sourceId)) return;
    st.running = true;
    st.at = this.now();
    const ms = Math.max(this.config.sourceTimeoutMs, 5_000);
    const signal = AbortSignal.timeout(ms);
    const run = (async () => {
      const all = await this.deps.sources(scope).catch((): Source[] => []);
      const source = all.find((x) => x.id === sourceId);
      if (!source || signal.aborted) return;
      // D325: the poll reads the user's held copies; a frozen user is thawed in slices first (only when frozen).
      const thawing = this.deps.cache.ready(scope);
      if (thawing) await thawing;
      await sync.freshen(scope, [source], signal);
    })()
      .catch(() => {})
      .finally(() => {
        // One at a time: the next poll waits for this one's call to end, not for its timeout.
        st.running = false;
        if (st.again) {
          st.again = false;
          this.pollRevised(scope, sourceId);
        }
      });
    // What `revisionsSettled` waits for is bounded, a hung resolver or listing included.
    const poll = Promise.race([run, whenAborted(signal)]);
    const before = this.revisionPolls.get(user);
    const both = before ? Promise.all([before, poll]).then(() => {}) : poll;
    const tracked: Promise<void> = both.finally(() => {
      if (this.revisionPolls.get(user) === tracked) this.revisionPolls.delete(user);
    });
    this.revisionPolls.set(user, tracked);
  }

  /** Whether a live session of the user was handed a copy of an item from this source. */
  private holdsCopyFrom(user: string, sourceId: string): boolean {
    for (const s of this.watching.get(user) ?? []) {
      if (s.closed) continue;
      for (const [, c] of s.ledger.shownCopies()) if (c.sourceId === sourceId) return true;
    }
    return false;
  }

  /**
   * What this process holds for a tenant (D326, `/v1/usage`): users with a cache (frozen ones counted apart, D325),
   * their items, and users the sync keeps current. Counts only, no ids or content.
   */
  tenantUsage(tenantId: string): { users: number; frozenUsers: number; items: number; syncedUsers: number } {
    const c = this.deps.cache.tenantStats(tenantId);
    return {
      users: c.users,
      frozenUsers: c.frozen,
      items: c.items,
      syncedUsers: this.sync?.tenantUsers(tenantId) ?? 0,
    };
  }

  /**
   * D425 (opt-in): writes every user not yet frozen to disk, as a freeze would, for a shutdown; users frozen already
   * were written when they froze. Stops after `deadlineMs`. Returns how many were written (0 when not persisting).
   */
  persistLive(deadlineMs: number): number {
    return this.deps.cache.flush(deadlineMs);
  }

  /**
   * Hands a user to the process that now owns them (D992: a machine joined or left, or a machine's child count
   * changed): their sessions end, their state is written with their sync state and source-map rows (`release`), and
   * everything this process held for them goes as on `forget`, except the blob just written. The rows are deleted here
   * only once they are in that blob. Returns whether the blob was written (false when not persisting: the new owner
   * then starts the user over, as before D992).
   */
  release(scope: Scope, write = true): boolean {
    const key = scopeKey(scope);
    for (const s of [...this.sessions.values()]) if (scopeKey(s.scope) === key) this.close(s, false);
    this.recorded.get(scope.tenantId)?.delete(key);
    const written = this.deps.cache.release(scope, write);
    this.unverifiable.delete(key);
    // Rows go once they are in the blob, or when another machine holds newer ones (a drop, `write` false).
    if (written || !write) this.deps.sourceMap.forget(scope);
    this.fanout.forget(scope);
    this.deps.planner?.forget(scope);
    this.economy.forget(scope);
    this.yields?.forget(scope);
    this.sync?.forget(scope);
    this.deps.cards?.forget(scope);
    this.deps.reader?.forget(scope);
    return written;
  }

  /**
   * Releases every held user `moved` says another process now owns (D992), within `deadlineMs`; returns the users
   * released and how many of them were written. Users past the deadline stay here, unserved (the router no longer
   * routes them here); their new owner fetches their last stored blob, or re-syncs them.
   */
  releaseMoved(
    moved: (scope: Scope) => boolean,
    deadlineMs: number,
    write = true,
  ): { released: Scope[]; written: number } {
    const t0 = performance.now();
    const released: Scope[] = [];
    let written = 0;
    for (const scope of this.deps.cache.heldScopes()) {
      if (performance.now() - t0 > deadlineMs) break;
      if (!moved(scope)) continue;
      released.push(scope);
      if (this.release(scope, write)) written++;
    }
    return { released, written };
  }

  /**
   * Null when the user's cache is not frozen; else when it is thawed (D325, `ItemCache.ready`). Every entry point that
   * serves a user's items awaits it first (`observe`, `ask`, `checkAction`, `sourceItems`, a notice's revision poll;
   * the server before a removal), so a thaw runs in slices and other users' requests do not wait behind it. A bare
   * change notice reads no items and leaves a frozen user frozen.
   */
  ready(scope: Scope): Promise<void> | null {
    return this.deps.cache.ready(scope);
  }

  /**
   * The party check (`partyCheck`, D375, D376; docs/research/a25-action-guard.md): an agent's tool call, before it
   * runs, checked with no model and no source call for a party (an address, an account) it adds that this session's
   * packets showed, the user's own request does not name and no correspondent of the user's vouches for
   * (`partyFinding`). Anything else proceeds, as does a call to the same tool adding the same parties again after a
   * finding (the agent's informed choice). A finding is data in the usual envelope; what the integration does with it
   * is its own. With the check off, every call proceeds and no state is touched. Never throws: a failure proceeds.
   * (The action firewall that also read the call's grounds, `actionCheck`, D69, was deleted by D815.)
   */
  async checkAction(event: AgentEvent): Promise<ActionCheck> {
    const t0 = performance.now();
    const thawing = this.deps.cache.ready(event); // D325, as in `observe`.
    if (thawing) await thawing;
    const proceed = (reason: string): ActionCheck => ({
      verdict: "proceed",
      finding: null,
      reason,
      latencyMs: Math.round(performance.now() - t0),
    });
    if (!this.config.partyCheck || event.kind !== "tool_call") return proceed("off");
    // A session Eden handed no identifier has nothing to hold, and none is opened for a call in a session Eden never
    // saw.
    if (!this.sessions.get(sessionKey(event))?.packetParties?.size) return proceed("clear");
    try {
      const s = this.session(event);
      // The user's own words only: an arriving message (`external:`) can be the attacker's mail naming the address.
      const said = [...s.window].reverse().find((w) => w.startsWith("user_message: "));
      const found = this.partyFinding(s, event, said ? said.slice("user_message: ".length) : "");
      if (!found) return proceed("clear");
      const latencyMs = Math.round(performance.now() - t0);
      this.trace(s, {
        sessionId: s.id,
        turn: s.turn,
        event: "tool_call",
        decision: "fast",
        reason: "action-party",
        latencyMs,
        sourceCalls: 0,
        modelCalls: 0,
        costUsd: 0,
        itemIds: found.citations.map((c) => c.itemId),
      });
      return { verdict: "finding", finding: found, reason: "party", latencyMs };
    } catch {
      return proceed("error");
    }
  }

  /**
   * `partyCheck` (D375): a finding when the call adds a party (`callParties`) that this session's packets showed
   * (`Session.packetParties`), that the request does not name, and that is no correspondent of the user's
   * (`ItemCache.isCorrespondent`, addresses only, the item that showed it never vouching for it: an account number
   * has no header line to be on). Null otherwise. The tool and the flagged parties are remembered, so a call to the
   * same tool adding them again proceeds. `request` is the session's latest user message.
   */
  private partyFinding(s: Session, event: AgentEvent & { kind: "tool_call" }, request: string) {
    const shown = s.packetParties;
    if (!shown || shown.size === 0) return null;
    const flagged: Party[] = [];
    const ids = new Set<string>();
    for (const p of callParties(event.input)) {
      const from = shown.get(partyKey(p.norm));
      if (from === undefined) continue;
      if (namesParty(request, p)) continue;
      if (p.kind === "address" && this.deps.cache.isCorrespondent(s.scope, p.norm, from || undefined)) continue;
      flagged.push(p);
      if (from) ids.add(from);
    }
    if (flagged.length === 0) return null;
    // The agent was told about these parties for this tool: a call adding them again proceeds, whatever else changed
    // in it (a fresh request id, a reworded body after the user said yes).
    const informed = `party\u0000${event.tool}\u0000${flagged
      .map((p) => partyKey(p.norm))
      .sort()
      .join(",")}`;
    const checked = (s.checked ??= new Set());
    if (checked.has(informed)) return null;
    checked.add(informed);
    while (checked.size > MAX_CHECKED) checked.delete(checked.values().next().value as string);
    const items = [...ids]
      .map((id) => this.deps.cache.get(s.scope, id, this.now()))
      .filter((i): i is ContextItem => i !== null);
    const citations = this.cited(items);
    const text = renderAnswer(
      partyFindingText(
        event.tool,
        flagged,
        citations.map((c) => c.title),
      ),
    );
    const finding: Injection = {
      ...s.scope,
      id: newId("inj", this.now()),
      sessionId: s.id,
      mode: "proactive",
      text,
      citations,
      reason: "action-party",
      score: 1,
      createdAt: this.now(),
    };
    return finding;
  }

  /**
   * `partyCheck` (D375): notes the identifiers a text handed to the agent showed (digests only), each with the cited
   * item whose text holds it, so `partyFinding` can tell a party Eden's packets supplied. An ask's answer is the text
   * the agent receives, not its injection's own rendering (`deliver`'s `shown`), so `ask` notes it itself.
   */
  private notePacketParties(s: Session, text: string, citations: readonly Citation[]): void {
    const found = partiesIn(text, true);
    if (found.length === 0) return;
    const map = (s.packetParties ??= new Map());
    const cited = citations
      .map((c) => this.deps.cache.get(s.scope, c.itemId, this.now()))
      .filter((i): i is ContextItem => i !== null);
    for (const p of found) {
      const k = partyKey(p.norm);
      const holder = cited.find((i) => partiesIn(`${i.title}\n${i.text}`).some((q) => q.norm === p.norm));
      map.delete(k);
      map.set(k, holder?.id ?? "");
    }
    while (map.size > MAX_PACKET_PARTIES) map.delete(map.keys().next().value as string);
  }

  async ask(request: AskRequest, internal: AskInternal = {}): Promise<AskResponse> {
    const t0 = performance.now();
    const thawing = this.deps.cache.ready(request); // D325, as in `observe`.
    if (thawing) await thawing;
    const spans = this.spans;
    const root = spans?.open("ask", 0, { async: true });
    const s = this.session(request);
    // An ask-only session (an MCP client) never runs observe, which keeps the session vocabulary bounded.
    if (s.vocab.size > this.config.maxSessionTerms) rebuildVocab(s, this.config.maxSessionTerms);
    const question = sanitizeForStore(request.question);
    const cue = buildCue(
      question,
      distinctTermIds(question, s.vocab),
      s.vocab,
      this.now(),
      this.deps.cache.offsetOf(s.scope),
      this.config.probes,
    );
    if (root) cue.span = root.id;
    const limit = request.maxItems ?? 5;
    // `readerPushBehind`: the push reads the index as it stands while the sync's poll runs behind (the agent's asks
    // wait for it only with `askBehind` off, D430). Its second reading, once the poll has stored something, reuses the
    // first one's search.
    const behind =
      internal.push === true &&
      internal.again === undefined &&
      this.config.readerPushBehind &&
      this.config.syncPollBehind &&
      this.config.syncOnDemand;
    // `askBehind` (D430): an explicit ask's lookup runs behind as the push's does, and the ask waits for that work only
    // `askBehindWaitMs`. Its follow-up (`internal.late`) reuses the first search and starts none.
    const askBehind =
      !internal.push &&
      internal.again === undefined &&
      internal.late === undefined &&
      this.config.askBehind &&
      this.config.pushCutBehind &&
      this.config.syncLocalComplete &&
      this.config.syncPollBehind &&
      this.config.syncOnDemand &&
      this.sync !== null;
    if (askBehind) cue.cutStatus = new Map();
    let searched =
      internal.again?.searched ??
      internal.late?.searched ??
      (await this.searchLive(s, cue, this.config.askSources, behind || askBehind));
    // Whether the work behind the ask was done when it answered; false leaves a follow-up for what it stores.
    let settled = true;
    if (askBehind && searched.behindLocal?.length) {
      const waiting = spans?.open("ask.wait", cue.span, { async: true });
      // No work behind at all (no poll, no search started) is settled: each such copy is then named, never "local".
      settled = cue.polled ? (await within(cue.polled, this.config.askBehindWaitMs)) !== null : true;
      if (waiting) spans!.close(waiting, { settled });
      searched = { ...searched, sources: this.behindStatuses(s, searched, cue.cutStatus!, settled) };
    }
    const { calls: sourceCalls, plans, probed, local, syncCalls } = searched;
    // `intent`: what the question would change, by the requests written for each item (no model, no call).
    const intentFound = this.intentFinds(s, cue);
    const extra = [...intentFound.keys()];
    const ranking = spans?.open("rank", cue.span);
    const scored = this.rank(s, cue, {
      ignoreLedger: true,
      probed: extra.length > 0 ? [...(probed ?? []), ...extra] : probed,
    });
    if (ranking) spans!.close(ranking, { candidates: scored.length });
    // Only anchored intent hits are fused in (`anchoredIntents`); every hit still withholds the guard's line.
    const intents = this.anchoredIntents(s, cue, intentFound);
    // The candidates' facts (`decide.ts`), for the lab's dump.
    const facts = this.deps.onCandidates
      ? this.factsOf(s, cue, scored, "ask", { probed: new Set(probed ?? []), bridged: new Set(), carded: new Map() })
      : [];
    const grounding = spans?.open("ground", cue.span);
    // What the question's people and days ground comes first (D44); a named day's other events only through it, so
    // a question about a topic is not padded with that day's calendar.
    const onDay = (x: Scored) => cue.time?.days.has(startDay(x.item, cue.offset) ?? "") === true;
    const grounded = this.grounded(
      s,
      cue,
      scored.filter((x) => x.score >= this.config.candidateScore || onDay(x)),
      "ask",
    ).items;
    if (grounding) spans!.close(grounding, { grounded: grounded.length });
    const lexical = [
      ...grounded,
      ...scored.filter((x) => x.score >= this.config.candidateScore && !grounded.includes(x)),
    ];
    const order = intents.size > 0 ? this.fuseIntent(lexical, scored, intents) : lexical;
    let chosen = order.slice(0, limit);
    // `askReader` (D95): one budgeted model call reads the widened pool; the items it says bind lead, with its bearing.
    // An explicit ask waits `askReaderWaitMs` for it; the push waits for the reading itself (the observe that started
    // it stops waiting at `readerPushWaitMs`), bounded by the reader's call and the session's close.
    const readOpts: ReadOpts = {
      push: internal.push === true,
      ...(internal.request !== undefined ? { request: internal.request } : {}),
    };
    // `pushCandidates` (D236, D237): no reader call, on the push or on an ask (the agent reads the candidates).
    const candidating = this.config.pushCandidates > 0;
    // `askBehind`'s follow-up (`internal.late`) reads nothing: it makes no call of its own, model or source (D430).
    const reading =
      this.config.askReader && this.deps.reader && !candidating && internal.late === undefined
        ? await this.readAsk(
            s,
            cue,
            [...order, ...scored],
            chosen,
            limit,
            internal.push ? Infinity : this.config.askReaderWaitMs,
            {
              push: internal.push === true,
              ...(internal.request !== undefined ? { request: internal.request } : {}),
            },
          )
        : null;
    if (reading) chosen = reading.chosen;
    // `askNudge` (D316, D317): an ask in the request a nudged packet went out for also lists the push pool's items past
    // those handed that hold one of the request's anchors (its current copies). They take at most half the answer's
    // seats (rounded up), from the end, and never the ask's own first: the answer still cites at most `maxItems` (the
    // protocol's bound) and keeps its best match for the question (none are added at `maxItems` 1).
    if (!internal.push && this.config.askNudge && s.nudged?.request === s.requests) {
      const { anchors, deeper } = s.nudged;
      const have = new Set(chosen.map((x) => x.item.id));
      const extra: Scored[] = [];
      const seats = Math.min(Math.ceil(limit / 2), limit - 1);
      for (const id of deeper) {
        if (extra.length >= seats) break;
        if (have.has(id)) continue;
        const item = this.deps.cache.get(s.scope, id, this.now());
        if (item && !bulkMail(item) && anchored(item, anchors))
          extra.push({ item, score: 0, matched: 0, sketch: null });
      }
      chosen = [...chosen.slice(0, Math.max(0, limit - extra.length)), ...extra];
    }
    // `askBehind` (D430): the follow-up of an ask that answered before its sources were read. What it would cite now
    // that the answer did not, and the agent has not been handed, goes out as a packet for the next take, re-checked
    // like any delivery; nothing for a closed session or a request the user has since followed with another.
    if (internal.late) {
      const { cited, request: asked } = internal.late;
      // Only what the sources still being read could have brought (the answer's own sources answered it), re-read as
      // strictly as the answer was (D211): an item the answer left out as not re-checked is not handed over as news.
      const reading = new Set(searched.behindLocal ?? []);
      const fresh = chosen.filter(
        (x) => reading.has(x.item.sourceId) && !cited.has(x.item.id) && s.ledger.isFresh(x.item.id, s.turn),
      );
      const was = new Map(fresh.map((x) => [x.item.id, s.ledger.entry(x.item.id)] as const));
      const current = () => !s.closed && s.requests === asked;
      const strict = { unconfirmed: new Map<string, number>(), unswept: new Map<string, number>() };
      let checked = fresh.length > 0 && current() ? await this.verifyItems(s, fresh, cue, strict) : [];
      // As the push (audit A11): an item handed out during the re-reads is not marked twice.
      checked = checked.filter((x) => {
        const now = s.ledger.entry(x.item.id);
        return now === undefined || sameEntry(was.get(x.item.id), now);
      });
      const frame = {
        lead: ASK_LATE_LEAD,
        itemBytes: this.config.compactItemBytes,
        maxBytes: this.config.maxInjectionBytes,
      };
      const injection =
        checked.length > 0 && current()
          ? this.deliver(s, checked, "proactive", `${ASK_BEHIND}${cue.id}`, cue, undefined, frame)
          : null;
      if (injection) {
        // Undoable, so a packet the agent has not taken when the user's next request comes is withdrawn whole.
        this.keepUndo(s, injection, checked, was);
        s.pending.push(injection);
      }
      const latencyMs = Math.round(performance.now() - t0);
      this.trace(s, {
        sessionId: s.id,
        turn: s.turn,
        event: "ask",
        decision: injection ? "sources" : "silent",
        reason: "ask behind",
        latencyMs,
        sourceCalls: 0,
        modelCalls: 0,
        costUsd: 0,
        itemIds: injection ? injection.citations.map((c) => c.itemId) : [],
      });
      if (root) spans!.close(root, { session: s.id, turn: s.turn, decision: "ask-behind", delivered: !!injection });
      return { answer: "", citations: [], usedModel: false, costUsd: 0, latencyMs };
    }
    // `readerPush`: the ask was the engine's own, for the user's request. What the reader flagged goes to the agent as
    // a proactive packet (queued, taken before its next model request); nothing else is answered or handed out.
    if (internal.push) {
      // `pushOpen` (D702): a message the verb lists do not know is not kept as an acting request: a plan alert
      // (D301) quotes the request it is about, and an opened message may be a remark.
      if (this.config.planConflict && internal.again === undefined && !internal.open) this.noteActed(s, cue);
      // `readerPushKinds`: only the kinds pushed unasked (a "changes" bearing is the reader's least precise).
      const pushes = new Set<string>(this.config.readerPushKinds);
      // `pushCandidates` (D236): the pool's top, for the agent to judge, in place of the reader's flags.
      const gate = candidating ? this.pushGate(s, cue, [...order, ...scored]) : null;
      // `pushCheck` (D500, D828): one budgeted call over the pool, only when the gate would hand candidates. With no
      // checker wired (no model key) no await is added: the push's timing (which turn it lands in) stays as it was.
      const check = gate && this.config.pushCheck && this.deps.checker ? await this.checkPush(s, cue, gate) : null;
      if (check && s.closed) {
        // The session closed while the check ran: its call was paid for, so it is traced on its own.
        if (check?.called) this.traceCheck(s, check, t0);
        return {
          answer: "",
          citations: [],
          usedModel: false,
          costUsd: 0,
          latencyMs: Math.round(performance.now() - t0),
        };
      }
      const candidates = gate ? this.candidatesOf(s, cue, gate, check) : null;
      const flagged = candidates
        ? candidates.items
        : reading
          ? chosen.filter((x) => reading.notes.has(x.item.id) && pushes.has(reading.kinds.get(x.item.id) ?? ""))
          : [];
      // A reading that lands after a newer user message answers a request the agent has moved past: not queued.
      const latest = internal.request === undefined || internal.request === s.requests;
      // `readerPushBehind`'s second reading, on the index the poll refreshed: the packet the first queued from the
      // older copies, if the agent has not taken it, gives way to this one (its items count as undelivered here). One
      // the agent has taken stays taken: only what is new to it, or what the poll changed since, goes out again.
      const prev = internal.again?.prev;
      // A candidates pass replaces the first packet only with candidates of its own (CL6 review).
      const replacing = !!prev && (reading?.read || (candidates?.items.length ?? 0) > 0) && !s.closed && latest;
      // The first packet's items count as undelivered for this reading while it is still queued. It is withdrawn only
      // after the re-reads below, in the same step as its replacement is queued: withdrawn before them, a take while a
      // re-read was on the wire found neither packet, and the push's context reached the agent a request late (audit
      // A5); a candidates pass with nothing left to deliver keeps it.
      const withdrawn = new Set<string>(
        replacing && s.pending.includes(prev!) ? prev!.citations.map((c) => c.itemId) : [],
      );
      const fresh = flagged.filter(
        (x) =>
          withdrawn.has(x.item.id) ||
          s.ledger.isFresh(x.item.id, s.turn) ||
          (internal.again !== undefined && s.ledger.revised(x.item.id, versionOf(x.item), s.turn)),
      );
      // The re-reads come first (`verifyItems`, which may wait on a connector), then the delivery, so a user message
      // that arrives meanwhile still keeps the packet out: nothing is marked delivered that is not queued.
      // As `deliverChecked` (audit A11): an item whose ledger entry changed over the re-reads' await was handed out
      // meanwhile (this event's slow path, a fast path), and `deliver` marks without testing again; it is left out. An
      // entry gone meanwhile was swept, not handed out: kept.
      const was = new Map(fresh.map((x) => [x.item.id, s.ledger.entry(x.item.id)] as const));
      let checked = fresh.length > 0 && !s.closed && latest ? await this.verifyItems(s, fresh, cue) : [];
      checked = checked.filter((x) => {
        const now = s.ledger.entry(x.item.id);
        return now === undefined || sameEntry(was.get(x.item.id), now);
      });
      const still = internal.request === undefined || internal.request === s.requests;
      const delivering = checked.length > 0 && !s.closed && still;
      if (replacing && (delivering || !candidates)) {
        const at = s.pending.indexOf(prev!);
        if (at >= 0) {
          s.pending.splice(at, 1);
          // The agent never got it: what its delivery marked is undone before this reading delivers.
          this.withdraw(s, prev!);
        } else if (withdrawn.size > 0) {
          // The agent took it during the re-reads: its items are delivered after all, and go again only if revised.
          checked = checked.filter(
            (x) =>
              !withdrawn.has(x.item.id) ||
              s.ledger.isFresh(x.item.id, s.turn) ||
              s.ledger.revised(x.item.id, versionOf(x.item), s.turn),
          );
        }
      }
      // A first reading whose poll runs behind may be withdrawn by the second: its ledger entries are kept to restore.
      const undo = behind ? new Map(checked.map((x) => [x.item.id, s.ledger.entry(x.item.id)])) : null;
      const injection =
        delivering && checked.length > 0
          ? candidates
            ? this.deliver(
                s,
                checked,
                "proactive",
                `candidates:${cue.id}`,
                cue,
                undefined,
                this.candidateFrame(candidates.unsettled !== undefined),
              )
            : this.deliver(s, checked, "proactive", `reader:${cue.id}`, cue)
          : null;
      if (injection && undo) this.keepUndo(s, injection, checked, undo);
      if (injection) s.pending.push(injection);
      // `askNudge` (D316, D317): the ask the nudge asks for, in this request, may look past what was handed. A settled
      // packet (a `readerPushBehind` second pass replacing a nudged one) ends that look: the agent was not nudged.
      if (injection && candidates && !candidates.unsettled) s.nudged = undefined;
      if (injection && candidates?.unsettled && internal.request !== undefined) {
        const handed = new Set(candidates.items.map((x) => x.item.id));
        s.nudged = {
          request: internal.request,
          anchors: candidates.unsettled,
          deeper: candidates.pool.filter((x) => !handed.has(x.item.id)).map((x) => x.item.id),
        };
      }
      const latencyMs = Math.round(performance.now() - t0);
      // Most of the reader's spend with `readerPush` is this read (a later ask over the same input is cached): its
      // trace carries it, since this response goes to no caller.
      const costUsd = reading?.costUsd ?? 0;
      this.trace(s, {
        sessionId: s.id,
        turn: internal.turn ?? s.turn,
        event: "user_message",
        decision: "reader-push",
        reason: cue.id,
        latencyMs,
        // The push's lookup runs beside the event's own slow path over the same words but asks `askSources`, not
        // `lookupSources`, so it is partly new calls: `searchLive` counts only the calls a connector received (a search
        // that joined the slow path's in flight, or was answered by the fan-out's cache, is none), and a harness
        // summing `sourceCalls` over a task counts what its connectors were sent. Plans and sync use stay off.
        sourceCalls,
        modelCalls: (reading?.called ? 1 : 0) + (check?.called ? 1 : 0),
        costUsd: costUsd + (check?.costUsd ?? 0),
        ...(reading ? { readerCalls: reading.called ? 1 : 0, readerCostUsd: reading.costUsd } : {}),
        ...(candidates ? { candidates: true } : {}),
        ...(check ? { checkCalls: check.called ? 1 : 0, checkCostUsd: check.costUsd } : {}),
        itemIds: injection ? injection.citations.map((c) => c.itemId) : [],
      });
      const turn = internal.turn ?? s.turn;
      if (root) spans!.close(root, { session: s.id, turn, decision: "reader-push", delivered: !!injection });
      if (behind && cue.polled) this.pushAgain(s, request, internal, cue.polled, searched, injection);
      return { answer: "", citations: [], usedModel: reading?.called === true, costUsd, latencyMs };
    }
    // `verifyDelivery`: what the answer cites is re-read first when a signal doubted its copy; gone items are left out,
    // and so are doubted ones no re-read confirmed (D211), named in the answer.
    const unconfirmed = new Map<string, number>();
    const unswept = new Map<string, number>();
    const checked = await this.verifyItems(s, chosen, cue, { unconfirmed, unswept });
    const items = checked.map((x) => x.item);
    const rendering = spans?.open("render", cue.span);
    const answering = this.answering(s, cue);
    if (reading?.notes.size) answering.note = (item) => reading.notes.get(item.id);
    const packet = items.length ? renderPacket(items, answering) : "";
    // D127: "nothing" is said only when the sources the ask chose answered; one that failed is named, in the text
    // (an MCP caller sees only the text) and in `sources`.
    const answer = honestAnswer(
      packet,
      searched.sources,
      searched.unresolved === true,
      // The session closing during the re-reads leaves nothing checked either (D127): not an all-clear.
      searched.closed === true || s.closed,
      unconfirmed,
      unswept,
    );
    if (rendering) spans!.close(rendering, { items: items.length });
    if (this.deps.onCandidates) {
      this.dump(
        s,
        "ask",
        facts,
        // By id: a re-read copy (`verifyDelivery`) is another object for the same item.
        scored.filter((x) => items.some((i) => i.id === x.item.id)),
        items.length > 0 ? "answer" : "",
        order.map((x) => x.item.id),
      );
    }
    const usedModel = reading?.called === true;
    // What the ask spent: the reader's call (0 when its verdict was cached, joined or late).
    const costUsd = reading?.costUsd ?? 0;
    if (items.length && !s.closed) {
      const injection = this.deliver(
        s,
        items.map((item) => ({ item, score: 1, matched: 0, sketch: null })),
        "answer",
        "ask",
        cue,
        packet,
      );
      // The answer is handed out as it is returned: its items are noted as shown now.
      this.handOut(s, injection);
      if (this.config.partyCheck) this.notePacketParties(s, answer, injection.citations);
      // A packet still queued for the agent whose every item this answer says in full is not handed out again; one it
      // covers only in part stays queued (its other items are news). Removed, never `withdraw`n: the agent now has
      // each of its items, so what its delivery marked stands.
      // Only what the answer's text rendered: an item its size cap cut was not said (audit A5).
      const cited = new Set(items.slice(0, renderedCount(items, injection.text)).map((i) => i.id));
      for (let k = s.pending.length - 1; k >= 0; k--) {
        const queued = s.pending[k]!.citations;
        // An "updated:" packet goes only when the answer rendered its items' new version (`watchCopies`, D205): an
        // item cited but cut from the answer was not said.
        if (s.pending[k]!.reason.startsWith(UPDATED)) continue;
        if (queued.length > 0 && queued.every((c) => cited.has(c.itemId))) s.pending.splice(k, 1);
      }
    }
    const latencyMs = Math.round(performance.now() - t0);
    this.trace(s, {
      sessionId: s.id,
      turn: s.turn,
      event: "ask",
      decision: "answer",
      reason: cue.id,
      latencyMs,
      sourceCalls,
      modelCalls: reading?.called ? 1 : 0,
      costUsd,
      ...(reading ? { readerCalls: reading.called ? 1 : 0, readerCostUsd: reading.costUsd } : {}),
      itemIds: items.map((i) => i.id),
      ...(plans ? { plans } : {}),
      ...(local !== undefined ? { localSources: local, syncCalls: syncCalls ?? 0 } : {}),
    });
    if (root) spans!.close(root, { session: s.id, turn: s.turn, decision: "answer", delivered: items.length > 0 });
    if (askBehind && !settled && cue.polled) {
      this.askLater(
        s,
        request,
        cue.polled,
        searched,
        items.map((i) => i.id),
      );
    }
    return {
      answer,
      citations: this.cited(items),
      usedModel,
      costUsd,
      latencyMs,
      ...(searched.sources ? { sources: searched.sources } : {}),
    };
  }

  /**
   * `askReader` (D95, `reader.ts`): the reader's verdict on an ask about an action, over the first `askReaderPool`
   * distinct candidates of `ranked` (the ask's pool in its order, then the rest it scored). The items it says bind
   * lead the answer, at most `limit`, the usual `chosen` fill what is left. Null when the reader is not asked; `read`
   * false when it gave no verdict within `waitMs` (fail open: `chosen` as is; Infinity waits for the verdict, with no
   * timer). A late call reports `called` false and no cost: the call this read started is traced as "reader-late" when
   * it lands.
   */
  private async readAsk(
    s: Session,
    cue: Cue,
    ranked: readonly Scored[],
    chosen: Scored[],
    limit: number,
    waitMs: number,
    opts: ReadOpts = {},
  ): Promise<{
    chosen: Scored[];
    notes: Map<string, string>;
    kinds: Map<string, ReaderKind>;
    read: boolean;
    called: boolean;
    costUsd: number;
  } | null> {
    const reader = this.deps.reader!;
    const acts = (raw: string) => isImperative(raw, MORE_VERBS);
    const request = acts(cue.raw) ? cue.raw : s.request && acts(s.request.raw) ? s.request.raw : undefined;
    if (!request && !ASKS_BLOCKERS.test(cue.raw)) return null;
    const pool: Scored[] = [];
    const seen = new Set<string>();
    const cap = Math.max(0, Math.min(this.config.askReaderPool, READER_POOL_CAP));
    for (const x of ranked) {
      if (pool.length >= cap) break;
      if (seen.has(x.item.id)) continue;
      seen.add(x.item.id);
      pool.push(x);
    }
    // Whether the reader is shown every candidate the ask has (none cut by the pool's cap or the prompt's), so a
    // rejection of all of them is a reading of everything found (D114).
    let readsAll =
      pool.length <= READER_MAX_ITEMS &&
      ranked.every((x) => seen.has(x.item.id)) &&
      chosen.every((x) => seen.has(x.item.id));
    const t0 = performance.now();
    const report = (outcome: ReaderReport["outcome"], flagged: ReaderReport["flagged"] = []) =>
      this.deps.onReader?.({
        sessionId: s.id,
        checked: pool.length,
        pool: pool.map((x) => x.item.id),
        flagged,
        outcome,
        waitedMs: Math.round(performance.now() - t0),
      });
    if (pool.length === 0) {
      report("none");
      return null;
    }
    const main = request ?? cue.raw;
    const focus = readerFocus(main, cue.raw);
    const cards =
      this.config.cards && this.deps.cards
        ? this.deps.cards.cardsOf(
            s.scope,
            pool.map((x) => x.item.id),
            cue.arrived ?? this.now(),
          )
        : new Map();
    // `readerGate`: no call when none of the request's own candidates could constrain it: no card of a constraint kind
    // (or a state change or a thing done) and no constraint wording. Bulk mail never counts.
    if (this.config.readerGate && !pool.some((x) => this.constraintLike(x, cards))) {
      report("gated");
      return null;
    }
    // `readerReuse` (D193): an ask in the push's request reads the push's verdict, with no call of its own.
    const reuseAt = performance.now();
    const reused = opts.push ? null : await this.reusePush(s, pool, main, waitMs);
    // The session can close while the ask waits on the push's verdict: no call for it (audit A5).
    if (s.closed) return null;
    // The ask's own read, when there was nothing to reuse, waits only what is left of its wait.
    const readWaitMs = Number.isFinite(waitMs) ? waitMs - (performance.now() - reuseAt) : waitMs;
    // The likely deliveries are re-read while the reader reads (`verifyDelivery`): the delivery then waits on no call.
    // Only once the reader will read (D134): an empty pool or a gated ask has no reading to overlap, and its delivery
    // re-reads what it actually cites (`verifyItems`), so a re-read started ahead there is a connector call wasted.
    // `readerVerifyAfter` (D192) starts none here: only what the reader names and a delivery cites is re-read.
    if (!this.config.readerVerifyAfter && !reused) this.checkAhead(s, pool);
    const input: ReaderInput = {
      request: main,
      ...(request && cue.raw !== request ? { question: cue.raw } : {}),
      items: pool.map((x) => readerItem(x.item, focus, cards.get(x.item.id), this.config.askReaderItemChars)),
      today: localDay(this.now(), this.deps.cache.offsetOf(s.scope)),
      // Sticky routing to the provider that holds the user's cached prefix, as the judge, answer and cards calls do.
      cacheKey: userCacheKey(s.scope),
      ...(this.config.readerStopEarly ? { stopEarly: true } : {}),
    };
    // Who makes the call, for the accounting: a read that finds a verdict cached, or a call another read started
    // (an ask joining its push), makes none. Known before the read, for when this ask's wait runs out first.
    const fresh =
      !reused && reader.peek(s.scope, s.key, input) === undefined && !reader.inFlight(s.scope, s.key, input);
    // A paid call this ask could not wait for (the push's verdict came null with almost none of the wait left) is not
    // started: it would only buy a cached verdict (wave-1 review). A cached or joined verdict is still read.
    const tooLate = fresh && Number.isFinite(waitMs) && readWaitMs < Math.min(MIN_OWN_READ_MS, waitMs / 4);
    const starts = fresh && !tooLate;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reading: Promise<ReaderRead> = reused
      ? Promise.resolve(reused === "late" ? NO_READ : { ...NO_READ, verdict: reused.verdict })
      : tooLate
        ? Promise.resolve(NO_READ)
        : reader.read(s.scope, s.key, input, s.abort.signal);
    // The push's reading, for a later ask in the same request (`readerReuse`): its pool's items and their content.
    if (opts.push && this.config.readerReuse) {
      s.pushRead = {
        request: opts.request ?? s.requests,
        main,
        hashes: new Map(input.items.map((it) => [it.id, it.hash])),
        verdict: reading.then(
          (r) => r.verdict,
          () => null,
        ),
      };
    }
    let got: ReaderRead | "late";
    try {
      // An explicit ask stops waiting at `waitMs`; the push (Infinity) waits for the reading, with no timer left
      // pending, bounded by the reader's call and the session's close.
      got = tooLate
        ? "late"
        : reused
          ? reused === "late"
            ? "late"
            : await reading
          : Number.isFinite(waitMs)
            ? await Promise.race([
                reading,
                new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), Math.max(0, readWaitMs)))),
              ])
            : await reading;
    } catch {
      got = NO_READ;
    } finally {
      clearTimeout(timer);
    }
    // A late call is not this ask's to report (its `costUsd` 0, `called` false, so `AskResponse.usedModel` is false):
    // when the call this ask started lands, it gets a "reader-late" trace of its own with its cost, so a harness that
    // sums traces counts each call once. Emitted even if the session has closed by then: the call was paid for. A
    // read that joined another's call (`starts` false) leaves that call to the read that started it. A read the budget
    // refused, a cached one and a joined one made no call.
    if (got === "late" && starts) {
      const turn = s.turn;
      void reading.then(
        (r) => {
          if (!r.called) return;
          this.trace(s, {
            sessionId: s.id,
            turn,
            event: "ask",
            decision: "reader-late",
            reason: cue.id,
            latencyMs: Math.round(performance.now() - t0),
            sourceCalls: 0,
            modelCalls: 1,
            costUsd: r.costUsd,
            readerCalls: 1,
            readerCostUsd: r.costUsd,
            itemIds: [],
          });
        },
        () => undefined,
      );
    }
    const costUsd = got === "late" ? 0 : got.costUsd;
    const called = got === "late" ? false : got.called;
    const unchanged = {
      chosen,
      notes: new Map<string, string>(),
      kinds: new Map<string, ReaderKind>(),
      read: false,
      called,
      costUsd,
    };
    if (got === "late" || got.verdict === null) {
      report(got === "late" ? "late" : got.overBudget ? "budget" : "none");
      return unchanged;
    }
    const verdict = got.verdict;
    // A reused verdict read the push's pool: it read every candidate here only if each was in that pool, unchanged.
    if (reused && reused !== "late" && !reused.all) readsAll = false;
    const byId = new Map(pool.map((x) => [x.item.id, x]));
    const notes = new Map<string, string>();
    const kinds = new Map<string, ReaderKind>();
    const lead: Scored[] = [];
    for (const b of verdict.bears) {
      const x = byId.get(b.id);
      if (!x || lead.includes(x) || lead.length >= limit) continue;
      lead.push(x);
      notes.set(b.id, readerNote(b.kind, b.why));
      kinds.set(b.id, b.kind);
    }
    report(
      "read",
      verdict.bears.filter((b) => notes.has(b.id)).map((b) => ({ id: b.id, kind: b.kind })),
    );
    // `askReaderDrop`: what the reader read and rejected by name leaves the answer (never what it flagged).
    const rejected = this.config.askReaderDrop ? new Set(verdict.rejected ?? []) : new Set<string>();
    let rest = chosen.filter((x) => !lead.includes(x) && !rejected.has(x.item.id));
    // A drop that would leave the answer empty is made only when the reader read every candidate (D114): otherwise
    // the empty answer ("Nothing in the connected sources") would be a false all-clear over items it never read (D93).
    if (lead.length === 0 && rest.length === 0 && !readsAll) rest = chosen.filter((x) => !lead.includes(x));
    return {
      chosen: [...lead, ...rest].slice(0, limit),
      notes,
      kinds,
      read: true,
      called,
      costUsd,
    };
  }

  /**
   * `pushCandidates` (D236): the push's pool and its constraint-like gate. The pool `readAsk` would read (the first
   * `askReaderPool` distinct items of `ranked`) in its own order; per item, `readerGate`'s constraint test, cards
   * included. A pool with no constraint-like item gives no candidates, as `readerGate` would read none.
   */
  private pushGate(s: Session, cue: Cue, ranked: readonly Scored[]): PushGate {
    const pool: Scored[] = [];
    const seen = new Set<string>();
    const cap = Math.max(0, Math.min(this.config.askReaderPool, READER_POOL_CAP));
    for (const x of ranked) {
      if (pool.length >= cap) break;
      if (seen.has(x.item.id)) continue;
      seen.add(x.item.id);
      pool.push(x);
    }
    const cards =
      pool.length > 0 && this.config.cards && this.deps.cards
        ? this.deps.cards.cardsOf(
            s.scope,
            pool.map((x) => x.item.id),
            cue.arrived ?? this.now(),
          )
        : new Map<string, Card>();
    return { pool, like: pool.map((x) => this.constraintLike(x, cards)) };
  }

  /**
   * `pushCheck` (D500): the push check's answer for this pool, or null (off, unwired, no constraint-like item or no
   * request text). Waits at most `pushCheckWaitMs`; a check
   * that answers later is kept on the session, so a second pass over the same pool (`readerPushBehind`) reads it
   * with no call. The call runs on the session's signal: it ends with the session, not with the wait.
   */
  private async checkPush(s: Session, cue: Cue, gate: PushGate): Promise<PushCheckRead | null> {
    const checker = this.deps.checker;
    if (!this.config.pushCheck || !checker || !gate.like.some(Boolean)) return null;
    const request = sanitizeForStore(cue.raw);
    if (!request.trim()) return null;
    const focus = readerFocus(cue.raw);
    const read = gate.pool.slice(0, Math.min(this.config.pushCheckItems, CHECK_MAX_ITEMS));
    const input = {
      request,
      items: read.map((x) => readerItem(x.item, focus, undefined, this.config.pushCheckItemChars)),
      today: localDay(this.now(), this.deps.cache.offsetOf(s.scope)),
      cacheKey: userCacheKey(s.scope),
      ...(this.config.pushCheckRecall ? { recall: this.config.pushCheckRecall } : {}),
    };
    const key = checkKey(input);
    const asked = `${input.today}\n${request}`;
    const checks: Map<string, KeptCheck> = (s.pushChecks ??= new Map());
    // A settled check of this request that read every item of this pool, unchanged, answers it with no call: a second
    // pass (`readerPushBehind`) often only reorders the pool or drops an item.
    const items = input.items.slice(0, CHECK_MAX_ITEMS);
    for (const kept of checks.values()) {
      const yes = kept.settled?.yes;
      if (!yes || kept.asked !== asked || !items.every((it) => kept.marks.get(it.id) === itemMark(it))) continue;
      // An answer that named its most (5) may have left out items a fresh read of a smaller pool would name.
      if (yes.size >= 5 && items.length < kept.marks.size) continue;
      return {
        yes: new Set(items.filter((it) => yes.has(it.id)).map((it) => it.id)),
        costUsd: 0,
        called: false,
        overBudget: false,
      };
    }
    let kept = checks.get(key);
    const fresh = !kept;
    if (!kept) {
      const entry: KeptCheck = {
        asked,
        marks: new Map(items.map((it) => [it.id, itemMark(it)])),
        read: checker.check(s.scope, s.key, input, s.abort.signal),
      };
      void entry.read.then((r) => (entry.settled = r));
      kept = entry;
      checks.set(key, entry);
      while (checks.size > CHECK_KEPT) checks.delete(checks.keys().next().value as string);
    }
    const running = kept.read;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), this.config.pushCheckWaitMs);
    });
    try {
      const got = await Promise.race([running, late]);
      // A check this pass did not start (a second pass reading the first's) cost this pass nothing.
      if (got) return fresh ? got : { ...got, costUsd: 0, called: false };
      // Past the wait: the call goes on behind; the pass that started it traces it when it settles ("check-late"),
      // even after the session closed (the call was paid for), so traces sum to the calls made.
      if (fresh) {
        const t0 = performance.now();
        void running.then(
          (r) => r.called && this.traceCheck(s, r, t0),
          () => undefined,
        );
      }
      return { yes: null, costUsd: 0, called: false, overBudget: false, late: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** `pushCheck` (D500): a check's call that no push trace carries (late, or its session closed), traced alone. */
  private traceCheck(s: Session, r: PushCheckRead, t0: number): void {
    this.trace(s, {
      sessionId: s.id,
      turn: s.turn,
      event: "user_message",
      decision: "check-late",
      reason: "push check",
      latencyMs: Math.round(performance.now() - t0),
      sourceCalls: 0,
      modelCalls: 1,
      costUsd: r.costUsd,
      checkCalls: 1,
      checkCostUsd: r.costUsd,
      itemIds: [],
    });
  }

  /**
   * `pushCandidates` (D236): the push's candidates for the agent to judge, with no model call: the gate's pool, bulk
   * mail out, the first `pushCandidates` of them; none when no pooled item is constraint-like. (Constraint-like items
   * first lost 27 points of hidden facts live: D236.) With a `pushCheck` answer (D500), the pool's items it named
   * instead, in the pool's order, and none when it named none.
   */
  private candidatesOf(
    s: Session,
    cue: Cue,
    gate: PushGate,
    check: PushCheckRead | null = null,
  ): { items: Scored[]; pool: Scored[]; unsettled?: Anchors } {
    const { like } = gate;
    // A check that names nothing sends no packet (D500, silent, D828): that is how the push stays silent on a request
    // with nothing to add.
    const yes = check?.yes ?? null;
    const pool = gate.pool;
    const reported = pool;
    if (reported.length === 0) return { items: [], pool };
    const open = reported.filter((x) => !bulkMail(x.item));
    let items = yes
      ? open.filter((x) => yes.has(x.item.id)).slice(0, this.config.pushCandidates)
      : like.some(Boolean)
        ? open.slice(0, this.config.pushCandidates)
        : [];
    // `askNudge` (D316): the handed items hold none that names every kind of anchor the request has.
    let unsettled: Anchors | undefined;
    let anchors: Anchors | undefined;
    const fewer = this.config.pushCandidatesSettled;
    if ((this.config.askNudge || fewer > 0) && items.length > 0) {
      anchors = anchorsOf(cue.entities, cue.time?.days ?? null, cue.raw, cue.offset);
      const handed = items.map((x) => x.item);
      if (!settles(handed, anchors)) {
        if (this.config.askNudge && (!this.config.askNudgeDeep || this.anchoredPast(pool, items, anchors)))
          unsettled = anchors;
      } else if (fewer > 0) {
        // `pushCandidatesSettled` (D400, D404): a request its anchors settle gets fewer candidates, never losing the
        // first one that settles it.
        items = items.slice(0, settledCut(handed, anchors, fewer));
      }
    }
    // The arguments are built only when the lab's hook is wired (an optional call evaluates none otherwise).
    const read = anchors;
    this.deps.onPushPool?.({
      sessionId: s.id,
      pool: reported.map((x) => x.item.id),
      constraintLike: reported.length > like.length ? [...like, ...reported.slice(like.length).map(() => false)] : like,
      handed: items.map((x) => x.item.id),
      ...(this.config.askNudge ? { unsettled: unsettled !== undefined } : {}),
      ...(read
        ? {
            anchored: reported.map((x) => anchored(x.item, read)),
            anchorKinds: { entities: read.entities.length, day: hasDay(read) },
          }
        : {}),
      ...(this.config.pushCheck && this.deps.checker
        ? {
            // What the check said: an answer naming nothing is still "yes".
            check: yes ? "yes" : !check ? "none" : check.late ? "late" : "failed",
            ...(yes ? { checked: reported.map((x) => yes.has(x.item.id)) } : {}),
            ...(check?.called ? { checkCalled: true } : {}),
          }
        : {}),
    });
    return { items, pool, ...(unsettled ? { unsettled } : {}) };
  }

  /**
   * `askNudgeDeep` (D460, D461): whether the pool past the handed candidates holds an item the ask's deeper look would
   * list (not bulk mail, holding one of the request's anchors), judged on the pool's copies as ranked.
   */
  private anchoredPast(pool: readonly Scored[], handed: readonly Scored[], anchors: Anchors): boolean {
    const ids = new Set(handed.map((x) => x.item.id));
    return pool.some((x) => !ids.has(x.item.id) && !bulkMail(x.item) && anchored(x.item, anchors));
  }

  /** `planConflict` (D301): the request the push ran for, kept so items stored later are checked against it. */
  private noteActed(s: Session, cue: Cue): void {
    if (s.closed) return;
    const acted = (s.acted ??= []);
    acted.push(cue);
    if (acted.length > PLAN_REQUESTS) acted.shift();
    const key = scopeKey(s.scope);
    let set = this.acting.get(key);
    if (!set) this.acting.set(key, (set = new Set()));
    set.add(s);
  }

  private unact(s: Session): void {
    const key = scopeKey(s.scope);
    const set = this.acting.get(key);
    if (!set) return;
    set.delete(s);
    if (set.size === 0) this.acting.delete(key);
  }

  /**
   * `planConflict` (D301): items the sync just stored (a poll, a backfill page, a notice's payload) wait, per session
   * of their user with acting requests, for the session's next take (`checkPlans`): by then the item's card, made in
   * the background as it was stored, can say whether it constrains. No index or card work here, on the store's path.
   */
  private queuePlanConflicts(scope: Scope, items: readonly ContextItem[]): void {
    if (!this.config.planConflict || items.length === 0) return;
    const sessions = this.acting.get(scopeKey(scope));
    if (!sessions) return;
    for (const s of sessions) {
      if (s.closed) continue;
      const waiting = (s.planNew ??= new Set());
      for (const it of items) {
        if (bulkMail(it)) continue;
        waiting.delete(it.id);
        waiting.add(it.id);
        if (waiting.size > PLAN_WAITING) waiting.delete(waiting.values().next().value as string);
      }
    }
  }

  /**
   * `planConflict` (D301), at a take: the items stored since the last one, checked against the session's acting
   * requests. An item no packet has handed the session that would have been among such a request's candidates (the
   * first `pushCandidates` of its pool, `rank`'s first `askReaderPool` distinct items, bulk mail out, a pool with an
   * item that passes `readerGate`'s constraint test, its card included: `candidatesOf`'s rule) is queued, one packet
   * per request. Built at once from the cached copy, the one the source just gave
   * (nothing to re-read), except a copy a change signal has put in doubt, which waits for a later take. Said once per
   * session (`planSent`). Index lookups only: at most
   * `PLAN_REQUESTS` a take, and only when something new was stored.
   */
  private checkPlans(s: Session): void {
    const waiting = s.planNew;
    if (!this.config.planConflict || s.closed || !s.acted || !waiting || waiting.size === 0) return;
    const now = this.now();
    const sent = (s.planSent ??= new Set());
    // A copy a change signal has put in doubt since it was read (D126's `doubted`) waits for a later take, when the
    // poll the signal starts has stored the current one; a held-gone id is not in the cache. Once sent, never again.
    const fresh = new Set<string>();
    const later: string[] = [];
    for (const id of waiting) {
      const it = this.deps.cache.get(s.scope, id, now);
      if (!it || sent.has(id) || !s.ledger.isFresh(id, s.turn)) continue;
      if (this.config.verifyDelivery && this.doubted(s, it)) later.push(id);
      else fresh.add(id);
    }
    waiting.clear();
    for (const id of later) waiting.add(id);
    if (fresh.size === 0) return;
    const cap = Math.max(0, Math.min(this.config.askReaderPool, READER_POOL_CAP));
    const said = new Set<string>();
    for (const cue of s.acted) {
      const pool: Scored[] = [];
      const seen = new Set<string>();
      for (const x of this.rank(s, cue, { ignoreLedger: true })) {
        if (pool.length >= cap) break;
        if (seen.has(x.item.id)) continue;
        seen.add(x.item.id);
        pool.push(x);
      }
      // The candidates' rule (`candidatesOf`): the pool holds something that could constrain the request, and the new
      // item is among its first `pushCandidates` (bulk mail out), as it would have been had it been there then.
      const top = pool.filter((x) => !bulkMail(x.item)).slice(0, Math.max(1, this.config.pushCandidates));
      const hits = top.filter((x) => fresh.has(x.item.id) && !said.has(x.item.id));
      if (hits.length === 0) continue;
      const cards =
        this.config.cards && this.deps.cards
          ? this.deps.cards.cardsOf(
              s.scope,
              pool.map((x) => x.item.id),
              now,
            )
          : new Map<string, Card>();
      if (!pool.some((x) => this.constraintLike(x, cards))) continue;
      const bearing = hits;
      for (const x of bearing) {
        said.add(x.item.id);
        sent.add(x.item.id);
        if (sent.size > PLAN_SENT) sent.delete(sent.values().next().value as string);
      }
      // The user's own (redacted) words, on one line, their double quotes made single so the quote cannot be closed
      // and the rest read as Eden's voice.
      const lead = `${PLAN_LEAD} "${safeLine(head(cue.raw, PLAN_QUOTE_CHARS)).replace(/["“”]/g, "'")}"`;
      const packet = this.deliver(s, bearing, "proactive", `plan:${cue.id}`, cue, undefined, {
        lead,
        itemBytes: Math.min(this.config.compactItemBytes, MAX_CANDIDATE_BYTES),
        maxBytes: Math.max(this.config.maxInjectionBytes, 400 + PLAN_QUOTE_CHARS + bearing.length * 2_120),
      });
      s.pending.push(packet);
      this.trace(s, {
        sessionId: s.id,
        turn: s.turn,
        event: "source_change",
        decision: "sources",
        reason: packet.reason,
        latencyMs: 0,
        sourceCalls: 0,
        modelCalls: 0,
        costUsd: 0,
        itemIds: packet.citations.map((c) => c.itemId),
      });
    }
  }

  /** `pushCandidates` (D236): how the candidates' packet is framed and cut. */
  private candidateFrame(nudge = false): PacketFrame {
    // At most the pool's items (`candidatesOf`), each at most `MAX_CANDIDATE_BYTES`: the packet's size is bounded too.
    const k = Math.min(this.config.pushCandidates, this.config.askReaderPool, READER_POOL_CAP);
    const each = Math.min(this.config.compactItemBytes, MAX_CANDIDATE_BYTES);
    return {
      lead: nudge ? `${CANDIDATES_LEAD} ${ASK_NUDGE}` : CANDIDATES_LEAD,
      itemBytes: each,
      // Room for every candidate's excerpt and its `- [source] title: ` line, beyond the usual packet's cap.
      maxBytes: Math.max(this.config.maxInjectionBytes, 400 + k * (each + 120)),
    };
  }

  /**
   * `readerGate`'s test of one candidate: whether it could constrain a request (a card of a constraint kind, a state
   * change or a thing done, or constraint wording; an arranged visit with `readerGateVisits`). Bulk mail never does.
   */
  private constraintLike(x: Scored, cards: ReadonlyMap<string, Card>): boolean {
    if (bulkMail(x.item)) return false;
    const card = cards.get(x.item.id);
    if (card && (STANDING_KINDS.has(card.kind) || card.kind === "status-change" || card.kind === "already-done")) {
      return true;
    }
    const text = `${x.item.title}. ${x.item.text}`.toLowerCase();
    return mayConstrain(text) || (this.config.readerGateVisits && arrangedVisit(text));
  }

  /**
   * `readerReuse` (D193): the push's verdict for an ask made in the same request (no newer user message), cut
   * to the ask's pool: its bearings and rejections on items the push read with the same content. `all` says whether
   * the push read every candidate of this pool. "late" when the push's reading is not in within `waitMs`; null when
   * there is nothing to reuse (no push in this request, or it gave no verdict), and the ask reads as usual.
   */
  private async reusePush(
    s: Session,
    pool: readonly Scored[],
    main: string,
    waitMs: number,
  ): Promise<{ verdict: ReaderVerdict; all: boolean } | "late" | null> {
    if (!this.config.readerReuse || !this.config.readerPush) return null;
    const prior = s.pushRead;
    // Only an ask read against the push's own request: one that acts on its own is another request.
    if (!prior || prior.request !== s.requests || prior.main !== main) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const v = await Promise.race([
      prior.verdict,
      new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), Math.max(0, waitMs)))),
    ]).finally(() => clearTimeout(timer));
    if (v === "late") return "late";
    if (!v) return null;
    // An item the push flagged whose copy changed since it read it (the push's own re-read, D192, or another): its
    // bearing was of the old copy, so the ask reads the current one with a call of its own.
    const now = new Map(pool.map((x) => [x.item.id, cardKey(x.item)]));
    if (v.bears.some((b) => now.has(b.id) && now.get(b.id) !== prior.hashes.get(b.id))) return null;
    const same = new Set(pool.filter((x) => prior.hashes.get(x.item.id) === cardKey(x.item)).map((x) => x.item.id));
    return {
      verdict: {
        bears: v.bears.filter((b) => same.has(b.id)),
        rejected: (v.rejected ?? []).filter((id) => same.has(id)),
        checked: same.size,
      },
      all: same.size === pool.length,
    };
  }

  /**
   * `intent` (D87): an ask's pool with its intent hits fused in. The pool (its rule paths' order) and the intent hits
   * (their requests' order) are fused by weighted reciprocal rank, 1/(k+rank) for the pool and `intentWeight`/(k+rank)
   * for the intent list, ties in the pool's order. An item in both lists is kept once and scores both.
   */
  private fuseIntent(pool: Scored[], scored: readonly Scored[], intents: ReadonlyMap<string, IntentFind>): Scored[] {
    const k = ASK_FUSE_K;
    const w = this.config.intentWeight;
    const fused = new Map<Scored, { score: number; first: number }>();
    pool.forEach((x, i) => fused.set(x, { score: 1 / (k + i), first: i }));
    for (const x of scored) {
      const f = intents.get(x.item.id);
      if (!f) continue;
      const add = w / (k + f.rank);
      const e = fused.get(x);
      if (e) e.score += add;
      else fused.set(x, { score: add, first: pool.length + f.rank });
    }
    const order = [...fused].sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first).map(([x]) => x);
    return order;
  }

  /**
   * Explicit feedback from an integration that knows whether the agent used an injection. It wins over inference:
   * if usage was already inferred (or the injection already counted as unused), the recorded outcome is corrected.
   * Returns false when the injection is unknown (never handed out, or its session is gone).
   */
  feedback(f: Feedback): boolean {
    const scope = { tenantId: f.tenantId, userId: f.userId };
    const s = this.sessions.get(sessionKey(f));
    const o = s?.outstanding.get(f.injectionId);
    if (s && o) {
      s.outstanding.delete(f.injectionId);
      this.record(scope, f.injectionId, o.sourceIds, o.situation, f.used, { sessionId: f.sessionId, how: "explicit" });
      return true;
    }
    // The session may have ended (and counted the injection unused): the user's record outlives it.
    const r = this.recordedOf(scope)?.get(f.injectionId);
    if (!r) return false;
    if (r.used !== f.used) {
      for (const sourceId of r.sourceIds) this.deps.sourceMap.correctOutcome(scope, r.situation, sourceId, f.used);
      r.used = f.used;
      this.usage({
        sessionId: r.sessionId,
        injectionId: f.injectionId,
        used: f.used,
        how: "explicit",
        sourceIds: r.sourceIds,
      });
    }
    return true;
  }

  /**
   * A change notification for one of the user's sources (`syncPush`; the source says it `notifies`): the integrator
   * forwards a Gmail watch, a Calendar or Drive channel, a Slack event, a Graph subscription, a connector platform's
   * trigger. The source's synced copy is behind until the next lookup that reads it polls it; until then, and between
   * notifications, nothing polls it (at most `syncPushMaxStaleMs` apart). No I/O (but see `sourceNotice` for
   * `revisionNotice`'s background poll); false when push is off, or the source
   * is not synced for the user or does not say it notifies (`sourceNotice` says which).
   */
  sourceChanged(scope: Scope, sourceId: string): boolean {
    return this.sourceNotice(scope, sourceId).synced;
  }

  /**
   * `sourceChanged` with the reason a notification did not act (`SourceChangedResult`). With push on, the source's held
   * search pages are dropped whatever the sync says: a search-only notifying source, or one no lookup has synced yet,
   * has no sync state, and its held page would otherwise keep answering with the copy from before the change. Costs
   * at most one search on the next lookup that would have used the page. No I/O, O(1) beyond the drop, except with
   * `revisionNotice` (D205): a source a live session holds a handed copy from is polled in the background
   * (`pollRevised`: one listing call, at most one at a time per user and source, 30 s apart).
   */
  sourceNotice(scope: Scope, sourceId: string): SourceChangedResult {
    if (!this.config.syncPush || !this.sync) return { synced: false, reason: "push-off" };
    const took = this.sync.changed(scope, sourceId);
    // A held search page predates the change: the next lookup asks the source again.
    this.fanout.dropResults(scope, sourceId);
    if (took) this.pollRevised(scope, sourceId);
    return took ? { synced: true } : { synced: false, reason: this.sync.ignoredBecause(scope, sourceId) };
  }

  /**
   * Items a change notification carried (`syncPush`): a Slack event's message, a Graph notification's resource data, a
   * trigger's payload. They pass the secret gate and are stored as synced, with no source call. Items naming another
   * source are left out. Returns how many were new or changed; 0 when push is off or the source is not synced yet.
   */
  async sourceItems(scope: Scope, sourceId: string, items: ContextItem[]): Promise<number> {
    if (!this.config.syncPush || !this.sync || items.length === 0) return 0;
    const thawing = this.ready(scope); // D325: a frozen user is thawed in slices, not all at once on this put.
    if (thawing) await thawing;
    const own = items.filter((it) => it.sourceId === sourceId).slice(0, MAX_PUSHED_ITEMS);
    // The removal holding each id gone before the redaction (0: none). These items came after that removal, so they
    // revive it (D160).
    const seqBefore = new Map<string, number>();
    for (const raw of own) {
      const id = sanitizedId(raw);
      seqBefore.set(id, this.deps.cache.heldGoneSeq(scope, id, this.now()));
    }
    const redacted = await this.redact(own);
    // A removal (`sourceRemoved`) that landed during the await came after these items: it wins, so an id whose hold
    // changed (a new hold, or a second removal of an id already held) is neither revived nor stored (D160, D176). A
    // sequence, not a "held gone" flag: a second removal leaves the flag as it was. `sync.mark()` cannot tell either:
    // removals never bump it.
    const clean = redacted.filter((i) => {
      const seq = this.deps.cache.heldGoneSeq(scope, i.id, this.now());
      return seq === 0 || seq === seqBefore.get(i.id);
    });
    // The source has them (again): a deletion held earlier no longer stands.
    this.deps.cache.revive(
      scope,
      clean.map((i) => i.id),
    );
    const n = this.sync.ingest(scope, sourceId, clean);
    // The source changed whether or not it is synced (a search-only source stores nothing here): a held search page
    // predates these items.
    if (clean.length > 0) this.fanout.dropResults(scope, sourceId);
    return n;
  }

  /**
   * A deletion notification (`syncPush`): the source no longer has these refs (a message deleted or recalled, a doc
   * removed, an event deleted). They are dropped at once from the cache, the sync's bookkeeping, their cards and held
   * search pages, and held as gone for a while, so nothing delivers them again. Returns how many cached items
   * were dropped (ids held as gone but not cached count 0); 0 when push is off. No I/O.
   */
  sourceRemoved(scope: Scope, sourceId: string, refs: string[]): number {
    if (!this.config.syncPush || refs.length === 0) return 0;
    // By the id the cache keys the item by: a ref holding something the gate redacts is keyed by its hash.
    const ids = refs
      .slice(0, MAX_PUSHED_ITEMS)
      .map((ref) => sanitizedId({ id: itemId(sourceId, ref), sourceId, ref, title: "", text: "" }));
    return this.dropGone(scope, sourceId, ids);
  }

  /**
   * A change notification that names what changed but carries no content (D347, A18): the refs the source changed or
   * added (a Gmail history's message ids, a Graph or HubSpot webhook's resource id, a Drive changes list). Each ref is
   * re-read by its fetch in the background (within `REF_TIMEOUT_MS`; a guard's skip or a plain error goes again), a
   * lane of two at a time, and stored as synced under the read mark its call
   * began with; one the source no longer has (`gone`) is dropped. No other item of the source is put in doubt, so no
   * delivery re-reads them and no lookup polls the source for it: the same effect as a payload notice
   * (`sourceItems`), with the connector call made here instead of by the integrator. Until its re-read lands a named
   * cached item is in doubt (`doubted`), and a delivery waits on that read (`check`). A ref that could not be read
   * (no fetch tool, an error, a timeout, a guard's skip, a null that proves nothing) turns the notice into a plain
   * signal (`sourceNotice`): the source's copy is polled and its items re-read before delivery, as before (D126).
   * A source that is not synced and notifying takes the plain signal at once, with its reason. `settled` resolves to
   * how many items were stored new or changed.
   */
  sourceRefs(scope: Scope, sourceId: string, refs: string[]): SourceChangedResult & { settled: Promise<number> } {
    const sync = this.sync;
    if (!this.config.syncPush || !sync) return { synced: false, reason: "push-off", settled: Promise.resolve(0) };
    if (refs.length === 0 || !sync.notifying(scope, sourceId))
      return { ...this.sourceNotice(scope, sourceId), settled: Promise.resolve(0) };
    // A held search page predates the change: the next lookup asks the source again.
    this.fanout.dropResults(scope, sourceId);
    const user = scopeKey(scope);
    const named = [...new Set(refs)].slice(0, MAX_PUSHED_ITEMS).map((ref) => ({
      ref,
      id: sanitizedId({ id: itemId(sourceId, ref), sourceId, ref, title: "", text: "" }),
    }));
    // The read mark when the notice came: a signal after it makes a delivery read the item itself rather than reuse
    // this read (`check`), which may have answered before that newer change.
    const noticeMark = sync.mark();
    const settle = new Map<string, (o: CheckOutcome) => void>();
    for (const { id } of named) {
      const key = `${user}|${id}`;
      const outcome = new Promise<CheckOutcome>((r) => settle.set(key, r));
      const entry = { mark: noticeMark, outcome };
      this.refreshing.set(key, entry);
      void outcome.then(() => {
        if (this.refreshing.get(key) === entry) this.refreshing.delete(key);
      });
    }
    let signalled = false;
    // What could not be read is left to the plain signal, raised at its first failure and before that item's doubt
    // is lifted: the source is polled and its copies (that one included) re-read on delivery, as under D126.
    const fallback = () => {
      if (signalled) return;
      signalled = true;
      this.freshness.refsFallback++;
      this.sourceNotice(scope, sourceId);
    };
    // Still synced for this user (not forgotten, the sync not stopped): else the reads stop, storing nothing.
    const live = () => sync.notifying(scope, sourceId);
    const settled = (async (): Promise<number> => {
      let stored = 0;
      const done = (id: string, o: CheckOutcome, mark = noticeMark) => {
        if (o === "failed" || o === "flaked" || o === "skipped" || o === "unverifiable") fallback();
        // Only a changed copy: a pool's copy of a confirmed item is the cached one already.
        else if (o === "changed") this.noteRefReads(scope, [{ id, outcome: o, mark }]);
        settle.get(`${user}|${id}`)?.(o);
      };
      try {
        const source = (await this.deps.sources(scope).catch((): Source[] => [])).find((x) => x.id === sourceId);
        for (let k = 0; k < named.length; k += REF_LANES) {
          const lane = named.slice(k, k + REF_LANES);
          await Promise.all(
            lane.map(async ({ ref, id }) => {
              if (!source?.fetch) return done(id, "unverifiable");
              if (!live()) return done(id, "failed");
              let mark = sync.mark();
              let seq = this.deps.cache.heldGoneSeq(scope, id, this.now());
              let got = await this.fanout.fetchChecked(source, scope, ref, { timeoutMs: REF_TIMEOUT_MS });
              // Off the agent's path, a read our own guard skipped (the source's slots or rate tokens in use by a
              // lookup) waits and goes again, as does one plain error; an open breaker or a 429 does not.
              for (let t = 0; t < REF_TRIES && got.status === "failed" && refTryAgain(got) && live(); t++) {
                await Bun.sleep(REF_RETRY_MS * (t + 1));
                if (!live()) break;
                mark = sync.mark();
                seq = this.deps.cache.heldGoneSeq(scope, id, this.now());
                got = await this.fanout.fetchChecked(source, scope, ref, { timeoutMs: REF_TIMEOUT_MS });
              }
              this.freshness.refsRead++;
              if (got.status === "failed") return done(id, "failed");
              // D325: the drop or store below reads the user's items; a user frozen while the read was on the wire
              // is thawed in slices first, never inside the store (A24). The removal check below runs after it.
              const thawing = this.deps.cache.ready(scope);
              if (thawing) await thawing;
              if (!live()) return done(id, "failed");
              if (got.status === "gone") {
                this.dropGone(scope, sourceId, [id]);
                return done(id, "gone");
              }
              // A removal that landed while the fetch was on the wire wins (D160, D176): not revived, not stored.
              const now = this.now();
              const held = this.deps.cache.heldGoneSeq(scope, id, now);
              if (held !== 0 && held !== seq) return done(id, "gone");
              // The source's id and our id; the ref as the fan-out's gate left it (a raw ref may hold a secret, D10).
              const copy = { ...got.item, id, sourceId };
              this.deps.cache.revive(scope, [id]);
              const n = sync.ingest(scope, sourceId, [copy], mark);
              stored += n;
              return done(id, n > 0 ? "changed" : "confirmed", mark);
            }),
          );
        }
      } catch {
        fallback();
      } finally {
        // Anything not settled above (a throw) reads as not re-read, after the signal is raised.
        for (const { id } of named) settle.get(`${user}|${id}`)?.("failed");
      }
      return stored;
    })();
    return { synced: true, settled };
  }

  /**
   * Drops everything held for a user, or for one of their sources (a revoked connector): cached items, source-map
   * rows, and the user's live sessions (their windows and queued injections hold content). In-flight lookups are
   * aborted, and their results discarded.
   */
  forget(scope: Scope, sourceId?: string): void {
    const key = scopeKey(scope);
    for (const s of [...this.sessions.values()]) if (scopeKey(s.scope) === key) this.close(s, false);
    this.recorded.get(scope.tenantId)?.delete(key);
    this.deps.cache.forget(scope, sourceId);
    // Any forget drops the user's held outcomes (one source's ids are not told apart from the rest here).
    this.unverifiable.delete(key);
    this.deps.sourceMap.forget(scope, sourceId);
    this.fanout.forget(scope, sourceId);
    this.deps.planner?.forget(scope, sourceId);
    this.economy.forget(scope, sourceId);
    this.yields?.forget(scope, sourceId);
    this.sync?.forget(scope, sourceId);
    // A source's forget drops only what its items brought: the user's other items keep their cards.
    this.deps.cards?.forget(scope, sourceId);
    // The reader's bearings are made from the items' text: any forget, of the user or of one source, drops them.
    this.deps.reader?.forget(scope);
  }

  /** Users held and their states, for an operator's metrics (D992's `/metrics`): counts only. */
  held(): { users: number; frozen: number; warm: number; frozenBytes: number; sessions: number } {
    const c = this.deps.cache;
    return {
      users: c.userCount,
      frozen: c.frozenCount,
      warm: c.warmCount,
      frozenBytes: c.frozenBytes,
      sessions: this.sessions.size,
    };
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  // ── sessions ──

  private session(e: Scope & { sessionId: string }): Session {
    const key = sessionKey(e);
    const now = this.now();
    const existing = this.sessions.get(key);
    if (existing) {
      // Re-insert so Map order is least recently active first, for idle sweeps and eviction.
      this.sessions.delete(key);
      this.sessions.set(key, existing);
      existing.lastActive = now;
      return existing;
    }
    // Integrations do not always send session_end. Idle sessions are dropped, and each tenant has its own cap, so
    // one tenant opening sessions can never push out another's.
    for (const s of this.sessions.values()) {
      if (now - s.lastActive < this.config.sessionIdleMs) break;
      this.close(s, false);
    }
    if ((this.perTenant.get(e.tenantId) ?? 0) >= this.config.maxSessionsPerTenant) {
      for (const s of this.sessions.values()) {
        if (s.scope.tenantId !== e.tenantId) continue;
        this.close(s, false);
        break;
      }
    }
    const s: Session = {
      scope: { tenantId: e.tenantId, userId: e.userId },
      id: e.sessionId,
      key,
      turn: 0,
      requests: 0,
      traces: [],
      lastActive: now,
      window: [],
      agentHas: [],
      vocab: new Vocab(256),
      seen: new Set(),
      ledger: new Ledger(this.config.ledgerCooldownTurns),
      delivered: [],
      outstanding: new Map(),
      pending: [],
      cues: new Map(),
      situation: "general",
      inflight: null,
      abort: new AbortController(),
      closed: false,
    };
    this.sessions.set(key, s);
    const user = scopeKey(s.scope);
    let mine = this.userSessions.get(user);
    if (!mine) this.userSessions.set(user, (mine = new Set()));
    mine.add(s);
    this.perTenant.set(e.tenantId, (this.perTenant.get(e.tenantId) ?? 0) + 1);
    return s;
  }

  /**
   * Ends a session. `learn` is true only for a real session_end: then injections the agent never showed use of count
   * as unused. Eviction and forget learn nothing, since the session did not run its course.
   */
  private close(s: Session, learn: boolean): void {
    if (s.closed) return;
    s.closed = true;
    s.abort.abort();
    if (learn) {
      for (const [id, o] of s.outstanding) {
        this.record(s.scope, id, o.sourceIds, o.situation, false, { sessionId: s.id, how: "ended" });
      }
    }
    s.outstanding.clear();
    s.pending.length = 0;
    s.window.length = 0;
    s.agentHas.length = 0;
    this.deps.budget.endSession(s.key);
    // The reader reserves on a Budget of its own, by the same session key.
    this.deps.reader?.endSession(s.key);
    this.deps.checker?.endSession(s.key);
    this.sessions.delete(s.key);
    const user = scopeKey(s.scope);
    const mine = this.userSessions.get(user);
    if (mine?.delete(s) && mine.size === 0) this.userSessions.delete(user);
    this.unwatch(s);
    this.unact(s);
    const n = (this.perTenant.get(s.scope.tenantId) ?? 1) - 1;
    if (n <= 0) this.perTenant.delete(s.scope.tenantId);
    else this.perTenant.set(s.scope.tenantId, n);
  }

  private remember(s: Session, event: AgentEvent, text: string, terms: Uint32Array): void {
    if (!text) return;
    s.window.push(`${event.kind}: ${text.slice(0, 1_000)}`);
    if (s.window.length > this.config.windowEvents) s.window.shift();
    if (event.kind === "tool_result" || event.kind === "agent_message") {
      s.agentHas.push(heldOf(text, s.vocab));
      if (s.agentHas.length > this.config.windowEvents) s.agentHas.shift();
    }
    for (let i = 0; i < terms.length; i++) {
      const id = terms[i]!;
      s.seen.delete(id); // Re-insert so Set order is least recently seen first.
      s.seen.add(id);
    }
    while (s.seen.size > this.config.maxSeenTokens) s.seen.delete(s.seen.values().next().value as number);
  }

  private markCue(s: Session, cue: Cue): void {
    s.cues.delete(cue.key);
    s.cues.set(cue.key, s.turn);
    while (s.cues.size > this.config.maxCues) s.cues.delete(s.cues.keys().next().value as string);
  }

  // ── usage learning ──

  /** Starts usage tracking: from the moment the agent actually receives an injection, against what it had seen. */
  private handOut(s: Session, injection: Injection): void {
    const built = this.built.get(injection);
    // `sourceYield` (D505): an item of a source reached the agent, so the source's run of unused reads ends.
    if (built && this.yields && !s.closed) this.yields.used(s.scope, built.sourceIds, this.now());
    if (this.config.partyCheck && injection.reason !== "action-party" && injection.reason !== "ask") {
      this.notePacketParties(s, injection.text, injection.citations);
    }
    // Every path that gives the agent an injection comes through here: what it was shown is noted first, before the
    // usage tracking's early returns (an injection already tracked or recorded was still shown).
    if (built?.shown) {
      this.noteShown(s, built.shown.items, built.shown.text);
      built.shown = undefined;
    }
    if (built?.copies) {
      this.watchCopies(s, built.copies);
      built.copies = undefined;
    }
    if (!built || s.outstanding.has(injection.id)) return;
    if (this.recordedOf(s.scope)?.has(injection.id)) return;
    s.outstanding.set(injection.id, {
      injectionId: injection.id,
      sourceIds: built.sourceIds,
      situation: s.situation,
      tokens: (() => {
        const { ids, n } = termIds(built.text, s.vocab, true);
        return distinctiveTokens(ids, n, s.seen, s.vocab);
      })(),
      deliveredTurn: s.turn,
    });
    // Usage expires by turns, and only events move turns: a session that only asks would hold every answer forever.
    while (s.outstanding.size > MAX_OUTSTANDING) s.outstanding.delete(s.outstanding.keys().next().value as string);
    // The shape that retrieved each item learns it was worth delivering, once the agent has it (D18, D39).
    for (const i of built.items) this.deps.planner?.creditDelivery(s.scope, i.sourceId, i.id);
  }

  private checkUsage(s: Session, event: AgentEvent, terms: Uint32Array): void {
    const actsOnIt = event.kind === "agent_message" || event.kind === "tool_call";
    if (s.outstanding.size === 0) return;
    for (const [id, o] of s.outstanding) {
      const used = actsOnIt && showsUse(terms, o.tokens, s.vocab);
      const expired = s.turn - o.deliveredTurn > this.config.usageWindowTurns;
      if (!used && !expired) continue;
      s.outstanding.delete(id);
      const how = used ? "inferred" : "expired";
      this.record(s.scope, id, o.sourceIds, o.situation, used, { sessionId: s.id, how });
    }
  }

  private record(
    scope: Scope,
    injectionId: string,
    sourceIds: string[],
    situation: string,
    used: boolean,
    report: { sessionId: string; how: UsageRecord["how"] },
  ): void {
    this.usage({ sessionId: report.sessionId, injectionId, used, how: report.how, sourceIds });
    for (const sourceId of sourceIds) this.deps.sourceMap.recordOutcome(scope, situation, sourceId, used);
    const key = scopeKey(scope);
    const tenant = this.recorded.get(scope.tenantId) ?? new Map<string, Map<string, Recorded>>();
    this.recorded.set(scope.tenantId, tenant);
    const mine = tenant.get(key) ?? new Map<string, Recorded>();
    tenant.delete(key); // Re-insert: Map order is least recently recorded user first.
    tenant.set(key, mine);
    mine.set(injectionId, { sourceIds, situation, used, sessionId: report.sessionId });
    while (mine.size > MAX_RECORDED) mine.delete(mine.keys().next().value as string);
    while (tenant.size > MAX_RECORDED_USERS) tenant.delete(tenant.keys().next().value as string);
  }

  private recordedOf(scope: Scope): Map<string, Recorded> | undefined {
    return this.recorded.get(scope.tenantId)?.get(scopeKey(scope));
  }

  // ── retrieval ──

  /**
   * Scores cached items for a cue: idf-weighted query coverage, plus a bonus when the item names a cue entity as
   * whole terms ("Al" never matches "also"). Both come from the cache's index: the item's text is never rescanned.
   */
  private rank(s: Session, cue: Cue, options: { ignoreLedger?: boolean; probed?: string[] } = {}): Scored[] {
    const cache = this.deps.cache;
    const vocab = cache.peekVocab(s.scope);
    if (!vocab) return []; // No cache for this user: nothing to rank, and nothing allocated.
    const q = termIds(`${cue.text} ${cue.entities.join(" ")}`, vocab, false);
    const query: number[] = [];
    for (let i = 0; i < q.n; i++) if (!isStopword(vocab.term(q.ids[i]!))) query.push(q.ids[i]!);
    // Events on a day the request names are candidates whether or not they share its words (D44); they rank after
    // every item that does, so the judge, when there is one, sees them only if there is room.
    const timed = cue.time?.days.size ? cache.timed(s.scope, cue.time.days, this.now(), 30, cue.offset) : [];
    if (query.length === 0 && timed.length === 0 && !options.probed?.length) return [];
    const entities = cue.entities.map((e) => {
      // An entity with a term no cached item holds matches nothing (never intern it: that grows the cache's vocab).
      const all = termIds(e, s.vocab, true).n;
      const t = termIds(e, vocab, false);
      return t.n === all ? Array.from(t.ids.subarray(0, t.n)) : [];
    });
    // `quietNameOnly`: the request's words that are not part of the name of someone it names nor only say when (its
    // topic: a company, a place or a project it names counts), each checked against the item's terms in the index, so
    // a tie by a person's name alone can be told from one by what the request is about.
    let topic: number[] = [];
    const people = this.config.quietNameOnly ? this.peopleOf(s, cue) : [];
    if (people.length > 0) {
      const inNames = new Set<number>();
      for (const p of people) {
        const t = termIds(p, vocab, false);
        for (let i = 0; i < t.n; i++) inNames.add(t.ids[i]!);
      }
      topic = query.filter((id) => !inNames.has(id) && !TIME_WORD.test(vocab.term(id)));
    }
    const one = [0];
    const beyondOf = (doc: number) => {
      let n = 0;
      for (const id of topic) {
        one[0] = id;
        if (cache.containsAll(s.scope, doc, one, 1)) n++;
      }
      return n;
    };
    const found = query.length > 0 ? cache.search(s.scope, query, query.length, 12, this.now()) : [];
    for (const h of timed) if (!found.some((f) => f.item.id === h.item.id)) found.push(h);
    // The probes' finds for the request's people, organisations and day are candidates whatever they share in words.
    const probed = options.probed?.length ? cache.hits(s.scope, options.probed, this.now()) : [];
    for (const h of probed) if (!found.some((f) => f.item.id === h.item.id)) found.push(h);
    // `syncPollBehind`: an item delivered from a copy since edited at its source is news again, though the ledger has
    // it and its old words are near the new (D40: what the agent was given must not stand once superseded).
    const revised = new Set(
      this.config.syncPollBehind
        ? found.filter((h) => s.ledger.revised(h.item.id, versionOf(h.item), s.turn)).map((h) => h.item.id)
        : [],
    );
    return (
      found
        .filter((h) => options.ignoreLedger || revised.has(h.item.id) || s.ledger.isFresh(h.item.id, s.turn))
        // A near-duplicate of something already delivered this session (a reply quoting it, a synced copy) is old news.
        .filter(
          (h) => options.ignoreLedger || revised.has(h.item.id) || !s.delivered.some((d) => nearDuplicate(d, h.sketch)),
        )
        // What the agent already has in front of it (a tool result it fetched, its own read-out) is not news either.
        .filter((h) => options.ignoreLedger || !this.alreadyHas(s, h.item, h.doc, vocab))
        .map((h) => {
          const entityHit = entities.some(
            (ids) => ids.length > 0 && cache.containsAll(s.scope, h.doc, ids, ids.length),
          );
          const score = h.coverage + (entityHit ? this.config.entityBonus : 0);
          const scored: Scored = { item: h.item, matched: h.matched, score, sketch: h.sketch, doc: h.doc };
          if (people.length > 0) scored.beyond = beyondOf(h.doc);
          if (entityHit) scored.entity = true;
          if (revised.has(h.item.id)) scored.revised = true;
          return scored;
        })
        .sort((a, b) => b.score - a.score)
        // Of near-duplicates among the candidates, keep the best scored: one packet never says the same thing twice.
        // Occurrences of a recurring event read alike but are not the same thing: another day is another item.
        .filter(
          (x, i, all) =>
            !all
              .slice(0, i)
              .some(
                (y) =>
                  nearDuplicate(x.sketch, y.sketch) && startDay(x.item, cue.offset) === startDay(y.item, cue.offset),
              ),
        )
    );
  }

  private confident(scored: Scored[], cue: Cue): Scored[] {
    // One pass that stops at the cap: every test judges one item alone, so stopping early returns what filtering all
    // and then slicing returned. The cheap tests run first; `cleared` (the conflict test, about half the fast path's
    // CPU in pipeline.bench) and `beyondName` run only on what survives them, and only until the cap is reached.
    const cap = Math.min(this.config.maxItemsPerInjection, this.config.confidentItems);
    const sure: Scored[] = [];
    for (const x of scored) {
      if (sure.length >= cap) break;
      if (x.score < this.config.confidentScore || x.matched < this.config.minMatchedTerms) continue;
      // Bulk mail is never pushed without a model's say: a newsletter arriving is no reason to speak.
      if (bulkMail(x.item)) continue;
      // Nor, with `quietSettled`, an item that only says things stand as expected (`settled`); nor, with
      // `groundAway`, an absence on other days than the request names (`awayElsewhere`).
      if (this.config.quietSettled && settled(x.item)) continue;
      if (this.awayElsewhere(x.item, cue)) continue;
      // Nor, with `quietClear`, one about what the request names whose decisive value does not conflict with it.
      if (this.cleared(x, cue)) continue;
      // Nor, with `quietNameOnly`, one only a name ties to the request.
      if (!this.beyondName(x, cue)) continue;
      sure.push(x);
    }
    return sure;
  }

  /**
   * With no model's say, what the request's people and days ground (D44), from the item's structure rather than the
   * words it shares with the request:
   * - an item a person the request names takes part in (`namesParticipant`), when the request acts on someone
   *   (scheduling, writing to them, a task) or arrives from outside; on a named day or, for "the next", the earliest
   *   upcoming such item, else the best scored, nearer in time first;
   * - events on a day the request names that share a name with it ("a call on 12 November" from Globex Ventures
   *   finds "Globex <> Robin" that day), or, when the user asks what is on their calendar, every event that day.
   * Bulk mail is never grounded. Empty when nothing is.
   */
  private grounded(
    s: Session,
    cue: Cue,
    candidates: Scored[],
    eventKind: string,
    bridged: ReadonlySet<string> = new Set(),
    cls?: ActionClass,
    carded: ReadonlyMap<string, CardFind> = new Map(),
  ): { items: Scored[]; how: string } {
    const none = { items: [] as Scored[], how: "" };
    const pool = candidates.filter((x) => !bulkMail(x.item));
    const time = cue.time;
    const onDay = (x: Scored) => time !== null && time.days.has(startDay(x.item, cue.offset) ?? "");
    const upcoming = (x: Scored) => startMs(x.item) >= cue.at;
    const soonest = (a: Scored, b: Scored) => startMs(a.item) - startMs(b.item);
    const acts = this.acts(s, cue, eventKind);
    // A run that starts the sentence may carry the verb with it ("Email Dana Lee"): try it without its first word too.
    const people = cue.entities
      .flatMap((e) => {
        const w = e.trim().split(/\s+/);
        return w.length >= 3 ? [e, w.slice(1).join(" ")] : [e];
      })
      .filter((e) => e.includes("@") || e.trim().split(/\s+/).length >= 2);
    const meeting = ABOUT_MEETING.test(cue.raw);
    // Who is named is not enough to say which item: a meeting needs an event with them; anything else needs the
    // item to hold a word of the request beyond the person's name (the topic).
    const nameWords = (p: string) => p.trim().split(/\s+/).length;
    const fits = (x: Scored, p: string) => (meeting ? startDay(x.item) !== null : x.matched > nameWords(p));
    const withPerson = acts ? pool.filter((x) => people.some((p) => namesParticipant(p, x.item) && fits(x, p))) : [];
    // With probes on: an action on a named day at a named time, and an event already there near that time, is a clash
    // the agent should see before it acts, whoever the event is with.
    const clash = this.config.probes && !this.config.probeOff.includes("clash");
    const range = clash && time && time.days.size > 0 && isScheduling(cue.raw) ? requestedSpan(cue.raw) : null;
    if (range && time) {
      // An event in the time asked for, other than the one the request is about (D48).
      const near = (x: Scored) => {
        const m = startMinutes(x.item);
        return m !== null && overlaps(x.item, m, range) && !isSubject(x.item, cue.raw);
      };
      const clashes = pool.filter((x) => time.days.has(startDay(x.item, cue.offset) ?? "") && near(x)).sort(soonest);
      if (clashes.length > 0) return { items: clashes.slice(0, this.max()), how: "clash" };
    }
    // With `groundConflict`: what would change the action (or the answer), tied to what the request names or asks
    // (`conflict.ts`): a hold over the day it acts on, a limit below its amount, a thing done already (D49).
    if (this.config.groundConflict) {
      const hits = this.conflicts(cue, pool, bridged, cls);
      if (hits.length > 0) return { items: hits.slice(0, this.max()), how: "conflict" };
      // `cards`: an item whose card the request violates (a freeze over its day, an expiry before it, a limit under
      // its amount, a standing constraint on what it names), read by the model when the item arrived. At most
      // `cardItems`, the best tied first: a card is a model's reading, and one wrong one is noise.
      const byCard = pool
        .filter((x) => carded.get(x.item.id)?.violated)
        .sort((a, b) => cardRank(carded.get(b.item.id)!) - cardRank(carded.get(a.item.id)!))
        .slice(0, this.config.cardItems);
      if (byCard.length > 0) return { items: byCard, how: "card" };
    }
    // With `groundAway`: a person the request names, away on a day it names ("ask Jamie to feed the cat next weekend"
    // and Jamie's "away on Skye 6–9 Nov"), whatever the words: the agent should know before it asks them (D48).
    if (this.config.groundAway && time && time.days.size > 0) {
      const names = cleanEntities(cue.entities).filter((e) => !e.includes("@"));
      const away = pool.filter((x) => {
        const span = absenceSpan(x.item, cue.at);
        return (
          span !== null &&
          [...time.days].some((d) => d >= span.from && d <= span.to) &&
          names.some((n) => mentions(n, x.item))
        );
      });
      if (away.length > 0) return { items: away.slice(0, this.max()), how: "away" };
    }
    if (this.config.groundOccasion) {
      const occasion = this.occasion(cue, pool, eventKind, acts, meeting);
      if (occasion.items.length > 0) return occasion;
    }
    if (withPerson.length > 0) {
      const dated = withPerson.filter(onDay);
      if (dated.length > 0) return { items: [dated[0]!], how: "person-day" };
      if (time?.next) {
        const next = withPerson.filter(upcoming).sort(soonest);
        if (next.length > 0) return { items: [next[0]!], how: "person-next" };
      }
      // Equal scores: the one nearer in time (a meeting this week over one in March); undated items keep their order.
      const near = (x: Scored) => Math.abs((startMs(x.item) || cue.at) - cue.at);
      const byPerson = [...withPerson].sort((a, b) => b.score - a.score || near(a) - near(b));
      return { items: byPerson.slice(0, 1), how: "person" };
    }
    if (!time) return none;
    const events = pool.filter((x) => (time.days.size > 0 ? onDay(x) : time.next && upcoming(x)));
    // A title that holds a name the request uses whole ("Priya Raman talk"); one shared uncommon word ("Globex" for
    // "Globex Ventures") only from an arriving message naming a day, where the sender's name is what the event is filed
    // under ("your next payment" from Globex names no day, and no event). A
    // first name alone ("Elena" in "Robin / Elena 1:1") names the event only when the request is about meeting them:
    // "the agenda with Elena this week" asks for something other than the 1:1.
    const whole = meeting ? cue.entities : cue.entities.filter((e) => nameWords(e) >= 2);
    const named = events
      .filter((x) => {
        if (titleNames(whole, x.item) === "whole") return true;
        return eventKind === "external" && time.days.size > 0 && titleNames(cue.entities, x.item) === "word";
      })
      .sort(soonest);
    if (named.length > 0) {
      return { items: time.next && time.days.size === 0 ? [named[0]!] : named.slice(0, this.max()), how: "time-named" };
    }
    // The whole day only for a question about the calendar and nothing else ("what's on my calendar on Sunday?"): any
    // other word, even a lowercase first name ("the agenda with sam this week"), says the day's events are not all
    // that is asked.
    if ((eventKind === "user_message" || eventKind === "ask") && onlyTime(cue) && ASKS_SCHEDULE.test(cue.raw)) {
      return { items: events.sort(soonest).slice(0, this.max()), how: "time-schedule" };
    }
    return none;
  }

  /**
   * Whether a request acts on someone (scheduling, writing to them, a task) or arrives from outside.
   */
  private acts(s: Session, cue: Cue, eventKind: string): boolean {
    return eventKind === "external" || eventKind === "ask" || ACTING.has(s.situation) || ACTS_ON.test(cue.raw);
  }

  /**
   * The conflict ground's finds (`groundConflict`, D49): candidates about what the request names, tied beyond a name,
   * that `conflict.ts` says conflict with it, with the conflicting consequence finds (`bridged`).
   */
  private conflicts(cue: Cue, pool: Scored[], bridged: ReadonlySet<string>, cls: ActionClass | undefined): Scored[] {
    const hits = pool.filter(
      (x) => this.about(x, cue) && this.beyondName(x, cue) && this.verdict(x.item, cue) === "conflict",
    );
    // A consequence find that conflicts (`bridged`) is about the request by its class's words: for a class whose
    // constraints bind everyone (a change freeze, the user's own passport), whoever it names; for one whose bind one
    // party, when the request names no one or the find names someone it does: a legal hold on another client's
    // records is not this one's. The class's words are a tie beyond a name, so `quietNameOnly` does not gate it.
    const names = cleanEntities(cue.entities).filter((e) => !e.includes("@"));
    for (const x of pool) {
      if (!bridged.has(x.item.id) || hits.includes(x)) continue;
      if (cls?.scope === "general" || names.length === 0 || names.some((n) => mentions(n, x.item))) hits.push(x);
    }
    return hits;
  }

  /**
   * With `groundAway`, whether an item says someone is away only on days other than the ones the request names: no
   * reason, with no model's say, to raise it (the person is there then).
   */
  private awayElsewhere(item: ContextItem, cue: Cue): boolean {
    const time = cue.time;
    if (!this.config.groundAway || !time || time.days.size === 0) return false;
    const span = absenceSpan(item, cue.at);
    if (span === null || [...time.days].some((d) => d >= span.from && d <= span.to)) return false;
    // An item that names a day the request names is about that day too ("Offsite Fri 6 Nov … Sam is away 9-10 Nov").
    return !daysNamed(item, cue.at).some((d) => time.days.has(d)) && !time.days.has(startDay(item, cue.offset) ?? "");
  }

  /**
   * Each candidate's facts (`decide.ts`), as the rule paths read them, for the lab's candidate dump (`onCandidates`):
   * computed only when a harness wires it. CPU only; at most `decideCandidates` candidates, best scored first.
   */
  private factsOf(
    s: Session,
    cue: Cue,
    scored: Scored[],
    eventKind: string,
    ctx: {
      probed?: ReadonlySet<string>;
      bridged?: ReadonlySet<string>;
      carded?: ReadonlyMap<string, CardFind>;
    } = {},
  ): { x: Scored; facts: Facts }[] {
    const top = scored[0]?.score ?? 0;
    const days = cue.time?.days;
    const hasDays = days !== undefined && days.size > 0;
    const names = cleanEntities(cue.entities).filter((e) => !e.includes("@"));
    const people = cue.entities.filter((e) => e.includes("@") || e.trim().split(/\s+/).length >= 2);
    const acts = this.acts(s, cue, eventKind);
    const imperative = isImperative(cue.raw);
    const question = /\?\s*$/.test(cue.raw);
    const frame = this.frame(cue);
    const b = (v: boolean) => (v ? 1 : 0);
    return scored.slice(0, this.config.decideCandidates).map((x, rank) => {
      const item = x.item;
      const card = ctx.carded?.get(item.id);
      const day = startDay(item, cue.offset);
      const at = startMs(item);
      const span = hasDays ? absenceSpan(item, cue.at) : null;
      const verdict = this.verdict(item, cue);
      const beyondName = this.beyondName(x, cue);
      const about = this.about(x, cue);
      const unmeasured = unmeasuredLimit(frame, item);
      const facts: Facts = {
        score: x.score,
        matched: x.matched,
        rank,
        relScore: top > 0 ? x.score / top : 0,
        entity: b(x.entity === true),
        beyond: x.beyond ?? -1,
        beyondName: b(beyondName),
        about: b(about),
        conflict: b(verdict === "conflict"),
        clear: b(verdict === "clear"),
        conflictHit: b(
          verdict === "conflict" && about && beyondName && !bulkMail(item) && !settled(item) && !unmeasured,
        ),
        bulk: b(bulkMail(item)),
        settled: b(settled(item)),
        awayElsewhere: b(this.awayElsewhere(item, cue)),
        onNamedDay: b(hasDays && days!.has(day ?? "")),
        namesDay: b(hasDays && daysNamed(item, cue.at).some((d) => days!.has(d))),
        dated: b(day !== null),
        upcoming: b(day !== null && at >= cue.at),
        awayOnDay: b(
          span !== null &&
            [...days!].some((d) => d >= span.from && d <= span.to) &&
            names.some((n) => mentions(n, item)),
        ),
        probed: b(ctx.probed?.has(item.id) === true),
        bridged: b(ctx.bridged?.has(item.id) === true),
        carded: b(card !== undefined),
        cardViolated: b(card?.violated === true),
        cardByName: b(card?.tied === "name"),
        participant: b(people.some((p) => namesParticipant(p, item))),
        mentions: b(names.some((n) => mentions(n, item))),
        namesRef: b(namesRef(frame, item)),
        unmeasured: b(unmeasured),
        ageDays: day !== null ? Math.log1p(Math.abs(at - cue.at) / 86_400_000) : 0,
        acts: b(acts),
        imperative: b(imperative),
        question: b(question),
        hasDays: b(hasDays),
        external: b(cue.external === true),
      };
      return { x, facts };
    });
  }

  /** The lab's candidate dump (`onCandidates`), when it is wired: ids and numbers, no content. */
  private dump(
    s: Session,
    path: CandidateDump["path"],
    facts: { x: Scored; facts: Facts }[],
    delivered: readonly Scored[],
    how: string,
    pool?: string[],
  ): void {
    const sink = this.deps.onCandidates;
    if (!sink) return;
    sink({
      sessionId: s.id,
      turn: s.turn,
      path,
      candidates: facts.map((f) => ({ id: f.x.item.id, facts: f.facts })),
      delivered: delivered.map((x) => x.item.id),
      how,
      ...(pool ? { pool } : {}),
    });
  }

  /** The request's frame (`conflict.ts`), read once per cue. */
  private frame(cue: Cue): Frame {
    let f = FRAMES.get(cue);
    if (!f) {
      const names = cleanEntities(cue.entities).filter((e) => !e.includes("@"));
      // The user's wall clock, so "today" and a date's nearest year are their own (D44), as `cue.time.days` are.
      FRAMES.set(cue, (f = frameOf(cue.raw, cue.time?.days ?? null, localNow(cue), names, this.config.conflictVocab)));
    }
    return f;
  }

  /** What an item says about the request's frame: conflict, clear or none (`conflict.ts` `assess`). */
  private verdict(item: ContextItem, cue: Cue, ties?: ReadonlySet<string>): Verdict {
    return assess(this.frame(cue), item, localNow(cue), ties);
  }

  /**
   * Whether an item is about what the request names: a person or organisation it names, a reference it names
   * ("INV-5842"), or two of its terms. A conflict or a clearance is only read from such an item.
   */
  private about(x: Scored, cue: Cue): boolean {
    if (x.matched >= 2 || namesRef(this.frame(cue), x.item)) return true;
    return cleanEntities(cue.entities).some((e) => !e.includes("@") && mentions(e, x.item));
  }

  /**
   * With `quietNameOnly`, whether something besides a name ties an item to the request: a word of the request beyond
   * its names and time words, a day it names (the item's own, or one its text names), or a reference it names. A
   * passing mention ("Leila says hi by the way") ties every item of Leila's by her name alone, and no item by anything
   * else: with no model to ask, nothing is pushed. True when the flag is off.
   */
  private beyondName(x: Scored, cue: Cue): boolean {
    if (!this.config.quietNameOnly || x.beyond === undefined || x.beyond > 0) return true;
    // A message arriving from someone is their act, and a request to act on someone ("Book a table for me and Sam",
    // "Send Priya a hamper") is the user's: what bears on that person bears on the act (D44). Neither is a mention.
    if (cue.external || this.imperative(cue)) return true;
    const days = cue.time?.days;
    if (days && days.size > 0) {
      if (days.has(startDay(x.item, cue.offset) ?? "") || daysNamed(x.item, cue.at).some((d) => days.has(d)))
        return true;
    }
    return namesRef(this.frame(cue), x.item);
  }

  /** The people a request names: its names that someone in the user's items goes by (`ItemCache.isPerson`). */
  private peopleOf(s: Session, cue: Cue): string[] {
    return cleanEntities(cue.entities).filter((e) => !e.includes("@") && this.deps.cache.isPerson(s.scope, e));
  }

  /** Whether a request is in the imperative; with `conflictVocab`, by its wider verbs too (`MORE_VERBS`). */
  private imperative(cue: Cue): boolean {
    return isImperative(cue.raw, this.config.conflictVocab ? MORE_VERBS : undefined);
  }

  /** With `quietClear`, whether an item is about the request and says its decisive value does not conflict. */
  private cleared(x: Scored, cue: Cue): boolean {
    return this.config.quietClear && this.about(x, cue) && this.verdict(x.item, cue) === "clear";
  }

  private max(): number {
    return this.config.maxItemsPerInjection;
  }

  /**
   * `groundOccasion`: with no model's say, the event a request means by what its title says, the way people name
   * one: by the occasion and who it is with ("dinner with Elena", "push coffee with Kofi"), by the occasion and the
   * day ("where are we having lunch on Monday?"), or, for a message from someone about meeting ("running late, still
   * ok to meet?"), by the event that names them. An event's title holds the request's occasion word (a word of the
   * request other than a name, a date or a stopword) and every word of a name it uses, a first name alone included;
   * or, for a question, the occasion word on a day the request names; or, for a meeting message, the person's name.
   * The one on a day the request names wins, else the soonest still to come (with no day named, a past one is never
   * taken). A named day no such event is on grounds nothing. Only for a request that asks or acts.
   */
  private occasion(
    cue: Cue,
    pool: Scored[],
    eventKind: string,
    acts: boolean,
    meeting: boolean,
  ): { items: Scored[]; how: string } {
    const none = { items: [] as Scored[], how: "" };
    const asks = acts || /\?\s*$/.test(cue.raw) || isAction(cue.raw);
    if (!asks) return none;
    const time = cue.time;
    const names = cleanEntities(cue.entities)
      .filter((e) => !e.includes("@"))
      .map((e) => e.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((w) => w.length > 0 && w.every((x) => !TIME_WORD.test(x)));
    const inNames = new Set(names.flat());
    const kinds = (cue.raw.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []).filter(
      (w) => !inNames.has(w) && !isStopword(w) && !TIME_WORD.test(w) && !LEADING.has(w),
    );
    const titleWordsOf = (x: Scored) => new Set(x.item.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const events = pool.filter((x) => startDay(x.item) !== null);
    const onDay = (x: Scored) => time !== null && time.days.has(startDay(x.item, cue.offset) ?? "");
    const pick = (xs: Scored[], how: string, many = false) => {
      const dated = xs.filter(onDay).sort((a, b) => startMs(a.item) - startMs(b.item));
      if (dated.length > 0) return { items: many ? dated.slice(0, this.max()) : [dated[0]!], how: `${how}-day` };
      // A day the request names that no such event is on: the request may be about a new one ("an invite for drinks
      // Saturday"), or where one is going ("move my dinner to Friday"). Which is not for words to say: no ground.
      if (time !== null && time.days.size > 0) return none;
      const next = xs.filter((x) => startMs(x.item) >= cue.at).sort((a, b) => startMs(a.item) - startMs(b.item));
      return next.length > 0 ? { items: [next[0]!], how } : none;
    };
    const named = (t: Set<string>) => names.some((n) => n.every((w) => t.has(w)));
    // An occasion word that is a participant's name is a person the cue did not read as one (lowercase, "with elena").
    const kind = (x: Scored, t: Set<string>) => {
      const people = participantWords(x.item);
      return kinds.some((w) => t.has(w) && !people.has(w));
    };
    const withName = events.filter((x) => {
      const t = titleWordsOf(x);
      return named(t) && kind(x, t);
    });
    if (withName.length > 0) {
      const r = pick(withName, "occasion-person");
      if (r.items.length > 0) return r;
    }
    // By occasion and day alone only for a question about it: an action on a day's occasion ("send the pack before
    // next week's board meeting") is about the action, and the occasion standing as planned is no news.
    if (time !== null && time.days.size > 0 && names.length === 0 && /\?\s*$/.test(cue.raw)) {
      const r = pick(
        events.filter((x) => onDay(x) && kind(x, titleWordsOf(x))),
        "occasion",
        true,
      );
      if (r.items.length > 0) return r;
    }
    if (eventKind === "external" && meeting && names.length > 0) {
      return pick(
        events.filter((x) => named(titleWordsOf(x))),
        "occasion-sender",
      );
    }
    return none;
  }

  /**
   * With no model's say, the best candidate alone, if it is strong enough: several distinct query terms and a score
   * of at least `fallbackScore` (coverage plus the entity bonus, D36). One item at most: nothing has judged it.
   */
  private fallback(unsure: Scored[], cue?: Cue): Scored | null {
    const top = unsure[0];
    const c = this.config;
    if (!top || c.fallbackMatchedTerms <= 0 || (c.quietSettled && settled(top.item))) return null;
    if (cue && this.awayElsewhere(top.item, cue)) return null;
    if (cue && this.cleared(top, cue)) return null;
    // `fallbackAsks`: a request that asks (a question, or an action) about something it names, with an item that names
    // it too, needs two of its terms, not three. A question about the world at large ("a good stretch for back pain")
    // names nothing of the user's, and words like "good" or "week" match anything.
    const asks = cue !== undefined && c.fallbackAsks && (/\?\s*$/.test(cue.raw) || isAction(cue.raw));
    const named = asks ? cleanEntities(cue.entities).filter((e) => !e.includes("@")) : [];
    if (named.length > 0) {
      // The best of the first three that names what the request names: the top one may be about something else.
      const hit = unsure
        .slice(0, 3)
        .find(
          (x) =>
            named.some((e) => mentions(e, x.item)) &&
            !bulkMail(x.item) &&
            x.matched >= 2 &&
            x.score >= c.fallbackScore &&
            !(c.quietSettled && settled(x.item)) &&
            !this.awayElsewhere(x.item, cue!) &&
            !this.cleared(x, cue!) &&
            this.beyondName(x, cue!),
        );
      if (hit) return hit;
    }
    const strong = !bulkMail(top.item) && top.matched >= c.fallbackMatchedTerms && top.score >= c.fallbackScore;
    return strong && (!cue || this.beyondName(top, cue)) ? top : null;
  }

  /**
   * Whether one recent tool result or agent message holds every term of a cached item and every pair of adjacent
   * terms in its title and text: then the item adds nothing the agent has not fetched or said, and delivering it is a
   * repeat. A new term or a new pairing (11:30 where the agent saw 11:00 and, elsewhere in a day's listing, 9:30)
   * keeps it: a stale copy in the agent's hands is no reason to hold back the update. Items of under four terms are
   * never judged so, since a few common terms prove nothing.
   */
  private alreadyHas(s: Session, item: ContextItem, doc: number, vocab: Vocab): boolean {
    if (s.agentHas.length === 0) return false; // The common case: no agent output yet, no work.
    const own = this.deps.cache.termsOf(s.scope, doc);
    if (own.length < 4) return false;
    // Item terms are in the cache's vocabulary, held terms in the session's: map once, and a term the session has
    // never seen means no event holds it.
    const ids = new Array<number>(own.length);
    for (let i = 0; i < own.length; i++) {
      const id = s.vocab.lookup(vocab.term(own[i]!));
      if (id < 0) return false;
      ids[i] = id;
    }
    const holders = s.agentHas.filter((held) => ids.every((id) => sortedHas(held.terms, id)));
    if (holders.length === 0) return false;
    // Every term is known to the session now, so no term is skipped and adjacent ids are adjacent words.
    const pairs = [...pairsOf(item.title, s.vocab), ...pairsOf(item.text.slice(0, HELD_CHARS), s.vocab)];
    return holders.some((held) => pairs.every((p) => sortedHas(held.pairs, p)));
  }

  /**
   * Routes, searches the chosen sources live, caches what they return and records which entities they hold. Returns
   * the sources called and the planner's plans for this lookup alone: a session can run an ask and a slow path at once,
   * so plans are never kept on the session where the other could read them.
   */
  private async searchLive(
    s: Session,
    cue: Cue,
    limit: number,
    behind = false,
  ): Promise<{
    calls: number;
    plans?: Trace["plans"];
    probed?: string[];
    looked?: string[];
    consequence?: { cls: ActionClass; ids: string[] };
    /** With `sync`: sources answered from the local index, and listing calls of on-demand polls (in `calls`). */
    local?: number;
    syncCalls?: number;
    /**
     * How each source this lookup chose fared (D127): the fan-out's status, or "local" for one answered from the
     * synced index. A sync poll that failed leaves its source not current, so it is searched live and its status is
     * that search's; probes are extra queries beside a chosen source's own search, which gives the source's status.
     */
    sources?: SourceStatus[];
    /** The user's sources could not be resolved at all: nothing was searched, which is not an empty result. */
    unresolved?: true;
    /** The session ended before the search ran: nothing was searched, which is not an empty result either (D127). */
    closed?: true;
    /**
     * `askBehind` (D430): the chosen sources answered from a copy that was not whole (cut) or not current when the
     * lookup ran, whose poll or live search runs behind. Their "local" status stands only once that work is done.
     */
    behindLocal?: string[];
  }> {
    // Before any call: what this lookup stores was read under it, so a signal while it runs doubts it (D133).
    const readMark = this.sync?.mark() ?? 0;
    let unresolved = false;
    const all = await this.deps.sources(s.scope).catch((): Source[] => {
      unresolved = true;
      return [];
    });
    if (unresolved) return { calls: 0, sources: [], unresolved: true };
    if (s.closed) return { calls: 0, sources: [], closed: true };
    if (all.length === 0) return { calls: 0, sources: [] };
    // `routeLocalHits` (D265): which sources hold the request's best local matches, for routing. Only past the
    // lookup's own width: with as few sources as it searches, every one is searched whatever the order.
    const wide = all.length > Math.min(limit, this.config.lookupSources);
    const localHits = this.config.routeLocalHits && wide ? this.localRouteHits(s, cue) : undefined;
    const boost = addBoosts(
      localHits,
      // `routeSketch` (D322): the sources whose sketches hold the request's rarer terms, read or trimmed.
      this.config.routeSketch && wide ? this.sketchRouteHits(s, cue) : undefined,
    );
    // One deadline for the whole lookup (D140): the on-demand poll, the live search, the planner's cascade and the
    // probes share it. An ask with `askBehind` off waits for its poll, so a poll and a search with deadlines of their
    // own could hold the reader back twice `sourceTimeoutMs` (a listing that hangs, then the search that follows it).
    const deadlineAt = performance.now() + this.config.sourceTimeoutMs;
    const left = () => Math.max(0, deadlineAt - performance.now());
    // The background sync (D57): a source whose synced copy is current answers from the user's local index, at no
    // call; with `syncOnDemand`, a stale one is polled first (one listing call, rather than its search and probes).
    let local: Set<string> | null = null;
    let syncCalls = 0;
    let preRanked: ReturnType<SourceMap["route"]> | null = null;
    let pollable: Set<string> | null = null;
    let cutBehind: Set<string> | undefined;
    let probeLocal: Set<string> | null | undefined;
    // `sourceYield` (D505): the warm copies whose unused live reads are spent: no probe, no cut-copy poll, and on a
    // lookup that does not wait for its poll no search behind. A lookup that waits for its poll still searches a spent
    // cut copy with the rest (more reads, never fewer facts).
    const spent = this.spentSources(s, cue, all, boost);
    if (this.sync) {
      // `syncPollWidth` (D263): over that many sources, only the best routed are polled. The lookup is routed once,
      // here, before its poll, and searches the head of the same ranking, so every source it searches was polled
      // (two routes would draw apart: an ask then answered unpolled stale copies as "nothing", review of D263). Under
      // the width nothing changes: the route runs after the poll, as before, and draws as before.
      const width = this.config.syncOnDemand ? this.config.syncPollWidth : 0;
      if (width > 0 && all.length > width) {
        preRanked = this.deps.sourceMap.route({
          scope: s.scope,
          entities: cue.entities,
          situation: s.situation,
          sourceIds: all.map((x) => x.id),
          limit: Math.max(width, limit),
          ...(boost ? { boost } : {}),
        });
        pollable = new Set(preRanked.map((r) => r.sourceId));
      }
      if (this.config.syncOnDemand) {
        const signal = AbortSignal.any([s.abort.signal, AbortSignal.timeout(left())]);
        const freshening = this.spans?.open("sync.freshen", cue.span, { async: true });
        const tally = { fresh: 0 };
        // A spent copy the cap cut is not polled either: it is answered as held and named "unsearched". A whole copy
        // keeps its poll (a listing is no live read, and without it an ask would call the copy failed).
        const sync = this.sync;
        const skipPoll =
          spent && this.config.sourceYieldPolls ? (id: string) => spent.has(id) && !sync.complete(s.scope, id) : null;
        const toPoll = all.filter((x) => (!pollable || pollable.has(x.id)) && !(skipPoll && skipPoll(x.id)));
        const polled = this.sync.freshen(s.scope, toPoll, signal, tally, s.abort.signal).then((calls) => {
          if (freshening) this.spans!.close(freshening, { calls, fresh: tally.fresh, ...(behind ? { behind } : {}) });
          return calls;
        });
        // `syncPollBehind`: the poll is not waited for. This lookup answers from the index as it stands (every warm
        // synced source, current or not); if the poll stores anything, the lookup is made again once it is done
        // (`afterPoll`). The agent's ask waits for it only with `askBehind` off (D430); on, it runs behind too.
        if (behind) {
          // The poll's listing calls are in no lookup's trace (this one's is out before they are counted, and a
          // follow-up runs only when the poll stored something), so the poll gets a trace of its own when it settles:
          // "skipped", not "silent" (it decided nothing), and emitted even if the session has closed by then, as a
          // late reader call is ("reader-late"): the calls were made. A poll that only waited on another's made none.
          const turn = s.turn;
          const started = performance.now();
          cue.polled = polled
            .then((calls) => {
              if (calls > 0) {
                this.trace(s, {
                  sessionId: s.id,
                  turn,
                  event: "sync",
                  decision: "skipped",
                  reason: "sync poll behind",
                  latencyMs: Math.round(performance.now() - started),
                  sourceCalls: calls,
                  modelCalls: 0,
                  costUsd: 0,
                  itemIds: [],
                  syncCalls: calls,
                });
              }
              return tally.fresh > 0;
            })
            .catch(() => false);
        } else syncCalls = await polled; // `freshen` stops waiting at the deadline itself (D140, D283)
        if (s.closed) return { calls: syncCalls, syncCalls, sources: [], closed: true };
      }
      // `pushCutBehind` (D405): on a lookup that does not wait for its poll, a cut copy answers here too and is
      // searched behind (below); a follow-up reads what that search stored and starts none of its own.
      if (behind && this.config.pushCutBehind && this.config.syncLocalComplete) {
        cutBehind = new Set();
        local = this.localOf(s, all, behind, cutBehind);
        // The probes keep D264: they search a cut copy live and are not waited for (`probeGraceMs`).
        probeLocal = this.localOf(s, all, behind);
      } else local = this.localOf(s, all, behind);
      // A spent copy answers the probes from what is held too.
      if (spent && spent.size > 0) {
        const base = probeLocal === undefined ? local : probeLocal;
        probeLocal = new Set([...(base ?? []), ...spent]);
      }
    }
    // `askBehind` (D430): which copies answered here before they were whole or current (read once the route is known).
    const now0 = this.now();
    const notYet =
      cue.cutStatus && local && this.sync
        ? (id: string) => local!.has(id) && (cutBehind?.has(id) === true || !this.sync!.current(s.scope, id, now0))
        : null;
    const routing = this.spans?.open("route", cue.span);
    const ranked =
      preRanked?.slice(0, limit) ??
      this.deps.sourceMap.route({
        scope: s.scope,
        entities: cue.entities,
        situation: s.situation,
        sourceIds: all.map((x) => x.id),
        limit,
        ...(boost ? { boost } : {}),
      });
    if (routing) this.spans!.close(routing, { sources: ranked.length, local: local?.size ?? 0, syncCalls });
    const byId = sourcesById(all);
    const routed = ranked.map((r) => byId.get(r.sourceId)!).filter(Boolean);
    // A source routed on evidence of its items (a name it mentioned, the request's words among its held items), not on
    // the prior's draw or its sketch alone: what `cardsSourceAware` and `syncEngagedDeep` count as one the user uses.
    // A sketch match routes a search but engages no source: counted, it doubled the card calls at 1,000 sources for
    // no more hidden facts (a13-scale.md).
    this.engageSources(
      s,
      cue,
      ranked
        .filter((r) => r.entityHits > 0 || (localHits?.get(r.sourceId) ?? 0) > 0)
        // `sourceYieldEngage` (D601): a source this request reads nothing live of has not earned a deep copy, a
        // daily sweep or the card model either.
        .filter((r) => !(this.config.sourceYieldEarn && this.config.sourceYieldEngage && spent?.has(r.sourceId)))
        .map((r) => r.sourceId),
    );
    // Only the sources not answered locally are searched live; the local ones answer the same query below.
    const found = local ? routed.filter((x) => !local.has(x.id)) : routed;
    // Serving through the planner only in "serve" mode; in "shadow" the lookup is served as without one.
    const planner = this.deps.planner?.mode === "serve" ? this.deps.planner : undefined;
    // Wrapped per lookup (cheap: no state of its own). The fan-out admits each lookup per source id as before (breaker,
    // concurrency, one rate token); every extra call the planner makes takes its own rate token through `permit`, and
    // a shape's query answered recently comes from the fan-out's cache (`planCalls`), at no call.
    // A request about nothing but a time ("what's on my calendar on Sunday?") is sent as a listing of those days, with
    // no words: a calendar that filters by text and time together would find nothing for "calendar sunday" (D44).
    // Any other request keeps its words and no window: its days may be the new slot, not the item it is about.
    // A listing goes only to sources that list by time (a calendar): with no words, any other would return nothing, or
    // everything. With none such, the request is sent with its words as any other.
    const days = cue.time ? [...cue.time.days].sort() : [];
    const listers = onlyTime(cue) ? routed.filter((x) => x.listsByTime === true) : [];
    const listing = listers.length > 0;
    const window = listing
      ? {
          start: days[0]!,
          end: new Date(Date.parse(days.at(-1)!) + 86_400_000).toISOString().slice(0, 10),
          offsetMinutes: cue.offset,
        }
      : undefined;
    // The planner's cascade sends only the calls that can still answer by `deadlineAt`. A listing goes to each source
    // as it is: the planner's shapes are ways of sending words, and it has none.
    const spans = this.spans;
    const searchSpan = spans?.open("search", cue.span, { async: true, listing });
    // With spans on, each call a source answers is a child span of this search (`traced`).
    const sendTo = searchSpan ? (xs: Source[]) => xs.map((x) => this.traced(x, searchSpan.id)) : (xs: Source[]) => xs;
    // With `probeShare`: what the planner and the probes of this lookup send alike is sent once (`SharedCalls`).
    const shared: SharedCalls | undefined = this.config.probeShare ? new Map() : undefined;
    // A planned source's calls, as counted where they reach the connector (`made`), by its index in `chosen`.
    const planned: CountedPlanCalls[] = [];
    const chosen =
      planner && !listing
        ? sendTo(found).map((x) => {
            const via = this.fanout.planCalls(x, shared);
            planned.push(via);
            return new PlannedSource(x, planner, () => this.fanout.permit(s.scope, x.id), via, deadlineAt);
          })
        : listing
          ? sendTo(listers.filter((x) => !local?.has(x.id)))
          : sendTo(found);
    // Probes (`probe`) go out with the lookup, not after it: the slow path waits for the slower of the two, not both.
    // A probe that fails is no probe; a session that closes mid-search leaves it to finish on its own (it checks).
    // The lookup's own search starts first: the fan-out admits a call when it starts (a per-source concurrency slot),
    // and probes started before it could take the slots and leave the request itself skipped as busy.
    const query: SearchQuery = {
      scope: s.scope,
      text: listing ? "" : cue.text,
      entities: cue.entities,
      limit: 8,
      ...(window ? { window } : {}),
    };
    // A poll that used up the deadline leaves no time to search: each chosen source answers from the page the fan-out
    // holds for this query ("cached", or "stale" as a cut-off call would get), else is a timeout with no call. No rate
    // token, concurrency slot or breaker failure is spent on a call that could not answer (the probes' 50 ms).
    const searching =
      left() < MIN_SEARCH_MS
        ? Promise.resolve(
            chosen.map(
              (x): FanoutOutcome =>
                this.fanout.held(x.id, query) ?? { sourceId: x.id, status: "timeout", items: [], latencyMs: 0 },
            ),
          )
        : // What the poll left of the lookup's deadline (D140).
          this.fanout.search(chosen, query, { timeoutMs: left(), signal: s.abort.signal });
    const settled = searching.catch(() => null);
    // As the lookup's own search (D140, D148): with under `MIN_SEARCH_MS` left, no call that could not answer is sent.
    if (spent && cue.cutStatus && cutBehind) {
      // An ask names a copy it did not search (D127): never "local" for a cut copy.
      for (const id of spent) if (cutBehind.has(id)) cue.cutStatus.set(id, UNSEARCHED);
    }
    if (cutBehind && cutBehind.size > 0 && !cue.followUp && left() >= MIN_SEARCH_MS) {
      const behindOf = (listing ? listers : routed).filter((x) => cutBehind!.has(x.id) && !spent?.has(x.id));
      // Sent as the lookup's own search would be: through the planner's cascade (its shapes find what the request's
      // words alone miss), its calls counted where they reach the connector.
      const via: (CountedPlanCalls | undefined)[] = [];
      const behindChosen =
        planner && !listing
          ? sendTo(behindOf).map((x) => {
              const calls = this.fanout.planCalls(x, shared);
              via.push(calls);
              return new PlannedSource(x, planner, () => this.fanout.permit(s.scope, x.id), calls, deadlineAt);
            })
          : sendTo(behindOf);
      if (behindOf.length > 0) this.searchCutBehind(s, cue, behindChosen, via, query, deadlineAt, readMark);
    } else if (cue.cutStatus && cutBehind) {
      // `askBehind` (D430): no search behind was sent (too little of the deadline left, D148), so nothing is reading
      // these copies: "timeout" at once, never "searching" (whose answer promises what follows).
      for (const id of cutBehind) if (!cue.cutStatus.has(id)) cue.cutStatus.set(id, "timeout");
    }
    const probed: ProbeOut = { calls: 0, kept: [] };
    const probing = this.config.probes
      ? this.probe(s, cue, routed, all, listing, probed, settled, shared, {
          local: probeLocal === undefined ? local : probeLocal,
          deadlineAt,
          ...(boost ? { boost } : {}),
        }).catch(() => {})
      : null;
    // The same query answered by the synced sources from the local index (D57): no call, nothing to store.
    const answeredHere = local
      ? this.localAnswer(
          s,
          new Set((listing ? listers : routed).filter((x) => local!.has(x.id)).map((x) => x.id)),
          listing ? "" : cue.text,
          8,
          window,
        ).map((i) => i.id)
      : [];
    const outcomes = await searching;
    this.noteLiveRead(s, cue, outcomes);
    if (searchSpan) spans!.close(searchSpan, outcomeAttrs(outcomes));
    const plans = planner
      ? chosen.flatMap((x) => {
          const last = (x as PlannedSource).last;
          return last ? [{ sourceId: x.id, shapes: last.shapes, calls: last.calls, found: last.found }] : [];
        })
      : undefined;
    // The calls the connectors received: not a source answered by the fan-out's cache, one that joined another
    // lookup's call in flight (the slow path and `readerPush`'s ask search the same words at once), or one a guard
    // refused. A planned source counts the shape calls it sent that reached the connector (a cascade sends two).
    let made = 0;
    for (let k = 0; k < outcomes.length; k++) {
      const via = planned[k];
      made += via ? via.made : reachedSource(outcomes[k]!) ? 1 : 0;
    }
    // Each source the lookup chose, as it fared (D127): a listing goes to the sources that list by time, anything else
    // to every routed one; a synced source answered here from the local index, the rest by the fan-out's outcome.
    const statusOf = new Map(outcomes.map((o) => [o.sourceId, o.status]));
    const sources: SourceStatus[] = (listing ? listers : routed).map((x) => ({
      sourceId: x.id,
      status: local?.has(x.id) ? "local" : (statusOf.get(x.id) ?? "error"),
    }));
    const behindLocal = notYet ? sources.filter((x) => notYet(x.sourceId)).map((x) => x.sourceId) : undefined;
    const result = {
      calls: made + syncCalls,
      sources,
      ...(plans ? { plans } : {}),
      ...(this.sync ? { local: local?.size ?? 0, syncCalls } : {}),
      ...(behindLocal ? { behindLocal } : {}),
    };
    if (s.closed) return result; // Forgotten or ended mid-search: keep nothing.
    // One shadow lookup per session at a time: shadowing must not pile up work behind a slow connector.
    if (this.deps.planner?.mode === "shadow" && !s.shadowing) {
      const shadowSpan = spans?.open("shadow", cue.span, { async: true });
      s.shadowing = this.shadowLookup(s, found, cue, outcomes).finally(() => {
        s.shadowing = undefined;
        if (shadowSpan) spans!.close(shadowSpan);
      });
    }
    for (let k = 0; k < outcomes.length; k++) {
      const o = outcomes[k]!;
      // One source's items at a time, yielding between: storing a lookup's items (tokenizing, indexing, sketching) is
      // ~80 µs each, and other users' events should not wait behind all of them at once.
      if (k > 0) await yieldToLoop();
      if (s.closed) return result;
      // Mentions are recorded for items new to the cache or changed, so an item many lookups return is not counted
      // each time (that let one item dominate routing, and was ~10% of server CPU). They are written with the put,
      // before the next yield: a session closing in between must not leave items cached whose mentions never land.
      this.store(s, o.items, cue.span ?? 0, false, readMark);
    }
    if (probing) {
      const graceSpan = spans?.open("probes.grace", cue.span, { async: true });
      // The lookup waits at most `probeGraceMs` past its own search for the probes: a slow probe must not hold up
      // what the lookup found. One still running finishes on its own and caches what it finds for later turns; this
      // lookup ranks what the probes found by then, and counts the calls they had sent.
      const grace = this.config.probeGraceMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([probing, new Promise<void>((done) => (timer = setTimeout(done, grace)))]);
      clearTimeout(timer);
      if (graceSpan) spans!.close(graceSpan);
      // What the request's own search returned, beside the probes' finds: an item both found is twice supported.
      const looked = [...outcomes.flatMap((o) => o.items.map((i) => i.id)), ...answeredHere];
      // What the lookup's own search found too is not a probe's contribution (`probeYield`).
      if (this.config.probeYield) this.economy.claimed(s.scope, looked);
      return {
        ...result,
        calls: result.calls + probed.calls,
        probed: probed.kept.slice(0, 20),
        looked,
        ...(probed.consequence ? { consequence: probed.consequence } : {}),
      };
    }
    return result;
  }

  /**
   * `sourceYield` (D505): the user's warm synced copies this request skips live reads of (no probe, no cut-copy
   * poll, no search behind; a lookup that waits for its poll still searches a spent cut copy): a source whose own run
   * of reads with nothing used has reached `sourceYieldRun` (never for a request that names an entity the source
   * mentioned), or, with `sourceYieldEarn` (D600, D603), one with no item ever used that the request has no strong
   * evidence for. Only a warm copy: it answers from what is held, where a source with no copy would answer nothing.
   * Null when the switch is off or no source is spent.
   */
  private spentSources(
    s: Session,
    cue: Cue,
    all: readonly Source[],
    boost: ReadonlyMap<string, number> | undefined,
  ): Set<string> | null {
    const c = this.config;
    // `sourceYieldEarn` (D600) acts from a user's first request: nothing has been read yet, and nothing has earned.
    if (!this.yields || !this.sync || (!c.sourceYieldEarn && this.yields.size(s.scope) === 0)) return null;
    const now = this.now();
    const evidence = this.evidenceFor(s, cue, boost);
    let out: Set<string> | null = null;
    for (const x of all) {
      const kind = evidence(x.id);
      const run = this.yields.run(s.scope, x.id, now);
      const limit = kind === 2 ? 0 : c.sourceYieldRun;
      // Half a read of slack: a run decays from the moment of its last read, so 4 reads read 3.999 a minute later.
      const spent =
        (limit > 0 && run > limit - 0.5) || (c.sourceYieldEarn && kind < 2 && !this.yields.hasYielded(s.scope, x.id));
      if (spent && this.sync.isWarm(s.scope, x.id)) (out ??= new Set()).add(x.id);
    }
    return out;
  }

  /**
   * `sourceYield` (D505): what the request has for a source: 2, it names an entity the source's items mentioned (the
   * source map); 1, its words are among the source's held items or in its sketch (`boost`); 0, nothing. With
   * `sourceYieldEarn` (D600) a word of the request that few of the user's sources hold counts as a name (2), and
   * with `sourceYieldNames` (D601) a name many of them mention counts only for a source with an item used.
   */
  private evidenceFor(s: Session, cue: Cue, boost: ReadonlyMap<string, number> | undefined): (id: string) => Evidence {
    let named: Set<string> | undefined;
    return (id) => {
      if (!named) {
        named = new Set();
        // `sourceYieldNames` (D601): a name more sources than that mention says little about any one of them; it
        // stays evidence for a source that has had an item used (the user's own mailbox names most people).
        const common = this.config.sourceYieldEarn ? this.config.sourceYieldNames : 0;
        for (const e of cue.entities) {
          const holders = this.deps.sourceMap.sourcesFor(s.scope, e);
          const weak = common > 0 && holders.length > common;
          for (const m of holders) if (!weak || this.yields?.hasYielded(s.scope, m.sourceId)) named.add(m.sourceId);
        }
        if (this.config.sourceYieldEarn && this.config.sourceYieldRare > 0 && this.sync) {
          const terms = sketchTerms(`${cue.text} ${cue.entities.join(" ")}`).slice(0, MAX_SKETCH_TERMS);
          const rare = this.sync.rareHolders(s.scope, terms.map(termHashes), this.config.sourceYieldRare);
          for (const id of rare) named.add(id);
        }
      }
      return named.has(id) ? 2 : (boost?.get(id) ?? 0) > 0 ? 1 : 0;
    };
  }

  /**
   * `sourceYield` (D505): books a live read against each source that answered one, once a source a turn: the push,
   * its probes and an ask of the same turn often join one call. Only an answer counts ("ok": the connector was
   * called and replied): a failure, a timeout or a guard's refusal says nothing about what the source holds, and a
   * page from the fan-out's cache was no call. Only a warm copy's source: no other is ever skipped, so its run
   * would count reads the rule cannot act on.
   */
  private noteLiveRead(s: Session, cue: Cue, outcomes: readonly FanoutOutcome[]): void {
    if (!this.yields || !this.sync || s.closed) return;
    if (s.liveReads?.turn !== s.turn) s.liveReads = { turn: s.turn, ids: new Set() };
    const seen = s.liveReads.ids;
    const fresh: string[] = [];
    for (const o of outcomes) {
      if (o.status !== "ok" || seen.has(o.sourceId) || !this.sync.isWarm(s.scope, o.sourceId)) continue;
      seen.add(o.sourceId);
      fresh.push(o.sourceId);
    }
    if (fresh.length === 0) return;
    this.yields.read(s.scope, fresh, this.now());
  }

  /**
   * `pushCutBehind` (D405): the live search D264 makes of cut copies, run behind a lookup that answered them from the
   * index. Same query, same deadline, same fan-out (breaker, rate, a call in flight joined). What it returns is stored
   * as the lookup's own finds are, and it joins `cue.polled`: if it stored anything new, the lookup's follow-up and
   * the push's second reading run on the index it refreshed. Its calls get a trace of their own when it settles, as a
   * poll behind does. Never throws.
   */
  private searchCutBehind(
    s: Session,
    cue: Cue,
    sources: Source[],
    via: readonly (CountedPlanCalls | undefined)[],
    query: SearchQuery,
    deadlineAt: number,
    readMark: number,
  ): void {
    const turn = s.turn;
    const started = performance.now();
    const span = this.spans?.open("search.behind", cue.span, { async: true, sources: sources.length });
    const opts = { timeoutMs: Math.max(0, deadlineAt - performance.now()), signal: s.abort.signal };
    // `askBehind` (D430): one source at a time (the same calls as one fan-out), each stored as it settles and its
    // outcome noted only then, so an ask that stops waiting ranks every source it calls answered on what it found.
    const each = cue.cutStatus;
    let early = 0;
    const searching = each
      ? Promise.all(
          sources.map((x) =>
            this.fanout.search([x], query, opts).then(([o]) => {
              if (!s.closed) early += this.store(s, o!.items, cue.span ?? 0, false, readMark);
              each.set(o!.sourceId, o!.status);
              return { ...o!, items: [] };
            }),
          ),
        )
      : this.fanout.search(sources, query, opts);
    // On the ask's path the outcomes come back with no items: each page was stored above as its source answered.
    const work = searching
      .then(async (outcomes) => {
        let made = 0;
        for (let k = 0; k < outcomes.length; k++) made += via[k] ? via[k]!.made : reachedSource(outcomes[k]!) ? 1 : 0;
        this.noteLiveRead(s, cue, outcomes);
        if (span) this.spans!.close(span, outcomeAttrs(outcomes));
        if (made > 0) {
          this.trace(s, {
            sessionId: s.id,
            turn,
            event: "search",
            decision: "skipped",
            reason: "cut search behind",
            latencyMs: Math.round(performance.now() - started),
            sourceCalls: made,
            modelCalls: 0,
            costUsd: 0,
            itemIds: [],
          });
        }
        let fresh = early;
        for (let k = 0; k < outcomes.length; k++) {
          if (k > 0) await yieldToLoop();
          if (s.closed) return false;
          fresh += this.store(s, outcomes[k]!.items, cue.span ?? 0, false, readMark);
        }
        return fresh > 0;
      })
      .catch(() => false);
    const before = cue.polled;
    cue.polled = before ? Promise.all([before, work]).then(([a, b]) => a || b) : work;
  }

  /**
   * The checks a request implies but does not ask for (`probes.ts`): its people, their organisations and its topic as
   * short queries, and the day an action names listed from sources that list by time. Their items are cached as the
   * lookup's are; the ids found for people, organisations and the day are returned for this lookup alone to rank and
   * seat with the judge (never kept on the session, where a later turn or a concurrent ask would see them). At most
   * `probeCalls` source calls, all within one `sourceTimeoutMs` deadline: the day, the people and the topic go out
   * together, the organisation after the people it is read from.
   */
  private async probe(
    s: Session,
    cue: Cue,
    found: Source[],
    all: Source[],
    listed: boolean,
    out: ProbeOut,
    searched: Promise<unknown>,
    shared?: SharedCalls,
    opts: ProbeOpts = {},
  ): Promise<void> {
    // Before the probes' calls: what they store was read under it (D133).
    const readMark = this.sync?.mark() ?? 0;
    const lanes = new Map<string, Promise<unknown>>();
    const budget = opts.budget ?? this.config.probeCalls;
    const local = opts.local ?? null;
    const spans = this.spans;
    const probesSpan = spans?.open("probes", cue.span, { async: true });
    // Calls the consequence probe made (outside `budget`).
    let extra = 0;
    const deadline = opts.deadlineAt ?? performance.now() + this.config.sourceTimeoutMs;
    const kept = out.kept;
    const send = async (
      kind: ProbeKind,
      sources: Source[],
      text: string,
      window?: SearchQuery["window"],
      keep = true,
      onAnswer?: (sourceId: string, page: ContextItem[]) => void,
    ): Promise<ContextItem[]> => {
      if (!spans) return sendOne(kind, sources, text, window, keep, onAnswer, 0);
      const sp = spans.open(`probe.${kind}`, probesSpan!.id, { async: true, sources: sources.length });
      const callsBefore = out.calls;
      try {
        return await sendOne(kind, sources, text, window, keep, onAnswer, sp.id);
      } finally {
        spans.close(sp, { calls: out.calls - callsBefore });
      }
    };
    const sendOne = async (
      kind: ProbeKind,
      sources: Source[],
      text: string,
      window: SearchQuery["window"] | undefined,
      keep: boolean,
      onAnswer: ((sourceId: string, page: ContextItem[]) => void) | undefined,
      parent: number,
    ): Promise<ContextItem[]> => {
      // Synced sources whose copy is current answer from the local index (D57), at no call and outside `probeCalls`.
      let here: ContextItem[] = [];
      if (local) {
        const mine = new Set(sources.filter((x) => local.has(x.id)).map((x) => x.id));
        sources = sources.filter((x) => !local.has(x.id));
        if (mine.size > 0) {
          here = this.localAnswer(s, mine, text, window ? 20 : 5, window);
          if (keep) for (const i of here) if (!kept.includes(i.id)) kept.push(i.id);
        }
        if (sources.length === 0) return here;
      }
      const ids = sources.map((x) => x.id);
      const key = `${text}|${window ? `${window.start}/${window.end}` : ""}|${ids.join(",")}`;
      // Probed recently by this user (any of their sessions): its finds at no call, while every one is still cached.
      const hits = this.deps.cache.probeHits(s.scope, key, this.config.probeMemoMs, this.now());
      if (hits) {
        if (keep) for (const h of hits) if (!kept.includes(h.item.id)) kept.push(h.item.id);
        return [...here, ...hits.map((h) => h.item)];
      }
      // The probe economy (`economy.ts`): a source whose answer to this query has likely not changed, or where this
      // kind of probe has not been yielding, is not called; its last answer, while still cached, stands in.
      const asked = `${text}|${window ? `${window.start}/${window.end}` : ""}`;
      const reused: ContextItem[] = [];
      let live = sources;
      if (this.config.probeFresh || this.config.probeYield) {
        live = [];
        const now = this.now();
        for (const source of sources) {
          const unchanged =
            this.config.probeFresh &&
            this.economy.changeChance(s.scope, source.id, asked, now) < this.config.probeFreshFloor;
          const idle =
            !unchanged &&
            this.config.probeYield &&
            !this.economy.worth(s.scope, kind, source.id, this.config.probeYieldFloor);
          const last = unchanged || idle ? this.economy.lastIds(s.scope, source.id, asked) : null;
          const held = last ? this.deps.cache.hits(s.scope, last, now) : [];
          // Unchanged but no longer cached: asked again, since nothing stands in for it.
          if (!idle && (!unchanged || !last || held.length < last.length)) {
            live.push(source);
            continue;
          }
          for (const h of held) reused.push(h.item);
        }
        if (keep) for (const i of reused) if (!kept.includes(i.id)) kept.push(i.id);
      }
      // The consequence probe is bounded by its own `consequenceSources`, on top of `probeCalls`: it must never take
      // the calls an organisation probe, sent after the people it is read from, would need.
      const own = kind === "consequence";
      const to = own ? live : live.slice(0, Math.max(0, budget - (out.calls - extra)));
      if (to.length === 0 || s.closed || deadline - performance.now() < 50) return [...here, ...reused];
      out.calls += to.length;
      if (own) extra += to.length;
      // A day's listing is the whole day (a busy one has more than a search's page); a query, its first page.
      const query = {
        scope: s.scope,
        text,
        entities: text ? [text] : [],
        // Shared with the planner's queries (`probeShare`), its page size: either may answer for the other.
        limit: window ? 20 : shared ? 8 : 5,
        ...(window ? { window } : {}),
      };
      const attempt = async (source: Source): Promise<FanoutOutcome | null> => {
        const left = deadline - performance.now();
        if (s.closed || left < 50) return null;
        // The planner sent the same query to this source in this lookup: its answer, at no call.
        const sk = shared && !window ? sharedKey(source.id, query) : "";
        const had = sk ? shared!.get(sk) : undefined;
        if (had) {
          const items = await had.catch(() => null);
          if (items) return { sourceId: source.id, status: "cached", items, latencyMs: 0 };
        }
        const run = this.fanout.search([parent ? this.traced(source, parent) : source], query, {
          timeoutMs: left,
          signal: s.abort.signal,
        });
        if (sk) {
          const answered = new Set(["ok", "cached", "stale"]);
          shared!.set(
            sk,
            run.then(([o]) => (o && answered.has(o.status) ? o.items : null)),
          );
        }
        const [o] = await run;
        return o ?? null;
      };
      // One probe call per source at a time, in this lookup: with the lookup's own call, that is two, the fan-out's
      // starting concurrency per source. One skipped as busy anyway (another lookup of the user's holds the slots)
      // is tried once more when the lookup's own search is done.
      const one = (source: Source) => {
        const run = (lanes.get(source.id) ?? Promise.resolve()).then(async () => {
          const o = await attempt(source);
          if (o?.status !== "busy") return o;
          await searched;
          return attempt(source);
        });
        lanes.set(
          source.id,
          run.catch(() => null),
        );
        return run;
      };
      const outcomes = (await Promise.all(to.map(one))).filter((o): o is FanoutOutcome => o !== null);
      this.noteLiveRead(s, cue, outcomes);
      // A page of the probe's own size from each source, even when the call was the planner's (8 items): more would
      // crowd the probes' seats with the judge (live, the judge passed fewer planted items with them).
      const items = outcomes.flatMap((o) => o.items.slice(0, window ? 20 : 5));
      const whole = window ? 20 : 5;
      // A call the fan-out did not make (busy, limited, open, answered from its cache, joined in flight, past the
      // deadline) is no call.
      const unmade = to.length - outcomes.filter(reachedSource).length;
      out.calls -= unmade;
      if (own) extra -= unmade;
      // A consequence probe's answers are always recorded: which of its terms each source was asked, and when, is
      // what rotates them and what its later lookups recall (`consequence`).
      const learn = this.config.probeFresh || this.config.probeYield || this.config.consequenceProbe;
      if (!s.closed && learn) {
        const now = this.now();
        for (const o of outcomes) {
          if (o.status !== "ok") continue;
          const page = o.items.slice(0, whole);
          this.economy.answered(s.scope, o.sourceId, asked, page, now, kind === "consequence");
          onAnswer?.(o.sourceId, page);
          // A name of several words teaches how the source searches them (`consequenceProbe` picks its query by it).
          if (this.config.consequenceProbe && (kind === "person" || kind === "second" || kind === "org")) {
            const words = text
              .toLowerCase()
              .split(/\s+/)
              .filter((w) => w.length > 1);
            this.economy.observeForm(s.scope, o.sourceId, words, page);
          }
          if (!this.config.probeYield) continue;
          // New to the user's cache (read before it is stored): what this call alone brought.
          const fresh = page.filter((i) => this.deps.cache.fetchedAt(s.scope, i.id) === undefined).map((i) => i.id);
          this.economy.called(s.scope, kind, o.sourceId, fresh);
        }
      }
      if (!s.closed) {
        const kept = whole > 5 && !window ? outcomes.flatMap((o) => o.items.slice(0, whole)) : items;
        this.store(s, kept, parent, false, readMark);
      }
      if (keep) for (const i of items) if (!kept.includes(i.id)) kept.push(i.id);
      // Only a complete answer is remembered: a source that failed or timed out is asked again next time.
      if (outcomes.length === to.length && live.length === to.length && outcomes.every((o) => o.status === "ok")) {
        this.deps.cache.rememberProbe(
          s.scope,
          key,
          [...items, ...reused].map((i) => i.id),
          PROBE_MEMO,
          this.now(),
        );
      }
      return [...here, ...items, ...reused];
    };
    const c = this.config;
    const off = new Set(c.probeOff);
    // An action on a named day: what is already that day is what it may clash with. Runs of consecutive days, each
    // listed whole: one span over separate days would page out the days asked for.
    const days = cue.time ? [...cue.time.days].sort() : [];
    const windows: SearchQuery["window"][] = [];
    if (!off.has("day") && !listed && days.length > 0 && days.length <= 7 && isScheduling(cue.raw)) {
      const next = (d: string) => new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10);
      for (let i = 0; i < days.length;) {
        let j = i;
        while (j + 1 < days.length && days[j + 1] === next(days[j]!)) j++;
        windows.push({ start: days[i]!, end: next(days[j]!), offsetMinutes: cue.offset });
        i = j + 1;
      }
    }
    const listers = all.filter((x) => x.listsByTime === true);
    // A person or organisation goes to the sources most likely to hold them, by the source map's own record of which
    // sources mention which names (any source may, not only the lookup's): three per name, not every source.
    const byId = sourcesById(all);
    const allIds = all.map((x) => x.id);
    const routeFor = (name: string, limit = c.probePeopleSources) =>
      this.deps.sourceMap
        .route({
          scope: s.scope,
          entities: [name],
          situation: s.situation,
          sourceIds: allIds,
          limit,
          ...(opts.boost ? { boost: opts.boost } : {}),
        })
        .map((r) => byId.get(r.sourceId)!)
        .filter(Boolean);
    const people = off.has("people") ? [] : cue.entities.slice(0, 2);
    // `probeTopicAlone`: the topic only for a request that names no one (with people, their probes find what the topic
    // would: held-out funnels returned as many planted items without it, at fewer calls).
    const topic =
      off.has("topic") || (c.probeTopicAlone && people.length > 0) ? "" : topicOf(cue.text.split(" "), cue.entities);
    // The organisations of the request's people, from what came back for them; what is said of someone's
    // organisation (a hold, a policy) applies to them.
    const byPeople = (async () => {
      // The request's first person to `probePeopleSources` sources, a second to `probeSecondSources`. With
      // `probeYield`, the first goes to every source, best first, and the user's own yields drop the sources where
      // their person probes find nothing: which sources hold a user's people is learned, not guessed at three.
      const wide = c.probeYield ? all.length : c.probePeopleSources;
      const first = await Promise.all(
        people.map((q, i) =>
          send(i === 0 ? "person" : "second", routeFor(q, i === 0 ? wide : c.probeSecondSources), q),
        ),
      );
      const reading = off.has("org") ? undefined : spans?.open("orgs", probesSpan!.id);
      const orgs = off.has("org") ? [] : orgsOf(people, first.flat()).slice(0, 1);
      if (reading) spans!.close(reading, { orgs: orgs.length });
      for (const org of orgs) {
        if (!cue.entities.includes(org)) await send("org", routeFor(org), org);
      }
    })();
    // `probeRoles`: someone named by their relation ("my manager"), to the lookup's best two sources.
    const roles = c.probeRoles && !off.has("roles") ? rolesOf(cue.raw) : [];
    // `consequenceProbe`: a request that acts, of an action class (`consequence.ts`), asks its class's constraint
    // vocabulary of the sources best for that class: what would stop the action, in words the request never uses.
    // An imperative or an arriving message, not `isAction` or `ACTS_ON` (which match "tell", "ping" anywhere): a
    // question that mentions a release ("did Sam tell you whether the release went out?") is no release.
    const acts = isImperative(cue.raw) || cue.external === true;
    const cls = c.consequenceProbe && !off.has("consequence") ? actionClass(cue.raw, acts) : null;
    await Promise.all([
      ...windows.map((w) => send("day", listers, "", w)),
      byPeople,
      ...roles.map((r) => send("role", found.slice(0, 2), r)),
      // The topic's finds share the request's words, and rank on them; the others get seats of their own.
      ...(topic ? [send("topic", found.slice(0, this.config.probeTopicSources), topic, undefined, false)] : []),
      // Last: a source's probe calls go one at a time, and the request's own probes go first.
      ...(cls ? [this.consequence(s, cls, all, found, send, out)] : []),
    ]);
    if (probesSpan) spans!.close(probesSpan, { calls: out.calls });
  }

  /**
   * The consequence probe (`consequenceProbe`, `consequence.ts`): the request's action class's constraint vocabulary,
   * to the `consequenceSources` sources best for that class. With `probeYield`, best is learned per user (the upper
   * bound of what that class's probes have yielded at each source, an untried source first); without, the lookup's own
   * routing. A source learned to search any word gets every term in one query; one learned to need every word gets one
   * term, the next not yet asked (`nextTerm`), so a run of lookups of the class covers its vocabulary at one call each.
   * Its finds that hold a class term, with those its class's earlier queries found that are still cached, are this
   * lookup's consequence finds (never kept on the session).
   */
  private async consequence(
    s: Session,
    cls: ActionClass,
    all: Source[],
    found: Source[],
    send: ProbeSend,
    out: ProbeOut,
  ): Promise<void> {
    // One arm per source for every class: where a user's notices, policies and alerts live (their mail, a chat's
    // channels, a shared drive) is the same whatever the action.
    const kind: ProbeKind = "consequence";
    const now = this.now();
    const joined = cls.terms.join(" ");
    const ids = new Set<string>();
    const take = (items: ContextItem[]) => {
      for (const i of items) if (matchesClass(cls, `${i.title}\n${i.text}`)) ids.add(i.id);
    };
    // The user's cache first, at no call: an item an earlier lookup or probe brought in that holds a class term. The
    // sources such items came from are where the user's constraints of this kind are written (a #legal channel, a
    // calendar of freeze windows): they are asked first, while no yield is learned.
    const where = new Map<string, number>();
    const vocab = this.deps.cache.peekVocab(s.scope);
    const t = vocab ? termIds(joined, vocab, false) : null;
    const cached =
      t && t.n > 0 ? this.deps.cache.search(s.scope, Array.from(t.ids.subarray(0, t.n)), t.n, 12, now) : [];
    for (const h of cached) where.set(h.item.sourceId, (where.get(h.item.sourceId) ?? 0) + 1);
    const order = [...found, ...all.filter((x) => !found.includes(x))];
    const ranked = order
      .map((x, i) => ({
        x,
        i,
        b: this.config.probeYield ? this.economy.bound(s.scope, kind, x.id) : 1,
        w: where.get(x.id) ?? 0,
      }))
      .sort((a, b) => b.b - a.b || b.w - a.w || a.i - b.i)
      .map((r) => r.x);
    await Promise.all(
      ranked.slice(0, this.config.consequenceSources).map(async (source) => {
        // Every term at once only where the source is known to search any word; one term works everywhere.
        const text = this.economy.formOf(s.scope, source.id) === "any" ? joined : this.nextTerm(s, cls, source.id, now);
        if (!text) return;
        // What a source answers to every term at once teaches how it searches (`ProbeEconomy.observeForm`).
        const learn = (id: string, page: ContextItem[]) => {
          if (text === joined) this.economy.observeForm(s.scope, id, cls.terms, page, true);
        };
        const got = await send(kind, [source], text, undefined, false, learn);
        take(got);
      }),
    );
    if (s.closed) return;
    // This lookup's own finds first (the bound below keeps the first), then the cache's.
    take(cached.map((h) => h.item));
    // What the class's queries found at earlier lookups, at any source, while still cached: a freeze found when the
    // last release was asked for still stands in the way of this one.
    for (const source of all) {
      for (const q of [joined, ...cls.terms]) {
        const last = this.economy.lastIds(s.scope, source.id, `${q}|`);
        if (last) take(this.deps.cache.hits(s.scope, last, now).map((h) => h.item));
      }
    }
    if (ids.size > 0) out.consequence = { cls, ids: [...ids].slice(0, MAX_CONSEQUENCE) };
  }

  /**
   * The class term to ask a source that needs every word: the first never asked there, else the one asked longest
   * ago once its answer may have changed (past `probeMemoMs`); null when every term was asked recently.
   */
  private nextTerm(s: Session, cls: ActionClass, sourceId: string, now: number): string | null {
    let best: string | null = null;
    let bestAt = Infinity;
    for (const t of cls.terms) {
      const at = this.economy.askedAt(s.scope, sourceId, `${t}|`);
      if (at === null) return t;
      if (at < bestAt) [best, bestAt] = [t, at];
    }
    return best !== null && now - bestAt >= this.config.probeMemoMs ? best : null;
  }

  /**
   * Caches sanitized items, read under `readMark` (`Sync.mark` when their read began), and records the entity mentions
   * of those new to the cache or changed.
   */
  private store(s: Session, items: ContextItem[], parent: number, synced: boolean, readMark: number): number {
    const spans = this.spans;
    const putting = items.length > 0 ? spans?.open("cache.put", parent, { items: items.length }) : undefined;
    const added = this.deps.cache.put(s.scope, items, this.now(), true, synced, readMark);
    if (putting) spans!.close(putting, { added: added.length });
    // An item seen again unchanged keeps its card alive; one evicted by the same put is not carded at all.
    if (this.config.cards)
      this.deps.cards?.touch(
        s.scope,
        items.map((i) => i.id),
      );
    this.enqueueCards(s.scope, added);
    this.recordMentions(s.scope, added, parent);
    return added.length;
  }

  /** `cards`: what is new to the cache (looked up or synced) is read for constraints in the background, off-path. */
  private enqueueCards(scope: Scope, added: ContextItem[], defer?: (item: ContextItem) => boolean): void {
    if (this.config.cards && this.deps.cards && added.length > 0) this.deps.cards.enqueue(scope, added, defer);
  }

  /**
   * `cardsSourceAware` (D320): for a user with more than `SOURCE_AWARE_MIN` synced sources, which synced items wait
   * unread: those of a source no lookup of the user's has searched that name none of the names the user's requests
   * named (`mentions`: each item's names, as the source map records them). Undefined (read all) otherwise.
   */
  private cardDefer(
    scope: Scope,
    items: readonly ContextItem[],
    mentions: readonly { entities: string[] }[],
  ): ((item: ContextItem) => boolean) | undefined {
    const sync = this.sync;
    if (!this.config.cardsSourceAware || !sync || sync.sourceCount(scope) <= SOURCE_AWARE_MIN) return undefined;
    const people = sync.peopleOf(scope);
    const keep = new Set<string>();
    items.forEach((item, i) => {
      if (sync.engaged(scope, item.sourceId)) keep.add(item.id);
      else if (people.size > 0 && mentions[i]!.entities.some((e) => people.has(e.toLowerCase()))) keep.add(item.id);
    });
    return (item) => !keep.has(item.id);
  }

  /**
   * `cardsSourceAware` (D320), `syncEngagedDeep` (D323): the sources a lookup searched (or answered from the index)
   * are the user's in use (`Sync.engage`). With `cardsSourceAware`, the first time one is, its held synced items are
   * read by the card model, and the request's names are noted as the user's people.
   */
  private engageSources(s: Session, cue: Cue, searched: readonly string[]): void {
    const sync = this.sync;
    const cards = this.config.cardsSourceAware && this.config.cards && this.deps.cards !== undefined;
    if (!sync || (!cards && !this.config.syncEngagedDeep && !(this.config.syncUnusedSweepMs > 0))) return;
    if (cards && cue.entities.length > 0) {
      sync.notePeople(
        s.scope,
        cue.entities.map((e) => e.toLowerCase()),
      );
    }
    const fresh = sync.engage(s.scope, searched);
    // Whatever the user's source count now: items deferred while it was past `SOURCE_AWARE_MIN` are read (the review: a
    // count that fell to 32 first left them unread for good).
    if (!cards || fresh.length === 0) return;
    const now = this.now();
    const held: ContextItem[] = [];
    for (const id of fresh) {
      for (const itemId of sync.syncedIds(s.scope, id)) {
        const item = this.deps.cache.get(s.scope, itemId, now);
        if (item) held.push(item);
      }
    }
    this.enqueueCards(s.scope, held);
  }

  /**
   * A query answered from the user's synced items of the given sources (D57), as their live search would answer it
   * but with no call: at most `limit` per source, holding every word of the query (`syncLocalAll`: a mail or chat
   * search) or ranked on any; a listing (a window and no words) is the events that start on its days, soonest first.
   */
  private localAnswer(
    s: Session,
    sourceIds: ReadonlySet<string>,
    text: string,
    limit: number,
    window?: SearchQuery["window"],
  ): ContextItem[] {
    const cache = this.deps.cache;
    const now = this.now();
    const capped = (hits: CacheHit[]) => {
      const per = new Map<string, number>();
      return hits.filter((h) => {
        const k = per.get(h.item.sourceId) ?? 0;
        if (!sourceIds.has(h.item.sourceId) || k >= limit) return false;
        per.set(h.item.sourceId, k + 1);
        return true;
      });
    };
    if (window && !text.trim()) {
      const days = new Set<string>();
      const end = Date.parse(window.end);
      for (let t = Date.parse(window.start); t < end && days.size < 31; t += 86_400_000) {
        days.add(new Date(t).toISOString().slice(0, 10));
      }
      return capped(cache.timed(s.scope, days, now, 400)).map((h) => h.item);
    }
    const vocab = cache.peekVocab(s.scope);
    if (!vocab) return [];
    // The query's words, stopwords out, each once (in the session's vocabulary, so the user's never grows from a
    // query); a word no synced item holds matches nothing when every word is needed.
    const q = termIds(text, s.vocab, true);
    const words = new Set<string>();
    for (let i = 0; i < q.n; i++) {
      const w = s.vocab.term(q.ids[i]!);
      if (!isStopword(w)) words.add(w);
    }
    const ids: number[] = [];
    for (const w of words) {
      const id = vocab.lookup(w);
      if (id >= 0) ids.push(id);
      else if (this.config.syncLocalAll) return [];
    }
    const all = this.config.syncLocalAll;
    return cache.searchIn(s.scope, ids, ids.length, limit, sourceIds, all, now).map((h) => h.item);
  }

  /** Records the entity mentions of items new to the user's cache or changed (lookups and the sync, D57). */
  private recordMentions(
    scope: Scope,
    added: ContextItem[],
    parent = 0,
    given?: { sourceId: string; entities: string[] }[],
  ): void {
    if (added.length === 0) return;
    const spans = this.spans;
    const noting = spans?.open("mentions", parent, { items: added.length });
    const mentions = given ?? mentionsOf(added);
    if (mentions.length > 0) this.deps.sourceMap.recordMentionsMany(scope, mentions, this.now());
    if (noting) spans!.close(noting);
  }

  /**
   * Whether any of these cached items was fetched longer ago than `refreshAfterMs` (refreshing on), or, with
   * `verifyDelivery`, read before its source signalled a change (`doubted`): the fast path may not re-read it, so the
   * slow path, which does, delivers it.
   */
  private stale(s: Session, scored: Scored[]): boolean {
    const now = this.now();
    if (this.config.verifyDelivery && scored.some((x) => this.doubted(s, x.item))) return true;
    const after = this.config.refreshAfterMs;
    if (after <= 0) return false;
    // A synced item counts by when the sync last read it too (D57): its source's copy may be current, but the fast
    // path stays for what was read recently, and the rest goes through the slow path, which answers from the local
    // index at no call and lets the judge, when there is one, rule (the fast path never asks it).
    return scored.some((x) => now - this.readAt(s, x.item, now) > after);
  }

  /** When an item's copy was last known current: when it was fetched. */
  private readAt(s: Session, item: ContextItem, now: number): number {
    return this.deps.cache.fetchedAt(s.scope, item.id) ?? now;
  }

  /**
   * Ref notices' reads that landed (D347), noted as recent re-reads in each live session of the user
   * (`Session.checks`, as `check` keeps its own): a pool a session built before they landed holds the older copies, and
   * `verifyItems` then applies these outcomes to them (a changed item goes out as the cache now holds it). Called for
   * changed copies only, before their doubt is lifted: one walk of that user's sessions per changed ref
   * (`userSessions`; a walk of the whole process's sessions was refs × sessions on a busy process).
   */
  private noteRefReads(scope: Scope, landed: readonly { id: string; outcome: CheckOutcome; mark: number }[]): void {
    if (landed.length === 0) return;
    const sessions = this.userSessions.get(scopeKey(scope));
    if (!sessions) return;
    const now = this.now();
    for (const s of sessions) {
      if (s.closed) continue;
      const checks = (s.checks ??= new Map());
      for (const { id, outcome, mark } of landed) {
        checks.delete(id);
        checks.set(id, { at: now, mark, outcome: Promise.resolve(outcome), settled: outcome });
      }
      while (checks.size > MAX_CHECKS) checks.delete(checks.keys().next().value as string);
    }
  }

  /**
   * Whether an item must be re-read before it is delivered (`verifyDelivery`): its source signalled a change since the
   * copy's read began (`Sync.signalledSince` on its `ItemCache.readMark`; D133: not since it was stored, which a
   * signal while the call was on the wire precedes) and no listing or notification has brought it again since. A
   * copy's age alone does not doubt it (D126: re-reading by age cost 4.6 connector calls and 0.33 s per task live, for
   * no measured gain; a silent source's changes reach Eden through the sync's polls and sweeps).
   */
  private doubted(s: Session, item: ContextItem): boolean {
    // A ref notice's re-read still on the wire (D347): the copy held is from before the change.
    if (this.refreshing.size > 0 && this.refreshing.has(`${scopeKey(s.scope)}|${item.id}`)) return true;
    if (this.unswept(s.scope, item)) return true;
    const mark = this.deps.cache.readMark(s.scope, item.id);
    if (mark === undefined || this.sync?.signalledSince(s.scope, item.sourceId, mark) !== true) return false;
    // A re-read since that signal could not tell (a null that proves nothing): another says the same until it signals.
    const held = this.unverifiable.get(scopeKey(s.scope))?.get(item.id);
    if (held === undefined || this.now() - held.at > UNVERIFIABLE_HOLD_MS) return true;
    return this.sync.signalledSince(s.scope, item.sourceId, held.mark);
  }

  /**
   * `syncUnusedSweepMs` (D356): the item's source is one the user does not use, swept less often, and neither a sweep
   * nor any other read has seen this copy for longer than the daily sweep would have allowed (`syncSweepMs`): a
   * deletion the sweep has not seen yet may be behind it, so it is re-read before it is delivered or cited. O(1).
   */
  private unswept(scope: Scope, item: ContextItem): boolean {
    const every = this.config.syncSweepMs;
    if (!(this.config.syncUnusedSweepMs > 0) || !this.sync) return false;
    const at = this.deps.cache.fetchedAt(scope, item.id);
    if (at === undefined) return false;
    const now = this.now();
    // A copy the last sweep did not list: the second miss that drops it may be a week away (on the longer sweep), and
    // a withheld copy's own early sweep is such a first miss (the MCP worst case cited 3 against 1). Whatever its age:
    // listed since, it would not be missed.
    if (this.sync.sweepMissed(scope, item.sourceId, item.id)) return true;
    return now - at > every && this.sync.sweepLapsed(scope, item.sourceId, now);
  }

  /** Notes an "unverifiable" re-read of a user's item under the read mark it began with (`unverifiable`). */
  private noteUnverifiable(scope: Scope, id: string, readMark: number): void {
    const key = scopeKey(scope);
    let user = this.unverifiable.get(key);
    if (user) this.unverifiable.delete(key);
    else user = new Map();
    this.unverifiable.set(key, user);
    user.delete(id);
    user.set(id, { mark: readMark, at: this.now() });
    while (user.size > MAX_UNVERIFIABLE) user.delete(user.keys().next().value as string);
    while (this.unverifiable.size > MAX_UNVERIFIABLE_USERS)
      this.unverifiable.delete(this.unverifiable.keys().next().value as string);
  }

  /**
   * `verifyDelivery`: re-reads, by ref and in parallel, each item in doubt (`doubted`). A changed copy is stored
   * (already redacted by the fan-out) and replaces the item; one its source no longer has is dropped from the cache and
   * left out; one that could not be checked stays as held.
   * Each re-read is a connector call, traced as a "verify" decision (`sourceCalls`). Never throws.
   *
   * `strict` (an ask's citations, D211): a doubted item whose re-read failed with a plain error is read once more, and
   * one still not confirmed is left out, counted by source in `strict.unconfirmed` for the answer to name. An ask's
   * answer is taken as what the sources hold now, so a copy a signal doubted and nothing confirmed is not cited (one
   * ask in 360 cited a deleted item that way in RealUse-1 part D). A source with no fetch tool, or whose null proves
   * nothing, is cited as held. A copy only a sweep could vouch for (`unswept`, D356) is cited only if a re-read
   * confirms it; one left out is counted in `strict.unswept`, named in the answer with its own reason.
   */
  private async verifyItems(
    s: Session,
    scored: Scored[],
    cue: Cue,
    strict?: { unconfirmed: Map<string, number>; unswept: Map<string, number> },
  ): Promise<Scored[]> {
    if (!this.config.verifyDelivery || scored.length === 0) return scored;
    const now = this.now();
    // Doubted now, or re-read just before (`checkAhead`): that re-read made the cached copy current, but the copy in
    // hand is the one the pool was built from, so its outcome still applies.
    const recent = (id: string) => {
      const held = s.checks?.get(id);
      return held !== undefined && now - held.at <= CHECK_REUSE_MS;
    };
    const doubted = new Set<string>();
    // `syncUnusedSweepMs` (D356): copies only the sweep could vouch for, delivered only if a re-read confirms them.
    const unswept = new Set<string>();
    for (const x of scored) {
      if (this.unswept(s.scope, x.item)) unswept.add(x.item.id);
      if (unswept.has(x.item.id) || this.doubted(s, x.item)) doubted.add(x.item.id);
    }
    const due = scored.filter((x) => recent(x.item.id) || doubted.has(x.item.id));
    if (due.length === 0) return scored;
    const t0 = performance.now();
    // The calls of the re-reads this delivery started, counted by them: the engine-wide counter's change over the
    // awaits took in other sessions' and tenants' re-reads, and could go negative (audit A11's fuzz).
    const made = { calls: 0 };
    // The re-reads' wait as its own span (A18): counts only, under the delivery or ask that waits on it.
    const verifying = this.spans?.open("verify", cue.span, { async: true, due: due.length });
    const outcomes = new Map(
      await Promise.all(due.map(async (x) => [x.item.id, await this.check(s, x.item, made)] as const)),
    );
    let rounds = 1;
    if (strict && !s.closed) {
      // One more read (`check` reuses no failure) for a plain error, often one bad call, and for a read our own guard
      // skipped while the others held the source's slots; two at a time, the fan-out's starting concurrency per source.
      const again = due.filter((x) => doubted.has(x.item.id) && RETRIED.has(outcomes.get(x.item.id)!));
      for (let k = 0; k < again.length && !s.closed; k += STRICT_RETRY_LANES) {
        const batch = again.slice(k, k + STRICT_RETRY_LANES);
        const read = await Promise.all(batch.map(async (x) => [x.item.id, await this.check(s, x.item, made)] as const));
        for (const [id, o] of read) outcomes.set(id, o);
        rounds++;
      }
    }
    this.trace(s, {
      sessionId: s.id,
      turn: s.turn,
      event: "verify",
      decision: "verify",
      reason: cue.id,
      latencyMs: Math.round(performance.now() - t0),
      // Calls this delivery waited on that were made for it (a re-read started ahead is counted where it began).
      sourceCalls: made.calls,
      modelCalls: 0,
      costUsd: 0,
      itemIds: due.map((x) => x.item.id),
    });
    if (verifying) {
      let skipped = 0;
      for (const o of outcomes.values()) if (o === "skipped") skipped++;
      this.spans!.close(verifying, { calls: made.calls, rounds, skipped, strict: !!strict });
    }
    if (s.closed) return [];
    const after = this.now();
    return scored.flatMap((x) => {
      const o = outcomes.get(x.item.id);
      if (o === "gone") return [];
      // A removal that landed while the other re-reads ran (audit A5): the item is gone whatever its own outcome said.
      if (this.deps.cache.isHeldGone(s.scope, x.item.id, after)) return [];
      // An unswept copy no re-read confirmed (a null that proves nothing, an error, a skip): the sweep it was waiting
      // for is due now, and until it or a re-read vouches for the copy, it is not delivered nor cited.
      if (unswept.has(x.item.id) && o !== "confirmed" && o !== "changed") {
        // Only a null (the source could not say) is left to the sweep; an error or our own guard's skip is not worth
        // a whole listing: the next delivery re-reads it (the review).
        if (o === "unverifiable") this.sync?.sweepSoon(s.scope, x.item.sourceId);
        if (strict) strict.unswept.set(x.item.sourceId, (strict.unswept.get(x.item.sourceId) ?? 0) + 1);
        return [];
      }
      if (strict && doubted.has(x.item.id) && (o === "failed" || o === "flaked")) {
        strict.unconfirmed.set(x.item.sourceId, (strict.unconfirmed.get(x.item.sourceId) ?? 0) + 1);
        return [];
      }
      if (o !== "changed") return [x];
      // The copy in hand is the one the re-read found superseded: with no current copy cached (evicted meanwhile, not
      // removed), nothing is cited, and a strict ask names it as not re-checked, not an all-clear (D127).
      const copy = this.deps.cache.get(s.scope, x.item.id, after);
      if (copy) return [{ ...x, item: copy }];
      if (strict) strict.unconfirmed.set(x.item.sourceId, (strict.unconfirmed.get(x.item.sourceId) ?? 0) + 1);
      return [];
    });
  }

  /**
   * One item's re-read (`verifyDelivery`), shared by every delivery of the session that wants it while it runs or for
   * `CHECK_REUSE_MS` after: started ahead (`checkAhead`, beside the reader's call) or by `verifyItems`. A changed copy
   * is stored, a gone item dropped from the cache and the sync's bookkeeping. Never throws. `made` counts the call of
   * a re-read this starts (not one it joins).
   */
  private check(s: Session, item: ContextItem, made?: { calls: number }): Promise<CheckOutcome> {
    // A ref notice is re-reading this item now (D347): its outcome, with no second call.
    const refreshing = this.refreshing.size > 0 ? this.refreshing.get(`${scopeKey(s.scope)}|${item.id}`) : undefined;
    // Not past a signal that came after the notice: that read may have answered before the newer change.
    if (refreshing && this.sync?.signalledSince(s.scope, item.sourceId, refreshing.mark) !== true) {
      // Waited on no longer than a re-read of its own would be (`verifyTimeoutMs`): past it, not confirmed.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<CheckOutcome>(
        (r) => (timer = setTimeout(() => r("failed"), this.config.verifyTimeoutMs)),
      );
      return Promise.race([refreshing.outcome, late]).finally(() => clearTimeout(timer));
    }
    const checks = (s.checks ??= new Map());
    const now = this.now();
    const held = checks.get(item.id);
    // Reused while it runs, or for a while after if it settled; never past a newer signal, and never a failure.
    if (
      held &&
      now - held.at <= CHECK_REUSE_MS &&
      held.settled !== "failed" &&
      held.settled !== "flaked" &&
      held.settled !== "skipped" &&
      this.sync?.signalledSince(s.scope, item.sourceId, held.mark) !== true
    )
      return held.outcome;
    // The read mark before the re-read's call (D133): a signal while it is on the wire doubts what it stores, and
    // refuses its reuse.
    const mark = this.sync?.mark() ?? 0;
    const entry: { at: number; mark: number; outcome: Promise<CheckOutcome>; settled?: CheckOutcome } = {
      at: now,
      mark,
      outcome: this.recheck(s, item, mark, made).then((o) => (entry.settled = o)),
    };
    const outcome = entry.outcome;
    checks.delete(item.id);
    checks.set(item.id, entry);
    while (checks.size > MAX_CHECKS) checks.delete(checks.keys().next().value as string);
    return outcome;
  }

  private async recheck(
    s: Session,
    item: ContextItem,
    readMark: number,
    made: { calls: number } = { calls: 0 },
  ): Promise<CheckOutcome> {
    this.freshness.checked++;
    try {
      const all = await this.deps.sources(s.scope).catch((): Source[] => []);
      const source = all.find((x) => x.id === item.sourceId);
      if (!source?.fetch) {
        this.freshness.failed++;
        return "unverifiable";
      }
      this.freshness.calls++;
      made.calls++;
      const got = await this.fanout.fetchChecked(source, s.scope, item.ref, {
        timeoutMs: this.config.verifyTimeoutMs,
        signal: s.abort.signal,
      });
      if (got.status === "failed" || s.closed) {
        this.freshness.failed++;
        if (s.closed || got.status !== "failed") return "failed";
        // A guard's skip made no call: not one the connector received. A busy permit or our rate limit's ordinary use
        // is no evidence against the item and clears in moments (one retry). An open breaker, or a rate limit the
        // connector's own 429 pushed back, says the source is in trouble now: the item could not be checked
        // ("failed"), so a strict ask leaves it out and says so (D211, D232).
        if (got.why === "refused") {
          this.freshness.calls--;
          made.calls--;
          return got.guard === "open" || got.pushedBack ? "failed" : "skipped";
        }
        // A null from a source whose null does not mean gone (an MCP tool) says nothing, and says it every time: like
        // a source with no fetch, its items are cited as held (D126). A plain error is worth one more read.
        // A null whose reply lacked the record says the same next time: held (D298). An error result may pass: not.
        if (got.why === "null" && !s.closed) this.noteUnverifiable(s.scope, item.id, readMark);
        if (got.why === "null" || got.why === "error-result") return "unverifiable";
        return got.why === "error" ? "flaked" : "failed";
      }
      if (got.status === "gone") {
        this.freshness.gone++;
        this.dropGone(s.scope, item.sourceId, [item.id]);
        return "gone";
      }
      // A removal that landed while the fetch was on the wire (`sourceRemoved`) wins over what it read: the id was a
      // cached candidate when the re-read began, and `removeItems` drops what it holds gone, so a live hold now means
      // the deletion came after. Reviving it would undo the deletion and deliver it (D126).
      if (this.deps.cache.isHeldGone(s.scope, item.id, this.now())) {
        this.freshness.gone++;
        return "gone";
      }
      const copy = { ...got.item, id: item.id, sourceId: item.sourceId, ref: item.ref };
      this.deps.cache.revive(s.scope, [item.id]);
      // Found at its source: a sweep that missed it skipped it (an offset listing shifts), D356's doubt is answered.
      this.sync?.vouched(s.scope, item.sourceId, item.id);
      const synced = this.deps.cache.isSynced(s.scope, item.id);
      // Stored as read now (its fetch time moves), as synced when the sync held it; carded and noted like any read.
      const changed = this.store(s, [copy], 0, synced, readMark) > 0;
      // A held search page may still show the old copy: a later lookup must not store it back.
      if (changed) this.fanout.dropResults(s.scope, item.sourceId);
      if (changed) {
        const stored = this.deps.cache.get(s.scope, item.id, this.now());
        if (stored) this.queueRevised(s.scope, [stored]);
      }
      if (changed) this.freshness.changed++;
      else this.freshness.confirmed++;
      return changed ? "changed" : "confirmed";
    } catch {
      // Never throws: a re-read started ahead is not awaited (`checkAhead`), and its outcome is shared.
      this.freshness.failed++;
      return "failed";
    }
  }

  /**
   * Items their source no longer has: dropped from the cache (and held as gone for `GONE_HOLD_MS`, so a search or
   * listing read before the deletion cannot store them back), from the sync's bookkeeping and from held search pages.
   */
  private dropGone(scope: Scope, sourceId: string, ids: string[]): number {
    // Packets queued for this user that cite a removed item go now: the hold that `dropRemovedPending` reads at
    // hand-out lasts `GONE_HOLD_MS`, and a packet can wait longer than that in an idle session's queue.
    const gone = new Set(ids);
    const user = scopeKey(scope);
    for (const s of this.sessions.values()) {
      if (s.pending.length === 0 || scopeKey(s.scope) !== user) continue;
      for (let k = s.pending.length - 1; k >= 0; k--) {
        const packet = s.pending[k]!;
        if (!packet.citations.some((c) => gone.has(c.itemId))) continue;
        s.pending.splice(k, 1);
        this.withdraw(s, packet);
      }
    }
    this.sync?.removed(scope, sourceId, ids);
    this.fanout.dropResults(scope, sourceId);
    const evicted = this.deps.cache.holdsEvicted(scope.tenantId);
    const n = this.deps.cache.removeItems(scope, ids, this.now(), GONE_HOLD_MS);
    this.freshness.holdsEvicted += this.deps.cache.holdsEvicted(scope.tenantId) - evicted;
    return n;
  }

  /**
   * `verifyDelivery`: re-reads the first `VERIFY_AHEAD` doubted candidates of a reader's pool while the reader reads
   * them, so the delivery that follows finds them done (`check`) instead of waiting a connector's round trip. The
   * reader reads the copies it was given; a delivery shows the re-read ones.
   */
  private checkAhead(s: Session, pool: readonly Scored[]): void {
    if (!this.config.verifyDelivery) return;
    let n = 0;
    for (const x of pool) {
      if (n >= VERIFY_AHEAD) break;
      if (!this.doubted(s, x.item)) continue;
      n++;
      void this.check(s, x.item);
    }
  }

  /** `deliver`, after `verifyItems`: null when every item was found gone, or the session closed meanwhile. */
  private async deliverChecked(
    s: Session,
    scored: Scored[],
    mode: InjectionMode,
    reason: string,
    cue: Cue,
  ): Promise<Injection | null> {
    // The items were ranked against the ledger before the re-reads' await; a delivery during it (the next request's
    // fast path from the cache) may have handed some out since, and `build` marks without testing again: an item
    // whose ledger entry changed over the await is left out (audit A11's fuzz, default seed 2577; core seed 704). An
    // entry gone meanwhile was swept (past the cooldown, or past `MAX_LEDGER_ITEMS`), not handed out: kept (review).
    const was = new Map(scored.map((x) => [x.item.id, s.ledger.entry(x.item.id)] as const));
    const verified = await this.verifyItems(s, scored, cue);
    const kept = verified.filter((x) => {
      const now = s.ledger.entry(x.item.id);
      return now === undefined || sameEntry(was.get(x.item.id), now);
    });
    if (kept.length === 0 || s.closed) return null;
    return this.deliver(s, kept, mode, reason, cue);
  }

  /**
   * The planner's lookup beside a served one (shadow mode): it learns, and reports what it found, but nothing it
   * returns is cached, delivered or recorded as a mention, and it must never change serving:
   * - it runs only for connectors that served this lookup normally (not ones skipped as open, busy or limited, or
   *   that failed), so it adds no load to a struggling connector;
   * - its calls draw on a separate, smaller rate bucket (`permitShadow`), so serving's budget is never spent on it;
   * - a rate-limit error it sees is fed back to the limit, as serving's are;
   * - like serving, it starts no call its timeout would cut off.
   * Records carry sanitized item ids, the same ids serving's items get.
   */
  private async shadowLookup(s: Session, sources: Source[], cue: Cue, served: FanoutOutcome[]): Promise<void> {
    const planner = this.deps.planner;
    const sink = this.deps.onShadow;
    if (!planner) return;
    const turn = s.turn;
    const signal = AbortSignal.any([s.abort.signal, AbortSignal.timeout(this.config.sourceTimeoutMs)]);
    // As in serving: no call is started that this timeout would cut off.
    const deadlineAt = performance.now() + this.config.sourceTimeoutMs;
    const query = { scope: s.scope, text: cue.text, entities: cue.entities, limit: 8 };
    const healthy = new Set(["ok", "cached", "stale"]);
    await Promise.all(
      sources.map(async (source) => {
        const outcome = served.find((o) => o.sourceId === source.id);
        if (!outcome || !healthy.has(outcome.status)) return;
        const servedItemIds = outcome.items.map((i) => i.id);
        const record = (r: Partial<ShadowRecord>): void => {
          if (!sink || s.closed) return;
          try {
            sink({
              sessionId: s.id,
              turn,
              sourceId: source.id,
              status: "ok",
              shapes: [],
              calls: 0,
              itemIds: [],
              servedItemIds,
              ...r,
            });
          } catch {
            // A broken sink never breaks a lookup.
          }
        };
        const permit = () => this.fanout.permitShadow(s.scope, source.id);
        if (!permit()) return record({ status: "limited" });
        try {
          const r = await planner.search(source, query, signal, permit, undefined, deadlineAt);
          record({ shapes: r.shapes, calls: r.calls, itemIds: r.items.map((i) => sanitizedId(i)) });
        } catch (e) {
          this.fanout.rateLimited(s.scope, source.id, String(e));
          const partial = e instanceof PlanError ? e.partial : { shapes: [], calls: 1, items: [] };
          record({
            status: "error",
            shapes: partial.shapes,
            calls: partial.calls,
            itemIds: partial.items.map((i) => sanitizedId(i)),
          });
        }
      }),
    );
  }

  /** The slow path (`lookup`), under its own span when spans are on: its phases are that span's children. */
  private async slowPath(
    s: Session,
    cue: Cue,
    t0: number,
    eventKind: string,
    served = false,
  ): Promise<Injection | null> {
    const spans = this.spans;
    if (!spans) return this.lookup(s, cue, t0, eventKind, served);
    const sp = spans.open("slow", cue.span, { async: true, served });
    cue.span = sp.id;
    let injection: Injection | null = null;
    try {
      injection = await this.lookup(s, cue, t0, eventKind, served);
      return injection;
    } finally {
      // The path that delivered (sources, grounded-…, fallback, model): the reason's fixed prefix, no cue id.
      spans.close(sp, {
        delivered: injection !== null,
        ...(injection ? { how: injection.reason.split(":")[0]! } : {}),
      });
    }
  }

  /** Which candidates a lookup may deliver or seat with the judge: scored above `candidateScore`, or tied otherwise. */
  private eligible(
    scored: Scored[],
    cue: Cue,
    probed: ReadonlySet<string>,
    bridged: ReadonlySet<string>,
    carded: ReadonlyMap<string, CardFind> = new Map(),
    intents: ReadonlyMap<string, IntentFind> = new Map(),
  ): Scored[] {
    // An event on a day the request names is a candidate whatever it scores on words (D44).
    const onNamedDay = (x: Scored) => cue.time?.days.has(startDay(x.item, cue.offset) ?? "") === true;
    // A consequence find that does not conflict is no candidate: it shares nothing with the request but its class.
    // An intent hit (`intent`) is: its requests say the request is one it would change. The rule paths still read
    // its own words (its lexical score and terms are unchanged), so it is delivered with no model's say only where a
    // structural verdict (the conflict test, a violated card) binds it.
    return scored.filter(
      (x) =>
        x.score >= this.config.candidateScore ||
        onNamedDay(x) ||
        probed.has(x.item.id) ||
        bridged.has(x.item.id) ||
        carded.has(x.item.id) ||
        intents.has(x.item.id),
    );
  }

  /**
   * `routeLocalHits` (D265): for each source, log2(1 + how many of the request's best matches in the user's own index
   * it holds), from one search of the cache (no call); undefined when the user has nothing cached or nothing matches.
   */
  private localRouteHits(s: Session, cue: Cue): Map<string, number> | undefined {
    const cache = this.deps.cache;
    const vocab = cache.peekVocab(s.scope);
    if (!vocab) return undefined;
    const q = termIds(`${cue.text} ${cue.entities.join(" ")}`, vocab, false);
    const query: number[] = [];
    for (let i = 0; i < q.n; i++) if (!isStopword(vocab.term(q.ids[i]!))) query.push(q.ids[i]!);
    if (query.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const h of cache.search(s.scope, query, query.length, LOCAL_ROUTE_HITS, this.now())) {
      counts.set(h.item.sourceId, (counts.get(h.item.sourceId) ?? 0) + 1);
    }
    if (counts.size === 0) return undefined;
    for (const [id, n] of counts) counts.set(id, Math.log2(1 + n));
    return counts;
  }

  /** `routeSketch` (D322): each source's match of the request's terms against its vocabulary sketch (no call). */
  private sketchRouteHits(s: Session, cue: Cue): Map<string, number> | undefined {
    if (!this.sync) return undefined;
    const terms = sketchTerms(`${cue.text} ${cue.entities.join(" ")}`).slice(0, MAX_SKETCH_TERMS);
    return this.sync.sketchScores(s.scope, terms.map(termHashes));
  }

  /** The sources whose synced copy is current (`sync`, D57), which answer from the local index; null when none. */
  private localOf(s: Session, all: readonly Source[], behind = false, cut?: Set<string>): Set<string> | null {
    if (!this.sync) return null;
    const now = this.now();
    // `pushCutBehind` (D405): `cut` collects the warm cut copies admitted here, whose live search runs behind.
    if (cut) {
      const local = new Set<string>();
      for (const x of all) {
        if (!this.sync.isWarm(s.scope, x.id)) continue;
        local.add(x.id);
        if (!this.sync.complete(s.scope, x.id)) cut.add(x.id);
      }
      return local.size > 0 ? local : null;
    }
    // `behind`: a warm copy answers while its poll runs (`syncPollBehind`), never one still in its backfill; so does a
    // warm copy past `syncPollWidth` that the lookup did not poll (D263). An ask passes `behind` only with `askBehind`
    // (D430), which then names such a copy's status itself (`behindStatuses`); without it a stale copy it did not poll
    // is searched live (D127), within the probes' call budget.
    // With `syncLocalComplete`, only a copy that holds the whole source answers for it (D264): one the user's cap cut
    // is searched live, or a lookup would miss what is older than the cut.
    const whole = (id: string) => !this.config.syncLocalComplete || this.sync!.complete(s.scope, id);
    const ok = (id: string) =>
      whole(id) && (this.sync!.current(s.scope, id, now) || (behind && this.sync!.isWarm(s.scope, id)));
    const local = new Set(all.filter((x) => ok(x.id)).map((x) => x.id));
    return local.size > 0 ? local : null;
  }

  private async lookup(s: Session, cue: Cue, t0: number, eventKind: string, served = false): Promise<Injection | null> {
    // The turn that triggered the lookup. Traces report it, not the turn current when the lookup finishes: later
    // events may arrive meanwhile, and evals attribute deliveries by this field.
    const turn = s.turn;
    let modelCalls = 0;
    let costUsd = 0;
    let sourceCalls = 0;
    let plans: Trace["plans"];
    let local: number | undefined;
    let syncCalls: number | undefined;
    const done = (decision: Trace["decision"], reason: string, items: ContextItem[] = []) =>
      this.trace(s, {
        sessionId: s.id,
        turn,
        event: eventKind,
        decision,
        reason,
        latencyMs: Math.round(performance.now() - t0),
        sourceCalls,
        modelCalls,
        costUsd,
        itemIds: items.map((i) => i.id),
        ...(plans ? { plans } : {}),
        ...(local !== undefined ? { localSources: local, syncCalls: syncCalls ?? 0 } : {}),
      });
    try {
      let probedIds: string[] | undefined;
      let lookedIds: string[] | undefined;
      let consequence: { cls: ActionClass; ids: string[] } | undefined;
      ({
        calls: sourceCalls,
        plans,
        probed: probedIds,
        looked: lookedIds,
        consequence,
        local,
        syncCalls,
        // Poll-behind needs the poll: without `syncOnDemand` nothing would bring a stale copy current, so it is
        // searched live as before.
      } = await this.searchLive(
        s,
        cue,
        this.config.lookupSources,
        this.config.syncPollBehind && this.config.syncOnDemand,
      ));
      if (s.closed) return null;
      const spans = this.spans;
      // This lookup's probe finds, its own (never another turn's or a concurrent ask's).
      const consIds = new Set(consequence?.ids ?? []);
      // `cards`: cached items whose implication card bears on the request's actions (no model, no call).
      const carding = this.config.cards && this.deps.cards ? spans?.open("cards.match", cue.span) : undefined;
      const carded = this.cardFinds(s, cue);
      if (carding) spans!.close(carding, { found: carded.size });
      // `intent`: cached items whose requests (written with their cards) match the request's words (no model).
      const intending = this.config.intent && this.deps.cards ? spans?.open("intent.match", cue.span) : undefined;
      const intentFound = this.intentFinds(s, cue);
      if (intending) spans!.close(intending, { found: intentFound.size });
      const extra = [...consIds, ...carded.keys(), ...intentFound.keys()];
      const ranking = spans?.open("rank", cue.span);
      const scored = this.rank(s, cue, {
        probed: extra.length > 0 ? [...(probedIds ?? []), ...extra] : probedIds,
      });
      if (ranking) spans!.close(ranking, { candidates: scored.length });
      // Only anchored intent hits are eligible as such, take seats or tie the judge (`anchoredIntents`).
      const intents = this.anchoredIntents(s, cue, intentFound);
      // A consequence find counts only where the conflict test, tied by its class's words, says it conflicts with the
      // request (`consequenceProbe`): a freeze over the day a release is asked for, not one last month; and not a
      // limit on an amount the request does not state ("travel over £500 needs pre-approval" for printer paper).
      const ties = consequence ? classTies(consequence.cls) : undefined;
      const conflicting = consIds.size > 0 ? spans?.open("conflict", cue.span) : undefined;
      const bridged = new Set(
        consIds.size > 0
          ? scored
              .filter(
                (x) =>
                  consIds.has(x.item.id) &&
                  !unmeasuredLimit(this.frame(cue), x.item) &&
                  this.verdict(x.item, cue, ties) === "conflict",
              )
              .map((x) => x.item.id)
          : [],
      );
      if (conflicting) spans!.close(conflicting, { bridged: bridged.size });
      const confiding = spans?.open("confident", cue.span);
      const sure = this.confident(scored, cue);
      if (confiding) spans!.close(confiding, { sure: sure.length });
      const probedSet = new Set(probedIds ?? []);
      const factsNow = () => this.factsOf(s, cue, scored, eventKind, { probed: probedSet, bridged, carded: carded });
      // The rule paths decide when no model does.
      const noModelSay = !this.deps.model;
      const dumped = (path: CandidateDump["path"], items: readonly Scored[], how: string, say = noModelSay) => {
        if (this.deps.onCandidates && say) this.dump(s, path, factsNow(), items, items.length > 0 ? how : "");
      };
      // `served`: the request was answered already (a follow-up behind a delivery, `afterPoll`). The live search adds
      // only what is sure, or with no model what the request's structure grounds: never the fallback's best guess or
      // a judge call, which would have had that delivery among their candidates.
      if (served) {
        // A follow-up (`afterPoll`) decides as with no model whatever is configured: its judge call would be the
        // event's second (docs/COST-MODEL.md).
        const ruled =
          this.deps.model && !cue.followUp
            ? []
            : sure.length > 0
              ? sure
              : this.grounded(
                  s,
                  cue,
                  this.eligible(scored, cue, new Set(probedIds ?? []), bridged, carded, intents),
                  eventKind,
                  bridged,
                  consequence?.cls,
                  carded,
                ).items;
        // A follow-up corrects: an item the agent was given whose words its poll changed goes out again, as it now
        // reads, whatever it scores (the agent holds the superseded copy).
        const corrected = cue.followUp ? scored.filter((x) => x.revised && !ruled.includes(x)) : [];
        const items = [...ruled, ...corrected];
        dumped(
          "served",
          items,
          ruled.length > 0 ? (sure.length > 0 ? "sure" : "grounded") : "corrected",
          noModelSay || cue.followUp === true,
        );
        if (items.length === 0) {
          done("silent", "served");
          return null;
        }
        done(
          "sources",
          `after-served:${cue.id}`,
          items.map((x) => x.item),
        );
        return await this.deliverChecked(s, items, "proactive", `sources:${cue.id}`, cue);
      }
      // `judgeContested`: only when more than one item scored as sure (which is meant is then the judge's call), what
      // scores as sure is judged with the rest in the same call.
      const contested = this.config.judgeContested && sure.length > 1;
      const judgeSure = contested && this.deps.model !== null;
      if (sure.length > 0 && !judgeSure) {
        dumped("lookup", sure, "sure");
        done(
          "sources",
          cue.id,
          sure.map((x) => x.item),
        );
        return await this.deliverChecked(s, sure, "proactive", `sources:${cue.id}`, cue);
      }
      // An event on a day the request names is a candidate whatever it scores on words (D44).
      const onNamedDay = (x: Scored) => cue.time?.days.has(startDay(x.item, cue.offset) ?? "") === true;
      const probed = new Set(probedIds ?? []);
      const eligible = this.eligible(scored, cue, probed, bridged, carded, intents);
      // With probes on, up to three of the probes' finds join the judge's candidates beyond the best scored: found for
      // the request's people, organisations or day, they share few of its words and would otherwise never be seen.
      const top = judgeSure
        ? [...sure, ...eligible.filter((x) => !sure.includes(x))].slice(0, this.config.judgeCandidates)
        : eligible.slice(0, this.config.judgeCandidates);
      // A conflicting consequence find takes the first of those seats: nothing else would bring it to the judge.
      const probeSeats =
        this.config.probes && !this.config.probeOff.includes("seats")
          ? [
              ...eligible.filter((x) => bridged.has(x.item.id) && !top.includes(x)).slice(0, 1),
              ...eligible.filter((x) => probed.has(x.item.id) && !bridged.has(x.item.id) && !top.includes(x)),
            ].slice(0, 3)
          : [];
      // A carded item the request violates takes a seat of its own: it shares no word with the request, so nothing
      // else would bring it before the judge (`cards`).
      const cardSeat = eligible
        .filter((x) => carded.get(x.item.id)?.violated && !top.includes(x) && !probeSeats.includes(x))
        .sort((a, b) => cardRank(carded.get(b.item.id)!) - cardRank(carded.get(a.item.id)!))
        .slice(0, 1);
      // `intent`: the best intent hits the lexical order left out take seats of their own (`intentSeats`), for the
      // judge to read: their requests say the request is one they would change, though they share few of its words.
      const intentSeats = this.deps.model
        ? eligible
            .filter(
              (x) => intents.has(x.item.id) && !top.includes(x) && !probeSeats.includes(x) && !cardSeat.includes(x),
            )
            .sort((a, b) => intents.get(a.item.id)!.rank - intents.get(b.item.id)!.rank)
            .slice(0, this.config.intentSeats)
        : [];
      const seats = [...cardSeat, ...intentSeats, ...probeSeats];
      const unsure = [...top, ...seats];
      // A probe that brought in what is seated for the judge did its part, whatever the judge then makes of it: the
      // judge rules on relevance, the probe only on finding (`probeYield`).
      if (this.config.probeYield && !s.closed) {
        this.economy.reached(
          s.scope,
          unsure.map((x) => x.item.id),
        );
      }
      if (unsure.length === 0) {
        dumped("lookup", [], "");
        done("silent", "no candidates");
        return null;
      }
      // With no model to judge: what the request's people and days ground first (D44), then D36's fallback.
      const noModel = async (why: string, reasonPrefix: string): Promise<Injection | null> => {
        // What scored as sure is delivered as it would have been with no judge to ask: a failing or unaffordable
        // model is never worse than none (D41).
        if (judgeSure) {
          dumped("lookup", sure, "sure", true);
          done(
            "sources",
            cue.id + reasonPrefix,
            sure.map((x) => x.item),
          );
          return await this.deliverChecked(s, sure, "proactive", `sources:${cue.id}`, cue);
        }
        // Grounding reads every candidate, not only the judge's few: a day's events rank after every word match.
        const grounding = spans?.open("ground", cue.span, { candidates: eligible.length });
        const grounded = this.grounded(s, cue, eligible, eventKind, bridged, consequence?.cls, carded);
        if (grounding) spans!.close(grounding, { grounded: grounded.items.length });
        if (grounded.items.length > 0) {
          dumped("lookup", grounded.items, `grounded-${grounded.how}`, true);
          done(
            "sources",
            `grounded-${grounded.how}${reasonPrefix}:${cue.id}`,
            grounded.items.map((x) => x.item),
          );
          return await this.deliverChecked(s, grounded.items, "proactive", `grounded-${grounded.how}:${cue.id}`, cue);
        }
        const falling = spans?.open("fallback", cue.span);
        const top = this.fallback(unsure, cue);
        if (falling) spans!.close(falling, { picked: top !== null });
        const items = top ? [top] : [];
        dumped("lookup", items, "fallback", true);
        if (top) {
          done("sources", `fallback${reasonPrefix}:${cue.id}`, [top.item]);
          return await this.deliverChecked(s, items, "proactive", `fallback:${cue.id}`, cue);
        }
        done("silent", why);
        return null;
      };
      // `judgeTied`: a judge shown only candidates the request is barely tied to (one common word each: "nice",
      // "week", "calendar") says "none" almost always, so the call is not made and the lookup ends silent. A candidate
      // is tied by a probe's find, a day the request names, two of its words, or one word few of the user's items hold.
      // A consequence find that conflicts with the request (`bridged`) is tied by its class's words, which the
      // request never uses: without this, the judge never sees the constraint the probe was sent to find.
      const tiedBy =
        (rare: ReturnType<ContextPartner["rareTerms"]>) =>
        (x: Scored): boolean =>
          probed.has(x.item.id) ||
          bridged.has(x.item.id) ||
          carded.get(x.item.id)?.violated === true ||
          intents.has(x.item.id) ||
          onNamedDay(x) ||
          x.matched >= 2 ||
          this.holdsAny(s, x, rare);
      if (this.deps.model && this.config.judgeTied) {
        const tying = spans?.open("judge.tied", cue.span);
        const tied = tiedBy(this.rareTerms(s, cue));
        const any = unsure.some(tied);
        if (tying) spans!.close(tying, { tied: any });
        if (!any) {
          done("silent", "judge: untied");
          return null;
        }
      }
      const reservation = this.deps.model ? this.charge(s) : null;
      if (!this.deps.model || !reservation) return noModel(this.deps.model ? "no model budget" : "no model", "");
      const candidates = unsure.map((x) => x.item);
      let res: Awaited<ReturnType<Model["chat"]>>;
      const building = spans?.open("judge.build", cue.span, { candidates: candidates.length });
      const messages = judgeMessages(
        s.window.join("\n"),
        candidates,
        this.config.probes,
        this.config.compactInjection ? focusOf(cue) : undefined,
        { windowChars: this.config.judgeWindowChars, itemBytes: this.config.judgeItemBytes },
      );
      if (building) spans!.close(building, { chars: messages.reduce((n, m) => n + m.content.length, 0) });
      const calling = spans?.open("model", cue.span, { async: true, role: "judge" });
      try {
        res = await this.deps.model.chat({
          messages,
          cacheKey: userCacheKey(s.scope),
          maxTokens: JUDGE_MAX_TOKENS,
          reasoning: "low",
          json: true,
          signal: s.abort.signal,
        });
      } catch {
        if (calling) spans!.close(calling, { error: true });
        this.settle(reservation, 0);
        if (s.closed) return null;
        // A failing model (bad key, spend limit, outage) is treated as no model, never worse than none (D41). The
        // reason keeps the cause, so a broken key does not look like a healthy keyless server in traces.
        return noModel("model error", ":model-error");
      }
      if (calling) spans!.close(calling, modelAttrs(res));
      modelCalls = 1;
      costUsd = res.costUsd;
      this.settle(reservation, res.costUsd);
      if (s.closed) return null;
      const parsing = spans?.open("judge.parse", cue.span);
      const picked = parseJudge(res.text, candidates.length)
        .slice(0, this.config.maxItemsPerInjection)
        .map((i) => unsure[i]!);
      if (parsing) spans!.close(parsing, { picked: picked.length });
      // A verdict cut off at the token cap is no verdict: the no-model path decides, as for a failing call (D41,
      // D45), rather than reading the cut-off text as "none".
      if (picked.length === 0 && res.truncated) return noModel("model truncated", ":model-truncated");
      if (picked.length === 0) {
        done("silent", "model: none");
        return null;
      }
      done(
        "model",
        cue.id,
        picked.map((x) => x.item),
      );
      return await this.deliverChecked(s, picked, "proactive", `model:${cue.id}`, cue);
    } catch {
      // A failing source map or cache never escapes as an unhandled rejection; the lookup just ends silent.
      done("silent", "error");
      return null;
    }
  }

  /**
   * `cards`: the user's cached items whose implication card (`cards.ts`) bears on the request: an action of the
   * request's, and a party it names when the card binds one. Only cards made before the request arrived count: the
   * enrichment runs in the background, so a card made during this lookup lands at a later one (D4). No model, no call:
   * a classification by fixed lexicons and a pass over the user's carded items (at most `maxCardsPerUser` twice).
   */
  private cardFinds(s: Session, cue: Cue): Map<string, CardFind> {
    const out = new Map<string, CardFind>();
    const enricher = this.deps.cards;
    if (!this.config.cards || !enricher) return out;
    const actions = requestActions(cue.raw);
    if (actions.size === 0) return out;
    const now = this.now();
    const ids = enricher.carded(s.scope).filter((id) => this.deps.cache.get(s.scope, id, now) !== null);
    const frame = this.frame(cue);
    for (const [id, card] of enricher.cardsOf(s.scope, ids, cue.arrived ?? now)) {
      const m = cardVerdict(card, frame, actions);
      if (m) out.set(id, { ...m, spanDays: spanDays(card) });
    }
    // Bounded: the best matches only, so a user with many constraint cards never floods the candidates.
    return new Map([...out].sort((a, b) => cardRank(b[1]) - cardRank(a[1])).slice(0, MAX_CARD_FINDS));
  }

  /**
   * `intent` (D87, docs/research/edge-intent.md): the user's cached items whose requests, written by the card call in
   * the background, best match the request, best first: item id → its place (0-based) and match. A hit holds at least
   * `intentMinMatched` of the request's terms and `intentMinCoverage` of their idf; at most `intentHits` items
   * (`keepIntents`, intent.ts; `intentByKind` treats constraint-carded hits apart, D200). Only requests made before the
   * request arrived count (as for cards). No model, no call: one BM25 search over the user's requests (at most four
   * per carded item).
   */
  private intentFinds(s: Session, cue: Cue): Map<string, IntentFind> {
    const enricher = this.deps.cards;
    if (!this.config.cards || !this.config.intent || !enricher) return new Map();
    const now = this.now();
    const c = this.config;
    // The request as written (redacted), not its content terms: the requests the model wrote are whole sentences in
    // the user's words, verbs included ("approve", "book"), which the cue's terms may leave out.
    const cut = intentCut(c);
    const text = cue.raw.slice(0, INTENT_QUERY_CHARS);
    const accept = (id: string) => this.deps.cache.get(s.scope, id, now) !== null;
    const found = enricher.intentFinds(s.scope, text, cue.arrived ?? now, c.intentHits, accept);
    // `intentByKind`: a second, deeper search for the carded pass only (`intentReach`, intent.ts, says why apart).
    const reach = intentReach(cut);
    const deep = reach > 0 ? enricher.intentFinds(s.scope, text, cue.arrived ?? now, reach, accept) : found;
    return keepIntents(found, cut, deep);
  }

  /**
   * `intent`: the hits (`intentFinds`) that count as intent hits: eligible, a judge seat (`intentSeats`), a tie
   * (`judgeTied`), fused into an ask. The model writes an item's requests from the item's own text, so an inbound
   * message can word itself to be matched by most requests ("reply to the email", "approve the payment"). A hit counts
   * only when its item also holds a card, whose words the anchor check tied to the item (`anchored`), or when its
   * requests hold one of the request's rare words (fewer than `judgeTiedShare` of the user's items hold it, or none):
   * a request in words common to the user's mail ("reply", "email", "meeting") is no anchor, a name, a thing or a
   * verb the mail rarely uses is ("savings", "laptop"). Any other hit stays a candidate as the ranking found it.
   * Re-ranked from 0. No model, no call.
   */
  private anchoredIntents(s: Session, cue: Cue, found: ReadonlyMap<string, IntentFind>): Map<string, IntentFind> {
    const out = new Map<string, IntentFind>();
    const enricher = this.deps.cards;
    if (found.size === 0 || !enricher) return out;
    const before = cue.arrived ?? this.now();
    const cards = enricher.cardsOf(s.scope, found.keys(), before);
    const rare = new Set<string>();
    for (const w of cue.raw
      .slice(0, INTENT_QUERY_CHARS)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (w.length < 3 || isStopword(w)) continue;
      if (this.deps.cache.isRare(s.scope, w, this.config.judgeTiedShare)) rare.add(stemWord(w));
    }
    for (const [id, f] of found) {
      const carded = (cards.get(id)?.kind ?? "none") !== "none";
      const tied = () => intentTerms(enricher.requestsOf(s.scope, id, before).join("\n")).some((t) => rare.has(t));
      if (carded || tied()) out.set(id, { ...f, rank: out.size });
    }
    return out;
  }

  /**
   * The request's words (cue and entities, stopwords out) that fewer than `judgeTiedShare` of the user's items hold:
   * a name, a reference, a place, rather than words common to their mail. Ids in the user's cache vocabulary; a word
   * no cached item holds has no id and so ties nothing (`judgeTied`).
   */
  private rareTerms(s: Session, cue: Cue): number[] {
    const vocab = this.deps.cache.peekVocab(s.scope);
    if (!vocab) return [];
    const q = termIds(`${cue.text} ${cue.entities.join(" ")}`, vocab, false);
    const out: number[] = [];
    for (let i = 0; i < q.n; i++) {
      const id = q.ids[i]!;
      const word = vocab.term(id);
      if (isStopword(word) || out.includes(id)) continue;
      if (this.deps.cache.isRare(s.scope, word, this.config.judgeTiedShare)) out.push(id);
    }
    return out;
  }

  /** Whether the cached item `x` was ranked from holds one of `terms` (whole terms, the cache's index). */
  private holdsAny(s: Session, x: Scored, terms: readonly number[]): boolean {
    if (x.doc === undefined) return false;
    for (const id of terms) if (this.deps.cache.containsAll(s.scope, x.doc, [id], 1)) return true;
    return false;
  }

  private charge(s: Session, usd = this.config.estimatedCallUsd): Reservation | null {
    return this.deps.budget.reserve(scopeKey(s.scope), s.key, usd);
  }

  /**
   * Books a call's real cost against the session and day it was charged to. A session that ended mid-call already
   * dropped its tally (`close`), so only the user's day is corrected; a new session reusing the id is not touched.
   */
  private settle(r: Reservation, actualUsd: number): void {
    this.deps.budget.settle(r, actualUsd);
  }

  /** The citations of what was rendered. */
  private cited(items: readonly ContextItem[]): Citation[] {
    return citationsOf([...items]);
  }

  /**
   * How an ask's answer is rendered. Not compacted, it says each item whole; `compactAsk` cuts each item to what
   * bears on the question as a packet's are, and `askDedup` says an item this session already showed by what is new
   * in it, or by its title alone.
   */
  private answering(s: Session, cue: Cue): Parameters<typeof renderPacket>[1] {
    const shown = this.config.askDedup ? s.shown : undefined;
    const compact = this.config.compactAsk;
    const dense = compact && this.config.densePacket;
    return {
      maxBytes: 4_000,
      ...(compact
        ? {
            focus: focusOf(cue),
            itemBytes: this.config.askItemBytes,
            // No `year`: an answer's dates stay as the source wrote them, as they did whole ("9 Oct 2026").
            self: this.deps.cache.selfOf(s.scope),
            dense,
          }
        : {}),
      ...(shown ? { shownBefore: (item: ContextItem) => shown.get(shownKey(item)) } : {}),
      ...(this.config.compactParts ? { split: true } : {}),
    };
  }

  /**
   * With `askDedup`, keeps the words each item's line in `text` (a rendered packet or answer of `items`, in order)
   * showed the agent. A line is matched to its item by its `[source]` tag; a packet cut short has fewer lines.
   */
  private noteShown(s: Session, items: readonly ContextItem[], text: string): void {
    // Item lines only.
    const lines = text
      .split("\n")
      .slice(1, -1)
      .filter((line) => line.startsWith("- ["));
    const shown = (s.shown ??= new Map());
    // A packet's dates leave out the current year ("9 Oct"), meaning this one: an answer saying it is no news.
    const year = String(new Date(this.now()).getUTCFullYear());
    for (const [k, line] of lines.entries()) {
      const item = items[k];
      if (!item || !line.startsWith(`- [${item.sourceId}] `)) break;
      const key = shownKey(item);
      const words = shown.get(key) ?? new Set<string>([year]);
      const said = line.slice(line.indexOf("] ") + 2);
      for (const w of `${item.sourceId} ${said}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) words.add(w);
      shown.delete(key); // re-inserted last: the most recently shown is dropped last
      shown.set(key, words);
    }
    while (shown.size > MAX_SHOWN) shown.delete(shown.keys().next().value!);
  }

  /**
   * `shown` is what the agent receives when it is not the injection's own text (an ask's answer). With
   * `compactInjection`, each item is cut to what bears on `cue` (`compactText`) rather than to its first bytes.
   */
  private deliver(
    s: Session,
    scored: Scored[],
    mode: InjectionMode,
    reason: string,
    cue: Cue,
    shown?: string,
    frame?: PacketFrame,
  ): Injection {
    const spans = this.spans;
    const sp = spans?.open("deliver", cue.span, { items: scored.length });
    const injection = this.build(s, scored, mode, reason, cue, sp?.id ?? 0, shown, frame);
    if (sp) spans!.close(sp, { bytes: injection.text.length });
    return injection;
  }

  private build(
    s: Session,
    scored: Scored[],
    mode: InjectionMode,
    reason: string,
    cue: Cue,
    parent: number,
    shown?: string,
    frame?: PacketFrame,
  ): Injection {
    const spans = this.spans;
    // Whatever path delivered them, a probe that first brought one in paid for its call (`probeYield`).
    if (this.config.probeYield) {
      this.economy.reached(
        s.scope,
        scored.map((x) => x.item.id),
      );
    }
    for (const x of scored) if (x.sketch) s.delivered.push(x.sketch);
    if (s.delivered.length > 200) s.delivered.splice(0, s.delivered.length - 200);
    // Every item counts as delivered, an echo folded out of the packet too: the agent has its occurrence.
    s.ledger.mark(
      scored.map((x) => x.item.id),
      s.turn,
      // `syncPollBehind` answers from copies its poll may then correct: each delivery's words are kept to tell.
      this.config.syncPollBehind ? scored.map((x) => versionOf(x.item)) : undefined,
    );
    const dense = this.config.densePacket && this.config.compactInjection;
    const self = this.config.compactInjection ? this.deps.cache.selfOf(s.scope) : null;
    const folding = dense ? spans?.open("fold", parent) : undefined;
    const shownItems = dense
      ? foldEchoes(scored, {
          focus: focusOf(cue),
          year: new Date(this.now()).getUTCFullYear(),
          self,
          rare: (w) => this.deps.cache.isRare(s.scope, w, RARE_SHARE),
        })
      : scored;
    if (folding) spans!.close(folding, { kept: shownItems.length });
    const items = shownItems.map((x) => x.item);
    const rendering = spans?.open("render", parent, { items: items.length });
    const options: Parameters<typeof renderPacket>[1] = {
      maxBytes: frame?.maxBytes ?? this.config.maxInjectionBytes,
      ...(frame ? { lead: frame.lead } : {}),
      ...(this.config.compactInjection || frame
        ? {
            focus: focusOf(cue),
            itemBytes: frame?.itemBytes ?? this.config.compactItemBytes,
            year: new Date(this.now()).getUTCFullYear(),
            self,
            dense,
          }
        : {}),
      ...(this.config.compactParts ? { split: true } : {}),
    };
    const injection: Injection = {
      ...s.scope,
      id: newId("inj", this.now()),
      sessionId: s.id,
      mode,
      text: renderPacket(items, options),
      citations: this.cited(items),
      reason,
      score: Math.max(...scored.map((x) => x.score)),
      createdAt: this.now(),
    };
    if (rendering) spans!.close(rendering);
    this.built.set(injection, {
      sourceIds: [...new Set(items.map((i) => i.sourceId))],
      items: items.map((i) => ({ sourceId: i.sourceId, id: i.id })),
      // Only the words the agent received: an item's text past the packet's cut is not evidence of use.
      text: shownText(shown ?? injection.text),
      // What the agent will have been shown of each item once it is handed out (`markShown`): an answer's lines are
      // its items' in order (not folded); a model's composed answer has no item lines and is attributed to none.
      ...(this.config.askDedup
        ? { shown: { items: shown === undefined ? items : scored.map((x) => x.item), text: shown ?? injection.text } }
        : {}),
      ...(this.config.revisionNotice
        ? {
            copies: renderedCopies(
              shown === undefined ? items : scored.map((x) => x.item),
              shown ?? injection.text,
              this.config.revisionDiff,
            ),
          }
        : {}),
    });
    return injection;
  }

  /** Per-phase totals of the spans so far (`config.spans`); empty when it is off. */
  spanStats(): SpanStat[] {
    return this.stats?.snapshot() ?? [];
  }

  /**
   * `source` with each call it answers recorded as a span under `parent` (spans on only): a `source.search` or
   * `source.fetch` span per call that reaches the connector, so a planner's several calls and a probe's are each seen.
   * The connector id, the page size and whether it failed: never the query. A call the fan-out answers from its cache
   * never reaches this, and has no span.
   */
  private traced(source: Source, parent: number): Source {
    const spans = this.spans!;
    const fetch = source.fetch?.bind(source);
    return {
      id: source.id,
      kind: source.kind,
      description: source.description,
      ...(source.listsByTime !== undefined ? { listsByTime: source.listsByTime } : {}),
      ...(source.notifies !== undefined ? { notifies: source.notifies } : {}),
      ...(source.fetchReportsGone !== undefined ? { fetchReportsGone: source.fetchReportsGone } : {}),
      ...(source.fetchesById !== undefined ? { fetchesById: source.fetchesById } : {}),
      // A listing (the sync, D57) is traced by the sync itself (`sync.list`): passed through as it is.
      ...(source.list ? { list: source.list.bind(source) } : {}),
      // One `then`, no async frame of its own: a source call is the most frequent span (tracing overhead).
      search: (query, signal) => {
        const sp = spans.open("source.search", parent, { async: true, source: source.id, window: !!query.window });
        const failed = (e: unknown): never => {
          spans.close(sp, { error: true });
          throw e;
        };
        let pending: Promise<ContextItem[]>;
        try {
          pending = source.search(query, signal);
        } catch (e) {
          return Promise.reject(e).catch(failed);
        }
        return pending.then((page) => {
          if (page && typeof page === "object") spans.page(page, sp.id);
          spans.close(sp, { items: Array.isArray(page) ? page.length : 0 });
          return page;
        }, failed);
      },
      ...(fetch
        ? {
            fetch: async (ref: string, scope: Scope, signal: AbortSignal) => {
              const sp = spans.open("source.fetch", parent, { async: true, source: source.id });
              try {
                const item = await fetch(ref, scope, signal);
                // The fan-out gates `[item]`, a new array: the item names the call.
                if (item) spans.page(item, sp.id);
                spans.close(sp, { items: item ? 1 : 0 });
                return item;
              } catch (e) {
                spans.close(sp, { error: true });
                throw e;
              }
            },
          }
        : {}),
    };
  }

  private usage(u: UsageRecord): void {
    try {
      this.deps.onUsage?.({ ...u, sourceIds: [...u.sourceIds] });
    } catch {
      // A broken sink never breaks learning or feedback.
    }
  }

  private trace(s: Session, t: Trace): void {
    // The session's last decisions, for `explain` (D277): content-free like the trace itself, dropped with the session.
    s.traces.push(t);
    if (s.traces.length > EXPLAIN_TRACES) s.traces.shift();
    try {
      this.deps.onTrace?.(t);
    } catch {
      // A broken sink never breaks a delivery.
    }
  }
}

const NO_TERMS = new Uint32Array(0);

/** How many of a session's decisions `explain` keeps (D277): a few turns of a task, about 200 bytes each. */
export const EXPLAIN_TRACES = 32;

/**
 * `ObserveResult.pending`: slower work may still queue an injection. That is a lookup in flight, work a lookup left
 * running behind its answer (`syncPollBehind`'s poll and follow-up, `readerPushBehind`'s second reading), or a queued
 * delivery.
 */
function pendingOf(s: Session): boolean {
  return s.inflight !== null || !!s.behind || s.pending.length > 0;
}

/** `pushCandidates` (D236): the most of an item a candidate's excerpt says, whatever `compactItemBytes` is set to. */
const MAX_CANDIDATE_BYTES = 2_000;

/** `planConflict` (D301): acting requests a session keeps, and how much of one its packet quotes. */
const PLAN_REQUESTS = 12;
const PLAN_QUOTE_CHARS = 200;
const PLAN_WAITING = 64;
const PLAN_SENT = 256;

/** `pushCandidates` (D236): a candidates' packet's framing line and cut. */
interface PacketFrame {
  lead: string;
  itemBytes: number;
  maxBytes: number;
}

/** `revisionNotice`: an "updated:" packet's reason prefix, and what each of its items' titles starts with. */
const UPDATED = "updated:";
const UPDATED_TAG = "updated: ";
const UPDATED_NOTE = " (changed at its source since shown earlier; this version replaces it)";

/** `pollRevised`: the least time between two notice polls of one user's source, and how many sources it tracks. */
const REVISION_POLL_GAP_MS = 30_000;
const MAX_REVISION_SOURCES = 10_000;

interface RevisionSource {
  running: boolean;
  /** A notice came while the poll ran: one more poll once it settles. */
  again: boolean;
  /** When the last poll started (engine clock). */
  at: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Resolves when `signal` aborts (at once if it has). */
function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })));
}

/** What a packet hands the agent of an item (`revisionNotice`): its version and, for `revisionDiff`, its times. */
interface Copy {
  id: string;
  sourceId: string;
  version: number;
  times?: string[];
}

/** Each item's copy; its times only with `revisionDiff` (`withTimes`), so the switch off reads no text for them. */
function copiesOf(items: readonly ContextItem[], withTimes: boolean): Copy[] {
  return items.map((it) =>
    withTimes
      ? { id: it.id, sourceId: it.sourceId, version: versionOf(it), times: timesOf(it) }
      : { id: it.id, sourceId: it.sourceId, version: versionOf(it) },
  );
}

/** A clock time ("9:15", "14:00", "3pm"), a day and month either way round, or a weekday (`revisionDiff`). */
const MONTH =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|" +
  "nov(?:ember)?|dec(?:ember)?)";
const TIME_OR_DATE = new RegExp(
  "\\b(?:([01]?\\d|2[0-3]):([0-5]\\d)(?:\\s?([ap]m))?|(1[0-2]|0?[1-9])\\s?([ap]m)|" +
    `(\\d{1,2})(?:st|nd|rd|th)?\\s${MONTH}|${MONTH}\\s(\\d{1,2})(?:st|nd|rd|th)?|` +
    "((?:mon|tues|wednes|thurs|fri|satur|sun)day))\\b",
  "gi",
);
/** At most this many times are read from one item (`revisionDiff`). */
const MAX_ITEM_TIMES = 16;

/** A 12-hour clock's hour in 24-hour form. */
const hour24 = (h: number, ampm: string | undefined) =>
  ampm === undefined ? h : (h % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * `revisionDiff` (D342): the distinct times and dates in an item's title and text, in order, each in one form so a
 * reworded time is the same time: a clock as 24-hour "HH:MM" ("9:30am", "09:30" and "9:30" are "09:30"; "3pm" is
 * "15:00"), a date as "<day> <3-letter month>" ("Oct 4th" and "4 October" are "4 oct"), a weekday lowercased. No
 * model: a pattern over the words, so "3.45" (a price) is no time and "decision 2" no date. An unmarked clock is read
 * as 24-hour: "9:30" then "9:30pm" says 09:30 is gone, the honest reading of an ambiguous edit. Exported for tests.
 */
export function timesOf(item: Pick<ContextItem, "title" | "text">): string[] {
  const out: string[] = [];
  for (const m of `${item.title}\n${item.text}`.matchAll(TIME_OR_DATE)) {
    let t: string;
    if (m[1] !== undefined) t = `${pad(hour24(Number(m[1]), m[3]))}:${m[2]}`;
    else if (m[4] !== undefined) t = `${pad(hour24(Number(m[4]), m[5]))}:00`;
    else if (m[6] !== undefined) t = `${Number(m[6])} ${m[7]!.slice(0, 3).toLowerCase()}`;
    else if (m[8] !== undefined) t = `${Number(m[9])} ${m[8].slice(0, 3).toLowerCase()}`;
    else t = m[10]!.toLowerCase();
    if (!out.includes(t)) out.push(t);
    if (out.length >= MAX_ITEM_TIMES) break;
  }
  return out;
}

/**
 * How many of `items`, in order, have their line in `text` (a packet or answer: one `- [source] …` line each, in
 * the items' order, until the size cut), as `noteShown` reads them.
 */
function renderedCount(items: readonly ContextItem[], text: string): number {
  const lines = text.split("\n").filter((line) => line.startsWith("- ["));
  let n = 0;
  while (n < items.length && n < lines.length && lines[n]!.startsWith(`- [${items[n]!.sourceId}] `)) n++;
  return n;
}

/** The copies of the items whose lines the agent receives: one cut from the text was not shown. */
function renderedCopies(items: readonly ContextItem[], text: string, withTimes: boolean) {
  return copiesOf(items.slice(0, renderedCount(items, text)), withTimes);
}

/** An item's words as the ledger records them (`Ledger.revised`): a copy edited at its source hashes otherwise. */
function versionOf(item: ContextItem): number {
  return hashString(`${item.title}\n${item.text}`, 0);
}

/**
 * An item's key in `Session.shown`: its id and its words' version. A sync that changes an item's words ("approved"
 * to "not approved", two rows swapped) makes it a new item to the agent, which a bag of shown words cannot see.
 */
function shownKey(item: ContextItem): string {
  return `${item.id}\u0000${versionOf(item)}`;
}

/** A model call's span attributes: tokens, cost and whether it was cut off. Counts only. */
function modelAttrs(res: {
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  truncated?: boolean;
}) {
  return {
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    costUsd: res.costUsd,
    truncated: res.truncated === true,
  };
}

/**
 * An ask's answer text (D127): `packet` (empty when no item answers), with the sources the ask chose that did not
 * answer named. An empty answer reads "Nothing in the connected sources." only when every chosen source answered (or
 * none was chosen); otherwise it says which could not be reached and that this is not an all-clear. Source ids are the
 * operator's names for its connectors, not source text. Items left out because a change signal doubted them and no
 * re-read confirmed them (`unconfirmed`, by source, D211) are named too: an answer short of them is not an all-clear.
 */
function honestAnswer(
  packet: string,
  sources: readonly SourceStatus[] | undefined,
  unresolved = false,
  closed = false,
  unconfirmed?: ReadonlyMap<string, number>,
  unswept?: ReadonlyMap<string, number>,
): string {
  const told = reachAnswer(packet, sources, unresolved, closed);
  const notes: string[] = [];
  const list = (m: ReadonlyMap<string, number>) => [...m].map(([id, n]) => `${id} (${n})`).join(", ");
  if (unconfirmed && unconfirmed.size > 0) {
    const why = "their source reported changes and they could not be re-checked";
    notes.push(`Left out items from ${list(unconfirmed)}: ${why}`);
  }
  // D356: a source swept weekly whose copies no listing has seen for a day; nothing was reported about them.
  if (unswept && unswept.size > 0) {
    const why = "no recent listing of their source confirms them and they could not be re-checked";
    notes.push(`Left out items from ${list(unswept)}: ${why}`);
  }
  if (notes.length === 0) return told;
  const left = notes.join(". ");
  // An answer that would read as an all-clear says it is not one.
  if (told === "Nothing in the connected sources.")
    return `Nothing confirmed in the connected sources. ${left}, so this is not an all-clear.`;
  return `${told}\n${left}.`;
}

/** `honestAnswer` without the unconfirmed items: the packet and the sources that did not answer (D127). */
function reachAnswer(
  packet: string,
  sources: readonly SourceStatus[] | undefined,
  unresolved: boolean,
  closed: boolean,
): string {
  if (closed) {
    const none = "The session ended before the sources were searched, so this is not an all-clear.";
    return packet ? `${packet}\n${none}` : none;
  }
  if (unresolved) {
    const none = "Could not reach the connected sources (they could not be listed), so this is not an all-clear.";
    return packet ? `${packet}\n${none}` : none;
  }
  // `askBehind` (D430): sources still being read when the ask answered are named apart from those that failed.
  const reading = (sources ?? []).filter((x) => x.status === SEARCHING);
  // `sourceYield` (D505): cut copies the ask did not search are named apart too: nothing failed.
  const skipped = (sources ?? []).filter((x) => x.status === UNSEARCHED);
  const missed = (sources ?? []).filter(
    (x) => !ANSWERED.has(x.status) && x.status !== SEARCHING && x.status !== UNSEARCHED,
  );
  const told = unreached(packet, sources ?? [], missed);
  if (reading.length === 0 && skipped.length === 0) return told;
  const some = (xs: readonly SourceStatus[]) =>
    `${xs
      .slice(0, 3)
      .map((x) => x.sourceId)
      .join(", ")}${xs.length > 3 ? ` and ${xs.length - 3} more` : ""}`;
  const notes: string[] = [];
  if (reading.length > 0)
    notes.push(`Still reading ${some(reading)}: anything there that fits follows as a later packet`);
  if (skipped.length > 0) {
    // True of both rules that skip a read (the source's run, and a source with nothing used yet, D603): neither
    // skips a source the request names. The run rule can skip one the request's common words touch, so the line
    // says "names", not "points there" (review of the D603 merge).
    notes.push(`Not searched past what is held of ${some(skipped)}: nothing in the request names it`);
  }
  if (told === "Nothing in the connected sources.") {
    const head = reading.length > 0 ? "Nothing found yet." : "Nothing found in what was searched.";
    return `${head} ${notes.join(". ")}, so this is not an all-clear${reading.length > 0 ? " yet" : ""}.`;
  }
  return `${told}\n${notes.join(". ")}.`;
}

/** `reachAnswer`'s text for the sources that did not answer (`missed`), as D127 words it. */
function unreached(packet: string, sources: readonly SourceStatus[], missed: readonly SourceStatus[]): string {
  if (missed.length === 0) return packet || "Nothing in the connected sources.";
  const names = missed.map((x) => `${x.sourceId} (${STATUS_WORDS[x.status] ?? x.status})`).join(", ");
  if (packet) return `${packet}\nCould not reach ${names}: this answer may be missing what they hold.`;
  const answered = sources.filter((x) => ANSWERED.has(x.status)).map((x) => x.sourceId);
  if (answered.length === 0) return `Could not reach ${names}, so this is not an all-clear: nothing was checked.`;
  return `Nothing in ${answered.join(", ")}. Could not reach ${names}, so this is not an all-clear.`;
}

/** A search's span attributes: how many sources answered each way. */
function outcomeAttrs(outcomes: readonly FanoutOutcome[]): Record<string, number> {
  const out: Record<string, number> = { sources: outcomes.length };
  for (const o of outcomes) out[o.status] = (out[o.status] ?? 0) + 1;
  return out;
}

/** A card's match against a request (`cardVerdict`), with its span's length for ranking. */
interface CardFind {
  violated: boolean;
  tied: "name" | "word" | null;
  /** Days the card's span covers (Infinity when open or none): a narrower span says more about the day asked. */
  spanDays: number;
}
/** The head of a request matched against the intent index (`intent`): where its action and objects are named. */
const INTENT_QUERY_CHARS = 400;

/** An item the intent index found for a request (`intent`): its place among the hits, and how its requests matched. */
interface IntentFind {
  rank: number;
  coverage: number;
  matched: number;
}

/**
 * `p`'s value if it settles within `ms`, else null (it runs on; a rejection after the bound is swallowed). Not an
 * async function: an answer already in settles as soon as awaiting `p` itself would.
 */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
  p.catch(() => {}).finally(() => clearTimeout(timer));
  return Promise.race([p, late]);
}

/** Card finds a lookup ranks at most (`cards`). */
const MAX_CARD_FINDS = 6;
/** Violated first, then tied by a name, then by a word, then the narrower span. */
function cardRank(f: CardFind): number {
  const span = Number.isFinite(f.spanDays) ? Math.max(0, 1 - f.spanDays / 400) : 0;
  return (f.violated ? 8 : 0) + (f.tied === "name" ? 4 : f.tied === "word" ? 2 : 0) + span;
}
function spanDays(c: { start?: string; end?: string }): number {
  if (!c.start || !c.end) return Infinity;
  return (Date.parse(c.end) - Date.parse(c.start)) / 86_400_000 + 1;
}

/** The request's words and its people's names, lowercased: what a compacted packet keeps the parts holding. */
function focusOf(cue: Cue): Set<string> {
  const words = `${cue.text} ${cue.entities.join(" ")}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => w.length > 1 && !isStopword(w)));
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Replaces a session's vocabulary with one holding only the terms it still refers to: seen terms (in the same order),
 * the distinctive terms of injections awaiting use, and the newest agent-held events. Ids change; nothing else holds
 * them.
 */
function rebuildVocab(s: Session, maxTerms: number): void {
  const old = s.vocab;
  const vocab = new Vocab(Math.max(256, s.seen.size * 2));
  const seen = new Set<number>();
  for (const id of s.seen) seen.add(vocab.intern(old.term(id)));
  for (const o of s.outstanding.values()) {
    const tokens = new Set<number>();
    for (const id of o.tokens) tokens.add(vocab.intern(old.term(id)));
    o.tokens = tokens;
  }
  // The newest held events keep their terms under the new ids while they fit in a quarter of the cap; older ones are
  // dropped, which only errs toward delivering.
  const agentHas: Held[] = [];
  const remap = (id: number) => vocab.intern(old.term(id));
  let room = Math.floor(maxTerms / 4);
  for (let i = s.agentHas.length - 1; i >= 0 && s.agentHas[i]!.terms.length <= room; i--) {
    const held = s.agentHas[i]!;
    room -= held.terms.length;
    // New ids do not keep the old order, so both arrays are sorted again after the remap.
    const terms = held.terms.map(remap);
    const pairs = held.pairs.map((p) => pairKey(remap(Math.floor(p / PAIR_BASE)), remap(p % PAIR_BASE)));
    agentHas.unshift({ terms: sortedUnique(terms), pairs: sortedUnique(pairs) });
  }
  s.agentHas = agentHas;
  s.vocab = vocab;
  s.seen = seen;
}

/** What `searchLive` returns: the calls it made and what the lookup's ranking reads from them. */
type SearchedLive = Awaited<ReturnType<ContextPartner["searchLive"]>>;

/** `ask`'s second argument, for the engine's own asks (`readerPush`); an embedder's ask passes none. */
interface AskInternal {
  push?: boolean;
  /** The session's request count when the push's request was counted: a later request makes it stale. */
  request?: number;
  /** The session's turn when the push's request was counted: the push's trace reports it (audit A11). */
  turn?: number;
  /** `pushOpen` (D702): the push started on the message's shape (`isOpenRequest`), not on a listed verb. */
  open?: boolean;
  /** `readerPushBehind`'s second reading: the first one's search, and the packet it queued. */
  again?: { searched: SearchedLive; prev: Injection | null };
  /**
   * `askBehind` (D430): the follow-up of an explicit ask that answered before its sources were read: the ask's search,
   * the ids its answer cited, and the session's request count when it was asked.
   */
  late?: { searched: SearchedLive; cited: ReadonlySet<string>; request: number };
}

/** `readAsk`'s options: whether it reads for the push, and the push's request. */
interface ReadOpts {
  push?: boolean;
  /** The push's request (`AskInternal.request`), recorded with its reading for `readerReuse`. */
  request?: number;
}

/** No reading: no verdict, no call, nothing spent. */
const NO_READ: ReaderRead = { verdict: null, costUsd: 0, called: false, overBudget: false };

const sessionKey = (e: Scope & { sessionId: string }) => `${scopeKey(e)}#${e.sessionId}`;

const sameEntry = (a: LedgerEntry | undefined, b: LedgerEntry | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.turn === b.turn && a.version === b.version);

/** An opaque per-user key for provider sticky routing (prompt-cache reuse): a hash, never the ids themselves. */
export const userCacheKey = (scope: Scope) =>
  `eden-${createHash("sha256").update(scopeKey(scope)).digest("hex").slice(0, 24)}`;

function eventText(e: AgentEvent): string {
  switch (e.kind) {
    case "user_message":
    case "agent_message":
    case "external":
      return e.text;
    case "tool_call":
      return `${e.tool} ${typeof e.input === "string" ? e.input : JSON.stringify(e.input ?? "")}`;
    case "tool_result":
      return `${e.tool} ${e.output}`;
    default:
      return "";
  }
}

/** Proactive lookups start from what the user or the world says, not from the agent's own words. */
function wantsLookup(e: AgentEvent, text: string, terms: Uint32Array, vocab: Vocab): boolean {
  if (e.kind !== "user_message" && e.kind !== "external") return false;
  return !isChatterTerms(text, terms, vocab);
}

/** Whether a request names days and nothing but days and calendar words: a listing of the days answers it (D44). */
function onlyTime(cue: Cue): boolean {
  return (
    (cue.time?.days.size ?? 0) > 0 && cue.entities.length === 0 && cue.text.split(" ").every((w) => TIME_WORD.test(w))
  );
}

/** The cue's time on the user's wall clock, read as UTC: its ISO day is the user's day. */
const localNow = (cue: Cue) => cue.at + cue.offset * 60_000;

/** `offset`: the user's UTC offset in minutes, so "today" is their today (D44). */
function buildCue(text: string, ids: Uint32Array, vocab: Vocab, at: number, offset: number, probes = false): Cue {
  // With probes on, a sentence's leading verb is not part of the name it starts ("Send Rose Kimura").
  const entities = (probes ? cleanEntities(extractEntities(text)) : extractEntities(text)).slice(0, 8);
  const terms = contentTermsOf(ids, vocab).slice(0, 16); // Distinct already.
  const key = (entities.length ? entities.map((e) => e.toLowerCase()) : terms).slice().sort().join("|").slice(0, 200);
  // Traces and reasons carry this id, never the cue itself: the cue is the user's words.
  const id = `cue:${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
  return { text: terms.join(" "), entities, key, id, time: timeWindow(text, at, offset), at, raw: text, offset };
}

/**
 * What one agent-held event holds: its terms and its adjacent term pairs (`pairKey`), in session ids, each sorted and
 * unique so membership is a binary search. Typed arrays, not Sets: a session keeps up to `windowEvents` of these, and
 * a Set of numbers costs over 100 bytes an entry against 4 or 8 here (`held.test.ts`: a session with 12 mail
 * listings of 8 KB took 2,096 KB with Sets, 311 KB with these).
 */
interface Held {
  terms: Uint32Array;
  pairs: Float64Array;
}

/**
 * The head of an agent-held event that is kept, and at most this many distinct terms of it: bounds the session
 * vocabulary a rebuild must keep. An item longer than that is never judged held, so the bounds only err toward
 * delivering.
 */
const HELD_CHARS = 8_000;
const MAX_HELD_TERMS = 512;

/** Pair keys are exact while ids stay under 2^21 (a session vocabulary is rebuilt far below that). */
const PAIR_BASE = 2 ** 32;
const pairKey = (a: number, b: number) => a * PAIR_BASE + b;

/** An agent-held event's terms and pairs. Its terms are interned already (`observe`), so none is skipped. */
function heldOf(text: string, vocab: Vocab): Held {
  const { ids, n: all } = termIds(text.slice(0, HELD_CHARS), vocab, false);
  let terms = sortedUnique(ids.subarray(0, all));
  let n = all;
  if (terms.length > MAX_HELD_TERMS) {
    // Rare (an event of over 512 distinct terms): the head up to its 513th distinct term, in reading order.
    const distinct = new Set<number>();
    for (n = 0; n < all && (distinct.has(ids[n]!) || distinct.size < MAX_HELD_TERMS); n++) distinct.add(ids[n]!);
    terms = sortedUnique(ids.subarray(0, n));
  }
  const pairs = new Float64Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i++) pairs[i - 1] = pairKey(ids[i - 1]!, ids[i]!);
  return { terms, pairs: sortedUnique(pairs) };
}

/** A sorted copy of `xs` without repeats, trimmed to fit (a fresh buffer: the input may be a view of a shared one). */
function sortedUnique<T extends Uint32Array | Float64Array>(xs: T): T {
  const sorted = xs.slice().sort() as T;
  let m = 0;
  for (let i = 0; i < sorted.length; i++) if (m === 0 || sorted[i] !== sorted[m - 1]) sorted[m++] = sorted[i]!;
  return m === sorted.length ? sorted : (sorted.slice(0, m) as T);
}

/** Whether sorted `xs` holds `x`. */
function sortedHas(xs: Uint32Array | Float64Array, x: number): boolean {
  let lo = 0;
  let hi = xs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = xs[mid]!;
    if (v === x) return true;
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** The adjacent term pairs of `text` (terms the vocabulary does not know are skipped). */
function pairsOf(text: string, vocab: Vocab): number[] {
  const { ids, n } = termIds(text, vocab, false);
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(pairKey(ids[i - 1]!, ids[i]!));
  return out;
}

/**
 * Bulk mail, by the connector's mailbox category (`meta.category`; Gmail's Promotions tab) or by a title that names
 * itself a newsletter or digest of notifications. A heuristic tuned on one eval scenario (`newsletter-arrives`), kept
 * narrow on purpose: Gmail's Updates tab holds bills and receipts, and words like "webinar", "promotion" or
 * "unsubscribe" appear in real meeting, HR and transactional mail.
 */
const BULK_CATEGORY = /^promotions?$/i;
const BULK_TITLE = /\b(newsletter|top stories|you appeared in)\b/i;

/** A question about what could stop or change an act, and the usual ways to ask whether something is fine to do. */
const ASKS_BLOCKERS =
  /\b(?:block(?:s|ed|ing|er|ers)?|constrain(?:s|t|ts)?|rules?|limits?|holds?|approvals?|policy|policies|availab(?:le|ility)|allowed|permitted|conflicts?|clash(?:es)?|freezes?|frozen|restrictions?|ok(?:ay)? to|safe to|fine to|go ahead)\b/i;

/** Items one `sourceItems` call stores at most (a notification carries a few; a bigger batch is a listing's job). */
const MAX_PUSHED_ITEMS = 100;
/** A ref notice's re-reads run this many at a time (D347): the fan-out's starting concurrency per source. */
const REF_LANES = 2;
/** A ref read the guard skipped or that hit one plain error goes again up to this many times, this far apart (×k). */
const REF_TRIES = 4;
const REF_RETRY_MS = 150;
/**
 * A ref read's deadline: it runs off the agent's path, so it may wait out a connector's slow tail (a hosted
 * connector passed 1.5 s on about one fetch in five, D347) rather than fall back to the source-wide signal.
 */
const REF_TIMEOUT_MS = 5_000;
/** Whether a failed ref read is worth another: our own guard's skip that clears in moments, or a plain error. */
function refTryAgain(got: { why: string; guard?: string; pushedBack?: boolean }): boolean {
  if (got.why === "error") return true;
  return got.why === "refused" && got.guard !== "open" && got.pushedBack !== true;
}

/** The most candidates an ask's reader reads, whatever `askReaderPool` says. */
const READER_POOL_CAP = READER_MAX_ITEMS;
/** `pushCheck` (D500): the push checks a session keeps (a request's first and second pass, and a few before). */
const CHECK_KEPT = 4;

/** `pushCheck` (D500): one kept check: the request and day it read, its items as read (`itemMark`), its answer. */
interface KeptCheck {
  asked: string;
  /** Per item read, `itemMark`: id, content hash, date and sender. */
  marks: Map<string, string>;
  read: Promise<PushCheckRead>;
  settled?: PushCheckRead;
}

/** `pushCandidates` (D236): the push's pool and, per item, whether it is constraint-like. */
interface PushGate {
  pool: Scored[];
  like: boolean[];
}

/** What a re-read found (`verifyDelivery`). */
/**
 * A re-read's outcome. Four ways not to know (D211): "unverifiable" (the source has no fetch tool, or answered null
 * and does not report gone: its items are delivered as held, D126), "skipped" (our own guard refused the call, most
 * often the per-source concurrency limit while the other re-reads hold its slots: no call, no evidence), "flaked"
 * (the call failed with a plain error, worth one retry) and "failed" (a timeout, a 429, the caller giving up, our
 * gate).
 */
type CheckOutcome = "confirmed" | "changed" | "gone" | "failed" | "flaked" | "skipped" | "unverifiable";
/** Re-reads a session keeps (`Session.checks`), and how long one is reused before an item is read again (ms). */
const MAX_CHECKS = 64;
/** Below this much of an ask's wait left (or a quarter of it, if less), the ask starts no reader call of its own. */
const MIN_OWN_READ_MS = 250;

/** A strict (ask) verification's outcomes worth one more read, and how many such reads run at once (D211). */
const RETRIED: ReadonlySet<CheckOutcome> = new Set<CheckOutcome>(["flaked", "skipped"]);
const STRICT_RETRY_LANES = 2;
const CHECK_REUSE_MS = 30_000;
/** `unverifiable`: items held per user, and users held (least recently noted dropped first). */
const MAX_UNVERIFIABLE = 512;
const MAX_UNVERIFIABLE_USERS = 4_096;
/** `unverifiable`: how long a held null stands at most, signal or not (a reply lacking the record may be transient). */
const UNVERIFIABLE_HOLD_MS = 10 * 60_000;
/** How long an item its source said is gone is kept from being stored again (the fan-out's stale-result window). */
const GONE_HOLD_MS = 10 * 60_000;
/** A lookup with less of its deadline left than this sends no live search (D140): no call could answer in time. */
const MIN_SEARCH_MS = 50;
/** Doubted candidates of a reader's pool re-read beside its call (`checkAhead`): about what a delivery cites. */
const VERIFY_AHEAD = 3;

/** The user's day as YYYY-MM-DD, at their offset from UTC (minutes). */
function localDay(at: number, offsetMin: number): string {
  return new Date(at + offsetMin * 60_000).toISOString().slice(0, 10);
}

/**
 * Whether an item looks like bulk mail. Such items are never pushed without a model: their words overlap with real
 * work, and one arriving says nothing about the user's need. The judge still sees them, and an ask still finds them.
 */
function bulkMail(item: ContextItem): boolean {
  const category = item.meta?.category;
  return (category !== undefined && BULK_CATEGORY.test(category)) || BULK_TITLE.test(item.title);
}

/** The names each item mentions, as the source map records them (D57): at most 20 an item, persistable kinds. */
function mentionsOf(items: readonly ContextItem[]): { sourceId: string; entities: string[] }[] {
  return items.map((item) => ({
    sourceId: item.sourceId,
    entities: extractTypedEntities(`${item.title}. ${item.text}`)
      .filter((e) => PERSISTABLE_KINDS.has(e.kind))
      .slice(0, 20)
      .map((e) => e.text),
  }));
}

/** `routeSketch`: a request's terms matched against the sources' sketches, at most (its first). */
const MAX_SKETCH_TERMS = 16;

/** Two routing boosts summed per source; either may be absent. */
function addBoosts(
  a: Map<string, number> | undefined,
  b: Map<string, number> | undefined,
): Map<string, number> | undefined {
  if (!a || !b) return a ?? b;
  const out = new Map(a);
  for (const [id, x] of b) out.set(id, (out.get(id) ?? 0) + x);
  return out;
}

/** `cardsSourceAware` (D320): users with at most this many synced sources have every synced item read, as before. */
const SOURCE_AWARE_MIN = 32;

/** `routeLocalHits`: the user's best local matches for a request that routing counts per source (D265). */
const LOCAL_ROUTE_HITS = 40;

/**
 * A user's sources by id, the first of any repeated id (as `Array.find` gave): a lookup maps routed ids back to sources
 * through it, which was a scan of every source per routed one (quadratic for a user with 1,000 connectors, D261).
 */
function sourcesById(all: readonly Source[]): Map<string, Source> {
  const byId = new Map<string, Source>();
  for (const x of all) if (!byId.has(x.id)) byId.set(x.id, x);
  return byId;
}
