/**
 * Validity (A4 §5.1 step 5) for the legacy store, until P0.3 persists `invalid_at` and P2.1 and P3.3 bring keys.
 * Only D7's and A4 §3.1's own forms invalidate, read narrowly, because a false invalidation silently drops a memory
 * the user still needs:
 * - a **retraction** (A4 §3.1): "we no longer use Redis", "we don't use Jest anymore", "we're not using Jest
 *   anymore", "we dropped Sentry";
 * - a **switch** (D7): "we switched apps/web from Auth0 to Clerk" (or moved, migrated). D7's "use A, not B" waits for
 *   P3.3: without a slot to tie it to, "use POST instead of GET" is a coding instruction, not a switch;
 * - a **revocation** (A4 §3.1, D9): "you can merge PRs yourself now", whose verb is one of A7 §5's action classes. It
 *   invalidates a rule that forbids an action of the same class on the same object (`forbids`).
 *
 * Only typed text invalidates (A4 §3.0, A6 §2.1): the human Submit's prompt, without its pasted spans
 * (`<pasted_content>`, fenced code, `>` quotes, runs of 3 or more lines without sentence punctuation), and without
 * questions or conditionals, after the store's own secret redaction. A retracted or switched-from value is one token
 * that ends its clause, capitalized or identifier-shaped and not a path (D7's rule for a value outside a slot's value
 * class; P3.3 brings the classes), so a common word ("array", "src") or the first word of a longer name ("Node" of
 * "Node 16") never is one.
 *
 * The hook appends each invalidation to `<root>/validity.jsonl` with its time. Every delivery point then drops each
 * sentence of an older row or gist that still names the value as a whole token, or forbids the revoked action; the
 * sentence stating the change stays, and so does a rule a retraction names (only a revocation supersedes a rule). An
 * episode carrying an invalidated value is D31's `stale_for`: a cue that asks about history keeps it. The whole
 * sentence goes, so a still-valid clause in it goes too, until P3.3's slots split them.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contentWords, FUNCTION_WORDS, STATUS_WORDS } from "./memory-transcript";

export type Invalidation = { k: "retract"; o: string; t: number } | { k: "revoke"; c: string; o: string[]; t: number };

const FILE = "validity.jsonl";

/** A value: one token after an optional article, never a path. Its shape is checked by `valueShaped`. */
const VALUE = String.raw`(?:the |our |a |an )?([A-Za-z0-9@][\w@.+-]*[A-Za-z0-9])`;
/** The value ends its clause ("we no longer use Redis.", not "we no longer use Node 16" or "… CI on Fridays"). */
const CLAUSE_END = String.raw`(?: any ?more)?\s*(?:[.!;,]|$)`;

const RETRACT = [
  new RegExp(
    String.raw`\bwe(?:'re| are)? no longer (?:use|using|run|running|need|have|depend on|rely on) ${VALUE}${CLAUSE_END}`,
    "gi",
  ),
  new RegExp(String.raw`\bwe (?:don'?t|do not) (?:use|run|need) ${VALUE} any ?more\b`, "gi"),
  new RegExp(String.raw`\bwe(?:'re| are) not (?:using|running) ${VALUE} any ?more\b`, "gi"),
  new RegExp(String.raw`\bwe(?:'ve| have)? (?:dropped|stopped using|got rid of) ${VALUE}${CLAUSE_END}`, "gi"),
  new RegExp(String.raw`\bwe(?:'ve| have)? (?:switched|moved|migrated)\b[^.!?;\n]*?\bfrom ${VALUE} to \S`, "gi"),
];

/** A7 §5's action-class verbs that a revocation can name: the class is what a rule and its revocation share. */
const ACTION_VERBS: Record<string, string> = {
  merge: "integrate",
  land: "integrate",
  ship: "integrate",
  commit: "commit",
  push: "push-upstream",
  squash: "history-rewrite",
  rebase: "history-rewrite",
  amend: "history-rewrite",
  "force-push": "history-rewrite",
  deploy: "deploy",
  release: "deploy",
  publish: "deploy",
  delete: "delete",
  remove: "delete",
  prune: "delete",
  drop: "delete",
  install: "dependency",
  bump: "dependency",
  upgrade: "dependency",
  truncate: "destructive-db",
  reset: "destructive-db",
  wipe: "destructive-db",
};
const VERBS = Object.keys(ACTION_VERBS).join("|");
const CLASSES = new Set(Object.values(ACTION_VERBS));
const REVOKE = new RegExp(String.raw`^you (?:can|may|are allowed to|are free to) (${VERBS})\b(.*?)\bnow\b`, "i");

/** Words that name no object: D9 normalizes "don't merge it yourself" to the object `*`. */
const NO_OBJECT = new Set(["yourself", "yourselves", "again", "too", "anytime", "freely", "whenever", "want", "like"]);

/** Sentences that only ask or suppose something never invalidate. */
const NOT_A_STATEMENT =
  /^(?:if|should|shall|could|would|can|do|does|did|is|are|what|why|how|which|when|where|who|whether|maybe|perhaps|suppose)\b/i;

/** A prompt without A6 §2.1's pasted spans. */
function typedText(prompt: string): string {
  const unpasted = String(prompt ?? "")
    .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\b[^>]*>/gi, "\n")
    .replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2|$)/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line));
  const kept: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length < 3) kept.push(...run);
    run = [];
  };
  for (const line of unpasted) {
    if (line.trim() && !/[.!?]\s*$/.test(line)) run.push(line);
    else {
      flush();
      kept.push(line);
    }
  }
  flush();
  return kept.join("\n");
}

function sentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function statements(text: string): string[] {
  return sentences(text).filter((sentence) => !sentence.endsWith("?") && !NOT_A_STATEMENT.test(sentence));
}

/** D7's value shape: capitalized, or with a digit, an inner capital, a dot or an underscore; never a path. */
function valueShaped(value: string): boolean {
  const lower = value.toLowerCase();
  if (value.includes("/") || lower === "redacted" || FUNCTION_WORDS.has(lower) || STATUS_WORDS.has(lower)) return false;
  return /^[A-Z]/.test(value) || /\d/.test(value) || /[a-z][A-Z]/.test(value) || /\w[._]\w/.test(value);
}

/** An object word in one form ("PRs" and "PR" are the same object). */
function singular(word: string): string {
  return word.length >= 3 && /[^siu]s$/.test(word) ? word.slice(0, -1) : word;
}

function objectWords(text: string): string[] {
  return contentWords(text)
    .filter((word) => !NO_OBJECT.has(word))
    .map(singular);
}

/** The invalidations a typed prompt states. */
export function invalidationsIn(prompt: string, t: number): Invalidation[] {
  const found: Invalidation[] = [];
  for (const sentence of statements(typedText(prompt))) {
    for (const pattern of RETRACT)
      for (const match of sentence.matchAll(pattern))
        if (valueShaped(match[1]!)) found.push({ k: "retract", o: match[1]!.toLowerCase(), t });
    const revoked = REVOKE.exec(sentence);
    if (revoked)
      found.push({ k: "revoke", c: ACTION_VERBS[revoked[1]!.toLowerCase()]!, o: objectWords(revoked[2]!), t });
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
  return text.split("\n").flatMap((line): Invalidation[] => {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const t = record.t;
      if (typeof t !== "number") return [];
      if (record.k === "retract" && typeof record.o === "string") return [{ k: "retract", o: record.o, t }];
      if (record.k === "revoke" && typeof record.c === "string" && CLASSES.has(record.c) && Array.isArray(record.o))
        return [
          { k: "revoke", c: record.c, o: record.o.filter((word): word is string => typeof word === "string"), t },
        ];
      return [];
    } catch {
      return [];
    }
  });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a sentence names a value as a whole token: not inside a path, a filename or a longer name. */
function mentions(sentence: string, value: string): boolean {
  return new RegExp(`(?<![\\w@./+-])${escape(value)}(?![\\w@/+-]|\\.\\w)`, "i").test(sentence);
}

/**
 * Whether a sentence forbids an action of the revoked class on the revoked object (D9's `(class, polarity,
 * object)`): its object, the words after the negated verb up to the end of the clause, is within the revocation's,
 * and the revocation's is named in the sentence. "You can merge PRs now" so revokes "never merge PRs" and "push the
 * fix to the PR, but don't merge it yourself", and not "never merge PRs without a review" or "never merge"; "you can
 * delete the branch now" does not revoke "never delete the main branch".
 */
function forbids(sentence: string, record: Extract<Invalidation, { k: "revoke" }>): boolean {
  const verbs = Object.keys(ACTION_VERBS).filter((verb) => ACTION_VERBS[verb] === record.c);
  if (!verbs.length) return false;
  const negated = new RegExp(
    String.raw`\b(?:don'?t|do not|never|not)\s+(?:\w+\s+){0,2}(?:${verbs.join("|")})\w*\b([^,;:.!?]*)`,
    "i",
  );
  const match = negated.exec(sentence);
  if (!match) return false;
  const revoked = new Set(record.o);
  const named = new Set(objectWords(sentence));
  return objectWords(match[1]!).every((word) => revoked.has(word)) && record.o.every((word) => named.has(word));
}

function invalidates(record: Invalidation, sentence: string, rule: boolean): boolean {
  if (record.k === "revoke") return forbids(sentence, record);
  if (rule) return false;
  if (!mentions(sentence, record.o)) return false;
  return !invalidationsIn(sentence, 0).some((own) => own.k === "retract" && own.o === record.o);
}

/**
 * A row's or gist's text without the sentences an invalidation newer than `at` has made invalid; "" when none is
 * left. A text without a wall-clock time counts as older than every invalidation. A rule (`rule`) is superseded only
 * by a revocation: a retraction supersedes slot facts and makes episodes `stale_for` (A4 §3.1).
 */
export function validText(text: string, at: unknown, records: readonly Invalidation[], rule = false): string {
  const raw = String(text ?? "").trim();
  const time = typeof at === "number" && Number.isFinite(at) ? at : 0;
  const newer = records.filter((record) => record.t > time);
  if (!raw || !newer.length) return raw;
  const parts = sentences(raw);
  const kept = parts.filter((sentence) => !newer.some((record) => invalidates(record, sentence, rule)));
  return kept.length === parts.length ? raw : kept.join(" ");
}

/** A cue that asks about history (A4 §5.1 step 5; R3's markers), which keeps episodes carrying an older value. */
export function asksHistory(prompt: string): boolean {
  return /\b(?:before|used to|previously|was|why did we)\b/i.test(String(prompt ?? ""));
}
