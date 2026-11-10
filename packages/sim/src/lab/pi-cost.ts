/**
 * The cost split of a pi-ab run (H16, CL5, docs/research/cl-cl5.md), for the short horizon (one request per session)
 * and the long one (`--days`, pi-user.ts) alike: per condition, what each task costs the agent and Eden, what Eden
 * spends in the background while the user works, and what it spends once per user before the first request.
 *
 * - Per task: the agent's model calls (`costUsd`) and Eden's per-task calls (`edenCostUsd`: the reader, as made when
 *   replayed). Recap turns are probes: never a task, their cost reported apart.
 * - Background while working (`run`): each stream's card and intent spend after its first request (new and changed
 *   items), spread over that stream's tasks.
 * - One-time per user (`setup`): the backfill's enrichment before the first request. With the cards replayed from disk
 *   the run still makes much of it live (CL5: $0.018–0.019 a long-horizon user against a $0.020 cold start, the
 *   default's enricher sending items the replay files hold no line for), but what it replays it does not pay for,
 *   so a measured cold start of the same user (`cold-start.ts --users user:SEED`, `lifetimeFor`) stands in for it when
 *   given, and the line says which.
 *
 * Two totals: the steady state per task (per task + background while working) and all-in over the run (the steady
 * state plus each user's one-time backfill spread over that user's tasks in the run). The short horizon's
 * figures are also weighted by REALUSE_MIX (1:1:8); a long horizon's tasks already are that mix.
 */
import type { Background, RunResult, Task } from "./ab-common";
import { REALUSE_MIX } from "./pi-ab-weighted";

/**
 * Connector plans, $ per 1,000 tool calls (packages/sim/lab/before-after/market.py's `CONNECTORS`; sources in
 * docs/research/eden-market-effect.md, list prices as researched there, assumed for any one tenant). Every connector
 * call is priced at its plan's rate: the agent's own source tool calls and all of Eden's (request-time searches,
 * polls and re-reads, the background sync's ticks, the one-time backfill).
 */
export const CONNECTOR_PLANS: Readonly<Record<string, number>> = {
  "first-party (quota only)": 0,
  "Composio (overage)": 0.3,
  "Unified.to (Pro)": 0.75,
  "Arcade.dev (Team)": 10,
  "Pipedream Connect (overage)": 12,
  "Zapier MCP (10k tasks)": 25.8,
};

/**
 * Event triggers on a per-call connector platform (F1, D478): the platform watches the user's source and sends each
 * change as an event carrying the item, billed per event instead of per tool call. `EVENT_TRIGGER_USD` is the
 * brief's figure (0.003 dollars an event; assumed, not checked against a price list). An event replaces the calls
 * Eden would make to learn of that change (its polls of that source and its re-reads before delivery), not its
 * searches.
 */
export const EVENT_TRIGGER_USD = 0.003;

/**
 * A plan's steady cost per task with event triggers on the sources that offer them: `avoided` connector calls a task
 * are no longer made (never more than Eden makes), and `events` events a task are billed instead. `breakEvenEvents`
 * is how many events a task the avoided calls pay for at this plan's price: above it, calls are the cheaper way.
 */
export function triggerCosts(
  c: ConditionCost,
  perThousand: number,
  t: { usdPerEvent: number; events: number; avoided: number },
) {
  const per = perThousand / 1_000;
  const edenCalls = c.connectorPerTask.eden + c.connectorPerTask.background;
  const avoided = Math.min(Math.max(0, t.avoided), edenCalls);
  const plain = planCosts(c, perThousand).steady;
  return {
    steady: plain - avoided * per + t.events * t.usdPerEvent,
    plain,
    avoided,
    breakEvenEvents: t.usdPerEvent > 0 ? (avoided * per) / t.usdPerEvent : Infinity,
  };
}

/** The long-horizon user a run planned, or a cold start measured: what must match for one to stand for the other. */
export interface UserShape {
  suites: string[];
  days: number;
  daySize: [number, number];
  mix: { hidden: number; control: number; neutral: number };
}

/**
 * `--lifetime`'s rows checked against the runs: only `user:SEED` rows, for runs that are long-horizon users, of the
 * same shape (suites, days, day size, mix), one row per seed. Throws with the reason otherwise, so a cold start of
 * another world never stands for a run's backfill silently.
 */
