/**
 * funnel.ts's arithmetic, apart from the script so it is tested in-process (funnel-merge.test.ts): how many processes
 * run at once, how `--time 0` groups suite × seed shards into them, how their JSON merges, the merged amortised
 * connector calls, and which processes' traces miss calls their connectors received.
 */
import type { IntentUse } from "./reader-stub";

/** Shards at once at `--time` > 0 with no `--jobs`: at most this many, and at most `JOBS_PER_CORE` per core. */
export const TIME_JOBS_CAP = 12;
export const JOBS_PER_CORE = 3;

/**
 * The jobs a run uses before the solo reasons (which still force one). `--jobs` as typed wins. Without it, a run at
 * `--time` > 0 runs min(shards, 12, 3 × cores) at once: its shards wait on simulated connector latency (sleeps, not
 * CPU), so they barely contend (audit 2026-11-03b, devloop-time-screen-jobs-default: ALL3 train1–6 seeds 41–42 at
 * `--time 1` took 222 s at one job and 44–51 s at 12 on 4 cores, perTask rows identical without their timing fields).
 * At `--time 0` the work is CPU, so the default is one process per core, each over a block of shards (`groupShards`):
 * each extra process repeats its start-up in CPU (D139). ms/task is then contended; `--jobs 1` gives the
 * uncontended figure.
 */
export function defaultJobs(o: { jobsGiven?: number; timeScale: number; shards: number; cores: number }): number {
  const cores = Math.max(1, o.cores);
  const wanted = o.jobsGiven ?? (o.timeScale > 0 ? Math.min(TIME_JOBS_CAP, JOBS_PER_CORE * cores) : cores);
  return Math.max(1, Math.min(wanted, o.shards));
}

/** A block of shards one hidden-funnel.ts process runs: its `--suite` list × its `--seeds` list. */
export interface ShardGroup {
  suites: string[];
  seeds: string[];
}

/** `items` cut into `k` contiguous chunks whose sizes differ by at most one, the larger first. */
function chunks<T>(items: T[], k: number): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (let i = 0; i < k; i++) {
    const size = Math.floor(items.length / k) + (i < items.length % k ? 1 : 0);
    out.push(items.slice(at, at + size));
    at += size;
  }
  return out;
}

/**
 * At `--time 0`, at most `jobs` processes over the suites × seeds grid (D139). hidden-funnel.ts takes a suite list
 * and a seed list, so each process gets a block: a contiguous run of suites × a contiguous run of seeds. The suites
 * are cut into `a` runs and the seeds into `b` (a × b ≤ jobs), choosing the cut whose largest block is smallest (the
 * run's wall time), then the fewer processes (each one costs start-up CPU). Blocks come in shard order: suite runs
 * outer, seed runs inner. train (6 suites) × 2 seeds on 4 cores: four blocks of 3 suites × 1 seed.
 */
export function groupShards(suites: string[], seeds: string[], jobs: number): ShardGroup[] {
  if (!suites.length || !seeds.length) return [];
  let best = { a: 1, b: 1, largest: suites.length * seeds.length };
  for (let a = 1; a <= suites.length; a++) {
    for (let b = 1; b <= seeds.length && a * b <= Math.max(1, jobs); b++) {
      const largest = Math.ceil(suites.length / a) * Math.ceil(seeds.length / b);
      if (largest < best.largest || (largest === best.largest && a * b < best.a * best.b)) best = { a, b, largest };
    }
  }
  return chunks(suites, best.a).flatMap((s) => chunks(seeds, best.b).map((d) => ({ suites: s, seeds: d })));
}

/**
 * Connector calls over the merged shards, request time and background together. `request` (calls the connectors
 * received in the tasks' windows) already holds the on-demand listings seen there (`demandSeen`); the sync's own count
 * (`demandAll`) holds them all, so the seen ones are taken out once. Subtracting `demand` instead (the polls in
 * lookups' traces) counted twice every poll left behind (`syncPollBehind`) or made by the reader's push, whose traces
 * carry none of it: 7.04/task merged against a shard mean of 4.43 (audit 2026-11-03b,
 * lab-merged-amortised-double-counts-behind-polls). hidden-funnel.ts's per-shard line uses the same formula.
 */
export function amortisedCalls(request: number, sync: Record<string, number | undefined>): number {
  const n = (k: string) => sync[k] ?? 0;
  return request - n("demandSeen") + n("demandAll") + n("background") + n("backfill");
}

/** A shard's call counts: what its connectors received in the tasks' windows, and what its traces summed. */
export interface CallCheck {
  received: number;
  listed: number;
  traced: number;
}

/**
 * The shards whose traces summed fewer or more calls than their connectors received (audit 2026-11-03b,
 * corr-poll-behind-calls-untraced): with `syncPollBehind` the poll's listings reach no trace, so per-trace
 * `sourceCalls` (and every cost view built from traces) undercounts. The connectors' count is the ground truth.
 */
export function callMismatches(shards: { name: string; calls?: CallCheck }[]): string[] {
  return shards
    .filter((s) => s.calls && s.calls.traced !== s.calls.received)
    .map((s) => `${s.name}: traced ${s.calls!.traced} of ${s.calls!.received} received`);
}

