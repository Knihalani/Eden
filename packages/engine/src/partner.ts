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
import type { Budget, Model } from "@eden/llm";
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
import { sanitizeForStore } from "@eden/redact";
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
import { Ledger } from "./ledger";
import { citationsOf, renderAnswer, renderPacket } from "./render";
import { classifySituation } from "./situation";
import {
  contentTermsOf,
  distinctTermIds,
  extractEntities,
  extractTypedEntities,
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
  /** The last lookup's planner outcomes, for its trace (shape names and counts only). */
  plans?: Trace["plans"];
  /** The planner's shadow lookup in flight, if any (shadow mode). */
  shadowing?: Promise<void>;
}

interface Cue {
  text: string;
  entities: string[];
  key: string;
  /** A content-free id for the cue, for traces and injection reasons. */
  id: string;
}

interface Scored {
  item: ContextItem;
  score: number;
  matched: number;
  sketch: Sketch | null;
}

/** What an injection was built from, kept until it is handed out and usage tracking starts. */
interface Built {
  sourceIds: string[];
  text: string;
}

/** Outcomes kept per user for later correction, and users kept. Outlives sessions: feedback often comes at the end. */
const MAX_RECORDED = 200;
const MAX_RECORDED_USERS = 10_000;

export class ContextPartner {
  readonly config: EngineConfig;
  private readonly sessions = new Map<string, Session>();
  private readonly perTenant = new Map<string, number>();
  private readonly built = new WeakMap<Injection, Built>();
  private readonly recorded = new Map<string, Map<string, Recorded>>();
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
    const cue = buildCue(text, terms, s.vocab);
    const last = s.cues.get(cue.key);
    if (last !== undefined && s.turn - last < this.config.cueCooldownTurns) {
      trace("repeat", cue.id);
      return reply(queued);
    }

