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
  type QueryPlanner,
  type Source,
  type SourceResolver,
} from "@eden/sources";
import { nearDuplicate, sanitizedId, sanitizeItem, type ItemCache, type Sketch } from "./cache";
import { pooledSanitizer } from "./gate";
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import { answerMessages, judgeMessages, parseJudge } from "./judge";
import { namesParticipant, startDay, startMs, timeWindow, titleNames, type TimeWindow } from "./grounding";
import { Ledger } from "./ledger";
import { citationsOf, renderAnswer, renderPacket, shownText } from "./render";
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
}

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
}

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
  /** The request's own (redacted) text, for questions about the calendar itself. */
  raw: string;
  /** The user's UTC offset (minutes) the days were resolved at. */
  offset: number;
}

/**
 * Output caps for the two model calls. Reasoning models (the default GLM among them) spend part of the cap thinking
 * before they answer; at 60 tokens the judge's verdict was cut off most of the time (D45). The caps bound spend, which
 * is billed on tokens used: a verdict is a few tokens plus low-effort reasoning.
 */
const JUDGE_MAX_TOKENS = 512;
const ANSWER_MAX_TOKENS = 1_000;

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
}

/** What an injection was built from, kept until it is handed out and usage tracking starts. */
interface Built {
  sourceIds: string[];
  /** The delivered items, for the planner's delivery credit when the injection is handed out (D39). */
  items: { sourceId: string; id: string }[];
  text: string;
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

  constructor(private readonly deps: PartnerDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
    const maxText = deps.cache.maxTextChars;
    this.fanout = new SourceFanout({
      sanitize: deps.gatePool
        ? pooledSanitizer(deps.gatePool, maxText)
        : (items) => items.map((i) => sanitizeItem(i, maxText)),
      // One clock for the whole engine: rate limits, result freshness and breakers run on the same time as the
      // cache and sessions (an injected clock that skipped the fan-out made simulated time hit real-time limits).
      now: this.now,
    });
  }

