import { canonicalize } from "./eq";
import { isCheckName, isMutating, isReadName, isStretchEnd } from "./names";
import type { EvidenceLedger, OnlineWarning, SignalBudget, TraceEvent } from "./types";

export const FAIL_STREAK_AT = 2;
export const NGRAM_MIN = 2;
export const NGRAM_MAX = 4;
export const NGRAM_REPEAT_AT = 2;
/**
 * Reads get one extra identical cycle before the loop signal fires.
 *
 * Two byte-identical read cycles are what legitimate polling looks like
 * (status checks between sleeps), and the guard's response to repeat_ngram
 * when nothing is compiled is a hard stop — an expensive false positive that
 * yanks a human back into the loop. Mutating or unknown-name loops get no such
 * grace: repeating those twice is already evidence of thrash, and letting a
 * third cycle of writes through costs more than the rare extra poll.
 */
export const READ_NGRAM_REPEAT_AT = 3;
export const LOW_GAIN_AT = 0.9;
export const LOW_GAIN_STREAK = 2;
/**
 * Spaced-spin detection (repeat_visits): how many successful calls of one
 * tool constitute a visit pattern, and how similar their results must be to
 * count as stalled. Args are ignored here on purpose — the variant-args case
 * (re-grepping with tweaked terms, finding nothing new) is exactly what this
 * catches and adjacent-pair low_gain cannot.
 */
export const VISIT_STALL_RUN = 3;
export const VISIT_STALL_OVERLAP = 0.9;
/**
 * How much a repeated call's RESULT must change to count as new work.
 * Deliberately stricter than the old 0.9 bar: small results where one field
 * drifts (a timestamp on {ok, ts}) scored 0.83 and read as "progress",
 * letting timestamp-stamped thrash run forever. Real transitions flip the
 * dominant token ({state: pending} → {state: success} scores 0.5) — exactly
 * at this boundary, which is why it is strict inequality below.
 */
export const PROGRESS_RESULTS_OVERLAP = 0.5;
/**
 * Unconditional run-length ceiling (waste audit probe finding): progress
 * detection can be defeated by one drifting field, so detection alone can
 * never bound spend. After MAX_STEPS executed calls the wrap halts the run
 * outright — reads included. Override with EDEN_MAX_STEPS; clamped 10..10_000.
 */
export const MAX_RUN_STEPS = 150;

function liveEvents(events: TraceEvent[]): Array<{ e: TraceEvent; i: number }> {
  const out: Array<{ e: TraceEvent; i: number }> = [];
  for (let i = 0; i < events.length; i++) {
    if (!events[i]!.skipped) out.push({ e: events[i]!, i });
  }
  return out;
}

function failStreakFromEnd(events: TraceEvent[]): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.skipped) continue;
    if (e.ok) break;
    n++;
  }
  return n;
}

function gramCount(names: string[], start: number, n: number, enough: number): number {
  let count = 0;
  for (let i = 0; i + n <= names.length; i++) {
    let match = true;
    for (let k = 0; k < n; k++) {
      if (names[i + k] !== names[start + k]) {
        match = false;
        break;
      }
    }
    if (match) {
      count++;
      if (count >= enough) return count;
    }
  }
  return count;
}

function withBudget(
  kind: OnlineWarning["kind"],
  at: number,
  detail: string,
  budget: SignalBudget,
  extra?: { n?: number; ngram?: string[]; gain?: number },
): OnlineWarning {
  const w: OnlineWarning = {
    kind,
    at,
    detail,
    duration_ms: budget.duration_ms,
    llmCalls: budget.llmCalls,
  };
  if (budget.prompt_tokens != null) w.prompt_tokens = budget.prompt_tokens;
  if (budget.completion_tokens != null) w.completion_tokens = budget.completion_tokens;
  if (extra?.n != null) w.n = extra.n;
  if (extra?.ngram) w.ngram = extra.ngram;
  if (extra?.gain != null) w.gain = extra.gain;
  return w;
}