    const fast = this.confident(this.rank(s, cue));
    if (fast.length > 0) {
      this.markCue(s, cue);
      const injection = this.deliver(s, fast, "proactive", `cache:${cue.id}`);
      trace("fast", cue.id, { itemIds: fast.map((x) => x.item.id) });
      if (queued) s.pending.unshift(queued);
      return reply(injection);
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
    const question = sanitizeForStore(request.question);
    const cue = buildCue(question, distinctTermIds(question, s.vocab), s.vocab);
    const limit = request.maxItems ?? 5;
    const sourceCalls = await this.searchLive(s, cue, this.config.askSources);
    const items = this.rank(s, cue, { ignoreLedger: true })
      .filter((x) => x.score >= this.config.candidateScore)
      .slice(0, limit)
      .map((x) => x.item);
    let answer = items.length ? renderPacket(items, { maxBytes: 4_000 }) : "Nothing in the connected sources.";
    let usedModel = false;
    let costUsd = 0;
    if (items.length && this.deps.model && !s.closed && this.charge(s)) {
      try {
        const res = await this.deps.model.chat({
          messages: answerMessages(question, s.window.join("\n"), items),
          maxTokens: 300,
          cacheKey: userCacheKey(s.scope),
          signal: s.abort.signal,
        });
        this.settle(s, res.costUsd);
        if (res.text.trim()) answer = renderAnswer(res.text);
        usedModel = true;
        costUsd = res.costUsd;
      } catch {
        this.settle(s, 0);
      }
    }
    if (items.length && !s.closed) {
      const injection = this.deliver(
        s,
        items.map((item) => ({ item, score: 1, matched: 0, sketch: null })),
        "answer",
        "ask",
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
      ...(s.plans ? { plans: s.plans } : {}),
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
    const r = this.recorded.get(scopeKey(scope))?.get(f.injectionId);
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
    this.recorded.delete(key);
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
    if (this.recorded.get(scopeKey(s.scope))?.has(injection.id)) return;
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
    const mine = this.recorded.get(key) ?? new Map<string, Recorded>();
    this.recorded.delete(key); // Re-insert: Map order is least recently recorded user first.
    this.recorded.set(key, mine);
    mine.set(injectionId, { sourceIds, situation, used });
    while (mine.size > MAX_RECORDED) mine.delete(mine.keys().next().value as string);
    while (this.recorded.size > MAX_RECORDED_USERS) this.recorded.delete(this.recorded.keys().next().value as string);
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
    if (query.length === 0) return [];
    const entities = cue.entities.map((e) => {
      // An entity with a term no cached item holds matches nothing (never intern it: that grows the cache's vocab).
      const all = termIds(e, s.vocab, true).n;
      const t = termIds(e, vocab, false);
      return t.n === all ? Array.from(t.ids.subarray(0, t.n)) : [];
    });
    return (
      cache
        .search(s.scope, query, query.length, 12, this.now())
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
        .filter((x, i, all) => !all.slice(0, i).some((y) => nearDuplicate(x.sketch, y.sketch)))
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

  /** Routes, searches the chosen sources live, caches what they return and records which entities they hold. */
  private async searchLive(s: Session, cue: Cue, limit: number): Promise<number> {
    s.plans = undefined; // A trace reports this lookup's plans, never an earlier one's.
    const all = await this.deps.sources(s.scope).catch((): Source[] => []);
    if (all.length === 0 || s.closed) return 0;
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
    // The fan-out's deadline for this lookup, so the planner's cascade sends only the calls that can still answer.
    const deadlineAt = performance.now() + this.config.sourceTimeoutMs;
    const chosen = planner
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
      : found;
    const outcomes = await this.fanout.search(
      chosen,
      { scope: s.scope, text: cue.text, entities: cue.entities, limit: 8 },
      { timeoutMs: this.config.sourceTimeoutMs, signal: s.abort.signal },
    );
    s.plans = planner
      ? chosen.flatMap((x) => {
          const last = (x as PlannedSource).last;
          return last ? [{ sourceId: x.id, shapes: last.shapes, calls: last.calls, found: last.found }] : [];
        })
      : undefined;
    if (s.closed) return chosen.length; // Forgotten or ended mid-search: keep nothing.
    // One shadow lookup per session at a time: shadowing must not pile up work behind a slow connector.
    if (this.deps.planner?.mode === "shadow" && !s.shadowing) {
      s.shadowing = this.shadowLookup(s, found, cue, outcomes).finally(() => (s.shadowing = undefined));
    }
    for (let k = 0; k < outcomes.length; k++) {
      const o = outcomes[k]!;
      // One source's items at a time, yielding between: storing a lookup's items (tokenizing, indexing, sketching) is
      // ~80 µs each, and other users' events should not wait behind all of them at once.
      if (k > 0) await yieldToLoop();
      if (s.closed) return chosen.length;
      // Mentions are recorded for items new to the cache or changed, so an item many lookups return is not counted
      // each time (that let one item dominate routing, and was ~10% of server CPU). They are written with the put,
      // before the next yield: a session closing in between must not leave items cached whose mentions never land.
      const added = this.deps.cache.put(s.scope, o.items, this.now(), true);
      const mentions = added.map((item) => ({
        sourceId: item.sourceId,
        entities: extractTypedEntities(`${item.title}. ${item.text}`)
          .filter((e) => PERSISTABLE_KINDS.has(e.kind))
          .slice(0, 20)
          .map((e) => e.text),
      }));
      if (mentions.length > 0) this.deps.sourceMap.recordMentionsMany(s.scope, mentions, this.now());
    }
    return chosen.length;
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
        ...(s.plans ? { plans: s.plans } : {}),
      });
    try {
      sourceCalls = await this.searchLive(s, cue, this.config.lookupSources);
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
      const unsure = scored.filter((x) => x.score >= this.config.candidateScore).slice(0, this.config.judgeCandidates);
      if (unsure.length === 0) {
        done("silent", "no candidates");
        return null;
      }
      if (!this.deps.model || !this.charge(s)) {
        const top = this.fallback(unsure);
        if (top) {
          done("sources", `fallback:${cue.id}`, [top.item]);
          return this.deliver(s, [top], "proactive", `fallback:${cue.id}`);
        }
        done("silent", this.deps.model ? "no model budget" : "no model");
        return null;
      }
      const candidates = unsure.map((x) => x.item);
      try {
        const res = await this.deps.model.chat({
          messages: judgeMessages(s.window.join("\n"), candidates),
          cacheKey: userCacheKey(s.scope),
          maxTokens: 60,
          json: true,
          signal: s.abort.signal,
        });
        modelCalls = 1;
        costUsd = res.costUsd;
        this.settle(s, res.costUsd);
        if (s.closed) return null;
        const picked = parseJudge(res.text, candidates.length)
          .slice(0, this.config.maxItemsPerInjection)
          .map((i) => unsure[i]!);
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
        this.settle(s, 0);
        done("silent", "model error");
        return null;
      }
    } catch {
      // A failing source map or cache never escapes as an unhandled rejection; the lookup just ends silent.
      done("silent", "error");
      return null;
    }
  }

  private charge(s: Session): boolean {
    return this.deps.budget.charge(scopeKey(s.scope), s.key, this.config.estimatedCallUsd);
  }

  private settle(s: Session, actualUsd: number): void {
    if (s.closed) {
      this.deps.budget.endSession(s.key); // The session ended mid-call: settle nothing, keep no tally for it.
      return;
    }
    this.deps.budget.settle(scopeKey(s.scope), s.key, this.config.estimatedCallUsd, actualUsd);
  }

  private deliver(s: Session, scored: Scored[], mode: InjectionMode, reason: string): Injection {
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
      text: items.map((i) => `${i.title} ${i.text}`).join(" "),
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

/**
 * The first `max` characters of `s`, cut so that redaction (which runs after the cut) still sees every secret whole:
 * the cut drops the whole run it would split, back to whitespace or JSON punctuation (" , { } [ ], which no token or
 * base64 body contains, so minified JSON keeps its head: half a JWT no longer looks like one), and a private key whose
 * END line falls past the cut is dropped from its BEGIN line (alone, the banner is all `redactPem` redacts).
 */
function head(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  while (end > 0 && !isCutPoint(s.charCodeAt(end - 1))) end--;
  let out = s.slice(0, end);
  let begin = -1;
  for (const m of out.matchAll(PEM_BEGIN)) begin = m.index;
  if (begin >= 0 && !PEM_END.test(out.slice(begin))) out = out.slice(0, begin);
  return out;
}

/** Whitespace and the JSON punctuation " , [ ] { }. */
const isCutPoint = (c: number) => c <= 32 || c === 34 || c === 44 || c === 91 || c === 93 || c === 123 || c === 125;

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/i;

/** Proactive lookups start from what the user or the world says, not from the agent's own words. */
function wantsLookup(e: AgentEvent, text: string, terms: Uint32Array, vocab: Vocab): boolean {
  if (e.kind !== "user_message" && e.kind !== "external") return false;
  return !isChatterTerms(text, terms, vocab);
}

function buildCue(text: string, ids: Uint32Array, vocab: Vocab): Cue {
  const entities = extractEntities(text).slice(0, 8);
  const terms = contentTermsOf(ids, vocab).slice(0, 16); // Distinct already.
  const key = (entities.length ? entities.map((e) => e.toLowerCase()) : terms).slice().sort().join("|").slice(0, 200);
  // Traces and reasons carry this id, never the cue itself: the cue is the user's words.
  const id = `cue:${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
  return { text: terms.join(" "), entities, key, id };
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
