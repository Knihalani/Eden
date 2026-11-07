import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import {
  itemId,
  type AgentEvent,
  type AskResponse,
  type ContextItem,
  type Injection,
  type Scope,
} from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import type { EngineConfig } from "./config";
import { ContextPartner } from "./partner";
import { AskReader, type ReaderInput, type ReaderMaker } from "./reader";
import { explainTrace } from "./trace";

// A seeded fuzz world for the engine's state machine (`fuzz.test.ts`): two tenants with two users each, two sessions
// per user, one notifying, listable, re-readable source per user whose items the plan adds, edits and deletes, and
// source calls that answer after a seeded number of microtask or timer turns, so events, asks, takes, notices,
// removals and session ends interleave. Every hand-out is checked against invariants that hold whatever the order
// (`Violation`). The plan is data made from one seed; the scheduling draws from a second stream of the same seed, so a
// plan with ops removed (`minimize`) still runs deterministically, apart from the engine's own wall-clock timers.

/** mulberry32: a small seeded PRNG, uniform on [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Monday 2 November 2026, 09:00 UTC. */
export const T0 = Date.UTC(2026, 10, 2, 9);
const SOURCE = "mail";

// Secret-shaped strings, assembled from parts so no scanner reads this file as holding one.
export const AWS_KEY = "AK" + "IA" + "QWERTYUIOPASDFGH";
export const GH_TOKEN = "gh" + "p_" + "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5";
const PHRASE = ["violet", "tractor", "mango", "seven"].join(" ");
/** What must never reach the agent: the raw secrets, and the tail of the quoted phrase (audit A5's bug 1). */
export const SECRET_PIECES = [AWS_KEY, GH_TOKEN, "tractor mango", "mango seven"];

/** Topics: a constraint-worded sentence (so the rule paths, the gates and the candidates have something to take). */
const TOPICS = [
  {
    title: "Harlow invoice",
    text: (h: number) => `Payments to Harlow are on hold until the dispute over the venue deposit ends at ${h}:00.`,
    ask: ["Pay the Harlow invoice today", "Is the Harlow invoice on hold?", "Send the Harlow venue deposit"],
  },
  {
    title: "Lisbon offsite",
    text: (h: number) => `The quarterly offsite in Lisbon moved to ${h}:30 on 12 November; book flights before Friday.`,
    ask: ["Book flights for the Lisbon offsite", "When is the quarterly offsite in Lisbon?"],
  },
  {
    title: "Budget review",
    text: (h: number) => `The budget review with finance is at ${h}:00 on Friday; do not send the deck before legal.`,
    ask: ["Send the budget review deck to finance", "When is the budget review with finance?"],
  },
  {
    title: "Dentist appointment",
    text: (h: number) => `Dentist appointment with Dr Okafor on Tuesday at ${h}:00, cancel a day ahead or pay the fee.`,
    ask: ["Reschedule the dentist appointment with Dr Okafor", "Cancel the dentist appointment"],
  },
  {
    title: "Atlas migration",
    text: (h: number) => `The Atlas server migration is frozen until the security audit ends; window opens ${h}:00.`,
    ask: ["Start the Atlas server migration tonight", "Can we run the Atlas migration?"],
  },
  {
    title: "Acme renewal",
    text: (h: number) => `The Acme contract renewal needs the signed NDA first; Priya owns it, call at ${h}:15.`,
    ask: ["Renew the Acme contract with Priya", "Who owns the Acme contract renewal?"],
  },
  {
    title: "Lunch",
    text: (h: number) => `Lunch with Sam at the canteen at ${h}:45.`,
    ask: ["Order lunch for the team", "Where is lunch with Sam?"],
  },
];

const tenantsOf = ["t0", "t1"];
const usersOf = ["u0", "u1"];
const sessionsOf = ["s0", "s1"];

export interface User {
  scope: Scope;
  /** `t0u1`: in every ref, item id and planted marker of this user, and of no other. */
  tag: string;
  source: FakeSource;
}

interface Doc {
  topic: number;
  rev: number;
  hour: number;
  secret: number;
  updatedAt: number;
}

