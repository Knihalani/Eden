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

export const FORECAST_TIMEOUT_DEFAULT_MS = 60_000;
export const FORECAST_TIMEOUT_CAP_MS = 300_000;

export function forecastTimeoutMs(opts: Pick<EdenOpts, "timeoutMs"> | number | undefined): number {
  const explicit = typeof opts === "number" ? opts : opts?.timeoutMs;
  const env = Number(process.env.EDEN_TIMEOUT_MS);
  const raw =
    explicit && explicit > 0
      ? explicit
      : Number.isFinite(env) && env > 0
        ? env
        : FORECAST_TIMEOUT_DEFAULT_MS;
  return Math.min(FORECAST_TIMEOUT_CAP_MS, Math.max(1, raw));
}

export function actualSpend(run: RunRecorder, now: number): ForecastSpend {
  return spend({
    llmCalls: run.llmCalls,
    ms: Math.max(0, now - run.t0),
    cents: run.cost,
  });
}

/**
 * Programs this run is actually on. Same idea as requiredChecks: the seen
 * (non-skipped) names must be a subsequence of the program, starting at
 * sequence[0]. Longest sequence first. No match → unique-work.
 */
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

export function inFlightProgram(
  live: StretchProgram[],
  events: { name: string; skipped?: boolean }[],
): StretchProgram | undefined {
  return matchingRunPrograms(live, events)[0];
}

export function remainingBudgetForRun(args: {
  program: StretchProgram;
  run: RunRecorder;
  now: number;
  opts: Pick<EdenOpts, "timeoutMs">;
}): ForecastView | null {
  if (!args.program.budget) return null;
  const cap = forecastTimeoutMs(args.opts);
  const elapsed = args.now - args.run.t0;
  return remainingBudget({
    predicted: args.program.budget,
    actual: actualSpend(args.run, args.now),
    remainingTimeoutMs: cap - elapsed,
  });
}

export function isUniqueWork(
  live: StretchProgram[],
  events: { name: string; skipped?: boolean }[],
): boolean {
  return matchingRunPrograms(live, events).length === 0;
}
