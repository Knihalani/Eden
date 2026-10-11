/**
 * Validity (A4 §5.1 step 5) for the legacy store, until P0.3 persists `invalid_at` and P2.1 and P3.3 bring keys.
 * Only D7's and A4 §3.1's own forms invalidate, read narrowly, because a false invalidation silently drops a memory
 * the user still needs:
 * - a **retraction** (A4 §3.1): "we no longer use Redis", "we don't use Jest anymore", "we're not using Jest
 *   anymore", "we dropped Sentry";
 * - a **switch** (D7): "we switched apps/web from Auth0 to Clerk" (or moved, migrated). The words before "from" tie it
 *   to a slot as far as text can: a scope path ("apps/web") and subject words ("the queue"); a sentence naming another
 *   scope, or lacking the subject, keeps the value. D7's "use A, not B" waits for P3.3: without a slot to tie it to,
 *   "use POST instead of GET" is a coding instruction, not a switch;
 * - a **revocation** (A4 §3.1, D9): "you can merge PRs yourself now", whose verb is one of A7 §5's action classes. It
 *   invalidates a rule that forbids an action of the same class on the same object (`forbids`);
 * - an **opposition** (A4 §3.1, L8; P2.1): a typed policy ("never squash") overturns what older text said of the
 *   opposite polarity on its key (D9's `(class, polarity, object)`): "always squash when merging". An intent ("don't
 *   squash yet") overturns nothing;
 * - a **forget** (A6 §3, A4 §3.1's "forget that"): "forget ZebraCache", "forget that the auth provider is Clerk". It
 *   is a retraction (`r: "forget"`) of the value its sentence ends with, shaped as a retracted value is: "Forget the
 *   tests, just fix the build" sets nothing aside, "forget it" neither, and "don't forget to …" is none (D9 fix 2).
 *   Unlike the others, neither its own sentence (`withoutForgets`) nor a history cue keeps the value.
 *
 * Only typed text invalidates (A4 §3.0, A6 §2.1): the human Submit's prompt, without its pasted spans
 * (`<pasted_content>`, fenced code, `>` quotes, runs of 3 or more lines without sentence punctuation), and without
 * questions or conditionals, after the store's own secret redaction. A retracted or switched-from value is one token
 * that ends its clause, capitalized or identifier-shaped and not a path (D7's rule for a value outside a slot's value
 * class; P3.3 brings the classes), so a common word ("array", "src") or the first word of a longer name ("Node" of
 * "Node 16") never is one. The same shape holds where the value is matched: a value shaped by its capitals alone
 * ("Make", "GET") is matched as typed, and where it opens a sentence only as the sentence's subject ("Make is …",
 * not "Make sure …"); a value with a digit, a dot or an underscore ("Auth0") is matched in any case.
 *
 * The hook appends each invalidation to `<root>/validity.jsonl` with its time. Every delivery point then drops each
 * clause of an older row or gist that still names the value as a whole token, and each sentence with a clause that
 * forbids the revoked action (its `;` clauses qualify the rule). The sentence stating the change stays, and so does a
 * rule clause a retraction names (only a revocation supersedes a rule). An episode carrying an invalidated value is
 * D31's `stale_for`: a cue that asks about history keeps it. A whole clause goes, so a still-valid part of it goes too,
 * until P3.3's slots split them.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryNow } from "./memory-clock";
import { stripPacketLabel } from "./memory-provenance";
import { keyedObject, objectWords, oneNamePerObject, oppositeKey, ruleKey, rulesIn } from "./memory-policy";
import { contentWords, FUNCTION_WORDS, STATUS_WORDS } from "./memory-transcript";

/**
 * A retraction or switch (`retract`) of value `o`, with its typed form `f` when its capitals alone shape it; a switch
 * also keeps the scope it names (`s`, a path), its subject words (`w`) and the value it switches to (`n`, as typed,
 * when that is value-shaped). A revocation (`revoke`) of action class `c`
 * on object words `o`. An opposition (`oppose`) of the rule keyed `r`.
 */
