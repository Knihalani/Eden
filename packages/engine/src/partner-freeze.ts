/**
 * The frozen-user blob's session/verdict slice (D1995-D2004): what a `release`d user's blob keeps of live
 * sessions, use-verdicts and held re-reads, and the merges that union two processes' writes to it. Everything
 * here is JSON-safe and shape-checked on read (`isFrozen*`) so an unknown blob fails open.
 */
import type { LedgerSnapshot } from "./ledger";
import type { Sketch } from "./cache";
import type { Recorded, Session } from "./partner";

/** `recorded` rows kept per user in the blob (newest kept); also the live map's cap. */
export const MAX_RECORDED = 200;
/** `unverifiable` re-read rows kept per user in the blob and live (newest kept). */
export const FROZEN_UNVERIFIABLE = 512;

/**
 * What a frozen user keeps of a live session's delivery knowledge (its blob's `extra.sessions`): the ledger
 * snapshot and the delivered list, JSON-safe so the blob's zstd JSON carries it. A restored user's next sessions
 * are seeded from it, so a daemon respawned between turns does not hand the agent the same packet again.
 */
export interface FrozenSession {
  /** The saved session's key: a restored blob seeds only a session that continues it, never a new conversation. */
  sessionId: string;
  /** The saved session's turn at write: `Ledger.seed` re-anchors by it so elapsed cooldown turns still count. */
  turn: number;
  ledger: LedgerSnapshot;
  delivered: { sketch: Sketch | null; refs: string[]; turn: number; terms: string[]; years: number[] }[];
  /**
   * Injections handed but not yet judged used or unused (`Session.outstanding`): a respawn without it loses the
   * usage signal for everything the agent held, so the source map learns nothing from those deliveries.
   * `tokens` are vocabulary ids per session, so they ride the blob as term strings, re-interned on the seed.
   */
  outstanding?: {
    injectionId: string;
    sourceIds: string[];
    situation: string;
    terms: string[];
    deliveredTurn: number;
    /** The handed injection's UTF-8 size (`Outstanding.bytes`): a respawn's usage record still names it. */
    bytes?: number;
    /** `Outstanding.warning`: a respawn must keep it or a retried call is wrongly credited. */
    warning?: boolean;
  }[];
}

/** Shape check for a `FrozenSession` read back from a blob: anything else is ignored (fails open). */
export function isFrozenSession(x: unknown): x is FrozenSession {
  const s = x as FrozenSession | null;
  return (
    s !== null &&
    typeof s === "object" &&
    s.ledger !== null &&
    typeof s.ledger === "object" &&
    Array.isArray(s.ledger.delivered) &&
    Array.isArray(s.ledger.versions) &&
    Array.isArray(s.ledger.shown) &&
    Array.isArray(s.delivered) &&
    typeof s.sessionId === "string" &&
    typeof s.turn === "number" &&
    (s.outstanding === undefined ||
      (Array.isArray(s.outstanding) &&
        s.outstanding.every(
          (o) =>
            o !== null &&
            typeof o === "object" &&
            typeof o.injectionId === "string" &&
            Array.isArray(o.sourceIds) &&
            typeof o.situation === "string" &&
            Array.isArray(o.terms) &&
            typeof o.deliveredTurn === "number" &&
            (o.bytes === undefined || typeof o.bytes === "number") &&
            (o.warning === undefined || typeof o.warning === "boolean"),
        )))
  );
}

/** A `Recorded` row frozen with its injection id: feedback can still correct an ended session's verdict. */
export interface FrozenRecorded extends Recorded {
  injectionId: string;
}

/**
 * A user's `unverifiable` rows as a frozen list of `[item id, {mark, at}]` — the least recently noted first, so a
 * `slice(-FROZEN_UNVERIFIABLE)` keeps the freshest (D2003).
 */
export type FrozenUnverifiable = [string, { mark: number; at: number }][];

/** Shape check for a `FrozenRecorded` read back from a blob: anything else is ignored (fails open). */
export function isFrozenRecorded(x: unknown): x is FrozenRecorded {
  const r = x as FrozenRecorded | null;
  return (
    r !== null &&
    typeof r === "object" &&
    typeof r.injectionId === "string" &&
    Array.isArray(r.sourceIds) &&
    typeof r.situation === "string" &&
    typeof r.used === "boolean" &&
    typeof r.sessionId === "string" &&
    (r.pending === undefined || typeof r.pending === "boolean")
  );
}

