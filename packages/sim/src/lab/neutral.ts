/**
 * The `neutral` variant (RealUse-1, docs/research/benchmark-realuse-1.md): the same request as a suite's `hidden` and
 * `control` tasks with nothing planted, which is what most real turns look like. It measures Eden's cost, latency and
 * noise when it has nothing to add. Only suites that build it (NEUTRAL_SUITES) run it: the older suites' planting
 * functions read any variant but `hidden` as the control.
 *
 * In the funnel a neutral task has no planted item, so "delivered" means any packet at all (noise); in the live A/Bs
 * the grader asks whether the answer raises any concern, which counts like a false concern on a control task.
 */

/**
 * Suites whose planting function builds the `neutral` variant (plants nothing, same request text). The train suites
 * build it through suites.ts's `withNeutral` (CL5), so tuning can measure nothing-to-add turns without a held-out
 * suite.
 */
export const NEUTRAL_SUITES: readonly string[] = [
  "heldout14",
  "heldout15",
  "heldout16",
  "train1",
  "train2",
  "train3",
  "train4",
  "train5",
  "train6",
];

export const supportsNeutral = (suite: string) => NEUTRAL_SUITES.includes(suite);

/**
 * The variants a harness runs for a suite: those asked for, minus `neutral` where the suite does not build it.
 * Throws on a name that is not a variant.
 */
export function variantsFor<V extends string>(suite: string, asked: readonly V[]): V[] {
  for (const v of asked) {
    if (v !== "hidden" && v !== "control" && v !== "neutral") throw new Error(`unknown variant "${v}"`);
  }
  return asked.filter((v) => v !== "neutral" || supportsNeutral(suite));
}

/** One neutral task in the funnel, as hidden-funnel.ts records it (the fields this summary reads). */
export interface NeutralTask {
  injected: number;
  packets: number;
  packetBytes: number;
  calls: number;
  ms: number;
  askItems?: number;
  readerFlags?: number;
}

/** The funnel's neutral summary: tasks, those with any delivery, items and bytes delivered, ask items, calls, ms. */
export interface NeutralRow {
  n: number;
  /** Tasks with at least one packet delivered (noise: nothing was planted). */
  anyDelivered: number;
  items: number;
  packets: number;
  packetBytes: number;
  askItems: number;
  /** Tasks whose reader flagged any item (only with a reader). */
  anyFlagged: number;
  calls: number;
  ms: number;
}

export const neutralRow = (): NeutralRow => ({
  n: 0,
  anyDelivered: 0,
  items: 0,
  packets: 0,
  packetBytes: 0,
  askItems: 0,
  anyFlagged: 0,
  calls: 0,
  ms: 0,
});

export function addNeutralTask(into: NeutralRow, t: NeutralTask): void {
  into.n++;
  if (t.packets > 0) into.anyDelivered++;
  into.items += t.injected;
  into.packets += t.packets;
  into.packetBytes += t.packetBytes;
  into.askItems += t.askItems ?? 0;
  if ((t.readerFlags ?? 0) > 0) into.anyFlagged++;
  into.calls += t.calls;
  into.ms += t.ms;
}

export function addNeutralRows(into: NeutralRow, r: NeutralRow): void {
  for (const k of Object.keys(into) as (keyof NeutralRow)[]) into[k] += r[k];
}

/** The funnel's NEUTRAL line for one suite or the total. */
export function neutralLine(name: string, r: NeutralRow): string {
  const per = (x: number) => (x / Math.max(1, r.n)).toFixed(2);
  return (
    `NEUTRAL ${name}: any packet ${r.anyDelivered}/${r.n}; ${per(r.items)} items, ${per(r.packets)} packets, ` +
    `${(r.packetBytes / Math.max(1, r.n)).toFixed(0)} packet bytes/task; ask ${per(r.askItems)} items/task; ` +
    `reader flagged any ${r.anyFlagged}/${r.n}; ${per(r.calls)} calls/task; ${(r.ms / Math.max(1, r.n)).toFixed(1)} ` +
    "ms/task"
  );
}

/** hidden-funnel.ts's `neutral` JSON block (present only with `--neutral`). */
export interface NeutralOut {
  total: NeutralRow;
  /** The neutral phase's own use of the run-wide counters (connector calls, intent, sync, reader, cards, judge). */
  use?: Record<string, Record<string, number>>;
  suites: Record<string, NeutralRow>;
  perTask: ({ suite: string; seed: number; template: string } & NeutralTask)[];
}

/**
 * Several processes' neutral blocks as one process would write them: totals summed per suite, perTask laid out by
 * suite (in `suites`' order), then seed (in `seeds`' order), each cell's own order kept. Undefined when no part has
 * one; throws when only some do (a run whose processes disagree on `--neutral` is not one run).
 */
export function mergeNeutral(
  parts: readonly { neutral?: NeutralOut }[],
  suites: readonly string[],
  seeds: readonly string[],
): NeutralOut | undefined {
  const withIt = parts.filter((p) => p.neutral);
  if (!withIt.length) return undefined;
  if (withIt.length !== parts.length) throw new Error(`${withIt.length} of ${parts.length} parts ran --neutral`);
  const total = neutralRow();
  const bySuite: Record<string, NeutralRow> = {};
  const cells = new Map<string, NeutralOut["perTask"]>();
  for (const p of parts) {
    for (const [suite, r] of Object.entries(p.neutral!.suites)) addNeutralRows((bySuite[suite] ??= neutralRow()), r);
    addNeutralRows(total, p.neutral!.total);
    for (const t of p.neutral!.perTask) {
      const k = `${t.suite}|${Number(t.seed)}`;
      const list = cells.get(k) ?? [];
      list.push(t);
      cells.set(k, list);
    }
  }
  const perTask = suites.flatMap((s) => seeds.flatMap((seed) => cells.get(`${s}|${Number(seed)}`) ?? []));
  const seen = [...cells.values()].reduce((n, l) => n + l.length, 0);
  if (perTask.length !== seen) throw new Error(`${seen} neutral rows laid out as ${perTask.length}`);
  const suitesOut = Object.fromEntries(suites.filter((s) => bySuite[s]).map((s) => [s, bySuite[s]!]));
  // Each process's neutral-phase counters, summed key by key.
  let use: NeutralOut["use"];
  for (const p of parts) {
    for (const [group, counts] of Object.entries(p.neutral!.use ?? {})) {
      use ??= {};
      const into = (use[group] ??= {});
      for (const [k, v] of Object.entries(counts)) into[k] = (into[k] ?? 0) + v;
    }
  }
  return { total, suites: suitesOut, perTask, ...(use ? { use } : {}) };
}
