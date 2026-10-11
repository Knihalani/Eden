/**
 * P2.3's guard core (D19, A4 §5.4, A6 §2.5, A7 §5): how a call is read and re-checked against its classes, which
 * rules of the store's index apply and how they are worded, which class answers, and which intents a release ends.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "./index";
import { guardAnswer, intentsReleasedBy } from "./memory-guard";
import { callClasses, subcommandsOf } from "./memory-guard-match";
import { recordInvalidations } from "./memory-validity";

const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const DAY_MS = 86_400_000;
const dirs: string[] = [];
const savedNow = process.env.EDEN_NOW;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedNow === undefined) delete process.env.EDEN_NOW;
  else process.env.EDEN_NOW = savedNow;
});

/** A repo store holding what the user typed, a day before `T0`. */
function storeSaying(...typed: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "eden-guard-"));
  dirs.push(dir);
  process.env.EDEN_NOW = String(T0 - DAY_MS);
  const mem = openMemory({ dir, perRepo: true });
  mem.observe(
    typed.map((content) => ({ role: "user", content, src: "user" as const })),
    { keepLiveIdentity: true },
  );
  mem.close();
  process.env.EDEN_NOW = String(T0);
  return dir;
}

const bash = (command: string) => ({ tool: "Bash", input: { command } });

describe("reading a call", () => {
  test("subcommands at operators outside quotes, inside $() and backticks, leading assignments stripped", () => {
    expect(subcommandsOf(`FOO=1 git commit -m "a && b" && git push`)).toEqual([`git commit -m "a && b"`, "git push"]);
    expect(subcommandsOf("echo $(gh pr merge 4) `rm -rf x`")).toEqual([
      "echo $(gh pr merge 4) `rm -rf x`",
      "gh pr merge 4",
      "rm -rf x",
    ]);
    expect(subcommandsOf("echo '$(not run)'")).toEqual(["echo '$(not run)'"]);
  });

  test("the re-check: a class's command, not a word that only starts like one", () => {
    expect(callClasses(bash("git merge-base main HEAD"))).toEqual([]);
    expect(callClasses(bash("cat docs/deploy.md"))).toEqual([]);
    expect(callClasses(bash("npm install"))).toEqual([]);
    expect(callClasses(bash("$GH pr merge 4"))).toEqual([]);
    expect(callClasses(bash("npm run deploy:prod"))).toEqual(["deploy"]);
    expect(callClasses(bash("npm i -D lodash"))).toEqual(["dependency"]);
    expect(callClasses({ tool: "mcp__github__merge_pull_request", input: {} })).toEqual(["integrate"]);
  });

  test("a call that only asks for help or a dry run carries nothing out", () => {
    expect(callClasses(bash("gh pr merge --help"))).toEqual([]);
    expect(callClasses(bash("git push --dry-run origin main"))).toEqual([]);
  });

  test("the classes of a call, most severe first", () => {
    expect(callClasses(bash("git push --force origin feature"))).toEqual(["history-rewrite", "push-upstream"]);
    expect(callClasses(bash("git push origin --delete old"))).toEqual(["delete", "push-upstream"]);
    expect(callClasses(bash("gh pr merge 4 --auto"))).toEqual(["push-upstream", "integrate"]);
  });
});

describe("the answer", () => {
  test("a prohibition the user put on the agent alone is said as who does it, the rest of the row left out", () => {
    const store = storeSaying("Push the fix to the PR, but don't merge it yourself.");
    const answer = guardAnswer(store, bash("gh pr merge 42"), "default", T0)!;
    expect(answer.reason).toBe("Eden: rule you set (1 day ago): pull requests are merged by you, not by the agent");
    expect(answer.context).toContain("- Rule you set (1 day ago): pull requests are merged by you, not by the agent");
    expect(answer.context).not.toContain("Push the fix");
    expect(answer).toMatchObject({ cls: "integrate", due: true, ask: true, bypassed: false });
  });

  test("any other rule is its own clause, as typed", () => {
    const store = storeSaying("Never force-push.");
    expect(guardAnswer(store, bash("git push -f"), "default", T0)?.reason).toBe(
      "Eden: rule you set (1 day ago): Never force-push",
    );
  });

  test("the most severe class with a rule that applies answers, with its rules only", () => {
    const store = storeSaying("Never force-push.", "Don't push without asking me.");
    const answer = guardAnswer(store, bash("git push --force origin feature"), "default", T0)!;
    expect(answer.cls).toBe("history-rewrite");
    expect(answer.rules).toEqual(["history-rewrite|neg|*|force-push"]);
    expect(guardAnswer(store, bash("git push origin feature"), "default", T0)?.cls).toBe("push-upstream");
  });

  test("dontAsk and bypassPermissions downgrade a due ask to context; a positive rule never asks", () => {
    const store = storeSaying("Don't merge PRs yourself.", "Always run the tests before you push.");
    for (const mode of ["dontAsk", "bypassPermissions"])
      expect(guardAnswer(store, bash("gh pr merge 1"), mode, T0)).toMatchObject({ ask: false, bypassed: true });
    expect(guardAnswer(store, bash("git push"), "default", T0)).toMatchObject({ due: false, ask: false });
  });

  test("a live intent asks on a class that is not irreversible; a policy of that class only tells", () => {
    const intent = storeSaying("Don't open the PR yet.");
    expect(guardAnswer(intent, bash("gh pr create --fill"), "default", T0)).toMatchObject({ ask: true });
    const policy = storeSaying("Don't add new dependencies without asking.");
    expect(guardAnswer(policy, bash("bun add zod"), "default", T0)).toMatchObject({ due: false });
  });

  test("a revoked rule and an intent 7 days old are gone", () => {
    const store = storeSaying("Don't merge PRs yourself.", "Don't open the PR yet.");
    recordInvalidations(store, "You can merge PRs yourself now.", T0 - 1000);
    expect(guardAnswer(store, bash("gh pr merge 1"), "default", T0)).toBeUndefined();
    expect(guardAnswer(store, bash("gh pr create"), "default", T0 + 7 * DAY_MS)).toBeUndefined();
  });
});

describe("a release", () => {
  test("a release with no class word ends the intent whose own verb it names, nothing else", () => {
    const store = storeSaying("Don't open the PR yet.", "Don't merge it yet.", "Never push to main.");
    expect(intentsReleasedBy(store, "Open it now.", T0)).toEqual(["review|neg|*"]);
    expect(intentsReleasedBy(store, "OK, merge it now", T0)).toEqual(["integrate|neg|*"]);
    expect(intentsReleasedBy(store, "fix it now", T0)).toEqual([]);
    expect(intentsReleasedBy(store, "push it now", T0)).toEqual([]);
  });
});
