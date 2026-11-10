/**
 * `days-calls.ts` (A8, docs/research/a8-connector-calls.md): Eden's connector calls over a user's days, at $0. The
 * `pi-ab --days` user (the same plan, world, day sizes, clock gaps, the recap's clock moves and its change notice),
 * driven through a real `ContextPartner` on `DEFAULT_CONFIG` with no agent and no model: each request is observed (the
 * push and its candidates), its packets taken, and, with `--ask`, asked once (the eden arm's `ask_context`). Every
 * connector call is counted by source, operation and when it happened: `request` (inside a request's observe, drain or
 * ask), `notice` (the recap's change notice and what it starts, settled as pi-ab settles it), `tick` (the background
 * sync before each request), `backfill` (before the first request, once per user).
 *
 *   bun packages/sim/src/lab/days-calls.ts [--seeds 41,42] [--days 8] [--push none|signals|payload] [--ask]
 *     [--cards FILE] [--recap-notice push|signal] [--gap-min 10] [--night-h 2] [--set JSON] [--json FILE]
 *
 * `--recap-notice signal` announces the recap as pi-ab did before D272: a bare `sourceChanged` whatever `--push` says.
 * `--cards FILE` replays cards and the checked-in intent requests with no live call (a miss gets no card); without it
 * the no-key path. `--night-h 20` with the default day sizes puts about 24 hours of Eden's clock in a day (pi-ab's
 * 2 h nights compress eight days into about 36 hours, so a daily sweep runs about once a user).
 */
import { writeFileSync } from "node:fs";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { CardEnricher, ContextPartner, ItemCache, type EngineConfig } from "@eden/engine";
import { QueryPlanner, type ListPage, type Source } from "@eden/sources";
import { REALISTIC, simSources, type SimSource } from "../sources";
import { applyNotifyShare, parseNotifyShare, recapNotice, sourceFields, type PushMode } from "./connector-options";
import { DiskCardMaker, INTENT_PATH } from "./cards-disk";
import { noiseSources } from "./noise-sources";
import { isRecap, recapOf, shiftClocks, shiftMeta, UPDATED_MARK, type ClockMove } from "./pi-day";
import { parseDaySize, parseMix, planUser, suiteTemplates, userWorldOf, withDayRecaps } from "./pi-user";
import { parseSuites } from "./suites";

export type Phase = "backfill" | "tick" | "notice" | "request";
/** `${phase} ${source} ${op}` → calls. */
export type Counts = Record<string, number>;

export interface DaysCallsOptions {
  days: number;
  push: PushMode;
  /** One `ask` per request after its push (the eden arm's agent asks about once a request one at a time). */
  ask?: boolean;
  /** pi-ab's recap before D272: a bare signal whatever `push` says. */
  recapSignal?: boolean;
  cards?: DiskCardMaker | null;
  config?: Partial<EngineConfig>;
  gapMs?: number;
  nightMs?: number;
  /** `--notify-share P` (N1): only this share of the connectors notify (`applyNotifyShare`). */
  notifyShare?: number | null;
  /** `--noise-sources N` (N1): N unrelated connectors beside the world's five (`noise-sources.ts`), 20 items each. */
  noiseSources?: number;
  /** `--noise-vocab N` (O1): words of its own for each noise connector (`noiseSources`). */
  noiseVocab?: number;
}

export interface DaysCallsUser {
  seed: number;
  requests: number;
  days: number;
  counts: Counts;
  /** `verifyDelivery`'s outcomes over the requests. */
  freshness: Record<string, number>;
  /** Distinct items re-read at request time, and those re-read more than once. */
  fetchedItems: number;
  refetched: number;
  /** "updated:" packets the agent was handed (`revisionNotice`). */
  updatePackets: number;
  /** Items moved at their source by a recap: how many, and how many of those the cache still held in an old version
   * at the next request (a changed copy delivered stale would need one). */
  changed: number;
  staleHeld: number;
  /**
   * Requests with a planted item, and those whose item reached the agent (a packet or the ask's citations), by the
   * task's kind: "hidden" (the fact) and "control" (its all-clear decoy). The funnel's "surfaced", over a user's days.
   */
  surfaced: Record<string, { n: number; got: number }>;
  /** Request-time calls by day (index 0 is the first day). */
  requestCallsByDay: number[];
  requestsByDay: number[];
}

const bump = (c: Counts, k: string, n = 1) => (c[k] = (c[k] ?? 0) + n);

