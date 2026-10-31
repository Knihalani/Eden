/**
 * Anticipation (`anticipate`, off by default; docs/research/moon-anticipate.md): Eden reads each event of a session
 * (a user message, a draft the user is still typing, a tool call, a tool result, an arriving message) for what the
 * agent will likely need next, and fetches it in the background, before the request that needs it arrives. The
 * request's probes then find their answers in the user's probe memo at no call, and a no-model decision can be made
 * from the cache at once, on the critical path, while the live search runs behind it.
 *
 * Everything here is a fixed, linear read of a bounded head of the event: no model, no network. The prediction is
 * - the names the event mentions (people, organisations, systems), as the request's own probes would send them;
 * - the days it names, listed when it schedules;
 * - its intent: the action class (`consequence.ts`) of an imperative or arriving message, else its situation;
 * - what the user's own history says follows that intent: the names in what was delivered after it before
 *   (`IntentPatterns`, learned per user, bounded, dropped on forget).
 */
import { scopeKey, type Scope } from "@eden/protocol";
import { actionClass, type ActionClass } from "./consequence";
import { timeWindow } from "./grounding";
import { cleanEntities, isImperative, isScheduling } from "./probes";
import { classifySituation } from "./situation";
import { extractEntities } from "./text";

/**
 * Characters of an event read for a prediction. A tool result can be 32 KB; its head says what it is about, and the
 * regexes read here (the scheduling words, entities, days) are linear but run on every event, so the head bounds them.
 */
export const PREDICT_CHARS = 600;
/** Names taken from one event: a tool result listing twenty senders is not twenty needs. */
export const PREDICT_NAMES = 2;

export interface Prediction {
  /** Names the event mentions, cleaned as a request's probes clean them (`cleanEntities`). */
  names: string[];
  /** Days the event names (ISO, the user's wall clock), when it schedules something; empty otherwise. */
  days: string[];
  /** The event's action class, when it acts (an imperative, or a message arriving from outside). */
  cls: ActionClass | null;
  /** The intent the user's patterns are learned under: the action class's id, else the situation label. */
  intent: string;
  /** The bounded head that was read: what a synthetic cue for the prefetch is built from. */
  head: string;
}

/**
 * What an event says the agent will need next. `external` marks a message arriving from outside, which acts whatever
 * its wording (as `consequence.ts` treats it). Linear in `PREDICT_CHARS`.
 */
export function predict(text: string, at: number, offsetMinutes: number, external = false): Prediction {
  const head = text.slice(0, PREDICT_CHARS);
  const names = cleanEntities(extractEntities(head)).slice(0, PREDICT_NAMES);
  const window = isScheduling(head) ? timeWindow(head, at, offsetMinutes) : null;
  const days = window ? [...window.days].sort().slice(0, 7) : [];
  const cls = actionClass(head, external || isImperative(head));
  return { names, days, cls, intent: cls?.id ?? classifySituation(head), head };
}

/** Intents remembered per user, names per intent, and users per tenant (`IntentPatterns`). */
const MAX_INTENTS = 16;
const MAX_NAMES = 8;
const MAX_USERS_PER_TENANT = 10_000;
/** A learned name is prefetched for an intent once it followed that intent this many times. */
export const FOLLOW_MIN = 2;

interface UserPatterns {
  tenantId: string;
  /** Intent → name (lower case) → how often a delivery after that intent named it; least recently noted first. */
  follows: Map<string, Map<string, { name: string; n: number; sources: Set<string> }>>;
}

/**
 * The user's recurring patterns: which names (and the sources that held them) followed which intents, learned from
 * what was delivered after a request of that intent ("pay" requests followed by the finance team's notices, "release"
 * requests by the platform channel's). Per user, bounded, never shared across users: no content leaves the user's
 * own record, and names are those the user's own items carry.
 */
export class IntentPatterns {
  private readonly users = new Map<string, UserPatterns>();
  private readonly perTenant = new Map<string, number>();

  /** Notes that a delivery after a request of `intent` named `names` and came from `sourceIds`. */
  note(scope: Scope, intent: string, names: readonly string[], sourceIds: readonly string[]): void {
    if (!intent || names.length === 0) return;
    const u = this.user(scope);
    let follows = u.follows.get(intent);
    if (!follows) {
      if (u.follows.size >= MAX_INTENTS) u.follows.delete(u.follows.keys().next().value!);
      follows = new Map();
    }
    u.follows.delete(intent); // Re-insert: least recently noted intent first.
    u.follows.set(intent, follows);
    for (const name of names.slice(0, MAX_NAMES)) {
      const key = name.toLowerCase();
      const had = follows.get(key) ?? { name, n: 0, sources: new Set<string>() };
      had.n++;
      for (const id of sourceIds) if (had.sources.size < MAX_NAMES) had.sources.add(id);
      follows.delete(key);
      follows.set(key, had);
      while (follows.size > MAX_NAMES) follows.delete(follows.keys().next().value!);
    }
  }

  /** The names that followed `intent` at least `FOLLOW_MIN` times for this user, most often first; at most `max`. */
  follows(scope: Scope, intent: string, max = 1): string[] {
    const f = this.users.get(scopeKey(scope))?.follows.get(intent);
    if (!f) return [];
    return [...f.values()]
      .filter((x) => x.n >= FOLLOW_MIN)
      .sort((a, b) => b.n - a.n)
      .slice(0, max)
      .map((x) => x.name);
  }

  /** Drops the user's patterns, or only what one source contributed (a name held only by it goes too). */
  forget(scope: Scope, sourceId?: string): void {
    const key = scopeKey(scope);
    const u = this.users.get(key);
    if (!u) return;
    if (sourceId === undefined) {
      this.users.delete(key);
      const n = (this.perTenant.get(scope.tenantId) ?? 1) - 1;
      if (n <= 0) this.perTenant.delete(scope.tenantId);
      else this.perTenant.set(scope.tenantId, n);
      return;
    }
    for (const follows of u.follows.values()) {
      for (const [k, x] of follows) {
        x.sources.delete(sourceId);
        if (x.sources.size === 0) follows.delete(k);
      }
    }
  }

  /** Users with patterns kept (tests). */
  get userCount(): number {
    return this.users.size;
  }

  private user(scope: Scope): UserPatterns {
    const key = scopeKey(scope);
    const had = this.users.get(key);
    if (had) {
      this.users.delete(key); // Re-insert: least recently used user first.
      this.users.set(key, had);
      return had;
    }
    // One tenant's users never push out another's: past its cap, the tenant's own least recent user goes.
    if ((this.perTenant.get(scope.tenantId) ?? 0) >= MAX_USERS_PER_TENANT) {
      for (const [k, v] of this.users) {
        if (v.tenantId !== scope.tenantId) continue;
        this.users.delete(k);
        this.perTenant.set(scope.tenantId, (this.perTenant.get(scope.tenantId) ?? 1) - 1);
        break;
      }
    }
    const made: UserPatterns = { tenantId: scope.tenantId, follows: new Map() };
    this.users.set(key, made);
    this.perTenant.set(scope.tenantId, (this.perTenant.get(scope.tenantId) ?? 0) + 1);
    return made;
  }
}
