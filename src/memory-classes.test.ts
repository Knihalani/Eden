/**
 * P2.2: A7 §5's lexicon ships as data (`memory-classes.json`), and every reader takes it from there: D9's extraction,
 * the cue's trigger, the revocation and compaction verbs, and D9 fix 3's default objects.
 */
import { describe, expect, test } from "bun:test";
import lexicon from "./memory-classes.json";
import {
  ACTION_CLASSES,
  ACTION_VERBS,
  CLASS_WORDS,
  CUE_WORDS,
  defaultObject,
  defaultObjectNames,
} from "./memory-classes";
import { extractRules, ruleKey } from "./memory-policy";

const keys = (text: string) => extractRules(text).map(ruleKey);

describe("the action-class lexicon", () => {
  test("lists A7 §5's classes, D18's stash and D9 fix 4's protected-path, in R8's order", () => {
    expect(ACTION_CLASSES).toEqual([
      "destructive-db",
      "history-rewrite",
      "stash",
      "generated",
      "billing",
      "dependency",
      "deploy",
      "delete",
      "push-upstream",
      "integrate",
      "review",
      "commit",
      "branch",
      "complete",
      "protected-path",
    ]);
    expect(Object.keys(lexicon.classes)).toEqual([...ACTION_CLASSES]);
    expect(CLASS_WORDS.map(([cls]) => cls)).toEqual([...ACTION_CLASSES]);
    expect(CUE_WORDS.map(([cls]) => cls)).toEqual([...ACTION_CLASSES]);
  });

  test("names the verbs a revocation or a summary names a class by", () => {
    expect(ACTION_VERBS).toMatchObject({
      merge: "integrate",
      land: "integrate",
      ship: "integrate",
      commit: "commit",
      push: "push-upstream",
      "force-push": "history-rewrite",
      release: "deploy",
      drop: "delete",
      upgrade: "dependency",
      wipe: "destructive-db",
    });
  });

  test("names each class's default object and its other names (D9 fix 3)", () => {
    expect(defaultObject("integrate")).toBe("pr");
    expect(defaultObjectNames("integrate")).toEqual(["pr", "pull request"]);
    expect(defaultObject("deploy")).toBe("prod");
    expect(defaultObjectNames("deploy")).toEqual(["prod", "production"]);
    expect(defaultObject("billing")).toBeUndefined();
    expect(defaultObjectNames("billing")).toEqual([]);
  });

  test("is what D9's extraction reads a rule's class by", () => {
    // "add a new dependency": determiners and modifiers between the verb and the package (A7 §5: add dep/package)
    expect(keys("Ask before adding a new dependency.")).toEqual(["dependency|neg|*"]);
    expect(keys("Don't add a date picker package.")).toEqual(["dependency|neg|*"]);
    expect(keys("Don't add tests to the package.")).toEqual([]);
    // A7 §5: destructive-db is a destructive verb with a db, table or schema, in either order
    expect(keys("Do not run destructive database commands (drop, truncate, reset) without asking.")).toEqual([
      "destructive-db|neg|*",
    ]);
    expect(keys("Never drop the users table.")).toEqual(["destructive-db|neg|user-table"]);
    // A7 §5's phrasal verbs with their object inside: "close it out", "wrap this up"
    expect(keys("Never close it out yourself.")).toEqual(["integrate|neg|*"]);
  });
});
