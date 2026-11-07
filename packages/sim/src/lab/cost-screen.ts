/**
 * H18's cost screen (CL5, docs/research/cl-cl5.md; docs/LAB.md recipe 2b): from a funnel run with the paid reader
 * replayed, what Eden's per-task model spend and calls would be, per task kind and on the assumed traffic mix, with no
 * live agent and no grader. Each funnel row carries its reader calls and their cost as made (`readerCalls`,
 * `readerUsd`: a replayed call at what it cost when it was recorded), its connector calls and its ask's wall time.
 *
 * What it does not see: the agent's own tokens (a lever that changes what the agent reads or how often it asks needs
 * the live A/B), the background cards and intent (replayed at $0 here; a user's one-time backfill, booked apart in
 * the long-horizon report), and the reader's wall time beyond the recorded latency. Reader calls a replay missed
 * answer without the reader and cost nothing here, so a screen with misses understates: the line says how many.
 */
import { REALUSE_MIX } from "./pi-ab-weighted";

/** The fields of a funnel row (hidden-funnel.ts TaskRow, or a neutral row) the screen reads. */
export interface CostRow {
  variant?: string;
  readerCalls?: number;
  readerUsd?: number;
  calls: number;
  askMs?: number;
}

export interface KindCost {
  n: number;
  /** Rows with a model reader's counts (0 when the run had none: a stub or no reader). */
  read: number;
  readerCallsPerTask: number;
  /** $ per 1,000 tasks, reader as made. */
  readerUsdPer1k: number;
  connectorCallsPerTask: number;
  askMsMean: number | null;
}

export interface CostScreen {
  kinds: Record<string, KindCost>;
  /** The kinds weighted by REALUSE_MIX (1:1:8); only when every kind of the mix has rows. */
  mix: { readerCallsPerTask: number; readerUsdPer1k: number; connectorCallsPerTask: number } | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Per kind (`hidden`, `control` from the planted rows, `neutral` from the neutral rows) and on the mix. */
export function costScreen(planted: readonly CostRow[], neutral: readonly CostRow[]): CostScreen {
  const groups = new Map<string, CostRow[]>();
  for (const r of planted) {
    const k = r.variant ?? "hidden";
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  if (neutral.length) groups.set("neutral", [...neutral]);
  const kinds: Record<string, KindCost> = {};
  for (const [k, rows] of groups) {
    const asks = rows.flatMap((r) => (r.askMs === undefined ? [] : [r.askMs]));
    kinds[k] = {
      n: rows.length,
      read: rows.filter((r) => r.readerCalls !== undefined).length,
      readerCallsPerTask: mean(rows.map((r) => r.readerCalls ?? 0)),
      readerUsdPer1k: 1_000 * mean(rows.map((r) => r.readerUsd ?? 0)),
      connectorCallsPerTask: mean(rows.map((r) => r.calls)),
      askMsMean: asks.length ? mean(asks) : null,
    };
  }
  const shares = Object.entries(REALUSE_MIX);
  const mix = shares.every(([k]) => kinds[k]?.n)
    ? {
        readerCallsPerTask: shares.reduce((a, [k, w]) => a + w * kinds[k]!.readerCallsPerTask, 0),
        readerUsdPer1k: shares.reduce((a, [k, w]) => a + w * kinds[k]!.readerUsdPer1k, 0),
        connectorCallsPerTask: shares.reduce((a, [k, w]) => a + w * kinds[k]!.connectorCallsPerTask, 0),
      }
    : null;
  return { kinds, mix };
}

/** The screen's printed lines. `misses`: reader prompts the replay did not hold (those tasks are understated). */
export function costScreenLines(s: CostScreen, misses: number): string[] {
  const f = (x: number, d: number) => x.toFixed(d);
  const out = Object.entries(s.kinds).map(
    ([k, c]) =>
      `COST SCREEN ${k.padEnd(7)} n ${c.n}: reader ${f(c.readerCallsPerTask, 2)} calls/task, ` +
      `$${f(c.readerUsdPer1k, 4)}/1k tasks (as made), ${f(c.connectorCallsPerTask, 2)} connector calls/task` +
      (c.askMsMean === null ? "" : `, ask ${f(c.askMsMean, 1)} ms`) +
      (c.read < c.n ? `  [${c.n - c.read} rows without a model reader: counted as 0]` : ""),
  );
  if (s.mix) {
    out.push(
      `COST SCREEN mix 1:1:8: reader ${f(s.mix.readerCallsPerTask, 3)} calls/task, ` +
        `$${f(s.mix.readerUsdPer1k, 4)}/1k tasks (Eden per-task, as made; no agent, no backfill), ` +
        `${f(s.mix.connectorCallsPerTask, 2)} connector calls/task`,
    );
  } else out.push("COST SCREEN mix: needs hidden, control and neutral rows (-- --neutral on a suite that builds it)");
  if (misses > 0) out.push(`COST SCREEN: ${misses} reader prompts missed the replay (answered without it, $0 here)`);
  return out;
}
