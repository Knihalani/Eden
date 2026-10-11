/**
 * A7 §5's action-class lexicon (D18), with D18's `stash` and D9 fix 4's `protected-path`. It ships as data,
 * `memory-classes.json`, so D21's miss-driven learning can extend it, and it is the one lexicon every reader shares:
 * - D9's extraction reads a class's words after a rule's trigger (`memory-policy.ts`);
 * - a compiled trigger fires a class on its words in the user's prompt (`memory-triggers.ts`);
 * - a revocation and a compaction summary name a class by its verbs (`memory-validity.ts`, `memory-value-tokens.ts`);
 * - D9 fix 3 keys a rule on its class's default object as `*`;
 * - the PreToolUse guard registers one handler per class command pattern (`hooks.json`) and re-checks each command
 *   against its class (A7 §5, `memory-guard.ts`).
 *
 * The classes are listed in R8's order of specificity, which breaks a tie between two classes whose words start at
 * one place (`push --force` is history-rewrite, `drop the tables` destructive-db).
 */
import lexicon from "./memory-classes.json";

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

interface ClassEntry {
  /** The class's words, one case-insensitive regex; a word that names its object captures it as group 1. */
  words: string;
  /** The words a cue fires the class by, where a word means the class only in context (`main`, a branch). */
  cue?: string;
  /** The verbs a revocation or a compaction summary names the class by. */
  verbs?: string[];
  /** The class's default object (D9 fix 3), then its other names. */
  object?: string[];
  guard?: ClassGuard;
}

/** A class's PreToolUse map (A7 §5). */
export interface ClassGuard {
  /** Permission rules for Bash commands (`git merge*`): `hooks.json` registers one handler each. */
  if: string[];
  /** The re-check of each subcommand (case-insensitive): `if` is best-effort. */
  check: string;
  /** A tool-name matcher with no `if` (`mcp__.*__merge.*`). */
  tools?: string;
}

const ENTRIES = lexicon.classes as Record<ActionClass, ClassEntry>;
const GUARD = lexicon.guard as { severity: ActionClass[]; irreversible: ActionClass[] };

/** The classes, in R8's order of specificity. */
export const ACTION_CLASSES = Object.keys(ENTRIES) as ActionClass[];

/** Each class and its words, in R8's order. */
export const CLASS_WORDS: readonly (readonly [ActionClass, RegExp])[] = ACTION_CLASSES.map((cls) => [
  cls,
  new RegExp(ENTRIES[cls].words, "i"),
]);

/** Each class and the words a cue fires it by, in R8's order (global: a cue is read for every match). */
export const CUE_WORDS: readonly (readonly [ActionClass, RegExp])[] = ACTION_CLASSES.map((cls) => [
  cls,
  new RegExp(ENTRIES[cls].cue ?? ENTRIES[cls].words, "gi"),
]);

/** Each verb a revocation or a compaction summary may name a class by, to its class. */
export const ACTION_VERBS: Readonly<Record<string, ActionClass>> = Object.fromEntries(
  ACTION_CLASSES.flatMap((cls) => (ENTRIES[cls].verbs ?? []).map((verb) => [verb, cls])),
);

/** D9 fix 3: what a class acts on when a rule names nothing else. */
export function defaultObject(cls: string): string | undefined {
  return ENTRIES[cls as ActionClass]?.object?.[0];
}

/** Every name of a class's default object ("pr", "pull request"); none for a class without one. */
export function defaultObjectNames(cls: string): readonly string[] {
  return ENTRIES[cls as ActionClass]?.object ?? [];
}

/** The classes the guard acts for, each with its PreToolUse map, in the lexicon's order. */
export const GUARDED_CLASSES: readonly (readonly [ActionClass, ClassGuard])[] = ACTION_CLASSES.flatMap((cls) => {
  const guard = ENTRIES[cls].guard;
  return guard ? [[cls, guard] as const] : [];
});

/** The classes whose prohibition asks before the call (D19). */
export const IRREVERSIBLE: ReadonlySet<ActionClass> = new Set(GUARD.irreversible);

/** A7 §5's severity: the listed classes first, most severe first, then the rest in the lexicon's order. */
export function severityRank(cls: ActionClass): number {
  const listed = GUARD.severity.indexOf(cls);
  return listed >= 0 ? listed : GUARD.severity.length + ACTION_CLASSES.indexOf(cls);
}