  async observe(event: AgentEvent, options: { waitMs?: number } = {}): Promise<ObserveResult> {
    const t0 = performance.now();
    if (event.kind === "session_end") {
      const ended = this.sessions.get(sessionKey(event));
      if (ended) this.close(ended, true);
      return { injection: null, pending: false };
    }
    const s = this.session(event);
    s.turn++;
    if (s.vocab.size > this.config.maxSessionTerms) rebuildVocab(s, this.config.maxSessionTerms);
    const text = sanitizeForStore(head(eventText(event), this.config.maxEventChars));
    const terms = text ? distinctTermIds(text, s.vocab) : NO_TERMS;
    this.checkUsage(s, event, terms);
    this.remember(s, event, text, terms);

    const trace = (decision: Trace["decision"], reason: string, extra: Partial<Trace> = {}) =>
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
    const reply = (injection: Injection | null): ObserveResult => {
      if (injection) this.handOut(s, injection);
      return { injection, pending: s.inflight !== null || s.pending.length > 0 };
    };

    const queued = s.pending.shift() ?? null;
    if (!wantsLookup(event, text, terms, s.vocab)) {
      trace("skipped", event.kind);
      return reply(queued);
    }
    if (event.kind === "user_message") s.situation = classifySituation(text);
    const cue = buildCue(text, terms, s.vocab, event.at, this.deps.cache.offsetOf(s.scope));
    const last = s.cues.get(cue.key);
    const repeat = last !== undefined && s.turn - last < this.config.cueCooldownTurns;

    const fast = this.confident(this.rank(s, cue));
    // A stale cached copy is not delivered from here: the slow path re-reads it first (D40). A cue in cooldown is not
    // looked up again, but the cache may hold something new for it (another question about the same person).
    if (fast.length > 0 && !this.stale(s, fast)) {
      this.markCue(s, cue);
      const injection = this.deliver(s, fast, "proactive", `cache:${cue.id}`);
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
    const queueLater = () => void slow.then((inj) => inj && !s.closed && s.pending.push(inj));
    const waitMs = options.waitMs ?? 0;
    if (queued || waitMs <= 0) {
      queueLater();
      return reply(queued);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), waitMs)));
    const result = await Promise.race([slow, late]);
    clearTimeout(timer);
    if (result === "late") {
      queueLater();
      return reply(null);
    }
    return reply(s.closed ? null : result);
  }

  /** Injections the slow path queued for a session, oldest first. Integrations that poll call this. */
  takePending(ref: Scope & { sessionId: string }): Injection[] {
    const s = this.sessions.get(sessionKey(ref));
    if (!s) return [];
    const out = s.pending.splice(0);
    for (const injection of out) this.handOut(s, injection);
    return out;
  }

  async ask(request: AskRequest): Promise<AskResponse> {
    const t0 = performance.now();
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
    );
    const limit = request.maxItems ?? 5;
    const { calls: sourceCalls, plans } = await this.searchLive(s, cue, this.config.askSources);
    const scored = this.rank(s, cue, { ignoreLedger: true });
    // What the question's people and days ground comes first (D44); a named day's other events only through it, so
    // a question about a topic is not padded with that day's calendar.
    const onDay = (x: Scored) => cue.time?.days.has(startDay(x.item) ?? "") === true;
    const grounded = this.grounded(
      s,
      cue,
      scored.filter((x) => x.score >= this.config.candidateScore || onDay(x)),
      "ask",
    ).items;
    const items = [...grounded, ...scored.filter((x) => x.score >= this.config.candidateScore && !grounded.includes(x))]
      .slice(0, limit)
      .map((x) => x.item);
    let answer = items.length ? renderPacket(items, { maxBytes: 4_000 }) : "Nothing in the connected sources.";
    let usedModel = false;
    let costUsd = 0;
    const reservation =
      this.config.askWithModel && items.length && this.deps.model && !s.closed
        ? this.charge(s, this.config.estimatedAnswerUsd)
        : null;
    if (reservation && this.deps.model) {
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
      } catch {
        this.settle(reservation, 0);
      }
    }
    if (items.length && !s.closed) {
      const injection = this.deliver(
        s,
        items.map((item) => ({ item, score: 1, matched: 0, sketch: null })),
        "answer",
        "ask",
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
    });
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
      this.record(scope, f.injectionId, o.sourceIds, o.situation, f.used);
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
      for (const [id, o] of s.outstanding) this.record(s.scope, id, o.sourceIds, o.situation, false);
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
      this.record(s.scope, id, o.sourceIds, o.situation, used);
    }
  }

  private record(scope: Scope, injectionId: string, sourceIds: string[], situation: string, used: boolean): void {
    for (const sourceId of sourceIds) this.deps.sourceMap.recordOutcome(scope, situation, sourceId, used);
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
  private rank(s: Session, cue: Cue, options: { ignoreLedger?: boolean } = {}): Scored[] {
    const cache = this.deps.cache;
    const vocab = cache.peekVocab(s.scope);
    if (!vocab) return []; // No cache for this user: nothing to rank, and nothing allocated.
    const q = termIds(`${cue.text} ${cue.entities.join(" ")}`, vocab, false);
    const query: number[] = [];
    for (let i = 0; i < q.n; i++) if (!isStopword(vocab.term(q.ids[i]!))) query.push(q.ids[i]!);
    // Events on a day the request names are candidates whether or not they share its words (D44); they rank after
    // every item that does, so the judge, when there is one, sees them only if there is room.
    const timed = cue.time?.days.size ? cache.timed(s.scope, cue.time.days, this.now()) : [];
    if (query.length === 0 && timed.length === 0) return [];
    const entities = cue.entities.map((e) => {
      // An entity with a term no cached item holds matches nothing (never intern it: that grows the cache's vocab).
      const all = termIds(e, s.vocab, true).n;
      const t = termIds(e, vocab, false);
      return t.n === all ? Array.from(t.ids.subarray(0, t.n)) : [];
    });
    const found = query.length > 0 ? cache.search(s.scope, query, query.length, 12, this.now()) : [];
    for (const h of timed) if (!found.some((f) => f.item.id === h.item.id)) found.push(h);
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
          return { item: h.item, matched: h.matched, score, sketch: h.sketch };
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

  private confident(scored: Scored[]): Scored[] {
    return (
      scored
        .filter((x) => x.score >= this.config.confidentScore && x.matched >= this.config.minMatchedTerms)
        // Bulk mail is never pushed without a model's say: a newsletter arriving is no reason to speak.
        .filter((x) => !bulkMail(x.item))
        .slice(0, this.config.maxItemsPerInjection)
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
  private grounded(s: Session, cue: Cue, candidates: Scored[], eventKind: string): { items: Scored[]; how: string } {
    const none = { items: [] as Scored[], how: "" };
    const pool = candidates.filter((x) => !bulkMail(x.item));
    const time = cue.time;
    const onDay = (x: Scored) => time !== null && time.days.has(startDay(x.item) ?? "");
    const upcoming = (x: Scored) => startMs(x.item) >= cue.at;
    const soonest = (a: Scored, b: Scored) => startMs(a.item) - startMs(b.item);
    const acts = eventKind === "external" || eventKind === "ask" || ACTING.has(s.situation) || ACTS_ON.test(cue.raw);
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

  private max(): number {
    return this.config.maxItemsPerInjection;
  }

  /**
   * With no model's say, the best candidate alone, if it is strong enough: several distinct query terms and a score
   * of at least `fallbackScore` (coverage plus the entity bonus, D36). One item at most: nothing has judged it.
   */
  private fallback(unsure: Scored[]): Scored | null {
    const top = unsure[0];
    const c = this.config;
    if (!top || c.fallbackMatchedTerms <= 0 || bulkMail(top.item)) return null;
    return top.matched >= c.fallbackMatchedTerms && top.score >= c.fallbackScore ? top : null;
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
  private async searchLive(s: Session, cue: Cue, limit: number): Promise<{ calls: number; plans?: Trace["plans"] }> {
    const all = await this.deps.sources(s.scope).catch((): Source[] => []);
    if (all.length === 0 || s.closed) return { calls: 0 };
    const ranked = this.deps.sourceMap.route({
      scope: s.scope,
      entities: cue.entities,
      situation: s.situation,
      sourceIds: all.map((x) => x.id),
      limit,
    });
    const found = ranked.map((r) => all.find((x) => x.id === r.sourceId)!).filter(Boolean);
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
    const listers = onlyTime(cue) ? found.filter((x) => x.listsByTime === true) : [];
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
    const chosen =
      planner && !listing
        ? found.map(
            (x) =>
              new PlannedSource(
                x,
                planner,
                () => this.fanout.permit(s.scope, x.id),
                this.fanout.planCalls(x),
                deadlineAt,
              ),
          )
        : listing
          ? listers
          : found;
    const outcomes = await this.fanout.search(
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
    const plans = planner
      ? chosen.flatMap((x) => {
          const last = (x as PlannedSource).last;
          return last ? [{ sourceId: x.id, shapes: last.shapes, calls: last.calls, found: last.found }] : [];
        })
      : undefined;
    const result = { calls: chosen.length, ...(plans ? { plans } : {}) };
    if (s.closed) return result; // Forgotten or ended mid-search: keep nothing.
    // One shadow lookup per session at a time: shadowing must not pile up work behind a slow connector.
    if (this.deps.planner?.mode === "shadow" && !s.shadowing) {
      s.shadowing = this.shadowLookup(s, found, cue, outcomes).finally(() => (s.shadowing = undefined));
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
      this.store(s, o.items);
    }
    return result;
  }

  /** Caches sanitized items and records the entity mentions of those new to the cache or changed. */
  private store(s: Session, items: ContextItem[]): void {
    const added = this.deps.cache.put(s.scope, items, this.now(), true);
    const mentions = added.map((item) => ({
      sourceId: item.sourceId,
      entities: extractTypedEntities(`${item.title}. ${item.text}`)
        .filter((e) => PERSISTABLE_KINDS.has(e.kind))
        .slice(0, 20)
        .map((e) => e.text),
    }));
    if (mentions.length > 0) this.deps.sourceMap.recordMentionsMany(s.scope, mentions, this.now());
  }

  /** Whether any of these cached items was fetched longer ago than `refreshAfterMs` (refreshing on). */
  private stale(s: Session, scored: Scored[]): boolean {
    const after = this.config.refreshAfterMs;
    if (after <= 0) return false;
    const now = this.now();
    return scored.some((x) => now - (this.deps.cache.fetchedAt(s.scope, x.item.id) ?? now) > after);
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
    const now = this.now();
    const stale = this.rank(s, cue)
      .filter((x) => x.score >= c.candidateScore)
      .slice(0, c.judgeCandidates)
      .filter((x) => now - (this.deps.cache.fetchedAt(s.scope, x.item.id) ?? now) > c.refreshAfterMs)
      .slice(0, c.maxRefreshes);
    if (stale.length === 0) return 0;
    const all = await this.deps.sources(s.scope).catch((): Source[] => []);
    const jobs = stale.flatMap((x) => {
      const source = all.find((a) => a.id === x.item.sourceId);
      // A ref the gate redacted, or Eden's own content hash, cannot be asked for again: no call, no rate token.
      const fetchable = !x.item.ref.includes(REDACTED) && !x.item.ref.startsWith("eden-h-");
      return source?.fetch && fetchable ? [{ source, ref: x.item.ref }] : [];
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

  private async slowPath(s: Session, cue: Cue, t0: number, eventKind: string): Promise<Injection | null> {
    // The turn that triggered the lookup. Traces report it, not the turn current when the lookup finishes: later
    // events may arrive meanwhile, and evals attribute deliveries by this field.
    const turn = s.turn;
    let modelCalls = 0;
    let costUsd = 0;
    let sourceCalls = 0;
    let plans: Trace["plans"];
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
      });
    try {
      ({ calls: sourceCalls, plans } = await this.searchLive(s, cue, this.config.lookupSources));
      if (s.closed) return null;
      sourceCalls += await this.refresh(s, cue);
      if (s.closed) return null;
      const scored = this.rank(s, cue);
      const sure = this.confident(scored);
      if (sure.length > 0) {
        done(
          "sources",
          cue.id,
          sure.map((x) => x.item),
        );
        return this.deliver(s, sure, "proactive", `sources:${cue.id}`);
      }
      // An event on a day the request names is a candidate whatever it scores on words (D44).
      const onNamedDay = (x: Scored) => cue.time?.days.has(startDay(x.item) ?? "") === true;
      const eligible = scored.filter((x) => x.score >= this.config.candidateScore || onNamedDay(x));
      const unsure = eligible.slice(0, this.config.judgeCandidates);
      if (unsure.length === 0) {
        done("silent", "no candidates");
        return null;
      }
      // With no model to judge: what the request's people and days ground first (D44), then D36's fallback.
      const noModel = (why: string, reasonPrefix: string): Injection | null => {
        // Grounding reads every candidate, not only the judge's few: a day's events rank after every word match.
        const grounded = this.grounded(s, cue, eligible, eventKind);
        if (grounded.items.length > 0) {
          const items = grounded.items;
          done(
            "sources",
            `grounded-${grounded.how}${reasonPrefix}:${cue.id}`,
            items.map((x) => x.item),
          );
          return this.deliver(s, items, "proactive", `grounded-${grounded.how}:${cue.id}`);
        }
        const top = this.fallback(unsure);
        if (top) {
          done("sources", `fallback${reasonPrefix}:${cue.id}`, [top.item]);
          return this.deliver(s, [top], "proactive", `fallback:${cue.id}`);
        }
        done("silent", why);
        return null;
      };
      const reservation = this.deps.model ? this.charge(s) : null;
      if (!this.deps.model || !reservation) return noModel(this.deps.model ? "no model budget" : "no model", "");
      const candidates = unsure.map((x) => x.item);
      let res: Awaited<ReturnType<Model["chat"]>>;
      try {
        res = await this.deps.model.chat({
          messages: judgeMessages(s.window.join("\n"), candidates),
          cacheKey: userCacheKey(s.scope),
          maxTokens: JUDGE_MAX_TOKENS,
          reasoning: "low",
          json: true,
          signal: s.abort.signal,
        });
      } catch {
        this.settle(reservation, 0);
        if (s.closed) return null;
        // A failing model (bad key, spend limit, outage) is treated as no model, never worse than none (D41). The
        // reason keeps the cause, so a broken key does not look like a healthy keyless server in traces.
        return noModel("model error", ":model-error");
      }
      modelCalls = 1;
      costUsd = res.costUsd;
      this.settle(reservation, res.costUsd);
      if (s.closed) return null;
      const picked = parseJudge(res.text, candidates.length)
        .slice(0, this.config.maxItemsPerInjection)
        .map((i) => unsure[i]!);
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
      return this.deliver(s, picked, "proactive", `model:${cue.id}`);
    } catch {
      // A failing source map or cache never escapes as an unhandled rejection; the lookup just ends silent.
      done("silent", "error");
      return null;
    }
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

  /** `shown` is what the agent receives when it is not the injection's own text (an ask's answer). */
  private deliver(s: Session, scored: Scored[], mode: InjectionMode, reason: string, shown?: string): Injection {
    const items = scored.map((x) => x.item);
    for (const x of scored) if (x.sketch) s.delivered.push(x.sketch);
    if (s.delivered.length > 200) s.delivered.splice(0, s.delivered.length - 200);
    s.ledger.mark(
      items.map((i) => i.id),
      s.turn,
    );
    const injection: Injection = {
      ...s.scope,
      id: newId("inj", this.now()),
      sessionId: s.id,
      mode,
      text: renderPacket(items, { maxBytes: this.config.maxInjectionBytes }),
      citations: citationsOf(items),
      reason,
      score: Math.max(...scored.map((x) => x.score)),
      createdAt: this.now(),
    };
    this.built.set(injection, {
      sourceIds: [...new Set(items.map((i) => i.sourceId))],
      items: items.map((i) => ({ sourceId: i.sourceId, id: i.id })),
      // Only the words the agent received: an item's text past the packet's cut is not evidence of use.
      text: shownText(shown ?? injection.text),
    });
    return injection;
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

/** `offset`: the user's UTC offset in minutes, so "today" is their today (D44). */
function buildCue(text: string, ids: Uint32Array, vocab: Vocab, at: number, offset: number): Cue {
  const entities = extractEntities(text).slice(0, 8);
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