export type Invalidation =
  | { k: "retract"; o: string; t: number; f?: string; s?: string; w?: string[]; n?: string; r?: "forget" }
  | { k: "revoke"; c: string; o: string[]; t: number }
  | { k: "oppose"; r: string; t: number };
type Retraction = Extract<Invalidation, { k: "retract" }>;
type Revocation = Extract<Invalidation, { k: "revoke" }>;

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
];
/** A6 §3's forget, opening its sentence: the value is the clause's last token, after "that …" when there is one. */
const FORGET = new RegExp(
  String.raw`^(?:please\s+)?forget(?: about)?\s+(?:that\s+[^.!?;]*?\s)?${VALUE}${CLAUSE_END}`,
  "i",
);
/** D7's switch: the words between the verb and "from" name the slot's subject or scope ("apps/web", "the queue"). */
const SWITCH = new RegExp(
  String.raw`\bwe(?:'ve| have)? (?:switched|moved|migrated)\b([^.!?;\n]*?)\bfrom ${VALUE} to (?:the |our |a |an )?(\S+)`,
  "gi",
);
const PATH = /[\w@.-]*\/[\w@./-]*\w/g;
/** Words between a switch's verb and "from" that name no subject. */
const NO_SUBJECT = new Set(["everything", "things", "stuff", "over", "back", "all", "entirely", "fully"]);

/**
 * A7 §5's action-class verbs that a revocation can name: the class is what a rule and its revocation share, and what
 * a compaction summary must name for a rule to stay habituated (`memory-value-tokens.ts`).
 */
export const ACTION_VERBS: Record<string, string> = {
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

/** D9 fix 3: a class's default object is no object of its own, so "never merge PRs" is the integrate rule on `*`. */
const DEFAULT_OBJECTS: Record<string, readonly string[]> = {
  integrate: ["pr", "pull", "request"],
  "push-upstream": ["branch"],
  "history-rewrite": ["branch"],
  dependency: ["package"],
  deploy: ["prod", "production"],
};

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

/** A sentence ends at its punctuation, never after a list marker ("1. The database is …" is one sentence). */
const SENTENCE_END = /(?<=[.!?])(?<!(?:^|\s)\d{1,3}[.)])\s+|\n+/;
const CLAUSE_BREAK = /;\s+/;

function sentences(text: string): string[] {
  return String(text ?? "")
    .split(SENTENCE_END)
    .flatMap((sentence) => sentence.split(CLAUSE_BREAK))
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

/** A retracted value as logged: lower case, with its typed form when its capitals alone shape it ("Make", "GET"). */
function retracted(value: string): { o: string; f?: string } {
  const byCase = !/\d/.test(value) && !/\w[._]\w/.test(value);
  return { o: value.toLowerCase(), ...(byCase ? { f: value } : {}) };
}

/**
 * The words a slot's subject is matched by, as a switch's subject words (`w`) are kept: content words, singular,
 * without words that name no object or no subject.
 */
export function subjectWords(text: string): string[] {
  return objectWords(text).filter((word) => !NO_SUBJECT.has(word));
}

/** The forget a sentence states, if it states one. */
function forgetIn(sentence: string, t: number): Retraction | undefined {
  const value = FORGET.exec(sentence)?.[1];
  return value && valueShaped(value) ? { k: "retract", ...retracted(value), t, r: "forget" } : undefined;
}

/** A typed text without the sentences that forget (A6 §3): a forget is not itself a memory, as it names the value. */
export function withoutForgets(text: string): string {
  let dropped = false;
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => {
      const parts = line.split(SENTENCE_END);
      const kept = parts.filter((sentence) => !forgetIn(sentence.trim(), 0));
      dropped ||= kept.length < parts.length;
      return kept.join(" ").trim();
    });
  return dropped ? lines.filter(Boolean).join("\n") : text;
}