/** Shape check for `FrozenUnverifiable` rows read back from a blob: anything else is ignored (fails open). */
export function isFrozenUnverifiable(x: unknown): x is FrozenUnverifiable {
  return (
    Array.isArray(x) &&
    x.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 2 &&
        typeof row[0] === "string" &&
        typeof row[1] === "object" &&
        row[1] !== null &&
        typeof (row[1] as { mark?: unknown }).mark === "number" &&
        typeof (row[1] as { at?: unknown }).at === "number",
    )
  );
}

/**
 * A live session's delivery knowledge as a frozen record: items of packets still queued were never handed, so
 * their build-time marks are left out (BUG_0002); `shown` stays, since a queued REVISION's earlier copies really
 * were handed, and their `times` feed `revisionDiff` (BUG_0001). Null when the session handed nothing.
 */
export function freezeSession(s: Session): FrozenSession | null {
  const queued = new Set<string>();
  for (const p of s.pending) for (const c of p.citations) queued.add(c.itemId);
  const snap = s.ledger.snapshot();
  const ledger: LedgerSnapshot = queued.size
    ? {
        delivered: snap.delivered.filter(([id]) => !queued.has(id)),
        versions: snap.versions.filter(([id]) => !queued.has(id)),
        shown: snap.shown,
      }
    : snap;
  const delivered = s.delivered
    .filter((d) => d.itemId === undefined || !queued.has(d.itemId))
    .map((d) => ({ ...d, refs: [...d.refs], terms: [...d.terms], years: [...d.years] }));
  if (ledger.delivered.length === 0 && ledger.shown.length === 0 && delivered.length === 0) return null;
  const outstanding = [...s.outstanding.values()].map((o) => ({
    injectionId: o.injectionId,
    sourceIds: [...o.sourceIds],
    situation: o.situation,
    terms: [...o.tokens].map((id) => s.vocab.term(id)),
    deliveredTurn: o.deliveredTurn,
    bytes: o.bytes,
    warning: o.warning,
  }));
  return { sessionId: s.id, turn: s.turn, ledger, delivered, outstanding };
}

/**
 * The blob's `sessions`: the live sessions' snapshot plus frozen entries this process holds for sessions the
 * snapshot does not (an evicted one the agent may still continue). A live snapshot wins on its sessionId; bounded.
 */
export function mergeFrozenSessions(
  frozen: FrozenSession[] | undefined,
  live: FrozenSession[] | null,
  judged?: ReadonlySet<string>,
): FrozenSession[] | null {
  const liveIds = new Set((live ?? []).map((f) => f.sessionId));
  const out = (frozen ?? []).filter((f) => !liveIds.has(f.sessionId));
  out.push(...(live ?? []));
  // An injectionId the merged `recorded` already judged is not outstanding: kept, a continued session would
  // seed it and the delivery counts a second verdict (review of D2004).
  if (judged) {
    for (const f of out) {
      if (f.outstanding?.length) {
        const left = f.outstanding.filter((o) => !judged.has(o.injectionId));
        f.outstanding = left.length ? left : undefined;
      }
    }
  }
  const cut = out.slice(-MAX_FROZEN_SESSIONS);
  return cut.length ? cut : null;
}

/**
 * Unions a disk blob's `recorded` rows with this save's (D2004): keyed by injectionId, this process's rows
 * win a collision — they are the newest write — and the tail holds the freshest in map order.
 */
export function mergeFrozenRecorded(prior: FrozenRecorded[], live: FrozenRecorded[]): FrozenRecorded[] | null {
  const out = new Map<string, FrozenRecorded>(prior.map((r) => [r.injectionId, r]));
  for (const r of live) out.set(r.injectionId, r);
  const rows = [...out.values()].slice(-MAX_RECORDED);
  return rows.length ? rows : null;
}

/** Unions two blobs' `unverifiable` rows (D2004): per item the newer `at` wins; the freshest are kept. */
export function mergeFrozenUnverifiable(prior: FrozenUnverifiable, live: FrozenUnverifiable): FrozenUnverifiable {
  const out = new Map<string, { mark: number; at: number }>(prior);
  for (const [id, r] of live) {
    const old = out.get(id);
    if (!old || r.at >= old.at) out.set(id, r);
  }
  return [...out].slice(-FROZEN_UNVERIFIABLE);
}

/** Frozen sessions kept per user (`restoredSessions`): an old one's knowledge still applies, bounded. */
export const MAX_FROZEN_SESSIONS = 8;
/**
 * Users `restoredSessions` holds at once. A user can leave the cache without a `release` (`expireIdle` drops them
 * whole and only the cards hook hears it), so evicted-session knowledge (D1999) must stay bounded across churn.
 */
export const MAX_FROZEN_USERS = 256;
