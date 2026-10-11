/**
 * D9's policy and intent extraction (A4 §3.1, A7 §5; R8 E3's fixes): a regex at write time over the user's own
 * words (A4 §3.0), read sentence by sentence and clause by clause, one rule per clause.
 *
 * - **A rule** is an imperative trigger (`don't`, `never`, `always`, `without asking`, `ask before`, `only … after`;
 *   fix 2's `hold off`, `no <verb>ing`, `leave … unmerged / as a draft / alone`, `wait before/for`, `without checking
 *   with me`) followed by a word of an action class (A7 §5's lexicon, D18's `stash`, fix 4's `protected-path`). The
 *   class is the one whose word comes first after the trigger, before any `when`/`if`/`unless`/`because` clause; a tie
 *   (`push --force`, `drop tables`) goes to the more specific class, in R8's order. Where nothing after the trigger
 *   names a class, a leading subordinate clause may ("before you merge, wait for my ok").
 * - **Not a rule** (fix 2): `don't forget to`, `never mind`, `don't worry / bother / hesitate`, a question (a tag such
 *   as ", ok?" aside), and a descriptive clause, whose trigger follows a subject other than "you" ("we always forget
 *   …", "the deploy always breaks", "the API never returns …"). "You never merge" and "I want you to never push" are
 *   rules.
 * - **Polarity:** `always` is positive; every other trigger negative. `never` and `always` are explicit: a policy so
 *   said is a pin (D9).
 * - **Intent:** a clause with a temporal qualifier (`yet`, `for now`, `until`, `this time`, `in this PR`, `today`,
 *   `this week`, `before`/`after`) states an intent; a clause that is nothing but one ("not yet, don't commit")
 *   qualifies the clauses beside it. Fix 1: `before`/`after` qualify only when a time ("before friday") or an event
 *   follows ("after this commit", "after launch"); a precondition ("before you …", "before merging", "after CI
 *   passes", "before commit") keeps a standing policy, and a trigger's own `before`/`after` ("ask before") is none.
 * - **Object:** the noun phrase after the class word (after a leading preposition: "push to main"), singular,
 *   synonyms named one way (`pr`, `main`, `prod`, `db`, `package`), its words joined by `-`. Fix 3: `*` when there is
 *   none ("don't merge it yourself") or it is the class's default object alone (integrate and review: `pr`;
 *   push-upstream, history-rewrite and branch: `branch`; dependency: `package`; deploy: `prod`). Named with other
 *   words, the default object is dropped ("the main branch" is `main`). A protected path is its own object (`.env`,
 *   `infra`, `pnpm-lock.yaml`).
 * - **Overturning** (A4 §3.1, L8): a rule is stated *outright* when its class word is its own verb (not inside "run
 *   the tests before you push") and nothing narrows it (no precondition, no `when`/`if`/`without`/`unless` clause, no
 *   qualifying phrase cut from its object: "merge PRs from dependabot"). Only a policy stated outright overturns the
 *   opposite rule on its key, and it overturns a prohibition only one stated outright: "never squash" overturns
 *   "always squash when merging", while "you can merge now" leaves "never merge PRs without a review" standing.
 */
import { stripPastes } from "./memory-authority";
import { CLASS_WORDS, defaultObject, type ActionClass } from "./memory-classes";
import { FUNCTION_WORDS } from "./memory-transcript";

export type { ActionClass } from "./memory-classes";

export type Polarity = "pos" | "neg";
export type Qualifier =
  "yet" | "for-now" | "until" | "before" | "after" | "this-time" | "in-this-pr" | "today" | "this-week";

export interface Rule {
  kind: "policy" | "intent";
  class: ActionClass;
  polarity: Polarity;
  /** The normalized object, `*` for none (fix 3). */
  object: string;
  /** What makes it an intent. */
  qualifier?: Qualifier;
  /** Said with `never` or `always`: a policy so said is a pin (D9). */
  explicit: boolean;
  /** It states its action outright, unnarrowed (see the header). */
  outright: boolean;
  /** Its action, in a class whose words name distinct actions (`squash`, `force-push`; see `actionOf`). */
  action?: string;
}

