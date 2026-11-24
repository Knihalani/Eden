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
import { assess, frameOf, gateOf, namesRef, unmeasuredLimit, type Frame, type Verdict } from "./conflict";
import {
  cardKey,
  cardVerdict,
  cardNames,
  CLEARED_STATES,
  couldClear,
  type CardNames,
  requestActions,
  STANDING_KINDS,
  type Card,
  type CardEnricher,
} from "./cards";
import { glossOf, warmGlossary } from "./gloss";
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
import {
  CHECK_MAX_ITEMS,
  checkKey,
  itemMark,
  SHEET_MAX_CARDS,
  sheetText,
  type PushCheckRead,
  type PushChecker,
  type SheetCard,
} from "./push-check";
import { actionClass, classTies, matchesClass, type ActionClass } from "./consequence";
import { sourcePriors } from "./source-prior";
import { isFrozenYields, mergeFrozenYields, SourceYield, type Evidence, type FrozenYields } from "./source-yield";
import { isFrozenEconomy, mergeFrozenEconomy, ProbeEconomy, type FrozenEconomy, type ProbeKind } from "./economy";
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
  ASKS_OWN,
  ASKS_WHO,
  cleanEntities,
  daysNamed,
  isAction,
  isImperative,
  pushStart,
  MORE_VERBS,
  LEADING,
  isScheduling,
  isSubject,
  mentionsAny,
  mentionWords,
  orgsOf,
  overlaps,
  requestedSpan,
  rolesOf,
  settled,
  startMinutes,
  textMinutes,
  topicOf,
} from "./probes";
import { type TurnGate, turnGate } from "./turn-gate";
import { foldEchoes } from "./fold";
import type { Facts } from "./decide";
import { Ledger, type LedgerEntry, type LedgerSnapshot } from "./ledger";
import {
  FROZEN_UNVERIFIABLE,
  MAX_FROZEN_SESSIONS,
  MAX_FROZEN_USERS,
  MAX_RECORDED,
  freezeSession,
  isFrozenRecorded,
  isFrozenSession,
  isFrozenUnverifiable,
  mergeFrozenRecorded,
  mergeFrozenSessions,
  mergeFrozenUnverifiable,
  type FrozenRecorded,
  type FrozenSession,
  type FrozenUnverifiable,
} from "./partner-freeze";
import { PartnerCore, mentionsOf } from "./partner-core";
import { PartnerDelivery } from "./partner-delivery";
import { PartnerAsk } from "./partner-ask";
export type { Built } from "./partner-delivery";
export {
  CHECK_REUSE_MS,
  MAX_CANDIDATE_BYTES,
  READER_POOL_CAP,
  TIME_WORD,
  MONTH,
  docYears,
  docSpan,
  idNumbers,
  sameEntry,
  sameRef,
  userCacheKey,
} from "./partner-verdict";
export type {
  CandidateDump,
  CandidateSink,
  PartnerDeps,
  PushPoolReport,
  ReaderReport,
  ReaderSink,
  Undo,
} from "./partner-verdict";
import { MONTH } from "./partner-verdict";
import { isPacked } from "./packed-text";
import {
  ASK_LATE_LEAD,
  ASK_NUDGE,
  CANDIDATES_LEAD,
  citationsOf,
  LOOKUP_HEAD_LEAD,
  LOOKUP_LEAD,
  LOOKUP_QUIET,
  LOOKUP_USE,
  PLAN_LEAD,
  renderAnswer,
  renderPacket,
  shownText,
  shownTextOfLines,
  wordsIn,
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
import { datedText, dayKeys } from "./days";
import { dayFactsClass, dayFactsOf } from "./day-facts";
import {
  anchored,
  aliasExpand,
  anchorsOf,
  hasDay,
  namedDays,
  namesDay,
  namesEntity,
  namesRequestDay,
  settledCut,
  settles,
  type Anchors,
} from "./settle";
import { classifySituation } from "./situation";
import {
  contentTerms,
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

/** An outcome already written to the source map, kept so explicit feedback can correct it. */
export interface Recorded {
  sourceIds: string[];
  situation: string;
  used: boolean;
  /** The session the injection was delivered in: a later correction's usage record names it (D293). */
  sessionId: string;
  /**
   * Delivered but judged by nothing yet — a `context_reset` kept the entry for a later correction without
   * recording an outcome (D2006): a compaction is no verdict. Feedback records it fresh, not as a flip.
   */
  pending?: boolean;
  /** The handed injection's UTF-8 size, so a later correction's usage record still names it (C1). */
  bytes?: number;
}

export interface Session {
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
  /**
   * Sketches and identifier numbers of items delivered in this session (bounded): a near-duplicate of one is not
   * delivered again, unless its own identifiers say it is a different thing ("order 874" beside "order 881").
   * `turn` and `terms` (the item's own content terms, bounded) let a follow-up's `carry` read what the last
   * request's answer was about (D1976).
   */
  delivered: {
    sketch: Sketch | null;
    refs: ReadonlySet<string>;
    /** The item this entry came from, when known: lets a snapshot leave out items whose packet was never taken. */
    itemId?: string;
    turn: number;
    terms: string[];
    years: number[];
    /** The record's own date range (`docSpan`), kept so a stale same-entity sibling is judged against it. */
    span?: [number, number];
  }[];
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
   * The session's last user cue's topic (its content terms, entities and named days) and the turn it landed on:
   * a follow-up that names nothing of its own ("And the cable?", "Who is he again?") reads the request it
   * follows up on from here (`carry`).
   */
  lastUser?: { terms: string[]; entities: string[]; time: TimeWindow | null; turn: number };
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
  /**
   * `planConflict` (D301): ids a plan packet has sent → its sends and the turn of the latest, at most `PLAN_SENT`.
   * D2010: said once, then one repeat at a later request — 60% of late facts the alert carried were never raised.
   */
  planSent?: Map<string, { n: number; at: number }>;
} /** Items whose shown words a session keeps (`askDedup`). */
export const MAX_SHOWN = 64;

export interface Cue {
  text: string;
  entities: string[];
  key: string;
  /** A content-free id for the cue, for traces and injection reasons. */
  id: string;
  /** `packetHeedsCheck` (D1450): the user request (`Session.requests`) an observed event's cue was made in. */
  request?: number;
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
  /** `requestGloss`: the English words a request in another language means (`glossOf`), searched beside it. */
  gloss?: string;
}
/** `densePacket`: a word on fewer than this share of the user's items is rare; an item adding one is no echo. */
export const RARE_SHARE = 0.03;

/**
 * `pushAsk` (D1985): the question shape a missed ask takes — a leading wh- or yes/no word, or a closing
 * question mark. `ASKS_OWN`'s narrower shape starts `listed` in `pushStartOne` already; this reads the rest.
 */
const QUESTION =
  /\?\s*$|^\s*(?:who|whose|whom|what|when|where|why|how|which|is|are|was|were|do|does|did|can|could|would|should|am)\b/i;

/**
 * Whether a turn that started no push asks a question: the gate reads it `ask` or `qact`, or it has a
 * question's shape. A turn the gate reads as chatter is left alone even with a question mark ("you ok?"); with
 * no gate the shape alone decides, as `pushStart` alone would (fail open).
 */
function asksQuestion(said: string, verdict: { kind?: string } | null): boolean {
  if (verdict?.kind === "chatter") return false;
  return verdict?.kind === "ask" || verdict?.kind === "qact" || QUESTION.test(said);
}

export interface Scored {
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
   * How the item sits on a day the request names (`rank`'s `timed`/`dated` seats): 0 starts that day, 1 covers it
   * (a span or a recurring weekday), 2 names it in text. Undefined for a word-found item off the day.
   */
  dayCls?: number;
  /**
   * `syncPollBehind`: delivered earlier this session and changed since (`Ledger.revised`), so the agent holds a
   * superseded copy; a follow-up delivers the corrected one (D65).
   */
  revised?: true;
}
/** `askBehind` (D430): the reason prefix of an ask's follow-up packet, withdrawn untaken at the next request. */
export const ASK_BEHIND = "ask-behind:"; // MAX_RECORDED lives in partner-freeze.ts (imported below).
export const MAX_RECORDED_USERS = 10_000;
export class ContextPartner extends PartnerAsk {
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
    const reads =
      event.kind !== "session_end" &&
      event.kind !== "context_reset" &&
      !(event.kind === "user_message" && event.draft === true);
    // A `context_reset` reads no item either, but it mutates the persisted marks: a cold user's saved session seed
    // must be thawed to be dropped, so it asks `ready` like a reader — `pendingThaw` would leave the seed on disk
    // for the next event to re-seed (D2006 review).
    const thawing =
      reads || event.kind === "context_reset" ? this.deps.cache.ready(event) : this.deps.cache.pendingThaw(event);
    if (thawing) await thawing;
    // `readerPush`: a request that acts is also read by the ask-time reader, as an ask of the engine's own; what it
    // flags is queued as a packet. The observe waits for it within its own wait, so an agent that never calls
    // `ask_context` gets the reading before its first model request when it is ready in time. The push's own read is
    // not cut at `askReaderWaitMs` (that bounds an explicit ask): a reading that lands later is still queued, while its
    // session is open and its request is the session's latest (`internal.request`, set once `observeEvent` counts it).
    const internal: {
      push: true;
      request?: number;
      turn?: number;
      open?: boolean;
      byDay?: boolean;
      deadline?: number;
    } = { push: true };
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
    let verdict: { needs: boolean; kind?: string } | null = null;
    if (this.gate && event.kind === "user_message")
      try {
        verdict = this.gate.read(said, { how: ruled?.how ?? "none", rest: ruled !== null && ruled.request !== said });
      } catch {
        verdict = null;
      }
    const adds = this.config.pushOpen && this.config.pushCandidates > 0;
    let start = !verdict
      ? ruled
      : !verdict.needs
        ? null
        : (ruled ?? (adds ? { how: "opened" as const, request: said } : null));
    // `pushDaySeats` (G1, D1400): a plan with a day is an action on that day. A turn that starts no push (the rule
    // has none, or the gate read a statement and vetoed it) starts an opened one when it names a coming day and the
    // gate does not read chatter. With no gate nothing is added: the rule decides alone, as before.
    // Only for a message the push could start for: a draft reads nothing, and must not thaw a frozen user (D325).
    const sent = event.kind === "user_message" && event.draft !== true;
    if (sent && !start && adds && verdict && verdict.kind !== "chatter" && this.config.pushDaySeats > 0) {
      if (this.namesComingDay(said, event.at, this.deps.cache.offsetOf(event)))
        start = { how: "opened" as const, request: said };
      if (start) internal.byDay = true;
    }
    // `pushAsk` (D1985): a turn that asks starts an opened push when nothing started one — the questions the
    // turn gate stays silent on (the benchmark's 17%-vs-85% gap) and the question whose rule start the gate
    // vetoed. The question is the lookup's request; the candidates' own gate decides whether anything goes,
    // so silence stays the default. Chatter is left alone; with no gate the question's shape alone decides.
    if (sent && !start && adds && this.config.pushAsk && asksQuestion(said, verdict)) {
      start = { how: "opened" as const, request: said };
    }
    const listed = start?.how === "listed";
    const opened = start?.how === "opened";
    // An indirect start (D820) is kept out of plan alerts as an opened one is: "We should get together sometime" can
    // read as listed, and D301 measured only listed-verb requests (the review of D820).
    if (opened || start?.open === true || (start && event.kind === "user_message" && start.request !== event.text))
      internal.open = true;
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
    // With a push running, the reply's packet is handed out below, once the push's check has had its say (D1450).
    const pushWait = Math.min(options.waitMs ?? 0, this.config.readerPushWaitMs);
    if (pushWait > 0) internal.deadline = t0 + pushWait;
    const observing = this.observeEvent(event, options, push !== null);
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
    // `packetHeedsCheck` (D1450): the reply's packet (a rule path made it before the check answered) is not handed
    // when its request's check has since read every item in it and said yes to none. Nothing was noted as shown or
    // outstanding for it (`handOut` was held for this); its items stay marked in the ledger: silence, no repeat.
    let injection = result.injection;
    if (injection && live && !options.shadow) {
      if (settled && this.allCheckedOut(live, injection)) {
        this.traceHeld(live, injection);
        injection = null;
      } else this.handOut(live, injection);
    }
    return { ...result, injection, pending: result.pending || !settled || queued };
  }

  private async observeEvent(
    event: AgentEvent,
    options: { waitMs?: number; shadow?: boolean } = {},
    /** The caller hands the reply's packet out itself (`observe`, while a push runs: `packetHeedsCheck`). */
    held = false,
  ): Promise<ObserveResult> {
    const t0 = performance.now();
    const spans = this.spans;
    const root = spans?.open("observe", 0, { kind: event.kind });
    if (event.kind === "session_end") {
      const ended = this.sessions.get(sessionKey(event));
      if (ended) this.close(ended, true);
      // The frozen knowledge of a session that ended seeds nothing: an ended session does not continue, and the
      // seed gate reads a matching sessionId as one (D1999).
      const endedUser = scopeKey(event);
      const frozenEnded = this.restoredSessions.get(endedUser);
      if (frozenEnded?.some((f) => f.sessionId === event.sessionId)) {
        const kept = frozenEnded.filter((f) => f.sessionId !== event.sessionId);
        if (kept.length) this.restoredSessions.set(endedUser, kept);
        else this.restoredSessions.delete(endedUser);
      }
      if (root) spans!.close(root);
      return { injection: null, pending: false };
    }
    if (event.kind === "context_reset") {
      // The agent compacted (or replaced) its transcript: what this session showed it is gone from its context,
      // so the marks that keep the session from repeating itself go too — a later delivery is news, not a repeat
      // (A3, D2006). The session stays open: the conversation continues where the transcript left off.
      const resetting = this.sessions.get(sessionKey(event));
      if (resetting) this.resetContext(resetting);
      // Its saved marks must not re-seed it either: a restored blob seeds a session that continues this one, and
      // this one's ledger and delivered list are exactly what the reset dropped.
      const resetUser = scopeKey(event);
      const frozenReset = this.restoredSessions.get(resetUser);
      const seed = frozenReset?.find((f) => f.sessionId === event.sessionId);
      if (seed !== undefined) {
        // The seed an evicted session left carries its outstanding deliveries too: a reset keeps them pending like
        // a live session's — `feedback` on a pre-reset delivery still lands (D2006 review).
        for (const o of seed.outstanding ?? []) {
          // As `resetContext`: no verdict, but the handed bytes reach the digest (C1); the pending row waits for
          // a later correction.
          this.usage({
            sessionId: seed.sessionId,
            injectionId: o.injectionId,
            used: false,
            how: "reset",
            sourceIds: o.sourceIds,
            injectionBytes: o.bytes,
          });
          this.recordRow(event, o.injectionId, {
            sourceIds: o.sourceIds,
            situation: o.situation,
            used: false,
            sessionId: seed.sessionId,
            pending: true,
            bytes: o.bytes,
          });
        }
        const kept = frozenReset!.filter((f) => f !== seed);
        if (kept.length) this.restoredSessions.set(resetUser, kept);
        else this.restoredSessions.delete(resetUser);
      }
      if (root) spans!.close(root, { decision: "reset" });
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
    this.seen(s.scope);
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
      if (injection && !options.shadow && !held) this.handOut(s, injection);
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
    const lookup =
      wantsLookup(event, text, terms, s.vocab) ||
      // `carryQuestions` (D1984): a user message made only of stop-words is dropped as chatter above, but a
      // question-shaped one ("Right. Who is he again?") is a follow-up `carry` widens with the request before
      // it — when there is a recent one to carry. With none, or as a bare statement, it stays chatter.
      (event.kind === "user_message" &&
        /\?\s*$/.test(text) &&
        s.lastUser !== undefined &&
        s.turn - s.lastUser.turn <= 6);
    if (!lookup) {
      trace("skipped", event.kind);
      return reply(queued);
    }
    if (event.kind === "user_message") s.situation = classifySituation(text);
    const cue = buildCue(text, terms, s.vocab, event.at, this.deps.cache.offsetOf(s.scope), this.config.probes);
    if (event.kind === "user_message") {
      // `carry`: a follow-up that names no person and almost no terms of its own asks about what the last
      // request was about; its cue is widened with that request's topic before it is ranked.
      this.carry(s, cue);
      s.lastUser = { terms: cue.text.split(" ").filter(Boolean), entities: cue.entities, time: cue.time, turn: s.turn };
    }
    if (event.kind === "external") cue.external = true;
    cue.arrived = this.now();
    cue.request = s.requests;
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
    let fast = this.confident(s, ranked, cue);
    // "Who is he?" (D1982): when an item's title IS the carried person's name, it alone answers.
    if (ASKS_WHO.test(cue.raw) && event.kind === "user_message") {
      const who = cleanEntities(cue.entities)
        .filter(isPersonName)
        .map((e) => e.toLowerCase());
      if (who.length > 0) {
        const record = ranked.filter((x) => who.includes(x.item.title.trim().toLowerCase()));
        if (record.length > 0) fast = record;
      }
    }
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
    // A seat on the reject: `lookup` throws when its model or a source does, and past "late" nothing else awaits
    // `slow`, so its rejection would ride to the process as unhandled. The seat drops it as `push`'s does above.
    const queueLater = () =>
      void slow.then(
        (inj) => inj && !s.closed && s.pending.push(inj),
        () => {},
      );
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
   * `packetHeedsCheck` (G2, D1450): a queued rule-path packet of this request whose every item its push check read
   * and said yes to none of is not handed out (the rule path queued it before the check answered: the no-model
   * conflict test reads "hold lifted" as a hold). It goes whole, as a removed item's packet does, and only when
   * nothing else is in it; what its delivery marked stays marked (silence over a repeat).
   */
  protected dropCheckedOut(s: Session): void {
    if (s.pending.length === 0) return;
    const out = this.checkedOut(s);
    if (!out) return;
    for (let k = s.pending.length - 1; k >= 0; k--) {
      const packet = s.pending[k]!;
      if (!this.allCheckedOut(s, packet, out)) continue;
      s.pending.splice(k, 1);
      this.traceHeld(s, packet);
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
  protected watchCopies(s: Session, copies: readonly Copy[]): void {
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
  protected withoutCoveredUpdates(batch: Injection[]): Injection[] {
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
  protected currentLast(s: Session, batch: Injection[]): Injection[] {
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

  protected unwatch(s: Session): void {
    const key = scopeKey(s.scope);
    const set = this.watching.get(key);
    if (!set) return;
    set.delete(s);
    if (set.size === 0) this.watching.delete(key);
  }

  /**
   * Queues "updated:" packets for these stored copies in one session: as many as the size cut needs, an earlier
   * update still queued for the same items replaced, each copy noted as promised.
   */
  protected queueUpdates(s: Session, changed: readonly ContextItem[]): void {
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
   * The live sessions' delivery knowledge for a user, written beside its frozen blob (`persistHooks.save`): each
   * session's ledger snapshot and delivered list, so a restore's fresh sessions do not hand the agent again what
   * an earlier process already delivered (a local daemon respawned between turns).
   */
  protected sessionSnapshot(scope: Scope): FrozenSession[] | null {
    const mine = this.userSessions.get(scopeKey(scope));
    if (!mine || mine.size === 0) return null;
    const out: FrozenSession[] = [];
    for (const s of mine) {
      const f = freezeSession(s);
      if (f) out.push(f);
    }
    return out.length ? out.slice(-MAX_FROZEN_SESSIONS) : null;
  }

  /** Writes a user's frozen list, most recently written last, dropping the oldest over `MAX_FROZEN_USERS`. */
  protected putFrozenSessions(user: string, list: FrozenSession[]): void {
    this.restoredSessions.delete(user); // Re-insert: Map order is least recently written user first.
    this.restoredSessions.set(user, list);
    while (this.restoredSessions.size > MAX_FROZEN_USERS)
      this.restoredSessions.delete(this.restoredSessions.keys().next().value as string);
  }

  /** How many users this process holds, live or frozen (the router's base for estimating a move's size, S1-P6). */
  heldCount(): number {
    return this.deps.cache.heldScopes().length;
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
   * `pushStateFilter` (D1456): the user's constraint cards that may still be in force, as `couldClear` reads them:
   * every card made before `before` that is neither `none`, a `preference`, nor itself cleared (at most the
   * enricher's cap a user). Read, and normalised once, only when the ranking holds a cleared item. No model call and
   * no source call. An expired or bulk item's card is kept: it can only keep a notice in the pool, the safe side.
   */
  protected inForce(s: Session, before: number): CardNames[] {
    const enricher = this.config.cards ? this.deps.cards : undefined;
    if (!enricher) return [];
    const out: CardNames[] = [];
    for (const card of enricher.cardsOf(s.scope, enricher.carded(s.scope), before).values()) {
      if (card.kind === "none" || card.kind === "preference") continue;
      if (card.state && CLEARED_STATES.has(card.state)) continue;
      const names = cardNames(card);
      if (names.entities.length > 0 || names.fields.length > 0) out.push(names);
    }
    return out;
  }

  protected unact(s: Session): void {
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
  protected queuePlanConflicts(scope: Scope, items: readonly ContextItem[]): void {
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
    if (!took) return { synced: false, reason: this.sync.ignoredBecause(scope, sourceId) };
    // A bare signal on a source that re-reads by ref costs every held copy: name what changed instead (D2008).
    return this.sync.fetchesById(scope, sourceId) ? { synced: true, advice: "refs" } : { synced: true };
  }

  /**
   * Whether `sourceId` is one of the user's configured sources (`deps.sources`): `/v1/sources/items`, `/refs` and
   * `/removed` answer 422 naming an unconfigured one rather than storing nothing (D2109's follow-up).
   */
  async hasSource(scope: Scope, sourceId: string): Promise<boolean> {
    // The sync's populated view is cheap and current for engaged users; the resolver covers an
    // unengaged or new user (whose `status` answers fresh on its first sighting) — a just-added
    // connector is rejected only while neither holds it (config TTL), never silently dropped.
    if (this.sync?.has(scope, sourceId)) return true;
    const all = await this.deps.sources(scope).catch((): Source[] => []);
    return all.some((x) => x.id === sourceId);
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
    const n = await this.sync.ingest(scope, sourceId, clean);
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
              const n = await sync.ingest(scope, sourceId, [copy], mark);
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

  forget(scope: Scope, sourceId?: string): void {
    const key = scopeKey(scope);
    if (sourceId === undefined) {
      this.forgotten.add(key);
      if (this.forgotten.size > 4_096) this.forgotten.clear();
    }
    for (const s of [...this.sessions.values()]) if (scopeKey(s.scope) === key) this.close(s, false);
    this.recorded.get(scope.tenantId)?.delete(key);
    this.deps.cache.forget(scope, sourceId);
    // Restored or pending session snapshots carry content-derived terms and refs of the user's items: they go
    // with everything else, or a later persist could write the forgotten content back (SEC_0001).
    this.restoredSessions.delete(key);
    this.frozenPending.delete(key);
    this.frozenRecorded.delete(key);
    this.frozenEconomy.delete(key);
    this.frozenYields.delete(key);
    this.frozenUnverifiable.delete(key);
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
    // The check's sheet cache state (D1800) is content-free, but it is the user's: dropped with the rest.
    this.deps.checker?.forget(scope);
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

  protected recordedOf(scope: Scope): Map<string, Recorded> | undefined {
    return this.recorded.get(scope.tenantId)?.get(scopeKey(scope));
  }

  /** The user's `recorded` as a frozen list (null when nothing is held), for the persist `save` hook. */
  protected recordedSnapshot(scope: Scope): FrozenRecorded[] | null {
    const mine = this.recordedOf(scope);
    if (!mine?.size) return null;
    return [...mine].map(([injectionId, r]) => ({ injectionId, ...r }));
  }

  /** Seeds `recorded` from a restored blob's rows, under the same caps the live path enforces. */
  protected restoreRecorded(scope: Scope, rec: FrozenRecorded[]): void {
    const tenant = this.recorded.get(scope.tenantId) ?? new Map<string, Map<string, Recorded>>();
    this.recorded.set(scope.tenantId, tenant);
    const mine = new Map<string, Recorded>();
    for (const { injectionId, ...r } of rec) mine.set(injectionId, r);
    while (mine.size > MAX_RECORDED) mine.delete(mine.keys().next().value as string);
    tenant.delete(scopeKey(scope)); // Re-insert: Map order is least recently recorded user first.
    tenant.set(scopeKey(scope), mine);
    while (tenant.size > MAX_RECORDED_USERS) tenant.delete(tenant.keys().next().value as string);
  }

  /** The user's `unverifiable` rows as a frozen list (null when none is held), for the persist `save` hook. */
  protected unverifiableSnapshot(key: string): FrozenUnverifiable | null {
    const mine = this.unverifiable.get(key);
    if (!mine?.size) return null;
    return [...mine].slice(-FROZEN_UNVERIFIABLE);
  }

  /** Seeds `unverifiable` from a restored blob's rows, under the same caps the live path enforces. */
  protected restoreUnverifiable(scope: Scope, rows: FrozenUnverifiable): void {
    const key = scopeKey(scope);
    const mine = new Map<string, { mark: number; at: number }>();
    for (const [id, r] of rows.slice(-MAX_UNVERIFIABLE)) {
      // `mark` is this process's signal counter: the dead process's value compares against nothing here —
      // one above the new counter would hold a copy past real changes, one below re-reads needlessly.
      // The hold's meaning is "a null said nothing as of the copy's mark": reset it to the copy's mark
      // now, so a signal landed since (noticedMark is newer) doubts it, and the next one ends the hold.
      mine.set(id, { mark: this.deps.cache.readMark(scope, id) ?? this.sync?.mark() ?? 0, at: r.at });
    }
    this.unverifiable.delete(key); // Re-insert: least recently noted user first.
    this.unverifiable.set(key, mine);
    while (this.unverifiable.size > MAX_UNVERIFIABLE_USERS)
      this.unverifiable.delete(this.unverifiable.keys().next().value as string);
  }

  /** The people a request names: its names that someone in the user's items goes by (`ItemCache.isPerson`). */
  protected peopleOf(s: Session, cue: Cue): string[] {
    return cleanEntities(cue.entities).filter((e) => !e.includes("@") && this.deps.cache.isPerson(s.scope, e));
  }

  /**
   * `cardsSourceAware` (D320): for a user with more than `SOURCE_AWARE_MIN` synced sources, which synced items wait
   * unread: those of a source no lookup of the user's has searched that name none of the names the user's requests
   * named (`mentions`: each item's names, as the source map records them). Undefined (read all) otherwise.
   */
  protected cardDefer(
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

  /** When an item's copy was last known current: when it was fetched. */
  protected readAt(s: Session, item: ContextItem, now: number): number {
    return this.deps.cache.fetchedAt(s.scope, item.id) ?? now;
  }

  /**
   * Items their source no longer has: dropped from the cache (and held as gone for `GONE_HOLD_MS`, so a search or
   * listing read before the deletion cannot store them back), from the sync's bookkeeping and from held search pages.
   */
  protected dropGone(scope: Scope, sourceId: string, ids: string[]): number {
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
   * With `askDedup`, keeps the words each item's line in `text` (a rendered packet or answer of `items`, in order)
   * showed the agent. A line is matched to its item by its `[source]` tag; a packet cut short has fewer lines.
   */
  protected noteShown(s: Session, items: readonly ContextItem[], text: ItemLines): void {
    // Item lines only, of the text's lines after its first and before its last.
    const lines = noteLines(text);
    const shown = (s.shown ??= new Map());
    // A packet's dates leave out the current year ("9 Oct"), meaning this one: an answer saying it is no news.
    const year = String(new Date(this.now()).getUTCFullYear());
    for (const [k, line] of lines.entries()) {
      const item = items[k];
      if (!item || !line.startsWith(`- [${item.sourceId}] `)) break;
      const key = shownKey(item);
      const words = shown.get(key) ?? new Set<string>([year]);
      // Words of one character too: the known test asks of them for a part holding no longer word — a table row
      // of single cells (`saysUnknown`, D1933, D2022).
      for (const w of lineWords(item.sourceId, line)) words.add(w);
      shown.delete(key); // re-inserted last: the most recently shown is dropped last
      shown.set(key, words);
    }
    while (shown.size > MAX_SHOWN) shown.delete(shown.keys().next().value!);
  }

  protected build(
    s: Session,
    scored: Scored[],
    mode: InjectionMode,
    reason: string,
    cue: Cue,
    parent: number,
    shown?: string,
    frame?: PacketFrame,
    undoWas?: Map<string, LedgerEntry | undefined>,
  ): Injection {
    const spans = this.spans;
    // Whatever path delivered them, a probe that first brought one in paid for its call (`probeYield`).
    if (this.config.probeYield) {
      this.economy.reached(
        s.scope,
        scored.map((x) => x.item.id),
      );
    }
    for (const x of scored) {
      if (x.sketch) this.recordDelivered(s, x.item, x.sketch);
    }
    // Every item counts as delivered, an echo folded out of the packet too: the agent has its occurrence.
    // A caller undoing a delivery it never handed out gets each entry the marks replace — captured here, where
    // the write is, not before the awaits that precede it, or another delivery's mark would read as ours.
    if (undoWas) for (const x of scored) undoWas.set(x.item.id, s.ledger.entry(x.item.id));
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
      packetCoversLine: this.config.packetCoversLine,
      ...(frame
        ? { lead: frame.lead, changes: frame.changes, facts: frame.facts, unsureAskTopic: frame.unsureAskTopic }
        : {}),
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
    // The text the agent is shown, split once for the three readers of its lines below (D1920).
    const said = shown ?? injection.text;
    const all = said.split("\n");
    const lines = this.config.askDedup || this.config.revisionNotice ? itemLinesOf(all) : undefined;
    this.built.set(injection, {
      sourceIds: [...new Set(items.map((i) => i.sourceId))],
      items: items.map((i) => ({ sourceId: i.sourceId, id: i.id })),
      // Only the words the agent received: an item's text past the packet's cut is not evidence of use.
      text: shownTextOfLines(all),
      // What the agent will have been shown of each item once it is handed out (`markShown`): an answer's lines are
      // its items' in order (not folded); a model's composed answer has no item lines and is attributed to none.
      ...(this.config.askDedup
        ? { shown: { items: shown === undefined ? items : scored.map((x) => x.item), text: said, lines } }
        : {}),
      ...(this.config.revisionNotice
        ? {
            copies: renderedCopies(
              shown === undefined ? items : scored.map((x) => x.item),
              lines!,
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

  protected usage(u: UsageRecord): void {
    try {
      this.deps.onUsage?.({ ...u, sourceIds: [...u.sourceIds] });
    } catch {
      // A broken sink never breaks learning or feedback.
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

/** `planConflict` (D301): acting requests a session keeps, and how much of one its packet quotes. */
export const PLAN_REQUESTS = 12;
export const PLAN_WAITING = 64;
export const PLAN_SENT = 256; /** `pushCandidates` (D236): a candidates' packet's framing line and cut. */
export interface PacketFrame {
  lead: string;
  unsureAskTopic?: string;
  changes?: ReadonlyMap<string, string>;
  facts?: ReadonlyMap<string, string>;
  itemBytes: number;
  maxBytes: number;
}

/** `revisionNotice`: an "updated:" packet's reason prefix, and what each of its items' titles starts with. */
export const UPDATED = "updated:";

/** `pollRevised`: the least time between two notice polls of one user's source, and how many sources it tracks. */
const REVISION_POLL_GAP_MS = 30_000;
const MAX_REVISION_SOURCES = 10_000;

export interface RevisionSource {
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
export interface Copy {
  id: string;
  sourceId: string;
  version: number;
  times?: string[];
}

/** Each item's copy; its times only with `revisionDiff` (`withTimes`), so the switch off reads no text for them. */
export function copiesOf(items: readonly ContextItem[], withTimes: boolean): Copy[] {
  return items.map((it) =>
    withTimes
      ? { id: it.id, sourceId: it.sourceId, version: versionOf(it), times: timesOfItem(it) }
      : { id: it.id, sourceId: it.sourceId, version: versionOf(it) },
  );
} /** A clock time ("9:15", "14:00", "3pm"), a day and month either way round, or a weekday (`revisionDiff`). */
export const TIME_OR_DATE = new RegExp(
  "\\b(?:([01]?\\d|2[0-3]):([0-5]\\d)(?:\\s?([ap]m))?|(1[0-2]|0?[1-9])\\s?([ap]m)|" +
    `(\\d{1,2})(?:st|nd|rd|th)?\\s${MONTH}|${MONTH}\\s(\\d{1,2})(?:st|nd|rd|th)?|` +
    "((?:mon|tues|wednes|thurs|fri|satur|sun)day))\\b",
  "gi",
); /** At most this many times are read from one item (`revisionDiff`). */
export const MAX_ITEM_TIMES = 16; /** A 12-hour clock's hour in 24-hour form. */
export const hour24 = (h: number, ampm: string | undefined) =>
  ampm === undefined ? h : (h % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
export const pad = (n: number) => String(n).padStart(2, "0");

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
} /**
 * A packet's or answer's item lines (those starting `- [`), and whether its first and its last line are among them:
 * `noteShown` reads the lines between its first and last, `renderedCount` all of them. Read once from one split.
 */
export interface ItemLines {
  lines: string[];
  head: boolean;
  tail: boolean;
}

export function itemLinesOf(all: readonly string[]): ItemLines {
  const lines = all.filter((line) => line.startsWith("- ["));
  return {
    lines,
    head: lines.length > 0 && all[0]!.startsWith("- ["),
    tail: all.length > 1 && lines.length > 0 && all[all.length - 1]!.startsWith("- ["),
  };
}

/** `text.split("\n").slice(1, -1).filter((line) => line.startsWith("- ["))`, from the text's `ItemLines`. */
function noteLines(text: ItemLines): string[] {
  const { lines, head, tail } = text;
  return head || tail ? lines.slice(head ? 1 : 0, tail ? lines.length - 1 : lines.length) : lines;
}

/**
 * The words `noteShown` keeps of an item's line: its source and what the line says after its `[source]` tag,
 * lowercased, read as `/[\p{L}\p{N}]+/gu` reads them (`wordsIn`'s code-unit pass, the regex for a surrogate, D1881).
 */
function lineWords(sourceId: string, line: string): string[] {
  return wordsIn(`${sourceId} ${line.slice(line.indexOf("] ") + 2)}`.toLowerCase());
} /**
 * How many of `items`, in order, have their line in `text` (a packet or answer: one `- [source] …` line each, in
 * the items' order, until the size cut), as `noteShown` reads them.
 */
export function renderedCount(items: readonly ContextItem[], text: string | ItemLines): number {
  const lines = (typeof text === "string" ? itemLinesOf(text.split("\n")) : text).lines;
  let n = 0;
  while (n < items.length && n < lines.length && lines[n]!.startsWith(`- [${items[n]!.sourceId}] `)) n++;
  return n;
}

/** The copies of the items whose lines the agent receives: one cut from the text was not shown. */
function renderedCopies(items: readonly ContextItem[], text: ItemLines, withTimes: boolean) {
  return copiesOf(items.slice(0, renderedCount(items, text)), withTimes);
}

/** The line readers, for `opt-round3.test.ts`. */
export const shownReadings = {
  itemLinesOf,
  noteLines,
  lineWords,
  renderedCount,
}; /** An item's words as the ledger records them (`Ledger.revised`): a copy edited at its source hashes otherwise. */
export function versionOf(item: ContextItem): number {
  const r = readingOf(item);
  return (r.version ??= hashString(`${item.title}\n${item.text}`, 0));
} /** `timesOf` an item, read once per item object (`readingOf`); the array is shared, and never changed by a reader. */
export function timesOfItem(item: ContextItem): string[] {
  const r = readingOf(item);
  return (r.times ??= timesOf(item));
} /**
 * `settled` (probes.ts) of an item, read once per item object (`readingOf`, D1920): the push's `confident` and the
 * fallback asked it of every candidate they reached, a pattern over the title and text each time (8.5 µs an item on
 * the pipeline bench).
 */
export function settledOf(item: ContextItem): boolean {
  const r = readingOf(item);
  return (r.settled ??= settled(item));
} /** What `versionOf`, `timesOfItem` and `settledOf` read of an item, kept on it (`READINGS`). */
export interface Reading {
  /** The text read, for an item held plain (`null` for a packed one, whose text cannot change). */
  text: string | null;
  title: string;
  version?: number;
  times?: string[];
  settled?: boolean;
} /**
 * Each item object's `Reading` (D1885). An item's version was hashed again for every copy a packet, a revision check or
 * a lookup's ledger test named (the title and up to 8,000 characters of text joined, then hashed), and its times read
 * by a pattern for every packet that handed it. Held weakly, per item object (a user's own cached copy, so no other
 * tenant's), and checked against the item: a plain item whose text or title changed in place is read again; a packed
 * one's text cannot change (its getter is fixed), and its deflated bytes are the only copy kept, so none is held here.
 */
export const READINGS = new WeakMap<ContextItem, Reading>();

/** `versionOf`, `timesOfItem` and `settledOf`, for tests (`readings.test.ts`). */
export const itemReadings = { versionOf, timesOfItem, settledOf };

export function readingOf(item: ContextItem): Reading {
  const packed = isPacked(item);
  let r = READINGS.get(item);
  if (r && r.title === item.title && (packed ? r.text === null : r.text === item.text)) return r;
  r = { text: packed ? null : item.text, title: item.title };
  READINGS.set(item, r);
  return r;
} /**
 * An item's key in `Session.shown`: its id and its words' version. A sync that changes an item's words ("approved"
 * to "not approved", two rows swapped) makes it a new item to the agent, which a bag of shown words cannot see.
 */
export function shownKey(item: ContextItem): string {
  return `${item.id}\u0000${versionOf(item)}`;
} /**
 * `p`'s value if it settles within `ms`, else null (it runs on; a rejection after the bound is swallowed). Not an
 * async function: an answer already in settles as soon as awaiting `p` itself would.
 */
export function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
  p.catch(() => {}).finally(() => clearTimeout(timer));
  return Promise.race([p, late]);
}

/** The request's words and its people's names, lowercased: what a compacted packet keeps the parts holding. */
export function focusOf(cue: Cue): ReadonlySet<string> {
  let focus = FOCI.get(cue);
  if (!focus) {
    const words = `${cue.text} ${cue.entities.join(" ")}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    FOCI.set(cue, (focus = new Set(words.filter((w) => w.length > 1 && !isStopword(w)))));
  }
  return focus;
}

/**
 * Each cue's focus words, read once and dropped with the cue (D1933): an ask read them three times (its answer, its
 * delivery's fold and packet). Shared by every reader, so read only, never changed.
 */
export const FOCI = new WeakMap<Cue, ReadonlySet<string>>();

/**
 * Replaces a session's vocabulary with one holding only the terms it still refers to: seen terms (in the same order),
 * the distinctive terms of injections awaiting use, and the newest agent-held events. Ids change; nothing else holds
 * them.
 */
export function rebuildVocab(s: Session, maxTerms: number): void {
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

export const sessionKey = (e: Scope & { sessionId: string }) => `${scopeKey(e)}#${e.sessionId}`;

export function eventText(e: AgentEvent): string {
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
export function wantsLookup(e: AgentEvent, text: string, terms: Uint32Array, vocab: Vocab): boolean {
  if (e.kind !== "user_message" && e.kind !== "external") return false;
  // A "who is he?" follow-up is all stop-words of its own but is a real question: it reaches `carry` (D1982).
  if (e.kind === "user_message" && ASKS_WHO.test(text)) return true;
  return !isChatterTerms(text, terms, vocab);
}

/** A name that can answer "who is he?": two words or more, or an address — "Leo Park", not "Acme". */
export function isPersonName(e: string): boolean {
  return e.trim().split(/\s+/).length >= 2 || e.includes("@");
}

/** `offset`: the user's UTC offset in minutes, so "today" is their today (D44). */
/** `time`, when given, is the cue's days read already (the ask's wider reading), in place of `timeWindow(text)`. */
export function buildCue(
  text: string,
  ids: Uint32Array,
  vocab: Vocab,
  at: number,
  offset: number,
  probes = false,
  time?: TimeWindow | null,
): Cue {
  // With probes on, a sentence's leading verb is not part of the name it starts ("Send Rose Kimura").
  const entities = (probes ? cleanEntities(extractEntities(text)) : extractEntities(text)).slice(0, 8);
  const terms = contentTermsOf(ids, vocab).slice(0, 16); // Distinct already.
  const key = (entities.length ? entities.map((e) => e.toLowerCase()) : terms).slice().sort().join("|").slice(0, 200);
  // Traces and reasons carry this id, never the cue itself: the cue is the user's words.
  const id = `cue:${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
  return {
    text: terms.join(" "),
    entities,
    key,
    id,
    time: time !== undefined ? time : timeWindow(text, at, offset),
    at,
    raw: text,
    offset,
  };
} /**
 * What one agent-held event holds: its terms and its adjacent term pairs (`pairKey`), in session ids, each sorted and
 * unique so membership is a binary search. Typed arrays, not Sets: a session keeps up to `windowEvents` of these, and
 * a Set of numbers costs over 100 bytes an entry against 4 or 8 here (`held.test.ts`: a session with 12 mail
 * listings of 8 KB took 2,096 KB with Sets, 311 KB with these).
 */
export interface Held {
  terms: Uint32Array;
  pairs: Float64Array;
} /**
 * The head of an agent-held event that is kept, and at most this many distinct terms of it: bounds the session
 * vocabulary a rebuild must keep. An item longer than that is never judged held, so the bounds only err toward
 * delivering.
 */
export const HELD_CHARS = 8_000;
const MAX_HELD_TERMS = 512;

/** Pair keys are exact while ids stay under 2^21 (a session vocabulary is rebuilt far below that). */
export const PAIR_BASE = 2 ** 32;
export const pairKey = (a: number, b: number) => a * PAIR_BASE + b;

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
export function sortedUnique<T extends Uint32Array | Float64Array>(xs: T): T {
  const sorted = xs.slice().sort() as T;
  let m = 0;
  for (let i = 0; i < sorted.length; i++) if (m === 0 || sorted[i] !== sorted[m - 1]) sorted[m++] = sorted[i]!;
  return m === sorted.length ? sorted : (sorted.slice(0, m) as T);
} /**
 * Bulk mail, by the connector's mailbox category (`meta.category`; Gmail's Promotions tab) or by a title that names
 * itself a newsletter or digest of notifications. A heuristic tuned on one eval scenario (`newsletter-arrives`), kept
 * narrow on purpose: Gmail's Updates tab holds bills and receipts, and words like "webinar", "promotion" or
 * "unsubscribe" appear in real meeting, HR and transactional mail.
 */
export const BULK_CATEGORY = /^promotions?$/i;
export const BULK_TITLE = /\b(newsletter|top stories|you appeared in)\b/i;

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

/** `pushCheck` (D500): the push checks a session keeps (a request's first and second pass, and a few before). */
export const CHECK_KEPT = 4;

/** `pushCheck` (D500): one kept check: the request and day it read, its items as read (`itemMark`), its answer. */
export interface KeptCheck {
  asked: string;
  /** The user request (`Session.requests`) the check was made for (`packetHeedsCheck`). */
  request?: number;
  /** Per item read, `itemMark`: id, content hash, date and sender. */
  marks: Map<string, string>;
  read: Promise<PushCheckRead>;
  settled?: PushCheckRead;
}

/** What a re-read found (`verifyDelivery`). */
/**
 * A re-read's outcome. Four ways not to know (D211): "unverifiable" (the source has no fetch tool, or answered null
 * and does not report gone: its items are delivered as held, D126), "skipped" (our own guard refused the call, most
 * often the per-source concurrency limit while the other re-reads hold its slots: no call, no evidence), "flaked"
 * (the call failed with a plain error, worth one retry) and "failed" (a timeout, a 429, the caller giving up, our
 * gate).
 */
export type CheckOutcome =
  | "confirmed"
  | "changed"
  | "gone"
  | "failed"
  | "flaked"
  | "skipped"
  | "unverifiable"; /** Re-reads a session keeps (`Session.checks`), and how long one is reused before an item is read again (ms). */
export const MAX_CHECKS = 64;

/** `unverifiable`: items held per user, and users held (least recently noted dropped first). */
export const MAX_UNVERIFIABLE = 512;
export const MAX_UNVERIFIABLE_USERS = 4_096;
/** How long an item its source said is gone is kept from being stored again (the fan-out's stale-result window). */
const GONE_HOLD_MS = 10 * 60_000; /**
 * Whether an item looks like bulk mail. Such items are never pushed without a model: their words overlap with real
 * work, and one arriving says nothing about the user's need. The judge still sees them, and an ask still finds them.
 */
export function bulkMail(item: ContextItem): boolean {
  const category = item.meta?.category;
  return (category !== undefined && BULK_CATEGORY.test(category)) || BULK_TITLE.test(item.title);
}

/** `cardsSourceAware` (D320): users with at most this many synced sources have every synced item read, as before. */
export const SOURCE_AWARE_MIN = 32;
