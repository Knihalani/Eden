import type { StretchProgram } from "@eden/ir";
import { remainingBudget, spend, type ForecastSpend, type ForecastView } from "@eden/measure";
import type { EdenOpts, RunRecorder } from "./types";

export {
  forecastCopy,
  forecastHalt,
  remainingBudget,
  spend,
  type ForecastOverflow,
  type ForecastSpend,
  type ForecastView,
} from "@eden/measure";

export function actualSpend(run: RunRecorder, now: number): ForecastSpend {
  return spend({
    llmCalls: run.llmCalls,
    ms: Math.max(0, now - run.t0),
    cents: run.cost,
  });
}

export function matchingRunPrograms(
  live: StretchProgram[],
  events: { name: string; skipped?: boolean }[],
): StretchProgram[] {
  const seen = events.filter((e) => !e.skipped).map((e) => e.name);
  const first = seen[0];
  if (!first) return [];
  return live
    .filter((p) => {
      const s = p.sequence ?? [];
      if (s[0] !== first) return false;
      let j = 0;
      for (const n of seen) {
        const at = s.indexOf(n, j);
        if (at < 0) return false;
        j = at + 1;
      }
      return true;
    })
    .sort((a, b) => (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0));
}

export const inFlightProgram = (live: StretchProgram[], events: { name: string; skipped?: boolean }[]): StretchProgram | undefined => matchingRunPrograms(live, events)[0];

export function remainingBudgetForRun(args: {
  program: StretchProgram;
  run: RunRecorder;
  now: number;
  opts: Pick<EdenOpts, "timeoutMs">;
}): ForecastView | null {
  if (!args.program.budget) return null;
  const cap = ((o) => { const e = o?.timeoutMs; const env = Number(process.env.EDEN_TIMEOUT_MS); return Math.min(300_000, Math.max(1, e && e > 0 ? e : Number.isFinite(env) && env > 0 ? env : 60_000)); })(args.opts);
  const elapsed = args.now - args.run.t0;
  return remainingBudget({
    predicted: args.program.budget,
    actual: actualSpend(args.run, args.now),
    remainingTimeoutMs: cap - elapsed,
  });
}
