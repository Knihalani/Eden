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
 *   the run itself spends almost none of it, so a measured cold start (`cold-start.ts`, `lifetime`) stands in for it
 *   when given, and the line says which.
 *
 * Two totals: the steady state per task (per task + background while working) and all-in over the run (the steady
 * state plus each user's one-time backfill spread over that user's tasks in the run). The short horizon's
 * figures are also weighted by REALUSE_MIX (1:1:8); a long horizon's tasks already are that mix.
 */
import type { Background, RunResult, Task } from "./ab-common";
import { REALUSE_MIX } from "./pi-ab-weighted";

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
