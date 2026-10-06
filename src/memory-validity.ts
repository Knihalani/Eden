/**
 * Validity (A4 §5.1 step 5) for the legacy store, by A4 §3.1's supersession lexicon, until P0.3 persists
 * `invalid_at` on rows:
 * - a **retraction** invalidates a value with no successor: "we no longer use Redis", "we don't use jest anymore",
 *   "we dropped Redis";
 * - a **switch** invalidates the value left behind: "we switched apps/web from Auth0 to Clerk", "replaced npm with
 *   pnpm", "use pnpm, not npm", "pnpm instead of npm";
 * - a **revocation** invalidates the rules that forbid an action: "you can merge PRs yourself now".
 *
 * Only user-typed text invalidates (A4 §3.0): the memory hook reads the human Submit's prompt and appends one record
 * per invalidation to `<root>/validity.jsonl`. Every delivery point then drops each sentence of a row or gist that
 * is older than an invalidation and still asserts its value (or forbids its action). A sentence that states the
 * change itself is kept. Values are single tokens and match as whole words, in any scope. An episode carrying an
 * invalidated value is D31's `stale_for`: a cue that asks about history keeps it (A4 §5.1 step 5).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Invalidation = { k: "retract"; o: string; t: number } | { k: "revoke"; v: string; t: number };

const FILE = "validity.jsonl";

/** A value: one token after an optional article (`the Redis cache` → `redis`). */
const VALUE = String.raw`(?:the |our |a |an )?([a-z0-9@][\w@./+-]*[a-z0-9])`;
const WHO = String.raw`(?:we|i|they|you|it)(?:'ve| have)?`;

const RETRACT = [
  new RegExp(String.raw`\bno longer (?:use|uses|using|run|runs|need|needs|have|has|depend on|rely on) ${VALUE}`, "gi"),
  new RegExp(String.raw`\b(?:don'?t|do not|doesn'?t|does not) (?:use|need|run) ${VALUE} any ?more\b`, "gi"),
  new RegExp(String.raw`\bnot (?:using|running) ${VALUE} any ?more\b`, "gi"),
  new RegExp(String.raw`\b${WHO} (?:dropped|stopped using|got rid of) ${VALUE}`, "gi"),
];
const SWITCH = [
  new RegExp(String.raw`\b(?:switched|moved|migrated|changed|went)\b[^.!?;\n]*?\bfrom ${VALUE} to \S`, "gi"),
  new RegExp(String.raw`\breplaced ${VALUE} with \S`, "gi"),
  new RegExp(String.raw`\buse [\w@./+-]+,? not ${VALUE}`, "gi"),
  new RegExp(String.raw`\b[\w@./+-]+ instead of ${VALUE}`, "gi"),
];
const REVOKE = [
  /\byou (?:can|may|are allowed to|are free to) ([a-z]+)\b[^.!?;\n]*\bnow\b/gi,
  /\b(?:it'?s|it is) (?:fine|ok|okay) (?:for you )?to ([a-z]+)\b[^.!?;\n]*\bnow\b/gi,
];

const NOT_VALUES = new Set(["it", "that", "this", "them", "those", "these", "one", "any", "anything", "all"]);

function sentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function matches(patterns: readonly RegExp[], sentence: string): string[] {
  return patterns.flatMap((pattern) =>
    [...sentence.matchAll(pattern)].map((match) => match[1]!.toLowerCase()).filter((value) => !NOT_VALUES.has(value)),
  );
}

/** The invalidations a user-typed text states. */
export function invalidationsIn(text: string, t: number): Invalidation[] {
  const found: Invalidation[] = [];
  for (const sentence of sentences(text)) {
    for (const o of matches([...RETRACT, ...SWITCH], sentence)) found.push({ k: "retract", o, t });
    for (const v of matches(REVOKE, sentence)) found.push({ k: "revoke", v, t });
  }
  return found;
}

/** Appends the invalidations of a human prompt to the store's validity log. Fails open. */
export function recordInvalidations(root: string, prompt: string, t = Date.now()): void {
  try {
    const found = invalidationsIn(prompt, t);
    if (!found.length) return;
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, FILE), found.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
  } catch {}
}

/** The store's invalidations. Fails open to none. */
export function readInvalidations(root: string): Invalidation[] {
  let text = "";
  try {
    text = readFileSync(join(root, FILE), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const record = JSON.parse(line) as Partial<Invalidation>;
      if (typeof record.t !== "number") return [];
      if (record.k === "retract" && typeof record.o === "string") return [record as Invalidation];
      if (record.k === "revoke" && typeof record.v === "string") return [record as Invalidation];
      return [];
    } catch {
      return [];
    }
  });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(sentence: string, value: string): boolean {
  return new RegExp(`(?<![\\w@./+-])${escape(value)}(?![\\w@+-]|\\.\\w)`, "i").test(sentence);
}

/** Whether a sentence forbids an action: a negation shortly before the verb ("don't merge it", "never merge"). */
function forbids(sentence: string, verb: string): boolean {
  return new RegExp(String.raw`\b(?:don'?t|do not|never|not)\s+(?:\w+\s+){0,2}${escape(verb)}\w*\b`, "i").test(
    sentence,
  );
}

function invalidates(record: Invalidation, sentence: string): boolean {
  if (record.k === "revoke") return forbids(sentence, record.v);
  if (!mentions(sentence, record.o)) return false;
  return !invalidationsIn(sentence, 0).some((own) => own.k === "retract" && own.o === record.o);
}

/**
 * A row's or gist's text without the sentences an invalidation newer than `at` has made invalid; "" when none is
 * left. A text without a wall-clock time counts as older than every invalidation.
 */
export function validText(text: string, at: unknown, records: readonly Invalidation[]): string {
  const raw = String(text ?? "").trim();
  const time = typeof at === "number" && Number.isFinite(at) ? at : 0;
  const newer = records.filter((record) => record.t > time);
  if (!raw || !newer.length) return raw;
  const parts = sentences(raw);
  const kept = parts.filter((sentence) => !newer.some((record) => invalidates(record, sentence)));
  return kept.length === parts.length ? raw : kept.join(" ");
}

/** A cue that asks about history (A4 §5.1 step 5; R3's markers), which keeps episodes carrying an older value. */
export function asksHistory(prompt: string): boolean {
  return /\b(?:before|used to|previously|was|why did we)\b/i.test(String(prompt ?? ""));
}
