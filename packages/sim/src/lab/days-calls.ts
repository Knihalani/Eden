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
 *     [--cards FILE] [--recap-notice push|signal|none] [--move-after N] [--gap-min 10] [--night-h 2] [--set JSON]
 *     [--json FILE] [--pool-diag FILE] [--intent FILE[,FILE]]
 *
 * Weeks and more users (P7, D874, D875): `--days 28 --night-h 20` is four weeks of Eden's clock, long enough for the
 * weekly sweep of unused sources (D356) to run three times; past about 12 days the plan is a weeks plan
 * (`planWeeks`). `--seeds 41-64` runs 24 users (a range or a list). `--suite train,longtail` adds the long-tail suite's
 * facts in rarely used connectors (rare-sources.ts); `--day-size` and `--mix` as pi-ab takes them. `--arrive-days
 * LO-HI`: each planted item (fact or decoy) is not there at the backfill but appears at its connector LO to HI days
 * before its request, with no notice (a quiet source), so only a poll, a sweep or the request's own reads find it.
 * The surfaced lines then split by connector (`rare`, `common`) and by how long before its request the item arrived
 * (`0d` the same day, `1-6d`, `7d+`, `backfill`), and a line gives the rare connectors' listings a user-day: the two
 * sides of a sweep or dormancy decision.
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
import { CardEnricher, ContextPartner, ItemCache, type EngineConfig, type PushPoolReport } from "@eden/engine";
import { QueryPlanner, type ListPage, type Source } from "@eden/sources";
import { RARE_SOURCE_IDS } from "../rare-sources";
import { Rng } from "../rng";
import { REALISTIC, simSources, type SimSource } from "../sources";
import type { World, WorldItem } from "../world";
import type { Task } from "./ab-common";
import { applyNotifyShare, parseNotifyShare, recapNotice, sourceFields, type PushMode } from "./connector-options";
import { DiskCardMaker, INTENT_PATH } from "./cards-disk";
import { noiseSources } from "./noise-sources";
import { isRecap, recapOf, shiftClocks, shiftMeta, UPDATED_MARK, type ClockMove } from "./pi-day";
import { parseDaySize, parseMix, planUser, suiteTemplates, userWorldOf, withDayRecaps } from "./pi-user";
import { parseSuites } from "./suites";

export type Phase = "backfill" | "tick" | "notice" | "request";
/** `${phase} ${source} ${op}` → calls. */
export type Counts = Record<string, number>;

/**
 * What became of an item its day's recap moved (O1, D606): `unhanded` (the agent was not handed it that day, so no
 * update is owed), `updated` (an "updated:" packet cited it), `unpolled` (its source was not listed between the move
 * and the end of the recap's request), `unseen` (listed, but the cache's copy is still the old one), `undelivered`
 * (the cache holds the new copy and no update packet cited it).
 */
export type MovedFate = "unhanded" | "updated" | "unpolled" | "unseen" | "undelivered";

export interface DaysCallsOptions {
  days: number;
  push: PushMode;
  /** One `ask` per request after its push (the eden arm's agent asks about once a request one at a time). */
  ask?: boolean;
  /** pi-ab's recap before D272: a bare signal whatever `push` says. */
  recapSignal?: boolean;
  /** `--recap-notice none` (O1): the moved items' sources say nothing, so only a poll or a sweep finds the change. */
  recapSilent?: boolean;
  /**
   * `--move-after N` (P4, D841): a planted item handed at a request moves its clock times N requests later in the same
   * session (with the recap's notice, or none), not just before the recap; one whose turn falls at or past the recap
   * moves there as before. Its fate is read when the session ends (`midFates`), with how many requests the update
   * took (`midDelays`). The recap's own fates (`fates`) then count only the items moved at the recap.
   */
  moveAfter?: number;
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
  /** `--suite` (D875): the suites the user's requests come from (default train). */
  suites?: string[];
  /** `--day-size`, `--mix` (as pi-ab): requests a day and the hidden:control:neutral shares (12-20, 1:1:8). */
  daySize?: [number, number];
  mix?: { hidden: number; control: number; neutral: number };
  /**
   * `--arrive-days LO-HI` (D875): each planted item appears silently at its connector LO-HI days before its request's
   * day (at the start of that day, before its first request); one due before the first day is there from the backfill.
   */
  arriveDays?: [number, number] | null;
  /**
   * `--pool-diag FILE` (O3, D712): one row per hidden or control request saying where its planted item was in the
   * push's pool (`onPushPool`): ids and flags only.
   */
  onPlanted?: (row: PlantedRow) => void;
}

