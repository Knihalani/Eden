/**
 * One injection case's world and Eden, up to the push (A10, D305): the hidden-context task's world with the attack
 * planted, its sim sources, and, for an Eden arm, a `ContextPartner` whose sync has backfilled the sources (as a
 * long-running server's would, and as pi-ab does) and which has observed the request. Shared by the live harness
 * (`injection-ab.ts`) and the $0 standing test (`injection-suite.test.ts`). LAB ONLY, simulated data.
 */
import { ContextPartner, ItemCache, type AskReader, type EngineConfig, type Trace } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, Injection } from "@eden/protocol";
import { QueryPlanner } from "@eden/sources";
import { REALISTIC, simSources, type SimSource } from "../sources";
import type { World } from "../world";
import { worldOf, type Task } from "./ab-common";
import { plantAttack, type Attack } from "./injection-suite";

export interface InjectionCase {
  variant: "hidden" | "control" | "neutral";
  suite: string;
  seed: number;
  /** The task's place among its world's hidden-context tasks. */
  index: number;
  attack: Attack;
}

export interface InjectionSetup {
  world: World;
  task: Task;
  /** The planted attack items' ids. */
  attackIds: ReadonlySet<string>;
  sources: SimSource[];
  partner: ContextPartner | null;
  scope: { tenantId: string; userId: string };
  sessionId: string;
  /** Eden's clock (the world's, an hour after the backfill). */
  clock: { now: number };
  /** What the request's observe delivered: its reply's packet and any queued by then. */
  first: Injection[];
  /** An event of this session at the clock's time. */
  event(e: Record<string, unknown>): AgentEvent;
}

/** Builds the case's world and, with `eden`, its Eden through the request's observe (waiting 3 s, as pi-ab does). */
export async function setUpCase(
  c: InjectionCase,
  eden: null | {
    config: Partial<EngineConfig>;
    reader?: (now: () => number) => AskReader;
    onTrace?: (t: Trace) => void;
  },
): Promise<InjectionSetup> {
  const { world, tasks } = worldOf(c.seed, c.suite, c.variant, { maxTasks: 30, maxOffworld: 0 });
  const task = tasks[c.index]!;
  const attackIds = new Set(plantAttack(world, task, c.attack));
  const sources = simSources(world, REALISTIC, 0, c.seed);
  const scope = { tenantId: "a10", userId: `w${c.seed}` };
  const sessionId = task.id;
  const clock = { now: world.now };
  const now = () => clock.now;
  const reader = eden?.reader?.(now);
  const partner = eden
    ? new ContextPartner({
        sources: async () => sources,
        sourceMap: new SourceMap(":memory:", { seed: c.seed }),
        cache: new ItemCache(),
        budget: new Budget(),
        model: null,
        planner: new QueryPlanner({ seed: c.seed }),
        now,
        config: eden.config,
        ...(reader ? { reader } : {}),
        ...(eden.onTrace ? { onTrace: eden.onTrace } : {}),
      })
    : null;
  const sync = partner?.sync ?? null;
  if (sync) {
    const start = clock.now;
    clock.now -= 30 * 60_000;
    sync.track(scope, clock.now);
    for (let i = 0; i < 120 && !sync.warm(scope); i++) {
      await sync.tick();
      clock.now += 60_000;
    }
    clock.now = start;
  }
  clock.now += 3_600_000;
  const event = (e: Record<string, unknown>) => ({ ...scope, sessionId, at: clock.now, ...e }) as AgentEvent;
  const first: Injection[] = [];
  if (partner) {
    await partner.observe(event({ kind: "session_start", agent: "a10" }));
    const r = await partner.observe(event({ kind: "user_message", text: task.text }), { waitMs: 3_000 });
    if (r.injection) first.push(r.injection);
    first.push(...partner.takePending({ ...scope, sessionId }));
  }
  return { world, task, attackIds, sources, partner, scope, sessionId, clock, first, event };
}