/** A source as Eden sees it, every call counted under the phase running now. */
function counted(source: SimSource, phase: () => Phase, into: Counts, fetched: Map<string, number>): Source {
  const k = (op: string) => `${phase()} ${source.id} ${op}`;
  return {
    ...sourceFields(source),
    search: (q, signal) => (bump(into, k("search")), source.search(q, signal)),
    fetch: (ref, scope, signal) => {
      bump(into, k("fetch"));
      const key = `${source.id}:${ref}`;
      if (phase() === "request") fetched.set(key, (fetched.get(key) ?? 0) + 1);
      return source.fetch(ref, scope, signal);
    },
    list: (scope, cursor, limit, signal): Promise<ListPage> => {
      bump(into, k("list"));
      return source.list(scope, cursor, limit, signal);
    },
  };
}

/** One user's `--days` run through Eden alone, counting its connector calls. */
export async function daysCalls(seed: number, o: DaysCallsOptions): Promise<DaysCallsUser> {
  const gapMs = o.gapMs ?? 10 * 60_000;
  const nightMs = o.nightMs ?? 2 * 3_600_000;
  const plan = planUser(seed, suiteTemplates(seed, parseSuites("train")), {
    days: o.days,
    size: parseDaySize("12-20"),
    mix: parseMix("1:1:8"),
  });
  const u = userWorldOf(seed, plan);
  const world = { ...u.world, items: u.world.items.map((i) => ({ ...i })) };
  const userPrefix = `w${seed}:user`;
  const tasks = withDayRecaps(u.tasks, u.daySizes, (t, d) => recapOf(t, `${userPrefix}:day${d}:recap`));
  // Time scale 0: instant sources, so the run is deterministic and the counts are the connectors' alone.
  const own = simSources(world, REALISTIC, 0, seed);
  if (o.push !== "none") for (const s of own) s.notifies = true;
  const sources = [
    ...own,
    ...(o.noiseSources ? noiseSources(world, o.noiseSources, 20, 0, seed, o.noiseVocab ?? 0) : []),
  ];
  applyNotifyShare(sources, o.notifyShare ?? null, seed);
  const counts: Counts = {};
  const fetched = new Map<string, number>();
  let phase: Phase = "backfill";
  const eden = sources.map((s) => counted(s, () => phase, counts, fetched));
  let clock = world.now;
  const cards = o.cards ? new CardEnricher({ maker: o.cards, budget: new Budget(), now: () => clock }) : undefined;
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async () => eden,
    sourceMap: new SourceMap(":memory:", { seed }),
    cache,
    budget: new Budget(),
    model: null,
    planner: new QueryPlanner({ seed }),
    now: () => clock,
    config: o.config ?? {},
    ...(cards ? { cards } : {}),
  });
  const scope = { tenantId: "ab", userId: `w${seed}` };
  // The harness reads the engine's session table, as hidden-funnel does: whether a session's lookup is still running.
  const table = (partner as unknown as { sessions: Map<string, { inflight: unknown; behind?: unknown }> }).sessions;
  const busy = (id: string) => {
    const s = table.get(`${scope.tenantId}/${scope.userId}#${id}`);
    return !!(s?.inflight || s?.behind);
  };
  const sync = partner.sync;
  if (!sync) throw new Error("days-calls needs the sync (it is in the default)");
  // As pi-ab: the backfill from half an hour before the first request, a minute a tick.
  const start = clock;
  clock -= 30 * 60_000;
  sync.track(scope, clock);
  for (let i = 0; i < (o.noiseSources ? 600 : 120) && !sync.warm(scope); i++) {
    await sync.tick();
    clock += 60_000;
  }
  clock = start;
  if (!sync.warm(scope)) throw new Error(`sync never warmed for w${seed}`);
  if (cards) await cards.idle();
  const planted = new Set<string>();
  /** Items moved at their source, with what moved: the cache's copy must not show an old time without its new one. */
  const moved = new Map<string, ClockMove[]>();
  let dayNo = -1;
  let newDay = true;
  let session = "";
  let requests = 0;
  let updatePackets = 0;
  let staleHeld = 0;
  const f0 = { ...partner.freshness };
  const surfaced: DaysCallsUser["surfaced"] = {};
  const requestCallsByDay: number[] = [];
  const requestsByDay: number[] = [];
  /** The item ids the agent was handed in the current request. */
  const handed = new Set<string>();
  const requestCalls = () => callsWhere(counts, (p) => p === "request");
  const take = () => {
    for (const i of partner.takePending({ ...scope, sessionId: session })) {
      if (i.text.includes(UPDATED_MARK)) updatePackets++;
      for (const c of i.citations) handed.add(c.itemId);
    }
  };
  for (const task of tasks) {
    clock += newDay && dayNo >= 0 ? nightMs : gapMs;
    phase = "tick";
    await sync.tick();
    if (newDay) {
      if (session)
        await partner.observe({ ...scope, sessionId: session, at: clock, kind: "session_end" } as AgentEvent);
      dayNo++;
      session = `${userPrefix}:day${dayNo}`;
      planted.clear();
    }
    newDay = isRecap(task);
    if (isRecap(task)) {
      // pi-ab's recap: the day's planted items move their clock times and their source says so.
      const changed = new Set<string>();
      for (const id of planted) {
        const it = world.items.find((x) => x.id === id);
        if (!it) continue;
        const shift = shiftClocks(it.text);
        if (!shift.moves.length) continue;
        it.text = shift.text;
        if (it.meta) it.meta = shiftMeta(it.meta, shift.moves);
        it.updatedAt = clock;
        changed.add(it.id);
        moved.set(it.id, shift.moves);
      }
      const touched = new Set(world.items.filter((i) => changed.has(i.id)).map((i) => i.sourceId));
      for (const s of sources) if (touched.has(s.id)) s.reindex();
      phase = "notice";
      if (o.push !== "none") {
        if (o.recapSignal) for (const id of touched) partner.sourceChanged(scope, id);
        else await recapNotice(partner, scope, sources, changed, o.push);
        await partner.revisionsSettled(scope);
      }
    }
    phase = "request";
    const ev = { ...scope, sessionId: session, at: clock };
    if (!isRecap(task)) requests++;
    handed.clear();
    const callsBefore = requestCalls();
    const arriving = task.event === "external" ? { source: "gmail" } : {};
    const r = await partner.observe({ ...ev, kind: task.event, text: task.text, ...arriving } as AgentEvent, {
      waitMs: 3_000,
    });
    if (r.injection?.text.includes(UPDATED_MARK)) updatePackets++;
    for (const c of r.injection?.citations ?? []) handed.add(c.itemId);
    // The lookup's work left running (the push behind its poll, a second reading) settles before the next request.
    for (let k = 0; k < 5_000 && busy(session); k++) await Bun.sleep(1);
    take();
    if (o.ask && !isRecap(task)) {
      const a = await partner.ask({ ...scope, sessionId: session, question: task.text });
      for (const c of a.citations) handed.add(c.itemId);
      // The ask's reads behind (D430) settle before the next request, as the push's do.
      for (let k = 0; k < 5_000 && busy(session); k++) await Bun.sleep(1);
    }
    take();
    if (!isRecap(task)) {
      requestCallsByDay[dayNo] = (requestCallsByDay[dayNo] ?? 0) + requestCalls() - callsBefore;
      requestsByDay[dayNo] = (requestsByDay[dayNo] ?? 0) + 1;
      if (task.planted && task.kind !== "neutral") {
        const row = (surfaced[task.kind] ??= { n: 0, got: 0 });
        row.n++;
        if (handed.has(task.planted)) row.got++;
      }
    }
    if (cards) await cards.idle();
    if (!isRecap(task) && task.planted) planted.add(task.planted);
    // After each request, whether the cache holds a moved item in an old version (its old time without the new one)
    // with nothing doubting it: a delivery would then send it stale, which D126 and D211 forbid.
    for (const [id, moves] of moved) {
      const held = cache.get(scope, id, clock);
      if (!held) continue;
      const text = held.text;
      const old = moves.some((m) => text.includes(m.from) && !text.includes(m.to));
      const mark = cache.readMark(scope, id);
      const doubted = mark !== undefined && sync.signalledSince(scope, held.sourceId, mark);
      if (old && !doubted) staleHeld++;
    }
  }
  phase = "tick";
  const freshness = Object.fromEntries(
    Object.entries(partner.freshness).map(([k, v]) => [k, v - (f0 as Record<string, number>)[k]!]),
  );
  return {
    seed,
    requests,
    days: dayNo + 1,
    counts,
    freshness,
    fetchedItems: fetched.size,
    refetched: [...fetched.values()].filter((n) => n > 1).length,
    updatePackets,
    changed: moved.size,
    staleHeld,
    surfaced,
    requestCallsByDay,
    requestsByDay,
  };
}

