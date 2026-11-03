#!/usr/bin/env bun
/**
 * The reader gate on simulated realistic sessions, at no cost (`bun run gate-traffic`; docs/COST-MODEL.md).
 *
 * The phase 3 suites are constraint-shaped by design, so `readerGate` skipped only 2–10 of 768 requests there
 * (docs/research/haiku-phase3.md) and its saving on everyday traffic was unmeasured. This plays `sessions.ts`'s
 * sessions (requests that need context, inbound mail, small talk, off-world and novel requests, passing mentions)
 * through a real `ContextPartner` with the lab presets' reader settings, and a reader that makes no model call: a
 * stub maker that counts the calls the engine would have made and says nothing binds. It reports, per preset:
 *
 * - reader calls per user message, and how each user message ended at the reader: `read` (a call or a cached
 *   verdict), `gated` (`readerGate` skipped the call), `none` (an empty pool), or `skipped` (not read at all: under
 *   NEWL a request that does not act is never pushed);
 * - the gated share: gated over the messages that reached the gate (a non-empty pool);
 * - the missed-binding rate: gated messages whose pool held an item stating a fact the turn's ground truth needs
 *   (`must`), over gated messages; and the same over every message whose pool held one;
 * - card coverage: the share of the request's own pool items (standing constraints left out: they never open the
 *   gate) whose card is known without a model call (a replayed card, or the prefilter's no), and the gated share
 *   counted on fully covered pools only. Items with no replayed card look
 *   unconstrained to the gate, so a low coverage overstates the skip rate.
 *
 * Setup: worlds `buildWorld({seed: seed * 1_000})` (the funnel's, whose items the checked-in card caches cover),
 * sessions `buildSessions(world, {seed: seed * 7_919})`, every item synced into Eden's cache before the first session
 * (the funnel's `--sync` experiment) with its replayed card, REALISTIC sources at time 0. `intent` is on in the presets
 * but no requests file is replayed, so it finds nothing. The stub's empty verdicts change nothing the gate sees.
 * Deterministic: the same seeds give the same numbers. Simulated sessions, not production traffic.
 *
 *   bun run gate-traffic [--seeds 41,42,43,44] [--sessions 40] [--json out.json] [--record]
 *
 * `--record` appends one line to bench/ledger.jsonl (no per-row file).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeOn,
  AskReader,
  CardEnricher,
  cardKey,
  ContextPartner,
  DIGEST_KINDS,
  ItemCache,
  worthCarding,
  worthCardingStrict,
  type EngineConfig,
  type ReaderMaker,
  type ReaderReport,
} from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { buildSessions, type Label } from "../sessions";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { DiskCardMaker } from "./cards-disk";
import { record, tidy } from "./ledger";
import { PRESETS } from "./presets";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
const SESSIONS = Number(opt("sessions", "40"));
const JSON_OUT = opt("json", "");
const RECORD = args.includes("--record");

/** The presets measured: the two with the gate, and each without it for the calls the gate saves. */
const CONFIGS: Record<string, Partial<EngineConfig>> = {
  NEWL: { ...PRESETS.NEWL },
  "NEWL-nogate": { ...PRESETS.NEWL, readerGate: false },
  "NEW2+gate": { ...PRESETS.NEW2, readerGate: true },
  NEW2: { ...PRESETS.NEW2 },
};

const UNCAPPED = { callsPerSession: Infinity, usdPerSession: Infinity, usdPerUserDay: Infinity };
const cardsDir = join(import.meta.dir, "..", "..", "lab", "cards");
// Both checked-in caches are read; no live maker is given, so nothing is ever written to either (`put` is only
// called for a live call's cards).
const cardMaker = new DiskCardMaker(join(cardsDir, "cards-v2.jsonl"), undefined, {
  out: join(cardsDir, "cards-train.jsonl"),
});

/** The reader with no model: counts the calls the engine makes and says nothing binds. */
class CountingReader implements ReaderMaker {
  calls = 0;
  async read() {
    this.calls++;
    return { bears: [], rejected: [], costUsd: 0 };
  }
}

type Outcome = ReaderReport["outcome"] | "skipped";

interface Tally {
  messages: number;
  calls: number;
  outcomes: Record<Outcome, number>;
  /** Messages whose pool held an item stating a `must` fact of the turn, and how many of those were gated. */
  bindingInPool: number;
  bindingGated: number;
  /** Pool items at the gate (reports with a pool), and those whose card is known without a model call. */
  poolItems: number;
  poolCovered: number;
  /** Messages at the gate whose whole pool was covered, and how many of those were gated. */
  coveredPools: number;
  coveredGated: number;
}