/** One user's connector: search, fetch (a null means gone), list newest first, notifies. */
export class FakeSource implements Source {
  readonly id = SOURCE;
  readonly kind = "test";
  readonly description = "the user's mail, calendar and notes";
  readonly notifies = true;
  readonly fetchReportsGone = true;
  readonly docs = new Map<string, Doc>();
  /** Refs the plan deleted (for re-adds). */
  readonly deleted = new Map<string, Doc>();
  next = 0;
  constructor(
    private readonly world: World,
    readonly owner: Scope,
    readonly tag: string,
  ) {}

  marker(ref: string): string {
    return `zq${ref.replace("-", "")}`;
  }

  item(ref: string): ContextItem | null {
    const d = this.docs.get(ref);
    if (!d) return null;
    const t = TOPICS[d.topic]!;
    const secret =
      d.secret === 1
        ? ` Deploy key ${AWS_KEY} for the bucket.`
        : d.secret === 2
          ? ` vpn password: "${PHRASE}" ok.`
          : "";
    // The title carries the revision, so a citation names the version it handed out.
    const title = `${t.title} ${this.marker(ref)} v${d.rev}${d.secret === 3 ? ` ${GH_TOKEN}` : ""}`;
    return {
      id: itemId(SOURCE, ref),
      sourceId: SOURCE,
      ref,
      title,
      text: `${t.text(d.hour)} Ref ${this.marker(ref)}.${secret}`,
      updatedAt: d.updatedAt,
    };
  }

  private checkScope(scope: Scope | undefined, call: string): void {
    if (scope && (scope.tenantId !== this.owner.tenantId || scope.userId !== this.owner.userId)) {
      this.world.violate("isolation", `${call} on ${this.tag}'s source with scope ${scope.tenantId}/${scope.userId}`);
    }
  }

  async search(q: SearchQuery, _signal: AbortSignal): Promise<ContextItem[]> {
    await this.world.jitter();
    this.world.maybeFail("search");
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return [...this.docs.keys()]
      .map((r) => this.item(r)!)
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }

  async fetch(ref: string, scope: Scope, _signal: AbortSignal): Promise<ContextItem | null> {
    this.checkScope(scope, "fetch");
    await this.world.jitter();
    this.world.maybeFail("fetch");
    return this.item(ref);
  }