/** Calls in `counts` whose key passes `pred`. */
export const callsWhere = (counts: Counts, pred: (phase: Phase, source: string, op: string) => boolean): number =>
  Object.entries(counts).reduce((n, [k, v]) => {
    const [p, s, op] = k.split(" ") as [Phase, string, string];
    return pred(p, s, op) ? n + v : n;
  }, 0);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
  };
  const seeds = opt("seeds", "41,42").split(",").map(Number);
  const push = opt("push", "payload") as PushMode;
  if (!["none", "signals", "payload"].includes(push)) throw new Error("--push must be none, signals or payload");
  const recap = opt("recap-notice", "push");
  if (recap !== "push" && recap !== "signal") throw new Error("--recap-notice must be push or signal");
  const cardsFile = opt("cards", "");
  const o: DaysCallsOptions = {
    days: Number(opt("days", "8")),
    push,
    ask: argv.includes("--ask"),
    recapSignal: recap === "signal",
    cards: cardsFile ? new DiskCardMaker(cardsFile, undefined, { requests: [INTENT_PATH] }) : null,
    config: JSON.parse(opt("set", "{}")) as Partial<EngineConfig>,
    notifyShare: parseNotifyShare(opt("notify-share", "")),
    noiseSources: Number(opt("noise-sources", "0")),
    noiseVocab: Number(opt("noise-vocab", "0")),
    gapMs: Number(opt("gap-min", "10")) * 60_000,
    nightMs: Number(opt("night-h", "2")) * 3_600_000,
  };
  const users: DaysCallsUser[] = [];
  for (const seed of seeds) users.push(await daysCalls(seed, o));
  const requests = users.reduce((n, u) => n + u.requests, 0);
  const days = users.reduce((n, u) => n + u.days, 0);
  const total: Counts = {};
  for (const u of users) for (const [k, v] of Object.entries(u.counts)) bump(total, k, v);
  const set = Object.keys(o.config!).length ? `, set ${JSON.stringify(o.config)}` : "";
  const label =
    `push ${push}${o.recapSignal ? " (recap: bare signal)" : ""}${o.ask ? ", one ask a request" : ""}` +
    `${cardsFile ? ", cards replayed" : ", no cards"}, night ${o.nightMs! / 3_600_000} h${set}`;
  console.log(`days-calls: seeds ${seeds.join(",")}, ${o.days} days, ${requests} requests, ${label}`);
  console.log("phase     source    op       calls   per request  per user-day");
  // With noise connectors, one row for all of them a phase and operation: a thousand rows say nothing more.
  const world5 = new Set(["gmail", "calendar", "drive", "slack", "crm"]);
  const rows: Counts = {};
  for (const [k, v] of Object.entries(total)) {
    const [p, s, op] = k.split(" ") as [string, string, string];
    bump(rows, `${p} ${o.noiseSources && !world5.has(s) ? "(noise)" : s} ${op}`, v);
  }
  for (const k of Object.keys(rows).sort()) {
    const [p, s, op] = k.split(" ") as [string, string, string];
    const v = rows[k]!;
    const per = p === "backfill" ? "" : (v / requests).toFixed(3);
    const perDay = p === "backfill" ? `${(v / users.length).toFixed(1)} a user` : (v / days).toFixed(2);
    console.log(
      `${p.padEnd(9)} ${s.padEnd(9)} ${op.padEnd(7)} ${String(v).padStart(6)}   ${per.padStart(10)}  ${perDay.padStart(12)}`,
    );
  }
  const at = (ps: Phase[]) => callsWhere(total, (p) => ps.includes(p));
  console.log(
    `request-time ${(at(["request"]) / requests).toFixed(3)} a request; background (tick + notice) ` +
      `${(at(["tick", "notice"]) / days).toFixed(2)} a user-day, ${(at(["tick", "notice"]) / requests).toFixed(3)} ` +
      `a request; steady ${(at(["request", "tick", "notice"]) / requests).toFixed(3)} a request; backfill ` +
      `${(at(["backfill"]) / users.length).toFixed(1)} a user`,
  );
  const surf = (kind: string) => {
    const n = users.reduce((x, u) => x + (u.surfaced[kind]?.n ?? 0), 0);
    const got = users.reduce((x, u) => x + (u.surfaced[kind]?.got ?? 0), 0);
    return `${got}/${n}`;
  };
  console.log(
    `surfaced (a packet or the ask's citations): hidden facts ${surf("hidden")}, control decoys ${surf("control")}`,
  );
  const byDay = Array.from({ length: Math.max(...users.map((u) => u.requestCallsByDay.length)) }, (_, d) => {
    const c = users.reduce((x, u) => x + (u.requestCallsByDay[d] ?? 0), 0);
    const r = users.reduce((x, u) => x + (u.requestsByDay[d] ?? 0), 0);
    return (c / Math.max(1, r)).toFixed(1);
  });
  console.log(`request-time calls a request, by day: ${byDay.join(" ")}`);
  for (const u of users)
    console.log(
      `  w${u.seed}: verify ${JSON.stringify(u.freshness)}; items re-read ${u.fetchedItems}, more than once ` +
        `${u.refetched}; moved ${u.changed}, update packets ${u.updatePackets}, stale copies held ${u.staleHeld}`,
    );
  const out = opt("json", "");
  if (out) writeFileSync(out, JSON.stringify({ label, seeds, days: o.days, requests, userDays: days, total, users }));
}
