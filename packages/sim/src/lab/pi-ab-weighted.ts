/**
 * Traffic-weighted rows for the A/B reports (audit 2026-11-03b, R3-21): a deployment's traffic is mostly silent
 * (control) tasks, so a condition's cost and wall time on hidden tasks alone understate what it costs per message.
 * The weighted row prices a mix with share `w` hidden and `1 − w` control:
 *
 * - means ($/1k, Eden $/1k, tool calls): `w × mean(hidden) + (1 − w) × mean(control)`;
 * - percentiles (wall p50/p90): taken from the pooled per-task samples, each hidden task weighted `w / n_hidden` and
 *   each control task `(1 − w) / n_control`. A weighted average of the two p50s is not the p50 of the mix (a
 *   bimodal mix's median can sit in neither group's centre), so it is never used here.
 *
 * `pi-ab-report.ts` prints these from a results file (`weightedRows`) and, for a report kept only as text (the Haiku
 * campaign's raw results are not kept), the means from its outcome tables (`--weighted report.txt`,
 * `weightedFromReport`; percentiles '-'). `hermes-ab.ts` prints them at the end of a run.
 */

/** One graded task run, as the weighted row needs it. Costs in $ per task, wall in seconds. */
export interface WeightedSample {
  usd: number;
  edenUsd: number;
  tools: number;
  wallS: number;
}

export interface WeightedRow {
  condition: string;
  w: number;
  nHidden: number;
  nControl: number;
  /** $ per 1k tasks of the mix: agent + Eden's per-task calls, and Eden's alone. */
  perK: number;
  edenPerK: number;
  tools: number;
  /** Wall seconds of the mix; null when only the report's text (no per-task samples) was available. */
  p50: number | null;
  p90: number | null;
}

/** The weights the reports print: 10% and 50% of tasks carrying a hidden fact. */
export const TRAFFIC_WEIGHTS = [0.1, 0.5] as const;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * The `p` quantile of weighted samples, with the same convention as `pi-timeline.ts`'s `quantile` (the smallest value
 * whose cumulative weight reaches `p`), so equal weights give the same answer as the unweighted report columns.
 */
export function weightedQuantile(xs: { v: number; weight: number }[], p: number): number {
  const live = xs.filter((x) => x.weight > 0).sort((a, b) => a.v - b.v);
  if (!live.length) return 0;
  const total = live.reduce((n, x) => n + x.weight, 0);
  let acc = 0;
  for (const x of live) {
    acc += x.weight / total;
    // A small tolerance: 0.1 + 0.2 summed in floating point must still reach 0.3.
    if (acc >= p - 1e-12) return x.v;
  }
  return live[live.length - 1]!.v;
}

/** The weighted row of one condition from its hidden and control task runs; null when either kind has none. */
export function weightedRow(
  condition: string,
  hidden: WeightedSample[],
  control: WeightedSample[],
  w: number,
): WeightedRow | null {
  if (!hidden.length || !control.length) return null;
  const mix = (pick: (s: WeightedSample) => number) => w * mean(hidden.map(pick)) + (1 - w) * mean(control.map(pick));
  const pooled = [
    ...hidden.map((s) => ({ v: s.wallS, weight: w / hidden.length })),
    ...control.map((s) => ({ v: s.wallS, weight: (1 - w) / control.length })),
  ];
  return {
    condition,
    w,
    nHidden: hidden.length,
    nControl: control.length,
    perK: 1_000 * mix((s) => s.usd + s.edenUsd),
    edenPerK: 1_000 * mix((s) => s.edenUsd),
    tools: mix((s) => s.tools),
    p50: weightedQuantile(pooled, 0.5),
    p90: weightedQuantile(pooled, 0.9),
  };
}

/** One row of a report's outcome table (`== hidden` / `== control`), as printed by `pi-ab-report.ts`. */
interface TableRow {
  n: number;
  perK: number;
  eden: number;
  tools: number;
}

/**
 * The outcome tables of a report kept as text, by kind and condition. Both column layouts are read: before 2026-11-03
 * (`… $/1k (Eden) calls tools …`) and after (`… $/1k (Eden) bkfill all-in calls tools …`), told apart by the header.
 */
export function reportTables(text: string): Map<string, Map<string, TableRow>> {
  const out = new Map<string, Map<string, TableRow>>();
  let kind = "";
  let toolsAt = -1;
  for (const line of text.split("\n")) {
    if (line.startsWith("== critical path")) break;
    const head = /^== (hidden|control|request|arrival|offworld)/.exec(line);
    if (head) {
      kind = head[1]!;
      out.set(kind, out.get(kind) ?? new Map());
    } else if (!line.trim()) kind = "";
    else if (kind && line.startsWith("condition")) toolsAt = line.trim().split(/\s+/).indexOf("tools");
    else if (kind && toolsAt > 0) {
      // The header's "$/1k" and "(Eden)" are one token each, as are the row's cells, so indexes line up.
      const cells = line.trim().split(/\s+/);
      out.get(kind)!.set(cells[0]!, {
        n: Number(cells[1]),
        perK: Number(cells[3]),
        eden: Number(cells[4]),
        tools: Number(cells[toolsAt]),
      });
    }
  }
  return out;
}

/** The weighted rows (means only: a text report keeps no per-task samples) of every condition with both kinds. */
export function weightedFromReport(text: string, weights: readonly number[] = TRAFFIC_WEIGHTS): WeightedRow[] {
  const tables = reportTables(text);
  const hidden = tables.get("hidden") ?? new Map();
  const control = tables.get("control") ?? new Map();
  const rows: WeightedRow[] = [];
  for (const w of weights) {
    for (const [c, h] of hidden) {
      const k = control.get(c);
      if (!k) continue;
      const mix = (pick: (r: TableRow) => number) => w * pick(h) + (1 - w) * pick(k);
      rows.push({
        condition: c,
        w,
        nHidden: h.n,
        nControl: k.n,
        perK: mix((r) => r.perK),
        edenPerK: mix((r) => r.eden),
        tools: mix((r) => r.tools),
        p50: null,
        p90: null,
      });
    }
  }
  return rows;
}

/**
 * `x` to `d` decimals, halves rounded up. A text report's cells have three decimals, so a w = 0.5 mean can land on an
 * exact half (0.553 and 0.778 average to 0.6655), which binary floating point holds just below the half: plain
 * `toFixed` would print 0.665. The 1e-6 nudge (far below the cells' 1e-3 resolution) prints the decimal answer, 0.666.
 */
export function fixed(x: number, d: number): string {
  const scale = 10 ** d;
  return (Math.round(x * scale + 1e-6) / scale).toFixed(d);
}

/** The weighted section of a report: a heading, a column line and one line per row. */
export function weightedLines(rows: WeightedRow[]): string[] {
  if (!rows.length) return [];
  const f = (x: number | null, d: number, width: number) => (x === null ? "-" : fixed(x, d)).padStart(width);
  return [
    "\n== traffic-weighted: w × hidden + (1 − w) × control; means weighted, p50/p90 from the pooled per-task samples",
    "w     condition          n hid  n ctl   $/1k  (Eden)  tools   p50 s   p90 s",
    ...rows.map(
      (r) =>
        `${r.w.toFixed(2)}  ${r.condition.padEnd(16)} ${String(r.nHidden).padStart(5)} ${String(r.nControl).padStart(6)} ` +
        `${f(r.perK, 3, 6)} ${f(r.edenPerK, 3, 7)} ${f(r.tools, 2, 6)} ${f(r.p50, 2, 7)} ${f(r.p90, 2, 7)}`,
    ),
  ];
}
