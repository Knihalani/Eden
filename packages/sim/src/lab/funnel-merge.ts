/**
 * funnel.ts's arithmetic, apart from the script so it is tested in-process (funnel-merge.test.ts): how many shards run
 * at once, the merged amortised connector calls, and which shards' traces miss calls their connectors received.
 */

/** Shards at once at `--time` > 0 with no `--jobs`: at most this many, and at most `JOBS_PER_CORE` per core. */
export const TIME_JOBS_CAP = 12;
export const JOBS_PER_CORE = 3;

/**
 * The jobs a run uses before the solo reasons (which still force one). `--jobs` as typed wins. Without it, a run at
 * `--time` > 0 runs min(shards, 12, 3 × cores) at once: its shards wait on simulated connector latency (sleeps, not
 * CPU), so they barely contend (audit 2026-11-03b, devloop-time-screen-jobs-default: ALL3 train1–6 seeds 41–42 at
 * `--time 1` took 222 s at one job and 44–51 s at 12 on 4 cores, perTask rows identical without their timing fields).
 * At `--time 0` the work is CPU and the default stays one, so ms/task stays an uncontended figure.
 */
export function defaultJobs(o: { jobsGiven?: number; timeScale: number; shards: number; cores: number }): number {
  const wanted = o.jobsGiven ?? (o.timeScale > 0 ? Math.min(TIME_JOBS_CAP, JOBS_PER_CORE * Math.max(1, o.cores)) : 1);
  return Math.max(1, Math.min(wanted, o.shards));
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
