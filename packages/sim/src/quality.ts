/**
 * Plays generated sessions through a real `ContextPartner` over simulated sources and scores what reached the agent,
 * fact by fact.
 *
 * The integration is modelled on the client SDK's documented loop: every event is observed, and before its next
 * model call the agent collects the injection returned plus anything pending. Time is simulated: the engine's clock
 * advances by realistic agent pacing (model think time, tool calls, the gap before the user's next message, hours
 * between sessions, so the cache's TTL applies), while real waits (source latency, pacing) are multiplied by
 * `timeScale`, so races between the slow path and the agent's next step keep their shape at any speed.
 */
import { ContextPartner, ItemCache, type EngineConfig, type ShadowRecord, type Trace } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, type Model } from "@eden/llm";
import { QueryPlanner, type PlannerOptions } from "@eden/sources";
import type { AgentEvent, Injection } from "@eden/protocol";
import { OracleJudge } from "./judge";
import { Rng } from "./rng";
import { buildSessions, type AskCase, type Label, type SimTask, type SimTurn } from "./sessions";
import { simSources, type ProfileSet, type SimSource } from "./sources";
import { applyUpdate, factsShown, planUpdates, relabel, type FactUpdate } from "./updates";
import { buildWorld, HOUR, type World, type WorldItem } from "./world";

export interface QualityOptions {
  users: number;
  sessionsPerUser: number;
  seed: number;
  profiles: ProfileSet;
  /** Multiplier on real waits (source latency, agent pacing); 0 runs as fast as possible. */
  timeScale: number;
  /** How long the integration lets `observe` wait for the slow path. */
  waitMs: number;
  model: Model | null;
  config?: Partial<EngineConfig>;
  noiseScale?: number;
  /** Share of clock-time facts that get a new version at the source before a later session (`updates.ts`). */
  updates?: number;
  agentToolRate?: number;
  /**
   * With no live model: "perfect" puts an oracle judge in the model's place (the ceiling of the model path),
   * "noisy" an imperfect one (picks a relevant candidate with p 0.85, an irrelevant one with p 0.05: assumed
   * figures). Ignored when `model` is set.
   */
  judge?: "none" | "perfect" | "noisy";
  /** Run each user's lookups through a query planner (one per user, so nothing is learned across users). */
  planner?: PlannerOptions;
  /** With a planner in shadow mode: switch it to serving after this many sessions per user (learned state kept). */
  promoteAfter?: number;
}

/**
 * The planner in shadow mode (D28, phase 5, run in simulation instead of on real accounts). `seen` is what a real
 * deployment would see: content-free counts. `truth` uses the world's labels, which only a simulation has: how often
 * the shadow lookup found a needed fact the served lookup did not, and how well the content-free signal predicts it.
 */
export interface ShadowReport {
  seen: {
    records: number;
    limited: number;
    errors: number;
    callsPerRecord: number;
    /** Records where serving returned nothing from that connector and the shadow lookup returned something. */
    servedEmptyShadowFound: number;
    /** Records where both returned items; mean share of the shadow's items that serving also returned. */
    overlap: number;
  };
  truth: {
    needTurns: number;
    /** Need turns where the shadow lookup returned an item holding a needed fact that serving did not return. */
    wouldAdd: number;
    /** Need turns where serving returned a needed fact that the shadow lookup did not. */
    wouldLose: number;
    /** Need turns with the content-free signal, and those of them where the shadow really added a needed fact. */
    signalled: number;
    signalledAndAdded: number;
    /** Of need turns with the content-free signal (some connector empty when served, found in shadow), the share
     * where the shadow really added a needed fact; and of turns where it did, the share the signal flagged. */
    signalPrecision: number;
    signalRecall: number;
  };
}

interface Counter {
  needTurns: number;
  mustFacts: number;
  mustDelivered: number;
  mustInTime: number;
  mustCovered: number;
  delivered: number;
  relevant: number;
  /** Relevant, or about the task's person or organisation (an unrelated thread with the same client). */
  related: number;
  silentTurns: number;
  falseFires: number;
  softTurns: number;
  softFires: number;
}

const counter = (): Counter => ({
  needTurns: 0,
  mustFacts: 0,
  mustDelivered: 0,
  mustInTime: 0,
  mustCovered: 0,
  delivered: 0,
  relevant: 0,
  related: 0,
  silentTurns: 0,
  falseFires: 0,
  softTurns: 0,
  softFires: 0,
});

