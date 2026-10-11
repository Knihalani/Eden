/**
 * D9's policy and intent extraction (A4 §3.1, A7 §5; R8 E3's fixes): a regex at write time over the user's own
 * words (A4 §3.0), read sentence by sentence and clause by clause, one rule per clause.
 *
 * - **A rule** is an imperative trigger (`don't`, `never`, `always`, `without asking`, `ask before`, `only … after`;
 *   fix 2's `hold off`, `no <verb>ing`, `leave … unmerged / as a draft / alone`, `wait before/for`, `without checking
 *   with me`) followed by a word of an action class (A7 §5's lexicon, D18's `stash`, fix 4's `protected-path`). The
 *   class is the one whose word comes first after the trigger; a tie (`push --force`, `drop tables`) goes to the more
 *   specific class, in R8's order. Where nothing after the trigger names a class, a leading subordinate clause may
 *   ("before you merge, wait for my ok").
 * - **Not a rule** (fix 2): `don't forget to`, `never mind`, a question, and a descriptive clause, whose trigger
 *   follows a subject other than "you" ("we always forget …", "the deploy always breaks"). "You never merge" is a
 *   rule.
 * - **Polarity:** `always` is positive; every other trigger negative. `never` and `always` are explicit: a policy so
 *   said is a pin (D9).
 * - **Intent:** a sentence with a temporal qualifier (`yet`, `for now`, `until`, `this time`, `in this PR`, `today`,
 *   `this week`, `before`/`after`) states intents. Fix 1: `before`/`after` qualify only when a time or event follows
 *   ("before friday", "after this commit"); a precondition clause ("before you …", "before merging", "after CI is
 *   green") keeps a standing policy, and a trigger's own `before`/`after` ("ask before") is no qualifier.
 * - **Object:** the noun phrase after the class word (after a leading preposition: "push to main"), singular,
 *   synonyms named one way (`pr`, `main`, `prod`, `db`, `package`), its words joined by `-`. Fix 3: `*` when there is
 *   none ("don't merge it yourself") or it is the class's default object alone (integrate and review: `pr`;
 *   push-upstream, history-rewrite and branch: `branch`; dependency: `package`; deploy: `prod`). Named with other
 *   words, the default object is dropped ("the main branch" is `main`). A protected path is its own object (`.env`,
 *   `infra`, `pnpm-lock.yaml`).
 */
import { stripPastes } from "./memory-authority";
import { invalidationsIn, objectWords } from "./memory-validity";

export type ActionClass =
  | "integrate"
  | "review"
  | "complete"
  | "commit"
  | "push-upstream"
  | "branch"
  | "history-rewrite"
  | "stash"
  | "deploy"
  | "delete"
  | "dependency"
  | "destructive-db"
  | "generated"
  | "billing"
  | "protected-path";
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
}

/** A rule as a row keeps it: its key, and the qualifier that makes it an intent. */
export interface RuleRef {
  k: string;
  q?: Qualifier;
}

/** D9: an intent expires after 7 days, if its action has not completed first. */
export const INTENT_TTL_MS = 7 * 86_400_000;

/**
 * A7 §5's action classes and their words, in R8's order of specificity, which breaks a tie between two classes whose
 * words start at one place. A class word that names its object (`drop tables`) captures it as `o`.
 */
const CLASS_WORDS: readonly (readonly [ActionClass, RegExp])[] = [
  ["destructive-db", /\b(?:drop|truncate|reset|wipe)\b[^,;]*?\b(?<o>db|database|table|schema)s?\b|\bmigrate reset\b/i],
  ["history-rewrite", /\b(?:squash\w*|rebas\w*|amend\w*|force[- ]?push\w*)\b|\bpush(?:es|ed|ing)?\s+(?:--force|-f)\b/i],
  ["stash", /\bstash\w*\b/i],
  ["generated", /\bdist\/|\.gen\.ts\b|\bgenerated\b/i],
  ["billing", /\b(?:billing|invoic\w*|payments?|stripe)\b/i],
  [
    "dependency",
    /\b(?:add(?:s|ed|ing)?\s+(?:a\s+|any\s+|new\s+)?(?:deps?|dependenc(?:y|ies)|packages?|librar(?:y|ies))|install\w*|npm i|pnpm add|bump\w*|upgrad\w*)\b/i,
  ],
  ["deploy", /\b(?:deploy\w*|releas\w*|prod|production|publish\w*|roll(?:ing)? out)\b/i],
  ["delete", /\b(?:delet\w*|remov\w*|rm|clean up|prun\w*|drop(?:s|ped|ping)?)\b/i],
  ["push-upstream", /\b(?:push(?:es|ed|ing)?|upload the branch)\b/i],
  [
    "integrate",
    /\b(?:merg(?:e|es|ed|ing)|land(?:s|ed|ing)?(?!\s+page)|ship(?:s|ped|ping)?|get it in|close out|finish up|wrap up)\b/i,
  ],
  ["review", /\b(?:prs?|pull requests?|review(?:s|ed|ing)?|put up)\b/i],
  ["commit", /\b(?:commit(?:s|ted|ting)?|sync)\b/i],
  ["branch", /\b(?:branch(?:es)?|main|master|checkout)\b/i],
  ["complete", /\b(?:done|finished|good to go|ready|all set)\b/i],
  [
    "protected-path",
    /(?<![\w/])\.env\b|\binfra\/|\b(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|cargo\.lock|poetry\.lock|gemfile\.lock|composer\.lock|lockfiles?)\b/i,
  ],
];