/** Cheap Jaccard-like similarity of two JSON-ish values. 1 = identical. */
export function valueOverlap(a: unknown, b: unknown): number {
  if (a === undefined && b === undefined) return 0;
  try {
    const ca = canonicalize(a);
    const cb = canonicalize(b);
    if (ca === cb) return 1;
    const ta = ca.replace(/[{}\[\]",:]/g, " ").split(/\s+/).filter(Boolean);
    const tb = cb.replace(/[{}\[\]",:]/g, " ").split(/\s+/).filter(Boolean);
    // Different shapes with no tokens at all — {} vs [] — are different
    // values, not a perfect overlap. Everything-tokenless used to score 1.
    if (!ta.length && !tb.length) return 0;
    const sb = new Set(tb);
    let hit = 0;
    for (const t of ta) if (sb.has(t)) hit++;
    return hit / Math.max(ta.length, tb.length, 1);
  } catch {
    return 0;
  }
}

export function pairGain(prev: TraceEvent, cur: TraceEvent): number {
  const args = valueOverlap(prev.args ?? {}, cur.args ?? {});
  const results = valueOverlap(prev.result, cur.result);
  return 1 - Math.max(args * 0.4 + results * 0.6, args === 1 && results === 1 ? 1 : 0);
}

/**
 * Is this occurrence of a repeated call actually doing new work?
 *
 * A repeated n-gram is waste only when nothing changed. Polling is the
 * counterexample that used to be punished: `get_ci_status → sleep →
 * get_ci_status` repeats as an n-gram whether CI is stuck or moving, and the
 * old detector fired on both — the guard then hard-stopped an agent whose
 * poll had just flipped pending → success, which costs a turn, forces a human
 * back into the loop, and is the most expensive kind of false positive.
 *
 * Three questions, in order:
 *  1. Did the inputs change? Different arguments are a different question
 *     being asked (pagination, the next ticket id), not a loop.
 *  2. Did the output change materially? A result that moved past the
 *     low-gain bar is new information; the loop is paying for itself.
 *  3. Anything unobservable — both results missing, e.g. two failures with
 *     identical args — fails closed toward detection: assumed thrash.
 */
export function repeatProgress(prev: TraceEvent, cur: TraceEvent): boolean {
  const resultsKnown = prev.result !== undefined && cur.result !== undefined;
  if (resultsKnown) {
    // Arg jitter alone never counts as progress. And the bar for a material
    // result change is deliberately strict — at most half the output tokens
    // shared: real transitions ({state: pending} → {state: success}) sit
    // exactly AT this boundary, while one drifting timestamp on a small
    // result scores ~0.83 and is correctly read as spinning.
    return valueOverlap(prev.result, cur.result) <= PROGRESS_RESULTS_OVERLAP;
  }
  // Unobservable outputs fail closed toward detection: assumed thrash.
  return false;
}

/** Start index of an earlier occurrence of `gram`, strictly before `start`. */
function priorOccurrence(names: string[], gram: string[], start: number): number {
  // Overlapping counts: [get_ci_status, get_ci_status] is a real repeat whose
  // prior occurrence shares an edge with the tail. Requiring disjoint windows
  // here made consecutive-call loops invisible to the progress check.
  outer: for (let p = start - 1; p >= 0; p--) {
    for (let k = 0; k < gram.length; k++) {
      if (names[p + k] !== gram[k]) continue outer;
    }
    return p;
  }
  return -1;
}

function lowGainHit(events: TraceEvent[]): { at: number; n: number; gain: number } | null {
  const live = liveEvents(events);
  if (live.length < 2) return null;
  let streak = 0;
  let gain = 1;
  for (let i = 1; i < live.length; i++) {
    const prev = live[i - 1]!.e;
    const cur = live[i]!.e;
    if (prev.name !== cur.name || !prev.ok || !cur.ok || cur.result === undefined || prev.result === undefined) {
      streak = 0;
      continue;
    }
    const g = pairGain(prev, cur);
    if (g > 1 - LOW_GAIN_AT) {
      streak = 0;
      continue;
    }
    streak++;
    gain = Math.min(gain, g);
    if (streak >= LOW_GAIN_STREAK) return { at: live[i]!.i, n: streak + 1, gain };
  }
  return null;
}

export function isUsableOutput(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return false;
}

export function evidenceLedger(events: TraceEvent[], required: string[] = []): EvidenceLedger {
  const checks = events.filter((e) => !e.skipped && isCheckName(e.name));
  const present = [...new Set(checks.filter((e) => e.ok).map((e) => e.name))];
  const failed = [...new Set(checks.filter((e) => !e.ok).map((e) => e.name))];
  const req = [...new Set(required.filter(Boolean))];
  const last = [...events].reverse().find((e) => !e.skipped);
  const ending = Boolean(last && isStretchEnd(last.name));
  const sawMut = events.some((e) => !e.skipped && e.ok && isMutating(e.name));
  const named = (n: string) => events.some((e) => e.name === n && !e.skipped);
  const absent =
    ending && sawMut
      ? req.filter((n) => !present.includes(n) && !failed.includes(n))
      : req.filter((n) => !present.includes(n) && !failed.includes(n) && named(n));
  return { required: req, present, absent, failed };
}

export function firstWarningIndex(events: TraceEvent[], warnings: OnlineWarning[]): number | undefined {
  let at: number | undefined;
  const consider = (i: number) => {
    if (i < 0) return;
    at = at == null ? i : Math.min(at, i);
  };
  for (const w of warnings) consider(w.at);
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.skipped || e.ok === false) consider(i);
  }
  return at;
}

export function postWarningSpend(now: SignalBudget, then?: SignalBudget): SignalBudget | undefined {
  if (!then) return undefined;
  const snap: SignalBudget = {
    duration_ms: Math.max(0, now.duration_ms - then.duration_ms),
    llmCalls: Math.max(0, now.llmCalls - then.llmCalls),
  };
  if (now.prompt_tokens != null && then.prompt_tokens != null) {
    snap.prompt_tokens = Math.max(0, now.prompt_tokens - then.prompt_tokens);
  }
  if (now.completion_tokens != null && then.completion_tokens != null) {
    snap.completion_tokens = Math.max(0, now.completion_tokens - then.completion_tokens);
  }
  return snap;
}

/**
 * Did the two most recent occurrences of this n-gram produce new information?
 *
 * A repeat_ngram warning is permanent once emitted — `seen` pins it for the
 * run — so the guard used to act on it forever after. A CI poll whose status
 * flipped pending → success kept being halted on every later poll because a
 * stale warning said "loop". Re-judge against the live events: only a repeat
 * whose newest cycle is observationally identical to the one before (same
 * args, materially same results) may stop the agent.
 */
/**
 * Did the most recent calls of these tools produce new information?
 *
 * A repeat_ngram warning is permanent once emitted — `seen` pins it for the
 * run — so the guard used to act on it forever after. A CI poll whose status
 * flipped pending → success kept being halted on every later poll because a
 * stale warning said "loop".
 *
 * Judged per tool rather than per aligned occurrence: the newest cycle of a
 * loop is usually still partial when the guard runs (the incoming call is the
 * next step of it), so aligning whole windows compared two stale cycles and
 * missed the change that just landed. If EITHER tool in the n-gram has, on
 * its own two most recent calls, changed inputs or materially changed
 * outputs, the loop is buying information and must not be stopped. Tools with
 * fewer than two recorded calls cannot show progress — fail closed toward
 * detection.
 */
export function latestRepeatStalled(events: TraceEvent[], ngram: string[]): boolean {
  const live = liveEvents(events);
  for (const tool of ngram) {
    let prev: TraceEvent | undefined;
    let cur: TraceEvent | undefined;
    for (let i = live.length - 1; i >= 0; i--) {
      const e = live[i]!.e;
      if (e.name !== tool) continue;
      if (!cur) cur = e;
      else {
        prev = e;
        break;
      }
    }
    if (!cur || !prev) return true;
    if (repeatProgress(prev, cur)) return false;
  }
  return true;
}

/**
 * Cheap online detectors for one in-flight wrap run.
 *
 * No second agent, no extra LLM call. Token fields stay off the warning
 * unless the caller already measured them.
 */
export function takeSignals(
  events: TraceEvent[],
  budget: SignalBudget,
  seen: Set<string>,
  required: string[] = [],
  ledger?: EvidenceLedger,
): OnlineWarning[] {
  const at = events.length - 1;
  if (at < 0) return [];
  const fresh: OnlineWarning[] = [];

  const streak = failStreakFromEnd(events);
  if (streak >= FAIL_STREAK_AT) {
    const key = `fail_streak:${at - streak + 1}`;
    if (!seen.has(key)) {
      seen.add(key);
      fresh.push(withBudget("fail_streak", at, `${streak} consecutive tool failures`, budget, { n: streak }));
    }
  }

  const live = liveEvents(events);
  const names = live.map((x) => x.e.name);
  const maxN = Math.min(NGRAM_MAX, names.length);
  for (let n = maxN; n >= NGRAM_MIN; n--) {
    const start = names.length - n;
    const ngram = names.slice(start);
    const repeatAt = ngram.every((g) => isReadName(g)) ? READ_NGRAM_REPEAT_AT : NGRAM_REPEAT_AT;
    if (gramCount(names, start, n, repeatAt) < repeatAt) continue;
    // A repeated n-gram whose newest occurrence produced new information is a
    // loop that is still paying its way — polling that just watched CI flip
    // pending → success, pagination pulling the next page. Suppress the
    // warning this cycle; it is not added to `seen`, so the first *stalled*
    // repeat (identical args, identical result) still warns, one cycle later.
    // Without this the guard hard-stopped productive polls exactly like
    // thrash, and thrash with consecutive identical calls (an [A,A] n-gram)
    // slipped past the guard's size>=2 check in the other direction.
    const prior = priorOccurrence(names, ngram, start);
    if (prior >= 0) {
      let progressed = false;
      for (let k = 0; k < n; k++) {
        if (repeatProgress(live[prior + k]!.e, live[start + k]!.e)) {
          progressed = true;
          break;
        }
      }
      if (progressed) continue;
    }
    const key = `repeat_ngram:${ngram.join("\0")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(withBudget("repeat_ngram", at, `repeated ${ngram.join(" → ")}`, budget, { n: ngram.length, ngram }));
    break;
  }

  const gain = lowGainHit(events);
  if (gain) {
    const key = `low_gain:${gain.at}`;
    if (!seen.has(key)) {
      seen.add(key);
      fresh.push(
        withBudget("low_gain", gain.at, "consecutive tool results added nothing", budget, { n: gain.n, gain: gain.gain }),
      );
    }
  }

  // Spaced spinning. low_gain only sees *adjacent* same-tool pairs and
  // repeat_ngram only sees contiguous name runs, so a thrash pattern like
  // grep → edit → grep(variant) → write → grep(variant2) — the classic
  // re-searching-for-something-already-found loop, or HAL's "scouring the web
  // for nonexistent sources" — evaded both. This detector watches each
  // tool's own recent history: three successful calls whose *results* are
  // materially identical (args may differ — that is the point) is a visit
  // pattern paying full context price per lap for no new information.
  //
  // Deliberately telemetry-only: the guard does not halt on it. A batch of
  // writes that each return {ok: true} looks exactly like this from the
  // outside, and halting legitimate batch work is the expensive false
  // positive (see the all-read rule on the guard's loop branch). The warning
  // lands on traces, feeds failureModeOf → failure-cluster mining, and is
  // honoured by killAfterWarning.
  const visits = new Map<string, TraceEvent[]>();
  for (const { e } of live) {
    if (!e.ok || e.result === undefined) continue;
    const list = visits.get(e.name);
    if (list) list.push(e);
    else visits.set(e.name, [e]);
  }
  for (const [tool, list] of visits) {
    if (list.length < VISIT_STALL_RUN) continue;
    const window = list.slice(-VISIT_STALL_RUN);
    let worst = 1;
    for (let i = 1; i < window.length; i++) {
      worst = Math.min(worst, valueOverlap(window[i - 1]!.result, window[i]!.result));
    }
    if (worst < VISIT_STALL_OVERLAP) continue;
    const key = `repeat_visits:${tool}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(
      withBudget("repeat_visits", at, `${tool} returned materially the same result ${VISIT_STALL_RUN} times`, budget, {
        n: list.length,
        gain: worst,
      }),
    );
  }

  const book = ledger ?? evidenceLedger(events, required);
  if (book.absent.length) {
    const key = `evidence_gap:${book.absent.join(",")}`;
    if (!seen.has(key)) {
      seen.add(key);
      fresh.push(withBudget("evidence_gap", at, `missing ${book.absent.join(", ")}`, budget, { n: book.absent.length }));
    }
  }

  if (fresh.length) {
    const key = `budget:${at}`;
    if (!seen.has(key)) {
      seen.add(key);
      fresh.push(withBudget("budget", at, "wall and LLM snapshot", budget));
    }
  }
  return fresh;
}

export function failureModeOf(warnings: OnlineWarning[] | undefined): ProgramOriginMode {
  if (!warnings?.length) return "happy";
  if (warnings.some((w) => w.kind === "repeat_ngram" || w.kind === "repeat_visits")) return "loop";
  if (warnings.some((w) => w.kind === "fail_streak")) return "fail_streak";
  if (warnings.some((w) => w.kind === "low_gain")) return "low_gain";
  if (warnings.some((w) => w.kind === "evidence_gap")) return "evidence";
  return "happy";
}

type ProgramOriginMode = "happy" | "loop" | "fail_streak" | "low_gain" | "evidence";
