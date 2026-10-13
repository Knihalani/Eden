/**
 * Validity (A4 §5.1 step 5): the clause-level log (`validity.jsonl`) that every delivery point reads text against.
 * Rows that hold keys go to history by them (`invalid_at`: D9's rules since P2.1, D7's slots since P3.3); this log is
 * for what holds no key: gists, episodes (D31's `stale_for`) and the clauses of other sessions' rows. Only D7's and
 * A4 §3.1's own forms invalidate, read narrowly, because a false invalidation silently drops a memory the user still
 * needs:
 * - a **slot's ended value** (D7, P3.3), logged by the store that encodes the statement (`recordSlotChanges`): each
 *   value a typed slot statement superseded, retracted or invalidated (`use A not B`), at the scope it was true at
 *   and below it, but for the descendants that hold their own value of the slot (D31). A clause carries it by one of
 *   its value's names, beside the slot's alias when the name is an everyday word or a version ("render the form" is
 *   no host); a clause giving another subject the value ("the cache is postgres") keeps it. The prompt's own reading
 *   below leaves such a value to the store, so it is not held at every scope;
 * - a **retraction** (A4 §3.1) of a value of no D7 slot: "we no longer use Redis", "we're not using Sentry anymore",
 *   "we dropped Sentry";
 * - a **switch** (D7) of a value of no D7 slot: "we migrated the queue from SQS to Kafka" (or switched, moved). The
 *   words before "from" tie it to a subject as far as text can: a scope path ("apps/web") and subject words ("the
 *   queue"); a sentence naming another scope, or lacking the subject, keeps the value. Without a slot, "use POST
 *   instead of GET" is a coding instruction, not a switch;
 * - a **revocation** (A4 §3.1, D9): "you can merge PRs yourself now", whose verb is one of A7 §5's action classes. It
 *   invalidates a rule that forbids an action of the same class on the same object (`forbids`);
 * - an **opposition** (A4 §3.1, L8; P2.1): a typed policy stated outright ("never squash") overturns what older text
 *   said of the opposite polarity on its key (D9's `(class, polarity, object)`): "always squash when merging". An
 *   intent ("don't squash yet"), a rule with a precondition ("always run the tests before you push") or one whose
 *   object lost a qualifier ("always merge PRs from dependabot") overturns nothing (`overturnedKeys`). A revocation
 *   is logged as an opposition too, of the prohibition it lifts, keyed by D9's classes, so it reaches every class
 *   ("you can open the PR now"). Each key's newest opposition is read; older ones add nothing;
 * - an **end** (D9, P2.3) of the rule keyed `r` (`ruleIdentity`): an intent released ("open it now") or done (its
 *   action succeeded), or a rule the user dropped ("that rule is gone"). It drops each clause stating that rule (only
 *   an intent, for an intent's end) with a bare qualifier beside it, whether or not it was narrowed;
 * - a **forget** (A6 §3, A4 §3.1's "forget that"): "forget ZebraCache", "forget that the auth provider is Clerk". It
 *   is a retraction (`r: "forget"`) of the value its sentence ends with, shaped as a retracted value is: "Forget the
 *   tests, just fix the build" sets nothing aside, "forget it" neither, and "don't forget to …" is none (D9 fix 2).
 *   Unlike the others, neither its own sentence (`withoutForgets`) nor a history cue keeps the value.
 *
 * Only typed text invalidates (A4 §3.0, A6 §2.1): the human Submit's prompt, without its pasted spans
 * (`<pasted_content>`, fenced code, `>` quotes, runs of 3 or more lines without sentence punctuation), and without
 * questions or conditionals, after the store's own secret redaction. A retracted or switched-from value of no slot is
 * one token that ends its clause, capitalized or identifier-shaped and not a path (D7's rule for a value outside a
 * slot's value class), so a common word ("array", "src") or the first word of a longer name ("Node" of "Node 16")
 * never is one. The same shape holds where the value is matched: a value shaped by its capitals alone
 * ("Make", "GET") is matched as typed, and where it opens a sentence only as the sentence's subject ("Make is …",
 * not "Make sure …"); a value with a digit, a dot or an underscore ("Auth0") is matched in any case.
 *
 * The hook appends each invalidation to `<root>/validity.jsonl` with its time. Every delivery point then drops each
 * clause of an older row or gist that still names the value as a whole token, and each sentence with a clause that
 * forbids the revoked action (its `;` clauses qualify the rule). The sentence stating the change stays, and so does a
 * rule clause a retraction names (only a revocation supersedes a rule). An episode carrying an invalidated value is
 * D31's `stale_for`: a cue that asks about history keeps it. A whole clause goes, so a still-valid part of it goes
 * too; a row that keys its slots goes to history only when every value it sets is gone.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_VERBS, defaultObjectNames } from "./memory-classes";
import { memoryNow } from "./memory-clock";
import { stripPacketLabel } from "./memory-provenance";
import {
  INTENT_TTL_MS,
  objectWords,
  overturnable,
  overturnedKeys,
  ruleIdentity,
  ruleRefs,
  rulesIn,
  withoutIntents,
  withoutRules,
} from "./memory-policy";
import {
  commonWord,
  inClass,
  namesSlot,
  slotLabel,
  slotsIn,
  slotsOfName,
  valueNames,
  type SlotId,
} from "./memory-slots";
import { objectAsserted } from "./semantic-store";
import { contentWords, FUNCTION_WORDS, STATUS_WORDS } from "./memory-transcript";

/**
 * A retraction or switch (`retract`) of value `o`, with its typed form `f` when its capitals alone shape it; a switch
 * also keeps the scope it names (`s`, a path), its subject words (`w`) and the value it switches to (`n`, as typed,
 * when that is value-shaped). A supersession keeps the scope of the row it superseded (`in`, since P3.2): it holds
 * for rows at that scope only, and for rows whose scope is unknown. A slot's value ended by key (`slot`, P3.3) holds
 * at `in` and below it, but for the scopes in `except` (and below them), which hold their own value of the slot
 * (D31); its `f` is the value as it was typed. A revocation (`revoke`) of action class `c`
 * on object words `o`. An opposition (`oppose`) of the rule keyed `r`. An end (`end`) of the rule `r`: of an
 * intent, or (`of: "rule"`) of any rule.
 */