/** The invalidations a typed prompt states. */
export function invalidationsIn(prompt: string, t: number): Invalidation[] {
  const found: Invalidation[] = [];
  for (const sentence of statements(typedText(prompt))) {
    const forget = forgetIn(sentence, t);
    if (forget) found.push(forget);
    for (const pattern of RETRACT)
      for (const match of sentence.matchAll(pattern))
        if (valueShaped(match[1]!)) found.push({ k: "retract", ...retracted(match[1]!), t });
    for (const match of sentence.matchAll(SWITCH)) {
      if (!valueShaped(match[2]!)) continue;
      const middle = match[1]!;
      const scope = middle.match(PATH)?.[0]?.toLowerCase();
      const subject = subjectWords(middle.replace(PATH, " "));
      const to = match[3]!.replace(/^[`'"(]+|[`'".!?;,:)]+$/g, "");
      found.push({
        k: "retract",
        ...retracted(match[2]!),
        t,
        ...(scope ? { s: scope } : {}),
        ...(subject.length ? { w: subject } : {}),
        ...(valueShaped(to) ? { n: to } : {}),
      });
    }
    const revoked = REVOKE.exec(sentence);
    if (revoked)
      found.push({ k: "revoke", c: ACTION_VERBS[revoked[1]!.toLowerCase()]!, o: objectWords(revoked[2]!), t });
  }
  const opposed = rulesIn(typedText(prompt)).flatMap((rule) =>
    rule.kind === "policy" ? [oppositeKey(ruleKey(rule))] : [],
  );
  for (const r of new Set(opposed)) found.push({ k: "oppose", r, t });
  return found;
}

/** The rule key a revocation revokes: its object keyed as a rule's is ("you can merge PRs now": `integrate|neg|*`). */
function revokedKey(record: Revocation): string {
  return `${record.c}|neg|${keyedObject(record.c, objectWords(oneNamePerObject(record.o.join(" "))))}`;
}

/**
 * The rule keys a typed text counters (A4 §3.1, L8): the rules it revokes, and the opposite of each policy it states.
 * A rule row whose every rule it counters goes to history.
 */
export function counteredKeys(text: string): string[] {
  return invalidationsIn(text, 0).flatMap((record) =>
    record.k === "oppose" ? [record.r] : record.k === "revoke" ? [revokedKey(record)] : [],
  );
}

/** Appends the invalidations of a human prompt to the store's validity log, and returns them. Fails open. */
export function recordInvalidations(root: string, prompt: string, t = memoryNow()): Invalidation[] {
  try {
    const found = invalidationsIn(prompt, t);
    if (!found.length) return [];
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, FILE), found.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
    return found;
  } catch {
    return [];
  }
}

/** Whether an invalidation is a forget (A6 §3). */
export function isForget(record: Invalidation): boolean {
  return record.k === "retract" && record.r === "forget";
}

/**
 * D31's `stale_for` (A4 §3.2): when a typed statement supersedes a slot's value ("The database is postgres" after
 * "1. The database is sqlite"), older text that still gives the subject its old value is stale, episodes included.
 * It is logged as D7's switch is: a retraction of the old value, tied to the slot's subject words. `src: "legacy"`
 * marks one `eden memory migrate` derived, so its rollback can take it back. Fails open.
 */
export function recordSupersession(
  root: string,
  slot: { subject: string; value: string },
  t = memoryNow(),
  src?: "legacy",
): void {
  try {
    const subject = subjectWords(slot.subject);
    if (!subject.length) return;
    const record = { k: "retract", ...retracted(slot.value), t, w: subject, ...(src ? { src } : {}) };
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
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
      if (record.k === "retract" && typeof record.o === "string") {
        const form = typeof record.f === "string" ? { f: record.f } : {};
        const scope = typeof record.s === "string" ? { s: record.s } : {};
        const subject = Array.isArray(record.w)
          ? { w: record.w.filter((word): word is string => typeof word === "string") }
          : {};
        const forget = record.r === "forget" ? { r: "forget" as const } : {};
        const to = typeof record.n === "string" ? { n: record.n } : {};
        return [{ k: "retract", o: record.o, t, ...form, ...scope, ...subject, ...to, ...forget }];
      }
      if (record.k === "revoke" && typeof record.c === "string" && CLASSES.has(record.c) && Array.isArray(record.o))
        return [
          { k: "revoke", c: record.c, o: record.o.filter((word): word is string => typeof word === "string"), t },
        ];
      if (record.k === "oppose" && typeof record.r === "string") return [{ k: "oppose", r: record.r, t }];
      return [];
    } catch {
      return [];
    }
  });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A verb after a value that opens a sentence, making the value the sentence's subject ("React is our UI library"). */
