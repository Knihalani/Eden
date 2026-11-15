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
import { type Iv, maskOf, type Pieces, same, traced, union } from "./pieces.ts";
import { REDACTED } from "./redact.ts";

type Span = [number, number];

/** One pipeline's structural pass, on a gated text. */
export interface StructuralPass {
  /** Main's assignment spans on `text`: every credential key's value (`all`) and the ones not excused (`strict`). */
  assignments(text: string): { all: Span[]; strict: Span[] };
  /**
   * The structural pass on `gated` as main ran it: its output, `seen.excusable` set when it took an excused value,
   * and `removed`: what it removes from `gated`, as sorted merged intervals, all of it and only what is not an
   * excused value (whose texts go to `values` when given), worked out from the same run. `gating` is the gated
   * text's pieces against the original (pieces.ts), so the pass can use what the gate's scan of the original found.
   */
  run(
    gated: string,
    seen: { excusable: boolean },
    gating: Pieces,
  ): {
    stored: string;
    removed(values?: string[]): { all: Iv[]; strict: Iv[] };
    /** Whether `removed(...).strict` is empty (nothing removed but excused values), worked out more cheaply. */
    keepsAll?(): boolean;
  };
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
  /** The gated text's pieces against `text` (pieces.ts): kept runs and sentinels. */
  const gating: Pieces = [];
  // Its parts, joined once (D1850): a string built by `+=` a span at a time was a rope of as many parts, flattened
  // when the structural pass first read it.
  const parts: string[] = [];
  gate(text, spans, gating, parts);
  const gated = parts.length === 1 ? parts[0]! : parts.join("");
  const seen = { excusable: false };
  const ran = pass.run(gated, seen, gating);
  const stored = ran.stored;
  const excusing = excused.length > 0 || assigned.all.length !== assigned.strict.length || seen.excusable;
  if (post.length === 0 && !excusing && !explain) return { stored };
  // Every finding excused and the structural pass removing only excused values (code in the text, no secret): the
  // gate removes nothing, so the text is stored as it is; the masks below would say so at more cost.
  if (!explain && post.length === 0 && strict.length === 0 && assigned.strict.length === 0 && ran.keepsAll?.()) {
    return { stored: text };
  }

  // What main removed (`before`) and what the gate removes (`after`), as intervals of `text`: the work follows the
  // number of findings, not the text's length (D1850: masks over every character cost 20 ms a megabyte).
  const values: string[] | undefined = explain ? [] : undefined;
  const removed = ran.removed(values);
  const all = traced(gating, removed.all);
  const kept = traced(gating, removed.strict);
  const before = union(spans, all);
  const after = union(strict, assigned.strict, kept, post, post.length > 0 ? assigned.strict : []);
  let masks: Pick<Composed, "before" | "after" | "excused" | "values"> = {};
  if (explain) {
    // Main removed a character only through an excused value when no other reason (above) removes it here.
    const left = assigned.all.filter(([a, b]) => !assigned.strict.some(([c, d]) => a === c && b === d));
    const excusedChars = maskOf(union(excused, left), text.length);
    const keptMask = maskOf(kept, text.length);
    for (const [s0, e0] of all) for (let i = s0; i < e0; i++) if (keptMask[i] === 0) excusedChars[i] = 1;
    for (const [start, end] of excused) values!.push(valueAt(text, start, end));
    for (const [start, end] of left) values!.push(text.slice(start, end));
    masks = { before: maskOf(before, text.length), after: maskOf(after, text.length), excused: excusedChars, values };
  }
  if (same(before, after)) return { stored, ...masks };
  let out = "";
  let from = 0;
  for (const [start, end] of after) {
    out += text.slice(from, start) + REDACTED;
    from = end;
  }
  return { stored: out + text.slice(from), ...masks };
}

/**
 * The gating of `text` by `spans` (sorted by start): its parts (kept runs and sentinels) in `parts` and its pieces in
 * `gating`. A function of its own, its loop last (D1850): V8 compiles a loop on stack replacement and keeps that code
 * for later calls, and code after the loop that saw another kind of string there deoptimized it at every call (849
 * times in one run over the benchmark's texts).
 */
function gate(text: string, spans: Span[], gating: Pieces, parts: string[]): void {
  let at = 0;
  let length = 0;
  for (let k = 0; k <= spans.length; k++) {
    // One past the last span: the text's tail, kept (so no code follows the loop).
    const start = k < spans.length ? spans[k]![0] : text.length;
    const end = k < spans.length ? spans[k]![1] : text.length;
    if (end <= at && k < spans.length) continue;
    const kept = start > at ? start : at;
    if (kept > at) {
      gating.push(length, length + kept - at, at);
      parts.push(text.slice(at, kept));
      length += kept - at;
    }
    if (k === spans.length) {
      if (kept === at) parts.push("");
      return;
    }
    if (start >= at) {
      gating.push(length, length + REDACTED.length, -1);
      parts.push(REDACTED);
      length += REDACTED.length;
    }
    at = end;
  }
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