/** Where a request's planted item was (`DaysCallsOptions.onPlanted`). */
export interface PlantedRow {
  seed: number;
  task: string;
  kind: string;
  day: number;
  /** Whether the request's observe ran the candidates' pass at all. */
  pushRan: boolean;
  poolSize: number;
  /** The planted item's place in the pool (0 first), -1 when it is not in it. */
  rank: number;
  /** `readerGate`'s constraint test on it, when pooled. */
  like: boolean;
  /** Pool items before it that pass the constraint test. */
  likeAhead: number;
  handed: number;
  /** Handed by the push; handed at all (the ask included, with `--ask`); handed earlier the same day. */
  pushed: boolean;
  got: boolean;
  today: boolean;
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
  /** Each moved item's fate at its recap (`MovedFate`). */
  fates: Record<MovedFate, number>;
  /** `--move-after`: the fate of each item moved mid-session, read at the session's end, and each update's delay. */
  midFates: Record<MovedFate, number>;
  midDelays: number[];
  /** Owed updates (moved items the agent was handed that day, recap and mid-session) by source: owed and updated. */
  bySource: Record<string, { owed: number; updated: number }>;
  staleHeld: number;
  /**
   * Requests with a planted item, and those whose item reached the agent (a packet or the ask's citations), by the
   * task's kind: "hidden" (the fact) and "control" (its all-clear decoy). The funnel's "surfaced", over a user's days.
   */
  surfaced: Record<string, { n: number; got: number }>;
  /**
   * The same, keyed `<kind> <rare|common> <lag>` (D875): the planted item's connector class and how long before its
   * request it arrived (`backfill` when it was there from the start; with `--arrive-days`, `0d`, `1-6d` or `7d+`).
   */
  surfacedBy: Record<string, { n: number; got: number }>;
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
  const plan = planUser(seed, suiteTemplates(seed, o.suites ?? parseSuites("train")), {
    days: o.days,
    size: o.daySize ?? parseDaySize("12-20"),
    mix: o.mix ?? parseMix("1:1:8"),
  });
  const u = userWorldOf(seed, plan);
  const world = { ...u.world, items: u.world.items.map((i) => ({ ...i })) };
  // `--arrive-days`: hold each planted item until its day (`arrivals`, by plan day), drawn before the sources exist.
  const { arrivals, lagOf } = scheduleArrivals(world, u.tasks, u.daySizes, seed, o.arriveDays ?? null);
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
  /** The current request's candidates pass, when it ran (`onPlanted`). */
  let pooled: PushPoolReport | null = null;
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
    ...(o.onPlanted ? { onPushPool: (r: PushPoolReport) => void (pooled = r) } : {}),
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
  /** Items an "updated:" packet cited, and what became of each moved item at its recap (`MovedFate`). */
  const updatedIds = new Set<string>();
  const fates: Record<MovedFate, number> = { unhanded: 0, updated: 0, unpolled: 0, unseen: 0, undelivered: 0 };
  let recapMoved: { id: string; source: string; lists: number; to: string[] }[] = [];
  /** `--move-after`: items handed and due to move (request of the day), and those moved mid-session today. */
  const dueToMove = new Map<string, number>();
  let midMoved: { id: string; source: string; lists: number; to: string[]; at: number; delay?: number }[] = [];
  const midFates: Record<MovedFate, number> = { unhanded: 0, updated: 0, unpolled: 0, unseen: 0, undelivered: 0 };
  const midDelays: number[] = [];
  const bySource: DaysCallsUser["bySource"] = {};
  const owe = (source: string, updated: boolean) => {
    const row = (bySource[source] ??= { owed: 0, updated: 0 });
    row.owed++;
    if (updated) row.updated++;
  };
  let reqInDay = 0;
  /** An "updated:" packet cited these: a mid-session move's delay is read from the first after it. */
  const noteUpdated = (ids: Iterable<string>) => {
    for (const id of ids) {
      updatedIds.add(id);
      for (const m of midMoved) if (m.id === id && m.delay === undefined) m.delay = reqInDay - m.at;
    }
  };
  /** Moves an item's clock times at its source (the recap's change); the record, or null when it names no time. */
  const moveItem = (id: string) => {
    const it = world.items.find((x) => x.id === id);
    if (!it) return null;
    const shift = shiftClocks(it.text);
    if (!shift.moves.length) return null;
    it.text = shift.text;
    if (it.meta) it.meta = shiftMeta(it.meta, shift.moves);
    it.updatedAt = clock;
    moved.set(it.id, shift.moves);
    return { id: it.id, source: it.sourceId, lists: listsOf(it.sourceId), to: shift.moves.map((m) => m.to) };
  };
  /** The source's notice for moved items, as the recap gives it (`--recap-notice`). */
  const announce = async (changed: Set<string>) => {
    const touched = new Set(world.items.filter((i) => changed.has(i.id)).map((i) => i.sourceId));
    for (const s of sources) if (touched.has(s.id)) s.reindex();
    phase = "notice";
    if (o.push !== "none" && !o.recapSilent) {
      if (o.recapSignal) for (const id of touched) partner.sourceChanged(scope, id);
      else await recapNotice(partner, scope, sources, changed, o.push);
      await partner.revisionsSettled(scope);
    }
  };
  const listsOf = (source: string) => callsWhere(counts, (_p, src, op) => src === source && op === "list");
  const f0 = { ...partner.freshness };
  const surfaced: DaysCallsUser["surfaced"] = {};
  const surfacedBy: DaysCallsUser["surfacedBy"] = {};
  const requestCallsByDay: number[] = [];
  const requestsByDay: number[] = [];
  /** The item ids the agent was handed in the current request. */
  const handed = new Set<string>();
  /** Planted items handed so far in the current day's session (`onPlanted`'s `today`). */
  const handedToday = new Set<string>();
  const requestCalls = () => callsWhere(counts, (p) => p === "request");
  const take = () => {
    for (const i of partner.takePending({ ...scope, sessionId: session })) {
      if (i.text.includes(UPDATED_MARK)) {
        updatePackets++;
        noteUpdated(i.citations.map((c) => c.itemId));
      }
      for (const c of i.citations) handed.add(c.itemId);
    }
  };
  for (const task of tasks) {
    clock += newDay && dayNo >= 0 ? nightMs : gapMs;
    if (newDay) {
      // The day's arrivals appear overnight at their connectors with no notice; the tick below may or may not list
      // them (an unused connector is swept weekly).
      const due = arrivals.get(dayNo + 1) ?? [];
      for (const it of due) world.items.push({ ...it, updatedAt: clock - 3_600_000 });
      const touched = new Set(due.map((it) => it.sourceId));
      for (const s of sources) if (touched.has(s.id)) s.reindex();
    }
    phase = "tick";
    await sync.tick();
    if (newDay) {
      if (session)
        await partner.observe({ ...scope, sessionId: session, at: clock, kind: "session_end" } as AgentEvent);
      dayNo++;
      session = `${userPrefix}:day${dayNo}`;
      planted.clear();
      handedToday.clear();
      dueToMove.clear();
      midMoved = [];
      reqInDay = 0;
    }
    newDay = isRecap(task);
    if (isRecap(task)) {
      // pi-ab's recap: the day's planted items move their clock times and their source says so.
      const changed = new Set<string>();
      for (const id of planted) {
        const m = moveItem(id);
        if (!m) continue;
        changed.add(m.id);
        recapMoved.push(m);
      }
      await announce(changed);
    } else if (o.moveAfter) {
      // `--move-after`: items handed N requests ago move now, mid-session.
      const changed = new Set<string>();
      for (const [id, at] of dueToMove) {
        if (at > reqInDay) continue;
        dueToMove.delete(id);
        planted.delete(id);
        const m = moveItem(id);
        if (!m) continue;
        changed.add(m.id);
        midMoved.push({ ...m, at: reqInDay });
      }
      if (changed.size) await announce(changed);
    }
    phase = "request";
    const ev = { ...scope, sessionId: session, at: clock };
    if (!isRecap(task)) requests++;
    handed.clear();
    pooled = null;
    const callsBefore = requestCalls();
    const arriving = task.event === "external" ? { source: "gmail" } : {};
    const r = await partner.observe({ ...ev, kind: task.event, text: task.text, ...arriving } as AgentEvent, {
      waitMs: 3_000,
    });
    if (r.injection?.text.includes(UPDATED_MARK)) {
      updatePackets++;
      noteUpdated(r.injection.citations.map((c) => c.itemId));
    }
    for (const c of r.injection?.citations ?? []) handed.add(c.itemId);
    // The lookup's work left running (the push behind its poll, a second reading) settles before the next request.
    for (let k = 0; k < 5_000 && busy(session); k++) await Bun.sleep(1);
    take();
    const pushed = task.planted ? handed.has(task.planted) : false;
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
        const src = world.items.find((it) => it.id === task.planted)?.sourceId ?? "";
        const by = `${task.kind} ${RARE_SOURCE_IDS.includes(src) ? "rare" : "common"} ${lagOf.get(task.id) ?? "backfill"}`;
        const rowBy = (surfacedBy[by] ??= { n: 0, got: 0 });
        rowBy.n++;
        if (handed.has(task.planted)) rowBy.got++;
        if (o.onPlanted) {
          const report = pooled as PushPoolReport | null;
          const rank = report ? report.pool.indexOf(task.planted) : -1;
          o.onPlanted({
            seed,
            task: task.id,
            kind: task.kind,
            day: dayNo,
            pushRan: report !== null,
            poolSize: report?.pool.length ?? 0,
            rank,
            like: rank >= 0 && report!.constraintLike[rank] === true,
            likeAhead: rank >= 0 ? report!.constraintLike.slice(0, rank).filter(Boolean).length : 0,
            handed: report?.handed.length ?? 0,
            pushed,
            got: handed.has(task.planted),
            today: handedToday.has(task.planted),
          });
        }
      }
      for (const id of handed) handedToday.add(id);
    }
    if (cards) await cards.idle();
    // What became of each item this recap moved, once the recap's request has settled: the session ends with it, so
    // an update not handed by now never is.
    for (const m of recapMoved) {
      const held = cache.get(scope, m.id, clock);
      const fate: MovedFate = !handedToday.has(m.id)
        ? "unhanded"
        : updatedIds.has(m.id)
          ? "updated"
          : listsOf(m.source) === m.lists
            ? "unpolled"
            : !held || !m.to.every((t) => held.text.includes(t))
              ? "unseen"
              : "undelivered";
      fates[fate]++;
      if (fate !== "unhanded") owe(m.source, fate === "updated");
    }
    recapMoved = [];
    // `--move-after`: the session ends with the recap's request, so each mid-session move's fate is read now.
    if (isRecap(task)) {
      for (const m of midMoved) {
        const held = cache.get(scope, m.id, clock);
        const fate: MovedFate =
          m.delay !== undefined
            ? "updated"
            : listsOf(m.source) === m.lists
              ? "unpolled"
              : !held || !m.to.every((t) => held.text.includes(t))
                ? "unseen"
                : "undelivered";
        midFates[fate]++;
        owe(m.source, fate === "updated");
        if (m.delay !== undefined) midDelays.push(m.delay);
      }
      midMoved = [];
    }
    // An item already moved mid-session today is not planted again: the recap would move it a second time (the
    // review) and owe it twice.
    const movedToday = !!task.planted && midMoved.some((m) => m.id === task.planted);
    if (!isRecap(task) && task.planted && !movedToday) planted.add(task.planted);
    if (o.moveAfter && !isRecap(task) && task.planted && handed.has(task.planted) && !dueToMove.has(task.planted)) {
      if (!movedToday) dueToMove.set(task.planted, reqInDay + o.moveAfter);
    }
    if (!isRecap(task)) reqInDay++;
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
    fates,
    midFates,
    midDelays,
    bySource,
    staleHeld,
    surfaced,
    surfacedBy,
    requestCallsByDay,
    requestsByDay,
  };
}