const SUBJECT_VERB = /^\s+(?:is|are|was|were|has|had|uses|used|runs|ran|handles|stores|caches|serves)\b/i;
/**
 * What may come before a clause's first word: nothing but punctuation, a list marker ("1. ", "- "), or a label and
 * its colon ("Note: "). Not a comma: after one, a capital marks a name ("Redis, Make and Docker"), not an opening.
 */
const CLAUSE_OPENING = /^\W*(?:\d{1,3}[.)]\s+)?$|:\s*$/;

/**
 * Whether a sentence names a retracted value as a whole token, not inside a path, a filename or a longer name. A value
 * shaped by its capitals alone is matched as typed, and where it opens the sentence only as its subject: "Make sure …"
 * and "the next release" do not name Make or Next.
 */
function mentions(sentence: string, record: Retraction): boolean {
  const pattern = new RegExp(`(?<![\\w@./+-])${escape(record.o)}(?![\\w@/+-]|\\.\\w)`, "gi");
  for (const match of sentence.matchAll(pattern)) {
    if (!record.f) return true;
    const end = match.index + match[0].length;
    if (CLAUSE_OPENING.test(stripPacketLabel(sentence.slice(0, match.index)).body)) {
      if (SUBJECT_VERB.test(sentence.slice(end))) return true;
    } else if (match[0] === record.f) return true;
  }
  return false;
}

/**
 * Whether a sentence forbids an action of the revoked class on the revoked object (D9's `(class, polarity,
 * object)`): its object, the words after the negated verb up to the end of the clause, is within the revocation's,
 * and the revocation's is named in the sentence, a class's default object counting as none (D9 fix 3). "You can
 * merge PRs now" so revokes "never merge PRs", "never merge" and "push the fix to the PR, but don't merge it
 * yourself", and not "never merge PRs without a review"; "you can delete the branch now" does not revoke "never
 * delete the main branch".
 */
function forbids(sentence: string, record: Revocation): boolean {
  const verbs = Object.keys(ACTION_VERBS).filter((verb) => ACTION_VERBS[verb] === record.c);
  if (!verbs.length) return false;
  const negated = new RegExp(
    String.raw`\b(?:don'?t|do not|never|not)\s+(?:\w+\s+){0,2}(?:${verbs.join("|")})\w*\b([^,;:.!?]*)`,
    "i",
  );
  const match = negated.exec(sentence);
  if (!match) return false;
  const revoked = keyObject(record.o, record.c);
  const named = new Set(objectWords(sentence));
  const object = keyObject(objectWords(match[1]!), record.c);
  return object.every((word) => revoked.includes(word)) && revoked.every((word) => named.has(word));
}

/** An object as D9 keys it: without its class's default object. */
function keyObject(words: readonly string[], cls: string): string[] {
  const defaults = DEFAULT_OBJECTS[cls] ?? [];
  return words.filter((word) => !defaults.includes(word));
}

/** Whether a sentence may be about a switch's scope: it names no path, or a path within that scope. */
function sameScope(sentence: string, scope: string | undefined): boolean {
  if (!scope) return true;
  const paths = (sentence.match(PATH) ?? []).map((path) => path.toLowerCase());
  return !paths.length || paths.some((path) => path === scope || path.startsWith(`${scope}/`));
}

