import { evidenceLedger, isCheckName, isReadName, isStretchEnd, latestRepeatStalled } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";
import {
  forecastCopy,
  forecastTimeoutMs,
  matchingRunPrograms,
  remainingBudget,
  actualSpend,
} from "./forecast";
import type { EdenOpts, RunRecorder } from "./types";

export type GuardDecision =
  | { action: "halt"; reason: string; detail?: string }
  | { action: "block"; reason: string; detail?: string }
  | { action: "steer"; program: StretchProgram; reason: string; detail?: string };

function hasNgram(sequence: string[] | undefined, ngram: string[]): boolean {
  if (!sequence?.length || ngram.length > sequence.length) return false;
  for (let i = 0; i + ngram.length <= sequence.length; i++) {
    if (ngram.every((n, j) => sequence[i + j] === n)) return true;
  }
  return false;
}

export function requiredChecks(
  live: StretchProgram[],
  events: { name: string; skipped?: boolean }[],
): string[] {
  const hit = matchingRunPrograms(live, events)[0];
  return hit ? (hit.sequence ?? []).filter(isCheckName) : [];
}

export const killAfterWarningEnabled = (opts: EdenOpts) => opts.killAfterWarning != null ? opts.killAfterWarning : process.env.EDEN_KILL_AFTER_WARNING === "1";

export function enforcementEnabled(opts: EdenOpts): boolean {
  if (opts.enforce != null) return opts.enforce;
  return process.env.EDEN_ENFORCE === "1";
}

export function decideGuard(args: {
  name: string;
  run: RunRecorder;
  live: StretchProgram[];
  opts: EdenOpts;
  now: number;
}): GuardDecision | null {
  const { name, run, live, opts, now } = args;
  if (killAfterWarningEnabled(opts) && run.firstWarningAt != null) {
    return { action: "halt", reason: "warning" };
  }
  if (run.tripped || run.warnings.some((w) => w.kind === "fail_streak")) {
    return { action: "halt", reason: "fail_streak" };
  }
  const loop = [...run.warnings].reverse().find((w) => w.kind === "repeat_ngram" && w.ngram && new Set(w.ngram).size >= 2);
  if (loop?.ngram && loop.ngram.includes(name)) {
    const allReads = loop.ngram.every((n) => isReadName(n));
    if (!allReads && latestRepeatStalled(run.events, loop.ngram)) {
      const hit = live.filter((p) => p.manifest).find((p) => hasNgram(p.sequence, loop.ngram!));
      if (hit) return { action: "steer", program: hit, reason: "loop" };
      return { action: "halt", reason: "loop" };
    }
  }
  if (isStretchEnd(name)) {
    const required = requiredChecks(live, [...run.events, { name }]);
    const preview = evidenceLedger([...run.events, { name, args: {}, ok: true }], required);
    if (preview.absent.length) {
      const need = new Set(preview.absent);
      const hit = live.filter((p) => p.manifest).find((p) => (p.sequence ?? []).some((n) => need.has(n)));
      if (hit) return { action: "steer", program: hit, reason: "missing_evidence" };
      return { action: "block", reason: "missing_evidence" };
    }
  }
  const elapsed = now - run.t0;
  const cap = forecastTimeoutMs(opts);
  const remaining = cap - elapsed;
  const onPath = [...run.events, { name }];
  const matches = matchingRunPrograms(live, onPath);
  const on = matches[0];
  if (!on?.budget) return null;
  const view = remainingBudget({
    predicted: on.budget,
    actual: actualSpend(run, now),
    remainingTimeoutMs: remaining,
  });
  if (view.spent) return { action: "halt", reason: "budget", detail: forecastCopy(view) };
  if (run.firstWarningAt == null) return null;
  if (view.timeoutPressure) {
    const hit = matches.filter((p) => p.manifest).find((p) => (p.budget?.ms ?? 0) <= remaining);
    if (hit) return { action: "steer", program: hit, reason: "budget" };
    return { action: "halt", reason: "budget", detail: forecastCopy(view) };
  }
  return null;
}
