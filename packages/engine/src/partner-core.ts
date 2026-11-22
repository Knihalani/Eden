import type { UserRows } from "@eden/graph";
import { scopeKey, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import { SourceFanout, type Source } from "@eden/sources";
import { sanitizeItem, type ItemCache } from "./cache";
import { SyncManager } from "./sync";
import { pooledSanitizer } from "./gate";
import { DEFAULT_CONFIG, type EngineConfig } from "./config";
import { warmGlossary } from "./gloss";
import { isFrozenYields, mergeFrozenYields, SourceYield, type FrozenYields } from "./source-yield";
import { isFrozenEconomy, mergeFrozenEconomy, ProbeEconomy, type FrozenEconomy } from "./economy";
import { type TurnGate, turnGate } from "./turn-gate";
import { Ledger } from "./ledger";
import {
  MAX_FROZEN_SESSIONS,
  MAX_RECORDED,
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
import { extractTypedEntities, PERSISTABLE_KINDS } from "./text";
import { SpanStats, Tracer } from "./spans";
import type { Built, CheckOutcome, PartnerDeps, Recorded, RevisionSource, Session, Undo } from "./partner";

/**
 * `ContextPartner`'s fields and wiring (R3, D2017): the class split along its paths moves each path to its own
 * file; the chain `ContextPartner extends ... extends PartnerCore` keeps `this` working across them, so this
 * base holds every field, the constructor's persist-hooks and the shared sync/fan-out plumbing. Members are
 * `protected` where another slice reads them; the public shape is unchanged.
 */

export abstract class PartnerCore {
  /**
   * The methods the persist-hooks and `onStored` closures call: implemented on `ContextPartner` (and the path
   * classes between), declared here so the shared wiring type-checks. `protected`: the paths' surface is unchanged.
   */
  protected abstract enqueueCards(scope: Scope, added: ContextItem[], defer?: (item: ContextItem) => boolean): void;
  protected abstract cardDefer(
    scope: Scope,
    items: readonly ContextItem[],
    mentions: readonly { entities: string[] }[],
  ): ((item: ContextItem) => boolean) | undefined;
  protected abstract recordMentions(
    scope: Scope,
    added: ContextItem[],
    parent?: number,
    given?: { sourceId: string; entities: string[] }[],
  ): void;
  protected abstract queueRevised(scope: Scope, items: readonly ContextItem[]): void;
  protected abstract queuePlanConflicts(scope: Scope, items: readonly ContextItem[]): void;
  protected abstract sessionSnapshot(scope: Scope): FrozenSession[] | null;
  protected abstract putFrozenSessions(user: string, list: FrozenSession[]): void;
  protected abstract recordedSnapshot(scope: Scope): FrozenRecorded[] | null;
  protected abstract restoreRecorded(scope: Scope, rec: FrozenRecorded[]): void;
  protected abstract unverifiableSnapshot(key: string): FrozenUnverifiable | null;
  protected abstract restoreUnverifiable(scope: Scope, rows: FrozenUnverifiable): void;
  readonly config: EngineConfig;
  /** The turn gate (`pushGate`, D1014), or null: the rule alone. */
  protected readonly gate: TurnGate | null;
  protected readonly sessions = new Map<string, Session>();
  /** By user scope key, that user's live sessions (no larger than `sessions`); a session leaves on close. */
  protected readonly userSessions = new Map<string, Set<Session>>();
  /**
   * Session knowledge restored with a frozen user (`persistHooks.restored`): each saved session's ledger snapshot
   * and delivered list. Every new session of the user is seeded from it, so a daemon respawned between turns does
   * not hand the agent the same packet again (D). Read-only: sessions keep their own copies.
   */
  protected readonly restoredSessions = new Map<string, FrozenSession[]>();
  /**
   * Session snapshots taken in `release` before the user's sessions close (`close` removes them from
   * `userSessions`, so a snapshot read by the save hook then would be empty). Consumed by `save`.
   */
  protected readonly frozenPending = new Map<string, FrozenSession[] | null>();
  /**
   * `recorded` rows taken in `release` before the user's map entry drops (the save hook reads `recorded` after
   * `release` deleted it, so a live read there would be empty). Consumed by `save`.
   */
  protected readonly frozenRecorded = new Map<string, FrozenRecorded[]>();
  /** Economy snapshot `release` captures before `economy.forget` — `save` consumes it (D2001). */
  protected readonly frozenEconomy = new Map<string, FrozenEconomy | null>();
  /** Source-yield snapshot `release` captures before `yields.forget` — `save` consumes it (D2002). */
  protected readonly frozenYields = new Map<string, FrozenYields | null>();
  /** `unverifiable` rows `release` captures before the map drops — `save` consumes them (D2003). */
  protected readonly frozenUnverifiable = new Map<string, FrozenUnverifiable | null>();
  protected readonly perTenant = new Map<string, number>();
  protected readonly built = new WeakMap<Injection, Built>();
  /**
   * `revisionNotice`: by user scope key, the live sessions handed at least one item (`Ledger.noteShown`), so a store
   * looks at those sessions alone; a session leaves on close. And the polls a change notice started for them
   * (`revisionsSettled`).
   */
  protected readonly watching = new Map<string, Set<Session>>();
  /** `planConflict` (D301): by user scope key, the live sessions with acting requests; a session leaves on close. */
  protected readonly acting = new Map<string, Set<Session>>();
  protected readonly revisionPolls = new Map<string, Promise<void>>();
  /** By user and source: the notice poll's state (`pollRevised`), at most `MAX_REVISION_SOURCES`, idle ones dropped. */
  protected readonly revisionSources = new Map<string, RevisionSource>();
  /** `stopSync` was called (and no `startSync` since): notices start no revision poll. */
  protected revisionsStopped = false;
  /**
   * `sourceRefs` (D347): by user and item, the re-read a ref notice started and has not finished. The item is in doubt
   * until it lands (`doubted`), and a delivery's re-read waits on it rather than make a second call (`check`).
   */
  protected readonly refreshing = new Map<string, { mark: number; outcome: Promise<CheckOutcome> }>();
  /**
   * `readerPushBehind`: what a push packet's delivery changed in its own session, so a second reading that withdraws
   * the packet untaken can undo it (`withdraw`). Keyed by the packet, so it goes with it.
   */
  protected readonly undoable = new WeakMap<Injection, Undo>();
  /** `packetHeedsCheck` (D1450): the user request each rule-path packet was made for (its cue's). */
  protected readonly madeFor = new WeakMap<Injection, number>();
  /** Tenant → user scope key → injection id → outcome; both inner maps least recently recorded first. */
  protected readonly recorded = new Map<string, Map<string, Map<string, Recorded>>>();
  protected readonly now: () => number;
  protected readonly fanout: SourceFanout;
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
  protected readonly unverifiable = new Map<string, Map<string, { mark: number; at: number }>>();
  /** The secret gate every item passes before it is held (D10): the fanout's, and `sourceItems`'. */
  protected readonly redact: (items: ContextItem[]) => ContextItem[] | Promise<ContextItem[]>;
  /** What each user's probes bring back (`probeFresh`, `probeYield`). */
  protected readonly economy = new ProbeEconomy();
  /** `sourceYield` (D505): each source's run of live reads with nothing used; null when off. */
  protected readonly yields: SourceYield | null;
  /** Span tracing (`spans.ts`): null when off, so each phase's call site is one null check. */
  protected readonly spans: Tracer | null;
  protected readonly stats: SpanStats | null;
  /**
   * The background sync (`sync`, D57), or null when off. Its `tick` does the background work: a server runs it on a
   * timer (`startSync`), a simulation calls it on its own clock.
   */
  readonly sync: SyncManager | null;
  protected syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(protected readonly deps: PartnerDeps) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    // The turn gate's weights are read here, once a process, not on a user's first message (D1014).
    this.gate = this.config.pushGate ? (deps.turnGate === undefined ? turnGate() : deps.turnGate) : null;
    // `requestGloss` (F1, D1153): the glossary's prefix is read here too, once a process (D1710: function words,
    // English words, the keys' filters); its lexicons only when a request could be read as another language.
    if (this.config.requestGloss) warmGlossary();
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
      // `cardsState` (F2, D1193): each card says whether its constraint still holds.
      if (this.config.cardsState) cards.askState();
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
      // `tenantCallsPerMin` (S1-P1): the tenant's pace per connector, unset (0) unless the operator sets it.
      tenantRatePerSec: this.config.tenantCallsPerMin > 0 ? this.config.tenantCallsPerMin / 60 : undefined,
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
            keepRules: c.syncKeepRules,
            pageSize: c.syncPageSize,
            backfillLanes: c.syncBackfillLanes,
            kickLanes: c.syncKick ? c.syncKickLanes : 0,
            kickRetryMs: c.syncKick ? c.syncKickRetryMs : 0,
            pollPageSize: c.syncPollPageSize,
            staleChance: c.syncStaleChance,
            maxStaleMs: c.syncMaxStaleMs,
            ...(c.syncActivePollMs > 0
              ? {
                  activePollMs: c.syncActivePollMs,
                  activePollBackoff: c.syncActivePollBackoff,
                  activePollPriced: c.syncActivePollPriced,
                  activePollCap: c.syncActivePollCap,
                }
              : {}),
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
            ...(deps.syncResketchForTests === true ? { resketchForTests: true } : {}),
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
        save: (scope, prior) => {
          const key = scopeKey(scope);
          const live = this.frozenPending.get(key) ?? this.sessionSnapshot(scope);
          this.frozenPending.delete(key);
          const recorded = this.frozenRecorded.get(key) ?? this.recordedSnapshot(scope);
          this.frozenRecorded.delete(key);
          const economy = this.frozenEconomy.has(key) ? this.frozenEconomy.get(key) : this.economy.snapshot(scope);
          this.frozenEconomy.delete(key);
          const yields = this.frozenYields.has(key) ? this.frozenYields.get(key) : this.yields?.snapshot(scope);
          this.frozenYields.delete(key);
          const unverifiable = this.frozenUnverifiable.has(key)
            ? this.frozenUnverifiable.get(key)
            : this.unverifiableSnapshot(key);
          this.frozenUnverifiable.delete(key);
          // D2004: the file on disk may be another process's blob (a failover both served this user), newer
          // than this process's thaw — its rows merge in instead of being replaced, or the later freeze
          // silently drops what the other machine learned.
          const carried = prior as
            | {
                sessions?: unknown;
                recorded?: unknown;
                economy?: unknown;
                yields?: unknown;
                unverifiable?: unknown;
              }
            | null
            | undefined;
          const priorSessions = Array.isArray(carried?.sessions) ? carried.sessions.filter(isFrozenSession) : [];
          const priorRecorded = Array.isArray(carried?.recorded) ? carried.recorded.filter(isFrozenRecorded) : [];
          const mergedEconomy = mergeFrozenEconomy(
            isFrozenEconomy(carried?.economy) ? carried.economy : null,
            economy ?? null,
          );
          const mergedYields = mergeFrozenYields(
            isFrozenYields(carried?.yields) ? carried.yields : null,
            yields ?? null,
          );
          const mergedUnverifiable = mergeFrozenUnverifiable(
            isFrozenUnverifiable(carried?.unverifiable) ? carried.unverifiable : [],
            unverifiable ?? [],
          );
          const mergedRecorded = mergeFrozenRecorded(priorRecorded, recorded ?? []);
          const judged = new Set(mergedRecorded?.map((r) => r.injectionId));
          return {
            sync: sync?.snapshot(scope) ?? null,
            rows: this.deps.sourceMap.exportUser(scope),
            sessions: mergeFrozenSessions(
              priorSessions,
              mergeFrozenSessions(this.restoredSessions.get(key), live, judged),
              judged,
            ),
            recorded: mergedRecorded,
            ...(mergedEconomy ? { economy: mergedEconomy } : {}),
            ...(mergedYields ? { yields: mergedYields } : {}),
            ...(mergedUnverifiable.length ? { unverifiable: mergedUnverifiable } : {}),
          };
        },
        restored: (scope, items, extra) => {
          const carried = extra as
            | {
                sync?: unknown;
                rows?: UserRows;
                sessions?: unknown;
                recorded?: unknown;
                economy?: unknown;
                yields?: unknown;
                unverifiable?: unknown;
              }
            | null
            | undefined;
          const saved = carried?.sync;
          if (sync && saved) sync.restore(scope, saved);
          if (carried?.rows && typeof carried.rows === "object") {
            try {
              this.deps.sourceMap.importUser(scope, carried.rows);
            } catch {
              // Fails open: the user keeps whatever this process's file holds for them (or learns again).
            }
          }
          if (Array.isArray(carried?.sessions)) {
            const frozen = carried.sessions.filter(isFrozenSession);
            if (frozen.length > 0) this.putFrozenSessions(scopeKey(scope), frozen.slice(-MAX_FROZEN_SESSIONS));
          }
          if (Array.isArray(carried?.recorded)) {
            const rec = carried.recorded.filter(isFrozenRecorded).slice(-MAX_RECORDED);
            if (rec.length > 0) this.restoreRecorded(scope, rec);
          }
          if (carried?.economy && isFrozenEconomy(carried.economy)) this.economy.restore(scope, carried.economy);
          if (carried?.yields && isFrozenYields(carried.yields)) this.yields?.restore(scope, carried.yields);
          if (carried?.unverifiable && isFrozenUnverifiable(carried.unverifiable))
            this.restoreUnverifiable(scope, carried.unverifiable);

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
}
/** The names each item mentions, as the source map records them (D57): at most 20 an item, persistable kinds. */
/** The mentions a stored item may name, capped (D57). */
const MAX_MENTIONS = 20;

export function mentionsOf(items: readonly ContextItem[]): { sourceId: string; entities: string[] }[] {
  return items.map((item) => ({
    sourceId: item.sourceId,
    entities: extractTypedEntities(`${item.title}. ${item.text}`, MAX_MENTIONS)
      .filter((e) => PERSISTABLE_KINDS.has(e.kind))
      .slice(0, MAX_MENTIONS)
      .map((e) => e.text),
  }));
}