/**
 * A rule as a row keeps it: its key, the qualifier that makes it an intent, `c` when it is narrowed, and `v`, its
 * action in a class whose words name distinct actions.
 */
export interface RuleRef {
  k: string;
  q?: Qualifier;
  c?: true;
  v?: string;
}

/** D9: an intent expires after 7 days, if its action has not completed first. */
export const INTENT_TTL_MS = 7 * 86_400_000;

interface Trigger {
  pattern: RegExp;
  polarity: Polarity;
  explicit?: boolean;
  /** The rule's words are on both sides of the trigger ("push without asking"). */
  around?: boolean;
  /** The class the trigger itself names. */
  names?: (said: string) => ActionClass | undefined;
}

const TRIGGERS: readonly Trigger[] = [
  { pattern: /\bnever\b(?!\s+(?:mind|forget)\b)/gi, polarity: "neg", explicit: true },
  { pattern: /\balways\b/gi, polarity: "pos", explicit: true },
  { pattern: /\b(?:don['’]?t|do not)\b(?!\s+(?:forget|worry|bother|hesitate|mind)\b)/gi, polarity: "neg" },
  { pattern: /\bwithout (?:asking|checking with me)\b/gi, polarity: "neg", around: true },
  { pattern: /\bask (?:me )?before\b/gi, polarity: "neg" },
  { pattern: /\bonly\b(?=(?:\s+[\w'-]+){1,3}?\s+(?:after|once)\b)/gi, polarity: "neg" },
  { pattern: /\bhold off(?: on)?\b/gi, polarity: "neg" },
  { pattern: /\bno\b(?=\s+\w+ing\b)/gi, polarity: "neg" },
  {
    pattern: /\bleave\b(?=[^,;]{0,40}?\b(?:unmerged|as an? draft|alone)\b)/gi,
    polarity: "neg",
    names: (said) => (/\bunmerged\b/i.test(said) ? "integrate" : /\bdraft\b/i.test(said) ? "review" : undefined),
  },
  { pattern: /\bwait (?:before|for)\b/gi, polarity: "neg" },
];

/** Fix 2's wording that is no rule: a reminder ("don't forget to …") and "never mind". */
const NOT_A_RULE = /\b(?:don['’]?t|do not|never)\s+forget\b|\bnever\s+mind\b/gi;

/** A text without fix 2's reminders and "never mind", where the legacy store's rule words are read. */
export function withoutExcludedWording(text: string): string {
  return String(text ?? "").replace(NOT_A_RULE, " ");
}

/** A trigger's own `before` or `after` ("ask before", "only merge after"), which is no qualifier (fix 1). */
const OWNED_QUALIFIER = /\b(?:ask (?:me )?|wait )before\b|\bonly\b(?:\s+[\w'-]+){1,3}?\s+after\b/gi;
const QUALIFIER = /\b(?:yet|for now|until|before|after|this time|in this (?:pr|pull request)|today|this week)\b/gi;
const QUALIFIER_NAMES: Record<string, Qualifier> = {
  yet: "yet",
  "for now": "for-now",
  until: "until",
  before: "before",
  after: "after",
  "this time": "this-time",
  today: "today",
  "this week": "this-week",
};

const QUESTION = new RegExp(
  String.raw`^(?:(?:why|what|how|which|who|where|when)\s+(?:does|do|did|is|are|was|were|can|could|would|should|will|` +
    String.raw`has|have)\b|(?:does|do|did|is|are|was|were|can|could|would|should|will|has|have)\s+` +
    String.raw`(?:it|you|i|we|they|he|she|there|the|this|that|these|those)\b)`,
  "i",
);
/** A tag that asks only for assent ("…, ok?"): the sentence before it still instructs. */
const TAG_QUESTION = /,\s*(?:ok|okay|right|yeah|alright|got it|understood|clear)\s*\?+\s*$/i;
/** Words that open a sentence or clause without being its subject. */
const DISCOURSE =
  /^(?:(?:please|pls|plz|just|also|and|so|but|then|ok|okay|now|again|seriously|btw|fyi|remember|note|hey|from now on|going forward|rule|reminder)\b[\s,:!.-]*)+/i;
/** A subject other than "you": a clause opening with one describes, it does not instruct (fix 2). */
const SUBJECT =
  /^(?:i|we|it|they|he|she|this|that|these|those|there|the|a|an|my|our|their|his|her|its|everyone|everybody|someone|somebody|nobody|everything|something|nothing)\b/i;
/** A subject right before the trigger ("make sure the API never …", "… so it never …"). */
const SUBJECT_BEFORE =
  /(?:^|\s)(?:(?:the|a|an|this|that|these|those|our|my|their|its|his|her)\s+[\w-]+|it|we|i|they|he|she)$/i;
/** "I want you to never …": "you" is the trigger's subject. */
const YOU_BEFORE = /\byou(?:\s+to)?$/i;
const SUBORDINATE = /^(?:before|after|until|once|when|whenever|unless|if|while)\b/i;
/** A clause inside the rule that is not its action ("never returns a 500 when the branch is missing"). */
const INNER_CLAUSE = /\b(?:when|whenever|if|unless|because|while|since|so that)\b/i;
/** Words that narrow a rule to some cases ("never merge PRs without a review"). */
const NARROWING = /\b(?:when|whenever|if|unless|because|while|since|without|except|once)\b/i;

/** A sentence ends at `.`, `!`, `?` or `;` before a space, or at a line break. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** A sentence's clauses, split at commas; a leading subordinate clause stays with the clause it qualifies. */
function clausesOf(sentence: string): string[] {
  const parts = sentence.split(/,\s*/);
  const clauses: string[] = [];
  for (let at = 0; at < parts.length; at++) {
    const part = parts[at]!;
    if (SUBORDINATE.test(part.trim()) && at + 1 < parts.length) parts[at + 1] = `${part}, ${parts[at + 1]}`;
    else clauses.push(part);
  }
  return clauses.filter((clause) => clause.trim());
}

function isQuestion(sentence: string): boolean {
  const said = sentence.trim().replace(TAG_QUESTION, "");
  return said.endsWith("?") || QUESTION.test(said.replace(DISCOURSE, ""));
}

/** Whether the words before a trigger leave it an instruction: no subject but "you" governs it. */
function instructs(lead: string): boolean {
  const own = lead
    .split(/[,;:]|\b(?:and|but|so|then|or)\b/i)
    .at(-1)!
    .trim();
  if (YOU_BEFORE.test(own)) return true;
  return !SUBJECT.test(own.replace(DISCOURSE, "")) && !SUBJECT_BEFORE.test(own);
}

interface Hit {
  trigger: Trigger;
  start: number;
  end: number;
}

/** A clause's triggers in order; of two that touch ("always ask before"), the later governs. */
function triggersIn(clause: string): Hit[] {
  const hits = TRIGGERS.flatMap((trigger) =>
    [...clause.matchAll(trigger.pattern)].map((m) => ({ trigger, start: m.index, end: m.index + m[0].length })),
  ).sort((a, b) => a.start - b.start);
  return hits.filter((hit, at) => {
    const next = hits[at + 1];
    return !next || next.start - hit.end > 1;
  });
}

/** The class whose word comes first in a text; a tie goes to the earlier class in R8's order (`CLASS_WORDS`). */
function classIn(text: string): { cls: ActionClass; match: RegExpExecArray } | undefined {
  let found: { cls: ActionClass; match: RegExpExecArray } | undefined;
  for (const [cls, pattern] of CLASS_WORDS) {
    const match = pattern.exec(text);
    if (match && (!found || match.index < found.match.index)) found = { cls, match };
  }
  return found;
}

/** Words that name no object: D9 normalizes "don't merge it yourself" to the object `*`. */
const NO_OBJECT = new Set(["yourself", "yourselves", "again", "too", "anytime", "freely", "whenever", "want", "like"]);

/**
 * An object word in one form, whatever its plural: "PRs" and "PR", "branches" and "branch", "caches" and "cache",
 * "prizes" and "prize" each share one. The form need not be a word ("cach"), only the same for both.
 */
function singular(word: string): string {
  const stem = word.length >= 3 && /[^siu]s$/.test(word) ? word.slice(0, -1) : word;
  return stem.length >= 4 && /(?:ch|sh|ss|x|z)e$/.test(stem) ? stem.slice(0, -1) : stem;
}

/**
 * The object words of a text (D9): lowercased words of letters and digits, a dotted version kept whole ("v1.2"),
 * without function words, single characters or words that name no object, singular.
 */
export function objectWords(text: string): string[] {
  return (
    String(text ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+(?:\.\d+)*/g) ?? []
  )
    .filter((word) => word.length > 1 && !FUNCTION_WORDS.has(word) && !NO_OBJECT.has(word))
    .map(singular);
}

/** Synonyms named one way, before objects are read (fix 3), and in a summary (`memory-value-tokens.ts`). */
export function oneNamePerObject(text: string): string {
  return text
    .replace(/\bpull requests?\b/gi, "pr")
    .replace(/\b(?:dependenc(?:y|ies)|deps?|librar(?:y|ies)|packages?)\b/gi, "package")
    .replace(/\bmaster\b/gi, "main")
    .replace(/\bproduction\b/gi, "prod")
    .replace(/\bdatabases?\b/gi, "db");
}

/**
 * Where an object's noun phrase ends: a qualifier, a conjunction, a relative pronoun, a word that names no object,
 * punctuation (a period only before a space: `.env` and `v1.2` are words).
 */
const PHRASE_END = new RegExp(
  String.raw`\b(?:yet|until|before|after|for now|this time|in this pr|today|this week|and|but|or|so|then|when|` +
    String.raw`whenever|while|unless|if|once|because|since|without|that|which|who|whose|yourself|yourselves|ever|` +
    String.raw`first|on your own|from your side|by hand)\b|[,;:!?()]|\.(?=\s|$)`,
  "i",
);
const LEADING_WORDS =
  /^(?:\s*\b(?:the|a|an|my|our|your|their|any|all|some|this|that|these|those|it|them|anything|everything|something|just|really|also|anymore|new|\w+ly)\b)+/i;
const LEADING_PREPOSITION = /^\s*(?:to|into|onto|on|under|in|from|against|off|at)\b/i;
const INNER_PREPOSITION = /\s(?:of|for|with|in|on|to|at|by|from|under|into|via|using|across)\s.*$/i;

/** A command's flags ("rm -rf node_modules"), which are no object. */
const FLAGS = /(?:^|\s)--?[a-z][\w-]*/gi;

/** A noun phrase: its words, and whether a qualifying prepositional phrase was cut from it. */
interface Phrase {
  words: string;
  cut: boolean;
}

/** The noun phrase a text opens with, after its articles and adverbs, or after one leading preposition. */
function nounPhrase(text: string, again = true): Phrase {
  const end = PHRASE_END.exec(text);
  const phrase = ` ${(end ? text.slice(0, end.index) : text).replace(LEADING_WORDS, "").trim()} `;
  if (LEADING_PREPOSITION.test(phrase))
    return again ? nounPhrase(phrase.replace(LEADING_PREPOSITION, ""), false) : { words: "", cut: false };
  const words = phrase.replace(INNER_PREPOSITION, "").replace(FLAGS, " ").trim();
  return { words, cut: words !== phrase.replace(FLAGS, " ").trim() };
}

/** A protected path's own name: `.env`, `infra`, a lockfile's name. */
function pathName(word: string): string {
  const name = word.toLowerCase().replace(/\/$/, "");
  return /^lockfiles?$/.test(name) ? "lockfile" : name;
}

/**
 * Object words as a key holds them (fix 3): `*` for none or for the class's default object alone ("PRs"); a default
 * object named with other words keys by them ("the main branch" is `main`, "the feature branch" `feature`).
 */
function keyedObject(cls: string, words: readonly string[]): string {
  const named = words.slice(0, 3);
  const kept = named.length > 1 && named.at(-1) === defaultObject(cls) ? named.slice(0, -1) : named;
  return !kept.length || (kept.length === 1 && kept[0] === defaultObject(cls)) ? "*" : kept.join("-");
}

/** A protected path (fix 4) a text names: `.env`, `infra/`, a lockfile. */
const PROTECTED_PATH = CLASS_WORDS.find(([cls]) => cls === "protected-path")![1];

/**
 * A rule's object: a protected path or a branch name its class word names, the object its class word captured
 * (`drop the test table`), or the noun phrase after it, which is a protected path when it names one ("never commit .env
 * files" is `.env`). `cut` tells whether a qualifying phrase was cut from it ("PRs from dependabot").
 */
function objectOf(cls: ActionClass, rest: string, word?: RegExpExecArray): { object: string; cut: boolean } {
  if (word && cls === "protected-path") return { object: pathName(word[0].trim()), cut: false };
  if (word && cls === "branch" && /^(?:main|master)$/i.test(word[0])) return { object: "main", cut: false };
  const phrase = nounPhrase(word?.[1] ?? rest);
  const path = PROTECTED_PATH.exec(phrase.words);
  if (path) return { object: pathName(path[0].trim()), cut: phrase.cut };
  return { object: keyedObject(cls, objectWords(oneNamePerObject(phrase.words))), cut: phrase.cut };
}

/** Words before a rule's class word that leave it the rule's own verb ("never git push", "don't open the PR"). */
const VERB_LEAD =
  /^(?:\s*\b(?:please|just|ever|again|really|actually|directly|yourself|git|gh|go|open|create|make|file|raise|touch|edit|modify|change|a|an|the|any|my|our|your|new)\b)*\s*$/i;

function qualifierOf(said: string): Qualifier {
  const name = said.toLowerCase();
  return name.startsWith("in this") ? "in-this-pr" : QUALIFIER_NAMES[name]!;
}

const TIME =
  /^\s*(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the weekend|next \w+|this \w+|end of|\d)/i;
const EVENT = /^\s*(?:(?:the|this|that|our|my|your|a|an|next)\s+\w+|launch|lunch|standup|release|the demo|qa)\b/i;
const VERB_MARK =
  /\b(?:is|are|was|were|be|been|being|has|have|had|gets|got|goes|went|does|did|go|get|run|pass|fail|finish|land|ship|merge|end|start|come|sign|say|look|turn|clear|wrap)\b/i;

const DETERMINER = /^(?:the|this|that|our|my|your|a|an|next)$/i;

/**
 * Fix 1: whether `before`/`after` is followed by a time or an event ("before friday", "after this commit", "after
 * launch", "before the design review"), which makes an intent, rather than a precondition ("before you push", "before
 * merging", "after CI passes", "before commit"), which keeps a standing policy. An event is a noun phrase with no verb
 * after its noun: a verb ("is", "go", or an `-s`/`-ed` word: "the build finishes", "the checks go green") makes it a
 * precondition.
 */
function eventFollows(rest: string): boolean {
  const phrase = rest.split(/[,;.!?]/)[0]!.trim();
  if (TIME.test(phrase)) return true;
  if (!EVENT.test(phrase)) return false;
  const words = phrase.split(/\s+/);
  const after = words.slice(DETERMINER.test(words[0]!) ? 2 : 1);
  return !after.some((word) => VERB_MARK.test(word) || /^[a-z]+(?:s|ed)$/i.test(word));
}

/** The temporal qualifier a clause states, if any (D9, fix 1). */
function qualifierIn(clause: string): Qualifier | undefined {
  const owned = new Set(
    [...clause.matchAll(OWNED_QUALIFIER)].map((m) => m.index + m[0].length - (/before$/i.test(m[0]) ? 6 : 5)),
  );
  for (const match of clause.matchAll(QUALIFIER)) {
    const said = match[0].toLowerCase();
    if (said === "before" || said === "after") {
      if (owned.has(match.index) || !eventFollows(clause.slice(match.index + said.length))) continue;
    }
    return qualifierOf(said);
  }
  return undefined;
}

/** A clause that is nothing but a qualifier ("not yet"): it qualifies the clauses beside it. */
function bareQualifier(clause: string): Qualifier | undefined {
  const qualifier = qualifierIn(clause);
  const rest = clause.replace(QUALIFIER, " ").replace(DISCOURSE, "");
  return qualifier && !/\w/.test(rest.replace(/\b(?:not|no|ok|okay)\b/gi, "")) ? qualifier : undefined;
}

/**
 * History-rewrite's words name distinct actions (squash, rebase, amend, force-push). D9 keys its rules by class, but
 * one action's rule is not another's opposite, nor the same delivery: "never force-push" neither overturns "always
 * squash when merging" nor stands for it. Every other class's words are synonyms of one action (delete, remove, rm,
 * clean up; deploy, release, publish), which fix 3 keeps one rule.
 */
function actionOf(cls: ActionClass, word: string): string | undefined {
  if (cls !== "history-rewrite") return undefined;
  const said = word.toLowerCase();
  return /force/.test(said) ? "force-push" : said.match(/[a-z]+/)![0].replace(/(?:ing|ed|es|e|s)$/, "");
}

/** What a trigger that names its class says after its object ("leave it unmerged"). */
const NAMING_TAIL = /\b(?:unmerged|as an? draft|alone)\b.*$/i;

/** The rule one trigger states in its clause, if its words name an action class. */
function ruleAt(clause: string, hit: Hit, qualifier: Qualifier | undefined): Rule | undefined {
  const lead = clause.slice(0, hit.start);
  if (!instructs(lead)) return undefined;
  const after = clause.slice(hit.end);
  const named = hit.trigger.names?.(after);
  let cls: ActionClass;
  let object: { object: string; cut: boolean };
  let ownVerb = true;
  let action: string | undefined;
  if (named) {
    cls = named;
    object = objectOf(named, after.replace(NAMING_TAIL, ""));
  } else {
    const window = hit.trigger.around ? `${lead} ${after}` : after;
    const inner = INNER_CLAUSE.exec(window);
    const found = classIn(inner ? window.slice(0, inner.index) : window);
    const fromLead = !found && SUBORDINATE.test(lead.trim()) ? classIn(lead) : undefined;
    const used = found ?? fromLead;
    if (!used) return undefined;
    cls = used.cls;
    object = objectOf(cls, used.match.input.slice(used.match.index + used.match[0].length), used.match);
    ownVerb = !!found && VERB_LEAD.test(window.slice(0, found.match.index)) && !inner;
    action = actionOf(cls, used.match[0]);
  }
  const timed = qualifier === "before" || qualifier === "after";
  const precondition = (!timed && /\b(?:before|after)\b/i.test(clause)) || SUBORDINATE.test(lead.trim());
  const narrowed = NARROWING.test(after) || hit.trigger.around || precondition || object.cut;
  return {
    kind: qualifier ? "intent" : "policy",
    class: cls,
    polarity: hit.trigger.polarity,
    object: object.object,
    ...(qualifier ? { qualifier } : {}),
    explicit: hit.trigger.explicit === true,
    outright: ownVerb && !narrowed,
    ...(action ? { action } : {}),
  };
}

/**
 * The rules a text the user typed states, in order (see the header). The text must already be the user's own words:
 * `extractRules` strips pasted spans first.
 */
export function rulesIn(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const sentence of sentencesOf(String(text ?? ""))) {
    if (isQuestion(sentence)) continue;
    for (const { rule } of readClauses(sentence))
      if (rule && !rules.some((known) => ruleKey(known) === ruleKey(rule) && known.kind === rule.kind))
        rules.push(rule);
  }
  return rules;
}

/** A clause as `rulesIn` reads it: the rule it states, if any, and whether it is nothing but a qualifier. */
interface ClauseReading {
  clause: string;
  rule?: Rule;
  bare: boolean;
}

/** A sentence's clauses, each with the rule its first trigger that names a class states. */
function readClauses(sentence: string): ClauseReading[] {
  const clauses = clausesOf(sentence.replace(TAG_QUESTION, ""));
  const bare = clauses.map(bareQualifier);
  return clauses.map((clause, at) => {
    const qualifier = qualifierIn(clause) ?? bare[at - 1] ?? bare[at + 1];
    for (const hit of triggersIn(clause)) {
      const rule = ruleAt(clause, hit, qualifier);
      if (rule) return { clause, rule, bare: false };
    }
    return { clause, bare: !!bare[at] };
  });
}

/**
 * A text without its intents (D9: an intent expires after 7 days): each clause that states one goes, with a bare
 * qualifier beside it ("not yet, don't commit"); the other clauses stay ("Never force-push, and don't open the PR yet"
 * keeps "Never force-push."). A text stating no intent is returned as it is.
 */
export function withoutIntents(text: string): string {
  let dropped = false;
  const kept = sentencesOf(String(text ?? "")).flatMap((sentence) => {
    if (isQuestion(sentence)) return [sentence];
    const readings = readClauses(sentence);
    const intent = (at: number) => readings[at]?.rule?.kind === "intent";
    const left = readings.filter(({ bare }, at) => !intent(at) && !(bare && (intent(at - 1) || intent(at + 1))));
    if (left.length === readings.length) return [sentence];
    dropped = true;
    if (!left.length) return [];
    const joined = left
      .map(({ clause }) => clause.trim())
      .join(", ")
      .replace(/^(?:and|but|so|then|or)\s+/i, "");
    return [/[.!?;]$/.test(joined) ? joined : `${joined}${/[.!?;]$/.test(sentence) ? sentence.at(-1) : ""}`];
  });
  return dropped ? kept.join(" ") : text;
}

/** The rules of a whole utterance: pasted spans, fenced code and quotes stripped first (D12, A4 §3.0). */
export function extractRules(text: string): Rule[] {
  return rulesIn(stripPastes(String(text ?? "")));
}

/** A rule's key, `class|polarity|object` (D9). */
export function ruleKey(rule: Pick<Rule, "class" | "polarity" | "object">): string {
  return `${rule.class}|${rule.polarity}|${rule.object}`;
}

/** The rules a row keeps: each rule once, an intent with its qualifier. */
export function ruleRefs(rules: readonly Rule[]): RuleRef[] {
  const refs: RuleRef[] = [];
  for (const rule of rules) {
    const ref: RuleRef = {
      k: ruleKey(rule),
      ...(rule.qualifier ? { q: rule.qualifier } : {}),
      ...(rule.outright ? {} : { c: true as const }),
      ...(rule.action ? { v: rule.action } : {}),
    };
    if (!refs.some((known) => ruleIdentity(known) === ruleIdentity(ref))) refs.push(ref);
  }
  return refs;
}

/** What tells one rule from another: its key, and its action where the class's words name distinct ones. */
export function ruleIdentity(rule: Pick<RuleRef, "k" | "v">): string {
  return rule.v ? `${rule.k}|${rule.v}` : rule.k;
}

/** The key with the other polarity: a rule it states supersedes one with this key (A4 §3.1, L8). */
export function oppositeKey(key: string): string {
  const [cls, polarity, object] = key.split("|");
  return `${cls}|${polarity === "neg" ? "pos" : "neg"}|${object}`;
}

/**
 * The rules a typed sentence overturns (A4 §3.1, L8), by `ruleIdentity`: the opposite of each policy it states
 * outright, and, for a revocation ("you can merge PRs yourself now", "you can open the PR now"), the prohibition of
 * what it permits, read by this module's own classes.
 */
export function overturnedKeys(sentence: string): string[] {
  const permitted = /^you (?:can|may|are allowed to|are free to) (.+?)\s+now\b/i.exec(sentence.trim());
  if (permitted) return ruleRefs(rulesIn(`don't ${permitted[1]}`)).map(ruleIdentity);
  return rulesIn(sentence).flatMap((rule) =>
    rule.kind === "policy" && rule.outright ? [ruleIdentity({ k: oppositeKey(ruleKey(rule)), v: rule.action })] : [],
  );
}

/** Whether a stated rule yields to an overturning of its key: any positive rule, a prohibition only stated outright. */
export function overturnable(rule: RuleRef): boolean {
  return rule.k.includes("|pos|") || !rule.c;
}
