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
 *   the default a request that does not act is never pushed);
 * - the gated share: gated over the messages that reached the gate (a non-empty pool);
 * - the missed-binding rate: gated messages whose pool held an item stating a fact the turn's ground truth needs
 *   (`must`), over gated messages; and the same over every message whose pool held one;
 * - card coverage: the share of the request's pool items whose card is known without a model call (a replayed card,
 *   or the prefilter's no), and the gated share counted on fully covered pools only. Items with no replayed card look
 *   unconstrained to the gate, so a low coverage overstates the skip rate.
 *
 * Setup: worlds `buildWorld({seed: seed * 1_000})` (the funnel's, whose items the checked-in card caches cover),
 * sessions `buildSessions(world, {seed: seed * 7_919})`, every item synced into Eden's cache before the first session
 * (the funnel's `--sync` experiment) with its replayed card, REALISTIC sources at time 0. `intent` is on in the presets
 * but no requests file is replayed, so it finds nothing. The stub's empty verdicts change nothing the gate sees.
 * Deterministic: the same seeds give the same numbers. Simulated sessions, not production traffic.
 *
 * Ceilings (docs/COST-MODEL.md "Where 3x is impossible"), printed under each preset:
 *
 * - the oracle gate: a gate that knew the ground truth would still call for every message at the gate whose pool
 *   holds an item stating a fact the reader is for. Counted twice: over any `must` fact (an upper bound on what an
 *   oracle needs, since most `must` facts are plain information the reader is not for), and over the reader-relevant
 *   facts only (`READER_FACTS`: a constraint, a blocker, an invoice already paid; those the turn needs, then those
 *   the turn needs or may use, as a meeting's constraint is labelled `ok`). The ceiling is this preset's calls over
 *   the oracle's.
 * - need turns among the unread: user messages the preset never read (`skipped`) or gated whose label is a need, and
 *   how many of those needed a reader-relevant fact.
 * - `--reuse`: what a verdict reused across one user's sessions could save (the engine caches per session only,
 *   reader.ts). Among the messages that made a call, one repeats when the same user made a call earlier with the same
 *   exact input (request text and pool), the same pool (ids in order), or the same task type and the same set of
 *   pool items stating a needed fact (an oracle memo). The ceiling is calls over calls not repeated. Sessions'
 *   requests are templated, so exact repeats overstate what real traffic would repeat.
 *
 *   bun run gate-traffic [--seeds 41,42,43,44] [--sessions 40] [--json out.json] [--record] [--reuse]
 *
 * `--record` appends one line to bench/ledger.jsonl (no per-row file).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AskReader,
  CardEnricher,
  cardKey,
  ContextPartner,
  ItemCache,
  worthCarding,
  worthCardingStrict,
  type EngineConfig,
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
import { CountingReader } from "./reader-stub";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const SEEDS = opt("seeds", "41,42,43,44").split(",").map(Number);
const SESSIONS = Number(opt("sessions", "40"));
const JSON_OUT = opt("json", "");
const RECORD = args.includes("--record");
const REUSE = args.includes("--reuse");

/** The preset measured with the gate, and without it for the calls the gate saves. */
const CONFIGS: Record<string, Partial<EngineConfig>> = {
  default: { ...PRESETS.default },
  "default-nogate": { ...PRESETS.default, readerGate: false },
};

const UNCAPPED = { callsPerSession: Infinity, usdPerSession: Infinity, usdPerUserDay: Infinity };
const cardsDir = join(import.meta.dir, "..", "..", "lab", "cards");
// Both checked-in caches are read; no live maker is given, so nothing is ever written to either (`put` is only
// called for a live call's cards).
const cardMaker = new DiskCardMaker(join(cardsDir, "cards-v2.jsonl"), undefined, {
  out: join(cardsDir, "cards-train.jsonl"),
});

type Outcome = ReaderReport["outcome"] | "skipped";
// "budget" (the gate passed but the reader's Budget refused the call) is named here as well as in ReaderReport so the
// tally has every key whether or not this tree's ReaderReport lists it; a missing key would count NaN.
type Counted = Outcome | "budget";

interface Tally {
  messages: number;
  calls: number;
  outcomes: Record<Counted, number>;
  /** Messages whose pool held an item stating a `must` fact of the turn, and how many of those were gated. */
  bindingInPool: number;
  bindingGated: number;
  /** Pool items at the gate (reports with a pool), and those whose card is known without a model call. */
  poolItems: number;
  poolCovered: number;
  /** Messages at the gate whose whole pool was covered, and how many of those were gated. */
  coveredPools: number;
  coveredGated: number;
  /** Oracle gates: messages at the gate whose pool holds an item stating a fact of each kind, and their calls. */
  oracle: Record<OracleKind, number>;
  /**
   * User messages not read (`skipped`) or gated whose label is a need; of those, the ones needing a reader fact (in
   * `must`), and the wider set needing or able to use one (in `must` or `ok`): see `needKinds`.
   */
  unreadNeed: number;
  unreadReaderNeed: number;
  unreadReaderUsable: number;
  gatedNeed: number;
  gatedReaderNeed: number;
  gatedReaderUsable: number;
  /** `--reuse`: calls made by messages that repeat an earlier called message of the same user, per key. */
  reuse: Record<ReuseKind, number>;
}

/**
 * The fact kinds the reader is for: what means the assistant should not simply do the request as written (its
 * prompt, reader.ts). A world fact's id ends in its kind (`world.ts` `fact`). The other kinds (an event's time, a
 * deal's pricing or record, a flight, a visit, an agenda) are information a search delivers without a reader.
 */
export const READER_FACTS: ReadonlySet<string> = new Set(["constraint", "blocker", "paid"]);
export const factKind = (fact: string) => fact.slice(fact.lastIndexOf(":") + 1);

/** `must`: any needed fact; `reader`: needed reader facts; `readerOk`: reader facts needed or usable (`ok`). */
export type OracleKind = "must" | "reader" | "readerOk";
export const ORACLE_KINDS: readonly OracleKind[] = ["must", "reader", "readerOk"];

/**
 * How a turn counts among need turns: a need at all; needing a reader fact (one in `must`); needing or able to use
 * one (in `must` or `ok`). A reader fact only in `ok` makes a turn usable, not needing.
 */
export function needKinds(label: Label): { need: boolean; readerNeed: boolean; readerUsable: boolean } {
  const wanted = oracleFacts(label);
  return { need: label.kind === "need", readerNeed: wanted.reader.size > 0, readerUsable: wanted.readerOk.size > 0 };
}

/** The facts each oracle looks for in a turn's pool. Only a need turn has any. */
export function oracleFacts(label: Label): Record<OracleKind, Set<string>> {
  if (label.kind !== "need") return { must: new Set(), reader: new Set(), readerOk: new Set() };
  const isReader = (f: string) => READER_FACTS.has(factKind(f));
  return {
    must: new Set(label.must),
    reader: new Set(label.must.filter(isReader)),
    readerOk: new Set([...label.must, ...label.ok].filter(isReader)),
  };
}

/** Whether a pool holds an item stating one of `wanted` (item id to its facts). */
export const poolHolds = (pool: readonly string[], wanted: Set<string>, facts: Map<string, readonly string[]>) =>
  wanted.size > 0 && pool.some((id) => facts.get(id)?.some((f) => wanted.has(f)));

export type ReuseKind = "exact" | "pool" | "typeBinding";
export const REUSE_KINDS: readonly ReuseKind[] = ["exact", "pool", "typeBinding"];

/** The keys a called message is matched on across one user's sessions (`--reuse`). */
export function reuseKeys(
  request: string,
  pool: readonly string[],
  type: string,
  bindingIds: readonly string[],
): Record<ReuseKind, string> {
  return {
    exact: `${request}\u0000${pool.join("\u0001")}`,
    pool: pool.join("\u0001"),
    typeBinding: `${type}\u0000${[...bindingIds].sort().join("\u0001")}`,
  };
}

/**
 * One user's reuse ledger: `seen` returns, per key kind, whether an earlier called message had the same key, and
 * remembers this one. Only messages that made a call are passed in (a verdict exists to reuse only after a call).
 */
export class ReuseLedger {
  private readonly keys: Record<ReuseKind, Set<string>> = { exact: new Set(), pool: new Set(), typeBinding: new Set() };
  seen(k: Record<ReuseKind, string>): Record<ReuseKind, boolean> {
    const out = {} as Record<ReuseKind, boolean>;
    for (const kind of REUSE_KINDS) {
      out[kind] = this.keys[kind].has(k[kind]);
      this.keys[kind].add(k[kind]);
    }
    return out;
  }
}

const tally = (): Tally => ({
  messages: 0,
  calls: 0,
  outcomes: { read: 0, gated: 0, none: 0, late: 0, budget: 0, skipped: 0 },
  bindingInPool: 0,
  bindingGated: 0,
  poolItems: 0,
  poolCovered: 0,
  coveredPools: 0,
  coveredGated: 0,
  oracle: { must: 0, reader: 0, readerOk: 0 },
  unreadNeed: 0,
  unreadReaderNeed: 0,
  unreadReaderUsable: 0,
  gatedNeed: 0,
  gatedReaderNeed: 0,
  gatedReaderUsable: 0,
  reuse: { exact: 0, pool: 0, typeBinding: 0 },
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
  // One user per seed: reuse is counted across that user's sessions, never across users (isolation).
  const ledger = new ReuseLedger();
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
        const own = r ? r.pool : [];
        const atGate = !!r && r.pool.length > 0;
        const cov = own.filter(covered).length;
        const calls = maker.calls - before;
        const wanted = oracleFacts(turn.label);
        // At the gate (a pool, and the gate or the reader saw it): an oracle gate calls only when the pool holds it.
        const atOracle = atGate && outcome !== "none";
        const oracleHit = Object.fromEntries(
          ORACLE_KINDS.map((k) => [k, atOracle && poolHolds(r!.pool, wanted[k], facts)]),
        ) as Record<OracleKind, boolean>;
        const kinds = needKinds(turn.label);
        let repeat: Record<ReuseKind, boolean> | null = null;
        if (REUSE && r && calls > 0) {
          const text = turn.event.kind === "user_message" ? turn.event.text : "";
          const bindingIds = r.pool.filter((id) => facts.get(id)?.some((f) => must.has(f)));
          repeat = ledger.seen(reuseKeys(text, r.pool, task.type, bindingIds));
        }
        for (const x of [t, total]) {
          x.messages++;
          x.calls += calls;
          x.outcomes[outcome]++;
          // A gated message would have made one call; a read answered from the session's cache made none.
          for (const k of ORACLE_KINDS) if (oracleHit[k]) x.oracle[k] += outcome === "gated" ? 1 : calls;
          if (kinds.need && outcome === "skipped") {
            x.unreadNeed++;
            if (kinds.readerNeed) x.unreadReaderNeed++;
            if (kinds.readerUsable) x.unreadReaderUsable++;
          }
          if (kinds.need && outcome === "gated") {
            x.gatedNeed++;
            if (kinds.readerNeed) x.gatedReaderNeed++;
            if (kinds.readerUsable) x.gatedReaderUsable++;
          }
          if (repeat) for (const k of REUSE_KINDS) if (repeat[k]) x.reuse[k] += calls;
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
/** How many times fewer calls an oracle gate makes than the preset (0 when the oracle makes none). */
export function ceilings(calls: number, oracle: Record<OracleKind, number>): Record<OracleKind, number> {
  return {
    must: ratio(calls, oracle.must),
    reader: ratio(calls, oracle.reader),
    readerOk: ratio(calls, oracle.readerOk),
  };
}
/** How many times fewer calls a cross-session verdict reuse makes: calls over the calls not repeated. */
export function reuseCeilings(calls: number, reuse: Record<ReuseKind, number>): Record<ReuseKind, number> {
  return {
    exact: ratio(calls, calls - reuse.exact),
    pool: ratio(calls, calls - reuse.pool),
    typeBinding: ratio(calls, calls - reuse.typeBinding),
  };
}
function summary(t: Tally) {
  // A budget refusal passed the gate, like a late read: it counts at the gate.
  const atGate = t.outcomes.read + t.outcomes.gated + t.outcomes.late + t.outcomes.budget;
  return {
    messages: t.messages,
    calls: t.calls,
    callsPerMessage: ratio(t.calls, t.messages),
    read: t.outcomes.read,
    gated: t.outcomes.gated,
    emptyPool: t.outcomes.none,
    late: t.outcomes.late,
    budget: t.outcomes.budget,
    skipped: t.outcomes.skipped,
    gatedShare: ratio(t.outcomes.gated, atGate),
    missedBindingRate: ratio(t.bindingGated, t.outcomes.gated),
    bindingGatedShare: ratio(t.bindingGated, t.bindingInPool),
    bindingInPool: t.bindingInPool,
    cardCoverage: ratio(t.poolCovered, t.poolItems),
    coveredPools: t.coveredPools,
    gatedShareCovered: ratio(t.coveredGated, t.coveredPools),
    oracleCalls: { ...t.oracle },
    oracleCeiling: ceilings(t.calls, t.oracle),
    unreadNeed: t.unreadNeed,
    unreadReaderNeed: t.unreadReaderNeed,
    unreadReaderUsable: t.unreadReaderUsable,
    gatedNeed: t.gatedNeed,
    gatedReaderNeed: t.gatedReaderNeed,
    gatedReaderUsable: t.gatedReaderUsable,
    ...(REUSE ? { reuseCalls: { ...t.reuse }, reuseCeiling: reuseCeilings(t.calls, t.reuse) } : {}),
  };
}

// Imported by the test for its helpers; run as a script for the report.
if (import.meta.main) {
  const t0 = performance.now();
  const results: Record<
    string,
    { all: ReturnType<typeof summary>; byType: Record<string, ReturnType<typeof summary>> }
  > = {};
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
  // A ceiling over an oracle that makes no call is undefined, not 0x.
  const times = (x: number) => (x > 0 ? `${x.toFixed(2)}x` : "n/a");
  for (const [name, r] of Object.entries(results)) {
    const a = r.all;
    console.log(
      `${name.padEnd(12)} ${a.messages} user messages: ${a.calls} reader calls (${a.callsPerMessage.toFixed(3)} per ` +
        `message); read ${a.read}, gated ${a.gated}, late ${a.late}, budget-refused ${a.budget}, empty pool ` +
        `${a.emptyPool}, not read ${a.skipped}; gated share ` +
        `${pct(a.gatedShare)}; missed-binding ${a.missedBindingRate.toFixed(3)} (${a.bindingGatedShare.toFixed(3)} of ` +
        `${a.bindingInPool} pools holding a needed item); card coverage ${pct(a.cardCoverage)}, gated share on fully ` +
        `covered pools ${pct(a.gatedShareCovered)} (${a.coveredPools} pools)`,
    );
    const o = a.oracleCalls;
    const c = a.oracleCeiling;
    console.log(
      `  oracle gate: ${o.must} calls over any needed fact (${times(c.must)}), ${o.reader} over needed reader ` +
        `facts (${times(c.reader)}), ${o.readerOk} over reader facts needed or usable (${times(c.readerOk)}); ` +
        `need turns not read ${a.unreadNeed} (${a.unreadReaderNeed} needing a reader fact, ${a.unreadReaderUsable} ` +
        `needing or able to use one), gated ${a.gatedNeed} (${a.gatedReaderNeed}, ${a.gatedReaderUsable})`,
    );
    if (a.reuseCalls && a.reuseCeiling) {
      const u = a.reuseCalls;
      const x = a.reuseCeiling;
      console.log(
        `  reuse across one user's sessions: exact input ${u.exact} calls (${x.exact.toFixed(2)}x), pool only ` +
          `${u.pool} (${x.pool.toFixed(2)}x), same type and binding set ${u.typeBinding} ` +
          `(${x.typeBinding.toFixed(2)}x)`,
      );
    }
    for (const [type, s] of Object.entries(r.byType)) {
      console.log(
        `  ${type.padEnd(18)} ${String(s.messages).padStart(4)} msgs  calls/msg ${s.callsPerMessage.toFixed(3)}  read ` +
          `${s.read}  gated ${s.gated}  late ${s.late}  budget ${s.budget}  empty ${s.emptyPool}  not read ${s.skipped}  ` +
          `missed-binding ` +
          `${s.missedBindingRate.toFixed(3)}  coverage ${pct(s.cardCoverage)}`,
      );
    }
  }
  console.log(`seeds ${SEEDS.join(",")}, ${SESSIONS} sessions each, ${wallSeconds.toFixed(1)} s`);

  if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify({ seeds: SEEDS, sessions: SESSIONS, results }, null, 2)}\n`);
  if (RECORD) {
    const metrics: Record<string, number> = {};
    for (const [name, r] of Object.entries(results)) {
      for (const [k, v] of Object.entries(r.all)) {
        if (typeof v === "number") metrics[`${name}.${k}`] = v;
        else for (const [sub, n] of Object.entries(v)) metrics[`${name}.${k}.${sub}`] = n;
      }
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
}
