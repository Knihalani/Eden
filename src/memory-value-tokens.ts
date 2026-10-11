/**
 * A4 §4's value tokens: the words `compact_summary` must still name for a delivered item to stay habituated after a
 * compaction (R0 F14). Everything else the window was given is re-armed.
 * - **Slot:** the words of its value ("postgres", "node 22").
 * - **Rule with D9 keys** (P2.1, `keyValueTokens`): each key's class and object words; a key on `*` names its class's
 *   default object (`pr` for integrate, D9 fix 3), which a summary names by any synonym ("pull requests"). A key whose
 *   class has no verb a summary could name it by (A7 §5's verbs, `ACTION_VERBS`), or that has no object and no
 *   default, gives the row no value tokens: it is always re-armed.
 * - **Rule without keys** (one on no action class, or written before P2.1): the class verb stem and the object of
 *   its first clause that names an action class: "Don't merge PRs yourself" is `integrate` and "pr". The object is
 *   what follows the verb, or, when the verb ends its clause ("Run the tests before you commit"), the clause's other
 *   words. A rule whose clause names nothing but its class has no value tokens: any summary mentioning a commit would
 *   hold it, so it is always re-armed. A summary names the class with any of its verbs, inflected ("not to be merging
 *   PRs"). A rule without a class verb keeps its object words (D9), all of which the summary must name.
 * - **Other kinds** have none: no summary keeps them, so a compaction always re-arms them.
 * The ledger keeps the tokens hashed (X11); this module compares them as words.
 */
import { stripPacketLabel } from "./memory-provenance";
import { contentWords } from "./memory-transcript";
import { defaultObject, oneNamePerObject, type RuleRef } from "./memory-policy";
import { ACTION_VERBS, objectWords } from "./memory-validity";

/** A class token, which no word of a text can be: words are `[a-z0-9]+`. */
function classToken(cls: string): string {
  return `@${cls}`;
}

/** Each inflection of an action verb ("merge", "merges", "merged", "merging"; "commit", "committed") to its class. */
const VERB_FORMS: ReadonlyMap<string, string> = new Map(
  Object.entries(ACTION_VERBS)
    .filter(([verb]) => /^[a-z]+$/.test(verb))
    .flatMap(([verb, cls]) => {
      const base = verb.endsWith("e") ? verb.slice(0, -1) : verb;
      const doubled = verb + verb.at(-1);
      const forms = [verb, `${verb}s`, `${base}es`, `${base}ed`, `${base}ing`, `${doubled}ed`, `${doubled}ing`];
      return forms.map((form): [string, string] => [form, cls]);
    }),
);

/**
 * Words that mark a sentence as a rule or link its clauses, never what it is about: "Before you deploy, ask me" has
 * no object beside its class, so no summary holds it.
 */
const RULE_WORDS = new Set([
  "always",
  "never",
  "don",
  "dont",
  "must",
  "avoid",
  "before",
  "after",
  "without",
  "until",
  "unless",
  "once",
  "while",
]);

/** A slot's value tokens: the words of its value. */
export function slotValueTokens(value: string): string[] {
  return [...new Set(contentWords(value))];
}

/** The object words among `words`, without the words that only mark a rule. */
function objectOf(words: readonly string[]): string[] {
  return objectWords(words.filter((word) => !RULE_WORDS.has(word)).join(" "));
}

/** A rule's value tokens (see the header); its packet label, when it has one, is not part of it. */
export function ruleValueTokens(text: string): string[] {
  const body = stripPacketLabel(text).body;
  for (const clause of body.split(/[,;:.!?]/)) {
    const words = clause.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const at = words.findIndex((word) => VERB_FORMS.has(word));
    if (at < 0) continue;
    const after = words.slice(at + 1);
    const object = objectOf(after.length ? after : words.filter((_, index) => index !== at));
    return object.length ? [...new Set([classToken(VERB_FORMS.get(words[at]!)!), ...object])] : [];
  }
  return [...new Set(objectOf(contentWords(body)))];
}

/** The classes a summary can name, by one of their verbs. */
const VERB_CLASSES: ReadonlySet<string> = new Set(VERB_FORMS.values());

/** A keyed rule row's value tokens (see the header). */
export function keyValueTokens(rules: readonly RuleRef[]): string[] {
  const tokens: string[] = [];
  for (const { k } of rules) {
    const [cls = "", , object = "*"] = k.split("|");
    const named = object === "*" ? defaultObject(cls) : object.replace(/-/g, " ");
    if (!named || !VERB_CLASSES.has(cls)) return [];
    tokens.push(classToken(cls), ...objectWords(named));
  }
  return [...new Set(tokens)];
}

/** What a summary names, as value tokens are written: its words, their singular forms, and the classes of its verbs. */
export function summaryTokens(summary: string): Set<string> {
  const words = contentWords(summary);
  const classes = words.flatMap((word) => {
    const cls = VERB_FORMS.get(word);
    return cls ? [classToken(cls)] : [];
  });
  return new Set([...words, ...objectWords(oneNamePerObject(summary)), ...classes]);
}
