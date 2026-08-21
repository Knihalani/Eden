import type { StretchProgram } from "./types";

/**
 * Live confirmation of the 20b time counterfactual (37).
 *
 * `program.budget.ms` is the mean naive wall from the mined traces.
 * `actualMs` is this compiled run. The delta is measured on this run — never
 * copied from `manifest.timeSavedMs`, which is the pre-Approve shadow mean.
 *
 * Failed / deopted runs did not save time. Token savings stay omitted until
 * this run scrapes provider usage (honest zeros).
 */
export function liveTimeSavedMs(program: StretchProgram, actualMs: number, ok: boolean): number | null {
  if (!ok) return null;
  const naive = program.budget?.ms;
  if (naive == null || !(naive > 0) || !Number.isFinite(actualMs) || actualMs < 0) return null;
  return naive - actualMs;
}
