import type { Budget } from "@eden/llm";
import {
  type Citation,
  itemId,
  scopeKey,
  type ContextItem,
  type Feedback,
  type Injection,
  type InjectionMode,
  type Scope,
} from "@eden/protocol";
import { Vocab } from "@eden/primitives";
import { nearDuplicate, type ItemCache, type Sketch } from "./cache";
import { gateOf } from "./conflict";
import { cardNames, CLEARED_STATES, couldClear, type CardNames, STANDING_KINDS, type Card } from "./cards";
import { startDay } from "./grounding";
import { Ledger } from "./ledger";
import type { FrozenRecorded, FrozenSession, FrozenUnverifiable } from "./partner-freeze";
import { MAX_FROZEN_SESSIONS, MAX_RECORDED, freezeSession } from "./partner-freeze";
import { citationsOf, PLAN_LEAD } from "./render";
import { MAX_PACKET_PARTIES, partiesIn, partyKey } from "./parties";
import { safeLine } from "./line";
import { anchored } from "./settle";
import { contentTerms, head, isStopword, termIds } from "./text";
import type { Trace, UsageRecord } from "./trace";
import { distinctiveTokens } from "./usage";
import { PartnerCore } from "./partner-core";
import type { Copy, Cue, ItemLines, PacketFrame, Recorded, Scored, Session } from "./partner";
import {
  EXPLAIN_TRACES,
  HELD_CHARS,
  MAX_CANDIDATE_BYTES,
  MAX_RECORDED_USERS,
  PLAN_REQUESTS,
  PLAN_SENT,
  READER_POOL_CAP,
  TIME_WORD,
  bulkMail,
  docYears,
  idNumbers,
  itemLinesOf,
  pairKey,
  sameEntry,
  sameRef,
  sessionKey,
  versionOf,
} from "./partner";

/**
 * `ContextPartner`'s delivery slice (R3, D2019): `takePending`/`explain`/`feedback`, sessions and their lifecycle
 * (`session`, `close`, `freezeEvicted`, `resetContext`), the `recorded`/`outstanding` ledgers and shown marks.
 * Between `PartnerCore` and the observe/ask/check paths because the paths call into these.
 */

/** Content terms `carry` keeps per delivered item (its title leads, so its most naming terms are kept). */
export const DELIVERED_TERMS = 2;

/** How much of a delivered item's text `carry` reads terms from once its title's terms run out. */
export const DELIVERED_TEXT_CHARS = 256;

export interface Built {
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
  shown?: { items: readonly ContextItem[]; text: string; lines?: ItemLines };
  /** With `revisionNotice`: each item's version the agent holds once this is handed out (`noteShown`). */
  copies?: { id: string; sourceId: string; version: number }[];
}

/**
 * Injections awaiting a usage verdict per session; past this the oldest is dropped with no verdict. An ask-only session
 * (an MCP client) sends no events, so nothing it was given can ever show use: counting those as unused would teach the
 * source map that the sources answering its asks are useless.
 */
export const MAX_OUTSTANDING = 64;

export const utf8 = new TextEncoder();

export const PLAN_QUOTE_CHARS = 200;

