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
import type { SourceMap } from "@eden/graph";
import type { Budget, Model, Reservation } from "@eden/llm";
import {
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
} from "@eden/protocol";
import { REDACTED, sanitizeForStore } from "@eden/redact";
import { Vocab, type WorkerPool } from "@eden/primitives";
import {
  PlanError,
  PlannedSource,
  SourceFanout,
  type FanoutOutcome,
  sharedKey,
  type SharedCalls,
  type QueryPlanner,
  type SearchQuery,
  type Source,
  type SourceResolver,
} from "@eden/sources";
import { IntentPatterns, predict, PREDICT_NAMES } from "./anticipate";
import { nearDuplicate, sanitizedId, sanitizeItem, type CacheHit, type ItemCache, type Sketch } from "./cache";
import { SyncManager, type SourceChange } from "./sync";
import { pooledSanitizer } from "./gate";
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import { assess, frameOf, namesRef, unmeasuredLimit, type Frame, type Verdict } from "./conflict";
import { cardVerdict, requestActions, type CardEnricher } from "./cards";
import {
  accounts,
  actionKey,
  actionText,
  FIREWALL_GROUNDS,
  domainsOf,
  MAX_CHECKED,
  setsTime,
  structuralTie,
} from "./firewall";
import { actionClass, classTies, matchesClass, type ActionClass } from "./consequence";
import { ProbeEconomy, type ProbeKind } from "./economy";
import { seedsOf, tieWords, type Walked } from "./kg";
import { answerMessages, judgeMessages, parseJudge } from "./judge";
import { namesParticipant, startDay, startMs, timeWindow, titleNames, type TimeWindow } from "./grounding";
import {
  absenceSpan,
  cleanEntities,
  daysNamed,
  isAction,
  isImperative,
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
import { foldEchoes } from "./fold";
import type { Facts } from "./decide";
import { Ledger } from "./ledger";
import { citationsOf, renderAnswer, renderPacket, shownText, withoutAddedDates } from "./render";
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
import { SpanStats, Tracer, type SpanSink, type SpanStat } from "./spans";
import type { ShadowRecord, ShadowSink, Trace, TraceSink } from "./trace";
import { distinctiveTokens, showsUse, type Outstanding } from "./usage";

export interface PartnerDeps {
  sources: SourceResolver;
  sourceMap: SourceMap;
  cache: ItemCache;
  budget: Budget;
  /** Null runs the engine with no model at all: fast and source paths only. */
  model: Model | null;
  config?: Partial<EngineConfig>;
  onTrace?: TraceSink;
  now?: () => number;
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
   * A debug hook for the lab (docs/research/econ-decide.md): each no-model decision's candidates with their facts
   * (`decide.ts`) and what was delivered. Ids and numbers only, no content. Absent: no facts are computed for it.
   */
  onCandidates?: CandidateSink;
}

/** One no-model decision's candidates, for `PartnerDeps.onCandidates`. */
export interface CandidateDump {
  sessionId: string;
  turn: number;
  /** Where the decision was made: the fast path, anticipation's early decision, or the lookup. */
  path: "fast" | "early" | "lookup" | "served";
  candidates: { id: string; facts: Facts }[];
  delivered: string[];
  /** How the rule paths decided (`sure`, `grounded-<how>`, `fallback`, or empty for silence). */
  how: string;
}
export type CandidateSink = (dump: CandidateDump) => void;

/** An outcome already written to the source map, kept so explicit feedback can correct it. */
interface Recorded {
  sourceIds: string[];
  situation: string;
  used: boolean;
}

interface Session {
  scope: Scope;
  id: string;
  /** Tenant, user and session: the only key a session's state is ever looked up by. */
  key: string;
  turn: number;
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
  /** With `anticipate`: the session's background prefetch, made on its first event. */
  ant?: Anticipation;
  /** Work lookups left running behind their answers: a poll and its follow-up (`afterPoll`), a judge (`judgeLater`). */
  behind?: Promise<void> | null;
  /**
   * With `actionCheck`: the keys of the calls the firewall answered with a finding (`actionKey`, bounded by
   * `MAX_CHECKED`, oldest first). The same call made again is the agent's informed choice, and proceeds.
   */
  checked?: Set<string>;
}

/** A session's anticipation (`anticipate`): its prefetch in flight, the next one waiting, and what it has fetched. */
interface Anticipation {
  /** Source calls this session's prefetches made, against `anticipateSessionCalls`. */
  calls: number;
  running: Promise<void> | null;
  /** The latest event that arrived while a prefetch ran: only it is read next (older ones are superseded). */
  queued: { kind: string; text: string; at: number; lookup: boolean } | null;
  /** Item ids the prefetches fetched or held ready, newest last (bounded: `MAX_PREFETCHED`). */
  prefetched: Set<string>;
  /** Names and days already prefetched in this session (lower case), so each is fetched once per session. */
  asked: Set<string>;
}

/** Item ids a session's anticipation remembers as prefetched, and names and days it remembers as asked. */
const MAX_PREFETCHED = 256;
const MAX_ASKED = 64;

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
  /** The request arrived from outside the conversation (a new email): probed whatever its wording (`probeWhen`). */
  external?: boolean;
  /** With spans on, the span this lookup's phases are children of (`spans.ts`). */
  span?: number;
  /**
   * `syncPollBehind`: the on-demand poll this lookup did not wait for; true once it is done if it stored anything (an
   * item new or changed since the index answered the lookup).
   */
  polled?: Promise<boolean>;
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
/** How a probe run differs from a lookup's own (`Partner.probe`); `anticipate` uses every one. */
interface ProbeOpts {
  /** Source calls it may make (default `probeCalls`). */
  budget?: number;
  /** No call at all: what the memo and the economy hold for each query. */
  offline?: boolean;
  /** The action class to read or ask (default: `consequenceProbe`'s own). */
  cls?: ActionClass | null;
  /** The class is read from what is cached, with no call. */
  classOffline?: boolean;
  /** No topic probe (a prefetch has only an event's words, not a request's). */
  noTopic?: boolean;
  /** Waited for (at most `probeGraceMs`) before any probe goes out: a prefetch of the same names still running. */
  after?: Promise<void>;
  /** Synced sources whose copy is current (`sync`, D57): they answer from the local index, at no call. */
  local?: ReadonlySet<string> | null;
}
const ANSWER_MAX_TOKENS = 1_000;
/** `densePacket`: a word on fewer than this share of the user's items is rare; an item adding one is no echo. */
const RARE_SHARE = 0.03;
/** The action firewall: a party named on more than this share of a user's items is the user's own organisation. */
const SELF_DOMAIN_SHARE = 0.1;
/** `recoverNames`: names taken from one request at most, and the words of it read for them. */
const MAX_RECOVERED = 2;
const RECOVER_WORDS = 24;

/** Each cue's frame (`conflict.ts`), read once and dropped with the cue. */
const FRAMES = new WeakMap<Cue, Frame>();
/** A lookup's knowledge-graph finds (`graph`), by item id, kept with its cue for delivery's learning. */
const WALKS = new WeakMap<Cue, Map<string, Walked>>();

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
  /** Ranked only because the knowledge graph reached it (`graph`): no path but the graph's reads it. */
  walkedOnly?: true;
  /** A whole cue entity is in the item (`rank`'s entity bonus). */
  entity?: true;
}

/** What an injection was built from, kept until it is handed out and usage tracking starts. */
interface Built {
  sourceIds: string[];
  /** The delivered items, for the planner's delivery credit when the injection is handed out (D39). */
  items: { sourceId: string; id: string }[];
  text: string;
  /** Edge types the knowledge graph reached the delivered items by (`graph`), learned from on use. */
  graphMask: number;
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
  private readonly sessions = new Map<string, Session>();
  private readonly perTenant = new Map<string, number>();
  private readonly built = new WeakMap<Injection, Built>();
  /** Tenant → user scope key → injection id → outcome; both inner maps least recently recorded first. */
  private readonly recorded = new Map<string, Map<string, Map<string, Recorded>>>();
  private readonly now: () => number;
  private readonly fanout: SourceFanout;
  /** What each user's probes bring back (`probeFresh`, `probeYield`). */
  private readonly economy = new ProbeEconomy();
  /** Span tracing (`spans.ts`): null when off, so each phase's call site is one null check. */
  private readonly spans: Tracer | null;
  private readonly stats: SpanStats | null;
  /**
   * The background sync (`sync`, D57), or null when off. Its `tick` does the background work: a server runs it on a
   * timer (`startSync`), a simulation calls it on its own clock.
   */
  readonly sync: SyncManager | null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  /** Which names followed which intents, per user (`anticipate`). */
  private readonly patterns = new IntentPatterns();