/** D9 fix 3: what a class acts on when the rule names nothing else. */
const DEFAULT_OBJECT: Partial<Record<ActionClass, string>> = {
  integrate: "pr",
  review: "pr",
  "push-upstream": "branch",
  "history-rewrite": "branch",
  branch: "branch",
  dependency: "package",
  deploy: "prod",
};

/** The default object of a class, if it has one. */
export function defaultObject(cls: string): string | undefined {
  return DEFAULT_OBJECT[cls as ActionClass];
}

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
  { pattern: /\b(?:don['’]?t|do not)\b(?!\s+forget\b)/gi, polarity: "neg" },
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

/** A trigger's own `before` or `after`, which is no qualifier (fix 1). */
const OWNED_QUALIFIER = /\b(?:ask (?:me )?|wait )(?<q>before)\b|\bonly\b(?:\s+[\w'-]+){1,3}?\s+(?<q2>after)\b/dgi;
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
/** Words that open a sentence or clause without being its subject. */
const DISCOURSE =
  /^(?:(?:please|pls|plz|just|also|and|so|but|then|ok|okay|now|again|seriously|btw|fyi|remember|note|hey|from now on|going forward|rule|reminder)\b[\s,:!.-]*)+/i;
/** A subject other than "you": a clause opening with one describes, it does not instruct (fix 2). */
const SUBJECT =
  /^(?:i|we|it|they|he|she|this|that|these|those|there|the|a|an|my|our|their|his|her|its|everyone|everybody|someone|somebody|nobody|everything|something|nothing)\b/i;
const SUBORDINATE = /^(?:before|after|until|once|when|whenever|unless|if|while)\b/i;

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
  const said = sentence.trim();
  return said.endsWith("?") || QUESTION.test(said.replace(DISCOURSE, ""));
}

/** Whether the words before a trigger leave it an instruction: no subject but "you" opens its clause. */
function instructs(lead: string): boolean {
  const own = lead.split(/[,;:]|\b(?:and|but|so|then|or)\b/i).at(-1)!;
  return !SUBJECT.test(own.trim().replace(DISCOURSE, ""));
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

/** The class whose word comes first in a text; a tie goes to the earlier class in `CLASS_WORDS`. */
function classIn(text: string): { cls: ActionClass; match: RegExpExecArray } | undefined {
  let found: { cls: ActionClass; match: RegExpExecArray } | undefined;
  for (const [cls, pattern] of CLASS_WORDS) {
    const match = pattern.exec(text);
    if (match && (!found || match.index < found.match.index)) found = { cls, match };
  }
  return found;
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

/** Where an object's noun phrase ends: a qualifier, a conjunction, a word that names no object, punctuation. */
const PHRASE_END = new RegExp(
  String.raw`\b(?:yet|until|before|after|for now|this time|in this pr|today|this week|and|but|or|so|then|when|` +
    String.raw`whenever|while|unless|if|once|because|since|without|yourself|yourselves|ever|first|on your own|` +
    String.raw`from your side|by hand)\b|[,;:.!?()]`,
  "i",
);
const LEADING_WORDS =
  /^(?:\s*\b(?:the|a|an|my|our|your|their|any|all|some|this|that|these|those|it|them|anything|everything|something|just|really|also|anymore|new|\w+ly)\b)+/i;
const LEADING_PREPOSITION = /^\s*(?:to|into|onto|on|under|in|from|against|off|at)\b/i;
const INNER_PREPOSITION = /\s(?:of|for|with|in|on|to|at|by|from|under|into|via|using|across)\s.*$/i;

/** The noun phrase a text opens with, after its articles and adverbs, or after one leading preposition. */
function nounPhrase(text: string, again = true): string {
  const end = PHRASE_END.exec(text);
  const phrase = ` ${(end ? text.slice(0, end.index) : text).replace(LEADING_WORDS, "").trim()} `;
  if (LEADING_PREPOSITION.test(phrase)) return again ? nounPhrase(phrase.replace(LEADING_PREPOSITION, ""), false) : "";
  return phrase.replace(INNER_PREPOSITION, "").trim();
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

/**
 * A rule's object: a protected path or a branch name its class word names, the object its class word captured
 * (`drop tables`), or the noun phrase after it.
 */
function objectOf(cls: ActionClass, rest: string, word?: RegExpExecArray): string {
  if (word && cls === "protected-path") return pathName(word[0].trim());
  if (word && cls === "branch" && /^(?:main|master)$/i.test(word[0])) return "main";
  return keyedObject(cls, objectWords(oneNamePerObject(word?.groups?.o ?? nounPhrase(rest))));
}

function qualifierOf(match: RegExpMatchArray): Qualifier {
  const said = match[0].toLowerCase();
  return said.startsWith("in this") ? "in-this-pr" : QUALIFIER_NAMES[said]!;
}

/**
 * Fix 1: whether what follows `before`/`after` is a precondition clause (a subject pronoun, a gerund, or a verb such
 * as "is"), which keeps a standing policy, rather than a time or an event.
 */
function precondition(rest: string): boolean {
  const phrase = rest.split(/[,;.!?]/)[0]!;
  return (
    /^\s*(?:you|i|we|they|he|she|someone|anyone|everyone)\b/i.test(phrase) ||
    /^\s*\w+ing\b/i.test(phrase) ||
    /\b(?:is|are|was|were|be|been|has|have|had|gets|got)\b/i.test(phrase)
  );
}

/** The temporal qualifier a sentence states, if any (D9, fix 1). */
function qualifierIn(sentence: string): Qualifier | undefined {
  const owned = new Set(
    [...sentence.matchAll(OWNED_QUALIFIER)].flatMap((m) => {
      const at = m.indices?.groups?.q ?? m.indices?.groups?.q2;
      return at ? [at[0]] : [];
    }),
  );
  for (const match of sentence.matchAll(QUALIFIER)) {
    const said = match[0].toLowerCase();
    if (said === "before" || said === "after") {
      if (owned.has(match.index) || precondition(sentence.slice(match.index + said.length))) continue;
    }
    return qualifierOf(match);
  }
  return undefined;
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
  let object: string;
  if (named) {
    cls = named;
    object = objectOf(named, after.replace(NAMING_TAIL, ""));
  } else {
    const found =
      classIn(hit.trigger.around ? `${lead} ${after}` : after) ??
      (SUBORDINATE.test(lead.trim()) ? classIn(lead) : undefined);
    if (!found) return undefined;
    cls = found.cls;
    object = objectOf(cls, found.match.input.slice(found.match.index + found.match[0].length), found.match);
  }
  return {
    kind: qualifier ? "intent" : "policy",
    class: cls,
    polarity: hit.trigger.polarity,
    object,
    ...(qualifier ? { qualifier } : {}),
    explicit: hit.trigger.explicit === true,
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
    const qualifier = qualifierIn(sentence);
    for (const clause of clausesOf(sentence)) {
      for (const hit of triggersIn(clause)) {
        const rule = ruleAt(clause, hit, qualifier);
        if (!rule) continue;
        if (!rules.some((known) => ruleKey(known) === ruleKey(rule) && known.kind === rule.kind)) rules.push(rule);
        break;
      }
    }
  }
  return rules;
}

/** The rules of a whole utterance: pasted spans, fenced code and quotes stripped first (D12, A4 §3.0). */
export function extractRules(text: string): Rule[] {
  return rulesIn(stripPastes(String(text ?? "")));
}

/** A rule's key, `class|polarity|object` (D9). */
export function ruleKey(rule: Pick<Rule, "class" | "polarity" | "object">): string {
  return `${rule.class}|${rule.polarity}|${rule.object}`;
}

/** The rules a row keeps: each key once, an intent with its qualifier. */
export function ruleRefs(rules: readonly Rule[]): RuleRef[] {
  const refs: RuleRef[] = [];
  for (const rule of rules) {
    const k = ruleKey(rule);
    if (!refs.some((ref) => ref.k === k)) refs.push(rule.qualifier ? { k, q: rule.qualifier } : { k });
  }
  return refs;
}

/** The key with the other polarity: a rule it states supersedes one with this key (A4 §3.1, L8). */
export function oppositeKey(key: string): string {
  const [cls, polarity, object] = key.split("|");
  return `${cls}|${polarity === "neg" ? "pos" : "neg"}|${object}`;
}

/**
 * The rule keys a text revokes (A4 §3.1): "you can merge PRs yourself now" revokes `integrate|neg|*`. The
 * revocation's object is keyed as a rule's is, so it revokes the rule on that object only.
 */
export function revokedKeys(text: string): string[] {
  return invalidationsIn(text, 0).flatMap((record) =>
    record.k === "revoke"
      ? [`${record.c}|neg|${keyedObject(record.c, objectWords(oneNamePerObject(record.o.join(" "))))}`]
      : [],
  );
}
