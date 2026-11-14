/**
 * D1850: how the secret gate turns its rules' spans into the stored text, shared by the gate (`secrets.ts`) and its
 * reference (`secrets.reference.ts`), each with its own structural pass.
 *
 * Main's pipeline stays as it was: every pre-D1850 rule's span (including the ones `not-secret.ts` excuses) and, with
 * any of them, the assignment pass's spans on the text gate it; the structural pass runs on the gated text. Its output
 * is what main stored, and it is returned as it is unless D1850 changes something. Two things can:
 *
 * - D1850's rules (`post`) add spans. They run apart: gated with the others, their spans changed what the keyword
 *   rule's matches and the structural pass saw, and the gate redacted less than main (the review of 2026-11-14).
 * - A value that is code or a placeholder (`not-secret.ts`) is left in place, whichever rule or pass took it. Only
 *   its own characters come back: dropping its span before the gating changed what the passes saw next to it.
 *
 * Then the stored text is rendered from a mask: what main removed for any other reason (the spans not excused, and
 * what the structural pass removed from the gated text other than an excused assignment value, traced back through
 * the gating), plus the post rules' spans, one sentinel a removed run. So the gate removes everything main removed
 * but the excused values' own characters, by construction, and `never-less.test.ts` checks it against a frozen main.
 */
import { valueAt } from "./not-secret.ts";
import { REDACTED } from "./redact.ts";

type Span = [number, number];

/** One pipeline's structural pass, on a gated text. */
export interface StructuralPass {
  /** Main's assignment spans on `text`: every credential key's value (`all`) and the ones not excused (`strict`). */
  assignments(text: string): { all: Span[]; strict: Span[] };
  /**
   * The structural pass on `gated` as main ran it: its output, `seen.excusable` set when it took an excused value,
   * and `masks`: what it removes from `gated` (1: removed), all of it and only what is not an excused value (whose
   * texts go to `values` when given), worked out from the same run.
   */
  run(
    gated: string,
    seen: { excusable: boolean },
  ): { stored: string; masks(values?: string[]): { all: Uint8Array; strict: Uint8Array } };
}

/** What `composeMasks` works out: the stored text, and (when asked, or when D1850 changes something) the masks. */
export interface Composed {
  stored: string;
  /** What main removed; what the gate removes; what main removed only through an excused value (1: such a char). */
  before?: Uint8Array;
  after?: Uint8Array;
  excused?: Uint8Array;
  /** The excused values' texts, so a test can check each is code or a placeholder (not-secret.ts). */
  values?: string[];
}

/** The stored text for `text`, given the pre-D1850 rules' spans (`strict`, `excused`) and D1850's (`post`). */
export function composeStored(
  text: string,
  strict: Span[],
  excused: Span[],
  post: Span[],
  pass: StructuralPass,
): string {
  return composeMasks(text, strict, excused, post, pass, false).stored;
}

/** `composeStored`, with its masks when `explain` (for tests). */
export function composeMasks(
  text: string,
  strict: Span[],
  excused: Span[],
  post: Span[],
  pass: StructuralPass,
  explain: boolean,
): Composed {
  const main = strict.length + excused.length > 0;
  const assigned = main ? pass.assignments(text) : { all: [], strict: [] };
  const spans = byStart(strict.concat(excused, assigned.all));
  let gated = "";
  let at = 0;
  for (const [start, end] of spans) {
    if (end <= at) continue;
    gated += text.slice(at, Math.max(start, at)) + (start >= at ? REDACTED : "");
    at = end;
  }
  gated += text.slice(at);
  const seen = { excusable: false };
  const ran = pass.run(gated, seen);
  const stored = ran.stored;
  const excusing = excused.length > 0 || assigned.all.length !== assigned.strict.length || seen.excusable;
  if (post.length === 0 && !excusing && !explain) return { stored };

  /** Per character of `gated`, its index in `text`, or -1 inside a sentinel (the gating walk again). */
  const map = new Int32Array(gated.length);
  let n = 0;
  at = 0;
  for (const [start, end] of spans) {
    if (end <= at) continue;
    const kept = Math.max(start, at);
    for (let i = at; i < kept; i++) map[n++] = i;
    if (start >= at) for (let i = 0; i < REDACTED.length; i++) map[n++] = -1;
    at = end;
  }
  for (let i = at; i < text.length; i++) map[n++] = i;
  const before = new Uint8Array(text.length);
  const after = new Uint8Array(text.length);
  for (const [start, end] of spans) before.fill(1, start, end);
  for (const [start, end] of strict) after.fill(1, start, end);
  for (const [start, end] of assigned.strict) after.fill(1, start, end);
  const values: string[] | undefined = explain ? [] : undefined;
  const { all, strict: kept } = ran.masks(values);
  for (let j = 0; j < gated.length; j++) {
    const i = map[j]!;
    if (i < 0) continue;
    if (all[j] === 1) before[i] = 1;
    if (kept[j] === 1) after[i] = 1;
  }
  let excusedChars: Uint8Array | undefined;
  if (explain) {
    // Main removed a character only through an excused value when no other reason (above) removes it here.
    excusedChars = new Uint8Array(text.length);
    for (const [start, end] of excused) excusedChars.fill(1, start, end);
    const left = assigned.all.filter(([a, b]) => !assigned.strict.some(([c, d]) => a === c && b === d));
    for (const [start, end] of left) excusedChars.fill(1, start, end);
    for (let j = 0; j < gated.length; j++) if (all[j] === 1 && kept[j] === 0 && map[j]! >= 0) excusedChars[map[j]!] = 1;
    for (const [start, end] of excused) values!.push(valueAt(text, start, end));
    for (const [start, end] of left) values!.push(text.slice(start, end));
  }
  for (const [start, end] of post) after.fill(1, start, end);
  if (post.length > 0)
    for (const [start, end] of (main ? assigned : pass.assignments(text)).strict) after.fill(1, start, end);
  let same = true;
  for (let i = 0; i < text.length && same; i++) same = before[i] === after[i];
  if (same) return { stored, before, after, excused: excusedChars, values };
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length;) {
    if (after[i] === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && after[j] === 1) j++;
    out += text.slice(from, i) + REDACTED;
    from = i = j;
  }
  return { stored: out + text.slice(from), before, after, excused: excusedChars, values };
}

/**
 * `spans` sorted by start, stably: what `spans.sort((a, b) => a[0] - b[0])` gives, by merging the runs already in
 * order (each rule reports its spans in order, so a text holds a few runs however many spans): a comparator sort
 * cost 10 ms a megabyte of findings (D1850).
 */
export function byStart(spans: Span[]): Span[] {
  let runs: Span[][] = [];
  let from = 0;
  for (let i = 1; i <= spans.length; i++) {
    if (i === spans.length || spans[i]![0] < spans[i - 1]![0]) {
      runs.push(spans.slice(from, i));
      from = i;
    }
  }
  if (runs.length <= 1) return spans;
  // Merge neighbours, the left one first at an equal start (stable), until one run is left.
  while (runs.length > 1) {
    const next: Span[][] = [];
    for (let r = 0; r + 1 < runs.length; r += 2) next.push(merge(runs[r]!, runs[r + 1]!));
    if (runs.length % 2 === 1) next.push(runs[runs.length - 1]!);
    runs = next;
  }
  return runs[0]!;
}

function merge(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(b[j]![0] < a[i]![0] ? b[j++]! : a[i++]!);
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}
