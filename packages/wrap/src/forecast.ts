import type { StretchProgram } from "@eden/ir";
import { remainingBudget, spend, type ForecastSpend } from "@eden/measure";
import type { RunRecorder } from "./types";

export {
  forecastCopy,
  remainingBudget,
  type ForecastSpend,
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
