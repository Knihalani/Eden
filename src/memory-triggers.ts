/**
 * Compiled triggers on the cue (A7 §1 layer 3 and §5, D18, A4 §5.1 step 4b): an action word in what the user typed
 * fires its class (`memory-classes.ts`), and each fired class delivers at most 2 of the store's policies and intents
 * keyed on it (D9), ranked by A7 §5: the ones the user stated first, then the most recently stated. Rows carry a
 * scope since P3.1, but the cue's is P3.2's read set, so "narrowest scope" ranks nothing yet. A trigger hit is STRONG
 * evidence and admits alone (A7 §4).
 * Policies are delivered by triggers, not similarity (D18): the lexical path leaves keyed rule rows out (`index.ts`).
 *
 * A class fires on an action the prompt asks for or announces, never on a word that names a topic (R1 Addendum A:
 * topical words overfire). In a clause that asks for information, a WH-question ("where do prod credentials live?",
 * "in general, what are the tradeoffs of soft deletes?") or a request to be told or reminded ("can you remind me how
 * Stripe webhooks work?"), a class word fires only as the verb of the user or the agent ("what should I run before I
 * push?", "how do we deploy?"). Every other clause fires on any class word: a request ("land it"), an announcement
 * ("done, ship it"), a question about doing the action ("can you land it?", "are we done?").
 */
import { CUE_WORDS, type ActionClass } from "./memory-classes";
import type { MemoryRecord } from "./index";
import { compareRecency } from "./memory-ids";
import { knownNoteSource } from "./memory-provenance";

/** A7 §5: what one fired class delivers at most. */
export const PER_CLASS = 2;

/** Words that open a clause without being what it asks ("ok so", "quick question:", "in general,"). */
const OPENING =
  /^(?:(?:ok(?:ay)?|so|hey|hi|also|and|but|btw|then|now|quick question|question|in general|just curious)\b[\s,:!.-]*)+/i;

/** A clause that asks for information rather than for an action (see the header). */
const ASKS_INFORMATION = new RegExp(
  String.raw`^(?:(?:what|what's|whats|which|where|where's|when|who|whom|whose|why|how)\b(?!\s+about\b)|` +
    String.raw`(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:remind|tell|show) me (?:about|of|what|why|how|` +
    String.raw`where|when|who|which|whether|if)\b|(?:i\s+)?need help (?:understanding|with)\b|help me understand\b|` +
    String.raw`(?:(?:can|could|would|will) you\s+)?(?:please\s+)?explain\b)`,
  "i",
);

/** A prompt's clauses: its sentences (at `.`, `!`, `?` or `;` before a space, or a line break), split at commas. */
function clausesOf(prompt: string): string[] {
  return prompt
    .split(/(?<=[.!?;])\s+|\n+/)
    .flatMap((sentence) => sentence.split(/,\s*/))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/** Words before a class word that make it the verb of the user or the agent ("before I push", "can we merge"). */
const PERSON_VERB = new RegExp(
  String.raw`\b(?:i|we|you)(?:\s+(?:can|can't|cannot|could|should|shall|will|would|must|may|might|do|don't|did|` +
    String.raw`didn't|need|needs|have|has|want|am|are|going|gonna|got|to|not|just|also|still|then|now|first|ever))*\s+$`,
  "i",
);

const asksInformation = (clause: string) => ASKS_INFORMATION.test(clause.replace(OPENING, ""));

/** Where a class's word first fires in a clause, if it does (see the header). */
function firesAt(clause: string, words: RegExp, informational: boolean): number | undefined {
  for (const match of clause.matchAll(words))
    if (!informational || PERSON_VERB.test(clause.slice(0, match.index))) return match.index;
  return undefined;
}

/** The last prompt read and its classes: a Submit reads one prompt for its wide event and for `recall`. */
let last: { prompt: string; classes: ActionClass[] } | undefined;

/** The classes a prompt the user typed fires, in the order it first names them (see the header). */
export function firedClasses(prompt: string): ActionClass[] {
  if (last?.prompt === prompt) return [...last.classes];
  const classes = classesIn(String(prompt ?? ""));
  last = { prompt, classes };
  return [...classes];
}

function classesIn(prompt: string): ActionClass[] {
  const first = new Map<ActionClass, number>();
  let at = 0;
  for (const clause of clausesOf(prompt)) {
    const informational = asksInformation(clause);
    for (const [cls, words] of CUE_WORDS) {
      const index = firesAt(clause, words, informational);
      if (index !== undefined && !first.has(cls)) first.set(cls, at + index);
    }
    at += clause.length + 1;
  }
  return [...first].sort((a, b) => a[1] - b[1]).map(([cls]) => cls);
}

/** The classes a rule row's D9 keys name. */
export function ruleClasses(row: Pick<MemoryRecord, "rules">): Set<string> {
  return new Set((row.rules ?? []).map((rule) => rule.k.split("|")[0]!));
}

/** A7 §5's order within a class: what the user stated first, then the most recently stated. */
function byStatement(a: MemoryRecord, b: MemoryRecord): number {
  const user = (row: MemoryRecord) => (knownNoteSource(row) === "user" ? 0 : 1);
  return user(a) - user(b) || compareRecency(b, a);
}

/**
 * The rule rows the fired classes deliver: each class's best `PER_CLASS` (see `byStatement`), every class's first
 * before any class's second, in the order the classes fired, each row once.
 */
export function triggeredRows(rows: readonly MemoryRecord[], classes: readonly ActionClass[]): MemoryRecord[] {
  const ranked = classes.map((cls) =>
    rows
      .filter((row) => ruleClasses(row).has(cls))
      .sort(byStatement)
      .slice(0, PER_CLASS),
  );
  const out: MemoryRecord[] = [];
  for (let rank = 0; rank < PER_CLASS; rank++)
    for (const rowsOfClass of ranked) {
      const row = rowsOfClass[rank];
      if (row && !out.includes(row)) out.push(row);
    }
  return out;
}