export type Invalidation =
  | {
      k: "retract";
      o: string;
      t: number;
      f?: string;
      s?: string;
      w?: string[];
      n?: string;
      r?: "forget";
      in?: string;
      slot?: SlotId;
      except?: string[];
    }
  | { k: "revoke"; c: string; o: string[]; t: number }
  | { k: "oppose"; r: string; t: number }
  | { k: "end"; r: string; t: number; of: RuleEnd };

/** What an `end` ends: an intent (released or done), or a rule of any kind the user dropped. */
export type RuleEnd = "intent" | "rule";
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

/** A7 §5's verbs (`memory-classes.json`), as a revocation names them: the class is what it shares with a rule. */
const VERBS = Object.keys(ACTION_VERBS).join("|");
const CLASSES = new Set<string>(Object.values(ACTION_VERBS));
const REVOKE = new RegExp(String.raw`^you (?:can|may|are allowed to|are free to) (${VERBS})\b(.*?)\bnow\b`, "i");

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

/**
 * Whether a sentence states slots and a value is a name of a slot value: its retraction or switch is the store's to
 * log, by key and at its scope (`recordSlotChanges`), not this log's, which would hold it at every scope.
 */
function keyedValue(sentence: string, value: string): boolean {
  return slotsOfName(value).length > 0 && slotsIn(sentence).length > 0;
}

