/**
 * The PreToolUse policy guard's answer (D19, A4 §5.4, A6 §2.5, A7 §5): for a tool call, the rules the user set that
 * it would break, and whether to ask before it runs. The hook around it (`packages/cli/src/memory-guard-hook.ts`) adds
 * the flags, the deduplication across parallel handlers, the ledger and the wide event.
 *
 * - **Which classes a call is:** `memory-guard-match.ts`.
 * - **Which rules apply.** The rows of the store's rule index (`memory-rule-index.ts`) and the rules kept for all
 *   projects (`memory-user-global.ts`, which a repo row of the same rule gives way to) with a rule of the class, as
 *   every delivery point reads them: past `valid_until`, an intent after 7 days, and what an invalidation newer than
 *   the row took (a revocation, an opposition, an end) are gone. A rule applies when the call names its object (`*`
 *   always does; "don't delete the fixtures" applies to `rm -rf tests/fixtures`, not to `rm -rf node_modules`) and,
 *   for history-rewrite, its action ("never force-push" is not "never rebase"). A6 §2.5: no blanket asks.
 * - **Which class answers.** The most severe class of the call with a rule that applies (A7 §5's severity), with at
 *   most 2 of its rows: the user's own first, then the newest.
 * - **Ask or tell.** The rule always goes to Claude as context. An ask is due for a prohibition on an irreversible
 *   class, or for a live intent's prohibition; a positive rule ("always run the tests before you push") is never a
 *   reason to stop the call. It is returned only in `default`, `acceptEdits`, `plan` and `auto`: in `dontAsk` an ask
 *   becomes a denial and in `bypassPermissions` it is not honoured, so there the guard tells only (`bypassed`). It
 *   never denies.
 * - **Wording** (D14, A6 §2.3): each rule is its own clause of what the user typed ("don't merge it yourself" of
 *   "Push the fix to the PR, but don't merge it yourself."), labelled "Rule you set" with its age. A prohibition the
 *   user put on the agent alone ("… yourself") of a class's default object is said as who does it: "pull requests are
 *   merged by you, not by the agent".
 */
import { ACTION_VERBS, IRREVERSIBLE, type ActionClass } from "./memory-classes";
import { memoryNow } from "./memory-clock";
import { ageInWords } from "./memory-hook-packet";
import { historyAction, objectWords, oneNamePerObject, ruleClause, ruleIdentity, type RuleRef } from "./memory-policy";
import { callClasses, CHECKS, commandOf, partsOf, type GuardCall } from "./memory-guard-match";
import { knownNoteSource } from "./memory-provenance";
import { readRuleIndex, type IndexedRow } from "./memory-rule-index";
import { isUserGlobal, readUserRules, withUserGlobal } from "./memory-user-global";
import {
  readInvalidations,
  rulesInForce,
  validText,
  withoutExpiredIntents,
  type Invalidation,
} from "./memory-validity";

/** The permission modes in which an `ask` reaches the user (D19). */
const ASKING_MODES = new Set(["default", "acceptEdits", "plan", "auto"]);

/** What the guard says for one call. */
export interface GuardAnswer {
  cls: ActionClass;
  /** The rows whose rules it shows (≤ 2), for the ledger. */
  rows: IndexedRow[];
  /** The rules it shows, by `ruleIdentity`. */
  rules: string[];
  /** An ask is due, whatever the permission mode. */
  due: boolean;
  /** Due, and the permission mode lets the user be asked. */
  ask: boolean;
  /** Due, but the permission mode forbids an ask (`dontAsk`, `bypassPermissions`): context only. */
  bypassed: boolean;
  /** The ask's reason, shown to the user only. */
  reason: string;
  /** The same rules for Claude, next to the tool result. */
  context: string;
}

/** A7 §5's per-class cap, as at the cue. */
const PER_CLASS = 2;
const CONTEXT_HEADER = "Eden memory, a rule you set for this command:";
/** A rule's longest text in an answer: the reason is a prompt line, not a document. */
const RULE_CHARS = 300;

/** The history-rewrite actions of a call: `git push --force` force-pushes, `git rebase` rebases, … */
function historyActions(call: GuardCall): Set<string> {
  const check = CHECKS.find(({ cls }) => cls === "history-rewrite")!.check;
  return new Set(
    partsOf(call, check).map((part) =>
      /^git push\b/i.test(part)
        ? "force-push"
        : /\s--amend\b/i.test(part)
          ? "amend"
          : historyAction(part.split(/\s+/)[1] ?? ""),
    ),
  );
}