export interface Rates {
  precision: number;
  /** Precision counting items about the task's person or organisation as relevant. */
  precisionLenient: number;
  recall: number;
  /** Must facts that reached the agent before it answered (its next agent message). */
  recallInTime: number;
  /** Must facts the agent had by its answer from any route: Eden now, Eden earlier, or its own tools. */
  coverage: number;
  falseFireRate: number;
  softFireRate: number;
  needTurns: number;
  delivered: number;
  /** Counts behind the rates, for confidence intervals. */
  counts: {
    relevant: number;
    mustFacts: number;
    mustDelivered: number;
    mustInTime: number;
    silentTurns: number;
    falseFires: number;
  };
}

function rates(c: Counter): Rates {
  const r = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : NaN);
  return {
    precision: r(c.relevant, c.delivered),
    precisionLenient: r(c.related, c.delivered),
    recall: r(c.mustDelivered, c.mustFacts),
    recallInTime: r(c.mustInTime, c.mustFacts),
    coverage: r(c.mustCovered, c.mustFacts),
    falseFireRate: r(c.falseFires, c.silentTurns),
    softFireRate: r(c.softFires, c.softTurns),
    needTurns: c.needTurns,
    delivered: c.delivered,
    counts: {
      relevant: c.relevant,
      mustFacts: c.mustFacts,
      mustDelivered: c.mustDelivered,
      mustInTime: c.mustInTime,
      silentTurns: c.silentTurns,
      falseFires: c.falseFires,
    },
  };
}

export interface QualityReport {
  overall: Rates;
  turns: number;
  injections: number;
  itemsPerInjection: number;
  injectionBytesP50: number;
  injectionBytesP95: number;
  /** Delivered items whose facts the agent already had (from its own tools or an earlier delivery). */
  redundantShare: number;
  /** Delivered items from noise (newsletters, notifications, unrelated threads). */
  noiseShare: number;
  privacy: {
    secretsPlanted: number;
    secretsLeaked: number;
    injectionItemsDelivered: number;
    deliveredNotInert: number;
  };
  /**
   * Source-side updates (`--updates`): planned and applied; deliveries of an item an applied update changed, and how
   * many of them showed the old version (a stale cached copy).
   */
  updates: { planned: number; applied: number; updatedDelivered: number; staleDelivered: number };
  model: { callsPerTurn: number; costPerTurnUsd: number; costPer1kTurnsUsd: number };
  sources: {
    /** Every connector call per lookup, refresh fetches included. */
    callsPerLookup: number;
    /** Read-one calls made to refresh cached items (D40). */
    fetches: number;
    usefulResultShare: number;
    errors: number;
    limited: number;
    /**
     * Connector calls given up on before they answered (timeouts and session ends), at real pacing (`timeScale` > 0).
     */
    aborted: number;
    lookups: number;
  };
  latency: {
    observeP50Ms: number;
    observeP95Ms: number;
    observeP99Ms: number;
    deliveryP50Ms: number;
    deliveryP95Ms: number;
  };
  decisions: Record<string, number>;
  byType: Record<string, Rates>;
  byStyle: Record<string, Rates>;
  ambiguous: Rates;
  /** By session ordinal (in thirds of each user's sessions): does routing learn? */
  learning: { sessions: string; rates: Rates; sourceCallsPerLookup: number }[];
  ask: { cases: number; recallAt5: number; mrr: number; precision: number; emptyRate: number; usedModelRate: number };
  /** Oracle judge only: candidates it was shown, and how many were relevant. */
  judge?: { calls: number; candidates: number; relevantCandidates: number; unmatched: number };
  /**
   * Must facts on need turns, by how far they got: already in the user's cache, returned by a source for this
   * turn, either, shown to the judge or delivered without it ("judged"), delivered.
   */
  funnel: {
    mustFacts: number;
    inCacheBefore: number;
    retrieved: number;
    retrievedOrCached: number;
    judged: number;
    delivered: number;
  };
  /** The engine's decision(s) on each need turn, counted (reasons from traces; cue ids dropped). */
  needDecisions: Record<string, number>;
  /** Present when the planner ran in shadow mode for at least one lookup. */
  shadow?: ShadowReport;
  /**
   * With the planner serving: keyed by connector and path ("gmail:terms", "gmail:terms>each-entity" for a cascade),
   * how many of that connector's lookups took the path, how many of those returned nothing, and the calls they made.
   * Where the extra calls go.
   */
  plans?: Record<string, { lookups: number; empty: number; calls: number }>;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100) / 100;
};