/** The invalidations a typed prompt states. */
export function invalidationsIn(prompt: string, t: number): Invalidation[] {
  const found: Invalidation[] = [];
  for (const sentence of statements(typedText(prompt))) {
    const forget = forgetIn(sentence, t);
    if (forget) found.push(forget);
    for (const pattern of RETRACT)
      for (const match of sentence.matchAll(pattern))
        if (valueShaped(match[1]!) && !keyedValue(sentence, match[1]!))
          found.push({ k: "retract", ...retracted(match[1]!), t });
    for (const match of sentence.matchAll(SWITCH)) {
      if (!valueShaped(match[2]!) || keyedValue(sentence, match[2]!)) continue;
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
  const overturned = sentences(typedText(prompt)).flatMap(overturnedKeys);
  for (const r of new Set(overturned)) found.push({ k: "oppose", r, t });
  return found;
}

/**
 * The rule keys a typed text overturns (A4 §3.1, L8; `overturnedKeys`): the rules it revokes, and the opposite of each
 * policy it states outright. A rule row whose every rule it overturns goes to history.
 */
export function counteredKeys(text: string): string[] {
  return invalidationsIn(text, 0).flatMap((record) => (record.k === "oppose" ? [record.r] : []));
}

/** Appends the ends of rules (by `ruleIdentity`) to the store's validity log (see the header). Fails open. */
export function recordRuleEnds(root: string, rules: readonly string[], of: RuleEnd, t = memoryNow()): void {
  if (!rules.length) return;
  try {
    mkdirSync(root, { recursive: true });
    const lines = [...new Set(rules)].map((r) => `${JSON.stringify({ k: "end", r, t, of })}\n`);
    appendFileSync(join(root, FILE), lines.join(""), { mode: 0o600 });
  } catch {}
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
  scope?: string,
): void {
  try {
    const subject = subjectWords(slot.subject);
    if (!subject.length) return;
    const place = scope === undefined ? {} : { in: scope };
    const record = { k: "retract", ...retracted(slot.value), t, w: subject, ...place, ...(src ? { src } : {}) };
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {}
}

/** A slot value a typed statement ended (P3.3): where, as typed, and the scopes below that keep their own value. */
export interface SlotChange {
  slot: SlotId;
  value: string;
  typed: string;
  scope?: string;
  except?: readonly string[];
}

/**
 * D31's `stale_for` by key (A4 §3.2): each slot value a typed statement superseded or invalidated, at the scope it
 * was true at (none where the place is unknown) and its descendants but those in `except`. Fails open.
 */
export function recordSlotChanges(root: string, changes: readonly SlotChange[], t = memoryNow()): void {
  if (!changes.length) return;
  try {
    const lines = changes.map(({ slot, value, typed, scope, except }) => {
      const record = {
        k: "retract",
        o: value,
        t,
        f: typed,
        slot,
        ...(scope === undefined ? {} : { in: scope }),
        ...(except?.length ? { except } : {}),
      };
      return `${JSON.stringify(record)}\n`;
    });
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, FILE), lines.join(""), { mode: 0o600 });
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
  return newestOppositions(text.split("\n").flatMap(parseInvalidation));
}

/**
 * Each key's newest opposition only: it overturns all text older than itself, so older oppositions of the key add
 * nothing, and the log's cost at every delivery point stays bounded by the keys ever opposed.
 */
function newestOppositions(records: readonly Invalidation[]): Invalidation[] {
  const newest = new Map<string, Invalidation>();
  for (const record of records)
    if (record.k === "oppose" && record.t >= (newest.get(record.r)?.t ?? -Infinity)) newest.set(record.r, record);
  return records.filter((record) => record.k !== "oppose" || newest.get(record.r) === record);
}

function parseInvalidation(line: string): Invalidation[] {
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
      const place = typeof record.in === "string" ? { in: record.in } : {};
      const keyed = typeof record.slot === "string" ? { slot: record.slot as SlotId } : {};
      const except = Array.isArray(record.except)
        ? { except: record.except.filter((at): at is string => typeof at === "string") }
        : {};
      return [
        {
          k: "retract",
          o: record.o,
          t,
          ...form,
          ...scope,
          ...subject,
          ...to,
          ...forget,
          ...place,
          ...keyed,
          ...except,
        },
      ];
    }
    if (record.k === "revoke" && typeof record.c === "string" && CLASSES.has(record.c) && Array.isArray(record.o))
      return [{ k: "revoke", c: record.c, o: record.o.filter((word): word is string => typeof word === "string"), t }];
    if (record.k === "oppose" && typeof record.r === "string") return [{ k: "oppose", r: record.r, t }];
    if (record.k === "end" && typeof record.r === "string" && (record.of === "intent" || record.of === "rule"))
      return [{ k: "end", r: record.r, t, of: record.of }];
    return [];
  } catch {
    return [];
  }
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
  const defaults = objectWords(defaultObjectNames(cls).join(" "));
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

/** Whether a text states a rule keyed `key` that an overturning reaches (D9, `overturnable`). */
function statesRule(text: string, key: string): boolean {
  return ruleKeysOf(text).includes(key);
}

/**
 * A text's readings, each made once per text: every delivery point reads each note against the log, and rereads it at
 * the next point. Bounded: the cache is emptied when full.
 */
const READINGS_KEPT = 4_096;
const RULE_KEYS = new Map<string, string[]>();
const INTENTLESS = new Map<string, string>();

function cached<T>(cache: Map<string, T>, text: string, read: (text: string) => T): T {
  let reading = cache.get(text);
  if (reading === undefined) {
    if (cache.size >= READINGS_KEPT) cache.clear();
    cache.set(text, (reading = read(text)));
  }
  return reading;
}

/** The keys of the rules a text states that an overturning reaches (`overturnable`). */
function ruleKeysOf(text: string): string[] {
  return cached(RULE_KEYS, text, (said) =>
    ruleRefs(rulesIn(said)).flatMap((rule) => (overturnable(rule) ? [ruleIdentity(rule)] : [])),
  );
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

/** Whether a scope is at or below `at`, and not at or below a scope of `except`. */
function within(scope: string, at: string, except: readonly string[] = []): boolean {
  const under = (top: string) => top === "" || scope === top || scope.startsWith(`${top}/`);
  return under(at) && !except.some(under);
}

/**
 * Whether a sentence carries a slot's ended value: one of its names as a whole word, and the slot named beside it
 * when the name is an everyday word or a version number ("render the form" is no host).
 */
function carriesSlotValue(sentence: string, slot: SlotId, value: string): boolean {
  return valueNames(slot, value).some((name) => {
    const pattern = new RegExp(`(?<![\\w@./+-])${escape(name)}(?![\\w@/+-]|\\.\\w)`, "i");
    if (!pattern.test(sentence)) return false;
    const plain = inClass(slot, value) && !commonWord(name) && !/^\d/.test(name);
    return plain || namesSlot(sentence, slot);
  });
}

/**
 * D31's `stale_for` by key: a fact or episode clause carrying a slot value a statement ended, at a scope the record
 * holds for (its row's, and the folders the clause names), older than the record; never a rule clause, a clause
 * giving another subject that value, nor the clause stating the change.
 */
function staleForSlot(record: Retraction & { slot: SlotId }, sentence: string, scope: string | undefined): boolean {
  if (scope !== undefined && record.in !== undefined && !within(scope, record.in, record.except)) return false;
  const clause = stripPacketLabel(sentence).body;
  // A clause naming its folder is that folder's ("In apps/web the database is postgres"), whatever row holds it.
  const paths = (clause.match(PATH) ?? []).map((path) => path.toLowerCase());
  if (record.in !== undefined && paths.length && !paths.some((path) => within(path, record.in!, record.except)))
    return false;
  if (RULE_SENTENCE.test(clause) || !carriesSlotValue(clause, record.slot, record.o)) return false;
  const stated = slotsIn(clause);
  if (stated.some((statement) => statement.slot === record.slot && statement.was.includes(record.o))) return false;
  return stated.some((statement) => statement.slot === record.slot) || !statesOtherSubject(clause, record.slot);
}

/**
 * Whether a clause that states nothing of a slot gives another subject a value ("The cache is postgres"): a value
 * there is that subject's, not the slot's.
 */
function statesOtherSubject(clause: string, slot: SlotId): boolean {
  try {
    const fact = objectAsserted(clause);
    return !!fact && fact.s !== slotLabel(slot).toLowerCase() && !namesSlot(fact.s, slot);
  } catch {
    return false;
  }
}

function invalidates(record: Invalidation, sentence: string, scope: string | undefined): boolean {
  if (record.k === "revoke") return forbids(sentence, record);
  if (record.k === "oppose") return statesRule(sentence, record.r);
  // An end is applied to the whole text first (`withoutEnded`).
  if (record.k === "end") return false;
  if (record.slot) return staleForSlot({ ...record, slot: record.slot }, sentence, scope);
  if (record.in !== undefined && scope !== undefined && record.in !== scope) return false;
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
 * (supersession, `stale_for`), even inside a pinned row. `scope` is the row's (A4 §2), when it has one: a supersession
 * at another scope leaves it as it is.
 */
export function validText(text: string, at: unknown, records: readonly Invalidation[], scope?: string): string {
  const time = typeof at === "number" && Number.isFinite(at) ? at : 0;
  const newer = records.filter((record) => record.t > time && record.k !== "end");
  const raw = withoutEnded(
    String(text ?? "").trim(),
    records.filter((record): record is RuleEndRecord => record.k === "end" && record.t > time),
  );
  if (!raw || !newer.length) return raw;
  let dropped = false;
  const kept: string[] = [];
  for (const sentence of raw.split(SENTENCE_END)) {
    const clauses = sentence
      .split(CLAUSE_BREAK)
      .map((clause) => clause.trim())
      .filter(Boolean);
    const valid = (clause: string) => !newer.some((record) => invalidates(record, clause, scope));
    const revoked = clauses.some((clause) => revokes(newer, clause));
    const left = revoked ? otherRules(sentence, newer).filter(valid) : clauses.filter(valid);
    if (revoked || left.length < clauses.length) dropped = true;
    // What is left must say something: never a bare list marker ("1.").
    const said = left.filter((part) => contentWords(part).length);
    if (said.length) kept.push(said.join("; "));
  }
  return dropped ? kept.join(" ") : raw;
}

type RuleEndRecord = Extract<Invalidation, { k: "end" }>;

/** A text without the rules an `end` newer than it ended (see the header); the text itself when none applies. */
function withoutEnded(text: string, ends: readonly RuleEndRecord[]): string {
  if (!ends.length || !text) return text;
  return withoutRules(text, (rule) =>
    ruleRefs([rule]).some((ref) =>
      ends.some((end) => end.r === ruleIdentity(ref) && (end.of === "rule" || rule.kind === "intent")),
    ),
  ).trim();
}

/**
 * A delivered text without its expired intents (D9, A4 §5.1 step 5's expired intent): 7 days after the text was said,
 * each clause stating an intent goes (`withoutIntents`). A row stating a policy beside one ("Never force-push, and
 * don't open the PR yet") has no `valid_until` of its own, so every delivery point reads its text through this. A text
 * without a wall-clock time counts as older than 7 days. Only delivery reads it: a forget reads the store's own text.
 */
export function withoutExpiredIntents(text: string, at: unknown): string {
  const time = typeof at === "number" && Number.isFinite(at) ? at : 0;
  const said = String(text ?? "");
  return time + INTENT_TTL_MS <= memoryNow() ? cached(INTENTLESS, said, withoutIntents) : said;
}

/**
 * What a rule row still says once every delivery point's validity is read (`withoutExpiredIntents`, `validText`), and
 * the rules that text states, by `ruleIdentity`.
 */
export function rulesInForce(
  row: { text: string; at?: unknown },
  invalid: readonly Invalidation[],
): { text: string; rules: Set<string> } {
  const text = validText(withoutExpiredIntents(row.text, row.at), row.at, invalid);
  return { text, rules: new Set(text ? ruleRefs(rulesIn(text)).map(ruleIdentity) : []) };
}

/** A cue that asks about history (A4 §5.1 step 5; R3's markers), which keeps episodes carrying an older value. */
export function asksHistory(prompt: string): boolean {
  return /\b(?:before|used to|previously|was|why did we)\b/i.test(String(prompt ?? ""));
}