/** Whether sorted `xs` holds `x`. */
export function sortedHas(xs: Uint32Array | Float64Array, x: number): boolean {
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
export function pairsOf(text: string, vocab: Vocab): number[] {
  const { ids, n } = termIds(text, vocab, false);
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(pairKey(ids[i - 1]!, ids[i]!));
  return out;
}

/** `packetHeedsCheck` (D1450): the reasons of the packets the no-model rule paths make for a request. */
export const RULE_PATHS = ["fallback:", "grounded-", "sources:"];

/** `unverifiable`: how long a held null stands at most, signal or not (a reply lacking the record may be transient). */
export const UNVERIFIABLE_HOLD_MS = 10 * 60_000;

export abstract class PartnerDelivery extends PartnerCore {
  protected abstract dropCheckedOut(s: Session): void;
  protected abstract watchCopies(s: Session, copies: readonly Copy[]): void;
  protected abstract withoutCoveredUpdates(batch: Injection[]): Injection[];
  protected abstract currentLast(s: Session, batch: Injection[]): Injection[];
  protected abstract unwatch(s: Session): void;
  protected abstract override sessionSnapshot(scope: Scope): FrozenSession[] | null;
  protected abstract override putFrozenSessions(user: string, list: FrozenSession[]): void;
  protected abstract inForce(s: Session, before: number): CardNames[];
  protected abstract checkedOut(s: Session): ((item: ContextItem) => boolean) | null;
  protected abstract unact(s: Session): void;
  protected abstract recordedOf(scope: Scope): Map<string, Recorded> | undefined;
  protected abstract override recordedSnapshot(scope: Scope): FrozenRecorded[] | null;
  protected abstract override unverifiableSnapshot(key: string): FrozenUnverifiable | null;
  protected abstract peopleOf(s: Session, cue: Cue): string[];
  protected abstract readAt(s: Session, item: ContextItem, now: number): number;
  protected abstract noteShown(s: Session, items: readonly ContextItem[], text: ItemLines): void;
  protected abstract build(
    s: Session,
    scored: Scored[],
    mode: InjectionMode,
    reason: string,
    cue: Cue,
    parent: number,
    shown?: string,
    frame?: PacketFrame,
  ): Injection;
  protected abstract usage(u: UsageRecord): void;

  /**
   * A push packet withdrawn before the agent took it (`readerPushBehind`'s second reading): its items go back to what
   * the session's ledger held before it (an earlier delivery and its version stand; an item never delivered is fresh
   * again), and their sketches leave the near-duplicate memory, so what the second reading does not deliver again
   * stays deliverable. An entry marked since by another delivery that recorded something else is left as it is.
   */
  protected withdraw(s: Session, prev: Injection): void {
    const undo = this.undoable.get(prev);
    if (!undo) return;
    this.undoable.delete(prev);
    for (const [id, u] of undo) {
      if (!sameEntry(u.set, s.ledger.entry(id))) continue;
      s.ledger.restore(id, u.was);
      if (!u.sketch) continue;
      const at = s.delivered.findIndex((d) => d.sketch === u.sketch);
      if (at >= 0) s.delivered.splice(at, 1);
    }
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
    this.dropCheckedOut(s);
    const out = this.currentLast(s, this.withoutCoveredUpdates(s.pending.splice(0)));
    if (!options.shadow) for (const injection of out) this.handOut(s, injection);
    return out;
  }

  /**
   * `packetHeedsCheck` (D1450): a rule path's packet (`RULE_PATHS`), made for the session's current request, whose
   * every item that request's push check turned down. Never the candidates' own packet (a check that failed open or
   * came late left them), an update, a plan alert, an ask's follow-up or the fast path's.
   */
  protected allCheckedOut(s: Session, packet: Injection, out = this.checkedOut(s)): boolean {
    if (!out || packet.mode !== "proactive" || packet.citations.length === 0) return false;
    if (!RULE_PATHS.some((prefix) => packet.reason.startsWith(prefix))) return false;
    if (this.madeFor.get(packet) !== s.requests) return false;
    const now = this.now();
    return packet.citations.every((c) => {
      const item = this.deps.cache.get(s.scope, c.itemId, now);
      return !!item && out(item);
    });
  }

  /** `packetHeedsCheck` (D1450): the decision not to hand a packet, traced (ids only), so `explain` says why. */
  protected traceHeld(s: Session, packet: Injection): void {
    this.trace(s, {
      sessionId: s.id,
      turn: s.turn,
      event: "user_message",
      decision: "silent",
      reason: "push check turned it down",
      latencyMs: 0,
      sourceCalls: 0,
      modelCalls: 0,
      costUsd: 0,
      itemIds: packet.citations.map((c) => c.itemId),
    });
  }

  /**
   * A queued packet that cites an item since removed at its source (`sourceRemoved`, D126) is not handed out: the agent
   * would read a deleted item as current. Found by the engine fuzz harness (`fuzz.test.ts`, audit A5): the removal
   * cleared the cache, the sync's records and held pages, but not packets already queued. The packet goes whole (its
   * text cannot lose one item safely: folding and framing span items); what its delivery marked is undone where an undo
   * was kept, as for a withdrawn packet, and otherwise its other items stay marked (silence over a repeat).
   */
  protected dropRemovedPending(s: Session): void {
    if (s.pending.length === 0) return;
    const now = this.now();
    for (let k = s.pending.length - 1; k >= 0; k--) {
      const packet = s.pending[k]!;
      if (!packet.citations.some((c) => this.deps.cache.isHeldGone(s.scope, c.itemId, now))) continue;
      s.pending.splice(k, 1);
      this.withdraw(s, packet);
    }
  }

  /**
   * Keeps an evicted session's delivery knowledge in `restoredSessions`: the agent may continue the same
   * sessionId, and a session created for it is seeded like a thawed one, so nothing already handed is delivered
   * again (D1999).
   */
  private freezeEvicted(s: Session): void {
    const f = freezeSession(s);
    if (!f) return;
    const user = scopeKey(s.scope);
    const list = (this.restoredSessions.get(user) ?? []).filter((x) => x.sessionId !== s.id);
    list.push(f);
    this.putFrozenSessions(user, list.slice(-MAX_FROZEN_SESSIONS));
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
    // Take the sessions' delivery knowledge before closing them: `close` drops them from `userSessions`.
    this.frozenPending.set(key, this.sessionSnapshot(scope));
    for (const s of [...this.sessions.values()]) if (scopeKey(s.scope) === key) this.close(s, false);
    this.frozenRecorded.set(key, this.recordedSnapshot(scope) ?? []);
    this.recorded.get(scope.tenantId)?.delete(key);
    // The probe economy's learned rates and arms too: `save` runs inside `cache.release`, after
    // `economy.forget` below, so the snapshot must be taken first (D2001).
    this.frozenEconomy.set(key, this.economy.snapshot(scope));
    this.frozenYields.set(key, this.yields?.snapshot(scope) ?? null);
    this.frozenUnverifiable.set(key, this.unverifiableSnapshot(key));
    const written = this.deps.cache.release(scope, write);
    this.frozenPending.delete(key);
    this.frozenRecorded.delete(key);
    this.frozenEconomy.delete(key);
    this.frozenYields.delete(key);
    this.frozenUnverifiable.delete(key);
    this.restoredSessions.delete(key);
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
    this.deps.checker?.forget(scope);
    return written;
  }

  /**
   * `partyCheck` (D375): notes the identifiers a text handed to the agent showed (digests only), each with the cited
   * item whose text holds it, so `partyFinding` can tell a party Eden's packets supplied. An ask's answer is the text
   * the agent receives, not its injection's own rendering (`deliver`'s `shown`), so `ask` notes it itself.
   */
  protected notePacketParties(s: Session, text: string, citations: readonly Citation[]): void {
    const found = partiesIn(text, true);
    if (found.length === 0) return;
    const map = (s.packetParties ??= new Map());
    const cited = citations
      .map((c) => this.deps.cache.get(s.scope, c.itemId, this.now()))
      .filter((i): i is ContextItem => i !== null);
    // Each cited item's identifiers, read once and only when a party reaches it.
    const norms: (Set<string> | undefined)[] = [];
    const holds = (n: number, norm: string) =>
      (norms[n] ??= new Set(partiesIn(`${cited[n]!.title}\n${cited[n]!.text}`).map((q) => q.norm))).has(norm);
    for (const p of found) {
      const k = partyKey(p.norm);
      const holder = cited.find((_, n) => holds(n, p.norm));
      map.delete(k);
      map.set(k, holder?.id ?? "");
    }
    while (map.size > MAX_PACKET_PARTIES) map.delete(map.keys().next().value as string);
  }

  /**
   * The push's pool: the ranking's first `askReaderPool` distinct items, and their cards. `pushGate` and the plan
   * alerts (`checkPlans`) share it. `pushStateFilter` (F2, trial): an item carded none because a constraint was
   * lifted, met or superseded leaves the pool, and the next ranked item takes its seat; cards are then read for the
   * whole ranking (one lookup an item). It stays when one of the user's constraint cards is one it could clear
   * (`couldClear`, D1456).
   */
  protected pushPool(
    s: Session,
    ranked: readonly Scored[],
    before: number,
  ): { pool: Scored[]; cards: Map<string, Card> } {
    const pool: Scored[] = [];
    const seen = new Set<string>();
    const cap = Math.max(0, Math.min(this.config.askReaderPool, READER_POOL_CAP));
    const enricher = this.config.cards ? this.deps.cards : undefined;
    const states =
      enricher && this.config.pushStateFilter && ranked.length > 0
        ? enricher.cardsOf(
            s.scope,
            ranked.map((x) => x.item.id),
            before,
          )
        : null;
    let inForce: CardNames[] | undefined;
    for (const x of ranked) {
      if (pool.length >= cap) break;
      if (seen.has(x.item.id)) continue;
      seen.add(x.item.id);
      // Only a none card: an item that announces the new state of affairs (a retimed flight, a claim already paid) is
      // carded already-done or status-change and is the fact in force, though it says an earlier one was superseded.
      const card = states?.get(x.item.id);
      // A lift notice stays beside the hold it could lift (D1456): without it the check would read the hold alone.
      if (card?.kind === "none" && card.state && CLEARED_STATES.has(card.state)) {
        inForce ??= this.inForce(s, before);
        const names = cardNames(card);
        if (!inForce.some((c) => couldClear(names, c))) continue;
      }
      pool.push(x);
    }
    const cards =
      states ??
      (enricher && pool.length > 0
        ? enricher.cardsOf(
            s.scope,
            pool.map((x) => x.item.id),
            before,
          )
        : new Map<string, Card>());
    return { pool, cards };
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
  protected checkPlans(s: Session): void {
    const waiting = s.planNew;
    if (!this.config.planConflict || s.closed || !s.acted) return;
    const sent = s.planSent;
    // D2010: an alert said once repeats once at a request past the one it was sent on — while the copy is still
    // the one the session holds (not `isFresh`: the alert's own delivery marks it read). `at` counts requests,
    // not turns: a tool result's take must not spend the repeat before the next request arrives.
    const repeats = sent === undefined ? false : [...sent.values()].some((m) => m.n === 1 && m.at < s.requests);
    if ((!waiting || waiting.size === 0) && !repeats) return;
    const now = this.now();
    const sentMap = (s.planSent ??= new Map());
    // A copy a change signal has put in doubt since it was read (D126's `doubted`) waits for a later take, when the
    // poll the signal starts has stored the current one; a held-gone id is not in the cache. A re-stored copy of an
    // item said once counts as its repeat; one said twice is never said again.
    const fresh = new Set<string>();
    const later: string[] = [];
    for (const id of waiting ?? []) {
      const it = this.deps.cache.get(s.scope, id, now);
      if (!it || (sentMap.get(id)?.n ?? 0) >= 2 || !s.ledger.isFresh(id, s.turn)) continue;
      if (this.config.verifyDelivery && this.doubted(s, it)) later.push(id);
      else fresh.add(id);
    }
    waiting?.clear();
    if (waiting) for (const id of later) waiting.add(id);
    for (const [id, mark] of sentMap) {
      if (mark.n !== 1 || mark.at >= s.requests || fresh.has(id)) continue;
      const it = this.deps.cache.get(s.scope, id, now);
      if (it && !(this.config.verifyDelivery && this.doubted(s, it))) fresh.add(id);
    }
    if (fresh.size === 0) return;
    const said = new Set<string>();
    for (const cue of s.acted) {
      // The push's own pool (`pushPool`, with `pushStateFilter`): a clearance that arrives late is no alert either.
      const { pool, cards } = this.pushPool(s, this.rank(s, cue, { ignoreLedger: true }), now);
      // The candidates' rule (`candidatesOf`): the pool holds something that could constrain the request, and the new
      // item is among its first `pushCandidates` (bulk mail out), as it would have been had it been there then.
      const top = pool.filter((x) => !bulkMail(x.item)).slice(0, Math.max(1, this.config.pushCandidates));
      const hits = top.filter((x) => fresh.has(x.item.id) && !said.has(x.item.id));
      if (hits.length === 0) continue;
      if (!pool.some((x) => this.constraintLike(x, cards))) continue;
      const bearing = hits;
      for (const x of bearing) {
        said.add(x.item.id);
        const mark = sentMap.get(x.item.id);
        sentMap.set(x.item.id, { n: (mark?.n ?? 0) + 1, at: s.requests });
        if (sentMap.size > PLAN_SENT) sentMap.delete(sentMap.keys().next().value as string);
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

  /**
   * `readerGate`'s test of one candidate: whether it could constrain a request (a card of a constraint kind, a state
   * change or a thing done, or constraint wording; an arranged visit with `readerGateVisits`). Bulk mail never does.
   */
  protected constraintLike(x: Scored, cards: ReadonlyMap<string, Card>): boolean {
    if (bulkMail(x.item)) return false;
    const card = cards.get(x.item.id);
    if (card && (STANDING_KINDS.has(card.kind) || card.kind === "status-change" || card.kind === "already-done")) {
      return true;
    }
    return gateOf(x.item, this.config.readerGateVisits);
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
      this.record(scope, f.injectionId, o.sourceIds, o.situation, f.used, {
        sessionId: f.sessionId,
        how: "explicit",
        bytes: o.bytes,
      });
      return true;
    }
    // The session may have ended (and counted the injection unused): the user's record outlives it.
    const r = this.recordedOf(scope)?.get(f.injectionId);
    if (!r) return false;
    if (r.pending === true) {
      // Judged by nothing yet (a `context_reset` kept it): the verdict records, it does not correct (D2006).
      r.pending = undefined;
      r.used = f.used;
      for (const sourceId of r.sourceIds) this.deps.sourceMap.recordOutcome(scope, r.situation, sourceId, f.used);
      this.usage({
        sessionId: r.sessionId,
        injectionId: f.injectionId,
        used: f.used,
        how: "explicit",
        sourceIds: r.sourceIds,
        injectionBytes: r.bytes,
      });
      return true;
    }
    if (r.used !== f.used) {
      for (const sourceId of r.sourceIds) this.deps.sourceMap.correctOutcome(scope, r.situation, sourceId, f.used);
      r.used = f.used;
      this.usage({
        sessionId: r.sessionId,
        injectionId: f.injectionId,
        used: f.used,
        how: "explicit",
        sourceIds: r.sourceIds,
        injectionBytes: r.bytes,
      });
    }
    return true;
  }

  // ── sessions ──

  protected session(e: Scope & { sessionId: string }): Session {
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
      this.freezeEvicted(s);
      this.close(s, false);
    }
    if ((this.perTenant.get(e.tenantId) ?? 0) >= this.config.maxSessionsPerTenant) {
      for (const s of this.sessions.values()) {
        if (s.scope.tenantId !== e.tenantId) continue;
        this.freezeEvicted(s);
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
    // A user back from a frozen blob (a daemon respawned between turns): its sessions' knowledge of what was
    // already handed comes with it, so nothing is delivered twice across the restart.
    const frozen = this.restoredSessions.get(user);
    if (frozen) {
      // Only the session the blob continues is seeded: a new conversation's agent never held those items, so
      // their marks would suppress context it never saw (BUG_0001).
      for (const f of frozen) {
        if (f.sessionId !== s.id) continue;
        s.ledger.seed(f.ledger, f.turn);
        for (const d of f.delivered) {
          s.delivered.push({ ...d, refs: new Set(d.refs), terms: [...d.terms], years: [...d.years], turn: 0 });
        }
        // Injections still awaiting a use verdict ride along: the agent may still act on them, and the source
        // map's learning must not lose the deliveries a respawn interrupted. Turn re-anchored like the ledger's.
        // Seeding consumes them: the live session owns the verdicts now, and a stale copy kept in `restoredSessions`
        // would re-seed an evicted-then-reopened session — a judged injection then counts a second outcome (a later
        // session_end learns it again as "ended", or feedback records it twice).
        for (const o of f.outstanding ?? []) {
          if (s.outstanding.size >= MAX_OUTSTANDING || s.outstanding.has(o.injectionId)) break;
          s.outstanding.set(o.injectionId, {
            injectionId: o.injectionId,
            sourceIds: [...o.sourceIds],
            situation: o.situation,
            bytes: o.bytes,
            warning: o.warning,
            tokens: new Set(o.terms.map((t) => s.vocab.intern(t))),
            deliveredTurn: o.deliveredTurn - f.turn,
          });
        }
        f.outstanding = [];
      }
      if (s.delivered.length > 200) s.delivered.splice(0, s.delivered.length - 200);
    }
    this.perTenant.set(e.tenantId, (this.perTenant.get(e.tenantId) ?? 0) + 1);
    return s;
  }

  /**
   * Ends a session. `learn` is true only for a real session_end: then injections the agent never showed use of count
   * as unused. Eviction and forget learn nothing, since the session did not run its course.
   */
  /**
   * `context_reset` (A3, D2006): the agent's transcript was compacted — the items this session showed it are gone
   * from its context. The delivery marks clear (the ledger's delivered/versions/shown, the near-duplicate
   * `delivered` list, `agentHas`, the party digests and shown words, the plan alerts already sent), so a later
   * packet or answer may show the same items again. `outstanding` drops quietly — a compaction is no use-verdict
   * on what was shown — while request state, cues, learned economy (`pushRead`/`pushChecks`/`checks`) and queued
   * packets stand: they are not the agent's memory of a delivery.
   */
  protected resetContext(s: Session): void {
    s.ledger.reset();
    s.delivered = [];
    s.agentHas = [];
    // Shown but judged by nothing: kept for a later correction, with no outcome recorded — a compaction is no
    // verdict on what was shown (feedback on it lands fresh in `feedback`).
    for (const [id, o] of s.outstanding) {
      // No verdict — a compaction scores nothing — but the bytes were handed: a `reset` record keeps the packet in
      // the digest's accounting (C1) while the pending row waits for a later correction.
      this.usage({
        sessionId: s.id,
        injectionId: id,
        used: false,
        how: "reset",
        sourceIds: o.sourceIds,
        injectionBytes: o.bytes,
      });
      this.recordRow(s.scope, id, {
        sourceIds: o.sourceIds,
        situation: o.situation,
        used: false,
        sessionId: s.id,
        pending: true,
        bytes: o.bytes,
      });
    }
    s.outstanding.clear();
    s.checked?.clear();
    s.packetParties?.clear();
    s.shown?.clear();
    s.planSent?.clear();
  }

  protected close(s: Session, learn: boolean): void {
    if (s.closed) return;
    s.closed = true;
    s.abort.abort();
    if (learn) {
      for (const [id, o] of s.outstanding) {
        this.record(s.scope, id, o.sourceIds, o.situation, false, { sessionId: s.id, how: "ended", bytes: o.bytes });
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

  // ── usage learning ──

  /** Starts usage tracking: from the moment the agent actually receives an injection, against what it had seen. */
  protected handOut(s: Session, injection: Injection): void {
    const built = this.built.get(injection);
    // `sourceYield` (D505): an item of a source reached the agent, so the source's run of unused reads ends.
    if (built && this.yields && !s.closed) this.yields.used(s.scope, built.sourceIds, this.now());
    if (this.config.partyCheck && injection.reason !== "action-party" && injection.reason !== "ask") {
      this.notePacketParties(s, injection.text, injection.citations);
    }
    // Every path that gives the agent an injection comes through here: what it was shown is noted first, before the
    // usage tracking's early returns (an injection already tracked or recorded was still shown).
    if (built?.shown) {
      this.noteShown(s, built.shown.items, built.shown.lines ?? itemLinesOf(built.shown.text.split("\n")));
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
      // The handed bytes (C1): the usage record names them so the digest can price the agent's re-reads.
      bytes: utf8.encode(injection.text).byteLength,
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

  protected record(
    scope: Scope,
    injectionId: string,
    sourceIds: string[],
    situation: string,
    used: boolean,
    report: { sessionId: string; how: UsageRecord["how"]; bytes?: number },
  ): void {
    this.usage({
      sessionId: report.sessionId,
      injectionId,
      used,
      how: report.how,
      sourceIds,
      injectionBytes: report.bytes,
    });
    for (const sourceId of sourceIds) this.deps.sourceMap.recordOutcome(scope, situation, sourceId, used);
    this.recordRow(scope, injectionId, {
      sourceIds,
      situation,
      used,
      sessionId: report.sessionId,
      bytes: report.bytes,
    });
  }

  /** A row in `recorded`, under the same per-user and per-tenant caps `record` enforces. */
  protected recordRow(scope: Scope, injectionId: string, row: Recorded): void {
    const key = scopeKey(scope);
    const tenant = this.recorded.get(scope.tenantId) ?? new Map<string, Map<string, Recorded>>();
    this.recorded.set(scope.tenantId, tenant);
    const mine = tenant.get(key) ?? new Map<string, Recorded>();
    tenant.delete(key); // Re-insert: Map order is least recently recorded user first.
    tenant.set(key, mine);
    mine.set(injectionId, row);
    while (mine.size > MAX_RECORDED) mine.delete(mine.keys().next().value as string);
    while (tenant.size > MAX_RECORDED_USERS) tenant.delete(tenant.keys().next().value as string);
  }

  // ── retrieval ──

  /**
   * Scores cached items for a cue: idf-weighted query coverage, plus a bonus when the item names a cue entity as
   * whole terms ("Al" never matches "also"). Both come from the cache's index: the item's text is never rescanned.
   */
  protected rank(s: Session, cue: Cue, options: { ignoreLedger?: boolean; probed?: string[] } = {}): Scored[] {
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
        ? found
            // Only an item the ledger holds a version of can be revised: the others' words are not hashed (D1885).
            .filter((h) => s.ledger.holdsVersion(h.item.id) && s.ledger.revised(h.item.id, versionOf(h.item), s.turn))
            .map((h) => h.item.id)
        : [],
    );
    return (
      found
        .filter((h) => options.ignoreLedger || revised.has(h.item.id) || s.ledger.isFresh(h.item.id, s.turn))
        // A near-duplicate of something already delivered this session (a reply quoting it, a synced copy) is old news.
        .filter(
          (h) =>
            options.ignoreLedger ||
            revised.has(h.item.id) ||
            !s.delivered.some((d) => nearDuplicate(d.sketch, h.sketch) && sameRef(d.refs, h.item)),
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
                  nearDuplicate(x.sketch, y.sketch) &&
                  startDay(x.item, cue.offset) === startDay(y.item, cue.offset) &&
                  sameRef(idNumbers(`${x.item.title} ${x.item.text}`), y.item),
              ),
        )
    );
  }

  /**
   * Whether one recent tool result or agent message holds every term of a cached item and every pair of adjacent
   * terms in its title and text: then the item adds nothing the agent has not fetched or said, and delivering it is a
   * repeat. A new term or a new pairing (11:30 where the agent saw 11:00 and, elsewhere in a day's listing, 9:30)
   * keeps it: a stale copy in the agent's hands is no reason to hold back the update. Items of under four terms are
   * never judged so, since a few common terms prove nothing.
   */
  protected alreadyHas(s: Session, item: ContextItem, doc: number, vocab: Vocab): boolean {
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
   * Whether any of these cached items was fetched longer ago than `refreshAfterMs` (refreshing on), or, with
   * `verifyDelivery`, read before its source signalled a change (`doubted`): the fast path may not re-read it, so the
   * slow path, which does, delivers it.
   */
  protected stale(s: Session, scored: Scored[]): boolean {
    const now = this.now();
    if (this.config.verifyDelivery && scored.some((x) => this.doubted(s, x.item))) return true;
    const after = this.config.refreshAfterMs;
    if (after <= 0) return false;
    // A synced item counts by when the sync last read it too (D57): its source's copy may be current, but the fast
    // path stays for what was read recently, and the rest goes through the slow path, which answers from the local
    // index at no call and lets the judge, when there is one, rule (the fast path never asks it).
    return scored.some((x) => now - this.readAt(s, x.item, now) > after);
  }

  /**
   * Whether an item must be re-read before it is delivered (`verifyDelivery`): its source signalled a change since the
   * copy's read began (`Sync.signalledSince` on its `ItemCache.readMark`; D133: not since it was stored, which a
   * signal while the call was on the wire precedes) and no listing or notification has brought it again since. A
   * copy's age alone does not doubt it (D126: re-reading by age cost 4.6 connector calls and 0.33 s per task live, for
   * no measured gain; a silent source's changes reach Eden through the sync's polls and sweeps).
   */
  protected doubted(s: Session, item: ContextItem): boolean {
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
  protected unswept(scope: Scope, item: ContextItem): boolean {
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

  /** The citations of what was rendered. */
  protected cited(items: readonly ContextItem[]): Citation[] {
    return citationsOf([...items]);
  }

  /**
   * `shown` is what the agent receives when it is not the injection's own text (an ask's answer). With
   * `compactInjection`, each item is cut to what bears on `cue` (`compactText`) rather than to its first bytes.
   */
  protected deliver(
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
    if (cue.request !== undefined) this.madeFor.set(injection, cue.request);
    if (sp) spans!.close(sp, { bytes: injection.text.length });
    return injection;
  }

  /**
   * What a delivery handed: the item's sketch (null for an ask's answer, which arrives with none), identifier
   * numbers and the turn, plus the bounded content terms a follow-up's `carry` inherits (D1976). Title first so
   * its most naming terms win the cap. Number-bearing terms are kept out: a carried identifier ("881") would
   * make the follow-up's own `contradicts` drop the sibling it was meant to reach.
   */
  protected recordDelivered(s: Session, item: ContextItem, sketch: Sketch | null): void {
    s.delivered.push({
      sketch,
      refs: idNumbers(`${item.title} ${item.text}`),
      itemId: item.id,
      turn: s.turn,
      terms: contentTerms(`${item.title} ${item.text.slice(0, DELIVERED_TEXT_CHARS)}`, s.vocab)
        .filter((t) => !/\d/.test(t))
        .slice(0, DELIVERED_TERMS),
      years: docYears(item),
    });
    if (s.delivered.length > 200) s.delivered.splice(0, s.delivered.length - 200);
  }

  protected trace(s: Session, t: Trace): void {
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
