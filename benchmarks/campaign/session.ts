/**
 * Session driver: runs scripted agent stretches against raw or Eden-wrapped
 * tools, charges an LLM turn for every call the agent decides to issue,
 * records compilable traces, and can take compiled programs live mid-session
 * through the real path: compileTraces -> shadowProgram (sandbox) -> manifest.
 *
 * Honesty rules baked in here:
 *   - every call the AGENT issues costs a turn (even ones Eden suppresses —
 *     the model still decided to make them),
 *   - "aware" agents stop once a result satisfies the goal (that is how a
 *     real integration behaves); "oblivious" agents run their whole script
 *     regardless, which measures Eden's value when the model does not
 *     cooperate,
 *   - correctness is checked against world state after every session, and a
 *     violated invariant is reported even when the speed numbers look great.
 */
import type { IslandCaller, StretchProgram, StretchTrace } from "@eden/ir";
import { IslandReply } from "@eden/ir";
import { compileTraces, findForkedGroups, forkWitnessTraces, type ForkCandidate } from "@eden/compile";
import { registryFrom } from "@eden/runtime";
import { shadowProgram } from "@eden/shadow";
import { createState, wrapTools, type ToolDef, type ToolsIn, type WrapState } from "@eden/wrap";
import { mulberry32 } from "@eden/measure";
import type { CallResult, World } from "./worlds";
import { tagGoLive } from "./witness-econ";