export function lifetimeFor(
  files: readonly { users: { user: string; seed?: number; usd: number }[]; userShape?: UserShape }[],
  runs: readonly { file: string; shape?: UserShape }[],
): Lifetime[] {
  if (!files.length) return [];
  const short = runs.filter((r) => !r.shape).map((r) => r.file);
  if (short.length)
    throw new Error(`--lifetime books a long-horizon user's backfill: ${short.join(", ")} has no --days`);
  const same = (a: UserShape, b: UserShape) => JSON.stringify(a) === JSON.stringify(b);
  const out: Lifetime[] = [];
  for (const f of files) {
    const rows = f.users.filter((u) => u.user.startsWith("user:"));
    if (!rows.length) continue;
    if (!f.userShape) throw new Error("--lifetime: a cold-start file without its user shape (rerun cold-start.ts)");
    for (const r of runs) {
      if (!same(f.userShape, r.shape!)) {
        throw new Error(
          `--lifetime: cold start ${JSON.stringify(f.userShape)} is not ${r.file}'s ${JSON.stringify(r.shape)}`,
        );
      }
    }
    for (const u of rows) {
      const seed = u.seed ?? Number(u.user.split(":")[1]);
      if (out.some((l) => l.seed === seed)) throw new Error(`--lifetime: two cold starts for seed ${seed}`);
      out.push({ seed, usd: u.usd });
    }
  }
  return out;
}

/** One task run as the report reads it. */
export interface CostTask {
  seed: number;
  condition: string;
  kind: string;
  /** The day of a long-horizon user (0 on a short run). */
  day: number;
  agentUsd: number;
  edenUsd: number;
  wallS: number;
  /** The agent's own tool calls (search tools, and `ask_context` where it has it). */
  agentTools: number;
  /** Of them, calls to a connector (`tool.search_*` spans): `ask_context` and action tools are not connector calls. */
  agentSourceCalls: number;
  readerCalls: number;
  /** Eden's connector calls in the task's window (searches, fetches, listings). */
  edenSourceCalls: number;
  /** The grade (raised the detail / a concern), when graded. */
  raised?: boolean;
}

export interface Lifetime {
  seed: number;
  usd: number;
}

