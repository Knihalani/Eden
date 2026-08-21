import { canonicalize } from "./eq";
import { isCheckName, isMutating, isStretchEnd } from "./names";
import type { EvidenceLedger, OnlineWarning, SignalBudget, TraceEvent } from "./types";

export const FAIL_STREAK_AT = 2;
export const NGRAM_MIN = 2;
export const NGRAM_MAX = 4;
export const NGRAM_REPEAT_AT = 2;
export const LOW_GAIN_AT = 0.9;
export const LOW_GAIN_STREAK = 2;

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

function gramCount(names: string[], start: number, n: number): number {
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
      if (count >= NGRAM_REPEAT_AT) return count;
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
    if (!ta.length && !tb.length) return 1;
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
  const absent =
    ending && sawMut ? req.filter((n) => !present.includes(n) && !failed.includes(n)) : req.filter((n) => !present.includes(n) && !failed.includes(n) && events.some((e) => e.name === n));
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

  const names = liveEvents(events).map((x) => x.e.name);
  const maxN = Math.min(NGRAM_MAX, names.length);
  for (let n = maxN; n >= NGRAM_MIN; n--) {
    const start = names.length - n;
    if (gramCount(names, start, n) < NGRAM_REPEAT_AT) continue;
    const ngram = names.slice(start);
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

  const ledger = evidenceLedger(events, required);
  if (ledger.absent.length) {
    const key = `evidence_gap:${ledger.absent.join(",")}`;
    if (!seen.has(key)) {
      seen.add(key);
      fresh.push(withBudget("evidence_gap", at, `missing ${ledger.absent.join(", ")}`, budget, { n: ledger.absent.length }));
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
  if (warnings.some((w) => w.kind === "repeat_ngram")) return "loop";
  if (warnings.some((w) => w.kind === "fail_streak")) return "fail_streak";
  if (warnings.some((w) => w.kind === "low_gain")) return "low_gain";
  if (warnings.some((w) => w.kind === "evidence_gap")) return "evidence";
  return "happy";
}

type ProgramOriginMode = "happy" | "loop" | "fail_streak" | "low_gain" | "evidence";