/** Seed derivation for concurrent stretches: distinct per slot, stable per arm. */
function blockSeed2(base: number, slot: number): number {
  return (Math.imul(base ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(slot + 1, 0xc2b2ae35)) >>> 0;
}

export const THINK_MS = Number(process.env.CAMPAIGN_THINK_MS ?? 120);
export const TURN_CENTS = 1;
export const ISLAND_CENTS = 0.3;

export type SessionStats = {
  /** Agent LLM turns (decisions to call a tool), both arms count alike. */
  turns: number;
  /** turn cost + island (cheap-model) cost. */
  cents: number;
  wall_ms: number;
  /** Actual underlying tool executions, including ones a compiled run performed. */
  rawExecutions: number;
  islands: number;
  stretches: number;
  completed: number;
  violations: string[];
};

export type SessionOpts = {
  /** Stop issuing calls once a result satisfies the goal. Default true. */
  aware?: boolean;
  /**
   * When false, traces omit prompt/completion tokens and island calls are
   * not wrapped with scraped usage — an unscrapable host. Default true.
   */
  scrapeUsage?: boolean;
};

export type WorldFactory = () => World;

type Counters = { execs: number };

function emptyStats(): SessionStats {
  return { turns: 0, cents: 0, wall_ms: 0, rawExecutions: 0, islands: 0, stretches: 0, completed: 0, violations: [] };
}

type WorldSlot = {
  world: World;
  counters: Counters;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  state?: WrapState;
  traces: StretchTrace[];
  stats: SessionStats;
  goals: Array<Record<string, unknown>>;
};

const SCRAPED_ISLAND = { prompt_tokens: 80, completion_tokens: 20 } as const;

/** Matches compileTraces default — family detection must see the same forks. */
const FORK_MIN_SUPPORT = 3;

/**
 * Collapsed tool-order (consecutive repeats dropped). Width-7 and width-10
 * of the same stretch stay one class. Full event signatures would re-split
 * mixed fan-out widths — that SKIP is the width_class_split honesty gate.
 */
function collapsedShapeKey(t: StretchTrace): string {
  const names: string[] = [];
  for (const e of t.events) {
    if (!e.ok || e.skipped) continue;
    if (names.at(-1) !== e.name) names.push(e.name);
  }
  return names.join("\0");
}

function find(parent: Map<string, string>, k: string): string {
  let r = parent.get(k) ?? k;
  while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
  let x = k;
  while (x !== r) {
    const n = parent.get(x) ?? x;
    parent.set(x, r);
    x = n;
  }
  return r;
}

/**
 * Shape families for go-live split. Collapsed order is the atom. Traces that
 * findForkedGroups would merge as one n-way fork union into one family.
 * Unrelated linear pipelines that only share a first tool stay apart unless
 * the compiler would actually fork them (discriminator + minSupport).
 */
function shapeFamilies(clean: StretchTrace[]): { families: Map<string, StretchTrace[]>; forks: ForkCandidate[] } {
  const parent = new Map<string, string>();
  for (const t of clean) {
    const k = collapsedShapeKey(t);
    if (!parent.has(k)) parent.set(k, k);
  }
  const forks = clean.length >= FORK_MIN_SUPPORT * 2 ? findForkedGroups(clean, FORK_MIN_SUPPORT) : [];
  for (const f of forks) {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const t of forkWitnessTraces(f)) {
      const k = collapsedShapeKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
    }
    for (let i = 1; i < keys.length; i++) {
      const ra = find(parent, keys[0]!);
      const rb = find(parent, keys[i]!);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const families = new Map<string, StretchTrace[]>();
  for (const t of clean) {
    const root = find(parent, collapsedShapeKey(t));
    const arr = families.get(root);
    if (arr) arr.push(t);
    else families.set(root, [t]);
  }
  return { families, forks };
}

/** n-way nestedArms repeats the else arm as rest[0]; don't double-count it. */
function uniqueForkArms(c: ForkCandidate): StretchTrace[][] {
  if (c.nestedArms && c.nestedArms.length >= 2) {
    return [c.thenTraces, ...c.nestedArms.map((a) => a.traces)];
  }
  return [c.thenTraces, c.elseTraces];
}

function forkMatchingFamily(forks: ForkCandidate[], family: ReadonlySet<StretchTrace>): ForkCandidate | undefined {
  let best: ForkCandidate | undefined;
  let bestN = 0;
  for (const f of forks) {
    let n = 0;
    for (const t of forkWitnessTraces(f)) if (family.has(t)) n++;
    if (n > bestN) {
      bestN = n;
      best = f;
    }
  }
  return bestN > 0 ? best : undefined;
}

/**
 * Hold out from a shape family. Prefer ≥1 per fork arm when there are enough
 * duplicate ids to keep a training rep of each held input.
 */
function pickHoldout(family: StretchTrace[], need: number, arms: StretchTrace[][] | undefined): StretchTrace[] {
  const idKey = (t: StretchTrace) => JSON.stringify(t.input ?? {});
  const remainingById = new Map<string, number>();
  for (const t of family) remainingById.set(idKey(t), (remainingById.get(idKey(t)) ?? 0) + 1);
  const familySet = new Set(family);
  const held: StretchTrace[] = [];
  const heldSet = new Set<StretchTrace>();
  const tryTake = (t: StretchTrace): boolean => {
    if (held.length >= need || heldSet.has(t) || !familySet.has(t)) return false;
    const k = idKey(t);
    if ((remainingById.get(k) ?? 0) <= 1) return false;
    remainingById.set(k, remainingById.get(k)! - 1);
    held.push(t);
    heldSet.add(t);
    return true;
  };
  if (arms && arms.length >= 2) {
    for (const arm of arms) {
      if (held.length >= need) break;
      for (let i = arm.length - 1; i >= 0; i--) {
        if (tryTake(arm[i]!)) break;
      }
    }
  }
  for (let i = family.length - 1; i >= 0 && held.length < need; i--) tryTake(family[i]!);
  return held;
}

/** Campaign analogue of wrap's provider scraper (island usage on IslandReply). */
function scrapeIsland(island: IslandCaller): IslandCaller {
  return async (p) => {
    const out = await island(p);
    if (out instanceof IslandReply) return out;
    return new IslandReply(out, { ...SCRAPED_ISLAND });
  };
}

export class Session {
  private slots = new Map<string, WorldSlot>();
  private aware: boolean;
  private scrapeUsage: boolean;
  total: SessionStats = emptyStats();

  constructor(factories: Array<[string, WorldFactory]>, useEden: boolean, opts: SessionOpts = {}) {
    this.aware = opts.aware ?? true;
    this.scrapeUsage = opts.scrapeUsage !== false;
    for (const [name, factory] of factories) {
      const world = factory();
      // Counting proxy UNDER the wrap, so both arms count identically and a
      // compiled run's internal executions show up too.
      const counters: Counters = { execs: 0 };
      const defs = world.tools();
      const counted: Record<string, ToolDef> = {};
      for (const [tool, def] of Object.entries(defs)) {
        counted[tool] = {
          description: def.description,
          execute: async (args: Record<string, unknown>) => {
            counters.execs++;
            return await def.execute(args);
          },
        };
      }
      let state: WrapState | undefined;
      let call: (n: string, a: Record<string, unknown>) => Promise<unknown>;
      if (useEden) {
        const countedIsland: IslandCaller = async (p) => {
          this.slot(name).stats.islands++;
          this.slot(name).stats.cents += ISLAND_CENTS;
          return world.island()(p);
        };
        state = createState({
          island: this.scrapeUsage ? scrapeIsland(countedIsland) : countedIsland,
          llmCents: ISLAND_CENTS,
        });
        const wrapped = wrapTools(counted as ToolsIn, state);
        call = async (n, a) => {
          const t = (wrapped as Record<string, ToolDef | undefined>)[n];
          if (!t) throw new Error(`no such tool: ${n}`);
          return await t.execute(a);
        };
      } else {
        call = async (n, a) => {
          const t = counted[n];
          if (!t) throw new Error(`no such tool: ${n}`);
          return await t.execute(a);
        };
      }
      this.slots.set(name, { world, counters, call, state, traces: [], stats: emptyStats(), goals: [] });
    }
  }

  slot(name: string): WorldSlot {
    const s = this.slots.get(name);
    if (!s) throw new Error(`unknown world ${name}`);
    return s;
  }

  /** Install already-live programs (steady-state deployments start here). */
  addPrograms(programs: StretchProgram[]): void {
    for (const p of programs) {
      if (!p) continue;
      for (const [, slot] of this.slots) slot.state?.programs.push(p);
    }
  }

  /** Run one stretch of one world against this session's tools. */
  async stretch(worldName: string, goal: Record<string, unknown>, seed: number): Promise<void> {
    const slot = this.slot(worldName);
    slot.world.beginStretch?.();
    const beforeExecs = slot.counters.execs;
    const rng = mulberry32(seed >>> 0);
    const t0 = performance.now();
    const events: StretchTrace["events"] = [];
    let turns = 0;
    let completed = false;
    let lastValue: unknown;

    const gen = slot.world.script(goal, rng);
    let sent: CallResult | undefined;
    for (;;) {
      const next = await gen.next(sent as never);
      if (next.done) break;
      const { tool, args } = next.value;
      // Every call the agent DECIDES to make is an LLM turn — including calls
      // Eden will answer from its arming without executing anything.
      await Bun.sleep(THINK_MS);
      turns++;
      const c0 = performance.now();
      let out: CallResult;
      try {
        const v = await slot.call(tool, args);
        out = { ok: true, value: v };
      } catch (err) {
        out = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      events.push({
        name: tool,
        args,
        result: out.ok ? out.value : { error: out.error },
        ok: out.ok,
        duration_ms: performance.now() - c0,
      });
      // Enforcement mode can refuse a call outright ({eden:"halted"}). A real
      // agent reads that and gives up on the stretch; it does not keep firing.
      if (out.ok && out.value && typeof out.value === "object" && "eden" in (out.value as object) && (out.value as { eden?: string }).eden === "halted") {
        break;
      }
      if (out.ok) lastValue = out.value;
      if (this.aware && out.ok && slot.world.done(out.value)) {
        completed = true;
        break;
      }
      sent = out;
    }
    // An oblivious agent still completes the goal when its terminal tool ran.
    if (!completed && events.some((e) => e.ok && e.name === slot.world.terminal)) completed = true;

    const wall = performance.now() - t0;
    const cents = turns * TURN_CENTS;
    slot.traces.push({
      id: `${worldName}-${slot.traces.length}`,
      events,
      input: goal,
      output: lastValue,
      llmCalls: turns,
      duration_ms: this.scrapeUsage ? Math.round(wall) : 200 * turns,
      cost_cents: cents,
      skipped: [],
      complete: completed,
      ...(this.scrapeUsage ? { prompt_tokens: 40 * turns, completion_tokens: 10 * turns } : {}),
    });
    slot.goals.push(goal);
    slot.stats.turns += turns;
    slot.stats.cents += cents;
    slot.stats.wall_ms += wall;
    slot.stats.stretches += 1;
    if (completed) slot.stats.completed += 1;
    slot.stats.rawExecutions += slot.counters.execs - beforeExecs;
  }

  /**
   * Run several stretches of one world CONCURRENTLY, interleaving their tool
   * calls. The regime real multi-goal agents live in, and the hardest case
   * for the arming machinery: overlapping stretches share the wrapped tool
   * surface while each suppresses only its own input's tail.
   */
  async stretchConcurrent(worldName: string, goals: Array<Record<string, unknown>>, seedBase: number): Promise<void> {
    await Promise.all(goals.map((goal, i) => this.stretch(worldName, goal, blockSeed2(seedBase, i))));
  }

  finish(): SessionStats {
    const violations: string[] = [];
    const agg = emptyStats();
    for (const [, slot] of this.slots) {
      violations.push(...slot.world.check(slot.goals));
      agg.turns += slot.stats.turns;
      agg.cents += slot.stats.cents;
      agg.wall_ms += slot.stats.wall_ms;
      agg.rawExecutions += slot.stats.rawExecutions;
      agg.islands += slot.stats.islands;
      agg.stretches += slot.stats.stretches;
      agg.completed += slot.stats.completed;
    }
    agg.violations = violations;
    this.total = agg;
    return agg;
  }

  /**
   * Take compiled programs live for one world, the way production does:
   * compile recorded traces, shadow-validate against held-out traces on a
   * sandbox copy of the world, attach the manifest only on PASS.
   */
  async goLive(
    worldName: string,
    o: {
      compile: number;
      holdout: number;
      sandbox: WorldFactory;
      maxGram?: number;
    },
  ): Promise<{
    program: StretchProgram | null;
    verdict: string;
    reasons: string[];
    uncertified?: boolean;
    mechanism?: string;
  }> {
    const slot = this.slot(worldName);
    if (!slot.state) throw new Error("goLive on a raw session");
    const usable = slot.traces.filter((t) => t.complete);
    if (usable.length < o.compile + o.holdout) {
      return tagGoLive({ program: null, verdict: "SKIP", reasons: [`only ${usable.length} complete traces`] });
    }
    // "Clean" = full-fidelity traces per the world's own definition (desk:
    // the audit line was not skipped; incident: no retried searches; worlds
    // without degradation: everything qualifies). Length alone cannot do
    // this — fan-out widths make legitimate traces different lengths.
    const fidelityOf = slot.world.fidelity ?? (() => true);
    const clean = usable.filter((t) => fidelityOf(t.events));
    const variants = usable.filter((t) => !fidelityOf(t.events));
    const need = { train: Math.max(o.compile, 3), holdout: o.holdout };
    if (clean.length < need.holdout + 3) {
      return tagGoLive({
        program: null,
        verdict: "SKIP",
        reasons: [`only ${clean.length} clean traces of ${usable.length}`],
      });
    }
    // Split by SHAPE FAMILY. Atom = collapsed tool order (width-7 and width-10
    // of the same stretch stay one class — width_class_split in WITNESS-ECON.md).
    // Traces findForkedGroups would merge as one n-way fork are one family, so a
    // 3-arm gate is not three thin linear shapes. Hold out from the dominant
    // family (prefer ≥1 per arm), keep ≥1 rep of every held id in training.
    const { families, forks } = shapeFamilies(clean);
    let dominant: StretchTrace[] = [];
    for (const arr of families.values()) if (arr.length > dominant.length) dominant = arr;
    if (dominant.length < need.holdout + 3) {
      return tagGoLive({
        program: null,
        verdict: "SKIP",
        reasons: [`dominant shape has only ${dominant.length} clean traces`],
      });
    }
    const familyFork = forkMatchingFamily(forks, new Set(dominant));
    const holdout = pickHoldout(dominant, need.holdout, familyFork ? uniqueForkArms(familyFork) : undefined);
    const heldSet = new Set(holdout);
    const train: StretchTrace[] = clean.filter((t) => !heldSet.has(t));
    // Variants vote for sequence shape (Wave 3.5). Envelope values come only
    // from shape-compatible traces inside compileTraces — sloppy inputs do
    // not poison the witnessed set.
    train.push(...variants);
    const res = compileTraces(train, o.maxGram != null ? { maxGram: o.maxGram } : {});
    // Try candidates most-complete-first and take the first that PASSES: a
    // mined fragment that ends mid-stretch can never reproduce the recorded
    // output, and burning its replays just to say no helps nobody.
    const candidates = [...res.programs].sort((a, b) => b.sequence.length - a.sequence.length);
    let lastVerdict = candidates.length ? "INCONCLUSIVE" : "NO_PROGRAM";
    let lastReasons: string[] = candidates.length ? [] : res.refusals.map((r) => r.reason).slice(0, 4);
    let usageBlocked = false;
    for (const candidate of candidates.slice(0, 3)) {
      const sandboxWorld = o.sandbox();
      const sandboxExecs: Record<string, ToolDef["execute"]> = {};
      for (const [k, d] of Object.entries(sandboxWorld.tools())) sandboxExecs[k] = d.execute;
      const sandboxIsland = sandboxWorld.island();
      const shadow = await shadowProgram(candidate, holdout, {
        registry: registryFrom(sandboxExecs),
        island: this.scrapeUsage ? scrapeIsland(sandboxIsland) : sandboxIsland,
        allowSideEffects: true,
      });
      lastVerdict = shadow.verdict;
      lastReasons = shadow.reasons;
      const usageOnly =
        shadow.verdict === "INCONCLUSIVE" &&
        shadow.manifest != null &&
        shadow.reasons.some((r) => r.includes("extrapolated") || r.includes("not measured"));
      if (usageOnly) usageBlocked = true;
      if (shadow.verdict === "PASS" && shadow.manifest) {
        const live: StretchProgram = { ...candidate, manifest: shadow.manifest };
        slot.state.programs.push(live);
        return tagGoLive({
          program: live,
          verdict: "PASS",
          reasons: shadow.reasons,
          uncertified: false,
        });
      }
    }
    return tagGoLive({
      program: null,
      verdict: lastVerdict,
      reasons: lastReasons,
      uncertified: lastVerdict === "INCONCLUSIVE" && usageBlocked,
    });
  }
}