/**
 * `--arrive-days` (D875): take each planted item of `tasks` out of `world.items` and give it a plan day to arrive on,
 * LO-HI days before its request's day (drawn per task, deterministic per seed). Items due on day 0 or before stay (they
 * are there at the backfill). `lagOf`: task id → `0d`, `1-6d` or `7d+` for the held ones.
 */
export function scheduleArrivals(
  world: World,
  tasks: readonly Task[],
  daySizes: readonly number[],
  seed: number,
  range: [number, number] | null,
): { arrivals: Map<number, WorldItem[]>; lagOf: Map<string, string> } {
  const arrivals = new Map<number, WorldItem[]>();
  const lagOf = new Map<string, string>();
  if (!range) return { arrivals, lagOf };
  const r = new Rng(seed * 7_919 + 875);
  const dayOf: number[] = daySizes.flatMap((n, d) => Array.from({ length: n }, () => d));
  const hold = new Map<string, number>();
  tasks.forEach((t, i) => {
    if (!t.planted || t.kind === "neutral") return;
    const lag = r.int(range[0], range[1]);
    const day = dayOf[i]! - lag;
    if (day <= 0) return;
    hold.set(t.planted, day);
    lagOf.set(t.id, lag === 0 ? "0d" : lag < 7 ? "1-6d" : "7d+");
  });
  world.items = world.items.filter((it) => {
    const day = hold.get(it.id);
    if (day === undefined) return true;
    arrivals.set(day, [...(arrivals.get(day) ?? []), it]);
    return false;
  });
  return { arrivals, lagOf };
}