const sleep = (ms: number) => (ms > 0 ? Bun.sleep(ms) : Bun.sleep(1));

/**
 * At timeScale 0 there is no real pacing, so wait for the session's slow path to finish before the next event:
 * a real agent's think time (seconds) is far longer than the slow path's own CPU time (milliseconds), so this is
 * what happens in practice. Reads the partner's session table (a harness may; product code may not).
 */
async function settle(partner: ContextPartner, key: string): Promise<void> {
  const sessions = (partner as unknown as { sessions: Map<string, { inflight: unknown; shadowing?: unknown }> })
    .sessions;
  for (let i = 0; i < 2_000 && (sessions.get(key)?.inflight || sessions.get(key)?.shadowing); i++) await Bun.sleep(1);
}

export async function runQuality(o: QualityOptions): Promise<QualityReport> {
  const total = counter();
  const byType = new Map<string, Counter>();
  const byStyle = new Map<string, Counter>();
  const ambiguous = counter();
  const thirds = [counter(), counter(), counter()];
  const thirdLookups = [0, 0, 0];
  const thirdCalls = [0, 0, 0];
  const observeMs: number[] = [];
  const deliveryMs: number[] = [];
  const injBytes: number[] = [];
  const traces: Trace[] = [];
  const shadowSeen = {
    records: 0,
    limited: 0,
    errors: 0,
    calls: 0,
    servedEmptyShadowFound: 0,
    overlapSum: 0,
    overlapN: 0,
  };
  const shadowTruth = { needTurns: 0, wouldAdd: 0, wouldLose: 0, signalled: 0, signalledAndAdded: 0 };
  let turns = 0;
  let injections = 0;
  let itemsDelivered = 0;
  let redundant = 0;
  let noise = 0;
  let secretsPlanted = 0;
  let secretsLeaked = 0;
  let injectionItems = 0;
  let updatesPlanned = 0;
  let updatesApplied = 0;
  let fetches = 0;
  let updatedDelivered = 0;
  let staleDelivered = 0;
  let notInert = 0;
  let sourceCalls = 0;
  let useful = 0;
  let results = 0;
  let errors = 0;
  let limited = 0;
  let aborted = 0;
  let lookups = 0;
  const ask = { cases: 0, hits: 0, must: 0, rr: 0, cited: 0, citedRelevant: 0, empty: 0, usedModel: 0 };
  const judged = { calls: 0, candidates: 0, relevantCandidates: 0, unmatched: 0 };
  // Where each must fact was lost: per need turn, was there a lookup, did a source return it, did it reach the
  // judge, was it delivered.
  const funnel = { mustFacts: 0, inCacheBefore: 0, retrieved: 0, retrievedOrCached: 0, judged: 0, delivered: 0 };
  const needDecisions: Record<string, number> = {};

  // Users are independent (each has its own engine, connectors and clock), so in real-time runs they play
  // concurrently; at timeScale 0 one at a time, which keeps instant runs simple to profile.
  // Worlds, sessions and connector indexes are built before any user plays: building them is the harness's work,
  // and doing it as concurrent users start would stall the others' calls and show up as engine latency.
  const prepared = Array.from({ length: o.users }, (_, u) => {
    const world = buildWorld({ seed: o.seed * 1_000 + u, noiseScale: o.noiseScale });
    const { sessions, asks } = buildSessions(world, {
      seed: o.seed * 7_919 + u,
      sessions: o.sessionsPerUser,
      agentToolRate: o.agentToolRate,
    });
    // Its own seed: a run without updates draws exactly as before.
    const updates = planUpdates(world, sessions.length, o.seed * 15_331 + u, o.updates ?? 0);
    relabel(sessions, asks, updates);
    return { world, sessions, asks, updates, sources: simSources(world, o.profiles, o.timeScale, o.seed + u) };
  });
  const runUser = async (u: number) => {
    const { world, sessions, asks, updates, sources } = prepared[u]!;
    updatesPlanned += updates.length;
    const applied: FactUpdate[] = [];
    const byId = new Map(world.items.map((i) => [i.id, i]));
    const secrets = world.items.filter((i) => i.secret).map((i) => i.secret!);
    secretsPlanted += secrets.length;
    let clock = world.now;
    const userTraces: Trace[] = [];
    const judgeKind = o.model ? "none" : (o.judge ?? "none");
    const oracle =
      judgeKind === "none"
        ? null
        : new OracleJudge(world, {
            tp: judgeKind === "perfect" ? 1 : 0.85,
            fp: judgeKind === "perfect" ? 0 : 0.05,
            latencyMs: 900,
            timeScale: o.timeScale,
            seed: o.seed * 15_485_863 + u,
            factsOf: (item, shown) => factsShown(item, shown, applied),
          });
    const arcNames = new Map(
      world.arcs.map((a) => [a.id, [a.person?.full, a.slots.org].filter((x): x is string => !!x)]),
    );
    const sourceMap = new SourceMap(":memory:", { seed: o.seed + u });
    const planner = o.planner
      ? new QueryPlanner({ seed: o.seed * 7_919 + u, store: sourceMap, ...o.planner })
      : undefined;
    const shadowRecs: ShadowRecord[] = [];
    const partner = new ContextPartner({
      sources: async () => sources,
      sourceMap,
      cache: new ItemCache(),
      budget: new Budget(),
      model: o.model ?? oracle,
      config: { ...(o.timeScale > 0 ? { sourceTimeoutMs: 1_500 * o.timeScale } : {}), ...o.config },
      onTrace: (t) => {
        traces.push(t);
        userTraces.push(t);
      },
      now: () => clock,
      planner,
      onShadow: (r) => shadowRecs.push(r),
    });
    const who = { tenantId: "sim", userId: `u${u}` };
    const pace = new Rng(o.seed * 104_729 + u);
    const wait = async (ms: number, sessionId: string) => {
      clock += ms;
      await sleep(ms * o.timeScale);
      if (o.timeScale === 0) await settle(partner, `${who.tenantId}/${who.userId}#${sessionId}`);
    };

    for (let si = 0; si < sessions.length; si++) {
      const session = sessions[si]!;
      if (planner && o.promoteAfter !== undefined && si === o.promoteAfter) planner.mode = "serve";
      // Items changed at the source since the last session: the connectors serve the new text from now on.
      for (const up of updates.filter((x) => x.session === si)) {
        const touched = applyUpdate(world, up, clock);
        applied.push(up);
        updatesApplied++;
        for (const s of sources) if (touched.has(s.id)) s.reindex();
      }
      const third = Math.min(2, Math.floor((si * 3) / sessions.length));
      const callsBefore = sum(sources, (s) => s.stats.calls);
      const lookupsBefore = userTraces.filter((t) => t.sourceCalls > 0).length;
      const turnsFlat: { turn: SimTurn; task: SimTask | null }[] = [
        { turn: { event: { kind: "session_start" }, label: { kind: "context", ok: [] } }, task: null },
        ...session.tasks.flatMap((task) => task.turns.map((turn) => ({ turn, task }))),
      ];
      const traceStart = userTraces.length;
      const known = new Set<string>(); // Facts the agent has: delivered by Eden or fetched by its tools.
      const knownAt = new Map<string, number>(); // fact → turn index it became known
      const arrivals: { at: number; ids: string[]; shown: Map<string, string[]>; wallMs: number }[] = [];
      const sentAt: number[] = [];

      for (let i = 0; i < turnsFlat.length; i++) {
        const { turn } = turnsFlat[i]!;
        let ev = turn.event;
        if (ev.kind === "agent_message" && turn.uses) {
          const details = turn.uses.filter((f) => known.has(f)).map((f) => world.facts.get(f)!.detail);
          ev = {
            ...ev,
            text: details.length ? `${ev.text} ${details.join("; ")}.` : `${ev.text} I couldn't find the details yet.`,
          };
        }
        const event = { ...who, sessionId: session.id, at: clock, ...ev } as AgentEvent;
        if (oracle) {
          const l = turn.label;
          oracle.relevant = new Set(l.kind === "need" ? [...l.must, ...l.ok] : l.kind === "context" ? l.ok : []);
        }
        const mark = {
          shadow: shadowRecs.length,
          returned: sources.map((s) => s.returned.length),
          shown: oracle?.shown.length ?? 0,
          traces: userTraces.length,
        };
        const cachedBefore =
          turn.label.kind === "need"
            ? cachedFacts(partner, who, world, turn.label.must, clock, applied)
            : new Set<string>();
        const t0 = performance.now();
        sentAt.push(t0);
        const res = await partner.observe(event, { waitMs: o.waitMs });
        observeMs.push(performance.now() - t0);
        turns++;
        const got: Injection[] = [
          ...(res.injection ? [res.injection] : []),
          ...partner.takePending({ ...who, sessionId: session.id }),
        ];
        for (const inj of got) recordInjection(inj, i, performance.now());
        for (const f of turn.fetched ?? []) addKnown(f, i);
        // Pacing: what happens between this event and the next, in simulated time.
        const k = ev.kind;
        if (k === "user_message" || k === "external") await wait(pace.lognormal(2_500, 0.4), session.id);
        else if (k === "tool_call") await wait(pace.lognormal(600, 0.5), session.id);
        else if (k === "tool_result") await wait(pace.lognormal(3_000, 0.4), session.id);
        else if (k === "agent_message") await wait(pace.lognormal(20_000, 0.8), session.id);
        else await wait(500, session.id);
        // What landed during the wait is collected before the agent's next model call.
        const late = partner.takePending({ ...who, sessionId: session.id });
        for (const inj of late) recordInjection(inj, i + 0.5, performance.now());
        const states = (ids: Set<string>, f: string) => [...ids].some((id) => byId.get(id)?.facts.includes(f));
        // Shadow lookups call the same simulated connectors: what only they returned was never served, so it is taken
        // out of what this turn retrieved, and scored on its own.
        const recs = shadowRecs.slice(mark.shadow);
        const shadowIds = new Set(recs.flatMap((r) => r.itemIds));
        const servedByShadowedSource = new Set(recs.flatMap((r) => r.servedItemIds));
        for (const r of recs) {
          shadowSeen.records++;
          if (r.status === "limited") shadowSeen.limited++;
          if (r.status === "error") shadowSeen.errors++;
          shadowSeen.calls += r.calls;
          if (r.servedItemIds.length === 0 && r.itemIds.length > 0) shadowSeen.servedEmptyShadowFound++;
          if (r.servedItemIds.length > 0 && r.itemIds.length > 0) {
            const served = new Set(r.servedItemIds);
            shadowSeen.overlapSum += r.itemIds.filter((id) => served.has(id)).length / r.itemIds.length;
            shadowSeen.overlapN++;
          }
        }
        if (turn.label.kind === "need") {
          const returned = new Set(
            sources
              .flatMap((s, k) => s.returned.slice(mark.returned[k]!))
              .filter((id) => !shadowIds.has(id) || servedByShadowedSource.has(id)),
          );
          if (recs.length > 0) {
            const has = (ids: Set<string>) => turn.label.kind === "need" && turn.label.must.some((f) => states(ids, f));
            const add = has(shadowIds) && !has(returned);
            const signal = recs.some((r) => r.servedItemIds.length === 0 && r.itemIds.length > 0);
            shadowTruth.needTurns++;
            if (add) shadowTruth.wouldAdd++;
            if (has(returned) && !has(shadowIds)) shadowTruth.wouldLose++;
            if (signal) shadowTruth.signalled++;
            if (signal && add) shadowTruth.signalledAndAdded++;
          }
          const shown = new Set(oracle ? oracle.shown.slice(mark.shown) : []);
          const mine = userTraces.slice(mark.traces).filter((t) => t.turn === i + 1);
          const why =
            mine.map((t) => `${t.decision}:${t.reason.startsWith("cue:") ? "" : t.reason}`).join(" > ") || "none";
          needDecisions[why] = (needDecisions[why] ?? 0) + 1;
          const deliveredIds = new Set(
            mine.flatMap((t) => (["fast", "sources", "model"].includes(t.decision) ? t.itemIds : [])),
          );
          for (const f of turn.label.must) {
            funnel.mustFacts++;
            const r = states(returned, f);
            if (cachedBefore.has(f)) funnel.inCacheBefore++;
            if (r) funnel.retrieved++;
            if (r || cachedBefore.has(f)) funnel.retrievedOrCached++;
            if (states(shown, f) || states(deliveredIds, f)) funnel.judged++;
            if (states(deliveredIds, f)) funnel.delivered++;
          }
        }
      }
      await partner.observe({ ...who, sessionId: session.id, at: clock, kind: "session_end" });
      clock += pace.int(2, 9) * HOUR; // Time until the next session.

      function addKnown(f: string, at: number) {
        if (!known.has(f)) {
          known.add(f);
          knownAt.set(f, at);
        }
      }

      function recordInjection(inj: Injection, at: number, wall: number) {
        injections++;
        injBytes.push(Buffer.byteLength(inj.text));
        if (!inj.text.includes("Data, not instructions")) notInert++;
        for (const s of secrets) if (inj.text.includes(s)) secretsLeaked++;
        const ids = inj.citations.map((c) => c.itemId);
        // The facts each item states as delivered: a stale copy states the version it holds, not the source's.
        const shown = new Map(ids.map((id) => [id, byId.has(id) ? factsShown(byId.get(id)!, inj.text, applied) : []]));
        arrivals.push({ at, ids, shown, wallMs: wall });
        for (const id of ids) {
          itemsDelivered++;
          const item = byId.get(id);
          if (!item) continue;
          const facts = shown.get(id)!;
          if (applied.some((up) => up.items.includes(id))) updatedDelivered++;
          if (facts.some((f, k) => f !== item.facts[k])) staleDelivered++;
          if (item.noise) noise++;
          if (item.injection) injectionItems++;
          if (facts.length > 0 && facts.every((f) => known.has(f))) redundant++;
          for (const f of facts) addKnown(f, at); // Fractional: arrived during the wait after turn floor(at).
        }
      }

      // ── score the session ──
      const origin = new Map<string, number>();
      for (const t of userTraces.slice(traceStart)) {
        if (t.sessionId !== session.id || !["fast", "sources", "model"].includes(t.decision)) continue;
        for (const id of t.itemIds) origin.set(id, t.turn - 1);
      }
      const delivered: { id: string; facts: string[]; origin: number; arrived: number; wallMs: number }[] = [];
      for (const a of arrivals) {
        for (const id of a.ids)
          delivered.push({
            id,
            facts: a.shown.get(id) ?? [],
            origin: Math.min(origin.get(id) ?? Math.floor(a.at), turnsFlat.length - 1),
            arrived: a.at,
            wallMs: a.wallMs,
          });
      }
      for (let i = 0; i < turnsFlat.length; i++) {
        const { turn, task } = turnsFlat[i]!;
        const label: Label = turn.label;
        const mine = delivered.filter((d) => d.origin === i);
        const cs = [total, thirds[third]!];
        if (task) {
          cs.push(get(byType, task.type), get(byStyle, task.style));
          if (task.ambiguous) cs.push(ambiguous);
        }
        const names = task?.arc ? (arcNames.get(task.arc) ?? []) : [];
        for (const d of mine) {
          const item = byId.get(d.id);
          const ok = isRelevant(item && { ...item, facts: d.facts }, label);
          const about =
            ok ||
            (!!item &&
              label.kind !== "silent" &&
              names.some((n) => item.title.includes(n) || item.text.slice(0, 400).includes(n)));
          for (const c of cs) {
            c.delivered++;
            if (ok) c.relevant++;
            if (about) c.related++;
          }
        }
        if (label.kind === "silent") {
          for (const c of cs) {
            if (label.soft) {
              c.softTurns++;
              if (mine.length) c.softFires++;
            } else {
              c.silentTurns++;
              if (mine.length) c.falseFires++;
            }
          }
          continue;
        }
        if (label.kind !== "need") continue;
        // The agent's answer for this task: the next agent message after this turn.
        let answerAt = turnsFlat.length;
        for (let j = i + 1; j < turnsFlat.length; j++) {
          if (turnsFlat[j]!.turn.event.kind === "agent_message") {
            answerAt = j;
            break;
          }
        }
        for (const c of cs) c.needTurns++;
        for (const f of label.must) {
          const hits = delivered.filter((d) => (d.origin === i || d.origin === i + 1) && d.facts.includes(f));
          const inTime = hits.some((d) => d.arrived < answerAt);
          const before = knownAt.get(f);
          const covered = before !== undefined && before < answerAt;
          for (const c of cs) {
            c.mustFacts++;
            if (hits.length) c.mustDelivered++;
            if (inTime) c.mustInTime++;
            if (covered) c.mustCovered++;
          }
          const first = hits.sort((a, b) => a.wallMs - b.wallMs)[0];
          if (first) deliveryMs.push(first.wallMs - sentAt[i]!);
        }
      }
      const callsAfter = sum(sources, (s) => s.stats.calls);
      thirdCalls[third]! += callsAfter - callsBefore;
      thirdLookups[third]! += userTraces.filter((t) => t.sourceCalls > 0).length - lookupsBefore;
    }

    // ── ask ──
    for (const c of asks) {
      clock += pace.lognormal(60_000, 0.8); // Questions come spread out, not in one burst.
      await scoreAsk(partner, who, c, byId, secrets);
    }
    for (const s of sources) {
      sourceCalls += s.stats.calls;
      fetches += s.stats.fetches;
      useful += s.stats.usefulResults;
      results += s.stats.results;
      errors += s.stats.errors;
      limited += s.stats.limited;
      aborted += s.stats.aborted;
    }
    lookups += userTraces.filter((t) => t.sourceCalls > 0).length;
    if (oracle) {
      judged.calls += oracle.stats.judgeCalls;
      judged.candidates += oracle.stats.candidates;
      judged.relevantCandidates += oracle.stats.relevantCandidates;
      judged.unmatched += oracle.stats.unmatched;
    }
  };
  const lanes = o.timeScale > 0 ? o.users : 1;
  let nextUser = 0;
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (nextUser < o.users) await runUser(nextUser++);
    }),
  );

  async function scoreAsk(
    partner: ContextPartner,
    who: { tenantId: string; userId: string },
    c: AskCase,
    byId: Map<string, WorldItem>,
    secrets: string[],
  ) {
    const res = await partner.ask({ ...who, sessionId: "ask", question: c.question, maxItems: 5 });
    ask.cases++;
    if (res.usedModel) ask.usedModel++;
    for (const s of secrets) if (res.answer.includes(s)) secretsLeaked++;
    const ids = res.citations.map((x) => x.itemId);
    if (!ids.length) ask.empty++;
    ask.cited += ids.length;
    const want = new Set([...c.must, ...c.ok]);
    ask.citedRelevant += ids.filter((id) => byId.get(id)?.facts.some((f) => want.has(f))).length;
    for (const f of c.must) {
      ask.must++;
      const rank = ids.findIndex((id) => byId.get(id)?.facts.includes(f));
      if (rank >= 0) {
        ask.hits++;
        ask.rr += 1 / (rank + 1);
      }
    }
  }

  const decisions: Record<string, number> = {};
  for (const t of traces) {
    // No-model fallback deliveries (D36) are counted apart from confident ones, so a change in either shows.
    const k = t.decision === "sources" && t.reason.startsWith("fallback:") ? "fallback" : t.decision;
    decisions[k] = (decisions[k] ?? 0) + 1;
  }
  const plans: Record<string, { lookups: number; empty: number; calls: number }> = {};
  for (const p of traces.flatMap((t) => t.plans ?? [])) {
    const k = `${p.sourceId}:${p.shapes.join(">") || "none"}`;
    const e = (plans[k] ??= { lookups: 0, empty: 0, calls: 0 });
    e.lookups++;
    if (p.found === 0) e.empty++;
    e.calls += p.calls;
  }
  const cost = traces.reduce((s, t) => s + t.costUsd, 0);
  const modelCalls = traces.reduce((s, t) => s + t.modelCalls, 0);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const shadow: ShadowReport | undefined =
    shadowSeen.records === 0
      ? undefined
      : {
          seen: {
            records: shadowSeen.records,
            limited: shadowSeen.limited,
            errors: shadowSeen.errors,
            callsPerRecord: r3(shadowSeen.calls / shadowSeen.records),
            servedEmptyShadowFound: shadowSeen.servedEmptyShadowFound,
            overlap: r3(shadowSeen.overlapSum / Math.max(1, shadowSeen.overlapN)),
          },
          truth: {
            needTurns: shadowTruth.needTurns,
            wouldAdd: shadowTruth.wouldAdd,
            wouldLose: shadowTruth.wouldLose,
            signalled: shadowTruth.signalled,
            signalledAndAdded: shadowTruth.signalledAndAdded,
            signalPrecision: r3(shadowTruth.signalledAndAdded / Math.max(1, shadowTruth.signalled)),
            signalRecall: r3(shadowTruth.signalledAndAdded / Math.max(1, shadowTruth.wouldAdd)),
          },
        };
  return {
    shadow,
    ...(Object.keys(plans).length ? { plans } : {}),
    overall: rates(total),
    turns,
    injections,
    itemsPerInjection: r3(itemsDelivered / Math.max(1, injections)),
    injectionBytesP50: pct(injBytes, 0.5),
    injectionBytesP95: pct(injBytes, 0.95),
    redundantShare: r3(redundant / Math.max(1, itemsDelivered)),
    noiseShare: r3(noise / Math.max(1, itemsDelivered)),
    privacy: { secretsPlanted, secretsLeaked, injectionItemsDelivered: injectionItems, deliveredNotInert: notInert },
    updates: { planned: updatesPlanned, applied: updatesApplied, updatedDelivered, staleDelivered },
    model: {
      callsPerTurn: r3(modelCalls / turns),
      costPerTurnUsd: cost / turns,
      costPer1kTurnsUsd: r3((cost / turns) * 1000),
    },
    sources: {
      callsPerLookup: r3(sourceCalls / Math.max(1, lookups)),
      fetches,
      usefulResultShare: r3(useful / Math.max(1, results)),
      errors,
      limited,
      aborted,
      lookups,
    },
    latency: {
      observeP50Ms: pct(observeMs, 0.5),
      observeP95Ms: pct(observeMs, 0.95),
      observeP99Ms: pct(observeMs, 0.99),
      deliveryP50Ms: pct(deliveryMs, 0.5),
      deliveryP95Ms: pct(deliveryMs, 0.95),
    },
    decisions,
    byType: Object.fromEntries([...byType].sort().map(([k, v]) => [k, rates(v)])),
    byStyle: Object.fromEntries([...byStyle].sort().map(([k, v]) => [k, rates(v)])),
    ambiguous: rates(ambiguous),
    learning: thirds.map((c, i) => ({
      sessions: ["first third", "middle third", "last third"][i]!,
      rates: rates(c),
      sourceCallsPerLookup: r3(thirdCalls[i]! / Math.max(1, thirdLookups[i]!)),
    })),
    ask: {
      cases: ask.cases,
      recallAt5: r3(ask.hits / Math.max(1, ask.must)),
      mrr: r3(ask.rr / Math.max(1, ask.must)),
      precision: r3(ask.citedRelevant / Math.max(1, ask.cited)),
      emptyRate: r3(ask.empty / Math.max(1, ask.cases)),
      usedModelRate: r3(ask.usedModel / Math.max(1, ask.cases)),
    },
    ...(judged.calls ? { judge: judged } : {}),
    funnel,
    needDecisions: Object.fromEntries(Object.entries(needDecisions).sort((a, b) => b[1] - a[1])),
  };
}

