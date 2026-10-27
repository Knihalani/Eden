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
import { searchSources, type Source, type SourceResolver } from "@eden/sources";
import type { ItemCache } from "./cache";
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import { answerMessages, judgeMessages, parseJudge } from "./judge";
import { Ledger } from "./ledger";
import { citationsOf, renderAnswer, renderPacket } from "./render";
import { classifySituation } from "./situation";
import {
  contentTerms,
  extractEntities,
  extractTypedEntities,
  isChatter,
  mentions,
  PERSISTABLE_KINDS,
  wordSet,
} from "./text";
import type { Trace, TraceSink } from "./trace";
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
  seen: Set<string>;
  ledger: Ledger;
  /** Injections handed to the agent and not yet judged used or unused. */
  outstanding: Map<string, Outstanding>;
  pending: Injection[];
  cues: Map<string, number>;
  situation: string;
  inflight: Promise<Injection | null> | null;
  abort: AbortController;
  closed: boolean;
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

  constructor(private readonly deps: PartnerDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
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
    const text = sanitizeForStore(eventText(event));
    this.checkUsage(s, event, text);
    this.remember(s, event, text);

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
    if (!wantsLookup(event, text)) {
      trace("skipped", event.kind);
      return reply(queued);
    }
    if (event.kind === "user_message") s.situation = classifySituation(text);
    const cue = buildCue(text);
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
    const cue = buildCue(question);
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
        items.map((item) => ({ item, score: 1, matched: 0 })),
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
      seen: new Set(),
      ledger: new Ledger(this.config.ledgerCooldownTurns),
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
    this.deps.budget.endSession(s.key);
    this.sessions.delete(s.key);
    const n = (this.perTenant.get(s.scope.tenantId) ?? 1) - 1;
    if (n <= 0) this.perTenant.delete(s.scope.tenantId);
    else this.perTenant.set(s.scope.tenantId, n);
  }

  private remember(s: Session, event: AgentEvent, text: string): void {
    if (!text) return;
    s.window.push(`${event.kind}: ${text.slice(0, 1_000)}`);
    if (s.window.length > this.config.windowEvents) s.window.shift();
    for (const t of contentTerms(text)) {
      s.seen.delete(t); // Re-insert so Set order is least recently seen first.
      s.seen.add(t);
    }
    while (s.seen.size > this.config.maxSeenTokens) s.seen.delete(s.seen.values().next().value as string);
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
      tokens: distinctiveTokens(built.text, s.seen),
      deliveredTurn: s.turn,
    });
  }

  private checkUsage(s: Session, event: AgentEvent, text: string): void {
    const actsOnIt = event.kind === "agent_message" || event.kind === "tool_call";
    for (const [id, o] of s.outstanding) {
      const used = actsOnIt && showsUse(text, o.tokens);
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
   * whole words ("Al" never matches "also").
   */
  private rank(s: Session, cue: Cue, options: { ignoreLedger?: boolean } = {}): Scored[] {
    return this.deps.cache
      .search(s.scope, `${cue.text} ${cue.entities.join(" ")}`, 12, this.now())
      .filter((h) => options.ignoreLedger || s.ledger.isFresh(h.item.id, s.turn))
      .map((h) => {
        const words = wordSet(`${h.item.title} ${h.item.text}`);
        const entityHit = cue.entities.some((e) => mentions(words, e));
        return { item: h.item, matched: h.matched, score: h.coverage + (entityHit ? this.config.entityBonus : 0) };
      })
      .sort((a, b) => b.score - a.score);
  }

  private confident(scored: Scored[]): Scored[] {
    return scored
      .filter((x) => x.score >= this.config.confidentScore && x.matched >= this.config.minMatchedTerms)
      .slice(0, this.config.maxItemsPerInjection);
  }

  /** Routes, searches the chosen sources live, caches what they return and records which entities they hold. */
  private async searchLive(s: Session, cue: Cue, limit: number): Promise<number> {
    const all = await this.deps.sources(s.scope).catch((): Source[] => []);
    if (all.length === 0 || s.closed) return 0;
    const ranked = this.deps.sourceMap.route({
      scope: s.scope,
      entities: cue.entities,
      situation: s.situation,
      sourceIds: all.map((x) => x.id),
      limit,
    });
    const chosen = ranked.map((r) => all.find((x) => x.id === r.sourceId)!).filter(Boolean);
    const outcomes = await searchSources(
      chosen,
      { scope: s.scope, text: cue.text, entities: cue.entities, limit: 8 },
      { timeoutMs: this.config.sourceTimeoutMs, signal: s.abort.signal },
    );
    if (s.closed) return chosen.length; // Forgotten or ended mid-search: keep nothing.
    for (const o of outcomes) {
      const stored = this.deps.cache.put(s.scope, o.items, this.now());
      for (const item of stored) {
        const entities = extractTypedEntities(`${item.title}. ${item.text}`)
          .filter((e) => PERSISTABLE_KINDS.has(e.kind))
          .slice(0, 20)
          .map((e) => e.text);
        this.deps.sourceMap.recordMentions(s.scope, item.sourceId, entities, this.now());
      }
    }
    return chosen.length;
  }

  private async slowPath(s: Session, cue: Cue, t0: number, eventKind: string): Promise<Injection | null> {
    let modelCalls = 0;
    let costUsd = 0;
    let sourceCalls = 0;
    const done = (decision: Trace["decision"], reason: string, items: ContextItem[] = []) =>
      this.trace({
        sessionId: s.id,
        turn: s.turn,
        event: eventKind,
        decision,
        reason,
        latencyMs: Math.round(performance.now() - t0),
        sourceCalls,
        modelCalls,
        costUsd,
        itemIds: items.map((i) => i.id),
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
      if (!this.deps.model) {
        done("silent", "no model");
        return null;
      }
      if (!this.charge(s)) {
        done("silent", "no model budget");
        return null;
      }
      const candidates = unsure.map((x) => x.item);
      try {
        const res = await this.deps.model.chat({
          messages: judgeMessages(s.window.join("\n"), candidates),
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

const sessionKey = (e: Scope & { sessionId: string }) => `${scopeKey(e)}#${e.sessionId}`;

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
function wantsLookup(e: AgentEvent, text: string): boolean {
  if (e.kind !== "user_message" && e.kind !== "external") return false;
  return !isChatter(text);
}

function buildCue(text: string): Cue {
  const entities = extractEntities(text).slice(0, 8);
  const terms = [...new Set(contentTerms(text))].slice(0, 16);
  const key = (entities.length ? entities.map((e) => e.toLowerCase()) : terms).slice().sort().join("|").slice(0, 200);
  // Traces and reasons carry this id, never the cue itself: the cue is the user's words.
  const id = `cue:${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
  return { text: terms.join(" "), entities, key, id };
}
