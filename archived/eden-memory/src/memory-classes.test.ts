/**
 * P2.2: A7 §5's lexicon ships as data (`memory-classes.json`), and every reader takes it from there: D9's extraction,
 * the cue's trigger, the revocation and compaction verbs, and D9 fix 3's default objects. P2.3: its PreToolUse map is
 * what `hooks.json` registers and what the guard re-checks.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import lexicon from "./memory-classes.json";
import {
  ACTION_CLASSES,
  ACTION_VERBS,
  CLASS_WORDS,
  CUE_WORDS,
  defaultObject,
  defaultObjectNames,
  GUARD_IF_RULES,
  GUARD_TOOL_MATCHERS,
  GUARDED_CLASSES,
} from "./memory-classes";
import { callClasses } from "./memory-guard-match";
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
    expect(keys("Don't add a section about packages.")).toEqual([]);
    // A7 §5: destructive-db is a destructive verb with a db, table or schema, in either order
    expect(keys("Do not run destructive database commands (drop, truncate, reset) without asking.")).toEqual([
      "destructive-db|neg|*",
    ]);
    expect(keys("Never drop the users table.")).toEqual(["destructive-db|neg|user-table"]);
    // A7 §5's phrasal verbs with their object inside: "close it out", "wrap this up"
    expect(keys("Never close it out yourself.")).toEqual(["integrate|neg|*"]);
  });
});

describe("the PreToolUse map (A7 §5)", () => {
  const hooks = JSON.parse(readFileSync(join(import.meta.dir, "../plugins/eden-memory/hooks/hooks.json"), "utf8"));
  const command = (n: number) =>
    `bun --no-install "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.ts" guard ${n} 2>/dev/null || true`;

  test("hooks.json registers one handler per command a pattern starts with, wildcard patterns as written", () => {
    expect(GUARD_IF_RULES).toEqual([
      "*migrate reset*",
      "*db drop*",
      "psql *",
      "git *",
      "npm *",
      "pnpm *",
      "yarn *",
      "bun *",
      "pip *",
      "cargo *",
      "*deploy*",
      "vercel *",
      "fly *",
      "kubectl *",
      "rm *",
      "gh *",
    ]);
    const bash = GUARD_IF_RULES.map((rule, n) => ({
      type: "command",
      command: command(n + 1),
      if: `Bash(${rule})`,
      timeout: 5,
    }));
    const tools = GUARD_TOOL_MATCHERS.map((matcher, n) => ({
      matcher,
      hooks: [{ type: "command", command: command(GUARD_IF_RULES.length + n + 1), timeout: 5 }],
    }));
    // P2.5: the Agent call's launch record for SubagentStart (A4 §5.3), not a class handler.
    const spawn = {
      matcher: "Agent",
      hooks: [
        {
          type: "command",
          command: `bun --no-install "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.ts" spawn 2>/dev/null || true`,
          timeout: 5,
        },
      ],
    };
    expect(hooks.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: bash }, ...tools, spawn]);
  });

  /** A command each `if` rule spawns its handler for. */
  const SPAWNS: Record<string, string> = {
    "git merge*": "git merge feature",
    "gh pr merge*": "gh pr merge 42",
    "gh pr create*": "gh pr create --fill",
    "git commit*": "git commit -m wip",
    "git push*": "git push origin main",
    "gh pr merge --auto*": "gh pr merge --auto 42",
    "git push --force*": "git push --force origin feature",
    "git push -f*": "git push -f",
    "git push *+*": "git push origin +main",
    "git rebase*": "git rebase main",
    "git commit --amend*": "git commit --amend",
    "*deploy*": "npm run deploy",
    "vercel*": "vercel --prod",
    "fly deploy*": "fly deploy",
    "kubectl apply*": "kubectl apply -f k8s.yaml",
    "rm -rf*": "rm -rf dist",
    "rm -fr*": "rm -fr dist",
    "rm -r*": "rm -r dist",
    "git branch -D*": "git branch -D old",
    "git push * --delete*": "git push origin --delete old",
    "npm i*": "npm i lodash",
    "pnpm add*": "pnpm add zod",
    "yarn add*": "yarn add zod",
    "bun add*": "bun add zod",
    "pip install*": "pip install requests",
    "cargo add*": "cargo add serde",
    "*migrate reset*": "npx prisma migrate reset",
    "*db drop*": "supabase db drop",
    "psql*DROP*": "psql -c 'DROP TABLE users'",
  };

  /** Whether a registered `if` rule starts a handler for a plain command (no `$()`, no variable command name). */
  const spawns = (rule: string, sample: string) =>
    new RegExp(
      `^${rule
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    ).test(sample);

  test("each class pattern's command starts a registered handler, and the guard re-checks it as its class", () => {
    const missed = GUARDED_CLASSES.flatMap(([cls, guard]) =>
      guard.if.flatMap((pattern) => {
        const sample = SPAWNS[pattern];
        const spawned = sample !== undefined && GUARD_IF_RULES.some((rule) => spawns(rule, sample));
        return spawned && callClasses({ tool: "Bash", input: { command: sample } }).includes(cls) ? [] : [pattern];
      }),
    );
    expect(missed).toEqual([]);
  });
});
