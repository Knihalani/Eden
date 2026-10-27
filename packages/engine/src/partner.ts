/**
 * The context partner. It runs beside an agent and does two things:
 *
 * - observe: sees each session event and, when the agent likely needs context it does not have, delivers it
 *   unasked (proactive injection). Most events end in silence.
 * - ask: answers the agent's explicit question from the user's sources.
 *
 * Two speeds. The fast path (cue → item cache → score) runs on every event, costs no source call and no model,
 * and delivers only when it is confident. The slow path (route → live source search → maybe one model call) runs in
 * the background; what it finds is queued and delivered at the next event, or returned directly if the caller is
 * willing to wait (`waitMs`). The model is the last resort, rationed by `Budget`, and its default verdict is silence.
 */
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
import { citationsOf, renderPacket } from "./render";
import { classifySituation } from "./situation";
import { contentTerms, extractEntities, isChatter } from "./text";
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

interface Session {
  scope: Scope;
  id: string;
  /** Tenant, user and session: the only key a session's state is ever looked up by. */
  key: string;
  turn: number;
  window: string[];
  seen: Set<string>;
  ledger: Ledger;
  outstanding: Outstanding[];
  pending: Injection[];
  cues: Map<string, number>;
  situation: string;
  inflight: Promise<Injection | null> | null;
}

interface Cue {
  text: string;
  entities: string[];
  key: string;
}

interface Scored {
  item: ContextItem;
  score: number;
}

export class ContextPartner {
  readonly config: EngineConfig;
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;

  constructor(private readonly deps: PartnerDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
  }

  async observe(event: AgentEvent, options: { waitMs?: number } = {}): Promise<ObserveResult> {
    const t0 = performance.now();
    const s = this.session(event);
    if (event.kind === "session_end") {
      this.closeSession(s);
      return { injection: null, pending: false };
    }
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

    const queued = s.pending.shift() ?? null;
    if (!wantsLookup(event, text)) {
      trace("skipped", event.kind);
      return { injection: queued, pending: s.inflight !== null };
    }
    if (event.kind === "user_message") s.situation = classifySituation(text);
    const cue = buildCue(text);
    const last = s.cues.get(cue.key);
    if (last !== undefined && s.turn - last < this.config.cueCooldownTurns) {
      trace("repeat", cue.key);
      return { injection: queued, pending: s.inflight !== null };
    }
    s.cues.set(cue.key, s.turn);

    const fast = this.confident(this.rank(s, cue));
    if (fast.length > 0) {
      const injection = this.deliver(s, fast, "proactive", `cache:${cue.key}`);
      trace("fast", cue.key, { itemIds: fast.map((x) => x.item.id) });
      if (queued) s.pending.unshift(queued);
      return { injection, pending: s.inflight !== null };
    }
    if (queued) return { injection: queued, pending: true }; // Deliver what is ready; look again next event.
    if (s.inflight) {
      trace("silent", "slow path busy");
      return { injection: null, pending: true };
    }

    const slow = this.slowPath(s, cue, t0, event.kind).finally(() => {
      s.inflight = null;
    });
    s.inflight = slow;
    const waitMs = options.waitMs ?? 0;
    if (waitMs <= 0) {
      void slow.then((inj) => inj && s.pending.push(inj));
      return { injection: null, pending: true };
    }
    const timer = new Promise<"late">((r) => setTimeout(() => r("late"), waitMs));
    const result = await Promise.race([slow, timer]);
    if (result === "late") {
      void slow.then((inj) => inj && s.pending.push(inj));
      return { injection: null, pending: true };
    }
    return { injection: result, pending: false };
  }

  /** Injections the slow path queued for a session, oldest first. Integrations that poll call this. */
  takePending(ref: Scope & { sessionId: string }): Injection[] {
    const s = this.sessions.get(sessionKey(ref));
    return s ? s.pending.splice(0) : [];
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
    if (items.length && this.deps.model && this.charge(s)) {
      try {
        const res = await this.deps.model.chat({
          messages: answerMessages(question, s.window.join("\n"), items),
          maxTokens: 300,
        });
        this.deps.budget.settle(scopeKey(s.scope), s.key, this.config.estimatedCallUsd, res.costUsd);
        answer = res.text.trim() || answer;
        usedModel = true;
        costUsd = res.costUsd;
      } catch {
        this.deps.budget.settle(scopeKey(s.scope), s.key, this.config.estimatedCallUsd, 0);
      }
    }
    if (items.length)
      this.deliver(
        s,
        items.map((item) => ({ item, score: 1 })),
        "answer",
        "ask",
      );
    const latencyMs = Math.round(performance.now() - t0);
    this.trace({
      sessionId: s.id,
      turn: s.turn,
      event: "ask",
      decision: "answer",
      reason: cue.key,
      latencyMs,
      sourceCalls,
      modelCalls: usedModel ? 1 : 0,
      costUsd,
      itemIds: items.map((i) => i.id),
    });
    return { answer, citations: citationsOf(items), usedModel, costUsd, latencyMs };
  }