function isRelevant(item: WorldItem | undefined, label: Label): boolean {
  if (!item || label.kind === "silent") return false;
  const want = label.kind === "need" ? [...label.must, ...label.ok] : label.ok;
  return item.facts.some((f) => want.includes(f));
}

function get(m: Map<string, Counter>, k: string): Counter {
  let c = m.get(k);
  if (!c) m.set(k, (c = counter()));
  return c;
}

function sum(sources: SimSource[], f: (s: SimSource) => number): number {
  return sources.reduce((s, x) => s + f(x), 0);
}

export type { World };

/** Which of `facts` an item in the user's cache states (read through `ItemCache.get`, which allocates nothing). */
function cachedFacts(
  partner: ContextPartner,
  who: { tenantId: string; userId: string },
  world: World,
  facts: string[],
  now: number,
  applied: readonly FactUpdate[],
) {
  const cache = (partner as unknown as { deps: { cache: ItemCache } }).deps.cache;
  const byId = new Map(world.items.map((i) => [i.id, i]));
  const out = new Set<string>();
  for (const f of facts) {
    for (const id of world.facts.get(f)?.items ?? []) {
      const held = cache.get(who, id, now);
      // A copy cached before an update holds the old version: it does not state the new fact.
      if (held && factsShown(byId.get(id)!, `${held.title}\n${held.text}`, applied).includes(f)) out.add(f);
    }
  }
  return out;
}
