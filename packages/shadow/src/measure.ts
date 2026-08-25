import type { StretchTrace, TraceEvent } from "@eden/ir";

/** Fixture clock used by TicketShip traces: `duration_ms: 200 * llmCalls`. */
export const SYNTHETIC_MS_PER_LLM = 200;

export function isSyntheticDuration(t: StretchTrace): boolean {
  if (!(t.llmCalls > 0)) return false;
  return t.duration_ms === SYNTHETIC_MS_PER_LLM * t.llmCalls;
}

/** Naive tokens when wrap scraped provider usage. Absent → not measured. */
export function traceTokens(t: StretchTrace): number | null {
  if (t.prompt_tokens == null) return null;
  const prompt = t.prompt_tokens;
  const completion = t.completion_tokens ?? 0;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return prompt + completion;
}

/**
 * Sum recorded tool `duration_ms` on the trace.
 * Missing any event duration → not measured (do not mix clocks).
 */
export function naiveToolMs(t: StretchTrace): number | null {
  if (!t.events.length) return 0;
  let sum = 0;
  for (const e of t.events) {
    const d = e.duration_ms;
    if (d == null || !Number.isFinite(d) || d < 0) return null;
    sum += d;
  }
  return sum;
}

/**
 * Compiled time from the *same* trace: FIFO-match `duration_ms` for tools the
 * program still ran. Does not use tape-lookup wall clock.
 */
export function compiledToolMs(t: StretchTrace, toolCalls: string[]): number | null {
  const used = new Map<string, number>();
  let sum = 0;
  for (const name of toolCalls) {
    const hit = nthEvent(t.events, name, used.get(name) ?? 0);
    if (hit < 0) return null;
    const d = t.events[hit]!.duration_ms;
    if (d == null || !Number.isFinite(d) || d < 0) return null;
    sum += d;
    used.set(name, (used.get(name) ?? 0) + 1);
  }
  return sum;
}

/**
 * Island tokens are not scraped today. Scale naive tokens by remaining LLM
 * calls so an island program can still report a measured delta instead of
 * inventing a second agent run.
 */
export function compiledTokens(t: StretchTrace, compiledLlm: number, hasIsland: boolean): number | null {
  void hasIsland; // kept for signature stability; see tokensExtrapolated
  const naive = traceTokens(t);
  if (naive == null) return null;
  if (compiledLlm <= 0) return 0;
  if (!(t.llmCalls > 0)) return null;
  return naive * (compiledLlm / t.llmCalls);
}

/**
 * Whether the token delta came from that scaling — an estimate, not provider
 * usage. Callers must say so: the ship gate treats estimated numbers as
 * absent, because "honest numbers or absent" does not have an "honest-ish"
 * tier.
 *
 * Keyed on compiledLlm alone, not hasIsland: a program with no DIRECT island
 * step can still burn provider tokens through composed sub-programs, and the
 * old hasIsland-only check let such runs report a measured-looking ZERO.
 */
export function tokensExtrapolated(compiledLlm: number, _hasIsland: boolean): boolean {
  return compiledLlm > 0;
}

function nthEvent(events: TraceEvent[], name: string, n: number): number {
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.name !== name) continue;
    if (seen === n) return i;
    seen++;
  }
  return -1;
}
