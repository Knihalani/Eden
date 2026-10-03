/**
 * Reading packets and windows against the world: which bullets a packet holds, and which slot or policy
 * values a piece of text states. The A5 metrics are built on these two readings.
 *
 * A text states a value when one sentence holds a phrase of the value and, unless the value names its
 * subject on its own, a phrase of the subject. A value in a historic or negated context ("was jest",
 * "from Auth0", "not npm", "no longer use Redis") is not stated. A sentence may carry several scopes, split
 * by ` · ` as in A4's two-scope bullet (`auth — apps/web: Clerk · packages/cli: none`).
 */
import type { Subject } from "./oracle";

/** A value a text states. `scope` is the scope the text names, if any. */
export interface Statement {
  key: string;
  value: string;
  scope?: string;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;
const TAG = /^\[[^\]]*\]\s*/;
/** Words after which a value is history or negated, with at most one word in between ("no longer use X"). */
const HISTORIC =
  /(?:^|[^a-z0-9'])(?:was|were|from|not|no|never|don't|doesn't|didn't|no longer|instead of|rather than|formerly|previously|used to|replaced|dropped|removed|without)(?:\s+\S+)?\s+$/;

/** The bullet lines of a packet. A packet without bullet lines is one bullet. */
export function bulletsOf(packet: string): string[] {
  const bullets = packet.split("\n").flatMap((line) => {
    const match = BULLET.exec(line);
    return match ? [match[1]!] : [];
  });
  return bullets.length ? bullets : packet.trim() ? [packet.trim()] : [];
}

/** A bullet without its leading `[kind · age · src]` tag, which is Eden's metadata, not content. */
export function bulletContent(bullet: string): string {
  return bullet.replace(TAG, "").trim();
}

/** The lines of a packet that are not bullets, such as `Eden memory (apps/web), recalled …`. */
export function packetHeader(packet: string): string {
  return packet
    .split("\n")
    .filter((line) => !BULLET.test(line))
    .join("\n");
}

/** Lowercase tokens joined by single spaces: two texts with the same content normalize alike. */
export function normalize(text: string): string {
  const tokens = text.toLowerCase().match(/[a-z0-9@][a-z0-9@._/-]*/g) ?? [];
  return tokens
    .map((token) => token.replace(/[._/-]+$/, ""))
    .filter(Boolean)
    .join(" ");
}

/** Whether `normalized` text contains `part` (both from `normalize`) as whole tokens. */
export function containsNormalized(normalized: string, part: string): boolean {
  return part.length > 0 && ` ${normalized} `.includes(` ${part} `);
}

/**
 * The scopes a text names, in order of appearance: a scope path, alone or as the start of a file path. Its
 * segments may also be separated by spaces (`apps web`), as today's hook writes them in its gists.
 */
export function scopesNamed(text: string, scopes: readonly string[]): { scope: string; at: number }[] {
  const lower = text.toLowerCase();
  const found: { scope: string; at: number }[] = [];
  for (const scope of scopes) {
    if (!scope) continue;
    const path = scope.toLowerCase().split("/").map(escapeRegExp).join("(?:/|\\s+)");
    for (const match of lower.matchAll(new RegExp(`(?<![a-z0-9])${path}(?![a-z0-9_-])`, "g"))) {
      found.push({ scope, at: match.index });
    }
  }
  // A longer scope at the same place wins (`apps/web/app` over `apps/web`).
  return found
    .sort((a, b) => a.at - b.at || b.scope.length - a.scope.length)
    .filter((item, i, all) => i === 0 || all[i - 1]!.at !== item.at);
}

/** Every value `text` states, at most once each. */
export function statementsIn(text: string, subjects: readonly Subject[], scopes: readonly string[]): Statement[] {
  const found = new Map<string, Statement>();
  for (const sentence of sentencesOf(text.toLowerCase())) {
    for (const subject of subjects) {
      const named = names(sentence, subject);
      for (const segment of sentence.split(" · ")) {
        for (const [value, phrases] of Object.entries(subject.values)) {
          if (!named && !subject.standalone?.includes(value)) continue;
          const at = phrases.flatMap((phrase) => assertedAt(segment, phrase.toLowerCase()))[0];
          if (at === undefined) continue;
          const scope = scopeAt(segment, at, scopes) ?? scopeAt(sentence, sentence.indexOf(segment) + at, scopes);
          const statement: Statement = { key: subject.key, value, ...(scope === undefined ? {} : { scope }) };
          found.set(JSON.stringify(statement), statement);
        }
      }
    }
  }
  return [...found.values()];
}

/** Which sentences may count: those naming none of the world's `scopes`, or naming one of `accept`. */
export interface ScopeFilter {
  scopes: readonly string[];
  accept: readonly string[];
}

/**
 * Whether `text` (already lowercase) states that `subject` has `value`. With a filter, a sentence that names
 * another scope does not count ("apps/web uses postgres" does not state the cli's database).
 */
export function statesValue(lower: string, subject: Subject, value: string, where?: ScopeFilter): boolean {
  for (const phrase of subject.values[value] ?? []) {
    for (const at of occurrences(lower, phrase.toLowerCase())) {
      const sentence = sentenceAround(lower, at);
      if (!assertedAt(sentence.text, phrase.toLowerCase()).includes(at - sentence.start)) continue;
      if (!subject.standalone?.includes(value) && !names(sentence.text, subject)) continue;
      if (!where) return true;
      const named = scopesNamed(sentence.text, where.scopes);
      if (!named.length || named.some((item) => where.accept.includes(item.scope))) return true;
    }
  }
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Positions of `phrase` in `segment` that are not in a historic or negated context. */
function assertedAt(segment: string, phrase: string): number[] {
  return occurrences(segment, phrase).filter((at) => !HISTORIC.test(segment.slice(0, at)));
}

/** Where `phrase` occurs as whole words. */
function occurrences(text: string, phrase: string): number[] {
  const out: number[] = [];
  if (!phrase) return out;
  const wordStart = /[a-z0-9]/.test(phrase[0]!);
  const wordEnd = /[a-z0-9]/.test(phrase.at(-1)!);
  for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
    const before = text[at - 1];
    const next = text[at + phrase.length];
    if (wordStart && before !== undefined && /[a-z0-9]/.test(before)) continue;
    if (wordEnd && next !== undefined && /[a-z0-9]/.test(next)) continue;
    out.push(at);
  }
  return out;
}

/** Sentences end at a newline, or at `.`, `!`, `?` or `;` followed by whitespace (so `auth.ts` is one word). */
function sentencesOf(lower: string): string[] {
  return lower
    .split(/\n|[.!?;](?=\s)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function endsSentence(text: string, at: number): boolean {
  return text[at] === "\n" || (/[.!?;]/.test(text[at] ?? "") && /\s/.test(text[at + 1] ?? ""));
}

/** The sentence holding position `at`, found by scanning outwards, so a large window is never split whole. */
function sentenceAround(lower: string, at: number): { text: string; start: number } {
  let start = at;
  while (start > 0 && !endsSentence(lower, start - 1)) start--;
  let end = at;
  while (end < lower.length && !endsSentence(lower, end)) end++;
  return { text: lower.slice(start, end), start };
}

function names(sentence: string, subject: Subject): boolean {
  return subject.words.some((word) => occurrences(sentence, word.toLowerCase()).length > 0);
}

/** Whether `text` names `subject`: one of its words, or a value that names it on its own. */
export function mentions(text: string, subject: Subject): boolean {
  const lower = text.toLowerCase();
  const alone = (subject.standalone ?? []).flatMap((value) => subject.values[value] ?? []);
  return names(lower, subject) || alone.some((phrase) => occurrences(lower, phrase.toLowerCase()).length > 0);
}

/** The scope a statement at `at` is about: the nearest scope named before it, else the first named after. */
function scopeAt(text: string, at: number, scopes: readonly string[]): string | undefined {
  const named = scopesNamed(text, scopes);
  return named.filter((item) => item.at <= at).at(-1)?.scope ?? named[0]?.scope;
}
