import { evidenceLedger, isCheckName, isReadName, isStretchEnd, latestRepeatStalled } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";
import {
  forecastCopy,
  forecastTimeoutMs,
  inFlightProgram,
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

function matchingProgram(live: StretchProgram[], pred: (p: StretchProgram) => boolean): StretchProgram | undefined {
  return live.filter((p) => p.manifest).find(pred);
}

export function requiredChecks(
  live: StretchProgram[],
  events: { name: string; skipped?: boolean }[],
): string[] {
  const hit = inFlightProgram(live, events);
  return hit ? (hit.sequence ?? []).filter(isCheckName) : [];
}

export function killAfterWarningEnabled(opts: EdenOpts): boolean {
  if (opts.killAfterWarning != null) return opts.killAfterWarning;
  return process.env.EDEN_KILL_AFTER_WARNING === "1";
}

/**
 * Is hard enforcement on?
 *
 * Default is NO — and this default is the product's prime directive: a broken
 * or thrashing Eden must never refuse, block, or halt the agent's own call.
 * Guards still observe (warnings are recorded, surfaced on the dashboard, and
 * honoured by steering that has a verified fallback), they just never stop
 * traffic. Operators who want hard caps opt in with `enforce: true` or
 * EDEN_ENFORCE=1, accepting that a guard can refuse a call in exchange for
 * bounded spend.
 */
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
    // An all-read loop is never hard-stopped. The halt lands on the *next*
    // loop call, which for a poller is exactly the observation that would
    // have shown progress — CI flips to success, and the agent is killed
    // one call before seeing it. Reads are cheap and side-effect-free; the
    // asymmetry runs entirely the wrong way. They keep accumulating
    // repeat_ngram / low_gain warnings (visible on traces, honoured by
    // killAfterWarning and the budget guard), they just don't get executed
    // into a dead stop. Loops touching a mutating or unknown-name tool stay
    // subject to the hard stop: repeating writes is both expensive and
    // dangerous.
    const allReads = loop.ngram.every((n) => isReadName(n));
    if (!allReads && latestRepeatStalled(run.events, loop.ngram)) {
      const hit = matchingProgram(live, (p) => hasNgram(p.sequence, loop.ngram!));
      if (hit) return { action: "steer", program: hit, reason: "loop" };
      return { action: "halt", reason: "loop" };
    }
  }
  if (isStretchEnd(name)) {
    const required = requiredChecks(live, [...run.events, { name }]);
    const preview = evidenceLedger([...run.events, { name, args: {}, ok: true }], required);
    if (preview.absent.length) {
      const need = new Set(preview.absent);
      const hit = matchingProgram(live, (p) => (p.sequence ?? []).some((n) => need.has(n)));
      if (hit) return { action: "steer", program: hit, reason: "missing_evidence" };
      return { action: "block", reason: "missing_evidence" };
    }
  }
  const elapsed = now - run.t0;
  const cap = forecastTimeoutMs(opts);
  const remaining = cap - elapsed;
  // Only the program this run is actually on — never max(all live budget.ms).
  // A stretch that matches no live sequence is unique-work and must not take
  // a budget halt because some other live tool has a large predicted ms.
  const onPath = [...run.events, { name }];
  const matches = matchingRunPrograms(live, onPath);
  const on = matches[0];
  if (!on?.budget) return null;
  const view = remainingBudget({
    predicted: on.budget,
    actual: actualSpend(run, now),
    remainingTimeoutMs: remaining,
  });
  // Spent (actual ≥ predicted llm/ms/cents) does not wait on firstWarningAt.
  // Timeout-pressure (predicted ms > remaining timeout) still does: lifting
  // that would false-halt the first call of any program whose predicted ms
  // exceeds the cap left.
  if (view.spent) return { action: "halt", reason: "budget", detail: forecastCopy(view) };
  if (run.firstWarningAt == null) return null;
  if (view.timeoutPressure) {
    // Only a program that *fits* the time left may be steered to. The old
    // `|| Boolean(p.manifest)` made this predicate always true for verified
    // programs, so the branch steered to whichever came first — even one
    // that could not fit and would itself deopt on timeout. Scope the
    // candidates to the in-flight match set, not every live tool.
    const hit = matchingProgram(matches, (p) => (p.budget?.ms ?? 0) <= remaining);
    if (hit) return { action: "steer", program: hit, reason: "budget" };
    return { action: "halt", reason: "budget", detail: forecastCopy(view) };
  }
  return null;
}