/** Whether a call names a rule's object: `*` always; else each of its words, or the object as written. */
function namesObject(object: string, call: GuardCall): boolean {
  if (object === "*") return true;
  const said = commandOf(call) ?? `${call.tool} ${JSON.stringify(call.input)}`;
  const escaped = object.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`, "i").test(said)) return true;
  const words = new Set(objectWords(oneNamePerObject(said)));
  return object.split("-").every((word) => words.has(word));
}

/** The class, polarity and object of a rule's key. */
function keyParts(rule: RuleRef): { cls: string; polarity: string; object: string } {
  const [cls = "", polarity = "", object = "*"] = rule.k.split("|");
  return { cls, polarity, object };
}

interface Applying {
  row: IndexedRow;
  text: string;
  rule: RuleRef;
}

/** The rules of a class that apply to a call, by row (see the header), the user's own first, then the newest. */
function applying(
  rows: readonly IndexedRow[],
  cls: ActionClass,
  call: GuardCall,
  invalid: readonly Invalidation[],
  now: number,
): Applying[] {
  const actions = cls === "history-rewrite" ? historyActions(call) : undefined;
  const found: Applying[] = [];
  for (const row of rows) {
    if (typeof row.validUntil === "number" && row.validUntil <= now) continue;
    const ofClass = (row.rules ?? []).filter((rule) => keyParts(rule).cls === cls);
    if (!ofClass.length) continue;
    const { text, rules: stated } = rulesInForce(row, invalid);
    if (!text) continue;
    const rule = ofClass.find(
      (ref) =>
        stated.has(ruleIdentity(ref)) &&
        namesObject(keyParts(ref).object, call) &&
        (!actions || !ref.v || actions.has(ref.v)),
    );
    if (rule) found.push({ row, text, rule });
  }
  const own = (row: IndexedRow) => (knownNoteSource(row) === "user" ? 0 : 1);
  return found.sort((a, b) => own(a.row) - own(b.row) || (b.row.at ?? 0) - (a.row.at ?? 0)).slice(0, PER_CLASS);
}

/** Who does what, for a prohibition the user put on the agent alone (see the header). */
const DONE_BY_YOU: Partial<Record<ActionClass, string>> = {
  integrate: "pull requests are merged by you, not by the agent",
  review: "pull requests are opened by you, not by the agent",
  "push-upstream": "pushes are made by you, not by the agent",
  commit: "commits are made by you, not by the agent",
  deploy: "deploys are run by you, not by the agent",
  dependency: "dependencies are added by you, not by the agent",
};

/** A rule as the guard says it (see the header). */
function ruleWords(found: Applying, now: number): string {
  const identity = ruleIdentity(found.rule);
  const clause = ruleClause(found.text, identity) ?? found.text;
  const { cls, polarity, object } = keyParts(found.rule);
  const byYou = polarity === "neg" && object === "*" && /\byoursel(?:f|ves)\b/i.test(clause);
  const said = (byYou && DONE_BY_YOU[cls as ActionClass]) || clause;
  const age = ageInWords(found.row.at, now);
  const plain = said
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const text = plain.length > RULE_CHARS ? `${plain.slice(0, RULE_CHARS - 1).trimEnd()}…` : plain;
  return `Rule you set${age ? ` (${age})` : ""}: ${text}${isUserGlobal(found.row) ? " (all projects)" : ""}`;
}

/**
 * A release with no class word (P2.1's follow-up): "Open it now.", "OK, merge it now", "go ahead and push them now".
 * Its verb names the intent: the verb of the intent's own clause ("don't open the PR yet"), or a verb of its class.
 */
const RELEASE =
  /^(?:(?:ok(?:ay)?|alright|great|good|fine|right)[\s,.!]+)?(?:(?:you can|go ahead and|feel free to)\s+)?([a-z]+)\s+(?:it|them|that|this|the\s+[a-z]+)\s+now\b/i;

/** The live intents a typed prompt releases (see `RELEASE`), by `ruleIdentity`. */
export function intentsReleasedBy(store: string, prompt: string, now = memoryNow()): string[] {
  const verbs = String(prompt ?? "")
    .split(/(?<=[.!?;])\s+|\n+/)
    .flatMap((sentence) => RELEASE.exec(sentence.trim())?.[1]?.toLowerCase() ?? []);
  if (!verbs.length) return [];
  const rows = readRuleIndex(store).filter((row) => row.rules?.some((rule) => rule.q !== undefined));
  const invalid = rows.length ? readInvalidations(store) : [];
  const released: string[] = [];
  for (const row of rows) {
    if (typeof row.validUntil === "number" && row.validUntil <= now) continue;
    const text = validText(withoutExpiredIntents(row.text, row.at), row.at, invalid);
    for (const rule of row.rules ?? []) {
      if (rule.q === undefined) continue;
      const clause = ruleClause(text, ruleIdentity(rule))?.toLowerCase();
      if (!clause) continue;
      const own = verbs.some((verb) => new RegExp(`\\b${verb}\\b`).test(clause));
      if (own || verbs.some((verb) => ACTION_VERBS[verb] === keyParts(rule).cls)) released.push(ruleIdentity(rule));
    }
  }
  return [...new Set(released)];
}

/**
 * The guard's answer for a call, from a store's index and the rules kept for all projects under `root` (D11, A7 §5's
 * lookup), or undefined when no rule of a class it is applies.
 */
export function guardAnswer(
  store: string,
  call: GuardCall,
  permissionMode: string,
  now = memoryNow(),
  root?: string,
): GuardAnswer | undefined {
  const classes = callClasses(call);
  if (!classes.length) return undefined;
  const rows = withUserGlobal(readRuleIndex(store), root ? readUserRules(root) : []);
  if (!rows.length) return undefined;
  const invalid = readInvalidations(store);
  for (const cls of classes) {
    const found = applying(rows, cls, call, invalid, now);
    if (!found.length) continue;
    const prohibits = (item: Applying) => keyParts(item.rule).polarity === "neg";
    const due = found.some((item) => prohibits(item) && (IRREVERSIBLE.has(cls) || item.rule.q !== undefined));
    const asking = ASKING_MODES.has(permissionMode);
    const words = found.map((item) => ruleWords(item, now));
    return {
      cls,
      rows: found.map((item) => item.row),
      rules: found.map((item) => ruleIdentity(item.rule)),
      due,
      ask: due && asking,
      bypassed: due && !asking,
      reason: `Eden: ${words.map((said) => said.replace(/^Rule/, "rule")).join("; ")}`,
      context: [CONTEXT_HEADER, ...words.map((said) => `- ${said}`)].join("\n"),
    };
  }
  return undefined;
}