/** Whether a sentence names a switch's subject (D7 ties a switch to its slot's subject). */
function namesSubject(sentence: string, subject: readonly string[] | undefined): boolean {
  if (!subject?.length) return true;
  const words = new Set(objectWords(sentence));
  return subject.some((word) => words.has(word));
}

/** A sentence that states a rule (a prohibition or an "always"), which only a revocation supersedes (A4 §3.1). */
const RULE_SENTENCE = /\b(?:never|always|don'?t|do not|must|must not|should not|shouldn'?t|avoid)\b/i;

/** Whether a text states the rule keyed `key` (D9). */
function statesRule(text: string, key: string): boolean {
  return rulesIn(text).some((rule) => ruleKey(rule) === key);
}

/** Whether a text states a rule a revocation or an opposition has overturned. */
const revokes = (records: readonly Invalidation[], text: string) =>
  records.some(
    (record) =>
      (record.k === "revoke" && forbids(text, record)) || (record.k === "oppose" && statesRule(text, record.r)),
  );

/**
 * What a revocation leaves of a sentence: the rules joined to the revoked one (by `;` or `,`) about another action
 * ("never merge PRs yourself; never push to main" keeps "never push to main"). The other clauses qualified the
 * revoked rule and go with it ("never push to main; ask first").
 */
function otherRules(sentence: string, records: readonly Invalidation[]): string[] {
  return sentence
    .split(/[;,]\s+/)
    .map((part) => part.trim())
    .filter((part) => RULE_SENTENCE.test(part) && !revokes(records, part));
}

function invalidates(record: Invalidation, sentence: string): boolean {
  if (record.k === "revoke") return forbids(sentence, record);
  if (record.k === "oppose") return statesRule(sentence, record.r);
  if (RULE_SENTENCE.test(sentence)) return false;
  if (!mentions(sentence, record)) return false;
  if (!sameScope(sentence, record.s) || !namesSubject(sentence, record.w)) return false;
  // The sentence stating the change stays, unless it is a forget.
  return !invalidationsIn(sentence, 0).some((own) => own.k === "retract" && own.o === record.o && !own.r);
}

/**
 * A row's or gist's text without what an invalidation newer than `at` has made invalid; "" when nothing is left. A
 * text without a wall-clock time counts as older than every invalidation. Each clause is read on its own, as A4 §3.1
 * supersedes statements: a rule clause yields only to a revocation, which takes its whole sentence (the clauses after
 * a `;` qualify the rule: "never push to main; ask first"); a fact or episode clause yields to a retraction
 * (supersession, `stale_for`), even inside a pinned row.
 */
export function validText(text: string, at: unknown, records: readonly Invalidation[]): string {
  const raw = String(text ?? "").trim();
  const time = typeof at === "number" && Number.isFinite(at) ? at : 0;
  const newer = records.filter((record) => record.t > time);
  if (!raw || !newer.length) return raw;
  let dropped = false;
  const kept: string[] = [];
  for (const sentence of raw.split(SENTENCE_END)) {
    const clauses = sentence
      .split(CLAUSE_BREAK)
      .map((clause) => clause.trim())
      .filter(Boolean);
    const valid = (clause: string) => !newer.some((record) => invalidates(record, clause));
    const revoked = clauses.some((clause) => revokes(newer, clause));
    const left = revoked ? otherRules(sentence, newer).filter(valid) : clauses.filter(valid);
    if (revoked || left.length < clauses.length) dropped = true;
    // What is left must say something: never a bare list marker ("1.").
    const said = left.filter((part) => contentWords(part).length);
    if (said.length) kept.push(said.join("; "));
  }
  return dropped ? kept.join(" ") : raw;
}

/** A cue that asks about history (A4 §5.1 step 5; R3's markers), which keeps episodes carrying an older value. */
export function asksHistory(prompt: string): boolean {
  return /\b(?:before|used to|previously|was|why did we)\b/i.test(String(prompt ?? ""));
}