  async list(scope: Scope, cursor: string | undefined, limit: number, _signal: AbortSignal): Promise<ListPage> {
    this.checkScope(scope, "list");
    await this.world.jitter();
    this.world.maybeFail("list");
    const sorted = [...this.docs.keys()]
      .map((r) => this.item(r)!)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

/** Flags nothing (the default's candidates push makes no call with it, D237). */
class StubReader implements ReaderMaker {
  calls = 0;
  async read(input: ReaderInput) {
    this.calls++;
    return {
      bears: [],
      rejected: input.items.map((_, k) => k),
      costUsd: 0.0001,
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    };
  }
}

export type OpKind =
  | "user"
  | "agent"
  | "tool"
  | "ask"
  | "take"
  | "add"
  | "edit"
  | "delete"
  | "readd"
  | "end"
  | "forget"
  | "clock"
  | "midnight"
  | "tick"
  | "settle";

/** One planned operation: which, on whom, and the draws its details are resolved from at run time. */
export interface Op {
  kind: OpKind;
  user: number;
  session: number;
  /** Uniform draws on [0, 1), resolved against the world's state when the op runs. */
  r: [number, number, number, number];
  /** Run in the background (not awaited before the next op). */
  bg: boolean;
}

const WEIGHTS: [OpKind, number][] = [
  ["user", 14],
  ["agent", 4],
  ["tool", 5],
  ["ask", 9],
  ["take", 10],
  ["add", 5],
  ["edit", 8],
  ["delete", 5],
  ["readd", 2],
  ["end", 3],
  ["forget", 1],
  ["clock", 5],
  ["midnight", 1],
  ["tick", 5],
  ["settle", 4],
];
const TOTAL = WEIGHTS.reduce((n, [, w]) => n + w, 0);

export function plan(seed: number, ops: number): Op[] {
  const rng = mulberry32(seed);
  const out: Op[] = [];
  for (let k = 0; k < ops; k++) {
    let x = rng() * TOTAL;
    let kind: OpKind = "user";
    for (const [name, w] of WEIGHTS) {
      if ((x -= w) < 0) {
        kind = name;
        break;
      }
    }
    out.push({
      kind,
      user: Math.floor(rng() * 4),
      session: Math.floor(rng() * 2),
      r: [rng(), rng(), rng(), rng()],
      bg: rng() < 0.4,
    });
  }
  return out;
}

export interface Violation {
  invariant: string;
  detail: string;
  /** Index of the op whose result showed it (-1: at the end). */
  at: number;
}

/** A hand-out to the agent, as the invariants see it. */
interface HandOut {
  user: User;
  sessionId: string;
  via: "observe" | "take" | "ask";
  text: string;
  citations: { itemId: string; title: string }[];
  injection?: Injection;
  /** The op index that started the call. */
  op: number;
}

interface SessionState {
  open: boolean;
  /** Turns the harness counted since the session (re)opened: events, as `observe` counts them. */
  turn: number;
  lastActive: number;
  /** Not-twice: `itemId \0 title` → the turn and op it was handed in, its reason, whether a candidates push. */
  handed: Map<string, { turn: number; candidates: boolean; op: number; reason: string }>;
}

export interface WorldOptions {
  config: Partial<EngineConfig>;
  /** Source calls fail at this rate (an error, which every path must survive). */
  failRate?: number;
  /** No reader dependency (a server with no model key; the candidates push still runs, D276). */
  noReader?: boolean;
  /** Check the not-twice invariant (proactive packets). */
  notTwice?: boolean;
}

export class World {
  readonly partner: ContextPartner;
  readonly users: User[] = [];
  readonly violations: Violation[] = [];
  readonly log: string[] = [];
  clock = T0;
  private readonly sched: () => number;
  private readonly sessions = new Map<string, SessionState>();
  /** By item id: the op after whose settle a removal stands; cleared when the plan re-adds the ref. */
  private readonly removed = new Map<string, { op: number; at: number; settledAfter: number | null }>();
  private readonly inflight = new Set<Promise<unknown>>();
  private opIndex = -1;
  private readonly cooldown: number;
  private readonly idleMs: number;
  handOuts = 0;
  citedItems = 0;

  constructor(
    seed: number,
    private readonly opts: WorldOptions,
  ) {
    this.sched = mulberry32(seed ^ 0x9e3779b9);
    const now = () => this.clock;
    this.partner = new ContextPartner({
      sources: async (sc) => {
        const u = this.users.find((x) => x.scope.tenantId === sc.tenantId && x.scope.userId === sc.userId);
        return u ? [u.source] : [];
      },
      sourceMap: new SourceMap(":memory:", { seed: 1 }),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now,
      ...(opts.noReader ? {} : { reader: new AskReader({ maker: new StubReader(), budget: new Budget(), now }) }),
      config: opts.config,
    });
    this.cooldown = 40;
    this.idleMs = this.partner.config.sessionIdleMs;
    for (const t of tenantsOf) {
      for (const u of usersOf) {
        const scope = { tenantId: t, userId: u };
        const tag = `${t}${u}`;
        const user: User = { scope, tag, source: null as unknown as FakeSource };
        user.source = new FakeSource(this, scope, tag);
        this.users.push(user);
        // Each user starts with one item per topic, a few with a planted secret.
        for (let k = 0; k < TOPICS.length; k++) this.addDoc(user, k, Math.floor(this.sched() * 4));
      }
    }
  }

  violate(invariant: string, detail: string): void {
    this.violations.push({ invariant, detail, at: this.opIndex });
  }

  /** 0-3 turns of the microtask queue or the timer queue, drawn from the scheduling stream. */
  async jitter(): Promise<void> {
    const n = Math.floor(this.sched() * 4);
    for (let k = 0; k < n; k++) {
      if (this.sched() < 0.5) await Promise.resolve();
      else await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  maybeFail(call: string): void {
    if ((this.opts.failRate ?? 0) > 0 && this.sched() < this.opts.failRate!) throw new Error(`fuzz: ${call} failed`);
  }

  private addDoc(user: User, topic: number, secret: number): string {
    const ref = `${user.tag}-n${user.source.next++}`;
    user.source.docs.set(ref, { topic, rev: 1, hour: 8 + topic, secret, updatedAt: this.clock });
    return ref;
  }

  private state(user: User, sessionId: string): SessionState {
    const key = `${user.tag}#${sessionId}`;
    let st = this.sessions.get(key);
    if (!st) {
      st = { open: false, turn: 0, lastActive: this.clock, handed: new Map() };
      this.sessions.set(key, st);
    }
    return st;
  }

  /** A call that opens (or keeps open) a session: an event other than its end, or an ask. */
  private touch(user: User, sessionId: string, event: boolean): SessionState {
    const st = this.state(user, sessionId);
    // A session idle past `sessionIdleMs` may have been swept: its ledger went with it.
    if (!st.open || this.clock - st.lastActive >= this.idleMs) {
      st.turn = 0;
      st.handed.clear();
    }
    st.open = true;
    st.lastActive = this.clock;
    if (event) st.turn++;
    return st;
  }

  private closeSession(user: User, sessionId: string): void {
    const st = this.state(user, sessionId);
    st.open = false;
    st.handed.clear();
  }

  private openCount(): number {
    let n = 0;
    for (const st of this.sessions.values()) if (st.open) n++;
    return n;
  }

  // ── invariants ──

  private check(h: HandOut): void {
    this.handOuts++;
    this.citedItems += h.citations.length;
    const own = h.user.tag;
    const others = this.users.filter((u) => u.tag !== own);
    const all = [h.text, ...h.citations.map((c) => c.title)].join("\n");
    // 1. Isolation (D9): nothing of another user's.
    for (const o of others) {
      if (all.includes(`zq${o.tag}`) || h.citations.some((c) => c.itemId.includes(`${o.tag}-`))) {
        this.violate("isolation", `${h.via} for ${own}/${h.sessionId} carries ${o.tag}'s item`);
      }
    }
    for (const c of h.citations) {
      if (!c.itemId.startsWith(`${SOURCE}:${own}-`)) {
        this.violate("isolation", `${h.via} for ${own} cites ${c.itemId}`);
      }
    }
    // 2. Redaction (D10).
    for (const piece of SECRET_PIECES) {
      if (all.includes(piece)) this.violate("redaction", `${h.via} for ${own}/${h.sessionId} carries "${piece}"`);
    }
    // 3. Envelope (D11): every planted marker sits inside a `<context …>…</context>` span.
    const spans: [number, number][] = [];
    const open = /<context [^\n]*?>/g;
    for (let m = open.exec(h.text); m; m = open.exec(h.text)) {
      const end = h.text.indexOf("</context>", m.index);
      spans.push([m.index, end < 0 ? -1 : end]);
      if (end < 0) this.violate("envelope", `${h.via} for ${own}: an unclosed <context>`);
    }
    const marker = /zq[a-z0-9]+/g;
    for (let m = marker.exec(h.text); m; m = marker.exec(h.text)) {
      const at = m.index;
      if (!spans.some(([a, b]) => at > a && (b < 0 || at < b))) {
        this.violate("envelope", `${h.via} for ${own}: "${m[0]}" outside the data envelope`);
      }
    }
    // 4. Deletes (D126): a removal that stood and settled before this call started is never cited. A packet built
    // before the removal (its `createdAt` is earlier: the removal moves the clock 1 ms) and handed out after it is
    // "deletes-queued": `dropGone` leaves queued packets as they are (see the report in `fuzz.test.ts`).
    for (const c of h.citations) {
      const r = this.removed.get(c.itemId);
      if (r && r.settledAfter !== null && h.op > r.settledAfter) {
        const queued = h.injection !== undefined && h.injection.createdAt < r.at;
        this.violate(
          queued ? "deletes-queued" : "deletes",
          `${h.via} at op ${h.op} for ${own}/${h.sessionId} cites ${c.itemId}, removed at op ${r.op} (settled at op ` +
            `${r.settledAfter}); ` +
            (h.injection ? `${h.injection.reason}, built ${h.injection.createdAt - r.at} ms after it` : "ask"),
        );
      }
    }
    // 7. Not-twice (D13): a proactive packet does not repeat an item version within the cooldown, but for the push
    // and the rule paths racing within one request (documented, docs/research/cl-cl8.md "Repeats") and updates.
    if (this.opts.notTwice && h.injection && h.injection.mode === "proactive" && h.via !== "ask") {
      const reason = h.injection.reason;
      if (reason.startsWith("updated:")) return;
      const st = this.state(h.user, h.sessionId);
      if (!st.open) return;
      const candidates = reason.startsWith("candidates:");
      for (const c of h.citations) {
        const key = `${c.itemId}\u0000${c.title}`;
        const was = st.handed.get(key);
        if (was && st.turn - was.turn < this.cooldown) {
          // The push and the rule paths look side by side (for one request, or two that overlap), each tests the
          // ledger before its awaits, and the slower one may deliver what the faster just did: a known race, kept
          // (docs/research/cl-cl8.md, "Repeats"; D258 deleted `pushCandidateDedup`, which saved nothing).
          const race = was.candidates !== candidates;
          if (!race) {
            this.violate(
              "not-twice",
              `${own}/${h.sessionId}: ${c.itemId} "${c.title}" handed at op ${was.op} (turn ${was.turn}, ` +
                `${was.reason}) and again at op ${h.op} (turn ${st.turn}, ${reason})`,
            );
          }
        }
        st.handed.set(key, { turn: st.turn, candidates, op: h.op, reason });
      }
    }
  }

  /** 1. Isolation of what `explain` keeps (D277): a session's traces name only its own items and itself. */
  private checkExplain(user: User, sessionId: string): void {
    for (const t of this.partner.explain({ ...user.scope, sessionId })) {
      const said = explainTrace(t);
      if (t.sessionId !== sessionId)
        this.violate("isolation", `explain for ${user.tag}/${sessionId} has ${t.sessionId}`);
      for (const id of t.itemIds) {
        if (!id.startsWith(`${SOURCE}:${user.tag}-`)) {
          this.violate("isolation", `explain for ${user.tag}/${sessionId} names ${id}`);
        }
      }
      for (const o of this.users) {
        if (o.tag !== user.tag && (said.includes(`${o.tag}-`) || said.includes(`zq${o.tag}`))) {
          this.violate("isolation", `explain for ${user.tag}/${sessionId} says ${o.tag}'s item: ${said}`);
        }
      }
    }
  }

  private injectionOut(user: User, sessionId: string, via: HandOut["via"], i: Injection, op: number): void {
    if (i.tenantId !== user.scope.tenantId || i.userId !== user.scope.userId || i.sessionId !== sessionId) {
      this.violate("isolation", `${via} for ${user.tag}/${sessionId} returned a packet addressed elsewhere`);
    }
    this.check({
      user,
      sessionId,
      via,
      text: i.text,
      citations: i.citations.map((c) => ({ itemId: c.itemId, title: c.title })),
      injection: i,
      op,
    });
  }

  private askOut(user: User, sessionId: string, r: AskResponse, op: number): void {
    this.check({
      user,
      sessionId,
      via: "ask",
      text: r.answer,
      citations: r.citations.map((c) => ({ itemId: c.itemId, title: c.title })),
      op,
    });
  }

  // ── operations ──

  private describe(op: Op, k: number, detail: string): void {
    const u = this.users[op.user]!;
    this.log.push(`#${k} ${op.bg ? "bg " : ""}${op.kind} ${u.tag}/${sessionsOf[op.session]} ${detail}`);
  }

  async run(ops: Op[]): Promise<void> {
    for (let k = 0; k < ops.length; k++) {
      this.opIndex = k;
      const op = ops[k]!;
      let p: Promise<unknown>;
      try {
        p = this.start(op, k);
      } catch (err) {
        this.violate("fail-open", `op #${k} ${op.kind} threw: ${String(err)}`);
        continue;
      }
      const tracked = p.catch((err) => this.violate("fail-open", `op #${k} ${op.kind} rejected: ${String(err)}`));
      if (op.bg && op.kind !== "settle") {
        this.inflight.add(tracked);
        void tracked.finally(() => this.inflight.delete(tracked));
      } else {
        await tracked;
      }
      if (this.partner.sessionCount > this.openCount()) {
        this.violate("sessions", `sessionCount ${this.partner.sessionCount} > open ${this.openCount()}`);
      }
      await this.jitter();
    }
    this.opIndex = ops.length;
    await this.settle(ops.length);
    // At the end, every open session's queue is taken once more: what settled is checked too.
    for (const u of this.users) {
      for (const sid of sessionsOf) {
        const st = this.state(u, sid);
        const got = this.partner.takePending({ ...u.scope, sessionId: sid });
        if (!st.open && got.length > 0) this.violate("closed", `${u.tag}/${sid} closed but had ${got.length} queued`);
        for (const i of got) this.injectionOut(u, sid, "take", i, ops.length);
        this.checkExplain(u, sid);
      }
    }
    if (this.partner.sessionCount > this.openCount()) {
      this.violate("sessions", `sessionCount ${this.partner.sessionCount} > open ${this.openCount()} at the end`);
    }
  }

  /** Waits for every op in flight, the users' revision polls, and the engine's background turns. */
  private async settle(k: number): Promise<void> {
    for (let round = 0; round < 3; round++) {
      await Promise.all([...this.inflight]);
      for (const u of this.users) await this.partner.revisionsSettled(u.scope);
      for (let n = 0; n < 5; n++) await new Promise<void>((r) => setImmediate(r));
    }
    for (const r of this.removed.values()) if (r.settledAfter === null) r.settledAfter = k;
  }

  private start(op: Op, k: number): Promise<unknown> {
    const user = this.users[op.user]!;
    const sessionId = sessionsOf[op.session]!;
    const ref = { ...user.scope, sessionId };
    const [a, b, c, d] = op.r;
    const src = user.source;
    const refs = [...src.docs.keys()];
    const pickRef = () => (refs.length > 0 ? refs[Math.floor(b * refs.length)]! : null);
    const event = (kind: "user_message" | "agent_message" | "tool_result", text: string) => {
      const waits = [undefined, 0, 30, 2_000];
      const waitMs = waits[Math.floor(c * waits.length)];
      this.describe(op, k, `${JSON.stringify(text.slice(0, 60))} waitMs=${waitMs}`);
      const e =
        kind === "tool_result"
          ? ({ ...ref, at: this.clock, kind, tool: "read_mail", output: text } as AgentEvent)
          : ({ ...ref, at: this.clock, kind, text } as AgentEvent);
      this.touch(user, sessionId, true);
      return this.partner
        .observe(e, waitMs === undefined ? {} : { waitMs })
        .then((r) => r.injection && this.injectionOut(user, sessionId, "observe", r.injection, k));
    };
    switch (op.kind) {
      case "user": {
        const t = TOPICS[Math.floor(a * TOPICS.length)]!;
        return event("user_message", t.ask[Math.floor(b * t.ask.length)]!);
      }
      case "agent": {
        const t = TOPICS[Math.floor(a * TOPICS.length)]!;
        return event("agent_message", `I will look into the ${t.title.toLowerCase()} next.`);
      }
      case "tool": {
        // The agent read one of its user's items (sometimes one with a planted secret): `alreadyHas` sees it.
        const r = pickRef();
        const item = r ? src.item(r) : null;
        return event("tool_result", item ? `${item.title}\n${item.text}` : "No messages found.");
      }
      case "ask": {
        const t = TOPICS[Math.floor(a * TOPICS.length)]!;
        const sizes = [undefined, 1, 2, 5, 12];
        const maxItems = sizes[Math.floor(c * sizes.length)];
        const question = t.ask[Math.floor(b * t.ask.length)]!;
        this.describe(op, k, `${JSON.stringify(question)} maxItems=${maxItems}`);
        this.touch(user, sessionId, false);
        return this.partner
          .ask({ ...ref, question, ...(maxItems === undefined ? {} : { maxItems }) })
          .then((r) => this.askOut(user, sessionId, r, k));
      }
      case "take": {
        this.describe(op, k, "");
        const st = this.state(user, sessionId);
        const got = this.partner.takePending(ref);
        // 5. A closed session hands nothing out.
        if (!st.open && got.length > 0) {
          this.violate("closed", `takePending on closed ${user.tag}/${sessionId} returned ${got.length}`);
        }
        for (const i of got) this.injectionOut(user, sessionId, "take", i, k);
        this.checkExplain(user, sessionId);
        return Promise.resolve();
      }
      case "add": {
        const r = this.addDoc(user, Math.floor(a * TOPICS.length), Math.floor(d * 4));
        return this.notify(op, k, user, r, c, "add");
      }
      case "edit": {
        const r = pickRef();
        if (!r) return Promise.resolve(this.describe(op, k, "nothing to edit"));
        const doc = src.docs.get(r)!;
        // Same age half the time: a newest-first poll does not see it (the signal-only notice's hard case).
        src.docs.set(r, {
          ...doc,
          rev: doc.rev + 1,
          hour: 8 + Math.floor(a * 10),
          updatedAt: d < 0.5 ? doc.updatedAt : this.clock,
        });
        return this.notify(op, k, user, r, c, "edit");
      }
      case "delete": {
        const r = pickRef();
        if (!r) return Promise.resolve(this.describe(op, k, "nothing to delete"));
        src.deleted.set(r, src.docs.get(r)!);
        src.docs.delete(r);
        if (c < 0.7) {
          this.describe(op, k, `${r} + sourceRemoved`);
          // The removal stands from now (it acts only with `syncPush`); it is checked after the next full settle.
          this.clock += 1;
          this.partner.sourceRemoved(user.scope, SOURCE, [r]);
          const at = this.clock;
          if (this.partner.config.syncPush) this.removed.set(itemId(SOURCE, r), { op: k, at, settledAfter: null });
          return Promise.resolve();
        }
        if (c < 0.9) {
          this.describe(op, k, `${r} + sourceChanged`);
          this.partner.sourceChanged(user.scope, SOURCE);
          return Promise.resolve();
        }
        this.describe(op, k, `${r} silently`);
        return Promise.resolve();
      }
      case "readd": {
        const gone = [...src.deleted.keys()];
        if (gone.length === 0) return Promise.resolve(this.describe(op, k, "nothing to re-add"));
        const r = gone[Math.floor(b * gone.length)]!;
        const doc = src.deleted.get(r)!;
        src.deleted.delete(r);
        src.docs.set(r, { ...doc, rev: doc.rev + 1, updatedAt: this.clock });
        this.removed.delete(itemId(SOURCE, r));
        return this.notify(op, k, user, r, c, "re-add");
      }
      case "end": {
        this.describe(op, k, "");
        this.closeSession(user, sessionId);
        return this.partner.observe({ ...ref, at: this.clock, kind: "session_end" } as AgentEvent);
      }
      case "forget": {
        this.describe(op, k, "");
        for (const sid of sessionsOf) this.closeSession(user, sid);
        this.partner.forget(user.scope);
        return Promise.resolve();
      }
      case "clock": {
        const steps = [MIN, 10 * MIN, HOUR, 3 * HOUR, DAY, 3 * DAY];
        const by = Math.max(1, Math.floor(steps[Math.floor(a * steps.length)]! * (0.5 + b)));
        this.clock += by;
        this.describe(op, k, `+${by} ms → ${new Date(this.clock).toISOString()}`);
        return Promise.resolve();
      }
      case "midnight": {
        // To just before the next UTC midnight, so the next ops cross it.
        const next = Math.ceil((this.clock + 1) / DAY) * DAY;
        this.clock = Math.max(this.clock, next - Math.floor(1 + a * 30_000));
        this.describe(op, k, `→ ${new Date(this.clock).toISOString()}`);
        return Promise.resolve();
      }
      case "tick": {
        this.describe(op, k, "");
        return this.partner.sync?.tick() ?? Promise.resolve();
      }
      case "settle": {
        this.describe(op, k, "");
        return this.settle(k);
      }
    }
  }

  /** After a change at the source: a signal (`sourceChanged`), the item itself (`sourceItems`), or nothing. */
  private notify(op: Op, k: number, user: User, r: string, c: number, what: string): Promise<unknown> {
    if (c < 0.4) {
      this.describe(op, k, `${what} ${r} + sourceChanged`);
      this.partner.sourceChanged(user.scope, SOURCE);
      return Promise.resolve();
    }
    if (c < 0.8) {
      this.describe(op, k, `${what} ${r} + sourceItems`);
      return this.partner.sourceItems(user.scope, SOURCE, [user.source.item(r)!]);
    }
    this.describe(op, k, `${what} ${r} silently`);
    return Promise.resolve();
  }
}

/** Runs one seed's plan in a fresh world. */
export async function runSeed(seed: number, ops: Op[], options: WorldOptions): Promise<World> {
  const world = new World(seed, options);
  await world.run(ops);
  return world;
}

/**
 * Shrinks a failing plan to a short one that still shows the same invariant (greedy: drop chunks, then single ops).
 */
export async function minimize(seed: number, ops: Op[], options: WorldOptions, invariant: string): Promise<Op[]> {
  const fails = async (xs: Op[]) =>
    (await runSeed(seed, xs, options)).violations.some((v) => v.invariant === invariant);
  let cur = ops;
  for (let chunk = Math.ceil(cur.length / 2); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    for (let at = 0; at < cur.length;) {
      const next = [...cur.slice(0, at), ...cur.slice(at + chunk)];
      if (next.length > 0 && (await fails(next))) cur = next;
      else at += chunk;
    }
  }
  return cur;
}