  /** Explicit feedback from an integration that knows whether the agent used an injection. */
  feedback(f: Feedback): void {
    const s = this.sessions.get(sessionKey(f));
    const i = s?.outstanding.findIndex((o) => o.injectionId === f.injectionId) ?? -1;
    if (!s || i < 0) return;
    const [o] = s.outstanding.splice(i, 1);
    for (const sourceId of o!.sourceIds) this.deps.sourceMap.recordOutcome(s.scope, o!.situation, sourceId, f.used);
  }

  /** Drops everything held for a user, or for one of their sources (a revoked connector). */
  forget(scope: Scope, sourceId?: string): void {
    this.deps.cache.forget(scope, sourceId);
    this.deps.sourceMap.forget(scope, sourceId);
  }

  // ── internals ──

  private session(e: Scope & { sessionId: string }): Session {
    const key = sessionKey(e);
    const existing = this.sessions.get(key);
    if (existing) {
      // Re-insert so Map order is least recently active first, for eviction.
      this.sessions.delete(key);
      this.sessions.set(key, existing);
      return existing;
    }
    // Integrations do not always send session_end; never let abandoned sessions grow without bound.
    while (this.sessions.size >= this.config.maxSessions) {
      this.closeSession(this.sessions.values().next().value as Session);
    }
    const s: Session = {
      scope: { tenantId: e.tenantId, userId: e.userId },
      id: e.sessionId,
      key,
      turn: 0,
      window: [],
      seen: new Set(),
      ledger: new Ledger(this.config.ledgerCooldownTurns),
      outstanding: [],
      pending: [],
      cues: new Map(),
      situation: "general",
      inflight: null,
    };
    this.sessions.set(key, s);
    return s;
  }

  private closeSession(s: Session): void {
    for (const o of s.outstanding.splice(0)) {
      for (const sourceId of o.sourceIds) this.deps.sourceMap.recordOutcome(s.scope, o.situation, sourceId, false);
    }
    this.deps.budget.endSession(s.key);
    this.sessions.delete(s.key);
  }

  private remember(s: Session, event: AgentEvent, text: string): void {
    if (!text) return;
    s.window.push(`${event.kind}: ${text.slice(0, 1_000)}`);
    if (s.window.length > this.config.windowEvents) s.window.shift();
    for (const t of contentTerms(text)) s.seen.add(t);
  }

  private checkUsage(s: Session, event: AgentEvent, text: string): void {
    const actsOnIt = event.kind === "agent_message" || event.kind === "tool_call";
    s.outstanding = s.outstanding.filter((o) => {
      const used = actsOnIt && showsUse(text, o.tokens);
      const expired = s.turn - o.deliveredTurn > this.config.usageWindowTurns;
      if (!used && !expired) return true;
      for (const sourceId of o.sourceIds) this.deps.sourceMap.recordOutcome(s.scope, o.situation, sourceId, used);
      return false;
    });
  }

  /** Scores cached items for a cue: idf-weighted query coverage plus a bonus for an exact entity match. */
  private rank(s: Session, cue: Cue, options: { ignoreLedger?: boolean } = {}): Scored[] {
    const lowered = cue.entities.map((e) => e.toLowerCase());
    return this.deps.cache
      .search(s.scope, `${cue.text} ${cue.entities.join(" ")}`, 12, this.now())
      .filter((h) => options.ignoreLedger || s.ledger.isFresh(h.item.id, s.turn))
      .map((h) => {
        const hay = `${h.item.title} ${h.item.text}`.toLowerCase();
        // A capitalised run can glue two names together ("Dana Lee Globex"), so every word present also counts.
        const entityHit = lowered.some((e) => hay.includes(e) || e.split(/\s+/).every((w) => hay.includes(w)));
        return { item: h.item, score: h.coverage + (entityHit ? this.config.entityBonus : 0) };
      })
      .sort((a, b) => b.score - a.score);
  }