  constructor(private readonly deps: PartnerDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    if (this.config.graph) deps.cache.enableGraph();
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
    }
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
              this.enqueueCards(scope, items);
              this.recordMentions(scope, items);
            },
            tracer: spans,
          },
          {
            maxItems: c.syncMaxItems,
            pageSize: c.syncPageSize,
            everyMs: c.syncEveryMs,
            staleChance: c.syncStaleChance,
            maxStaleMs: c.syncMaxStaleMs,
            activeMs: c.syncActiveMs,
            sweepMs: c.syncSweepMs,
            dropMs: c.syncDropMs,
            callsPerMin: c.syncCallsPerMin,
            catchupPages: c.syncCatchupPages,
            maxUsersPerTenant: c.syncMaxUsersPerTenant,
            timeoutMs: Math.max(c.sourceTimeoutMs, 5_000),
            push: c.syncPush,
            pushMaxStaleMs: c.syncPushMaxStaleMs,
            pushSweepMs: c.syncPushSweepMs,
            pushGapMs: c.syncPushGapMs,
          },
        )
      : null;
  }

  /**
   * Push (`syncPush`): a tenant that holds a watch on one of the user's sources (Gmail watch, Calendar push channel,
   * Slack Events) declares it here once the source is synced, and relays each change notice to `sourceChanged`. A
   * notice carries no content: Eden reads the change with its own read-only list call (D7), or drops the items the
   * notice names as deleted. No-ops unless `sync` and `syncPush` are on and the user is synced; never throw.
   */
  sourcePushes(scope: Scope, sourceId: string): void {
    if (this.sync && this.config.syncPush) this.sync.pushing(scope, sourceId);
  }

  /** A change notice for a source that pushes (`sourcePushes`); see above. */
  sourceChanged(scope: Scope, sourceId: string, change: SourceChange = {}): void {
    if (!this.sync || !this.config.syncPush) return;
    try {
      this.sync.notify(scope, sourceId, change, this.now());
    } catch {
      // A malformed notice is the tenant's; the sync stays as it was.
    }
  }

  /**
   * Runs the background sync's `tick` every `everyMs` (`sync` on; a no-op otherwise). The timer does not keep the
   * process alive, and a tick never overlaps another.
   */
  startSync(everyMs = 60_000): void {
    if (!this.sync || this.syncTimer) return;
    const sync = this.sync;
    this.syncTimer = setInterval(() => void sync.tick(), everyMs);
    this.syncTimer.unref?.();
  }

  stopSync(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  async observe(event: AgentEvent, options: { waitMs?: number } = {}): Promise<ObserveResult> {
    const t0 = performance.now();
    const spans = this.spans;
    const root = spans?.open("observe", 0, { kind: event.kind });
    if (event.kind === "session_end") {
      const ended = this.sessions.get(sessionKey(event));
      if (ended) this.close(ended, true);
      if (root) spans!.close(root);
      return { injection: null, pending: false };
    }
    // A draft the user is still typing is never a request, and moves no turn: with `anticipate` it is read ahead for
    // what the sent message will need; otherwise it is ignored (no session is even opened for it).
    if (event.kind === "user_message" && event.draft === true) {
      if (!this.config.anticipate) {
        if (root) spans!.close(root, { decision: "draft" });
        return { injection: null, pending: false };
      }
      const s = this.session(event);
      const text = sanitizeForStore(head(event.text, this.config.maxEventChars));
      if (text) this.anticipate(s, "draft", text, event.at, false);
      if (root) spans!.close(root, { session: s.id, decision: "draft" });
      return { injection: null, pending: s.inflight !== null || s.pending.length > 0 };
    }
    const s = this.session(event);
    // The user is active: their sources are synced (and polled) while they are (D57). O(1), no I/O.
    this.sync?.track(s.scope, this.now());
    s.turn++;
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
      this.trace({
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
      if (injection) this.handOut(s, injection);
      if (root) {
        spans!.close(root, {
          session: s.id,
          turn: s.turn,
          decision: decided || "lookup",
          delivered: injection !== null,
          ...(waited ? { async: true } : {}),
        });
      }
      return { injection, pending: s.inflight !== null || s.pending.length > 0 };
    };

    const queued = s.pending.shift() ?? null;
    const lookup = wantsLookup(event, text, terms, s.vocab);
    // `anticipate`: every event with words is read for what the agent will need next, in the background. A request's
    // own names and days are its lookup's to probe; read from it are its intent's (class, learned names).
    const tool = event.kind === "tool_call" || event.kind === "tool_result";
    if (
      this.config.anticipate &&
      text &&
      event.kind !== "agent_message" &&
      !(tool && this.config.anticipateOff.includes("tools"))
    ) {
      this.anticipate(s, event.kind, text, event.at, lookup);
    }
    if (!lookup) {
      trace("skipped", event.kind);
      return reply(queued);
    }
    if (event.kind === "user_message") s.situation = classifySituation(text);
    const cue = buildCue(text, terms, s.vocab, event.at, this.deps.cache.offsetOf(s.scope), this.config.probes);
    if (event.kind === "external") cue.external = true;
    cue.arrived = this.now();
    if (root) cue.span = root.id;
    // The request's names are its own lookup's to probe: a later event naming them again prefetches nothing.
    if (s.ant)
      this.markAsked(
        s.ant,
        cue.entities.map((e) => `n:${e.toLowerCase()}`),
      );
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
    // `anticipate` warms the cache before the request, so the fast path meets what only the slow path met before. With
    // a judge, the request then goes to the slow path, whose judge sees every candidate the live search adds: a lone
    // sure item from the cache would end the lookup before the second one that makes it the judge's call.
    const judges = this.config.anticipate && this.deps.model !== null && !this.config.judgeBehind;
    if (this.deps.onCandidates && (!this.deps.model || this.config.judgeBehind)) {
      const delivered = fast.length > 0 && !this.stale(s, fast) && !judges;
      this.dump(s, "fast", this.factsOf(s, cue, ranked, event.kind), delivered ? fast : [], delivered ? "sure" : "");
    }
    if (fast.length > 0 && !this.stale(s, fast) && !judges) {
      this.markCue(s, cue);
      const injection = this.deliver(s, fast, "proactive", `cache:${cue.id}`, cue);
      const ids = fast.map((x) => x.item.id);
      trace("fast", cue.id, { itemIds: ids, ...this.prefetchedOf(s, ids) });
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
    // `anticipate`, with no model: the request is first decided from what is held (the cache, the answers the
    // prefetches warmed), with no call, and what that delivers is returned now; the slow path runs behind it either way
    // and, after such a delivery, adds only what is sure or grounded (`slowPath`'s `served`).
    const early =
      this.config.anticipate && !this.config.anticipateOff.includes("serve")
        ? this.tracedEarly(s, cue, event.kind, t0).catch((): Injection | null => null)
        : null;
    const slow = (
      early
        ? early.then((pre) => (s.closed ? null : this.slowPath(s, cue, t0, event.kind, pre !== null)))
        : this.slowPath(s, cue, t0, event.kind)
    ).finally(() => {
      s.inflight = null;
    });
    s.inflight = slow;
    if (this.config.syncPollBehind && this.sync && this.config.syncOnDemand) {
      this.afterPoll(s, cue, t0, event.kind, slow, early);
    }
    const queueLater = () => void slow.then((inj) => inj && !s.closed && s.pending.push(inj));
    const pre = early ? await early : null;
    if (pre && !s.closed) {
      queueLater();
      if (queued) s.pending.unshift(queued);
      return reply(pre);
    }
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
   * stored something, the lookup is made again on the fresh index and what it delivers is queued. After a delivery
   * (or an early one, `anticipate`) it adds only what is sure or grounded (`served`), as a lookup behind an early
   * delivery does; after silence it decides as the lookup would have had it waited. Follow-ups run one at a time
   * after any lookup in flight, so each request made while the poll was out gets one. Never throws.
   */
  private afterPoll(
    s: Session,
    cue: Cue,
    t0: number,
    eventKind: string,
    first: Promise<Injection | null>,
    early: Promise<Injection | null> | null,
  ): void {
    const chain = first
      .then(async (injection) => {
        // `cue.polled` is set while the first lookup runs (its search), so it is read once the lookup is done.
        const fresh = cue.polled ? await cue.polled : false;
        if (!fresh || s.closed) return;
        // Another lookup still running (a later request, or another request's follow-up) may have read the index
        // before this poll stored anything, so this cue is not covered by it: wait, then look again. The ledger keeps
        // what an earlier lookup delivered from being sent twice.
        while (s.inflight && !s.closed) await s.inflight.catch(() => null);
        if (s.closed) return;
        const served = injection !== null || (early !== null && (await early) !== null);
        const { polled: _, ...again0 } = cue;
        const again = this.slowPath(s, again0, t0, eventKind, served);
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

  /** Work a lookup left running behind its answer (`syncPollBehind`, `judgeBehind`), for harnesses to wait on. */
  private addBehind(s: Session, work: Promise<void>): void {
    const all = s.behind ? Promise.all([s.behind, work]).then(() => {}) : work;
    const tracked: Promise<void> = all.finally(() => {
      if (s.behind === tracked) s.behind = null;
    });
    s.behind = tracked;
  }

  /**
   * `judgeBehind`: the judge, off the critical path. It reads `rest` (candidates the lookup's answer left out) once
   * that answer is out, within the session's model budget, and its picks not yet delivered are queued as a later
   * injection. A failing, cut-off or unaffordable call adds nothing (D41). Never throws.
   */
  private judgeLater(s: Session, cue: Cue, t0: number, eventKind: string, rest: Scored[]): void {
    const model = this.deps.model;
    if (!model || rest.length === 0 || s.closed) return;
    const reservation = this.charge(s);
    if (!reservation) return;
    const turn = s.turn;
    const spans = this.spans;
    const work = (async () => {
      const candidates = rest.map((x) => x.item);
      const messages = judgeMessages(
        s.window.join("\n"),
        candidates,
        this.config.probes,
        this.config.compactInjection ? focusOf(cue) : undefined,
        { windowChars: this.config.judgeWindowChars, itemBytes: this.config.judgeItemBytes },
      );
      const calling = spans?.open("model", cue.span, { async: true, role: "judge-behind" });
      let res: Awaited<ReturnType<Model["chat"]>>;
      try {
        res = await model.chat({
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
        return;
      }
      if (calling) spans!.close(calling, modelAttrs(res));
      this.settle(reservation, res.costUsd);
      const picked = s.closed
        ? []
        : parseJudge(res.text, candidates.length)
            .map((i) => rest[i]!)
            .filter((x) => s.ledger.isFresh(x.item.id, s.turn))
            .slice(0, this.config.maxItemsPerInjection);
      this.trace({
        sessionId: s.id,
        turn,
        event: eventKind,
        decision: picked.length > 0 ? "model" : "silent",
        reason: `judge-behind${res.truncated ? ":model-truncated" : ""}`,
        latencyMs: Math.round(performance.now() - t0),
        sourceCalls: 0,
        modelCalls: 1,
        costUsd: res.costUsd,
        itemIds: picked.map((x) => x.item.id),
      });
      if (picked.length > 0) s.pending.push(this.deliver(s, picked, "proactive", `model:${cue.id}`, cue));
    })().catch(() => {});
    this.addBehind(s, work);
  }

  /** Injections the slow path queued for a session, oldest first. Integrations that poll call this. */
  takePending(ref: Scope & { sessionId: string }): Injection[] {
    const s = this.sessions.get(sessionKey(ref));
    if (!s) return [];
    const out = s.pending.splice(0);
    for (const injection of out) this.handOut(s, injection);
    return out;
  }

  /**
   * The action firewall (`actionCheck`; docs/research/econ-firewall.md): an agent's tool call, before it runs, checked
   * against what is held, with no model and no source call. The session's request and the call's arguments read as
   * words (`actionText`: its days written out, its amounts, names and references) make one cue; what the request's
   * structure grounds against it (`grounded`: a clash at the time it books, a conflict the conflict test reads, the
   * graph's, a card's, someone away that day; `FIREWALL_GROUNDS`) is the finding, delivered already or not: the agent
   * is about to act as if it were not there. Anything else proceeds, as does a call made again unchanged after a
   * finding (the agent's informed choice). A finding is data in the usual envelope; what the integration does with it
   * is its own. With the flag off, every call proceeds and no state is touched. Never throws: a failure proceeds.
   */
  async checkAction(event: AgentEvent): Promise<ActionCheck> {
    const t0 = performance.now();
    const proceed = (reason: string): ActionCheck => ({
      verdict: "proceed",
      finding: null,
      reason,
      latencyMs: Math.round(performance.now() - t0),
    });
    if (!this.config.actionCheck || event.kind !== "tool_call") return proceed("off");
    try {
      const s = this.session(event);
      const key = actionKey(event.tool, event.input);
      if (s.checked?.has(key)) return proceed("repeat");
      // The request the call serves: the session's latest user message or arriving message, as remembered.
      const asked = [...s.window].reverse().find((w) => w.startsWith("user_message: ") || w.startsWith("external: "));
      const request = asked ? asked.slice(asked.indexOf(": ") + 2) : "";
      // What the call commits to (its days, amounts, names, references), without what the agent wrote in it.
      const call = sanitizeForStore(actionText(event.tool, event.input, { prose: false }));
      // The call first: its time is the one the clash test reads (`requestedSpan` reads the first).
      const text = sanitizeForStore(head(`${call}\n${request}`, this.config.maxEventChars));
      if (s.vocab.size > this.config.maxSessionTerms) rebuildVocab(s, this.config.maxSessionTerms);
      const terms = distinctTermIds(text, s.vocab);
      const offset = this.deps.cache.offsetOf(s.scope);
      const cue = buildCue(text, terms, s.vocab, event.at, offset, this.config.probes);
      // The days the call acts on are its own when it names any: an agent that moved the dinner to another evening
      // acts on that evening, not the one the request asked for.
      const own = timeWindow(call, event.at, offset);
      if (own && own.days.size > 0) cue.time = own;
      cue.arrived = this.now();
      // The probes' last answers and the class's cached finds, with no call (as `early` reads them).
      const out: ProbeOut = { calls: 0, kept: [] };
      if (this.config.probes) {
        const all = await within(this.deps.sources(s.scope), EARLY_SOURCES_MS);
        if (all && all.length > 0 && !s.closed) {
          await this.probe(s, cue, all, all, false, out, Promise.resolve(), undefined, {
            offline: true,
            cls: actionClass(cue.raw, true),
            classOffline: true,
            local: this.localOf(s, all),
          });
        }
      }
      if (s.closed) return proceed("closed");
      const walked = this.config.graph ? this.walkGraph(s, cue) : new Map<string, Walked>();
      const carded = this.cardFinds(s, cue);
      const extra = [...out.kept, ...(out.consequence?.ids ?? []), ...carded.keys()];
      // Delivered already or not: what the agent is about to do is checked, not whether it was told.
      const scored = this.rank(s, cue, {
        ignoreLedger: true,
        probed: extra,
        ...(walked.size > 0 ? { walked: [...walked.keys()] } : {}),
      });
      const bridged = this.bridgedOf(scored, cue, out.consequence);
      const g = this.grounded(
        s,
        cue,
        this.eligible(scored, cue, new Set(out.kept), bridged, carded),
        "action",
        bridged,
        out.consequence?.cls,
        walked,
        walked.size > 0 ? scored.filter((x) => walked.has(x.item.id)) : [],
        carded,
      );
      if (g.items.length === 0) return proceed("clear");
      if (!FIREWALL_GROUNDS.has(g.how)) return proceed(`quiet-${g.how}`);
      // Only a call that commits the user at a time clashes with the calendar: one with a start, or one serving a
      // request to schedule ("accept the invite … at 10:00" as a generic action).
      if (g.how === "clash" && !setsTime(event.input) && !isScheduling(request)) return proceed("untimed");
      // And only at a time the user asked for: a reminder or a task the agent placed at a slot of its own choosing
      // overlaps a meeting without clashing with anything the user asked (it would be held at every slot it tries).
      if (g.how === "clash" && requestedSpan(request) === null) return proceed("agent-timed");
      // Read from shared words, a conflict (the conflict test's, the graph's, a card's) holds the action only on a tie
      // the words cannot fake (`structuralTie`: a span over its day, an expiry before it, a limit on its amount, a
      // statement binding a party it names), an identifier or qualified reference the call names, or the action
      // class's find about a party it names.
      const frame = this.frame(cue);
      const named = cleanEntities(cue.entities).filter((e) => !e.includes("@"));
      // The parties: names of two words or more and the user's people the call and request name ("Team" and "Open" in
      // a call's title are not parties), and the organisations of the addresses the call writes to. Never the user,
      // whose name is on everything they hold, nor anything on more than a tenth of their items (their organisation).
      const self = this.deps.cache.selfOf(s.scope)?.toLowerCase().split(/\s+/) ?? [];
      const rare = (n: string) => n.split(/\s+/).some((w) => this.deps.cache.isRare(s.scope, w, SELF_DOMAIN_SHARE));
      const parties = named.filter((e) => e.trim().includes(" ") || this.deps.cache.isPerson(s.scope, e));
      const full = parties.map((e) => e.toLowerCase());
      // A first name alone is a party only when no fuller name has it: "Sam" beside "Sam Ortiz" is Sam Ortiz, and Sam
      // Patel's diet is not his.
      const whole = full.filter((n) => n.includes(" ") || !full.some((m) => m !== n && m.split(/\s+/).includes(n)));
      const names = [...whole, ...domainsOf(call)].filter(
        (n) => rare(n) && !self.some((w) => w.length > 2 && n.split(/\s+/).includes(w)),
      );
      // The call's topic words, without the user's own name (on every item they hold).
      const topical = { ...frame, wordTies: new Set([...frame.wordTies].filter((w) => !self.includes(w))) };
      // The action class's find binds the call when it names a party the call names: "a payment to Cyberdyne was sent"
      // does not bind a payment to the gym, nor a client's no-gifts policy flowers for a sister.
      const tied = (x: Scored) =>
        g.how === "clash" ||
        g.how === "away" ||
        namesRef(frame, x.item, true) ||
        (bridged.has(x.item.id) && whole.some((n) => names.includes(n) && mentions(n, x.item))) ||
        structuralTie(`${x.item.title}. ${x.item.text}`, topical, names, localNow(cue), call);
      const held = g.items.filter(tied);
      if (held.length === 0) return proceed("untied");
      // What the call already takes into account (its notes name the allergy, its email the absence) is not repeated.
      const written = sanitizeForStore(actionText(event.tool, event.input));
      const items = held.filter((x) => !accounts(x.item.text, written, request));
      if (items.length === 0) return proceed("accounted");
      const checked = (s.checked ??= new Set());
      checked.add(key);
      while (checked.size > MAX_CHECKED) checked.delete(checked.values().next().value as string);
      const finding = this.deliver(s, items, "proactive", `action-${g.how}:${cue.id}`, cue);
      this.handOut(s, finding);
      this.trace({
        sessionId: s.id,
        turn: s.turn,
        event: "tool_call",
        decision: "fast",
        reason: `action-${g.how}`,
        latencyMs: Math.round(performance.now() - t0),
        sourceCalls: 0,
        modelCalls: 0,
        costUsd: 0,
        itemIds: items.map((x) => x.item.id),
      });
      return { verdict: "finding", finding, reason: g.how, latencyMs: Math.round(performance.now() - t0) };
    } catch {
      return proceed("error");
    }
  }

  async ask(request: AskRequest): Promise<AskResponse> {
    const t0 = performance.now();
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
    const {
      calls: sourceCalls,
      plans,
      probed,
      local,
      syncCalls,
    } = await this.searchLive(s, cue, this.config.askSources);
    const ranking = spans?.open("rank", cue.span);
    const scored = this.rank(s, cue, { ignoreLedger: true, probed });
    if (ranking) spans!.close(ranking, { candidates: scored.length });
    const grounding = spans?.open("ground", cue.span);
    // What the question's people and days ground comes first (D44); a named day's other events only through it, so
    // a question about a topic is not padded with that day's calendar.
    const onDay = (x: Scored) => cue.time?.days.has(startDay(x.item) ?? "") === true;
    const grounded = this.grounded(
      s,
      cue,
      scored.filter((x) => x.score >= this.config.candidateScore || onDay(x)),
      "ask",
    ).items;
    if (grounding) spans!.close(grounding, { grounded: grounded.length });
    const items = [...grounded, ...scored.filter((x) => x.score >= this.config.candidateScore && !grounded.includes(x))]
      .slice(0, limit)
      .map((x) => x.item);
    const rendering = spans?.open("render", cue.span);
    // `packetDates`: an answer is not compacted, so only an event's missing day needs saying.
    let answer = items.length
      ? renderPacket(items, { maxBytes: 4_000, ...(this.config.packetDates ? { when: true } : {}) })
      : "Nothing in the connected sources.";
    if (rendering) spans!.close(rendering, { items: items.length });
    let usedModel = false;
    let costUsd = 0;
    const reservation =
      this.config.askWithModel && items.length && this.deps.model && !s.closed
        ? this.charge(s, this.config.estimatedAnswerUsd)
        : null;
    if (reservation && this.deps.model) {
      const calling = spans?.open("model", cue.span, { async: true, role: "answer" });
      try {
        const res = await this.deps.model.chat({
          messages: answerMessages(question, s.window.join("\n"), items),
          maxTokens: ANSWER_MAX_TOKENS,
          reasoning: "low",
          cacheKey: userCacheKey(s.scope),
          signal: s.abort.signal,
        });
        this.settle(reservation, res.costUsd);
        // A cut-off answer is not shown: the cited items stand on their own (D43, D45).
        if (res.text.trim() && !res.truncated) answer = renderAnswer(res.text);
        usedModel = true;
        costUsd = res.costUsd;
        if (calling) spans!.close(calling, modelAttrs(res));
      } catch {
        this.settle(reservation, 0);
        if (calling) spans!.close(calling, { error: true });
      }
    }
    if (items.length && !s.closed) {
      const injection = this.deliver(
        s,
        items.map((item) => ({ item, score: 1, matched: 0, sketch: null })),
        "answer",
        "ask",
        cue,
        answer,
      );
      this.handOut(s, injection);
    }
    const latencyMs = Math.round(performance.now() - t0);
    this.trace({
      sessionId: s.id,
      turn: s.turn,
      event: "ask",
      decision: "answer",
      reason: cue.id,
      latencyMs,
      sourceCalls,
      modelCalls: usedModel ? 1 : 0,
      costUsd,
      itemIds: items.map((i) => i.id),
      ...(plans ? { plans } : {}),
      ...(local !== undefined ? { localSources: local, syncCalls: syncCalls ?? 0 } : {}),
    });
    if (root) spans!.close(root, { session: s.id, turn: s.turn, decision: "answer", delivered: items.length > 0 });
    return { answer, citations: citationsOf(items), usedModel, costUsd, latencyMs };
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
      this.record(scope, f.injectionId, o.sourceIds, o.situation, f.used, o.graphMask);
      return true;
    }
    // The session may have ended (and counted the injection unused): the user's record outlives it.
    const r = this.recordedOf(scope)?.get(f.injectionId);
    if (!r) return false;
    if (r.used !== f.used) {
      for (const sourceId of r.sourceIds) this.deps.sourceMap.correctOutcome(scope, r.situation, sourceId, f.used);
      r.used = f.used;
    }
    return true;
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
    this.deps.sourceMap.forget(scope, sourceId);
    this.fanout.forget(scope, sourceId);
    this.deps.planner?.forget(scope, sourceId);
    this.economy.forget(scope, sourceId);
    this.sync?.forget(scope, sourceId);
    // A source's forget drops only what its items brought: the user's other items keep their cards.
    this.deps.cards?.forget(scope, sourceId);
    this.patterns.forget(scope, sourceId);
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
      for (const [id, o] of s.outstanding) this.record(s.scope, id, o.sourceIds, o.situation, false, o.graphMask);
    }
    s.outstanding.clear();
    s.pending.length = 0;
    s.window.length = 0;
    s.agentHas.length = 0;
    this.deps.budget.endSession(s.key);
    this.sessions.delete(s.key);
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
      ...(built.graphMask ? { graphMask: built.graphMask } : {}),
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
      this.record(s.scope, id, o.sourceIds, o.situation, used, o.graphMask);
    }
  }

  private record(
    scope: Scope,
    injectionId: string,
    sourceIds: string[],
    situation: string,
    used: boolean,
    graphMask = 0,
  ): void {
    for (const sourceId of sourceIds) this.deps.sourceMap.recordOutcome(scope, situation, sourceId, used);
    // The knowledge graph learns which edge types reach what the agent then uses (`graph`).
    if (graphMask && this.config.graphLearn) this.deps.cache.learnGraph(scope, graphMask, used);
    const key = scopeKey(scope);
    const tenant = this.recorded.get(scope.tenantId) ?? new Map<string, Map<string, Recorded>>();
    this.recorded.set(scope.tenantId, tenant);
    const mine = tenant.get(key) ?? new Map<string, Recorded>();
    tenant.delete(key); // Re-insert: Map order is least recently recorded user first.
    tenant.set(key, mine);
    mine.set(injectionId, { sourceIds, situation, used });
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
  private rank(
    s: Session,
    cue: Cue,
    options: { ignoreLedger?: boolean; probed?: string[]; walked?: string[] } = {},
  ): Scored[] {
    const cache = this.deps.cache;
    const vocab = cache.peekVocab(s.scope);
    if (!vocab) return []; // No cache for this user: nothing to rank, and nothing allocated.
    const q = termIds(`${cue.text} ${cue.entities.join(" ")}`, vocab, false);
    const query: number[] = [];
    for (let i = 0; i < q.n; i++) if (!isStopword(vocab.term(q.ids[i]!))) query.push(q.ids[i]!);
    // Events on a day the request names are candidates whether or not they share its words (D44); they rank after
    // every item that does, so the judge, when there is one, sees them only if there is room.
    const timed = cue.time?.days.size ? cache.timed(s.scope, cue.time.days, this.now()) : [];
    if (query.length === 0 && timed.length === 0 && !options.probed?.length && !options.walked?.length) return [];
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
    // So are the knowledge graph's finds (`graph`): reached through a name, an id or a day, not through words.
    const walked = options.walked?.length ? cache.hits(s.scope, options.walked, this.now()) : [];
    const walkedOnly = new Set<string>();
    for (const h of walked) {
      if (found.some((f) => f.item.id === h.item.id)) continue;
      found.push(h);
      walkedOnly.add(h.item.id);
    }
    return (
      found
        .filter((h) => options.ignoreLedger || s.ledger.isFresh(h.item.id, s.turn))
        // A near-duplicate of something already delivered this session (a reply quoting it, a synced copy) is old news.
        .filter((h) => options.ignoreLedger || !s.delivered.some((d) => nearDuplicate(d, h.sketch)))
        // What the agent already has in front of it (a tool result it fetched, its own read-out) is not news either.
        .filter((h) => options.ignoreLedger || !this.alreadyHas(s, h.item, h.doc, vocab))
        .map((h) => {
          const entityHit = entities.some(
            (ids) => ids.length > 0 && cache.containsAll(s.scope, h.doc, ids, ids.length),
          );
          const score = h.coverage + (entityHit ? this.config.entityBonus : 0);
          const scored: Scored = { item: h.item, matched: h.matched, score, sketch: h.sketch, doc: h.doc };
          if (people.length > 0) scored.beyond = beyondOf(h.doc);
          if (walkedOnly.has(h.item.id)) scored.walkedOnly = true;
          if (entityHit) scored.entity = true;
          return scored;
        })
        .sort((a, b) => b.score - a.score)
        // Of near-duplicates among the candidates, keep the best scored: one packet never says the same thing twice.
        // Occurrences of a recurring event read alike but are not the same thing: another day is another item.
        .filter(
          (x, i, all) =>
            !all.slice(0, i).some((y) => nearDuplicate(x.sketch, y.sketch) && startDay(x.item) === startDay(y.item)),
        )
    );
  }

  private confident(scored: Scored[], cue: Cue): Scored[] {
    return (
      scored
        .filter((x) => x.score >= this.config.confidentScore && x.matched >= this.config.minMatchedTerms)
        // Bulk mail is never pushed without a model's say: a newsletter arriving is no reason to speak.
        .filter((x) => !bulkMail(x.item))
        // Nor, with `quietSettled`, an item that only says things stand as expected (`settled`); nor, with
        // `groundAway`, an absence on other days than the request names (`awayElsewhere`).
        .filter((x) => !this.config.quietSettled || !settled(x.item))
        .filter((x) => !this.awayElsewhere(x.item, cue))
        // Nor, with `quietClear`, one about what the request names whose decisive value does not conflict with it.
        .filter((x) => !this.cleared(x, cue))
        // Nor, with `quietNameOnly`, one only a name ties to the request.
        .filter((x) => this.beyondName(x, cue))
        .slice(0, Math.min(this.config.maxItemsPerInjection, this.config.confidentItems))
    );
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
    walked?: ReadonlyMap<string, Walked>,
    graphPool: Scored[] = [],
    carded: ReadonlyMap<string, CardFind> = new Map(),
  ): { items: Scored[]; how: string } {
    const none = { items: [] as Scored[], how: "" };
    const pool = candidates.filter((x) => !bulkMail(x.item));
    const time = cue.time;
    const onDay = (x: Scored) => time !== null && time.days.has(startDay(x.item) ?? "");
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
      const clashes = pool.filter((x) => time.days.has(startDay(x.item) ?? "") && near(x)).sort(soonest);
      if (clashes.length > 0) return { items: clashes.slice(0, this.max()), how: "clash" };
    }
    // With `groundConflict`: what would change the action (or the answer), tied to what the request names or asks
    // (`conflict.ts`): a hold over the day it acts on, a limit below its amount, a thing done already (D49).
    if (this.config.groundConflict) {
      const { hits, best } = this.conflicts(cue, pool, acts, bridged, cls, walked, graphPool);
      if (hits.length > 0) {
        // With `graphMerge`, the walk's best conflict joins the request's own (it was found another way).
        const extra = this.config.graphMerge ? best.slice(0, this.config.graphGround) : [];
        return { items: [...hits.slice(0, this.max() - extra.length), ...extra], how: "conflict" };
      }
      if (best.length > 0) return { items: best.slice(0, this.config.graphGround), how: "graph" };
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
      return { items: [[...withPerson].sort((a, b) => b.score - a.score || near(a) - near(b))[0]!], how: "person" };
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
   * Whether a request acts on someone (scheduling, writing to them, a task), arrives from outside, or is a tool call
   * the action firewall checks (`checkAction`, "action").
   */
  private acts(s: Session, cue: Cue, eventKind: string): boolean {
    return (
      eventKind === "external" ||
      eventKind === "ask" ||
      eventKind === "action" ||
      ACTING.has(s.situation) ||
      ACTS_ON.test(cue.raw)
    );
  }

  /**
   * The conflict ground's finds (`groundConflict`, D49): candidates about what the request names, tied beyond a name,
   * that `conflict.ts` says conflict with it (`hits`), with the conflicting consequence finds (`bridged`); and the
   * graph's conflicts (`graph`), best walked first (`best`, those not among the hits).
   */
  private conflicts(
    cue: Cue,
    pool: Scored[],
    acts: boolean,
    bridged: ReadonlySet<string>,
    cls: ActionClass | undefined,
    walked: ReadonlyMap<string, Walked> | undefined,
    graphPool: Scored[],
  ): { hits: Scored[]; best: Scored[] } {
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
    // With `graph`: an item the knowledge graph reached from what the request names (a person's organisation, the
    // name a colleague goes by, an identifier, a role) or from a day it names, though it shares none of its words,
    // tied in the conflict test by the names it was reached through (`conflictTies`); its author speaks for them
    // when the graph says the author is someone the request names or one of theirs.
    const viaGraph: Scored[] = [];
    // Only when the request's own words ground no conflict: the graph widens what is found, not what is said.
    // Only for a request that acts or asks, or a message arriving: a remark that names someone ("haha Lucía sent me
    // a meme") is no occasion to raise what binds them or their organisation.
    const engaged = acts || isImperative(cue.raw) || isAction(cue.raw);
    if (walked?.size && engaged && (hits.length === 0 || this.config.graphMerge)) {
      for (const x of graphPool) {
        const w = walked.get(x.item.id);
        if (!w || !w.binds || bulkMail(x.item) || !this.beyondName(x, cue)) continue;
        // A notification's status ("Status: Blocked") is no one's constraint on a person it names, unless the request
        // names its reference.
        if (w.automated && w.named && !w.byRef) continue;
        // A limit on an amount ("travel over £500 needs pre-approval") binds a request that states no amount only
        // perhaps: with no model's say, not raised on a name alone (as for the consequence probe, D54).
        if (unmeasuredLimit(this.frame(cue), x.item)) continue;
        if (this.verdict(x.item, cue, this.conflictTies(cue, w), w.speaks) === "conflict") viaGraph.push(x);
      }
    }
    // The walk's best first: it is the one most tied to what the request names.
    const by = (x: Scored) => walked!.get(x.item.id)!.score;
    const best = viaGraph.filter((x) => !hits.includes(x)).sort((a, b) => by(b) - by(a));
    return { hits, best };
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
    return !daysNamed(item, cue.at).some((d) => time.days.has(d)) && !time.days.has(startDay(item) ?? "");
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
      walked?: ReadonlyMap<string, Walked>;
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
      const w = ctx.walked?.get(item.id);
      const card = ctx.carded?.get(item.id);
      const day = startDay(item);
      const at = startMs(item);
      const span = hasDays ? absenceSpan(item, cue.at) : null;
      const verdict = this.verdict(item, cue);
      const beyondName = this.beyondName(x, cue);
      const about = this.about(x, cue);
      const unmeasured = unmeasuredLimit(frame, item);
      const graphConflict =
        w !== undefined && w.binds && this.verdict(item, cue, this.conflictTies(cue, w), w.speaks) === "conflict";
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
        graphHit: b(graphConflict && beyondName && !bulkMail(item) && w.automated !== true),
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
        walked: b(w !== undefined),
        walkScore: w?.score ?? 0,
        binds: b(w?.binds === true),
        walkNamed: b(w?.named === true),
        automated: b(w?.automated === true),
        graphConflict: b(graphConflict),
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
    });
  }

  /** The request's frame (`conflict.ts`), read once per cue. */
  private frame(cue: Cue): Frame {
    let f = FRAMES.get(cue);
    if (!f) {
      const names = cleanEntities(cue.entities).filter((e) => !e.includes("@"));
      // The user's wall clock, so "today" and a date's nearest year are their own (D44), as `cue.time.days` are.
      FRAMES.set(cue, (f = frameOf(cue.raw, cue.time?.days ?? null, localNow(cue), names)));
    }
    return f;
  }

  /** What an item says about the request's frame: conflict, clear or none (`conflict.ts` `assess`). */
  private verdict(item: ContextItem, cue: Cue, ties?: ReadonlySet<string>, speaks = false): Verdict {
    return assess(this.frame(cue), item, localNow(cue), ties, speaks);
  }

  /**
   * The words that tie a graph-walked item's statements to the request (`graph`): the names of the nodes it was
   * reached through ("umbrella", "health"); with `graphWordTies`, for one reached by a name, the request's own words
   * (the name already says the item is about what the request names); for one reached by a day alone, the request's
   * action class's words (`consequence.ts`: "production" for a release), when it has one.
   */
  private conflictTies(cue: Cue, w: Walked): Set<string> {
    const ties = tieWords(w.via);
    if (w.named && this.config.graphWordTies) for (const t of this.frame(cue).wordTies) ties.add(t);
    if (!w.named) {
      const cls = actionClass(cue.raw, isAction(cue.raw) || cue.external === true);
      if (cls) for (const t of classTies(cls)) ties.add(t);
    }
    return ties;
  }

  /**
   * The knowledge graph's finds for a request (`graph`): a walk from its names (as typed, and capitalised runs the
   * user's items name), identifiers, roles and, with `graphDays`, days. The user's own name, addresses and
   * organisation are kept out (`ItemCache.walk`): they are on everything. CPU only, bounded by `graphBudgetMs`.
   */
  private walkGraph(s: Session, cue: Cue): Map<string, Walked> {
    const seeds = seedsOf(cue.raw, cleanEntities(cue.entities), this.config.graphDays ? (cue.time?.days ?? []) : []);
    const found = this.deps.cache.walk(
      s.scope,
      seeds,
      { budgetMs: this.config.graphBudgetMs, limit: this.config.graphItems, floor: this.config.graphFloor },
      this.now(),
    );
    const out = new Map(found.map((w) => [w.id, w]));
    WALKS.set(cue, out);
    return out;
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
    if (cue.external || isImperative(cue.raw)) return true;
    const days = cue.time?.days;
    if (days && days.size > 0) {
      if (days.has(startDay(x.item) ?? "") || daysNamed(x.item, cue.at).some((d) => days.has(d))) return true;
    }
    return namesRef(this.frame(cue), x.item);
  }

  /** The people a request names: its names that someone in the user's items goes by (`ItemCache.isPerson`). */
  private peopleOf(s: Session, cue: Cue): string[] {
    return cleanEntities(cue.entities).filter((e) => !e.includes("@") && this.deps.cache.isPerson(s.scope, e));
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
    const onDay = (x: Scored) => time !== null && time.days.has(startDay(x.item) ?? "");
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
    const kind = (t: Set<string>) => kinds.some((w) => t.has(w));
    const withName = events.filter((x) => {
      const t = titleWordsOf(x);
      return named(t) && kind(t);
    });
    if (withName.length > 0) {
      const r = pick(withName, "occasion-person");
      if (r.items.length > 0) return r;
    }
    // By occasion and day alone only for a question about it: an action on a day's occasion ("send the pack before
    // next week's board meeting") is about the action, and the occasion standing as planned is no news.
    if (time !== null && time.days.size > 0 && names.length === 0 && /\?\s*$/.test(cue.raw)) {
      const r = pick(
        events.filter((x) => onDay(x) && kind(titleWordsOf(x))),
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
   * `recoverNames`: the cue with the names it holds in lowercase added ("drinks with chen wei", "reply to stark
   * freight"). A run of two or three words, none a stopword, a date or already an entity, is a name when the user's
   * own sources have been recorded mentioning it (the source map's mentions: names their items wrote capitalised).
   * A single word is never taken: "Lunch" is capitalised in many subjects. Longest runs first; at most
   * `MAX_RECOVERED` names, from the request's first `RECOVER_WORDS` words. One indexed read per run tried.
   */
  private withRecoveredNames(s: Session, cue: Cue): Cue {
    const have = new Set(cue.entities.map((e) => e.toLowerCase()));
    const words = (cue.raw.match(/[\p{L}\p{N}][\p{L}\p{N}&'’-]*/gu) ?? []).slice(0, RECOVER_WORDS);
    // Only words typed in lowercase: a capitalised run was the extractor's to read ("Has Aperture Labs been paid?").
    const open = (w: string) => w === w.toLowerCase() && !isStopword(w) && !TIME_WORD.test(w) && !LEADING.has(w);
    const used = new Uint8Array(words.length);
    const found: string[] = [];
    for (let n = 3; n >= 2; n--) {
      for (let i = 0; i + n <= words.length && found.length < MAX_RECOVERED; i++) {
        const run = words.slice(i, i + n);
        if (run.some((w, k) => used[i + k] || !open(w))) continue;
        const name = run.join(" ");
        if (have.has(name) || this.deps.sourceMap.sourcesFor(s.scope, name).length === 0) continue;
        found.push(run.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" "));
        used.fill(1, i, i + n);
      }
    }
    return found.length ? { ...cue, entities: [...cue.entities, ...found] } : cue;
  }

  /**
   * With no model's say, the best candidate alone, if it is strong enough: several distinct query terms and a score
   * of at least `fallbackScore` (coverage plus the entity bonus, D36). One item at most: nothing has judged it.
   */
  private fallback(unsure: Scored[], agreed?: Set<string>, cue?: Cue): Scored | null {
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
    if (strong && (!cue || this.beyondName(top, cue))) return top;
    // Found both by the request's own search and by a probe for its people (`fallbackAgree`): two independent queries
    // agreeing is evidence words alone are not. Still one item, and it must share two of the request's terms.
    if (!agreed) return null;
    return (
      unsure
        .slice(0, 3)
        .find(
          (x) =>
            agreed.has(x.item.id) &&
            x.matched >= 2 &&
            x.score >= c.fallbackAgreeScore &&
            !bulkMail(x.item) &&
            (!cue || this.beyondName(x, cue)),
        ) ?? null
    );
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
    const holders = s.agentHas.filter((held) => ids.every((id) => held.terms.has(id)));
    if (holders.length === 0) return false;
    // Every term is known to the session now, so no term is skipped and adjacent ids are adjacent words.
    const pairs = [...pairsOf(item.title, s.vocab), ...pairsOf(item.text.slice(0, HELD_CHARS), s.vocab)];
    return holders.some((held) => pairs.every((p) => held.pairs.has(p)));
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
  }> {
    const all = await this.deps.sources(s.scope).catch((): Source[] => []);
    if (all.length === 0 || s.closed) return { calls: 0 };
    // The background sync (D57): a source whose synced copy is current answers from the user's local index, at no
    // call; with `syncOnDemand`, a stale one is polled first (one listing call, rather than its search and probes).
    let local: Set<string> | null = null;
    let syncCalls = 0;
    if (this.sync) {
      if (this.config.syncOnDemand) {
        const signal = AbortSignal.any([s.abort.signal, AbortSignal.timeout(this.config.sourceTimeoutMs)]);
        const freshening = this.spans?.open("sync.freshen", cue.span, { async: true });
        const tally = { fresh: 0 };
        const polled = this.sync.freshen(s.scope, all, signal, tally).then((calls) => {
          if (freshening) this.spans!.close(freshening, { calls, fresh: tally.fresh, ...(behind ? { behind } : {}) });
          return calls;
        });
        // `syncPollBehind`: the poll is not waited for. This lookup answers from the index as it stands (every warm
        // synced source, current or not); if the poll stores anything, the lookup is made again once it is done
        // (`afterPoll`), and the agent's ask waits for it as before.
        if (behind) cue.polled = polled.then(() => tally.fresh > 0).catch(() => false);
        else syncCalls = await polled;
        if (s.closed) return { calls: syncCalls, syncCalls };
      }
      local = this.localOf(s, all, behind);
    }
    const routing = this.spans?.open("route", cue.span);
    const ranked = this.deps.sourceMap.route({
      scope: s.scope,
      entities: cue.entities,
      situation: s.situation,
      sourceIds: all.map((x) => x.id),
      limit,
    });
    if (routing) this.spans!.close(routing, { sources: ranked.length, local: local?.size ?? 0, syncCalls });
    const routed = ranked.map((r) => all.find((x) => x.id === r.sourceId)!).filter(Boolean);
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
    // The fan-out's deadline for this lookup, so the planner's cascade sends only the calls that can still answer. A
    // listing goes to each source as it is: the planner's shapes are ways of sending words, and it has none.
    const deadlineAt = performance.now() + this.config.sourceTimeoutMs;
    const spans = this.spans;
    const searchSpan = spans?.open("search", cue.span, { async: true, listing });
    // With spans on, each call a source answers is a child span of this search (`traced`).
    const sendTo = searchSpan ? (xs: Source[]) => xs.map((x) => this.traced(x, searchSpan.id)) : (xs: Source[]) => xs;
    // With `probeShare`: what the planner and the probes of this lookup send alike is sent once (`SharedCalls`).
    const shared: SharedCalls | undefined = this.config.probeShare ? new Map() : undefined;
    // `anticipate`: what a prefetch already asked a source for the request's names answers the planner too (its
    // query per name), as it answers the probes (`probe`'s `recent`).
    if (shared && this.config.anticipate && s.ant) this.seedShared(s, shared, cue, all);
    const chosen =
      planner && !listing
        ? sendTo(found).map(
            (x) =>
              new PlannedSource(
                x,
                planner,
                () => this.fanout.permit(s.scope, x.id),
                this.fanout.planCalls(x, shared),
                deadlineAt,
              ),
          )
        : listing
          ? sendTo(listers.filter((x) => !local?.has(x.id)))
          : sendTo(found);
    // Probes (`probe`) go out with the lookup, not after it: the slow path waits for the slower of the two, not both.
    const probeThis =
      this.config.probeWhen === "always" ||
      isAction(cue.raw) ||
      ACTING.has(s.situation) ||
      ACTS_ON.test(cue.raw) ||
      cue.external;
    // A probe that fails is no probe; a session that closes mid-search leaves it to finish on its own (it checks).
    // The lookup's own search starts first: the fan-out admits a call when it starts (a per-source concurrency slot),
    // and probes started before it could take the slots and leave the request itself skipped as busy.
    const searching = this.fanout.search(
      chosen,
      {
        scope: s.scope,
        text: listing ? "" : cue.text,
        entities: cue.entities,
        limit: 8,
        ...(window ? { window } : {}),
      },
      { timeoutMs: this.config.sourceTimeoutMs, signal: s.abort.signal },
    );
    const settled = searching.catch(() => null);
    const probed: ProbeOut = { calls: 0, kept: [] };
    const probing =
      this.config.probes && probeThis
        ? this.probe(s, cue, routed, all, listing, probed, settled, shared, {
            ...this.lookupOpts(s, cue),
            local,
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
    if (searchSpan) spans!.close(searchSpan, outcomeAttrs(outcomes));
    const plans = planner
      ? chosen.flatMap((x) => {
          const last = (x as PlannedSource).last;
          return last ? [{ sourceId: x.id, shapes: last.shapes, calls: last.calls, found: last.found }] : [];
        })
      : undefined;
    const result = {
      calls: chosen.length + syncCalls,
      ...(plans ? { plans } : {}),
      ...(this.sync ? { local: local?.size ?? 0, syncCalls } : {}),
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
      this.store(s, o.items, cue.span);
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
    if (opts.after) {
      // A prefetch of the same names still running (`anticipate`): its answers, once in, stand in for these calls.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((done) => (timer = setTimeout(done, this.config.probeGraceMs)));
      await Promise.race([opts.after.catch(() => {}), grace]);
      clearTimeout(timer);
      if (s.closed) return;
    }
    const lanes = new Map<string, Promise<unknown>>();
    const budget = opts.budget ?? this.config.probeCalls;
    const local = opts.local ?? null;
    const spans = this.spans;
    const probesSpan = spans?.open("probes", cue.span, { async: true });
    // Calls the consequence probe made (outside `budget`).
    let extra = 0;
    const deadline = performance.now() + this.config.sourceTimeoutMs;
    const kept = out.kept;
    const send = async (
      kind: ProbeKind,
      sources: Source[],
      text: string,
      window?: SearchQuery["window"],
      keep = true,
      onAnswer?: (sourceId: string, page: ContextItem[]) => void,
      offline = opts.offline === true,
    ): Promise<ContextItem[]> => {
      if (!spans) return sendOne(kind, sources, text, window, keep, onAnswer, offline, 0);
      const sp = spans.open(`probe.${kind}`, probesSpan!.id, { async: true, sources: sources.length, offline });
      const callsBefore = out.calls;
      try {
        return await sendOne(kind, sources, text, window, keep, onAnswer, offline, sp.id);
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
      offline: boolean,
      parent: number,
    ): Promise<ContextItem[]> => {
      // Synced sources whose copy is current answer from the local index (D57), at no call and outside `probeCalls`;
      // with `syncWide`, every such source does, not only the ones this probe was routed to (a person or a topic).
      let here: ContextItem[] = [];
      if (local) {
        const wide = this.config.syncWide && kind !== "day" ? all.filter((x) => local.has(x.id)) : [];
        const mine = new Set([...sources.filter((x) => local.has(x.id)), ...wide].map((x) => x.id));
        sources = sources.filter((x) => !local.has(x.id));
        if (mine.size > 0) {
          here = this.localAnswer(s, mine, text, window ? 20 : 5, window);
          if (keep) for (const i of here) if (!kept.includes(i.id)) kept.push(i.id);
        }
        if (sources.length === 0) return here;
      }
      // With `anticipate`, the same sources in another order are the same probe: an event's prefetch and the request
      // route a name at different moments (the situation, the mentions recorded in between), and should share it.
      const ids = sources.map((x) => x.id);
      if (this.config.anticipate) ids.sort();
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
      // Offline (`anticipate`'s read at the request, and its class read): what each source last answered to this
      // query, while still cached, and no call.
      if (offline) {
        const now = this.now();
        for (const source of sources) {
          const last = this.economy.lastIds(s.scope, source.id, asked);
          if (last) for (const h of this.deps.cache.hits(s.scope, last, now)) reused.push(h.item);
        }
        if (keep) for (const i of reused) if (!kept.includes(i.id)) kept.push(i.id);
        return [...here, ...reused];
      }
      let live = sources;
      if (this.config.probeFresh || this.config.probeYield || this.config.anticipate) {
        live = [];
        const now = this.now();
        for (const source of sources) {
          // `anticipate`: asked live at this source within the memo's age (an event's prefetch, most often), its last
          // answer stands in as the memo's would; the memo itself keeps only answers every source gave in full.
          const at = this.config.anticipate ? this.economy.askedAt(s.scope, source.id, asked) : null;
          const recent = at !== null && now - at <= this.config.probeMemoMs;
          const unchanged =
            recent ||
            (this.config.probeFresh &&
              this.economy.changeChance(s.scope, source.id, asked, now) < this.config.probeFreshFloor);
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
      // A page of the probe's own size from each source, even when the call was the planner's (8 items): more would
      // crowd the probes' seats with the judge (live, the judge passed fewer planted items with them).
      const items = outcomes.flatMap((o) => o.items.slice(0, window ? 20 : 5));
      // `anticipate` with shared calls: the whole answer (the planner's page size) is cached and recorded, so it can
      // stand in for the planner's own query of the name later (`seedShared`); the probe's finds stay its first five.
      const whole = window ? 20 : this.config.anticipate && shared ? 8 : 5;
      // A call the fan-out did not make (busy, limited, open, answered from its cache, past the deadline) is no call.
      const unmade = to.length - outcomes.filter((o) => !SKIPPED.has(o.status)).length;
      out.calls -= unmade;
      if (own) extra -= unmade;
      // A consequence probe's answers are always recorded: which of its terms each source was asked, and when, is
      // what rotates them and what its later lookups recall (`consequence`).
      const learn =
        this.config.probeFresh || this.config.probeYield || this.config.consequenceProbe || this.config.anticipate;
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
        this.store(s, whole > 5 && !window ? outcomes.flatMap((o) => o.items.slice(0, whole)) : items, parent);
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
    const routeFor = (name: string, limit = c.probePeopleSources) =>
      opts.offline
        ? all
        : this.deps.sourceMap
            .route({
              scope: s.scope,
              entities: [name],
              situation: s.situation,
              sourceIds: all.map((x) => x.id),
              limit,
            })
            .map((r) => all.find((x) => x.id === r.sourceId)!)
            .filter(Boolean);
    const people = off.has("people") ? [] : cue.entities.slice(0, 2);
    // `probeTopicAlone`: the topic only for a request that names no one (with people, their probes find what the topic
    // would: held-out funnels returned as many planted items without it, at fewer calls).
    const topic =
      opts.noTopic || off.has("topic") || (c.probeTopicAlone && people.length > 0)
        ? ""
        : topicOf(cue.text.split(" "), cue.entities);
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
    const cls =
      opts.cls !== undefined
        ? opts.cls
        : c.consequenceProbe && !off.has("consequence")
          ? actionClass(cue.raw, acts)
          : null;
    // The class read with no call (`anticipate`): the class's queries an event's prefetch sent, as cached.
    const offlineSend: ProbeSend = (k, src, t, w, keep, on) => send(k, src, t, w, keep, on, true);
    // `syncTermProbes` (D57): with sources answered locally, each of the request's words that few of the user's items
    // hold (a place, a reference, a product), alone, to those sources: a query per word, which no live budget allows.
    const synced = local ? all.filter((x) => local.has(x.id)) : [];
    const terms = synced.length > 0 && c.syncTermProbes > 0 ? this.termProbes(s, cue, c.syncTermProbes) : [];
    await Promise.all([
      ...terms.map((t) => send("topic", synced, t)),
      ...windows.map((w) => send("day", listers, "", w)),
      byPeople,
      ...roles.map((r) => send("role", found.slice(0, 2), r)),
      // The topic's finds share the request's words, and rank on them; the others get seats of their own.
      ...(topic ? [send("topic", found.slice(0, this.config.probeTopicSources), topic, undefined, false)] : []),
      // Last: a source's probe calls go one at a time, and the request's own probes go first.
      ...(cls ? [this.consequence(s, cls, all, found, opts.classOffline ? offlineSend : send, out)] : []),
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

  /** Caches sanitized items and records the entity mentions of those new to the cache or changed. */
  private store(s: Session, items: ContextItem[], parent = 0): void {
    const spans = this.spans;
    const putting = items.length > 0 ? spans?.open("cache.put", parent, { items: items.length }) : undefined;
    const added = this.deps.cache.put(s.scope, items, this.now(), true);
    if (putting) spans!.close(putting, { added: added.length });
    // An item seen again unchanged keeps its card alive; one evicted by the same put is not carded at all.
    if (this.config.cards)
      this.deps.cards?.touch(
        s.scope,
        items.map((i) => i.id),
      );
    this.enqueueCards(s.scope, added);
    this.recordMentions(s.scope, added, parent);
  }

  /** `cards`: what is new to the cache (looked up or synced) is read for constraints in the background, off-path. */
  private enqueueCards(scope: Scope, added: ContextItem[]): void {
    if (this.config.cards && this.deps.cards && added.length > 0) this.deps.cards.enqueue(scope, added);
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
  private recordMentions(scope: Scope, added: ContextItem[], parent = 0): void {
    if (added.length === 0) return;
    const spans = this.spans;
    const noting = spans?.open("mentions", parent, { items: added.length });
    const mentions = added.map((item) => ({
      sourceId: item.sourceId,
      entities: extractTypedEntities(`${item.title}. ${item.text}`)
        .filter((e) => PERSISTABLE_KINDS.has(e.kind))
        .slice(0, 20)
        .map((e) => e.text),
    }));
    if (mentions.length > 0) this.deps.sourceMap.recordMentionsMany(scope, mentions, this.now());
    if (noting) spans!.close(noting);
  }

  /** Whether any of these cached items was fetched longer ago than `refreshAfterMs` (refreshing on). */
  private stale(s: Session, scored: Scored[]): boolean {
    const after = this.config.refreshAfterMs;
    if (after <= 0) return false;
    const now = this.now();
    // A synced item counts by when the sync last read it too (D57): its source's copy may be current, but the fast
    // path stays for what was read recently, and the rest goes through the slow path, which answers from the local
    // index at no call and lets the judge, when there is one, rule (the fast path never asks it).
    return scored.some((x) => now - this.readAt(s, x.item, now) > after);
  }

  /**
   * When an item's copy was last known current: when it was fetched, or now when its source pushes its changes and
   * has none unread (`syncPush`: a quiet pushed source is not re-listed, and its copy is no older for it).
   */
  private readAt(s: Session, item: ContextItem, now: number): number {
    if (this.sync?.confirmed(s.scope, item.sourceId, now)) return now;
    return this.deps.cache.fetchedAt(s.scope, item.id) ?? now;
  }

  /**
   * Re-reads the best candidates fetched longer ago than `refreshAfterMs` through their source's `fetch`, so what is
   * ranked next is the source's current copy (D40). At most `maxRefreshes`, in parallel, under the fan-out's guards;
   * a source without `fetch`, or a call that fails or is skipped, leaves the cached copy as it is. Returns the fetches
   * attempted.
   */
  private async refresh(s: Session, cue: Cue): Promise<number> {
    const c = this.config;
    if (c.refreshAfterMs <= 0 || c.maxRefreshes <= 0 || s.closed) return 0;
    const spans = this.spans;
    if (!spans) return this.refreshOnce(s, cue, 0);
    const sp = spans.open("refresh", cue.span, { async: true });
    let fetched = 0;
    try {
      fetched = await this.refreshOnce(s, cue, sp.id);
      return fetched;
    } finally {
      spans.close(sp, { fetches: fetched });
    }
  }

  private async refreshOnce(s: Session, cue: Cue, parent: number): Promise<number> {
    const c = this.config;
    const now = this.now();
    const stale = this.rank(s, cue)
      .filter((x) => x.score >= c.candidateScore)
      .slice(0, c.judgeCandidates)
      .filter((x) => now - this.readAt(s, x.item, now) > c.refreshAfterMs)
      .slice(0, c.maxRefreshes);
    if (stale.length === 0) return 0;
    const all = await this.deps.sources(s.scope).catch((): Source[] => []);
    const jobs = stale.flatMap((x) => {
      const source = all.find((a) => a.id === x.item.sourceId);
      // A ref the gate redacted, or Eden's own content hash, cannot be asked for again: no call, no rate token.
      const fetchable = !x.item.ref.includes(REDACTED) && !x.item.ref.startsWith("eden-h-");
      return source?.fetch && fetchable
        ? [{ source: parent ? this.traced(source, parent) : source, ref: x.item.ref }]
        : [];
    });
    if (jobs.length === 0 || s.closed) return 0;
    const fresh = await Promise.all(
      jobs.map((j) =>
        this.fanout.fetch(j.source, s.scope, j.ref, { timeoutMs: c.sourceTimeoutMs, signal: s.abort.signal }),
      ),
    );
    if (s.closed) return jobs.length; // Forgotten or ended meanwhile: keep nothing (D17).
    this.store(
      s,
      fresh.filter((x): x is ContextItem => x !== null),
      parent,
    );
    return jobs.length;
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
  ): Scored[] {
    // An event on a day the request names is a candidate whatever it scores on words (D44).
    const onNamedDay = (x: Scored) => cue.time?.days.has(startDay(x.item) ?? "") === true;
    // A consequence find that does not conflict is no candidate: it shares nothing with the request but its class.
    // A graph walk's own finds (`graph`) are not either: they have their seats and ground, and no other path.
    return scored.filter(
      (x) =>
        !x.walkedOnly &&
        (x.score >= this.config.candidateScore ||
          onNamedDay(x) ||
          probed.has(x.item.id) ||
          bridged.has(x.item.id) ||
          carded.has(x.item.id)),
    );
  }

  /**
   * The consequence finds that conflict with the request (`consequenceProbe`, or `anticipate`'s class read): a freeze
   * over the day a release is asked for, not one last month; and not a limit on an amount the request does not state
   * ("travel over £500 needs pre-approval" for printer paper).
   */
  private bridgedOf(scored: Scored[], cue: Cue, consequence?: { cls: ActionClass; ids: string[] }): Set<string> {
    if (!consequence || consequence.ids.length === 0) return new Set();
    const ids = new Set(consequence.ids);
    const ties = classTies(consequence.cls);
    return new Set(
      scored
        .filter(
          (x) =>
            ids.has(x.item.id) &&
            !unmeasuredLimit(this.frame(cue), x.item) &&
            this.verdict(x.item, cue, ties) === "conflict",
        )
        .map((x) => x.item.id),
    );
  }

  /** The sources whose synced copy is current (`sync`, D57), which answer from the local index; null when none. */
  private localOf(s: Session, all: readonly Source[], behind = false): Set<string> | null {
    if (!this.sync) return null;
    const now = this.now();
    // `behind`: a warm copy answers while its poll runs (`syncPollBehind`), never one still in its backfill.
    const ok = (id: string) => this.sync!.current(s.scope, id, now) || (behind && this.sync!.isWarm(s.scope, id));
    const local = new Set(all.filter((x) => ok(x.id)).map((x) => x.id));
    return local.size > 0 ? local : null;
  }

  // ── anticipation (`anticipate`, `anticipate.ts`) ──

  /**
   * Reads an event for what the agent will need next and prefetches it in the background (`prefetch`). One prefetch
   * per session at a time: an event arriving meanwhile waits, and a later one replaces it (the newest is what the
   * next request will be closest to). Never throws and never blocks the event.
   */
  private anticipate(s: Session, kind: string, text: string, at: number, lookup: boolean): void {
    const ant = (s.ant ??= { calls: 0, running: null, queued: null, prefetched: new Set(), asked: new Set() });
    if (s.closed || ant.calls >= this.config.anticipateSessionCalls) return;
    if (ant.running) {
      ant.queued = { kind, text, at, lookup };
      return;
    }
    const spans = this.spans;
    const sp = spans?.open("anticipate.prefetch", 0, { async: true, event: kind });
    ant.running = this.prefetch(s, ant, kind, text, at, lookup, sp?.id)
      .catch(() => {})
      .finally(() => {
        if (sp) spans!.close(sp, { session: s.id, calls: ant.calls });
        ant.running = null;
        const next = ant.queued;
        ant.queued = null;
        if (next && !s.closed) this.anticipate(s, next.kind, next.text, next.at, next.lookup);
      });
  }

  /**
   * One event's prefetch: the names it mentions and the days it schedules, as the request's own probes would send
   * them (person, organisation and day probes, through `probe`, so their answers land in the user's probe memo and
   * economy), the names the user's history says follow its intent, and its action class's constraint vocabulary.
   * A request's own names and days are left to its lookup. At most `anticipateCalls` calls (the class query, one
   * call to one source, on top), and `anticipateSessionCalls` for the session.
   */
  private async prefetch(
    s: Session,
    ant: Anticipation,
    kind: string,
    text: string,
    at: number,
    lookup: boolean,
    span?: number,
  ): Promise<void> {
    const off = this.config.anticipateOff;
    const offset = this.deps.cache.offsetOf(s.scope);
    const p = predict(text, at, offset, kind === "external");
    const fresh = (key: string) => !ant.asked.has(key);
    // The user's own name is on everything of theirs: never a need. A tool's output names whoever its items do (the
    // senders, a signature's colleagues, a company): only people the user's items have as parties are worth a call.
    const self = this.deps.cache.selfOf(s.scope)?.toLowerCase();
    const tool = kind === "tool_call" || kind === "tool_result";
    const names =
      lookup || off.includes("names")
        ? []
        : p.names.filter(
            (n) =>
              fresh(`n:${n.toLowerCase()}`) &&
              n.toLowerCase() !== self &&
              (!tool || this.deps.cache.isPerson(s.scope, n)),
          );
    if (!off.includes("learn")) {
      for (const n of this.patterns.follows(s.scope, p.intent, 1, this.now())) {
        if (names.length < PREDICT_NAMES && fresh(`n:${n.toLowerCase()}`) && !names.includes(n)) names.push(n);
      }
    }
    const days = lookup || off.includes("days") ? [] : p.days.filter((d) => fresh(`d:${d}`));
    // A class's vocabulary once per session: the draft and the message it becomes are one action.
    const cls = off.includes("class") || !p.cls || !fresh(`c:${p.cls.id}`) ? null : p.cls;
    if (names.length === 0 && days.length === 0 && !cls) return;
    const all = await this.deps.sources(s.scope).catch((): Source[] => []);
    if (all.length === 0 || s.closed) return;
    this.markAsked(ant, [
      ...names.map((n) => `n:${n.toLowerCase()}`),
      ...days.map((d) => `d:${d}`),
      ...(cls ? [`c:${cls.id}`] : []),
    ]);
    // A cue of the event's head, with only the names and days still to fetch: `probe` sends what a request with them
    // would, so the request's own probes later find the same queries answered.
    const cue = buildCue(p.head, distinctTermIds(p.head, s.vocab), s.vocab, at, offset, true);
    cue.entities = names;
    // Its probes are the `anticipate.prefetch` span's children: they reach the session through it (D56).
    if (span !== undefined) cue.span = span;
    if (days.length === 0) cue.time = null;
    else if (cue.time) cue.time = { ...cue.time, days: new Set(days) };
    // Only the class's query ranks sources by the lookup's routing; routing draws from the source map's sampler, so
    // it is not consulted for nothing.
    const found = cls ? this.routed(s, cue, all, this.config.lookupSources) : [];
    const out: ProbeOut = { calls: 0, kept: [] };
    const left = this.config.anticipateSessionCalls - ant.calls;
    // A draft's names are the request's own, probed early: the request's probe budget. Any other event's are a guess.
    const budget = kind === "draft" ? this.config.probeCalls : this.config.anticipateCalls;
    await this.probe(
      s,
      cue,
      found,
      all,
      false,
      out,
      Promise.resolve(),
      this.config.probeShare ? new Map() : undefined,
      { budget: Math.min(budget, left), cls, noTopic: true, local: this.localOf(s, all) },
    );
    // The session ended while the probes ran: nothing of it is learned or traced after its end (D17).
    if (s.closed) return;
    ant.calls += out.calls;
    for (const id of [...out.kept, ...(out.consequence?.ids ?? [])]) {
      ant.prefetched.delete(id);
      ant.prefetched.add(id);
    }
    while (ant.prefetched.size > MAX_PREFETCHED) ant.prefetched.delete(ant.prefetched.values().next().value!);
    this.trace({
      sessionId: s.id,
      turn: s.turn,
      event: kind,
      decision: "skipped",
      reason: "anticipate",
      latencyMs: 0,
      sourceCalls: 0,
      modelCalls: 0,
      costUsd: 0,
      itemIds: [],
      anticipateCalls: out.calls,
    });
  }

  /**
   * Puts into a lookup's shared calls (`SharedCalls`, `probeShare`) the answers a source gave this user's prefetch
   * for the request's names, while recent (within `probeMemoMs`) and still wholly cached: the planner's query for a
   * name is then answered at no call, as the probe's is.
   */
  private seedShared(s: Session, shared: SharedCalls, cue: Cue, all: Source[]): void {
    const now = this.now();
    for (const name of cue.entities.slice(0, 2)) {
      const asked = `${name}|`;
      for (const source of all) {
        const at = this.economy.askedAt(s.scope, source.id, asked);
        if (at === null || now - at > this.config.probeMemoMs) continue;
        const last = this.economy.lastIds(s.scope, source.id, asked);
        const held = last ? this.deps.cache.hits(s.scope, last, now) : [];
        if (!last || held.length < last.length) continue;
        const key = sharedKey(source.id, { scope: s.scope, text: name, entities: [name], limit: 8 });
        if (!shared.has(key)) shared.set(key, Promise.resolve(held.map((h) => h.item)));
      }
    }
  }

  /** Notes names ("n:…"), days ("d:…") and classes ("c:…") as fetched for the session (bounded: `MAX_ASKED`). */
  private markAsked(ant: Anticipation, keys: readonly string[]): void {
    for (const k of keys) {
      ant.asked.delete(k);
      ant.asked.add(k);
    }
    while (ant.asked.size > MAX_ASKED) ant.asked.delete(ant.asked.values().next().value!);
  }

  /** `early`, under an `anticipate.early` span when spans are on (its probes are that span's children). */
  private async tracedEarly(s: Session, cue: Cue, eventKind: string, t0: number): Promise<Injection | null> {
    const spans = this.spans;
    if (!spans) return this.early(s, cue, eventKind, t0);
    const sp = spans.open("anticipate.early", cue.span, { async: true });
    let injection: Injection | null = null;
    try {
      injection = await this.early(s, { ...cue, span: sp.id }, eventKind, t0);
      return injection;
    } finally {
      spans.close(sp, { delivered: injection !== null });
    }
  }

  /**
   * The request decided from what is held, with no call and no model (`anticipate`): the economy's last answers for
   * its names and days at every source (which the prefetches warmed), the class's cached finds, and the cache. What is
   * sure is delivered, else what the request's structure grounds (a conflict, a clash, an absence, the event it
   * names). Never the fallback: its best guess among what happens to be held is no better than among what the live
   * search returns. A stale copy is never delivered from here (D40). With a judge, nothing: the slow path decides.
   */
  private async early(s: Session, cue: Cue, eventKind: string, t0: number): Promise<Injection | null> {
    // With a judge, the slow path decides (see the fast path): what is held only makes it faster. A judge behind
    // (`judgeBehind`) decides nothing, so what is held is delivered as with no model.
    if (this.deps.model !== null && !this.config.judgeBehind) return null;
    // The observe call waits on this: a resolver doing I/O (an MCP connect, a token refresh) must not hold it. Past
    // `EARLY_SOURCES_MS` the request goes to the slow path, which waits for the sources as it always has.
    // (A resolver that fails throws here; `observe` reads that as no early answer, as it reads an empty list.)
    const all = await within(this.deps.sources(s.scope), EARLY_SOURCES_MS);
    if (all === null || all.length === 0 || s.closed) return null;
    const out: ProbeOut = { calls: 0, kept: [] };
    if (this.config.probes) {
      const cls = this.config.anticipateOff.includes("class")
        ? null
        : actionClass(cue.raw, isImperative(cue.raw) || cue.external === true);
      // Offline, every source's last answer is read (no routing: it would draw from the source map's sampler).
      await this.probe(s, cue, all, all, false, out, Promise.resolve(), undefined, {
        offline: true,
        cls,
        classOffline: true,
        local: this.localOf(s, all),
      });
    }
    if (s.closed) return null;
    const probed = new Set(out.kept);
    const scored = this.rank(s, cue, { probed: [...out.kept, ...(out.consequence?.ids ?? [])] });
    const bridged = this.bridgedOf(scored, cue, out.consequence);
    const sure = this.confident(scored, cue);
    let items: Scored[] = [];
    let how = "sure";
    if (sure.length > 0) {
      items = sure;
    } else {
      const g = this.grounded(
        s,
        cue,
        this.eligible(scored, cue, probed, bridged),
        eventKind,
        bridged,
        out.consequence?.cls,
      );
      items = g.items;
      how = g.how;
    }
    const stale = items.length > 0 && this.stale(s, items);
    if (this.deps.onCandidates) {
      const facts = this.factsOf(s, cue, scored, eventKind, { probed, bridged });
      this.dump(s, "early", facts, stale ? [] : items, items.length > 0 && !stale ? how : "");
    }
    if (items.length === 0 || stale) return null;
    const ids = items.map((x) => x.item.id);
    this.trace({
      sessionId: s.id,
      turn: s.turn,
      event: eventKind,
      decision: "fast",
      reason: `anticipated-${how}`,
      latencyMs: Math.round(performance.now() - t0),
      sourceCalls: 0,
      modelCalls: 0,
      costUsd: 0,
      itemIds: ids,
      ...this.prefetchedOf(s, ids),
    });
    return this.deliver(s, items, "proactive", `anticipated-${how}:${cue.id}`, cue);
  }

  /**
   * The options a lookup's own probes run with under `anticipate`: they first wait (at most `probeGraceMs`) for the
   * session's running prefetch, whose answers they would otherwise ask again, and read the request's action class
   * from what the prefetches cached, with no call (unless `consequenceProbe` sends it live).
   */
  private lookupOpts(s: Session, cue: Cue): ProbeOpts {
    if (!this.config.anticipate) return {};
    const cls =
      this.config.consequenceProbe || this.config.anticipateOff.includes("class")
        ? undefined
        : actionClass(cue.raw, isImperative(cue.raw) || cue.external === true);
    return {
      ...(cls !== undefined ? { cls, classOffline: true } : {}),
      ...(s.ant?.running ? { after: s.ant.running } : {}),
    };
  }

  /** The delivered ids the session's anticipation had fetched or held ready (`Trace.prefetched`); {} when none. */
  private prefetchedOf(s: Session, ids: readonly string[]): Partial<Trace> {
    const pre = s.ant?.prefetched;
    if (!pre || pre.size === 0) return {};
    const hit = ids.filter((id) => pre.has(id));
    return hit.length > 0 ? { prefetched: hit } : {};
  }

  /**
   * Learns what followed the request's intent (`IntentPatterns`): the names in the titles of what was delivered for
   * it, other than those it named itself. Its action class, else its situation.
   */
  private learnFollows(s: Session, cue: Cue, scored: Scored[]): void {
    const own = new Set(cue.entities.map((e) => e.toLowerCase()));
    const intent = actionClass(cue.raw, isImperative(cue.raw) || cue.external === true)?.id ?? s.situation;
    for (const x of scored) {
      const names = cleanEntities(extractEntities(x.item.title.slice(0, 200)))
        .filter((n) => !own.has(n.toLowerCase()))
        .slice(0, 2);
      this.patterns.note(s.scope, intent, names, [x.item.sourceId], this.now());
    }
  }

  /** The sources the source map ranks first for a cue's names and the session's situation. */
  private routed(s: Session, cue: Cue, all: Source[], limit: number): Source[] {
    return this.deps.sourceMap
      .route({ scope: s.scope, entities: cue.entities, situation: s.situation, sourceIds: all.map((x) => x.id), limit })
      .map((r) => all.find((x) => x.id === r.sourceId)!)
      .filter(Boolean);
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
      this.trace({
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
        ...this.prefetchedOf(
          s,
          items.map((i) => i.id),
        ),
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
      sourceCalls += await this.refresh(s, cue);
      if (s.closed) return null;
      const spans = this.spans;
      // This lookup's probe finds, its own (never another turn's or a concurrent ask's).
      const consIds = new Set(consequence?.ids ?? []);
      // With `graph`: what the user's knowledge graph reaches from the request, after the lookup's items are cached.
      const walking = this.config.graph ? spans?.open("graph.walk", cue.span) : undefined;
      const walked = this.config.graph ? this.walkGraph(s, cue) : new Map<string, Walked>();
      if (walking) spans!.close(walking, { reached: walked.size });
      // `cards`: cached items whose implication card bears on the request's actions (no model, no call).
      const carding = this.config.cards && this.deps.cards ? spans?.open("cards.match", cue.span) : undefined;
      const carded = this.cardFinds(s, cue);
      if (carding) spans!.close(carding, { found: carded.size });
      const extra = [...consIds, ...carded.keys()];
      const ranking = spans?.open("rank", cue.span);
      const scored = this.rank(s, cue, {
        probed: extra.length > 0 ? [...(probedIds ?? []), ...extra] : probedIds,
        ...(walked.size > 0 ? { walked: [...walked.keys()] } : {}),
      });
      if (ranking) spans!.close(ranking, { candidates: scored.length });
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
      const sure = this.confident(walked.size > 0 ? scored.filter((x) => !x.walkedOnly) : scored, cue);
      if (confiding) spans!.close(confiding, { sure: sure.length });
      const probedSet = new Set(probedIds ?? []);
      const factsNow = () =>
        this.factsOf(s, cue, scored, eventKind, { probed: probedSet, bridged, walked, carded: carded });
      // The rule paths decide when no model does: with none, or with `judgeBehind`, whose lookup decides as with none
      // and leaves the judge only what that answer left out.
      const noModelSay = !this.deps.model || this.config.judgeBehind;
      const dumped = (path: CandidateDump["path"], items: readonly Scored[], how: string) => {
        if (this.deps.onCandidates && noModelSay) this.dump(s, path, factsNow(), items, how);
      };
      // `decideConflict` (D67, docs/research/econ-decide.md), with no model's say: whatever path spoke first, or none,
      // the best conflict among every ranked candidate joins the delivery while it has room (`maxItemsPerInjection`):
      // it never displaces what a rule path chose. The same pass runs on `syncPollBehind`'s follow-up lookup (a
      // `served` lookup), so a fresh item the request breaks reaches the agent without its asking.
      const extend = (items: Scored[]): { items: Scored[]; how: string } => {
        if (!noModelSay || !this.config.decideConflict || items.length >= this.max()) return { items, how: "" };
        const pool = scored.slice(0, this.config.decideCandidates).filter((x) => !bulkMail(x.item));
        const { hits, best } = this.conflicts(
          cue,
          pool.filter((x) => !x.walkedOnly),
          this.acts(s, cue, eventKind),
          bridged,
          consequence?.cls,
          walked,
          pool.filter((x) => walked.has(x.item.id)),
        );
        const frame = this.frame(cue);
        const x = [...hits, ...best].find(
          (x) => !items.includes(x) && !settled(x.item) && !unmeasuredLimit(frame, x.item),
        );
        return x ? { items: [...items, x], how: "conflict" } : { items, how: "" };
      };
      const tagged = (reason: string, how: string) => (how ? `${reason}+decide-${how}` : reason);
      // `anticipate`: the request was answered from what was held (`early`). The live search adds only what is sure,
      // or with no model what the request's structure grounds: never the fallback's best guess or a judge call, which
      // would have had that delivery among their candidates.
      if (served) {
        const ruled =
          this.deps.model && !this.config.judgeBehind
            ? []
            : sure.length > 0
              ? sure
              : this.grounded(
                  s,
                  cue,
                  this.eligible(scored, cue, new Set(probedIds ?? []), bridged, carded),
                  eventKind,
                  bridged,
                  consequence?.cls,
                  walked,
                  walked.size > 0 ? scored.filter((x) => walked.has(x.item.id)) : [],
                  carded,
                ).items;
        const { items, how } = extend(ruled);
        dumped(
          "served",
          items,
          items.length > 0 ? (ruled.length === 0 ? "" : sure.length > 0 ? "sure" : "grounded") : "",
        );
        // `judgeBehind`: the judge reads the best of the rest after this answer, and may only add to it.
        if (this.deps.model && this.config.judgeBehind) {
          const rest = this.eligible(scored, cue, new Set(probedIds ?? []), bridged, carded)
            .filter((x) => !items.includes(x))
            .slice(0, this.config.judgeCandidates);
          this.judgeLater(s, cue, t0, eventKind, rest);
        }
        if (items.length === 0) {
          done("silent", "anticipated");
          return null;
        }
        done(
          "sources",
          tagged(`after-anticipated:${cue.id}`, how),
          items.map((x) => x.item),
        );
        return this.deliver(s, items, "proactive", tagged(`sources`, how) + `:${cue.id}`, cue);
      }
      // With `judgeConfident` and a judge to ask, what scores as sure is judged with the rest in the same call: the
      // no-model bar is right about half the time (docs/research/probes.md), the judge more often.
      // One sure item both the request's search and a probe found is corroborated: delivered without the call
      // (`judgeAgreed` false).
      const both = agreed(new Set(probedIds ?? []), lookedIds);
      const corroborated = !this.config.judgeAgreed && sure.length === 1 && both.has(sure[0]!.item.id);
      // `judgeContested`: only when more than one item scored as sure (which is meant is then the judge's call).
      const contested = this.config.judgeContested && sure.length > 1;
      const judgeSure =
        (this.config.judgeConfident || contested) &&
        this.deps.model !== null &&
        !this.config.judgeBehind &&
        sure.length > 0 &&
        !corroborated;
      if (sure.length > 0 && !judgeSure) {
        const { items, how } = extend(sure);
        dumped("lookup", items, "sure");
        done(
          "sources",
          tagged(cue.id, how),
          items.map((x) => x.item),
        );
        return this.deliver(s, items, "proactive", tagged(`sources`, how) + `:${cue.id}`, cue);
      }
      // An event on a day the request names is a candidate whatever it scores on words (D44).
      const onNamedDay = (x: Scored) => cue.time?.days.has(startDay(x.item) ?? "") === true;
      const probed = new Set(probedIds ?? []);
      const eligible = this.eligible(scored, cue, probed, bridged, carded);
      // The walk's finds (`graph`), whatever they score on words: they get seats and the graph's conflict ground,
      // and no other path (what every other path reads stays as it was without the graph).
      const graphPool = walked.size > 0 ? scored.filter((x) => walked.has(x.item.id)) : [];
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
      const seats = [...cardSeat, ...probeSeats];
      // With `graph`, the walk's best finds the judge would not otherwise see take seats of their own.
      const graphSeats = graphPool
        .filter((x) => !top.includes(x) && !seats.includes(x))
        .sort((a, b) => walked.get(b.item.id)!.score - walked.get(a.item.id)!.score)
        .slice(0, this.config.graphSeats);
      const unsure = [...top, ...seats, ...graphSeats];
      // A probe that brought in what is seated for the judge did its part, whatever the judge then makes of it: the
      // judge rules on relevance, the probe only on finding (`probeYield`).
      if (this.config.probeYield && !s.closed) {
        this.economy.reached(
          s.scope,
          unsure.map((x) => x.item.id),
        );
      }
      if (unsure.length === 0) {
        const { items, how } = extend([]);
        dumped("lookup", items, "");
        if (items.length > 0) {
          done(
            "sources",
            `decide-${how}:${cue.id}`,
            items.map((x) => x.item),
          );
          return this.deliver(s, items, "proactive", `decide-${how}:${cue.id}`, cue);
        }
        done("silent", "no candidates");
        return null;
      }
      // With no model to judge: what the request's people and days ground first (D44), then D36's fallback.
      const noModel = (why: string, reasonPrefix: string): Injection | null => {
        // What scored as sure is delivered as it would have been with no judge to ask (`judgeConfident`): a failing
        // or unaffordable model is never worse than none (D41).
        if (judgeSure) {
          done(
            "sources",
            `${cue.id}${reasonPrefix}`,
            sure.map((x) => x.item),
          );
          return this.deliver(s, sure, "proactive", `sources:${cue.id}`, cue);
        }
        // `recoverNames`: names the request typed in lowercase ("move my drinks with chen wei"), from the user's own
        // record of names, ground and fall back as typed ones do. Only here: probes and ranking keep the cue as typed.
        const named = this.config.recoverNames ? this.withRecoveredNames(s, cue) : cue;
        // Grounding reads every candidate, not only the judge's few: a day's events rank after every word match.
        const grounding = spans?.open("ground", cue.span, { candidates: eligible.length });
        const grounded = this.grounded(
          s,
          named,
          eligible,
          eventKind,
          bridged,
          consequence?.cls,
          walked,
          graphPool,
          carded,
        );
        if (grounding) spans!.close(grounding, { grounded: grounded.items.length });
        if (grounded.items.length > 0) {
          const { items, how } = extend(grounded.items);
          dumped("lookup", items, `grounded-${grounded.how}`);
          done(
            "sources",
            tagged(`grounded-${grounded.how}`, how) + `${reasonPrefix}:${cue.id}`,
            items.map((x) => x.item),
          );
          return this.deliver(s, items, "proactive", tagged(`grounded-${grounded.how}`, how) + `:${cue.id}`, cue);
        }
        const falling = spans?.open("fallback", cue.span);
        const top = this.fallback(unsure, this.config.fallbackAgree ? agreed(probed, lookedIds) : undefined, named);
        if (falling) spans!.close(falling, { picked: top !== null });
        const { items, how } = extend(top ? [top] : []);
        dumped("lookup", items, top ? "fallback" : "");
        if (items.length > 0) {
          const reason = top ? tagged("fallback", how) : `decide-${how}`;
          done(
            "sources",
            `${reason}${reasonPrefix}:${cue.id}`,
            items.map((x) => x.item),
          );
          return this.deliver(s, items, "proactive", `${reason}:${cue.id}`, cue);
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
          walked.has(x.item.id) ||
          carded.get(x.item.id)?.violated === true ||
          onNamedDay(x) ||
          x.matched >= 2 ||
          this.holdsAny(s, x, rare);
      // `judgeBehind`: the lookup decides as with no model and answers now; the judge then reads the candidates that
      // answer left out, and what it picks is queued for the agent's next turn. It only adds, never holds back.
      if (this.deps.model && this.config.judgeBehind) {
        const now = noModel("judge behind", "");
        const given = new Set(now?.citations.map((c) => c.itemId) ?? []);
        const rest = unsure.filter((x) => !given.has(x.item.id));
        if (!this.config.judgeTied || rest.some(tiedBy(this.rareTerms(s, cue)))) {
          this.judgeLater(s, cue, t0, eventKind, rest);
        }
        return now;
      }
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
      return this.deliver(s, picked, "proactive", `model:${cue.id}`, cue);
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
   * The request's words (cue and entities, stopwords out) that fewer than `judgeTiedShare` of the user's items hold:
   * a name, a reference, a place, rather than words common to their mail. Ids in the user's cache vocabulary; a word
   * no cached item holds has no id and so ties nothing (`judgeTied`).
   */
  /**
   * The request's words for `syncTermProbes`: at least four letters, rare in the user's items (`judgeTiedShare`), not
   * a stopword, a word that only says when, nor part of a name the people probes already send; at most `max`.
   */
  private termProbes(s: Session, cue: Cue, max: number): string[] {
    const vocab = this.deps.cache.peekVocab(s.scope);
    if (!vocab) return [];
    const named = new Set(
      cue.entities.flatMap((e) =>
        e
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 0),
      ),
    );
    const out: string[] = [];
    for (const id of this.rareTerms(s, cue)) {
      const w = vocab.term(id);
      if (w.length < 4 || named.has(w) || TIME_WORD.test(w) || out.includes(w)) continue;
      out.push(w);
      if (out.length >= max) break;
    }
    return out;
  }

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
  ): Injection {
    const spans = this.spans;
    const sp = spans?.open("deliver", cue.span, { items: scored.length });
    const injection = this.build(s, scored, mode, reason, cue, sp?.id ?? 0, shown);
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
    if (this.config.anticipate && mode === "proactive" && !this.config.anticipateOff.includes("learn")) {
      this.learnFollows(s, cue, scored);
    }
    // Every item counts as delivered, an echo folded out of the packet too: the agent has its occurrence.
    s.ledger.mark(
      scored.map((x) => x.item.id),
      s.turn,
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
    const injection: Injection = {
      ...s.scope,
      id: newId("inj", this.now()),
      sessionId: s.id,
      mode,
      text: renderPacket(items, {
        maxBytes: this.config.maxInjectionBytes,
        ...(this.config.compactInjection
          ? {
              focus: focusOf(cue),
              itemBytes: this.config.compactItemBytes,
              year: new Date(this.now()).getUTCFullYear(),
              self,
              dense,
              // A word the session has seen: a part with nothing else the agent has (`compactText`).
              ...(this.config.compactNovel ? { known: (w: string) => s.seen.has(s.vocab.lookup(w)) } : {}),
            }
          : {}),
        ...(this.config.packetDates ? { keepYear: true, when: true } : {}),
      }),
      citations: citationsOf(items),
      reason,
      score: Math.max(...scored.map((x) => x.score)),
      createdAt: this.now(),
    };
    if (rendering) spans!.close(rendering);
    const walks = WALKS.get(cue);
    let graphMask = 0;
    for (const x of scored) graphMask |= walks?.get(x.item.id)?.mask ?? 0;
    this.built.set(injection, {
      graphMask,
      sourceIds: [...new Set(items.map((i) => i.sourceId))],
      items: items.map((i) => ({ sourceId: i.sourceId, id: i.id })),
      // Only the words the agent received: an item's text past the packet's cut is not evidence of use. Nor are the
      // dates `packetDates` says whole: usage learns from the same words as without the flag.
      text: this.config.packetDates
        ? withoutAddedDates(
            shownText(shown ?? injection.text),
            this.config.compactInjection && shown === undefined ? new Date(this.now()).getUTCFullYear() : undefined,
          )
        : shownText(shown ?? injection.text),
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

  private trace(t: Trace): void {
    try {
      this.deps.onTrace?.(t);
    } catch {
      // A broken sink never breaks a delivery.
    }
  }
}

const NO_TERMS = new Uint32Array(0);

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
/** How long anticipation's early decision waits for the source resolver (ms): an answer held, or none at once. */
const EARLY_SOURCES_MS = 5;

/**
 * `p`'s value if it settles within `ms`, else null (it runs on; a rejection after the bound is swallowed). Not an
 * async function: an answer already in settles as soon as awaiting `p` itself would, so the early decision keeps its
 * place among the session's other work (the prefetch it races with).
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

/** Fan-out outcomes with no call to the source behind them. */
const SKIPPED = new Set<string>(["busy", "limited", "open", "cached"]);

/** Ids both a lookup's own search and its probes found. */
function agreed(probed: ReadonlySet<string>, looked: readonly string[] | undefined): Set<string> {
  return new Set((looked ?? []).filter((id) => probed.has(id)));
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
  for (let i = s.agentHas.length - 1; i >= 0 && s.agentHas[i]!.terms.size <= room; i--) {
    const held = s.agentHas[i]!;
    room -= held.terms.size;
    const pairs = new Set(
      Array.from(held.pairs, (p) => pairKey(remap(Math.floor(p / PAIR_BASE)), remap(p % PAIR_BASE))),
    );
    agentHas.unshift({ terms: new Set(Array.from(held.terms, remap)), pairs });
  }
  s.agentHas = agentHas;
  s.vocab = vocab;
  s.seen = seen;
}

const sessionKey = (e: Scope & { sessionId: string }) => `${scopeKey(e)}#${e.sessionId}`;

/** An opaque per-user key for provider sticky routing (prompt-cache reuse): a hash, never the ids themselves. */
const userCacheKey = (scope: Scope) =>
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

/** What one agent-held event holds: its terms and its adjacent term pairs (`pairKey`), in session ids. */
interface Held {
  terms: Set<number>;
  pairs: Set<number>;
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
  const { ids, n } = termIds(text.slice(0, HELD_CHARS), vocab, false);
  const terms = new Set<number>();
  const pairs = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (!terms.has(ids[i]!) && terms.size === MAX_HELD_TERMS) break;
    terms.add(ids[i]!);
    if (i > 0) pairs.add(pairKey(ids[i - 1]!, ids[i]!));
  }
  return { terms, pairs };
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

/**
 * Whether an item looks like bulk mail. Such items are never pushed without a model: their words overlap with real
 * work, and one arriving says nothing about the user's need. The judge still sees them, and an ask still finds them.
 */
function bulkMail(item: ContextItem): boolean {
  const category = item.meta?.category;
  return (category !== undefined && BULK_CATEGORY.test(category)) || BULK_TITLE.test(item.title);
}
