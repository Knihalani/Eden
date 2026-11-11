/**
 * How a tenant's integration calls Eden (D852), for `eden doctor`: content-free counts, per tenant, of the calls that
 * show whether each integration obligation is met (docs/INTEGRATION.md's loop). The handler records each accepted
 * request; `/v1/usage` returns the tenant's record as `integration` (the router sums its children's, so every field
 * is a number or a record of numbers).
 *
 * Counts only: no text, no ids, no tool names leave this module. Session ids are held in memory to count sessions
 * (bounded per tenant, least recent dropped), never returned. Counted since the process started, not per day: an
 * obligation is about the integration's code, not today's traffic.
 */

/** Tool names that act on the user's behalf (the Hermes plugin's `ACTING`, D420): a call to one should be checked. */
const ACTING =
  /(?:^|[_\-.])(send|reply|forward|share|invite|invites|book|schedule|pay|transfer|grant|post|purchase|order|create|update|add|respond|deploy)(?=$|[_\-.])/i;

export function isActingTool(name: string): boolean {
  // camelCase as words, as the plugin reads them: sendEmail -> send_Email.
  return ACTING.test(name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_"));
}

/** One tenant's counts. Every field adds across processes (`sumUsage`). */
export interface IntegrationCounts {
  /** Events by kind (`/v1/events`). */
  events: Record<string, number>;
  /** Sent user messages by the wait they asked for: none, under 2 s, 2 s or more (D98, D99). */
  userWait: { none: number; short: number; full: number };
  /** Observes answered `pending: true` (work still running, to be collected before the next model call). */
  pendingReplies: number;
  /** `/v1/pending` calls (how `collect` takes what landed later). */
  pendingCalls: number;
  asks: number;
  checks: number;
  /** Reported `tool_call` events whose tool acts (`isActingTool`), and checks of such tools. */
  actingToolCalls: number;
  actingChecks: number;
  /** Change notices by form: refs, items, removed refs, the bare signal (D347, D421). */
  notices: { refs: number; items: number; removed: number; signals: number };
  feedback: number;
  /** Requests in shadow mode (`?shadow=1`). */
  shadow: number;
  /** Requests refused for their shape or ids (400), counted after the tenant is known. */
  refused: number;
  /**
   * Sessions seen (any session-scoped call), and how many of them: began with `session_start`; reported a user
   * message; reported the agent's side (an agent message, a tool call or a tool result); got a `pending: true` reply;
   * and, of those, called `/v1/pending` afterwards.
   */
  sessions: {
    seen: number;
    started: number;
    startedFirst: number;
    withUser: number;
    withAgent: number;
    gotPending: number;
    tookPending: number;
  };
}

const START = 1;
const USER = 2;
const AGENT = 4;
const GOT_PENDING = 8;
const TOOK_PENDING = 16;
const ANY = 32;

/** Sessions remembered per tenant; past it the least recent go (their flags are then counted afresh if they return). */
const MAX_SESSIONS = 4_096;
/** Tenants remembered; past it the least recent go. */
const MAX_TENANTS = 1_024;

function empty(): IntegrationCounts {
  return {
    events: {},
    userWait: { none: 0, short: 0, full: 0 },
    pendingReplies: 0,
    pendingCalls: 0,
    asks: 0,
    checks: 0,
    actingToolCalls: 0,
    actingChecks: 0,
    notices: { refs: 0, items: 0, removed: 0, signals: 0 },
    feedback: 0,
    shadow: 0,
    refused: 0,
    sessions: { seen: 0, started: 0, startedFirst: 0, withUser: 0, withAgent: 0, gotPending: 0, tookPending: 0 },
  };
}

interface TenantState {
  counts: IntegrationCounts;
  /** Per session (`userId` + session id), its flags; Map order is recency. */
  sessions: Map<string, number>;
}

export class IntegrationStats {
  private readonly tenants = new Map<string, TenantState>();

  private state(tenant: string): TenantState {
    let t = this.tenants.get(tenant);
    if (t) {
      this.tenants.delete(tenant);
      this.tenants.set(tenant, t);
      return t;
    }
    t = { counts: empty(), sessions: new Map() };
    this.tenants.set(tenant, t);
    if (this.tenants.size > MAX_TENANTS) this.tenants.delete(this.tenants.keys().next().value!);
    return t;
  }

  /** Sets a session's flag, counting the session and the flag the first time each is seen. */
  private flag(t: TenantState, userId: string, sessionId: string, bit: number): void {
    const key = `${userId}\u0000${sessionId}`;
    const was = t.sessions.get(key);
    const flags = was ?? 0;
    if (was !== undefined) t.sessions.delete(key);
    const s = t.counts.sessions;
    if (!(flags & ANY)) s.seen++;
    // A session_start that is the session's first call: Eden started reading before the first request (D755).
    if (bit === START && !(flags & ANY)) s.startedFirst++;
    const now = flags | ANY | bit;
    if (!(flags & bit)) {
      if (bit === START) s.started++;
      else if (bit === USER) s.withUser++;
      else if (bit === AGENT) s.withAgent++;
      else if (bit === GOT_PENDING) s.gotPending++;
      else if (bit === TOOK_PENDING) s.tookPending++;
    }
    t.sessions.set(key, now);
    if (t.sessions.size > MAX_SESSIONS) t.sessions.delete(t.sessions.keys().next().value!);
  }

  /** An accepted event (`/v1/events`), with the wait it asked for and whether the reply was `pending`. */
  event(
    tenant: string,
    e: { kind: string; userId: string; sessionId: string; tool?: unknown; draft?: unknown },
    waitMs: number,
    pending: boolean,
    shadow: boolean,
  ): void {
    const t = this.state(tenant);
    const c = t.counts;
    c.events[e.kind] = (c.events[e.kind] ?? 0) + 1;
    if (shadow) c.shadow++;
    if (e.kind === "user_message" && e.draft !== true) {
      if (waitMs <= 0) c.userWait.none++;
      else if (waitMs < 2_000) c.userWait.short++;
      else c.userWait.full++;
    }
    if (e.kind === "tool_call" && typeof e.tool === "string" && isActingTool(e.tool)) c.actingToolCalls++;
    const bit =
      e.kind === "session_start"
        ? START
        : e.kind === "user_message"
          ? USER
          : e.kind === "agent_message" || e.kind === "tool_call" || e.kind === "tool_result"
            ? AGENT
            : 0;
    this.flag(t, e.userId, e.sessionId, bit);
    if (pending) {
      c.pendingReplies++;
      this.flag(t, e.userId, e.sessionId, GOT_PENDING);
    }
  }

  pending(tenant: string, userId: string, sessionId: string, shadow: boolean): void {
    const t = this.state(tenant);
    t.counts.pendingCalls++;
    if (shadow) t.counts.shadow++;
    const flags = t.sessions.get(`${userId}\u0000${sessionId}`) ?? 0;
    // Only a take after a `pending` reply counts as collecting it; a session that polls first is not yet doing so.
    if (flags & GOT_PENDING) this.flag(t, userId, sessionId, TOOK_PENDING);
    else this.flag(t, userId, sessionId, 0);
  }

  ask(tenant: string, userId: string, sessionId: string): void {
    const t = this.state(tenant);
    t.counts.asks++;
    this.flag(t, userId, sessionId, 0);
  }

  check(tenant: string, tool: unknown): void {
    const c = this.state(tenant).counts;
    c.checks++;
    if (typeof tool === "string" && isActingTool(tool)) c.actingChecks++;
  }

  notice(tenant: string, form: keyof IntegrationCounts["notices"]): void {
    this.state(tenant).counts.notices[form]++;
  }

  feedback(tenant: string): void {
    this.state(tenant).counts.feedback++;
  }

  refused(tenant: string): void {
    this.state(tenant).counts.refused++;
  }

  /** The tenant's counts (a copy); zeros for a tenant never seen. */
  of(tenant: string): IntegrationCounts {
    const t = this.tenants.get(tenant);
    return structuredClone(t ? t.counts : empty());
  }
}