  private confident(scored: Scored[]): Scored[] {
    return scored.filter((x) => x.score >= this.config.confidentScore).slice(0, this.config.maxItemsPerInjection);
  }

  /** Routes, searches the chosen sources live, caches what they return and records which entities they hold. */
  private async searchLive(s: Session, cue: Cue, limit: number): Promise<number> {
    const all = await this.deps.sources(s.scope).catch((): Source[] => []);
    if (all.length === 0) return 0;
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
      { timeoutMs: this.config.sourceTimeoutMs },
    );
    for (const o of outcomes) {
      const stored = this.deps.cache.put(s.scope, o.items, this.now());
      for (const item of stored) {
        const entities = extractEntities(`${item.title}. ${item.text}`).slice(0, 20);
        this.deps.sourceMap.recordMentions(s.scope, item.sourceId, item.ref, entities, this.now());
      }
    }
    return chosen.length;
  }

  private async slowPath(s: Session, cue: Cue, t0: number, eventKind: string): Promise<Injection | null> {
    let modelCalls = 0;
    let costUsd = 0;
    const done = (decision: Trace["decision"], reason: string, sourceCalls: number, items: ContextItem[]) =>
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

    const sourceCalls = await this.searchLive(s, cue, this.config.lookupSources);
    const scored = this.rank(s, cue);
    const sure = this.confident(scored);
    if (sure.length > 0) {
      done(
        "sources",
        cue.key,
        sourceCalls,
        sure.map((x) => x.item),
      );
      return this.deliver(s, sure, "proactive", `sources:${cue.key}`);
    }
    const unsure = scored.filter((x) => x.score >= this.config.candidateScore).slice(0, this.config.judgeCandidates);
    if (unsure.length === 0 || !this.deps.model || !this.charge(s)) {
      done("silent", unsure.length ? "no model budget" : "no candidates", sourceCalls, []);
      return null;
    }
    try {
      const candidates = unsure.map((x) => x.item);
      const res = await this.deps.model.chat({
        messages: judgeMessages(s.window.join("\n"), candidates),
        maxTokens: 60,
        json: true,
      });
      modelCalls = 1;
      costUsd = res.costUsd;
      this.deps.budget.settle(scopeKey(s.scope), s.key, this.config.estimatedCallUsd, res.costUsd);
      const verdict = parseJudge(res.text, candidates.length);
      const picked = verdict.pick.slice(0, this.config.maxItemsPerInjection).map((i) => unsure[i]!);
      if (picked.length === 0) {
        done("silent", "model: none", sourceCalls, []);
        return null;
      }
      done(
        "model",
        cue.key,
        sourceCalls,
        picked.map((x) => x.item),
      );
      return this.deliver(s, picked, "proactive", `model:${cue.key}`, verdict.why);
    } catch {
      this.deps.budget.settle(scopeKey(s.scope), s.key, this.config.estimatedCallUsd, 0);
      done("silent", "model error", sourceCalls, []);
      return null;
    }
  }

  private charge(s: Session): boolean {
    return this.deps.budget.charge(scopeKey(s.scope), s.key, this.config.estimatedCallUsd);
  }

  private deliver(s: Session, scored: Scored[], mode: InjectionMode, reason: string, note?: string): Injection {
    const items = scored.map((x) => x.item);
    const text = renderPacket(items, { maxBytes: this.config.maxInjectionBytes, note });
    s.ledger.mark(
      items.map((i) => i.id),
      s.turn,
    );
    const injection: Injection = {
      ...s.scope,
      id: newId("inj", this.now()),
      sessionId: s.id,
      mode,
      text,
      citations: citationsOf(items),
      reason,
      score: Math.max(...scored.map((x) => x.score)),
      createdAt: this.now(),
    };
    s.outstanding.push({
      injectionId: injection.id,
      sourceIds: [...new Set(items.map((i) => i.sourceId))],
      situation: s.situation,
      tokens: distinctiveTokens(items.map((i) => `${i.title} ${i.text}`).join(" "), s.seen),
      deliveredTurn: s.turn,
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
  return { text: terms.join(" "), entities, key };
}