/** `LO-HI` or `N` with 0 ≤ LO ≤ HI. */
export function parseRange(arg: string, flag: string): [number, number] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(arg.trim());
  if (!m) throw new Error(`${flag} takes N or LO-HI, not "${arg}"`);
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  if (hi < lo) throw new Error(`${flag} ${arg}: needs LO ≤ HI`);
  return [lo, hi];
}

/** `--seeds`: a comma list of seeds and ranges (`41-64`, `41,45-48`). */
export function parseSeeds(arg: string): number[] {
  return arg.split(",").flatMap((part) => {
    const [lo, hi] = parseRange(part, "--seeds");
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  });
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
  const seeds = parseSeeds(opt("seeds", "41,42"));
  const push = opt("push", "payload") as PushMode;
  if (!["none", "signals", "payload"].includes(push)) throw new Error("--push must be none, signals or payload");
  const recap = opt("recap-notice", "push");
  if (!["push", "signal", "none"].includes(recap)) throw new Error("--recap-notice must be push, signal or none");
  const cardsFile = opt("cards", "");
  // `--intent` (O3, D713): the requests files replayed beside the cards, in place of the checked-in one.
  const intentFiles = opt("intent", INTENT_PATH).split(",");
  const o: DaysCallsOptions = {
    days: Number(opt("days", "8")),
    push,
    ask: argv.includes("--ask"),
    recapSignal: recap === "signal",
    recapSilent: recap === "none",
    moveAfter: Number(opt("move-after", "0")),
    cards: cardsFile ? new DiskCardMaker(cardsFile, undefined, { requests: intentFiles }) : null,
    config: JSON.parse(opt("set", "{}")) as Partial<EngineConfig>,
    notifyShare: parseNotifyShare(opt("notify-share", "")),
    noiseSources: Number(opt("noise-sources", "0")),
    noiseVocab: Number(opt("noise-vocab", "0")),
    gapMs: Number(opt("gap-min", "10")) * 60_000,
    nightMs: Number(opt("night-h", "2")) * 3_600_000,
    suites: parseSuites(opt("suite", "train")),
    daySize: parseDaySize(opt("day-size", "12-20")),
    mix: parseMix(opt("mix", "1:1:8")),
    arriveDays: opt("arrive-days", "") ? parseRange(opt("arrive-days", ""), "--arrive-days") : null,
  };
  const diag = opt("pool-diag", "");
  const planted: PlantedRow[] = [];
  if (diag) o.onPlanted = (row) => void planted.push(row);
  const users: DaysCallsUser[] = [];
  for (const seed of seeds) users.push(await daysCalls(seed, o));
  if (diag) writeFileSync(diag, planted.map((r) => `${JSON.stringify(r)}\n`).join(""));
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
  // D875: by connector class and arrival lag, and what the rare connectors cost in listings.
  const byKeys = [...new Set(users.flatMap((u) => Object.keys(u.surfacedBy)))].sort();
  for (const k of byKeys) {
    const n = users.reduce((x, u) => x + (u.surfacedBy[k]?.n ?? 0), 0);
    const got = users.reduce((x, u) => x + (u.surfacedBy[k]?.got ?? 0), 0);
    console.log(`  surfaced ${k.padEnd(24)} ${got}/${n}`);
  }
  if (o.suites!.includes("longtail") || o.arriveDays) {
    const rareLists = (ps: Phase[]) =>
      callsWhere(total, (p, src, op) => ps.includes(p) && op === "list" && RARE_SOURCE_IDS.includes(src));
    console.log(
      `rare connectors (${RARE_SOURCE_IDS.length}): listings ${(rareLists(["tick", "notice"]) / days).toFixed(2)} a ` +
        `user-day in the background, ${(rareLists(["request"]) / requests).toFixed(3)} a request, ` +
        `${(rareLists(["backfill"]) / users.length).toFixed(1)} at backfill a user`,
    );
  }
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
  const fates = users.reduce<Record<string, number>>((all, u) => {
    for (const [k, v] of Object.entries(u.fates)) all[k] = (all[k] ?? 0) + v;
    return all;
  }, {});
  console.log(`moved items at their recap: ${JSON.stringify(fates)}`);
  const bySrc: Record<string, string> = {};
  for (const u of users)
    for (const [k, v] of Object.entries(u.bySource)) {
      const [upd, owed] = (bySrc[k] ?? "0/0").split("/").map(Number) as [number, number];
      bySrc[k] = `${upd + v.updated}/${owed + v.owed}`;
    }
  console.log(`owed updates arrived by source (updated/owed): ${JSON.stringify(bySrc)}`);
  if (o.moveAfter) {
    const mid = users.reduce<Record<string, number>>((all, u) => {
      for (const [k, v] of Object.entries(u.midFates)) all[k] = (all[k] ?? 0) + v;
      return all;
    }, {});
    const delays = users.flatMap((u) => u.midDelays).sort((a, b) => a - b);
    const q = (p: number) => (delays.length ? delays[Math.min(delays.length - 1, Math.floor(p * delays.length))] : NaN);
    console.log(
      `moved mid-session (${o.moveAfter} requests after handed), at session end: ${JSON.stringify(mid)}; ` +
        `requests to the update: p50 ${q(0.5)}, p90 ${q(0.9)}, max ${delays.at(-1) ?? NaN}`,
    );
  }
  const out = opt("json", "");
  if (out) writeFileSync(out, JSON.stringify({ label, seeds, days: o.days, requests, userDays: days, total, users }));
}