export interface Row {
  n: number;
  returned: number;
  cached: number;
  delivered: number;
  calls: number;
  ms: number;
}
export interface Rows {
  hidden: Row;
  control: Row;
}
export type Counts = Record<string, number>;
/** One task's row as hidden-funnel.ts writes it: the suite and seed it ran under, then the rest. */
export interface PartTask {
  suite: string;
  seed: number;
  variant: "hidden" | "control";
}
/** hidden-funnel.ts's `--json` for one process: per-template rows keyed `suite/name` when it ran several suites. */
export interface PartOut {
  rows: Record<string, Rows>;
  total: Rows;
  suites?: Record<string, { rows: Record<string, Rows>; total: Rows }>;
  sync?: Counts;
  cards?: Counts;
  reader?: Counts;
  intent?: IntentUse;
  calls?: CallCheck;
  perTask: PartTask[];
}

export function zeroRow(): Row {
  return { n: 0, returned: 0, cached: 0, delivered: 0, calls: 0, ms: 0 };
}

/**
 * Several processes' JSON (part i ran `groups[i]`) as hidden-funnel.ts writes it for all of `suites` × `seeds` in one
 * process. perTask is rebuilt in that process's order (per suite, hidden then control, seeds in order) from each row's
 * own suite and seed, so it does not matter which block ran a shard; within one suite, variant and seed a part's
 * order is kept. Rows and totals are summed per suite from each part's per-suite summary (`suites`, or its whole
 * `rows`/`total` when it ran one suite), keyed `suite/name` over several suites as hidden-funnel.ts keys them. The
 * sync, cards, reader and intent counters are summed. Throws when a part's rows do not match its group (a part that
 * ran other shards than asked, or a task outside the grid), rather than merge a run that is not the one named.
 */
export function mergeParts(parts: PartOut[], groups: ShardGroup[], suites: string[], seeds: string[]) {
  if (parts.length !== groups.length) throw new Error(`${parts.length} parts for ${groups.length} groups`);
  const addRows = (into: Rows | undefined, r: Rows): Rows => {
    const sum = into ?? { hidden: zeroRow(), control: zeroRow() };
    for (const v of ["hidden", "control"] as const) {
      for (const k of Object.keys(r[v]) as (keyof Row)[]) sum[v][k] += r[v][k];
    }
    return sum;
  };
  const addCounts = (into: Counts | undefined, c: Counts | undefined) => {
    if (!c) return into;
    const sum = into ?? {};
    for (const [k, v] of Object.entries(c)) sum[k] = (sum[k] ?? 0) + v;
    return sum;
  };
  const perSuite = parts.map((p, i) => {
    const g = groups[i]!;
    if (p.suites) return p.suites;
    if (g.suites.length !== 1) throw new Error(`part ${i} ran ${g.suites.join(",")} but has no per-suite summary`);
    return { [g.suites[0]!]: { rows: p.rows, total: p.total } };
  });
  let total: Rows = { hidden: zeroRow(), control: zeroRow() };
  const rows: Record<string, Rows> = {};
  const bySuite: Record<string, { rows: Record<string, Rows>; total: Rows }> = {};
  for (const suite of suites) {
    for (const [i, g] of groups.entries()) {
      if (!g.suites.includes(suite)) continue;
      const part = perSuite[i]![suite];
      if (!part) throw new Error(`part ${i} has no summary for ${suite}`);
      const s = (bySuite[suite] ??= { rows: {}, total: { hidden: zeroRow(), control: zeroRow() } });
      for (const [name, r] of Object.entries(part.rows)) {
        s.rows[name] = addRows(s.rows[name], r);
        const k = suites.length > 1 ? `${suite}/${name}` : name;
        rows[k] = addRows(rows[k], r);
      }
      s.total = addRows(s.total, part.total);
      total = addRows(total, part.total);
    }
  }
  let sync: Counts | undefined;
  let cards: Counts | undefined;
  let reader: Counts | undefined;
  const intentUse: IntentUse = { asked: 0, found: 0 };
  for (const p of parts) {
    sync = addCounts(sync, p.sync);
    cards = addCounts(cards, p.cards);
    reader = addCounts(reader, p.reader);
    intentUse.asked += p.intent?.asked ?? 0;
    intentUse.found += p.intent?.found ?? 0;
  }
  // Each part's rows by suite, variant and seed, its own order kept; then laid out in the one-process order.
  const cell = (suite: string, variant: string, seed: number | string) => `${suite}|${variant}|${seed}`;
  const cells = new Map<string, PartTask[]>();
  let seen = 0;
  for (const [i, p] of parts.entries()) {
    const g = groups[i]!;
    for (const t of p.perTask) {
      if (!g.suites.includes(t.suite) || !g.seeds.some((d) => Number(d) === Number(t.seed))) {
        throw new Error(`part ${i} (${g.suites.join(",")} × ${g.seeds.join(",")}) has a task of ${t.suite} ${t.seed}`);
      }
      const k = cell(t.suite, t.variant, t.seed);
      const list = cells.get(k) ?? [];
      list.push(t);
      cells.set(k, list);
      seen++;
    }
  }
  const perTask = suites.flatMap((suite) =>
    (["hidden", "control"] as const).flatMap((variant) =>
      seeds.flatMap((seed) => cells.get(cell(suite, variant, Number(seed))) ?? []),
    ),
  );
  if (perTask.length !== seen)
    throw new Error(`${seen} task rows laid out as ${perTask.length}: repeated suite or seed?`);
  return { rows, total, sync, cards, reader, intentUse, bySuite, perTask };
}