const tally = (): Tally => ({
  messages: 0,
  calls: 0,
  outcomes: { read: 0, gated: 0, none: 0, late: 0, skipped: 0 },
  bindingInPool: 0,
  bindingGated: 0,
  poolItems: 0,
  poolCovered: 0,
  coveredPools: 0,
  coveredGated: 0,
});

/** Waits for the session's background work (as `quality.ts` `settle`; harness only). */
async function settle(partner: ContextPartner, key: string): Promise<void> {
  const sessions = (partner as unknown as { sessions: Map<string, { inflight: unknown; ant?: { running: unknown } }> })
    .sessions;
  const busy = () => {
    const s = sessions.get(key);
    return !!(s?.inflight || s?.ant?.running);
  };
  for (let i = 0; i < 2_000 && busy(); i++) await Bun.sleep(1);
}

async function runSeed(config: Partial<EngineConfig>, seed: number, total: Tally, byType: Map<string, Tally>) {
  const world = buildWorld({ seed: seed * 1_000 });
  const { sessions } = buildSessions(world, { seed: seed * 7_919, sessions: SESSIONS });
  const sources = simSources(world, REALISTIC, 0, seed);
  const facts = new Map(world.items.map((i) => [i.id, i.facts]));
  let clock = world.now;
  const scope = { tenantId: "gate", userId: `w${seed}` };
  const cache = new ItemCache();
  const cards = new CardEnricher({ maker: cardMaker, budget: new Budget(UNCAPPED), now: () => clock });
  const maker = new CountingReader();
  const reader = new AskReader({ maker, budget: new Budget(UNCAPPED), now: () => clock });
  let reports: ReaderReport[] = [];
  const partner = new ContextPartner({
    sources: async () => sources,
    sourceMap: new SourceMap(":memory:", { seed }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    config,
    cards,
    reader,
    onReader: (r) => reports.push(r),
  });
  // Every item synced with its replayed card before the first session (built after the partner, which sets the
  // enricher's economy and intent modes from the config).
  const synced = cache.put(
    scope,
    sources.flatMap((s) => s.listAll()),
    clock,
  );
  cards.enqueue(scope, synced);
  await cards.idle();
  const prefilter = config.cardsEconomy ? worthCardingStrict : worthCarding;
  const covered = (id: string) => {
    const item = cache.get(scope, id, clock);
    return !!item && (cardMaker.cards.has(cardKey(item)) || !prefilter(item));
  };
  // `askReaderStanding`: the user's standing constraints lead the pool and never open the gate, so coverage is counted
  // on the request's own candidates after them. They are the pool's leading items with an active card of a standing
  // kind, at most `askReaderStanding` (the engine's own list, newest first, deduped against the ranking).
  const standingCap = config.askReaderStanding ?? 0;
  const ownPool = (pool: string[]) => {
    if (standingCap <= 0) return pool;
    const today = new Date(clock).toISOString().slice(0, 10);
    const held = cards.cardsOf(scope, pool, clock + 1);
    let n = 0;
    while (n < Math.min(standingCap, pool.length)) {
      const card = held.get(pool[n]!);
      if (!card || !DIGEST_KINDS.has(card.kind) || !activeOn(card, today)) break;
      n++;
    }
    return pool.slice(n);
  };

  for (const session of sessions) {
    for (const task of session.tasks) {
      for (const turn of task.turns) {
        clock += 20_000;
        const event = { ...scope, sessionId: session.id, at: clock, ...turn.event } as AgentEvent;
        reports = [];
        const before = maker.calls;
        await partner.observe(event, { waitMs: 5_000 });
        await settle(partner, `${scope.tenantId}/${scope.userId}#${session.id}`);
        if (turn.event.kind !== "user_message") continue;
        const t = byType.get(task.type) ?? tally();
        byType.set(task.type, t);
        // The push's report is the message's (an observe makes at most one ask of its own).
        const r = reports[0];
        const outcome: Outcome = r ? r.outcome : "skipped";
        const must = mustOf(turn.label);
        const binding = !!r && r.pool.some((id) => facts.get(id)?.some((f) => must.has(f)));
        const own = r ? ownPool(r.pool) : [];
        const atGate = !!r && r.pool.length > 0;
        const cov = own.filter(covered).length;
        for (const x of [t, total]) {
          x.messages++;
          x.calls += maker.calls - before;
          x.outcomes[outcome]++;
          if (binding) {
            x.bindingInPool++;
            if (outcome === "gated") x.bindingGated++;
          }
          if (atGate) {
            x.poolItems += own.length;
            x.poolCovered += cov;
            if (cov === own.length) {
              x.coveredPools++;
              if (outcome === "gated") x.coveredGated++;
            }
          }
        }
      }
    }
  }
  partner.stopSync();
}

const mustOf = (label: Label) => new Set(label.kind === "need" ? label.must : []);

const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
function summary(t: Tally) {
  const atGate = t.outcomes.read + t.outcomes.gated + t.outcomes.late;
  return {
    messages: t.messages,
    calls: t.calls,
    callsPerMessage: ratio(t.calls, t.messages),
    read: t.outcomes.read,
    gated: t.outcomes.gated,
    emptyPool: t.outcomes.none,
    skipped: t.outcomes.skipped,
    gatedShare: ratio(t.outcomes.gated, atGate),
    missedBindingRate: ratio(t.bindingGated, t.outcomes.gated),
    bindingGatedShare: ratio(t.bindingGated, t.bindingInPool),
    bindingInPool: t.bindingInPool,
    cardCoverage: ratio(t.poolCovered, t.poolItems),
    coveredPools: t.coveredPools,
    gatedShareCovered: ratio(t.coveredGated, t.coveredPools),
  };
}

const t0 = performance.now();
const results: Record<string, { all: ReturnType<typeof summary>; byType: Record<string, ReturnType<typeof summary>> }> =
  {};
for (const [name, config] of Object.entries(CONFIGS)) {
  const total = tally();
  const byType = new Map<string, Tally>();
  for (const seed of SEEDS) await runSeed(config, seed, total, byType);
  results[name] = {
    all: summary(total),
    byType: Object.fromEntries(
      [...byType.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, summary(v)]),
    ),
  };
}
const wallSeconds = (performance.now() - t0) / 1_000;

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
for (const [name, r] of Object.entries(results)) {
  const a = r.all;
  console.log(
    `${name.padEnd(12)} ${a.messages} user messages: ${a.calls} reader calls (${a.callsPerMessage.toFixed(3)} per ` +
      `message); read ${a.read}, gated ${a.gated}, empty pool ${a.emptyPool}, not read ${a.skipped}; gated share ` +
      `${pct(a.gatedShare)}; missed-binding ${a.missedBindingRate.toFixed(3)} (${a.bindingGatedShare.toFixed(3)} of ` +
      `${a.bindingInPool} pools holding a needed item); card coverage ${pct(a.cardCoverage)}, gated share on fully ` +
      `covered pools ${pct(a.gatedShareCovered)} (${a.coveredPools} pools)`,
  );
  for (const [type, s] of Object.entries(r.byType)) {
    console.log(
      `  ${type.padEnd(18)} ${String(s.messages).padStart(4)} msgs  calls/msg ${s.callsPerMessage.toFixed(3)}  read ` +
        `${s.read}  gated ${s.gated}  empty ${s.emptyPool}  not read ${s.skipped}  missed-binding ` +
        `${s.missedBindingRate.toFixed(3)}  coverage ${pct(s.cardCoverage)}`,
    );
  }
}
console.log(`seeds ${SEEDS.join(",")}, ${SESSIONS} sessions each, ${wallSeconds.toFixed(1)} s`);

if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify({ seeds: SEEDS, sessions: SESSIONS, results }, null, 2)}\n`);
if (RECORD) {
  const metrics: Record<string, number> = {};
  for (const [name, r] of Object.entries(results)) {
    for (const [k, v] of Object.entries(r.all)) metrics[`${name}.${k}`] = v;
  }
  const entry = record(
    {
      tier: "sim",
      suite: "sessions",
      label: "gate-traffic",
      config: { presets: Object.keys(CONFIGS), sessions: SESSIONS, reader: "counting stub (no model)", sync: true },
      seeds: SEEDS,
      costUsd: 0,
      wallSeconds: Number(wallSeconds.toFixed(1)),
      metrics: tidy(metrics),
      note: "SIMULATED: sessions.ts sessions, not production traffic; stub reader, replayed cards",
    },
    [],
  );
  console.log(`recorded ${entry.id}`);
}
