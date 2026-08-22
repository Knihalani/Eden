import { evidenceLedger, isCheckName, isStretchEnd } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";
import type { EdenOpts, RunRecorder } from "./types";

export type GuardDecision =
  | { action: "halt"; reason: string }
  | { action: "block"; reason: string }
  | { action: "steer"; program: StretchProgram; reason: string };

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

/** Checks required by the live program this run is actually on, not the union of every live tool. */
export function requiredChecks(
  live: StretchProgram[],
  events: { name: string; skipped?: boolean }[],
): string[] {
  const seen = events.filter((e) => !e.skipped).map((e) => e.name);
  const first = seen[0];
  if (!first) return [];
  const hit = live
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
    .sort((a, b) => (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0))[0];
  return hit ? (hit.sequence ?? []).filter(isCheckName) : [];
}

export function killAfterWarningEnabled(opts: EdenOpts): boolean {
  if (opts.killAfterWarning != null) return opts.killAfterWarning;
  return process.env.EDEN_KILL_AFTER_WARNING === "1";
}

/** Cheap mid-run halt / steer. No extra LLM. */
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
    const hit = matchingProgram(live, (p) => hasNgram(p.sequence, loop.ngram!));
    if (hit) return { action: "steer", program: hit, reason: "loop" };
    return { action: "halt", reason: "loop" };
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
  if (run.firstWarningAt == null) return null;
  const elapsed = now - run.t0;
  const env = Number(process.env.EDEN_TIMEOUT_MS);
  const raw = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : Number.isFinite(env) && env > 0 ? env : 60_000;
  const cap = Math.min(300_000, Math.max(1, raw));
  const remaining = cap - elapsed;
  const predicted = live.reduce((m, p) => Math.max(m, p.budget?.ms ?? 0), 0);
  if (predicted > 0 && remaining >= 0 && predicted > remaining) {
    // Only a program that *fits* the time left may be steered to. The old
    // `|| Boolean(p.manifest)` made this predicate always true for verified
    // programs, so the branch steered to whichever came first — even one
    // that could not fit and would itself deopt on timeout.
    const hit = matchingProgram(live, (p) => (p.budget?.ms ?? 0) <= remaining);
    if (hit) return { action: "steer", program: hit, reason: "budget" };
    return { action: "halt", reason: "budget" };
  }
  return null;
}
