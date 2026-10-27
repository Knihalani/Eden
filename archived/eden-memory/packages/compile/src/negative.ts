import type { TraceEvent } from "@eden/ir";
import {
  canonicalize,
  flatten,
  isCheckName,
  isIslandName,
  isMutating,
  isReadName,
  isWeakValue,
  nameWords,
} from "@eden/ir";

/**
 * Words that name a wait. Cho & Garcia-Molina: uniform polling is waste;
 * visit frequency should follow need. A compiled program is the method, not
 * the wait — `get_status` × N is negative space.
 */
const POLL_WORDS = new Set(["status", "poll", "wait"]);

export function isPollName(name: string): boolean {
  return nameWords(name).some((w) => POLL_WORDS.has(w));
}

function isPollCandidate(name: string): boolean {
  if (isMutating(name) || isCheckName(name) || isIslandName(name)) return false;
  return isReadName(name) || isPollName(name);
}

function samePoll(a: TraceEvent, b: TraceEvent): boolean {
  return a.name === b.name && canonicalize(a.args ?? {}) === canonicalize(b.args ?? {});
}

/** Consecutive same-args reads that are a named wait, not a foreach (foreach varies args). */
function isPollRun(run: TraceEvent[]): boolean {
  if (run.length < 2) return false;
  const name = run[0]?.name;
  if (!name || !isPollCandidate(name)) return false;
  if (!run.every((e) => isPollCandidate(e.name) && samePoll(run[0]!, e))) return false;
  // Named waits (status/poll/wait) stay negative space. A same-args read
  // whose result *changes* (ready false→true) is a poll-until candidate —
  // compile.ts mines `until`, it is not stripped here.
  return isPollName(name);
}

function addValues(into: Set<string>, value: unknown): void {
  for (const v of flatten(value).values()) {
    if (isWeakValue(v)) continue;
    into.add(canonicalize(v));
  }
}

/**
 * Later steps bind from this wait when an arg value is unique to the poll
 * results (not input, not earlier steps, not the poll's own args). Job `id`
 * lives on input — notify({id}) is not a bind from status. A sha that only
 * appears on the terminal poll is.
 */
function pollUsedByLater(events: TraceEvent[], start: number, end: number, input?: Record<string, unknown>): boolean {
  const later = events.slice(end);
  if (!later.length) return false;
  const prior = new Set<string>();
  if (input) addValues(prior, input);
  for (let i = 0; i < start; i++) {
    addValues(prior, events[i]!.args);
    addValues(prior, events[i]!.result);
  }
  addValues(prior, events[start]!.args);
  const fromPoll = new Set<string>();
  for (let i = start; i < end; i++) {
    for (const v of flatten(events[i]!.result).values()) {
      if (isWeakValue(v)) continue;
      const k = canonicalize(v);
      if (!prior.has(k)) fromPoll.add(k);
    }
  }
  if (!fromPoll.size) return false;
  for (const e of later) {
    for (const v of flatten(e.args).values()) {
      if (isWeakValue(v)) continue;
      if (fromPoll.has(canonicalize(v))) return true;
    }
  }
  return false;
}

/**
 * Compile the absence of a poll: drop unused wait runs entirely; if a later
 * step binds from the poll, keep only the last (terminal) call so a program
 * never believes stale `pending`.
 */
export function stripNegativeSpace(events: TraceEvent[], input?: Record<string, unknown>): TraceEvent[] {
  if (events.length < 2) return events;
  const keep = events.map(() => true);
  let i = 0;
  while (i < events.length) {
    const head = events[i]!;
    if (!isPollCandidate(head.name)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < events.length && samePoll(head, events[j]!)) j++;
    const run = events.slice(i, j);
    if (isPollRun(run)) {
      if (pollUsedByLater(events, i, j, input)) {
        for (let k = i; k < j - 1; k++) keep[k] = false;
      } else {
        for (let k = i; k < j; k++) keep[k] = false;
      }
    }
    i = j;
  }
  return events.filter((_, n) => keep[n]);
}