export interface ConditionCost {
  condition: string;
  tasks: number;
  users: number;
  /** $ per task, means. */
  agent: number;
  eden: number;
  /** Background while the user worked, per task. */
  backgroundRun: number;
  /** One-time per user ($ per user, mean over users) and its source. */
  oneTimePerUser: number;
  oneTimeFrom: "in-run" | "cold-start" | "none";
  steady: number;
  allIn: number;
  /** The same on the 1:1:8 mix (per-kind means weighted), when every kind has tasks. */
  mixSteady: number | null;
  mixAllIn: number | null;
  readerCallsPerTask: number;
  edenSourceCallsPerTask: number;
  agentToolsPerTask: number;
  /** Connector calls per task: the agent's, Eden's in the task's window, Eden's background while the user worked. */
  connectorPerTask: { agent: number; eden: number; background: number };
  /**
   * Eden's one-time backfill connector calls per user (before the first request): per stream, since every stream's
   * partner backfills its own user (a short run's suites are separate users; a long run's seed is one).
   */
  backfillCallsPerUser: number;
  /** Streams that recorded their connector calls (A3 and later): the users the backfill is spread over. */
  backfillUsers: number;
  /** The same per-task calls on the 1:1:8 mix (the background is per task already), when every kind has tasks. */
  mixConnectorPerTask: number | null;
  wallP50: number;
  wallMean: number;
  recapUsd: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const p50 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

/** Spans of one name in a task's timeline events (a "B" event per span). */
export const countSpans = (events: readonly { ph: string; ev: string }[], name: string) =>
  events.filter((e) => e.ph === "B" && e.ev === name).length;

/** The task runs of a results file, with their timeline counts and days. */
export function costTasks(
  run: { tasks: Task[]; results: RunResult[]; seeds: number[] },
  records: ReadonlyMap<string, { events: { ph: string; ev: string }[] }>,
  dayOf: ReadonlyMap<string, number>,
): CostTask[] {
  const tasks = new Map(run.tasks.map((t) => [t.id, t]));
  return run.results.flatMap((r) => {
    const t = tasks.get(r.task);
    if (!t || r.error) return [];
    const rec = records.get(`${r.task}\u0000${r.condition}`);
    const seed = Number(/^w(\d+):/.exec(r.task)?.[1] ?? run.seeds[0]);
    const graded = r.facts && t.must.length ? t.must.some((m) => r.facts![m.id]) : undefined;
    return [
      {
        seed,
        condition: r.condition,
        kind: t.kind,
        day: dayOf.get(r.task) ?? 0,
        agentUsd: r.costUsd,
        edenUsd: r.edenCostUsd,
        wallS: r.wallMs / 1_000,
        agentTools: r.toolCalls,
        agentSourceCalls: rec ? rec.events.filter((e) => e.ph === "B" && e.ev.startsWith("tool.search_")).length : 0,
        readerCalls: rec ? countSpans(rec.events, "eden.reader") : 0,
        edenSourceCalls: rec ? countSpans(rec.events, "eden.source") : 0,
        ...(graded === undefined ? {} : { raised: graded }),
      },
    ];
  });
}

/** Per condition: the split, the two totals, the mix-weighted totals, calls and wall. */
export function conditionCosts(
  tasks: readonly CostTask[],
  background: readonly Background[],
  recaps: readonly { seed: number; condition: string; usd: number }[],
  lifetime: readonly Lifetime[] = [],
): ConditionCost[] {
  const conditions = [...new Set(tasks.map((t) => t.condition))];
  return conditions.map((condition) => {
    const ts = tasks.filter((t) => t.condition === condition);
    const seeds = [...new Set(ts.map((t) => t.seed))];
    const bg = background.filter((b) => b.condition === condition && seeds.includes(b.seed));
    const setup = bg.reduce((a, b) => a + (b.setupUsd ?? 0), 0);
    const run = bg.reduce((a, b) => a + b.cardsUsd + b.bridgeUsd - (b.setupUsd ?? 0), 0);
    // Eden's arms only: a stream with no background (no cards) has no backfill to book.
    const hasEden = bg.length > 0;
    const cold = lifetime.filter((l) => seeds.includes(l.seed));
    const oneTimeFrom: ConditionCost["oneTimeFrom"] = !hasEden
      ? "none"
      : cold.length === seeds.length
        ? "cold-start"
        : "in-run";
    const oneTimeTotal = oneTimeFrom === "cold-start" ? cold.reduce((a, l) => a + l.usd, 0) : setup;
    const agent = mean(ts.map((t) => t.agentUsd));
    const eden = mean(ts.map((t) => t.edenUsd));
    const backgroundRun = ts.length ? run / ts.length : 0;
    const steady = agent + eden + backgroundRun;
    const oneTimePerTask = ts.length ? oneTimeTotal / ts.length : 0;
    const kinds = Object.entries(REALUSE_MIX);
    const byKind = (k: string) => ts.filter((t) => t.kind === k);
    const mixed = kinds.every(([k]) => byKind(k).length > 0);
    const mixSteady = mixed
      ? kinds.reduce((a, [k, w]) => a + w * mean(byKind(k).map((t) => t.agentUsd + t.edenUsd)), 0) + backgroundRun
      : null;
    // Eden's connector calls outside any task's window (the sync's ticks, notices' polls) while the user worked: the
    // stream's total less its backfill and less what the tasks' windows counted. Streams before A3 lack the total.
    const counted = bg.filter((b) => b.sourceCalls !== undefined);
    const backfillCalls = counted.reduce((a, b) => a + (b.setupSourceCalls ?? 0), 0);
    const inTasks = ts.reduce((a, t) => a + t.edenSourceCalls, 0);
    const streamCalls = counted.reduce((a, b) => a + b.sourceCalls!, 0);
    const backgroundCalls = counted.length ? Math.max(0, streamCalls - backfillCalls - inTasks) : 0;
    const perTaskConn = (xs: readonly CostTask[]) => mean(xs.map((t) => t.agentSourceCalls + t.edenSourceCalls));
    const bgConn = ts.length ? backgroundCalls / ts.length : 0;
    return {
      condition,
      tasks: ts.length,
      users: seeds.length,
      agent,
      eden,
      backgroundRun,
      oneTimePerUser: seeds.length ? oneTimeTotal / seeds.length : 0,
      oneTimeFrom,
      steady,
      allIn: steady + oneTimePerTask,
      mixSteady,
      mixAllIn: mixSteady === null ? null : mixSteady + oneTimePerTask,
      readerCallsPerTask: mean(ts.map((t) => t.readerCalls)),
      edenSourceCallsPerTask: mean(ts.map((t) => t.edenSourceCalls)),
      agentToolsPerTask: mean(ts.map((t) => t.agentTools)),
      connectorPerTask: {
        agent: mean(ts.map((t) => t.agentSourceCalls)),
        eden: mean(ts.map((t) => t.edenSourceCalls)),
        background: bgConn,
      },
      backfillCallsPerUser: counted.length ? backfillCalls / counted.length : 0,
      backfillUsers: counted.length,
      mixConnectorPerTask: mixed ? kinds.reduce((a, [k, w]) => a + w * perTaskConn(byKind(k)), 0) + bgConn : null,
      wallP50: p50(ts.map((t) => t.wallS)),
      wallMean: mean(ts.map((t) => t.wallS)),
      recapUsd: recaps.filter((r) => r.condition === condition).reduce((a, r) => a + r.usd, 0),
    };
  });
}

/** Per condition and kind: n, the share raised (graded tasks only), $ per 1k (agent + Eden per task), wall. */
export function kindRows(tasks: readonly CostTask[]) {
  const out: {
    condition: string;
    kind: string;
    n: number;
    graded: number;
    raised: number;
    usd1k: number;
    p50: number;
  }[] = [];
  for (const condition of new Set(tasks.map((t) => t.condition))) {
    for (const kind of ["hidden", "control", "neutral"]) {
      const ts = tasks.filter((t) => t.condition === condition && t.kind === kind);
      if (!ts.length) continue;
      const graded = ts.filter((t) => t.raised !== undefined);
      out.push({
        condition,
        kind,
        n: ts.length,
        graded: graded.length,
        raised: graded.filter((t) => t.raised).length,
        usd1k: 1_000 * mean(ts.map((t) => t.agentUsd + t.edenUsd)),
        p50: p50(ts.map((t) => t.wallS)),
      });
    }
  }
  return out;
}

/** Per condition and day (long horizon): n, agent and Eden $ per 1k tasks, wall p50 — the transcript's growth. */
export function dayRows(tasks: readonly CostTask[]) {
  const out: { condition: string; day: number; n: number; agent1k: number; eden1k: number; p50: number }[] = [];
  for (const condition of new Set(tasks.map((t) => t.condition))) {
    const days = [...new Set(tasks.filter((t) => t.condition === condition).map((t) => t.day))].sort((a, b) => a - b);
    for (const day of days) {
      const ts = tasks.filter((t) => t.condition === condition && t.day === day);
      out.push({
        condition,
        day,
        n: ts.length,
        agent1k: 1_000 * mean(ts.map((t) => t.agentUsd)),
        eden1k: 1_000 * mean(ts.map((t) => t.edenUsd)),
        p50: p50(ts.map((t) => t.wallS)),
      });
    }
  }
  return out;
}

/**
 * One condition's $ per task under a connector plan: steady (model + connector calls per task, the background's
 * included) and all-in (plus the one-time backfill, its model spend and its connector calls, over the user's tasks);
 * the 1:1:8 mix the same when the run has every kind.
 */
export function planCosts(c: ConditionCost, perThousand: number) {
  const per = perThousand / 1_000;
  const conn = c.connectorPerTask.agent + c.connectorPerTask.eden + c.connectorPerTask.background;
  const backfill = c.tasks ? (c.backfillCallsPerUser * c.backfillUsers * per) / c.tasks : 0;
  const steady = c.steady + conn * per;
  const allIn = c.allIn + conn * per + backfill;
  const mixSteady =
    c.mixSteady === null || c.mixConnectorPerTask === null ? null : c.mixSteady + c.mixConnectorPerTask * per;
  return {
    steady,
    allIn,
    mixSteady,
    mixAllIn: mixSteady === null || c.mixAllIn === null ? null : mixSteady + (c.mixAllIn - c.mixSteady!) + backfill,
  };
}
